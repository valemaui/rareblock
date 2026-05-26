-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Migration 077: Adattamento per cardmarket-api.com (CMAPI)
--
--  La fonte per-condizione NON è più (solo) lo userscript ma l'API
--  legittima cardmarket-api.com (RapidAPI, piano Pro). Il suo formato
--  differisce dalla 075:
--   • dà lowest_near_mint + varianti per-paese (_DE/_FR/_ES/_IT)
--   • dà 7d_average / 30d_average (non i 3 minimi per ogni condizione)
--   • dà graded PSA/CGC
--   • ha un id interno CMAPI + card_number + episode.code
--
--  Strategia:
--   • cm_price_by_condition (075) resta per il dato dello userscript
--     (3 minimi reali per condizione, on-demand dal browser).
--   • NUOVA cm_market_price: snapshot CMAPI per carta+lingua, con i prezzi
--     per-paese e le medie. È QUESTA che il bootstrap + le chiamate utente
--     popolano via l'edge function cmapi-sync.
--
--  Lingue gestite: 'EN','IT','JP' (scope deciso col progetto).
-- ═══════════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════════
--  1) Tabella prezzi di mercato da CMAPI
-- ══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.cm_market_price (
  cmapi_id           BIGINT  NOT NULL,           -- id interno cardmarket-api
  language           TEXT    NOT NULL DEFAULT 'EN'
                     CHECK (language IN ('EN','IT','JP')),
  name               TEXT,
  name_numbered      TEXT,
  card_number        TEXT,
  rarity             TEXT,
  episode_code       TEXT,                       -- es. 'CRZ'
  episode_name       TEXT,
  currency           TEXT    NOT NULL DEFAULT 'EUR',

  -- Prezzi Cardmarket (EUR)
  lowest_near_mint   NUMERIC(12,2),
  lnm_de             NUMERIC(12,2),
  lnm_fr             NUMERIC(12,2),
  lnm_es             NUMERIC(12,2),
  lnm_it             NUMERIC(12,2),
  avg_7d             NUMERIC(12,2),
  avg_30d            NUMERIC(12,2),

  -- Graded (JSONB: struttura CMAPI psa/cgc/bgs → grade → prezzo)
  graded             JSONB,

  -- TCGplayer (USD) opzionale, per arbitraggio EU/US
  tcg_market_usd     NUMERIC(12,2),
  tcg_mid_usd        NUMERIC(12,2),

  image_url          TEXT,
  artist             TEXT,

  -- Collegamento opzionale al card_id interno RareBlock (mapping risolto a parte)
  rb_card_id         TEXT,

  fetched_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (cmapi_id, language)
);

CREATE INDEX IF NOT EXISTS cm_market_price_episode_idx
  ON public.cm_market_price (episode_code, language);
CREATE INDEX IF NOT EXISTS cm_market_price_name_idx
  ON public.cm_market_price (lower(name));
CREATE INDEX IF NOT EXISTS cm_market_price_rbcard_idx
  ON public.cm_market_price (rb_card_id) WHERE rb_card_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cm_market_price_fetched_idx
  ON public.cm_market_price (fetched_at);


-- Storico settimanale per i trend (riusa il pattern di 075)
CREATE TABLE IF NOT EXISTS public.cm_market_price_history (
  cmapi_id          BIGINT NOT NULL,
  language          TEXT   NOT NULL DEFAULT 'EN',
  snapshot_week     DATE   NOT NULL,
  currency          TEXT   NOT NULL DEFAULT 'EUR',
  lowest_near_mint  NUMERIC(12,2),
  lnm_it            NUMERIC(12,2),
  avg_7d            NUMERIC(12,2),
  avg_30d           NUMERIC(12,2),
  captured_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (cmapi_id, language, snapshot_week)
);

CREATE INDEX IF NOT EXISTS cm_market_price_history_week_idx
  ON public.cm_market_price_history (snapshot_week);


