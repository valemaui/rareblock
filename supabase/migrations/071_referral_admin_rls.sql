-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Migration 071: RLS admin per gestione codici referral
--
--  Abilita la UI admin (frames-investor/admin.html) a creare/modificare/
--  attivare-disattivare i codici referral e a leggere il log redemptions,
--  via PostgREST con l'access_token dell'admin (ruolo 'authenticated' +
--  profiles.role = 'admin', verificato da public.is_admin()).
--
--  Le RPC pubbliche (validate/consume) restano l'unica via per anon.
--  Dipende da: 011 (is_admin), 070 (tabelle referral).
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Policy admin su inv_referral_codes (CRUD completo) ────────────────
DROP POLICY IF EXISTS "referral_codes_admin_select" ON public.inv_referral_codes;
DROP POLICY IF EXISTS "referral_codes_admin_insert" ON public.inv_referral_codes;
DROP POLICY IF EXISTS "referral_codes_admin_update" ON public.inv_referral_codes;
DROP POLICY IF EXISTS "referral_codes_admin_delete" ON public.inv_referral_codes;

CREATE POLICY "referral_codes_admin_select" ON public.inv_referral_codes
  FOR SELECT USING ( public.is_admin() );
CREATE POLICY "referral_codes_admin_insert" ON public.inv_referral_codes
  FOR INSERT WITH CHECK ( public.is_admin() );
CREATE POLICY "referral_codes_admin_update" ON public.inv_referral_codes
  FOR UPDATE USING ( public.is_admin() ) WITH CHECK ( public.is_admin() );
CREATE POLICY "referral_codes_admin_delete" ON public.inv_referral_codes
  FOR DELETE USING ( public.is_admin() );

-- ── 2. Policy admin su redemptions (sola lettura: è un log) ──────────────
DROP POLICY IF EXISTS "referral_redemptions_admin_select" ON public.inv_referral_redemptions;
CREATE POLICY "referral_redemptions_admin_select" ON public.inv_referral_redemptions
  FOR SELECT USING ( public.is_admin() );

-- ── 3. View aggregata per la UI (codice + stato derivato + ultimo uso) ───
--  security_invoker=on → la view eredita le RLS del chiamante (no leak
--  ad anon). Espone i contatori "valid/invalid/consumed" già aggregati.
CREATE OR REPLACE VIEW public.v_referral_codes_admin
WITH (security_invoker = on) AS
SELECT
  c.id,
  c.code,
  c.label,
  c.source_type,
  c.referrer_user,
  c.max_uses,
  c.uses,
  c.expires_at,
  c.is_active,
  c.created_at,
  c.notes,
  -- stato derivato per il badge UI
  CASE
    WHEN NOT c.is_active THEN 'inactive'
    WHEN c.expires_at IS NOT NULL AND c.expires_at < now() THEN 'expired'
    WHEN c.max_uses IS NOT NULL AND c.uses >= c.max_uses THEN 'exhausted'
    ELSE 'active'
  END AS status,
  -- residuo inviti (NULL = illimitato)
  CASE WHEN c.max_uses IS NULL THEN NULL ELSE GREATEST(c.max_uses - c.uses, 0) END AS remaining,
  -- ultimo tentativo di validazione/consumo loggato
  (SELECT max(r.created_at) FROM public.inv_referral_redemptions r WHERE r.code = c.code) AS last_seen_at,
  -- conteggi rapidi
  (SELECT count(*) FROM public.inv_referral_redemptions r WHERE r.code = c.code AND r.outcome = 'consumed') AS consumed_count,
  (SELECT count(*) FROM public.inv_referral_redemptions r WHERE r.code = c.code AND r.outcome = 'invalid')  AS invalid_count
FROM public.inv_referral_codes c;

GRANT SELECT ON public.v_referral_codes_admin TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════
--  Note: la UI admin legge da v_referral_codes_admin (GET) e scrive su
--  inv_referral_codes (POST/PATCH). Il log si legge da
--  inv_referral_redemptions. Tutto gated da is_admin() lato RLS.
-- ═══════════════════════════════════════════════════════════════════════
