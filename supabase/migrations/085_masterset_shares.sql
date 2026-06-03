-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock Collector — Masterset Public Sharing (PR Masterset-Share)
--  Tabella per generare link pubblici read-only di una mancolista/masterset.
--  Ogni utente può creare uno o più "share" con token URL-safe; tramite
--  l'RPC `get_public_masterset(token)` un visitatore anonimo (NON registrato
--  su RareBlock) può visualizzare il masterset senza login — solo lettura,
--  dati filtrati lato server, nessun accesso ad aree riservate.
--
--  MODELLO DATI: a differenza di `cards` (una riga per carta), i masterset
--  sono salvati come UN unico blob JSON nella tabella `mastersets`
--  (colonna `data` TEXT, una riga per utente — vedi migration 002).
--  Per questo l'RPC restituisce JSONB con il singolo masterset richiesto,
--  estratto dall'array tramite `masterset_id`.
--
--  SICUREZZA: il token è una capability opaca di 24 caratteri casuali
--  (alfabeto ambiguity-free). Modificare caratteri del token non consente
--  enumerazione né escalation: un token inesistente/scaduto/disattivato
--  ritorna {ok:false} senza esporre alcun dato. Nessuna chiave privilegiata
--  è esposta al client (la pagina pubblica usa solo la anon key).
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Tabella masterset_shares ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS masterset_shares (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  masterset_id  TEXT NOT NULL,                               -- ms.id all'interno del blob JSON
  token         TEXT NOT NULL UNIQUE,
  title         TEXT,                                        -- es. "Mancolista Base Set ITA"
  filter        JSONB,                                       -- snapshot vista: {owned,variant,tier,rarity,search,view}
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at    TIMESTAMPTZ,                                 -- opzionale: scadenza link
  view_count    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS masterset_shares_token_idx ON masterset_shares(token);
CREATE INDEX IF NOT EXISTS masterset_shares_user_idx  ON masterset_shares(user_id, masterset_id);

-- Trigger updated_at
CREATE OR REPLACE FUNCTION masterset_shares_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS masterset_shares_updated_at ON masterset_shares;
CREATE TRIGGER masterset_shares_updated_at
  BEFORE UPDATE ON masterset_shares
  FOR EACH ROW EXECUTE FUNCTION masterset_shares_set_updated_at();

-- ── 2. RLS: ogni utente gestisce SOLO i propri share ─────────────────
ALTER TABLE masterset_shares ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ms_shares_select_own" ON masterset_shares;
DROP POLICY IF EXISTS "ms_shares_insert_own" ON masterset_shares;
DROP POLICY IF EXISTS "ms_shares_update_own" ON masterset_shares;
DROP POLICY IF EXISTS "ms_shares_delete_own" ON masterset_shares;

CREATE POLICY "ms_shares_select_own" ON masterset_shares
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "ms_shares_insert_own" ON masterset_shares
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "ms_shares_update_own" ON masterset_shares
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "ms_shares_delete_own" ON masterset_shares
  FOR DELETE USING (auth.uid() = user_id);

-- ── 3. Helper: generatore di token URL-safe (24 caratteri) ───────────
-- Stesso alfabeto ambiguity-free della collezione (niente 0/O/1/I/l).
CREATE OR REPLACE FUNCTION gen_masterset_share_token()
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

-- ── 4. Default token sui nuovi share (se non fornito) ────────────────
CREATE OR REPLACE FUNCTION masterset_shares_default_token()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  new_token TEXT;
  attempts INTEGER := 0;
BEGIN
  IF NEW.token IS NULL OR NEW.token = '' THEN
    LOOP
      new_token := gen_masterset_share_token();
      attempts := attempts + 1;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM masterset_shares WHERE token = new_token);
      IF attempts > 8 THEN
        RAISE EXCEPTION 'Impossibile generare un token univoco dopo % tentativi', attempts;
      END IF;
    END LOOP;
    NEW.token := new_token;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS masterset_shares_default_token_tg ON masterset_shares;
CREATE TRIGGER masterset_shares_default_token_tg
  BEFORE INSERT ON masterset_shares
  FOR EACH ROW EXECUTE FUNCTION masterset_shares_default_token();

-- ── 5. RPC pubblica: legge un masterset condiviso ────────────────────
-- SECURITY DEFINER perché aggira RLS su `mastersets` per servire il blob
-- di un altro utente. Il token funge da capability: token valido → dati;
-- altrimenti {ok:false} (nessun leak, nessuna enumerazione).
DROP FUNCTION IF EXISTS get_public_masterset(text);

CREATE OR REPLACE FUNCTION get_public_masterset(p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public
AS $$
DECLARE
  v_share   masterset_shares%ROWTYPE;
  v_raw     TEXT;
  v_arr     JSONB;
  v_ms      JSONB := NULL;
  v_elem    JSONB;
  v_owner   TEXT;
BEGIN
  -- Risolve lo share. Token inesistente, disattivato o scaduto → ok:false.
  SELECT * INTO v_share
  FROM masterset_shares
  WHERE token = p_token
    AND is_active = TRUE
    AND (expires_at IS NULL OR expires_at > now())
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false);
  END IF;

  -- Legge il blob JSON dei masterset del proprietario dello share.
  SELECT data INTO v_raw
  FROM mastersets
  WHERE user_id = v_share.user_id
  LIMIT 1;

  IF v_raw IS NULL OR v_raw = '' THEN
    RETURN jsonb_build_object('ok', false);
  END IF;

  -- Coercizione robusta TEXT → JSONB array.
  -- `data` è il risultato di JSON.stringify(array) lato client, quindi
  -- normalmente è già un array JSON. Gestiamo anche l'eventuale caso di
  -- valore double-encoded (stringa JSON che contiene a sua volta l'array).
  BEGIN
    v_arr := v_raw::jsonb;
  EXCEPTION WHEN others THEN
    RETURN jsonb_build_object('ok', false);
  END;

  IF jsonb_typeof(v_arr) = 'string' THEN
    v_arr := (v_arr #>> '{}')::jsonb;
  END IF;

  IF jsonb_typeof(v_arr) <> 'array' THEN
    RETURN jsonb_build_object('ok', false);
  END IF;

  -- Trova l'elemento il cui id corrisponde al masterset_id dello share.
  FOR v_elem IN SELECT * FROM jsonb_array_elements(v_arr)
  LOOP
    IF v_elem ->> 'id' = v_share.masterset_id THEN
      v_ms := v_elem;
      EXIT;
    END IF;
  END LOOP;

  IF v_ms IS NULL THEN
    RETURN jsonb_build_object('ok', false);
  END IF;

  SELECT full_name INTO v_owner FROM profiles WHERE id = v_share.user_id;

  RETURN jsonb_build_object(
    'ok',         true,
    'title',      v_share.title,
    'filter',     v_share.filter,
    'view_count', v_share.view_count,
    'created_at', v_share.created_at,
    'owner_name', v_owner,
    'masterset',  v_ms
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_public_masterset(TEXT) TO anon, authenticated;

-- ── 6. RPC per incrementare view count (best-effort, non critico) ────
CREATE OR REPLACE FUNCTION incr_masterset_share_view(p_token TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE masterset_shares
     SET view_count = view_count + 1
   WHERE token = p_token
     AND is_active = TRUE
     AND (expires_at IS NULL OR expires_at > now());
END;
$$;

GRANT EXECUTE ON FUNCTION incr_masterset_share_view(TEXT) TO anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════
--  FINE MIGRATION 085
-- ═══════════════════════════════════════════════════════════════════════
