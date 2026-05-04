-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Modulo Contratti — PR1 #3/4
--  Migration 036: parametri di piattaforma + tariffario custodia
--                  + override pricing su prodotti
--
--  NOTA: il numero 035 è riservato alla migration "contracts" che
--        sarà creata in PR6 (insieme ai template firmabili).
--
--  Contenuto:
--   • platform_settings (key/value JSONB) con:
--       - parametri commerciali (commissione default, validità offerta, ...)
--       - dati societari RareBlock (Q11, modificabili da admin)
--       - dati polizza assicurativa (Q15, modificabili da admin)
--       - parametri legali (foro competente)
--       - parametri club privato (B5.c: cap membri)
--   • platform_settings_history (audit trail dei cambi)
--   • custody_fee_tiers (Q4: tariffario custodia per fascia dimensionale)
--   • inv_products: campi override (custody_tier_code, custody_fee_override,
--     commission_pct_override) per gestire eccezioni puntuali
--   • view v_product_pricing (cascata override → vendor → default)
-- ═══════════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════════
--  1) platform_settings — key/value parametri amministrabili
-- ══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.platform_settings (
  key           TEXT PRIMARY KEY,
  value         JSONB NOT NULL,
  description   TEXT,
  category      TEXT NOT NULL DEFAULT 'general',
  is_sensitive  BOOLEAN NOT NULL DEFAULT false,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  CONSTRAINT settings_category_chk
    CHECK (category IN ('general','commercial','company','insurance','legal','club','feature_flag'))
);


-- ══════════════════════════════════════════════════════════════════════
--  2) platform_settings_history — audit trail (Q11: storico modifiche)
-- ══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.platform_settings_history (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key            TEXT NOT NULL,
  old_value      JSONB,
  new_value      JSONB NOT NULL,
  change_reason  TEXT,
  changed_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  changed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_settings_history_key
  ON public.platform_settings_history (key, changed_at DESC);


-- ══════════════════════════════════════════════════════════════════════
--  3) Trigger automatico per popolare lo storico ad ogni cambio valore
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.log_platform_settings_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
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

DROP TRIGGER IF EXISTS trg_platform_settings_history ON public.platform_settings;
CREATE TRIGGER trg_platform_settings_history
  AFTER INSERT OR UPDATE ON public.platform_settings
  FOR EACH ROW EXECUTE FUNCTION public.log_platform_settings_change();


-- ══════════════════════════════════════════════════════════════════════
--  4) RLS
-- ══════════════════════════════════════════════════════════════════════
ALTER TABLE public.platform_settings         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_settings_history ENABLE ROW LEVEL SECURITY;

-- Lettura pubblica dei NON-sensitive (servono per pre-fill dati societari nei contratti)
DROP POLICY IF EXISTS settings_read_non_sensitive ON public.platform_settings;
CREATE POLICY settings_read_non_sensitive ON public.platform_settings
  FOR SELECT TO authenticated
  USING (NOT is_sensitive);

-- Anon può leggere SOLO i feature_flag (es. mode banner pubblico)
DROP POLICY IF EXISTS settings_read_flags_anon ON public.platform_settings;
CREATE POLICY settings_read_flags_anon ON public.platform_settings
  FOR SELECT TO anon
  USING (NOT is_sensitive AND category = 'feature_flag');

-- Admin: tutto
DROP POLICY IF EXISTS settings_admin_all ON public.platform_settings;
CREATE POLICY settings_admin_all ON public.platform_settings
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Storia: solo admin
DROP POLICY IF EXISTS settings_history_admin ON public.platform_settings_history;
CREATE POLICY settings_history_admin ON public.platform_settings_history
  FOR SELECT TO authenticated
  USING (public.is_admin());


-- ══════════════════════════════════════════════════════════════════════
--  5) SEED iniziale dei parametri
-- ══════════════════════════════════════════════════════════════════════

-- ── 5a) Commerciali ───────────────────────────────────────────────────
INSERT INTO public.platform_settings (key, value, description, category) VALUES
  ('default_vendor_commission_pct', '15.0',
    'Commissione % default RareBlock al vendor (override su inv_vendors.commission_pct e inv_products.commission_pct_override)',
    'commercial'),
  ('contract_offer_validity_days', '7',
    'Giorni di validità della bozza contratto prima della scadenza automatica',
    'commercial'),
  ('custody_payment_grace_days', '60',
    'Giorni di tolleranza prima della vendita coatta per insoluto custodia (analogia art. 1782 c.c.)',
    'commercial'),
  ('contract_signed_retention_years', '10',
    'Anni di retention dei PDF contrattuali firmati (AML/231)',
    'commercial')
ON CONFLICT (key) DO NOTHING;


