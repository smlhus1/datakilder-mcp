import { z } from "zod";
import { TTL } from "../cache.js";
import { getJson } from "../http.js";
import { SourceError, type Source } from "../source.js";

/**
 * Generic OGC API Features client — one module covering every Norwegian agency
 * that speaks the protocol.
 *
 * Same argument as the WMS client: NGU's 28 services and Havforskningsinstituttet's
 * 110 collections are not 138 integrations, they are one protocol. Wrapping the
 * protocol once means a dataset nobody has thought about yet is already reachable,
 * and a new publisher costs one line in the registry.
 *
 * But "same protocol" is not "same behaviour", and the differences are the kind
 * that fail silently:
 *   - A zero-area bbox is a point-in-polygon query on BOTH servers (verified at a
 *     polygon vertex, which must intersect if degenerate boxes work at all).
 *   - skipGeometry is honoured by NGU and ignored by HI. NGU sends 2 kB where it
 *     would otherwise send 17,5 MB; HI sends the outline whatever we ask. The flag
 *     goes out anyway — harmless where ignored — and http.ts's size ceiling is the
 *     backstop. Geometry is never returned to the caller either way.
 *
 * Verified live 2026-08-06 against geo.ngu.no and kart.hi.no.
 */

/**
 * Services that do not publish a machine-readable index of themselves. One line
 * each; NGU's 28 are discovered instead.
 */
const KJENTE = [
  {
    id: "hi-mareano",
    navn: "Havforskningsinstituttet — Mareano (havbunn, biotoper, sedimenter)",
    base: "https://kart.hi.no/mareano/ogc/features/v1",
  },
  {
    id: "hi-gytefelt",
    navn: "Havforskningsinstituttet — kystbestandskartlegging (gytefelt)",
    base: "https://kart.hi.no/data/kystbestandskartlegging/ogc/features/v1",
  },
];

const NGU_INDEKS = "https://geo.ngu.no/api/features";

interface Tjeneste {
  id: string;
  navn?: string;
  base: string;
}

interface NguIndeks {
  apis?: Array<{ id: string; title?: string; description?: string; landingPageUri?: string }>;
}

/** NGU publishes an index of its own services, so it is read rather than listed here. */
async function registeret(): Promise<Tjeneste[]> {
  const ngu = await getJson<NguIndeks>(`${NGU_INDEKS}?f=json`, { cacheTtlMs: TTL.uke }).catch(
    () => ({}) as NguIndeks,
  );
  return [
    ...(ngu.apis ?? []).map((a) => ({
      id: `ngu:${a.id}`,
      navn: `NGU — ${a.title}`,
      base: a.landingPageUri ?? `${NGU_INDEKS}/${a.id}`,
    })),
    ...KJENTE,
  ];
}

async function finnBase(tjeneste: string): Promise<string> {
  // An explicit URL is the escape hatch: any Norwegian OGC service, registered or not.
  if (/^https?:\/\//i.test(tjeneste)) {
    const u = new URL(tjeneste);
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      throw new SourceError(`Bare http(s) støttes, fikk "${u.protocol}".`);
    }
    return tjeneste.replace(/\/+$/, "");
  }

  const treff = (await registeret()).find((t) => t.id === tjeneste);
  if (!treff) {
    throw new SourceError(
      `Kjenner ikke tjenesten "${tjeneste}". Bruk ogc_tjenester for gyldige navn, ` +
        `eller oppgi landingssiden som full URL.`,
    );
  }
  return treff.base;
}

/**
 * A zero-area bbox is a point-in-polygon query, and the server does the work.
 *
 * Not a micro-optimisation: a ±1 km box at an address in Halden returns eight
 * radon polygons, and the first says "Usikker aktsomhet". The point query returns
 * the one polygon the address stands in — "Moderat til lav". A nearby answer is a
 * wrong answer.
 */
export function bbox(lat: number, lon: number, meter = 0): string {
  if (meter <= 0) return `${lon},${lat},${lon},${lat}`;
  const dLat = meter / 111_320;
  const dLon = meter / (111_320 * Math.cos((lat * Math.PI) / 180));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat].join(",");
}

/** Metres between two nearby points. Flat-earth is accurate well past any radius here. */
export function meterMellom(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * 111_320;
  const dLon = (lon2 - lon1) * 111_320 * Math.cos((lat1 * Math.PI) / 180);
  return Math.round(Math.hypot(dLat, dLon));
}

export interface Feature {
  geometry?: { type: string; coordinates: unknown };
  properties?: Record<string, unknown>;
}

interface FeatureSvar {
  numberMatched?: number;
  features?: Feature[];
}

/**
 * Geology and seabed mapping are not news: these datasets carry an extraction date
 * that moves a few times a year. A month of caching is polite to a free service and
 * invisible to the answer.
 */
export async function features(
  base: string,
  samling: string,
  boks: string,
  antall = 5,
  medGeometri = false,
): Promise<Feature[]> {
  const svar = await getJson<FeatureSvar>(
    `${base}/collections/${encodeURIComponent(samling)}/items` +
      `?bbox=${boks}&limit=${antall}&f=json${medGeometri ? "" : "&skipGeometry=true"}`,
    { cacheTtlMs: TTL.maned },
  );
  return svar.features ?? [];
}

