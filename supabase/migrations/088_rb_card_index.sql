-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Migration 088: RB CARD INDEX (registro proprietario carte)
--
--  Obiettivo: rendere "infallibile" il collegamento carta → Cardmarket e
--  costruire nel tempo un DB proprietario basato su DATI REALI, consultato
--  PRIMA della Pokémon TCG API.
--
--  Cosa contiene una riga (chiave = product_key, identità della PAGINA
--  prodotto CM, indipendente da lingua/condizione che sono solo filtri):
--   • cm_url VERIFICATO (ha restituito listing reali almeno una volta)
--     + metodo di risoluzione + confidenza + contatori verify/fail.
--     Auto-riparante: 2 fallimenti consecutivi ("Prodotto sbagliato")
--     invalidano l'URL e forzano una nuova discovery.
--   • immagine proprietaria (Supabase Storage, bucket card-images) —
--     la foto CM è spesso più fedele di quella della TCG API.
--   • prezzo NM denormalizzato (raw + pesato anti-anomalie) per ricerche
--     istantanee. Il ladder completo per-condizione resta in
--     cm_price_by_condition (075/078), joinabile via card_key.
--
--  Scrittura SOLO via RPC SECURITY DEFINER (auth richiesta): la tabella è
--  conoscenza condivisa tra tutti gli utenti, non dato personale.
--
--  Eseguire una volta nel Supabase SQL Editor (progetto rbjaaeyjeeqfpbzyavag).
--  Idempotente: rieseguibile senza effetti collaterali.
-- ═══════════════════════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════════════════
--  1) Tabella
-- ══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.rb_card_index (
  -- Chiave prodotto: 'set_id|number' (lower). Per carte censite senza set
  -- TCG: 'cm|{set-slug}|{card-slug}' derivata dall'URL prodotto CM.
  product_key            TEXT PRIMARY KEY,

  -- Identità carta
  name                   TEXT NOT NULL,
  set_id                 TEXT,
  set_name               TEXT,
  number                 TEXT,
  rarity                 TEXT,

  -- Risoluzione Cardmarket (URL base pagina prodotto, senza query string)
  cm_url                 TEXT,
  cm_product_id          BIGINT,
  resolution_method      TEXT,          -- authoritative|userscript|discover|direct|variant-cascade|census|manual|cmapi
  resolution_confidence  SMALLINT DEFAULT 0,  -- 0..100
  verify_count           INT      DEFAULT 0,  -- n° conferme (listing reali ottenuti)
  fail_count             INT      DEFAULT 0,  -- n° "Prodotto sbagliato" consecutivi
  last_verified_at       TIMESTAMPTZ,
  last_failed_at         TIMESTAMPTZ,

  -- Immagine proprietaria (Storage RareBlock) + origine
  image_url              TEXT,
  image_source_url       TEXT,
  image_captured_at      TIMESTAMPTZ,

  -- Prezzo NM denormalizzato (accesso rapido in ricerca; ladder completo
  -- in cm_price_by_condition via card_key)
  price_nm               NUMERIC(12,2),
  price_nm_weighted      NUMERIC(12,2), -- prezzo pesato anti-anomalie (client)
  price_source           TEXT,          -- userscript|scrape|cmapi|census
  price_updated_at       TIMESTAMPTZ,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ricerca per nome (ILIKE '%…%') → trigram se disponibile, altrimenti btree lower.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE INDEX IF NOT EXISTS rb_cidx_name_trgm
      ON public.rb_card_index USING gin (lower(name) gin_trgm_ops);
  EXCEPTION WHEN OTHERS THEN
    CREATE INDEX IF NOT EXISTS rb_cidx_name_lower
      ON public.rb_card_index (lower(name));
  END;
END $$;

CREATE INDEX IF NOT EXISTS rb_cidx_set_num
  ON public.rb_card_index (set_id, number) WHERE set_id IS NOT NULL;

-- RLS: lettura per tutti gli autenticati; nessuna scrittura diretta
-- (solo RPC SECURITY DEFINER sotto + service role dell'edge function).
ALTER TABLE public.rb_card_index ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rb_cidx_select ON public.rb_card_index;
CREATE POLICY rb_cidx_select ON public.rb_card_index
  FOR SELECT TO authenticated USING (true);

-- ══════════════════════════════════════════════════════════════════════
--  2) RPC: lettura batch per chiavi
-- ══════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS public.rb_index_get(TEXT[]);
CREATE OR REPLACE FUNCTION public.rb_index_get(p_keys TEXT[])
RETURNS SETOF public.rb_card_index
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT * FROM public.rb_card_index
  WHERE auth.uid() IS NOT NULL
    AND product_key = ANY(p_keys)
$$;

-- ══════════════════════════════════════════════════════════════════════
--  3) RPC: ricerca per nome (+numero opzionale) — fonte primaria pre-TCG-API
-- ══════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS public.rb_index_search(TEXT, TEXT, INT);
CREATE OR REPLACE FUNCTION public.rb_index_search(
  p_name   TEXT,
  p_number TEXT DEFAULT NULL,
  p_limit  INT  DEFAULT 30
)
RETURNS SETOF public.rb_card_index
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT * FROM public.rb_card_index
  WHERE auth.uid() IS NOT NULL
    AND p_name IS NOT NULL AND length(trim(p_name)) >= 2
    AND lower(name) LIKE '%' || lower(trim(p_name)) || '%'
    AND (p_number IS NULL OR lower(coalesce(number,'')) = lower(trim(p_number)))
  ORDER BY verify_count DESC, updated_at DESC
  LIMIT GREATEST(1, LEAST(coalesce(p_limit,30), 100))
