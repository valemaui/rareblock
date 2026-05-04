-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Modulo Contratti — PR6 #4/4
--  Migration 040: seed dei template DRAFT
--
--  Carica nel DB i due template Markdown completi:
--    1. VENDOR_MANDATE_V1            (mandato a vendere con custodia)
--    2. BUYER_PURCHASE_CUSTODY_V1    (compravendita + deposito)
--
--  Entrambi caricati con is_active=false → NON USABILI in produzione
--  finché un admin (o un legale) non li attiva manualmente dal pannello
--  o via:
--     UPDATE contract_templates SET is_active=true
--     WHERE code='VENDOR_MANDATE' AND version=1;
--
--  Procedura raccomandata:
--    1. Applicare questa migration
--    2. Generare PDF di esempio con dati fittizi (POST /contract-prepare
--       da un account test) per visualizzare come appaiono i template
--    3. Trasmettere i PDF all'avvocato per revisione articolo per articolo
--    4. Recepire le modifiche → INSERT nuova versione (version=2)
--    5. Attivare la versione finale
--
--  NB: ogni testo va validato dall'avvocato. I template qui sono BOZZE
--  tecniche dell'impianto giuridico approvato (mandato + deposito,
--  comproprietà, foro Messina con riserva consumatore, FEA via SMS OTP).
-- ═══════════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════════
--  1) VENDOR_MANDATE_V1 — Mandato a vendere con custodia
-- ══════════════════════════════════════════════════════════════════════
INSERT INTO public.contract_templates (
  code, version, title, description, body_md, fea_doc_md, privacy_doc_md, is_active
) VALUES (
  'VENDOR_MANDATE',
  1,
  'Mandato a vendere senza rappresentanza con custodia',
  'Vendor mandate template v1 (DRAFT) — richiede revisione legale prima dell''attivazione.',
$VENDOR_MD$
# CONTRATTO DI MANDATO A VENDERE SENZA RAPPRESENTANZA CON CUSTODIA

**Numero contratto:** {{contract.number}}
**Data:** {{contract.date_it}}

---

## TRA

**{{counterparty.company_legal_name}}** ({{counterparty.company_legal_form}}), con sede legale in {{counterparty_address_full}}, P.IVA {{counterparty.company_vat}}, C.F. {{counterparty.company_fiscal_code}}, iscritta al REA di {{counterparty.company_chamber}} al n. {{counterparty.company_rea}}, capitale sociale {{counterparty.company_capital}}, PEC {{counterparty.company_pec}}, in persona del legale rappresentante {{counterparty.legal_rep_name}} ({{counterparty.legal_rep_role}}), C.F. {{counterparty.legal_rep_fiscal_code}} — di seguito "**RareBlock**" o la "**Mandataria**" —

## E

**{{party.full_name}}**, nato il {{party.birth_date}} a {{party.birth_place}} ({{party.birth_country}}), C.F. {{party.fiscal_code}}, residente in {{party_address_full}}, documento di identità {{party.id_doc_type}} n. {{party.id_doc_number}} rilasciato da {{party.id_doc_issuer}} il {{party.id_doc_issue_date}} con scadenza {{party.id_doc_expiry_date}}, email {{party.email}}, cellulare {{party.phone_e164}} — di seguito il "**Vendor**" o il "**Mandante**" —

congiuntamente le "**Parti**".

---

## PREMESSE

a) RareBlock gestisce una piattaforma di intermediazione e custodia di beni da collezione (carte Pokémon e prodotti correlati), riservata a una community selezionata di collezionisti e investitori privati.

b) Il Vendor è proprietario di uno o più beni elencati in **Allegato A** (di seguito i "**Beni**") e intende avvalersi della piattaforma RareBlock per metterli in vendita, conferendo a RareBlock mandato senza rappresentanza ex artt. 1703 ss. c.c. e affidandoli in custodia ex artt. 1766 ss. c.c.

c) Le Parti hanno compreso che la presente sottoscrizione avviene mediante Firma Elettronica Avanzata ai sensi dell'art. 26 Reg. UE 910/2014 e dell'art. 20 D.Lgs. 82/2005, identificata tramite OTP inviato sul cellulare verificato del Vendor.

Tutto ciò premesso, le Parti convengono e stipulano quanto segue.

---

## ART. 1 — DEFINIZIONI

- **Bene/i**: ciascun oggetto da collezione descritto in Allegato A.
- **Piattaforma**: il sito web e i servizi online erogati da RareBlock.
- **Custodia**: la conservazione fisica dei Beni nel caveau di RareBlock.
- **Prezzo di Riserva**: il prezzo minimo concordato per la vendita di ciascun Bene.
- **Commissione**: la percentuale spettante a RareBlock sul prezzo lordo di vendita.
- **Acquirente**: il terzo che acquista uno o più Beni tramite la Piattaforma.

---

## ART. 2 — OGGETTO

