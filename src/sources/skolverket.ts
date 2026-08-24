import { z } from "zod";
import { TTL } from "../cache.js";
import { getJson } from "../http.js";
import { SourceError, type Source } from "../source.js";

/**
 * Skolverket — skolenhetsregistret.
 *
 * The register is served whole or not at all: one call returns all ~10 600
 * school units, 1.4 MB. So the search happens HERE, against a cached copy,
 * rather than being pushed onto the API — there is no query parameter to push it
 * to. First call is slow, every later one is free.
 *
 * The list rows are deliberately thin (code, name, municipality, status); the
 * detail endpoint carries principal, address and WGS84 coordinates. Returning
 * the fat shape for 10 600 rows would be a megabyte of context for one answer.
 *
 * ⚠️ Skolverket's OTHER API, planned-educations, answers 406 to
 * `Accept: application/json` — it wants its own vendor media type. Not used
 * here, but the next person to reach for it should know before losing an hour.
 *
 * Verified live 2026-08-24.
 */

const BASE = "https://api.skolverket.se/skolenhetsregistret/v1";

interface Register {
  Uttagsdatum: string;
  Skolenheter: Array<{
    Skolenhetskod: string;
    Kommunkod: string;
    PeOrgNr: string;
    Skolenhetsnamn: string;
    Status: string;
  }>;
}

interface Enhet {
  Uttagsdatum: string;
  SkolenhetInfo: {
    Namn: string;
    Rektorsnamn?: string;
    Skolenhetskod: string;
    Epost?: string;
    Telefon?: string;
    Skolenhetstyp?: string;
    Inriktningstyp?: string;
    Status?: string;
    Kommunkod?: string;
    Besoksadress?: {
      Adress?: string;
      Postnr?: string;
      Ort?: string;
      GeoData?: { Koordinat_WGS84_Lat?: string; Koordinat_WGS84_Lng?: string };
    };
  };
}

async function schools({ søk, kommunkod }: { søk: string; kommunkod?: string }) {
  const reg = await getJson<Register>(`${BASE}/skolenhet`, { cacheTtlMs: TTL.uke });

  const nål = søk.toLowerCase();
  const treff = reg.Skolenheter.filter(
    (s) =>
      s.Skolenhetsnamn.toLowerCase().includes(nål) &&
      (kommunkod === undefined || s.Kommunkod === kommunkod),
  );

  if (treff.length === 0) {
    throw new SourceError(
      `Ingen av de ${reg.Skolenheter.length} skoleenhetene heter noe som ligner "${søk}"` +
        (kommunkod ? ` i kommune ${kommunkod}.` : "."),
    );
  }

  return {
    uttaksdato: reg.Uttagsdatum.slice(0, 10),
    antallTreff: treff.length,
    skoler: treff.slice(0, 50).map((s) => ({
      kode: s.Skolenhetskod,
      navn: s.Skolenhetsnamn,
      kommunkod: s.Kommunkod,
      // "Planerad" and "Vilande" units exist in the register but have no pupils.
      status: s.Status,
    })),
    avkortet: treff.length > 50,
    hint: "Bruk koden i skolverket_skole for rektor, adresse og koordinater.",
  };
}

async function school({ kode }: { kode: string }) {
  if (!/^\d+$/.test(kode)) {
    throw new SourceError(`"${kode}" er ikke en skolenhetskod. Finn den med skolverket_skoler.`);
  }

  const data = await getJson<Enhet>(`${BASE}/skolenhet/${kode}`, { cacheTtlMs: TTL.uke });
  const i = data.SkolenhetInfo;
  const geo = i.Besoksadress?.GeoData;

  return {
    kode: i.Skolenhetskod,
    navn: i.Namn,
    rektor: i.Rektorsnamn ?? null,
    type: i.Skolenhetstyp ?? null,
    inriktning: i.Inriktningstyp ?? null,
    status: i.Status ?? null,
    kommunkod: i.Kommunkod ?? null,
    epost: i.Epost ?? null,
    telefon: i.Telefon ?? null,
    adresse: i.Besoksadress
      ? `${i.Besoksadress.Adress ?? ""}, ${i.Besoksadress.Postnr ?? ""} ${i.Besoksadress.Ort ?? ""}`.trim()
      : null,
    // Handed over as numbers so they can go straight into a map or a distance
    // calculation; the API returns them as strings.
    lat: geo?.Koordinat_WGS84_Lat ? Number(geo.Koordinat_WGS84_Lat) : null,
    lon: geo?.Koordinat_WGS84_Lng ? Number(geo.Koordinat_WGS84_Lng) : null,
  };
}

export const skolverket: Source = {
  id: "skolverket",
  name: "Skolverket (skolenhetsregistret)",
  homepage: "https://api.skolverket.se/skolenhetsregistret/swagger-ui/index.html",
  requiresKeyEnv: null,
  helse: { verktoy: "skoler", args: { søk: "Lejonbacken" } },
  attribution: {
    licence: "CC0 1.0",
    credit: "Källa: Skolverket",
    termsUrl: "https://www.skolverket.se/om-oss/oppna-data",
  },
  tools: [
    {
      name: "skoler",
      title: "Skolverket: finn skole",
      description:
        "Søker i det svenske skolenhetsregistret på skolenavn, valgfritt begrenset til én kommune. " +
        "Søketekst er påkrevd: registeret har over 10 000 enheter.",
      inputSchema: {
        søk: z.string().describe("Del av skolenavnet, f.eks. \"Katedralskolan\""),
        kommunkod: z.string().optional().describe("Fire sifre, f.eks. \"0180\" for Stockholm"),
      },
      run: schools,
    },
    {
      name: "skole",
      title: "Skolverket: detaljer om én skole",
      description:
        "Gir rektor, skoletype, kontaktinfo, besøksadresse og WGS84-koordinater for én skoleenhet.",
      inputSchema: { kode: z.string().describe("Skolenhetskod fra skolverket_skoler") },
      run: school,
    },
  ],
};
