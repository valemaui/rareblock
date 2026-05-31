-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Migration 079: storico per-condizione + valore collezione
--
--  Contesto: la 075/078 hanno già:
--   • cm_price_by_condition  — prezzi per condizione (NM/EX/GD/PL/PO) per card_key
--   • cm_price_history       — snapshot SETTIMANALE ma SOLO product-level
--                              (low/avg/trend), non per-condizione né per card_key
--   • cm_snapshot_weekly()   — cron lun 04:30 che congela cm_price_guide
--
--  Mancano i 3 pezzi per il "listino settimanale + valore nel tempo":
--
--   1) STORICO PER-CONDIZIONE  → cm_condition_history
--      Congela settimanalmente cm_price_by_condition keyed by card_key.
--      È la serie storica dietro il grafico RAW per-condizione (screenshot).
--
--   2) VALORE COLLEZIONE NEL TEMPO → collection_value_history
--      Una riga per (user, settimana): valore totale collezione valutato ai
--      prezzi correnti per-condizione. Più breakdown (n_carte, n_valutate).
--      RPC collection_snapshot_all() la popola per tutti gli utenti (cron).
--
--   3) READ API per i grafici → cm_get_condition_history / collection_value_series
--
--  Tutto SECURITY DEFINER, scrittura via RPC, lettura RLS-scoped.
--  Pattern identico a 075/076/078.
-- ═══════════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════════
--  1) STORICO PER-CONDIZIONE — cm_condition_history
--
--  Keyed by card_key (convenzione app: set_id|number|LANG|variant|fe), non
--  da id_product CM (che spesso non abbiamo). 1 riga per
--  (card_key, condition, is_foil, snapshot_week). Idempotente sulla settimana.
-- ══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.cm_condition_history (
  card_key      TEXT    NOT NULL,
  condition     TEXT    NOT NULL
                CHECK (condition IN ('Mint','Near Mint','Excellent','Good',
                                      'Light Played','Played','Poor')),
  is_foil       BOOLEAN NOT NULL DEFAULT false,
  snapshot_week DATE    NOT NULL,                 -- lunedì ISO
  cond_rank     INT,
  low1          NUMERIC(12,2),
  low2          NUMERIC(12,2),
  low3          NUMERIC(12,2),
  avg           NUMERIC(12,2),
  n_listings    INT,
  card_name     TEXT,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (card_key, condition, is_foil, snapshot_week)
);

CREATE INDEX IF NOT EXISTS cm_condition_history_key_idx
  ON public.cm_condition_history (card_key, snapshot_week);
CREATE INDEX IF NOT EXISTS cm_condition_history_week_idx
  ON public.cm_condition_history (snapshot_week);


-- ══════════════════════════════════════════════════════════════════════
--  2) VALORE COLLEZIONE NEL TEMPO — collection_value_history
--
--  1 riga per (user_id, snapshot_week). Valore = somma su tutte le carte
--  dell'utente di (qty × prezzo_per_condizione). Il prezzo per-condizione è
--  preso da cm_price_by_condition via card_key+condition; se assente per la
--  condizione esatta, fallback alla condizione più vicina disponibile.
-- ══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.collection_value_history (
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  snapshot_week  DATE NOT NULL,                   -- lunedì ISO
  currency       TEXT NOT NULL DEFAULT 'EUR',
  total_value    NUMERIC(14,2) NOT NULL DEFAULT 0,  -- valore di mercato (CM)
  total_cost     NUMERIC(14,2) NOT NULL DEFAULT 0,  -- somma buy_price (costo)
  n_cards        INT NOT NULL DEFAULT 0,            -- carte totali (somma qty)
  n_valued       INT NOT NULL DEFAULT 0,            -- carte con prezzo trovato
  n_distinct     INT NOT NULL DEFAULT 0,            -- righe distinte in collezione
  captured_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, snapshot_week)
);

