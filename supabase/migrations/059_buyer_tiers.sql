-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Migration 059: Buyer Tiers (BASIC / PRO / GOLD)
--
--  Modello:
--   • BASIC  — gratis, fee buyer 2,5% / success 10% (fractional)
--   • PRO    — €490/anno, fee buyer 1,5% / success 10%
--   • GOLD   — €2.500/anno · invitation only · fee 0,5% / success 7%
--
--  Logica chiave:
--   • Il cron è solo "eligibility scanner": legge AUM, scrive flag
--     (gold_eligible_since / gold_at_risk_since). NON tocca mai `tier`.
--   • L'admin è l'unica autorità che scrive su `tier='gold'` (o downgrade),
--     attraverso la RPC admin_set_user_tier.
--   • Override sotto soglia consentito ma tracciato (note obbligatoria,
--     manual_override=true in inv_tier_history).
--   • Snapshot fee su inv_orders al momento del checkout.
--
--  NOTE compatibilità:
--   • Convivenza con club_membership (037): club è un filtro per Modalità B
--     fractional, tier è il pricing tier acquirente generale.
--     Un GOLD non è automaticamente club member né viceversa.
-- ═══════════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════════
--  1) profiles — campi tier
-- ══════════════════════════════════════════════════════════════════════
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS tier                  TEXT NOT NULL DEFAULT 'basic',
  ADD COLUMN IF NOT EXISTS tier_started_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tier_expires_at       TIMESTAMPTZ,        -- solo PRO ha scadenza
  ADD COLUMN IF NOT EXISTS gold_eligible_since   TIMESTAMPTZ,        -- settato dal cron
  ADD COLUMN IF NOT EXISTS gold_eligible_aum     NUMERIC(12,2),      -- snapshot AUM al flag
  ADD COLUMN IF NOT EXISTS gold_at_risk_since    TIMESTAMPTZ,        -- GOLD sotto soglia da X mesi
  ADD COLUMN IF NOT EXISTS gold_promoted_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS gold_promoted_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gold_promotion_note   TEXT;

-- Constraint: tier valido
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_tier_chk'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_tier_chk CHECK (tier IN ('basic','pro','gold'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_profiles_tier
  ON public.profiles (tier);

CREATE INDEX IF NOT EXISTS idx_profiles_gold_eligible
  ON public.profiles (gold_eligible_since DESC NULLS LAST)
  WHERE tier <> 'gold' AND gold_eligible_since IS NOT NULL;


-- ══════════════════════════════════════════════════════════════════════
--  2) inv_tier_history — audit trail
-- ══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.inv_tier_history (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  from_tier        TEXT,
  to_tier          TEXT NOT NULL,

  changed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  reason           TEXT,                                      -- nota libera admin / motivo automatico
  manual_override  BOOLEAN NOT NULL DEFAULT false,            -- true = forzato sotto soglia
  source           TEXT NOT NULL DEFAULT 'admin'              -- 'admin'|'system'|'self_signup'|'expired'
                     CHECK (source IN ('admin','system','self_signup','expired')),

  -- Snapshot AUM al momento del cambio (per audit/compliance)
  aum_at_change    NUMERIC(12,2),

  CONSTRAINT inv_tier_history_to_chk
    CHECK (to_tier IN ('basic','pro','gold')),
  CONSTRAINT inv_tier_history_from_chk
    CHECK (from_tier IS NULL OR from_tier IN ('basic','pro','gold'))
);

CREATE INDEX IF NOT EXISTS idx_inv_tier_history_user
  ON public.inv_tier_history (user_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_inv_tier_history_to_tier
  ON public.inv_tier_history (to_tier, changed_at DESC);

ALTER TABLE public.inv_tier_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tier_history_self ON public.inv_tier_history;
CREATE POLICY tier_history_self ON public.inv_tier_history
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS tier_history_admin ON public.inv_tier_history;
CREATE POLICY tier_history_admin ON public.inv_tier_history
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());