Il Vendor conferisce a RareBlock, che accetta, mandato senza rappresentanza a vendere i Beni elencati in Allegato A, in nome di RareBlock e per conto del Vendor, alle condizioni economiche e tecniche del presente contratto.

---

## ART. 3 — CONSEGNA E CUSTODIA

3.1 Il Vendor consegna a RareBlock i Beni mediante spedizione assicurata a propria cura e spese, all'indirizzo indicato dalla Mandataria.

3.2 RareBlock effettua, alla presa in consegna, una verifica fotografica documentata e una valutazione preliminare delle condizioni dei Beni. Le risultanze sono comunicate al Vendor entro **5 giorni lavorativi**.

3.3 I Beni sono custoditi presso il caveau certificato di {{counterparty.insurance_caveau_address}}, in condizioni controllate di temperatura, umidità e sicurezza fisica e antincendio.

3.4 La custodia ha durata indeterminata fino alla vendita o al ritiro dei Beni da parte del Vendor.

---

## ART. 4 — AUTENTICAZIONE E GRADING

4.1 RareBlock si riserva il diritto, a propria discrezione, di sottoporre ciascun Bene a procedure di autenticazione interna e/o a grading professionale presso enti terzi (PSA, CGC, Beckett o equivalenti).

4.2 **I costi del grading sono interamente a carico di RareBlock**, quale investimento sulla qualità del catalogo della Piattaforma.

4.3 RareBlock si riserva il diritto di rifiutare il Bene laddove esso risulti non autentico, ovvero la sua condizione effettiva risulti significativamente difforme dalla dichiarazione del Vendor: in tal caso, il Bene è restituito al Vendor a sue spese di spedizione.

---

## ART. 5 — ESCLUSIVITÀ E CONDIZIONI DI VENDITA

5.1 Il Vendor garantisce a RareBlock l'**esclusiva** sui Beni per la durata del presente mandato. Il Vendor si impegna a non offrire i Beni in vendita altrove (siti web, marketplace, social, contatti privati) per tutto il periodo del mandato, salvo previa risoluzione dello stesso.

5.2 Il Prezzo di Riserva di ciascun Bene è indicato in Allegato A ed è concordato tra le Parti. Modifiche del Prezzo di Riserva richiedono accordo scritto, anche via email registrata.

5.3 RareBlock può promuovere i Beni mediante prezzo fisso, asta, drop a tempo o altre modalità tecniche disponibili sulla Piattaforma, sempre nel rispetto del Prezzo di Riserva.

---

## ART. 6 — COMMISSIONE E SPESE

6.1 Sul prezzo lordo di vendita di ciascun Bene, RareBlock trattiene una **Commissione** pari alla percentuale concordata e indicata in Allegato A. La Commissione applicata viene congelata nel presente contratto al momento della firma e non è modificabile retroattivamente.

6.2 Spese vive a carico di **RareBlock**: grading (vedi art. 4), foto professionali, fee del marketplace lato venditore, costi del Payment Service Provider sul lato seller.

6.3 Spese vive a carico del **Vendor**: spedizione di consegna iniziale a RareBlock, eventuale spedizione di ritorno in caso di ritiro del Bene non venduto.

---

## ART. 7 — INCASSO E PAGAMENTO AL VENDOR

7.1 RareBlock incassa il prezzo di vendita direttamente dall'Acquirente, per conto del Vendor.

7.2 Il pagamento al Vendor del prezzo netto (prezzo lordo meno Commissione e meno eventuali spese imputabili al Vendor ex art. 6.3) è effettuato entro **15 giorni di calendario** dalla "vendita confermata", ove per tale si intende: ricevimento integrale del pagamento dall'Acquirente E decorrenza del termine di diritto di recesso ex art. 52 c. cons. ove applicabile.

7.3 Il pagamento è effettuato mediante bonifico SEPA sull'IBAN comunicato dal Vendor in fase di onboarding.

7.4 RareBlock si riserva la facoltà di trattenere temporaneamente il pagamento in caso di reclamo dell'Acquirente o di disputa sulle condizioni del Bene venduto, fino alla definizione del reclamo.

---

## ART. 8 — RISCHIO E ASSICURAZIONE

8.1 Il rischio di perimento o danneggiamento dei Beni si trasferisce in capo a RareBlock dal momento della presa in consegna fino alla riconsegna al Vendor o alla consegna all'Acquirente.

8.2 I Beni sono coperti dalla polizza n. {{counterparty.insurance_policy_number}} rilasciata da {{counterparty.insurance_company}} ({{counterparty.insurance_policy_type}}), con massimale per oggetto pari a {{counterparty.insurance_max_per_item}} EUR e massimale aggregato annuo pari a {{counterparty.insurance_max_aggregate}} EUR. Franchigia: {{counterparty.insurance_deductible}}.

8.3 Esclusioni della copertura: {{counterparty.insurance_exclusions}}.

