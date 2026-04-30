-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Tipologia fisica del prodotto investor (sealed/single/etc)
--  Aggiunta colonna category con CHECK includendo box_break.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.inv_products
  ADD COLUMN IF NOT EXISTS category TEXT;

-- Drop il vecchio CHECK se presente (qualunque nome abbia)
DO $$
DECLARE con_name text;
BEGIN
  SELECT conname INTO con_name
  FROM pg_constraint
  WHERE conrelid = 'public.inv_products'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%category%'
  LIMIT 1;

  IF con_name IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.inv_products DROP CONSTRAINT ' || quote_ident(con_name);
  END IF;
END $$;

-- Ricrea con elenco completo + box_break
ALTER TABLE public.inv_products
  ADD CONSTRAINT inv_products_category_check
  CHECK (category IS NULL OR category IN (
    'booster_box','etb','booster_bundle','collection_box',
    'tin','blister','single_pack','case','box_break',
    'graded_card','sealed_other','other'
  ));

CREATE INDEX IF NOT EXISTS inv_products_category_idx ON inv_products(category);

-- Reload PostgREST cache
NOTIFY pgrst, 'reload schema';

-- Verifica
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name='inv_products' AND column_name='category';