CREATE INDEX IF NOT EXISTS collection_value_history_user_idx
  ON public.collection_value_history (user_id, snapshot_week);


-- ══════════════════════════════════════════════════════════════════════
--  3) RLS
-- ══════════════════════════════════════════════════════════════════════
ALTER TABLE public.cm_condition_history      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collection_value_history  ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- cm_condition_history: dato di mercato → lettura per tutti gli authenticated
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname='public' AND tablename='cm_condition_history'
                    AND policyname='cm_condition_history_read') THEN
    CREATE POLICY cm_condition_history_read ON public.cm_condition_history
      FOR SELECT TO authenticated USING (true);
  END IF;

  -- collection_value_history: dato personale → solo il proprietario
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname='public' AND tablename='collection_value_history'
                    AND policyname='collection_value_history_own') THEN
    CREATE POLICY collection_value_history_own ON public.collection_value_history
      FOR SELECT TO authenticated USING (user_id = auth.uid());
  END IF;
END $$;


-- ══════════════════════════════════════════════════════════════════════
--  4) Mappa set_name → set_id
--
--  IMPORTANTE: la tabella `cards` NON ha la colonna set_id (vedi migration
--  068: set_id esiste solo sugli item dei preventivi, non sulla collezione).
--  Le carte salvano `set_name` ("Base Set"), ma il card_key — la chiave con
--  cui cm_price_by_condition è indicizzata — usa il set_id ("base1").
--  Serve quindi una mappa SQL nome→id, allineata 1:1 a CM_SET_NAME_TO_ID
--  (definito in pokemon-db.html). Seed sotto.
-- ══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.cm_set_name_map (
  set_name TEXT PRIMARY KEY,
  set_id   TEXT NOT NULL
);

