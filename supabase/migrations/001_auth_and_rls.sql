-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock Collector — Auth & Row Level Security
--  Esegui questo SQL nel Supabase SQL Editor (una volta sola)
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Aggiungi user_id alle tabelle esistenti ───────────────────────
ALTER TABLE cards
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE preventivi
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- ── 2. Index per performance ─────────────────────────────────────────
CREATE INDEX IF NOT EXISTS cards_user_id_idx      ON cards(user_id);
CREATE INDEX IF NOT EXISTS preventivi_user_id_idx ON preventivi(user_id);

-- ── 3. Attiva RLS sulle tabelle ──────────────────────────────────────
ALTER TABLE cards      ENABLE ROW LEVEL SECURITY;
ALTER TABLE preventivi ENABLE ROW LEVEL SECURITY;

-- ── 4. Policy: ogni utente vede e modifica SOLO i propri dati ────────
-- Rimuovi policy esistenti (idempotente)
DROP POLICY IF EXISTS "cards_select_own"  ON cards;
DROP POLICY IF EXISTS "cards_insert_own"  ON cards;
DROP POLICY IF EXISTS "cards_update_own"  ON cards;
DROP POLICY IF EXISTS "cards_delete_own"  ON cards;

DROP POLICY IF EXISTS "preventivi_select_own"  ON preventivi;
DROP POLICY IF EXISTS "preventivi_insert_own"  ON preventivi;
DROP POLICY IF EXISTS "preventivi_update_own"  ON preventivi;
DROP POLICY IF EXISTS "preventivi_delete_own"  ON preventivi;

-- Cards
CREATE POLICY "cards_select_own" ON cards
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "cards_insert_own" ON cards
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "cards_update_own" ON cards
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "cards_delete_own" ON cards
  FOR DELETE USING (auth.uid() = user_id);

-- Preventivi
CREATE POLICY "preventivi_select_own" ON preventivi
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "preventivi_insert_own" ON preventivi
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "preventivi_update_own" ON preventivi
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "preventivi_delete_own" ON preventivi
  FOR DELETE USING (auth.uid() = user_id);

-- ── 5. Migra dati esistenti ──────────────────────────────────────────
-- ATTENZIONE: esegui questa parte SOLO se hai dati esistenti da assegnare.
-- Sostituisci 'YOUR-USER-UUID' con il tuo UUID da Authentication > Users.
-- UPDATE cards      SET user_id = 'YOUR-USER-UUID' WHERE user_id IS NULL;
-- UPDATE preventivi SET user_id = 'YOUR-USER-UUID' WHERE user_id IS NULL;

-- ── 6. Note su auth.users ────────────────────────────────────────────
-- Supabase gestisce auth.users automaticamente.
-- Per invitare nuovi utenti: Authentication > Users > Invite User
-- Oppure abilita la self-registration nelle Auth Settings.
