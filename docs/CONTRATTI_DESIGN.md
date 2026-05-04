# RareBlock — Progettazione Contratti & Firma OTP

**Versione:** 0.5 (PR1 consegnata)
**Autore:** Claude (assistente sviluppo)
**Data:** 04 maggio 2026
**Stato:** ✅ PR1 in main — pronto per PR2 (Edge Functions OTP via Twilio+WA)

## Cambiamenti v0.4 → v0.5
- ✅ **PR1 consegnata** in commit successivi alla baseline `fcc30ec`
- 📌 Migration 037 originale **splittata** in:
  - `037_club_membership.sql` (in PR1) — solo club, indipendente da contracts
  - `038_kyc_quote_acknowledgments.sql` (in PR9 con 035) — dipende da `contracts.id` per FK
- ⏳ Restano da confermare: B4 (preemption vs scioglimento) e B6 (questionario consapevolezza), entrambi non bloccanti per le PR successive di infrastruttura

## Cambiamenti v0.3 → v0.4
- ✅ B1: comunicazione marketing = **co-titolarità di un bene da collezione** (no linguaggio "investimento con rendimento")
- ✅ B2: **nessuna promessa di rendimento** — solo dichiarazione di volatilità
- ✅ B3: liquidazione decisa dai **comproprietari a maggioranza qualificata** (RareBlock = solo amministratore)
- ⏳ B4: presumo **B4.a (preemption right)** in linea con prassi club privati — da confermare
- ✅ B5: **club privato chiuso a numero chiuso** (criteri di ammissione gestiti da admin)
- ⏳ B6: proposto **questionario light di consapevolezza** (3 spunte: co-titolarità, volatilità, illiquidità) — da confermare

**Risultato giuridico**: Modalità B configurata come comproprietà ex art. 1100 c.c. + mandato di amministrazione e custodia ex artt. 1105-1106 c.c. → **fuori dal perimetro CONSOB/TUF**, scrivibile come contratto privato senza autorizzazioni.

## Cambiamenti v0.2 → v0.3
- ✅ Q5: mandato vendor **esclusivo**
- ✅ Q6: campi anagrafica §1.1 e §1.2 confermati
- ✅ Q7: documento d'identità **CI / Patente / Passaporto** tutti accettati
- ✅ Q8: soglia KYC L3 = **€15.000 cumulativi/12 mesi** (default ex 231)
- ✅ Q9: provider messaggistica = **Twilio Programmable Messaging** con canale primario **WhatsApp Business via Meta** (più economico, UX migliore) e fallback automatico **SMS** se WA non delivered
- ✅ Q10: **notarizzazione on-chain inclusa** al go-live (riusa wallet custodial Base + chain_certificates)
- ✅ Q11: dati societari RareBlock e legale rappresentante **gestiti da `platform_settings`**, modificabili dal pannello admin con audit trail e versioning
- ✅ Q12: foro = **Tribunale di Messina** (con riserva consumatore, vedi §2.2)
- ✅ Q13: legale ha dato **via libera all'impianto** (impatto: vedi §10 sulla validazione)
- ✅ Q14: Privacy Policy / Cookie Policy / Informativa GDPR / Informativa FEA → **da redigere ex novo come allegati standard customizzati**, gestiti dal modulo template
- ✅ Q15: dati polizza assicurativa → **gestiti da `platform_settings`**, aggiornabili da admin (placeholder dinamico nei contratti)
- ✅ Q16: liability cap = **massimale assicurativo** (con eccezione di legge per dolo e colpa grave ex art. 1229 c.c.)
- ⏳ B1-B5: aperte (vedi §4)

## Cambiamenti v0.1 → v0.2
- ✅ Q0: nuovo file dedicato `rareblock-contracts.html` per UI utente, tab dedicato in admin esistente
- ✅ Q1: A + B al go-live → richiede sub-decisioni B1-B5 in §4 prima di procedere
- ✅ Q2: spese grading a carico RareBlock
- ✅ Q3: commissione vendor = default piattaforma + override per vendor (riusa `inv_vendors.commission_pct`)
- ✅ Q4: custodia sempre a pagamento, tariffario per dimensione prodotto + override per oggetto

---

## ⚠️ Premessa legale

Non sono un avvocato. Questo documento definisce un **impianto tecnico-contrattuale** che recepisce le best practice del settore (mandato a vendere con custodia, deposito ex art. 1766 c.c., firma elettronica avanzata ex eIDAS), ma le bozze di contratto **devono essere validate da un legale italiano** prima di essere messe in produzione, per due ragioni concrete:

1. **KYC/AML.** Sopra €15.000 cumulativi su uno stesso cliente scatta l'obbligo di adeguata verifica ex **D.Lgs. 231/2007**. Operare con HNWI alza la probabilità di superare quella soglia: serve definire chi è il "soggetto obbligato" (RareBlock come operatore? o solo gli istituti di pagamento a valle?).
2. **Quota d'investimento.** La vendita di "quote" di beni fisici a investitori privati può essere riqualificata come **strumento finanziario / OICR** sotto la vigilanza CONSOB se promette un rendimento. Il taglio comunicativo del prodotto (rendimento atteso vs comproprietà di un bene fisico) cambia tutto. Vedi §5.

Detto questo, l'impianto qui sotto è progettato per **minimizzare il rischio** stando nel perimetro di:
- contratto di **mandato a vendere senza rappresentanza** (vendor) + **deposito** (custodia)
- **compravendita + comproprietà indivisa** ex art. 1100 c.c. (acquirente di quote) + **deposito**

---

## 1. Anagrafica utente — campi minimi

L'anagrafica attuale (`profiles` + `bill_*`) ha solo dati fatturazione. Per i contratti servono campi ulteriori. Distinguiamo **3 livelli KYC**:

| Livello | Quando si applica | Cosa serve |
|---|---|---|
| **L0** — Lead | Sola navigazione, newsletter | Email |
| **L1** — Account base | Browse marketplace, no transazioni | + nome, cellulare verificato OTP, GDPR |
| **L2** — Operativo | Firma contratti vendor o acquisto/custodia | Anagrafica completa + documento d'identità |
| **L3** — Rinforzato | Operazioni > €15.000 cumulativi/12m | + dichiarazione fonte fondi, PEP, UBO se persona giuridica |

### 1.1 Campi persona fisica (L2)

Schema dati che alimenta l'anagrafica e il pre-fill dei contratti:

| Campo | Tipo | Obbligo | Note |
|---|---|---|---|
| `first_name` | text | sì | |
| `last_name` | text | sì | |
| `birth_date` | date | sì | maggiorenne richiesto |
| `birth_place` | text | sì | comune o città estera |
| `birth_country` | iso2 | sì | default IT |
| `nationality` | iso2 | sì | default IT |
| `fiscal_code` | text | sì se IT | validato con check digit |
| `id_doc_type` | enum | sì | CI / PATENTE / PASSAPORTO |
| `id_doc_number` | text | sì | |
| `id_doc_issuer` | text | sì | "Comune di X" / "Prefettura di Y" |
| `id_doc_issue_date` | date | sì | |
| `id_doc_expiry_date` | date | sì | check non scaduto |
| `id_doc_front_url` | text | sì | upload Supabase Storage privato |
| `id_doc_back_url` | text | sì | (no per passaporto) |
| `res_address` | text | sì | via |
| `res_civic` | text | sì | numero civico |
| `res_zip` | text | sì | |
| `res_city` | text | sì | |
| `res_province` | text | sì se IT | sigla 2 lettere |
| `res_country` | iso2 | sì | |
| `phone_country_code` | text | sì | default +39 |
| `phone_number` | text | sì | normalizzato E.164 |
| `phone_verified_at` | timestamptz | – | impostato solo dopo OTP iniziale |
| `email` (auth.users) | text | sì | |
| `iban` | text | per vendor | per accrediti payout |
| `bic` | text | opz | dedotto da IBAN se IT |

### 1.2 Campi aggiuntivi persona giuridica (per vendor company)

| Campo | Tipo | Note |
|---|---|---|
| `company_legal_name` | text | ragione sociale |
| `company_form` | enum | SRL / SPA / SAS / SNC / SS / Ditta individuale / Altro |
| `company_vat` | text | P.IVA |
| `company_fiscal_code` | text | spesso = P.IVA |
| `company_rea` | text | iscrizione REA |
| `company_chamber` | text | CCIAA di iscrizione |
| `company_pec` | text | obbligatoria per IT |
| `company_sdi` | text | codice destinatario SDI |
| `company_registered_office` | json | indirizzo sede legale |
| `legal_rep_*` | – | tutti i campi persona fisica del legale rappresentante |
| `legal_rep_role` | text | "Amministratore unico" / "Presidente CdA" / ... |
| `legal_rep_powers_doc_url` | text | visura o atto di nomina |

### 1.3 Compliance (L3)

