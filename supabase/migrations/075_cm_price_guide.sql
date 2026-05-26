-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Migration 075: Cardmarket Price Guide replica
--
--  Replica server-side del PRICE GUIDE ufficiale Cardmarket (low/avg/trend +
--  medie mobili 1/7/30gg, foil e non-foil). NON è scraping di listing: la
--  fonte è il file ufficiale che CM pubblica una volta al giorno.
--
--  Modello dati (star schema leggero):
--   • cm_catalog            — dimensione prodotto (idProduct → nome/set/...)
--   • cm_price_guide        — fatto "ultimo prezzo" (1 riga per prodotto, upsert)
--   • cm_price_history      — snapshot settimanali (storico trend)
--   • cm_price_by_condition — 3 minimi + media PER CONDIZIONE (Poor→Mint)
--                             popolata ON-DEMAND dal CM Price Bridge userscript
--                             (il file ufficiale NON contiene il dato per
--                              condizione, solo aggregati per prodotto)
--
--  Ingest:
--   • cm_ingest_catalog(jsonb)         — bulk upsert dimensione
--   • cm_ingest_price_guide(jsonb)     — bulk upsert prezzi correnti
--   • cm_ingest_condition_prices(jsonb)— upsert per-condizione (dal bridge)
--   • cm_snapshot_weekly()             — copia correnti → history (cron)
--
--  Scrittura SOLO via RPC SECURITY DEFINER (no policy INSERT/UPDATE diretta).
--  Lettura: authenticated (dato di mercato, non sensibile).
--
--  Chiavi JSON accettate dagli ingest = stesse del file ufficiale CM:
--   idProduct, idCategory, idExpansion, low, avg, trend, avg1, avg7, avg30,
--   low-foil, avg-foil, trend-foil, avg1-foil, avg7-foil, avg30-foil,
--   processedAt. (Le varianti foil sono accettate sia 'low-foil' sia 'low_foil'.)
-- ═══════════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════════
--  1) Tabelle
-- ══════════════════════════════════════════════════════════════════════

-- 1a) Dimensione prodotto ------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cm_catalog (
  id_product        BIGINT PRIMARY KEY,
  id_category       INT,
  id_expansion      INT,
  name              TEXT,
  expansion         TEXT,
  collector_number  TEXT,
  rarity            TEXT,
  website_url       TEXT,
  image_url         TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cm_catalog_expansion_idx
  ON public.cm_catalog (id_expansion);
CREATE INDEX IF NOT EXISTS cm_catalog_name_idx
  ON public.cm_catalog (lower(name));


-- 1b) Prezzi correnti (ultimo file ingerito) -----------------------------
--  NB: niente FK verso cm_catalog: il price guide può arrivare prima del
--  catalogo o coprire prodotti non ancora catalogati. Integrità "soft".
CREATE TABLE IF NOT EXISTS public.cm_price_guide (
  id_product   BIGINT PRIMARY KEY,
  id_category  INT,
  currency     TEXT NOT NULL DEFAULT 'EUR',
  low          NUMERIC(12,2),
  avg          NUMERIC(12,2),
  trend        NUMERIC(12,2),
  avg1         NUMERIC(12,2),
  avg7         NUMERIC(12,2),
  avg30        NUMERIC(12,2),
  low_foil     NUMERIC(12,2),
  avg_foil     NUMERIC(12,2),
  trend_foil   NUMERIC(12,2),
  avg1_foil    NUMERIC(12,2),
  avg7_foil    NUMERIC(12,2),
  avg30_foil   NUMERIC(12,2),
  processed_at TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- 1c) Snapshot settimanali (storico) -------------------------------------
CREATE TABLE IF NOT EXISTS public.cm_price_history (
  id_product    BIGINT NOT NULL,
  snapshot_week DATE   NOT NULL,           -- lunedì ISO della settimana
  currency      TEXT NOT NULL DEFAULT 'EUR',
  low           NUMERIC(12,2),
  avg           NUMERIC(12,2),
  trend         NUMERIC(12,2),
  avg7          NUMERIC(12,2),
  avg30         NUMERIC(12,2),
  low_foil      NUMERIC(12,2),
  avg_foil      NUMERIC(12,2),
  trend_foil    NUMERIC(12,2),
  processed_at  TIMESTAMPTZ,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id_product, snapshot_week)
);

