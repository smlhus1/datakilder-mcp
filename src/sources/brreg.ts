import { z } from "zod";
import { TTL } from "../cache.js";
import { getJson } from "../http.js";
import { SourceError, type Source } from "../source.js";

/**
 * Brønnøysundregistrene — Enhetsregisteret.
 *
 * Second source on purpose: it is the opposite shape from SSB (plain REST, no
 * cube), so the skeleton gets exercised against both kinds before more sources
 * are added on top of it.
 *
 * Verified live 2026-08-05 against org. 923609016 (Equinor ASA).
 */

const BASE = "https://data.brreg.no/enhetsregisteret/api";

interface Enhet {
  organisasjonsnummer: string;
  navn: string;
  organisasjonsform?: { kode?: string; beskrivelse?: string };
  registreringsdatoEnhetsregisteret?: string;
  naeringskode1?: { kode?: string; beskrivelse?: string };
  antallAnsatte?: number;
  hjemmeside?: string;
  konkurs?: boolean;
  underAvvikling?: boolean;
  slettedato?: string;
  forretningsadresse?: { adresse?: string[]; postnummer?: string; poststed?: string; kommune?: string };
}

/** One shape for both tools, so a search hit and a lookup read identically. */
function tidy(e: Enhet) {
  const a = e.forretningsadresse;
  return {
    orgnr: e.organisasjonsnummer,
    navn: e.navn,
    form: e.organisasjonsform?.beskrivelse ?? e.organisasjonsform?.kode,
    registrert: e.registreringsdatoEnhetsregisteret,
    næring: e.naeringskode1 ? `${e.naeringskode1.kode} ${e.naeringskode1.beskrivelse}` : undefined,
    ansatte: e.antallAnsatte,
    hjemmeside: e.hjemmeside,
    adresse: a ? [a.adresse?.join(" "), a.postnummer, a.poststed].filter(Boolean).join(", ") : undefined,
    kommune: a?.kommune,
    // Surfaced explicitly rather than left in the raw payload: whether a company
    // is bankrupt or dissolved is usually the whole reason for looking it up.
    status:
      e.slettedato ? `slettet ${e.slettedato}` : e.konkurs ? "konkurs" : e.underAvvikling ? "under avvikling" : "aktiv",
  };
}

function normaliserOrgnr(input: string): string {
  const digits = input.replace(/\D/g, "");
  if (digits.length !== 9) {
    throw new SourceError(`"${input}" er ikke et organisasjonsnummer — det skal være 9 siffer.`);
  }
  return digits;
}

async function foretak({ orgnr }: { orgnr: string }) {
  const id = normaliserOrgnr(orgnr);
  try {
    return tidy(await getJson<Enhet>(`${BASE}/enheter/${id}`, { cacheTtlMs: TTL.dag }));
  } catch (err) {
    if (err instanceof SourceError && err.status === 404) {
      throw new SourceError(`Fant ingen enhet med organisasjonsnummer ${id} i Enhetsregisteret.`);
    }
    throw err;
  }
}

async function søk({ navn, kommunenummer, antall = 10 }: { navn: string; kommunenummer?: string; antall?: number }) {
  const params = new URLSearchParams({ navn, size: String(Math.min(antall, 50)) });
  if (kommunenummer) params.set("kommunenummer", kommunenummer);

  const res = await getJson<{ _embedded?: { enheter?: Enhet[] }; page?: { totalElements?: number } }>(
    `${BASE}/enheter?${params}`,
    { cacheTtlMs: TTL.dag },
  );
  const treff = res._embedded?.enheter ?? [];
  return {
    søk: navn,
    totaltAntallTreff: res.page?.totalElements ?? treff.length,
    viser: treff.length,
    enheter: treff.map(tidy),
  };
}

