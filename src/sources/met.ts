import { z } from "zod";
import { TTL } from "../cache.js";
import { getJson } from "../http.js";
import { SourceError, type Source } from "../source.js";

/**
 * Meteorologisk institutt — api.met.no.
 *
 * Two rules learned the hard way in the vaeret PWA, both hard 403s rather than
 * helpful errors:
 *   1. A generic or missing User-Agent is blocked. Ours identifies the client
 *      and carries contact info, as MET's terms require. (Handled in http.ts.)
 *   2. More than 4 decimals of latitude/longitude is rejected. We round rather
 *      than pass through, so a caller with GPS precision still gets an answer.
 *
 * Verified live 2026-08-05.
 */

const BASE = "https://api.met.no/weatherapi";

/** ~11 m precision. 5+ decimals is a hard 403 from MET, not a warning. */
function coord(v: number, navn: string): string {
  if (!Number.isFinite(v)) throw new SourceError(`${navn} må være et tall, fikk "${v}".`);
  return v.toFixed(4);
}

interface Forecast {
  properties: {
    meta: { updated_at: string; units: Record<string, string> };
    timeseries: Array<{
      time: string;
      data: {
        instant: { details: Record<string, number> };
        next_1_hours?: { summary: { symbol_code: string }; details?: Record<string, number> };
        next_6_hours?: { summary: { symbol_code: string }; details?: Record<string, number> };
      };
    }>;
  };
}

async function varsel({ lat, lon, hoyde, timer = 24 }: { lat: number; lon: number; hoyde?: number; timer?: number }) {
  const p = new URLSearchParams({ lat: coord(lat, "lat"), lon: coord(lon, "lon") });
  // Altitude materially changes the forecast in Norway — a valley reading is
  // wrong on a mountain 15 km away. Pass it when the caller knows it.
  if (Number.isFinite(hoyde as number)) p.set("altitude", String(Math.round(hoyde as number)));

  const data = await getJson<Forecast>(`${BASE}/locationforecast/2.0/compact?${p}`, { cacheTtlMs: TTL.minutter });
  const serie = data.properties.timeseries.slice(0, Math.min(timer, 96));

  return {
    oppdatert: data.properties.meta.updated_at,
    enheter: data.properties.meta.units,
    posisjon: { lat: Number(coord(lat, "lat")), lon: Number(coord(lon, "lon")), hoyde },
    timer: serie.map((t) => ({
      tid: t.time,
      temp: t.data.instant.details.air_temperature,
      vind: t.data.instant.details.wind_speed,
      vindkast: t.data.instant.details.wind_speed_of_gust,
      vindretning: t.data.instant.details.wind_from_direction,
      fuktighet: t.data.instant.details.relative_humidity,
      trykk: t.data.instant.details.air_pressure_at_sea_level,
      skydekke: t.data.instant.details.cloud_area_fraction,
      symbol: t.data.next_1_hours?.summary.symbol_code ?? t.data.next_6_hours?.summary.symbol_code,
      nedbor_mm: t.data.next_1_hours?.details?.precipitation_amount,
    })),
  };
}

interface Alerts {
  features: Array<{
    properties: {
      title?: string;
      description?: string;
      severity?: string;
      event?: string;
      area?: string;
      certainty?: string;
    };
    when?: { interval?: string[] };
  }>;
}

async function farevarsel({ lat, lon }: { lat: number; lon: number }) {
  const p = new URLSearchParams({ lat: coord(lat, "lat"), lon: coord(lon, "lon") });
  const data = await getJson<Alerts>(`${BASE}/metalerts/2.0/current.json?${p}`, { cacheTtlMs: TTL.minutter });
  return {
    antall: data.features.length,
    varsler: data.features.map((f) => ({
      hendelse: f.properties.event,
      tittel: f.properties.title,
      alvorlighet: f.properties.severity,
      omrade: f.properties.area,
      gjelder: f.when?.interval,
      beskrivelse: f.properties.description,
    })),
  };
}

interface SunMoon {
  properties: Record<string, { time?: string; azimuth?: number } | number | string>;
}

async function solOgMane({ lat, lon, dato }: { lat: number; lon: number; dato: string }) {
  const q = (extra: Record<string, string> = {}) =>
    new URLSearchParams({ lat: coord(lat, "lat"), lon: coord(lon, "lon"), date: dato, offset: "+01:00", ...extra });

  const [sol, mane] = await Promise.all([
    getJson<SunMoon>(`${BASE}/sunrise/3.0/sun?${q()}`, { cacheTtlMs: TTL.uke }),
    getJson<SunMoon>(`${BASE}/sunrise/3.0/moon?${q()}`, { cacheTtlMs: TTL.uke }),
  ]);

  return {
    dato,
    sol: sol.properties,
    // moonphase is a bare number (0-360°), not an object — verified against api.met.no.
    mane: mane.properties,
  };
}

export const met: Source = {
  id: "met",
  name: "Meteorologisk institutt (api.met.no)",
  homepage: "https://api.met.no/",
  requiresKeyEnv: null,
  attribution: {
    licence: "NLOD 2.0 / CC BY 4.0",
    credit: "Kilde: Meteorologisk institutt (MET Norway)",
    termsUrl: "https://api.met.no/doc/TermsOfService",
  },
  tools: [
    {
      name: "varsel",
      title: "MET: værvarsel for et punkt",
      description:
        "Time-for-time værvarsel (temp, vind, kast, nedbør, symbol) for koordinater. " +
        "Oppgi høyde når du kjenner den — i Norge endrer den varselet vesentlig.",
      inputSchema: {
        lat: z.number(),
        lon: z.number(),
        hoyde: z.number().optional().describe("Meter over havet"),
        timer: z.number().int().min(1).max(96).optional().describe("Antall timer framover, standard 24"),
      },
      run: varsel,
    },
    {
      name: "farevarsel",
      title: "MET: farevarsel for et punkt",
      description: "Gjeldende farevarsel (MetAlerts) for koordinater — uvær, skred, flom, skogbrannfare.",
      inputSchema: { lat: z.number(), lon: z.number() },
      run: farevarsel,
    },
    {
      name: "sol_og_mane",
      title: "MET: soloppgang, solnedgang og månefase",
      description: "Sol- og månetider for en dato og posisjon, inkludert månefase.",
      inputSchema: {
        lat: z.number(),
        lon: z.number(),
        dato: z.string().describe("ISO-dato, f.eks. \"2026-08-05\""),
      },
      run: solOgMane,
    },
  ],
};
