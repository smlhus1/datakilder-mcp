import { z } from "zod";
import { TTL } from "../cache.js";
import { getJson } from "../http.js";
import { SourceError, type Source } from "../source.js";

/**
 * Norges geologiske undersøkelse — 28 OGC API Features services, key-free.
 *
 * Found by asking a different question than "which agency has an API": the sweep
 * of the catalogue's 1063 APIs turned up 40 machine-readable specs, and checking
 * *auth* first killed 17 of them — including all ten Skatteetaten APIs, which
 * need Maskinporten and serve data about named people. NGU was the opposite:
 * everything open, no key, no registration.
 *
 * Three tools cover all 28 services rather than one tool per service: a composite
 * for the question people actually ask ("what is the ground like here?"), a
 * generic point query for the rest, and an index so the other 24 are not invisible.
 *
 * Verified live 2026-08-06 against geo.ngu.no.
 */

const BASE = "https://geo.ngu.no/api/features";

/**
 * A zero-area bbox is a point-in-polygon query, and the server does the work.
 *
 * This is not a micro-optimisation, it is the difference between right and wrong:
 * a ±1 km box at Stians address returns 8 radon polygons, and the first one says
 * "Usikker aktsomhet". The point query returns the one polygon he actually stands
 * on — "Moderat til lav aktsomhet". A nearby answer is a wrong answer here.
 */
function bbox(lat: number, lon: number, meter = 0): string {
  if (meter <= 0) return `${lon},${lat},${lon},${lat}`;
  const dLat = meter / 111_320;
  const dLon = meter / (111_320 * Math.cos((lat * Math.PI) / 180));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat].join(",");
}

/** Metres between two nearby points. Flat-earth is accurate well past any radius this tool takes. */
function meterMellom(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * 111_320;
  const dLon = (lon2 - lon1) * 111_320 * Math.cos((lat1 * Math.PI) / 180);
  return Math.round(Math.hypot(dLat, dLon));
}

interface Feature {
  geometry?: { type: string; coordinates: unknown };
  properties?: Record<string, unknown>;
}
interface FeatureSvar {
  numberMatched?: number;
  features?: Feature[];
}

/**
 * Geology is not news: NGU stamps each dataset with a datauttaksdato that moves a
 * few times a year. A month of caching is polite to a free service and invisible
 * to the answer.
 *
 * skipGeometry unless the caller needs coordinates, because one radon polygon is
 * 17,5 MB of outline — it blew straight past the client's 8 MB ceiling, and the
 * only part we read from it is a four-field property bag. Dropping the geometry
 * takes the same answer from 17,5 MB in 5,7 s to 2 kB in 0,7 s.
 */
async function features(
  tjeneste: string,
  samling: string,
  boks: string,
  antall = 5,
  medGeometri = false,
): Promise<Feature[]> {
  const svar = await getJson<FeatureSvar>(
    `${BASE}/${encodeURIComponent(tjeneste)}/collections/${encodeURIComponent(samling)}/items` +
      `?bbox=${boks}&limit=${antall}&f=json${medGeometri ? "" : "&skipGeometry=true"}`,
    { cacheTtlMs: TTL.maned },
  );
  return svar.features ?? [];
}

async function forsok<T>(navn: string, f: () => Promise<T>, mangler: string[]): Promise<T | undefined> {
  try {
    return await f();
  } catch (err) {
    mangler.push(`${navn} (${(err as Error).message.slice(0, 80)})`);
    return undefined;
  }
}

function egenskap(f: Feature | undefined, navn: string): string | undefined {
  const v = f?.properties?.[navn];
  return v == null ? undefined : String(v);
}

