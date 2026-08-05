#!/usr/bin/env node
/**
 * Mark a source done/skipped in kilder.json, and print progress.
 *
 * A one-line script rather than hand-editing JSON thirteen times: the sweep hook
 * reads this file, so a typo that breaks the JSON silently disables the hook
 * (it fails open by design). Writing through a script keeps it parseable.
 *
 * Usage: node scripts/status.mjs <id> done|skipped ["begrunnelse"]
 *        node scripts/status.mjs                      (bare vis framdrift)
 */
import { readFileSync, writeFileSync } from "node:fs";

const FILE = new URL("../kilder.json", import.meta.url);
const state = JSON.parse(readFileSync(FILE, "utf8"));
const [id, status, begrunnelse] = process.argv.slice(2);

if (id) {
  const k = state.kilder.find((k) => k.id === id);
  if (!k) {
    console.error(`ukjent kilde: ${id}`);
    process.exit(1);
  }
  if (!["done", "skipped", "todo"].includes(status)) {
    console.error(`status må være done|skipped|todo, fikk "${status}"`);
    process.exit(1);
  }
  k.status = status;
  if (begrunnelse) k.hvorfor = begrunnelse;
  writeFileSync(FILE, JSON.stringify(state, null, 2) + "\n");
}

const tier12 = state.kilder.filter((k) => k.tier <= 2);
const done = tier12.filter((k) => k.status !== "todo");
console.log(`tier 1-2: ${done.length}/${tier12.length} ferdig`);
const igjen = tier12.filter((k) => k.status === "todo").map((k) => k.id);
if (igjen.length) console.log(`igjen: ${igjen.join(", ")}`);

// Commit rhythm is Stian's instruction (5.8): push every N finished sources.
const n = state.sveip.commit_hver ?? 5;
if (done.length && done.length % n === 0) console.log(`\n⚠️ ${done.length} ferdig — commit + push nå.`);
