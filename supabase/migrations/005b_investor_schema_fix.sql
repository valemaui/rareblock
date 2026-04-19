-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Fix profiles table + Investor schema safe
--  Esegui questo nel Supabase SQL Editor (sostituisce 005)
--  È idempotente: sicuro da rieseguire più volte
-- ═══════════════════════════════════════════════════════════════════════

-- ── 0a. Adatta la tabella profiles esistente ─────────────────────────
-- La tabella esiste già con colonna "nome" — aggiungiamo solo ciò che manca

-- Aggiungi role se non esiste
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'investor';

-- Aggiungi full_name come alias/aggiunta (nome esiste già)
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS full_name TEXT;

-- Sincronizza full_name da nome se è NULL
UPDATE profiles SET full_name = nome WHERE full_name IS NULL AND nome IS NOT NULL;

-- Aggiungi gli altri campi mancanti
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS iban       TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS phone      TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS notes      TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();

-- RLS (idempotente con DROP IF EXISTS)
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_select_own" ON profiles;
DROP POLICY IF EXISTS "profiles_update_own" ON profiles;
CREATE POLICY "profiles_select_own" ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "profiles_update_own" ON profiles FOR UPDATE USING (auth.uid() = id);

-- ── 0b. Trigger signup — usa "nome" che già esiste ───────────────────
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, nome, full_name, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'nome', ''),
    NEW.raw_user_meta_data->>'full_name',
    'investor'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();


-- ── 1. inv_products ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inv_products (
  id                     UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_by             UUID REFERENCES auth.users(id),
  name                   TEXT NOT NULL,
  description            TEXT,
  type                   TEXT NOT NULL CHECK (type IN ('full','fractional','millesimal','grade_hold')),
  status                 TEXT NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft','open','closed','pending_grading',
                                             'grading_complete','hold','liquidated')),
  image_url              TEXT,
  tags                   TEXT[],
  total_quotes           INT  NOT NULL DEFAULT 100,
  quote_unit             TEXT DEFAULT 'quota',
  price_per_quote        NUMERIC(10,2) NOT NULL,
  min_quotes_per_order   INT  DEFAULT 1,
  max_quotes_per_order   INT,
  estimated_value        NUMERIC(10,2),
  target_date            DATE,
  hold_years             INT,
  storage_fee_annual     NUMERIC(10,2) DEFAULT 0,
  storage_fee_type       TEXT DEFAULT 'per_quota'
                           CHECK (storage_fee_type IN ('per_quota','flat')),
  grading_house          TEXT CHECK (grading_house IN ('PSA','BGS','CGC','CGS','ACE') OR grading_house IS NULL),
  grading_cost_estimated NUMERIC(10,2),
  grading_cost_actual    NUMERIC(10,2),
  grading_sent_at        DATE,
  grading_result         TEXT,
  grading_cert_number    TEXT,
  admin_notes            TEXT,
  created_at             TIMESTAMPTZ DEFAULT now(),
  updated_at             TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inv_products_status_idx ON inv_products(status);
CREATE INDEX IF NOT EXISTS inv_products_type_idx   ON inv_products(type);
ALTER TABLE inv_products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "inv_products_select" ON inv_products;
DROP POLICY IF EXISTS "inv_products_insert" ON inv_products;
DROP POLICY IF EXISTS "inv_products_update" ON inv_products;
CREATE POLICY "inv_products_select" ON inv_products
  FOR SELECT USING (status <> 'draft' OR auth.uid() = created_by);
CREATE POLICY "inv_products_insert" ON inv_products
  FOR INSERT WITH CHECK (auth.uid() = created_by);
CREATE POLICY "inv_products_update" ON inv_products
  FOR UPDATE USING (auth.uid() = created_by);


