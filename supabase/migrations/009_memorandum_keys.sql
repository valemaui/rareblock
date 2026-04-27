-- ═══════════════════════════════════════════════════════════════════
-- 009_memorandum_keys.sql
-- Sistema chiavi invito + log accessi per Private Memorandum
-- ═══════════════════════════════════════════════════════════════════
--
-- Struttura:
--   memorandum_keys      → chiavi invito personalizzate per prospect
--   memorandum_access_log → ogni tentativo di accesso (riuscito o no)
--
-- Sicurezza:
--   Anon NON può leggere le tabelle direttamente (RLS deny by default)
--   Anon può chiamare due RPC:
--     - validate_memorandum_key(key, ua, referrer, ip_hint, country_hint, city_hint)
--         → SECURITY DEFINER: valida e registra in un solo round-trip
--     - update_memorandum_engagement(log_id, scroll_depth, time_seconds)
--         → SECURITY DEFINER: aggiorna metriche engagement a fine sessione
--   Admin authenticated può leggere tutto via RLS policy
--
-- ═══════════════════════════════════════════════════════════════════

-- ─── Tabella chiavi invito ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS memorandum_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_value       text UNIQUE NOT NULL,
  prospect_name   text NOT NULL,
  prospect_type   text NOT NULL CHECK (prospect_type IN ('investitore','membro','venditore','generico')),
  prospect_email  text,
  prospect_company text,
  notes           text,
  active          boolean NOT NULL DEFAULT true,
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text,
  last_used_at    timestamptz,
  use_count       int NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_memorandum_keys_active ON memorandum_keys(active) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_memorandum_keys_value  ON memorandum_keys(key_value);

-- ─── Tabella log accessi ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS memorandum_access_log (
  id                    bigserial PRIMARY KEY,
  key_id                uuid REFERENCES memorandum_keys(id) ON DELETE SET NULL,
  key_value             text,
  success               boolean NOT NULL DEFAULT true,
  user_agent            text,
  referrer              text,
  ip_hint               text,
  country_hint          text,
  city_hint             text,
  language              text,
  -- engagement (aggiornati alla chiusura della pagina)
  scroll_depth_max      int,
  time_on_page_seconds  int,
  cta_clicked           text,           -- 'investitore' | 'membro' | 'venditore'
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz
);

CREATE INDEX IF NOT EXISTS idx_memorandum_log_keyid   ON memorandum_access_log(key_id);
CREATE INDEX IF NOT EXISTS idx_memorandum_log_created ON memorandum_access_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memorandum_log_success ON memorandum_access_log(success);

-- ─── RLS ───────────────────────────────────────────────────────────
ALTER TABLE memorandum_keys       ENABLE ROW LEVEL SECURITY;
ALTER TABLE memorandum_access_log ENABLE ROW LEVEL SECURITY;

-- Drop esistenti se ri-eseguito
DROP POLICY IF EXISTS memo_keys_admin_all   ON memorandum_keys;
DROP POLICY IF EXISTS memo_log_admin_select ON memorandum_access_log;

-- Solo admin autenticati (definiti dal claim email in auth.jwt) possono leggere/scrivere
CREATE POLICY memo_keys_admin_all
  ON memorandum_keys
  FOR ALL
  TO authenticated
  USING (
    coalesce((auth.jwt()->>'email')::text, '') IN (
      'admin@rareblock.eu',
      'valemaui@gmail.com'
    )
  )
  WITH CHECK (
    coalesce((auth.jwt()->>'email')::text, '') IN (
      'admin@rareblock.eu',
      'valemaui@gmail.com'
    )
  );

CREATE POLICY memo_log_admin_select
  ON memorandum_access_log
  FOR SELECT
  TO authenticated
  USING (
    coalesce((auth.jwt()->>'email')::text, '') IN (
      'admin@rareblock.eu',
      'valemaui@gmail.com'
    )
  );