8.4 In caso di sinistro, l'indennizzo al Vendor è pari al **minore** tra (a) il Prezzo di Riserva concordato e (b) il valore di mercato medio degli ultimi 12 mesi del Bene secondo fonti pubbliche di riferimento (Cardmarket, PriceCharting o equivalenti), entro il massimale di polizza per oggetto.

---

## ART. 9 — DICHIARAZIONI E GARANZIE DEL VENDOR

Il Vendor dichiara e garantisce sotto la propria piena responsabilità che:

a) è il legittimo proprietario dei Beni, liberi da pegni, sequestri o altre limitazioni giuridiche;

b) la provenienza dei Beni è lecita e non riconducibile a operazioni di riciclaggio o finanziamento del terrorismo (ex D.Lgs. 231/2007);

c) i Beni sono conformi alle dichiarazioni rese in Allegato A circa edizione, condizione e autenticità;

d) non sussistono vizi occulti dei Beni di cui il Vendor sia a conoscenza e non dichiarati a RareBlock;

e) il Vendor manleva RareBlock da qualsiasi pretesa di terzi che invochino diritti reali o di privativa sui Beni.

---

## ART. 10 — DIRITTI DEL VENDOR

10.1 **Ritiro del Bene non venduto**: il Vendor può chiedere in qualsiasi momento il ritiro di uno o più Beni non ancora venduti, mediante comunicazione scritta a RareBlock con preavviso di **15 giorni**. Le spese di spedizione sono a carico del Vendor.

10.2 **Modifica del Prezzo di Riserva**: il Vendor può proporre modifiche del Prezzo di Riserva con preavviso di **7 giorni**, e con accordo scritto di RareBlock.

10.3 **Reportistica**: il Vendor ha accesso a un report periodico sulla Piattaforma indicante visualizzazioni, offerte e stato di vendita dei propri Beni.

---

## ART. 11 — RECESSO E RISOLUZIONE

11.1 Il Vendor può recedere dal presente contratto con preavviso scritto di **30 giorni**, senza necessità di motivazione. In caso di recesso, i Beni invenduti sono restituiti al Vendor a sue spese di spedizione.

11.2 RareBlock può risolvere il contratto per inadempimento del Vendor (autenticità non confermata, descrizione gravemente difforme, dichiarazioni mendaci di provenienza, mancato rispetto dell'esclusiva ex art. 5.1) con effetto immediato, fatti salvi i diritti al risarcimento dei danni.

---

## ART. 12 — RISERVATEZZA

Le Parti si impegnano a mantenere riservate le informazioni economiche, tecniche e commerciali scambiate nell'esecuzione del presente contratto, con la sola eccezione delle informazioni necessariamente comunicate agli Acquirenti e alle autorità competenti.

---

## ART. 13 — TRATTAMENTO DEI DATI PERSONALI

I dati personali del Vendor sono trattati da RareBlock ai sensi del Reg. UE 2016/679 (GDPR) e del D.Lgs. 196/2003 e ss.mm.ii. La base giuridica del trattamento è l'esecuzione del presente contratto e l'adempimento degli obblighi di legge (D.Lgs. 231/2007). L'informativa completa è riportata in Allegato B.

---

## ART. 14 — COMUNICAZIONI

Tutte le comunicazioni tra le Parti relative al presente contratto sono validamente effettuate via email all'indirizzo {{party.email}} (per il Vendor) e {{counterparty.company_email}} (per RareBlock), o tramite la PEC ove disponibile per il Vendor.

---

## ART. 15 — DURATA

Il presente contratto entra in vigore alla data di sottoscrizione e ha durata indeterminata, salvo recesso o risoluzione ex art. 11.

---

## ART. 16 — LEGGE APPLICABILE E FORO COMPETENTE

16.1 Il presente contratto è regolato dalla {{counterparty.legge_applicabile}}.

16.2 Per ogni controversia derivante o connessa al presente contratto è competente in via esclusiva il **{{counterparty.foro_competente}}**.

16.3 Eccezione: qualora il Vendor sia qualificabile come consumatore ai sensi dell'art. 3 D.Lgs. 206/2005 (persona fisica che agisce per scopi estranei all'attività imprenditoriale, commerciale, artigianale o professionale), trova applicazione il foro inderogabile di residenza o domicilio elettivo del Vendor ex art. 33, comma 2, lett. u) c. cons.

---

## ART. 17 — FIRMA ELETTRONICA AVANZATA

17.1 Le Parti dichiarano espressamente di accettare la sottoscrizione del presente contratto mediante Firma Elettronica Avanzata ai sensi dell'art. 26 Reg. UE 910/2014 e dell'art. 20 D.Lgs. 82/2005.

17.2 La firma del Vendor è validata mediante OTP monouso inviato al cellulare verificato {{party.phone_e164}}, e legata al documento mediante hash crittografico SHA-256.

17.3 Il documento firmato è inoltre ancorato on-chain sulla blockchain Base, garantendo timestamp certo e immutabilità del contenuto. La verifica pubblica è disponibile all'URL stampato sulla pagina di firma.

