import { z } from "zod";
import { TTL } from "../cache.js";
import { getJson } from "../http.js";
import { flattenJsonStat, type JsonStat2 } from "../jsonstat.js";
import { SourceError, type Source } from "../source.js";

/**
 * Statistiska centralbyrån — PxWebApi v1.
 *
 * The same engine as SSB, with one difference that decides the whole tool set:
 * SSB names a table with a NUMBER ("07459"), SCB with a PATH
 * ("BE/BE0101/BE0101A/BefolkningNy"). Nobody guesses that path, and PxWeb v1 has
 * no free-text search across the tree — so where SSB gets three tools, SCB needs
 * a fourth that walks the tree one level at a time.
 *
 * Everything after the lookup is identical: the metadata shape matches SSB's
 * field for field, and a query returns json-stat2, so `flattenJsonStat` is
 * reused untouched.
 *
 * Use v1. The v2beta base returns 404 (verified 2026-08-24).
 * Verified live 2026-08-24 against BE/BE0101/BE0101A/BefolkningNy.
 */

const BASE = "https://api.scb.se/OV0104/v1/doris/sv/ssd";

/** A node in the PxWeb tree: "l" is a folder to descend into, "t" is a table. */
interface TreeNode {
  id: string;
  type: "l" | "t";
  text: string;
}

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

/** Reject anything that could climb out of the catalogue path. */
function rensSti(sti: string): string {
  const deler = sti.split("/").filter(Boolean);
  if (deler.some((d) => !/^[A-Za-z0-9_]+$/.test(d))) {
    throw new SourceError(`Ugyldig sti: "${sti}". Bruk kodene fra scb_finn_tabell, f.eks. "BE/BE0101".`);
  }
  return deler.join("/");
}

async function findTable({ sti }: { sti?: string }) {
  const rensa = sti ? rensSti(sti) : "";
  // Weeks, not days: the subject tree is a taxonomy — it changes when SCB
  // reorganises a statistical area, which is a yearly event at most.
  const noder = await getJson<TreeNode[]>(`${BASE}${rensa ? `/${rensa}` : ""}`, { cacheTtlMs: TTL.uke });

  if (!Array.isArray(noder)) {
    throw new SourceError(`"${rensa}" er en tabell, ikke en mappe. Bruk scb_tabell_info på den.`);
  }

  const mapper = noder.filter((n) => n.type === "l");
  const tabeller = noder.filter((n) => n.type === "t");

  return {
    sti: rensa || "(rot)",
    mapper: mapper.map((n) => ({ kode: n.id, navn: n.text, sti: rensa ? `${rensa}/${n.id}` : n.id })),
    tabeller: tabeller.map((n) => ({ kode: n.id, navn: n.text, sti: rensa ? `${rensa}/${n.id}` : n.id })),
    hint: tabeller.length
      ? "Bruk stien til en tabell i scb_tabell_info for å se variablene."
      : "Gå videre ned i en av mappene med scb_finn_tabell.",
  };
}

async function tableInfo({ sti }: { sti: string }) {
  const meta = await getJson<TableMeta>(`${BASE}/${rensSti(sti)}`, { cacheTtlMs: TTL.uke });
  return {
    sti,
    tittel: meta.title,
    // Truncated for the same reason as SSB: a region variable holds hundreds of
    // codes and dumping them buries the useful part of the answer.
    variabler: meta.variables.map((v) => ({
      kode: v.code,
      navn: v.text,
      erTid: Boolean(v.time),
      kanUtelates: Boolean(v.elimination),
      antallVerdier: v.values.length,
      eksempler: v.values.slice(0, 8).map((val, i) => ({ kode: val, tekst: v.valueTexts[i] })),
    })),
    hint:
      "Bruk scb_tabell_data med ett utvalg per variabel. " +
      "Tid: {filter:'top', values:['5']} gir de fem siste periodene. " +
      "Trenger du flere verdier for en variabel, hent dem via scb_tabell_verdier.",
  };
}

