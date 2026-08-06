#!/usr/bin/env node
/**
 * Er kildene oppe akkurat nå? Samme sjekk som MCP-verktøyet `doctor`, på kommandolinja.
 *
 * Kjør: npm run build && npm run doctor
 */
import { doctor } from "../dist/doctor.js";

const r = await doctor();

const ikon = { ok: "✓", feil: "✗", mangler_nøkkel: "🔑", ikke_sjekket: "?" };
for (const k of r.kilder) {
  const tid = k.ms === undefined ? "" : `${String(k.ms).padStart(5)} ms`;
  console.log(`${ikon[k.status] ?? "?"} ${k.id.padEnd(12)} ${tid}  ${k.detalj ?? k.navn}`);
}

const o = r.oppsummering;
console.log(
  `\n${o.ok} oppe · ${o.feil} nede · ${o["mangler_nøkkel"]} mangler nøkkel · ` +
    `${o.ikke_sjekket} ikke sjekket — ${r.brukt_ms} ms`,
);

// Non-zero only for real failures: a missing key is a choice, not a broken source.
process.exit(o.feil ? 1 : 0);