interface Regnskap {
  regnskapsperiode?: { fraDato?: string; tilDato?: string };
  valuta?: string;
  resultatregnskapResultat?: {
    aarsresultat?: number;
    driftsresultat?: {
      driftsinntekter?: { sumDriftsinntekter?: number };
      driftskostnad?: { sumDriftskostnad?: number };
      driftsresultat?: number;
    };
  };
  eiendeler?: { sumEiendeler?: number };
  egenkapitalGjeld?: { sumEgenkapitalGjeld?: number; egenkapital?: { sumEgenkapital?: number } };
}

/**
 * Annual accounts.
 *
 * Found late, and only because the catalogue entry pointed at a Swagger *viewer*
 * rather than the API: reading that page revealed the spec, and the spec revealed
 * an open endpoint needing no key. Worth remembering — a catalogue entry that looks
 * like documentation may be an API with the label on the wrong door.
 *
 * Verified live 2026-08-05: Equinor 2024, 72.5 bn revenue.
 */
async function regnskap({ orgnr }: { orgnr: string }) {
  const id = normaliserOrgnr(orgnr);
  const svar = await getJson<Regnskap[]>(`${BASE.replace("/enhetsregisteret/api", "")}/regnskapsregisteret/regnskap/${id}`, {
    cacheTtlMs: TTL.uke,
  });

  if (!Array.isArray(svar) || svar.length === 0) {
    throw new SourceError(
      `Ingen regnskap registrert på ${id}. Små foretak og nystartede selskaper mangler ofte innsendt regnskap.`,
    );
  }

  return {
    orgnr: id,
    antallAar: svar.length,
    aar: svar.map((r) => {
      const res = r.resultatregnskapResultat;
      return {
        fra: r.regnskapsperiode?.fraDato,
        til: r.regnskapsperiode?.tilDato,
        valuta: r.valuta,
        driftsinntekter: res?.driftsresultat?.driftsinntekter?.sumDriftsinntekter,
        driftskostnader: res?.driftsresultat?.driftskostnad?.sumDriftskostnad,
        driftsresultat: res?.driftsresultat?.driftsresultat,
        aarsresultat: res?.aarsresultat,
        sumEiendeler: r.eiendeler?.sumEiendeler,
        egenkapital: r.egenkapitalGjeld?.egenkapital?.sumEgenkapital,
      };
    }),
  };
}

export const brreg: Source = {
  id: "brreg",
  name: "Brønnøysundregistrene (Enhetsregisteret)",
  homepage: "https://data.brreg.no/enhetsregisteret/api/dokumentasjon",
  requiresKeyEnv: null,
  helse: { verktoy: "foretak", args: { orgnr: "923609016" } },
  attribution: {
    licence: "NLOD 2.0",
    credit: "Kilde: Brønnøysundregistrene",
    termsUrl: "https://data.brreg.no/enhetsregisteret/api/dokumentasjon",
  },
  tools: [
    {
      name: "foretak",
      title: "Brreg: slå opp foretak på organisasjonsnummer",
      description:
        "Henter navn, organisasjonsform, næringskode, adresse, ansatte og status (aktiv/konkurs/under avvikling) " +
        "for ett organisasjonsnummer.",
      inputSchema: {
        orgnr: z.string().describe("9 siffer, mellomrom tillatt"),
      },
      run: foretak,
    },
    {
      name: "søk",
      title: "Brreg: søk etter foretak på navn",
      description:
        "Søker i Enhetsregisteret på navn, valgfritt begrenset til én kommune. Returnerer samme felter som oppslag.",
      inputSchema: {
        navn: z.string(),
        kommunenummer: z.string().optional().describe("F.eks. \"3101\" for Halden"),
        antall: z.number().int().min(1).max(50).optional(),
      },
      run: søk,
    },
    {
      name: "regnskap",
      title: "Brreg: årsregnskap for et foretak",
      description:
        "Henter innsendte årsregnskap — driftsinntekter, driftsresultat, årsresultat, eiendeler og " +
        "egenkapital per år. Bruk den når spørsmålet er hvor stort eller hvor solid et selskap er, " +
        "ikke bare om det finnes.",
      inputSchema: { orgnr: z.string().describe("9 siffer") },
      run: regnskap,
    },
  ],
};
