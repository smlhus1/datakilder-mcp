#!/usr/bin/env node
/**
 * Prove the .mcpb actually runs — unpacked, from a directory that has never seen
 * `npm install`.
 *
 * `mcpb pack` succeeding only proves a zip was written. What matters is whether
 * the server starts on a machine with no toolchain and no dependencies of its
 * own, which is exactly the machine it is built for. So: unpack somewhere else,
 * speak MCP to it over stdio, and check the Swedish tools are there.
 *
 * Run: npm run bundle && node scripts/verifiser-bundle.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MCPB = join(ROT, "build", "datakilder.mcpb");

const ut = mkdtempSync(join(tmpdir(), "mcpb-verify-"));
console.log(`pakker ut i ${ut}`);
execFileSync("npx", ["--yes", "@anthropic-ai/mcpb", "unpack", MCPB, ut], { stdio: "inherit" });

// Start it the way the manifest says Claude will: node, entry point, nothing else.
const server = spawn("node", [join(ut, "dist", "index.js")], {
  stdio: ["pipe", "pipe", "pipe"],
  // A bare environment: no repo, no node_modules to fall back on.
  cwd: tmpdir(),
});

let stderr = "";
server.stderr.on("data", (d) => (stderr += d));

const svar = [];
let buffer = "";
server.stdout.on("data", (d) => {
  buffer += d;
  for (const linje of buffer.split("\n").slice(0, -1)) {
    if (linje.trim()) svar.push(JSON.parse(linje));
  }
  buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
});

const send = (melding) => server.stdin.write(JSON.stringify(melding) + "\n");

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "bundle-verifier", version: "1" },
  },
});

await new Promise((r) => setTimeout(r, 2500));
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
await new Promise((r) => setTimeout(r, 2500));

server.kill();

const init = svar.find((s) => s.id === 1);
const liste = svar.find((s) => s.id === 2);

if (!init) {
  console.error(`✗ serveren svarte ikke på initialize.\nstderr:\n${stderr.slice(0, 800)}`);
  process.exit(1);
}
console.log(`✓ initialize — ${init.result?.serverInfo?.name} ${init.result?.serverInfo?.version ?? ""}`);

const verktøy = (liste?.result?.tools ?? []).map((t) => t.name);
if (verktøy.length === 0) {
  console.error(`✗ ingen verktøy i tools/list.\nstderr:\n${stderr.slice(0, 800)}`);
  process.exit(1);
}

const svenske = verktøy.filter((n) => /^(scb|smhi|skolverket)_/.test(n));
console.log(`✓ tools/list — ${verktøy.length} verktøy, hvorav ${svenske.length} svenske`);
console.log(`  ${svenske.join(", ")}`);

const mangler = ["scb_finn_tabell", "smhi_stasjoner", "skolverket_skoler"].filter((n) => !verktøy.includes(n));
if (mangler.length > 0) {
  console.error(`✗ mangler: ${mangler.join(", ")}`);
  process.exit(1);
}

rmSync(ut, { recursive: true, force: true });
console.log("\n✓ bundlen kjører uten repoet, uten npm install.");
