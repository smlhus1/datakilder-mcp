import { z } from "zod";
import { getJson } from "../http.js";
import { flattenJsonStat, type JsonStat2 } from "../jsonstat.js";
import { type Source } from "../source.js";

/**
 * Eurostat — EU statistics.
 *
 * Not Norwegian, but it carries Norway as a `geo` and answers the questions no
 * Norwegian source does: comparable European series. The restverdi tool uses it
 * for used-car price drift (CP0712), where SSB has no equivalent index.
 *
 * It returns json-stat2, exactly like SSB — which is why the parser is shared
 * rather than written twice. Eurostat's variant is sparse (empty cells omitted
 * from the value object), handled in jsonstat.ts.
 *
 * Verified live 2026-08-05 against prc_hicp_midx.
 */

const BASE = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0";

async function data({
  datasett,
  filtre = {},
  sisteperioder,
}: {
  datasett: string;
  filtre?: Record<string, string>;
  sisteperioder?: number;
}) {
  const p = new URLSearchParams({ format: "JSON", lang: "EN" });
  for (const [k, v] of Object.entries(filtre)) p.set(k, v);
  if (sisteperioder) p.set("lastTimePeriod", String(sisteperioder));

  const d = await getJson<JsonStat2 & { label?: string }>(`${BASE}/data/${encodeURIComponent(datasett)}?${p}`);

  return {
    datasett,
    tittel: d.label,
    filtre,
    rader: flattenJsonStat(d),
    hint:
      "Uten filtre kan et datasett bli svært stort. Begrens med geo (f.eks. NO), unit og " +
      "datasettets egne dimensjoner, og bruk sisteperioder for korte tidsserier.",
  };
}

interface Metadata {
  label?: string;
  dimension: Record<string, { label?: string; category: { index?: Record<string, number> | string[]; label?: Record<string, string> } }>;
  id: string[];
}

async function info({ datasett }: { datasett: string }) {
  // Asking for one period is the cheapest way to see a dataset's shape: the
  // response carries the full dimension metadata but almost no values.
  const d = await getJson<Metadata>(
    `${BASE}/data/${encodeURIComponent(datasett)}?format=JSON&lang=EN&lastTimePeriod=1`,
  );

  return {
    datasett,
    tittel: d.label,
    dimensjoner: d.id.map((id) => {
      const dim = d.dimension[id];
      const idx = dim.category.index;
      const koder = Array.isArray(idx) ? idx : Object.keys(idx ?? {});
      return {
        kode: id,
        navn: dim.label,
        antallVerdier: koder.length,
        eksempler: koder.slice(0, 8).map((k) => ({ kode: k, tekst: dim.category.label?.[k] })),
      };
    }),
  };
}

export const eurostat: Source = {
  id: "eurostat",
  name: "Eurostat (EU-statistikk)",
  homepage: "https://ec.europa.eu/eurostat/web/main/data/web-services",
  requiresKeyEnv: null,
  attribution: {
    licence: "Eurostat copyright/licence policy (gjenbruk tillatt med kildehenvisning)",
    credit: "Kilde: Eurostat",
    termsUrl: "https://ec.europa.eu/eurostat/about-us/policies/copyright",
  },
  tools: [
    {
      name: "info",
      title: "Eurostat: hvilke dimensjoner har datasettet?",
      description:
        "Viser dimensjonene i et Eurostat-datasett med eksempelkoder. Kjør denne før du henter data — " +
        "kodeverket er ikke til å gjette.",
      inputSchema: { datasett: z.string().describe("Datasettkode, f.eks. \"prc_hicp_midx\"") },
      run: info,
    },
    {
      name: "data",
      title: "Eurostat: hent tall",
      description:
        "Henter tall fra et Eurostat-datasett som ferdige rader. Filtrer på dimensjonene " +
        "(geo, unit, coicop ...) for å holde svaret lite.",
      inputSchema: {
        datasett: z.string(),
        filtre: z
          .record(z.string(), z.string())
          .optional()
          .describe("Dimensjonsfiltre, f.eks. { geo: \"NO\", coicop: \"CP0712\", unit: \"I15\" }"),
        sisteperioder: z.number().int().min(1).max(120).optional().describe("Antall siste perioder"),
      },
      run: data,
    },
  ],
};
