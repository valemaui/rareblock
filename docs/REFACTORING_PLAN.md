# Refactoring & Modularizzazione — RareBlock

> Ultimo aggiornamento: 6 mag 2026
> Stato: **Fase 1 in corso** (fondazione + estrazione Wishlist come test pattern)

---

## 1. Stato del codice (audit, mag 2026)

I due file principali del portale sono cresciuti molto e oggi concentrano troppe feature in un unico documento.

| File                          | Righe   | Peso  | Problema                                              |
|-------------------------------|--------:|------:|-------------------------------------------------------|
| `pokemon-db.html` (Collector) | 20.964  | 1.1 MB| 9 tab + auth overlay + onboarding + scan + radar      |
| `rareblock-dashboard.html` (Investor) | 19.669 | 0.9 MB | 9 tab (mkt, port, market, tx, agenda, profile, contracts, vendor, admin) |

Nel `pokemon-db.html` la mappa è la seguente:

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
| **Totale**              | **20.964** | -        | -         |

Il problema concreto: **un bug in qualunque tab apre il rischio di rompere TUTTO il file**, l'app è lenta a caricare (1.1 MB di JS+CSS allo start anche se l'utente apre solo "Collezione"), e ogni modifica richiede di leggere un file da 20k righe.

---

## 2. Obiettivo del refactoring

Trasformare `pokemon-db.html` da SPA monolitica → **shell snella** che ospita solo le feature core (Collezione, Preventivi, Import, Scan), mentre i moduli pesanti diventano pagine standalone richiamabili dalla nav.

**Vincoli non negoziabili** (in ordine di priorità):
1. **Zero regressioni funzionali**: ogni feature continua a funzionare identica.
2. **Zero rotture estetiche**: il design system attuale (palette dark + oro RareBlock) si preserva.
3. **Auth condivisa**: la sessione utente passa fra le pagine senza re-login.
4. **Deploy invariato**: il workflow GitHub Actions continua a funzionare (basta aggiungere i nuovi path alla whitelist).
5. **Roll-back facile**: ogni fase deve poter essere rollback-ata con un singolo `git revert`.

---

## 3. Architettura target

```
┌─────────────────────────────────────────────────────────────┐
│  shared/                                                    │
│  ├─ rareblock-shared.css    ← design tokens + componenti UI │
│  ├─ rareblock-shared.js     ← supa client, auth, helpers    │
│  └─ rareblock-header.js     ← header standard + mode switch │
└─────────────────────────────────────────────────────────────┘
              ▲                          ▲
              │                          │
   ┌──────────┴──────────┐    ┌──────────┴──────────────┐
   │  pokemon-db.html    │    │  rareblock-dashboard.html│
   │  (Collector shell)  │    │  (Investor shell)        │
   │                     │    │                          │
   │  Solo i tab core:   │    │  Solo i tab core         │
   │  ▸ Collezione       │    │                          │
   │  ▸ Preventivi       │    │                          │
   │  ▸ Import           │    │                          │
   │  ▸ Scan             │    │                          │
   └─────────────────────┘    └──────────────────────────┘
              │
              │ link nav esterni (apertura in stessa tab)
              ▼
   ┌─────────────────────────────────────────────────┐
   │  rareblock-wishlist.html       (~500 righe)     │
   │  rareblock-vendite.html        (~700 righe)     │
   │  rareblock-dashboard-coll.html (~250 righe)     │
   │  rareblock-masterset.html      (~1900 righe)    │
   │  rareblock-autentica.html      (~2600 righe)    │
   │  rareblock-analizza.html       (~2700 righe)    │
   │  rareblock-radar.html          (~3300 righe)    │
   └─────────────────────────────────────────────────┘
```

Risultato: `pokemon-db.html` da 20.964 righe → **~6.000 righe** (solo lo "shell" Collector).

---

## 4. Pattern di estrazione (ripetibile per ogni tab)

Per ogni tab estratto, il flow è:

1. **Crea pagina standalone** `rareblock-<feature>.html`:
   - Importa `<link rel="stylesheet" href="shared/rareblock-shared.css">`
   - Importa `<script src="shared/rareblock-shared.js" defer></script>`
   - Header con titolo + breadcrumb "← Collezione" e mode switch Investor/Collector
   - CSS specifico del modulo (inline)
   - HTML del modulo (1:1 estratto da `pokemon-db.html`)
   - JS del modulo (1:1 estratto, con namespace già isolato)
   - Bootstrap auth: se non autenticato → redirect a `rareblock-login.html?return=<this-page>`

