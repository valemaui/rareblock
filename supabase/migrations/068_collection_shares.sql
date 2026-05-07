-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock Collector — Collection Public Sharing (PR Collection-Share)
--  Tabella per generare link pubblici read-only della collezione personale.
--  Ogni utente può creare uno o più "share" con token URL-safe; tramite
--  l'RPC `get_public_collection(token)` un visitatore anonimo può vedere
--  la collezione senza login (solo lettura, dati filtrati lato server).
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Tabella collection_shares ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS collection_shares (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token         TEXT NOT NULL UNIQUE,
  title         TEXT,                                        -- es. "La mia collezione vintage"
  show_prices   BOOLEAN NOT NULL DEFAULT TRUE,               -- mostra/nasconde sell_price + cm_avg30
  show_notes    BOOLEAN NOT NULL DEFAULT FALSE,              -- mostra/nasconde campo notes (di default privato)
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at    TIMESTAMPTZ,                                 -- opzionale: scadenza link
  view_count    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS collection_shares_token_idx    ON collection_shares(token);
CREATE INDEX IF NOT EXISTS collection_shares_user_idx     ON collection_shares(user_id);

-- Trigger updated_at
CREATE OR REPLACE FUNCTION collection_shares_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS collection_shares_updated_at ON collection_shares;
CREATE TRIGGER collection_shares_updated_at
  BEFORE UPDATE ON collection_shares
  FOR EACH ROW EXECUTE FUNCTION collection_shares_set_updated_at();

-- ── 2. RLS: ogni utente gestisce SOLO i propri share ─────────────────
ALTER TABLE collection_shares ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "shares_select_own" ON collection_shares;
DROP POLICY IF EXISTS "shares_insert_own" ON collection_shares;
DROP POLICY IF EXISTS "shares_update_own" ON collection_shares;
DROP POLICY IF EXISTS "shares_delete_own" ON collection_shares;

CREATE POLICY "shares_select_own" ON collection_shares
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "shares_insert_own" ON collection_shares
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "shares_update_own" ON collection_shares
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "shares_delete_own" ON collection_shares
  FOR DELETE USING (auth.uid() = user_id);

-- ── 3. Helper: generatore di token URL-safe (24 caratteri, base32-like)
-- Usa caratteri ambigui-free: niente 0/O/1/I/l per migliore leggibilità
CREATE OR REPLACE FUNCTION gen_collection_share_token()
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  alphabet TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghjkmnpqrstuvwxyz';
  result TEXT := '';
  i INTEGER;
BEGIN
  FOR i IN 1..24 LOOP
    result := result || substr(alphabet, 1 + (random() * (length(alphabet) - 1))::int, 1);
  END LOOP;
  RETURN result;
END;
$$;

-- ── 4. Default token sui nuovi share (se non fornito)
CREATE OR REPLACE FUNCTION collection_shares_default_token()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  new_token TEXT;
  attempts INTEGER := 0;
BEGIN
  IF NEW.token IS NULL OR NEW.token = '' THEN
    LOOP
      new_token := gen_collection_share_token();
      attempts := attempts + 1;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM collection_shares WHERE token = new_token);
      IF attempts > 8 THEN
        RAISE EXCEPTION 'Impossibile generare un token univoco dopo % tentativi', attempts;
      END IF;
    END LOOP;
    NEW.token := new_token;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS collection_shares_default_token_tg ON collection_shares;
CREATE TRIGGER collection_shares_default_token_tg
  BEFORE INSERT ON collection_shares
  FOR EACH ROW EXECUTE FUNCTION collection_shares_default_token();

-- ── 5. RPC pubblica: legge una collezione condivisa ──────────────────
-- SECURITY DEFINER perché aggira RLS sulla tabella `cards` per servire
-- carte di un altro utente. Il token funge da capability: chi conosce
-- il token può vedere; altrimenti la funzione restituisce zero righe.
-- I campi sensibili (buy_price, notes private) sono filtrati in base
-- alle preferenze dello share.
CREATE OR REPLACE FUNCTION get_public_collection(p_token TEXT)
RETURNS TABLE (
  card_id        UUID,
  name           TEXT,
  set_name       TEXT,
  card_number    TEXT,
  rarity         TEXT,
  condition      TEXT,
  language       TEXT,
  variant        TEXT,
  first_edition  BOOLEAN,
  qty            INTEGER,
  sell_price     NUMERIC,
  cm_avg30       NUMERIC,
  image_url      TEXT,
  notes          TEXT,
  is_manual      BOOLEAN,
  set_id         TEXT,
  created_at     TIMESTAMPTZ,
  share_title    TEXT,
  share_show_prices BOOLEAN,
  share_show_notes  BOOLEAN,
  share_view_count  INTEGER,
  share_created_at  TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public
AS $$
DECLARE
  v_share collection_shares%ROWTYPE;
BEGIN
  -- Risolve lo share. Token non esistente, disattivato o scaduto → zero righe.
  SELECT * INTO v_share
  FROM collection_shares
  WHERE token = p_token
    AND is_active = TRUE
    AND (expires_at IS NULL OR expires_at > now())
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    c.id,
    c.name,
    c.set_name,
    c.card_number,
    c.rarity,
    c.condition,
    c.language,
    c.variant,
    COALESCE(c.first_edition, FALSE),
    COALESCE(c.qty, 1),
    CASE WHEN v_share.show_prices THEN c.sell_price  ELSE NULL END,
    CASE WHEN v_share.show_prices THEN c.cm_avg30    ELSE NULL END,
    c.image_url,
    CASE WHEN v_share.show_notes  THEN c.notes       ELSE NULL END,
    COALESCE(c.is_manual, FALSE),
    c.set_id,
    c.created_at,
    v_share.title,
    v_share.show_prices,
    v_share.show_notes,
    v_share.view_count,
    v_share.created_at
  FROM cards c
  WHERE c.user_id = v_share.user_id
  ORDER BY c.created_at DESC NULLS LAST
  LIMIT 5000;
END;
$$;

-- Espone l'RPC ad anon e authenticated (necessario per consumo via PostgREST)
GRANT EXECUTE ON FUNCTION get_public_collection(TEXT) TO anon, authenticated;

-- ── 6. RPC per incrementare view count (best-effort, non critico)
CREATE OR REPLACE FUNCTION incr_collection_share_view(p_token TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE collection_shares
     SET view_count = view_count + 1
   WHERE token = p_token
     AND is_active = TRUE
     AND (expires_at IS NULL OR expires_at > now());
END;
$$;

GRANT EXECUTE ON FUNCTION incr_collection_share_view(TEXT) TO anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════
--  FINE MIGRATION 068
-- ═══════════════════════════════════════════════════════════════════════