-- ══════════════════════════════════════════════════════════════════════
--  3) inv_orders — snapshot fee al checkout
-- ══════════════════════════════════════════════════════════════════════
ALTER TABLE public.inv_orders
  ADD COLUMN IF NOT EXISTS tier_at_purchase     TEXT,
  ADD COLUMN IF NOT EXISTS buyer_fee_pct        NUMERIC(5,4),       -- 0.0250 = 2,5%
  ADD COLUMN IF NOT EXISTS buyer_fee_amount     NUMERIC(10,2),      -- € applicati
  ADD COLUMN IF NOT EXISTS success_fee_pct      NUMERIC(5,4);       -- riservato per liquidazione fractional

-- Constraint coerenza tier_at_purchase
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inv_orders_tier_chk'
  ) THEN
    ALTER TABLE public.inv_orders
      ADD CONSTRAINT inv_orders_tier_chk
      CHECK (tier_at_purchase IS NULL OR tier_at_purchase IN ('basic','pro','gold'));
  END IF;
END $$;


-- ══════════════════════════════════════════════════════════════════════
--  4) Seed parametri in platform_settings
-- ══════════════════════════════════════════════════════════════════════
INSERT INTO public.platform_settings (key, value, description, category) VALUES
  ('tier_basic_buyer_fee_pct', '0.025',
    'Fee buyer applicata al tier BASIC (frazione: 0.025 = 2,5%)',
    'commercial'),
  ('tier_pro_buyer_fee_pct', '0.015',
    'Fee buyer applicata al tier PRO (0.015 = 1,5%)',
    'commercial'),
  ('tier_gold_buyer_fee_pct', '0.005',
    'Fee buyer applicata al tier GOLD (0.005 = 0,5%)',
    'commercial'),
  ('tier_basic_success_fee_pct', '0.10',
    'Success fee BASIC sull''upside fractional alla liquidazione',
    'commercial'),
  ('tier_pro_success_fee_pct', '0.10',
    'Success fee PRO sull''upside fractional alla liquidazione',
    'commercial'),
  ('tier_gold_success_fee_pct', '0.07',
    'Success fee GOLD sull''upside fractional alla liquidazione',
    'commercial'),
  ('tier_pro_annual_price_eur', '490',
    'Canone annuale PRO in euro',
    'commercial'),
  ('tier_gold_annual_price_eur', '2500',
    'Canone annuale GOLD in euro (invitation only)',
    'commercial'),
  ('gold_aum_threshold_eur', '50000',
    'Soglia AUM minima per essere flaggati GOLD eligible dal cron',
    'commercial'),
  ('gold_eligibility_loss_days', '30',
    'Giorni consecutivi sotto soglia AUM prima di perdere l''eleggibilità GOLD',
    'commercial'),
  ('gold_at_risk_days', '90',
    'Giorni sotto soglia per un GOLD prima di marcarlo "at-risk" in admin (no downgrade automatico)',
    'commercial')
ON CONFLICT (key) DO NOTHING;


-- ══════════════════════════════════════════════════════════════════════
--  5) Helper: lettura fee correnti da settings (con fallback hardcoded)
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public._tier_setting_numeric(
  p_key  TEXT,
  p_default NUMERIC
)
RETURNS NUMERIC
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    (SELECT (value::TEXT)::NUMERIC
       FROM public.platform_settings
       WHERE key = p_key),
    p_default
  );
$$;

GRANT EXECUTE ON FUNCTION public._tier_setting_numeric(TEXT, NUMERIC) TO authenticated, anon;


-- ── Buyer fee % per un tier dato ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_buyer_fee_pct(p_tier TEXT)
RETURNS NUMERIC
LANGUAGE sql
STABLE
AS $$
  SELECT CASE LOWER(COALESCE(p_tier,'basic'))
    WHEN 'gold' THEN public._tier_setting_numeric('tier_gold_buyer_fee_pct', 0.005)
    WHEN 'pro'  THEN public._tier_setting_numeric('tier_pro_buyer_fee_pct',  0.015)
    ELSE             public._tier_setting_numeric('tier_basic_buyer_fee_pct',0.025)
  END;
$$;

GRANT EXECUTE ON FUNCTION public.get_buyer_fee_pct(TEXT) TO authenticated, anon;


-- ── Success fee % per un tier dato ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_success_fee_pct(p_tier TEXT)
RETURNS NUMERIC
LANGUAGE sql
STABLE
AS $$
  SELECT CASE LOWER(COALESCE(p_tier,'basic'))
    WHEN 'gold' THEN public._tier_setting_numeric('tier_gold_success_fee_pct', 0.07)
    WHEN 'pro'  THEN public._tier_setting_numeric('tier_pro_success_fee_pct',  0.10)
    ELSE             public._tier_setting_numeric('tier_basic_success_fee_pct',0.10)
  END;
