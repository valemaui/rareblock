-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Stato utente: active / suspended / deleted (soft-delete)
--  Esegui DOPO 014_diagnostic_nuclear.sql nel SQL Editor.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Colonna status + timestamp tracking ──────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','suspended','deleted'));

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS suspended_at      TIMESTAMPTZ;
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS suspension_reason TEXT;
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS deleted_at        TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS profiles_status_idx ON public.profiles(status);

-- ── 2. Aggiorna v_admin_users con i nuovi campi ────────────────────
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

-- ── 3. Helper: trigger auto-set timestamp su cambio status ──────────
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

-- ── 4. Verifica ────────────────────────────────────────────────────
-- SELECT id, email, role, status FROM public.v_admin_users LIMIT 10;