-- ── 2. inv_holdings ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inv_holdings (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id      UUID NOT NULL REFERENCES inv_products(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  qty             INT  NOT NULL DEFAULT 1,
  price_per_quote NUMERIC(10,2) NOT NULL,
  acquired_at     TIMESTAMPTZ DEFAULT now(),
  notes           TEXT,
  origin          TEXT DEFAULT 'primary'
                    CHECK (origin IN ('primary','secondary'))
);

CREATE INDEX IF NOT EXISTS inv_holdings_product_idx ON inv_holdings(product_id);
CREATE INDEX IF NOT EXISTS inv_holdings_user_idx    ON inv_holdings(user_id);
ALTER TABLE inv_holdings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "inv_holdings_select_own" ON inv_holdings;
DROP POLICY IF EXISTS "inv_holdings_insert_own" ON inv_holdings;
DROP POLICY IF EXISTS "inv_holdings_update_own" ON inv_holdings;
DROP POLICY IF EXISTS "inv_holdings_delete_own" ON inv_holdings;
-- Admin needs to read all holdings for transfers — use service role in app or relax:
CREATE POLICY "inv_holdings_select_own" ON inv_holdings FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "inv_holdings_insert_own" ON inv_holdings FOR INSERT WITH CHECK (true); -- inserimento consentito (admin e investor)
CREATE POLICY "inv_holdings_update_own" ON inv_holdings FOR UPDATE USING (true);
CREATE POLICY "inv_holdings_delete_own" ON inv_holdings FOR DELETE USING (true);


-- ── 3. inv_payments ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inv_payments (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product_id       UUID REFERENCES inv_products(id),
  transfer_id      UUID,
  holding_id       UUID,
  type             TEXT NOT NULL
                     CHECK (type IN ('purchase','secondary_buy','accrual','refund','liquidation')),
  amount           NUMERIC(10,2) NOT NULL,
  qty              INT  DEFAULT 1,
  method           TEXT NOT NULL DEFAULT 'bonifico'
                     CHECK (method IN ('bonifico','stripe','paypal','internal')),
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','confirmed','rejected','refunded')),
  bank_reference   TEXT,
  bank_sender      TEXT,
  received_at      DATE,
  gateway_id       TEXT,
  gateway_status   TEXT,
  confirmed_by     UUID REFERENCES auth.users(id),
  confirmed_at     TIMESTAMPTZ,
  rejection_reason TEXT,
  admin_notes      TEXT,
  created_at       TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inv_payments_user_idx    ON inv_payments(user_id);
CREATE INDEX IF NOT EXISTS inv_payments_product_idx ON inv_payments(product_id);
CREATE INDEX IF NOT EXISTS inv_payments_status_idx  ON inv_payments(status);
ALTER TABLE inv_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "inv_payments_select_own" ON inv_payments;
DROP POLICY IF EXISTS "inv_payments_insert_own" ON inv_payments;
DROP POLICY IF EXISTS "inv_payments_update_admin" ON inv_payments;
CREATE POLICY "inv_payments_select_own" ON inv_payments FOR SELECT USING (true); -- admin vede tutto
CREATE POLICY "inv_payments_insert_own" ON inv_payments FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "inv_payments_update_admin" ON inv_payments FOR UPDATE USING (true); -- admin aggiorna status


-- ── 4. inv_transfers ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inv_transfers (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id   UUID NOT NULL REFERENCES inv_products(id),
  seller_id    UUID NOT NULL REFERENCES auth.users(id),
  buyer_id     UUID REFERENCES auth.users(id),
  qty          INT  NOT NULL,
  ask_price    NUMERIC(10,2) NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','reserved','payment_pending','completed','cancelled')),
  notes        TEXT,
  expires_at   DATE,
  created_at   TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS inv_transfers_product_idx ON inv_transfers(product_id);
CREATE INDEX IF NOT EXISTS inv_transfers_seller_idx  ON inv_transfers(seller_id);
CREATE INDEX IF NOT EXISTS inv_transfers_status_idx  ON inv_transfers(status);
ALTER TABLE inv_transfers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "inv_transfers_select" ON inv_transfers;
DROP POLICY IF EXISTS "inv_transfers_insert" ON inv_transfers;
DROP POLICY IF EXISTS "inv_transfers_update" ON inv_transfers;
CREATE POLICY "inv_transfers_select" ON inv_transfers FOR SELECT USING (true);
CREATE POLICY "inv_transfers_insert" ON inv_transfers FOR INSERT WITH CHECK (auth.uid() = seller_id);
CREATE POLICY "inv_transfers_update" ON inv_transfers FOR UPDATE USING (true);


-- ── 5. inv_accruals ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inv_accruals (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id   UUID NOT NULL REFERENCES inv_products(id) ON DELETE CASCADE,
  created_by   UUID REFERENCES auth.users(id),
  category     TEXT NOT NULL
                 CHECK (category IN ('grading','storage','shipping','unexpected','other')),
  description  TEXT NOT NULL,
  total_amount NUMERIC(10,2) NOT NULL,
  accrual_date DATE NOT NULL DEFAULT CURRENT_DATE,
  is_settled   BOOL DEFAULT false,
  notes        TEXT,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inv_accruals_product_idx ON inv_accruals(product_id);
ALTER TABLE inv_accruals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "inv_accruals_select" ON inv_accruals;
DROP POLICY IF EXISTS "inv_accruals_insert" ON inv_accruals;
DROP POLICY IF EXISTS "inv_accruals_update" ON inv_accruals;
CREATE POLICY "inv_accruals_select" ON inv_accruals FOR SELECT USING (true);
CREATE POLICY "inv_accruals_insert" ON inv_accruals FOR INSERT WITH CHECK (true); -- solo admin in pratica
CREATE POLICY "inv_accruals_update" ON inv_accruals FOR UPDATE USING (true);


-- ── 6. inv_liquidations ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inv_liquidations (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id     UUID NOT NULL REFERENCES inv_products(id),
  created_by     UUID REFERENCES auth.users(id),
  status         TEXT DEFAULT 'planned'
                   CHECK (status IN ('planned','processing','completed')),
  gross_amount   NUMERIC(10,2),
  fee_rareblock  NUMERIC(10,2) DEFAULT 0,
  net_amount     NUMERIC(10,2),
  per_quote      NUMERIC(10,2),
  planned_date   DATE,
  completed_date DATE,
  buyer_notes    TEXT,
  admin_notes    TEXT,
  created_at     TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE inv_liquidations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "inv_liquidations_select" ON inv_liquidations;
DROP POLICY IF EXISTS "inv_liquidations_insert" ON inv_liquidations;
DROP POLICY IF EXISTS "inv_liquidations_update" ON inv_liquidations;
CREATE POLICY "inv_liquidations_select" ON inv_liquidations FOR SELECT USING (true);
CREATE POLICY "inv_liquidations_insert" ON inv_liquidations FOR INSERT WITH CHECK (true);
CREATE POLICY "inv_liquidations_update" ON inv_liquidations FOR UPDATE USING (true);


-- ── 7. Vista quote per prodotto ──────────────────────────────────────
DROP VIEW IF EXISTS inv_product_stats;
CREATE VIEW inv_product_stats AS
SELECT
  p.id,
  p.total_quotes,
  COALESCE(SUM(h.qty), 0)::INT                 AS sold_quotes,
  p.total_quotes - COALESCE(SUM(h.qty), 0)     AS available_quotes,
  COALESCE(SUM(h.qty * h.price_per_quote), 0)  AS total_raised
FROM inv_products p
LEFT JOIN inv_holdings h ON h.product_id = p.id
GROUP BY p.id, p.total_quotes;

-- ── FINE ─────────────────────────────────────────────────────────────
-- Verifica colonne profiles dopo l'esecuzione:
-- SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'profiles';