-- ── 5b) Dati societari RareBlock (Q11) ───────────────────────────────
INSERT INTO public.platform_settings (key, value, description, category) VALUES
  ('company_legal_name',
    '"DA COMPILARE"',
    'Ragione sociale completa di RareBlock', 'company'),
  ('company_legal_form',
    '"DA COMPILARE"',
    'Forma giuridica (SRL, SPA, ditta individuale, ...)', 'company'),
  ('company_vat',
    '"DA COMPILARE"',
    'Partita IVA', 'company'),
  ('company_fiscal_code',
    '"DA COMPILARE"',
    'Codice fiscale società', 'company'),
  ('company_rea',
    '"DA COMPILARE"',
    'Numero REA', 'company'),
  ('company_chamber',
    '"DA COMPILARE"',
    'CCIAA di iscrizione', 'company'),
  ('company_capital',
    '"DA COMPILARE"',
    'Capitale sociale i.v.', 'company'),
  ('company_pec',
    '"DA COMPILARE"',
    'Indirizzo PEC', 'company'),
  ('company_office_address',
    '{"street":"","civic":"","zip":"","city":"","province":"","country":"IT"}',
    'Sede legale (oggetto strutturato)', 'company'),
  ('company_email',
    '"info@rareblock.eu"',
    'Email contatti commerciali', 'company'),
  ('company_phone',
    '"DA COMPILARE"',
    'Telefono contatti', 'company'),
  ('legal_rep_name',
    '"DA COMPILARE"',
    'Nome e cognome del legale rappresentante', 'company'),
  ('legal_rep_fiscal_code',
    '"DA COMPILARE"',
    'CF del legale rappresentante', 'company'),
  ('legal_rep_role',
    '"Amministratore Unico"',
    'Ruolo del legale rappresentante (es. Amministratore Unico, Presidente CdA)', 'company')
ON CONFLICT (key) DO NOTHING;


-- ── 5c) Parametri legali ──────────────────────────────────────────────
INSERT INTO public.platform_settings (key, value, description, category) VALUES
  ('foro_competente',
    '"Tribunale di Messina"',
    'Foro per controversie B2B (con riserva consumatore ex art. 33 c. cons.)',
    'legal'),
  ('legge_applicabile',
    '"Legge italiana"',
    'Legge applicabile ai contratti',
    'legal')
ON CONFLICT (key) DO NOTHING;


-- ── 5d) Polizza assicurativa caveau (Q15) — SENSITIVE ────────────────
INSERT INTO public.platform_settings (key, value, description, category, is_sensitive) VALUES
  ('insurance_company',       '"DA COMPILARE"', 'Compagnia assicuratrice', 'insurance', true),
  ('insurance_policy_number', '"DA COMPILARE"', 'Numero di polizza',       'insurance', true),
  ('insurance_policy_type',
    '"All Risks da collezione"',
    'Tipologia di polizza',  'insurance', true),
  ('insurance_max_per_item',
    '"DA COMPILARE"',
    'Massimale per singolo oggetto (EUR)',  'insurance', true),
  ('insurance_max_aggregate',
    '"DA COMPILARE"',
    'Massimale aggregato annuo (EUR)',  'insurance', true),
  ('insurance_deductible',
    '"DA COMPILARE"',
    'Franchigia (EUR o %)',  'insurance', true),
  ('insurance_coverage_start',
    '"DA COMPILARE"',
    'Decorrenza copertura',  'insurance', true),
  ('insurance_coverage_end',
    '"DA COMPILARE"',
    'Scadenza polizza',  'insurance', true),
  ('insurance_exclusions',
    '"Forza maggiore non assicurabile, atti di guerra, terrorismo, eventi nucleari, vizi occulti antecedenti la consegna"',
    'Esclusioni di polizza',  'insurance', true),
  ('insurance_caveau_address',
    '"DA COMPILARE"',
    'Indirizzo del caveau di custodia',  'insurance', true)
ON CONFLICT (key) DO NOTHING;


-- ── 5e) Club privato chiuso (B5.c) ────────────────────────────────────
INSERT INTO public.platform_settings (key, value, description, category) VALUES
  ('club_max_members',
    '100',
    'Numero massimo membri attivi del Club RareBlock',
    'club'),
  ('club_admission_mode',
    '"invite_only"',
    'Modalità di ammissione: invite_only | application | hybrid',
    'club'),
  ('club_quote_kyc_text_version',
    '1',
    'Versione corrente del testo del questionario di consapevolezza per quotisti (B6)',
    'club')
ON CONFLICT (key) DO NOTHING;


-- ══════════════════════════════════════════════════════════════════════
--  6) custody_fee_tiers — tariffario per fascia dimensionale (Q4)
-- ══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.custody_fee_tiers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                TEXT UNIQUE NOT NULL,
  display_name        TEXT NOT NULL,
  description         TEXT,
  size_category       TEXT NOT NULL,        -- 'card' | 'sealed' | 'display'
  max_dimensions_cm   TEXT,                  -- '10x7x0.5' (info)
  annual_fee_cents    BIGINT NOT NULL,       -- es. 1200 = €12,00
  insurance_max_eur   BIGINT,                -- massimale assicurato per oggetto in tier
  is_active           BOOLEAN NOT NULL DEFAULT true,
  sort_order          INT NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT tier_size_chk
    CHECK (size_category IN ('card','sealed','display','custom')),
  CONSTRAINT tier_fee_positive
    CHECK (annual_fee_cents >= 0)
);