17.4 Le Parti riconoscono al presente contratto, sottoscritto in tale modalità, piena efficacia probatoria ex art. 20 D.Lgs. 82/2005.

---

**Letto, compreso e sottoscritto.**

Il Vendor, **{{party.full_name}}**, sottoscrive con Firma Elettronica Avanzata.

Per RareBlock, **{{counterparty.legal_rep_name}}** ({{counterparty.legal_rep_role}}).

---

### ALLEGATI

- **Allegato A**: Lista dei Beni con foto, condizione, prezzo di riserva, commissione applicata
- **Allegato B**: Informativa Privacy (Reg. UE 2016/679)
- **Allegato C**: Informativa Firma Elettronica Avanzata (eIDAS)

$VENDOR_MD$,

-- FEA doc allegato
$FEA_VENDOR$
# INFORMATIVA SULLA FIRMA ELETTRONICA AVANZATA

Ai sensi dell'art. 57 Regole Tecniche AgID e degli artt. 26-28 Reg. UE 910/2014.

## Cos'è la Firma Elettronica Avanzata

La Firma Elettronica Avanzata (FEA) è una firma elettronica che soddisfa quattro requisiti tecnici:

1. **Connessione univoca al firmatario**: identificata mediante cellulare verificato precedentemente attraverso procedura KYC documentata.
2. **Idoneità all'identificazione**: il firmatario è stato identificato attraverso documento d'identità valido caricato in piattaforma.
3. **Controllo esclusivo**: l'OTP è inviato al cellulare in possesso esclusivo del firmatario, in regime di presunzione iuris tantum.
4. **Collegamento al documento**: l'hash SHA-256 del documento è registrato all'atto della firma e qualsiasi modifica successiva è matematicamente rilevabile.

## Modalità tecnica adottata

Al momento della firma RareBlock invia un codice OTP a 6 cifre al numero di cellulare verificato del firmatario, tramite SMS o WhatsApp Business. Il firmatario inserisce il codice nella piattaforma; il sistema verifica timing-safe la corrispondenza con l'hash bcrypt del codice generato e accerta che il codice non sia scaduto né già consumato.

A seguito della verifica positiva, il documento PDF viene completato con la pagina di firma contenente i dati tecnici (timestamp UTC, IP, hash documento, transaction ID OTP) e l'hash finale SHA-256 viene ancorato on-chain sulla blockchain Base mainnet, fornendo timestamp certo e immutabile.

## Valore probatorio

Ai sensi dell'art. 20 D.Lgs. 82/2005 (CAD), il documento informatico sottoscritto con FEA "soddisfa il requisito della forma scritta" e ha "l'efficacia probatoria di cui all'art. 2702 del codice civile" — fa cioè piena prova fino a querela di falso.

## Diritti del firmatario

Il firmatario può in ogni momento:
- Richiedere copia del documento firmato;
- Verificare l'integrità del documento attraverso la pagina pubblica /verify;
- Revocare il consenso alla FEA per i contratti futuri (i contratti già firmati restano validi).

## Conservazione

I documenti firmati sono conservati per **10 anni** in archivio digitale sicuro, conformemente agli obblighi AML/231.

## Contatti

Per qualsiasi domanda relativa alla FEA: {{counterparty.company_email}} / {{counterparty.company_pec}}.

$FEA_VENDOR$,

-- Privacy doc
$PRIV_VENDOR$
# INFORMATIVA PRIVACY (REG. UE 2016/679)

## Titolare del trattamento

{{counterparty.company_legal_name}}, P.IVA {{counterparty.company_vat}}, sede legale {{counterparty_address_full}}, PEC {{counterparty.company_pec}}.

## Finalità e basi giuridiche

I dati personali del Vendor sono trattati per:

a) **Esecuzione del contratto** ex art. 6, par. 1, lett. b) GDPR — gestione del mandato, custodia dei Beni, vendita, pagamento del corrispettivo;

b) **Adempimento di obblighi di legge** ex art. 6, par. 1, lett. c) GDPR — fatturazione, antiriciclaggio (D.Lgs. 231/2007), conservazione documentale fiscale e amministrativa;

c) **Legittimo interesse** ex art. 6, par. 1, lett. f) GDPR — sicurezza della piattaforma, prevenzione frodi, miglioramento del servizio.

## Categorie di dati trattati

