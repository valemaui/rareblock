-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Modulo KYC — patch
--  Migration 043: aggiunge kyc_reviewed_at a profiles
--
--  La 033 aveva kyc_reviewer_id + kyc_review_notes ma non il timestamp
--  della review. PR8 (pannello admin KYC review) lo richiede per audit.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS kyc_reviewed_at TIMESTAMPTZ;

COMMENT ON COLUMN public.profiles.kyc_reviewed_at IS
  'Timestamp della review admin (approve/reject), valorizzato dal pannello admin KYC PR8.';

-- Notify PostgREST
NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 043_kyc_reviewed_at.sql
-- ═══════════════════════════════════════════════════════════════════════