$$;

GRANT EXECUTE ON FUNCTION public.get_success_fee_pct(TEXT) TO authenticated, anon;


-- ── Lettura tier corrente di un utente (gestisce scadenza PRO) ───────
CREATE OR REPLACE FUNCTION public.get_user_tier(p_user_id UUID DEFAULT auth.uid())
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tier        TEXT;
  v_expires     TIMESTAMPTZ;
BEGIN
  IF p_user_id IS NULL THEN RETURN 'basic'; END IF;

  SELECT tier, tier_expires_at
    INTO v_tier, v_expires
  FROM public.profiles
  WHERE id = p_user_id;

  IF v_tier IS NULL THEN RETURN 'basic'; END IF;

  -- PRO scaduto = retrocede a basic in lettura.
  -- GOLD non scade mai (gestito manualmente da admin).
  IF v_tier = 'pro' AND v_expires IS NOT NULL AND v_expires < now() THEN
    RETURN 'basic';
  END IF;

  RETURN v_tier;
END $$;

GRANT EXECUTE ON FUNCTION public.get_user_tier(UUID) TO authenticated, anon;


-- ══════════════════════════════════════════════════════════════════════
--  6) Calcolo AUM corrente di un utente
--     AUM = somma totale ordini completati - somma liquidazioni
--     (in MVP usiamo solo inv_orders.total per ordini 'completed')
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_user_aum(p_user_id UUID)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(total), 0)::NUMERIC(12,2)
    FROM public.inv_orders
   WHERE user_id = p_user_id
     AND status = 'completed';
$$;

GRANT EXECUTE ON FUNCTION public.get_user_aum(UUID) TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  7) Trigger: snapshot fee + tier su inv_orders al momento del confirm
--     Si attiva su INSERT e su UPDATE quando lo status passa da draft.
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.inv_orders_apply_tier_snapshot()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tier   TEXT;
  v_bfee   NUMERIC;
  v_sfee   NUMERIC;
BEGIN
  -- Skip se snapshot già presente (idempotente)
  IF NEW.tier_at_purchase IS NOT NULL AND NEW.buyer_fee_pct IS NOT NULL THEN
    RETURN NEW;
  END IF;

  v_tier := public.get_user_tier(NEW.user_id);
  v_bfee := public.get_buyer_fee_pct(v_tier);
  v_sfee := public.get_success_fee_pct(v_tier);

  NEW.tier_at_purchase := v_tier;
  NEW.buyer_fee_pct    := v_bfee;
  NEW.success_fee_pct  := v_sfee;
  -- buyer_fee_amount calcolato sul total finale (post-discount)
  NEW.buyer_fee_amount := ROUND(COALESCE(NEW.total, 0) * v_bfee, 2);

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_inv_orders_tier_snapshot ON public.inv_orders;
CREATE TRIGGER trg_inv_orders_tier_snapshot
  BEFORE INSERT ON public.inv_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.inv_orders_apply_tier_snapshot();


-- ══════════════════════════════════════════════════════════════════════
--  8) Trigger: log audit su profiles.tier
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.log_tier_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_aum      NUMERIC;
  v_source   TEXT;
  v_override BOOLEAN;
  v_reason   TEXT;
BEGIN
  -- Skip se tier non è cambiato
  IF NEW.tier IS NOT DISTINCT FROM OLD.tier THEN
    RETURN NEW;
  END IF;

  v_aum := public.get_user_aum(NEW.id);

  -- Determina sorgente: se changed_by è admin → 'admin', altrimenti 'system'
  IF auth.uid() IS NOT NULL AND public.is_admin() THEN
    v_source := 'admin';
  ELSE
    v_source := 'system';
  END IF;

  -- override = NEW è gold ma AUM sotto soglia
  v_override := (NEW.tier = 'gold'
                 AND v_aum < public._tier_setting_numeric('gold_aum_threshold_eur', 50000));

  v_reason := COALESCE(NEW.gold_promotion_note,
                       'Tier change: ' || COALESCE(OLD.tier,'(null)') || ' → ' || NEW.tier);

  INSERT INTO public.inv_tier_history
    (user_id, from_tier, to_tier, changed_by, reason, manual_override, source, aum_at_change)
  VALUES
    (NEW.id, OLD.tier, NEW.tier,
     COALESCE(NEW.gold_promoted_by, auth.uid()),
     v_reason, v_override, v_source, v_aum);

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_profiles_tier_audit ON public.profiles;
CREATE TRIGGER trg_profiles_tier_audit
  AFTER UPDATE OF tier ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.log_tier_change();


