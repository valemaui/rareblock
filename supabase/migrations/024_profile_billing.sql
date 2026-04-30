-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Anagrafica fiscale nel profile
--  Aggiunge campi billing al profile per riuso nei checkout successivi.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS bill_is_company   BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS bill_email        TEXT,
  ADD COLUMN IF NOT EXISTS bill_fiscal_code  TEXT,
  ADD COLUMN IF NOT EXISTS bill_vat_number   TEXT,
  ADD COLUMN IF NOT EXISTS bill_pec          TEXT,
  ADD COLUMN IF NOT EXISTS bill_sdi_code     TEXT,
  ADD COLUMN IF NOT EXISTS bill_address      TEXT,
  ADD COLUMN IF NOT EXISTS bill_city         TEXT,
  ADD COLUMN IF NOT EXISTS bill_zip          TEXT,
  ADD COLUMN IF NOT EXISTS bill_country      TEXT DEFAULT 'IT';

-- Reload PostgREST cache
NOTIFY pgrst, 'reload schema';

-- Verifica
SELECT
  column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'profiles'
  AND column_name LIKE 'bill_%'
ORDER BY ordinal_position;
