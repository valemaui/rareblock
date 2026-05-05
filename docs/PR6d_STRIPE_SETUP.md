# PR6d — Setup operativo Stripe (runbook)

Riferimento completo per l'attivazione end-to-end di Stripe Checkout
in produzione su RareBlock. Da eseguire **manualmente** nel Dashboard
Stripe + 1 file da hostare su Aruba.

---

## Stato componenti software (già fatto)

| Componente | Status | Commit |
|---|---|---|
| Backend SQL (PR6a) | ✅ | `4362b64` |
| Edge functions create-session + webhook (PR6b) | ✅ | `78f19f4` |
| UI bottone carta + pagine ok/annullato (PR6c) | ✅ | `7459832` |
| Setup operativo (PR6d) | ⏳ | questo doc |

## Cosa fare: 4 step

### 1. Verificare che le edge functions siano deployate

Se non già fatto:
```bash
supabase functions deploy stripe-create-checkout-session
supabase functions deploy stripe-webhook
```

Oppure via Dashboard:
https://supabase.com/dashboard/project/rbjaaeyjeeqfpbzyavag/functions

Atteso: vedi le 2 funzioni con badge "ACTIVE" e ultima deploy recente.

### 2. Verificare i 3 secrets su Supabase

Dashboard → Edge Functions → Settings → Secrets:
https://supabase.com/dashboard/project/rbjaaeyjeeqfpbzyavag/functions/secrets

Devi avere:
- `STRIPE_SECRET_KEY` = `sk_test_...` o `sk_live_...`
- `STRIPE_WEBHOOK_SECRET` = `whsec_...`
- `SITE_URL` = `https://www.rareblock.eu`

> NB: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
> sono auto-iniettati da Supabase, non vanno aggiunti manualmente.

### 3. Webhook endpoint registrato su Stripe

Dashboard Stripe → Developers → Webhooks → Add endpoint:
https://dashboard.stripe.com/webhooks

- **Endpoint URL**:
  ```
  https://rbjaaeyjeeqfpbzyavag.supabase.co/functions/v1/stripe-webhook
  ```
- **Listen to**: Events on your account
- **Events**:
  - `checkout.session.completed` ✅ (essenziale)
  - `payment_intent.payment_failed` (warning logging)
  - `charge.refunded` (hook futuro per refund)

Dopo creato l'endpoint, copia il **Signing secret** (`whsec_...`) e
aggiornalo nei secrets Supabase come `STRIPE_WEBHOOK_SECRET`.

> NB: registra l'endpoint **due volte** se vuoi sia test che live mode:
> - Test mode → toggle "Test mode" ON in Dashboard
> - Live mode → toggle "Test mode" OFF
> Ogni mode ha il suo `whsec_...` distinto. Se usi test+live alla volta
> dovrai gestire 2 environment Supabase diversi (es. branch staging).

### 4. Domain verification per Apple Pay

Apple richiede verifica dominio per attivare Apple Pay sulle Checkout
Session. Senza questo step, gli utenti vedranno solo carte (no wallet).

#### 4.1 Genera il file su Stripe Dashboard

https://dashboard.stripe.com/settings/payments/apple_pay

(Toggle Test/Live in alto in base a dove vuoi attivare)

- Click "Add a new domain"
- Inserisci: `www.rareblock.eu`
- Stripe genera un file: `apple-developer-merchantid-domain-association`
  (file SENZA estensione, contiene un token JSON-like di Apple)
- Click "Download" → salva il file

#### 4.2 Hosta il file su Aruba

Il file deve essere accessibile esattamente a:
```
https://www.rareblock.eu/.well-known/apple-developer-merchantid-domain-association
```

Procedura via SSH:
```bash
ssh -p 2222 -i ~/.ssh/id_rsa e6tabwn-valentino@f3my2t5.zonef3.webhostingaruba.it

# Vai alla root del sito
cd /var/www/.../www.rareblock.eu/  # path effettivo Aruba

# Crea cartella .well-known se non esiste
mkdir -p .well-known
chmod 755 .well-known

# Upload via SCP da locale (in altra finestra terminale):
scp -P 2222 -i ~/.ssh/id_rsa \
    /percorso/locale/apple-developer-merchantid-domain-association \
    e6tabwn-valentino@f3my2t5.zonef3.webhostingaruba.it:/var/www/.../www.rareblock.eu/.well-known/

# Carica anche il .htaccess (già nel repo)
scp -P 2222 -i ~/.ssh/id_rsa \
    /home/.../rareblock/.well-known/.htaccess \
    e6tabwn-valentino@...:/var/www/.../www.rareblock.eu/.well-known/

# Verifica permessi
chmod 644 .well-known/apple-developer-merchantid-domain-association
chmod 644 .well-known/.htaccess
```

Alternativa via FTP client (FileZilla, Cyberduck):
- Crea cartella `.well-known/` nella root sito
- Upload `apple-developer-merchantid-domain-association` dentro
- Upload `.htaccess` (presente nel repo `.well-known/.htaccess`)

#### 4.3 Verifica accessibilità

Da terminale locale:
```bash
curl -i https://www.rareblock.eu/.well-known/apple-developer-merchantid-domain-association
```

Atteso:
- HTTP/2 200
- Content-Type: text/plain
- Body con stringa lunga di hex (token Apple)

