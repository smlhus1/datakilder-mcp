import { z } from "zod";
import { TTL } from "../cache.js";
import { getJson } from "../http.js";
import { SourceError, type Source } from "../source.js";

/**
 * Utdanningsdirektoratet — Nasjonalt skoleregister (NSR).
 *
 * The API ignores its own filter parameters: /enheter returns the entire 7.5 MB
 * registry whether you ask for one municipality, a name match, or a single page
 * (verified 2026-08-05 — ?navn=, ?kommunenr= and ?antallPerSide= all return the
 * same full payload). Rather than pay 7.5 MB per question, fetch it once per
 * process and filter in memory. Lookup by id does work, so that goes straight out.
 */

const BASE = "https://data-nsr.udir.no";

interface Enhet {
  NSRId: number;
  OrgNr?: string;
  Navn?: string;
  FulltNavn?: string;
  KommuneNavn?: string;
  KommuneNr?: string;
  FylkeNr?: string;
  Epost?: string | null;
  ErAktiv?: boolean;
  ErSkole?: boolean;
  ErGrunnSkole?: boolean;
  ErVideregaaendeSkole?: boolean;
  ErPrivatSkole?: boolean;
  ErOffentligSkole?: boolean;
}

/**
 * Process-lifetime cache of the full registry.
 *
 * Not a TTL cache on purpose: the school register changes a few times a year, an
 * MCP server is short-lived, and a stale school name is a far smaller problem than
 * re-downloading 7.5 MB on every question.
 */
let alle: Enhet[] | null = null;

async function hentAlle(): Promise<Enhet[]> {
  if (!alle) alle = await getJson<Enhet[]>(`${BASE}/enheter`, { cacheTtlMs: TTL.uke });
  return alle;
}

function tidy(e: Enhet) {
  return {
    id: e.NSRId,
    navn: e.FulltNavn?.trim() || e.Navn,
    orgnr: e.OrgNr,
    kommune: e.KommuneNavn,
    kommunenummer: e.KommuneNr,
    epost: e.Epost ?? undefined,
    aktiv: e.ErAktiv,
    type: [
      e.ErGrunnSkole ? "grunnskole" : null,
      e.ErVideregaaendeSkole ? "videregående" : null,
      e.ErPrivatSkole ? "privat" : e.ErOffentligSkole ? "offentlig" : null,
    ]
      .filter(Boolean)
      .join(", "),
  };
}

async function skoler({
  navn,
  kommunenummer,
  baraktive = true,
  antall = 20,
}: {
  navn?: string;
  kommunenummer?: string;
  baraktive?: boolean;
  antall?: number;
}) {
  if (!navn && !kommunenummer) {
    throw new SourceError("Oppgi navn og/eller kommunenummer — registeret har over 20 000 enheter.");
  }

  const reg = await hentAlle();
  const treff = reg.filter((e) => {
    if (baraktive && e.ErAktiv === false) return false;
    if (kommunenummer && e.KommuneNr !== kommunenummer) return false;
    if (navn) {
      const hay = `${e.Navn ?? ""} ${e.FulltNavn ?? ""}`.toLowerCase();
      if (!hay.includes(navn.toLowerCase())) return false;
    }
    return true;
  });

  return {
    sok: { navn, kommunenummer, baraktive },
    totaltIRegisteret: reg.length,
    antallTreff: treff.length,
    enheter: treff.slice(0, Math.min(antall, 100)).map(tidy),
    avkortet: treff.length > Math.min(antall, 100),
  };
}

async function skole({ id }: { id: number }) {
  try {
    return tidy(await getJson<Enhet>(`${BASE}/enhet/${id}`, { cacheTtlMs: TTL.uke }));
  } catch (err) {
    if (err instanceof SourceError && err.status === 404) {
      throw new SourceError(`Fant ingen enhet med NSR-id ${id}. Finn id-en med udir_skoler.`);
    }
    throw err;
  }
}

/**
 * GREP — læreplanverket (LK20). A different API on a different host, same agency.
 *
 * Everything in GREP is multilingual: titles arrive as {tekst: [{spraak, verdi}]}
 * with bokmål, nynorsk, English and northern Sámi. One helper flattens that, or
 * every field below would repeat the same five lines.
 */
const GREP = "https://data.udir.no/kl06/v201906";

type Flerspraaklig = string | { tekst?: Array<{ spraak?: string; verdi?: string }> } | Array<{ spraak?: string; verdi?: string }> | null | undefined;

/** Bokmål when it exists, otherwise whatever the curriculum calls its default. */
function tekst(v: Flerspraaklig): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v;
  const liste = Array.isArray(v) ? v : v.tekst;
  if (!liste?.length) return undefined;
  const valgt = liste.find((t) => t.spraak === "nob") ?? liste.find((t) => t.spraak === "default") ?? liste[0];
  return valgt?.verdi;
}