2. **Aggiorna `pokemon-db.html`**:
   - Bottone nav → `<a href="rareblock-<feature>.html" class="nav-btn">…</a>`
   - Rimuove `<div class="tab" id="tab-<feature>">…</div>`
   - Rimuove le funzioni `<feature>*` dal blocco JS
   - Rimuove le regole CSS `.<feature>-*` dal blocco CSS
   - Rimuove l'eventuale init nel `showTab()`

3. **Aggiorna deploy whitelist** (`.github/workflows/deploy-ftp.yml`):
   - Aggiunge `rareblock-<feature>.html` ai paths
   - Aggiunge `shared/**` ai paths (una volta sola, prima estrazione)

4. **Test mentale del flow**: login → click bottone → carica → verifica auth → carica dati → render → azioni CRUD → ritorno a Collezione.

---

## 5. Roadmap fasi

| Fase | Obiettivo | Tab estratti | Rischio | Sessione |
|-----:|-----------|--------------|---------|---------:|
| **1** | Fondazione: `shared/` + estrazione **Wishlist** (test del pattern) | wishlist | Basso | **In corso** |
| **2** | Estrazione **Vendite** + **Dashboard collector tab** | vendite, dashboard | Basso | Successiva |
| **3** | Estrazione **Masterset** | masterset | Medio | … |
| **4** | Estrazione **Analizza** | analizza | Medio | … |
| **5** | Estrazione **Autentica** (AI flow delicato) | autentica | Medio-Alto | … |
| **6** | Estrazione **Radar/Hunt** (Realtime + scraper userscript) | hunt | Alto | … |
| **7** | Cleanup: rimozione CSS orfani, dedupe shared, consolidamento | - | Basso | … |
| **8** | (opzionale) Split di `rareblock-dashboard.html` (admin tab molto pesante) | admin | Alto | … |

**Razionale dell'ordine**: si parte dai tab più piccoli e isolati (basso rischio, validano il pattern), si scalano verso quelli più grandi e accoppiati. Radar/Hunt è ultimo perché ha integrazioni esterne (Tampermonkey userscript, Supabase Realtime).

---

## 6. Criteri di "Done" per fase

Ogni fase è **terminata** solo se:

- [ ] La nuova pagina sub apre, mostra dati reali, esegue azioni CRUD senza errori console
- [ ] Il bottone nav nel `pokemon-db.html` apre la nuova pagina senza re-login
- [ ] Tornando a `pokemon-db.html` dalla nuova pagina, la sessione utente è preservata
- [ ] La build GitHub Actions passa (nuovi path nella whitelist)
- [ ] Nessuna regressione visiva sui tab non toccati
- [ ] Il file `pokemon-db.html` perde N righe (= righe HTML+CSS+JS del tab estratto)
- [ ] Commit message chiaro e atomico (1 fase = 1 commit logico, anche se multipli)

---

## 7. Rischi & mitigazioni

| Rischio | Mitigazione |
|---------|-------------|
| Variabile globale orfana dopo estrazione | Cercare `<feature>*` in tutto `pokemon-db.html` prima del removal; se restano riferimenti incrociati, lasciare uno stub o fixare |
| Sessione persa fra pagine | Test esplicito: la chiave `rb_auth_session` in localStorage deve essere già letta dallo shared.js prima di qualunque chiamata API |
| Mode-switch (Investor/Collector) rotto | Il mode-switch va incluso nello shared header, non duplicato per pagina |
| Userscript Hunter (Tampermonkey) si aspetta `pokemon-db.html` come endpoint | Verificare prima di estrarre Hunt; eventualmente il userscript continua a comunicare via Supabase Realtime indipendentemente dalla pagina aperta |
| Cache browser stale (utente vede vecchio JS dopo deploy) | Service worker `sw.js` già gestisce versioning; verificare che la nuova pagina rispetti lo stesso pattern |

---

## 8. Quick reference — file shared

- **`shared/rareblock-shared.css`** — design tokens (`--bg`, `--accent`, `--gold`, …), icon set `.rb-i-*`, componenti UI base (`.btn`, `.btn-primary`, `.header`, `.nav-btn`, `.badge`, `.field`, …), scrollbar, focus rings, toast.

- **`shared/rareblock-shared.js`** — costanti backend (`SUPA_URL`, `SUPA_KEY`, `TCG_URL`, `TCG_KEY`), helper API (`getHDR()`, `supa()`), helper sessione (`rbLoadSession()`, `rbClearSession()`, `getCurrentUserId()`), bootstrap auth (`rbRequireAuth(returnPath)`), utility (`esc()`, `fmtEur()`, `fmtDate()`).

- **`shared/rareblock-header.js`** — render header standard con logo, mode switch, badge utente, LED stato API. Inserisce automaticamente nella `<header>` della pagina.

Le pagine sub-feature includono questi tre file e poi solo CSS/HTML/JS del modulo specifico.
