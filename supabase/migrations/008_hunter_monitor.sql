-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — RADAR: monitoraggio attivo aste
--  Aggiunge colonne per tracciare aste singole su cui l'utente ha attivato
--  il monitoraggio attivo (notifiche a soglie temporali: 24h, 6h, 1h, 10m).
--  Esegui nel Supabase SQL Editor una volta sola.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE hunt_listings
  ADD COLUMN IF NOT EXISTS is_monitored     BOOL DEFAULT false,
  ADD COLUMN IF NOT EXISTS monitor_notified TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Index per il cron: scansiona solo le aste attivamente monitorate
CREATE INDEX IF NOT EXISTS hunt_listings_monitored_idx
  ON hunt_listings(auction_ends_at)
  WHERE is_monitored = true AND auction_ends_at IS NOT NULL;

COMMENT ON COLUMN hunt_listings.is_monitored IS
  'Se true, la edge function hunt-monitor invia notifiche alle soglie temporali prima della fine asta';
COMMENT ON COLUMN hunt_listings.monitor_notified IS
  'Array di soglie già notificate per evitare ri-invii: sottoinsieme di {24h,6h,1h,10m,ended}';
