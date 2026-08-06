import { z } from "zod";
import { createRequire } from "node:module";
import { TTL } from "../cache.js";
import { getText } from "../http.js";
import { SourceError, type Source } from "../source.js";

/**
 * Generic WMS client — one module covering 614 of the catalogue's 1063 "APIs".
 *
 * 58 % of what data.norge.no calls an API is a WMS/WFS map layer. Those are not
 * 614 integrations; they are one protocol spoken by Kartverket, NVE, Miljø-
 * direktoratet, Havforskningsinstituttet and the rest. Wrapping the protocol once
 * beats wrapping each publisher, and it means a layer nobody has thought about yet
 * is already reachable.
 *
 * GetFeatureInfo is the tool that turns a map into data: it answers "what is at
 * this coordinate" against any layer that supports it.
 *
 * XML is parsed with targeted regex rather than a dependency. That is normally a
 * bad idea, but here it is scoped to two element types in a machine-generated
 * document, and it keeps the server dependency-free. If this ever needs real XPath,
 * add a parser rather than growing the regex.
 *
 * Verified live 2026-08-05 against wms.geonorge.no.
 */

const require = createRequire(import.meta.url);

/**
 * Harvested WMS services (scripts/hent-kartindeks.mjs). Committed rather than
 * fetched at runtime: it changes a few times a year, and a tool that needs two
 * network round trips before it can answer is a tool nobody reaches for.
 */
interface Kartindeks {
  hentet: string;
  antallTjenester: number;
  tjenester: Array<{ url: string; utgiver?: string; titler: string[] }>;
}
const INDEKS: Kartindeks = require("../../data/kartindeks.json");

function assertWmsUrl(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new SourceError(`"${url}" er ikke en gyldig URL.`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new SourceError(`Bare http(s) støttes, fikk "${u.protocol}".`);
  }
  return u;
}

/**
 * WMS answers errors as XML with status 200, so the body has to be inspected —
 * a check that would be invisible if this used getJson.
 */
async function wmsText(url: string, ttlMs: number): Promise<string> {
  const text = await getText(url, { cacheTtlMs: ttlMs });
  const feil = /<ServiceException[^>]*>([\s\S]*?)<\/ServiceException>/.exec(text);
  if (feil) throw new SourceError(`Tjenesten avviste spørringen: ${feil[1].trim().slice(0, 200)}`);
  return text;
}

function tag(xml: string, name: string): string | undefined {
  return new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(xml)?.[1]?.trim();
}

async function lag({ url, sok }: { url: string; sok?: string }) {
  const u = assertWmsUrl(url);
  u.searchParams.set("service", "WMS");
  u.searchParams.set("request", "GetCapabilities");
  u.searchParams.set("version", "1.3.0");

  const xml = await wmsText(u.toString(), TTL.uke);

  // Only <Layer> blocks that carry a <Name> are requestable; group layers without
  // one are containers and would fail if handed to GetMap.
  const lag: Array<{ navn: string; tittel?: string }> = [];
  for (const m of xml.matchAll(/<Layer[^>]*>([\s\S]*?)(?=<Layer[\s>]|<\/Layer>)/g)) {
    const navn = tag(m[1], "Name");
    if (!navn || navn === "WMS") continue;
    lag.push({ navn, tittel: tag(m[1], "Title") });
  }

  const treff = sok ? lag.filter((l) => `${l.navn} ${l.tittel ?? ""}`.toLowerCase().includes(sok.toLowerCase())) : lag;

  return {
    tjeneste: tag(xml, "Title"),
    stotterFeatureInfo: xml.includes("GetFeatureInfo"),
    antallLag: lag.length,
    lag: treff.slice(0, 80),
    avkortet: treff.length > 80,
    hint: "Bruk «navn» i kart_punkt for å spørre hva som finnes i et koordinat.",
  };
}

async function punkt({
  url,
  lag,
  lat,
  lon,
  boks = 0.002,
}: {
  url: string;
  lag: string;
  lat: number;
  lon: number;
  boks?: number;
}) {
  const u = assertWmsUrl(url);
  // GetFeatureInfo needs a pixel inside a bounding box, so we build a tiny box
  // around the point and ask about its centre pixel. CRS:84 keeps the axis order
  // lon,lat — EPSG:4326 in WMS 1.3.0 is lat,lon, which is a classic silent swap.
  const half = boks / 2;
  const params: Record<string, string> = {
    service: "WMS",
    request: "GetFeatureInfo",
    version: "1.3.0",
    layers: lag,
    query_layers: lag,
    crs: "CRS:84",
    bbox: `${lon - half},${lat - half},${lon + half},${lat + half}`,
    width: "101",
    height: "101",
    i: "50",
    j: "50",
    info_format: "text/plain",
    feature_count: "10",
  };
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);

  const svar = await wmsText(u.toString(), TTL.dag);
  return {
    lag,
    punkt: { lat, lon },
    svar: svar.trim().slice(0, 4000) || "(tomt svar — laget har trolig ingen data i dette punktet)",
  };
}


