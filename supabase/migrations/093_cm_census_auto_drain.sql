-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Migration 093: censimento, drenaggio automatico
--
--  Aggiunge il flag `auto_drain` alla config dello scheduler (mig. 090).
--  Quando attivo, il client (solo admin, con Hunter pronta) avvia da solo
--  il drenaggio delle carte scadute all'apertura dell'app — nessun click
--  su "Esegui ora". Il cron continua a marcare 1 fascia/giorno; il
--  drenaggio resta browser-side via Hunter (IP residenziale, mai server).
-- ═══════════════════════════════════════════════════════════════════════

-- 1) Default auto_drain=false sulla config esistente (senza toccare le altre chiavi)
UPDATE public.platform_settings
   SET value = jsonb_build_object('auto_drain', false) || value,
       updated_at = now()
 WHERE key = 'cm_census_scheduler'
   AND NOT (value ? 'auto_drain');

-- 2) Estende settings_set con p_auto_drain (NULL = non toccare).
--    DROP esplicito: CREATE OR REPLACE con firma diversa creerebbe un
--    overload ambiguo per PostgREST sulle chiamate a 2 argomenti.
DROP FUNCTION IF EXISTS public.cm_census_settings_set(BOOLEAN, INT);

CREATE OR REPLACE FUNCTION public.cm_census_settings_set(
  p_enabled    BOOLEAN,
  p_hour       INT,
  p_auto_drain BOOLEAN DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_hour INT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Forbidden: admin only' USING ERRCODE = '42501';
  END IF;
  v_hour := GREATEST(0, LEAST(23, COALESCE(p_hour, 3)));

  UPDATE public.platform_settings
     SET value = value
                 || jsonb_build_object('enabled', COALESCE(p_enabled,false), 'hour_utc', v_hour)
                 || CASE WHEN p_auto_drain IS NULL THEN '{}'::jsonb
                         ELSE jsonb_build_object('auto_drain', p_auto_drain) END,
         updated_at = now()
   WHERE key = 'cm_census_scheduler';

  IF COALESCE(p_enabled,false) THEN
    PERFORM public.cm_census_reschedule(v_hour);
  ELSE
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
      PERFORM cron.unschedule('rb_cm_census_tick')
       WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rb_cm_census_tick');
    END IF;
  END IF;

  RETURN public.cm_census_settings_get();
END $$;

REVOKE ALL ON FUNCTION public.cm_census_settings_set(BOOLEAN, INT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cm_census_settings_set(BOOLEAN, INT, BOOLEAN) TO authenticated;

-- PostgREST: ricarica lo schema cache
NOTIFY pgrst, 'reload schema';
