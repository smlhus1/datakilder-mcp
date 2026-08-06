#!/usr/bin/env node
/**
 * Hvilke av de maskinlesbare API-spec-ene i sveipen er nøkkelfrie?
 *
 * Bakgrunnen: sveipen (scripts/sveip-apier.mjs) fant 40 spec-er som svarer med
 * JSON. Ti av dem er Skatteetatens, og de så ut som ti nye kilder. De er
 * Maskinporten-sikret og handler om navngitte personer — verdiløse for en
 * nøkkelfri server. Å telle spec-er er ikke å telle tilgjengelige data.
 *
 * Sikkerhetskravet står i spec-en selv, så det koster ett skript å vite det i
 * stedet for en halv dags koding. Kjør dette FØR du bygger en modul.
 *
 * MERK: dette forteller hvor du skal se, ikke hva som er sant. Brønnøysunds
 * regnskaps-API oppgir basicAuth i spec-en og svarer likevel åpent (se
 * brreg_regnskap i røyktesten). Behandle «krever auth» som et hint om å prøve
 * kallet, ikke som en dom.
 *
 * Kjør: node scripts/sjekk-auth.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const rot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sveip = JSON.parse(readFileSync(join(rot, "data/api-sveip.json"), "utf8"));

const kandidater = sveip.kandidater.filter(
  (k) => (k.ct ?? "").includes("json") && k.status === 200,
);

const apne = [];
const lukket = [];
const feilet = [];

for (const k of kandidater) {
  try {
    const res = await fetch(k.url, { headers: { accept: "application/json" } });
    if (!res.ok) {
      feilet.push({ ...k, grunn: `HTTP ${res.status}` });
      continue;
    }
    const spec = await res.json();
    // OpenAPI 3 kaller det securitySchemes, Swagger 2 securityDefinitions. En
    // tom global `security: []` betyr eksplisitt åpen.
    const skjemaer = Object.keys(
      spec.components?.securitySchemes ?? spec.securityDefinitions ?? {},
    );
    const krav = Array.isArray(spec.security) ? spec.security.length : 0;
    const rad = {
      utgiver: k.utgiver,
      tittel: k.tittel,
      url: k.url,
      skjemaer,
      server: spec.servers?.[0]?.url,
    };
    (skjemaer.length || krav ? lukket : apne).push(rad);
  } catch (err) {
    feilet.push({ ...k, grunn: err.message });
  }
}

console.log(`spec-er sjekket: ${kandidater.length}\n`);

console.log(`NØKKELFRIE (${apne.length}):`);
for (const r of apne) console.log(`  ${r.utgiver} — ${r.tittel}`);

console.log(`\nKREVER AUTH (${lukket.length}):`);
for (const r of lukket) console.log(`  ${r.utgiver} — ${r.tittel}  [${r.skjemaer.join(", ")}]`);

if (feilet.length) {
  console.log(`\nSVARTE IKKE (${feilet.length}):`);
  for (const r of feilet) console.log(`  ${r.utgiver} — ${r.tittel}: ${r.grunn}`);
}
