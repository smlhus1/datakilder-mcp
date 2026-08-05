import { z } from "zod";
import { getJson } from "../http.js";
import { type Source } from "../source.js";

/**
 * Felles datakatalog (data.norge.no) — discovery fallback.
 *
 * Last on purpose, and framed as a fallback rather than the front door. A sample
 * of 60 datasets on 2026-08-05 found 94 % of their download links pointing at HTML
 * landing pages, so the catalogue answers "does anything exist about X" far better
 * than "give me X". The typed sources in this server are the front door; this tool
 * is for when none of them covers a question.
 *
 * It earns its place anyway: it is how the real endpoints for Miljødirektoratet and
 * Artsdatabanken were found today, after guessing hostnames failed (api.artsdatabanken.no
 * does not resolve; NILU's API is 410 Gone).
 *
 * Verified live 2026-08-05.
 */

const SEARCH = "https://search.api.fellesdatakatalog.digdir.no/search";
const RESOURCE = "https://resource.api.fellesdatakatalog.digdir.no/v1";

type Katalog = "datasets" | "data-services" | "concepts" | "information-models" | "services";

interface Treff {
  id: string;
  title?: Record<string, string>;
  description?: Record<string, string>;
  organization?: { name?: string };
  isOpenData?: boolean;
  fdkFormatPrefixed?: string[];
}

function tekst(v?: Record<string, string>): string | undefined {
  return v?.nb ?? v?.no ?? v?.nn ?? v?.en;
}

async function sok({ sok, katalog = "data-services", antall = 10 }: { sok: string; katalog?: Katalog; antall?: number }) {
  const d = await getJson<{ hits: Treff[]; page?: { totalElements?: number } }>(`${SEARCH}/${katalog}`, {
    method: "POST",
    body: { query: sok, pagination: { size: Math.min(antall, 50), page: 0 } },
  });

  return {
    sok,
    katalog,
    totaltAntallTreff: d.page?.totalElements ?? d.hits.length,
    treff: d.hits.map((h) => ({
      id: h.id,
      tittel: tekst(h.title),
      utgiver: h.organization?.name,
      apneData: h.isOpenData,
      formater: h.fdkFormatPrefixed,
    })),
    hint:
      katalog === "data-services"
        ? "Bruk fdk_detaljer for å få selve endepunkt-URL-en."
        : "Merk: datasett-oppføringer lenker ofte til en nettside, ikke til data. Søk i \"data-services\" når du er ute etter et API.",
  };
}

async function detaljer({ id, katalog = "data-services" }: { id: string; katalog?: Katalog }) {
  const r = await getJson<Record<string, any>>(`${RESOURCE}/${katalog}/${encodeURIComponent(id)}`);

  const flat = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : []);

  return {
    id,
    tittel: tekst(r.title),
    beskrivelse: tekst(r.description)?.slice(0, 600),
    utgiver: r.publisher?.name ?? r.publisher?.prefLabel?.nb,
    lisens: r.license?.[0]?.uri ?? r.accessRights?.code,
    // The whole point of this tool: the machine-readable entry point, if the
    // publisher bothered to register one.
    endepunkt: [...flat(r.endpointUrl), ...flat(r.endpointDescription)],
    distribusjoner: (r.distribution ?? []).map((d: any) => ({
      format: d.fdkFormat?.[0]?.name ?? d.format?.[0],
      url: flat(d.downloadURL)[0] ?? flat(d.accessURL)[0],
    })),
  };
}

export const fdk: Source = {
  id: "fdk",
  name: "Felles datakatalog (data.norge.no)",
  homepage: "https://data.norge.no/",
  requiresKeyEnv: null,
  attribution: {
    licence: "NLOD 2.0",
    credit: "Kilde: Digitaliseringsdirektoratet / Felles datakatalog",
    termsUrl: "https://data.norge.no/",
  },
  tools: [
    {
      name: "sok",
      title: "Datakatalogen: finnes det data om dette?",
      description:
        "Søker i den nasjonale katalogen når ingen av de typede kildene dekker spørsmålet. " +
        "Søk i \"data-services\" for API-er — datasett-oppføringer lenker ofte bare til en nettside.",
      inputSchema: {
        sok: z.string(),
        katalog: z.enum(["datasets", "data-services", "concepts", "information-models", "services"]).optional(),
        antall: z.number().int().min(1).max(50).optional(),
      },
      run: sok,
    },
    {
      name: "detaljer",
      title: "Datakatalogen: hent endepunkt og lisens for en oppføring",
      description:
        "Full metadata for én katalogoppføring, inkludert den maskinlesbare endepunkt-URL-en og lisensen.",
      inputSchema: {
        id: z.string().describe("Id fra fdk_sok"),
        katalog: z.enum(["datasets", "data-services", "concepts", "information-models", "services"]).optional(),
      },
      run: detaljer,
    },
  ],
};
