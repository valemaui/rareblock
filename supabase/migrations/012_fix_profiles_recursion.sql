-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Fix ricorsione policy profiles
--  Esegui DOPO 011_user_permissions.sql nel SQL Editor.
--
--  Bug: la policy profiles_admin_select chiamava is_admin() che a sua volta
--  faceva SELECT su profiles → ri-valutazione policy → ricorsione infinita
--  (errore 42P17). SECURITY DEFINER non basta a bypassare RLS in tutti i
--  contesti Supabase.
--
--  Soluzione: tabella di lookup admin_uids (UUID puri, no PII) sincronizzata
--  da trigger su profiles. is_admin() interroga admin_uids → niente ricorsione.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Drop policy ricorsive temporaneamente ────────────────────────
DROP POLICY IF EXISTS "profiles_admin_select" ON profiles;
DROP POLICY IF EXISTS "profiles_admin_update" ON profiles;
DROP POLICY IF EXISTS "profiles_admin_insert" ON profiles;
DROP POLICY IF EXISTS "profiles_admin_all"    ON profiles;

-- ── 2. Tabella lookup admin (no ricorsione) ─────────────────────────
CREATE TABLE IF NOT EXISTS public.admin_uids (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  promoted_at TIMESTAMPTZ DEFAULT now()
);

-- RLS permissiva: qualsiasi utente autenticato può leggere admin_uids
-- (contiene solo UUID, niente dati sensibili)
ALTER TABLE public.admin_uids ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admin_uids_select_all" ON public.admin_uids;
CREATE POLICY "admin_uids_select_all" ON public.admin_uids
  FOR SELECT TO authenticated USING (true);

-- Solo admin esistenti possono modificare admin_uids (via funzione SECURITY DEFINER)
-- Nessuna policy INSERT/UPDATE/DELETE → solo trigger SECURITY DEFINER può scrivere

-- ── 3. Sync da profiles.role ─────────────────────────────────────────
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

-- Backfill admin esistenti
INSERT INTO public.admin_uids (id)
  SELECT id FROM profiles WHERE role = 'admin'
  ON CONFLICT DO NOTHING;

-- ── 4. Sostituisci is_admin() — niente più query a profiles ─────────
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

-- ── 5. Ricrea policy admin su profiles (ora senza ricorsione) ───────
CREATE POLICY "profiles_admin_select" ON profiles
  FOR SELECT USING ( public.is_admin() );

CREATE POLICY "profiles_admin_update" ON profiles
  FOR UPDATE USING ( public.is_admin() );

CREATE POLICY "profiles_admin_insert" ON profiles
  FOR INSERT WITH CHECK ( public.is_admin() OR auth.uid() = id );

-- ── 6. Verifica ────────────────────────────────────────────────────
-- Esegui per controllare:
--   SELECT * FROM public.admin_uids;
--   SELECT public.is_admin();   -- dovrebbe ritornare true se sei admin
--   SELECT id, email, role FROM v_admin_users LIMIT 5;
