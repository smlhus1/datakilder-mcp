import { z } from "zod";
import { TTL } from "../cache.js";
import { getJson } from "../http.js";
import { SourceError, type Source } from "../source.js";

/**
 * SMHI — öppna data, meteorologiska observationer (metobs).
 *
 * NOT the Swedish counterpart to MET's forecast API, however tempting the
 * mapping looks: SMHI's forecast service (metfcst) returned 404 on every
 * documented path when probed 2026-08-24, while metobs answers fine. MET gives
 * you what the weather WILL be; this gives you what it WAS. Different product,
 * and saying otherwise would send a model looking for a forecast that isn't here.
 *
 * The API is a catalogue three levels deep: parameter → station → period → data.
 * One parameter carries ~1 000 stations, so the station tool requires a search
 * term rather than returning the lot — the alternative is burying an answer in
 * a thousand rows nobody reads.
 *
 * Verified live 2026-08-24 against parameter 1 (lufttemperatur), station 52350
 * (Malmö A).
 */

const BASE = "https://opendata-download-metobs.smhi.se/api/version/1.0";

/** Every level of this API returns the same envelope; only the arrays differ. */
interface Katalog {
  title?: string;
  summary?: string;
  unit?: string;
  resource?: Array<{ key: string; title: string; summary: string; unit?: string }>;
  station?: Array<{ key: string; name?: string; title?: string; summary?: string; active?: boolean }>;
}

interface Observasjoner {
  parameter: { key: string; name: string; summary: string; unit: string };
  station: { key: string; name: string; height?: number };
  period: { key: string; from: number; to: number; summary: string };
  value?: Array<{ date: number; value: string | null; quality: string }>;
}

/** SMHI stamps times as epoch milliseconds; a bare number helps nobody read it. */
const tid = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

async function parameters() {
  const data = await getJson<Katalog>(`${BASE}.json`, { cacheTtlMs: TTL.uke });
  return {
    parametere: (data.resource ?? []).map((r) => ({
      kode: r.key,
      navn: r.title,
      enhet: r.unit ?? "",
      beskrivelse: r.summary,
    })),
    hint: "Bruk koden i smhi_stasjoner for å finne en målestasjon.",
  };
}

async function stations({ parameter, søk }: { parameter: string; søk: string }) {
  const data = await getJson<Katalog>(`${BASE}/parameter/${encodeURIComponent(parameter)}.json`, {
    cacheTtlMs: TTL.uke,
  });

  const alle = data.station ?? [];
  const nål = søk.toLowerCase();
  // The station's own `name` is clean ("Malmö A"); `title` repeats the parameter
  // in front of it, which makes every row match a search for the parameter name.
  const treff = alle.filter((s) => (s.name ?? s.title ?? "").toLowerCase().includes(nål));

  if (treff.length === 0) {
    throw new SourceError(
      `Ingen av de ${alle.length} stasjonene for parameter ${parameter} heter noe som ligner "${søk}". ` +
        "Prøv et stedsnavn, f.eks. \"Malmö\" eller \"Göteborg\".",
    );
  }

  // Decommissioned stations stay in the register, and for Malmö they sort ahead
  // of the working ones. A model takes the first hit, asks for "latest-day" and
  // gets an empty series with no clue why — so the live ones go first.
  const sortert = [...treff].sort((a, b) => Number(b.active ?? false) - Number(a.active ?? false));
  const aktive = sortert.filter((s) => s.active).length;

  return {
    parameter,
    enhet: data.unit ?? "",
    antallTreff: treff.length,
    antallAktive: aktive,
    stasjoner: sortert.slice(0, 40).map((s) => ({
      kode: s.key,
      navn: s.name ?? s.title,
      // Coordinates and altitude live in a free-text summary, not in fields.
      posisjon: s.summary,
      aktiv: s.active ?? null,
    })),
    avkortet: treff.length > 40,
    hint:
      aktive === 0
        ? "Ingen av stasjonene er aktive — bare \"corrected-archive\" vil gi målinger."
        : "Velg en stasjon med aktiv=true. Nedlagte stasjoner gir tomt svar for de siste periodene.",
  };
}

