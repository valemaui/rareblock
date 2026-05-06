# Refactoring & Modularizzazione — RareBlock

> Ultimo aggiornamento: 6 mag 2026
> Stato: **Fase 1 — branch `refactor/wishlist-extract-v2`**
> (la v1 è stata rollback-ata per errore UX, vedi §9)

---

## 1. Stato del codice (audit, mag 2026)

I due file principali del portale sono cresciuti molto e oggi concentrano troppe feature in un unico documento.

| File                          | Righe   | Peso  | Problema                                              |
|-------------------------------|--------:|------:|-------------------------------------------------------|
| `pokemon-db.html` (Collector) | 20.964  | 1.1 MB| 9 tab + auth overlay + onboarding + scan + radar      |
| `rareblock-dashboard.html` (Investor) | 19.669 | 0.9 MB | 9 tab (mkt, port, market, tx, agenda, profile, contracts, vendor, admin) |

Mappa del `pokemon-db.html`:

| Sezione                 | Righe HTML | Righe JS | Namespace |
|-------------------------|-----------:|---------:|-----------|
| AUTH OVERLAY (login)    | 510        | -        | `ao*`     |
| ONBOARDING (KYC)        | (incluso)  | -        | `obx*`    |
| TAB Collezione          | 148        | parte di 5535 | `col*` |
| TAB Preventivi          | 110        | parte di 5535 | `prev*`|
| TAB Import CSV          | 186        | parte di 5535 | `imp*` |
| TAB Scan (camera)       | 170        | parte di 5535 | `sc*`  |
| TAB Masterset           | 995        | 879           | `ms*`  |
| TAB Autentica (AI)      | 1.384      | 1.171         | `au*`  |
| TAB Analizza            | 107        | 2.627         | `anl*` |
| TAB Dashboard           | 63         | ~150          | `dash*`|
| TAB Vendite             | 88         | ~600          | `vend*`|
| TAB Wishlist            | 78         | ~400          | `wish*`|
| TAB Radar (Hunt)        | 360        | ~3.000        | `hunt*`|
| Header / init / auth    | -          | 1.421         | `auth*`|

---

## 2. Obiettivo & vincoli

Trasformare `pokemon-db.html` da SPA monolitica in **shell** che ospita solo le feature core (Collezione, Preventivi, Import, Scan), spostando i moduli pesanti in pagine standalone richiamabili dalla nav.

**Vincoli non negoziabili**:

1. **Zero regressioni funzionali**: ogni feature continua a funzionare identica.
2. **Zero discontinuità visiva** ⚠️ — questa è la lezione di v1 (vedi §9). Le pagine sub-feature devono essere **indistinguibili** da un cambio tab interno: stesso header, stessa nav completa, stesso mode-switch, stesso LED API, stesso badge utente. L'utente non deve mai pensare "sono uscito dal sito".
3. **Auth condivisa**: la sessione utente passa fra pagine senza re-login.
4. **Deploy invariato**: il workflow GitHub Actions continua a funzionare.
5. **Roll-back facile**: ogni fase deve poter essere rollback-ata con un singolo `git revert` o tornando indietro di un branch.

---

## 3. Architettura target

```
┌─────────────────────────────────────────────────────────────┐
│  shared/                                                    │
│  ├─ rareblock-shared.css   ← design tokens + componenti     │
│  │                          + page-fade + nav styles        │
│  └─ rareblock-shared.js    ← supa client + auth + helpers   │
│                             + rbRenderHeader (nav COMPLETA) │
│                             + rbCheckApiStatus (LED)        │
│                             + rbInitPageFade (cross-fade)   │
└─────────────────────────────────────────────────────────────┘
              ▲                          ▲
              │                          │
   ┌──────────┴──────────┐    ┌──────────┴──────────────┐
   │  pokemon-db.html    │    │  rareblock-dashboard.html│
   │  (Collector shell)  │    │  (Investor shell)        │
   │  4 tab core         │    │  9 tab                   │
   └─────────────────────┘    └──────────────────────────┘
              │
              │ link nav (stesso header, stessa nav)
              ▼
   ┌─────────────────────────────────────────────────┐
   │  rareblock-wishlist.html  ← header + nav UGUALI │
   │  rareblock-vendite.html   ← header + nav UGUALI │
   │  …                                              │
   └─────────────────────────────────────────────────┘
```

L'utente naviga fra tab interni (showTab) e pagine HTML separate (link `<a>`) senza percepire la differenza. Il mini fade di 180ms ammorbidisce il salto di rendering tra documenti.

---

## 4. Pattern di estrazione

Per ogni tab estratto:

1. **Crea pagina standalone** `rareblock-<feature>.html`:
   - Importa `<link rel="stylesheet" href="shared/rareblock-shared.css"/>`
   - Importa `<script src="shared/rareblock-shared.js" defer></script>`
   - Body con `<header id="rbHeader" class="header"></header>` (popolato da `rbRenderHeader({active:'<feature>'})`)
   - CSS specifico inline
   - HTML del modulo (1:1 estratto da `pokemon-db.html`)
   - JS del modulo (1:1, namespace già isolato)
   - Bootstrap: `rbRequireAuth → rbRenderHeader → rbCheckApiStatus → rbInitPageFade → init modulo`

