-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Migration 066: External HTML cache (CM/eBay/PC)
--
--  Cache server-side per fetch a CM, eBay, PriceCharting:
--   - Riduce drasticamente i costi del proxy esterno (ScrapingBee &c.)
--   - TTL 24h default, configurabile per source
--   - Cache key = hash sha256 dell'URL (gestisce URL lunghi)
--   - Solo HTML "buono" (status ok, len > 1000) viene cachato
--   - Auto-purge dei record scaduti (cron giornaliero opzionale)
--
--  Pattern uso (lato edge function):
--    1. Calcola cache_key
--    2. SELECT html FROM external_html_cache WHERE key=K AND expires_at>now()
--    3. Hit: ritorna html dalla cache
--    4. Miss: fetch (diretto o via proxy) → INSERT/UPDATE cache se ok
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.external_html_cache (
  cache_key   TEXT PRIMARY KEY,             -- sha256 di source||url
  source      TEXT NOT NULL                  -- 'cardmarket'|'ebay'|'pricecharting'
              CHECK (source IN ('cardmarket','ebay','pricecharting','other')),
  url         TEXT NOT NULL,
  html        TEXT NOT NULL,
  status      INT  NOT NULL DEFAULT 200,
  bytes       INT  GENERATED ALWAYS AS (LENGTH(html)) STORED,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  -- Tracciamento provenienza per analytics: 'direct'|'proxy_scrapingbee'|...
  fetched_via TEXT,
  hit_count   INT NOT NULL DEFAULT 0,
  last_hit_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS external_html_cache_expires_idx
  ON public.external_html_cache (expires_at);

CREATE INDEX IF NOT EXISTS external_html_cache_source_idx
  ON public.external_html_cache (source, fetched_at DESC);

-- ── RPC: read cache (ritorna NULL se miss/expired) ──────────────────
CREATE OR REPLACE FUNCTION public.cache_get_external(p_key TEXT)
RETURNS TABLE (html TEXT, status INT, fetched_via TEXT, age_seconds INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Update hit stats senza bloccare il read
  UPDATE public.external_html_cache
     SET hit_count = hit_count + 1,
         last_hit_at = now()
   WHERE cache_key = p_key
     AND expires_at > now();

  RETURN QUERY
    SELECT c.html,
           c.status,
           c.fetched_via,
           EXTRACT(EPOCH FROM (now() - c.fetched_at))::INT
      FROM public.external_html_cache c
     WHERE c.cache_key = p_key
       AND c.expires_at > now()
     LIMIT 1;
END $$;

GRANT EXECUTE ON FUNCTION public.cache_get_external(TEXT) TO service_role, authenticated;

-- ── RPC: write cache (upsert con TTL) ───────────────────────────────
CREATE OR REPLACE FUNCTION public.cache_put_external(
  p_key   TEXT,
  p_source TEXT,
  p_url   TEXT,
  p_html  TEXT,
  p_status INT,
  p_via   TEXT,
  p_ttl_seconds INT DEFAULT 86400         -- default 24h
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Skip cache di payload sospetti (status non-ok, html vuoto/troppo corto)
  IF p_html IS NULL OR LENGTH(p_html) < 500 OR p_status < 200 OR p_status >= 400 THEN
    RETURN;
  END IF;

  INSERT INTO public.external_html_cache
    (cache_key, source, url, html, status, fetched_via,
     fetched_at, expires_at)
  VALUES
    (p_key, p_source, p_url, p_html, p_status, p_via,
     now(), now() + (p_ttl_seconds || ' seconds')::INTERVAL)
  ON CONFLICT (cache_key) DO UPDATE SET
    html        = EXCLUDED.html,
    status      = EXCLUDED.status,
    fetched_via = EXCLUDED.fetched_via,
    fetched_at  = now(),
    expires_at  = now() + (p_ttl_seconds || ' seconds')::INTERVAL;
END $$;

GRANT EXECUTE ON FUNCTION public.cache_put_external(TEXT,TEXT,TEXT,TEXT,INT,TEXT,INT)
  TO service_role, authenticated;

-- ── Purge cron: rimuove record scaduti (settimanale) ────────────────
CREATE OR REPLACE FUNCTION public.cache_purge_external()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_count INT;
BEGIN
  WITH del AS (
    DELETE FROM public.external_html_cache
     WHERE expires_at < now() - INTERVAL '7 days'
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM del;
  RETURN v_count;
END $$;

GRANT EXECUTE ON FUNCTION public.cache_purge_external() TO service_role;

-- View admin: statistiche cache per debug/monitoring costi
CREATE OR REPLACE VIEW public.v_cache_stats AS
SELECT
  source,
  COUNT(*)                                       AS entries,
  COUNT(*) FILTER (WHERE expires_at > now())     AS active,
  COUNT(*) FILTER (WHERE expires_at <= now())    AS expired,
  SUM(hit_count)                                 AS total_hits,
  SUM(bytes)/1024/1024                           AS total_mb,
  MAX(fetched_at)                                AS last_fetch,
  fetched_via                                    AS via
FROM public.external_html_cache
GROUP BY source, fetched_via
ORDER BY source, fetched_via;

GRANT SELECT ON public.v_cache_stats TO authenticated;

NOTIFY pgrst, 'reload schema';
