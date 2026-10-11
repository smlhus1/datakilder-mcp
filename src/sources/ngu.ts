import { z } from "zod";
import { type Source } from "../source.js";
import { bbox, features as ogcFeatures, meterMellom, type Feature } from "./ogc.js";

/**
 * Norges geologiske undersøkelse — the ground under a given address.
 *
 * Found by asking a different question than "which agency has an API": the sweep
 * of the catalogue's 1063 APIs turned up 40 machine-readable specs, and checking
 * *auth* first killed 17 of them — including all ten Skatteetaten APIs, which
 * need Maskinporten and serve data about named people. NGU was the opposite:
 * everything open, no key, no registration.
 *
 * Only the composite lives here. Reaching NGU's other 27 services is the generic
 * ogc_punkt's job — they are the same protocol as Havforskningsinstituttet's, and
 * a second copy of that client would be a second thing to fix. What is NGU-specific
 * is knowing WHICH four services answer "is this a good place to buy a house", and
 * which field in each carries the answer.
 *
 * Verified live 2026-08-06 against geo.ngu.no; radon fields re-checked 2026-10-11 (dataset v2).
 */

const BASE = "https://geo.ngu.no/api/features";

/** NGU's services are separate OGC endpoints under one host. */
function features(tjeneste: string, samling: string, boks: string, antall = 5, medGeometri = false) {
  return ogcFeatures(`${BASE}/${encodeURIComponent(tjeneste)}`, samling, boks, antall, medGeometri);
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
    // The bbox is a square, so its corners reach radius × √2 — a "500 m" search
    // was quietly returning wells 700 m away. The parameter says radius, so the
    // answer has to be a radius.
    .filter((b) => b.meter !== undefined && b.meter <= radius_m)
    .sort((a, b) => (a.meter ?? Infinity) - (b.meter ?? Infinity));

  // "Areal under marin grense" / "Areal over marin grense" is stated by the
  // dataset itself, so no inference from elevation is needed — and none should be
  // made: the marine limit varies from ~10 to ~220 moh across Norway.
  const marinTema = egenskap(marin?.[0], "annetKvTemaNavn");

  // Radon dataset v2 (Sept 2026) renamed aktsomhetGrad → radonAktsomhetGrad and
  // dropped the *Navn text field; the value is now a code like "megetHøy". A hit
  // without the field means NGU changed the schema again — say so instead of
  // returning an empty object that reads as "no radon risk".
  const radonGrad = egenskap(radon?.[0], "radonAktsomhetGrad");
  if (radon?.[0] && !radonGrad) mangler.push("radon (NGU svarte uten radonAktsomhetGrad — nytt skjema?)");

  return {
    posisjon: { lat, lon },
    radon: radonGrad
      ? {
          grad: radonGrad,
          beskrivelse: radonGrad.replace(/([a-zæøå])([A-ZÆØÅ])/g, "$1 $2").toLowerCase(),
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

export const ngu: Source = {
  id: "ngu",
  name: "Norges geologiske undersøkelse (grunnforhold)",
  homepage: "https://geo.ngu.no/api/features",
  requiresKeyEnv: null,
  helse: { verktoy: "grunnforhold", args: { lat: 59.1249, lon: 11.3875, radius_m: 50 } },
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
        "graving eller planlegging av bergvarme. Deler som ikke kunne hentes står i «mangler». " +
        "For NGUs 27 andre datasett (havbunn, permafrost, grunn gass): bruk ogc_punkt.",
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
  ],
};