| Campo | Tipo | Note |
|---|---|---|
| `pep_self` | bool | Persona Politicamente Esposta — autodichiarazione |
| `pep_relative` | bool | familiare/legato a PEP |
| `pep_details` | text | dettagli se sì |
| `source_of_funds` | enum | reddito / risparmi / vendita immobile / eredità / impresa / altro |
| `source_of_funds_notes` | text | dettagli |
| `kyc_level` | int | 0/1/2/3 |
| `kyc_status` | enum | pending / review / approved / rejected |
| `kyc_completed_at` | timestamptz | |
| `kyc_reviewer_id` | uuid | admin che ha approvato |

### 1.4 Consensi GDPR (granulari, sempre)

| Campo | Tipo | Default |
|---|---|---|
| `gdpr_privacy_accepted_at` | timestamptz | obbligatorio per usare la piattaforma |
| `gdpr_tos_accepted_at` | timestamptz | obbligatorio |
| `gdpr_marketing_accepted` | bool | opt-in esplicito |
| `gdpr_profiling_accepted` | bool | opt-in esplicito |
| `gdpr_third_party_accepted` | bool | opt-in esplicito |

> **Audit trail:** ogni cambio dei consensi va loggato in tabella `gdpr_consent_log` (timestamp, IP, UA, valore prima/dopo). Obbligo di accountability ex art. 5(2) GDPR.

---

## 2. Contratto VENDOR — Mandato a vendere con custodia

### 2.1 Inquadramento

Tipologia: **mandato a vendere senza rappresentanza** (artt. 1703 ss. c.c.) **+ deposito** (artt. 1766 ss. c.c.) — RareBlock vende il bene **in nome proprio per conto del vendor** e ne mantiene la custodia fino alla vendita o al ritiro.

Identificativo template: `VENDOR_MANDATE_V1`
Numerazione contratti: `RB-VND-2026-NNNNNN`

### 2.2 Struttura clausole

```
PREAMBOLO
  • Identificazione completa di RareBlock (ragione sociale, P.IVA, sede, LR)
  • Identificazione completa del Vendor (anagrafica L2)
  • Premesse / recitals

ART. 1 — DEFINIZIONI
  Bene/i, Piattaforma, Custodia, Prezzo di Riserva, Commissione,
  Acquirente, Certificato Digitale, Mandato.

ART. 2 — OGGETTO
  Mandato senza rappresentanza a vendere i Beni elencati in
  Allegato A, in nome di RareBlock e per conto del Vendor.

ART. 3 — CONSEGNA E CUSTODIA
  3.1 Modalità di consegna fisica (spedizione assicurata a carico del Vendor)
  3.2 Verifica all'ingresso (pesatura, check fotografico, condizione)
  3.3 Custodia in caveau certificato (temperatura, umidità, sicurezza)
  3.4 Durata della custodia: indeterminata fino a vendita o ritiro
  3.5 Fee di custodia (se prevista, p.es. dopo X mesi)

ART. 4 — AUTENTICAZIONE E GRADING
  4.1 Diritto di RareBlock di sottoporre il Bene a verifica
      autentica e/o grading (PSA/CGC/Beckett) a propria discrezione
  4.2 Costi del grading INTERAMENTE A CARICO DI RAREBLOCK
      (decisione Q2: la piattaforma assorbe il costo come investimento
      di marketing sulla qualità del catalogo)
  4.3 Riservato il diritto di rifiutare il Bene se non autentico
      o se il grading restituisce condizione difforme dalla dichiarazione
      del Vendor (in tal caso restituzione a spese del Vendor)

ART. 5 — PREZZO E CONDIZIONI DI VENDITA
  5.1 Prezzo di Riserva concordato (per ciascun Bene)
  5.2 Modalità di promozione (asta / prezzo fisso / quote)
  5.3 Esclusiva: il Vendor si impegna a non offrire il Bene altrove
      durante il mandato

ART. 6 — COMMISSIONE
  6.1 Commissione di RareBlock applicata sul prezzo lordo di vendita.
      Modello (decisione Q3):
        - default piattaforma in `platform_settings.default_commission_pct`
        - override per vendor in `inv_vendors.commission_pct` (già esistente)
        - override puntuale per singolo Bene in caso di accordi speciali
        - la % applicata viene CONGELATA nel contratto al momento della firma
  6.2 Spese vive a carico di RareBlock: grading (vedi art. 4),
      foto professionali, fee marketplace lato seller (3% bonifico /
      3% Stripe / 3% PayPal — da `marketplace_fee_config`)
  6.3 Spese vive a carico del Vendor: spedizione di consegna a RareBlock,
      eventuale spedizione di ritorno se il Bene viene ritirato senza vendita
  6.4 Esempio numerico in Allegato D, calcolato dinamicamente sui
      parametri di QUESTO contratto

ART. 7 — INCASSO E PAGAMENTO AL VENDOR
  7.1 RareBlock incassa dall'Acquirente
  7.2 Tempi di accredito al Vendor: T+X giorni dalla "vendita confermata"
      (definita come: pagamento ricevuto + diritto di recesso scaduto)
  7.3 IBAN del Vendor da anagrafica
  7.4 Trattenuta in caso di reclami / dispute

ART. 8 — RISCHIO E ASSICURAZIONE
  8.1 Il rischio di perimento o danneggiamento del Bene si trasferisce
      a RareBlock dalla presa in consegna fino alla riconsegna o vendita
  8.2 Il Bene è coperto dalla polizza n. {{insurance_policy_number}}
      rilasciata da {{insurance_company}} (massimale e franchigia
      indicati negli estremi pubblicati nei platform_settings,
      aggiornati al momento della firma e congelati nel contratto)
  8.3 Esclusioni: forza maggiore non assicurabili, vizi occulti antecedenti
      la consegna a RareBlock e non rilevabili a un esame ragionevole,
      dichiarazioni mendaci del Vendor sulla provenienza/condizione
  8.4 In caso di sinistro: indennizzo al Vendor pari al MINORE tra
      il prezzo di riserva e il valore di mercato medio degli ultimi 12 mesi
      del Bene secondo fonti pubbliche (Cardmarket, PriceCharting o equivalenti)

ART. 9 — DIRITTI DEL VENDOR
  9.1 Ritiro del Bene non venduto: preavviso, costi spedizione
  9.2 Modifica prezzo di riserva: con quale preavviso
  9.3 Accesso a reportistica vendita

ART. 10 — RECESSO E RISOLUZIONE
  10.1 Recesso del Vendor: condizioni e termini
  10.2 Risoluzione per inadempimento (autenticità non confermata,
       descrizione difforme, ...)
  10.3 Effetti della risoluzione

ART. 11 — DICHIARAZIONI E GARANZIE DEL VENDOR
  11.1 Titolarità piena del Bene (no pegni, no contestazioni)
  11.2 Provenienza lecita
  11.3 Assenza di vizi non dichiarati
  11.4 Manleva a favore di RareBlock per pretese di terzi

ART. 12 — RISERVATEZZA

ART. 13 — TRATTAMENTO DATI PERSONALI
  Rinvio a Privacy Policy (link versionato)
  Base giuridica: esecuzione contratto + obblighi legali (231/AML)

ART. 14 — COMUNICAZIONI
  Email registrata + PEC se persona giuridica

ART. 15 — DURATA E CESSAZIONE

ART. 16 — LEGGE APPLICABILE E FORO
  Legge italiana
  Foro esclusivo: Tribunale di Messina
  Eccezione obbligatoria ex art. 33 c.2 lett. u) D.Lgs. 206/2005:
    se il Vendor è qualificabile come consumatore (persona fisica
    che agisce per scopi estranei all'attività imprenditoriale,
    commerciale, artigianale o professionale) → foro inderogabile
    di residenza o domicilio del Vendor.
  Per i contratti tra professionisti (vendor giuridici, vendor
  imprenditori) il foro di Messina è efficace come scelta esclusiva.

ART. 17 — FIRMA ELETTRONICA AVANZATA
  17.1 Modalità (SMS OTP)
  17.2 Effetti probatori ex art. 20 CAD
  17.3 Accettazione esplicita della modalità

ALLEGATI
  A — Lista dei Beni con foto, condizione, prezzo riserva
  B — Informativa Privacy
  C — Informativa Firma Elettronica Avanzata
  D — Tabella Commissioni e Costi
  E — Polizza Assicurativa (estratto)
```

### 2.3 Dati che il sistema pre-compila automaticamente

Tutti i campi tra `{{...}}` sono iniettati dal motore al momento della generazione PDF, attingendo da `profiles` + dati operazione:

```
{{vendor.full_name}}, nato a {{vendor.birth_place}} ({{vendor.birth_country}})
il {{vendor.birth_date|format}}, C.F. {{vendor.fiscal_code}}, residente in
{{vendor.res_address}} {{vendor.res_civic}}, {{vendor.res_zip}}
{{vendor.res_city}} ({{vendor.res_province}}), documento {{vendor.id_doc_type}}
n. {{vendor.id_doc_number}} rilasciato da {{vendor.id_doc_issuer}}
in data {{vendor.id_doc_issue_date|format}} e valido fino al
{{vendor.id_doc_expiry_date|format}}.
```

