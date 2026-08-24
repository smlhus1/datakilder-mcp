# datakilder-mcp

MCP-server med **typede verktøy for nordiske offentlige datakilder** — 15 norske og 3 svenske.
Én modul per kilde, så modellen slipper å gjette API-formen.

**Ingen API-nøkler.** Alle kildene under er åpne — klon, bygg, kjør.

## Hvorfor ikke bare katalogsøk?

data.norge.no har allerede et søk. Problemet ligger ikke der. Vi probet **alle 1 063 registrerte
API-er** og målte 300 datasett (5. august 2026):

```
1 063  registrerte API-er
  234  har en adresse en maskin kan følge   ← 4 av 5 mangler den
  207  svarer når du kaller dem
  148  av disse er WMS/WFS-kartlag
   40  er levende, ekte API-er som ikke er kart
```

**Fire av fem API-oppføringer mangler et maskinlesbart endepunkt.** Av datasettene har ~35 %
ingen distribusjon i det hele tatt, og av filene som finnes er de aller fleste Excel-ark —
ingen live API-er.

⚠️ En tidligere versjon av denne READMEen påsto «94 % landingssider», målt på 60 datasett.
Ved 300 datasett ble tallet ~40 %. Utvalget var for lite og ikke tilfeldig ordnet. Full
gjennomgang, inkludert feilen: `rapport/`.

Discovery er den lette halvdelen. Den vanskelige er at hver kilde har sin egen spørreform:
SSB er en kube med opake dimensjonskoder, Brreg er flat REST, MET krever User-Agent og
koordinatavrunding, Entur er GraphQL. Det er den halvdelen denne serveren dekker.

**Derfor finnes det ikke noe `fetch_data`-verktøy her.** Et verktøy som laster ned hva enn en
katalog-lenke peker på, laster i praksis ned en HTML-side 94 % av gangene. 17 av 18 kilder snakker
direkte med det ekte API-et og returnerer strukturerte data. Den attende (`fdk`) er katalogoppslag
som *finner et API å bygge mot* — den henter aldri data, og sier det selv i verktøybeskrivelsen.

## Hva kan du spørre om?

Alle svarene under er ekte utdrag fra røyktesten — den kjører mot de faktiske API-ene:

| Spørsmål | Verktøy | Svar |
|---|---|---|
| Hvor mange bor i Halden? | `ssb_*` | 32 082 |
| Er Equinor fortsatt aktivt? | `brreg_foretak` | EQUINOR ASA — Allmennaksjeselskap, aktiv |
| Hvordan er været på Venabu? | `kartverket_sted` → `met_varsel` | 19,2 °C, 4 m/s |
| Hvor høyt over havet ligger dette punktet? | `kartverket_hoyde` | 46,91 moh |
| Hva er fartsgrensen i denne gata? | `vegvesen_vegobjekter` | 30 km/h, Major Forbus gate |
| Når går neste tog fra Oslo S? | `entur_avganger` | R21 mot Moss, med sanntid |
| Hvilken kommune er dette koordinatet i? | `kart_punkt` | 3101 (Halden) |
| Finnes det en montessoriskole i Halden? | `udir_skoler` | Halden montessoriskole AS |
| Hva heter elg på latin? | `arter_art` | Alces alces |
| Hva står huset på, og er det radon her? | `ngu_grunnforhold` | Moderat til lav radon-aktsomhet, hav- og fjordavsetning, under marin grense, 137 brønner innen 1 km |
| Hvor kommer lufta jeg puster i fra? | `met_luftkvalitet` | AQI 1,8 («lite», liten helserisiko) — verst er ozon, 100 % langtransportert |
| Hva skal en 6.-klassing kunne i matte? | `udir_kompetansemaal` | 11 mål fra MAT01-06, gjeldende fra 1.8.2026 |

Poenget er kjedene: **stedsnavn → koordinat → høyde → værvarsel** er fire kall en modell kan gjøre
selv, uten at noen har hardkodet en integrasjon.

## Kilder