$$;

-- ══════════════════════════════════════════════════════════════════════
--  4) RPC: upsert intelligente
--     Regole anti-regressione:
--      • stesso cm_url riconfermato → verify_count+1, fail_count=0,
--        confidence = max(vecchia, nuova)
--      • cm_url DIVERSO → sostituisce solo se nuova confidence ≥ vecchia,
--        oppure URL vecchio assente/invalidato (fail_count ≥ 2)
--      • campi identità/prezzo/immagine: il nuovo non-null vince
-- ══════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS public.rb_index_upsert(TEXT, JSONB);
CREATE OR REPLACE FUNCTION public.rb_index_upsert(
  p_product_key TEXT,
  p             JSONB
)
RETURNS public.rb_card_index
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old  public.rb_card_index%ROWTYPE;
  v_row  public.rb_card_index%ROWTYPE;
  v_url  TEXT := nullif(trim(coalesce(p->>'cm_url','')), '');
  v_conf SMALLINT := coalesce((p->>'confidence')::SMALLINT, 0);
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Forbidden: authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_product_key IS NULL OR length(trim(p_product_key)) < 3 THEN
    RAISE EXCEPTION 'product_key non valida';
  END IF;
  -- Accetta SOLO pagine prodotto Cardmarket come URL verificato:
  -- /Products/{Categoria}/{Set}/{Carta} → ≥3 segmenti dopo /Products/.
  -- Le pagine SET (/Products/Singles/{Set}, 2 segmenti) vengono scartate:
  -- indicizzarle aprirebbe il set intero (bug Expedition, cfr. _isAuthoritativeCMUrl).
  IF v_url IS NOT NULL AND v_url !~* '^https?://(www\.)?cardmarket\.com/.+/Products/[^/?#]+/[^/?#]+/[^/?#]+' THEN
    v_url := NULL;
  END IF;

  SELECT * INTO v_old FROM public.rb_card_index WHERE product_key = p_product_key;

  IF NOT FOUND THEN
    INSERT INTO public.rb_card_index (
      product_key, name, set_id, set_name, number, rarity,
      cm_url, cm_product_id, resolution_method, resolution_confidence,
      verify_count, last_verified_at,
      image_source_url,
      price_nm, price_nm_weighted, price_source, price_updated_at,
      created_at, updated_at
    ) VALUES (
      p_product_key,
      coalesce(nullif(trim(p->>'name'),''), '?'),
      nullif(trim(coalesce(p->>'set_id','')),''),
      nullif(trim(coalesce(p->>'set_name','')),''),
      nullif(trim(coalesce(p->>'number','')),''),
      nullif(trim(coalesce(p->>'rarity','')),''),
      v_url,
      (p->>'cm_product_id')::BIGINT,
      nullif(trim(coalesce(p->>'method','')),''),
      CASE WHEN v_url IS NOT NULL THEN v_conf ELSE 0 END,
      CASE WHEN v_url IS NOT NULL THEN 1 ELSE 0 END,
      CASE WHEN v_url IS NOT NULL THEN now() ELSE NULL END,
      nullif(trim(coalesce(p->>'image_source_url','')),''),
      (p->>'price_nm')::NUMERIC,
      (p->>'price_nm_weighted')::NUMERIC,
      nullif(trim(coalesce(p->>'price_source','')),''),
      CASE WHEN (p->>'price_nm') IS NOT NULL OR (p->>'price_nm_weighted') IS NOT NULL
           THEN now() ELSE NULL END,
      now(), now()
    )
    RETURNING * INTO v_row;
    RETURN v_row;
  END IF;

  UPDATE public.rb_card_index SET
    name      = coalesce(nullif(trim(coalesce(p->>'name','')),''), name),
    set_id    = coalesce(nullif(trim(coalesce(p->>'set_id','')),''), set_id),
    set_name  = coalesce(nullif(trim(coalesce(p->>'set_name','')),''), set_name),
    number    = coalesce(nullif(trim(coalesce(p->>'number','')),''), number),
    rarity    = coalesce(nullif(trim(coalesce(p->>'rarity','')),''), rarity),
    cm_product_id = coalesce((p->>'cm_product_id')::BIGINT, cm_product_id),

    -- URL: riconferma vs sostituzione (vedi header)
    cm_url = CASE
      WHEN v_url IS NULL THEN cm_url
      WHEN cm_url IS NULL OR fail_count >= 2 THEN v_url
      WHEN split_part(cm_url,'?',1) = split_part(v_url,'?',1) THEN cm_url
      WHEN v_conf >= coalesce(resolution_confidence,0) THEN v_url
      ELSE cm_url
    END,
    resolution_method = CASE
      WHEN v_url IS NOT NULL AND (cm_url IS NULL OR fail_count >= 2
           OR split_part(cm_url,'?',1) = split_part(v_url,'?',1)
           OR v_conf >= coalesce(resolution_confidence,0))
      THEN coalesce(nullif(trim(coalesce(p->>'method','')),''), resolution_method)
      ELSE resolution_method
    END,
    resolution_confidence = CASE
      WHEN v_url IS NULL THEN resolution_confidence
      WHEN cm_url IS NOT NULL AND split_part(cm_url,'?',1) = split_part(v_url,'?',1)
        THEN GREATEST(coalesce(resolution_confidence,0), v_conf)
      WHEN cm_url IS NULL OR fail_count >= 2 OR v_conf >= coalesce(resolution_confidence,0)
        THEN v_conf
      ELSE resolution_confidence
    END,
    verify_count     = CASE WHEN v_url IS NOT NULL THEN verify_count + 1 ELSE verify_count END,
    fail_count       = CASE WHEN v_url IS NOT NULL THEN 0 ELSE fail_count END,
    last_verified_at = CASE WHEN v_url IS NOT NULL THEN now() ELSE last_verified_at END,

    image_source_url = coalesce(nullif(trim(coalesce(p->>'image_source_url','')),''), image_source_url),

    price_nm          = coalesce((p->>'price_nm')::NUMERIC, price_nm),
    price_nm_weighted = coalesce((p->>'price_nm_weighted')::NUMERIC, price_nm_weighted),
    price_source      = coalesce(nullif(trim(coalesce(p->>'price_source','')),''), price_source),
    price_updated_at  = CASE WHEN (p->>'price_nm') IS NOT NULL OR (p->>'price_nm_weighted') IS NOT NULL
                             THEN now() ELSE price_updated_at END,
    updated_at = now()
  WHERE product_key = p_product_key
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- ══════════════════════════════════════════════════════════════════════
--  5) RPC: segnala fallimento ("Prodotto sbagliato" sull'URL indicizzato)
--     Al 2° fallimento consecutivo l'URL viene invalidato → la prossima
--     lookup riparte dalla cascata/discovery e si auto-ripara.
-- ══════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS public.rb_index_report_failure(TEXT, TEXT);
CREATE OR REPLACE FUNCTION public.rb_index_report_failure(
  p_product_key TEXT,
  p_url         TEXT
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_fail INT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Forbidden: authentication required' USING ERRCODE = '42501';
  END IF;

  UPDATE public.rb_card_index SET
    fail_count     = fail_count + 1,
    last_failed_at = now(),
    updated_at     = now()
  WHERE product_key = p_product_key
    AND cm_url IS NOT NULL
    AND split_part(cm_url,'?',1) = split_part(coalesce(p_url, cm_url),'?',1)
  RETURNING fail_count INTO v_fail;

  IF v_fail IS NULL THEN RETURN 0; END IF;

  IF v_fail >= 2 THEN
    UPDATE public.rb_card_index SET
      cm_url = NULL,
      resolution_confidence = 0,
      updated_at = now()
    WHERE product_key = p_product_key;
  END IF;

  RETURN v_fail;
END;
$$;

GRANT EXECUTE ON FUNCTION public.rb_index_get(TEXT[])               TO authenticated;
GRANT EXECUTE ON FUNCTION public.rb_index_search(TEXT, TEXT, INT)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.rb_index_upsert(TEXT, JSONB)       TO authenticated;
GRANT EXECUTE ON FUNCTION public.rb_index_report_failure(TEXT, TEXT) TO authenticated;

-- ══════════════════════════════════════════════════════════════════════
--  6) Storage: bucket pubblico card-images (foto CM proprietarie)
--     Scrittura solo dall'edge function cm-image-cache (service role,
--     bypassa RLS). Lettura pubblica via URL /storage/v1/object/public/…
-- ══════════════════════════════════════════════════════════════════════
INSERT INTO storage.buckets (id, name, public)
VALUES ('card-images', 'card-images', true)
ON CONFLICT (id) DO UPDATE SET public = true;

DO $$
BEGIN
  BEGIN
    DROP POLICY IF EXISTS rb_card_images_public_read ON storage.objects;
    CREATE POLICY rb_card_images_public_read ON storage.objects
      FOR SELECT USING (bucket_id = 'card-images');
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'storage.objects policy non creabile (gestita dal dashboard): bucket pubblico sufficiente';
  END;
END $$;

-- Forza PostgREST a ricaricare lo schema (colonne/RPC visibili subito)
NOTIFY pgrst, 'reload schema';
