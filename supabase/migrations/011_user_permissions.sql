-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Permessi binari Collector / Investor
--  Esegui nel Supabase SQL Editor (una volta sola)
--  Aggiunge colonne can_collector / can_investor alla tabella profiles
--  e abilita policy RLS lato admin per gestire utenti dal pannello.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Colonne permessi (default true → backward compatibility) ──────
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS can_collector BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS can_investor  BOOLEAN NOT NULL DEFAULT TRUE;

-- Email cache (read-only convenience per pannello admin)
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS email TEXT;

-- Index per filtri admin
CREATE INDEX IF NOT EXISTS profiles_role_idx          ON profiles(role);
CREATE INDEX IF NOT EXISTS profiles_can_collector_idx ON profiles(can_collector);
CREATE INDEX IF NOT EXISTS profiles_can_investor_idx  ON profiles(can_investor);

-- ── 2. Helper: is_admin() (SECURITY DEFINER → niente ricorsione RLS) ─
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND role = 'admin'
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, anon;

-- ── 3. Policy admin: vede / modifica TUTTI i profili ────────────────
DROP POLICY IF EXISTS "profiles_admin_all"    ON profiles;
DROP POLICY IF EXISTS "profiles_admin_select" ON profiles;
DROP POLICY IF EXISTS "profiles_admin_update" ON profiles;

CREATE POLICY "profiles_admin_select" ON profiles
  FOR SELECT USING ( public.is_admin() );

CREATE POLICY "profiles_admin_update" ON profiles
  FOR UPDATE USING ( public.is_admin() );

CREATE POLICY "profiles_admin_insert" ON profiles
  FOR INSERT WITH CHECK ( public.is_admin() OR auth.uid() = id );

-- ── 4. Trigger: copia email da auth.users → profiles.email ───────────
CREATE OR REPLACE FUNCTION sync_profile_email()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE profiles SET email = NEW.email WHERE id = NEW.id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_email_sync ON auth.users;
CREATE TRIGGER on_auth_user_email_sync
  AFTER INSERT OR UPDATE OF email ON auth.users
  FOR EACH ROW EXECUTE FUNCTION sync_profile_email();

-- Backfill email per profili esistenti
UPDATE profiles p
SET email = u.email
FROM auth.users u
WHERE p.id = u.id AND (p.email IS NULL OR p.email <> u.email);

-- Update handle_new_user per popolare anche email
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, full_name, email)
  VALUES (NEW.id, NEW.raw_user_meta_data->>'full_name', NEW.email)
  ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 5. View admin: lista utenti con ultimo accesso ───────────────────
-- Garantisce presenza colonne opzionali (potrebbero mancare se la migration
-- 005 non è stata eseguita o è stata modificata):
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS iban       TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS phone      TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS notes      TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS full_name  TEXT;

DROP VIEW IF EXISTS v_admin_users;
CREATE VIEW v_admin_users
WITH (security_invoker = true)
AS
SELECT
  p.id,
  COALESCE(p.email, u.email)         AS email,
  p.full_name,
  p.role,
  p.can_collector,
  p.can_investor,
  p.iban,
  p.phone,
  p.notes,
  p.created_at,
  u.last_sign_in_at,
  u.confirmed_at
FROM profiles p
LEFT JOIN auth.users u ON u.id = p.id;

GRANT SELECT ON v_admin_users TO authenticated;

-- Nota: la view applica security_invoker → eredita le policy RLS di profiles,
-- quindi solo admin (via profiles_admin_select) o owner vedono righe.

-- ── FINE ─────────────────────────────────────────────────────────────