CREATE INDEX IF NOT EXISTS cm_price_history_week_idx
  ON public.cm_price_history (snapshot_week);


-- 1d) Prezzi PER CONDIZIONE (3 minimi + media) ---------------------------
--  Popolata on-demand dal CM Price Bridge userscript: il file ufficiale
--  non contiene il breakdown per condizione, solo le pagine di listing.
CREATE TABLE IF NOT EXISTS public.cm_price_by_condition (
  id_product   BIGINT NOT NULL,
  condition    TEXT   NOT NULL
               CHECK (condition IN ('Mint','Near Mint','Excellent','Good',
                                     'Light Played','Played','Poor')),
  cond_rank    INT,                         -- 1=Mint ... 7=Poor
  low1         NUMERIC(12,2),               -- 1° minimo
  low2         NUMERIC(12,2),               -- 2° minimo
  low3         NUMERIC(12,2),               -- 3° minimo
  avg          NUMERIC(12,2),               -- media listing condizione
  n_listings   INT,
  is_foil      BOOLEAN NOT NULL DEFAULT false,
  captured_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id_product, condition, is_foil)
);

CREATE INDEX IF NOT EXISTS cm_price_by_condition_product_idx
  ON public.cm_price_by_condition (id_product);


-- ══════════════════════════════════════════════════════════════════════
--  2) RLS — lettura authenticated, scrittura solo via RPC SECURITY DEFINER
-- ══════════════════════════════════════════════════════════════════════
ALTER TABLE public.cm_catalog            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cm_price_guide        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cm_price_history      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cm_price_by_condition ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- cm_catalog
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname='public' AND tablename='cm_catalog'
                    AND policyname='cm_catalog_read') THEN
    CREATE POLICY cm_catalog_read ON public.cm_catalog
      FOR SELECT TO authenticated USING (true);
  END IF;
  -- cm_price_guide
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname='public' AND tablename='cm_price_guide'
                    AND policyname='cm_price_guide_read') THEN
    CREATE POLICY cm_price_guide_read ON public.cm_price_guide
      FOR SELECT TO authenticated USING (true);
  END IF;
  -- cm_price_history
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname='public' AND tablename='cm_price_history'
                    AND policyname='cm_price_history_read') THEN
    CREATE POLICY cm_price_history_read ON public.cm_price_history
      FOR SELECT TO authenticated USING (true);
  END IF;
  -- cm_price_by_condition
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname='public' AND tablename='cm_price_by_condition'
                    AND policyname='cm_price_by_condition_read') THEN
    CREATE POLICY cm_price_by_condition_read ON public.cm_price_by_condition
      FOR SELECT TO authenticated USING (true);
  END IF;
END $$;


