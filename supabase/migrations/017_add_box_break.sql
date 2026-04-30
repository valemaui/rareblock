-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Aggiunta tipologia 'box_break' (HOTFIX nome tabella)
--
--  Errore precedente: tabella si chiama submission_items, non
--  submission_request_items. Script auto-detect del nome corretto.
-- ═══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  tbl_name text;
  con_name text;
BEGIN
  -- Trova la tabella corretta (gestisce entrambi i nomi possibili)
  SELECT c.relname INTO tbl_name
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname IN ('submission_items','submission_request_items')
  ORDER BY (c.relname = 'submission_items') DESC
  LIMIT 1;

  IF tbl_name IS NULL THEN
    RAISE EXCEPTION 'Nessuna tabella submission_items o submission_request_items trovata in public';
  END IF;

  RAISE NOTICE 'Tabella trovata: public.%', tbl_name;

  -- Trova il nome del CHECK constraint su product_type (qualsiasi nome abbia)
  SELECT con.conname INTO con_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = rel.relnamespace
  WHERE n.nspname = 'public'
    AND rel.relname = tbl_name
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) ILIKE '%product_type%'
  LIMIT 1;

  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', tbl_name, con_name);
    RAISE NOTICE 'Constraint % rimosso', con_name;
  END IF;

  -- Ricrea il CHECK con box_break incluso
  EXECUTE format($f$
    ALTER TABLE public.%I
    ADD CONSTRAINT %I
    CHECK (product_type IN (
      'booster_box','etb','booster_bundle','collection_box',
      'tin','blister','single_pack','case','box_break','other'
    ))
  $f$, tbl_name, tbl_name || '_product_type_check');

  RAISE NOTICE 'CHECK constraint ricreato con box_break su public.%', tbl_name;
END $$;

-- Force reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';

-- Verifica
SELECT con.conname, pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
JOIN pg_namespace n ON n.oid = rel.relnamespace
WHERE n.nspname = 'public'
  AND rel.relname IN ('submission_items','submission_request_items')
  AND con.contype = 'c'
  AND pg_get_constraintdef(con.oid) ILIKE '%product_type%';