---

## 3. Contratto ACQUIRENTE — Compravendita con custodia

### 3.1 Inquadramento

Due possibili tipologie a seconda del prodotto:

**Modalità A — Acquisto integrale di un bene fisico singolo con custodia**
Tipologia: **compravendita** (artt. 1470 ss. c.c.) **+ deposito** (artt. 1766 ss. c.c.).
La proprietà del bene specifico passa all'acquirente al pagamento, ma il bene resta in custodia.
Identificativo template: `BUYER_PURCHASE_CUSTODY_V1`

**Modalità B — Acquisto di quote di un bene in comproprietà**
Tipologia: **compravendita di quota di comproprietà indivisa** (art. 1100 c.c.) **+ deposito**.
Più acquirenti diventano comproprietari pro-quota dello stesso bene fisico.
Identificativo template: `BUYER_FRACTIONAL_CUSTODY_V1`
⚠️ **Vedi §5 per i rischi di riqualificazione come strumento finanziario.**

Numerazione contratti: `RB-BUY-2026-NNNNNN`

### 3.2 Struttura clausole — Modalità A

```
PREAMBOLO
  • Identificazione di RareBlock e dell'Acquirente

ART. 1 — DEFINIZIONI

ART. 2 — OGGETTO DELLA COMPRAVENDITA
  Identificazione univoca del Bene:
   - Descrizione, edizione, set, numero
   - Stato di conservazione e/o grading (con n. certificato)
   - Foto allegate
   - Eventuale Certificato Digitale RareBlock (chain_certificates.id)
     ancorato on-chain (network: Base, contract, token_id)

ART. 3 — PREZZO E PAGAMENTO
  3.1 Prezzo lordo
  3.2 Buyer's premium (% per metodo di pagamento — vedi marketplace_fee_config)
  3.3 Modalità ammesse (bonifico SEPA / carta / PayPal)
  3.4 Pagamento in unica soluzione

ART. 4 — TRASFERIMENTO DELLA PROPRIETÀ
  4.1 Proprietà trasferita al ricevimento del pagamento integrale
  4.2 Emissione del Certificato Digitale a favore dell'Acquirente
      con notazione blockchain (chain_certificates)
  4.3 Diritto di rivendita libero sul marketplace

ART. 5 — CUSTODIA
  5.1 Bene custodito da RareBlock in caveau certificato
  5.2 Condizioni ambientali (T°, umidità, sicurezza, antincendio)
  5.3 Durata: indeterminata, salvo richiesta di ritiro
  5.4 Fee di custodia (decisione Q4) — SEMPRE A PAGAMENTO con modello a tre livelli:
      a) tariffa base annua per fascia dimensionale del Bene secondo la
         tabella `custody_fee_tiers` (es. card singola, slab graded,
         box small/medium/large, sealed display, sealed case)
      b) override per singolo Bene per oggetti rari/delicati (incremento)
         o per accordi promozionali (riduzione/azzeramento periodo iniziale)
      c) la fee applicata viene CONGELATA nel contratto al momento della firma
         e indicizzata annualmente solo se così esplicitato
  5.5 Modalità di addebito: prepagata annuale, prelievo da IBAN
      o trattenuta sul payout di vendita
  5.6 Conseguenza mancato pagamento: dopo 60gg di insoluto RareBlock
      ha diritto di vendere il Bene per recuperare le spese
      (vedi art. 1782 c.c. analogia su deposito oneroso)

ART. 6 — DIRITTO AL RITIRO FISICO
  6.1 Acquirente può richiedere consegna fisica in qualsiasi momento
  6.2 Costi spedizione e assicurazione a carico Acquirente
  6.3 Tempi di evasione: max 15 giorni lavorativi
  6.4 Conseguenza: il Certificato Digitale viene "burned" o marcato
      come "redeemed" (chain_certificates.status='burned')

ART. 7 — RISCHIO E ASSICURAZIONE
  7.1 Rischio in capo a RareBlock per tutto il periodo di custodia
  7.2 Bene coperto dalla polizza n. {{insurance_policy_number}}
      rilasciata da {{insurance_company}}, massimale per oggetto
      {{insurance_max_per_item}}, massimale aggregato
      {{insurance_max_aggregate}}, franchigia {{insurance_deductible}}
      (estremi congelati al momento della firma da `platform_settings`)
  7.3 In caso di sinistro: rimborso al MAGGIORE tra
       (a) il prezzo pagato dall'Acquirente, e
       (b) il valore di perizia indipendente o, in subordine,
           il prezzo medio di mercato degli ultimi 12 mesi
       fino a concorrenza del massimale di polizza per oggetto

ART. 8 — GARANZIE SUL BENE
  8.1 Autenticità garantita da RareBlock, certificata da:
       - Grading di terza parte (PSA/CGC/Beckett)
       - Audit interno di autenticazione (vedi modulo Autentica)
  8.2 Conformità del grado dichiarato
  8.3 In caso di vizi non dichiarati: rimborso integrale + spese

ART. 9 — DIRITTO DI RECESSO (consumatore)
  Se Acquirente è consumatore ex art. 3 c. cons.:
   9.1 Diritto di recesso 14 giorni dalla conclusione del contratto
       senza necessità di motivazione
   9.2 Restituzione integrale del prezzo
   9.3 Modalità di esercizio (modulo allegato)
   9.4 Eccezione: NON si applica se il bene è stato già consegnato
       fisicamente e personalizzato (improbabile nel nostro caso)

ART. 10 — RIVENDITA SUL MARKETPLACE
  10.1 Rinvio ai TOS Marketplace (link versionato)
  10.2 Fee marketplace (buyer/seller premium)
  10.3 Possibilità di settlement automatico tramite chain transfer

ART. 11 — LIMITI DI RESPONSABILITÀ
  11.1 No responsabilità di RareBlock per perdita di valore di mercato
       del Bene (oscillazioni di mercato, caduta del segmento collezionismo
       Pokémon, eventi di settore)
  11.2 Cap di responsabilità: la responsabilità di RareBlock per qualsiasi
       sinistro sul Bene custodito è limitata al MASSIMALE DELLA POLIZZA
       ASSICURATIVA in vigore alla data del sinistro, come da
       polizza n. {{insurance_policy_number}} rilasciata da
       {{insurance_company}} (estremi disponibili nell'allegato e
       aggiornati nei `platform_settings`)
  11.3 Eccezione di legge ex art. 1229 c.c.: il cap NON opera
       in caso di dolo o colpa grave di RareBlock o dei suoi ausiliari.
       In tali casi la responsabilità è piena nei limiti del valore
       di perizia indipendente del Bene.
  11.4 Esclusioni assolute: caso fortuito, forza maggiore non
       assicurabili, atti di guerra, terrorismo, eventi nucleari

ART. 12 — RISERVATEZZA E DATI PERSONALI

ART. 13 — COMUNICAZIONI

ART. 14 — LEGGE APPLICABILE E FORO

ART. 15 — FIRMA ELETTRONICA AVANZATA

ALLEGATI
  A — Scheda tecnica del Bene (foto, grading, certificato)
  B — Estratto polizza assicurativa
  C — Modulo recesso consumatore
  D — Tariffe custodia oltre periodo gratuito
  E — Privacy & Informativa FEA
  F — TOS Marketplace (per rivendita)
```

### 3.3 Differenze chiave Modalità B (comproprietà)

Sostituire art. 2 e 4 con:

```
ART. 2bis — OGGETTO: ACQUISTO DI QUOTA INDIVISA
  L'Acquirente acquista N quote indivise (su un totale di T) del Bene.
  Le quote rappresentano una percentuale di comproprietà ex art. 1100 c.c.
  Tutti i comproprietari sono titolari di diritti reali sul medesimo Bene.

ART. 4bis — TRASFERIMENTO E AMMINISTRAZIONE
  4bis.1 Acquisto della quota al pagamento
  4bis.2 Mandato a RareBlock per amministrazione e custodia in nome
         e per conto della comunione (artt. 1105-1106 c.c.)
  4bis.3 Decisioni straordinarie (vendita del Bene intero):
         maggioranza qualificata da definire
  4bis.4 Diritto di prelazione tra comproprietari sulla rivendita di quote
  4bis.5 Liquidazione: alla scadenza del progetto (X anni) RareBlock
         organizza la vendita del Bene e ripartisce il ricavato
         pro-quota
```

---

## 4. ⚠️ Modalità B (Quote) — sub-decisioni necessarie prima del contratto

Hai scelto di andare **A + B al go-live** (Q1). Recepisco. Però il contratto B può essere scritto in due forme molto diverse a seconda di come strutturi il prodotto. La differenza è fra:

- **Comproprietà di bene da collezione** ex art. 1100 c.c. → fuori dal perimetro CONSOB
- **OICR / Strumento finanziario partecipativo** → dentro il perimetro TUF, serve gestore autorizzato CONSOB

