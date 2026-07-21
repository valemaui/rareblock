-- ─────────────────────────────────────────────────────────────────────────
--  RareBlock — Migration 098: Pausa cron non gestiti (risparmio risorse)
-- ─────────────────────────────────────────────────────────────────────────
--  Sezioni non attualmente gestite → i cron girano consumando risorse a vuoto.
--  Messi in PAUSA (active=false), NON cancellati: schedule e comando restano
--  intatti, si riattivano con un semplice active=true (vedi in fondo).
--
--  In pausa:
--    - rb_cancel_expired_orders      (ordini)
--    - rb_send_order_reminders       (email ordini)
--    - rb_send_order_expired_emails  (email ordini)
--    - rb_gold_eligibility_scan      (tier Gold)
--    - fractional-cron-tick          (apertura voti frazionari)
--    - rb_auction_alert_tick         (asta: girava OGNI MINUTO; feature non attiva)
--
--  NON toccati: rb_cm_census_tick / rb_cm_weekly_snapshot / rb_weekly_price_rollup
--  (pipeline prezzi, in verifica) e rb_external_html_cache_purge (fix I/O 096).
--
--  Riattivazione futura (sempre via alter_job, non UPDATE diretto):
--    SELECT cron.alter_job(jobid, active := true)
--      FROM cron.job WHERE jobname = '<nome>';
--
--  NB: nessun NOTIFY pgrst (non è un cambio di schema; eviterei il reload).
-- ─────────────────────────────────────────────────────────────────────────

-- NB: su Supabase la DML diretta su cron.job e' negata (permission denied):
--     si deve passare da cron.alter_job(), che modifica in modo privilegiato.
DO $$
DECLARE r RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron non disponibile: nessun cron da mettere in pausa';
    RETURN;
  END IF;

  FOR r IN
    SELECT jobid, jobname FROM cron.job
     WHERE jobname IN (
       'rb_cancel_expired_orders',
       'rb_send_order_reminders',
       'rb_send_order_expired_emails',
       'rb_gold_eligibility_scan',
       'fractional-cron-tick',
       'rb_auction_alert_tick'
     )
  LOOP
    PERFORM cron.alter_job(r.jobid, active := false);
    RAISE NOTICE '098: cron "%" messo in pausa', r.jobname;
  END LOOP;
END $$;