Anagrafici (nome, cognome, data e luogo di nascita), di contatto (email, telefono, indirizzo), identificativi (codice fiscale, documento d'identità), bancari (IBAN per i payout), tecnici (IP, log di accesso), commerciali (storico vendite).

## Comunicazione e trasferimento

I dati possono essere comunicati a:
- Compagnia assicurativa per la gestione di eventuali sinistri;
- Istituti di pagamento per l'esecuzione dei trasferimenti;
- Autorità competenti su richiesta (UIF, GdF, magistratura);
- Fornitori tecnici (hosting, comunicazioni elettroniche) operanti come responsabili del trattamento.

I dati non sono trasferiti fuori dallo Spazio Economico Europeo se non in presenza di adeguate garanzie ai sensi degli artt. 44 ss. GDPR.

## Conservazione

I dati sono conservati per la durata del rapporto contrattuale e per **10 anni** dalla cessazione, in coerenza con gli obblighi AML/231 e i termini prescrizionali ordinari.

## Diritti dell'interessato

Il Vendor ha diritto, ai sensi degli artt. 15-22 GDPR, a: accesso, rettifica, cancellazione (nei limiti degli obblighi di legge), limitazione del trattamento, portabilità, opposizione. Per esercitare tali diritti: {{counterparty.company_email}}.

Ha inoltre diritto a proporre reclamo al Garante per la protezione dei dati personali (www.garanteprivacy.it).

$PRIV_VENDOR$,

  false  -- is_active = false → DRAFT
)
ON CONFLICT (code, version) DO NOTHING;


-- ══════════════════════════════════════════════════════════════════════
--  2) BUYER_PURCHASE_CUSTODY_V1 — Compravendita con custodia
-- ══════════════════════════════════════════════════════════════════════
INSERT INTO public.contract_templates (
  code, version, title, description, body_md, fea_doc_md, privacy_doc_md, recess_form_md, is_active
) VALUES (
  'BUYER_PURCHASE_CUSTODY',
  1,
  'Compravendita di bene da collezione con custodia',
  'Buyer purchase + custody template v1 (DRAFT) — richiede revisione legale prima dell''attivazione.',

$BUYER_MD$
# CONTRATTO DI COMPRAVENDITA DI BENE DA COLLEZIONE CON CUSTODIA

**Numero contratto:** {{contract.number}}
**Data:** {{contract.date_it}}

---

## TRA

**{{counterparty.company_legal_name}}** ({{counterparty.company_legal_form}}), con sede legale in {{counterparty_address_full}}, P.IVA {{counterparty.company_vat}}, C.F. {{counterparty.company_fiscal_code}}, iscritta al REA di {{counterparty.company_chamber}} al n. {{counterparty.company_rea}}, capitale sociale {{counterparty.company_capital}}, PEC {{counterparty.company_pec}}, in persona del legale rappresentante {{counterparty.legal_rep_name}} ({{counterparty.legal_rep_role}}), C.F. {{counterparty.legal_rep_fiscal_code}} — di seguito "**RareBlock**" o il "**Venditore**" —

## E

**{{party.full_name}}**, nato il {{party.birth_date}} a {{party.birth_place}} ({{party.birth_country}}), C.F. {{party.fiscal_code}}, residente in {{party_address_full}}, documento di identità {{party.id_doc_type}} n. {{party.id_doc_number}} rilasciato da {{party.id_doc_issuer}} il {{party.id_doc_issue_date}} con scadenza {{party.id_doc_expiry_date}}, email {{party.email}}, cellulare {{party.phone_e164}} — di seguito l'"**Acquirente**" —

congiuntamente le "**Parti**".

---

## PREMESSE

a) RareBlock è titolare e/o ha mandato a vendere il bene da collezione descritto in Allegato A (di seguito il "**Bene**").

b) L'Acquirente ha esaminato la scheda tecnica e le foto del Bene, ha valutato la sua condizione, l'eventuale grading di terza parte, la storia delle valutazioni e ha deciso di procedere all'acquisto a termini del presente contratto.

c) L'Acquirente intende mantenere il Bene in custodia presso il caveau di RareBlock, anziché ricevere consegna fisica immediata, per le ragioni di sicurezza, conservazione e liquidità di rivendita illustrate nella Piattaforma.

Tutto ciò premesso, le Parti convengono e stipulano quanto segue.

---

## ART. 1 — DEFINIZIONI

- **Bene**: l'oggetto da collezione descritto in Allegato A.
- **Custodia**: la conservazione fisica del Bene nel caveau di RareBlock dopo la compravendita.
- **Certificato Digitale**: la registrazione on-chain (blockchain Base) del titolo di proprietà.
- **Marketplace**: la piattaforma di rivendita peer-to-peer di RareBlock.

---

## ART. 2 — OGGETTO DELLA COMPRAVENDITA

2.1 RareBlock vende all'Acquirente, che acquista, il Bene descritto in Allegato A.

2.2 La descrizione del Bene comprende: nome, edizione, set, numero, condizione e/o grading (con numero di certificato), foto allegate, eventuale Certificato Digitale RareBlock con riferimento on-chain.

---

## ART. 3 — PREZZO E PAGAMENTO

3.1 Il prezzo di acquisto del Bene è pari a {{subject.amount_eur}} EUR (di seguito il "**Prezzo**"), comprensivo di eventuale buyer's premium calcolato secondo il metodo di pagamento prescelto.

