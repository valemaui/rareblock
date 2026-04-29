-- ═══════════════════════════════════════════════════════════════════
-- 010_submission_requests.sql
-- Form valutazione collezione (CTA "Venditore" del memorandum)
-- ═══════════════════════════════════════════════════════════════════
--
-- Struttura:
--   submission_requests  → anagrafica + dati di contatto della richiesta
--   submission_items     → lista sigillati (n:1 alla richiesta)
--
-- Flusso:
--   1. Prospect compila form sul memorandum: dati personali + N sigillati
--   2. Click "Invia richiesta" → RPC submit_collection_request salva tutto
--      atomicamente, ritorna l'ID generato (e opzionalmente il log_id se la
--      richiesta arriva da una sessione memorandum tracciata)
--   3. Admin riceve la richiesta in dashboard → contatta + manda offerta
--
-- Sicurezza:
--   - Anon NON può leggere submission_requests/_items (RLS deny by default)
--   - Anon può chiamare submit_collection_request (SECURITY DEFINER) per
--     creare nuove richieste
--   - Admin authenticated (email in whitelist JWT) legge tutto via RLS
--
-- ═══════════════════════════════════════════════════════════════════

-- ─── Tabella richieste ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS submission_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Dati di contatto
  full_name       text NOT NULL,
  email           text NOT NULL,
  phone           text,
  city            text,
  country         text,
  notes           text,
  -- Provenienza (se la richiesta arriva da memorandum, lega al log_id)
  memorandum_log_id   bigint REFERENCES memorandum_access_log(id) ON DELETE SET NULL,
  memorandum_key_id   uuid REFERENCES memorandum_keys(id)         ON DELETE SET NULL,
  -- Workflow
  status          text NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new','contacted','offered','accepted','declined','closed')),
  admin_notes     text,
  estimated_value numeric(12,2),
  offered_value   numeric(12,2),
  -- Tracking
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz,
  contacted_at    timestamptz,
  offered_at      timestamptz,
  closed_at       timestamptz,
  -- Anti-spam metadata (compilata server-side da RPC)
  user_agent      text,
  ip_hint         text,
  country_hint    text
);

CREATE INDEX IF NOT EXISTS idx_subm_req_status  ON submission_requests(status);
CREATE INDEX IF NOT EXISTS idx_subm_req_created ON submission_requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subm_req_email   ON submission_requests(email);

-- ─── Tabella sigillati per richiesta ───────────────────────────────
CREATE TABLE IF NOT EXISTS submission_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id      uuid NOT NULL REFERENCES submission_requests(id) ON DELETE CASCADE,
  sort_order      int NOT NULL DEFAULT 0,
  -- Identificazione prodotto
  product_type    text NOT NULL
                    CHECK (product_type IN ('booster_box','etb','booster_bundle','collection_box','tin','blister','single_pack','case','other')),
  set_name        text,           -- es. "Base Set", "Neo Genesis", "Crown Zenith"
  language        text,           -- es. "EN","JP","IT"
  year            int,
  -- Stato
  condition       text
                    CHECK (condition IN ('mint_sealed','near_mint','very_good','played','damaged','unknown')),
  has_original_seal boolean,
  has_packaging   boolean,
  quantity        int NOT NULL DEFAULT 1,
  estimated_value numeric(12,2),  -- valore atteso dichiarato dal venditore
  notes           text,
  -- Future: foto allegate (per ora solo URL list opzionale)
  photo_urls      text[],
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subm_items_request ON submission_items(request_id);

-- ─── RLS ───────────────────────────────────────────────────────────
ALTER TABLE submission_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE submission_items    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS subm_req_admin_all ON submission_requests;
DROP POLICY IF EXISTS subm_items_admin_all ON submission_items;

CREATE POLICY subm_req_admin_all
  ON submission_requests
  FOR ALL
  TO authenticated
  USING (
    coalesce((auth.jwt()->>'email')::text, '') IN (
      'admin@rareblock.eu',
      'valemaui@gmail.com',
      'v.castiglia@rareblock.eu'
    )
  )
  WITH CHECK (
    coalesce((auth.jwt()->>'email')::text, '') IN (
      'admin@rareblock.eu',
      'valemaui@gmail.com',
      'v.castiglia@rareblock.eu'
    )
  );

