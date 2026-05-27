-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Migration 078: persistenza per-condizione da listing CM
--
--  Contesto: in verifyPrice() l'app ottiene gia' srv.listings (prezzo +
--  condizione + rank) per la carta che si sta quotando, via smooth-endpoint.
--  Finora quel dato veniva usato per il preventivo e poi perso. Questa
--  migration lo PERSISTE in cm_price_by_condition (creata in 075), cosi' il
--  catalogo per-condizione cresce sulle carte realmente trattate.
--
--  Aggiunte:
--   • cm_price_by_condition.card_key — aggancio stabile lato app
--     (set_id|number|language|variant|firstEd), indipendente dall'idProduct CM
--     (che non sempre e' disponibile nel flusso).
--   • cm_price_by_condition.card_name / source / cm_url — contesto utile.
--   • RPC cm_upsert_condition_from_listings(card_key, meta, listings[]):
--     fa l'aggregazione lato DB (3 minimi + media per condizione) da una lista
--     grezza di {price, condition, condRank}. Logica in UN solo posto,
--     riusabile sia da verifyPrice sia dal bridge userscript.
--   • RPC cm_get_condition_prices(card_key, max_age_days): lettura con TTL,
--     per evitare di riscrapare CM se il dato e' fresco.
--
--  La PK di cm_price_by_condition (075) e' (id_product, condition, is_foil).
--  Per il flusso app usiamo card_key come identita': quindi spostiamo l'unicita'
--  su (card_key, condition, is_foil) con un id_product sintetico se assente.
-- ═══════════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════════
--  1) Estendi cm_price_by_condition
--
--  NB: la PK di 075 e' (id_product, condition, is_foil) e id_product e' in PK
--  (quindi NOT NULL non rimovibile). Nel flusso app non abbiamo l'idProduct CM,
--  quindi derivo un id_product SINTETICO deterministico dalla card_key
--  (hash stabile, namespace negativo per non collidere con gli idProduct reali
--  positivi del price guide). Cosi' la PK esistente regge e l'upsert e'
--  idempotente sulla stessa carta.
-- ══════════════════════════════════════════════════════════════════════
ALTER TABLE public.cm_price_by_condition
  ADD COLUMN IF NOT EXISTS card_key   TEXT,
  ADD COLUMN IF NOT EXISTS card_name  TEXT,
  ADD COLUMN IF NOT EXISTS source     TEXT DEFAULT 'verifyPrice',
  ADD COLUMN IF NOT EXISTS cm_url     TEXT;

CREATE INDEX IF NOT EXISTS cm_pbc_cardkey_idx
  ON public.cm_price_by_condition (card_key) WHERE card_key IS NOT NULL;

-- id_product sintetico deterministico da card_key:
--   hashtextextended e' stabile e built-in; lo mappo nello spazio negativo
--   per non collidere con gli idProduct reali (positivi).
CREATE OR REPLACE FUNCTION public.cm_synthetic_id(p_card_key TEXT)
RETURNS BIGINT
LANGUAGE sql IMMUTABLE
AS $$
  SELECT -1 - (abs(hashtextextended(p_card_key, 0)) % 4611686018427387903)::BIGINT
$$;


