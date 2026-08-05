#!/usr/bin/env node
/**
 * Live smoke test: calls every source against its real API.
 *
 * Deliberately not mocked. The whole value of this server is that it knows the
 * actual shape of each API, so a test that mocks the response would only prove
 * that our own assumptions agree with themselves. This fails loudly when a
 * source changes its contract — which is exactly when we want to hear about it.
 *
 * Run: npm run build && npm run smoke
 */
import { SOURCES } from "../dist/sources/index.js";

const CASES = [
  {
    tool: "ssb_tabell_info",
    args: { tabell: "07459" },
    check: (r) => r.variabler.some((v) => v.kode === "Region"),
    describe: (r) => `${r.variabler.length} variabler — "${r.tittel.slice(0, 40)}…"`,
  },
  {
    tool: "ssb_tabell_verdier",
    args: { tabell: "07459", variabel: "Region", søk: "Halden" },
    check: (r) => r.verdier.some((v) => v.kode === "3101"),
    describe: (r) => `Halden = ${r.verdier.find((v) => v.tekst.includes("Halden"))?.kode}`,
  },
  {
    tool: "ssb_tabell_data",
    args: {
      tabell: "07459",
      utvalg: [
        { kode: "Region", verdier: ["3101"] },
        { kode: "ContentsCode", verdier: ["Personer1"] },
        { kode: "Tid", filter: "top", verdier: ["1"] },
      ],
    },
    check: (r) => r.rader.length > 0 && typeof r.rader[0].verdi === "number",
    describe: (r) => `folketall Halden: ${r.rader[0].verdi}`,
  },
  {
    tool: "brreg_foretak",
    args: { orgnr: "923 609 016" },
    check: (r) => r.navn.includes("EQUINOR") && r.status === "aktiv",
    describe: (r) => `${r.navn} — ${r.form}, ${r.status}`,
  },
  {
    tool: "brreg_søk",
    args: { navn: "Smart Innovation", antall: 3 },
    check: (r) => r.enheter.length > 0,
    describe: (r) => `${r.totaltAntallTreff} treff, første: ${r.enheter[0].navn}`,
  },
  {
    // The error path matters as much as the happy path: a bad org number must
    // produce a sentence the model can act on, not a stack trace.
    tool: "brreg_foretak",
    args: { orgnr: "12345" },
    expectError: /9 siffer/,
    describe: () => "avviser ugyldig orgnr med forklaring",
  },
];

const byName = new Map();
for (const s of SOURCES) for (const t of s.tools) byName.set(`${s.id}_${t.name}`, t);

let failed = 0;
for (const c of CASES) {
  const tool = byName.get(c.tool);
  if (!tool) {
    console.log(`✗ ${c.tool} — finnes ikke`);
    failed++;
    continue;
  }
  try {
    const result = await tool.run(c.args);
    if (c.expectError) {
      console.log(`✗ ${c.tool} — forventet feil, fikk svar`);
      failed++;
    } else if (!c.check(result)) {
      console.log(`✗ ${c.tool} — svar besto ikke sjekken: ${JSON.stringify(result).slice(0, 160)}`);
      failed++;
    } else {
      console.log(`✓ ${c.tool} — ${c.describe(result)}`);
    }
  } catch (err) {
    if (c.expectError?.test(err.message)) {
      console.log(`✓ ${c.tool} — ${c.describe()}`);
    } else {
      console.log(`✗ ${c.tool} — ${err.message}`);
      failed++;
    }
  }
}

console.log(failed ? `\n${failed} feilet` : `\nalle ${CASES.length} OK`);
process.exit(failed ? 1 : 0);
