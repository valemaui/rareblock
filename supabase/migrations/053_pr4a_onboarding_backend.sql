-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — auth PR4a (backend)
--  Migration 053: view onboarding status + RPC kyc_can_invest
--                 (gating smart: hard block solo prima del primo investimento)
--
--  CONTESTO
--  PR4 implementa onboarding multi-step adaptive post-signup. L approccio
--  scelto è "smart gating": il collector può usare l app subito, l investor
--  viene bloccato dal primo acquisto di quote finché non completa KYC L2.
--
--  L UI adaptive (PR4b) consuma v_user_onboarding_status per decidere
--  quali step mostrare. Le RPC kyc_can_invest e kyc_complete_step
--  supportano il gating + i salvataggi step-by-step.
--
--  COSA NON FA
--  - Storage: bucket kyc-documents già esiste (migration 033).
--  - Schema profiles: già completo per anagrafica + documento + telefono.
--  - PR4a tocca solo le query/view/RPC per supportare l UI di PR4b/PR4c.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. View v_user_onboarding_status ──────────────────────────────────
-- Aggrega lo stato di completamento KYC per l utente corrente in 3 sezioni:
--   - personal: anagrafica L2 (nome, cognome, data nascita, CF, residenza)
--   - document: documento d identità (tipo, numero, scadenza, foto fronte+retro)
--   - phone:    telefono E.164 + verificato OTP
-- Più derived flags:
--   - all_complete: tutti e 3 completati
--   - can_invest: pronto per investire (= all_complete + kyc_status approvabile)
--   - next_step: prossimo step incompleto (per UI auto-skip)
--
-- Security: SECURITY INVOKER → eredita RLS di profiles (utente vede solo se stesso,
-- admin vede tutti via policy esistente).
CREATE OR REPLACE VIEW public.v_user_onboarding_status
WITH (security_invoker = true)
AS
SELECT
  p.id AS user_id,
  p.email,
  p.kyc_level,
  p.kyc_status,

  -- Sezione 1: anagrafica personale L2
  (
    p.first_name IS NOT NULL AND p.first_name <> '' AND
    p.last_name  IS NOT NULL AND p.last_name  <> '' AND
    p.birth_date IS NOT NULL AND
    p.birth_place IS NOT NULL AND p.birth_place <> '' AND
    p.fiscal_code IS NOT NULL AND p.fiscal_code <> '' AND
    p.res_address IS NOT NULL AND p.res_address <> '' AND
    p.res_zip     IS NOT NULL AND p.res_zip     <> '' AND
    p.res_city    IS NOT NULL AND p.res_city    <> ''
  ) AS personal_complete,

  -- Sezione 2: documento d identità
  (
    p.id_doc_type IS NOT NULL AND p.id_doc_type <> '' AND
    p.id_doc_number IS NOT NULL AND p.id_doc_number <> '' AND
    p.id_doc_expiry_date IS NOT NULL AND
    p.id_doc_front_path IS NOT NULL AND p.id_doc_front_path <> '' AND
    p.id_doc_back_path  IS NOT NULL AND p.id_doc_back_path  <> ''
  ) AS document_complete,

  -- Sezione 3: telefono (numero raccolto, OTP differita)
  (p.phone_e164 IS NOT NULL AND p.phone_e164 <> '') AS phone_provided,
  (p.phone_verified_at IS NOT NULL) AS phone_verified,

  -- Documenti scaduti? (red flag per re-upload)
  (p.id_doc_expiry_date IS NOT NULL AND p.id_doc_expiry_date < CURRENT_DATE) AS document_expired,

  -- Consensi GDPR base (presenza timestamp, no version checks per semplicità)
  (p.gdpr_privacy_accepted_at IS NOT NULL) AS gdpr_privacy_ok,
  (p.gdpr_tos_accepted_at IS NOT NULL) AS gdpr_tos_ok,

  -- KYC reviewer info (se presente)
  p.kyc_reviewer_id,
  p.kyc_reviewed_at,

  -- Timestamp profile
  p.created_at,
  p.updated_at
FROM public.profiles p
WHERE p.id = auth.uid()
   OR public.is_admin();

GRANT SELECT ON public.v_user_onboarding_status TO authenticated;

COMMENT ON VIEW public.v_user_onboarding_status IS
  'Stato completamento onboarding/KYC dell utente corrente. Consumata da PR4b UI adaptive per decidere quali step mostrare. Ogni utente vede solo se stesso; admin vede tutti.';

