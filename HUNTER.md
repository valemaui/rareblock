# 🎯 RareBlock Hunter

Feature di scouting inserzioni multi-portale per investitori TCG.

## Cosa fa

1. **Monitora** carte target configurate dall'utente (nome, numero, grading, 1st Ed, shadowless, lingua)
2. **Genera URL pre-compilati** per eBay, Catawiki, Subito, Vinted, TCGPlayer, Delver, Mercari
3. **Raccoglie listing** tramite userscript `rareblock-hunter-scraper.user.js` (multi-dominio)
4. **Calcola Deal Score 0-100** che combina: sconto vs CM, timing asta, reputazione venditore, match attributi
5. **Invia alert** configurabili (push, email, WhatsApp, Telegram) con regole per utente
6. **Report aggregati** giornalieri/orari via digest

## Architettura

```
Browser userscript  →  POST /functions/v1/hunt-ingest  →  hunt_listings
  (eBay/Subito/...)         (auth JWT utente)                   ↓
                                                        matchTarget
                                                                ↓
                                                        calcDealScore
                                                                ↓
                                                        hunt_alert_rules
                                                                ↓
                                                  Resend / Telegram / Twilio
                                                                ↓
                                                        hunt_alert_log
```

## Schema (migration `007_hunter_schema.sql`)

| Tabella | Scopo |
|---|---|
| `hunt_targets` | carte monitorate con attributi e soglie |
| `hunt_listings` | inserzioni raccolte con deal_score |
| `hunt_alert_rules` | regole utente (quando notificare) |
| `hunt_channel_config` | email/WA/TG/push per utente |
| `hunt_alert_log` | storico invii |
| `hunt_scarcity_daily` | snapshot giornaliero PSA pop + listing per target |
| `hunt_feed` (view) | feed ordinato per deal_score |

## Setup operativo

### 1. Esegui migration
```bash
# Nel Supabase SQL Editor
# cat supabase/migrations/007_hunter_schema.sql
```

### 2. Deploy edge function
```bash
supabase functions deploy hunt-ingest
```

### 3. Configura secrets (nel dashboard Supabase)
```
RESEND_API_KEY          # per email
TELEGRAM_BOT_TOKEN      # per Telegram (crea bot con @BotFather)
```

Canali notifica disponibili: **push browser**, **email**, **Telegram**.
WhatsApp rimosso (setup Meta troppo oneroso per questa use case).

### 4. Installa userscript
Apri `rareblock-hunter-scraper.user.js` in Tampermonkey/Violentmonkey.

### 5. Login nell'app
Il JWT viene salvato come `rbJWT` in localStorage — il userscript lo legge e autentica le POST.

## Deal Score

| Range | Colore bordo | Significato |
|---|---|---|
| 80-100 | Rosso | 🔥 HOT deal (sotto 35%+ vs CM, o asta senza offerte) |
| 60-79  | Arancio | Ottima opportunità |
| 40-59  | Giallo | Da valutare |
| 0-39   | Grigio | Prezzo nella norma |

### Componenti dello score

- **50 pt max** — sconto vs `ref_price_cm`
- **25 pt max** — asta in scadenza (senza offerte = peso max)
- **10 pt max** — reputazione venditore (rating ≥99 + feedback ≥1000)
- **15 pt max** — match attributi target (grader, grade, 1st edition)

## Innovazioni vs competitor

1. **Multi-portale integrato**: nessuna tool TCG attuale aggrega eBay + Subito + Vinted + Catawiki con scoring unico
2. **Deal velocity index** *(prossima release)*: n. nuove inserzioni/gg per carta → indicatore sentiment mercato
3. **PSA pop-to-listing ratio** *(hunt_scarcity_daily)*: popolazione PSA ÷ listing attive = scarcity dinamica
4. **Auction sniper signal**: prioritizza automaticamente aste <24h con 0 offerte sotto soglia

## TODO roadmap Hunter

- [ ] UI form per edit target (attualmente solo add tramite prompt)
- [ ] Realtime Supabase per notifiche push live in-app
- [ ] Scheduled function `hunt-digest` per report giornaliero via cron
- [ ] Integrazione pop report PSA via scraping o API
- [ ] Scraper migliorato con parsing `__NEXT_DATA__` per Vinted/Catawiki
- [ ] Dashboard "Watch list" (listing salvati con status=watched)
- [ ] Cross-portal arbitrage: flag se stessa carta appare su +portali con delta prezzo
