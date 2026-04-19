-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Area Investor: schema completo
--  Esegui nel Supabase SQL Editor (una volta sola, in ordine)
-- ═══════════════════════════════════════════════════════════════════════

-- ── 0. Profili utente con ruolo ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name  TEXT,
  role       TEXT NOT NULL DEFAULT 'investor', -- 'investor' | 'admin'
  iban       TEXT,       -- per accrediti liquidazione
  phone      TEXT,
  notes      TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "profiles_select_own" ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "profiles_update_own" ON profiles FOR UPDATE USING (auth.uid() = id);
-- admin può vedere tutti i profili — aggiorna con il tuo UUID admin
-- CREATE POLICY "profiles_admin_all"  ON profiles FOR ALL USING (
--   EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
-- );

-- Trigger: crea profilo automaticamente al signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, full_name)
  VALUES (NEW.id, NEW.raw_user_meta_data->>'full_name')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();


-- ── 1. Prodotti di investimento ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS inv_products (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_by            UUID REFERENCES auth.users(id),

  -- Identità
  name                  TEXT NOT NULL,
  description           TEXT,
  type                  TEXT NOT NULL CHECK (type IN ('full','fractional','millesimal','grade_hold')),
  status                TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','open','closed','pending_grading',
                                            'grading_complete','hold','liquidated')),
  image_url             TEXT,
  tags                  TEXT[],

  -- Quote
  total_quotes          INT NOT NULL DEFAULT 100,   -- n. quote totali
  quote_unit            TEXT DEFAULT 'quota',        -- 'quota','bustina','millesimo' ecc.
  price_per_quote       NUMERIC(10,2) NOT NULL,      -- prezzo al lancio
  min_quotes_per_order  INT DEFAULT 1,
  max_quotes_per_order  INT,                         -- NULL = illimitato

  -- Valore e timeline
  estimated_value       NUMERIC(10,2),               -- valore stimato prodotto
  target_date           DATE,                        -- data apertura / liquidazione
  hold_years            INT,                         -- anni previsti di hold (tipo 4)

  -- Costi storage
  storage_fee_annual    NUMERIC(10,2) DEFAULT 0,     -- € annui per quota
  storage_fee_type      TEXT DEFAULT 'per_quota'     -- 'per_quota' | 'flat'
                          CHECK (storage_fee_type IN ('per_quota','flat')),

  -- Gradazione (tipo 4)
  grading_house         TEXT CHECK (grading_house IN ('PSA','BGS','CGC','CGS','ACE',NULL)),
  grading_cost_estimated NUMERIC(10,2),
  grading_cost_actual   NUMERIC(10,2),
  grading_sent_at       DATE,
  grading_result        TEXT,      -- es. 'PSA 10'
  grading_cert_number   TEXT,

  -- Metadati
  admin_notes           TEXT,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inv_products_status_idx ON inv_products(status);
CREATE INDEX IF NOT EXISTS inv_products_type_idx   ON inv_products(type);
ALTER TABLE inv_products ENABLE ROW LEVEL SECURITY;

-- Tutti gli utenti autenticati vedono i prodotti non-draft
CREATE POLICY "inv_products_select" ON inv_products
  FOR SELECT USING (status <> 'draft' OR auth.uid() = created_by);
-- Solo admin inserisce/modifica (gestito lato app via check ruolo)
CREATE POLICY "inv_products_insert" ON inv_products
  FOR INSERT WITH CHECK (auth.uid() = created_by);
CREATE POLICY "inv_products_update" ON inv_products
  FOR UPDATE USING (auth.uid() = created_by);