async function observations({
  parameter,
  stasjon,
  periode,
}: {
  parameter: string;
  stasjon: string;
  periode?: string;
}) {
  const valgt = periode ?? "latest-day";
  const url = `${BASE}/parameter/${encodeURIComponent(parameter)}/station/${encodeURIComponent(stasjon)}/period/${encodeURIComponent(valgt)}/data.json`;

  // Minutes, not hours: these are observations that update hourly, and a cached
  // "latest" that is a day old is worse than no answer.
  let data: Observasjoner;
  try {
    data = await getJson<Observasjoner>(url, { cacheTtlMs: TTL.minutter });
  } catch (err) {
    // A decommissioned station has no "latest-day" resource at all — SMHI answers
    // 404 with an HTML error page. Passed through, the model sees a wall of
    // Tomcat markup instead of the one thing it needs to know: pick another
    // station, or ask for the archive.
    if (err instanceof SourceError && err.status === 404) {
      throw new SourceError(
        `Stasjon ${stasjon} har ingen data for perioden "${valgt}". ` +
          "Stasjonen er trolig nedlagt — velg en med aktiv=true i smhi_stasjoner, " +
          "eller be om periode \"corrected-archive\" for historikken.",
        404,
      );
    }
    throw err;
  }

  const målinger = (data.value ?? []).map((v) => ({
    tid: tid(v.date),
    verdi: v.value === null ? null : Number(v.value),
    kvalitet: v.quality,
  }));

  // An empty series is a real answer from SMHI — the station exists but has been
  // decommissioned, or measured nothing in the window. Saying so beats handing
  // back `[]`, which reads as "it is 0 degrees in Malmö".
  if (målinger.length === 0) {
    throw new SourceError(
      `Stasjon ${data.station?.name ?? stasjon} ga ingen målinger for "${valgt}". ` +
        "Stasjonen er trolig nedlagt — velg en med aktiv=true i smhi_stasjoner, " +
        "eller be om periode \"corrected-archive\" for historikken.",
    );
  }

  return {
    parameter: data.parameter?.name,
    enhet: data.parameter?.unit,
    stasjon: data.station?.name,
    periode: data.period?.summary,
    fra: data.period ? tid(data.period.from) : null,
    til: data.period ? tid(data.period.to) : null,
    antall: målinger.length,
    // A corrected archive can hold decades; the tail is what anyone asks for.
    målinger: målinger.slice(-500),
    avkortet: målinger.length > 500,
  };
}

export const smhi: Source = {
  id: "smhi",
  name: "SMHI (meteorologiska observationer)",
  homepage: "https://opendata.smhi.se/apidocs/metobs/",
  requiresKeyEnv: null,
  helse: { verktoy: "parametere", args: {} },
  attribution: {
    licence: "CC BY 4.0",
    credit: "Källa: SMHI",
    termsUrl: "https://www.smhi.se/data/oppna-data/information-om-oppna-data/villkor-for-anvandning-1.30622",
  },
  tools: [
    {
      name: "parametere",
      title: "SMHI: hvilke værdata måles?",
      description:
        "Lister målte parametere (lufttemperatur, nederbörd, vindhastighet ...) med kode og enhet. " +
        "START HER — kodene trengs av de andre verktøyene. " +
        "MERK: dette er OBSERVASJONER, altså vær som HAR vært. SMHI har ikke prognoser her.",
      inputSchema: {},
      run: parameters,
    },
    {
      name: "stasjoner",
      title: "SMHI: finn målestasjon",
      description:
        "Søker opp målestasjoner for en parameter på stedsnavn. " +
        "Søketekst er påkrevd: én parameter har rundt 1 000 stasjoner.",
      inputSchema: {
        parameter: z.string().describe("Parameterkode fra smhi_parametere, f.eks. \"1\" for lufttemperatur"),
        søk: z.string().describe("Stedsnavn, f.eks. \"Malmö\""),
      },
      run: stations,
    },
    {
      name: "observasjoner",
      title: "SMHI: hent målinger",
      description:
        "Henter faktiske målinger for en parameter på én stasjon, med tidspunkt og kvalitetsflagg.",
      inputSchema: {
        parameter: z.string().describe("Parameterkode fra smhi_parametere"),
        stasjon: z.string().describe("Stasjonskode fra smhi_stasjoner"),
        periode: z
          .enum(["latest-hour", "latest-day", "latest-months", "corrected-archive"])
          .optional()
          .describe("Standard \"latest-day\". \"corrected-archive\" er hele den kvalitetssikrede historikken."),
      },
      run: observations,
    },
  ],
};
