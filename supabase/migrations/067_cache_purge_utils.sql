-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Migration 067: Cache purge utilities
--
--  Necessario per pulire entries contaminate dopo fix soft-block detection
--  nel proxy (cm/ebay possono aver cachato pagine di blocco mascherate).
-- ═══════════════════════════════════════════════════════════════════════

-- Purge per source: 'cardmarket'|'ebay'|'pricecharting'|'all'
CREATE OR REPLACE FUNCTION public.cache_purge_source(p_source TEXT DEFAULT 'all')
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_count INT;
BEGIN
  IF p_source = 'all' THEN
    WITH del AS (DELETE FROM public.external_html_cache RETURNING 1)
      SELECT COUNT(*) INTO v_count FROM del;
  ELSE
    WITH del AS (DELETE FROM public.external_html_cache WHERE source = p_source RETURNING 1)
      SELECT COUNT(*) INTO v_count FROM del;
  END IF;
  RETURN v_count;
END $$;

GRANT EXECUTE ON FUNCTION public.cache_purge_source(TEXT) TO service_role, authenticated;

-- Purge specifica URL (per fix puntuale)
CREATE OR REPLACE FUNCTION public.cache_purge_url(p_url_substring TEXT)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_count INT;
BEGIN
  IF p_url_substring IS NULL OR LENGTH(p_url_substring) < 10 THEN
    RAISE EXCEPTION 'url_substring troppo corto (min 10 char) per evitare purge accidentale';
  END IF;
  WITH del AS (
    DELETE FROM public.external_html_cache WHERE url ILIKE '%' || p_url_substring || '%' RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM del;
  RETURN v_count;
END $$;

GRANT EXECUTE ON FUNCTION public.cache_purge_url(TEXT) TO service_role, authenticated;

NOTIFY pgrst, 'reload schema';
