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
    args: { sok: "Karl Johans gate 1", antall: 1 },
    // Assert the contract, not the ranking: the same street name exists in several
    // towns (first hit is Sarpsborg, not Oslo), and which one ranks first is not
    // something this tool promises.
    check: (r) => r.adresser[0]?.adresse === "Karl Johans gate 1" && typeof r.adresser[0].lat === "number",
    describe: (r) => `${r.adresser[0].adresse}, ${r.adresser[0].poststed} (${r.totaltAntallTreff} treff)`,
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
    tool: "eurostat_info",
    args: { datasett: "prc_hicp_midx" },
    check: (r) => r.dimensjoner.some((d) => d.kode === "geo"),
    describe: (r) => `${r.dimensjoner.length} dimensjoner`,
  },
  {
    // Same json-stat2 parser as SSB — this case is what keeps the shared code honest.
    tool: "eurostat_data",
    args: { datasett: "prc_hicp_midx", filtre: { geo: "NO", coicop: "CP0712", unit: "I15" }, sisteperioder: 2 },
    check: (r) => r.rader.length > 0 && typeof r.rader[0].verdi === "number",
    describe: (r) => `bruktbil-indeks NO: ${r.rader.at(-1).verdi}`,
  },
  {
    tool: "fdk_sok",
    args: { sok: "luftkvalitet", katalog: "data-services", antall: 3 },
    check: (r) => r.treff.length > 0,
    describe: (r) => `${r.totaltAntallTreff} API-treff, første: ${r.treff[0].utgiver}`,
  },
  {
    tool: "kart_finn",
    args: { sok: "flom" },
    check: (r) => r.tjenester.length > 0,
    describe: (r) => `"flom" → ${r.tjenester[0].utgiver} (av ${r.antallTjenesterIIndeks} tjenester)`,
  },
  {
    // The composite must survive partial failure: every field is optional except
    // that it answers at all.
    tool: "sted_kontekst",
    args: { lat: 59.1294, lon: 11.3794 },
    check: (r) => r.kommunenummer === "3101" && typeof r.hoyde_moh === "number" && r.vaer,
    describe: (r) =>
      `${r.kommune}, ${r.hoyde_moh} moh, ${r.vaer.temp} °C, ${r.holdeplasser.length} holdeplasser` +
      (r.mangler ? ` (mangler: ${r.mangler.length})` : ""),
  },
  {
    // Found only by reading a Swagger viewer page for its spec URL — the catalogue
    // entry looked like documentation, not an API.
    tool: "brreg_regnskap",
    args: { orgnr: "923609016" },
    check: (r) => r.aar.length > 0 && typeof r.aar[0].driftsinntekter === "number",
    describe: (r) => `Equinor ${r.aar[0].fra?.slice(0, 4)}: ${(r.aar[0].driftsinntekter / 1e9).toFixed(1)} mrd`,
  },
  {
    tool: "nve_nettleie",
    args: { fraDato: "2026-07-01", tilDato: "2026-07-31", fylke: "Østfold" },
    check: (r) => r.tariffer.length > 0,
    describe: (r) => `${r.antallNettselskaper} nettselskap i Østfold`,
  },
  {
    // NVE answers 422 with a JSON body, so a bad parameter arrives looking like data.
    tool: "nve_nettleie",
    args: { fraDato: "2026-07-01", tilDato: "2026-07-31", kundegruppe: 9 },
    expectError: /avviste spørringen|Input should be/,
    describe: () => "fanger 422-som-JSON i stedet for å levere den som data",
  },
  {
    // "matematikk" matches twelve curricula; the sixth-grader wants the ordinary
    // one, not "fordypning i matematikk" — which is what the first hit used to be.
    tool: "udir_kompetansemaal",
    args: { fag: "matematikk", aarstrinn: 6 },
    check: (r) =>
      /1\.[–-]10\. trinn/.test(r.laereplan.tittel) &&
      r.gjelderEtterTrinn === 6 &&
      !r.merknad &&
      r.maalsett[0].kompetansemaal.length > 5,
    describe: (r) =>
      `${r.laereplan.kode} (gyldig fra ${r.laereplan.gyldigFra}) — ${r.maalsett[0].kompetansemaal.length} mål etter 6. trinn`,
  },
  {
    // LK20 sets goals after some years only. Asking for 3rd grade must answer,
    // not fail — with the substitution stated.
    tool: "udir_kompetansemaal",
    args: { fag: "naturfag", aarstrinn: 3 },
    check: (r) => r.gjelderEtterTrinn > 3 && /ikke kompetansemål etter 3\. trinn/.test(r.merknad),
    describe: (r) => `3. trinn → målene etter ${r.gjelderEtterTrinn}. trinn, med merknad`,
  },
  {
    // Upper secondary is vg1-vg3, not 11-13 — a plain number cannot address it.
    tool: "udir_kompetansemaal",
    args: { fag: "norsk", aarstrinn: "vg1" },
    check: (r) => r.maalsett.some((s) => s.kompetansemaal.length > 0),
    describe: (r) => `${r.laereplan.kode} vg1 — ${r.maalsett[0].kompetansemaal.length} mål`,
  },
  {
    // MAT01-05 expired 2026-07-31 and MAT01-06 took over the next day. Answering
    // from the expired plan would be silently wrong.
    tool: "udir_laereplan",
    args: { sok: "matematikk 1", antall: 5 },
    check: (r) => r.laereplaner.every((p) => p.gjelder) && r.utgaatteSkjult >= 1,
    describe: (r) => `${r.antallTreff} gjeldende, ${r.utgaatteSkjult} utgått skjult`,
  },
  {
    // nivaa comes from MET's own aqi_description, so an empty one means the scale
    // lookup broke — not that the air is fine.
    tool: "met_luftkvalitet",
    args: { lat: 59.9139, lon: 10.7522, timer: 3 },
    check: (r) =>
      r.naa.aqi > 0 &&
      typeof r.naa.nivaa === "string" &&
      r.timer.length === 3 &&
      Object.keys(r.naa.konsentrasjon_ug_m3).length === 4 &&
      r.naa.kilder.reduce((s, k) => s + k.andel, 0) > 0,
    describe: (r) =>
      `${r.sted.navn}: AQI ${r.naa.aqi} (${r.naa.nivaa}), verst ${r.naa.verstingstoff} — ${r.naa.kilder[0].navn} ${r.naa.kilder[0].andel} %`,
  },
  {
    tool: "ngu_grunnforhold",
    args: { lat: 59.1249, lon: 11.3875, radius_m: 1000 },
    check: (r) => r.radon?.beskrivelse && r.marin_grense === "under" && r.bronner.antall > 0,
    describe: (r) =>
      `Halden: radon ${r.radon.beskrivelse.toLowerCase()}, ${r.losmasse?.beskrivelse?.split(",")[0]}, ${r.bronner.antall} brønner`,
  },
  {
    // The whole tool rests on the zero-area bbox being a real point query. Finse
    // lies above the marine limit; if the query ever widens to "somewhere near",
    // this flips to "under" and says so.
    tool: "ngu_grunnforhold",
    args: { lat: 60.6022, lon: 7.5053 },
    check: (r) => r.marin_grense === "over",
    describe: (r) => `Finse ligger ${r.marin_grense} marin grense`,
  },
  {
    // The registry is NGU's live index plus the services that publish none.
    tool: "ogc_tjenester",
    args: { sok: "løsmasser" },
    check: (r) => r.antall >= 3 && r.av >= 30 && r.tjenester.some((t) => t.id === "ngu:maringrense"),
    describe: (r) => `${r.antall} av ${r.av} tjenester nevner løsmasser`,
  },
  {
    tool: "ogc_punkt",
    args: { tjeneste: "ngu:grunnvannborehull", lat: 59.1249, lon: 11.3875, radius_m: 1000, antall: 2 },
    check: (r) => r.funn.some((f) => f.samling === "energibronn"),
    describe: (r) => `${r.funn.length} samlinger med treff, ${r.uten_treff.length} uten`,
  },
  {
    // Same client, different agency and a different dialect: HI ignores
    // skipGeometry. The zero-area bbox works on both, which is what this proves —
    // the vertex of a real spawning ground must intersect a point query.
    tool: "ogc_punkt",
    args: { tjeneste: "hi-gytefelt", lat: 60.40141809171934, lon: 6.256234594352324, antall: 1 },
    check: (r) => r.funn.some((f) => f.samling.startsWith("Gytefelt")),
    describe: (r) => `HI: ${r.funn[0].samling} — ${r.funn[0].egenskaper[0].navn}`,
  },
  {
    tool: "ogc_punkt",
    args: { tjeneste: "finnes_ikke", lat: 59.1, lon: 11.3 },
    expectError: /ogc_tjenester/,
    describe: () => "peker på ogc_tjenester når tjenestenavnet er feil",
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

// fdk_detaljer needs an id from fdk_sok. Chaining beats hardcoding one that rots.
const chained = async (byName) => {
  const r = await byName.get("fdk_sok").run({ sok: "luftkvalitet", katalog: "data-services", antall: 1 });
  const d = await byName.get("fdk_detaljer").run({ id: r.treff[0].id, katalog: "data-services" });
  if (!d.endepunkt.length) throw new Error("ingen endepunkt-URL");
  return `fdk_detaljer — ${d.endepunkt[0].slice(0, 52)}…`;
};

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

try {
  console.log(`✓ ${await chained(byName)}`);
} catch (err) {
  console.log(`✗ fdk_detaljer — ${err.message}`);
  failed++;
}

console.log(failed ? `\n${failed} feilet` : `\nalle ${CASES.length + 1} OK`);
process.exit(failed ? 1 : 0);