/**
 * Search the harvested index for a map service.
 *
 * Without this, kart_lag and kart_punkt only work if the caller already knows a
 * service URL — which made the largest block of coverage in this server
 * effectively invisible. Two levels on purpose: matching service titles is
 * instant, while searching layer names has to fetch GetCapabilities per service
 * (cached for a week), so the caller opts into that cost.
 */
async function finn({ sok, iLag = false }: { sok: string; iLag?: boolean }) {
  const q = sok.toLowerCase();
  const tjenester = INDEKS.tjenester.filter((t) =>
    `${t.utgiver ?? ""} ${t.titler.join(" ")} ${t.url}`.toLowerCase().includes(q),
  );

  if (!iLag) {
    return {
      sok,
      indeksHentet: INDEKS.hentet,
      antallTjenesterIIndeks: INDEKS.antallTjenester,
      antallTreff: tjenester.length,
      tjenester: tjenester.slice(0, 25),
      hint:
        tjenester.length === 0
          ? "Ingen tjeneste matchet på navn. Prøv iLag=true for å søke i selve lagnavnene, eller et bredere ord."
          : "Bruk url-en i kart_lag for å se lagene, eller kart_punkt direkte hvis du vet lagnavnet.",
    };
  }

  // Layer search: only over services whose capabilities we can actually read.
  // Bounded to 12 — each miss is a network round trip, and an unbounded sweep
  // over 130 services would take minutes on a cold cache.
  const kandidater = (tjenester.length ? tjenester : INDEKS.tjenester).slice(0, 12);
  const funn: Array<{ tjeneste: string; utgiver?: string; lag: string; tittel?: string }> = [];
  const feilet: string[] = [];

  for (const t of kandidater) {
    try {
      const res = await lag({ url: t.url, sok });
      for (const l of res.lag.slice(0, 5)) {
        funn.push({ tjeneste: t.url, utgiver: t.utgiver, lag: l.navn, tittel: l.tittel });
      }
    } catch {
      feilet.push(t.url);
    }
  }

  return {
    sok,
    sokteI: kandidater.length,
    antallLagtreff: funn.length,
    lag: funn.slice(0, 40),
    // Named, not swallowed: a service that is down should not look like "no results".
    tjenesterSomIkkeSvarte: feilet.length,
  };
}

export const kart: Source = {
  id: "kart",
  name: "Generisk WMS-klient (norske karttjenester)",
  homepage: "https://kartkatalog.geonorge.no/",
  requiresKeyEnv: null,
  helse: { verktoy: "lag", args: { url: "https://wms.geonorge.no/skwms1/wms.topo", sok: "topo" } },
  attribution: {
    licence: "varierer per tjeneste",
    credit: "Kilde: se den enkelte karttjenesten (oftest Kartverket, NVE eller Miljødirektoratet)",
    termsUrl: "https://www.geonorge.no/verktoy/vilkar-for-bruk/",
  },
  tools: [
    {
      name: "finn",
      title: "Kart: finn en karttjeneste uten å kjenne URL-en",
      description:
        "Søker i en indeks over norske WMS-tjenester høstet fra data.norge.no. " +
        "Bruk denne FØRST når du leter etter kartdata (flomsoner, dybdedata, artsutbredelse ...) " +
        "og ikke vet hvilken tjeneste som har dem. iLag=true søker også i selve lagnavnene " +
        "(tregere første gang, men treffer bredere).",
      inputSchema: {
        sok: z.string().describe("F.eks. \"flom\", \"Artsdatabanken\", \"dybde\""),
        iLag: z.boolean().optional().describe("Søk også i lagnavn inne i tjenestene"),
      },
      run: finn,
    },
    {
      name: "lag",
      title: "Kart: hvilke lag finnes i en WMS-tjeneste?",
      description:
        "Leser GetCapabilities og lister lagene som kan spørres, valgfritt filtrert på tekst. " +
        "Fungerer mot enhver norsk WMS — Geonorge, NVE, Miljødirektoratet, Havforskningsinstituttet.",
      inputSchema: {
        url: z.string().describe("Basis-URL, f.eks. \"https://wms.geonorge.no/skwms1/wms.topo\""),
        sok: z.string().optional(),
      },
      run: lag,
    },
    {
      name: "punkt",
      title: "Kart: hva finnes i dette koordinatet?",
      description:
        "GetFeatureInfo mot et kartlag: returnerer egenskapene tjenesten har i punktet. " +
        "Dette er måten å hente DATA ut av et kartlag, ikke bare et bilde.",
      inputSchema: {
        url: z.string(),
        lag: z.string().describe("Lagnavn fra kart_lag"),
        lat: z.number(),
        lon: z.number(),
        boks: z.number().optional().describe("Grader rundt punktet, standard 0.002 (~200 m)"),
      },
      run: punkt,
    },
  ],
};
