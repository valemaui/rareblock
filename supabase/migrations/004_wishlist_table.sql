-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock Collector — Tabella wishlist
--  Esegui questo SQL nel Supabase SQL Editor (una volta sola)
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS wishlist (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  set_name    TEXT,
  condition   TEXT DEFAULT 'NM',
  language    TEXT DEFAULT 'ITA',
  max_price   NUMERIC(10,2),         -- prezzo massimo che vuoi pagare
  cm_avg30    NUMERIC(10,2),         -- prezzo di mercato aggiornato
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wishlist_user_id_idx ON wishlist(user_id);
CREATE INDEX IF NOT EXISTS wishlist_name_idx    ON wishlist(name);

ALTER TABLE wishlist ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wishlist_select_own" ON wishlist;
DROP POLICY IF EXISTS "wishlist_insert_own" ON wishlist;
DROP POLICY IF EXISTS "wishlist_update_own" ON wishlist;
DROP POLICY IF EXISTS "wishlist_delete_own" ON wishlist;

CREATE POLICY "wishlist_select_own" ON wishlist FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "wishlist_insert_own" ON wishlist FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "wishlist_update_own" ON wishlist FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "wishlist_delete_own" ON wishlist FOR DELETE USING (auth.uid() = user_id);