-- ══════════════════════════════════════════════════════════════════════
--  2) RPC: aggrega listing grezzi → 3 minimi + media per condizione
--
--  p_listings: array di {price, condition, condRank, isFoil?}
--  p_meta:     {cardName?, cmUrl?, source?}
--  Per ogni (condizione, isFoil) presente nei listing:
--    low1/low2/low3 = 3 prezzi piu' bassi; avg = media; n_listings = conteggio.
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.cm_upsert_condition_from_listings(
  p_card_key TEXT,
  p_meta     JSONB,
  p_listings JSONB
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count INT := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Forbidden: authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_card_key IS NULL OR length(trim(p_card_key)) = 0 THEN
    RAISE EXCEPTION 'card_key mancante';
  END IF;
  IF p_listings IS NULL OR jsonb_typeof(p_listings) <> 'array' THEN
    RAISE EXCEPTION 'p_listings deve essere un array JSON';
  END IF;

  WITH raw AS (
    SELECT
      COALESCE(NULLIF(l->>'condition',''), 'Near Mint')        AS condition,
      COALESCE((l->>'isFoil')::BOOLEAN, false)                 AS is_foil,
      NULLIF(l->>'price','')::NUMERIC                          AS price,
      NULLIF(l->>'condRank','')::INT                           AS cond_rank
    FROM jsonb_array_elements(p_listings) AS l
    WHERE NULLIF(l->>'price','') IS NOT NULL
      AND COALESCE(NULLIF(l->>'condition',''),'Near Mint')
          IN ('Mint','Near Mint','Excellent','Good','Light Played','Played','Poor')
  ),
  ranked AS (
    SELECT *,
           ROW_NUMBER() OVER (PARTITION BY condition, is_foil ORDER BY price ASC) AS rn
    FROM raw
  ),
  agg AS (
    SELECT
      condition,
      is_foil,
      MAX(cond_rank)                                        AS cond_rank,
      MIN(price)                                            AS low1,
      MIN(price) FILTER (WHERE rn = 2)                      AS low2,
      MIN(price) FILTER (WHERE rn = 3)                      AS low3,
      ROUND(AVG(price), 2)                                  AS avg,
      COUNT(*)                                              AS n_listings
    FROM ranked
    GROUP BY condition, is_foil
  )
  INSERT INTO public.cm_price_by_condition AS pc (
    id_product, card_key, card_name, source, cm_url,
    condition, cond_rank, low1, low2, low3, avg, n_listings, is_foil, captured_at
  )
  SELECT
    public.cm_synthetic_id(p_card_key),
    p_card_key,
    NULLIF(p_meta->>'cardName',''),
    COALESCE(NULLIF(p_meta->>'source',''), 'verifyPrice'),
    NULLIF(p_meta->>'cmUrl',''),
    a.condition,
    COALESCE(a.cond_rank,
      CASE a.condition WHEN 'Mint' THEN 1 WHEN 'Near Mint' THEN 2
        WHEN 'Excellent' THEN 3 WHEN 'Good' THEN 4 WHEN 'Light Played' THEN 5
        WHEN 'Played' THEN 6 WHEN 'Poor' THEN 7 ELSE 5 END),
    a.low1, a.low2, a.low3, a.avg, a.n_listings, a.is_foil, now()
  FROM agg a
  ON CONFLICT (id_product, condition, is_foil) DO UPDATE SET
    card_key    = EXCLUDED.card_key,
    card_name   = COALESCE(EXCLUDED.card_name, pc.card_name),
    source      = EXCLUDED.source,
    cm_url      = COALESCE(EXCLUDED.cm_url, pc.cm_url),
    cond_rank   = EXCLUDED.cond_rank,
    low1        = EXCLUDED.low1,
    low2        = EXCLUDED.low2,
    low3        = EXCLUDED.low3,
    avg         = EXCLUDED.avg,
    n_listings  = EXCLUDED.n_listings,
    captured_at = now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.cm_upsert_condition_from_listings(TEXT, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cm_upsert_condition_from_listings(TEXT, JSONB, JSONB) TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  3) RPC: lettura per-condizione con TTL (evita riscrape se fresco)
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.cm_get_condition_prices(
  p_card_key     TEXT,
  p_max_age_days INT DEFAULT 7
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rows JSONB;
  v_fresh BOOLEAN := false;
  v_captured TIMESTAMPTZ;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Forbidden: authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT MAX(captured_at) INTO v_captured
  FROM public.cm_price_by_condition
  WHERE card_key = p_card_key;

  IF v_captured IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  v_fresh := v_captured >= now() - make_interval(days => p_max_age_days);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'condition', condition, 'condRank', cond_rank,
            'low1', low1, 'low2', low2, 'low3', low3,
            'avg', avg, 'nListings', n_listings, 'isFoil', is_foil
          ) ORDER BY cond_rank), '[]'::jsonb)
    INTO v_rows
  FROM public.cm_price_by_condition
  WHERE card_key = p_card_key;

  RETURN jsonb_build_object(
    'found', true,
    'fresh', v_fresh,
    'captured_at', v_captured,
    'age_days', EXTRACT(EPOCH FROM (now() - v_captured)) / 86400.0,
    'conditions', v_rows
  );
END $$;

REVOKE ALL ON FUNCTION public.cm_get_condition_prices(TEXT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cm_get_condition_prices(TEXT, INT) TO authenticated;


NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 078_cm_condition_persistence.sql
--
--  card_key (convenzione app): lower(set_id)|number|language|variant|fe
--   es. 'df|100|ITA|Normal|0'
--  Test:
--   SELECT public.cm_upsert_condition_from_listings(
--     'df|100|ITA|Normal|0',
--     '{"cardName":"Charizard","cmUrl":"https://...","source":"verifyPrice"}'::jsonb,
--     '[{"price":40,"condition":"Near Mint","condRank":2},
--       {"price":42,"condition":"Near Mint","condRank":2},
--       {"price":38,"condition":"Mint","condRank":1}]'::jsonb);
--   SELECT public.cm_get_condition_prices('df|100|ITA|Normal|0', 7);
-- ═══════════════════════════════════════════════════════════════════════