-- ══════════════════════════════════════════════════════════════════════
--  9) RPC admin_set_user_tier — unica via di scrittura sul tier
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.admin_set_user_tier(
  p_target_user_id    UUID,
  p_target_tier       TEXT,
  p_note              TEXT,
  p_override_threshold BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin_id   UUID;
  v_aum        NUMERIC;
  v_threshold  NUMERIC;
  v_old_tier   TEXT;
  v_expires    TIMESTAMPTZ;
BEGIN
  v_admin_id := auth.uid();

  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Forbidden: admin role required'
      USING ERRCODE = '42501';
  END IF;

  IF p_target_user_id IS NULL THEN
    RAISE EXCEPTION 'target_user_id required';
  END IF;

  IF p_target_tier NOT IN ('basic','pro','gold') THEN
    RAISE EXCEPTION 'Invalid tier: %', p_target_tier;
  END IF;

  SELECT tier INTO v_old_tier FROM public.profiles WHERE id = p_target_user_id;
  IF v_old_tier IS NULL THEN
    RAISE EXCEPTION 'Target user not found';
  END IF;

  -- Verifica soglia per GOLD se non c'è override
  IF p_target_tier = 'gold' AND NOT p_override_threshold THEN
    v_aum := public.get_user_aum(p_target_user_id);
    v_threshold := public._tier_setting_numeric('gold_aum_threshold_eur', 50000);
    IF v_aum < v_threshold THEN
      RAISE EXCEPTION 'AUM (% €) below GOLD threshold (% €). Use override_threshold=true with note.',
                      v_aum, v_threshold
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Forza nota se override
  IF p_override_threshold AND (p_note IS NULL OR LENGTH(TRIM(p_note)) < 5) THEN
    RAISE EXCEPTION 'Override requires a note (min 5 chars)';
  END IF;

  -- Calcola scadenza per PRO (1 anno da oggi)
  IF p_target_tier = 'pro' THEN
    v_expires := now() + INTERVAL '1 year';
  ELSE
    v_expires := NULL;
  END IF;

  -- UPDATE atomico (il trigger log_tier_change scrive in inv_tier_history)
  UPDATE public.profiles SET
    tier                = p_target_tier,
    tier_started_at     = now(),
    tier_expires_at     = v_expires,
    gold_promoted_by    = CASE WHEN p_target_tier='gold' THEN v_admin_id ELSE gold_promoted_by END,
    gold_promoted_at    = CASE WHEN p_target_tier='gold' THEN now()      ELSE gold_promoted_at END,
    gold_promotion_note = CASE WHEN p_target_tier='gold' THEN p_note     ELSE gold_promotion_note END,
    -- al downgrade da gold, pulisce eleggibilità per ricominciare da capo
    gold_eligible_since = CASE WHEN p_target_tier='gold' THEN gold_eligible_since ELSE NULL END,
    gold_at_risk_since  = CASE WHEN p_target_tier='gold' THEN gold_at_risk_since  ELSE NULL END
  WHERE id = p_target_user_id;

  RETURN jsonb_build_object(
    'ok', true,
    'user_id', p_target_user_id,
    'from_tier', v_old_tier,
    'to_tier', p_target_tier,
    'override', p_override_threshold,
    'changed_at', now()
  );
END $$;

GRANT EXECUTE ON FUNCTION public.admin_set_user_tier(UUID, TEXT, TEXT, BOOLEAN) TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
-- 10) cron_scan_gold_eligibility — eligibility scanner (NO promotion)
--     Da invocare schedulato (pg_cron giornaliero alle 03:00).
--     Modifica solo i flag su profiles. Mai il campo `tier`.
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.cron_scan_gold_eligibility()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_threshold     NUMERIC;
  v_loss_days     INT;
  v_at_risk_days  INT;
  v_flagged       INT := 0;
  v_lost          INT := 0;
  v_at_risk       INT := 0;
  v_at_risk_clr   INT := 0;
