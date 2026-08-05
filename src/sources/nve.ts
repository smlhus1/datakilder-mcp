import { z } from "zod";
import { TTL } from "../cache.js";
import { getJson } from "../http.js";
import { SourceError, type Source } from "../source.js";

/**
 * Norges vassdrags- og energidirektorat — nettleietariffer.
 *
 * NVE was written off earlier in the day: its hydrology API returns 401 without a
 * key, and that was taken as "NVE is blocked". Two later findings undid that:
 *   1. NVE's flood zones are WMS layers, reachable through the kart tools.
 *   2. This API — grid tariffs for every network operator in Norway — is open, and
 *      was hiding behind a catalogue entry that pointed at a Swagger viewer page.
 *
 * Worth generalising: "the source is blocked" is a claim about one endpoint, not
 * about an agency.
 *
 * The API validates one parameter at a time, so the enums here were learned by
 * being rejected three times. They are written down so nobody has to repeat that.
 *
 * Verified live 2026-08-05.
 */

const BASE = "https://nettleietariffer.dataplattform.nve.no/v1";

interface Tariff {
  datoId?: string;
  tariffgruppe?: string;
  kundegruppe?: string;
  konsesjonar?: string;
  organisasjonsnr?: string;
  fylke?: string;
  fastleddEks?: number;
  energileddEks?: number;
  fastleddInk?: number;
  energileddInk?: number;
  omregnetPrisEks?: number;
}

async function nettleie({
  fraDato,
  tilDato,
  tariffgruppe = "Husholdning",
  kundegruppe = 1,
  fylke,
}: {
  fraDato: string;
  tilDato: string;
  tariffgruppe?: "Husholdning" | "Hytter og fritidshus";
  kundegruppe?: number;
  fylke?: string;
}) {
  const p = new URLSearchParams({
    FraDato: fraDato,
    TilDato: tilDato,
    Tariffgruppe: tariffgruppe,
    Kundegruppe: String(kundegruppe),
  });

  const svar = await getJson<Tariff[] | { detail?: unknown }>(
    `${BASE}/NettleiePerOmradePrManedHusholdningFritidEffekttariffer?${p}`,
    { cacheTtlMs: TTL.uke },
  );

  // The API answers 422 with a JSON body rather than an error status the client
  // would catch, so a bad parameter arrives looking like data.
  if (!Array.isArray(svar)) {
    throw new SourceError(
      `NVE avviste spørringen: ${JSON.stringify((svar as { detail?: unknown }).detail).slice(0, 200)}`,
    );
  }

  const rader = fylke
    ? svar.filter((r) => (r.fylke ?? "").toLowerCase().includes(fylke.toLowerCase()))
    : svar;

  return {
    periode: { fraDato, tilDato },
    tariffgruppe,
    kundegruppe,
    antallNettselskaper: rader.length,
    tariffer: rader.slice(0, 60).map((r) => ({
      nettselskap: r.konsesjonar,
      orgnr: r.organisasjonsnr,
      fylke: r.fylke,
      kundegruppe: r.kundegruppe,
      fastledd_eks_mva: r.fastleddEks,
      energiledd_eks_mva: r.energileddEks,
      fastledd_ink_mva: r.fastleddInk,
      energiledd_ink_mva: r.energileddInk,
    })),
    avkortet: rader.length > 60,
  };
}

export const nve: Source = {
  id: "nve",
  name: "NVE (nettleietariffer)",
  homepage: "https://nettleietariffer.dataplattform.nve.no/v1/openapi.json",
  requiresKeyEnv: null,
  attribution: {
    licence: "NLOD 2.0",
    credit: "Kilde: Norges vassdrags- og energidirektorat (NVE)",
    termsUrl: "https://www.nve.no/",
  },
  tools: [
    {
      name: "nettleie",
      title: "NVE: nettleietariffer per nettselskap",
      description:
        "Nettleie for husholdninger og fritidsboliger fra alle norske nettselskaper i en periode — " +
        "fastledd og energiledd, med og uten mva. Kan filtreres på fylke.",
      inputSchema: {
        fraDato: z.string().describe("ISO-dato, f.eks. \"2026-07-01\""),
        tilDato: z.string().describe("ISO-dato"),
        tariffgruppe: z
          .enum(["Husholdning", "Hytter og fritidshus"])
          .optional()
          .describe("Standard \"Husholdning\""),
        kundegruppe: z.number().int().min(1).max(4).optional().describe("1–4, ulike eksempelkunder"),
        fylke: z.string().optional().describe("Filtrer på fylkesnavn, f.eks. \"Østfold\""),
      },
      run: nettleie,
    },
  ],
};