INSERT INTO public.cm_set_name_map (set_name, set_id) VALUES
    ($$Base Set$$, 'base1'),
    ($$Jungle$$, 'base2'),
    ($$Fossil$$, 'base3'),
    ($$Base Set 2$$, 'base4'),
    ($$Team Rocket$$, 'base5'),
    ($$Legendary Collection$$, 'base6'),
    ($$Gym Heroes$$, 'gym1'),
    ($$Gym Challenge$$, 'gym2'),
    ($$Neo Genesis$$, 'neo1'),
    ($$Neo Discovery$$, 'neo2'),
    ($$Neo Revelation$$, 'neo3'),
    ($$Neo Destiny$$, 'neo4'),
    ($$Southern Islands$$, 'si1'),
    ($$Expedition Base Set$$, 'ecard1'),
    ($$Aquapolis$$, 'ecard2'),
    ($$Skyridge$$, 'ecard3'),
    ($$EX Ruby & Sapphire$$, 'ex1'),
    ($$EX Sandstorm$$, 'ex2'),
    ($$EX Dragon$$, 'ex3'),
    ($$EX Team Magma vs Team Aqua$$, 'ex4'),
    ($$EX Hidden Legends$$, 'ex5'),
    ($$EX FireRed & LeafGreen$$, 'ex6'),
    ($$EX Team Rocket Returns$$, 'ex7'),
    ($$EX Deoxys$$, 'ex8'),
    ($$EX Emerald$$, 'ex9'),
    ($$EX Unseen Forces$$, 'ex10'),
    ($$EX Delta Species$$, 'ex11'),
    ($$EX Legend Maker$$, 'ex12'),
    ($$EX Holon Phantoms$$, 'ex13'),
    ($$EX Crystal Guardians$$, 'ex14'),
    ($$EX Dragon Frontiers$$, 'ex15'),
    ($$EX Power Keepers$$, 'ex16'),
    ($$Diamond & Pearl$$, 'dp1'),
    ($$Mysterious Treasures$$, 'dp2'),
    ($$Secret Wonders$$, 'dp3'),
    ($$Great Encounters$$, 'dp4'),
    ($$Majestic Dawn$$, 'dp5'),
    ($$Legends Awakened$$, 'dp6'),
    ($$Stormfront$$, 'dp7'),
    ($$Platinum$$, 'pl1'),
    ($$Rising Rivals$$, 'pl2'),
    ($$Supreme Victors$$, 'pl3'),
    ($$Arceus$$, 'pl4'),
    ($$HeartGold & SoulSilver$$, 'hgss1'),
    ($$Unleashed$$, 'hgss2'),
    ($$Undaunted$$, 'hgss3'),
    ($$Triumphant$$, 'hgss4'),
    ($$Call of Legends$$, 'col1'),
    ($$Black & White$$, 'bw1'),
    ($$Emerging Powers$$, 'bw2'),
    ($$Noble Victories$$, 'bw3'),
    ($$Next Destinies$$, 'bw4'),
    ($$Dark Explorers$$, 'bw5'),
    ($$Dragons Exalted$$, 'bw6'),
    ($$Boundaries Crossed$$, 'bw7'),
    ($$Plasma Storm$$, 'bw8'),
    ($$Plasma Freeze$$, 'bw9'),
    ($$Plasma Blast$$, 'bw10'),
    ($$Legendary Treasures$$, 'bw11'),
    ($$XY$$, 'xy1'),
    ($$Flashfire$$, 'xy2'),
    ($$Furious Fists$$, 'xy3'),
    ($$Phantom Forces$$, 'xy4'),
    ($$Primal Clash$$, 'xy5'),
    ($$Roaring Skies$$, 'xy6'),
    ($$Ancient Origins$$, 'xy7'),
    ($$BREAKthrough$$, 'xy8'),
    ($$BREAKpoint$$, 'xy9'),
    ($$Fates Collide$$, 'xy10'),
    ($$Steam Siege$$, 'xy11'),
    ($$Evolutions$$, 'xy12'),
    ($$Sun & Moon$$, 'sm1'),
    ($$Guardians Rising$$, 'sm2'),
    ($$Burning Shadows$$, 'sm3'),
    ($$Crimson Invasion$$, 'sm4'),
    ($$Ultra Prism$$, 'sm5'),
    ($$Forbidden Light$$, 'sm6'),
    ($$Celestial Storm$$, 'sm7'),
    ($$Lost Thunder$$, 'sm8'),
    ($$Team Up$$, 'sm9'),
    ($$Unbroken Bonds$$, 'sm10'),
    ($$Unified Minds$$, 'sm11'),
    ($$Cosmic Eclipse$$, 'sm12'),
    ($$Sword & Shield$$, 'swsh1'),
    ($$Rebel Clash$$, 'swsh2'),
    ($$Darkness Ablaze$$, 'swsh3'),
    ($$Vivid Voltage$$, 'swsh4'),
    ($$Battle Styles$$, 'swsh5'),
    ($$Chilling Reign$$, 'swsh6'),
    ($$Evolving Skies$$, 'swsh7'),
    ($$Fusion Strike$$, 'swsh8'),
    ($$Brilliant Stars$$, 'swsh9'),
    ($$Astral Radiance$$, 'swsh10'),
    ($$Lost Origin$$, 'swsh11'),
    ($$Silver Tempest$$, 'swsh12'),
    ($$Crown Zenith$$, 'swsh12pt5'),
    ($$Scarlet & Violet$$, 'sv1'),
    ($$Paldea Evolved$$, 'sv2'),
    ($$Obsidian Flames$$, 'sv3'),
    ($$151$$, 'sv3pt5'),
    ($$Paradox Rift$$, 'sv4'),
    ($$Paldean Fates$$, 'sv4pt5'),
    ($$Temporal Forces$$, 'sv5'),
    ($$Twilight Masquerade$$, 'sv6'),
    ($$Shrouded Fable$$, 'sv6pt5'),
    ($$Stellar Crown$$, 'sv7'),
    ($$Surging Sparks$$, 'sv7pt5'),
    ($$Prismatic Evolutions$$, 'sv8')