-- ══════════════════════════════════════════════════════════════════════
--  2) RLS — lettura authenticated, scrittura solo via RPC/service_role
-- ══════════════════════════════════════════════════════════════════════
ALTER TABLE public.cm_market_price          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cm_market_price_history  ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname='public' AND tablename='cm_market_price'
                    AND policyname='cm_market_price_read') THEN
    CREATE POLICY cm_market_price_read ON public.cm_market_price
      FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname='public' AND tablename='cm_market_price_history'
                    AND policyname='cm_market_price_history_read') THEN
    CREATE POLICY cm_market_price_history_read ON public.cm_market_price_history
      FOR SELECT TO authenticated USING (true);
  END IF;
END $$;


-- ══════════════════════════════════════════════════════════════════════
--  3) Ingest CMAPI (bulk upsert). Chiamata dall'edge function cmapi-sync
--     con service_role; in più consentita ad authenticated per gli update
--     on-demand guidati dalle chiamate utente.
--
--  Chiavi JSON attese (mappate dall'edge function dal formato CMAPI):
--   cmapiId, language, name, nameNumbered, cardNumber, rarity,
--   episodeCode, episodeName, currency, lowestNearMint,
--   lnmDE, lnmFR, lnmES, lnmIT, avg7d, avg30d, graded (jsonb),
--   tcgMarketUsd, tcgMidUsd, image, artist, rbCardId
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.cm_ingest_market_prices(p_rows JSONB)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count INT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Forbidden: authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'p_rows deve essere un array JSON';
  END IF;

  INSERT INTO public.cm_market_price AS m (
    cmapi_id, language, name, name_numbered, card_number, rarity,
    episode_code, episode_name, currency,
    lowest_near_mint, lnm_de, lnm_fr, lnm_es, lnm_it, avg_7d, avg_30d,
    graded, tcg_market_usd, tcg_mid_usd, image_url, artist, rb_card_id,
    fetched_at
  )
  SELECT
    (r->>'cmapiId')::BIGINT,
    COALESCE(NULLIF(r->>'language',''),'EN'),
    NULLIF(r->>'name',''),
    NULLIF(r->>'nameNumbered',''),
    NULLIF(r->>'cardNumber',''),
    NULLIF(r->>'rarity',''),
    NULLIF(r->>'episodeCode',''),
    NULLIF(r->>'episodeName',''),
    COALESCE(NULLIF(r->>'currency',''),'EUR'),
    NULLIF(r->>'lowestNearMint','')::NUMERIC,
    NULLIF(r->>'lnmDE','')::NUMERIC,
    NULLIF(r->>'lnmFR','')::NUMERIC,
    NULLIF(r->>'lnmES','')::NUMERIC,
    NULLIF(r->>'lnmIT','')::NUMERIC,
    NULLIF(r->>'avg7d','')::NUMERIC,
    NULLIF(r->>'avg30d','')::NUMERIC,
    CASE WHEN r ? 'graded' AND jsonb_typeof(r->'graded') = 'object'
         THEN r->'graded' ELSE NULL END,
    NULLIF(r->>'tcgMarketUsd','')::NUMERIC,
    NULLIF(r->>'tcgMidUsd','')::NUMERIC,
    NULLIF(r->>'image',''),
    NULLIF(r->>'artist',''),
    NULLIF(r->>'rbCardId',''),
    now()
  FROM jsonb_array_elements(p_rows) AS r
  WHERE (r->>'cmapiId') IS NOT NULL
    AND COALESCE(NULLIF(r->>'language',''),'EN') IN ('EN','IT','JP')
  ON CONFLICT (cmapi_id, language) DO UPDATE SET
    name             = COALESCE(EXCLUDED.name, m.name),
    name_numbered    = COALESCE(EXCLUDED.name_numbered, m.name_numbered),
    card_number      = COALESCE(EXCLUDED.card_number, m.card_number),
    rarity           = COALESCE(EXCLUDED.rarity, m.rarity),
    episode_code     = COALESCE(EXCLUDED.episode_code, m.episode_code),
    episode_name     = COALESCE(EXCLUDED.episode_name, m.episode_name),
    currency         = EXCLUDED.currency,
    lowest_near_mint = EXCLUDED.lowest_near_mint,
    lnm_de           = EXCLUDED.lnm_de,
    lnm_fr           = EXCLUDED.lnm_fr,
    lnm_es           = EXCLUDED.lnm_es,
    lnm_it           = EXCLUDED.lnm_it,
    avg_7d           = EXCLUDED.avg_7d,
    avg_30d          = EXCLUDED.avg_30d,
    graded           = COALESCE(EXCLUDED.graded, m.graded),
    tcg_market_usd   = EXCLUDED.tcg_market_usd,
    tcg_mid_usd      = EXCLUDED.tcg_mid_usd,
    image_url        = COALESCE(EXCLUDED.image_url, m.image_url),
    artist           = COALESCE(EXCLUDED.artist, m.artist),
    rb_card_id       = COALESCE(EXCLUDED.rb_card_id, m.rb_card_id),
    fetched_at       = now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.cm_ingest_market_prices(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cm_ingest_market_prices(JSONB) TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  4) Snapshot settimanale CMAPI → history
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.cm_market_snapshot_weekly()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_week  DATE := date_trunc('week', now())::DATE;
  v_count INT;
BEGIN
  INSERT INTO public.cm_market_price_history AS h (
    cmapi_id, language, snapshot_week, currency,
    lowest_near_mint, lnm_it, avg_7d, avg_30d, captured_at
  )
  SELECT
    m.cmapi_id, m.language, v_week, m.currency,
    m.lowest_near_mint, m.lnm_it, m.avg_7d, m.avg_30d, now()
  FROM public.cm_market_price m
  ON CONFLICT (cmapi_id, language, snapshot_week) DO UPDATE SET
    currency         = EXCLUDED.currency,
    lowest_near_mint = EXCLUDED.lowest_near_mint,
    lnm_it           = EXCLUDED.lnm_it,
    avg_7d           = EXCLUDED.avg_7d,
    avg_30d          = EXCLUDED.avg_30d,
    captured_at      = now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.cm_market_snapshot_weekly() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cm_market_snapshot_weekly() TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  5) Monitoring CMAPI: coverage per lingua + freschezza
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW public.v_cm_market_status AS
SELECT
  language,
  COUNT(*)                                          AS cards,
  COUNT(*) FILTER (WHERE lowest_near_mint IS NOT NULL) AS with_nm_price,
  COUNT(*) FILTER (WHERE lnm_it IS NOT NULL)        AS with_it_price,
  COUNT(*) FILTER (WHERE graded IS NOT NULL)        AS with_graded,
  COUNT(DISTINCT episode_code)                      AS episodes,
  MAX(fetched_at)                                   AS last_fetch_at,
  MIN(fetched_at)                                   AS oldest_fetch_at
FROM public.cm_market_price
GROUP BY language;

GRANT SELECT ON public.v_cm_market_status TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_get_cm_market_status()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_json JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Forbidden: admin role required' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(jsonb_agg(row_to_json(s)), '[]'::jsonb)
    INTO v_json FROM public.v_cm_market_status s;
  RETURN jsonb_build_object('by_language', v_json);
END $$;

GRANT EXECUTE ON FUNCTION public.admin_get_cm_market_status() TO authenticated;


NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 077_cmapi_market_price.sql
--
--  Note:
--   • CMAPI dà lowest_near_mint, NON i 3 minimi per ogni condizione Mint→Poor.
--     Il breakdown completo per condizione resta in cm_price_by_condition (075),
--     popolato on-demand dallo userscript dove serve davvero.
--   • Mapping cmapi_id ↔ rb_card_id: risolto separatamente (via card_number +
--     episode_code) e scritto in rb_card_id quando disponibile.
-- ═══════════════════════════════════════════════════════════════════════
