-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Migration 062: Schedule pg_cron per cron_scan_gold_eligibility
--
--  Schedule:
--   • rb_gold_eligibility_scan — daily 03:00 UTC
--     Scansiona profili e aggiorna flag eligibility/at-risk su profiles.
--     NON tocca il campo `tier` (la promozione resta manuale dall'admin).
--
--  Cosa fa il job:
--   - Flagga utenti BASIC/PRO sopra soglia AUM come gold_eligible_since
--   - Rimuove eleggibilità dopo N giorni sotto soglia (default 30)
--   - Marca GOLD sotto soglia come at-risk (nessun downgrade automatico)
--   - Pulisce at-risk quando GOLD risale sopra soglia
--
--  Pattern:
--   - Verifica disponibilità pg_cron e fallisce graceful con RAISE NOTICE
--   - Idempotente: unschedule preesistente prima di reinstallare
--   - View v_gold_cron_status per monitoring admin
-- ═══════════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════════
--  1) Schedule del cron job
-- ══════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  -- Verifica che pg_cron sia abilitato
  IF NOT EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'
  ) THEN
    RAISE NOTICE 'pg_cron extension non installata. Abilitare da Supabase Dashboard → Database → Extensions, poi rieseguire questa migration.';
    RETURN;
  END IF;

  -- Rimuove eventuale schedule precedente (idempotente)
  PERFORM cron.unschedule('rb_gold_eligibility_scan')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rb_gold_eligibility_scan');

  -- Schedula daily 03:00 UTC
  -- (precede il rb_cancel_expired_orders delle 04:00 per evitare collisioni
  --  e perché lo scan è read-heavy ma write-light, ok in finestra notturna)
  PERFORM cron.schedule(
    'rb_gold_eligibility_scan',
    '0 3 * * *',
    $cron$ SELECT public.cron_scan_gold_eligibility(); $cron$
  );

  RAISE NOTICE 'pg_cron job rb_gold_eligibility_scan schedulato (03:00 UTC daily)';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron schedule fallito: %', SQLERRM;
END $$;


-- ══════════════════════════════════════════════════════════════════════
--  2) View admin: stato del cron job (last run, success rate, next run)
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW public.v_gold_cron_status AS
WITH job AS (
  SELECT j.jobid, j.jobname, j.schedule, j.active
    FROM cron.job j
   WHERE j.jobname = 'rb_gold_eligibility_scan'
),
last_runs AS (
  SELECT
    r.jobid,
    r.runid,
    r.status,
    r.return_message,
    r.start_time,
    r.end_time,
    ROW_NUMBER() OVER (PARTITION BY r.jobid ORDER BY r.start_time DESC) AS rn
  FROM cron.job_run_details r
  WHERE r.jobid IN (SELECT jobid FROM job)
),
stats AS (
  SELECT
    r.jobid,
    COUNT(*)                                            AS runs_total,
    COUNT(*) FILTER (WHERE r.status = 'succeeded')      AS runs_ok,
    COUNT(*) FILTER (WHERE r.status = 'failed')         AS runs_fail,
    MAX(r.start_time)                                   AS last_start,
    MIN(r.start_time)                                   AS first_start
  FROM cron.job_run_details r
  WHERE r.jobid IN (SELECT jobid FROM job)
  GROUP BY r.jobid
)
SELECT
  j.jobname,
  j.schedule,
  j.active,
  COALESCE(s.runs_total, 0)                             AS runs_total,
  COALESCE(s.runs_ok,    0)                             AS runs_ok,
  COALESCE(s.runs_fail,  0)                             AS runs_fail,
  s.last_start                                          AS last_run_at,
  lr.status                                             AS last_run_status,
  lr.return_message                                     AS last_run_message,
  CASE
    WHEN lr.start_time IS NOT NULL AND lr.end_time IS NOT NULL
      THEN EXTRACT(EPOCH FROM (lr.end_time - lr.start_time))
    ELSE NULL
  END                                                   AS last_run_duration_sec,
  s.first_start                                         AS first_run_at
FROM job j
LEFT JOIN stats s
       ON s.jobid = j.jobid
LEFT JOIN last_runs lr
       ON lr.jobid = j.jobid
      AND lr.rn = 1;

-- Permesso lettura via RLS è gestito a livello applicativo:
-- la view è esposta solo all'admin tramite la dashboard (admin-tiers).
-- pg_cron schemas hanno permessi restrittivi di default.
GRANT SELECT ON public.v_gold_cron_status TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  3) RPC admin: leggi status (proxy per non esporre cron.* direttamente)
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.admin_get_gold_cron_status()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row RECORD;
  v_result JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Forbidden: admin role required'
      USING ERRCODE = '42501';
  END IF;

  -- Se pg_cron non c'è, ritorna stato "non installato"
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RETURN jsonb_build_object(
      'installed', false,
      'message', 'pg_cron non installato. Abilitare da Supabase Dashboard → Database → Extensions.'
    );
  END IF;

  SELECT * INTO v_row FROM public.v_gold_cron_status LIMIT 1;

  IF v_row IS NULL THEN
    RETURN jsonb_build_object(
      'installed', true,
      'scheduled', false,
      'message', 'Job rb_gold_eligibility_scan non schedulato. Rieseguire migration 062.'
    );
  END IF;

  v_result := jsonb_build_object(
    'installed',             true,
    'scheduled',             true,
    'jobname',               v_row.jobname,
    'schedule',              v_row.schedule,
    'active',                v_row.active,
    'runs_total',            v_row.runs_total,
    'runs_ok',               v_row.runs_ok,
    'runs_fail',             v_row.runs_fail,
    'last_run_at',           v_row.last_run_at,
    'last_run_status',       v_row.last_run_status,
    'last_run_message',      v_row.last_run_message,
    'last_run_duration_sec', v_row.last_run_duration_sec,
    'first_run_at',          v_row.first_run_at
  );

  RETURN v_result;
END $$;

GRANT EXECUTE ON FUNCTION public.admin_get_gold_cron_status() TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  4) Verifica finale (output informativo)
-- ══════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_active BOOLEAN;
  v_schedule TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE '─── pg_cron NON installato. Schedule deferred. ───';
    RETURN;
  END IF;

  SELECT j.active, j.schedule
    INTO v_active, v_schedule
    FROM cron.job j
   WHERE j.jobname = 'rb_gold_eligibility_scan';

  IF v_active IS NULL THEN
    RAISE NOTICE '─── Job rb_gold_eligibility_scan NON trovato dopo schedule ───';
  ELSE
    RAISE NOTICE '─── Job rb_gold_eligibility_scan installato (active=%, schedule=%) ───', v_active, v_schedule;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 062_schedule_gold_cron.sql
--
--  Operazioni manuali:
--   • Per disabilitare temporaneamente:
--     SELECT cron.alter_job(
--       (SELECT jobid FROM cron.job WHERE jobname='rb_gold_eligibility_scan'),
--       active := false
--     );
--   • Per rimuovere completamente:
--     SELECT cron.unschedule('rb_gold_eligibility_scan');
--   • Per eseguirlo subito on-demand (la admin UI lo fa già con un button):
--     SELECT public.cron_scan_gold_eligibility();
-- ═══════════════════════════════════════════════════════════════════════
