-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Modulo Contratti — PR1 #4/4
--  Migration 037: Club privato chiuso (B5.c)
--
--  Modello:
--   • L'accesso alla Modalità B (acquisto di quote di comproprietà) è
--     riservato ai membri del Club.
--   • Ammissione gestita da admin (invite-only di default).
--   • Cap massimo membri letto da `platform_settings.club_max_members`.
--
--  NOTA: la tabella kyc_quote_acknowledgments (che registra le 3 spunte
--        di consapevolezza B6) richiede contracts.id come FK ed è quindi
--        rinviata a una migration successiva (sarà 038), in coppia con
--        035_contracts.sql in PR6.
-- ═══════════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════════
--  1) club_membership
-- ══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.club_membership (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL UNIQUE
                     REFERENCES auth.users(id) ON DELETE CASCADE,

  status             TEXT NOT NULL DEFAULT 'pending',

  -- Provenienza ammissione
  invited_by         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  application_notes  TEXT,             -- testo libero della richiesta

  -- Profilazione finanziaria autodichiarata (non MiFID-vincolante,
  -- solo per supporto admin nelle decisioni di ammissione)
  net_worth_band     TEXT,             -- '<500k'|'500k-1M'|'1M-5M'|'5M+'
  experience_years   INT,

  -- Note interne admin
  admin_notes        TEXT,

  -- Stato workflow
  admitted_at        TIMESTAMPTZ,
  admitted_by        UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  suspended_at       TIMESTAMPTZ,
  revoked_at         TIMESTAMPTZ,
  revoke_reason      TEXT,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT club_status_chk
    CHECK (status IN ('pending','active','suspended','revoked')),
  CONSTRAINT club_net_worth_chk
    CHECK (net_worth_band IS NULL OR net_worth_band IN ('<500k','500k-1M','1M-5M','5M+'))
);

CREATE INDEX IF NOT EXISTS idx_club_status
  ON public.club_membership (status);

CREATE INDEX IF NOT EXISTS idx_club_admitted_at
  ON public.club_membership (admitted_at DESC NULLS LAST)
  WHERE status = 'active';


-- ══════════════════════════════════════════════════════════════════════
--  2) RLS
-- ══════════════════════════════════════════════════════════════════════
ALTER TABLE public.club_membership ENABLE ROW LEVEL SECURITY;

-- Lettura: l'utente vede solo il proprio record
DROP POLICY IF EXISTS club_self_select ON public.club_membership;
CREATE POLICY club_self_select ON public.club_membership
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- L'utente può creare la PROPRIA application (modalità self-application)
DROP POLICY IF EXISTS club_self_apply ON public.club_membership;
CREATE POLICY club_self_apply ON public.club_membership
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND status = 'pending'
    AND admitted_at IS NULL
    AND admitted_by IS NULL
  );

-- Admin: pieno controllo
DROP POLICY IF EXISTS club_admin_all ON public.club_membership;
CREATE POLICY club_admin_all ON public.club_membership
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());


-- ══════════════════════════════════════════════════════════════════════
--  3) Trigger: aggiorna updated_at + popola admitted_at quando passa ad active
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.club_membership_touch()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();

  -- Quando si passa ad 'active', popola admitted_at se mancante
  IF NEW.status = 'active' AND OLD.status IS DISTINCT FROM 'active' THEN
    IF NEW.admitted_at IS NULL THEN
      NEW.admitted_at := now();
    END IF;
    IF NEW.admitted_by IS NULL THEN
      NEW.admitted_by := auth.uid();
    END IF;
  END IF;

  -- Quando si passa a 'suspended', timestamp
  IF NEW.status = 'suspended' AND OLD.status IS DISTINCT FROM 'suspended' THEN
    NEW.suspended_at := now();
  END IF;

  -- Quando si passa a 'revoked', timestamp
  IF NEW.status = 'revoked' AND OLD.status IS DISTINCT FROM 'revoked' THEN
    NEW.revoked_at := now();
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_club_membership_touch ON public.club_membership;
CREATE TRIGGER trg_club_membership_touch
  BEFORE UPDATE ON public.club_membership
  FOR EACH ROW EXECUTE FUNCTION public.club_membership_touch();


-- ══════════════════════════════════════════════════════════════════════
--  4) Helpers
-- ══════════════════════════════════════════════════════════════════════
-- Posti disponibili nel club
CREATE OR REPLACE FUNCTION public.club_seats_available()
RETURNS INT
LANGUAGE sql
STABLE
AS $$
  SELECT GREATEST(
    0,
    COALESCE(
      (SELECT (value::TEXT)::INT FROM public.platform_settings WHERE key='club_max_members'),
      0
    )
    -
    COALESCE(
      (SELECT COUNT(*)::INT FROM public.club_membership WHERE status='active'),
      0
    )
  );
$$;

GRANT EXECUTE ON FUNCTION public.club_seats_available() TO authenticated, anon;

-- Verifica che l'utente corrente sia membro attivo del club
CREATE OR REPLACE FUNCTION public.is_active_club_member(uid UUID DEFAULT auth.uid())
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.club_membership
    WHERE user_id = uid AND status = 'active'
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_active_club_member(UUID) TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  5) View admin: dashboard del club con statistiche
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW public.v_club_admin_dashboard AS
SELECT
  cm.id,
  cm.user_id,
  p.full_name,
  p.first_name,
  p.last_name,
  p.fiscal_code,
  cm.status,
  cm.invited_by,
  cm.net_worth_band,
  cm.experience_years,
  cm.application_notes,
  cm.admin_notes,
  cm.admitted_at,
  cm.admitted_by,
  cm.suspended_at,
  cm.revoked_at,
  cm.created_at,
  cm.updated_at,
  -- KYC dell'utente (utile per decisione di ammissione)
  p.kyc_level,
  p.kyc_status,
  p.phone_verified_at IS NOT NULL AS phone_verified
FROM public.club_membership cm
LEFT JOIN public.profiles p ON p.id = cm.user_id;

GRANT SELECT ON public.v_club_admin_dashboard TO authenticated;
-- La view eredita la RLS della tabella sottostante (club_membership)
-- Quindi un utente non-admin vedrà solo il proprio record qui dentro.


-- ══════════════════════════════════════════════════════════════════════
--  6) Reload PostgREST + verifica
-- ══════════════════════════════════════════════════════════════════════
NOTIFY pgrst, 'reload schema';

SELECT
  'club_membership'           AS object,
  COUNT(*)                    AS rows
FROM public.club_membership
UNION ALL
SELECT
  'club_seats_available()',
  public.club_seats_available()::BIGINT;

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 037_club_membership.sql
-- ═══════════════════════════════════════════════════════════════════════