ON CONFLICT (set_name) DO UPDATE SET set_id = EXCLUDED.set_id;

ALTER TABLE public.cm_set_name_map ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname='public' AND tablename='cm_set_name_map'
                    AND policyname='cm_set_name_map_read') THEN
    CREATE POLICY cm_set_name_map_read ON public.cm_set_name_map
      FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

-- Risolve set_name → set_id (case-insensitive). Ritorna '' se ignoto.
CREATE OR REPLACE FUNCTION public.rb_set_id_from_name(p_set_name TEXT)
RETURNS TEXT
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT set_id FROM public.cm_set_name_map
      WHERE lower(set_name) = lower(trim(COALESCE(p_set_name,''))) LIMIT 1),
    '')
$$;


-- ══════════════════════════════════════════════════════════════════════
--  4b) Helper: card_key dalla riga cards (stessa convenzione dell'app)
--     set_id|number|LANG|variant|fe   (es. 'base1|4|ITA|Normal|0')
--     Accetta direttamente set_id (se noto) altrimenti set_name da risolvere.
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.rb_card_key(
  p_set_id TEXT, p_number TEXT, p_language TEXT, p_variant TEXT, p_first_ed BOOLEAN
)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
AS $$
  SELECT lower(trim(COALESCE(p_set_id,'')))   || '|' ||
         lower(trim(COALESCE(p_number,'')))    || '|' ||
         upper(trim(COALESCE(NULLIF(p_language,''),'ITA'))) || '|' ||
         trim(COALESCE(NULLIF(p_variant,''),'Normal'))      || '|' ||
         CASE WHEN p_first_ed THEN '1' ELSE '0' END
$$;

-- Mappa condizione carta (sigle app) → label canonica cm_price_by_condition
CREATE OR REPLACE FUNCTION public.rb_cond_label(p_cond TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE upper(trim(COALESCE(p_cond,'NM')))
    WHEN 'MINT' THEN 'Mint'   WHEN 'MT' THEN 'Mint'
    WHEN 'NM'   THEN 'Near Mint' WHEN 'NEAR MINT' THEN 'Near Mint'
    WHEN 'EX'   THEN 'Excellent'  WHEN 'EXCELLENT' THEN 'Excellent'
    WHEN 'GD'   THEN 'Good'       WHEN 'GOOD' THEN 'Good'
    WHEN 'LP'   THEN 'Light Played' WHEN 'LIGHT PLAYED' THEN 'Light Played'
    WHEN 'PL'   THEN 'Played'     WHEN 'PLAYED' THEN 'Played'
    WHEN 'PO'   THEN 'Poor'       WHEN 'POOR' THEN 'Poor'
    ELSE 'Near Mint'
  END
$$;

CREATE OR REPLACE FUNCTION public.rb_cond_rank(p_label TEXT)
RETURNS INT
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE p_label
    WHEN 'Mint' THEN 1 WHEN 'Near Mint' THEN 2 WHEN 'Excellent' THEN 3
    WHEN 'Good' THEN 4 WHEN 'Light Played' THEN 5 WHEN 'Played' THEN 6
    WHEN 'Poor' THEN 7 ELSE 2 END
$$;


-- ══════════════════════════════════════════════════════════════════════
--  5) SNAPSHOT per-condizione: cm_price_by_condition → cm_condition_history
--     Congela il dato corrente sulla settimana ISO. Idempotente.
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.cm_condition_snapshot_weekly()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_week  DATE := date_trunc('week', now())::DATE;
  v_count INT;
BEGIN
  INSERT INTO public.cm_condition_history AS h (
    card_key, condition, is_foil, snapshot_week,
    cond_rank, low1, low2, low3, avg, n_listings, card_name, captured_at
  )
  SELECT
    pc.card_key, pc.condition, pc.is_foil, v_week,
    pc.cond_rank, pc.low1, pc.low2, pc.low3, pc.avg, pc.n_listings, pc.card_name, now()
  FROM public.cm_price_by_condition pc
  WHERE pc.card_key IS NOT NULL
  ON CONFLICT (card_key, condition, is_foil, snapshot_week) DO UPDATE SET
    cond_rank   = EXCLUDED.cond_rank,
    low1        = EXCLUDED.low1,
    low2        = EXCLUDED.low2,
    low3        = EXCLUDED.low3,
    avg         = EXCLUDED.avg,
    n_listings  = EXCLUDED.n_listings,
    card_name   = COALESCE(EXCLUDED.card_name, h.card_name),
    captured_at = now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.cm_condition_snapshot_weekly() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cm_condition_snapshot_weekly() TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  6) VALUTAZIONE COLLEZIONE — funzione core riusabile
