-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock Collector — Tabella vendite (sales)
--  Esegui questo SQL nel Supabase SQL Editor (una volta sola)
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS sales (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id           UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  card_id           UUID REFERENCES cards(id) ON DELETE SET NULL,
  name              TEXT NOT NULL,
  qty               INT NOT NULL DEFAULT 1,
  buy_price         NUMERIC(10,2) DEFAULT 0,
  sell_price_actual NUMERIC(10,2) NOT NULL,
  sold_at           DATE NOT NULL DEFAULT CURRENT_DATE,
  notes             TEXT,
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sales_user_id_idx ON sales(user_id);
CREATE INDEX IF NOT EXISTS sales_sold_at_idx  ON sales(sold_at);
CREATE INDEX IF NOT EXISTS sales_card_id_idx  ON sales(card_id);

ALTER TABLE sales ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sales_select_own" ON sales;
DROP POLICY IF EXISTS "sales_insert_own" ON sales;
DROP POLICY IF EXISTS "sales_update_own" ON sales;
DROP POLICY IF EXISTS "sales_delete_own" ON sales;

CREATE POLICY "sales_select_own" ON sales FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "sales_insert_own" ON sales FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "sales_update_own" ON sales FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "sales_delete_own" ON sales FOR DELETE USING (auth.uid() = user_id);

-- Vista opzionale: P&L per mese
-- CREATE VIEW sales_monthly_pl AS
-- SELECT
--   user_id,
--   to_char(sold_at, 'YYYY-MM') AS month,
--   SUM((sell_price_actual - buy_price) * qty) AS profit,
--   SUM(sell_price_actual * qty) AS revenue,
--   COUNT(*) AS sales_count
-- FROM sales
-- GROUP BY user_id, to_char(sold_at, 'YYYY-MM')
-- ORDER BY month DESC;
