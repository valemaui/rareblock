-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Aggiunta tipologia 'box_break' a submission_request_items
-- ═══════════════════════════════════════════════════════════════════════

-- Drop e ricrea CHECK constraint per includere 'box_break'
ALTER TABLE public.submission_request_items
  DROP CONSTRAINT IF EXISTS submission_request_items_product_type_check;

ALTER TABLE public.submission_request_items
  ADD CONSTRAINT submission_request_items_product_type_check
  CHECK (product_type IN (
    'booster_box',
    'etb',
    'booster_bundle',
    'collection_box',
    'tin',
    'blister',
    'single_pack',
    'case',
    'box_break',
    'other'
  ));

-- Force reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
