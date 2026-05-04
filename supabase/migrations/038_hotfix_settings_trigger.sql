-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Hotfix
--  Migration 038: SECURITY DEFINER su trigger functions che scrivono
--                  in audit tables protette da RLS
--
--  Problema osservato in PR3:
--    Salvando un campo da pannello admin → errore 42501:
--    "new row violates row-level security policy for table
--     platform_settings_history"
--
--  Causa:
--    Le trigger function girano nel security context dell'utente chiamante.
--    Le tabelle di audit (history, log) hanno policy SELECT ma nessuna
--    INSERT. I trigger AFTER provano a INSERT e vengono bloccati.
--
--  Soluzione:
--    Rendiamo le function SECURITY DEFINER + SET search_path. Stessa
--    tecnica usata da public.is_admin() e public.club_seats_available().
--
--  Function corrette:
--    1) public.log_platform_settings_change()  (bug attivo, confermato)
--    2) public.log_profile_gdpr_changes()      (bug latente, lo si
--                                               manifesterà in PR4 al
--                                               primo consenso GDPR)
--
--  NON serve fixare:
--    public.club_membership_touch()  — è BEFORE UPDATE che aggiorna
--                                       solo NEW.*, no INSERT esterni.
--
--  Sicurezza:
--    Le function non ricevono input utente — operano solo su NEW/OLD
--    della trigger row. Niente superficie SQL injection.
--    Il search_path è bloccato a public,pg_temp per impedire attacchi
--    di privilege escalation.
-- ═══════════════════════════════════════════════════════════════════════


-- ── 1) Trigger settings history ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.log_platform_settings_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.value IS DISTINCT FROM NEW.value THEN
    INSERT INTO platform_settings_history (key, old_value, new_value, changed_by)
    VALUES (NEW.key, OLD.value, NEW.value, NEW.updated_by);
  ELSIF TG_OP = 'INSERT' THEN
    INSERT INTO platform_settings_history (key, old_value, new_value, changed_by)
    VALUES (NEW.key, NULL, NEW.value, NEW.updated_by);
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.log_platform_settings_change() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_platform_settings_change() TO authenticated, service_role;


-- ── 2) Trigger GDPR consent log (preventivo, evita stesso problema in PR4) ─
CREATE OR REPLACE FUNCTION public.log_profile_gdpr_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  src TEXT := COALESCE(current_setting('rareblock.consent_source', true), 'profile_page');
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.gdpr_privacy_accepted_at IS NOT NULL THEN
      INSERT INTO gdpr_consent_log(user_id, consent_key, old_value, new_value, source)
      VALUES (NEW.id, 'privacy', NULL, to_jsonb(NEW.gdpr_privacy_accepted_at), src);
    END IF;
    IF NEW.gdpr_tos_accepted_at IS NOT NULL THEN
      INSERT INTO gdpr_consent_log(user_id, consent_key, old_value, new_value, source)
      VALUES (NEW.id, 'tos', NULL, to_jsonb(NEW.gdpr_tos_accepted_at), src);
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.gdpr_privacy_accepted_at IS DISTINCT FROM NEW.gdpr_privacy_accepted_at THEN
    INSERT INTO gdpr_consent_log(user_id, consent_key, old_value, new_value, source)
    VALUES (NEW.id, 'privacy', to_jsonb(OLD.gdpr_privacy_accepted_at), to_jsonb(NEW.gdpr_privacy_accepted_at), src);
  END IF;
  IF OLD.gdpr_tos_accepted_at IS DISTINCT FROM NEW.gdpr_tos_accepted_at THEN
    INSERT INTO gdpr_consent_log(user_id, consent_key, old_value, new_value, source)
    VALUES (NEW.id, 'tos', to_jsonb(OLD.gdpr_tos_accepted_at), to_jsonb(NEW.gdpr_tos_accepted_at), src);
  END IF;
  IF OLD.gdpr_marketing_accepted IS DISTINCT FROM NEW.gdpr_marketing_accepted THEN
    INSERT INTO gdpr_consent_log(user_id, consent_key, old_value, new_value, source)
    VALUES (NEW.id, 'marketing',
            jsonb_build_object('accepted', OLD.gdpr_marketing_accepted, 'at', OLD.gdpr_marketing_accepted_at),
            jsonb_build_object('accepted', NEW.gdpr_marketing_accepted, 'at', NEW.gdpr_marketing_accepted_at),
            src);
  END IF;
  IF OLD.gdpr_profiling_accepted IS DISTINCT FROM NEW.gdpr_profiling_accepted THEN
    INSERT INTO gdpr_consent_log(user_id, consent_key, old_value, new_value, source)
    VALUES (NEW.id, 'profiling',
            jsonb_build_object('accepted', OLD.gdpr_profiling_accepted, 'at', OLD.gdpr_profiling_accepted_at),
            jsonb_build_object('accepted', NEW.gdpr_profiling_accepted, 'at', NEW.gdpr_profiling_accepted_at),
            src);
  END IF;
  IF OLD.gdpr_third_party_accepted IS DISTINCT FROM NEW.gdpr_third_party_accepted THEN
    INSERT INTO gdpr_consent_log(user_id, consent_key, old_value, new_value, source)
    VALUES (NEW.id, 'third_party',
            jsonb_build_object('accepted', OLD.gdpr_third_party_accepted, 'at', OLD.gdpr_third_party_accepted_at),
            jsonb_build_object('accepted', NEW.gdpr_third_party_accepted, 'at', NEW.gdpr_third_party_accepted_at),
            src);
  END IF;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.log_profile_gdpr_changes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_profile_gdpr_changes() TO authenticated, service_role;


-- ── Reload PostgREST + smoke test ────────────────────────────────────
NOTIFY pgrst, 'reload schema';

-- Verifica che entrambe le function siano SECURITY DEFINER
SELECT
  p.proname    AS function_name,
  p.prosecdef  AS is_security_definer,
  CASE WHEN p.prosecdef THEN '✓ OK' ELSE '✗ FAIL' END AS status
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname='public'
  AND p.proname IN ('log_platform_settings_change','log_profile_gdpr_changes')
ORDER BY p.proname;

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 038_hotfix_settings_trigger.sql
-- ═══════════════════════════════════════════════════════════════════════
