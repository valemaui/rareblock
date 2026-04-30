-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Diagnostico schema profiles + force reload PostgREST cache
--  Esegui INTERO blocco, copia output sezioni A-D
-- ═══════════════════════════════════════════════════════════════════════

-- A. Le colonne 015 esistono fisicamente in DB?
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_schema='public' AND table_name='profiles'
  AND column_name IN ('status','suspended_at','suspension_reason','deleted_at')
ORDER BY column_name;
-- ATTESE: 4 righe. Se 0 → 015 non eseguita (o fallita)

-- B. Constraint CHECK su status presente?
SELECT con.conname, pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
WHERE rel.relname='profiles' AND con.contype='c';

-- C. Trigger status_audit attivo?
SELECT tgname, pg_get_triggerdef(oid) AS definition
FROM pg_trigger
WHERE tgrelid='public.profiles'::regclass AND NOT tgisinternal;

-- D. La view v_admin_users include i nuovi campi?
SELECT column_name FROM information_schema.columns
WHERE table_schema='public' AND table_name='v_admin_users'
ORDER BY ordinal_position;

-- ═══════════════════════════════════════════════════════════════════════
--  FORCE RELOAD PostgREST schema cache
--  Se le colonne esistono in A ma l'API ritorna 42703, è cache stale.
-- ═══════════════════════════════════════════════════════════════════════
NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════
--  REPLAY 015 idempotente (sicuro: non duplica nulla)
--  Esegui se A ritorna < 4 righe.
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS suspended_at      TIMESTAMPTZ;
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS suspension_reason TEXT;
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS deleted_at        TIMESTAMPTZ;

-- Aggiungi check constraint solo se manca
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_status_check'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_status_check
      CHECK (status IN ('active','suspended','deleted'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS profiles_status_idx ON public.profiles(status);

-- Ricrea view (sicuro DROP+CREATE)
DROP VIEW IF EXISTS public.v_admin_users;
CREATE VIEW public.v_admin_users
WITH (security_invoker = true)
AS
SELECT
  p.id,
  COALESCE(p.email, u.email) AS email,
  p.full_name,
  p.role,
  p.status,
  p.suspended_at,
  p.suspension_reason,
  p.deleted_at,
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

-- Ricrea trigger
CREATE OR REPLACE FUNCTION public.profiles_status_audit()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'suspended' AND OLD.status <> 'suspended' THEN
      NEW.suspended_at := now();
    ELSIF NEW.status = 'deleted' AND OLD.status <> 'deleted' THEN
      NEW.deleted_at := now();
    ELSIF NEW.status = 'active' THEN
      NEW.suspended_at := NULL;
      NEW.suspension_reason := NULL;
      NEW.deleted_at := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_status_audit_trg ON public.profiles;
CREATE TRIGGER profiles_status_audit_trg
  BEFORE UPDATE OF status ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_status_audit();

-- Force reload finale
NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════
--  TEST FINALE — query identica a quella che fa l'app
-- ═══════════════════════════════════════════════════════════════════════
SELECT id, email, role, status, suspended_at, deleted_at, can_collector, can_investor
FROM public.v_admin_users
LIMIT 3;
-- Se questo va, l'API funzionerà dopo schema reload (max 30s)
