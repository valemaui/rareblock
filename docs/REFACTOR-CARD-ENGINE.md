# Refactor — RB Card Engine (ricerca carte + prezzo CardMarket)

Obiettivo: isolare la logica di **ricerca carte** e **scraping prezzo CardMarket per
condizione** in moduli `shared/` riusabili, così da poterla richiamare da Preventivi,
Collezione, Monitora/Radar, Analizza **senza duplicazione e senza rompere il resto** a
ogni modifica.

Principio guida: **estrarre, non riscrivere.** La logica attuale contiene tuning empirico
verificato su CM (pattern V1/V2 e-Card, `CM_DIRECT_SETS`, abbreviazioni set, anomaly
threshold PriceCharting). Riscriverla "da zero" regredirebbe mesi di lavoro. "Da zero" qui
= ristrutturare i confini del modulo preservando gli algoritmi provati.

## Mappa del sottosistema (pokemon-db.html, ~16k righe)

| Cluster | Funzioni chiave | Accoppiamento | Stato |
|---|---|---|---|
| **URL CardMarket** (puro) | `buildCMDirectUrl`, `buildCMSearchUrl`, `buildCMDirectUrlVariants`, `cmAuthoritativeUrl`, `cmAppendParams`, `buildCardmarketSlug`, `_cmPrimaryVersionFor` + mappe `CM_SET_SLUG/ABBREV/NAME_TO_ID/LANG_ID/COND_ID/DIRECT_SETS/AMBIGUOUS_VERSION_SETS` | nessuno (solo stringhe) | ✅ **estratto** → `shared/rb-cm-url.js` |
| **Ricerca dati carte** | `rbSearchCards` (entry), `_fetchTCGDirect` (TCG API via proxy `hyper-endpoint`), cluster TCGdex (`rbSearchTCGdex`, `_tcgdexHydrate`, `_tcgdexResolveDexIds`, `_tcgdexCardsByDexIds`, `tcgdexToTCGShape`...), `itToEn` | rete (Supabase proxy), `SUPA_URL/KEY`, `window._rbSession` | ⏳ Fase 2 |
| **Scraping prezzo CM** | `fetchCmPriceLive`, `verifyPrice`, `_vpServerSideCMScrape` (`smooth-endpoint`), `_vpProcessListings`, `_isFakeCmListings`, `_rbPersistConditionPrices`, registry `_rbRegisterPriceHandler`, conversione valuta `frankfurter.app` | rete, Supabase, sessionStorage, Realtime/tab CM | ⏳ Fase 3 |
| **Matematica prezzo** | `calcBaseNMPrice`, `calcPrice`, `smartCMPrice` | puro | ⏳ Fase 2 (con la ricerca) |

Consumatori (call-site da non rompere): Preventivi (`prevSearch`, `updatePrevPrice`),
Collezione (`doSearch`, `colBatchUpdatePrices`, `_colFetchTcgPrices`, `verifyPriceColEdit`),
Scan (`scResolveTCG`, `scManualSearch`), Analizza, più i `frames/` (analizza.html, radar.html).

## Piano a fasi (ognuna validata con `node --check` e mergiata solo dopo test)

- **Fase 1 — URL CardMarket** ✅ *(questo commit)*
  Modulo puro `shared/rb-cm-url.js`. Incluso in `pokemon-db.html` **prima** dello script
  inline; blocco duplicato rimosso dal monolite. API: nomi globali retro-compatibili
  **+** namespace `RBCM.*`. Atomico per evitare il `SyntaxError` da ridichiarazione `const`.

- **Fase 2 — Motore di ricerca** (`shared/rb-card-search.js`)
  Estrarre `rbSearchCards` + TCGdex + `_fetchTCGDirect` + matematica prezzo. Dipendenze di
  rete iniettate via piccolo config (`RBCardSearch.init({supaUrl, supaKey, getSession})`)
  invece di leggere globali → testabile e usabile dai `frames/`.

- **Fase 3 — Motore prezzo CM** (`shared/rb-cm-price.js`)
  Estrarre `fetchCmPriceLive`/`verifyPrice` e il registry handler. È il cluster più
  accoppiato (Realtime, tab CM, persistenza per-condizione): incapsulare il registry e la
  conversione valuta dietro un'API stabile `RBCMPrice.fetch(card, {cond,lang,...})`.

- **Fase 4 — Consumatori + edge functions**
  Puntare i `frames/` allo stesso modulo (oggi riusano/duplicano). Consolidare
  `smooth-endpoint`/`hyper-endpoint`/`cmapi-test` se sovrapposti.

## Regole di estrazione (lezioni del codebase)
- **No IIFE**: simboli top-level `var`/`function`/`const` per restare nel global lexical
  environment condiviso tra `<script>` classici.
- Una sola dichiarazione per simbolo: caricare il modulo **prima** del monolite e
  **rimuovere** il duplicato nello stesso commit (const ridichiarato = JS morto).
- `shared/**` è già in whitelist deploy (`deploy-ftp.yml`) → il file va in produzione.
- Cache-buster `?v=` sull'include.
- Validare ogni `<script>` inline con `node --check` prima del commit.
