-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Stato 'closing_soon' (in chiusura)
--  Transizione automatica nell'ultima settimana prima di target_date
--  oppure forzata manualmente da admin via modal.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Aggiorna CHECK constraint per includere 'closing_soon' ────────
DO $$
DECLARE con_name text;
BEGIN
  SELECT conname INTO con_name
  FROM pg_constraint
  WHERE conrelid = 'public.inv_products'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%status%'
    AND pg_get_constraintdef(oid) ILIKE '%open%'
  LIMIT 1;
  IF con_name IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.inv_products DROP CONSTRAINT ' || quote_ident(con_name);
    RAISE NOTICE 'Dropped constraint %', con_name;
  END IF;
END $$;

ALTER TABLE public.inv_products
  ADD CONSTRAINT inv_products_status_check
  CHECK (status IN (
    'draft','open','closing_soon','closed',
    'pending_grading','grading_complete','hold','liquidated'
  ));

-- ── 2. Funzione: auto-promote open → closing_soon a meno di 7gg ──────
CREATE OR REPLACE FUNCTION public.refresh_closing_soon()
RETURNS TABLE(updated_id UUID, old_status TEXT, new_status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.inv_products
     SET status = 'closing_soon',
         updated_at = now()
   WHERE status = 'open'
     AND target_date IS NOT NULL
     AND target_date > CURRENT_DATE
     AND target_date <= CURRENT_DATE + INTERVAL '7 days'
   RETURNING id, 'open'::text, 'closing_soon'::text;
END;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_closing_soon() TO authenticated;

-- ── 3. Trigger su INSERT/UPDATE: applica logica automatica ───────────
-- Quando si salva un prodotto come 'open' ma manca <=7gg, switch immediato.
-- Quando admin imposta manualmente 'closing_soon', viene rispettato.
CREATE OR REPLACE FUNCTION public.inv_products_auto_closing()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Solo se status='open' e target_date entro 7gg → promuovi automaticamente
  IF NEW.status = 'open'
     AND NEW.target_date IS NOT NULL
     AND NEW.target_date > CURRENT_DATE
     AND NEW.target_date <= CURRENT_DATE + INTERVAL '7 days' THEN
    NEW.status := 'closing_soon';
  END IF;
  -- Se manualmente messo 'closing_soon' ma target_date già passata: mantenere status
  -- L'admin può sempre forzare manualmente, non sovrascriviamo le scelte esplicite.
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inv_products_auto_closing_trg ON public.inv_products;
CREATE TRIGGER inv_products_auto_closing_trg
  BEFORE INSERT OR UPDATE OF status, target_date ON public.inv_products
  FOR EACH ROW EXECUTE FUNCTION public.inv_products_auto_closing();

-- ── 4. Backfill: applica subito a prodotti già aperti < 7gg ──────────
SELECT * FROM public.refresh_closing_soon();

-- ── 5. Index per query "in chiusura" ────────────────────────────────
CREATE INDEX IF NOT EXISTS inv_products_closing_idx
  ON public.inv_products(target_date)
  WHERE status IN ('open','closing_soon');

NOTIFY pgrst, 'reload schema';

-- Verifica
SELECT id, name, status, target_date, target_date - CURRENT_DATE AS days_left
FROM public.inv_products
WHERE status IN ('open','closing_soon')
ORDER BY target_date ASC;
