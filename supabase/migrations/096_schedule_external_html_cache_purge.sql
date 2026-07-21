-- ─────────────────────────────────────────────────────────────────────────
--  RareBlock — Migration 096: Schedule external_html_cache purge (I/O fix)
-- ─────────────────────────────────────────────────────────────────────────
--  PROBLEMA (causa I/O):
--    public.cache_purge_external() esiste dalla 066 ma NON e' mai stata
--    schedulata. La tabella external_html_cache accumula pagine HTML intere
--    (colonna TEXT/TOAST, spesso >100KB per record CardMarket/eBay) con TTL
--    24h ma senza purge → crescita illimitata, bloat TOAST, autovacuum
--    continuo e letture/scritture su disco → esaurimento budget Disk I/O.
--
--  FIX:
--    1. Schedula cache_purge_external() ogni giorno alle 04:20 UTC.
--    2. Purge immediato one-shot per far scendere subito il volume dati.
--
--  NB: DELETE marca le righe come morte ma NON restituisce spazio al filesystem.
--      Per recuperare I/O e spazio subito, eseguire MANUALMENTE in finestra a
--      basso traffico (fuori da questa migration, non puo' stare in transazione):
--         VACUUM (ANALYZE, VERBOSE) public.external_html_cache;
--      oppure, per restituire spazio all'OS (lock esclusivo, rapido se tabella
--      gia' ripulita dal purge):
--         VACUUM FULL public.external_html_cache;
-- ─────────────────────────────────────────────────────────────────────────

-- 1) Purge immediato dei record scaduti (>7 giorni oltre expires_at)
DO $$
DECLARE v_deleted INT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'cache_purge_external') THEN
    SELECT public.cache_purge_external() INTO v_deleted;
    RAISE NOTICE 'external_html_cache: % record scaduti eliminati', v_deleted;
  END IF;
END $$;

-- 2) Schedula il purge giornaliero (04:20 UTC)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron non disponibile: purge non schedulato';
    RETURN;
  END IF;

  PERFORM cron.unschedule('rb_external_html_cache_purge')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rb_external_html_cache_purge');

  PERFORM cron.schedule(
    'rb_external_html_cache_purge',
    '20 4 * * *',
    $cron$ SELECT public.cache_purge_external(); $cron$
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'rb_external_html_cache_purge schedule fallito: %', SQLERRM;
END $$;

NOTIFY pgrst, 'reload schema';
