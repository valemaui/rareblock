-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Migration 076: Schedule pg_cron per cm_snapshot_weekly
--
--  Schedule:
--   • rb_cm_weekly_snapshot — lunedì 04:30 UTC
--     Copia public.cm_price_guide (prezzi correnti) in cm_price_history
--     marcandoli sulla settimana ISO corrente. Idempotente.
--
--  NB: questo cron NON scarica nulla da Cardmarket. L'ingest del file
--  ufficiale avviene lato browser autenticato (CM Price Bridge) perché
--  Cloudflare blocca le richieste server-side. Questo job lavora solo sui
--  dati già presenti in cm_price_guide, congelandone lo stato settimanale.
--
--  Pattern identico a 062 (gold cron): verifica pg_cron, idempotente,
--  view di stato + RPC admin proxy.
-- ═══════════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════════
--  1) Schedule
-- ══════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron non installata. Abilitare da Dashboard → Database → Extensions, poi rieseguire 076.';
    RETURN;
  END IF;

  PERFORM cron.unschedule('rb_cm_weekly_snapshot')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rb_cm_weekly_snapshot');

  -- Lunedì 04:30 UTC (dopo i job notturni esistenti delle 03:00/04:00)
  PERFORM cron.schedule(
    'rb_cm_weekly_snapshot',
    '30 4 * * 1',
    $cron$ SELECT public.cm_snapshot_weekly(); $cron$
  );

  RAISE NOTICE 'pg_cron job rb_cm_weekly_snapshot schedulato (lun 04:30 UTC)';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron schedule fallito: %', SQLERRM;
END $$;


-- ══════════════════════════════════════════════════════════════════════
--  2) View stato job
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW public.v_cm_snapshot_cron_status AS
WITH job AS (
  SELECT j.jobid, j.jobname, j.schedule, j.active
    FROM cron.job j
   WHERE j.jobname = 'rb_cm_weekly_snapshot'
),
last_runs AS (
  SELECT r.jobid, r.status, r.return_message, r.start_time, r.end_time,
         ROW_NUMBER() OVER (PARTITION BY r.jobid ORDER BY r.start_time DESC) AS rn
    FROM cron.job_run_details r
   WHERE r.jobid IN (SELECT jobid FROM job)
),
stats AS (
  SELECT r.jobid,
         COUNT(*)                                       AS runs_total,
         COUNT(*) FILTER (WHERE r.status = 'succeeded') AS runs_ok,
         COUNT(*) FILTER (WHERE r.status = 'failed')    AS runs_fail,
         MAX(r.start_time)                              AS last_start
    FROM cron.job_run_details r
   WHERE r.jobid IN (SELECT jobid FROM job)
   GROUP BY r.jobid
)
SELECT
  j.jobname, j.schedule, j.active,
  COALESCE(s.runs_total,0) AS runs_total,
  COALESCE(s.runs_ok,0)    AS runs_ok,
  COALESCE(s.runs_fail,0)  AS runs_fail,
  s.last_start             AS last_run_at,
  lr.status                AS last_run_status,
  lr.return_message        AS last_run_message
FROM job j
LEFT JOIN stats s     ON s.jobid = j.jobid
LEFT JOIN last_runs lr ON lr.jobid = j.jobid AND lr.rn = 1;

GRANT SELECT ON public.v_cm_snapshot_cron_status TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  3) RPC admin: stato (proxy per non esporre cron.*)
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.admin_get_cm_snapshot_cron_status()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v RECORD;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Forbidden: admin role required' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RETURN jsonb_build_object('installed', false,
      'message','pg_cron non installato.');
  END IF;

  SELECT * INTO v FROM public.v_cm_snapshot_cron_status LIMIT 1;
  IF v IS NULL THEN
    RETURN jsonb_build_object('installed', true, 'scheduled', false,
      'message','Job rb_cm_weekly_snapshot non schedulato. Rieseguire 076.');
  END IF;

  RETURN jsonb_build_object(
    'installed',        true,
    'scheduled',        true,
    'jobname',          v.jobname,
    'schedule',         v.schedule,
    'active',           v.active,
    'runs_total',       v.runs_total,
    'runs_ok',          v.runs_ok,
    'runs_fail',        v.runs_fail,
    'last_run_at',      v.last_run_at,
    'last_run_status',  v.last_run_status,
    'last_run_message', v.last_run_message
  );
END $$;

GRANT EXECUTE ON FUNCTION public.admin_get_cm_snapshot_cron_status() TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 076_schedule_cm_snapshot_cron.sql
--
--  Manuale:
--   • Disabilita: SELECT cron.alter_job(
--       (SELECT jobid FROM cron.job WHERE jobname='rb_cm_weekly_snapshot'),
--       active := false);
--   • Rimuovi:    SELECT cron.unschedule('rb_cm_weekly_snapshot');
--   • Esegui ora: SELECT public.cm_snapshot_weekly();
-- ═══════════════════════════════════════════════════════════════════════