Le quattro condizioni che fanno scattare la qualificazione come OICR (art. 1, lett. k, TUF + art. 4-bis Reg. UE 2011/61):

1. raccolta presso una pluralità di investitori,
2. con investimento gestito **nell'interesse degli investitori e in autonomia da essi**,
3. secondo una **politica predeterminata**,
4. con **promessa o aspettativa di rendimento**.

**Devono ricorrere TUTTE E QUATTRO**. Se ne manca anche solo una, la struttura resta fuori. Le sub-decisioni B1-B5 servono a configurare il prodotto per uscire dal perimetro CONSOB. Risposte sbagliate qui mi obbligano a riscrivere il contratto B come "informazione su strumento finanziario non autorizzato", che è una situazione di **rischio penale** (abusivismo finanziario, art. 166 TUF, fino a 8 anni).

### B1 — Comunicazione marketing del prodotto

| Opzione | Esempi di linguaggio | Rischio CONSOB |
|---|---|---|
| **B1.a — Co-titolarità di un bene da collezione** | "Diventi comproprietario di una carta Charizard PSA 10", "Quote di un bene unico", "Possedere un pezzo di storia" | 🟢 Basso |
| **B1.b — Investimento alternativo / asset class** | "Investi in collezionabili", "Asset alternativi non correlati", "Diversifica con i collectibles" | 🟡 Medio |
| **B1.c — Investimento con rendimento** | "Rendimento atteso 12-15%", "IRR target", "Plusvalenza media 8% annuo" | 🔴 Alto — quasi certamente AIF |

**Raccomandazione tecnica:** B1.a in tutti i materiali. Mai numeri di rendimento atteso esibiti come promessa o target.

### B2 — Promessa di rendimento

- [ ] **B2.** Il prodotto promette un rendimento (esplicito o implicito)?
  - **B2.a** No, nessuna promessa. Solo dichiarazione che il valore di mercato dei beni da collezione è volatile e può salire o scendere.
  - **B2.b** Sì, target di rendimento atteso non garantito.
  - **B2.c** Sì, rendimento minimo garantito.

> 🔴 Solo B2.a è compatibile con la qualificazione "comproprietà". B2.b e B2.c attivano la qualificazione (4) e portano in OICR.

### B3 — Liquidità / chi decide quando si vende il bene

- [ ] **B3.** Quando si vende il bene fisico intero (e si ripartisce il ricavato pro-quota), chi decide?
  - **B3.a** I comproprietari a maggioranza qualificata (es. ≥ 75% delle quote) tramite delibera della comunione. RareBlock esegue come amministratore senza autonomia decisionale.
  - **B3.b** RareBlock decide autonomamente sulla base di soglie di prezzo / scadenze pre-fissate nel contratto.
  - **B3.c** Esiste una scadenza forzata del progetto (es. "5 anni dall'apertura") oltre la quale RareBlock liquida obbligatoriamente.

> 🔴 Solo B3.a tiene fuori dal perimetro OICR (manca la condizione 2 "in autonomia da essi"). B3.b e B3.c configurano gestione collettiva.

### B4 — Diritto al ritiro fisico per il quotista

- [ ] **B4.** Un comproprietario può chiedere il ritiro fisico del bene?
  - **B4.a** Sì, ma solo se acquisisce le altre quote (preemption right). Cioè diventa proprietario al 100% e poi ritira.
  - **B4.b** Sì, qualsiasi comproprietario può chiedere lo scioglimento della comunione ex art. 1111 c.c. con vendita all'asta del bene tra comproprietari.
  - **B4.c** No, il ritiro fisico è escluso. Il quotista è titolare solo di un diritto patrimoniale astratto.

> 🔴 B4.c trasforma la quota in titolo astratto = strumento finanziario. Solo B4.a e B4.b sono compatibili con comproprietà ex art. 1100 c.c.

### B5 — Pubblico target

- [ ] **B5.** A chi si rivolge l'offerta delle quote?
  - **B5.a** Investitori qualificati / professionali (banche, SIM, family office, individui con patrimonio > €500k autodichiarato).
  - **B5.b** Pubblico generale (chiunque abbia un account verificato).
  - **B5.c** Club privato a numero chiuso (es. max 100 membri selezionati).

> 🟡 B5.a e B5.c godono di esenzioni dall'obbligo di prospetto (art. 100 TUF). B5.b sopra una certa soglia di raccolta (€8M in 12 mesi) richiede prospetto.

### Raccomandazione operativa

La configurazione che minimizza il rischio CONSOB per la Modalità B è:
- **B1.a + B2.a + B3.a + B4.a (o B4.b) + B5.c (o B5.a)**

Questo permette di scrivere un contratto pulito di **comproprietà di bene da collezione + mandato di amministrazione e custodia ex artt. 1100-1106 c.c.**, senza dover toccare il TUF.

Se anche solo uno tra B2.b/c, B3.b/c, B4.c viene scelto, **mi fermo e ti dico chiaramente che il contratto B non lo posso scrivere senza un parere legale di un avvocato regolamentare CONSOB** — non è competenza tecnica di un assistente di sviluppo, è materia da Studio Legale specializzato.

### Configurazione ADOTTATA

L'utente ha selezionato la **configurazione safe completa**:

| Sub-decisione | Scelta | Effetto giuridico |
|---|---|---|
| **B1.a** | Co-titolarità di un bene da collezione | No qualificazione "investimento" |
| **B2.a** | Nessuna promessa di rendimento | Manca condizione (4) per OICR |
| **B3.a** | Liquidazione = maggioranza qualificata comproprietari | Manca condizione (2) "in autonomia da essi" |
| **B4.a** | Preemption right (presunto, in conferma) | Comproprietà ex art. 1100, exit ordinata |
| **B5.c** | Club privato a numero chiuso | Esenzione obbligo prospetto art. 100 TUF |
| **B6** | Questionario light 3 spunte (in conferma) | Documenta consapevolezza del quotista |

Il contratto B `BUYER_FRACTIONAL_CUSTODY_V1` può quindi essere scritto come:

> **"Compravendita di quota indivisa di bene da collezione ex art. 1100 c.c. + mandato di amministrazione e custodia alla società RareBlock ex artt. 1105-1106 c.c."**

Senza richiedere autorizzazioni CONSOB, registrazione AIF, gestore autorizzato, o prospetto. La **revisione legale** del testo finale resta comunque obbligatoria prima del go-live.

### Clausole specifiche del contratto B (in aggiunta allo skeleton §3.3)

```
ART. 4ter — PATTO DI COMUNIONE
  4ter.1 Maggioranza qualificata per atti di straordinaria amministrazione
         e per la vendita del Bene intero: 75% del valore complessivo
         delle quote (non delle teste — riferimento ex art. 1108 c.c.)
  4ter.2 Atti di ordinaria amministrazione (custodia, assicurazione,
         manutenzione): delegati a RareBlock come amministratore
  4ter.3 Convocazione assemblea dei comproprietari: via piattaforma
         con preavviso 15 giorni, possibilità di voto digitale
  4ter.4 RareBlock NON ha diritto di voto, agisce solo come gestore esecutore
         delle delibere della comunione

ART. 6ter — DIRITTO DI PRELAZIONE E RITIRO FISICO (B4.a)
  6ter.1 Diritto di prelazione: ogni comproprietario ha diritto
         di prelazione sull'acquisto delle quote messe in vendita
         da altri comproprietari, in proporzione alle quote possedute
  6ter.2 Esercizio della prelazione: 30 giorni dalla notifica
         della messa in vendita su marketplace
  6ter.3 Ritiro fisico del Bene: consentito solo al comproprietario
         che acquisisce il 100% delle quote (consolidamento totale).
         A consolidamento avvenuto, applica art. 6 contratto Modalità A
  6ter.4 Scioglimento volontario della comunione: ammesso solo con
         delibera al 75% delle quote (art. 4ter.1)

ART. 5ter — KYC AGGRAVATO PER QUOTE (B6)
  5ter.1 L'Acquirente di quote deve sottoscrivere autocertificazione
         di consapevolezza con tre dichiarazioni espresse:
         (a) "Comprendo che acquisto una co-titolarità di un bene
              da collezione, non un prodotto finanziario"
         (b) "Accetto la volatilità del valore di mercato del Bene"
         (c) "Accetto l'illiquidità della mia quota, esigibile solo
              tramite marketplace P2P o consolidamento totale"
  5ter.2 La sottoscrizione è registrata nel `kyc_quote_acknowledgments`
         con timestamp e legata al contratto B specifico

ART. 12ter — AMMISSIONE AL CLUB (B5.c)
  12ter.1 L'accesso alla Modalità B è riservato ai membri del Club RareBlock
  12ter.2 Criteri di ammissione: definiti unilateralmente da RareBlock,
          basati su patrimonio dichiarato e/o invito di membro esistente
  12ter.3 RareBlock può rifiutare l'ammissione senza motivazione
  12ter.4 Numero chiuso: limite massimo membri attivi definito
          nei platform_settings (`club_max_members`)
```

