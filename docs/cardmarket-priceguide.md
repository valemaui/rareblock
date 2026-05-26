# Cardmarket Price Guide — replica server-side

Replica settimanale dei prezzi Cardmarket (low/avg/trend + medie mobili) su
Supabase, basata sul **file ufficiale** che CM pubblica una volta al giorno —
non su scraping di listing.

## Perché il file e non lo scraping
- Il price guide ufficiale copre **tutte le carte di tutti i set** con
  low/avg/trend/avg1/avg7/avg30 (foil e non), aggiornato 1×/giorno.
- È **1 download**, non centinaia di migliaia di page-load → nessun anti-bot.
- Lo scraping dei listing serve solo per il **breakdown per condizione**
  (Poor→Mint), che il file NON contiene. Quello resta on-demand via il
  `CM Price Bridge` userscript, sulle sole carte che l'utente apre.

## Limite noto
Cloudflare blocca le richieste server-side a cardmarket.com (403). Quindi
l'**acquisizione del file** avviene dal browser autenticato (userscript), che
poi pusha le righe parsate alle RPC `cm_ingest_*`. Lo **snapshot settimanale**
(`cm_snapshot_weekly`) gira invece interamente server-side via pg_cron, perché
lavora solo su dati già in tabella.

## Schema (migration 075)
- `cm_catalog` — dimensione prodotto (idProduct → nome/set/numero/rarità).
  Upsert con COALESCE: i campi mancanti **non** sovrascrivono gli esistenti.
- `cm_price_guide` — prezzi correnti, 1 riga/prodotto. Upsert **full-replace**:
  ogni ingest deve contenere la riga completa (è così nel file giornaliero).
- `cm_price_history` — snapshot settimanali, PK `(id_product, snapshot_week)`.
- `cm_price_by_condition` — 3 minimi + media per condizione, popolata dal bridge.

Scrittura solo via RPC `SECURITY DEFINER` (admin per gli ingest del file,
authenticated per gli ingest per-condizione). Lettura: authenticated.

## Setup (una tantum)
1. SQL editor Supabase → esegui `075_cm_price_guide.sql`.
2. SQL editor → esegui `076_schedule_cm_snapshot_cron.sql` (pg_cron già attivo).
3. Verifica: `SELECT public.admin_get_cm_snapshot_cron_status();`

## Diagnostica necessaria per finalizzare l'acquisizione
Il file non è ispezionabile da remoto (Cloudflare). Servono 2 dati dal browser
loggato su Cardmarket:
1. **URL reale del download** del price guide Pokémon (DevTools → Network →
   avvia il download dalla pagina Data → copia la Request URL).
2. **Prime 3 righe** del file scaricato (intestazione + 2 righe dati), per
   mappare le colonne reali sulle chiavi attese dalle RPC.

Con questi due dati finalizzo il `rareblock-cm-priceguide.user.js` (fetch
autenticato → decompress gzip → parse CSV → batch verso `cm_ingest_price_guide`).

## RPC utili
- `cm_ingest_catalog(jsonb)` / `cm_ingest_price_guide(jsonb)` — bulk upsert.
- `cm_ingest_condition_prices(jsonb)` — per-condizione (dal bridge).
- `cm_snapshot_weekly()` — correnti → history (cron, lun 04:30 UTC).
- `admin_get_cm_price_status()` — coverage e ultimo ingest.
