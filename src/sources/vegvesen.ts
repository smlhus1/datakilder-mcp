import { z } from "zod";
import { TTL } from "../cache.js";
import { getJson } from "../http.js";
import { SourceError, type Source } from "../source.js";

/**
 * Statens vegvesen.
 *
 * Two halves with very different access:
 *   - NVDB (Nasjonal vegdatabank) is fully open — 424 object types covering speed
 *     limits, barriers, signs, road works. Built here, verified live.
 *   - Autosys (kjøretøyopplysninger, the one restverdi wants) returns 401 without
 *     an ID-porten-registered key. NOT built: an unverifiable module is worse than
 *     an honest gap, so it stays listed as pending in kilder.json until the key exists.
 *
 * NVDB requires an X-Client header identifying the caller.
 *
 * Verified live 2026-08-05.
 */

const NVDB = "https://nvdbapiles.atlas.vegvesen.no";
const HEADERS = { "X-Client": "datakilder-mcp" };

interface Objekttype {
  id: number;
  navn: string;
  beskrivelse?: string;
}

async function objekttyper({ sok }: { sok?: string }) {
  // inkluder=minimum: the full catalogue is 9.3 MB (every attribute definition for
  // all 424 types) and tripped the client's byte cap. The trimmed form is 544 KB
  // and carries everything this tool needs — id and name.
  const alle = await getJson<Objekttype[]>(`${NVDB}/vegobjekttyper?inkluder=minimum`, { headers: HEADERS, cacheTtlMs: TTL.maned });
  const treff = sok
    ? alle.filter((t) => t.navn.toLowerCase().includes(sok.toLowerCase()))
    : alle;
  return {
    totalt: alle.length,
    // The whole catalogue is 424 entries; dumping it would bury the answer.
    treff: treff.slice(0, 60).map((t) => ({ id: t.id, navn: t.navn })),
    avkortet: treff.length > 60,
    hint: "Bruk id-en i vegvesen_vegobjekter. Fartsgrense = 105.",
  };
}

interface VegobjektSvar {
  objekter: Array<{
    id: number;
    egenskaper?: Array<{ navn: string; verdi: unknown; enhet?: { kortnavn?: string } }>;
    lokasjon?: { kommuner?: number[]; adresser?: Array<{ navn?: string }> };
  }>;
}

async function vegobjekter({
  type,
  vest,
  sor,
  ost,
  nord,
  antall = 20,
}: {
  type: number;
  vest: number;
  sor: number;
  ost: number;
  nord: number;
  antall?: number;
}) {
  // NVDB has no "everything" query — a bounding box is required, and a large one
  // times out. Guard here so the caller gets a sentence instead of a 30 s hang.
  const bredde = Math.abs(ost - vest);
  const hoyde = Math.abs(nord - sor);
  if (bredde > 0.5 || hoyde > 0.5) {
    throw new SourceError(
      `Kartutsnittet er for stort (${bredde.toFixed(2)}° × ${hoyde.toFixed(2)}°). Hold deg under 0,5° per akse.`,
    );
  }

  const p = new URLSearchParams({
    kartutsnitt: `${vest},${sor},${ost},${nord}`,
    srid: "4326",
    inkluder: "egenskaper,lokasjon",
    antall: String(Math.min(antall, 100)),
  });

  const d = await getJson<VegobjektSvar>(`${NVDB}/vegobjekter/${type}?${p}`, { headers: HEADERS, cacheTtlMs: TTL.dag });

  return {
    objekttype: type,
    antall: d.objekter.length,
    objekter: d.objekter.map((o) => ({
      id: o.id,
      kommune: o.lokasjon?.kommuner?.[0],
      veger: o.lokasjon?.adresser?.map((a) => a.navn).filter(Boolean),
      egenskaper: Object.fromEntries(
        (o.egenskaper ?? []).map((e) => [e.navn, e.enhet?.kortnavn ? `${e.verdi} ${e.enhet.kortnavn}` : e.verdi]),
      ),
    })),
  };
}

export const vegvesen: Source = {
  id: "vegvesen",
  name: "Statens vegvesen (NVDB — nasjonal vegdatabank)",
  homepage: "https://nvdbapiles.atlas.vegvesen.no/dokumentasjon/",
  requiresKeyEnv: null,
  attribution: {
    licence: "NLOD 2.0",
    credit: "Kilde: Statens vegvesen (NVDB)",
    termsUrl: "https://www.vegvesen.no/om-oss/om-organisasjonen/apne-data/",
  },
  tools: [
    {
      name: "objekttyper",
      title: "Vegvesen: finn objekttype-id i NVDB",
      description:
        "Søker i NVDBs 424 vegobjekttyper (fartsgrense, rekkverk, skilt, tunnel ...) og gir id-en du trenger " +
        "for å hente objekter. Kjør denne først hvis du ikke vet id-en.",
      inputSchema: { sok: z.string().optional().describe("F.eks. \"fartsgrense\"") },
      run: objekttyper,
    },
    {
      name: "vegobjekter",
      title: "Vegvesen: hent vegobjekter i et kartutsnitt",
      description:
        "Henter NVDB-objekter av én type innenfor et kartutsnitt (WGS84), med egenskaper og vegnavn. " +
        "Fartsgrense = type 105. Utsnittet må være under 0,5° per akse.",
      inputSchema: {
        type: z.number().int().describe("Objekttype-id fra vegvesen_objekttyper"),
        vest: z.number().describe("Vestlig lengdegrad"),
        sor: z.number().describe("Sørlig breddegrad"),
        ost: z.number().describe("Østlig lengdegrad"),
        nord: z.number().describe("Nordlig breddegrad"),
        antall: z.number().int().min(1).max(100).optional(),
      },
      run: vegobjekter,
    },
  ],
};
