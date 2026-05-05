-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — auth PR1 fix
--  Migration 052: handle_new_user legge consensi GDPR da raw_user_meta_data
--                 e li popola nelle colonne profiles.gdpr_*_accepted_at
--                 → trigger trg_profile_gdpr_log esistente fa il log automatico
--
--  CONTESTO BUG
--  Il fix originale di PR1 prevedeva una chiamata POST alla edge function
--  signup-consent-log dal frontend dopo il signup, usando data.access_token
--  della response /auth/v1/signup. Bug osservato: quando il progetto
--  Supabase richiede email_confirmation, la response NON include
--  access_token (data.session è null). Risultato: la mia condizione
--    if(data && data.access_token)
--  saltava silenziosamente, e nessun consenso veniva loggato in DB.
--
--  STRATEGIA FIX
--  Sfruttiamo l infrastruttura GIÀ ESISTENTE:
--    - profiles ha già le colonne gdpr_privacy_accepted_at e gdpr_tos_accepted_at
--    - trigger trg_profile_gdpr_log su profiles AFTER INSERT fa già il log
--      automatico in gdpr_consent_log per quei campi
--
--  Quindi basta che handle_new_user faccia INSERT in profiles popolando anche
--  quei due campi. Il logging è transazionale e atomico — anche se l utente
--  non conferma mai l email, il consenso resta documentato.
--
--  Frontend invia i timestamp via signupBody.data (Supabase Auth API),
--  che vengono persistiti in auth.users.raw_user_meta_data come JSON.
-- ═══════════════════════════════════════════════════════════════════════

-- Aggiorniamo handle_new_user per leggere e popolare i campi GDPR.
-- Manteniamo il fix search_path della 051.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_meta JSONB := COALESCE(NEW.raw_user_meta_data, '{}'::JSONB);
  v_priv TIMESTAMPTZ;
  v_tos  TIMESTAMPTZ;
  v_priv_v TEXT;
  v_tos_v  TEXT;
BEGIN
  -- Parsing timestamp consensi (passati dal frontend nel signup payload).
  -- Se invalidi/mancanti, restano NULL e il trigger trg_profile_gdpr_log
  -- non logga nulla per quel campo.
  BEGIN
    v_priv := (v_meta->>'gdpr_privacy_accepted_at')::TIMESTAMPTZ;
  EXCEPTION WHEN OTHERS THEN v_priv := NULL; END;

  BEGIN
    v_tos := (v_meta->>'gdpr_tos_accepted_at')::TIMESTAMPTZ;
  EXCEPTION WHEN OTHERS THEN v_tos := NULL; END;

  v_priv_v := COALESCE(v_meta->>'gdpr_privacy_version', '1.0');
  v_tos_v  := COALESCE(v_meta->>'gdpr_tos_version', '1.0');

  -- Settiamo source per il trigger trg_profile_gdpr_log via custom GUC.
  -- Il trigger 038 lo legge via current_setting('rareblock.consent_source', true).
  PERFORM set_config('rareblock.consent_source', 'signup', true);

  INSERT INTO public.profiles (
    id, full_name, email,
    gdpr_privacy_accepted_at, gdpr_tos_accepted_at
  )
  VALUES (
    NEW.id,
    NEW.raw_user_meta_data->>'full_name',
    NEW.email,
    v_priv,
    v_tos
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    gdpr_privacy_accepted_at = COALESCE(profiles.gdpr_privacy_accepted_at, EXCLUDED.gdpr_privacy_accepted_at),
    gdpr_tos_accepted_at     = COALESCE(profiles.gdpr_tos_accepted_at,     EXCLUDED.gdpr_tos_accepted_at);

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO authenticated, service_role, postgres;

-- ── Backfill consensi per utenti pre-fix ──────────────────────────────
-- Per gli utenti già esistenti (incluso v.castiglia, valemaui, e l'ultimo
-- test styq6ldv2o@yzcalo.com) NON tocchiamo il DB — i loro consensi non
-- erano stati registrati al signup. Saranno re-collected al prossimo
-- login se vogliamo bloccarli, oppure restano "non documentati" come
-- accettazione storica implicita.

-- ── Sanity test ────────────────────────────────────────────────────────
DO $$
DECLARE
  v_test_uuid UUID := gen_random_uuid();
  v_email TEXT := 'smoke-052-' || v_test_uuid || '@test.local';
  v_log_count INT;
BEGIN
  -- INSERT user con metadata di consensi (simula signup completo)
  INSERT INTO auth.users (id, email, instance_id, aud, role, raw_user_meta_data)
  VALUES (
    v_test_uuid, v_email, '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated',
    jsonb_build_object(
      'gdpr_privacy_accepted_at', now()::TEXT,
      'gdpr_tos_accepted_at', now()::TEXT,
      'gdpr_privacy_version', '1.0',
      'gdpr_tos_version', '1.0'
    )
  );

  -- Verifica: il trigger trg_profile_gdpr_log dovrebbe aver creato 2 righe
  -- (privacy + tos) in gdpr_consent_log per questo user.
  SELECT count(*) INTO v_log_count
  FROM public.gdpr_consent_log
  WHERE user_id = v_test_uuid;

  -- Cleanup (cascade)
  DELETE FROM auth.users WHERE id = v_test_uuid;

  IF v_log_count = 2 THEN
    RAISE NOTICE '052 TEST_OK: 2 righe loggate in gdpr_consent_log (privacy + tos)';
  ELSE
    RAISE WARNING '052 TEST_PROBLEM: atteso 2 righe, trovate %', v_log_count;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 052_handle_new_user_gdpr.sql
-- ═══════════════════════════════════════════════════════════════════════
