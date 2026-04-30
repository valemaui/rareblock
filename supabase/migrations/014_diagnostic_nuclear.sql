-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — DIAGNOSTIC + NUCLEAR CLEANUP profiles RLS
--  Esegui TUTTO il blocco. Le query SELECT alla fine mostrano lo stato.
--  Copia l'output dell'ultima sezione e mandamelo.
-- ═══════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────
--  STEP 1 — NUCLEAR: droppa OGNI policy su profiles, qualsiasi nome
-- ─────────────────────────────────────────────────────────────────
DO $$
DECLARE pol_name text;
BEGIN
  FOR pol_name IN
    SELECT polname FROM pg_policy WHERE polrelid = 'public.profiles'::regclass
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.profiles', pol_name);
    RAISE NOTICE 'Dropped policy: %', pol_name;
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────
--  STEP 2 — Droppa TUTTE le funzioni is_admin() in qualsiasi schema
--  (CASCADE rimuove anche eventuali dipendenze residue)
-- ─────────────────────────────────────────────────────────────────
DO $$
DECLARE fn record;
BEGIN
  FOR fn IN
    SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'is_admin'
  LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS %I.%I(%s) CASCADE', fn.nspname, fn.proname, fn.args);
    RAISE NOTICE 'Dropped function: %.%(%)', fn.nspname, fn.proname, fn.args;
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────
--  STEP 3 — Garantisci colonne profiles
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS can_collector BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS can_investor  BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS email         TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS iban          TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS phone         TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS notes         TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS full_name     TEXT;

-- ─────────────────────────────────────────────────────────────────
--  STEP 4 — admin_uids (lookup non ricorsivo)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.admin_uids (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  promoted_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.admin_uids ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE pol_name text;
BEGIN
  FOR pol_name IN
    SELECT polname FROM pg_policy WHERE polrelid = 'public.admin_uids'::regclass
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.admin_uids', pol_name);
  END LOOP;
END $$;

CREATE POLICY "admin_uids_select_all" ON public.admin_uids
  FOR SELECT TO authenticated USING (true);

-- ─────────────────────────────────────────────────────────────────
--  STEP 5 — Trigger sync e backfill admin
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sync_admin_uids()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
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
$$;

DROP TRIGGER IF EXISTS profiles_admin_sync ON public.profiles;
CREATE TRIGGER profiles_admin_sync
  AFTER INSERT OR UPDATE OF role OR DELETE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.sync_admin_uids();

INSERT INTO public.admin_uids (id)
  SELECT id FROM public.profiles WHERE role = 'admin'
  ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────
--  STEP 6 — is_admin() che NON tocca profiles
-- ─────────────────────────────────────────────────────────────────
CREATE FUNCTION public.is_admin()
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

-- ─────────────────────────────────────────────────────────────────
--  STEP 7 — Ricrea le 5 policy minime su profiles
-- ─────────────────────────────────────────────────────────────────
CREATE POLICY "profiles_select_own" ON public.profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "profiles_update_own" ON public.profiles
  FOR UPDATE USING (auth.uid() = id);

CREATE POLICY "profiles_admin_select" ON public.profiles
  FOR SELECT USING (public.is_admin());

CREATE POLICY "profiles_admin_update" ON public.profiles
  FOR UPDATE USING (public.is_admin());

CREATE POLICY "profiles_admin_insert" ON public.profiles
  FOR INSERT WITH CHECK (public.is_admin() OR auth.uid() = id);

-- ─────────────────────────────────────────────────────────────────
--  STEP 8 — View v_admin_users
-- ─────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.v_admin_users;
CREATE VIEW public.v_admin_users
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
FROM public.profiles p
LEFT JOIN auth.users u ON u.id = p.id;
GRANT SELECT ON public.v_admin_users TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════
--  STATO FINALE — ESEGUI QUESTE QUERY E COPIA L'OUTPUT
-- ═══════════════════════════════════════════════════════════════════════

-- A. Policy attualmente su profiles
SELECT polname AS policy, polcmd AS cmd,
       pg_get_expr(polqual, polrelid) AS using_expr,
       pg_get_expr(polwithcheck, polrelid) AS check_expr
FROM pg_policy
WHERE polrelid = 'public.profiles'::regclass
ORDER BY polname;

-- B. Funzioni is_admin esistenti
SELECT n.nspname AS schema, p.proname AS name,
       pg_get_function_identity_arguments(p.oid) AS args,
       pg_get_functiondef(p.oid) AS body
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.proname = 'is_admin';

-- C. Conta admin in admin_uids
SELECT COUNT(*) AS admin_count, array_agg(id) AS admin_ids
FROM public.admin_uids;

-- D. Test funzione is_admin (deve ritornare TRUE se sei admin)
SELECT public.is_admin() AS i_am_admin;

-- E. Test query diretta (NON deve dare ricorsione)
SELECT id, email, role, can_collector, can_investor
FROM public.profiles
WHERE id = auth.uid();
