-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Scala sconti per acquisti multipli (volume discounts)
--  Solo prodotti type='fractional' usano effettivamente questi tier.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Tabella tier sconto ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.inv_product_discounts (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id   UUID NOT NULL REFERENCES public.inv_products(id) ON DELETE CASCADE,
  min_qty      INT NOT NULL CHECK (min_qty >= 2),
  discount_pct NUMERIC(5,2) NOT NULL CHECK (discount_pct > 0 AND discount_pct <= 90),
  created_at   TIMESTAMPTZ DEFAULT now(),
  -- una sola scala per soglia per prodotto
  UNIQUE (product_id, min_qty)
);

CREATE INDEX IF NOT EXISTS inv_product_discounts_product_idx
  ON public.inv_product_discounts(product_id, min_qty);

-- ── 2. RLS: lettura pubblica autenticati, scrittura admin ─────────────
ALTER TABLE public.inv_product_discounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "inv_product_discounts_select" ON public.inv_product_discounts;
DROP POLICY IF EXISTS "inv_product_discounts_insert" ON public.inv_product_discounts;
DROP POLICY IF EXISTS "inv_product_discounts_update" ON public.inv_product_discounts;
DROP POLICY IF EXISTS "inv_product_discounts_delete" ON public.inv_product_discounts;

CREATE POLICY "inv_product_discounts_select" ON public.inv_product_discounts
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "inv_product_discounts_insert" ON public.inv_product_discounts
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());

CREATE POLICY "inv_product_discounts_update" ON public.inv_product_discounts
  FOR UPDATE TO authenticated USING (public.is_admin());

CREATE POLICY "inv_product_discounts_delete" ON public.inv_product_discounts
  FOR DELETE TO authenticated USING (public.is_admin());

-- ── 3. Funzione utility: calcolo sconto applicabile a una quantità ───
CREATE OR REPLACE FUNCTION public.get_volume_discount(
  p_product_id UUID,
  p_qty INT
) RETURNS NUMERIC
LANGUAGE sql
STABLE
AS $$
  -- Ritorna la % di sconto migliore (più alta) tra i tier la cui min_qty <= p_qty
  SELECT COALESCE(MAX(discount_pct), 0)
  FROM public.inv_product_discounts
  WHERE product_id = p_product_id
    AND min_qty <= p_qty;
$$;

GRANT EXECUTE ON FUNCTION public.get_volume_discount(UUID, INT) TO authenticated, anon;

-- ── 4. View: prodotti con array tier (per render efficiente) ─────────
DROP VIEW IF EXISTS public.v_inv_products_with_cover;
CREATE VIEW public.v_inv_products_with_cover
WITH (security_invoker = true)
AS
SELECT
  p.*,
  ph.url AS cover_photo_url,
  ph.id  AS cover_photo_id,
  (SELECT COUNT(*) FROM public.inv_product_photos WHERE product_id = p.id) AS photo_count,
  (SELECT json_agg(
     json_build_object('min_qty', d.min_qty, 'discount_pct', d.discount_pct)
     ORDER BY d.min_qty
   )
   FROM public.inv_product_discounts d
   WHERE d.product_id = p.id) AS discount_tiers
FROM public.inv_products p
LEFT JOIN public.inv_product_photos ph ON ph.product_id = p.id AND ph.is_cover = true;

GRANT SELECT ON public.v_inv_products_with_cover TO authenticated;

NOTIFY pgrst, 'reload schema';
