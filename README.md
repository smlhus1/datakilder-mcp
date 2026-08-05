# datakilder-mcp

MCP-server med **typede verktøy for norske offentlige datakilder**. Én modul per kilde, så
modellen slipper å gjette API-formen.

**Ingen API-nøkler.** Alle kildene under er åpne — klon, bygg, kjør.

## Hvorfor ikke bare katalogsøk?

data.norge.no har allerede et søk. Problemet ligger ikke der. En måling av katalogen
5. august 2026 (utvalg på 60 datasett):

```
katalogen totalt:                    9 091 datasett  ·  1 063 API-er
uten distribusjon i det hele tatt:   10 av 60
  landingsside (HTML)   47   94,0 %
  direkte datafil        3    6,0 %
```

**94 % av «nedlastingslenkene» peker på en nettside, ikke på data.** Og 58 % av «API-ene»
(614 stk) er WMS/WFS-kartlag — ett protokollmønster, ikke 614 integrasjoner.

Discovery er den lette halvdelen. Den vanskelige er at hver kilde har sin egen spørreform:
SSB er en kube med opake dimensjonskoder, Brreg er flat REST, MET krever User-Agent og
koordinatavrunding, Entur er GraphQL. Det er den halvdelen denne serveren dekker.

**Derfor finnes det ikke noe `fetch_data`-verktøy her.** Et verktøy som laster ned hva enn en
katalog-lenke peker på, laster i praksis ned en HTML-side 94 % av gangene. 10 av 11 kilder snakker
direkte med det ekte API-et og returnerer strukturerte data. Den ellevte (`fdk`) er katalogoppslag
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

Poenget er kjedene: **stedsnavn → koordinat → høyde → værvarsel** er fire kall en modell kan gjøre
selv, uten at noen har hardkodet en integrasjon.

## Kilder

| Kilde | Verktøy | Lisens |
|---|---|---|
| **SSB** (PxWebApi) | `ssb_tabell_info` · `ssb_tabell_verdier` · `ssb_tabell_data` | NLOD 2.0 |
| **Brønnøysund** (Enhetsregisteret) | `brreg_foretak` · `brreg_søk` | NLOD 2.0 |
| **MET** (api.met.no) | `met_varsel` · `met_farevarsel` · `met_sol_og_mane` | NLOD 2.0 / CC BY 4.0 |
| **Kartverket / Geonorge** | `kartverket_sted` · `kartverket_adresse` · `kartverket_adresse_fra_punkt` · `kartverket_hoyde` | CC BY 4.0 |
| **Statens vegvesen** (NVDB) | `vegvesen_objekttyper` · `vegvesen_vegobjekter` | NLOD 2.0 |
| **Entur** (kollektiv) | `entur_stoppested` · `entur_avganger` · `entur_reise` | NLOD 2.0 |
| **Kart** (generisk WMS) | `kart_finn` · `kart_lag` · `kart_punkt` | varierer per tjeneste |
| **UDIR** (skoleregister) | `udir_skoler` · `udir_skole` | NLOD 2.0 |
| **Artsdatabanken** | `arter_art` | CC BY 4.0 |
| **Eurostat** | `eurostat_info` · `eurostat_data` | Eurostat-vilkår |
| **Felles datakatalog** | `fdk_sok` · `fdk_detaljer` | NLOD 2.0 |
| **Stedskontekst** (sammensatt) | `sted_kontekst` | se underliggende kilder |

Pluss `kilder` — lister alt serveren dekker.

**Attribusjonen følger med dataene:** hvert svar bærer et `_kilde`-felt. Norske offentlige data
er lisensiert, ikke fritt fram, og en kildehenvisning som bare står i en README blir ikke lest.

### `kart` dekker 614 av katalogens API-er
58 % av det katalogen kaller API-er er WMS/WFS. Å pakke inn protokollen én gang slår å pakke inn
hver utgiver — og et kartlag ingen har tenkt på ennå er allerede nåbart. `kart_punkt`
(GetFeatureInfo) gjør et kartlag om til **data**: gi den et koordinat, få egenskapene tilbake.

Det er også grunnen til at Kystverket, Riksantikvaren, NGU, NIBIO, Havforskningsinstituttet,
Polarinstituttet, Landbruksdirektoratet og Norge i bilder ikke har egne moduler — API-ene deres
*er* kartlag, og `kart_lag`/`kart_punkt` når dem allerede.

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
