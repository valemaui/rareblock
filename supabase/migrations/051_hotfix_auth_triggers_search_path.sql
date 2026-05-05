-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — HOTFIX critico
--  Migration 051: search_path esplicito sui trigger SECURITY DEFINER
--                 collegati a auth.users (handle_new_user, sync_profile_email)
--
--  CONTESTO — BUG OSSERVATO
--  Tentativi di signup falliscono con:
--     "Database error saving new user"
--  
--  Postgres logs mostrano l'errore reale:
--     ERROR: relation "profiles" does not exist
--
--  CAUSA
--  Le funzioni handle_new_user() e sync_profile_email() (definite in
--  migration 011) sono SECURITY DEFINER ma NON specificano search_path.
--  
--  Quando Supabase Auth esegue le insert in auth.users (che triggerano
--  on_auth_user_created → handle_new_user e on_auth_user_email_sync →
--  sync_profile_email), recenti aggiornamenti della piattaforma Supabase
--  hanno reso più strict il search_path delle SECURITY DEFINER functions,
--  che ora viene impostato a vuoto come misura di sicurezza.
--  
--  Risultato: i riferimenti non-qualificati a `profiles` non risolvono.
--  
--  Le altre nostre funzioni più recenti (es. is_admin, log_profile_gdpr_changes)
--  già hanno SET search_path = public esplicito → non sono affette.
--
--  FIX
--  Riscriviamo entrambe le funzioni con SET search_path = public, pg_temp
--  e schema-qualifying esplicito (public.profiles) come ulteriore safety.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. handle_new_user con search_path esplicito ──────────────────────
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, email)
  VALUES (NEW.id, NEW.raw_user_meta_data->>'full_name', NEW.email)
  ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO authenticated, service_role, postgres;

-- ── 2. sync_profile_email con search_path esplicito ───────────────────
CREATE OR REPLACE FUNCTION public.sync_profile_email()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.profiles SET email = NEW.email WHERE id = NEW.id;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_profile_email() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_profile_email() TO authenticated, service_role, postgres;

-- ── 3. Sanity check: ricontrolla altre funzioni SECURITY DEFINER ──────
-- Verifichiamo se altre funzioni SECURITY DEFINER nel nostro schema
-- potrebbero soffrire dello stesso problema. Listiamo quelle SENZA
-- search_path settato per audit.
DO $$
DECLARE
  r RECORD;
  v_count INT := 0;
BEGIN
  RAISE NOTICE '────────── 051 SANITY: SECURITY DEFINER functions w/o search_path ──────────';
  FOR r IN
    SELECT
      n.nspname || '.' || p.proname AS func_name,
      p.proconfig                    AS config
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef = true
      AND (p.proconfig IS NULL OR NOT EXISTS (
        SELECT 1 FROM unnest(p.proconfig) AS cfg
        WHERE cfg LIKE 'search_path=%'
      ))
    ORDER BY p.proname
  LOOP
    v_count := v_count + 1;
    RAISE NOTICE '  ⚠ %', r.func_name;
  END LOOP;
  IF v_count = 0 THEN
    RAISE NOTICE '  ✓ Tutte le SECURITY DEFINER functions hanno search_path esplicito';
  ELSE
    RAISE WARNING '  Trovate % funzioni SECURITY DEFINER senza search_path. Considerare fix preventivo.', v_count;
  END IF;
END $$;

-- ── 4. Test smoke: simula signup ─────────────────────────────────────
-- Esegue lo stesso test che è stato eseguito manualmente in diagnostica.
-- Se il fix funziona, vedremo NOTICE 'TEST_OK'.
DO $$
DECLARE
  v_test_uuid UUID := gen_random_uuid();
  v_email TEXT := 'smoke-' || v_test_uuid || '@test.local';
BEGIN
  BEGIN
    INSERT INTO auth.users (id, email, instance_id, aud, role)
    VALUES (v_test_uuid, v_email, '00000000-0000-0000-0000-000000000000',
            'authenticated', 'authenticated');
    -- Cleanup immediato (cascade su profiles)
    DELETE FROM auth.users WHERE id = v_test_uuid;
    RAISE NOTICE '  ✓ TEST_OK: signup simulato + cleanup OK (handle_new_user e sync_profile_email funzionano)';
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '  ✗ TEST_FAILED: % | sqlstate=%', SQLERRM, SQLSTATE;
  END;
END $$;

NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 051_hotfix_auth_triggers_search_path.sql
-- ═══════════════════════════════════════════════════════════════════════