-- ══════════════════════════════════════════════════════════════════════
--  3) Ingest: catalogo (bulk upsert)
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.cm_ingest_catalog(p_rows JSONB)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count INT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Forbidden: admin role required' USING ERRCODE = '42501';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'p_rows deve essere un array JSON';
  END IF;

  INSERT INTO public.cm_catalog AS c (
    id_product, id_category, id_expansion, name, expansion,
    collector_number, rarity, website_url, image_url, updated_at
  )
  SELECT
    (r->>'idProduct')::BIGINT,
    NULLIF(r->>'idCategory','')::INT,
    NULLIF(r->>'idExpansion','')::INT,
    NULLIF(r->>'name',''),
    NULLIF(r->>'expansion',''),
    NULLIF(r->>'number',''),
    NULLIF(r->>'rarity',''),
    NULLIF(r->>'website',''),
    NULLIF(r->>'image',''),
    now()
  FROM jsonb_array_elements(p_rows) AS r
  WHERE (r->>'idProduct') IS NOT NULL
  ON CONFLICT (id_product) DO UPDATE SET
    id_category      = COALESCE(EXCLUDED.id_category, c.id_category),
    id_expansion     = COALESCE(EXCLUDED.id_expansion, c.id_expansion),
    name             = COALESCE(EXCLUDED.name, c.name),
    expansion        = COALESCE(EXCLUDED.expansion, c.expansion),
    collector_number = COALESCE(EXCLUDED.collector_number, c.collector_number),
    rarity           = COALESCE(EXCLUDED.rarity, c.rarity),
    website_url      = COALESCE(EXCLUDED.website_url, c.website_url),
    image_url        = COALESCE(EXCLUDED.image_url, c.image_url),
    updated_at       = now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.cm_ingest_catalog(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cm_ingest_catalog(JSONB) TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  4) Ingest: price guide (bulk upsert)
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.cm_ingest_price_guide(p_rows JSONB)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count INT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Forbidden: admin role required' USING ERRCODE = '42501';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'p_rows deve essere un array JSON';
  END IF;

  INSERT INTO public.cm_price_guide AS g (
    id_product, id_category, currency,
    low, avg, trend, avg1, avg7, avg30,
    low_foil, avg_foil, trend_foil, avg1_foil, avg7_foil, avg30_foil,
    processed_at, updated_at
  )
  SELECT
    (r->>'idProduct')::BIGINT,
    NULLIF(r->>'idCategory','')::INT,
    COALESCE(NULLIF(r->>'currency',''),'EUR'),
    NULLIF(r->>'low','')::NUMERIC,
    NULLIF(r->>'avg','')::NUMERIC,
    NULLIF(r->>'trend','')::NUMERIC,
    NULLIF(r->>'avg1','')::NUMERIC,
    NULLIF(r->>'avg7','')::NUMERIC,
    NULLIF(r->>'avg30','')::NUMERIC,
    NULLIF(COALESCE(r->>'low-foil',   r->>'low_foil'),   '')::NUMERIC,
    NULLIF(COALESCE(r->>'avg-foil',   r->>'avg_foil'),   '')::NUMERIC,
    NULLIF(COALESCE(r->>'trend-foil', r->>'trend_foil'), '')::NUMERIC,
    NULLIF(COALESCE(r->>'avg1-foil',  r->>'avg1_foil'),  '')::NUMERIC,
    NULLIF(COALESCE(r->>'avg7-foil',  r->>'avg7_foil'),  '')::NUMERIC,
    NULLIF(COALESCE(r->>'avg30-foil', r->>'avg30_foil'), '')::NUMERIC,
    NULLIF(r->>'processedAt','')::TIMESTAMPTZ,
    now()
  FROM jsonb_array_elements(p_rows) AS r
  WHERE (r->>'idProduct') IS NOT NULL
  ON CONFLICT (id_product) DO UPDATE SET
    id_category  = COALESCE(EXCLUDED.id_category, g.id_category),
    currency     = EXCLUDED.currency,
    low          = EXCLUDED.low,
    avg          = EXCLUDED.avg,
    trend        = EXCLUDED.trend,
    avg1         = EXCLUDED.avg1,
    avg7         = EXCLUDED.avg7,
    avg30        = EXCLUDED.avg30,
    low_foil     = EXCLUDED.low_foil,
    avg_foil     = EXCLUDED.avg_foil,
    trend_foil   = EXCLUDED.trend_foil,
    avg1_foil    = EXCLUDED.avg1_foil,
    avg7_foil    = EXCLUDED.avg7_foil,
    avg30_foil   = EXCLUDED.avg30_foil,
    processed_at = EXCLUDED.processed_at,
    updated_at   = now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.cm_ingest_price_guide(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cm_ingest_price_guide(JSONB) TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  5) Ingest: prezzi per condizione (dal CM Price Bridge, on-demand)
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.cm_ingest_condition_prices(p_rows JSONB)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count INT;
BEGIN
  -- Popolata da utenti loggati che aprono una carta: basta authenticated.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Forbidden: authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'p_rows deve essere un array JSON';
  END IF;

  INSERT INTO public.cm_price_by_condition AS pc (
    id_product, condition, cond_rank, low1, low2, low3, avg,
    n_listings, is_foil, captured_at
  )
  SELECT
    (r->>'idProduct')::BIGINT,
    r->>'condition',
    NULLIF(r->>'condRank','')::INT,
    NULLIF(r->>'low1','')::NUMERIC,
    NULLIF(r->>'low2','')::NUMERIC,
    NULLIF(r->>'low3','')::NUMERIC,
    NULLIF(r->>'avg','')::NUMERIC,
    NULLIF(r->>'nListings','')::INT,
    COALESCE((r->>'isFoil')::BOOLEAN, false),
    now()
  FROM jsonb_array_elements(p_rows) AS r
  WHERE (r->>'idProduct') IS NOT NULL
    AND (r->>'condition') IN ('Mint','Near Mint','Excellent','Good',
                              'Light Played','Played','Poor')
  ON CONFLICT (id_product, condition, is_foil) DO UPDATE SET
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