BEGIN
  v_threshold    := public._tier_setting_numeric('gold_aum_threshold_eur', 50000);
  v_loss_days    := public._tier_setting_numeric('gold_eligibility_loss_days', 30)::INT;
  v_at_risk_days := public._tier_setting_numeric('gold_at_risk_days', 90)::INT;

  -- ── A) NON-GOLD sopra soglia → flag eligible (se non già) ──────────
  WITH aum_calc AS (
    SELECT
      p.id,
      COALESCE(SUM(o.total) FILTER (WHERE o.status='completed'), 0) AS aum
    FROM public.profiles p
    LEFT JOIN public.inv_orders o ON o.user_id = p.id
    WHERE p.tier <> 'gold'
    GROUP BY p.id
  ),
  upd AS (
    UPDATE public.profiles p
       SET gold_eligible_since = now(),
           gold_eligible_aum   = a.aum
      FROM aum_calc a
     WHERE p.id = a.id
       AND a.aum >= v_threshold
       AND p.gold_eligible_since IS NULL
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_flagged FROM upd;

  -- ── B) NON-GOLD sotto soglia da X giorni → rimuove eleggibilità ────
  --     (solo per chi era già eleggibile da > loss_days)
  WITH aum_calc AS (
    SELECT
      p.id,
      p.gold_eligible_since,
      COALESCE(SUM(o.total) FILTER (WHERE o.status='completed'), 0) AS aum
    FROM public.profiles p
    LEFT JOIN public.inv_orders o ON o.user_id = p.id
    WHERE p.tier <> 'gold'
      AND p.gold_eligible_since IS NOT NULL
    GROUP BY p.id, p.gold_eligible_since
  ),
  upd AS (
    UPDATE public.profiles p
       SET gold_eligible_since = NULL,
           gold_eligible_aum   = NULL
      FROM aum_calc a
     WHERE p.id = a.id
       AND a.aum < v_threshold
       AND a.gold_eligible_since < now() - (v_loss_days || ' days')::INTERVAL
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_lost FROM upd;

  -- ── C) GOLD sotto soglia → flag at-risk (NO downgrade) ─────────────
  WITH aum_calc AS (
    SELECT
      p.id,
      COALESCE(SUM(o.total) FILTER (WHERE o.status='completed'), 0) AS aum
    FROM public.profiles p
    LEFT JOIN public.inv_orders o ON o.user_id = p.id
    WHERE p.tier = 'gold'
    GROUP BY p.id
  ),
  upd AS (
    UPDATE public.profiles p
       SET gold_at_risk_since = COALESCE(p.gold_at_risk_since, now())
      FROM aum_calc a
     WHERE p.id = a.id
       AND a.aum < v_threshold
       AND p.gold_at_risk_since IS NULL
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_at_risk FROM upd;

  -- ── D) GOLD risalito sopra soglia → clear at-risk ──────────────────
  WITH aum_calc AS (
    SELECT
      p.id,
      COALESCE(SUM(o.total) FILTER (WHERE o.status='completed'), 0) AS aum
    FROM public.profiles p
    LEFT JOIN public.inv_orders o ON o.user_id = p.id
    WHERE p.tier = 'gold'
      AND p.gold_at_risk_since IS NOT NULL
    GROUP BY p.id
  ),
  upd AS (
    UPDATE public.profiles p
       SET gold_at_risk_since = NULL
      FROM aum_calc a
     WHERE p.id = a.id
       AND a.aum >= v_threshold
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_at_risk_clr FROM upd;

  RETURN jsonb_build_object(
    'ran_at',                 now(),
    'aum_threshold_eur',      v_threshold,
    'newly_flagged_eligible', v_flagged,
    'lost_eligibility',       v_lost,
    'gold_at_risk_new',       v_at_risk,
    'gold_at_risk_cleared',   v_at_risk_clr
  );
END $$;

GRANT EXECUTE ON FUNCTION public.cron_scan_gold_eligibility() TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
-- 11) View: candidati GOLD per dashboard admin
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW public.v_gold_candidates AS
SELECT
  p.id                                              AS user_id,
  COALESCE(p.full_name,
           TRIM(BOTH ' ' FROM
             COALESCE(p.first_name,'') || ' ' || COALESCE(p.last_name,'')
           ),
           u.email)                                 AS display_name,
  u.email,
  p.tier                                            AS current_tier,
  p.gold_eligible_since,
  EXTRACT(DAY FROM (now() - p.gold_eligible_since))::INT AS eligible_days,
  p.gold_eligible_aum,
  public.get_user_aum(p.id)                         AS current_aum,
  (SELECT COUNT(*)
     FROM public.inv_orders o
    WHERE o.user_id = p.id
      AND o.status = 'completed')                   AS completed_orders,
  (SELECT MAX(o.created_at)
     FROM public.inv_orders o
    WHERE o.user_id = p.id
      AND o.status = 'completed')                   AS last_order_at,
  p.kyc_level,
  p.kyc_status
