#!/usr/bin/env node
/**
 * Recover machine-readable API specs from the HTML documentation pages.
 *
 * Stian's question: the entries that answered HTML — is there anything behind them,
 * or is it just noise? For one group there is, and I gave up too early on it.
 *
 * 31 of the live endpoints are Swagger/OpenAPI viewer pages. A viewer is HTML, but
 * it loads its spec from somewhere — usually a `url:` in an inline script, a
 * `configUrl`, or a conventional path. Earlier I guessed paths, got 404s, and moved
 * on. Reading the page to find where it actually points is the step I skipped.
 *
 * A recovered spec is worth a lot: it lists every route, parameter and response type,
 * which is exactly what a typed tool needs.
 *
 * Run: node scripts/finn-spec.mjs
 */
import { readFileSync } from "node:fs";

const UA = "datakilder-mcp (spec-leting)";
const H = { "User-Agent": UA };

const sveip = JSON.parse(readFileSync("data/api-sveip.json", "utf8"));
const doksider = sveip.resultater.filter(
  (r) => r.forventet === "dokumentasjon" && r.status >= 200 && r.status < 400,
);

console.log(`${doksider.length} dokumentasjonssider å undersøke\n`);

async function hent(url, timeoutMs = 12_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: H, signal: ctrl.signal, redirect: "follow" });
    const ct = (res.headers.get("content-type") || "").split(";")[0];
    return { ok: res.ok, status: res.status, ct, tekst: await res.text() };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Where a Swagger UI page says its spec lives. Order matters — explicit beats conventional. */
function kandidatSpecUrls(html, sideUrl) {
  const ut = new Set();
  const abs = (u) => {
    try {
      return new URL(u, sideUrl).toString();
    } catch {
      return null;
    }
  };

  // 1. Explicit in the page: url: "...", configUrl: "...", or a spec-looking href/src.
  for (const m of html.matchAll(/["'](?:url|configUrl|spec(?:Url)?)["']\s*:\s*["']([^"']+)["']/gi)) {
    const u = abs(m[1]);
    if (u) ut.add(u);
  }
  for (const m of html.matchAll(/["']([^"']*(?:swagger|openapi)[^"']*\.(?:json|ya?ml))["']/gi)) {
    const u = abs(m[1]);
    if (u) ut.add(u);
  }

  // 2. Conventional paths, tried only after the page has been asked.
  const base = new URL(sideUrl);
  for (const sti of [
    "/swagger/v1/swagger.json",
    "/swagger/v2/swagger.json",
    "/v3/api-docs",
    "/openapi.json",
    "/swagger.json",
    "/api-docs",
  ]) {
    ut.add(new URL(sti, base.origin).toString());
  }
  return [...ut];
}

function erSpec(tekst, ct) {
  if (/json|yaml/i.test(ct) === false && !/^\s*[{"]/.test(tekst)) return false;
  return /"(openapi|swagger)"\s*:/.test(tekst.slice(0, 4000));
}

const funnet = [];
for (const side of doksider) {
  const html = await hent(side.url);
  if (!html?.tekst) continue;

  // The page might already BE the spec (some entries link straight to it).
  if (erSpec(html.tekst, html.ct)) {
    funnet.push({ utgiver: side.utgiver, tittel: side.tittel, spec: side.url, via: "direkte" });
    continue;
  }

  for (const kandidat of kandidatSpecUrls(html.tekst, side.url)) {
    const r = await hent(kandidat, 8000);
    if (r?.ok && erSpec(r.tekst, r.ct)) {
      const ruter = (r.tekst.match(/"\/[^"]*"\s*:\s*\{/g) || []).length;
      funnet.push({ utgiver: side.utgiver, tittel: side.tittel, spec: kandidat, ruter, via: "gjenfunnet" });
      break;
    }
  }
}

console.log(`GJENFUNNET SPEC FOR ${funnet.length} AV ${doksider.length}:\n`);
for (const f of funnet) {
  console.log(`  ${(f.utgiver ?? "?").slice(0, 28).padEnd(30)} ${f.tittel.slice(0, 34).padEnd(36)} ${f.ruter ?? "?"} ruter`);
  console.log(`      ${f.spec.slice(0, 96)}`);
}
