-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Modulo Contratti — PR1 #1/4
--  Migration 033: anagrafica utente KYC L2/L3 + audit consensi GDPR
--
--  Estende `profiles` con i campi necessari per:
--   • compilazione anagrafica completa per firma contratti FEA
--   • adempimento KYC ex D.Lgs. 231/2007 (PEP, fonte fondi sopra €15k/12m)
--   • consensi GDPR granulari ex art. 6/7 Reg. UE 2016/679
--   • registrazione documento d'identità (CI/Patente/Passaporto)
--
--  Tutto additivo, nullable di default per popolamento progressivo.
--  Nessuna rottura di schema esistente.
-- ═══════════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════════
--  1) Estensione profiles — anagrafica L2 (persona fisica)
-- ══════════════════════════════════════════════════════════════════════
ALTER TABLE public.profiles
  -- Nome completo già presente in `full_name`, ma serve scomposto per i contratti
  ADD COLUMN IF NOT EXISTS first_name             TEXT,
  ADD COLUMN IF NOT EXISTS last_name              TEXT,
  ADD COLUMN IF NOT EXISTS birth_date             DATE,
  ADD COLUMN IF NOT EXISTS birth_place            TEXT,
  ADD COLUMN IF NOT EXISTS birth_country          CHAR(2) DEFAULT 'IT',
  ADD COLUMN IF NOT EXISTS nationality            CHAR(2) DEFAULT 'IT',
  ADD COLUMN IF NOT EXISTS fiscal_code            TEXT,

  -- Documento d'identità (Q7: tutti e 3 accettati)
  ADD COLUMN IF NOT EXISTS id_doc_type            TEXT,
  ADD COLUMN IF NOT EXISTS id_doc_number          TEXT,
  ADD COLUMN IF NOT EXISTS id_doc_issuer          TEXT,
  ADD COLUMN IF NOT EXISTS id_doc_issue_date      DATE,
  ADD COLUMN IF NOT EXISTS id_doc_expiry_date     DATE,
  ADD COLUMN IF NOT EXISTS id_doc_front_path      TEXT,    -- Storage path privato
  ADD COLUMN IF NOT EXISTS id_doc_back_path       TEXT,

  -- Residenza
  ADD COLUMN IF NOT EXISTS res_address            TEXT,
  ADD COLUMN IF NOT EXISTS res_civic              TEXT,
  ADD COLUMN IF NOT EXISTS res_zip                TEXT,
  ADD COLUMN IF NOT EXISTS res_city               TEXT,
  ADD COLUMN IF NOT EXISTS res_province           TEXT,
  ADD COLUMN IF NOT EXISTS res_country            CHAR(2) DEFAULT 'IT',

  -- Telefono normalizzato E.164 + verifica
  ADD COLUMN IF NOT EXISTS phone_country_code     TEXT DEFAULT '+39',
  ADD COLUMN IF NOT EXISTS phone_e164             TEXT,
  ADD COLUMN IF NOT EXISTS phone_verified_at      TIMESTAMPTZ,

  -- Compliance L3 (KYC rinforzato sopra €15k cumulativi/12m)
  ADD COLUMN IF NOT EXISTS pep_self               BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS pep_relative           BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS pep_details            TEXT,
  ADD COLUMN IF NOT EXISTS source_of_funds        TEXT,
  ADD COLUMN IF NOT EXISTS source_of_funds_notes  TEXT,

  -- Stato KYC (livello + workflow)
  ADD COLUMN IF NOT EXISTS kyc_level              INT  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS kyc_status             TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS kyc_completed_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS kyc_reviewer_id        UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS kyc_review_notes       TEXT,

  -- Consensi GDPR granulari (timestamp = data accettazione)
  ADD COLUMN IF NOT EXISTS gdpr_privacy_accepted_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gdpr_tos_accepted_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gdpr_marketing_accepted       BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS gdpr_marketing_accepted_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gdpr_profiling_accepted       BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS gdpr_profiling_accepted_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gdpr_third_party_accepted     BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS gdpr_third_party_accepted_at  TIMESTAMPTZ;


-- ══════════════════════════════════════════════════════════════════════
--  2) Vincoli soft (CHECK enum + range)
-- ══════════════════════════════════════════════════════════════════════
-- I CHECK constraint vengono aggiunti con NOT VALID per non rompere su dati legacy
DO $$
BEGIN
  -- id_doc_type
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='profiles_id_doc_type_chk') THEN
    ALTER TABLE profiles
      ADD CONSTRAINT profiles_id_doc_type_chk
      CHECK (id_doc_type IS NULL OR id_doc_type IN ('CI','PATENTE','PASSAPORTO'))
      NOT VALID;
  END IF;

  -- kyc_status
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='profiles_kyc_status_chk') THEN
    ALTER TABLE profiles
      ADD CONSTRAINT profiles_kyc_status_chk
      CHECK (kyc_status IN ('pending','review','approved','rejected'))
      NOT VALID;
  END IF;

  -- kyc_level 0..3
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='profiles_kyc_level_chk') THEN
    ALTER TABLE profiles
      ADD CONSTRAINT profiles_kyc_level_chk
      CHECK (kyc_level BETWEEN 0 AND 3)
      NOT VALID;
  END IF;

  -- source_of_funds enum (se compilato)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='profiles_source_of_funds_chk') THEN
    ALTER TABLE profiles
      ADD CONSTRAINT profiles_source_of_funds_chk
      CHECK (source_of_funds IS NULL OR source_of_funds IN
        ('reddito_lavoro','risparmi','vendita_immobile','eredita','impresa','altro'))
      NOT VALID;
  END IF;

  -- birth_date: maggiorenne (>= 18 anni alla data attuale)
  -- Non lo metto come CHECK per evitare problemi con dati incompleti durante l'onboarding.
  -- La validazione age >= 18 è applicata in Edge Function al momento del passaggio kyc_level=2.
