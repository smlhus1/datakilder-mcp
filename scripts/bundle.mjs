#!/usr/bin/env node
/**
 * Build the .mcpb bundle — the install path for people who do not use a terminal.
 *
 * Micke, who asked for the Swedish sources, is not technical. The README's
 * clone → npm install → build → edit-a-JSON-path recipe is not something to ask
 * of him; a .mcpb is a file he double-clicks in Claude's desktop app.
 *
 * Staged in a clean directory rather than packed in place: the repo carries
 * 48 MB of node_modules, of which only two packages are production
 * dependencies. Packing the working tree would ship TypeScript, the probe data
 * and a PDF report to every user.
 *
 * Run: npm run bundle
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STAGE = join(ROT, "build", "bundle");
const UT = join(ROT, "build", "datakilder.mcpb");

const pakke = JSON.parse(readFileSync(join(ROT, "package.json"), "utf8"));

rmSync(join(ROT, "build"), { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

for (const fil of ["manifest.json", "README.md", "LICENSE"]) {
  cpSync(join(ROT, fil), join(STAGE, fil));
}
cpSync(join(ROT, "dist"), join(STAGE, "dist"), { recursive: true });

// kart.ts requires this at import time, so leaving it out does not degrade the
// map source — it stops the whole server from starting. Found by running the
// unpacked bundle, not by packing it; `mcpb pack` was perfectly happy.
// Only this file: the rest of data/ is survey output, not runtime input.
mkdirSync(join(STAGE, "data"), { recursive: true });
cpSync(join(ROT, "data", "kartindeks.json"), join(STAGE, "data", "kartindeks.json"));

// A package.json with only the runtime deps, so `npm install` in the stage
// pulls the two packages the server actually needs and nothing else.
writeFileSync(
  join(STAGE, "package.json"),
  JSON.stringify(
    {
      name: pakke.name,
      version: pakke.version,
      type: pakke.type,
      dependencies: pakke.dependencies,
    },
    null,
    2,
  ) + "\n",
);

console.log("installerer produksjonsavhengigheter i staging…");
execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--silent"], {
  cwd: STAGE,
  stdio: "inherit",
});

console.log("pakker…");
execFileSync("npx", ["--yes", "@anthropic-ai/mcpb", "pack", STAGE, UT], { stdio: "inherit" });

const mb = (statSync(UT).size / 1024 / 1024).toFixed(1);
console.log(`\n→ ${UT} (${mb} MB)`);
console.log("Installer: Claude → Settings → Extensions → Install Extension…");
