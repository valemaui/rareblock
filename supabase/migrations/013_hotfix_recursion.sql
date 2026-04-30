-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — HOTFIX ricorsione profiles (one-shot, idempotente)
--  Esegui questo blocco INTERO nel SQL Editor.
--  Sostituisce 011 + 012 in modo sicuro su qualsiasi stato.
-- ═══════════════════════════════════════════════════════════════════════

-- 1. Rimuovi TUTTE le policy admin che potrebbero essere ricorsive
DROP POLICY IF EXISTS "profiles_admin_select" ON profiles;
DROP POLICY IF EXISTS "profiles_admin_update" ON profiles;
DROP POLICY IF EXISTS "profiles_admin_insert" ON profiles;
DROP POLICY IF EXISTS "profiles_admin_all"    ON profiles;

-- 2. Drop funzione vecchia (potrebbe essere quella che query profiles)
DROP FUNCTION IF EXISTS public.is_admin() CASCADE;

-- 3. Garantisci colonne
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS can_collector BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS can_investor  BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS email         TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS iban          TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS phone         TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS notes         TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS full_name     TEXT;

-- 4. Tabella admin_uids (lookup non ricorsivo)
CREATE TABLE IF NOT EXISTS public.admin_uids (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  promoted_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.admin_uids ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admin_uids_select_all" ON public.admin_uids;
CREATE POLICY "admin_uids_select_all" ON public.admin_uids
  FOR SELECT TO authenticated USING (true);

-- 5. Trigger sync da profiles.role
CREATE OR REPLACE FUNCTION sync_admin_uids()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    DELETE FROM public.admin_uids WHERE id = OLD.id;
    RETURN OLD;
  END IF;
  IF NEW.role = 'admin' THEN
    INSERT INTO public.admin_uids (id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM public.admin_uids WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS profiles_admin_sync ON profiles;
CREATE TRIGGER profiles_admin_sync
  AFTER INSERT OR UPDATE OF role OR DELETE ON profiles
  FOR EACH ROW EXECUTE FUNCTION sync_admin_uids();

-- 6. Backfill admin esistenti (eseguito come postgres → bypassa RLS)
INSERT INTO public.admin_uids (id)
  SELECT id FROM profiles WHERE role = 'admin'
  ON CONFLICT DO NOTHING;

-- 7. is_admin() che NON tocca profiles
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.admin_uids WHERE id = auth.uid()
  );
$$;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, anon;

-- 8. View admin (security_invoker → eredita RLS profiles)
DROP VIEW IF EXISTS v_admin_users;
CREATE VIEW v_admin_users
WITH (security_invoker = true)
AS
SELECT
  p.id,
  COALESCE(p.email, u.email) AS email,
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

-- 9. Policy admin (ora is_admin → admin_uids, niente ricorsione)
CREATE POLICY "profiles_admin_select" ON profiles
  FOR SELECT USING ( public.is_admin() );
CREATE POLICY "profiles_admin_update" ON profiles
  FOR UPDATE USING ( public.is_admin() );
CREATE POLICY "profiles_admin_insert" ON profiles
  FOR INSERT WITH CHECK ( public.is_admin() OR auth.uid() = id );

-- 10. Verifica — esegui SEPARATAMENTE dopo il blocco sopra:
--   SELECT * FROM public.admin_uids;
--   SELECT public.is_admin();
--   SELECT polname, pg_get_expr(polqual,polrelid) FROM pg_policy WHERE polrelid='profiles'::regclass;