| Kilde | Verktøy | Lisens |
|---|---|---|
| **SSB** (PxWebApi) | `ssb_tabell_info` · `ssb_tabell_verdier` · `ssb_tabell_data` | NLOD 2.0 |
| **Brønnøysund** (Enhetsregisteret) | `brreg_foretak` · `brreg_søk` | NLOD 2.0 |
| **MET** (api.met.no) | `met_varsel` · `met_farevarsel` · `met_luftkvalitet` · `met_sol_og_mane` | NLOD 2.0 / CC BY 4.0 |
| **Kartverket / Geonorge** | `kartverket_sted` · `kartverket_adresse` · `kartverket_adresse_fra_punkt` · `kartverket_hoyde` | CC BY 4.0 |
| **Statens vegvesen** (NVDB) | `vegvesen_objekttyper` · `vegvesen_vegobjekter` | NLOD 2.0 |
| **Entur** (kollektiv) | `entur_stoppested` · `entur_avganger` · `entur_reise` | NLOD 2.0 |
| **Kart** (generisk WMS) | `kart_finn` · `kart_lag` · `kart_punkt` | varierer per tjeneste |
| **UDIR** (skoleregister + LK20) | `udir_skoler` · `udir_skole` · `udir_kompetansemaal` · `udir_laereplan` | NLOD 2.0 |
| **Artsdatabanken** | `arter_art` | CC BY 4.0 |
| **Eurostat** | `eurostat_info` · `eurostat_data` | Eurostat-vilkår |
| **Felles datakatalog** | `fdk_sok` · `fdk_detaljer` | NLOD 2.0 |
| **NGU** (grunnforhold) | `ngu_grunnforhold` | NLOD 2.0 / CC BY 4.0 |
| **OGC** (generisk, 138 samlinger) | `ogc_punkt` · `ogc_tjenester` | varierer per tjeneste |
| **Stedskontekst** (sammensatt) | `sted_kontekst` | se underliggende kilder |

### Svenske kilder

| Kilde | Verktøy | Lisens |
|---|---|---|
| **SCB** (PxWebApi v1) | `scb_finn_tabell` · `scb_tabell_info` · `scb_tabell_verdier` · `scb_tabell_data` | CC0 1.0 |
| **SMHI** (observasjoner) | `smhi_parametere` · `smhi_stasjoner` · `smhi_observasjoner` | CC BY 4.0 |
| **Skolverket** (skolenhetsregistret) | `skolverket_skoler` · `skolverket_skole` | CC0 1.0 |

Tre ting som ikke er som man skulle tro, og som kostet et spike-kall hver å finne ut:

- **SCB navngir tabeller med en STI, ikke et nummer.** SSB har `07459`; SCB har
  `BE/BE0101/BE0101A/BefolkningNy`. Ingen gjetter den, og PxWeb v1 har ikke fritekstsøk — derfor
  har SCB et `finn_tabell` som SSB ikke trenger. Alt etter oppslaget er identisk: samme
  metadataform, samme json-stat2, samme `flattenJsonStat`.
- **SMHI er ikke det svenske MET.** Prognose-API-et (metfcst) svarte 404 på alle dokumenterte
  stier 24.8.2026; observasjons-API-et virker. MET gir vær som *kommer*, dette gir vær som *har
  vært*.
- **Nedlagte SMHI-stasjoner ligger i registeret** og sorterte foran de virksomme. En modell som
  tok første treff for «Malmö» fikk 404 og en Tomcat-side i fleisen. Aktive stasjoner sorteres
  først, og 404 oversettes til et råd.

Pluss `kilder` — lister alt serveren dekker — og `doctor`, som sjekker om de faktisk svarer nå.

**Attribusjonen følger med dataene:** hvert svar bærer et `_kilde`-felt. Offentlige data er
lisensiert, ikke fritt fram, og en kildehenvisning som bare står i en README blir ikke lest.

### `kart` dekker 614 av katalogens API-er
58 % av det katalogen kaller API-er er WMS/WFS. Å pakke inn protokollen én gang slår å pakke inn
hver utgiver — og et kartlag ingen har tenkt på ennå er allerede nåbart. `kart_punkt`
(GetFeatureInfo) gjør et kartlag om til **data**: gi den et koordinat, få egenskapene tilbake.