CREATE INDEX IF NOT EXISTS idx_custody_tiers_active
  ON public.custody_fee_tiers (is_active, sort_order)
  WHERE is_active;

ALTER TABLE public.custody_fee_tiers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS custody_tiers_read ON public.custody_fee_tiers;
CREATE POLICY custody_tiers_read ON public.custody_fee_tiers
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS custody_tiers_read_anon ON public.custody_fee_tiers;
CREATE POLICY custody_tiers_read_anon ON public.custody_fee_tiers
  FOR SELECT TO anon USING (is_active);

DROP POLICY IF EXISTS custody_tiers_admin ON public.custody_fee_tiers;
CREATE POLICY custody_tiers_admin ON public.custody_fee_tiers
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Seed iniziale: 8 fasce dimensionali
INSERT INTO public.custody_fee_tiers
  (code, display_name, description, size_category, max_dimensions_cm,
   annual_fee_cents, insurance_max_eur, sort_order) VALUES
  ('card_raw',    'Carta singola (no slab)',
    'Carta non gradata, in toploader o sleeve', 'card',  '9x6x0.1',     600,    500,  1),
  ('card_slab',   'Carta gradata (slab PSA/CGC/Beckett)',
    'Carta gradata in slab rigido',              'card',  '12x8x1.5',   1200,   5000,  2),
  ('booster_pack','Booster pack sigillato',
    'Singolo pack di carte sigillato',           'sealed','12x8x1',     1500,   3000,  3),
  ('etb',         'Elite Trainer Box',
    'Elite Trainer Box di formato standard',     'sealed','30x20x10',   3600,   2000,  4),
  ('box_small',   'Box piccolo (es. 36 booster pack)',
    'Booster box standard',                      'sealed','35x25x12',   4800,   5000,  5),
  ('box_medium',  'Box medio (case 6 box)',
    'Case sigillato 6 booster box',              'sealed','50x35x25',   8400,  20000,  6),
  ('case_large',  'Case grande (12+ box)',
    'Case sigillato 12+ booster box',            'sealed','60x40x30',  14400,  50000,  7),
  ('display',     'Display vintage da esposizione',
    'Display da esposizione (vintage/promo)',    'display','custom',   24000, 100000,  8)
ON CONFLICT (code) DO NOTHING;


-- ══════════════════════════════════════════════════════════════════════
--  7) Override su inv_products — eccezioni puntuali per Bene
-- ══════════════════════════════════════════════════════════════════════
ALTER TABLE public.inv_products
  ADD COLUMN IF NOT EXISTS custody_tier_code            TEXT REFERENCES public.custody_fee_tiers(code),
  ADD COLUMN IF NOT EXISTS custody_fee_override_cents   BIGINT,
  ADD COLUMN IF NOT EXISTS custody_fee_notes            TEXT,
  ADD COLUMN IF NOT EXISTS commission_pct_override      NUMERIC(5,2);

-- CHECK: override commissione 0..50%
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inv_products_commission_override_chk') THEN
    ALTER TABLE public.inv_products
      ADD CONSTRAINT inv_products_commission_override_chk
      CHECK (commission_pct_override IS NULL OR commission_pct_override BETWEEN 0 AND 50)
      NOT VALID;
  END IF;
END $$;


-- ══════════════════════════════════════════════════════════════════════
--  8) View: pricing effettivo per prodotto (cascata override)
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW public.v_product_pricing AS
SELECT
  p.id          AS product_id,
  p.name,
  p.vendor_id,
  -- Cascata: override Bene > override vendor > default piattaforma
  COALESCE(
    p.commission_pct_override,
    v.commission_pct,
    (SELECT (value::TEXT)::NUMERIC
       FROM public.platform_settings
      WHERE key = 'default_vendor_commission_pct')
  ) AS effective_commission_pct,
  p.custody_tier_code,
  -- Custody fee: override Bene > tariffa del tier
  COALESCE(
    p.custody_fee_override_cents,
    t.annual_fee_cents
  ) AS effective_custody_fee_cents,
  t.display_name        AS custody_tier_name,
  t.insurance_max_eur   AS insurance_max_for_tier,
  p.custody_fee_notes
FROM public.inv_products p
LEFT JOIN public.inv_vendors      v ON v.id   = p.vendor_id
LEFT JOIN public.custody_fee_tiers t ON t.code = p.custody_tier_code;

GRANT SELECT ON public.v_product_pricing TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  9) Reload PostgREST + verifica
-- ══════════════════════════════════════════════════════════════════════
NOTIFY pgrst, 'reload schema';

SELECT 'platform_settings'      AS table_name, COUNT(*) AS rows FROM public.platform_settings
UNION ALL
SELECT 'custody_fee_tiers',  COUNT(*) FROM public.custody_fee_tiers
ORDER BY table_name;

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 036_pricing_settings.sql
-- ═══════════════════════════════════════════════════════════════════════