FROM public.profiles p
LEFT JOIN auth.users u ON u.id = p.id
WHERE p.tier <> 'gold'
  AND p.gold_eligible_since IS NOT NULL;

GRANT SELECT ON public.v_gold_candidates TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
-- 12) View: GOLD at-risk (sotto soglia da N giorni)
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW public.v_gold_at_risk AS
SELECT
  p.id                                              AS user_id,
  COALESCE(p.full_name,
           TRIM(BOTH ' ' FROM
             COALESCE(p.first_name,'') || ' ' || COALESCE(p.last_name,'')
           ),
           u.email)                                 AS display_name,
  u.email,
  p.gold_promoted_at,
  p.gold_at_risk_since,
  EXTRACT(DAY FROM (now() - p.gold_at_risk_since))::INT AS at_risk_days,
  public.get_user_aum(p.id)                         AS current_aum,
  public._tier_setting_numeric('gold_aum_threshold_eur', 50000) AS threshold_eur,
  p.gold_promotion_note
FROM public.profiles p
LEFT JOIN auth.users u ON u.id = p.id
WHERE p.tier = 'gold'
  AND p.gold_at_risk_since IS NOT NULL;

GRANT SELECT ON public.v_gold_at_risk TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
-- 13) View: storia tier ricca per admin
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW public.v_tier_history_admin AS
SELECT
  h.id,
  h.user_id,
  COALESCE(p.full_name,
           TRIM(BOTH ' ' FROM
             COALESCE(p.first_name,'') || ' ' || COALESCE(p.last_name,'')
           ),
           u.email)                                 AS display_name,
  u.email,
  h.from_tier,
  h.to_tier,
  h.changed_at,
  h.changed_by,
  COALESCE(adm_p.full_name,
           TRIM(BOTH ' ' FROM
             COALESCE(adm_p.first_name,'') || ' ' || COALESCE(adm_p.last_name,'')
           ),
           adm_u.email)                             AS changed_by_name,
  h.reason,
  h.manual_override,
  h.source,
  h.aum_at_change
FROM public.inv_tier_history h
LEFT JOIN public.profiles p     ON p.id     = h.user_id
LEFT JOIN auth.users u          ON u.id     = h.user_id
LEFT JOIN public.profiles adm_p ON adm_p.id = h.changed_by
LEFT JOIN auth.users adm_u      ON adm_u.id = h.changed_by;

GRANT SELECT ON public.v_tier_history_admin TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
-- 14) Reload PostgREST + verifica
-- ══════════════════════════════════════════════════════════════════════
NOTIFY pgrst, 'reload schema';

SELECT
  'profiles_tier_basic'      AS metric,
  COUNT(*)::BIGINT           AS value
FROM public.profiles
WHERE tier = 'basic'
UNION ALL
SELECT 'profiles_tier_pro',  COUNT(*)::BIGINT
  FROM public.profiles WHERE tier = 'pro'
UNION ALL
SELECT 'profiles_tier_gold', COUNT(*)::BIGINT
  FROM public.profiles WHERE tier = 'gold'
UNION ALL
SELECT 'gold_candidates',    COUNT(*)::BIGINT FROM public.v_gold_candidates
UNION ALL
SELECT 'gold_at_risk',       COUNT(*)::BIGINT FROM public.v_gold_at_risk;

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 059_buyer_tiers.sql
-- ═══════════════════════════════════════════════════════════════════════
