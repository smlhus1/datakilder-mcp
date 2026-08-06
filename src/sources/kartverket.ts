import { z } from "zod";
import { TTL } from "../cache.js";
import { getJson } from "../http.js";
import { type Source } from "../source.js";

/**
 * Kartverket / Geonorge — place names, addresses and elevation.
 *
 * Kartverket publishes 223 "APIs" in the national catalogue, but 160 of them are
 * WMS/WFS map layers (covered by the generic map client, not here). What is left
 * is the genuinely useful REST surface: turn a name into coordinates, coordinates
 * into an address, and a point into a height.
 *
 * Elevation earns its own tool because MET forecasts change materially with it —
 * the vaeret app got mountain temperatures wrong until it started passing height.
 *
 * Verified live 2026-08-05.
 */

const STEDSNAVN = "https://api.kartverket.no/stedsnavn/v1";
const ADRESSER = "https://ws.geonorge.no/adresser/v1";
const HOYDE = "https://ws.geonorge.no/hoydedata/v1";

interface StedsnavnSvar {
  metadata: { totaltAntallTreff: number };
  navn: Array<{
    skrivemåte?: string;
    navneobjekttype?: string;
    kommuner?: Array<{ kommunenavn?: string; kommunenummer?: string }>;
    fylker?: Array<{ fylkesnavn?: string }>;
    representasjonspunkt?: { nord?: number; øst?: number };
  }>;
}

async function sted({ sok, antall = 10 }: { sok: string; antall?: number }) {
  const p = new URLSearchParams({ sok, fuzzy: "true", treffPerSide: String(Math.min(antall, 50)) });
  const d = await getJson<StedsnavnSvar>(`${STEDSNAVN}/navn?${p}`, { cacheTtlMs: TTL.maned });
  return {
    sok,
    totaltAntallTreff: d.metadata.totaltAntallTreff,
    steder: d.navn.map((n) => ({
      navn: n.skrivemåte,
      type: n.navneobjekttype,
      kommune: n.kommuner?.[0]?.kommunenavn,
      kommunenummer: n.kommuner?.[0]?.kommunenummer,
      fylke: n.fylker?.[0]?.fylkesnavn,
      lat: n.representasjonspunkt?.nord,
      lon: n.representasjonspunkt?.øst,
    })),
  };
}

interface AdresseSvar {
  metadata: { totaltAntallTreff: number };
  adresser: Array<{
    adressetekst?: string;
    postnummer?: string;
    poststed?: string;
    kommunenavn?: string;
    kommunenummer?: string;
    representasjonspunkt?: { lat?: number; lon?: number };
  }>;
}

function tidyAdresser(d: AdresseSvar) {
  return d.adresser.map((a) => ({
    adresse: a.adressetekst,
    postnummer: a.postnummer,
    poststed: a.poststed,
    kommune: a.kommunenavn,
    kommunenummer: a.kommunenummer,
    lat: a.representasjonspunkt?.lat,
    lon: a.representasjonspunkt?.lon,
  }));
}

async function adresse({ sok, antall = 10 }: { sok: string; antall?: number }) {
  const p = new URLSearchParams({ sok, treffPerSide: String(Math.min(antall, 50)) });
  const d = await getJson<AdresseSvar>(`${ADRESSER}/sok?${p}`, { cacheTtlMs: TTL.maned });
  return { sok, totaltAntallTreff: d.metadata.totaltAntallTreff, adresser: tidyAdresser(d) };
}

async function adresseFraPunkt({ lat, lon, radius = 200 }: { lat: number; lon: number; radius?: number }) {
  const p = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    radius: String(Math.min(radius, 2000)),
    treffPerSide: "5",
  });
  const d = await getJson<AdresseSvar>(`${ADRESSER}/punktsok?${p}`, { cacheTtlMs: TTL.maned });
  return { punkt: { lat, lon }, radius, adresser: tidyAdresser(d) };
}

interface HoydeSvar {
  punkter: Array<{ z?: number | null; terreng?: string; datakilde?: string }>;
}

async function hoyde({ lat, lon }: { lat: number; lon: number }) {
  // Geonorge names the axes ost/nord, and with koordsys 4258 they are lon/lat —
  // easy to swap by accident, so the mapping is spelled out here.
  const p = new URLSearchParams({ ost: String(lon), nord: String(lat), koordsys: "4258" });
  const d = await getJson<HoydeSvar>(`${HOYDE}/punkt?${p}`, { cacheTtlMs: TTL.maned });
  const punkt = d.punkter?.[0];
  return {
    posisjon: { lat, lon },
    hoyde_moh: punkt?.z ?? null,
    terreng: punkt?.terreng,
    datakilde: punkt?.datakilde,
  };
}

export const kartverket: Source = {
  id: "kartverket",
  name: "Kartverket / Geonorge (stedsnavn, adresser, høyde)",
  homepage: "https://ws.geonorge.no/",
  requiresKeyEnv: null,
  helse: { verktoy: "sted", args: { sok: "Venabu", antall: 1 } },
  attribution: {
    licence: "CC BY 4.0",
    credit: "Kilde: Kartverket",
    termsUrl: "https://www.kartverket.no/api-og-data/vilkar-for-bruk",
  },
  tools: [
    {
      name: "sted",
      title: "Kartverket: finn stedsnavn og koordinater",
      description:
        "Søker i stedsnavnregisteret og gir koordinater, kommune og fylke. " +
        "Bruk denne for å gjøre et stedsnavn om til lat/lon før et værvarsel.",
      inputSchema: { sok: z.string(), antall: z.number().int().min(1).max(50).optional() },
      run: sted,
    },
    {
      name: "adresse",
      title: "Kartverket: søk opp adresse",
      description: "Finner offisielle adresser med postnummer, kommune og koordinater.",
      inputSchema: { sok: z.string().describe("Fritekst, f.eks. \"Karl Johans gate 1\""), antall: z.number().int().min(1).max(50).optional() },
      run: adresse,
    },
    {
      name: "adresse_fra_punkt",
      title: "Kartverket: hvilken adresse ligger her?",
      description: "Revers-geokoding: finner nærmeste adresser innenfor en radius fra et koordinatpunkt.",
      inputSchema: {
        lat: z.number(),
        lon: z.number(),
        radius: z.number().int().min(1).max(2000).optional().describe("Meter, standard 200"),
      },
      run: adresseFraPunkt,
    },
    {
      name: "hoyde",
      title: "Kartverket: høyde over havet for et punkt",
      description:
        "Terrenghøyde i meter for koordinater. Nyttig sammen med met_varsel — høyde endrer værvarselet vesentlig i Norge.",
      inputSchema: { lat: z.number(), lon: z.number() },
      run: hoyde,
    },
  ],
};
