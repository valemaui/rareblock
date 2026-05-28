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
| **Ricerca dati carte** | `rbSearchCards` (entry), `_fetchTCGDirect` (TCG API via proxy `hyper-endpoint`), cluster TCGdex (`rbSearchTCGdex`, `_tcgdexHydrate`, `_tcgdexResolveDexIds`, `_tcgdexCardsByDexIds`, `tcgdexToTCGShape`...), `itToEn`+`IT_EN_MAP`, cache+`nameVariants`/`_fetchRaw`/`fetchCards` | rete (Supabase proxy), `SUPA_URL/KEY`, `TCG_URL/KEY`, `window._rbSession`, `calcPrice`, `document` (1 punto) | ✅ **estratto** → `shared/rb-card-search.js` |
| **Scraping prezzo CM** | `fetchCmPriceLive` (entry, +`_isFakeCmListings` annidata), `_vpServerSideCMScrape` (`smooth-endpoint`) | rete, Supabase; deps: `buildCM*` (rb-cm-url), `smartCMPrice`+`SUPA_*` (monolite) | ✅ **cuore estratto** → `shared/rb-cm-price.js` |
| **Prezzo CM — UI/Realtime** *(Fase 3b)* | `verifyPrice/verifyPriceAdd/applyAddPrice`, `cmLogger`, `_vpCloseCMTab`, `_saveCmStash`, `replayCmLog`, `_vpProcessListings`, `_logCmAttempts`, `_rbPersistConditionPrices`, registry `_rbRegisterPriceHandler`, conversione `frankfurter` | DOM, sessionStorage, Realtime/tab CM | resta nel monolite |
| **Matematica prezzo** | `calcBaseNMPrice`, `calcPrice`, `smartCMPrice` | puro | ⏳ Fase 2 (con la ricerca) |

Consumatori (call-site da non rompere): Preventivi (`prevSearch`, `updatePrevPrice`),
Collezione (`doSearch`, `colBatchUpdatePrices`, `_colFetchTcgPrices`, `verifyPriceColEdit`),
Scan (`scResolveTCG`, `scManualSearch`), Analizza, più i `frames/` (analizza.html, radar.html).

## Piano a fasi (ognuna validata con `node --check` e mergiata solo dopo test)

- **Fase 1 — URL CardMarket** ✅ *(questo commit)*
  Modulo puro `shared/rb-cm-url.js`. Incluso in `pokemon-db.html` **prima** dello script
  inline; blocco duplicato rimosso dal monolite. API: nomi globali retro-compatibili
  **+** namespace `RBCM.*`. Atomico per evitare il `SyntaxError` da ridichiarazione `const`.

- **Fase 2 — Motore di ricerca** ✅ *(fatto)*
  Estratto il range contiguo 4199–5126 (IT_EN_MAP, itToEn, _fetchTCGDirect, cluster
  TCGdex, rbSearchTCGdex, cache+nameVariants/_fetchRaw/fetchCards, rbSearchCards) in
  `shared/rb-card-search.js`. API: nomi globali retro-compatibili + namespace `RBSearch.*`.
  Include caricato dopo rb-cm-url e prima dello <script> inline; blocco rimosso atomico.
  L'autocomplete UI (DOM, da ~5127) resta nel monolite. Validato `node --check` (5/5 blocchi).
  Dipendenze runtime ancora dai global del monolite (SUPA/TCG/calcPrice): diventano
  parametri di `RBSearch.init({...})` in Fase 4 per il riuso nei frames/.

- **Fase 3 — Motore prezzo CM (cuore)** ✅ *(fatto)*
  Estratti `fetchCmPriceLive` (+`_isFakeCmListings` annidata) e `_vpServerSideCMScrape` in
  `shared/rb-cm-price.js`. API: nomi globali retro-compatibili + namespace `RBCMPrice.*`.
  Cluster scelto perché DOM-free e isolabile senza rischio; la parte UI/Realtime/tab
  (verifyPrice, cmLogger, _vpCloseCMTab, persist, registry) resta nel monolite — vedi
  riga "Prezzo CM — UI/Realtime" sopra. Validato `node --check` (5/5).

- **Fase 3b — Prezzo CM UI/Realtime**
  Disaccoppiare verifyPrice* e il registry handler dietro un'API stabile, spostare
  smartCMPrice/persist quando la UI è districata dal Realtime/tab CM.

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