3.2 Il pagamento è effettuato in unica soluzione mediante uno dei metodi disponibili sulla Piattaforma: bonifico SEPA, carta di credito (Stripe), PayPal.

3.3 Le commissioni del metodo di pagamento sono indicate trasparentemente nel checkout e si intendono note e accettate dall'Acquirente.

---

## ART. 4 — TRASFERIMENTO DELLA PROPRIETÀ

4.1 La proprietà del Bene si trasferisce all'Acquirente al momento del ricevimento integrale del pagamento da parte di RareBlock.

4.2 A trasferimento avvenuto, RareBlock emette un Certificato Digitale a favore dell'Acquirente, con annotazione su blockchain Base (chain_id 8453, contratto e token_id riportati nel Certificato).

4.3 L'Acquirente ha facoltà di rivendere liberamente il Bene sul Marketplace di RareBlock, alle condizioni economiche del Marketplace stesso, oppure di chiederne la consegna fisica ai sensi dell'art. 6.

---

## ART. 5 — CUSTODIA

5.1 Il Bene resta in custodia presso il caveau di RareBlock, in {{counterparty.insurance_caveau_address}}, in condizioni controllate di temperatura, umidità, sicurezza fisica e antincendio.

5.2 La custodia ha durata indeterminata, salvo richiesta di ritiro dell'Acquirente.

5.3 La fee di custodia annua applicata al Bene è pari a {{subject.custody_fee_eur}} EUR/anno, in base alla fascia dimensionale del Bene ({{subject.custody_tier_name}}). La fee viene addebitata in via prepagata annuale, mediante prelievo dall'IBAN comunicato o trattenuta sul payout di un'eventuale rivendita.

5.4 In caso di insoluto della fee di custodia per oltre **{{counterparty.custody_payment_grace_days}} giorni** rispetto alla scadenza di pagamento, RareBlock ha diritto, previo invito al pagamento, di procedere alla vendita del Bene per il recupero delle spese di custodia, in analogia a quanto disposto dall'art. 1782 c.c. per il deposito oneroso.

---

## ART. 6 — DIRITTO AL RITIRO FISICO

6.1 L'Acquirente può richiedere in qualsiasi momento la consegna fisica del Bene, mediante comunicazione scritta a RareBlock.

6.2 La consegna è effettuata con spedizione assicurata, a cura di RareBlock, con costi di spedizione e assicurazione a carico dell'Acquirente.

6.3 RareBlock evade la richiesta di ritiro entro un massimo di **15 giorni lavorativi** dalla ricezione della comunicazione e del pagamento delle spese di spedizione.

6.4 A seguito della consegna fisica, il Certificato Digitale viene marcato come "redeemed" e il Bene esce dalla custodia di RareBlock.

---

## ART. 7 — RISCHIO E ASSICURAZIONE

7.1 Il rischio di perimento o danneggiamento del Bene resta in capo a RareBlock per tutto il periodo di custodia, ai sensi dell'art. 1768 c.c.

7.2 Il Bene è coperto dalla polizza n. {{counterparty.insurance_policy_number}} rilasciata da {{counterparty.insurance_company}} ({{counterparty.insurance_policy_type}}), massimale per oggetto {{counterparty.insurance_max_per_item}} EUR, massimale aggregato {{counterparty.insurance_max_aggregate}} EUR, franchigia {{counterparty.insurance_deductible}}.

7.3 In caso di sinistro, l'indennizzo all'Acquirente è pari al **maggiore** tra (a) il Prezzo pagato e (b) il valore di perizia indipendente del Bene o, in subordine, il prezzo medio di mercato degli ultimi 12 mesi su fonti pubbliche, fino a concorrenza del massimale di polizza per oggetto.

---

## ART. 8 — GARANZIE SUL BENE

8.1 RareBlock garantisce all'Acquirente:

a) **Autenticità** del Bene, certificata dal grading di terza parte (PSA/CGC/Beckett) e/o dall'audit interno di autenticazione;

b) **Conformità** del grado dichiarato e delle condizioni descritte;

c) **Titolarità piena** del diritto di vendere, libero da pegni o privative.

8.2 In caso di vizi non dichiarati e non rilevabili a un esame ragionevole, l'Acquirente ha diritto al **rimborso integrale del Prezzo** maggiorato delle spese sostenute, dietro restituzione del Bene a RareBlock.

---

## ART. 9 — DIRITTO DI RECESSO (CONSUMATORE)

9.1 Qualora l'Acquirente sia qualificabile come consumatore ai sensi dell'art. 3 D.Lgs. 206/2005, ha diritto di recedere dal presente contratto entro **14 giorni di calendario** dalla conclusione del contratto, senza necessità di motivazione, ai sensi degli artt. 52 ss. c. cons.

9.2 Il diritto di recesso si esercita mediante comunicazione scritta inviata via email a {{counterparty.company_email}} o tramite il modulo di Allegato D.

9.3 Il recesso comporta il rimborso integrale del Prezzo entro **14 giorni** dalla ricezione della comunicazione.

