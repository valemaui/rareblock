-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Migration 089: prezzi per TIPOLOGIA VENDITORE (bucket)
--
--  Contesto: extractCMListings (smooth-endpoint) marca già ogni listing con
--  has_photo (foto reale del venditore) e is_professional (omino CM). Finora
--  l'aggregazione per-condizione (cm_upsert_condition_from_listings, 078)
--  collassava tutto in low1/low2/low3 + avg, ignorando quei flag.
--
--  Questa migration aggiunge la dimensione "tipologia venditore", così per
--  ogni (carta, condizione) otteniamo i tre tagli richiesti:
--    • all   → tutte le occorrenze
--    • photo → solo listing con foto del venditore
--    • pro   → solo venditori professionali
--  e per ciascun taglio: i 5 minimi (lows), media-top-3 (avg3), media-top-5
--  (avg5), conteggio (n). Niente scelta hardcoded 3-vs-5: salviamo entrambi,
--  il consumatore sceglie. Esempio "Clefairy 1" condizione PO →
--    buckets.all.lows[0]   = prezzo minimo
--    buckets.photo.lows[0] = prezzo minimo con foto
--    buckets.pro.lows[0]   = prezzo minimo professionale
--    buckets.all.avg3/avg5 = media prezzo (3/5)        [e così photo/pro]
--
--  Compatibilità: le colonne low1/low2/low3/avg restano (= taglio "all"),
--  niente reader esistente si rompe. Il nuovo dato sta nella colonna JSONB
--  buckets. Anche il reader cm_get_condition_prices ora espone buckets.
-- ═══════════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════════
--  1) Colonna buckets su cm_price_by_condition
-- ══════════════════════════════════════════════════════════════════════
ALTER TABLE public.cm_price_by_condition
  ADD COLUMN IF NOT EXISTS buckets JSONB;

COMMENT ON COLUMN public.cm_price_by_condition.buckets IS
  'Prezzi per tipologia venditore: {all,photo,pro} → {lows[5],avg3,avg5,n}';


-- ══════════════════════════════════════════════════════════════════════
--  2) Helper: array di prezzi → {lows[5], avg3, avg5, n}
--
--  Ordina crescente, scarta null/<=0, prende i 5 minimi e le medie dei primi
--  3 e 5. Ritorna NULL se non ci sono prezzi (così il bucket photo/pro assente
--  diventa esplicitamente null, non un oggetto vuoto fuorviante).
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.cm_bucket_agg(p_prices NUMERIC[])
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $$
  WITH s AS (
    SELECT p, row_number() OVER (ORDER BY p ASC) AS rn
    FROM unnest(COALESCE(p_prices, ARRAY[]::NUMERIC[])) AS p
    WHERE p IS NOT NULL AND p > 0
  )
  SELECT CASE
    WHEN (SELECT count(*) FROM s) = 0 THEN NULL
    ELSE jsonb_build_object(
      'lows', (SELECT jsonb_agg(p ORDER BY rn) FROM s WHERE rn <= 5),
      'avg3', (SELECT round(avg(p), 2) FROM s WHERE rn <= 3),
      'avg5', (SELECT round(avg(p), 2) FROM s WHERE rn <= 5),
      'n',    (SELECT count(*) FROM s)
    )
  END
$$;

REVOKE ALL ON FUNCTION public.cm_bucket_agg(NUMERIC[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cm_bucket_agg(NUMERIC[]) TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  3) Aggregazione estesa: legge has_photo / is_professional dai listing,
--     calcola i tre bucket e li persiste in buckets (+ legacy low1..3/avg).
--
--  Firma INVARIATA (TEXT,JSONB,JSONB → INT): nessun DROP necessario, i call
--  site esistenti continuano a funzionare. I listing ora possono portare i
--  campi has_photo / is_professional (bool); se assenti → false (tutto va in
--  "all", photo/pro restano null).
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
      NULLIF(l->>'condRank','')::INT                           AS cond_rank,
      COALESCE((l->>'has_photo')::BOOLEAN, false)              AS has_photo,
      COALESCE((l->>'is_professional')::BOOLEAN, false)        AS is_pro
    FROM jsonb_array_elements(p_listings) AS l
    WHERE NULLIF(l->>'price','') IS NOT NULL
      AND COALESCE(NULLIF(l->>'condition',''),'Near Mint')
          IN ('Mint','Near Mint','Excellent','Good','Light Played','Played','Poor')
  ),
  agg AS (
    SELECT
      condition,
      is_foil,
      MAX(cond_rank)                                          AS cond_rank,
      array_agg(price)                                        AS all_p,
      array_agg(price) FILTER (WHERE has_photo)               AS photo_p,
      array_agg(price) FILTER (WHERE is_pro)                  AS pro_p,
      COUNT(*)                                                AS n_listings,
      ROUND(AVG(price), 2)                                    AS avg_all
    FROM raw
    GROUP BY condition, is_foil
  ),
  built AS (
    SELECT
      condition, is_foil, cond_rank, n_listings, avg_all,
      public.cm_bucket_agg(all_p)   AS b_all,
      public.cm_bucket_agg(photo_p) AS b_photo,
      public.cm_bucket_agg(pro_p)   AS b_pro
    FROM agg
  )
  INSERT INTO public.cm_price_by_condition AS pc (
    id_product, card_key, card_name, source, cm_url,
    condition, cond_rank, low1, low2, low3, avg, n_listings, is_foil,
    buckets, captured_at
  )
  SELECT
    public.cm_synthetic_id(p_card_key),
    p_card_key,
    NULLIF(p_meta->>'cardName',''),
    COALESCE(NULLIF(p_meta->>'source',''), 'verifyPrice'),
    NULLIF(p_meta->>'cmUrl',''),
    b.condition,
    COALESCE(b.cond_rank,
      CASE b.condition WHEN 'Mint' THEN 1 WHEN 'Near Mint' THEN 2
        WHEN 'Excellent' THEN 3 WHEN 'Good' THEN 4 WHEN 'Light Played' THEN 5
        WHEN 'Played' THEN 6 WHEN 'Poor' THEN 7 ELSE 5 END),
    (b.b_all->'lows'->>0)::NUMERIC,
    (b.b_all->'lows'->>1)::NUMERIC,
    (b.b_all->'lows'->>2)::NUMERIC,
    b.avg_all,
    b.n_listings,
    b.is_foil,
    jsonb_build_object('all', b.b_all, 'photo', b.b_photo, 'pro', b.b_pro),
    now()
  FROM built b
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
    buckets     = EXCLUDED.buckets,
    captured_at = now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.cm_upsert_condition_from_listings(TEXT, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cm_upsert_condition_from_listings(TEXT, JSONB, JSONB) TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  4) Reader: espone anche buckets (oltre ai legacy low1..3/avg)
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
            'avg', avg, 'nListings', n_listings, 'isFoil', is_foil,
            'buckets', buckets
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


-- PostgREST: ricarica lo schema cache
NOTIFY pgrst, 'reload schema';
