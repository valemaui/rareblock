-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Tabella mastersets con RLS
--  Esegui nel Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════════════

-- Crea tabella (una riga per utente — JSON blob)
CREATE TABLE IF NOT EXISTS mastersets (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  data       TEXT NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT mastersets_user_unique UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS mastersets_user_id_idx ON mastersets(user_id);

ALTER TABLE mastersets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "mastersets_select_own" ON mastersets;
DROP POLICY IF EXISTS "mastersets_insert_own" ON mastersets;
DROP POLICY IF EXISTS "mastersets_update_own" ON mastersets;
DROP POLICY IF EXISTS "mastersets_delete_own" ON mastersets;

CREATE POLICY "mastersets_select_own" ON mastersets
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "mastersets_insert_own" ON mastersets
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "mastersets_update_own" ON mastersets
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "mastersets_delete_own" ON mastersets
  FOR DELETE USING (auth.uid() = user_id);