Se invece vedi:
- 404 → file non hostato correttamente, ricontrolla path
- 403 → permessi sbagliati o `.htaccess` blocca → verifica che il
  `.htaccess` di .well-known sia stato caricato
- 301/302 → redirect, probabilmente Aruba sta forzando HTTPS o
  rimuovendo .well-known → contatta supporto Aruba

#### 4.4 Click "Verify" su Stripe

Torna su https://dashboard.stripe.com/settings/payments/apple_pay
- Trovi `www.rareblock.eu` con badge "Pending"
- Click "Verify"
- Stripe contatta Apple, Apple verifica entro pochi secondi
- Badge diventa "Verified" ✅

#### 4.5 Ripeti per `rareblock.eu` (no www)

Se vuoi che Apple Pay funzioni anche da `rareblock.eu` senza www:
- Aggiungi quel dominio su Stripe come secondo
- Hosta il file (Stripe genera un token diverso!) sotto
  `https://rareblock.eu/.well-known/...`

## Test E2E completo (post setup)

### Test mode (sandbox)

1. Hard refresh dashboard
2. Acquista prodotto
3. Step 3 → Carta → Procedi al pagamento
4. Su Stripe checkout: vedi opzione **Apple Pay** se sei su Safari/iOS,
   o **Google Pay** se sei su Chrome con Google Pay configurato
5. Carta test: `4242 4242 4242 4242`, CVV qualsiasi, scadenza futura
6. Pay → redirect a `/pagamento-ok.html`
7. Verifica DB:
   ```sql
   SELECT order_number, status, stripe_method_type,
          stripe_card_brand, stripe_card_last4, stripe_environment
   FROM inv_orders ORDER BY created_at DESC LIMIT 1;
   ```
   Atteso: `status='payment_received'`, `stripe_environment='test'`,
   `stripe_method_type='card'` (o `apple_pay`/`google_pay` se hai testato wallet)

### Test mode con carte specifiche

Stripe fornisce carte test per scenari diversi:
- `4242 4242 4242 4242` — carta valida (success)
- `4000 0000 0000 9995` — declined insufficient funds
- `4000 0000 0000 0341` — attached but charge fails (test webhook failure)
- `4000 0027 6000 3184` — 3D Secure authentication required

Vedi: https://stripe.com/docs/testing#cards

### Verifica webhook log su Stripe

Dashboard → Developers → Webhooks → click endpoint → tab "Events":
- Vedi gli eventi ricevuti dal nostro webhook
- Stato: 200 = OK, 4xx/5xx = errore (se 5xx Stripe ri-invia)
- Click un evento per vedere request/response payload

### Verifica eventi nel nostro DB

```sql
SELECT stripe_event_id, event_type, processed,
       processing_error, livemode, received_at
FROM inv_stripe_events
ORDER BY received_at DESC LIMIT 10;
```

Tutti dovrebbero avere `processed=true` e `processing_error IS NULL`.
Se ci sono errori, `processing_error` ti dice cosa è andato storto
(tipicamente: amount mismatch, order not found, RPC error).

## Passaggio in Live mode (produzione)

Quando hai testato e tutto funziona:

1. Toggle **Live mode** su Stripe Dashboard
2. Apikeys → copia la nuova `sk_live_...`
3. Aggiorna `STRIPE_SECRET_KEY` su Supabase secrets con la live key
4. Webhook → registra di nuovo l'endpoint (in live mode è separato)
5. Copia il nuovo `whsec_...` e aggiorna `STRIPE_WEBHOOK_SECRET`
6. Apple Pay domain verification → ripeti in live mode
7. Test con carta vera (e refunda subito) per verificare flow live

> ATTENZIONE: in live mode ogni transazione è REALE. Se testi con
> tua carta personale, fai immediatamente refund dal Dashboard Stripe
> (o dalla pagina Payment Intent → "Refund").

## Troubleshooting

### "Pagamento non avviato: Sessione non valida"

Click su "Procedi al pagamento" ma errore in pannello.
- Causa probabile: JWT scaduto o mancante
- Fix: logout/login dell'utente

### "amount mismatch" nel webhook

Webhook arriva ma RPC `mark_order_stripe_paid` solleva exception.
- Causa: il totale ordine è cambiato tra creazione session e completamento
- Fix: investiga in `inv_orders.total` vs `stripe_amount_received`,
  dovrebbero coincidere ±1 cent

### "Apple Pay" non appare su Stripe Checkout

- Verifica che il dominio sia "Verified" su Stripe Dashboard
- Verifica che stai testando su Safari (Apple Pay funziona solo lì)
- Verifica che hai una carta in Wallet su quel device

### "Google Pay" non appare

- Verifica che stai testando su Chrome
- Verifica che hai Google Pay configurato sul browser/account
- Test mode: Google Pay funziona solo se hai modalità sviluppatore
  attiva o sei in test environment Stripe — vedi docs Stripe.

## Documentazione di riferimento

- Stripe Checkout: https://stripe.com/docs/payments/checkout
- Apple Pay setup: https://stripe.com/docs/apple-pay
- Webhook signing: https://stripe.com/docs/webhooks/signatures
- Test cards: https://stripe.com/docs/testing
