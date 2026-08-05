#!/usr/bin/env node
/**
 * Probe every registered API in the national catalogue and classify what answers.
 *
 * The question this settles: how many of the 1 063 "APIs" are actually alive, and
 * how many of the live ones are something other than a map layer? Everything built
 * so far rested on titles and a 300-dataset sample; this looks at the whole
 * population.
 *
 * Deliberately a script and not a fleet of agents: 1 063 HTTP requests is I/O, not
 * judgment. Agents would be slower, cost money, and produce a result nobody could
 * reproduce. The judgment part — reading docs for the promising ones — comes after,
 * on a shortlist this produces.
 *
 * Run: node scripts/sveip-apier.mjs
 */
import { writeFileSync } from "node:fs";

const SEARCH = "https://search.api.fellesdatakatalog.digdir.no/search/data-services";
const RESOURCE = "https://resource.api.fellesdatakatalog.digdir.no/v1/data-services";
const UA = "datakilder-mcp (kartlegging, github.com/smlhus1/datakilder-mcp)";
// FDK's own APIs are rate limited (~10 req/min). Twelve concurrent requests to
// them got almost everything rejected, and the first version of this script
// swallowed those rejections with a `continue` — it processed 34 of 1063 entries
// and printed the summary as if it were complete. Catalogue calls are therefore
// sequential; only the probes, which hit other hosts, run in parallel.
const SAMTIDIGE = 12;

const H = { "User-Agent": UA, Accept: "application/json" };

async function json(url, body) {
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: body ? { ...H, "Content-Type": "application/json" } : H,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const label = (v) => (v && typeof v === "object" ? (v.nb ?? v.no ?? v.en) : v) ?? "";
const flat = (v) => (Array.isArray(v) ? v : v ? [v] : []).filter((x) => typeof x === "string");

/** What kind of thing is this, judged from the URL before we call it. */
function forventetType(u) {
  if (/service=w[mf]s|\/wms|\/wfs|\/ows|mapserver|geoserver/i.test(u)) return "kart";
  if (/swagger|openapi|\/api-?docs/i.test(u)) return "dokumentasjon";
  return "mulig-api";
}

async function probe(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(url, { headers: H, signal: ctrl.signal, redirect: "follow" });
    clearTimeout(timer);
    const ct = (res.headers.get("content-type") || "").split(";")[0];
    return { status: res.status, ct };
  } catch (err) {
    clearTimeout(timer);
    return { status: 0, ct: "", feil: err.name === "AbortError" ? "timeout" : "uåpnbar" };
  }
}

// --- hent alle oppføringer -------------------------------------------------
const hits = [];
for (let page = 0; ; page++) {
  const res = await json(SEARCH, { pagination: { size: 100, page } });
  hits.push(...res.hits);
  if (page >= (res.page?.totalPages ?? 1) - 1) break;
}
console.log(`${hits.length} API-oppføringer i katalogen`);

// --- hent endepunkter (sekvensielt: se raten over) --------------------------
const oppforinger = [];
let feiletOppslag = 0;
{
  for (const h of hits) {
      let full;
      try {
        full = await json(`${RESOURCE}/${h.id}`);
      } catch {
        // Counted, never swallowed: a silent skip is how the first run reported
        // 34 entries as if they were 1063.
        feiletOppslag++;
        continue;
      }
      const urls = [...flat(full.endpointUrl), ...flat(full.endpointDescription)];
      oppforinger.push({
        tittel: label(h.title) || label(full.title),
        utgiver: h.organization?.name ?? label(h.organization?.prefLabel),
        urls,
      });
    if (oppforinger.length % 200 === 0) console.log(`  ...${oppforinger.length} hentet`);
  }
}

const medUrl = oppforinger.filter((o) => o.urls.length);
console.log(`hentet ${oppforinger.length} av ${hits.length} oppføringer (${feiletOppslag} feilet)`);
console.log(`${medUrl.length} av dem har registrert et endepunkt`);
if (feiletOppslag > hits.length * 0.05) {
  console.log(`⚠️  ${feiletOppslag} oppslag feilet — tallene under er IKKE komplette.`);
}

// --- probe ------------------------------------------------------------------
const resultater = [];
let j = 0;
await Promise.all(
  Array.from({ length: SAMTIDIGE }, async () => {
    while (j < medUrl.length) {
      const o = medUrl[j++];
      const url = o.urls[0];
      const svar = await probe(url);
      resultater.push({ ...o, url, forventet: forventetType(url), ...svar });
      if (resultater.length % 100 === 0) console.log(`  ...${resultater.length} probet`);
    }
  }),
);

// --- oppsummer --------------------------------------------------------------
const tell = (f) => resultater.reduce((m, r) => ((m[f(r)] = (m[f(r)] ?? 0) + 1), m), {});
const levende = resultater.filter((r) => r.status >= 200 && r.status < 400);

console.log("\nSVARSTATUS:");
for (const [k, v] of Object.entries(tell((r) => (r.status === 0 ? r.feil : `${r.status}`))).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${k.padEnd(12)} ${v}`);
}

console.log("\nAV DE LEVENDE, FORVENTET TYPE:");
for (const [k, v] of Object.entries(levende.reduce((m, r) => ((m[r.forventet] = (m[r.forventet] ?? 0) + 1), m), {}))) {
  console.log(`  ${k.padEnd(14)} ${v}`);
}

// The shortlist: alive, answers JSON, and is not a map layer. This is what a
// human or an agent should look at next — everything else is already handled.
const kandidater = levende.filter(
  (r) => r.forventet !== "kart" && /json/i.test(r.ct),
);
console.log(`\nKANDIDATER (levende, JSON, ikke kart): ${kandidater.length}`);
for (const k of kandidater.slice(0, 15)) {
  console.log(`  ${(k.utgiver ?? "?").slice(0, 26).padEnd(28)} ${k.tittel.slice(0, 40)}`);
}

writeFileSync(
  "data/api-sveip.json",
  JSON.stringify({ hentet: new Date().toISOString().slice(0, 10), antall: resultater.length, kandidater, resultater }, null, 1),
);
console.log("\n→ data/api-sveip.json");
