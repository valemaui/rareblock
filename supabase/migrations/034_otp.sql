-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Modulo Contratti — PR1 #2/4
--  Migration 034: tabella OTP per verifica telefono e firma contratti FEA
--
--  Finalità:
--   • verifica iniziale del cellulare (purpose='phone_verify')
--   • firma elettronica avanzata di un contratto (purpose='contract_sign')
--   • azioni critiche future (purpose='critical_action')
--
--  Sicurezza:
--   • il codice è memorizzato SOLO come hash (bcrypt o crypto.subtle)
--     calcolato lato Edge Function — il DB non vede mai il codice in chiaro
--   • TTL 5 min (espresso in expires_at)
--   • max 3 tentativi (rinforzato da CHECK + logica server)
--   • RLS chiusa: solo service_role tramite Edge Function può leggere/scrivere
--
--  Riferimenti normativi: art. 26 Reg. UE 910/2014 (eIDAS) — FEA via SMS OTP
-- ═══════════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════════
--  1) Tabella otp_codes
-- ══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.otp_codes (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  phone_e164              TEXT NOT NULL,
  code_hash               TEXT NOT NULL,                  -- bcrypt o equivalente
  purpose                 TEXT NOT NULL,
  context_id              UUID,                            -- es. contract_id per firma
  attempts                INT  NOT NULL DEFAULT 0,
  max_attempts            INT  NOT NULL DEFAULT 3,
  expires_at              TIMESTAMPTZ NOT NULL,
  consumed_at             TIMESTAMPTZ,                     -- timestamp di validazione riuscita
  ip                      INET,
  user_agent              TEXT,
  channel                 TEXT,                            -- 'whatsapp' | 'sms'
  sms_provider            TEXT,                            -- 'twilio' | ...
  sms_provider_message_id TEXT,                            -- ID Twilio per audit
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT otp_purpose_chk
    CHECK (purpose IN ('phone_verify','contract_sign','critical_action')),
  CONSTRAINT otp_channel_chk
    CHECK (channel IS NULL OR channel IN ('whatsapp','sms')),
  CONSTRAINT otp_attempts_chk
    CHECK (attempts >= 0 AND attempts <= max_attempts),
  CONSTRAINT otp_max_attempts_chk
    CHECK (max_attempts BETWEEN 1 AND 10),
  CONSTRAINT otp_expiry_after_creation_chk
    CHECK (expires_at > created_at)
);


-- ══════════════════════════════════════════════════════════════════════
--  2) Indici
-- ══════════════════════════════════════════════════════════════════════
-- Lookup principale per rate-limit e ricerca attiva
CREATE INDEX IF NOT EXISTS idx_otp_user_purpose
  ON public.otp_codes (user_id, purpose, created_at DESC);

-- Anti-flood per numero (rate-limit oltre lo user)
CREATE INDEX IF NOT EXISTS idx_otp_phone
  ON public.otp_codes (phone_e164, created_at DESC);

-- Pulizia: indice partial sui non consumati
CREATE INDEX IF NOT EXISTS idx_otp_active
  ON public.otp_codes (expires_at)
  WHERE consumed_at IS NULL;

-- Audit: ricerca per context (es. tutti gli OTP di un contratto)
CREATE INDEX IF NOT EXISTS idx_otp_context
  ON public.otp_codes (context_id)
  WHERE context_id IS NOT NULL;


-- ══════════════════════════════════════════════════════════════════════
--  3) RLS — accesso completamente chiuso
-- ══════════════════════════════════════════════════════════════════════
ALTER TABLE public.otp_codes ENABLE ROW LEVEL SECURITY;

-- Nessuna policy permissiva = nessun accesso da authenticated/anon.
-- Le Edge Functions usano la service_role key che bypassa RLS.

-- Eccezione minima: l'utente può vedere quanti tentativi ha ancora
-- per il proprio OTP attivo (ma NON il code_hash). Questo richiede una VIEW.

CREATE OR REPLACE VIEW public.v_my_active_otp AS
SELECT
  id,
  purpose,
  context_id,
  attempts,
  max_attempts,
  expires_at,
  channel,
  created_at,
  -- Mostriamo il telefono mascherato (ultime 4 cifre)
  CASE
    WHEN length(phone_e164) >= 4
    THEN regexp_replace(phone_e164, '(.+)(\d{4})$', '*** \2')
    ELSE '***'
  END AS phone_masked
FROM public.otp_codes
WHERE user_id = auth.uid()
  AND consumed_at IS NULL
  AND expires_at > now();

GRANT SELECT ON public.v_my_active_otp TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  4) Funzione di cleanup (chiamabile da cron Supabase)
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.cleanup_expired_otp()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  deleted INT;
BEGIN
  WITH del AS (
    DELETE FROM public.otp_codes
    WHERE
      -- OTP scaduti da più di 7 giorni
      (expires_at < now() - INTERVAL '7 days')
      OR
      -- OTP consumati da più di 30 giorni (mantengo audit recente)
      (consumed_at IS NOT NULL AND consumed_at < now() - INTERVAL '30 days')
    RETURNING 1
  )
  SELECT COUNT(*) INTO deleted FROM del;
  RETURN deleted;
END $$;

REVOKE ALL ON FUNCTION public.cleanup_expired_otp() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_otp() TO service_role;


-- ══════════════════════════════════════════════════════════════════════
--  5) Helper di rate-limit (chiamabile da Edge Function)
--      Ritorna numero di OTP creati negli ultimi N minuti per
--      coppia (user, phone) — usato per applicare i limiti del §5.3:
--          • 5 OTP/ora per utente
--          • 10 OTP/giorno per numero
--          • 20 OTP/giorno per IP (lato Edge Function)
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.otp_count_recent(
  p_user_id UUID,
  p_phone   TEXT,
  p_window  INTERVAL
)
RETURNS TABLE (by_user INT, by_phone INT)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT
    COALESCE((SELECT COUNT(*)::INT FROM otp_codes
              WHERE user_id = p_user_id AND created_at > now() - p_window), 0) AS by_user,
    COALESCE((SELECT COUNT(*)::INT FROM otp_codes
              WHERE phone_e164 = p_phone AND created_at > now() - p_window), 0) AS by_phone;
$$;

REVOKE ALL ON FUNCTION public.otp_count_recent(UUID,TEXT,INTERVAL) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.otp_count_recent(UUID,TEXT,INTERVAL) TO service_role;


-- ══════════════════════════════════════════════════════════════════════
--  6) Reload PostgREST + verifica
-- ══════════════════════════════════════════════════════════════════════
NOTIFY pgrst, 'reload schema';

SELECT
  c.relname    AS table_name,
  c.relrowsecurity AS rls_enabled,
  (SELECT COUNT(*) FROM pg_policies WHERE schemaname='public' AND tablename='otp_codes') AS policies_count
FROM pg_class c
WHERE c.relname = 'otp_codes';

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 034_otp.sql
-- ═══════════════════════════════════════════════════════════════════════