2. **Aggiorna `pokemon-db.html`**:
   - Bottone nav → `<a class="nav-btn" href="rareblock-<feature>.html">…</a>`
   - Rimuove `<div class="tab" id="tab-<feature>">…</div>`
   - Rimuove le funzioni `<feature>*` dal blocco JS
   - Rimuove le regole CSS `.<feature>-*` dal blocco CSS
   - Rimuove l'init nel `showTab()`

3. **Aggiorna deploy whitelist** (`.github/workflows/deploy-ftp.yml`):
   - Aggiunge `rareblock-<feature>.html` ai paths
   - `shared/**` già nei paths dalla Fase 1

4. **Test mentale**: login → click nav → carica → CRUD → click altro tab/nav → ritorno.

---

## 5. Roadmap fasi

| Fase | Obiettivo | Tab estratti | Rischio | Stato |
|-----:|-----------|--------------|---------|-------|
| **1** | Fondazione: `shared/` + estrazione **Wishlist** | wishlist | Basso | **In review (v2)** |
| **2** | Estrazione **Vendite** + **Dashboard collector tab** | vendite, dashboard | Basso | … |
| **3** | Estrazione **Masterset** | masterset | Medio | … |
| **4** | Estrazione **Analizza** | analizza | Medio | … |
| **5** | Estrazione **Autentica** (AI flow delicato) | autentica | Medio-Alto | … |
| **6** | Estrazione **Radar/Hunt** (Realtime + scraper userscript) | hunt | Alto | … |
| **7** | Cleanup: dedupe shared, rifattorizzazione finale `pokemon-db.html` | - | Basso | … |
| **8** | (opzionale) Split di `rareblock-dashboard.html` (admin tab molto pesante) | admin | Alto | … |

---

## 6. Criteri di "Done" per fase

- [ ] La nuova pagina sub apre, mostra dati reali, esegue azioni CRUD senza errori console
- [ ] **Header e nav identici alla shell**: stesso logo, stesso mode-switch, stessi 9 bottoni nav, stesso LED API, stesso user-badge
- [ ] La sessione utente è preservata fra le pagine
- [ ] Mini fade visibile cross-page (180ms in / 140ms out)
- [ ] La build GitHub Actions passa
- [ ] Nessuna regressione visiva sui tab non toccati
- [ ] Il file `pokemon-db.html` perde N righe (= righe HTML+CSS+JS del tab estratto)
- [ ] Commit message chiaro e atomico

---

## 7. Rischi & mitigazioni

| Rischio | Mitigazione |
|---------|-------------|
| Variabile globale orfana dopo estrazione | Cercare `<feature>*` in tutto `pokemon-db.html` prima del removal |
| Sessione persa fra pagine | `rb_auth_session` in localStorage, letto da `shared.js` al boot |
| Mode-switch (Investor/Collector) incoerente | Mode-switch generato da `rbRenderHeader()` — stesso markup ovunque |
| Userscript Hunter (Tampermonkey) si aspetta `pokemon-db.html` | Verificare prima di estrarre Hunt |
| Cache browser stale | Service worker `sw.js` già gestisce versioning |

---

## 8. Quick reference — file shared

- **`shared/rareblock-shared.css`** — design tokens, icon set, componenti UI base, **page-fade rules**, nav-link styling.

- **`shared/rareblock-shared.js`** — backend constants, supa client, sessione, profilo, `rbRequireAuth`, **`rbRenderHeader({active})`**, **`rbCheckApiStatus`**, **`rbInitPageFade`**, `rbLogout`/`authLogout`, utility (`esc/fmtEur/fmtDate`).

---

## 9. Lessons learned dalla v1 (rollback)

La prima versione della Fase 1 (commit `44c88f3`, mergata e poi revertata con `1ec25b4`) ha estratto correttamente la wishlist a livello tecnico ma ha **sbagliato la UX**: l'header della pagina sub aveva solo logo + breadcrumb "← Collezione" + titolo modulo, anziché replicare la nav completa.

**Sintomo**: l'utente percepiva la wishlist come una pagina "fuori dal sito", come se qualcosa si fosse rotto.

**Causa radice**: ho applicato il pattern *"pagina di dettaglio"* (es. checkout, modal-as-page) al posto del pattern *"tab estratto in pagina"* (l'utente non deve accorgersi di nulla).

**Fix in v2** (questo branch):
- `rbRenderHeader()` ora genera **la nav completa** con tutti e 9 i bottoni, in ordine identico al `pokemon-db.html`.
- Le voci che puntano a tab interni del Collector usano `<a href="pokemon-db.html#tab=…">` + il fragment-handler già presente in `appStart` per aprire il tab corretto al ritorno.
- La voce attiva (es. "Wishlist" nella pagina wishlist) ha la classe `.active` ed è non-cliccabile.
- Mini cross-fade (180ms in / 140ms out) gestito da `rbInitPageFade()`, applicato anche al `pokemon-db.html` per coerenza.

**Take-away**: nei prossimi tab estratti, il check "header e nav indistinguibili dal monolite" deve essere il **primo criterio di accettazione** — più importante del check tecnico.