REVOKE ALL ON FUNCTION public.cm_ingest_condition_prices(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cm_ingest_condition_prices(JSONB) TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  6) Snapshot settimanale: correnti → history (idempotente, chiamato da cron)
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.cm_snapshot_weekly()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_week  DATE := date_trunc('week', now())::DATE;  -- lunedì ISO
  v_count INT;
BEGIN
  INSERT INTO public.cm_price_history AS h (
    id_product, snapshot_week, currency,
    low, avg, trend, avg7, avg30,
    low_foil, avg_foil, trend_foil, processed_at, captured_at
  )
  SELECT
    g.id_product, v_week, g.currency,
    g.low, g.avg, g.trend, g.avg7, g.avg30,
    g.low_foil, g.avg_foil, g.trend_foil, g.processed_at, now()
  FROM public.cm_price_guide g
  ON CONFLICT (id_product, snapshot_week) DO UPDATE SET
    currency     = EXCLUDED.currency,
    low          = EXCLUDED.low,
    avg          = EXCLUDED.avg,
    trend        = EXCLUDED.trend,
    avg7         = EXCLUDED.avg7,
    avg30        = EXCLUDED.avg30,
    low_foil     = EXCLUDED.low_foil,
    avg_foil     = EXCLUDED.avg_foil,
    trend_foil   = EXCLUDED.trend_foil,
    processed_at = EXCLUDED.processed_at,
    captured_at  = now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.cm_snapshot_weekly() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cm_snapshot_weekly() TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  7) Monitoring: view stato + RPC admin
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW public.v_cm_price_guide_status AS
SELECT
  (SELECT COUNT(*) FROM public.cm_catalog)                       AS catalog_rows,
  (SELECT COUNT(*) FROM public.cm_price_guide)                   AS price_rows,
  (SELECT COUNT(*) FROM public.cm_price_by_condition)            AS condition_rows,
  (SELECT COUNT(DISTINCT snapshot_week)
     FROM public.cm_price_history)                               AS history_weeks,
  (SELECT MAX(updated_at)   FROM public.cm_price_guide)          AS last_ingest_at,
  (SELECT MAX(processed_at) FROM public.cm_price_guide)          AS last_processed_at,
  (SELECT MAX(snapshot_week) FROM public.cm_price_history)       AS last_snapshot_week;

GRANT SELECT ON public.v_cm_price_guide_status TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_get_cm_price_status()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v RECORD;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Forbidden: admin role required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v FROM public.v_cm_price_guide_status LIMIT 1;
  RETURN jsonb_build_object(
    'catalog_rows',       COALESCE(v.catalog_rows,   0),
    'price_rows',         COALESCE(v.price_rows,     0),
    'condition_rows',     COALESCE(v.condition_rows, 0),
    'history_weeks',      COALESCE(v.history_weeks,  0),
    'last_ingest_at',     v.last_ingest_at,
    'last_processed_at',  v.last_processed_at,
    'last_snapshot_week', v.last_snapshot_week
  );
END $$;

GRANT EXECUTE ON FUNCTION public.admin_get_cm_price_status() TO authenticated;


NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 075_cm_price_guide.sql
--
--  Esecuzione on-demand utili:
--   • Snapshot manuale:   SELECT public.cm_snapshot_weekly();
--   • Stato:              SELECT public.admin_get_cm_price_status();
--   • Coverage per set:   SELECT id_expansion, COUNT(*) FROM cm_catalog
--                          GROUP BY 1 ORDER BY 2 DESC;
-- ═══════════════════════════════════════════════════════════════════════
