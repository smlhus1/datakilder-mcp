import { z } from "zod";
import { TTL } from "../cache.js";
import { getJson } from "../http.js";
import { SourceError, type Source } from "../source.js";

/**
 * Utdanningsdirektoratet — Nasjonalt skoleregister (NSR).
 *
 * The API ignores its own filter parameters: /enheter returns the entire 7.5 MB
 * registry whether you ask for one municipality, a name match, or a single page
 * (verified 2026-08-05 — ?navn=, ?kommunenr= and ?antallPerSide= all return the
 * same full payload). Rather than pay 7.5 MB per question, fetch it once per
 * process and filter in memory. Lookup by id does work, so that goes straight out.
 */

const BASE = "https://data-nsr.udir.no";

interface Enhet {
  NSRId: number;
  OrgNr?: string;
  Navn?: string;
  FulltNavn?: string;
  KommuneNavn?: string;
  KommuneNr?: string;
  FylkeNr?: string;
  Epost?: string | null;
  ErAktiv?: boolean;
  ErSkole?: boolean;
  ErGrunnSkole?: boolean;
  ErVideregaaendeSkole?: boolean;
  ErPrivatSkole?: boolean;
  ErOffentligSkole?: boolean;
}

/**
 * Process-lifetime cache of the full registry.
 *
 * Not a TTL cache on purpose: the school register changes a few times a year, an
 * MCP server is short-lived, and a stale school name is a far smaller problem than
 * re-downloading 7.5 MB on every question.
 */
let alle: Enhet[] | null = null;

async function hentAlle(): Promise<Enhet[]> {
  if (!alle) alle = await getJson<Enhet[]>(`${BASE}/enheter`, { cacheTtlMs: TTL.uke });
  return alle;
}

function tidy(e: Enhet) {
  return {
    id: e.NSRId,
    navn: e.FulltNavn?.trim() || e.Navn,
    orgnr: e.OrgNr,
    kommune: e.KommuneNavn,
    kommunenummer: e.KommuneNr,
    epost: e.Epost ?? undefined,
    aktiv: e.ErAktiv,
    type: [
      e.ErGrunnSkole ? "grunnskole" : null,
      e.ErVideregaaendeSkole ? "videregående" : null,
      e.ErPrivatSkole ? "privat" : e.ErOffentligSkole ? "offentlig" : null,
    ]
      .filter(Boolean)
      .join(", "),
  };
}

async function skoler({
  navn,
  kommunenummer,
  baraktive = true,
  antall = 20,
}: {
  navn?: string;
  kommunenummer?: string;
  baraktive?: boolean;
  antall?: number;
}) {
  if (!navn && !kommunenummer) {
    throw new SourceError("Oppgi navn og/eller kommunenummer — registeret har over 20 000 enheter.");
  }

  const reg = await hentAlle();
  const treff = reg.filter((e) => {
    if (baraktive && e.ErAktiv === false) return false;
    if (kommunenummer && e.KommuneNr !== kommunenummer) return false;
    if (navn) {
      const hay = `${e.Navn ?? ""} ${e.FulltNavn ?? ""}`.toLowerCase();
      if (!hay.includes(navn.toLowerCase())) return false;
    }
    return true;
  });

  return {
    sok: { navn, kommunenummer, baraktive },
    totaltIRegisteret: reg.length,
    antallTreff: treff.length,
    enheter: treff.slice(0, Math.min(antall, 100)).map(tidy),
    avkortet: treff.length > Math.min(antall, 100),
  };
}

async function skole({ id }: { id: number }) {
  try {
    return tidy(await getJson<Enhet>(`${BASE}/enhet/${id}`, { cacheTtlMs: TTL.uke }));
  } catch (err) {
    if (err instanceof SourceError && err.status === 404) {
      throw new SourceError(`Fant ingen enhet med NSR-id ${id}. Finn id-en med udir_skoler.`);
    }
    throw err;
  }
}

export const udir: Source = {
  id: "udir",
  name: "Utdanningsdirektoratet (Nasjonalt skoleregister)",
  homepage: "https://data-nsr.udir.no/",
  requiresKeyEnv: null,
  attribution: {
    licence: "NLOD 2.0",
    credit: "Kilde: Utdanningsdirektoratet (NSR)",
    termsUrl: "https://www.udir.no/",
  },
  tools: [
    {
      name: "skoler",
      title: "UDIR: søk etter skoler",
      description:
        "Søker i det nasjonale skoleregisteret på navn og/eller kommunenummer. " +
        "Gir NSR-id, organisasjonsnummer, kommune og skoletype.",
      inputSchema: {
        navn: z.string().optional(),
        kommunenummer: z.string().optional().describe("F.eks. \"3101\" for Halden"),
        baraktive: z.boolean().optional().describe("Standard true"),
        antall: z.number().int().min(1).max(100).optional(),
      },
      run: skoler,
    },
    {
      name: "skole",
      title: "UDIR: slå opp én skole",
      description: "Henter detaljer for én enhet i skoleregisteret via NSR-id.",
      inputSchema: { id: z.number().int().describe("NSR-id fra udir_skoler") },
      run: skole,
    },
  ],
};