9.4 L'eccezione di cui all'art. 59 c. cons. (beni personalizzati o non confezionati standard) **non** si applica al presente contratto: il Bene resta in custodia e non subisce personalizzazione né disimballaggio per effetto della compravendita.

---

## ART. 10 — RIVENDITA SUL MARKETPLACE

10.1 L'Acquirente può rivendere il Bene sul Marketplace di RareBlock, accettando i termini di servizio del Marketplace pubblicati sul sito ufficiale di RareBlock e disponibili anche su richiesta a {{counterparty.company_email}}.

10.2 Le fee di marketplace (buyer's premium e seller's commission) sono trasparenti al momento della messa in vendita.

10.3 Il trasferimento di proprietà a un nuovo acquirente avviene mediante settlement automatico, con aggiornamento del Certificato Digitale on-chain.

---

## ART. 11 — LIMITI DI RESPONSABILITÀ

11.1 RareBlock non risponde della **perdita di valore di mercato** del Bene dovuta a oscillazioni di mercato, evoluzione del segmento collezionismo, eventi macroeconomici. L'Acquirente riconosce che il valore di mercato dei beni da collezione è soggetto a volatilità.

11.2 La responsabilità di RareBlock per eventuali sinistri sul Bene custodito è limitata al **massimale di polizza** in vigore alla data del sinistro (art. 7.2).

11.3 **Eccezione di legge** ex art. 1229 c.c.: il limite di cui al punto 11.2 non opera in caso di **dolo o colpa grave** di RareBlock o dei suoi ausiliari. In tali casi la responsabilità è piena, nei limiti del valore di perizia indipendente del Bene.

11.4 Esclusioni assolute: caso fortuito, forza maggiore non assicurabili, atti di guerra, terrorismo, eventi nucleari.

---

## ART. 12 — RISERVATEZZA E DATI PERSONALI

12.1 Le Parti si impegnano a mantenere riservate le informazioni economiche e tecniche scambiate.

12.2 Il trattamento dei dati personali dell'Acquirente è disciplinato dall'informativa di cui all'Allegato B.

---

## ART. 13 — COMUNICAZIONI

Le comunicazioni tra le Parti relative al presente contratto sono validamente effettuate via email all'indirizzo {{party.email}} (per l'Acquirente) e {{counterparty.company_email}} (per RareBlock).

---

## ART. 14 — LEGGE APPLICABILE E FORO COMPETENTE

14.1 Il presente contratto è regolato dalla {{counterparty.legge_applicabile}}.

14.2 Per ogni controversia derivante o connessa al presente contratto è competente in via esclusiva il **{{counterparty.foro_competente}}**.

14.3 Eccezione obbligatoria ex art. 33 c.2 lett. u) D.Lgs. 206/2005: qualora l'Acquirente sia qualificabile come consumatore, trova applicazione il **foro inderogabile di residenza o domicilio elettivo** dell'Acquirente.

---

## ART. 15 — FIRMA ELETTRONICA AVANZATA

15.1 Le Parti accettano espressamente la sottoscrizione del presente contratto mediante Firma Elettronica Avanzata ai sensi dell'art. 26 Reg. UE 910/2014 e dell'art. 20 D.Lgs. 82/2005.

15.2 La firma dell'Acquirente è validata mediante OTP monouso inviato al cellulare verificato {{party.phone_e164}} e legata al documento mediante hash crittografico SHA-256.

15.3 Il documento firmato è inoltre ancorato on-chain sulla blockchain Base, con verifica pubblica all'URL stampato sulla pagina di firma.

---

**Letto, compreso e sottoscritto.**

L'Acquirente, **{{party.full_name}}**, sottoscrive con Firma Elettronica Avanzata.

Per RareBlock, **{{counterparty.legal_rep_name}}** ({{counterparty.legal_rep_role}}).

---

### ALLEGATI

- **Allegato A**: Scheda tecnica del Bene (foto, grading, certificato, prezzo)
- **Allegato B**: Informativa Privacy (Reg. UE 2016/679)
- **Allegato C**: Informativa Firma Elettronica Avanzata
- **Allegato D**: Modulo recesso consumatore (artt. 52 ss. c. cons.)

$BUYER_MD$,

-- FEA doc (stessa di vendor)
$FEA_BUYER$
# INFORMATIVA SULLA FIRMA ELETTRONICA AVANZATA

Ai sensi dell'art. 57 Regole Tecniche AgID e degli artt. 26-28 Reg. UE 910/2014.

## Cos'è la Firma Elettronica Avanzata

La Firma Elettronica Avanzata (FEA) è una firma elettronica che soddisfa quattro requisiti tecnici:

1. **Connessione univoca al firmatario**: identificata mediante cellulare verificato precedentemente attraverso procedura KYC documentata.
2. **Idoneità all'identificazione**: il firmatario è stato identificato attraverso documento d'identità valido caricato in piattaforma.
3. **Controllo esclusivo**: l'OTP è inviato al cellulare in possesso esclusivo del firmatario.
4. **Collegamento al documento**: l'hash SHA-256 del documento è registrato all'atto della firma e qualsiasi modifica successiva è matematicamente rilevabile.

