# RareBlock — Checklist di lancio MVP (soft launch limitato)

> Documento operativo. Ogni voce è ancorata al codice reale verificato, non a memoria.
> Legenda: **[BLOCKER]** = impedisce il lancio · **[TU]** = azione manuale tua (DB/browser/legale) · **[VERIFICA]** = controllo prima di aprire al pubblico.

---

## 0. Stato del piano (Giorni 1-5, completati)

- IA investor razionalizzata: nav 8→6 superfici + sub-nav Portafoglio.
- Frame **Caveau & Garanzie** (custodia, assicurazione, provenienza on-chain).
- Frame **Track Record & Andamento** (liquidazioni reali + mark-to-market + narrativa).
- **Waitlist** sulla landing → RPC `request_admission` (5-arg con `capital_band`, migration 073 applicata).
- Pagine **Privacy** e **Termini** (bozze, da completare con dati reali — vedi §2).

---

## 1. Il funnel reale (come entra e converte un membro)

Catena verificata dal codice:

1. **Interesse** — visitatore compila la waitlist sulla landing (`index.html` → `request_admission`). La richiesta finisce in `inv_admission_requests` con `status='waiting'`.
2. **Ammissione** — un admin valuta la richiesta e genera/assegna un **codice referral** (`inv_referral_codes`). Senza codice non si crea account: l'accesso è gated (`rb_admission`, TTL 30 min — `rareblock-login.html`).
3. **Registrazione** — il candidato si registra con il codice + accetta Privacy e Termini (checkbox obbligatorie, ora linkate a pagine esistenti).
4. **KYC** — completa la verifica identità nel Profilo (CF, documento d'identità fronte/retro, indirizzo, telefono).
5. **Contratto** — alla prima operazione viene generato un contratto da firmare (`contract-prepare` → `contract-sign` → `contract-notarize` su Base).
6. **Pagamento** — bonifico (consigliato per la prima coorte) o Stripe/PayPal.

---

## 2. BLOCKER da chiudere prima del lancio

### 2.1 [BLOCKER][TU] Dati societari in `platform_settings`
Il codice di `contract-prepare` legge da `platform_settings`: `company_legal_name`, `company_legal_form`, `company_vat`, `company_fiscal_code`, `company_office_address`, `legal_rep_name`, `legal_rep_fiscal_code`, `legal_rep_role`, `foro_competente`, `company_pec`.
- **Azione:** compila tutto in `rareblock-admin-settings.html` (sezione "Dati societari", badge "Da completare").
- **Perché blocca:** senza questi dati i contratti si generano con valori di fallback ("RareBlock" generico) → contratti legalmente deboli.

### 2.2 [BLOCKER][TU] Template contratti `is_active=true`
Migration 040 ha seedato i template come **DRAFT** (`is_active=false` → non usabili in produzione, confermato in `035_contracts.sql` e `040_template_seed.sql`).
- **Azione:** dopo revisione legale, attivare i template in produzione (`UPDATE contract_templates SET is_active=true WHERE code IN (...)`).
- **Perché blocca:** con `is_active=false` il passo 5 del funnel non produce contratti firmabili.

### 2.3 [BLOCKER][TU] Pagine legali completate
Privacy e Termini sono **bozze** con 18 campi `[DA COMPLETARE]` e banner di bozza.
- **Azione:** completare i campi (coerenti con §2.1), rimuovere il commento BOZZA e il `.draft-banner`, far validare dal legale.
- **Stato:** revisione legale dichiarata fatta — resta da rimuovere i marcatori di bozza e valorizzare i `[DA COMPLETARE]`.

### 2.4 [BLOCKER][TU] Migration in sospeso applicate
- 073 (capital_band) → **applicata**.
- **Verifica:** che non restino altre migration non applicate al DB di produzione (confronta `supabase/migrations/` con lo stato del DB).

### 2.5 [VERIFICA] Stripe resta in TEST per la prima coorte
`stripe-create-checkout-session` legge la secret da `Deno.env.get` (Secret Supabase). Per il soft launch: **prima coorte solo bonifico**, Stripe in test. Switch a live (`sk_live_` + nuovo `whsec_`) solo dopo.
- **Aperti noti (non-blocker se solo bonifico):** Apple Pay `.well-known` pending; refund handler `charge.refunded` incompleto; trigger `payout_mode` snapshot solo su bonifico.

---

## 3. Dry run E2E [TU] — da eseguire loggato sul DB reale

Esegui l'intero funnel come un estraneo, in quest'ordine. Annota l'output console ad ogni passo.

- [ ] **Waitlist:** invia email di test + fascia capitale sulla landing live. Verifica riga in `inv_admission_requests` con `capital_band` valorizzato. *(test della 073 — vedi query sotto)*
- [ ] **Ammissione:** genera un codice referral di test, valida che sblocchi la registrazione.
- [ ] **Registrazione:** crea account col codice. Verifica che le checkbox Privacy/Termini aprano le pagine reali (non più 404).
- [ ] **KYC:** completa la verifica con dati di test. Verifica `kyc_status`/`kyc_level` aggiornati.
- [ ] **Catalogo:** apri un prodotto reale (Modalità A consigliata per il primo test — più semplice della comproprietà).
- [ ] **Contratto:** avvia un acquisto → verifica che il contratto si generi con i **dati societari reali** (§2.1) e si firmi (`contract-sign`) + notarizzi su Base (`contract-notarize`). Controlla la tx su basescan.
- [ ] **Bonifico:** completa l'ordine via bonifico. Verifica causale generata, `bank_reference`, stato ordine `pending`.
- [ ] **Conferma admin:** dal pannello admin, conferma il pagamento → verifica transizione stato + comparsa in Portafoglio/Transazioni/Caveau.
- [ ] **Caveau:** il bene comprato appare con badge assicurato e link verifica.
- [ ] **Track Record:** (se applicabile) la liquidazione di test appare nei risultati.

```sql
-- Verifica waitlist + capital_band (073)
select email, capital_band, status, created_at
from inv_admission_requests order by created_at desc limit 5;
```

---

## 4. Deploy & infrastruttura [VERIFICA]

Workflow presenti: `deploy-ftp.yml` (FTP Aruba), `deploy-supabase.yml`, `deploy-contracts-edge.yml`, `diag.yml`.

- [ ] Ultimo push su `main` → Action FTP verde (landing + dashboard + pagine legali online).
- [ ] Edge functions deployate: `request_admission` (DB), `contract-*`, `stripe-*`, `paypal-webhook`.
- [ ] Secret Supabase presenti: `STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SITE_URL`, chiavi email.
- [ ] SMTP Aruba attivo (`noreply@rareblock.eu`) → email di conferma signup/magic link arrivano.
- [ ] `privacy.html` e `terms.html` raggiungibili in produzione (verifica HTTP 200, non 404).

---

## 5. Sequenza soft launch (Giorno 7)

1. **Coorte ristretta:** invita 5-10 contatti fidati via codice referral. Non aprire la waitlist a freddo finché il funnel non è confermato su persone reali.
2. **Solo bonifico** per la prima coorte (azzera il rischio pagamenti live).
3. **Monitora:** `inv_admission_requests` (nuove richieste), errori console riportati, email recapitate.
4. **Iterazione rapida:** raccogli i primi feedback, sistema gli intoppi, poi allarga.
5. **Switch Stripe live** solo dopo che il flusso bonifico è confermato pulito end-to-end.

---

## 6. Post-lancio (non-blocker, dai tuoi TODO)

- Cron auto-apertura finestre di voto frazionato a `exit_window_years`.
- Notifiche email/SMS apertura finestre di voto.
- Pulizia 3 `holdings` "Set Base Box Break" con `type=fractional` ma campi Modalità B nulli.
- Refund handler Stripe `charge.refunded` → `status='refunded'`.
- Gating server-side investimenti frazionati (`kyc_can_invest` lato edge, difesa in profondità).
- `rb_watchlist` localStorage non user-scoped.
- Eventuale cookie policy + banner (se si aggiungono analitici).
