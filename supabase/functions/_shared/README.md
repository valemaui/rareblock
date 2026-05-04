# `_shared/` — moduli condivisi delle Edge Functions

Questa cartella contiene helper riusabili tra più Edge Functions.

## ⚠️ Note di deploy

Il modo in cui questi file vengono raccolti dipende dallo strumento di deploy:

| Strumento | Comportamento con `_shared/` |
|---|---|
| **Supabase CLI** (`supabase functions deploy <nome>`) | ✅ Include automaticamente `_shared/` nel bundle. Gli import `'../_shared/foo.ts'` funzionano. |
| **Supabase Dashboard UI** (copia-incolla del codice via web) | ❌ Bundla solo `index.ts`. Gli import a `_shared/` falliscono con `Module not found`. |

## Strategia adottata in questo progetto

Per supportare **entrambi i modi di deploy senza friction**, le Edge Functions del modulo contratti (`sms-otp-send`, `sms-otp-verify`, e tutte le successive) sono **self-contained**: gli helper sono **inlined** in cima ai rispettivi `index.ts`.

I file in questa cartella restano la **fonte canonica** degli helper. Se modifichi un helper qui, devi propagare la modifica anche nei file `index.ts` che lo usano.

Per evitare drift, ogni file `index.ts` riporta in commento di header da quale helper i blocchi sono stati copiati e ricorda di mantenerli sincronizzati.

## Come deployare le Edge Functions

### Opzione A — CLI Supabase (consigliata per dev locale)

```bash
# Una tantum: install + login
npm install -g supabase
supabase login

# Per ogni function
cd /path/to/rareblock
supabase functions deploy sms-otp-send       --project-ref rbjaaeyjeeqfpbzyavag
supabase functions deploy sms-otp-verify     --project-ref rbjaaeyjeeqfpbzyavag
```

Con la CLI gli import a `_shared/` vengono risolti automaticamente.

### Opzione B — Dashboard UI Supabase

1. Vai su Supabase Dashboard → Project → Edge Functions
2. "Create a new function" oppure clicca quella esistente
3. Incolla **l'intero contenuto** di `supabase/functions/<nome>/index.ts`
   — il file è già self-contained, non servono altri file
4. Click "Deploy"

## Helper presenti

| File | Esporta | Note |
|---|---|---|
| `paypal.ts` | client PayPal + helper CORS/json (legacy) | Usato dalle Edge Function `paypal-*`. Contiene anche `CORS` e `json` per ragioni storiche. |
| `http.ts` | `CORS`, `json`, `preflight`, `clientIp`, `userAgent` | Versione pulita dei generic HTTP helper, da preferire per nuove function. |
| `otp.ts` | `generateOtpCode`, `hashOtpForStorage`, `verifyOtpHash`, `normalizePhoneE164`, `maskPhone` | OTP a 6 cifre con SHA-256+salt, timing-safe verify. |
| `twilio.ts` | `sendOtpMessage` (dual channel WhatsApp+SMS con fallback) | Client Twilio REST con basic auth, no SDK. |

## Secrets richiesti (Edge Function level)

Vedi i commenti di header di ogni `index.ts` per la lista completa.
Sintesi:

```
SUPABASE_URL                  (auto)
SUPABASE_ANON_KEY             (auto)
SUPABASE_SERVICE_ROLE_KEY     (auto)
TWILIO_ACCOUNT_SID            (manual)
TWILIO_AUTH_TOKEN             (manual)
TWILIO_MESSAGING_SERVICE_SID  (manual, raccomandato)
TWILIO_SMS_FROM               (manual, alternativa al MessagingService)
TWILIO_WHATSAPP_FROM          (opzionale, attiva canale WA)
TWILIO_WA_TEMPLATE_OTP_SID    (opzionale, template Meta approvato)
TWILIO_WA_TEMPLATE_OTP_BODY   (opzionale, template testuale fallback)
```