---

## 5. Firma OTP — flusso e classificazione

### 5.1 Inquadramento eIDAS

Il Reg. UE 910/2014 (eIDAS) e il CAD italiano riconoscono 4 livelli di firma elettronica:

| Tipo | Caratteristiche | Valore probatorio |
|---|---|---|
| **FES** — Semplice | Spunta su checkbox | Liberamente valutabile dal giudice |
| **FEA** — Avanzata | Identifica il firmatario, controllo esclusivo, integrità documento | Piena prova ex art. 20 CAD |
| **FEQ** — Qualificata | FEA + certificato qualificato | Massima evidenza probatoria |
| **FD** — Digitale (IT) | Variante italiana di FEQ | = FEQ |

**SMS OTP può configurare una FEA** se rispetta queste 4 condizioni (art. 26 eIDAS):

1. **Connessione univoca al firmatario** → cellulare verificato e bound al profile.
2. **Idoneità a identificare il firmatario** → KYC pregresso (documento d'identità).
3. **Controllo esclusivo del firmatario** → SIM in possesso del firmatario (presunzione iuris tantum).
4. **Collegamento al documento e rilevazione modifiche** → hash SHA-256 del PDF nel record di firma.

Per i contratti che ci interessano (vendor mandate, sale, custody) la **FEA via SMS OTP è sufficiente**. Restano fuori dalla FEA solo: trasferimenti immobiliari, atti pubblici, alcuni testamenti — irrilevanti per noi.

### 5.2 Flusso di sottoscrizione (UX)

```
[1] Utente conclude flusso di acquisto / accetta proposta vendor
     ↓
[2] Sistema verifica: KYC L2 completato? Telefono verificato?
    Se NO → flow di completamento KYC obbligatorio
     ↓
[3] Sistema genera bozza PDF pre-compilata con anagrafica + dati operazione
     ↓
[4] Utente vede preview PDF (download disponibile)
     ↓
[5] Checkbox obbligatorie:
     • "Ho letto e compreso le condizioni del contratto"
     • "Accetto l'Informativa Firma Elettronica Avanzata"
     • "Acconsento al trattamento dati per esecuzione contratto"
     ↓
[6] Click "Firma con OTP"
     ↓
[7] Sistema invia SMS al cellulare verificato:
     "RareBlock — Codice firma contratto RB-VND-2026-NNNNNN: 482917
      Valido 5 minuti. Non condividere con nessuno."
     ↓
[8] Modal con 6 input numerici per OTP, countdown 5:00,
    pulsante "Reinvia" disabilitato per 60s
     ↓
[9] Validazione OTP server-side:
    - confronto bcrypt
    - check expires_at, attempts < 3
    - se ok: marca otp_codes.consumed_at, procede
     ↓
[10] Sistema genera PDF FINALE:
     - PDF originale +
     - Pagina di firma con:
        • Nome firmatario, CF, data nascita
        • Cellulare (mascherato: +39 *** *** 1234)
        • Timestamp UTC firma
        • IP e User-Agent del firmatario
        • Hash SHA-256 del documento contratto (senza pagina firma)
        • OTP transaction ID (NON il codice OTP)
        • Numero contratto univoco
        • Riferimento normativo: "Firma Elettronica Avanzata
           ex art. 26 Reg. UE 910/2014"
     ↓
[11] PDF finale firmato:
     - upload Supabase Storage privato (bucket "contracts")
     - SHA-256 finale → contracts.pdf_sha256
     - opzionale: ancoraggio on-chain (notarizzazione)
     ↓
[12] Email di conferma all'utente con PDF allegato
     Email di notifica admin con link al record
     ↓
[13] Stato contratto: status='signed', signed_at=now()
```

### 5.3 Sicurezza & rate-limit

- OTP: 6 cifre numeriche generate con CSPRNG, salvate **solo come bcrypt hash**
- TTL: 5 minuti
- Max 3 tentativi per OTP, poi invalida
- Max 5 OTP/ora per utente (anti-flood)
- Max 10 OTP/giorno per numero (anti-abuse)
- Rate limit per IP: 20 OTP/giorno
- Lockout temporaneo di 15 minuti dopo 5 fallimenti consecutivi
- Logging completo in `otp_codes` per audit

### 5.4 Provider messaggistica — Twilio + WhatsApp Business

Decisione Q9: **Twilio Programmable Messaging** con canale primario **WhatsApp Business via Meta**, fallback automatico SMS.

**Architettura a due canali con fallback automatico:**

```
[Sistema] genera OTP
     ↓
[Twilio Channels API] tenta canale primario WhatsApp
     ↓
   ┌─delivery confermata entro 60s? ─┐
   │                                 │
   sì                                no
   │                                 │
   ✅ flow normale            [Twilio fallback]
                              invio SMS allo stesso numero
                                 ↓
                              ✅ flow normale
```

**Vantaggi del modello combinato:**
- WhatsApp: costo ~€0.005/msg, conferma di lettura, deep link cliccabile
- SMS: copertura universale anche per chi non ha WhatsApp
- Stesso provider (Twilio) → un'unica configurazione, billing unificato, audit log unificato
- Fallback automatico → no degrado UX se WhatsApp fallisce

**Setup richiesto:**
1. **Account Twilio** con un Messaging Service e un numero italiano dedicato
2. **WhatsApp Business Account (WABA)** registrato presso Meta
3. **Sender WhatsApp** linkato al numero Twilio (verifica Meta ~24h)
4. **Template di messaggio approvati Meta** in categoria *AUTHENTICATION*:
   - Template OTP firma contratto
   - Template OTP verifica iniziale telefono
   - I template OTP devono rispettare regole Meta: codice in evidenza, no link esterni, no frasi promo
5. **Sender alfanumerico SMS fallback** = "RareBlock"

**Stima costi anno 1** (200 utenti × 4 firme + verifiche iniziali = ~1.000 messaggi):
- WhatsApp delivery rate atteso ~85% × 1.000 × €0.005 = €4.25
- SMS fallback rate ~15% × 1.000 × €0.075 = €11.25
- **Totale anno 1: ~€15-20** (vs solo SMS €75)

**Esempio template WhatsApp OTP:**
```
🔐 RareBlock — Firma contratto
Il tuo codice di firma per il contratto {{1}} è:

*{{2}}*

Valido 5 minuti. Non condividere con nessuno.
```

**Sicurezza & rate-limit:** stessi limiti del §5.3 indipendentemente dal canale (le 5 OTP/ora si contano sullo user, non sul canale).

### 5.5 Notarizzazione on-chain del PDF firmato (Q10 — inclusa al go-live)

Sfrutta l'infrastruttura `chain_certificates` + wallet custodial Base mainnet già operativa.

**Cosa si ancora on-chain:**
- SHA-256 del PDF firmato finale
- Numero contratto (`RB-VND-...` / `RB-BUY-...`)
- Timestamp UTC della firma
- Identificativo utente (hash keccak256, non in chiaro per GDPR)

**Implementazione:**
- Nuovo smart contract `RareBlockContractRegistry` su Base mainnet (chain_id 8453), pattern **storage-only** (no logic, no admin, immutable)
- Funzione `notarize(bytes32 docHash, string contractNumber, bytes32 userIdHash)` callable solo dal wallet operativo RareBlock (signer custodial)
- Evento `ContractNotarized(bytes32 indexed docHash, string contractNumber, uint256 timestamp)` — visibile su BaseScan
- Costo per notarizzazione: ~€0.001-0.005 (Base ha gas economici)

**Audit trail completo per ogni contratto:**
```json
{
  "contract_id": "uuid",
  "pdf_signed_sha256": "0x...",
  "chain_id": 8453,
  "tx_hash": "0x...",
  "block_number": 123456,
  "block_timestamp": 1714824000,
  "basescan_url": "https://basescan.org/tx/0x..."
}
```

**Verifica pubblica:** la pagina di firma del PDF include un QR che punta a `https://www.rareblock.eu/verify/{contract_number}` e mostra: hash del documento, link BaseScan, parti coinvolte (con dati pseudonimizzati).

**Vantaggio probatorio:** anche un decennio dopo, chiunque può verificare matematicamente che quel PDF esisteva e non è stato alterato. Combinato con la FEA via OTP, è un livello di garanzia **superiore** a una FEA standard senza notarizzazione.

**Modifica al flusso di firma §5.2:** lo step [11] ora include come substep:
- 11.a → upload PDF firmato in Storage
- 11.b → calcolo SHA-256
- 11.c → chiamata `notarize()` on-chain (asincrona, non blocca conferma utente)
- 11.d → salvataggio tx_hash in `contracts.signature_audit.notarization`

---

## 6. Architettura tecnica

### 6.1 Schema DB — nuove tabelle (additive, non breaking)

```sql
-- Migration 033_kyc_anagrafica.sql
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS first_name TEXT,
  ADD COLUMN IF NOT EXISTS last_name TEXT,
  ADD COLUMN IF NOT EXISTS birth_date DATE,
  ADD COLUMN IF NOT EXISTS birth_place TEXT,
  ADD COLUMN IF NOT EXISTS birth_country CHAR(2) DEFAULT 'IT',
  ADD COLUMN IF NOT EXISTS nationality CHAR(2) DEFAULT 'IT',
  ADD COLUMN IF NOT EXISTS fiscal_code TEXT,
  ADD COLUMN IF NOT EXISTS id_doc_type TEXT
    CHECK (id_doc_type IN ('CI','PATENTE','PASSAPORTO')),
  ADD COLUMN IF NOT EXISTS id_doc_number TEXT,
  ADD COLUMN IF NOT EXISTS id_doc_issuer TEXT,
  ADD COLUMN IF NOT EXISTS id_doc_issue_date DATE,
  ADD COLUMN IF NOT EXISTS id_doc_expiry_date DATE,
  ADD COLUMN IF NOT EXISTS id_doc_front_path TEXT,   -- Storage path
  ADD COLUMN IF NOT EXISTS id_doc_back_path TEXT,
  ADD COLUMN IF NOT EXISTS res_address TEXT,
  ADD COLUMN IF NOT EXISTS res_civic TEXT,
  ADD COLUMN IF NOT EXISTS res_zip TEXT,
  ADD COLUMN IF NOT EXISTS res_city TEXT,
  ADD COLUMN IF NOT EXISTS res_province TEXT,
  ADD COLUMN IF NOT EXISTS res_country CHAR(2) DEFAULT 'IT',
  ADD COLUMN IF NOT EXISTS phone_country_code TEXT DEFAULT '+39',
  ADD COLUMN IF NOT EXISTS phone_e164 TEXT,
  ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pep_self BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS pep_relative BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS pep_details TEXT,
  ADD COLUMN IF NOT EXISTS source_of_funds TEXT,
  ADD COLUMN IF NOT EXISTS source_of_funds_notes TEXT,
  ADD COLUMN IF NOT EXISTS kyc_level INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS kyc_status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS kyc_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS kyc_reviewer_id UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS gdpr_privacy_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gdpr_tos_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gdpr_marketing_accepted BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS gdpr_profiling_accepted BOOLEAN DEFAULT false;

-- gdpr_consent_log come per art. 5(2) GDPR
CREATE TABLE IF NOT EXISTS gdpr_consent_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  consent_key TEXT NOT NULL,
  old_value JSONB,
  new_value JSONB,
  ip INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Migration 034_otp.sql
CREATE TABLE IF NOT EXISTS otp_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  phone_e164 TEXT NOT NULL,
  code_hash TEXT NOT NULL,                   -- bcrypt
  purpose TEXT NOT NULL
    CHECK (purpose IN ('phone_verify','contract_sign','critical_action')),
  context_id UUID,                            -- es. contract_id
  attempts INT DEFAULT 0,
  max_attempts INT DEFAULT 3,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  ip INET,
  user_agent TEXT,
  sms_provider TEXT,
  sms_provider_message_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON otp_codes (user_id, purpose, created_at DESC);
CREATE INDEX ON otp_codes (phone_e164, created_at DESC);

-- Migration 035_contracts.sql
CREATE TABLE IF NOT EXISTS contract_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL,                  -- 'VENDOR_MANDATE'
  version INT NOT NULL,
  title TEXT NOT NULL,
  body_md TEXT NOT NULL,
  privacy_doc_md TEXT,
  fea_doc_md TEXT,
  is_active BOOLEAN DEFAULT true,
  effective_from TIMESTAMPTZ DEFAULT now(),
  legal_review_by TEXT,
  legal_review_date DATE,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (code, version)
);

CREATE SEQUENCE IF NOT EXISTS contract_number_seq START 1;

CREATE TABLE IF NOT EXISTS contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_number TEXT UNIQUE NOT NULL,        -- RB-VND-2026-000001
  template_id UUID REFERENCES contract_templates(id),
  template_code TEXT NOT NULL,
  template_version INT NOT NULL,

  -- Parti
  party_user_id UUID REFERENCES auth.users(id),
  party_snapshot JSONB NOT NULL,               -- anagrafica congelata
  counterparty_snapshot JSONB NOT NULL,        -- dati RareBlock al momento

  -- Oggetto
  subject_type TEXT NOT NULL
    CHECK (subject_type IN
      ('vendor_mandate','buyer_purchase_custody','buyer_fractional')),
  subject_data JSONB NOT NULL,                 -- product_id, prices, ...

  -- Documento
  pdf_unsigned_path TEXT,                       -- bozza
  pdf_signed_path TEXT,                         -- firmato
  pdf_unsigned_sha256 TEXT,
  pdf_signed_sha256 TEXT,

  -- Firma
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','pending_signature','signed','rejected','expired','revoked')),
  signed_at TIMESTAMPTZ,
  signature_method TEXT,                        -- 'sms_otp_fea'
  signature_audit JSONB,                        -- IP, UA, otp_id, ts, ...

  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT,

  created_at TIMESTAMPTZ DEFAULT now(),
  created_by UUID REFERENCES auth.users(id)
);

CREATE INDEX ON contracts (party_user_id, status);
CREATE INDEX ON contracts (subject_type, status);

-- Migration 036_pricing_settings.sql
-- Parametri piattaforma: commissione, custodia, dati societari, polizza
CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'general',  -- 'commercial'|'company'|'insurance'|'legal'
  is_sensitive BOOLEAN DEFAULT false,         -- dati confidenziali (es. dettagli polizza)
  updated_at TIMESTAMPTZ DEFAULT now(),
  updated_by UUID REFERENCES auth.users(id)
);

-- Audit trail dei cambiamenti settings (per ricostruzione storica
-- dei dati congelati nei contratti)
CREATE TABLE IF NOT EXISTS platform_settings_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL,
  old_value JSONB,
  new_value JSONB NOT NULL,
  changed_at TIMESTAMPTZ DEFAULT now(),
  changed_by UUID REFERENCES auth.users(id),
  change_reason TEXT
);

CREATE INDEX ON platform_settings_history (key, changed_at DESC);

-- Trigger automatico per popolare lo storico
CREATE OR REPLACE FUNCTION log_platform_settings_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.value IS DISTINCT FROM NEW.value THEN
    INSERT INTO platform_settings_history (key, old_value, new_value, changed_by)
    VALUES (NEW.key, OLD.value, NEW.value, NEW.updated_by);
  ELSIF TG_OP = 'INSERT' THEN
    INSERT INTO platform_settings_history (key, old_value, new_value, changed_by)
    VALUES (NEW.key, NULL, NEW.value, NEW.updated_by);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_platform_settings_history ON platform_settings;
CREATE TRIGGER trg_platform_settings_history
  AFTER INSERT OR UPDATE ON platform_settings
  FOR EACH ROW EXECUTE FUNCTION log_platform_settings_change();

-- ── SEED INIZIALE DEI PARAMETRI ────────────────────────────────────────

-- 1) Parametri commerciali
INSERT INTO platform_settings (key, value, description, category) VALUES
  ('default_vendor_commission_pct', '15.0', 'Commissione default RareBlock al vendor', 'commercial'),
  ('contract_offer_validity_days', '7', 'Validità della bozza contratto in giorni', 'commercial'),
  ('custody_payment_grace_days', '60', 'Giorni di tolleranza prima di vendita coatta per insoluto custodia', 'commercial')
ON CONFLICT (key) DO NOTHING;

-- 2) Dati societari RareBlock (Q11 — modificabili da admin)
INSERT INTO platform_settings (key, value, description, category) VALUES
  ('company_legal_name',     '"DA COMPILARE"',  'Ragione sociale completa di RareBlock', 'company'),
  ('company_legal_form',     '"DA COMPILARE"',  'Forma giuridica (SRL, SPA, ...)', 'company'),
  ('company_vat',            '"DA COMPILARE"',  'Partita IVA', 'company'),
  ('company_fiscal_code',    '"DA COMPILARE"',  'Codice fiscale società', 'company'),
  ('company_rea',            '"DA COMPILARE"',  'Numero REA', 'company'),
  ('company_chamber',        '"DA COMPILARE"',  'CCIAA di iscrizione', 'company'),
  ('company_capital',        '"DA COMPILARE"',  'Capitale sociale i.v.', 'company'),
  ('company_pec',            '"DA COMPILARE"',  'Indirizzo PEC', 'company'),
  ('company_office_address', '{"street":"","civic":"","zip":"","city":"","province":"","country":"IT"}', 'Sede legale', 'company'),
  ('company_email',          '"info@rareblock.eu"', 'Email contatti commerciali', 'company'),
  ('company_phone',          '"DA COMPILARE"',  'Telefono contatti', 'company'),
  ('legal_rep_name',         '"DA COMPILARE"',  'Nome legale rappresentante', 'company'),
  ('legal_rep_fiscal_code',  '"DA COMPILARE"',  'CF legale rappresentante', 'company'),
  ('legal_rep_role',         '"Amministratore Unico"', 'Ruolo del LR', 'company'),
  ('foro_competente',        '"Tribunale di Messina"', 'Foro per controversie B2B', 'legal')
ON CONFLICT (key) DO NOTHING;

-- 3) Dati polizza assicurativa (Q15 — modificabili da admin, sensibili)
INSERT INTO platform_settings (key, value, description, category, is_sensitive) VALUES
  ('insurance_company',       '"DA COMPILARE"', 'Compagnia assicuratrice', 'insurance', true),
  ('insurance_policy_number', '"DA COMPILARE"', 'Numero di polizza', 'insurance', true),
  ('insurance_policy_type',   '"All Risks da collezione"', 'Tipologia polizza', 'insurance', true),
  ('insurance_max_per_item',  '"DA COMPILARE"', 'Massimale per singolo oggetto (EUR)', 'insurance', true),
  ('insurance_max_aggregate', '"DA COMPILARE"', 'Massimale aggregato annuo (EUR)', 'insurance', true),
  ('insurance_deductible',    '"DA COMPILARE"', 'Franchigia (EUR o %)', 'insurance', true),
  ('insurance_coverage_start','"DA COMPILARE"', 'Decorrenza copertura', 'insurance', true),
  ('insurance_coverage_end',  '"DA COMPILARE"', 'Scadenza polizza', 'insurance', true),
  ('insurance_exclusions',    '"Forza maggiore non assicurabile, atti di guerra, terrorismo, eventi nucleari"', 'Esclusioni di polizza', 'insurance', true)
ON CONFLICT (key) DO NOTHING;

-- 4) RLS: solo admin può scrivere, lettura limitata per dati non sensitive
ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_settings_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS settings_admin_all ON platform_settings;
CREATE POLICY settings_admin_all ON platform_settings
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id=auth.uid() AND role='admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id=auth.uid() AND role='admin'));

DROP POLICY IF EXISTS settings_public_read ON platform_settings;
CREATE POLICY settings_public_read ON platform_settings
  FOR SELECT TO authenticated
  USING (NOT is_sensitive);

DROP POLICY IF EXISTS settings_history_admin ON platform_settings_history;
CREATE POLICY settings_history_admin ON platform_settings_history
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id=auth.uid() AND role='admin'));

-- ── TARIFFARIO CUSTODIA ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS custody_fee_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,           -- 'card_raw' | 'card_slab' | 'box_small' | ...
  display_name TEXT NOT NULL,
  description TEXT,
  size_category TEXT NOT NULL,         -- 'card' | 'sealed' | 'display'
  max_dimensions_cm TEXT,              -- '10x7x0.5' indicativo
  annual_fee_cents BIGINT NOT NULL,    -- es. 1200 = €12.00/anno
  insurance_max_eur BIGINT,            -- massimale assicurato per oggetto in tier
  is_active BOOLEAN DEFAULT true,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO custody_fee_tiers (code, display_name, size_category, max_dimensions_cm,
                                annual_fee_cents, insurance_max_eur, sort_order) VALUES
  ('card_raw',    'Carta singola (no slab)',   'card',    '9x6x0.1',     600,    500,  1),
  ('card_slab',   'Carta gradata (slab PSA/CGC)','card',  '12x8x1.5',   1200,   5000,  2),
  ('booster_pack','Booster pack sigillato',    'sealed',  '12x8x1',     1500,   3000,  3),
  ('etb',         'Elite Trainer Box',         'sealed',  '30x20x10',   3600,   2000,  4),
  ('box_small',   'Box piccolo (es. 36 pack)', 'sealed',  '35x25x12',   4800,   5000,  5),
  ('box_medium',  'Box medio (case 6 box)',    'sealed',  '50x35x25',   8400,  20000,  6),
  ('case_large',  'Case grande (12+ box)',     'sealed',  '60x40x30',  14400,  50000,  7),
  ('display',     'Display vintage da esposizione','display','custom',  24000, 100000,  8)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE custody_fee_tiers ENABLE ROW LEVEL SECURITY;
CREATE POLICY tiers_read ON custody_fee_tiers FOR SELECT TO authenticated USING (true);
CREATE POLICY tiers_admin ON custody_fee_tiers FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id=auth.uid() AND role='admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id=auth.uid() AND role='admin'));

-- ── OVERRIDE PER PRODOTTO ──────────────────────────────────────────────
ALTER TABLE inv_products
  ADD COLUMN IF NOT EXISTS custody_tier_code TEXT REFERENCES custody_fee_tiers(code),
  ADD COLUMN IF NOT EXISTS custody_fee_override_cents BIGINT,
  ADD COLUMN IF NOT EXISTS custody_fee_notes TEXT,
  ADD COLUMN IF NOT EXISTS commission_pct_override NUMERIC(5,2);

-- View helper: pricing effettivo per prodotto (cascata override)
CREATE OR REPLACE VIEW v_product_pricing AS
SELECT
  p.id AS product_id,
  p.name,
  p.vendor_id,
  COALESCE(
    p.commission_pct_override,
    v.commission_pct,
    (SELECT (value::TEXT)::NUMERIC FROM platform_settings WHERE key='default_vendor_commission_pct')
  ) AS effective_commission_pct,
  p.custody_tier_code,
  COALESCE(
    p.custody_fee_override_cents,
    t.annual_fee_cents
  ) AS effective_custody_fee_cents,
  t.display_name AS custody_tier_name
FROM inv_products p
LEFT JOIN inv_vendors v ON v.id = p.vendor_id
LEFT JOIN custody_fee_tiers t ON t.code = p.custody_tier_code;

GRANT SELECT ON v_product_pricing TO authenticated;

-- Migration 037_club_and_quote_kyc.sql (per Modalità B)
-- Membership al club privato chiuso (B5.c)
CREATE TABLE IF NOT EXISTS club_membership (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','active','suspended','revoked')),
  invited_by UUID REFERENCES auth.users(id),
  admission_notes TEXT,                     -- note admin sui criteri di ammissione
  net_worth_band TEXT,                      -- '<500k' | '500k-1M' | '1M-5M' | '5M+'
  admitted_at TIMESTAMPTZ,
  admitted_by UUID REFERENCES auth.users(id),
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON club_membership (status);

ALTER TABLE club_membership ENABLE ROW LEVEL SECURITY;
CREATE POLICY club_self_read ON club_membership FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY club_admin_all ON club_membership FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id=auth.uid() AND role='admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id=auth.uid() AND role='admin'));

-- Setting per cap massimo membri (modificabile da admin)
INSERT INTO platform_settings (key, value, description, category) VALUES
  ('club_max_members', '100', 'Numero massimo membri attivi del Club RareBlock', 'commercial')
ON CONFLICT (key) DO NOTHING;

-- Helper: posti disponibili
CREATE OR REPLACE FUNCTION club_seats_available()
RETURNS INT LANGUAGE sql STABLE AS $$
  SELECT GREATEST(0,
    (SELECT (value::TEXT)::INT FROM platform_settings WHERE key='club_max_members')
    - (SELECT COUNT(*) FROM club_membership WHERE status='active')
  );
$$;

-- KYC acknowledgments per quote (B6 — 3 spunte obbligatorie)
CREATE TABLE IF NOT EXISTS kyc_quote_acknowledgments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contract_id UUID REFERENCES contracts(id),  -- legato al contratto B specifico
  ack_co_titolarita BOOLEAN NOT NULL,
  ack_volatilita BOOLEAN NOT NULL,
  ack_illiquidita BOOLEAN NOT NULL,
  ack_text_version INT NOT NULL,              -- versione del testo dichiarazione
  signed_at TIMESTAMPTZ DEFAULT now(),
  ip INET,
  user_agent TEXT,
  CONSTRAINT all_three_required
    CHECK (ack_co_titolarita AND ack_volatilita AND ack_illiquidita)
);

CREATE INDEX ON kyc_quote_acknowledgments (user_id, signed_at DESC);

ALTER TABLE kyc_quote_acknowledgments ENABLE ROW LEVEL SECURITY;
CREATE POLICY ack_self ON kyc_quote_acknowledgments FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY ack_admin ON kyc_quote_acknowledgments FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id=auth.uid() AND role='admin'));
-- Insert solo via Edge Function autenticata, no UPDATE/DELETE per integrità
```

### 6.2 Edge Functions Supabase (Deno)

| Function | Scopo |
|---|---|
| `kyc-update-profile` | Update anagrafica con validazioni (CF check digit, IBAN MOD-97, IT phone format, age check) |
| `kyc-upload-id-doc` | Signed URL upload per documento d'identità (bucket privato) |
| `sms-otp-send` | Genera OTP, invia via Twilio (WhatsApp+SMS fallback), salva hash |
| `sms-otp-verify` | Verifica OTP, marca consumed |
| `contract-prepare` | Genera bozza PDF (pdf-lib) da template + dati |
| `contract-sign` | Validazione finale + appende pagina firma + storage + email |
| `contract-revoke` | Solo admin, con motivazione |

### 6.3 PDF generation

Stack: **pdf-lib** in Edge Function Deno.
- Template = Markdown → conversione `{{placeholder}}` con dati
- Layout: header con logo RareBlock (gold/cream Montserrat), corpo Inter 11pt, intestazioni Fraunces, footer con numero contratto e pagina N/M.
- Pagina firma generata programmaticamente (no template fisso).

### 6.4 Storage

Bucket privati Supabase Storage:
- `kyc-documents/` (RLS: solo proprietario + admin)
- `contracts-unsigned/` (RLS: solo proprietario + admin, TTL 7 giorni)
- `contracts-signed/` (RLS: solo proprietario + admin, retention 10 anni per AML)

---

## 7. UI/UX — punti di tocco

### 7.1 Onboarding KYC progressivo

Tre punti di entrata, no walled garden:
1. **Signup standard** → email + password + nome → L1
2. **Verifica telefono** → al primo tentativo di azione che richiede OTP
3. **KYC L2 completo** → al primo contratto da firmare (pagina "Completa il tuo profilo")

### 7.2 Pagina "Profilo & Anagrafica"

Sezioni:
- Identità (read-only dopo approvazione)
- Documento d'identità (con preview, possibilità di re-upload se in scadenza)
- Indirizzo
- Telefono (con OTP di re-verifica se cambia)
- Dati fiscali / fatturazione
- Conformità (PEP, fonte fondi)
- Consensi GDPR (toggle granulari)
- Stato KYC (livello + chip status)

### 7.3 Wizard firma contratto

Tre step laterali con progress, stessa estetica luxury del brand:
1. **Riepilogo** — anagrafica + oggetto contratto
2. **Lettura** — PDF preview + checkboxes informative
3. **Firma** — invio OTP + input + spinner conferma

### 7.4 Admin "Contratti"

In `rareblock-admin-users.html` (esistente) aggiungere tab:
- Lista contratti con filtri (tipo, stato, vendor/acquirente, periodo)
- Drill-down: vista record + audit firma + download PDF firmato
- Azioni: revoca, scarica audit pack (zip con PDF + JSON audit)
- Export AML annuale

---

## 8. Decisioni — stato attuale

### 8.1 Decisioni CHIUSE (recepite in v0.4)

**Decisioni di prodotto (Q0-Q16):** tutte chiuse — vedi v0.3.

**Sub-decisioni Modalità B (B1-B5):**

| # | Decisione | Risposta | Impatto |
|---|---|---|---|
| B1 | Comunicazione marketing | Co-titolarità di un bene da collezione | Linguaggio del contratto e del marketing |
| B2 | Promessa di rendimento | Nessuna | Manca condizione (4) per OICR |
| B3 | Liquidazione bene intero | Comproprietari a maggioranza qualificata 75% | Manca condizione (2) "in autonomia" |
| B5 | Pubblico target | Club privato a numero chiuso | Esenzione prospetto + tabella `club_membership` |

### 8.2 Decisioni APERTE (micro-conferme finali)

- [ ] **B4.** Diritto di ritiro fisico del quotista:
  - **B4.a** Preemption right (acquisto totalitario obbligato per ritiro) — *proposto come default*
  - B4.b Scioglimento ex art. 1111 c.c. unilaterale
  Conferma B4.a oppure dimmi B4.b.

- [ ] **B6.** Questionario consapevolezza per quotisti (3 spunte obbligatorie):
  - "Comprendo che si tratta di co-titolarità, non investimento finanziario"
  - "Accetto la volatilità del valore di mercato"
  - "Accetto l'illiquidità della quota"
  Conferma sì/no.

Nessun'altra decisione di prodotto rimane aperta. La revisione legale del Markdown finale dei contratti resta come step PRE-PRODUZIONE (vedi §9).

## 9. Validazione legale

L'avvocato di riferimento ha dato **via libera all'impianto** generale (decisione Q13). Distinguiamo due livelli di validazione:

| Livello | Cosa è stato validato | Cosa NON è stato validato |
|---|---|---|
| **Impianto** | ✅ Architettura giuridica (mandato + deposito + comproprietà), classificazione FEA, struttura KYC L0-L3, separazione tra contratti A e B, foro Messina con riserva consumatore | – |
| **Testi pieni** | – | ⚠️ I testi articolo per articolo dei contratti VENDOR_MANDATE_V1 e BUYER_PURCHASE_CUSTODY_V1 sono al momento in forma di SCHELETRO. La revisione articolo per articolo del Markdown completo deve essere fatta dall'avvocato come step PRE-PRODUZIONE prima del primo contratto firmato. |

**Workflow proposto:**
1. Implemento le migration e il modulo OTP (non richiede revisione legale)
2. Scrivo il Markdown completo dei due contratti come **template DRAFT** in `contract_templates` (campo `is_active=false`)
3. Genero PDF di esempio compilato con dati fittizi
4. Trasmetto i PDF all'avvocato per revisione
5. Recepisco modifiche → versione finale → `is_active=true`
6. Solo a quel punto la UI di firma diventa accessibile in produzione

La stessa procedura per il contratto Modalità B una volta chiuse B1-B5.

**Documenti aggiuntivi da redigere ex novo (Q14):**
- Privacy Policy (allegato standard, customizzato per RareBlock)
- Cookie Policy
- Informativa GDPR specifica per il trattamento contrattuale
- Informativa Firma Elettronica Avanzata (richiesta da AgID per FEA)
- Modulo recesso consumatore (allegato C contratto buyer)

Tutti questi escono dal modulo `contract_templates` con `template_code='ANNEX_PRIVACY'`, `'ANNEX_COOKIE'`, `'ANNEX_GDPR'`, `'ANNEX_FEA'`, `'ANNEX_RECESS_FORM'`. Anche questi necessitano revisione avvocato.

---

## 10. Sequenza di delivery proposta

Aggiornata sulla base delle decisioni 0-16. Le PR1-PR3 NON dipendono dalle B1-B5 e possono partire subito; PR5-PR6 includono solo Modalità A finché B non è chiuso.

| PR | Contenuto | Dipendenze | Stima sessioni |
|---|---|---|---|
| **PR1** | Migration 033 (KYC anagrafica) + 034 (OTP) + 036 (settings + custody tiers + dati societari + polizza) + RLS + view | Nessuna | 1 |
| **PR2** | Edge functions `sms-otp-send` e `sms-otp-verify` con Twilio Programmable Messaging configurato per WhatsApp + fallback SMS. Setup Meta WABA template AUTHENTICATION | Twilio account + Meta WABA approval (~24-72h Meta) | 1 |
| **PR3** | Pannello admin "Settings": gestione `platform_settings` (dati societari, polizza, parametri commerciali) + `custody_fee_tiers` + audit history. Tab in `rareblock-admin-users.html` | PR1 | 1 |
| **PR4** | `rareblock-contracts.html` — area utente "Profilo & KYC L2": compilazione anagrafica completa, upload documento d'identità, verifica telefono via OTP. Validazioni client+server (CF check digit, IBAN MOD-97, age check, expiry doc) | PR1 + PR2 | 2 |
| **PR5** | Smart contract `RareBlockContractRegistry` deploy su Base + Edge function `contract-notarize` + UI verifica pubblica `/verify/:contract_number` | PR1 | 1 |
| **PR6** | Migration 035 (contracts) + Edge functions `contract-prepare` (genera PDF) e `contract-sign` (valida OTP + appende firma + notarizza + email). Caricamento template DRAFT `VENDOR_MANDATE_V1` e `BUYER_PURCHASE_CUSTODY_V1` con Markdown completo da sottoporre all'avvocato | PR1+2+3+4+5 | 2 |
| **PR7** | UI wizard firma in `rareblock-contracts.html`: riepilogo → preview PDF → checkboxes → invio OTP → input → conferma + email | PR6 | 1 |
| **PR8** | Tab "Contratti" in admin: lista, filtri, audit pack, revoca, export AML | PR6 | 1 |
| **PR9** | Modalità B (contratto fractional) — solo dopo chiusura B1-B5 e revisione legale dedicata | PR6 + decisioni B + parere legale | TBD |

**Totale fase A (PR1-PR8): ~10 sessioni**.
**Modalità B (PR9): da pianificare dopo le decisioni B1-B5.**

Prima di andare in produzione con le firme: PR6 produce template DRAFT non attivi → genero PDF di esempio → revisione avvocato → recepisco → attivo template → vado live.

---

**Fine documento — design CHIUSO al netto di:**
- Conferma B4 (preemption vs scioglimento) e B6 (questionario consapevolezza) — micro
- Approvazione di partenza con PR1

Il design è considerato sufficientemente stabile per iniziare l'implementazione di PR1, PR2 e PR3 (che non dipendono dai dettagli B4/B6).
