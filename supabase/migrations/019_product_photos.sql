-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Galleria foto prodotto investor
--  Storage bucket + tabella metadati + RLS
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Storage bucket pubblico in lettura (le foto prodotto sono pubbliche) ──
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'product-photos',
  'product-photos',
  true,
  10485760,  -- 10 MB
  ARRAY['image/jpeg','image/png','image/webp','image/gif']
)
ON CONFLICT (id) DO UPDATE SET
  public = true,
  file_size_limit = 10485760,
  allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp','image/gif'];

-- Storage policies: chiunque legge, solo admin scrive/modifica
DROP POLICY IF EXISTS "product_photos_public_read"  ON storage.objects;
DROP POLICY IF EXISTS "product_photos_admin_insert" ON storage.objects;
DROP POLICY IF EXISTS "product_photos_admin_update" ON storage.objects;
DROP POLICY IF EXISTS "product_photos_admin_delete" ON storage.objects;

CREATE POLICY "product_photos_public_read" ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'product-photos');

CREATE POLICY "product_photos_admin_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'product-photos' AND public.is_admin());

CREATE POLICY "product_photos_admin_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'product-photos' AND public.is_admin());

CREATE POLICY "product_photos_admin_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'product-photos' AND public.is_admin());

-- ── 2. Tabella metadati foto ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.inv_product_photos (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id   UUID NOT NULL REFERENCES public.inv_products(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,                -- es. "products/<uuid>/abc123.jpg"
  url          TEXT NOT NULL,                -- public URL completo
  caption      TEXT,
  sort_order   INT NOT NULL DEFAULT 0,
  is_cover     BOOLEAN NOT NULL DEFAULT false,
  width        INT,
  height       INT,
  bytes        INT,
  mime_type    TEXT,
  created_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inv_product_photos_product_idx ON public.inv_product_photos(product_id);
CREATE INDEX IF NOT EXISTS inv_product_photos_order_idx   ON public.inv_product_photos(product_id, sort_order);
-- Una sola cover per prodotto
CREATE UNIQUE INDEX IF NOT EXISTS inv_product_photos_cover_uidx
  ON public.inv_product_photos(product_id) WHERE is_cover = true;

-- ── 3. RLS: lettura pubblica, scrittura solo admin ───────────────────
ALTER TABLE public.inv_product_photos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "inv_product_photos_select" ON public.inv_product_photos;
DROP POLICY IF EXISTS "inv_product_photos_insert" ON public.inv_product_photos;
DROP POLICY IF EXISTS "inv_product_photos_update" ON public.inv_product_photos;
DROP POLICY IF EXISTS "inv_product_photos_delete" ON public.inv_product_photos;

-- SELECT: tutti gli authenticated (le foto sono visibili a chiunque acceda al prodotto)
CREATE POLICY "inv_product_photos_select" ON public.inv_product_photos
  FOR SELECT TO authenticated
  USING (true);

-- INSERT/UPDATE/DELETE: solo admin
CREATE POLICY "inv_product_photos_insert" ON public.inv_product_photos
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

CREATE POLICY "inv_product_photos_update" ON public.inv_product_photos
  FOR UPDATE TO authenticated
  USING (public.is_admin());

CREATE POLICY "inv_product_photos_delete" ON public.inv_product_photos
  FOR DELETE TO authenticated
  USING (public.is_admin());

-- ── 4. Trigger: auto-set is_cover sulla prima foto del prodotto ──────
CREATE OR REPLACE FUNCTION public.inv_product_photos_auto_cover()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Se è la prima foto del prodotto, marcala automaticamente come cover
  IF NOT EXISTS (
    SELECT 1 FROM public.inv_product_photos
    WHERE product_id = NEW.product_id AND id <> NEW.id AND is_cover = true
  ) THEN
    NEW.is_cover := true;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inv_product_photos_auto_cover_trg ON public.inv_product_photos;
CREATE TRIGGER inv_product_photos_auto_cover_trg
  BEFORE INSERT ON public.inv_product_photos
  FOR EACH ROW EXECUTE FUNCTION public.inv_product_photos_auto_cover();

-- ── 5. Trigger: garantisci unicità cover (set_cover RPC fa swap atomico) ──
-- Funzione RPC: imposta una foto come cover, demote tutte le altre del prodotto
CREATE OR REPLACE FUNCTION public.set_cover_photo(p_photo_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product_id UUID;
BEGIN
  -- Solo admin
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo admin può impostare la cover';
  END IF;

  SELECT product_id INTO v_product_id
  FROM public.inv_product_photos
  WHERE id = p_photo_id;

  IF v_product_id IS NULL THEN
    RAISE EXCEPTION 'Foto non trovata';
  END IF;

  -- Demote tutte le altre foto del prodotto
  UPDATE public.inv_product_photos
  SET is_cover = false
  WHERE product_id = v_product_id AND id <> p_photo_id;

  -- Promote la nuova cover
  UPDATE public.inv_product_photos
  SET is_cover = true
  WHERE id = p_photo_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_cover_photo(UUID) TO authenticated;

-- ── 6. View: prodotti con cover photo joinata ───────────────────────
DROP VIEW IF EXISTS public.v_inv_products_with_cover;
CREATE VIEW public.v_inv_products_with_cover
WITH (security_invoker = true)
AS
SELECT
  p.*,
  ph.url AS cover_photo_url,
  ph.id  AS cover_photo_id,
  (SELECT COUNT(*) FROM public.inv_product_photos WHERE product_id = p.id) AS photo_count
FROM public.inv_products p
LEFT JOIN public.inv_product_photos ph ON ph.product_id = p.id AND ph.is_cover = true;

GRANT SELECT ON public.v_inv_products_with_cover TO authenticated;

-- Reload PostgREST
NOTIFY pgrst, 'reload schema';
