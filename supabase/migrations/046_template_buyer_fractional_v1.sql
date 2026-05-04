-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Modulo Contratti — PR9b
--  Migration 046: template BUYER_FRACTIONAL_V1
--                 Compravendita di quota di comproprietà ex art. 1100 c.c.
--                 + mandato di amministrazione e custodia ex artt. 1105-1106 c.c.
--
--  CONTESTO GIURIDICO
--  La Modalità B configura l'acquisto come compravendita di quota indivisa
--  di un bene determinato (ex art. 1100 c.c.). I sottoscrittori diventano
--  comproprietari pro-quota, con RareBlock S.r.l. nel ruolo di amministratore
--  + depositario ex artt. 1766-1782 c.c. e mandatario di vendita su trigger.
--
--  Questa configurazione è scelta DELIBERATAMENTE per stare FUORI dal
--  perimetro CONSOB/TUF (no OICR, no strumenti finanziari, no offerta al
--  pubblico di prodotti finanziari): "co-titolarità di un bene da collezione"
--  ≠ "investimento con rendimento atteso".
--
--  DECISIONI DI PRODOTTO RIFLESSE NEL TEMPLATE
--   B4    → Trigger ibrido OR (target_price OR exit_window) — Art. 8
--   B4.1  → Exit window one-shot con rinvio +N anni (subject_data.extension_years)
--   B4.2  → OR continuo (target attivo sempre) — Art. 8.2
--   B4.3  → Target immutabile (modificabile solo via voto 2/3) — Art. 8.5
--   B4.4  → Voto per quote, maggioranza qualificata 2/3 — Art. 9
--   B6    → Nessun obbligo buyback, illiquidità trasparente — Art. 11 + disclaimer
--
--  PLACEHOLDER DINAMICI USATI
--    {{counterparty.*}}                  — dati RareBlock (da platform_settings)
--    {{party.*}}                          — dati firmatario (da profiles)
--    {{subject_data.product_name}}        — nome bene determinato
--    {{subject_data.amount_eur}}          — prezzo della quota
--    {{subject_data.qty}}                 — numero quote acquistate
--    {{subject_data.total_quotes}}        — totale quote del bene
--    {{subject_data.target_price_eur}}    — target di vendita auto B4.2
--    {{subject_data.exit_window_years}}   — anni alla finestra
--    {{subject_data.extension_years}}     — anni di rinvio (default 2)
--    {{subject_data.custody_fee_eur}}     — fee annua custodia (B6 disclosure)
--    {{subject_data.custody_tier_name}}   — fascia custodia
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO public.contract_templates (
  code, version, title, description,
  body_md, fea_doc_md, privacy_doc_md, recess_form_md,
  required_placeholders,
  is_active
) VALUES (
  'BUYER_FRACTIONAL',
  1,
  'Compravendita di quota di comproprietà',
  'Acquisto di quota indivisa di bene determinato in comproprietà (Modalità B fractional). Comproprietà ex art. 1100 c.c. + amministrazione e custodia RareBlock ex artt. 1105-1106 c.c. Trigger di vendita ibrido (target price OR exit window) con voto per quote 2/3.',

  -- ── BODY MD ────────────────────────────────────────────────────────────
$BODY$
# CONTRATTO DI COMPRAVENDITA DI QUOTA DI COMPROPRIETÀ DI BENE DA COLLEZIONE

Numero contratto: {{contract.number}}
Data: {{contract.signed_date_it}}

## TRA

**{{counterparty.company_legal_name}}**, con sede legale in {{counterparty.company_address}}, Codice Fiscale e Partita IVA {{counterparty.vat_number}}, capitale sociale Euro {{counterparty.company_capital | money}}, in persona del legale rappresentante pro tempore, di seguito **"RareBlock"** o **"l'Amministratore"**;

## E

**{{party.first_name}} {{party.last_name}}**, nato/a a {{party.birth_place}} il {{party.birth_date_it}}, codice fiscale {{party.tax_code | upper}}, residente in {{party.address}}, di seguito **"l'Acquirente"** o **"il Comproprietario"**.

(RareBlock e l'Acquirente, congiuntamente, le **"Parti"**.)

---

## PREMESSE

(a) RareBlock opera una piattaforma di compravendita di quote indivise di beni da collezione di valore (di seguito i **"Beni"**), in regime di **comproprietà ex artt. 1100 e ss. c.c.**, con servizi accessori di amministrazione e custodia.

(b) Il presente contratto NON costituisce: (i) offerta di strumenti finanziari ai sensi del TUF; (ii) sollecitazione al pubblico risparmio; (iii) raccolta di fondi per attività di investimento collettivo; (iv) prodotto assicurativo o pensionistico; (v) prestito o finanziamento. La Modalità B è strutturata come compravendita civilistica con effetti reali immediati e contestuale mandato di custodia/amministrazione.

(c) L'Acquirente dichiara di essere maggiorenne, di non agire in nome o per conto di terzi, di disporre dei mezzi finanziari necessari, e di aver letto integralmente le **Informative sui Rischi** allegate.

(d) L'Acquirente dichiara altresì di aver fornito, tramite la piattaforma RareBlock, le tre acknowledgements obbligatorie di consapevolezza in tema di: illiquidità della quota, assenza di buyback obbligatorio da parte di RareBlock, possibilità di perdita totale del capitale.

---

## ARTICOLO 1 — OGGETTO

1.1 Con il presente contratto RareBlock vende e l'Acquirente acquista una quota indivisa di comproprietà del bene di seguito specificato (il **"Bene"**), ai sensi degli artt. 1100 e seguenti del Codice Civile.

1.2 **Identificazione del Bene**: {{subject_data.product_name}} (la scheda tecnica completa con foto, dati di grading e certificazione è riportata nell'Allegato A).

1.3 **Numero totale di quote in cui il Bene è frazionato**: {{subject_data.total_quotes | int}}.

1.4 **Quota acquistata dall'Acquirente con il presente atto**: {{subject_data.qty | int}} su un totale di {{subject_data.total_quotes | int}} quote.

1.5 **Prezzo totale della compravendita**: {{subject_data.amount_eur | money}} EUR.

1.6 La quota è acquistata in regime di comunione pro-quota indivisa: il Comproprietario è titolare di un diritto di proprietà sul Bene **in proporzione alla quota detenuta**, esercitabile congiuntamente con gli altri comproprietari secondo le regole del presente contratto.

---

## ARTICOLO 2 — TRASFERIMENTO DELLA PROPRIETÀ E PAGAMENTO

2.1 La proprietà della quota si trasferisce all'Acquirente al momento del pagamento integrale del prezzo, comprovato dall'incasso da parte di RareBlock e dalla relativa registrazione nel registro elettronico delle quote.

2.2 Il pagamento avviene secondo le modalità indicate dalla piattaforma (bonifico SEPA, carta di credito autorizzata, o eventuali altri canali approvati). Sono a carico dell'Acquirente eventuali commissioni del proprio istituto di pagamento.

2.3 RareBlock emette regolare quietanza/fattura ai sensi della normativa fiscale italiana entro 7 giorni dall'incasso.

---

## ARTICOLO 3 — REGISTRO ELETTRONICO DELLE QUOTE

3.1 RareBlock tiene un registro elettronico delle quote del Bene, costantemente aggiornato, contenente per ciascuna quota: (a) identificativo univoco; (b) Comproprietario titolare; (c) data di acquisto; (d) prezzo originario; (e) eventuali trasferimenti.

3.2 Il registro elettronico fa fede tra le Parti e nei confronti dei terzi, fatta salva prova contraria. RareBlock fornisce a ogni Comproprietario, su richiesta, un estratto del registro relativo alle proprie quote.

3.3 Ogni trasferimento, vincolo, o successione sulle quote deve essere notificato a RareBlock per essere annotato sul registro e produrre effetti nei confronti della comunione e dei terzi.

---

## ARTICOLO 4 — CUSTODIA E AMMINISTRAZIONE

4.1 Le Parti conferiscono a RareBlock, che accetta, **mandato di custodia e amministrazione** del Bene ai sensi degli artt. 1105-1106 c.c. e 1766 e ss. c.c.

4.2 RareBlock si obbliga a:
   (a) custodire il Bene in idoneo caveau con misure di sicurezza fisica e ambientale (controllo umidità, temperatura, illuminazione) conformi agli standard di settore per beni da collezione;
   (b) mantenere in essere una polizza assicurativa "all-risk" sul Bene per il valore di stima corrente, con massimale per singolo bene di {{counterparty.insurance_max_per_item}} EUR e massimale aggregato di {{counterparty.insurance_max_aggregate}} EUR;
   (c) effettuare ispezione fotografica periodica documentata del Bene, disponibile su richiesta del Comproprietario;
   (d) compiere gli atti di ordinaria amministrazione necessari alla conservazione del Bene.

4.3 **Fee di custodia annua**: {{subject_data.custody_fee_eur | money}} EUR (fascia: {{subject_data.custody_tier_name}}). La fee è dovuta pro-quota da ciascun Comproprietario, addebitata annualmente sulla base imponibile della quota detenuta.

4.4 In caso di insoluto della fee di custodia per oltre {{counterparty.custody_payment_grace_days}} giorni dalla scadenza, RareBlock ha diritto, previo invito al pagamento, di procedere al recupero anche mediante ritenuta sul ricavato della vendita della quota o del Bene, in analogia a quanto disposto dall'art. 1782 c.c.

---

## ARTICOLO 5 — DIRITTI E DOVERI DEI COMPROPRIETARI

5.1 Ciascun Comproprietario, in proporzione alla propria quota, partecipa:
   (a) ai diritti di godimento del Bene nei limiti del suo regime di custodia (visione fotografica documentata, partecipazione a eventi espositivi se organizzati da RareBlock);
   (b) ai vantaggi economici derivanti dalla vendita del Bene (Art. 8) o dalla cessione della propria quota sul mercato secondario (Art. 7);
   (c) ai costi di custodia, amministrazione, assicurazione, eventuali spese straordinarie deliberate ex Art. 9.

5.2 La quota è **liberamente cedibile** sul mercato secondario gestito da RareBlock secondo le condizioni di Art. 7. Nessun diritto di prelazione opera tra Comproprietari, salvo deroga espressa pattuita ad hoc.

5.3 I Comproprietari **non possono** chiedere il scioglimento della comunione ex art. 1111 c.c. con divisione in natura del Bene (essendo il Bene non divisibile) né chiederne la vendita giudiziale individuale: lo scioglimento avviene esclusivamente mediante il meccanismo di vendita previsto all'Art. 8.

---

## ARTICOLO 6 — RESPONSABILITÀ DI RAREBLOCK

6.1 RareBlock risponde dei danni al Bene secondo i normali criteri di diligenza professionale (art. 1176 c.c., 2° comma). RareBlock NON garantisce: (a) il valore di mercato del Bene; (b) la vendibilità della quota sul mercato secondario; (c) il raggiungimento del target price; (d) tempi di realizzo all'exit window.

6.2 La copertura assicurativa di Art. 4.2(b) costituisce il limite massimo del risarcimento dovuto da RareBlock in caso di perdita o danneggiamento del Bene.

6.3 RareBlock NON è in alcun caso responsabile delle oscillazioni di valore del Bene, di eventuali deprezzamenti del mercato dei beni da collezione, o di scelte d'investimento dell'Acquirente.

---

## ARTICOLO 7 — MERCATO SECONDARIO E CESSIONE DELLA QUOTA

7.1 Il Comproprietario può proporre in vendita la propria quota sul Marketplace di RareBlock, accettando i termini di servizio del Marketplace pubblicati sul sito ufficiale di RareBlock e disponibili anche su richiesta a {{counterparty.company_email}}.

7.2 Le commissioni di Marketplace (buyer's premium e seller's commission) sono trasparenti al momento della messa in vendita.

7.3 **L'Acquirente prende espressamente atto che**:
   (a) il Marketplace è un sistema di matching di domanda e offerta, non una promessa di liquidità;
   (b) la quota può rimanere invenduta per periodi anche prolungati, in funzione delle condizioni di mercato;
   (c) **RareBlock non assume alcun obbligo di buyback** della quota e non opera in alcun modo come market maker o controparte di ultima istanza;
   (d) non sussiste capitale garantito né protezione del valore investito.

7.4 Il prezzo di vendita della quota sul mercato secondario è libero ed è determinato dall'incontro tra domanda e offerta. Esso può differire significativamente, in più o in meno, dal prezzo di acquisto originario.

---

## ARTICOLO 8 — TRIGGER DI VENDITA DEL BENE (IBRIDO TARGET-EXIT)

8.1 La vendita del Bene fisico, con conseguente liquidazione di tutti i Comproprietari pro-quota, può scattare al verificarsi di uno dei due trigger seguenti, alternativamente (in OR continuo):

8.2 **Trigger A — Target Price (continuo)**:
   La vendita scatta automaticamente, senza necessità di voto, se RareBlock riceve, sul mercato istituzionale o tramite ricerca attiva di acquirenti, un'offerta di acquisto del Bene a un prezzo lordo non inferiore al **Target Price** di **{{subject_data.target_price_eur | money}} EUR**.
   Tale offerta deve essere documentata e vincolante; RareBlock effettuerà ragionevole due diligence sull'acquirente (capacità di pagamento, assenza di vincoli legali) prima di procedere.
   Il Target Price è **immutabile** e fissato al lancio del prodotto; può essere modificato esclusivamente con il voto favorevole della maggioranza qualificata dei 2/3 (sessantasei virgola sessantasette per cento) delle quote totali, secondo la procedura di Art. 9.

8.3 **Trigger B — Exit Window**:
   Decorsi **{{subject_data.exit_window_years | int}}** anni dalla data di lancio del Bene sulla piattaforma, RareBlock apre una **finestra di voto** di 60 (sessanta) giorni nella quale i Comproprietari possono deliberare la vendita del Bene.
   La vendita è approvata se, entro la chiusura della finestra, almeno il 66,67% delle quote totali ha votato favorevolmente alla vendita ("vendi"). Le quote astenute o non espresse equivalgono a voto contrario ai fini del calcolo della maggioranza qualificata.
   Se la vendita non è approvata, la decisione è rinviata di **{{subject_data.extension_years | int}}** anni, alla cui scadenza si apre una nuova finestra di voto, e così via fino a quando o (i) un voto favorevole approva la vendita, oppure (ii) si verifica il Trigger A.

8.4 In caso di Trigger A, RareBlock comunica a tutti i Comproprietari, con preavviso minimo di 7 giorni, la finalizzazione della vendita e le relative condizioni economiche. Trascorso tale termine senza opposizioni motivate (per es. dubbi sulla solvibilità dell'acquirente), la vendita è perfezionata.

8.5 In caso di Trigger B con esito favorevole, RareBlock procede alla messa in vendita del Bene secondo modalità di mercato (asta, trattativa privata, marketplace istituzionali) entro 12 mesi dalla chiusura del voto, con obbligo di realizzare il miglior prezzo ragionevolmente ottenibile alle condizioni di mercato.

---

## ARTICOLO 9 — VOTO DEI COMPROPRIETARI

9.1 Il diritto di voto è **proporzionale al numero di quote detenute** (una quota = un voto). Il voto è esercitato tramite la piattaforma RareBlock, che ne garantisce la riservatezza durante il periodo di apertura del voto e la trasparenza dell'esito a chiusura.

9.2 L'apertura della finestra di voto è notificata via e-mail e via dashboard a tutti i Comproprietari almeno 30 giorni prima della scadenza, con indicazione delle modalità di voto e dei termini.

9.3 Le decisioni che richiedono **voto a maggioranza qualificata 2/3 delle quote totali** sono:
   (a) approvazione della vendita del Bene in Trigger B (Art. 8.3);
   (b) modifica del Target Price (Art. 8.2);
   (c) sostituzione dell'Amministratore o modifica delle modalità di custodia in deviazione sostanziale dal presente contratto;
   (d) approvazione di spese straordinarie di importo superiore al 5% del valore di stima corrente del Bene.

9.4 L'esito del voto, una volta certificato, è vincolante per tutti i Comproprietari, anche per quelli che non hanno partecipato o hanno votato in senso contrario, e vincola anche i loro eventuali aventi causa.

---

## ARTICOLO 10 — DISTRIBUZIONE DEL RICAVATO DELLA VENDITA

10.1 Al perfezionamento della vendita del Bene (sia in Trigger A che B), RareBlock procede entro 30 giorni alla distribuzione del ricavato netto ai Comproprietari pro-quota, secondo le quote risultanti dal registro al momento della vendita.

10.2 Sono dedotti dal ricavato lordo:
   (a) costi di vendita (commissioni di marketplace, advisory, eventuali asta house);
   (b) eventuali fee di custodia non riscosse ex Art. 4.4;
   (c) imposte e tasse a carico della comunione, se dovute (es. plusvalenze, IVA su operazione);
   (d) eventuali compensi di RareBlock pattuiti separatamente per il successo dell'operazione (success fee), se previsti, in misura comunicata ai Comproprietari prima della vendita.

10.3 Il pagamento avviene tramite bonifico SEPA o altro canale concordato. RareBlock fornisce a ciascun Comproprietario rendiconto dettagliato della distribuzione.

---

## ARTICOLO 11 — DICHIARAZIONI DI CONSAPEVOLEZZA RAFFORZATE

11.1 L'Acquirente dichiara espressamente di aver compreso e accettato i seguenti rischi specifici della Modalità B fractional, già acknowledgeti via piattaforma in via separata:

(a) **Illiquidità della quota**: la quota acquistata può rimanere invenduta sul mercato secondario per periodi prolungati o per tutta la durata residua dell'investimento. RareBlock non garantisce alcun acquirente.

(b) **Assenza di obbligo di buyback**: RareBlock non è tenuta in alcun caso a riacquistare la quota dall'Acquirente né ad agire come controparte di ultima istanza. Il Comproprietario che voglia uscire deve trovare autonomamente un acquirente sul mercato secondario.

(c) **Possibilità di perdita totale del capitale investito**: il valore della quota e del Bene sottostante può azzerarsi; nessun capitale è garantito; le oscillazioni del mercato dei beni da collezione possono essere significative e imprevedibili.

(d) **Vincolo di durata**: l'investimento può avere durata molto lunga e indefinita, in funzione del trigger di vendita (Art. 8). L'Acquirente non può chiedere lo scioglimento individuale della comunione né la divisione in natura del Bene.

11.2 L'Acquirente conferma che la sua decisione di acquisto è frutto di una valutazione autonoma e informata, basata sulle proprie disponibilità finanziarie e tolleranza al rischio, e che NON ha fatto affidamento su alcuna promessa o stima di rendimento da parte di RareBlock.

---

## ARTICOLO 12 — DURATA E RECESSO

12.1 Il presente contratto ha durata pari alla durata della comproprietà sul Bene; cessa con la vendita del Bene (Art. 8) o con l'integrale cessione della quota a terzi (Art. 7).

12.2 **Recesso del consumatore**: l'Acquirente, qualora qualifichi come consumatore ai sensi del Codice del Consumo (D.Lgs. 206/2005), ha diritto di recesso entro 14 giorni dalla sottoscrizione, esercitabile mediante l'apposito modulo (Allegato D) o dichiarazione scritta inviata via PEC o e-mail certificata a {{counterparty.company_email}}. In caso di recesso esercitato nei termini, RareBlock restituisce il prezzo entro 14 giorni dalla ricezione, dedotti eventuali costi di custodia maturati pro-rata.

12.3 Decorsi i 14 giorni, il recesso unilaterale non è ammesso, salvo l'uscita tramite cessione della quota sul mercato secondario (Art. 7).

---

## ARTICOLO 13 — PRIVACY

13.1 I dati personali dell'Acquirente sono trattati secondo l'informativa di cui all'Allegato B, in conformità al Regolamento UE 2016/679 (GDPR) e al D.Lgs. 196/2003 e successive modificazioni.

13.2 Titolare del trattamento è {{counterparty.company_legal_name}}, contattabile all'indirizzo e-mail {{counterparty.company_email}}.

---

## ARTICOLO 14 — FORMA E FIRMA ELETTRONICA AVANZATA

14.1 Il presente contratto è stipulato in modalità telematica e sottoscritto mediante **Firma Elettronica Avanzata (FEA)** ai sensi dell'art. 26 Reg. UE 910/2014 (eIDAS) e dell'art. 20 D.Lgs. 82/2005 (Codice dell'Amministrazione Digitale), identificata mediante codice OTP inviato via SMS al cellulare verificato dell'Acquirente.

14.2 L'allegato C riporta l'informativa completa sulla FEA e sui suoi effetti giuridici.

---

## ARTICOLO 15 — LEGGE APPLICABILE E FORO COMPETENTE

15.1 Il presente contratto è regolato dalla {{counterparty.legge_applicabile}}.

15.2 Per ogni controversia derivante dal presente contratto è competente in via esclusiva il **{{counterparty.foro_competente}}**, fatta salva la competenza inderogabile del foro del consumatore ai sensi dell'art. 33, comma 2, lett. u), del D.Lgs. 206/2005, qualora applicabile.

---

## ALLEGATI
- Allegato A: Scheda tecnica del Bene (foto, grading, certificato, prezzo)
- Allegato B: Informativa Privacy (Reg. UE 2016/679)
- Allegato C: Informativa Firma Elettronica Avanzata
- Allegato D: Modulo recesso consumatore (artt. 52 ss. c. cons.)
$BODY$,

  -- ── FEA DOC MD ─────────────────────────────────────────────────────────
$FEA$
# Informativa sulla Firma Elettronica Avanzata (FEA)

## Cos'è la FEA
La Firma Elettronica Avanzata è una firma elettronica disciplinata dall'art. 26 del Regolamento UE 910/2014 (eIDAS) e dall'art. 20 del D.Lgs. 82/2005 (Codice dell'Amministrazione Digitale). È connessa univocamente al firmatario, idonea a identificarlo, creata con dati che il firmatario controlla, collegata ai dati sottoscritti in modo da consentire l'identificazione di ogni successiva modifica.

## Come funziona su RareBlock
1. Identificazione preliminare: completamento KYC livello 2 (anagrafica + documento d'identità + cellulare verificato).
2. Sottoscrizione: invio di un codice OTP monouso via SMS al cellulare verificato del firmatario.
3. Verifica del codice e applicazione della firma elettronica al documento PDF.
4. Calcolo dell'hash crittografico SHA-256 del documento firmato per garantirne l'integrità.
5. Ancoraggio dell'hash sulla blockchain pubblica Base (immutabile, time-stamped) per evidenza forense.

## Effetti giuridici
La FEA conferisce al documento sottoscritto:
- piena efficacia probatoria ex art. 2702 c.c. (scrittura privata);
- presunzione di provenienza dal firmatario;
- non disconoscibilità una volta verificata l'identificazione e l'integrità del documento.

## Conservazione
RareBlock conserva il documento firmato e i metadati di firma (timestamp, codice OTP, indirizzo IP, user agent, hash SHA-256) per il periodo previsto dalla legge e da regolamenti applicabili.

## Verifica pubblica
Il firmatario può in qualsiasi momento verificare l'autenticità del proprio documento firmato sulla pagina pubblica di verifica RareBlock, indicando il numero del contratto.

## Diritti del firmatario
Il firmatario ha diritto di:
- ricevere copia del documento firmato e dei metadati di firma;
- contestare l'autenticità della firma in caso di dubbio (es. uso non autorizzato del cellulare);
- richiedere chiarimenti sui dati conservati.
$FEA$,

  -- ── PRIVACY DOC MD ─────────────────────────────────────────────────────
$PRIVACY$
# Informativa Privacy (Reg. UE 2016/679 — GDPR)

## Titolare del trattamento
{{counterparty.company_legal_name}}, P.IVA {{counterparty.vat_number}}, sede in {{counterparty.company_address}}, e-mail {{counterparty.company_email}}.

## Dati raccolti
Anagrafici (nome, cognome, data e luogo di nascita, codice fiscale), di contatto (e-mail, cellulare), di residenza, documento d'identità, dati di pagamento, dati di transazione (acquisti, voti, cessioni di quote), dati tecnici di firma (IP, user agent, timestamp).

## Finalità e basi giuridiche
- Esecuzione del contratto e adempimenti pre-contrattuali (art. 6.1.b GDPR);
- Adempimenti di legge (antiriciclaggio D.Lgs. 231/2007, fiscale, normativa beni culturali se applicabile) (art. 6.1.c GDPR);
- Legittimo interesse del titolare per gestione interna, prevenzione frodi, sicurezza informatica (art. 6.1.f GDPR);
- Consenso per comunicazioni marketing (art. 6.1.a GDPR), revocabile in ogni momento.

## Tempi di conservazione
Per la durata del contratto + 10 anni dopo cessazione, salvo termini superiori imposti dalla legge.

## Diritti dell'interessato (artt. 15-22 GDPR)
Accesso, rettifica, cancellazione, limitazione, portabilità, opposizione, reclamo al Garante Privacy. Esercizio scrivendo a {{counterparty.company_email}}.

## Trasferimenti extra-UE
I dati sono conservati in UE su infrastrutture conformi GDPR. Eventuali trasferimenti avvengono solo con garanzie adeguate (clausole standard, decisioni di adeguatezza).

## Profilazione
Non è effettuata alcuna profilazione automatizzata che produca effetti giuridici sul firmatario.
$PRIVACY$,

  -- ── RECESS FORM MD ─────────────────────────────────────────────────────
$RECESS$
# Modulo di esercizio del diritto di recesso del consumatore

## Da inviare a
{{counterparty.company_legal_name}}
{{counterparty.company_address}}
E-mail: {{counterparty.company_email}}

---

Il/La sottoscritto/a ________________________________________________

residente in ____________________________________________________

dichiara di esercitare il proprio diritto di recesso in relazione al contratto:

**Numero contratto**: ________________________________________________

**Data sottoscrizione**: ________________________________________________

**Oggetto**: Compravendita di quota di comproprietà del bene "{{subject_data.product_name}}"

ai sensi dell'art. 52 del D.Lgs. 206/2005 (Codice del Consumo), entro il termine di 14 giorni dalla sottoscrizione.

Il sottoscritto richiede pertanto la restituzione del prezzo pagato, dedotti i costi di custodia eventualmente maturati pro-rata, sul conto corrente:

IBAN: ____________________________________________________________

Intestato a: _____________________________________________________

---

Data: ____________________

Firma: ____________________________________________________________
$RECESS$,

  ARRAY[
    'counterparty.company_legal_name', 'counterparty.company_address',
    'counterparty.vat_number', 'counterparty.company_email',
    'counterparty.company_capital', 'counterparty.insurance_max_per_item',
    'counterparty.insurance_max_aggregate', 'counterparty.custody_payment_grace_days',
    'counterparty.legge_applicabile', 'counterparty.foro_competente',
    'party.first_name', 'party.last_name', 'party.birth_place', 'party.birth_date_it',
    'party.tax_code', 'party.address',
    'subject_data.product_name', 'subject_data.amount_eur',
    'subject_data.qty', 'subject_data.total_quotes',
    'subject_data.target_price_eur', 'subject_data.exit_window_years',
    'subject_data.extension_years', 'subject_data.custody_fee_eur',
    'subject_data.custody_tier_name',
    'contract.number', 'contract.signed_date_it'
  ]::TEXT[],

  -- is_active: false (DRAFT) — l'admin attiva esplicitamente dopo revisione legale
  false
)
ON CONFLICT (code, version) DO NOTHING;

-- Verifica risultato
DO $$
DECLARE
  v_body_len    INT;
  v_privacy_len INT;
  v_fea_len     INT;
  v_recess_len  INT;
  v_active      BOOLEAN;
BEGIN
  SELECT
    length(body_md), length(privacy_doc_md),
    length(fea_doc_md), length(recess_form_md),
    is_active
  INTO v_body_len, v_privacy_len, v_fea_len, v_recess_len, v_active
  FROM public.contract_templates
  WHERE code = 'BUYER_FRACTIONAL' AND version = 1;

  IF v_body_len IS NULL THEN
    RAISE WARNING 'BUYER_FRACTIONAL_V1: template non inserito (forse già esisteva, ON CONFLICT DO NOTHING)';
  ELSE
    RAISE NOTICE 'BUYER_FRACTIONAL_V1 caricato:';
    RAISE NOTICE '  body_md      = % chars', v_body_len;
    RAISE NOTICE '  privacy_doc  = % chars', v_privacy_len;
    RAISE NOTICE '  fea_doc      = % chars', v_fea_len;
    RAISE NOTICE '  recess_form  = % chars', v_recess_len;
    RAISE NOTICE '  is_active    = %', v_active;
    RAISE NOTICE 'Per attivare in produzione (post revisione legale):';
    RAISE NOTICE '  UPDATE public.contract_templates';
    RAISE NOTICE '  SET is_active = true, legal_review_by = ''<nome avvocato>'',';
    RAISE NOTICE '      legal_review_date = CURRENT_DATE';
    RAISE NOTICE '  WHERE code = ''BUYER_FRACTIONAL'' AND version = 1;';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 046_template_buyer_fractional_v1.sql
-- ═══════════════════════════════════════════════════════════════════════
