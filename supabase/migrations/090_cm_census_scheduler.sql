-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Migration 090: scheduler censimento prezzi a 7 fasce
--
--  Obiettivo: rinfrescare l'intero catalogo rb_card_index una volta a
--  settimana, spalmando il lavoro su 7 fasce (1/giorno), a un'ora impostabile
--  dal pannello admin. I prezzi reali per-condizione/per-venditore si leggono
--  SOLO via Hunter (browser, IP residenziale) → il "drenaggio" gira nel
--  browser admin; pg_cron si limita a MARCARE come scadute le carte della
--  fascia del giorno. Nessun fallback CMAPI.
--
--  Modello:
--   • rb_card_index.refresh_bucket  — fascia 0..6 deterministica da product_key
--   • rb_card_index.next_due_at     — quando la carta va riletta (NULL/<=now = scaduta)
--   • rb_card_index.last_refresh_at — ultimo refresh riuscito
--   • platform_settings['cm_census_scheduler'] = {enabled,hour_utc,cursor,last_tick}
--
--  Flusso:
--   1. cron giornaliero (ora impostabile) → cm_census_tick(): avanza il cursore
--      (mod 7) e marca scaduta la fascia corrente (next_due_at = now()).
--   2. browser admin → cm_census_due_cards(limit): elenco carte scadute con URL.
--   3. drainer Hunter rilegge e chiama cm_census_mark_refreshed() → next_due_at
--      = now()+7gg.
-- ═══════════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════════
--  1) Colonne fascia / scadenza su rb_card_index
-- ══════════════════════════════════════════════════════════════════════
ALTER TABLE public.rb_card_index
  ADD COLUMN IF NOT EXISTS refresh_bucket  SMALLINT,
  ADD COLUMN IF NOT EXISTS next_due_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_refresh_at TIMESTAMPTZ;

-- Fascia deterministica da product_key (stabile, 0..6)
CREATE OR REPLACE FUNCTION public.cm_census_bucket(p_key TEXT)
RETURNS SMALLINT
LANGUAGE sql IMMUTABLE
AS $$
  SELECT (abs(hashtextextended(p_key, 0)) % 7)::SMALLINT
$$;

-- Backfill fasce mancanti
UPDATE public.rb_card_index
   SET refresh_bucket = public.cm_census_bucket(product_key)
 WHERE refresh_bucket IS NULL;

-- Trigger: nuove righe ricevono la fascia automaticamente
CREATE OR REPLACE FUNCTION public.rb_card_index_set_bucket()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.refresh_bucket IS NULL THEN
    NEW.refresh_bucket := public.cm_census_bucket(NEW.product_key);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_rb_card_index_bucket ON public.rb_card_index;
CREATE TRIGGER trg_rb_card_index_bucket
  BEFORE INSERT ON public.rb_card_index
  FOR EACH ROW EXECUTE FUNCTION public.rb_card_index_set_bucket();

CREATE INDEX IF NOT EXISTS rb_card_index_due_idx
  ON public.rb_card_index (refresh_bucket, next_due_at)
  WHERE cm_url IS NOT NULL;


-- ══════════════════════════════════════════════════════════════════════
--  2) Config di default in platform_settings (creata in 036)
-- ══════════════════════════════════════════════════════════════════════
INSERT INTO public.platform_settings (key, value)
VALUES ('cm_census_scheduler',
        jsonb_build_object('enabled', false, 'hour_utc', 3, 'cursor', -1, 'last_tick', null))
ON CONFLICT (key) DO NOTHING;


-- ══════════════════════════════════════════════════════════════════════
--  3) Tick del cron: avanza cursore + marca scaduta la fascia del giorno
--     SECURITY DEFINER, NESSUN auth.uid (gira dentro pg_cron, senza sessione).
--     Idempotente sul giorno: se ha gia' ticchettato oggi, non riavanza.
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.cm_census_tick()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cfg     JSONB;
  v_enabled BOOLEAN;
  v_cursor  INT;
  v_last    DATE;
  v_new     INT;
  v_marked  INT := 0;
BEGIN
  SELECT value INTO v_cfg FROM public.platform_settings WHERE key = 'cm_census_scheduler';
  IF v_cfg IS NULL THEN RETURN 0; END IF;

  v_enabled := COALESCE((v_cfg->>'enabled')::BOOLEAN, false);
  IF NOT v_enabled THEN RETURN 0; END IF;

  v_last := NULLIF(v_cfg->>'last_tick','')::DATE;
  IF v_last = CURRENT_DATE THEN RETURN 0; END IF;  -- gia' fatto oggi

  v_cursor := COALESCE((v_cfg->>'cursor')::INT, -1);
  v_new    := (v_cursor + 1) % 7;

  -- Marca scaduta la fascia del giorno (salta carte rinfrescate da <6gg)
  UPDATE public.rb_card_index
     SET next_due_at = now()
   WHERE refresh_bucket = v_new
     AND cm_url IS NOT NULL
     AND (last_refresh_at IS NULL OR last_refresh_at < now() - interval '6 days');
  GET DIAGNOSTICS v_marked = ROW_COUNT;

  UPDATE public.platform_settings
     SET value = value || jsonb_build_object('cursor', v_new, 'last_tick', CURRENT_DATE::TEXT),
         updated_at = now()
   WHERE key = 'cm_census_scheduler';

  RETURN v_marked;