/** GREP marks up its assessment texts as HTML; a model wants the sentences. */
function utenTagger(s: string | undefined): string | undefined {
  return s?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

interface GrepRef {
  kode: string;
  tittel?: Flerspraaklig;
  "url-data"?: string;
}

interface Laereplan extends GrepRef {
  kortform?: Flerspraaklig;
  "gyldig-fra"?: string | null;
  "gyldig-til"?: string | null;
  "kompetansemaal-kapittel"?: { kompetansemaalsett?: GrepRef[] };
}

/**
 * Curricula are replaced on a date, and the old one stays in the catalogue.
 *
 * Not a detail: MAT01-05 expired 2026-07-31 and MAT01-06 took over the next day,
 * so "matematikk 1.–10. trinn" matches two plans with different goals depending
 * on which week you ask. Answering from the expired one is silently wrong.
 */
function gjelderNaa(p: Laereplan, naa = Date.now()): boolean {
  const fra = p["gyldig-fra"] ? Date.parse(p["gyldig-fra"]) : -Infinity;
  const til = p["gyldig-til"] ? Date.parse(p["gyldig-til"]) : Infinity;
  return fra <= naa && naa <= til;
}

interface Maalsett extends GrepRef {
  "etter-aarstrinn"?: GrepRef[];
  "kompetansemaal-ingress"?: Flerspraaklig;
  kompetansemaal?: GrepRef[];
  underveisvurdering?: { beskrivelse?: Flerspraaklig };
}

async function laereplaner(): Promise<Laereplan[]> {
  // The whole LK20 catalogue is 296 kB and changes when a curriculum is revised —
  // a few times a year, not a few times a day.
  return getJson<Laereplan[]>(`${GREP}/laereplaner-lk20`, { cacheTtlMs: TTL.maned });
}

function planNavn(p: Laereplan): string | undefined {
  return tekst(p.tittel) ?? tekst(p.kortform);
}

function matcher(p: Laereplan, q: string): boolean {
  return p.kode.toLowerCase().includes(q) || (planNavn(p) ?? "").toLowerCase().includes(q);
}

async function laereplan({
  sok,
  ogsaUtgaatte = false,
  antall = 10,
}: {
  sok: string;
  ogsaUtgaatte?: boolean;
  antall?: number;
}) {
  const alle = await laereplaner();
  const q = sok.toLowerCase();
  const treff = alle.filter((p) => matcher(p, q) && (ogsaUtgaatte || gjelderNaa(p)));

  return {
    sok,
    antallTreff: treff.length,
    avTotalt: alle.length,
    utgaatteSkjult: ogsaUtgaatte ? 0 : alle.filter((p) => matcher(p, q) && !gjelderNaa(p)).length,
    laereplaner: treff.slice(0, Math.min(antall, 50)).map((p) => ({
      kode: p.kode,
      tittel: planNavn(p),
      gjelder: gjelderNaa(p),
      gyldigFra: p["gyldig-fra"]?.slice(0, 10),
      gyldigTil: p["gyldig-til"]?.slice(0, 10),
    })),
    avkortet: treff.length > Math.min(antall, 50),
  };
}

/** A code looks like MAT01-06 or NOR01-06; anything else is treated as a search. */
function erKode(s: string): boolean {
  return /^[A-ZÆØÅ]{2,6}\d/.test(s.trim().toUpperCase());
}

/**
 * "matematikk" matches twelve curricula — depth study, X, 2P, S, R, vg1 and the
 * ordinary 1.–10. Taking the first hit gave "fordypning i matematikk" for a
 * sixth-grader. The year level is the disambiguator we already have, so rank on
 * it and then confirm against the actual data.
 */
function rangerKandidater(alle: Laereplan[], fag: string, trinn: number | string): Laereplan[] {
  const q = fag.toLowerCase();
  const kandidater = alle.filter((p) => matcher(p, q) && gjelderNaa(p));

  const dekkerTrinn = (p: Laereplan) => {
    const navn = planNavn(p) ?? "";
    if (typeof trinn === "string") return navn.toLowerCase().includes(trinn.toLowerCase());
    const m = /(\d+)\.\s*[–-]\s*(\d+)\.\s*trinn/.exec(navn);
    return m ? trinn >= Number(m[1]) && trinn <= Number(m[2]) : false;
  };

  return kandidater.sort((a, b) => {
    if (dekkerTrinn(a) !== dekkerTrinn(b)) return dekkerTrinn(a) ? -1 : 1;
    // Shortest title as tie-break: every qualifier ("fellesfag", "for realfag",
    // "forberedende opplæring for voksne") makes a plan more specialised.
    return (planNavn(a) ?? "").length - (planNavn(b) ?? "").length;
  });
}

/**
 * Year levels are `aarstrinn1`–`aarstrinn10` and then `vg1`–`vg3` — upper
 * secondary is not numbered 11–13, so a plain number cannot address it.
 */
function trinnKode(trinn: number | string): string {
  return typeof trinn === "number" ? `aarstrinn${trinn}` : trinn;
}

function trinnNummer(kode: string): number | undefined {
  const n = Number(/^aarstrinn(\d+)$/.exec(kode)?.[1]);
  return Number.isFinite(n) ? n : undefined;
}

function trinnFor(s: Maalsett): string[] {
  return (s["etter-aarstrinn"] ?? []).map((t) => t.kode);
}

/**
 * LK20 sets goals after 2nd, 4th, 7th and 10th grade — not every year. Asking
 * for 3rd grade is a perfectly good question, and failing on it would be a tool
 * enforcing the data model on the user. Answer with the goals the pupil is
 * working towards, and say that is what happened.
 */
function velgTrinn(
  sett: Maalsett[],
  trinn: number | string,
): { treff: Maalsett[]; etterTrinn: string } | null {
  const onsket = trinnKode(trinn);
  const eksakt = sett.filter((s) => trinnFor(s).includes(onsket));
  if (eksakt.length) return { treff: eksakt, etterTrinn: onsket };

  // Only grades 1–10 form a sequence worth walking upwards; vg1–vg3 are separate
  // programme years, and guessing across them would be a different subject.
  const fra = trinnNummer(onsket);
  if (fra === undefined) return null;

  const neste = sett
    .flatMap(trinnFor)
    .map(trinnNummer)
    .filter((n): n is number => n !== undefined && n > fra)
    .sort((a, b) => a - b)[0];
  if (neste === undefined) return null;

  const kode = `aarstrinn${neste}`;
  return { treff: sett.filter((s) => trinnFor(s).includes(kode)), etterTrinn: kode };
}

async function hentSett(plan: Laereplan): Promise<Maalsett[]> {
  const refs = plan["kompetansemaal-kapittel"]?.kompetansemaalsett ?? [];
  return Promise.all(
    refs.map((s) =>
      getJson<Maalsett>(`${GREP}/kompetansemaalsett-lk20/${encodeURIComponent(s.kode)}`, {
        cacheTtlMs: TTL.maned,
      }),
    ),
  );
}

async function hentPlan(kode: string): Promise<Laereplan> {
  return getJson<Laereplan>(`${GREP}/laereplaner-lk20/${encodeURIComponent(kode)}`, {
    cacheTtlMs: TTL.maned,
  }).catch(() => {
    throw new SourceError(`Fant ingen læreplan med koden "${kode}". Bruk udir_laereplan.`);
  });
}

async function kompetansemaal({ fag, aarstrinn }: { fag: string; aarstrinn: number | string }) {
  const alle = await laereplaner();
  const kandidater = erKode(fag)
    ? [await hentPlan(fag.trim().toUpperCase())]
    : rangerKandidater(alle, fag, aarstrinn);

  if (!kandidater.length) {
    throw new SourceError(
      `Fant ingen gjeldende læreplan som matcher "${fag}". Søk med udir_laereplan.`,
    );
  }

  const forsokte: string[] = [];

  // Ranking picks the likely plan; this loop is what makes it true. Three tries
  // covers "matematikk" (12 candidates) without turning one question into fifty
  // requests.
  for (const kandidat of kandidater.slice(0, 3)) {
    const plan = kandidat["kompetansemaal-kapittel"] ? kandidat : await hentPlan(kandidat.kode);
    forsokte.push(plan.kode);

    const funn = velgTrinn(await hentSett(plan), aarstrinn);
    if (!funn) continue;

    return svar(plan, kandidat, aarstrinn, funn, kandidater, forsokte);
  }

  const forste = kandidater[0]["kompetansemaal-kapittel"] ? kandidater[0] : await hentPlan(kandidater[0].kode);
  const finnes = [
    ...new Set((await hentSett(forste)).flatMap((s) => s["etter-aarstrinn"]?.map((t) => tekst(t.tittel)) ?? [])),
  ];
  throw new SourceError(
    `Fant ingen kompetansemål for ${trinnNavn(aarstrinn)} i ${forsokte.join(", ")}. ` +
      `${planNavn(forste)} dekker: ${finnes.join(", ") || "ingen årstrinn oppgitt"}.`,
  );
}

/** "6. trinn" / "vg1" — used in messages, so both forms read naturally. */
function trinnNavn(trinn: number | string): string {
  return typeof trinn === "number" ? `${trinn}. trinn` : String(trinn);
}

function svar(
  plan: Laereplan,
  listeOppforing: Laereplan,
  aarstrinn: number | string,
  funn: { treff: Maalsett[]; etterTrinn: string },
  kandidater: Laereplan[],
  forsokte: string[],
) {
  const { treff, etterTrinn } = funn;
  return {
    laereplan: {
      kode: plan.kode,
      tittel: planNavn(plan),
      // The validity dates live on the catalogue entry, not on the detail
      // document, so take them from whichever of the two has them.
      gyldigFra: (plan["gyldig-fra"] ?? listeOppforing["gyldig-fra"])?.slice(0, 10),
    },
    // The search matched more than one curriculum, so say which one this answer
    // came from and what else it could have been.
    andreKandidater: kandidater
      .filter((p) => p.kode !== plan.kode && !forsokte.includes(p.kode))
      .slice(0, 5)
      .map((p) => ({ kode: p.kode, tittel: planNavn(p) })),
    aarstrinn,
    gjelderEtterTrinn: trinnNummer(etterTrinn) ?? etterTrinn,
    merknad:
      etterTrinn === trinnKode(aarstrinn)
        ? undefined
        : `Læreplanverket setter ikke kompetansemål etter ${trinnNavn(aarstrinn)} i dette faget. ` +
          `Dette er målene etter ${trinnNavn(trinnNummer(etterTrinn) ?? etterTrinn)} — det eleven jobber mot.`,
    maalsett: treff.map((s) => ({
      kode: s.kode,
      tittel: tekst(s.tittel),
      ingress: tekst(s["kompetansemaal-ingress"]),
      // The goals carry their text in the set, so the whole answer is one round
      // trip per set rather than one per goal.
      kompetansemaal: (s.kompetansemaal ?? []).map((m) => ({
        kode: m.kode,
        maal: tekst(m.tittel),
      })),
      underveisvurdering: utenTagger(tekst(s.underveisvurdering?.beskrivelse)),
    })),
  };
}

export const udir: Source = {
  id: "udir",
  name: "Utdanningsdirektoratet (skoleregister + læreplanverket)",
  homepage: "https://data-nsr.udir.no/",
  requiresKeyEnv: null,
  helse: { verktoy: "laereplan", args: { sok: "MAT01", antall: 1 } },
  attribution: {
    licence: "NLOD 2.0",
    credit: "Kilde: Utdanningsdirektoratet (NSR)",
    termsUrl: "https://www.udir.no/",
  },
  tools: [
    {
      name: "skoler",
      title: "UDIR: søk etter skoler",
      description:
        "Søker i det nasjonale skoleregisteret på navn og/eller kommunenummer. " +
        "Gir NSR-id, organisasjonsnummer, kommune og skoletype.",
      inputSchema: {
        navn: z.string().optional(),
        kommunenummer: z.string().optional().describe("F.eks. \"3101\" for Halden"),
        baraktive: z.boolean().optional().describe("Standard true"),
        antall: z.number().int().min(1).max(100).optional(),
      },
      run: skoler,
    },
    {
      name: "skole",
      title: "UDIR: slå opp én skole",
      description: "Henter detaljer for én enhet i skoleregisteret via NSR-id.",
      inputSchema: { id: z.number().int().describe("NSR-id fra udir_skoler") },
      run: skole,
    },
    {
      name: "kompetansemaal",
      title: "UDIR: hva skal eleven kunne i dette faget på dette trinnet?",
      description:
        "Kompetansemålene fra læreplanverket (LK20) for ett fag etter ett årstrinn — det eleven " +
        "skal kunne, pluss teksten om underveisvurdering. Oppgi fag som navn (\"matematikk\") " +
        "eller læreplankode (\"MAT01-06\"), og årstrinn 1–13. Bruk denne når spørsmålet handler " +
        "om hva som forventes på et trinn, ikke om en bestemt skole.",
      inputSchema: {
        fag: z.string().describe("Fagnavn eller læreplankode, f.eks. \"naturfag\" eller \"NAT01-04\""),
        aarstrinn: z
          .union([z.number().int().min(1).max(10), z.enum(["vg1", "vg2", "vg3"])])
          .describe(
            "Årstrinn 1–10, eller \"vg1\"/\"vg2\"/\"vg3\". Videregående er ikke nummerert 11–13 i " +
              "læreplanverket.",
          ),
      },
      run: kompetansemaal,
    },
    {
      name: "laereplan",
      title: "UDIR: finn en læreplan",
      description:
        "Søker i alle gjeldende LK20-læreplaner på navn eller kode. Gir koden du trenger for " +
        "udir_kompetansemaal.",
      inputSchema: {
        sok: z.string().describe("Fagnavn eller del av kode, f.eks. \"kunst\" eller \"MAT\""),
        ogsaUtgaatte: z
          .boolean()
          .optional()
          .describe("Ta med planer som er erstattet. Standard false — bare det som gjelder nå."),
        antall: z.number().int().min(1).max(50).optional().describe("Standard 10"),
      },
      run: laereplan,
    },
  ],
};