--
--  Valuta la collezione di UN utente ai prezzi correnti per-condizione.
--  Per ogni carta: card_key + condizione → cerca prezzo in cm_price_by_condition.
--   • prezzo unitario = low1 della condizione esatta (è il "prezzo da" CM);
--   • se manca la condizione esatta → prende la condizione DISPONIBILE più
--     vicina per rank (preferendo la migliore non sotto, poi la peggiore);
--   • foil: usa is_foil=true se variant indica Holo/Reverse, altrimenti false.
--  Ritorna aggregati (no scrittura). Usata sia dal snapshot sia dalla UI live.
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.collection_value_compute(p_user UUID)
RETURNS TABLE (
  total_value NUMERIC,
  total_cost  NUMERIC,
  n_cards     INT,
  n_valued    INT,
  n_distinct  INT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH col AS (
    SELECT
      c.id,
      GREATEST(COALESCE(c.qty,1),1)                              AS qty,
      COALESCE(c.buy_price,0)                                    AS buy_price,
      public.rb_cond_label(c.condition)                         AS cond_label,
      (COALESCE(c.variant,'') ILIKE '%holo%'
        OR COALESCE(c.variant,'') ILIKE '%reverse%')            AS is_foil,
      -- cards NON ha set_id → risolvi da set_name (vedi migration 068)
      public.rb_card_key(public.rb_set_id_from_name(c.set_name),
                         c.card_number, c.language,
                         c.variant, COALESCE(c.first_edition,false)) AS card_key
    FROM public.cards c
    WHERE c.user_id = p_user
  ),
  priced AS (
    SELECT
      col.*,
      -- prezzo condizione esatta
      (SELECT pc.low1 FROM public.cm_price_by_condition pc
        WHERE pc.card_key = col.card_key
          AND pc.condition = col.cond_label
          AND pc.is_foil  = col.is_foil
        LIMIT 1)                                                 AS exact_price,
      -- fallback: qualsiasi condizione per quella carta (rank più vicino)
      (SELECT pc.low1 FROM public.cm_price_by_condition pc
        WHERE pc.card_key = col.card_key
          AND pc.is_foil = col.is_foil
        ORDER BY abs(COALESCE(pc.cond_rank, public.rb_cond_rank(col.cond_label))
                     - public.rb_cond_rank(col.cond_label)) ASC,
                 pc.cond_rank ASC
        LIMIT 1)                                                 AS near_price
    FROM col
  ),
  final AS (
    SELECT
      qty, buy_price,
      COALESCE(exact_price, near_price) AS unit_price
    FROM priced
  )
  SELECT
    COALESCE(SUM(CASE WHEN unit_price IS NOT NULL
                      THEN unit_price * qty ELSE 0 END), 0)::NUMERIC AS total_value,
    COALESCE(SUM(buy_price * qty), 0)::NUMERIC                       AS total_cost,
    COALESCE(SUM(qty), 0)::INT                                       AS n_cards,
    COALESCE(SUM(CASE WHEN unit_price IS NOT NULL THEN qty ELSE 0 END),0)::INT AS n_valued,
    COUNT(*)::INT                                                    AS n_distinct
  FROM final;
$$;

REVOKE ALL ON FUNCTION public.collection_value_compute(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.collection_value_compute(UUID) TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  7) SNAPSHOT VALORE: scrive collection_value_history per UN utente
--     (chiamabile dall'utente stesso → on-demand "fotografa adesso")
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.collection_snapshot_me()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_week DATE := date_trunc('week', now())::DATE;
  v RECORD;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Forbidden: authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v FROM public.collection_value_compute(v_user);

  INSERT INTO public.collection_value_history AS hh (
    user_id, snapshot_week, currency,
    total_value, total_cost, n_cards, n_valued, n_distinct, captured_at
  ) VALUES (
    v_user, v_week, 'EUR',
    v.total_value, v.total_cost, v.n_cards, v.n_valued, v.n_distinct, now()
  )
  ON CONFLICT (user_id, snapshot_week) DO UPDATE SET
    total_value = EXCLUDED.total_value,
    total_cost  = EXCLUDED.total_cost,
    n_cards     = EXCLUDED.n_cards,
    n_valued    = EXCLUDED.n_valued,
    n_distinct  = EXCLUDED.n_distinct,
    captured_at = now();

  RETURN jsonb_build_object(
    'week', v_week, 'total_value', v.total_value, 'total_cost', v.total_cost,
    'n_cards', v.n_cards, 'n_valued', v.n_valued, 'n_distinct', v.n_distinct
  );
END $$;

REVOKE ALL ON FUNCTION public.collection_snapshot_me() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.collection_snapshot_me() TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  8) SNAPSHOT VALORE per TUTTI gli utenti (cron settimanale)
--     SECURITY DEFINER, NON espone dati: scrive solo, ritorna conteggio.
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.collection_snapshot_all()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_week DATE := date_trunc('week', now())::DATE;
  v_count INT := 0;
  u RECORD;
  v RECORD;
BEGIN
  FOR u IN (SELECT DISTINCT user_id FROM public.cards WHERE user_id IS NOT NULL)
  LOOP
    SELECT * INTO v FROM public.collection_value_compute(u.user_id);
    INSERT INTO public.collection_value_history AS hh (
      user_id, snapshot_week, currency,
      total_value, total_cost, n_cards, n_valued, n_distinct, captured_at
    ) VALUES (
      u.user_id, v_week, 'EUR',
      v.total_value, v.total_cost, v.n_cards, v.n_valued, v.n_distinct, now()
    )
    ON CONFLICT (user_id, snapshot_week) DO UPDATE SET
      total_value = EXCLUDED.total_value,
      total_cost  = EXCLUDED.total_cost,
      n_cards     = EXCLUDED.n_cards,
      n_valued    = EXCLUDED.n_valued,
      n_distinct  = EXCLUDED.n_distinct,
      captured_at = now();
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.collection_snapshot_all() FROM PUBLIC, anon;
-- NON grant a authenticated: solo cron (postgres) la chiama.


-- ══════════════════════════════════════════════════════════════════════
--  9) READ API per i grafici
-- ══════════════════════════════════════════════════════════════════════

