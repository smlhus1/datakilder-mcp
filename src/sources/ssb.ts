import { z } from "zod";
import { getJson } from "../http.js";
import { flattenJsonStat, type JsonStat2 } from "../jsonstat.js";
import { SourceError, type Source } from "../source.js";

/**
 * Statistisk sentralbyrå — PxWebApi v0.
 *
 * SSB is the source that costs the most to guess at, which is why it is first.
 * A table is a cube: every variable (region, age, year, ...) must be selected
 * before you get numbers, the variable codes differ per table, and the values
 * are opaque codes ("3101" is Halden). So the two tools are deliberately split:
 * ask what the table contains, THEN ask for numbers. A single do-everything tool
 * would force the model to invent dimension codes, which is how you get confident
 * nonsense.
 *
 * Verified live 2026-08-05 against table 07459.
 */

const BASE = "https://data.ssb.no/api/v0/no/table";

interface TableMeta {
  title: string;
  variables: Array<{
    code: string;
    text: string;
    values: string[];
    valueTexts: string[];
    elimination?: boolean;
    time?: boolean;
  }>;
}

async function tableInfo({ tabell }: { tabell: string }) {
  const meta = await getJson<TableMeta>(`${BASE}/${encodeURIComponent(tabell)}`);
  return {
    tabell,
    tittel: meta.title,
    // Values are truncated: a region variable holds ~400 municipality codes and
    // dumping them all would bury the useful part of the answer.
    variabler: meta.variables.map((v) => ({
      kode: v.code,
      navn: v.text,
      erTid: Boolean(v.time),
      kanUtelates: Boolean(v.elimination),
      antallVerdier: v.values.length,
      eksempler: v.values.slice(0, 8).map((val, i) => ({ kode: val, tekst: v.valueTexts[i] })),
    })),
    hint:
      "Bruk ssb_tabell_data med ett utvalg per variabel. " +
      "Tid: {filter:'top', values:['5']} gir de fem siste periodene. " +
      "Trenger du flere verdier for en variabel, hent dem via ssb_tabell_verdier.",
  };
}

async function tableValues({ tabell, variabel, søk }: { tabell: string; variabel: string; søk?: string }) {
  const meta = await getJson<TableMeta>(`${BASE}/${encodeURIComponent(tabell)}`);
  const v = meta.variables.find((x) => x.code.toLowerCase() === variabel.toLowerCase());
  if (!v) {
    throw new SourceError(
      `Tabell ${tabell} har ingen variabel "${variabel}". Den har: ${meta.variables.map((x) => x.code).join(", ")}`,
    );
  }
  const pairs = v.values.map((val, i) => ({ kode: val, tekst: v.valueTexts[i] }));
  const treff = søk ? pairs.filter((p) => p.tekst.toLowerCase().includes(søk.toLowerCase())) : pairs;
  return {
    tabell,
    variabel: v.code,
    antall: treff.length,
    // Cap the payload; a search that matches everything is a search that failed.
    verdier: treff.slice(0, 200),
    avkortet: treff.length > 200,
  };
}

async function tableData({ tabell, utvalg }: { tabell: string; utvalg: Array<{ kode: string; filter?: string; verdier: string[] }> }) {
  const body = {
    query: utvalg.map((s) => ({
      code: s.kode,
      selection: { filter: s.filter ?? "item", values: s.verdier },
    })),
    response: { format: "json-stat2" },
  };

  const data = await getJson<JsonStat2>(`${BASE}/${encodeURIComponent(tabell)}`, {
    method: "POST",
    body,
  });

  return { tabell, tittel: data.label, rader: flattenJsonStat(data) };
}


export const ssb: Source = {
  id: "ssb",
  name: "Statistisk sentralbyrå (PxWebApi)",
  homepage: "https://data.ssb.no/api/",
  requiresKeyEnv: null,
  attribution: {
    licence: "NLOD 2.0",
    credit: "Kilde: Statistisk sentralbyrå (SSB)",
    termsUrl: "https://www.ssb.no/informasjon/copyright",
  },
  tools: [
    {
      name: "tabell_info",
      title: "SSB: hva inneholder tabellen?",
      description:
        "Lister variablene i en SSB-tabell (region, alder, år ...) med eksempelverdier. " +
        "Kjør denne FØR du henter data, ellers må du gjette dimensjonskodene.",
      inputSchema: { tabell: z.string().describe("Tabellnummer, f.eks. \"07459\"") },
      run: tableInfo,
    },
    {
      name: "tabell_verdier",
      title: "SSB: slå opp gyldige koder for én variabel",
      description:
        "Gir kode/tekst-parene for én variabel i en tabell, valgfritt filtrert på søketekst. " +
        "Bruk den til å finne f.eks. kommunekoden for Halden før du henter tall.",
      inputSchema: {
        tabell: z.string(),
        variabel: z.string().describe("Variabelkode fra tabell_info, f.eks. \"Region\""),
        søk: z.string().optional().describe("Filtrer på tekst, f.eks. \"Halden\""),
      },
      run: tableValues,
    },
    {
      name: "tabell_data",
      title: "SSB: hent tall fra en tabell",
      description:
        "Henter tall fra en SSB-tabell og returnerer ferdige rader med etiketter (ikke rå json-stat). " +
        "Angi ett utvalg per variabel du vil begrense.",
      inputSchema: {
        tabell: z.string(),
        utvalg: z
          .array(
            z.object({
              kode: z.string().describe("Variabelkode, f.eks. \"Region\""),
              filter: z
                .string()
                .optional()
                .describe("\"item\" (standard), \"top\" for de N siste, eller \"all\" med jokertegn"),
              verdier: z.array(z.string()).describe("Koder, eller antall når filter=\"top\""),
            }),
          )
          .describe("Ett utvalg per variabel. Utelatte variabler aggregeres bort hvis tabellen tillater det."),
      },
      run: tableData,
    },
  ],
};