-- ─── RPC: validate + log in un solo shot ───────────────────────────
CREATE OR REPLACE FUNCTION validate_memorandum_key(
  p_key            text,
  p_user_agent     text DEFAULT NULL,
  p_referrer       text DEFAULT NULL,
  p_ip_hint        text DEFAULT NULL,
  p_country_hint   text DEFAULT NULL,
  p_city_hint      text DEFAULT NULL,
  p_language       text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key memorandum_keys%ROWTYPE;
  v_log_id bigint;
  v_clean_key text;
BEGIN
  v_clean_key := lower(trim(coalesce(p_key,'')));

  IF length(v_clean_key) = 0 THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'empty');
  END IF;

  SELECT * INTO v_key
    FROM memorandum_keys
    WHERE key_value = v_clean_key
      AND active = true
      AND (expires_at IS NULL OR expires_at > now())
    LIMIT 1;

  IF NOT FOUND THEN
    -- Logga tentativo fallito per anti-bruteforce monitoring
    INSERT INTO memorandum_access_log
      (key_value, user_agent, referrer, ip_hint, country_hint, city_hint, language, success)
    VALUES
      (v_clean_key, p_user_agent, p_referrer, p_ip_hint, p_country_hint, p_city_hint, p_language, false);
    RETURN jsonb_build_object('valid', false, 'reason', 'invalid');
  END IF;

  UPDATE memorandum_keys
    SET last_used_at = now(),
        use_count    = use_count + 1
    WHERE id = v_key.id;

  INSERT INTO memorandum_access_log
    (key_id, key_value, user_agent, referrer, ip_hint, country_hint, city_hint, language, success)
  VALUES
    (v_key.id, v_key.key_value, p_user_agent, p_referrer, p_ip_hint, p_country_hint, p_city_hint, p_language, true)
  RETURNING id INTO v_log_id;

  RETURN jsonb_build_object(
    'valid', true,
    'prospect_name', v_key.prospect_name,
    'prospect_type', v_key.prospect_type,
    'log_id', v_log_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION validate_memorandum_key(text,text,text,text,text,text,text) TO anon, authenticated;

-- ─── RPC: aggiorna engagement metrics ──────────────────────────────
CREATE OR REPLACE FUNCTION update_memorandum_engagement(
  p_log_id        bigint,
  p_scroll_depth  int  DEFAULT NULL,
  p_time_seconds  int  DEFAULT NULL,
  p_cta_clicked   text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE memorandum_access_log
    SET scroll_depth_max     = GREATEST(coalesce(scroll_depth_max,0), coalesce(p_scroll_depth,0)),
        time_on_page_seconds = GREATEST(coalesce(time_on_page_seconds,0), coalesce(p_time_seconds,0)),
        cta_clicked          = coalesce(p_cta_clicked, cta_clicked),
        updated_at           = now()
    WHERE id = p_log_id;
END;
$$;

GRANT EXECUTE ON FUNCTION update_memorandum_engagement(bigint,int,int,text) TO anon, authenticated;

-- ─── Vista admin: chiavi con stats accessi ─────────────────────────
CREATE OR REPLACE VIEW v_memorandum_keys_admin AS
SELECT
  k.id,
  k.key_value,
  k.prospect_name,
  k.prospect_type,
  k.prospect_email,
  k.prospect_company,
  k.notes,
  k.active,
  k.expires_at,
  k.created_at,
  k.created_by,
  k.last_used_at,
  k.use_count,
  COALESCE(stats.success_count, 0)        AS success_count,
  COALESCE(stats.fail_count, 0)            AS fail_count,
  stats.last_country                        AS last_country,
  stats.last_city                           AS last_city,
  stats.avg_time_seconds                    AS avg_time_seconds,
  stats.max_scroll_depth                    AS max_scroll_depth
FROM memorandum_keys k
LEFT JOIN LATERAL (
  SELECT
    COUNT(*) FILTER (WHERE success)              AS success_count,
    COUNT(*) FILTER (WHERE NOT success)          AS fail_count,
    (SELECT country_hint FROM memorandum_access_log
       WHERE key_id = k.id AND success ORDER BY created_at DESC LIMIT 1) AS last_country,
    (SELECT city_hint    FROM memorandum_access_log
       WHERE key_id = k.id AND success ORDER BY created_at DESC LIMIT 1) AS last_city,
    AVG(time_on_page_seconds) FILTER (WHERE success AND time_on_page_seconds IS NOT NULL) AS avg_time_seconds,
    MAX(scroll_depth_max)     FILTER (WHERE success)                                       AS max_scroll_depth
  FROM memorandum_access_log
  WHERE key_id = k.id
) stats ON true;

GRANT SELECT ON v_memorandum_keys_admin TO authenticated;

-- ═══════════════════════════════════════════════════════════════════
-- ESEMPIO INSERT INIZIALE (commentato — eseguire manualmente)
-- ═══════════════════════════════════════════════════════════════════
-- INSERT INTO memorandum_keys (key_value, prospect_name, prospect_type, notes) VALUES
--   ('demo-2026',     'Demo / Founder Use', 'generico',    'Chiave di test'),
--   ('centurion',     'Mario Rossi',        'investitore', 'Family office Milano - intro via Luca'),
--   ('rolex-26',      'Giovanni Bianchi',   'membro',      'Collezionista Rolex, intro al network');