-- 9a) Storico per-condizione di UNA carta (per il grafico RAW dello screenshot)
--     Ritorna serie temporale per ciascuna condizione disponibile.
CREATE OR REPLACE FUNCTION public.cm_get_condition_history(
  p_card_key TEXT,
  p_is_foil  BOOLEAN DEFAULT NULL,    -- NULL = entrambe
  p_weeks    INT     DEFAULT 52
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rows JSONB;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Forbidden: authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'week', snapshot_week,
            'condition', condition,
            'condRank', cond_rank,
            'isFoil', is_foil,
            'low1', low1, 'avg', avg, 'nListings', n_listings
          ) ORDER BY condition, snapshot_week), '[]'::jsonb)
    INTO v_rows
  FROM public.cm_condition_history
  WHERE card_key = p_card_key
    AND (p_is_foil IS NULL OR is_foil = p_is_foil)
    AND snapshot_week >= (date_trunc('week', now())::DATE - (p_weeks * 7));

  RETURN jsonb_build_object(
    'found', (jsonb_array_length(v_rows) > 0),
    'card_key', p_card_key,
    'series', v_rows
  );
END $$;

REVOKE ALL ON FUNCTION public.cm_get_condition_history(TEXT, BOOLEAN, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cm_get_condition_history(TEXT, BOOLEAN, INT) TO authenticated;


-- 9b) Serie valore collezione dell'utente corrente (per il grafico portfolio)
CREATE OR REPLACE FUNCTION public.collection_value_series(
  p_weeks INT DEFAULT 52
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_rows JSONB;
  v_live RECORD;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Forbidden: authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'week', snapshot_week,
            'total_value', total_value,
            'total_cost', total_cost,
            'n_cards', n_cards,
            'n_valued', n_valued,
            'n_distinct', n_distinct
          ) ORDER BY snapshot_week), '[]'::jsonb)
    INTO v_rows
  FROM public.collection_value_history
  WHERE user_id = v_user
    AND snapshot_week >= (date_trunc('week', now())::DATE - (p_weeks * 7));

  -- Valore live "adesso" (non ancora snapshotato) per il punto finale del grafico
  SELECT * INTO v_live FROM public.collection_value_compute(v_user);

  RETURN jsonb_build_object(
    'series', v_rows,
    'live', jsonb_build_object(
      'total_value', v_live.total_value, 'total_cost', v_live.total_cost,
      'n_cards', v_live.n_cards, 'n_valued', v_live.n_valued,
      'n_distinct', v_live.n_distinct
    )
  );
