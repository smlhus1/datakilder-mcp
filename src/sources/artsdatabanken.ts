import { z } from "zod";
import { TTL } from "../cache.js";
import { getJson } from "../http.js";
import { type Source } from "../source.js";

/**
 * Artsdatabanken — Artskart public API.
 *
 * Only the taxon search is built. The /observations endpoint answers 400 to every
 * parameter combination tried (Taxons, TaxonIds, with and without MaxResults) and
 * publishes no reachable spec, so it is left out rather than shipped on a guess.
 * Artsdatabanken's map layers are WMS and already reachable through the kart tools.
 *
 * Note: api.artsdatabanken.no does not resolve — the working host is
 * artskart.artsdatabanken.no. Found via the FDK API catalogue after guessing failed.
 *
 * Verified live 2026-08-05.
 */

const BASE = "https://artskart.artsdatabanken.no/publicapi/api";

interface Taxon {
  TaxonId: number;
  ValidScientificName?: string;
  PrefferedPopularname?: string;
  MatchedName?: string;
  TaxonGroup?: string;
  CategoryValue?: number;
}

async function art({ sok, antall = 15 }: { sok: string; antall?: number }) {
  const treff = await getJson<Taxon[]>(`${BASE}/taxon?term=${encodeURIComponent(sok)}`, { cacheTtlMs: TTL.maned });
  return {
    sok,
    antallTreff: treff.length,
    arter: treff.slice(0, Math.min(antall, 50)).map((t) => ({
      taxonId: t.TaxonId,
      vitenskapeligNavn: t.ValidScientificName,
      norsktNavn: t.PrefferedPopularname,
      traffPaa: t.MatchedName,
      gruppe: t.TaxonGroup,
    })),
    hint: "Søket treffer både norske og vitenskapelige navn.",
  };
}

export const artsdatabanken: Source = {
  id: "arter",
  name: "Artsdatabanken (Artskart)",
  homepage: "https://artskart.artsdatabanken.no/publicapi/",
  requiresKeyEnv: null,
  attribution: {
    licence: "CC BY 4.0",
    credit: "Kilde: Artsdatabanken",
    termsUrl: "https://www.artsdatabanken.no/Pages/205713",
  },
  tools: [
    {
      name: "art",
      title: "Artsdatabanken: slå opp art",
      description:
        "Søker i artsnavn — norsk eller vitenskapelig — og gir taxon-id, gyldig vitenskapelig navn, " +
        "norsk navn og artsgruppe.",
      inputSchema: {
        sok: z.string().describe("F.eks. \"elg\" eller \"Alces alces\""),
        antall: z.number().int().min(1).max(50).optional(),
      },
      run: art,
    },
  ],
};
