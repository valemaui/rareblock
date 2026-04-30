-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Tabella ordini per checkout multi-step
--  Lega holding + payment a un singolo ordine identificato da numero
--  pubblico leggibile (es. ORD-2026-00042).
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Sequence per numerazione progressiva annuale ──────────────────
CREATE SEQUENCE IF NOT EXISTS inv_orders_number_seq START 1;

-- ── 2. Tabella ordini ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.inv_orders (
  id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_number       TEXT NOT NULL UNIQUE,
  user_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product_id         UUID NOT NULL REFERENCES inv_products(id) ON DELETE RESTRICT,

  -- Dettagli economici (snapshot al momento dell'ordine)
  qty                INT NOT NULL CHECK (qty > 0),
  unit_price         NUMERIC(10,2) NOT NULL,
  subtotal           NUMERIC(10,2) NOT NULL,
  discount_pct       NUMERIC(5,2)  NOT NULL DEFAULT 0,
  discount_amount    NUMERIC(10,2) NOT NULL DEFAULT 0,
  total              NUMERIC(10,2) NOT NULL,

  -- Dati fatturazione (snapshot al checkout)
  bill_full_name     TEXT NOT NULL,
  bill_email         TEXT NOT NULL,
  bill_phone         TEXT,
  bill_fiscal_code   TEXT,
  bill_vat_number    TEXT,
  bill_address       TEXT,
  bill_city          TEXT,
  bill_zip           TEXT,
  bill_country       TEXT DEFAULT 'IT',
  bill_pec           TEXT,
  bill_sdi_code      TEXT,
  is_company         BOOLEAN NOT NULL DEFAULT false,

  -- Pagamento
  payment_method     TEXT NOT NULL DEFAULT 'bonifico'
                       CHECK (payment_method IN ('bonifico','stripe','paypal')),
  bank_reference     TEXT,
  causale            TEXT,

  -- Workflow
  status             TEXT NOT NULL DEFAULT 'awaiting_payment'
                       CHECK (status IN (
                         'draft',              -- non ancora confermato
                         'awaiting_payment',   -- ordine creato, in attesa bonifico
                         'payment_received',   -- admin marca incasso
                         'completed',          -- holding emesso, ordine completo
                         'cancelled',          -- annullato (utente o admin)
                         'expired'             -- scaduto senza pagamento
                       )),

  -- Link agli oggetti generati (popolati dopo conferma admin)
  holding_id         UUID REFERENCES inv_holdings(id) ON DELETE SET NULL,
  payment_id         UUID REFERENCES inv_payments(id) ON DELETE SET NULL,

  notes              TEXT,
  admin_notes        TEXT,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ,
  paid_at            TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  cancelled_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS inv_orders_user_idx     ON inv_orders(user_id);
CREATE INDEX IF NOT EXISTS inv_orders_product_idx  ON inv_orders(product_id);
CREATE INDEX IF NOT EXISTS inv_orders_status_idx   ON inv_orders(status);
CREATE INDEX IF NOT EXISTS inv_orders_number_idx   ON inv_orders(order_number);
CREATE INDEX IF NOT EXISTS inv_orders_created_idx  ON inv_orders(created_at DESC);

-- ── 3. Trigger: numera l'ordine alla creazione ───────────────────────
CREATE OR REPLACE FUNCTION public.inv_orders_assign_number()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_year TEXT;
  v_num  BIGINT;
BEGIN
  IF NEW.order_number IS NOT NULL AND NEW.order_number <> '' THEN
    RETURN NEW;
  END IF;
  v_year := to_char(now(), 'YYYY');
  v_num  := nextval('inv_orders_number_seq');
  NEW.order_number := 'ORD-' || v_year || '-' || lpad(v_num::text, 5, '0');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inv_orders_assign_number_trg ON public.inv_orders;
CREATE TRIGGER inv_orders_assign_number_trg
  BEFORE INSERT ON public.inv_orders
  FOR EACH ROW EXECUTE FUNCTION public.inv_orders_assign_number();

-- ── 4. Trigger: aggiorna timestamp di workflow ───────────────────────
CREATE OR REPLACE FUNCTION public.inv_orders_status_audit()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.updated_at := now();
    IF NEW.status = 'payment_received' AND NEW.paid_at IS NULL THEN
      NEW.paid_at := now();
    END IF;
    IF NEW.status = 'completed' AND NEW.completed_at IS NULL THEN
      NEW.completed_at := now();
    END IF;
    IF NEW.status = 'cancelled' AND NEW.cancelled_at IS NULL THEN
      NEW.cancelled_at := now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inv_orders_status_audit_trg ON public.inv_orders;
CREATE TRIGGER inv_orders_status_audit_trg
  BEFORE UPDATE OF status ON public.inv_orders
  FOR EACH ROW EXECUTE FUNCTION public.inv_orders_status_audit();

-- ── 5. RLS ──────────────────────────────────────────────────────────
ALTER TABLE public.inv_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "inv_orders_select_own"   ON public.inv_orders;
DROP POLICY IF EXISTS "inv_orders_insert_own"   ON public.inv_orders;
DROP POLICY IF EXISTS "inv_orders_update_own"   ON public.inv_orders;
DROP POLICY IF EXISTS "inv_orders_admin_all"    ON public.inv_orders;

-- L'utente vede e crea i propri ordini
CREATE POLICY "inv_orders_select_own" ON public.inv_orders
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "inv_orders_insert_own" ON public.inv_orders
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- L'utente può modificare i propri SOLO se draft/awaiting_payment (può cancellare prima del pagamento)
CREATE POLICY "inv_orders_update_own" ON public.inv_orders
  FOR UPDATE
  USING (auth.uid() = user_id AND status IN ('draft','awaiting_payment'))
  WITH CHECK (auth.uid() = user_id);

-- Admin: vede e modifica tutto
CREATE POLICY "inv_orders_admin_all" ON public.inv_orders
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- ── 6. View per riepilogo ordini con dati prodotto ──────────────────
DROP VIEW IF EXISTS public.v_user_orders;
CREATE VIEW public.v_user_orders
WITH (security_invoker = true)
AS
SELECT
  o.*,
  p.name           AS product_name,
  p.image_url      AS product_image_url,
  p.quote_unit     AS product_quote_unit,
  p.type           AS product_type,
  p.status         AS product_status,
  ph.url           AS product_cover_url
FROM public.inv_orders o
JOIN public.inv_products p ON p.id = o.product_id
LEFT JOIN public.inv_product_photos ph ON ph.product_id = p.id AND ph.is_cover = true;

GRANT SELECT ON public.v_user_orders TO authenticated;

-- ── 7. Funzione utility: causale bonifico standard ──────────────────
CREATE OR REPLACE FUNCTION public.format_order_causale(p_order_number TEXT, p_user_id UUID)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  -- Es. "ORD-2026-00042 - Mario Rossi"
  SELECT p_order_number;
$$;

NOTIFY pgrst, 'reload schema';

-- Verifica
SELECT 'inv_orders ready' AS status,
       (SELECT COUNT(*) FROM information_schema.tables WHERE table_name='inv_orders') AS table_exists;