END $$;


-- ══════════════════════════════════════════════════════════════════════
--  3) Indici unici parziali (deduplicano solo i valori validi e verificati)
-- ══════════════════════════════════════════════════════════════════════
-- Telefono univoco SOLO se verificato (evita lock su utenti senza telefono)
CREATE UNIQUE INDEX IF NOT EXISTS uq_profiles_phone_verified
  ON public.profiles(phone_e164)
  WHERE phone_e164 IS NOT NULL AND phone_verified_at IS NOT NULL;

-- CF univoco SOLO se compilato
CREATE UNIQUE INDEX IF NOT EXISTS uq_profiles_fiscal_code
  ON public.profiles(fiscal_code)
  WHERE fiscal_code IS NOT NULL AND length(fiscal_code) >= 11;

-- Indice di lavoro per KYC review queue (admin)
CREATE INDEX IF NOT EXISTS idx_profiles_kyc_status
  ON public.profiles(kyc_status, kyc_completed_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_profiles_kyc_level
  ON public.profiles(kyc_level);


-- ══════════════════════════════════════════════════════════════════════
--  4) gdpr_consent_log — accountability ex art. 5(2) GDPR
-- ══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.gdpr_consent_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  consent_key   TEXT NOT NULL,            -- 'privacy' | 'tos' | 'marketing' | 'profiling' | 'third_party'
  old_value     JSONB,
  new_value     JSONB NOT NULL,
  ip            INET,
  user_agent    TEXT,
  source        TEXT,                     -- 'signup' | 'profile_page' | 'contract_sign' | 'admin_override'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gdpr_log_user
  ON public.gdpr_consent_log(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_gdpr_log_key
  ON public.gdpr_consent_log(consent_key, created_at DESC);

ALTER TABLE public.gdpr_consent_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS gdpr_log_self_select ON public.gdpr_consent_log;
CREATE POLICY gdpr_log_self_select ON public.gdpr_consent_log
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS gdpr_log_admin_select ON public.gdpr_consent_log;
CREATE POLICY gdpr_log_admin_select ON public.gdpr_consent_log
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- Niente policy INSERT/UPDATE/DELETE: scritture solo da Edge Function service_role


-- ══════════════════════════════════════════════════════════════════════
--  5) Trigger: log automatico dei cambiamenti di consenso GDPR
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.log_profile_gdpr_changes()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  src TEXT := COALESCE(current_setting('rareblock.consent_source', true), 'profile_page');
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Log eventuale consenso prestato a signup
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

  -- UPDATE: log SOLO se il campo cambia
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

DROP TRIGGER IF EXISTS trg_profile_gdpr_log ON public.profiles;
CREATE TRIGGER trg_profile_gdpr_log
  AFTER INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.log_profile_gdpr_changes();


-- ══════════════════════════════════════════════════════════════════════
--  6) Storage bucket privato per i documenti d'identità
-- ══════════════════════════════════════════════════════════════════════
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('kyc-documents', 'kyc-documents', false, 10485760,  -- 10MB max
        ARRAY['image/jpeg','image/png','image/webp','application/pdf'])
ON CONFLICT (id) DO NOTHING;

-- Policy: ognuno legge solo i propri file, admin legge tutti
DROP POLICY IF EXISTS "kyc_docs_self_read" ON storage.objects;
CREATE POLICY "kyc_docs_self_read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'kyc-documents' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "kyc_docs_self_insert" ON storage.objects;
CREATE POLICY "kyc_docs_self_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'kyc-documents' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "kyc_docs_self_update" ON storage.objects;
CREATE POLICY "kyc_docs_self_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'kyc-documents' AND (storage.foldername(name))[1] = auth.uid()::text)
  WITH CHECK (bucket_id = 'kyc-documents' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "kyc_docs_admin_all" ON storage.objects;
CREATE POLICY "kyc_docs_admin_all" ON storage.objects
  FOR ALL TO authenticated
  USING (bucket_id = 'kyc-documents' AND public.is_admin())
  WITH CHECK (bucket_id = 'kyc-documents' AND public.is_admin());


-- ══════════════════════════════════════════════════════════════════════
--  7) Reload PostgREST + verifica
-- ══════════════════════════════════════════════════════════════════════
NOTIFY pgrst, 'reload schema';

-- Smoke test: elenca i nuovi campi
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema='public' AND table_name='profiles'
  AND column_name IN (
    'first_name','last_name','birth_date','fiscal_code','id_doc_type',
    'phone_e164','phone_verified_at','kyc_level','kyc_status',
    'gdpr_privacy_accepted_at','gdpr_marketing_accepted'
  )
ORDER BY ordinal_position;

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 033_kyc_anagrafica.sql
-- ═══════════════════════════════════════════════════════════════════════