Det er også grunnen til at Kystverket, Riksantikvaren, NIBIO, Polarinstituttet,
Landbruksdirektoratet og Norge i bilder ikke har egne moduler — API-ene deres *er* kartlag, og
`kart_lag`/`kart_punkt` når dem allerede.

**NGU sto på den lista til 6. august, og det var feil.** De har 28 OGC API Features-tjenester ved
siden av kartlagene sine — ekte JSON-API-er med egne spørreparametre. «Dekket av kartklienten» var
en påstand om protokollen, ikke om utgiveren.

### `ogc_punkt` dekker 138 datasamlinger — og to dialekter
Samme argument som for WMS: NGUs 28 tjenester og Havforskningsinstituttets 110 samlinger er ikke
138 integrasjoner, de er én protokoll. Én klient, ett register, én linje per ny utgiver.

Men «samme protokoll» er ikke «samme oppførsel», og forskjellene er av typen som feiler stille:

- **Bbox med null areal er en punkt-i-polygon-spørring hos begge.** Verifisert på et hjørnepunkt i
  et ekte gytefelt — et hjørnepunkt ligger på kanten, så det MÅ treffe hvis degenererte bokser
  virker i det hele tatt. (Første test ga 0 treff hos HI og så ut som en forskjell. Punktet lå bare
  i åpent hav.)
- **`skipGeometry` respekteres av NGU og ignoreres av HI.** NGU sender 2 kB der den ellers sender
  17,5 MB; HI sender omrisset uansett. Flagget sendes likevel — det er harmløst der det ignoreres —
  og størrelsestaket i `http.ts` er sikkerhetsnettet. Geometri returneres aldri til kalleren.

**`kart_finn` gjør dem faktisk mulige å finne.** Verktøyene over krevde at du kjente URL-en til
tjenesten, noe som gjorde den største dekningen i serveren praktisk usynlig. Nå søker du i en
indeks over 130 norske WMS-tjenester (`data/kartindeks.json`, høstet av
`scripts/hent-kartindeks.mjs`): `kart_finn("flom")` → NVEs flomtjeneste → lag → egenskaper i et punkt.
Verdt å merke seg: **NVE står som blokkert over fordi hydrologi-API-et krever nøkkel — men
flomdataene deres er kartlag, og dermed nåbare uansett.**

### `sted_kontekst` — ett kall i stedet for fire
Kommune, adresse, høyde, været nå, farevarsel og nærmeste holdeplasser for et koordinat.
Sammensatt av kilder som allerede finnes. Delvis feil er designet inn: hver del kjører uavhengig,
og det som ikke lot seg hente står i feltet `mangler` — for «ingen farevarsel» og «vi fikk ikke
sjekket farevarsel» må aldri se like ut.

### `ngu_grunnforhold` — hva består grunnen av her?
Radon-aktsomhet, løsmassetype, under eller over marin grense, og registrerte brønner i nærheten
med boredybde og dyp til fjell. Ett kall, tre NGU-tjenester, laget for spørsmålet folk faktisk
stiller foran et boligkjøp.

To ting var avgjørende for at svaret blir riktig:

- **Punktspørring, ikke nærhet.** En bbox på ±1 km rundt en adresse i Halden gir åtte
  radon-polygoner, og det første sier «Usikker aktsomhet». En bbox med null areal gir det ene
  polygonet adressen faktisk ligger i — «Moderat til lav aktsomhet». Et svar fra naboen er feil svar.
- **`skipGeometry=true`.** Ett radon-polygon er 17,5 MB omriss vi aldri leser. Uten flagget sprengte
  svaret klientens 8 MB-tak og radon kom tilbake som `null`. Med det: 2 kB, 0,7 s, samme svar.

Aktsomhetskart er ikke måling, og det står i svaret: radon må måles i boligen, og skredfaresoner er
NVEs datasett — `kart_finn("skredfare")`.

### `met_luftkvalitet` — og hvor forurensningen kommer fra
Samlet indeks, konsentrasjon av NO2, PM10, PM2,5 og ozon, 56 timer fram — og kildefordelingen for
stoffet som driver indeksen: trafikkeksos, veistøv, vedfyring, skipsfart, industri eller
langtransportert. Det er forskjellen på «lufta er dårlig» og «lufta er dårlig fordi det er piggdekk
på tørr asfalt».

