import { z } from "zod";
import { getJson } from "../http.js";
import { SourceError, type Source } from "../source.js";

/**
 * Entur — Norwegian public transport (all operators, one API).
 *
 * Not in the FDK catalogue, which is itself a small argument for this server:
 * the national catalogue does not list one of the most useful open APIs in Norway.
 *
 * Entur is GraphQL and requires an ET-Client-Name header. Stop places are opaque
 * NSR ids, so the tools are split: find the stop, then ask for departures. Same
 * reasoning as SSB — a single tool would force the model to invent ids.
 *
 * Verified live 2026-08-05.
 */

const GRAPHQL = "https://api.entur.io/journey-planner/v3/graphql";
const GEOCODER = "https://api.entur.io/geocoder/v1";
const HEADERS = { "ET-Client-Name": "datakilder-mcp" };

async function graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await getJson<{ data?: T; errors?: Array<{ message: string }> }>(GRAPHQL, {
    method: "POST",
    headers: HEADERS,
    body: { query, variables },
  });
  if (res.errors?.length) {
    throw new SourceError(`Entur avviste spørringen: ${res.errors.map((e) => e.message).join("; ")}`);
  }
  if (!res.data) throw new SourceError("Entur svarte uten data.");
  return res.data;
}

interface GeoSvar {
  features: Array<{
    properties: { id: string; label: string; locality?: string; category?: string[] };
    geometry: { coordinates: [number, number] };
  }>;
}

async function stoppested({ sok, antall = 5 }: { sok: string; antall?: number }) {
  const p = new URLSearchParams({ text: sok, size: String(Math.min(antall, 20)), lang: "no" });
  const d = await getJson<GeoSvar>(`${GEOCODER}/autocomplete?${p}`, { headers: HEADERS });
  return {
    sok,
    stoppesteder: d.features.map((f) => ({
      id: f.properties.id,
      navn: f.properties.label,
      sted: f.properties.locality,
      kategori: f.properties.category,
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
    })),
    hint: "Bruk id-en (NSR:StopPlace:...) i entur_avganger.",
  };
}

interface AvgangSvar {
  stopPlace: {
    name: string;
    estimatedCalls: Array<{
      expectedDepartureTime: string;
      aimedDepartureTime: string;
      realtime: boolean;
      cancellation: boolean;
      destinationDisplay: { frontText: string };
      quay?: { publicCode?: string };
      serviceJourney: { line: { publicCode?: string; transportMode?: string; name?: string } };
    }>;
  } | null;
}

async function avganger({ stoppestedId, antall = 10 }: { stoppestedId: string; antall?: number }) {
  if (!/^NSR:(StopPlace|GroupOfStopPlaces):/.test(stoppestedId)) {
    throw new SourceError(
      `"${stoppestedId}" ser ikke ut som en Entur-id. Finn den med entur_stoppested — de ser ut som "NSR:StopPlace:60053".`,
    );
  }

  const d = await graphql<AvgangSvar>(
    `query($id: String!, $n: Int!) {
       stopPlace(id: $id) {
         name
         estimatedCalls(numberOfDepartures: $n) {
           expectedDepartureTime aimedDepartureTime realtime cancellation
           destinationDisplay { frontText }
           quay { publicCode }
           serviceJourney { line { publicCode transportMode name } }
         }
       }
     }`,
    { id: stoppestedId, n: Math.min(antall, 50) },
  );

  if (!d.stopPlace) throw new SourceError(`Fant ikke stoppested ${stoppestedId}.`);

  return {
    stoppested: d.stopPlace.name,
    avganger: d.stopPlace.estimatedCalls.map((c) => ({
      // Both times are returned: when they differ, the trip is delayed, and that
      // difference is usually the thing the user actually wants to know.
      forventet: c.expectedDepartureTime,
      rutetid: c.aimedDepartureTime,
      sanntid: c.realtime,
      innstilt: c.cancellation,
      linje: c.serviceJourney.line.publicCode,
      transport: c.serviceJourney.line.transportMode,
      retning: c.destinationDisplay.frontText,
      spor: c.quay?.publicCode,
    })),
  };
}

interface ReiseSvar {
  trip: {
    tripPatterns: Array<{
      duration: number;
      startTime: string;
      endTime: string;
      legs: Array<{
        mode: string;
        distance?: number;
        expectedStartTime: string;
        fromPlace: { name: string };
        toPlace: { name: string };
        line?: { publicCode?: string };
      }>;
    }>;
  };
}

async function reise({
  fraLat,
  fraLon,
  tilLat,
  tilLon,
  antall = 3,
}: {
  fraLat: number;
  fraLon: number;
  tilLat: number;
  tilLon: number;
  antall?: number;
}) {
  const d = await graphql<ReiseSvar>(
    `query($fl: Float!, $fo: Float!, $tl: Float!, $to: Float!, $n: Int!) {
       trip(from: {coordinates: {latitude: $fl, longitude: $fo}},
            to:   {coordinates: {latitude: $tl, longitude: $to}},
            numTripPatterns: $n) {
         tripPatterns {
           duration startTime endTime
           legs { mode distance expectedStartTime
                  fromPlace { name } toPlace { name } line { publicCode } }
         }
       }
     }`,
    { fl: fraLat, fo: fraLon, tl: tilLat, to: tilLon, n: Math.min(antall, 10) },
  );

  return {
    forslag: d.trip.tripPatterns.map((t) => ({
      avgang: t.startTime,
      ankomst: t.endTime,
      minutter: Math.round(t.duration / 60),
      etapper: t.legs.map((l) => ({
        transport: l.mode,
        linje: l.line?.publicCode,
        fra: l.fromPlace.name,
        til: l.toPlace.name,
        avgang: l.expectedStartTime,
      })),
    })),
  };
}

export const entur: Source = {
  id: "entur",
  name: "Entur (kollektivtrafikk, alle norske operatører)",
  homepage: "https://developer.entur.org/",
  requiresKeyEnv: null,
  attribution: {
    licence: "NLOD 2.0",
    credit: "Kilde: Entur",
    termsUrl: "https://developer.entur.org/pages-intro-setup-and-access",
  },
  tools: [
    {
      name: "stoppested",
      title: "Entur: finn stoppested",
      description:
        "Søker etter holdeplasser og stasjoner og gir Entur-id-en (NSR:StopPlace:...) du trenger for avganger.",
      inputSchema: { sok: z.string(), antall: z.number().int().min(1).max(20).optional() },
      run: stoppested,
    },
    {
      name: "avganger",
      title: "Entur: neste avganger fra et stoppested",
      description:
        "Sanntids avgangstavle: linje, retning, spor, rutetid vs. forventet tid, og om avgangen er innstilt.",
      inputSchema: {
        stoppestedId: z.string().describe("NSR-id fra entur_stoppested"),
        antall: z.number().int().min(1).max(50).optional(),
      },
      run: avganger,
    },
    {
      name: "reise",
      title: "Entur: reiseforslag mellom to punkter",
      description: "Reiseplanlegger fra koordinat til koordinat, med etapper, bytter og reisetid.",
      inputSchema: {
        fraLat: z.number(),
        fraLon: z.number(),
        tilLat: z.number(),
        tilLon: z.number(),
        antall: z.number().int().min(1).max(10).optional(),
      },
      run: reise,
    },
  ],
};