END $$;

REVOKE ALL ON FUNCTION public.collection_value_series(INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.collection_value_series(INT) TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  10) CRON: estende il job settimanale esistente
--      Dopo cm_snapshot_weekly (075/076), aggiunge:
--       • cm_condition_snapshot_weekly()  (per-condizione → history)
--       • collection_snapshot_all()       (valore collezione tutti gli utenti)
--      Schedule: lunedì 05:00 UTC (dopo il job 04:30 di 076).
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.rb_weekly_price_rollup()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cond INT;
  v_users INT;
BEGIN
  v_cond  := public.cm_condition_snapshot_weekly();
  v_users := public.collection_snapshot_all();
  RETURN jsonb_build_object(
    'condition_rows', v_cond,
    'users_snapshotted', v_users,
    'week', date_trunc('week', now())::DATE
  );
END $$;

REVOKE ALL ON FUNCTION public.rb_weekly_price_rollup() FROM PUBLIC, anon;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron non installata. Abilitare da Dashboard → Database → Extensions, poi rieseguire 079.';
    RETURN;
  END IF;

  PERFORM cron.unschedule('rb_weekly_price_rollup')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rb_weekly_price_rollup');

  PERFORM cron.schedule(
    'rb_weekly_price_rollup',
    '0 5 * * 1',   -- lunedì 05:00 UTC
    $cron$ SELECT public.rb_weekly_price_rollup(); $cron$
  );

  RAISE NOTICE 'pg_cron job rb_weekly_price_rollup schedulato (lun 05:00 UTC)';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron schedule fallito: %', SQLERRM;
END $$;


NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 079_price_history_and_collection_value.sql
--
--  Test manuali:
--   • Snapshot per-condizione ora: SELECT public.cm_condition_snapshot_weekly();
--   • Snapshot valore mia collezione: SELECT public.collection_snapshot_me();
--   • Serie valore: SELECT public.collection_value_series(52);
--   • Storico carta: SELECT public.cm_get_condition_history('base1|4|ITA|Normal|0', NULL, 52);
--   • Rollup completo (cron): SELECT public.rb_weekly_price_rollup();
-- ═══════════════════════════════════════════════════════════════════════