-- ── 2. Quote detenute (holdings) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS inv_holdings (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id       UUID NOT NULL REFERENCES inv_products(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  qty              INT NOT NULL DEFAULT 1,
  price_per_quote  NUMERIC(10,2) NOT NULL,   -- prezzo effettivamente pagato
  acquired_at      TIMESTAMPTZ DEFAULT now(),
  notes            TEXT,

  -- per tracciare l'origine dell'acquisto
  origin           TEXT DEFAULT 'primary'    -- 'primary' | 'secondary'
                     CHECK (origin IN ('primary','secondary'))
);

CREATE INDEX IF NOT EXISTS inv_holdings_product_idx ON inv_holdings(product_id);
CREATE INDEX IF NOT EXISTS inv_holdings_user_idx    ON inv_holdings(user_id);
ALTER TABLE inv_holdings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "inv_holdings_select_own" ON inv_holdings FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "inv_holdings_insert_own" ON inv_holdings FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "inv_holdings_update_own" ON inv_holdings FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "inv_holdings_delete_own" ON inv_holdings FOR DELETE USING (auth.uid() = user_id);


-- ── 3. Pagamenti ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inv_payments (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product_id       UUID REFERENCES inv_products(id),
  transfer_id      UUID,            -- ref a inv_transfers se è pagamento secondario
  holding_id       UUID REFERENCES inv_holdings(id),

  type             TEXT NOT NULL    -- 'purchase' | 'secondary_buy' | 'accrual' | 'refund' | 'liquidation'
                     CHECK (type IN ('purchase','secondary_buy','accrual','refund','liquidation')),
  amount           NUMERIC(10,2) NOT NULL,
  qty              INT DEFAULT 1,

  method           TEXT NOT NULL DEFAULT 'bonifico'
                     CHECK (method IN ('bonifico','stripe','paypal','internal')),
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','confirmed','rejected','refunded')),

  -- Dettagli bonifico
  bank_reference   TEXT,
  bank_sender      TEXT,
  received_at      DATE,

  -- Dettagli stripe/paypal
  gateway_id       TEXT,
  gateway_status   TEXT,

  -- Admin
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
CREATE POLICY "inv_payments_select_own" ON inv_payments FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "inv_payments_insert_own" ON inv_payments FOR INSERT WITH CHECK (auth.uid() = user_id);


-- ── 4. Mercato secondario OTC ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inv_transfers (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id      UUID NOT NULL REFERENCES inv_products(id),
  seller_id       UUID NOT NULL REFERENCES auth.users(id),
  buyer_id        UUID REFERENCES auth.users(id),   -- NULL finché non c'è compratore

  qty             INT NOT NULL,
  ask_price       NUMERIC(10,2) NOT NULL,  -- prezzo richiesto dal venditore

  status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','reserved','payment_pending',
                                      'completed','cancelled')),
  notes           TEXT,
  expires_at      DATE,

  created_at      TIMESTAMPTZ DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS inv_transfers_product_idx ON inv_transfers(product_id);
CREATE INDEX IF NOT EXISTS inv_transfers_seller_idx  ON inv_transfers(seller_id);
CREATE INDEX IF NOT EXISTS inv_transfers_status_idx  ON inv_transfers(status);
ALTER TABLE inv_transfers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "inv_transfers_select" ON inv_transfers FOR SELECT USING (true);  -- tutti vedono le offerte
CREATE POLICY "inv_transfers_insert" ON inv_transfers FOR INSERT WITH CHECK (auth.uid() = seller_id);
CREATE POLICY "inv_transfers_update" ON inv_transfers FOR UPDATE
  USING (auth.uid() = seller_id OR auth.uid() = buyer_id);


-- ── 5. Accrual costi (modelli 3 e 4) ─────────────────────────────────
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
CREATE POLICY "inv_accruals_select" ON inv_accruals FOR SELECT USING (true);
CREATE POLICY "inv_accruals_insert" ON inv_accruals FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
);


-- ── 6. Liquidazioni ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inv_liquidations (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id      UUID NOT NULL REFERENCES inv_products(id),
  created_by      UUID REFERENCES auth.users(id),

  status          TEXT DEFAULT 'planned'
                    CHECK (status IN ('planned','processing','completed')),
  gross_amount    NUMERIC(10,2),      -- ricavato dalla vendita
  fee_rareblock   NUMERIC(10,2) DEFAULT 0,
  net_amount      NUMERIC(10,2),      -- netto distribuito
  per_quote       NUMERIC(10,2),      -- netto per singola quota
  planned_date    DATE,
  completed_date  DATE,
  buyer_notes     TEXT,
  admin_notes     TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE inv_liquidations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "inv_liquidations_select" ON inv_liquidations FOR SELECT USING (true);
CREATE POLICY "inv_liquidations_insert" ON inv_liquidations FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
);
CREATE POLICY "inv_liquidations_update" ON inv_liquidations FOR UPDATE USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
);

-- ── 7. Vista: quote disponibili per prodotto ─────────────────────────
CREATE OR REPLACE VIEW inv_product_stats AS
SELECT
  p.id,
  p.total_quotes,
  COALESCE(SUM(h.qty), 0)::INT                           AS sold_quotes,
  p.total_quotes - COALESCE(SUM(h.qty), 0)               AS available_quotes,
  COALESCE(SUM(h.qty * h.price_per_quote), 0)            AS total_raised
FROM inv_products p
LEFT JOIN inv_holdings h ON h.product_id = p.id
GROUP BY p.id, p.total_quotes;
