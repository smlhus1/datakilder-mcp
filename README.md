# datakilder-mcp

MCP-server med **typede verktøy for norske offentlige datakilder** — én modul per kilde,
så modellen slipper å gjette API-formen.

## Hvorfor ikke bare katalogsøk?

data.norge.no har allerede et søk, og `tenki-labs/datanorge-mcp` pakker det pent inn.
Problemet ligger ikke der. En måling av katalogen 5. august 2026 (utvalg på 60 datasett):

```
katalogen totalt:                    9 091 datasett
uten distribusjon i det hele tatt:   10 av 60
  landingsside (HTML)   47   94,0 %
  direkte datafil        3    6,0 %
```

**94 % av «nedlastingslenkene» peker på en nettside, ikke på data.** Discovery er den lette
halvdelen. Den vanskelige er at hver kilde har sin egen spørreform — SSB er en kube med
opake dimensjonskoder, Brreg er flat REST, MET krever User-Agent og koordinatavrunding.
Det er den halvdelen denne serveren dekker.

## Kilder

| Kilde | Verktøy | Lisens |
|---|---|---|
| Statistisk sentralbyrå (PxWebApi) | `ssb_tabell_info`, `ssb_tabell_verdier`, `ssb_tabell_data` | NLOD 2.0 |
| Brønnøysundregistrene (Enhetsregisteret) | `brreg_foretak`, `brreg_søk` | NLOD 2.0 |

Pluss `kilder` — lister alt serveren dekker, med lisens og om kilden krever nøkkel.

Attribusjonen følger **med dataene**: hvert svar bærer et `_kilde`-felt. Norske offentlige
data er lisensiert, ikke fritt fram, og en kildehenvisning som bare står i en README blir ikke lest.

### SSB i tre steg
SSB-tabeller er kuber: alt må velges før du får tall, og verdiene er koder («3101» = Halden).
Derfor er verktøyene delt — spør hva tabellen inneholder, slå opp kodene, hent så tallene.
Ett altomfattende verktøy ville tvunget modellen til å finne på dimensjonskoder.

```
ssb_tabell_info    { tabell: "07459" }                        → hvilke variabler finnes
ssb_tabell_verdier { tabell: "07459", variabel: "Region", søk: "Halden" }  → 3101
ssb_tabell_data    { tabell: "07459", utvalg: [...] }         → ferdige rader, ikke rå json-stat
```

## Legge til en kilde

Skriv **én fil** i `src/sources/`, legg til **én linje** i `src/sources/index.ts`.
Ingenting annet i serveren teller opp kilder — verktøyregistrering, `kilder`-oversikten og
attribusjonen utledes alle fra registeret.

```ts
export const minKilde: Source = {
  id: "kilde",                        // blir prefiks: kilde_verktøy
  name: "...", homepage: "...",
  requiresKeyEnv: null,               // eller "MIN_API_NØKKEL"
  attribution: { licence: "NLOD 2.0", credit: "Kilde: ...", termsUrl: "..." },
  tools: [{ name, title, description, inputSchema, run }],
};
```

All HTTP går gjennom `src/http.ts` — User-Agent, timeout, retry på 429/503, byte-tak og
sjekk av content-type (flere av disse API-ene svarer på en dårlig spørring med en HTML-side
og status 200). **Ikke skriv en klient til.**

## Utvikling

```bash
npm install
npm run build
npm run smoke     # kaller alle kildene mot ekte API — ikke mocket
```

Røyktesten er bevisst live. Poenget med serveren er at den kjenner den faktiske formen på
hvert API; en mocket test ville bare bevist at antakelsene våre er enige med seg selv.

## Kandidater videre

MET (værvarsel), Kartverket (stedssøk/geokoding), Statens vegvesen Autosys (kjøretøy — krever
ID-porten-registrert nøkkel), Eurostat, NVE, Entur. Flere av dem finnes allerede som
fungerende kode i `vaeret/` og `restverdi/` — jobben er å samle dem her, ikke skrive dem på nytt.
