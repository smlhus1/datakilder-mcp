# Hva kan gjøre dette vesentlig bedre?

> **Status 6.8.2026:** 1, 2, 3 og 5 er bygget. 4, 6, 7 og 8 står.
>
> Punkt 5 (overvåkning) ligger bevisst **utenfor** dette repoet: den er én maskins rigg — launchd,
> en Discord-kanal og et sett koordinater — og importerer denne serveren som et bibliotek i stedet
> for å gjenskape HTTP-kallene. Verktøyene her vet allerede formen på hvert API; en vakthund som
> gjenskapte dem ville vært enda en ting å holde i takt med virkeligheten.
> Mønsteret, for den som vil kopiere det: en vaktliste (verktøy + felt + regel), en tilstandsfil,
> og varsling bare når regelen slår til — aldri på første kjøring, ellers fyrer hver ny sjekk én
> gang uten grunn og folk lærer å overse kanalen.

Brainstorm 5. august 2026, etter at 11 kilder og 28 røyktester var på plass.
Rangert etter **nytte per innsats**, ikke etter hvor gøy de er å bygge.

---

## 1. Gjør de 614 kartlagene søkbare 🔴 største uforløste verdi

`kart_lag` og `kart_punkt` når hele kartkatalogen — **hvis du allerede vet URL-en til
tjenesten.** Det er en stor «hvis». Akkurat nå er 58 % av katalogen teknisk nåbar og praktisk
usynlig.

**Grep:** høst WMS-endepunktene fra FDK én gang, legg indeksen i repoet som en JSON-fil, og
eksponer `kart_finn("flomsone")` → tjeneste-URL + lagnavn. Da blir «finnes det et kartlag for
flomsoner?» ett kall i stedet for et researchprosjekt.

Dette er den enkeltendringen som frigjør mest av arbeidet som allerede er gjort.
**Innsats: liten.** Indeksen finnes i katalogen, den må bare hentes og lagres.

## 2. `kontekst(lat, lon)` — ett kall som svarer «hva gjelder her?»

I dag er kjeden stedsnavn → koordinat → høyde → vær fire kall. Fint at modellen *kan* gjøre den
selv, men den vanligste forespørselen fortjener én:

```
kontekst(59.13, 11.38) → kommune, adresse, høyde, vær nå, farevarsel,
                         nærmeste holdeplass, fartsgrense på nærmeste veg
```

Det er primitiven en agent faktisk vil ha, og den bygges kun av kilder vi allerede har.
**Innsats: liten.** Ingen nye API-er, bare komposisjon.

## 3. Cache 🟠 gjør det raskt, og er dessuten god folkeskikk

UDIR laster 7,5 MB per prosess. NVDBs typekatalog er 544 KB. MET **ber eksplisitt i vilkårene**
om at klienter cacher.

En diskcache med TTL per kilde (vær: minutter · registre: døgn · kodeverk: uker) gjør serveren
merkbart raskere, sparer API-ene for last, og fjerner den eneste grunnen til at UDIR-modulen
føles treg. **Innsats: liten. Effekt: føles som et annet produkt.**

## 4. `datakilder doctor` — er kildene oppe akkurat nå?

Røyktesten finnes allerede; gjør den til et brukervendt verktøy som rapporterer hvilke kilder som
svarer, hvor raskt, og hva som er nede. Nyttig for brukere, og det gjør API-endringer synlige
tidlig i stedet for som en mystisk feil midt i en samtale.

## 5. Overvåkning: gjør data om til hendelser 🟡 mest interessant, størst løft

Alt over er spørsmål-svar. Det virkelig nye er å snu det:

> «Si fra når luftkvaliteten i Halden overstiger X»
> «Si fra når et nytt foretak med denne næringskoden registreres i kommunen»
> «Si fra når farevarselet for hytta endrer seg»

Det passer perfekt inn i riggen som allerede finnes (launchd + Discord), og det er en helt annen
kategori enn «hent tall». **Innsats: middels.** Krever tilstandslagring og en kjøreplan — men
mønsteret er allerede bevist i `gh-watch` og `syncka-watch`.

## 6. Send én e-post til de blokkerte kildene

Miljødirektoratet, DiBK og Fiskeridirektoratet er blokkert av **manglende dokumentasjon**, ikke av
teknikk. Katalogoppføringen til Miljødirektoratet peker på en Swagger-UI som ikke serverer noen
spec. Det er en feil de sannsynligvis ikke vet om, og en e-post koster ingenting.

Verdien er dobbel: kildene blir tilgjengelige for alle, ikke bare for oss — og det er en billig,
ekte måte å bli kjent i det norske åpne data-miljøet.

## 7. Publiser målingen, ikke bare koden

Tallene fra i dag finnes ikke publisert noe sted jeg kan finne:

- 94 % av katalogens nedlastingslenker peker på en nettside, ikke data
- 58 % av «API-ene» er samme kartprotokoll
- 10 av 60 datasett har ingen distribusjon i det hele tatt

Det er en liten, etterprøvbar tilstandsrapport for norske åpne data. **Den vil spre seg lenger enn
repoet**, og den er nyttig for folk som aldri kommer til å kjøre en MCP-server. Metoden ligger
allerede i `scratchpad/fdk-kvalitet.py` — den bør flyttes inn i repoet så andre kan etterprøve den.

## 8. Verifiser i flere klienter

Testet i Claude Code. Cursor og Zed snakker samme protokoll, men «burde virke» er ikke verifisert.
En halvtime gir troverdighet og fanger eventuelle særegenheter.

---

## Bevisst IKKE

- **Jage den lange halen.** 47 organisasjoner med 1–8 API-er hver. De fem folk faktisk spør om —
  SSB, Brreg, MET, Kartverket, Entur — er allerede dekket. Marginalnytten faller av en klippe.
- **Bygge egen katalog-UI.** data.norge.no har en. Vår verdi er typet tilgang, ikke enda et søkefelt.
- **Nøkkelbaserte kilder som standard.** Alt her er nøkkelfritt, og det er en funksjon: det gjør at
  noen faktisk prøver det. Nøkkelkilder kan legges til som opt-in, aldri som krav.
- **Nordisk utvidelse nå.** Arkitekturen tåler SCB og DST, men å doble bredden før dybden sitter er
  klassisk overrekkevidde.

---

## Hvis jeg måtte velge tre

**1, 2 og 3.** Kartlag-søk, `kontekst`, og cache. Alle er små, ingen krever nye API-er, og til
sammen flytter de produktet fra «11 kilder som virker» til «det føles ferdig».

Deretter **7** (publiser målingen) hvis målet er at andre skal ha nytte av det — den når flest folk
per time brukt.