CREATE POLICY subm_items_admin_all
  ON submission_items
  FOR ALL
  TO authenticated
  USING (
    coalesce((auth.jwt()->>'email')::text, '') IN (
      'admin@rareblock.eu',
      'valemaui@gmail.com',
      'v.castiglia@rareblock.eu'
    )
  )
  WITH CHECK (
    coalesce((auth.jwt()->>'email')::text, '') IN (
      'admin@rareblock.eu',
      'valemaui@gmail.com',
      'v.castiglia@rareblock.eu'
    )
  );

-- ─── RPC: submit completo (anagrafica + items) in una sola transazione ──
CREATE OR REPLACE FUNCTION submit_collection_request(
  p_full_name     text,
  p_email         text,
  p_phone         text,
  p_city          text,
  p_country       text,
  p_notes         text,
  p_items         jsonb,                  -- array di oggetti item
  p_memorandum_log_id bigint DEFAULT NULL,
  p_user_agent    text   DEFAULT NULL,
  p_ip_hint       text   DEFAULT NULL,
  p_country_hint  text   DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request_id uuid;
  v_key_id uuid;
  v_item jsonb;
  v_idx int := 0;
BEGIN
  -- Validazione minima
  IF coalesce(trim(p_full_name),'') = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'name_required');
  END IF;
  IF coalesce(trim(p_email),'') = '' OR p_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'email_invalid');
  END IF;
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_items');
  END IF;
  IF jsonb_array_length(p_items) > 50 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'too_many_items');
  END IF;

  -- Recupera key_id se il log proviene da una chiave tracciata
  IF p_memorandum_log_id IS NOT NULL THEN
    SELECT key_id INTO v_key_id FROM memorandum_access_log
      WHERE id = p_memorandum_log_id LIMIT 1;
  END IF;

  -- Inserisci richiesta
  INSERT INTO submission_requests (
    full_name, email, phone, city, country, notes,
    memorandum_log_id, memorandum_key_id,
    user_agent, ip_hint, country_hint
  ) VALUES (
    trim(p_full_name), lower(trim(p_email)),
    nullif(trim(coalesce(p_phone,'')),''),
    nullif(trim(coalesce(p_city,'')),''),
    nullif(trim(coalesce(p_country,'')),''),
    nullif(trim(coalesce(p_notes,'')),''),
    p_memorandum_log_id, v_key_id,
    p_user_agent, p_ip_hint, p_country_hint
  ) RETURNING id INTO v_request_id;

  -- Inserisci items
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO submission_items (
      request_id, sort_order, product_type, set_name, language, year,
      condition, has_original_seal, has_packaging,
      quantity, estimated_value, notes
    ) VALUES (
      v_request_id,
      v_idx,
      coalesce(nullif(v_item->>'product_type',''), 'other'),
      nullif(v_item->>'set_name',''),
      nullif(v_item->>'language',''),
      nullif(v_item->>'year','')::int,
      nullif(v_item->>'condition',''),
      (v_item->>'has_original_seal')::boolean,
      (v_item->>'has_packaging')::boolean,
      coalesce(nullif(v_item->>'quantity','')::int, 1),
      nullif(v_item->>'estimated_value','')::numeric,
      nullif(v_item->>'notes','')
    );
    v_idx := v_idx + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'request_id', v_request_id);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', 'server_error', 'detail', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION submit_collection_request(text,text,text,text,text,text,jsonb,bigint,text,text,text) TO anon, authenticated;

-- ─── Vista admin: richieste con count items + dati key ──────────────
CREATE OR REPLACE VIEW v_submission_requests_admin AS
SELECT
  r.*,
  k.prospect_name        AS arrived_via_prospect,
  k.key_value            AS arrived_via_key,
  COALESCE(items.cnt, 0) AS item_count,
  COALESCE(items.total_estimate, 0) AS items_total_estimate
FROM submission_requests r
LEFT JOIN memorandum_keys k ON k.id = r.memorandum_key_id
LEFT JOIN LATERAL (
  SELECT
    COUNT(*) AS cnt,
    SUM(COALESCE(estimated_value,0) * COALESCE(quantity,1)) AS total_estimate
  FROM submission_items
  WHERE request_id = r.id
) items ON true
ORDER BY r.created_at DESC;

GRANT SELECT ON v_submission_requests_admin TO authenticated;

-- ─── Trigger updated_at ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION submission_requests_touch_updated()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_submission_requests_updated ON submission_requests;
CREATE TRIGGER trg_submission_requests_updated
  BEFORE UPDATE ON submission_requests
  FOR EACH ROW
  EXECUTE FUNCTION submission_requests_touch_updated();