## Modalità tecnica adottata

Al momento della firma RareBlock invia un codice OTP a 6 cifre al numero di cellulare verificato del firmatario, tramite SMS o WhatsApp Business. Il firmatario inserisce il codice nella piattaforma; il sistema verifica timing-safe la corrispondenza con l'hash bcrypt del codice generato e accerta che il codice non sia scaduto né già consumato.

A seguito della verifica positiva, il documento PDF viene completato con la pagina di firma contenente i dati tecnici (timestamp UTC, IP, hash documento, transaction ID OTP) e l'hash finale SHA-256 viene ancorato on-chain sulla blockchain Base mainnet.

## Valore probatorio

Ai sensi dell'art. 20 D.Lgs. 82/2005 (CAD), il documento informatico sottoscritto con FEA "soddisfa il requisito della forma scritta" e ha "l'efficacia probatoria di cui all'art. 2702 del codice civile" — fa cioè piena prova fino a querela di falso.

## Conservazione

I documenti firmati sono conservati per **10 anni** in archivio digitale sicuro.

$FEA_BUYER$,

-- Privacy doc
$PRIV_BUYER$
# INFORMATIVA PRIVACY (REG. UE 2016/679)

## Titolare del trattamento

{{counterparty.company_legal_name}}, P.IVA {{counterparty.company_vat}}, sede legale {{counterparty_address_full}}, PEC {{counterparty.company_pec}}.

## Finalità e basi giuridiche

I dati personali dell'Acquirente sono trattati per:

a) **Esecuzione del contratto** ex art. 6, par. 1, lett. b) GDPR — gestione della compravendita, custodia, eventuali sinistri;

b) **Adempimento di obblighi di legge** ex art. 6, par. 1, lett. c) GDPR — fatturazione, antiriciclaggio (D.Lgs. 231/2007), conservazione documentale;

c) **Legittimo interesse** ex art. 6, par. 1, lett. f) GDPR — sicurezza della piattaforma, prevenzione frodi.

## Categorie di dati

Anagrafici, di contatto, identificativi, bancari (per i pagamenti), tecnici (IP, log di accesso), commerciali (storico acquisti).

## Conservazione

10 anni dalla cessazione del rapporto contrattuale.

## Diritti

Accesso, rettifica, cancellazione (nei limiti degli obblighi di legge), limitazione, portabilità, opposizione. Reclamo al Garante.

Contatti: {{counterparty.company_email}}.

$PRIV_BUYER$,

-- Modulo recesso (allegato D)
$RECESS$
# MODULO TIPO PER L'ESERCIZIO DEL DIRITTO DI RECESSO

(da compilare e inviare a {{counterparty.company_email}} o via PEC a {{counterparty.company_pec}} entro 14 giorni dalla conclusione del contratto)

---

Spettabile **{{counterparty.company_legal_name}}**

Il/La sottoscritto/a {{party.full_name}}, C.F. {{party.fiscal_code}}, residente in {{party_address_full}}, in relazione al contratto n. {{contract.number}} sottoscritto in data {{contract.date_it}} avente ad oggetto la compravendita del Bene ivi descritto,

**COMUNICA**

di voler esercitare il proprio diritto di recesso ai sensi degli artt. 52 ss. D.Lgs. 206/2005.

Modalità di rimborso preferita: bonifico SEPA sull'IBAN _________________

Data: _________________

Firma: _________________

---

*Il diritto di recesso è esercitabile entro 14 giorni di calendario dalla data di conclusione del contratto. Il rimborso integrale del prezzo verrà accreditato entro 14 giorni dalla ricezione della presente comunicazione.*

$RECESS$,

  false  -- is_active = false → DRAFT
)
ON CONFLICT (code, version) DO NOTHING;


-- ══════════════════════════════════════════════════════════════════════
--  3) Verifica
-- ══════════════════════════════════════════════════════════════════════
SELECT
  code,
  version,
  is_active,
  length(body_md)        AS body_len,
  length(privacy_doc_md) AS privacy_len,
  length(fea_doc_md)     AS fea_len
FROM public.contract_templates
ORDER BY code, version;

-- Per ATTIVARE i template dopo revisione legale (eseguire manualmente):
--   UPDATE public.contract_templates SET is_active=true,
--          legal_review_by='Avv. ...', legal_review_date=current_date
--   WHERE code='VENDOR_MANDATE'         AND version=1;
--   UPDATE public.contract_templates SET is_active=true,
--          legal_review_by='Avv. ...', legal_review_date=current_date
--   WHERE code='BUYER_PURCHASE_CUSTODY' AND version=1;

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 040_template_seed.sql
-- ═══════════════════════════════════════════════════════════════════════