END $$;

REVOKE ALL ON FUNCTION public.cm_census_tick() FROM PUBLIC, anon, authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  4) Reschedule pg_cron all'ora impostata (helper, admin via settings_set)
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.cm_census_reschedule(p_hour INT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_expr TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron non installata: schedule saltato';
    RETURN;
  END IF;
  v_expr := '15 ' || GREATEST(0, LEAST(23, COALESCE(p_hour,3)))::TEXT || ' * * *';
  PERFORM cron.unschedule('rb_cm_census_tick')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rb_cm_census_tick');
  PERFORM cron.schedule('rb_cm_census_tick', v_expr, $cron$ SELECT public.cm_census_tick(); $cron$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'cm_census_reschedule fallito: %', SQLERRM;
END $$;

REVOKE ALL ON FUNCTION public.cm_census_reschedule(INT) FROM PUBLIC, anon, authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  5) RPC admin: leggi config + stato fasce
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.cm_census_settings_get()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_cfg JSONB; v_buckets JSONB; v_due INT; v_total INT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Forbidden: admin only' USING ERRCODE = '42501';
  END IF;

  SELECT value INTO v_cfg FROM public.platform_settings WHERE key = 'cm_census_scheduler';

  SELECT jsonb_agg(jsonb_build_object(
           'bucket', b,
           'total',  c_total,
           'due',    c_due
         ) ORDER BY b)
    INTO v_buckets
  FROM (
    SELECT refresh_bucket AS b,
           count(*) FILTER (WHERE cm_url IS NOT NULL) AS c_total,
           count(*) FILTER (WHERE cm_url IS NOT NULL
                            AND (next_due_at IS NOT NULL AND next_due_at <= now())) AS c_due
    FROM public.rb_card_index
    WHERE refresh_bucket IS NOT NULL
    GROUP BY refresh_bucket
  ) t;

  SELECT count(*) FILTER (WHERE cm_url IS NOT NULL AND next_due_at IS NOT NULL AND next_due_at <= now()),
         count(*) FILTER (WHERE cm_url IS NOT NULL)
    INTO v_due, v_total
  FROM public.rb_card_index;

  RETURN jsonb_build_object(
    'config',  COALESCE(v_cfg, '{}'::jsonb),
    'buckets', COALESCE(v_buckets, '[]'::jsonb),
    'due_now', COALESCE(v_due, 0),
    'total',   COALESCE(v_total, 0)
  );
END $$;

REVOKE ALL ON FUNCTION public.cm_census_settings_get() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cm_census_settings_get() TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  6) RPC admin: imposta enabled + ora → salva config e rischedula cron
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.cm_census_settings_set(p_enabled BOOLEAN, p_hour INT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_hour INT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Forbidden: admin only' USING ERRCODE = '42501';
  END IF;
  v_hour := GREATEST(0, LEAST(23, COALESCE(p_hour, 3)));

  UPDATE public.platform_settings
     SET value = value || jsonb_build_object('enabled', COALESCE(p_enabled,false), 'hour_utc', v_hour),
         updated_at = now()
   WHERE key = 'cm_census_scheduler';

  IF COALESCE(p_enabled,false) THEN
    PERFORM public.cm_census_reschedule(v_hour);
  ELSE
    -- disabilitato: rimuovi il job se presente
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
      PERFORM cron.unschedule('rb_cm_census_tick')
       WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rb_cm_census_tick');
    END IF;
  END IF;

  RETURN public.cm_census_settings_get();
END $$;

REVOKE ALL ON FUNCTION public.cm_census_settings_set(BOOLEAN, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cm_census_settings_set(BOOLEAN, INT) TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  7) RPC admin: carte scadute da rileggere (per il drainer browser)
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.cm_census_due_cards(p_limit INT DEFAULT 40)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_rows JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Forbidden: admin only' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'product_key', product_key, 'name', name, 'set_id', set_id,
            'set_name', set_name, 'number', number, 'rarity', rarity,
            'cm_url', cm_url, 'bucket', refresh_bucket
          ) ORDER BY next_due_at ASC NULLS FIRST), '[]'::jsonb)
    INTO v_rows
  FROM (
    SELECT * FROM public.rb_card_index
    WHERE cm_url IS NOT NULL
      AND next_due_at IS NOT NULL
      AND next_due_at <= now()
    ORDER BY next_due_at ASC NULLS FIRST
    LIMIT GREATEST(1, LEAST(200, COALESCE(p_limit, 40)))
  ) q;

  RETURN v_rows;
END $$;

REVOKE ALL ON FUNCTION public.cm_census_due_cards(INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cm_census_due_cards(INT) TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  8) RPC admin: segna carta rinfrescata → riprogramma a +7gg
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.cm_census_mark_refreshed(p_product_key TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Forbidden: admin only' USING ERRCODE = '42501';
  END IF;
  UPDATE public.rb_card_index
     SET last_refresh_at = now(),
         next_due_at     = now() + interval '7 days'
   WHERE product_key = p_product_key;
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION public.cm_census_mark_refreshed(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cm_census_mark_refreshed(TEXT) TO authenticated;


-- PostgREST: ricarica lo schema cache
NOTIFY pgrst, 'reload schema';