async function tableValues({ sti, variabel, søk }: { sti: string; variabel: string; søk?: string }) {
  const meta = await getJson<TableMeta>(`${BASE}/${rensSti(sti)}`, { cacheTtlMs: TTL.uke });
  const v = meta.variables.find((x) => x.code.toLowerCase() === variabel.toLowerCase());
  if (!v) {
    throw new SourceError(
      `Tabellen ${sti} har ingen variabel "${variabel}". Den har: ${meta.variables.map((x) => x.code).join(", ")}`,
    );
  }
  const pairs = v.values.map((val, i) => ({ kode: val, tekst: v.valueTexts[i] }));
  const treff = søk ? pairs.filter((p) => p.tekst.toLowerCase().includes(søk.toLowerCase())) : pairs;
  return {
    sti,
    variabel: v.code,
    antall: treff.length,
    verdier: treff.slice(0, 200),
    avkortet: treff.length > 200,
  };
}

async function tableData({
  sti,
  utvalg,
}: {
  sti: string;
  utvalg: Array<{ kode: string; filter?: string; verdier: string[] }>;
}) {
  const data = await getJson<JsonStat2>(`${BASE}/${rensSti(sti)}`, {
    method: "POST",
    body: {
      query: utvalg.map((s) => ({
        code: s.kode,
        selection: { filter: s.filter ?? "item", values: s.verdier },
      })),
      response: { format: "json-stat2" },
    },
    cacheTtlMs: TTL.dag,
  });

  return { sti, tittel: data.label, rader: flattenJsonStat(data) };
}

export const scb: Source = {
  id: "scb",
  name: "Statistiska centralbyrån (PxWebApi v1)",
  homepage: "https://www.scb.se/vara-tjanster/oppna-data/api-for-statistikdatabasen/",
  requiresKeyEnv: null,
  helse: { verktoy: "finn_tabell", args: {} },
  attribution: {
    licence: "CC0 1.0",
    credit: "Källa: Statistiska centralbyrån (SCB)",
    termsUrl: "https://www.scb.se/vara-tjanster/oppna-data/villkor-for-anvandning/",
  },
  tools: [
    {
      name: "finn_tabell",
      title: "SCB: finn fram til en tabell",
      description:
        "Navigerer SCBs emnetre ett nivå om gangen og viser mapper og tabeller. " +
        "SCB identifiserer tabeller med en sti (\"BE/BE0101/BE0101A/BefolkningNy\"), ikke et nummer, " +
        "så START HER — uten stien kan ingen av de andre verktøyene brukes. " +
        "Kall uten argument for toppnivået (Befolkning, Arbetsmarknad, ...).",
      inputSchema: {
        sti: z
          .string()
          .optional()
          .describe("Sti fra et tidligere kall, f.eks. \"BE/BE0101\". Utelat for toppnivået."),
      },
      run: findTable,
    },
    {
      name: "tabell_info",
      title: "SCB: hva inneholder tabellen?",
      description:
        "Lister variablene i en SCB-tabell (region, ålder, år ...) med eksempelverdier. " +
        "Kjør denne FØR du henter data, ellers må du gjette dimensjonskodene.",
      inputSchema: { sti: z.string().describe("Tabellsti fra scb_finn_tabell") },
      run: tableInfo,
    },
    {
      name: "tabell_verdier",
      title: "SCB: slå opp gyldige koder for én variabel",
      description:
        "Gir kode/tekst-parene for én variabel i en tabell, valgfritt filtrert på søketekst. " +
        "Bruk den til å finne f.eks. kommunekoden for Malmö før du henter tall.",
      inputSchema: {
        sti: z.string(),
        variabel: z.string().describe("Variabelkode fra tabell_info, f.eks. \"Region\""),
        søk: z.string().optional().describe("Filtrer på tekst, f.eks. \"Malmö\""),
      },
      run: tableValues,
    },
    {
      name: "tabell_data",
      title: "SCB: hent tall fra en tabell",
      description:
        "Henter tall fra en SCB-tabell og returnerer ferdige rader med etiketter (ikke rå json-stat). " +
        "Angi ett utvalg per variabel du vil begrense.",
      inputSchema: {
        sti: z.string(),
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
