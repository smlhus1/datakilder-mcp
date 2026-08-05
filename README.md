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
Katalogsøket ligger her også — som **fallback**, ikke som inngangsdør.

## Kilder

| Kilde | Verktøy | Lisens |
|---|---|---|
| **SSB** (PxWebApi) | `ssb_tabell_info` · `ssb_tabell_verdier` · `ssb_tabell_data` | NLOD 2.0 |
| **Brønnøysund** (Enhetsregisteret) | `brreg_foretak` · `brreg_søk` | NLOD 2.0 |
| **MET** (api.met.no) | `met_varsel` · `met_farevarsel` · `met_sol_og_mane` | NLOD 2.0 / CC BY 4.0 |
| **Kartverket / Geonorge** | `kartverket_sted` · `kartverket_adresse` · `kartverket_adresse_fra_punkt` · `kartverket_hoyde` | CC BY 4.0 |
| **Statens vegvesen** (NVDB) | `vegvesen_objekttyper` · `vegvesen_vegobjekter` | NLOD 2.0 |
| **Entur** (kollektiv) | `entur_stoppested` · `entur_avganger` · `entur_reise` | NLOD 2.0 |
| **Kart** (generisk WMS) | `kart_lag` · `kart_punkt` | varierer per tjeneste |
| **UDIR** (skoleregister) | `udir_skoler` · `udir_skole` | NLOD 2.0 |
| **Artsdatabanken** | `arter_art` | CC BY 4.0 |
| **Eurostat** | `eurostat_info` · `eurostat_data` | Eurostat-vilkår |
| **Felles datakatalog** | `fdk_sok` · `fdk_detaljer` | NLOD 2.0 |

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

### Kilder som ikke lot seg bygge
Ærlig ført i `kilder.json`, med grunn:
**NVE** (401, krever gratis nøkkel) · **Skatteetaten** (kun Maskinporten) ·
**Miljødirektoratet** (katalogen peker på en Swagger-UI som ikke serverer spec; alle gjettede
ruter 404) · **DiBK** (404 + HTML-docs) · **DSB** (ingen åpne REST-API-er funnet) ·
**Fiskeridirektoratet** (10 ekte registre finnes, men endepunktene er ikke registrert noe sted) ·
**Autosys** kjøretøydata (krever ID-porten-registrert nøkkel).

## Bruk

```bash
npm install && npm run build
npm run smoke        # kaller alle kildene mot ekte API-er
```

MCP-klient (Claude Code, `.mcp.json`):
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

All HTTP går gjennom `src/http.ts` — User-Agent, timeout, retry på 429/503, byte-tak og sjekk av
content-type (flere av disse API-ene svarer på en dårlig spørring med en HTML-side og status 200).
**Ikke skriv en klient til.**

## Testing

Røyktesten er **live, ikke mocket**. Poenget med serveren er at den kjenner den faktiske formen på
hvert API; en mocket test ville bare bevist at antakelsene våre er enige med seg selv. Den feiler
høylytt når en kilde endrer kontrakt — som er nøyaktig da vi vil høre det.

Den dekker også feilstiene: ugyldig organisasjonsnummer, stedsnavn brukt som Entur-id, for stort
kartutsnitt. En feilmelding en modell kan handle på er en funksjon, ikke en detalj.

## Lisens

MIT. Dataene har sine egne lisenser — se tabellen over og `_kilde`-feltet i hvert svar.