async function grunnforhold({
  lat,
  lon,
  radius_m = 500,
}: {
  lat: number;
  lon: number;
  radius_m?: number;
}) {
  const mangler: string[] = [];
  const punktBoks = bbox(lat, lon);

  const [radon, losmasse, marin, energibronn, grunnvannbronn] = await Promise.all([
    forsok("radon", () => features("radonaktsomhet", "radonaktsomhet", punktBoks, 1), mangler),
    forsok("løsmasser", () => features("losmasselokalt", "losmasseflate", punktBoks, 1), mangler),
    forsok("marin grense", () => features("maringrense", "maringrenseflate", punktBoks, 1), mangler),
    // Wells are the one case that needs geometry: their coordinates are the
    // distance. They are points, so it costs nothing.
    forsok(
      "energibrønner",
      () => features("grunnvannborehull", "energibronn", bbox(lat, lon, radius_m), 200, true),
      mangler,
    ),
    forsok(
      "grunnvannsbrønner",
      () => features("grunnvannborehull", "grunnvannbronn", bbox(lat, lon, radius_m), 200, true),
      mangler,
    ),
  ]);

  const bronner = [...(energibronn ?? []), ...(grunnvannbronn ?? [])]
    .map((f) => {
      const k = (f.geometry?.coordinates ?? []) as number[];
      return {
        meter: k.length >= 2 ? meterMellom(lat, lon, k[1], k[0]) : undefined,
        type: egenskap(f, "geolMedium"),
        boret_lengde_m: f.properties?.boretLengde as number | undefined,
        dyp_til_berg_m: f.properties?.boretLengdeTilBerg as number | undefined,
        boret: egenskap(f, "boreDato")?.slice(0, 10),
        bruk: egenskap(f, "brønnBrukOmfang"),
      };
    })
    .sort((a, b) => (a.meter ?? Infinity) - (b.meter ?? Infinity));

  // "Areal under marin grense" / "Areal over marin grense" is stated by the
  // dataset itself, so no inference from elevation is needed — and none should be
  // made: the marine limit varies from ~10 to ~220 moh across Norway.
  const marinTema = egenskap(marin?.[0], "annetKvTemaNavn");

  return {
    posisjon: { lat, lon },
    radon: radon?.[0]
      ? {
          grad: egenskap(radon[0], "aktsomhetGrad"),
          beskrivelse: egenskap(radon[0], "aktsomhetGradNavn"),
        }
      : null,
    losmasse: losmasse?.[0]
      ? {
          type: egenskap(losmasse[0], "løsmassetype"),
          beskrivelse: egenskap(losmasse[0], "løsmassetypeNavn"),
        }
      : null,
    marin_grense: marinTema?.includes("under") ? "under" : marinTema?.includes("over") ? "over" : null,
    bronner: {
      radius_m,
      antall: bronner.length,
      naermeste: bronner.slice(0, 5),
    },
    // Naming what could not be fetched, because an absent radon field must never
    // read as "no radon risk here".
    mangler: mangler.length ? mangler : undefined,
    forbehold:
      "Aktsomhetskart, ikke måling: radon må måles i boligen, og løsmassekartet er tolket i " +
      "grov målestokk. Under marin grense kan det finnes marin leire — skredfaresoner er NVEs " +
      "datasett, søk dem opp med kart_finn(\"skredfare\").",
  };
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
  const svar = await getJson<Samlinger>(
    `${BASE}/${encodeURIComponent(tjeneste)}/collections?f=json`,
    { cacheTtlMs: TTL.uke },
  ).catch(() => {
    throw new SourceError(
      `Fant ikke NGU-tjenesten "${tjeneste}". Bruk ngu_tjenester for gyldige navn.`,
    );
  });

  const alle = (svar.collections ?? []).map((c) => c.id);
  if (!alle.length) throw new SourceError(`"${tjeneste}" har ingen samlinger.`);

  const valgte = samling ? [samling] : alle.filter((id) => !ADMIN.has(id));
  const boks = bbox(lat, lon, radius_m);

  const resultater = await Promise.all(
    valgte.map(async (id) => ({
      samling: id,
      treff: await features(tjeneste, id, boks, antall).catch(() => null),
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
    // should be able to see that they exist and ask for one by name.
    hoppet_over: samling ? [] : alle.filter((id) => ADMIN.has(id)),
    feilet: resultater.filter((r) => r.treff === null).map((r) => r.samling),
  };
}

interface Indeks {
  apis?: Array<{ id: string; title?: string; description?: string }>;
}

async function tjenester({ sok }: { sok?: string }) {
  const indeks = await getJson<Indeks>(`${BASE}?f=json`, { cacheTtlMs: TTL.uke });
  const alle = indeks.apis ?? [];
  const q = sok?.toLowerCase();

  const treff = q
    ? alle.filter((a) => `${a.title} ${a.description}`.toLowerCase().includes(q))
    : alle;

  return {
    antall: treff.length,
    av: alle.length,
    tjenester: treff.map((a) => ({
      id: a.id,
      tittel: a.title,
      // Descriptions run to several paragraphs; enough to choose, not to read.
      om: a.description?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200),
    })),
  };
}

export const ngu: Source = {
  id: "ngu",
  name: "Norges geologiske undersøkelse (OGC API Features)",
  homepage: "https://geo.ngu.no/api/features",
  requiresKeyEnv: null,
  attribution: {
    licence: "NLOD 2.0 / CC BY 4.0",
    credit: "Kilde: Norges geologiske undersøkelse (NGU)",
    termsUrl: "https://www.ngu.no/",
  },
  tools: [
    {
      name: "grunnforhold",
      title: "NGU: grunnforhold i et punkt",
      description:
        "Hva består grunnen av på dette koordinatet — radon-aktsomhet, løsmassetype, om punktet " +
        "ligger under eller over marin grense, og registrerte energi- og grunnvannsbrønner i " +
        "nærheten (med boredybde og dyp til fjell). Bruk denne ved boligkjøp, tomtevurdering, " +
        "graving eller planlegging av bergvarme. Deler som ikke kunne hentes står i «mangler».",
      inputSchema: {
        lat: z.number(),
        lon: z.number(),
        radius_m: z
          .number()
          .int()
          .min(50)
          .max(5000)
          .optional()
          .describe("Søkeradius for brønner i meter, standard 500"),
      },
      run: grunnforhold,
    },
    {
      name: "punkt",
      title: "NGU: spør en hvilken som helst NGU-tjeneste om et punkt",
      description:
        "Henter geologiske data i et punkt (eller innenfor en radius) fra en av NGUs 28 " +
        "OGC-tjenester — marine bunnsedimenter, grunn gass, permafrost, grunnundersøkelser m.m. " +
        "Finn tjenestenavnet med ngu_tjenester først. Uten «samling» spørres alle datasamlinger " +
        "i tjenesten unntatt kartblad-/avgrensningslag, som listes i «hoppet_over».",
      inputSchema: {
        tjeneste: z.string().describe("Tjeneste-id fra ngu_tjenester, f.eks. \"grunnvannborehull\""),
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
      title: "NGU: hvilke geologiske datasett finnes?",
      description:
        "Lister NGUs 28 åpne OGC API Features-tjenester med id og beskrivelse, valgfritt filtrert " +
        "på søkeord (f.eks. «løsmasser», «marin», «grunnvann»). Id-en herfra brukes i ngu_punkt.",
      inputSchema: {
        sok: z.string().optional().describe("Filtrer på ord i tittel eller beskrivelse"),
      },
      run: tjenester,
    },
  ],
};