Skalaen hardkodes ikke: MET serverer sin egen indeksbeskrivelse på `/aqi_description`, og teksten
(«lite» / «liten helserisiko») leses derfra. En kopiert skala drifter, en avledet kan ikke.
Verdt å vite at varselet er modellert per **grunnkrets**, ikke målt på adressen — det står i svaret.

### `udir_kompetansemaal` — hva skal eleven kunne på dette trinnet?
Fag + årstrinn inn, kompetansemålene fra LK20 ut, med teksten om underveisvurdering. Tre ting måtte
løses før svaret ble til å stole på:

- **Utgåtte læreplaner ligger i katalogen.** MAT01-05 gikk ut 31.7.2026 og MAT01-06 overtok dagen
  etter. Samme søk, to ulike sett med mål, avhengig av hvilken uke du spør. Bare gjeldende planer
  telles — og de utgåtte kan hentes fram med et flagg, ikke ved et uhell.
- **«matematikk» treffer tolv læreplaner.** Fordypning, X, 2P, S, R, vg1 … Å ta første treff ga
  *fordypning i matematikk* til en sjetteklassing. Årstrinnet er det vi har til å skille dem, så
  kandidatene rangeres på det og bekreftes mot dataene. Svaret sier hvilken plan det kom fra, og
  hvilke andre det kunne vært.
- **LK20 setter mål etter 2., 4., 7. og 10. trinn — ikke hvert år.** «Hva skal en 3.-klassing kunne»
  er likevel et helt rimelig spørsmål. Verktøyet svarer med målene eleven jobber *mot*, og sier at
  det er det som skjedde. Videregående er `vg1`–`vg3`, ikke 11–13; typen sier det.

### `doctor` — svarer kildene akkurat nå?
Ett billig, ekte kall per kilde, med tid og feilmelding. Som MCP-verktøy, og som `npm run doctor`:

```
✓ nve            830 ms  NVE (nettleietariffer)
✓ met            136 ms  Meteorologisk institutt (api.met.no)
15 oppe · 0 nede · 0 mangler nøkkel · 0 ikke sjekket — 958 ms
```

Sonden er deklarert **på kilden**, ved siden av verktøyene den prøver: modulen vet hvilket av
kallene sine som er billig, og en sentral liste ville driftet ved første omdøping. En kilde uten
sonde rapporteres som `ikke_sjekket` — aldri som frisk. Røyktesten feiler hvis noen legger til en
modul uten sonde.

**Første versjon meldte 15/15 oppe på 855 ms — fra disk.** Cachen svarte, ikke API-ene. Det er den
samme feilen som stillhet-er-ikke-levert, i ny drakt: en sjekk som ikke kan skille «kilden svarte»
fra «vi husker at den svarte», sier alltid at alt er bra. `doctor` slår derfor av cache-lesing mens
den kjører.

### Nøkkelfritt er et krav, så auth sjekkes først
`scripts/sjekk-auth.mjs` leser sikkerhetsskjemaet i hver spec sveipen fant. Av de 40 maskinlesbare
spec-ene **oppgir 17 autentisering** — 10 av dem er Skatteetatens, som i tillegg handler om
navngitte personer (`personidentifikator`) og krever Maskinporten og rettighetspakke-avtale.
**23 er åpne.** Å telle spec-er er ikke å telle tilgjengelige data, og det er billigere å oppdage
med et skript enn med en halv dags koding.

Skriptet sier hvor du skal se, ikke hva som er sant: Brønnøysunds regnskaps-API oppgir `basicAuth`
i spec-en, men svarer helt åpent — `brreg_regnskap` henter Equinors 2024-tall uten nøkkel i
røyktesten. Kravet i spec-en er en påstand; kallet er beviset.

### Kilder som ikke lot seg bygge
Ærlig ført i `kilder.json`, med grunn:
**NVE** (401, krever gratis nøkkel) · **Skatteetaten** (kun Maskinporten) ·
**Miljødirektoratet** (katalogen peker på en Swagger-UI som ikke serverer spec; alle gjettede
ruter 404) · **DiBK** (404 + HTML-docs) · **DSB** (ingen åpne REST-API-er funnet) ·
**Fiskeridirektoratet** (10 ekte registre finnes, men endepunktene er ikke registrert noe sted) ·
**Autosys** kjøretøydata (krever ID-porten-registrert nøkkel).

