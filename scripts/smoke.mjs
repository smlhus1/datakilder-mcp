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
    tool: "met_varsel",
    args: { lat: 59.1265, lon: 11.3874, hoyde: 30, timer: 3 },
    check: (r) => r.timer.length === 3 && typeof r.timer[0].temp === "number",
    describe: (r) => `Halden nå: ${r.timer[0].temp} °C, ${r.timer[0].vind} m/s`,
  },
  {
    tool: "met_farevarsel",
    args: { lat: 59.1265, lon: 11.3874 },
    check: (r) => typeof r.antall === "number",
    describe: (r) => `${r.antall} farevarsel`,
  },
  {
    // 5+ decimals is a hard 403 from MET; we round instead of passing through.
    tool: "met_varsel",
    args: { lat: 59.126512345, lon: 11.387498765, timer: 1 },
    check: (r) => r.posisjon.lat === 59.1265,
    describe: (r) => `runder av koordinater (${r.posisjon.lat})`,
  },
  {
    tool: "kartverket_sted",
    args: { sok: "Venabu", antall: 3 },
    check: (r) => r.steder.length > 0 && typeof r.steder[0].lat === "number",
    describe: (r) => `${r.steder[0].navn} (${r.steder[0].kommune})`,
  },
  {
    tool: "kartverket_adresse",
    args: { sok: "Forstrøms vei 17", antall: 1 },
    check: (r) => r.adresser[0]?.poststed === "HALDEN",
    describe: (r) => `${r.adresser[0].adresse}, ${r.adresser[0].poststed}`,
  },
  {
    tool: "kartverket_hoyde",
    args: { lat: 59.1294, lon: 11.3794 },
    check: (r) => typeof r.hoyde_moh === "number",
    describe: (r) => `${r.hoyde_moh} moh (${r.terreng})`,
  },
  {
    tool: "vegvesen_objekttyper",
    args: { sok: "fartsgrense" },
    check: (r) => r.treff.some((t) => t.id === 105),
    describe: (r) => `Fartsgrense = type ${r.treff.find((t) => t.id === 105).id} av ${r.totalt}`,
  },
  {
    tool: "vegvesen_vegobjekter",
    args: { type: 105, vest: 11.375, sor: 59.126, ost: 11.385, nord: 59.132, antall: 2 },
    check: (r) => r.objekter.length > 0 && r.objekter[0].egenskaper.Fartsgrense,
    describe: (r) => `${r.objekter[0].egenskaper.Fartsgrense} i ${r.objekter[0].veger?.[0]}`,
  },
  {
    // A too-large bbox must fail with a sentence, not a 30 s hang.
    tool: "vegvesen_vegobjekter",
    args: { type: 105, vest: 5, sor: 58, ost: 12, nord: 62 },
    expectError: /for stort/,
    describe: () => "avviser for stort kartutsnitt",
  },
  {
    tool: "entur_stoppested",
    args: { sok: "Halden stasjon", antall: 2 },
    check: (r) => r.stoppesteder.some((s) => s.id.startsWith("NSR:")),
    describe: (r) => `${r.stoppesteder[0].navn} → ${r.stoppesteder[0].id}`,
  },
  {
    tool: "entur_avganger",
    args: { stoppestedId: "NSR:StopPlace:337", antall: 2 },
    check: (r) => r.avganger.length > 0 && r.avganger[0].forventet,
    describe: (r) => `${r.stoppested}: ${r.avganger[0].linje} mot ${r.avganger[0].retning}`,
  },
  {
    tool: "entur_avganger",
    args: { stoppestedId: "Halden" },
    expectError: /ser ikke ut som en Entur-id/,
    describe: () => "avviser navn brukt som id",
  },
  {
    tool: "kart_lag",
    args: { url: "https://wms.geonorge.no/skwms1/wms.topo", sok: "topo" },
    check: (r) => r.antallLag > 0 && r.stotterFeatureInfo,
    describe: (r) => `${r.antallLag} lag, GetFeatureInfo: ja`,
  },
  {
    tool: "kart_lag",
    args: { url: "ikke-en-url" },
    expectError: /gyldig URL/,
    describe: () => "avviser ugyldig URL",
  },
  {
    // The positive case for GetFeatureInfo: a coordinate must come back as real
    // attributes, not just a well-formed empty answer.
    tool: "kart_punkt",
    args: {
      url: "https://wms.geonorge.no/skwms1/wms.adm_enheter2",
      lag: "kommuner",
      lat: 59.1294,
      lon: 11.3794,
    },
    check: (r) => r.svar.includes("3101"),
    describe: () => "koordinat → kommunenummer 3101 (Halden)",
  },
  {
    tool: "udir_skoler",
    args: { navn: "Montessori", kommunenummer: "3101" },
    check: (r) => r.antallTreff > 0,
    describe: (r) => `${r.enheter[0].navn} (av ${r.totaltIRegisteret} enheter)`,
  },
  {
    tool: "udir_skoler",
    args: {},
    expectError: /navn og\/eller kommunenummer/,
    describe: () => "krever et filter (registeret er 20 000+)",
  },
  {
    tool: "arter_art",
    // Search is substring-based: "elg" also matches Elgiva divisa (a fly), so the
    // assertion uses the scientific name rather than assuming the moose ranks first.
    args: { sok: "Alces alces", antall: 3 },
    check: (r) => r.arter.some((a) => /Alces alces/i.test(a.vitenskapeligNavn ?? "")),
    describe: (r) => `${r.arter[0].norsktNavn ?? r.arter[0].vitenskapeligNavn} (${r.antallTreff} treff)`,
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