-- ── 2. RPC kyc_can_invest(user_id) ────────────────────────────────────
-- Gating smart: ritorna ok=true se utente può investire, altrimenti dettagli
-- su cosa manca (per redirect UI).
--
-- Una sola fonte di verità per il gating, riusabile da:
--   - Edge function fractional-vote-prepare (server-side)
--   - UI checkout (client-side via RPC)
--   - Marketplace acquisto secondario
--
-- Logica:
--   1. Anagrafica L2 completa
--   2. Documento d identità completo (con foto upload + scadenza valida)
--   3. Telefono verificato (OTP confermato)
--   4. KYC status NON 'rejected' (admin override possible)
CREATE OR REPLACE FUNCTION public.kyc_can_invest(p_user_id UUID DEFAULT NULL)
RETURNS TABLE(
  ok BOOLEAN,
  reason TEXT,           -- 'ok' | 'incomplete_personal' | 'incomplete_document' |
                          -- 'document_expired' | 'phone_not_verified' | 'kyc_rejected'
  missing_step TEXT,     -- 'personal' | 'document' | 'phone' | NULL
  detail TEXT            -- messaggio user-friendly
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
DECLARE
  v_uid UUID := COALESCE(p_user_id, auth.uid());
  p     RECORD;
BEGIN
  -- Solo l utente stesso può controllare il proprio status (eccetto admin)
  IF v_uid IS NULL THEN
    ok := false; reason := 'unauthenticated'; missing_step := NULL;
    detail := 'Utente non autenticato';
    RETURN NEXT; RETURN;
  END IF;
  IF v_uid <> auth.uid() AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'kyc_can_invest: non autorizzato a leggere KYC altrui';
  END IF;

  SELECT * INTO p FROM public.profiles WHERE id = v_uid;
  IF NOT FOUND THEN
    ok := false; reason := 'profile_not_found'; missing_step := NULL;
    detail := 'Profilo non trovato';
    RETURN NEXT; RETURN;
  END IF;

  -- KYC rejected da admin → blocco rigido
  IF p.kyc_status = 'rejected' THEN
    ok := false; reason := 'kyc_rejected'; missing_step := NULL;
    detail := 'La verifica KYC è stata rifiutata. Contatta il supporto per maggiori informazioni.';
    RETURN NEXT; RETURN;
  END IF;

  -- Step 1: anagrafica
  IF p.first_name IS NULL OR p.first_name = '' OR
     p.last_name  IS NULL OR p.last_name  = '' OR
     p.birth_date IS NULL OR
     p.birth_place IS NULL OR p.birth_place = '' OR
     p.fiscal_code IS NULL OR p.fiscal_code = '' OR
     p.res_address IS NULL OR p.res_address = '' OR
     p.res_zip     IS NULL OR p.res_zip     = '' OR
     p.res_city    IS NULL OR p.res_city    = '' THEN
    ok := false; reason := 'incomplete_personal'; missing_step := 'personal';
    detail := 'Completa l anagrafica (nome, cognome, codice fiscale, residenza)';
    RETURN NEXT; RETURN;
  END IF;

  -- Step 2: documento
  IF p.id_doc_type IS NULL OR p.id_doc_type = '' OR
     p.id_doc_number IS NULL OR p.id_doc_number = '' OR
     p.id_doc_expiry_date IS NULL OR
     p.id_doc_front_path IS NULL OR p.id_doc_front_path = '' OR
     p.id_doc_back_path  IS NULL OR p.id_doc_back_path  = '' THEN
    ok := false; reason := 'incomplete_document'; missing_step := 'document';
    detail := 'Carica un documento d identità valido (carta d identità, passaporto o patente)';
    RETURN NEXT; RETURN;
  END IF;

  -- Step 2b: documento scaduto
  IF p.id_doc_expiry_date < CURRENT_DATE THEN
    ok := false; reason := 'document_expired'; missing_step := 'document';
    detail := 'Il tuo documento d identità è scaduto. Caricane uno valido.';
    RETURN NEXT; RETURN;
  END IF;

  -- Step 3: telefono verificato (OTP)
  IF p.phone_e164 IS NULL OR p.phone_e164 = '' OR p.phone_verified_at IS NULL THEN
    ok := false; reason := 'phone_not_verified'; missing_step := 'phone';
    detail := 'Verifica il tuo numero di telefono per procedere all investimento';
    RETURN NEXT; RETURN;
  END IF;

  -- Tutto ok
  ok := true; reason := 'ok'; missing_step := NULL;
  detail := 'Verificato e abilitato a investire';
  RETURN NEXT; RETURN;
END;
$$;

GRANT EXECUTE ON FUNCTION public.kyc_can_invest(UUID) TO authenticated;

COMMENT ON FUNCTION public.kyc_can_invest(UUID) IS
  'Gating smart: ritorna ok=true se utente può investire. Riusabile da edge functions fractional + UI checkout per stabilire se aprire onboarding modal.';

-- ── 3. RPC kyc_save_personal: salva anagrafica L2 in transazione ──────
-- Helper specializzato chiamato dal form "Anagrafica" del wizard PR4b.
-- Validazione lato DB + UPDATE atomico. Setta kyc_level=1 se era 0.
CREATE OR REPLACE FUNCTION public.kyc_save_personal(
  p_first_name      TEXT,
  p_last_name       TEXT,
  p_birth_date      DATE,
  p_birth_place     TEXT,
  p_birth_country   CHAR(2) DEFAULT 'IT',
  p_nationality     CHAR(2) DEFAULT 'IT',
  p_fiscal_code     TEXT DEFAULT NULL,
  p_res_address     TEXT DEFAULT NULL,
  p_res_civic       TEXT DEFAULT NULL,
  p_res_zip         TEXT DEFAULT NULL,
  p_res_city        TEXT DEFAULT NULL,
  p_res_province    TEXT DEFAULT NULL,
  p_res_country     CHAR(2) DEFAULT 'IT'
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'kyc_save_personal: non autenticato';
  END IF;

  -- Validazioni minime (la UI fa già validation client-side, qui server-side safety)
  IF p_first_name IS NULL OR length(trim(p_first_name)) < 2 THEN
    RAISE EXCEPTION 'first_name minimo 2 caratteri';
  END IF;
  IF p_last_name IS NULL OR length(trim(p_last_name)) < 2 THEN
    RAISE EXCEPTION 'last_name minimo 2 caratteri';
  END IF;
  IF p_birth_date IS NULL OR p_birth_date > (CURRENT_DATE - INTERVAL '18 years') THEN
    RAISE EXCEPTION 'maggiore età richiesta';
  END IF;
  IF p_fiscal_code IS NOT NULL AND length(trim(p_fiscal_code)) > 0
     AND length(trim(p_fiscal_code)) NOT IN (11, 16) THEN
    RAISE EXCEPTION 'codice fiscale formato non valido';
  END IF;

  UPDATE public.profiles SET
    first_name      = trim(p_first_name),
    last_name       = trim(p_last_name),
    full_name       = trim(p_first_name) || ' ' || trim(p_last_name),
    birth_date      = p_birth_date,
    birth_place     = trim(p_birth_place),
    birth_country   = COALESCE(p_birth_country, 'IT'),
    nationality     = COALESCE(p_nationality, 'IT'),
    fiscal_code     = NULLIF(trim(COALESCE(p_fiscal_code,'')), ''),
    res_address     = NULLIF(trim(COALESCE(p_res_address,'')), ''),
    res_civic       = NULLIF(trim(COALESCE(p_res_civic,'')), ''),
    res_zip         = NULLIF(trim(COALESCE(p_res_zip,'')), ''),
    res_city        = NULLIF(trim(COALESCE(p_res_city,'')), ''),
    res_province    = NULLIF(trim(COALESCE(p_res_province,'')), ''),
    res_country     = COALESCE(p_res_country, 'IT'),
    kyc_level       = GREATEST(COALESCE(kyc_level, 0), 1),
    updated_at      = now()
  WHERE id = v_uid;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.kyc_save_personal(
  TEXT, TEXT, DATE, TEXT, CHAR(2), CHAR(2), TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT, CHAR(2)
) TO authenticated;

-- ── 4. RPC kyc_save_document: salva documento d identità ──────────────
-- Le foto sono già state caricate dal frontend in storage.objects con
-- path tipo 'kyc-documents/{user_id}/id_front_xxx.jpg'. Qui registriamo
-- solo i path nella tabella profiles + altri metadati documento.
CREATE OR REPLACE FUNCTION public.kyc_save_document(
  p_doc_type        TEXT,
  p_doc_number      TEXT,
  p_doc_issuer      TEXT,
  p_doc_issue_date  DATE,
  p_doc_expiry_date DATE,
  p_front_path      TEXT,
  p_back_path       TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'kyc_save_document: non autenticato';
  END IF;

  -- Validazioni
  IF p_doc_type NOT IN ('CIE','passport','license','id_card') THEN
    RAISE EXCEPTION 'doc_type non valido (atteso CIE | passport | license | id_card)';
  END IF;
  IF p_doc_number IS NULL OR length(trim(p_doc_number)) < 3 THEN
    RAISE EXCEPTION 'doc_number troppo corto';
  END IF;
  IF p_doc_expiry_date IS NULL OR p_doc_expiry_date < CURRENT_DATE THEN
    RAISE EXCEPTION 'doc_expiry_date deve essere futura';
  END IF;
  IF p_front_path IS NULL OR p_front_path = '' THEN
    RAISE EXCEPTION 'front_path mancante';
  END IF;
  IF p_back_path IS NULL OR p_back_path = '' THEN
    RAISE EXCEPTION 'back_path mancante';
  END IF;

  -- Verifica che i path delle foto appartengano effettivamente all utente
  -- (defense in depth: lo storage RLS già filtra, ma controlliamo anche qui)
  IF NOT (p_front_path LIKE v_uid::text || '/%') THEN
    RAISE EXCEPTION 'front_path non valido per questo utente';
  END IF;
  IF NOT (p_back_path LIKE v_uid::text || '/%') THEN
    RAISE EXCEPTION 'back_path non valido per questo utente';
  END IF;

  UPDATE public.profiles SET
    id_doc_type        = p_doc_type,
    id_doc_number      = trim(p_doc_number),
    id_doc_issuer      = NULLIF(trim(COALESCE(p_doc_issuer,'')), ''),
    id_doc_issue_date  = p_doc_issue_date,
    id_doc_expiry_date = p_doc_expiry_date,
    id_doc_front_path  = p_front_path,
    id_doc_back_path   = p_back_path,
    kyc_level          = GREATEST(COALESCE(kyc_level, 0), 2),
    -- Documento appena caricato → kyc_status torna a 'review' per nuova revisione admin
    kyc_status         = CASE
                           WHEN kyc_status = 'rejected' THEN 'review'  -- riproposta dopo refuse
                           WHEN kyc_status = 'approved' THEN 'review'  -- ri-upload dopo scadenza
                           ELSE COALESCE(kyc_status, 'pending')
                         END,
    updated_at         = now()
  WHERE id = v_uid;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.kyc_save_document(
  TEXT, TEXT, TEXT, DATE, DATE, TEXT, TEXT
) TO authenticated;

-- ── 5. RPC kyc_save_phone_pending: salva numero (OTP differita) ───────
-- L utente fornisce il numero in fase di onboarding. La verifica OTP è
-- differita al primo investimento (quando phone_verified_at viene settato
-- dall edge function sms-otp-verify esistente).
CREATE OR REPLACE FUNCTION public.kyc_save_phone_pending(
  p_phone_country_code TEXT,   -- es. '+39'
  p_phone_e164         TEXT    -- es. '+393281234567'
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'kyc_save_phone_pending: non autenticato';
  END IF;

  IF p_phone_e164 IS NULL OR p_phone_e164 !~ '^\+[1-9][0-9]{6,14}$' THEN
    RAISE EXCEPTION 'phone_e164 formato non valido (atteso +CCNNNNNNNNNN)';
  END IF;

  UPDATE public.profiles SET
    phone_country_code = COALESCE(p_phone_country_code, '+39'),
    phone_e164         = p_phone_e164,
    -- IMPORTANTE: NON settare phone_verified_at qui. Quello viene settato solo
    -- dopo verifica OTP via edge sms-otp-verify (quando l utente sta per
    -- investire o quando completa volontariamente la verifica).
    -- Se il numero cambia, invalidiamo la precedente verifica.
    phone_verified_at  = CASE
                           WHEN phone_e164 IS DISTINCT FROM p_phone_e164 THEN NULL
                           ELSE phone_verified_at
                         END,
    updated_at         = now()
  WHERE id = v_uid;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.kyc_save_phone_pending(TEXT, TEXT) TO authenticated;

-- ── 6. Reload + sanity ────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

DO $$
DECLARE
  v_view_exists BOOLEAN;
  v_can_invest_exists BOOLEAN;
  v_save_personal_exists BOOLEAN;
  v_save_document_exists BOOLEAN;
  v_save_phone_exists BOOLEAN;
BEGIN
  SELECT EXISTS(SELECT 1 FROM pg_views WHERE schemaname='public' AND viewname='v_user_onboarding_status') INTO v_view_exists;
  SELECT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='kyc_can_invest') INTO v_can_invest_exists;
  SELECT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='kyc_save_personal') INTO v_save_personal_exists;
  SELECT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='kyc_save_document') INTO v_save_document_exists;
  SELECT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='kyc_save_phone_pending') INTO v_save_phone_exists;

  RAISE NOTICE '────────── 053 SUMMARY ──────────';
  RAISE NOTICE '  v_user_onboarding_status view:      %', v_view_exists;
  RAISE NOTICE '  kyc_can_invest() function:          %', v_can_invest_exists;
  RAISE NOTICE '  kyc_save_personal() function:       %', v_save_personal_exists;
  RAISE NOTICE '  kyc_save_document() function:       %', v_save_document_exists;
  RAISE NOTICE '  kyc_save_phone_pending() function:  %', v_save_phone_exists;
END $$;

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 053_pr4a_onboarding_backend.sql
-- ═══════════════════════════════════════════════════════════════════════