## Bruk

Ikke publisert på npm ennå — klon og bygg (verifisert fra en fersk klone 5.8.2026):

```bash
git clone https://github.com/smlhus1/datakilder-mcp.git
cd datakilder-mcp
npm install          # installerer avhengigheter, ikke pakken selv
npm run build
npm run smoke        # valgfritt: kaller alle kildene mot ekte API-er
```

MCP-klient (Claude Code, `.mcp.json`) — bruk absolutt sti til `dist/index.js`:
```json
{ "mcpServers": { "datakilder": { "command": "node", "args": ["<sti>/dist/index.js"] } } }
```

### Uten terminal: `.mcpb`-bundle

Oppskriften over forutsetter Node, en terminal og en absolutt sti i en config-fil. For alle
andre finnes bundlen:

```bash
npm run bundle          # → build/datakilder.mcpb (3,1 MB)
```

Mottakeren åpner **Claude → Settings → Extensions → Install Extension…** og velger fila.
Ingen Node å installere, ingen `npm install`, ingen sti å skrive.

Ferdigbygde bundler ligger under [Releases](https://github.com/smlhus1/datakilder-mcp/releases).
Verifisert installert hos en ekstern bruker 24.8.2026 (SCB-oppslag mot ekte data).

`npm run bundle` stager i en ren mappe framfor å pakke arbeidstreet: repoet har 48 MB
`node_modules`, hvorav nøyaktig to pakker er produksjonsavhengigheter.

**Verifiser før du sender den til noen:**
```bash
node scripts/verifiser-bundle.mjs
```
Den pakker ut bundlen i en tom mappe, starter serveren derfra og snakker MCP med den. At
`mcpb pack` går igjennom beviser bare at det ble skrevet en zip — første forsøk pakket helt
fint og krasjet ved oppstart, fordi `data/kartindeks.json` ikke var med.

## Legge til en kilde

Skriv **én fil** i `src/sources/`, legg til **én linje** i `src/sources/index.ts`.
Ingenting annet teller opp kilder — verktøyregistrering, `kilder`-oversikten og attribusjonen
utledes alle fra registeret.

```ts
export const minKilde: Source = {
  id: "kilde",                        // blir prefiks: kilde_verktøy
  name: "...", homepage: "...",
  requiresKeyEnv: null,               // eller "MIN_API_NØKKEL"
  attribution: { licence: "NLOD 2.0", credit: "Kilde: ...", termsUrl: "..." },
  tools: [{ name, title, description, inputSchema, run }],
};
```

All HTTP går gjennom `src/http.ts` — User-Agent, timeout, retry på 429/503, byte-tak, sjekk av
content-type (flere av disse API-ene svarer på en dårlig spørring med en HTML-side og status 200)
og **cache**. **Ikke skriv en klient til.**

### Cache
TTL settes **per kall, ikke per kilde**, fordi skillet går tvers gjennom en kilde: Enturs
stoppesteder er stabile i uker, mens avgangene er sanntid og aldri skal caches. Vær i minutter,
registre i døgn, stedsnavn og kodeverk i måneder. MET **ber eksplisitt i vilkårene** om at klienter
cacher — det er folkeskikk, ikke bare fart. Målt: værvarsel 118 ms → 1 ms.
Cache ligger i `$XDG_CACHE_HOME/datakilder-mcp`.

## Testing

Røyktesten er **live, ikke mocket**. Poenget med serveren er at den kjenner den faktiske formen på
hvert API; en mocket test ville bare bevist at antakelsene våre er enige med seg selv. Den feiler
høylytt når en kilde endrer kontrakt — som er nøyaktig da vi vil høre det.

Den dekker også feilstiene: ugyldig organisasjonsnummer, stedsnavn brukt som Entur-id, for stort
kartutsnitt. En feilmelding en modell kan handle på er en funksjon, ikke en detalj.

## Lisens

MIT. Dataene har sine egne lisenser — se tabellen over og `_kilde`-feltet i hvert svar.
