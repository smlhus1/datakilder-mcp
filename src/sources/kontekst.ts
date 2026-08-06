import { z } from "zod";
import { TTL } from "../cache.js";
import { getJson } from "../http.js";
import { type Source } from "../source.js";
import { entur } from "./entur.js";
import { kartverket } from "./kartverket.js";
import { met } from "./met.js";

/**
 * One call that answers "what is true at this coordinate?".
 *
 * Composes sources we already have. The chain place → coordinate → elevation →
 * forecast is four calls, and a model *can* make them itself — but it is the most
 * common question by far, and four round trips of latency and reasoning for a
 * routine answer is a poor trade.
 *
 * Partial failure is the design constraint: a composite that returns nothing
 * because one upstream hiccuped is worse than the four separate calls it replaces.
 * Every part runs independently, and whatever failed is named in `mangler` rather
 * than silently omitted — an absent field must never read as "no danger warnings".
 */

const ENTUR_REVERSE = "https://api.entur.io/geocoder/v1/reverse";

function verktoy(kilde: Source, navn: string) {
  const t = kilde.tools.find((x) => x.name === navn);
  if (!t) throw new Error(`intern feil: ${kilde.id}_${navn} finnes ikke`);
  return t.run;
}

async function forsok<T>(navn: string, f: () => Promise<T>, mangler: string[]): Promise<T | undefined> {
  try {
    return await f();
  } catch (err) {
    mangler.push(`${navn} (${(err as Error).message.slice(0, 80)})`);
    return undefined;
  }
}

interface EnturReverse {
  features: Array<{ properties: { label?: string; id?: string; distance?: number } }>;
}

async function kontekst({ lat, lon, timer = 1 }: { lat: number; lon: number; timer?: number }) {
  const mangler: string[] = [];

  // Elevation first and alone: the forecast needs it, and MET is materially wrong
  // in Norwegian terrain without it.
  const hoyde = (await forsok("høyde", () => verktoy(kartverket, "hoyde")({ lat, lon }), mangler)) as
    | { hoyde_moh: number | null; terreng?: string }
    | undefined;

  const [adresse, vaer, farevarsel, holdeplass] = await Promise.all([
    forsok("adresse", () => verktoy(kartverket, "adresse_fra_punkt")({ lat, lon, radius: 500 }), mangler),
    forsok(
      "vær",
      () => verktoy(met, "varsel")({ lat, lon, hoyde: hoyde?.hoyde_moh ?? undefined, timer }),
      mangler,
    ),
    forsok("farevarsel", () => verktoy(met, "farevarsel")({ lat, lon }), mangler),
    forsok(
      "holdeplass",
      async () => {
        const p = new URLSearchParams({
          "point.lat": String(lat),
          "point.lon": String(lon),
          size: "3",
          layers: "venue",
        });
        const d = await getJson<EnturReverse>(`${ENTUR_REVERSE}?${p}`, {
          headers: { "ET-Client-Name": "datakilder-mcp" },
          cacheTtlMs: TTL.uke,
        });
        return d.features.map((f) => ({
          navn: f.properties.label,
          id: f.properties.id,
          meter: f.properties.distance ? Math.round(f.properties.distance * 1000) : undefined,
        }));
      },
      mangler,
    ),
  ]);

  const naermeste = (adresse as any)?.adresser?.[0];
  const naa = (vaer as any)?.timer?.[0];

  return {
    posisjon: { lat, lon },
    kommune: naermeste?.kommune,
    kommunenummer: naermeste?.kommunenummer,
    adresse: naermeste ? `${naermeste.adresse}, ${naermeste.postnummer} ${naermeste.poststed}` : undefined,
    hoyde_moh: hoyde?.hoyde_moh,
    terreng: hoyde?.terreng,
    vaer: naa && {
      tid: naa.tid,
      temp: naa.temp,
      vind: naa.vind,
      vindkast: naa.vindkast,
      symbol: naa.symbol,
      nedbor_mm: naa.nedbor_mm,
    },
    farevarsel: (farevarsel as any)?.varsler ?? [],
    holdeplasser: holdeplass ?? [],
    // Explicit, because "no danger warnings" and "we could not check for danger
    // warnings" must never look the same.
    mangler: mangler.length ? mangler : undefined,
    _sammensattAv: ["kartverket", "met", "entur"],
  };
}

export const stedskontekst: Source = {
  id: "sted",
  name: "Stedskontekst (sammensatt av Kartverket, MET og Entur)",
  homepage: "https://github.com/smlhus1/datakilder-mcp",
  requiresKeyEnv: null,
  helse: { verktoy: "kontekst", args: { lat: 59.1294, lon: 11.3794, timer: 1 } },
  attribution: {
    licence: "se de underliggende kildene",
    credit: "Kilder: Kartverket, Meteorologisk institutt, Entur",
    termsUrl: "https://github.com/smlhus1/datakilder-mcp",
  },
  tools: [
    {
      name: "kontekst",
      title: "Hva gjelder på dette stedet?",
      description:
        "Ett kall som gir kommune, adresse, høyde over havet, været nå, gjeldende farevarsel og " +
        "nærmeste holdeplasser for et koordinat. Bruk denne i stedet for å kjede sammen " +
        "kartverket_*, met_* og entur_* når spørsmålet er «hva gjelder her?». " +
        "Deler som ikke kunne hentes står i feltet «mangler».",
      inputSchema: {
        lat: z.number(),
        lon: z.number(),
        timer: z.number().int().min(1).max(24).optional().describe("Værtimer framover, standard 1"),
      },
      run: kontekst,
    },
  ],
};
