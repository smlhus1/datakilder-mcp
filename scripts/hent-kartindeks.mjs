#!/usr/bin/env node
/**
 * Harvest every registered WMS endpoint from the national catalogue into a local index.
 *
 * WHY: kart_lag and kart_punkt already reach all 614 map layers in the catalogue —
 * but only if you know the service URL. That "if" made the largest single piece of
 * coverage in this server practically invisible. The index turns "is there a layer
 * for flood zones?" from a research project into one call.
 *
 * The result is committed to the repo (data/kartindeks.json) rather than fetched at
 * runtime: it changes a few times a year, and a tool that needs two network round
 * trips before answering is a tool nobody reaches for.
 *
 * Run: node scripts/hent-kartindeks.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";

const SEARCH = "https://search.api.fellesdatakatalog.digdir.no/search/data-services";
const RESOURCE = "https://resource.api.fellesdatakatalog.digdir.no/v1/data-services";
const UA = "datakilder-mcp (indeksbygger)";

const headers = { "User-Agent": UA, Accept: "application/json" };

async function json(url, body) {
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: body ? { ...headers, "Content-Type": "application/json" } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

const label = (v) => (v && typeof v === "object" ? (v.nb ?? v.no ?? v.nn ?? v.en) : v) ?? "";
const flat = (v) => (Array.isArray(v) ? v : v ? [v] : []).filter((x) => typeof x === "string");

/** Strip the query so one service is one entry, whatever request the catalogue registered. */
function baseUrl(u) {
  try {
    const url = new URL(u);
    url.search = "";
    return url.toString().replace(/\?$/, "");
  } catch {
    return null;
  }
}

const hits = [];
for (let page = 0; ; page++) {
  const res = await json(SEARCH, { pagination: { size: 100, page } });
  hits.push(...res.hits);
  if (page >= (res.page?.totalPages ?? 1) - 1) break;
}
console.log(`${hits.length} API-oppføringer hentet`);

const tjenester = new Map();
let sett = 0;

for (const h of hits) {
  let full;
  try {
    full = await json(`${RESOURCE}/${h.id}`);
  } catch {
    continue;
  }
  const urls = [...flat(full.endpointUrl), ...flat(full.endpointDescription)];
  for (const u of urls) {
    // Only WMS: WFS speaks a different request vocabulary, and pretending one
    // client handles both would produce confident failures.
    if (!/service=wms/i.test(u) && !/wms/i.test(new URL(u, "https://x").pathname)) continue;
    const base = baseUrl(u);
    if (!base) continue;

    sett++;
    const eksisterende = tjenester.get(base);
    const tittel = label(h.title) || label(full.title);
    const utgiver = h.organization?.name ?? label(h.organization?.prefLabel);
    if (eksisterende) {
      if (tittel && !eksisterende.titler.includes(tittel)) eksisterende.titler.push(tittel);
    } else {
      tjenester.set(base, { url: base, utgiver, titler: tittel ? [tittel] : [] });
    }
  }
}

const indeks = {
  _om: "WMS-tjenester høstet fra data.norge.no. Bygget av scripts/hent-kartindeks.mjs.",
  hentet: new Date().toISOString().slice(0, 10),
  antallTjenester: tjenester.size,
  antallOppforinger: sett,
  tjenester: [...tjenester.values()].sort((a, b) => (a.utgiver ?? "").localeCompare(b.utgiver ?? "")),
};

mkdirSync("data", { recursive: true });
writeFileSync("data/kartindeks.json", JSON.stringify(indeks, null, 1));
console.log(`${tjenester.size} unike WMS-tjenester fra ${sett} oppføringer → data/kartindeks.json`);