/** Collections that describe the map sheet rather than the ground. */
const ADMIN = new Set([
  "dataavgrensning",
  "dekning",
  "dekningsvakhetssonerfjell",
  "fiktivdelelinje",
  "geolavgrlinje",
  "kartbladkant",
  "temakartavgrensning",
]);

interface Samlinger {
  collections?: Array<{ id: string; title?: string }>;
}

export async function samlinger(base: string): Promise<string[]> {
  const svar = await getJson<Samlinger>(`${base}/collections?f=json`, { cacheTtlMs: TTL.uke });
  return (svar.collections ?? []).map((c) => c.id);
}

async function punkt({
  tjeneste,
  lat,
  lon,
  radius_m = 0,
  samling,
  antall = 5,
}: {
  tjeneste: string;
  lat: number;
  lon: number;
  radius_m?: number;
  samling?: string;
  antall?: number;
}) {
  const base = await finnBase(tjeneste);
  const alle = await samlinger(base).catch(() => {
    throw new SourceError(`${base} svarte ikke som en OGC API Features-tjeneste.`);
  });
  if (!alle.length) throw new SourceError(`"${tjeneste}" har ingen datasamlinger.`);

  const valgte = samling ? [samling] : alle.filter((id) => !ADMIN.has(id));
  const boks = bbox(lat, lon, radius_m);

  const resultater = await Promise.all(
    valgte.map(async (id) => ({
      samling: id,
      treff: await features(base, id, boks, antall).catch(() => null),
    })),
  );

  return {
    tjeneste,
    posisjon: { lat, lon },
    radius_m,
    funn: resultater
      .filter((r) => r.treff?.length)
      .map((r) => ({
        samling: r.samling,
        antall: r.treff!.length,
        egenskaper: r.treff!.map((f) => f.properties),
      })),
    uten_treff: resultater.filter((r) => r.treff?.length === 0).map((r) => r.samling),
    // Named, not silently dropped: a caller who wants the map-sheet outlines
    // should be able to see they exist and ask for one by name.
    hoppet_over: samling ? [] : alle.filter((id) => ADMIN.has(id)),
    feilet: resultater.filter((r) => r.treff === null).map((r) => r.samling),
  };
}

async function tjenester({ sok }: { sok?: string }) {
  const alle = await registeret();
  const q = sok?.toLowerCase();
  const treff = q ? alle.filter((t) => `${t.id} ${t.navn}`.toLowerCase().includes(q)) : alle;

  return {
    antall: treff.length,
    av: alle.length,
    tjenester: treff.map((t) => ({ id: t.id, navn: t.navn })),
  };
}

export const ogc: Source = {
  id: "ogc",
  name: "OGC API Features (NGU, Havforskningsinstituttet m.fl.)",
  homepage: "https://ogcapi.ogc.org/features/",
  requiresKeyEnv: null,
  helse: { verktoy: "tjenester", args: {} },
  attribution: {
    licence: "varierer per tjeneste",
    credit: "Kilder: Norges geologiske undersøkelse, Havforskningsinstituttet m.fl.",
    termsUrl: "https://www.ngu.no/",
  },
  tools: [
    {
      name: "punkt",
      title: "OGC: hva finnes i dette punktet?",
      description:
        "Henter data i et koordinat (eller innenfor en radius) fra en norsk OGC API " +
        "Features-tjeneste — geologi fra NGU, havbunn og gytefelt fra Havforskningsinstituttet. " +
        "Finn tjenestenavnet med ogc_tjenester, eller oppgi landingssiden som full URL. Uten " +
        "«samling» spørres alle datasamlinger unntatt kartblad-/avgrensningslag, som listes i " +
        "«hoppet_over». For grunnforhold ved en bolig: bruk ngu_grunnforhold i stedet.",
      inputSchema: {
        tjeneste: z
          .string()
          .describe("Id fra ogc_tjenester, f.eks. \"ngu:grunnvannborehull\" eller \"hi-gytefelt\" — eller full URL"),
        lat: z.number(),
        lon: z.number(),
        radius_m: z
          .number()
          .int()
          .min(0)
          .max(20000)
          .optional()
          .describe("0 = nøyaktig punkt (standard). Punktdata som brønner krever radius."),
        samling: z.string().optional().describe("Én bestemt datasamling i tjenesten"),
        antall: z.number().int().min(1).max(50).optional().describe("Maks objekter per samling, standard 5"),
      },
      run: punkt,
    },
    {
      name: "tjenester",
      title: "OGC: hvilke norske datasett kan spørres i et punkt?",
      description:
        "Lister kjente norske OGC API Features-tjenester med id og beskrivelse, valgfritt " +
        "filtrert på søkeord (f.eks. «løsmasser», «gytefelt», «grunnvann»). NGUs 28 tjenester " +
        "hentes fra deres egen indeks, så lista er fersk. Id-en herfra brukes i ogc_punkt.",
      inputSchema: {
        sok: z.string().optional().describe("Filtrer på ord i id eller navn"),
      },
      run: tjenester,
    },
  ],
};
