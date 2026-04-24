# 📡 RareBlock Radar (ex Hunter)

Feature di scouting inserzioni multi-portale + **monitoraggio attivo aste** per investitori TCG.

## Cosa fa

1. **Monitora** carte target configurate dall'utente (nome, numero, grading, 1st Ed, shadowless, lingua)
2. **Genera URL pre-compilati** per eBay, Catawiki, Subito, Vinted, TCGPlayer, Mercari
3. **Raccoglie listing** tramite userscript `rareblock-hunter-scraper.user.js` (multi-dominio)
4. **Watch manuale URL** per portali senza scraper (es. Catawiki): paste URL + data fine → entry in hunt_listings
5. **Monitoraggio attivo singola asta**: toggle 🔔 sull'asta → la edge function `hunt-monitor` invia alert alle soglie 24h / 6h / 1h / 10min / fine asta
6. **Calcola Deal Score 0-100** che combina: sconto vs CM, timing asta, reputazione venditore, match attributi
7. **Invia alert** configurabili (push, email, Telegram) con regole per utente
8. **Report aggregati** giornalieri/orari via digest

## Architettura

```
┌─────────────────────────────┐
│ Browser userscript          │──POST /functions/v1/hunt-ingest──┐
│ (eBay/Subito/Vinted)        │                                   │
└─────────────────────────────┘                                   │
                                                                  ▼
┌─────────────────────────────┐                         ┌─────────────────┐
│ UI Radar: Monitora asta     │──PATCH is_monitored────▶│ hunt_listings   │
└─────────────────────────────┘                         └────────┬────────┘
                                                                 │
                    ┌────────────────────────────────────────────┤
                    ▼                                            ▼
           ┌─────────────────┐                          ┌──────────────────┐
           │ hunt-ingest     │                          │ hunt-monitor     │
           │ (on demand)     │                          │ (cron 5min)      │
           └───────┬─────────┘                          └─────────┬────────┘
                   │                                              │
                   └──────────┬───────────────────────────────────┘
                              ▼
                     ┌─────────────────┐
                     │ hunt_alert_rules│   (match + throttle)
                     └────────┬────────┘
                              ▼
                  Resend (email) · Telegram Bot · Supabase Realtime (push)
                              ▼
                     ┌────────────────┐
                     │ hunt_alert_log │
                     └────────────────┘
```

## Schema

- `007_hunter_schema.sql` — schema base
- `008_hunter_monitor.sql` — aggiunge `is_monitored`, `monitor_notified[]` a `hunt_listings`

| Tabella | Scopo |
|---|---|
| `hunt_targets` | carte monitorate con attributi e soglie |
| `hunt_listings` | inserzioni raccolte con deal_score + flag monitor |
| `hunt_alert_rules` | regole utente (quando notificare) |
| `hunt_channel_config` | email/TG/push per utente |
| `hunt_alert_log` | storico invii |
| `hunt_scarcity_daily` | snapshot giornaliero PSA pop + listing per target |
| `hunt_feed` (view) | feed ordinato per deal_score |

## Setup operativo

### 1. Migration (una volta sola nel SQL Editor)
```bash
cat supabase/migrations/007_hunter_schema.sql    # se non già eseguita
cat supabase/migrations/008_hunter_monitor.sql   # NUOVA
```

### 2. Deploy edge function
```bash
supabase functions deploy hunt-ingest
supabase functions deploy hunt-monitor --no-verify-jwt
```

### 3. Schedule hunt-monitor (ogni 5 minuti)

Via **pg_cron** (consigliato, runtime interno a Supabase):
```sql
-- Abilita estensioni nel dashboard Supabase (Database → Extensions)
-- pg_cron + pg_net

select cron.schedule(
  'hunt-monitor-5min',
  '*/5 * * * *',
  $$ select net.http_post(
       url:='https://<PROJECT>.functions.supabase.co/hunt-monitor',
       headers:=jsonb_build_object(
         'Authorization','Bearer '||current_setting('app.settings.service_role_key')
       )
     ); $$
);
```

Alternativa: **cron-job.org** / **GitHub Actions** con POST ogni 5min.

### 4. Secrets (dashboard Supabase → Project Settings → Edge Functions)
```
RESEND_API_KEY          # per email (Resend)
TELEGRAM_BOT_TOKEN      # crea bot con @BotFather su Telegram
```

Canali notifica disponibili: **push browser** (via Realtime), **email** (Resend), **Telegram**.

### 5. Userscript (per scraping automatico)
Installa `rareblock-hunter-scraper.user.js` in Tampermonkey/Violentmonkey.

### 6. Login nell'app
Il JWT viene salvato come `rbJWT` in localStorage — il userscript lo legge e autentica le POST.

## Monitoraggio attivo aste (novità)

**Flow**:
1. Utente trova asta (scraped o aggiunta manualmente da URL)
2. Clicca `🔕 Monitora` sulla card → diventa `🔔 Monitorata` con bordo arancio pulsante
3. Cron `hunt-monitor` ogni 5 min scansiona `is_monitored=true AND auction_ends_at>now()`
4. Quando l'asta entra in una finestra (24h, 6h, 1h, 10min, o è terminata) invia alert
5. Alert deduplicati tramite `monitor_notified TEXT[]` (soglie già inviate)
6. Se client browser aperto, Realtime WS invia UPDATE → toast + Notification API

**Strategia anti-spam**: se attivi il monitoraggio su un'asta che è già tra 2h alla fine, salta `24h` e `6h` (le marca silent) e invia solo `1h`. Mai più di una soglia per asta per ciclo.

**Smette automaticamente**: dopo aver inviato `ended`, `is_monitored` torna a `false`.

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
2. **Watch manuale + monitor**: per portali senza API/scraper (Catawiki) l'utente incolla URL e riceve comunque alert a soglie temporali
3. **Deal velocity index** *(prossima release)*: n. nuove inserzioni/gg per carta → indicatore sentiment mercato
4. **PSA pop-to-listing ratio** *(hunt_scarcity_daily)*: popolazione PSA ÷ listing attive = scarcity dinamica
5. **Auction sniper signal**: monitor attivo dedica soglia 10min finale per sniping tempestivo

## TODO roadmap

- [x] Watch manuale URL (Catawiki & co.)
- [x] Monitor attivo per singola asta con alert a soglie
- [ ] UI form full edit target (attualmente modal base + quick add sidebar)
- [ ] Scheduled function `hunt-digest` per report giornaliero via cron
- [ ] Integrazione pop report PSA via scraping o API
- [ ] Scraper migliorato con parsing `__NEXT_DATA__` per Vinted/Catawiki
- [ ] Re-sync live dell'asta monitorata: refresh bid_count/price ogni ciclo monitor
- [ ] Cross-portal arbitrage auto-detection (base c'è, migliorare heuristic)
