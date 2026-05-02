-- ============================================================================
-- 026_paypal.sql — Integrazione PayPal + ledger payout vendor
-- ============================================================================
-- Modello commerciale (definito con utente):
--  · Conto unico RareBlock: tutti gli incassi PayPal vanno sul conto business RB
--  · Distribuzione vendor offline (bonifico) tracciata via tabella vendor_payouts
--  · Fee PayPal a carico investitore, mostrate al checkout
--
-- Componenti:
--  1. Estensioni a inv_orders / inv_payments per metadata PayPal
--  2. Tabella paypal_webhook_events (idempotency)
--  3. Tabella vendor_payouts (ledger contabile)
--  4. Vista v_vendor_payouts_pending (riepilogo dovuto per vendor)
--  5. RLS policies
-- ============================================================================

-- ── 1. Estensioni inv_orders ──────────────────────────────────────────────
ALTER TABLE public.inv_orders
  ADD COLUMN IF NOT EXISTS paypal_order_id    TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS paypal_capture_id  TEXT,
  ADD COLUMN IF NOT EXISTS paypal_fee         NUMERIC(12,2),  -- fee addebitata da PayPal
  ADD COLUMN IF NOT EXISTS paypal_fee_charged NUMERIC(12,2),  -- fee addebitata all'utente (calcolata al checkout)
  ADD COLUMN IF NOT EXISTS paypal_status      TEXT,           -- 'pending' | 'completed' | 'refunded' | 'denied'
  ADD COLUMN IF NOT EXISTS paypal_payer_email TEXT,
  ADD COLUMN IF NOT EXISTS paypal_environment TEXT;            -- 'sandbox' | 'live'

CREATE INDEX IF NOT EXISTS inv_orders_paypal_order_idx
  ON public.inv_orders(paypal_order_id) WHERE paypal_order_id IS NOT NULL;

-- Estendi enum payment_method (se è un check constraint)
DO $$
BEGIN
  -- Se esiste un constraint sul payment_method, rilassalo per includere 'paypal'
  IF EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name LIKE '%payment_method%' AND constraint_schema='public'
  ) THEN
    ALTER TABLE public.inv_orders DROP CONSTRAINT IF EXISTS inv_orders_payment_method_check;
    ALTER TABLE public.inv_orders ADD CONSTRAINT inv_orders_payment_method_check
      CHECK (payment_method IN ('bonifico','paypal','stripe','contanti','altro'));
  END IF;
END$$;

-- ── 2. Estensioni inv_payments ────────────────────────────────────────────
ALTER TABLE public.inv_payments
  ADD COLUMN IF NOT EXISTS paypal_capture_id  TEXT,
  ADD COLUMN IF NOT EXISTS paypal_fee         NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS paypal_payer_email TEXT;

-- Rilassa anche il constraint method su inv_payments
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name='inv_payments_method_check' AND constraint_schema='public'
  ) THEN
    ALTER TABLE public.inv_payments DROP CONSTRAINT IF EXISTS inv_payments_method_check;
    ALTER TABLE public.inv_payments ADD CONSTRAINT inv_payments_method_check
      CHECK (method IN ('bonifico','paypal','stripe','contanti','altro'));
  END IF;
END$$;

-- ── 3. paypal_webhook_events (idempotency) ────────────────────────────────
-- PayPal può rispedire lo stesso evento N volte. Ogni evento ha un event_id
-- unico → salviamo qui per evitare doppia elaborazione.
CREATE TABLE IF NOT EXISTS public.paypal_webhook_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        TEXT NOT NULL UNIQUE,        -- PayPal event id
  event_type      TEXT NOT NULL,               -- es. 'PAYMENT.CAPTURE.COMPLETED'
  resource_type   TEXT,
  resource_id     TEXT,                         -- order_id o capture_id collegato
  raw_payload     JSONB NOT NULL,
  processed       BOOLEAN NOT NULL DEFAULT false,
  processing_error TEXT,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS paypal_webhook_events_type_idx
  ON public.paypal_webhook_events(event_type);
CREATE INDEX IF NOT EXISTS paypal_webhook_events_processed_idx
  ON public.paypal_webhook_events(processed) WHERE NOT processed;
CREATE INDEX IF NOT EXISTS paypal_webhook_events_resource_idx
  ON public.paypal_webhook_events(resource_id);

-- ── 4. vendor_payouts (ledger contabile) ──────────────────────────────────
-- Per ogni order pagato che riguarda un prodotto con vendor, calcoliamo:
--  · gross_amount     = subtotale incassato (al netto sconti volume)
--  · paypal_fee       = fee PayPal effettiva (dal webhook capture.completed)
--  · rb_commission    = commissione RareBlock (gross × commission_pct)
--  · vendor_net       = gross − paypal_fee − rb_commission
--  · status           = stato del payout: 'due' | 'in_progress' | 'paid' | 'cancelled'
--
-- Un order può generare al massimo 1 vendor_payout (1:1 se prodotto ha vendor).
-- Prodotti senza vendor → nessun payout (margine 100% RareBlock).

CREATE TABLE IF NOT EXISTS public.vendor_payouts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            UUID NOT NULL UNIQUE REFERENCES public.inv_orders(id) ON DELETE RESTRICT,
  vendor_id           UUID NOT NULL REFERENCES public.inv_vendors(id) ON DELETE RESTRICT,
  product_id          UUID NOT NULL REFERENCES public.inv_products(id) ON DELETE RESTRICT,
  -- Importi
  gross_amount        NUMERIC(12,2) NOT NULL,           -- subtotale ordine (post sconti)
  paypal_fee          NUMERIC(12,2) NOT NULL DEFAULT 0, -- fee effettiva trattenuta da PayPal
  rb_commission_pct   NUMERIC(5,2)  NOT NULL DEFAULT 0, -- snapshot della % al momento dell'ordine
  rb_commission       NUMERIC(12,2) NOT NULL DEFAULT 0, -- gross × pct
  vendor_net          NUMERIC(12,2) NOT NULL,           -- da pagare al vendor
  -- Stato payout
  status              TEXT NOT NULL DEFAULT 'due'
                      CHECK (status IN ('due','in_progress','paid','cancelled','disputed')),
  -- Esecuzione
  paid_at             TIMESTAMPTZ,
  paid_method         TEXT,                              -- 'bonifico' | 'paypal' | 'altro'
  paid_reference      TEXT,                              -- CRO bonifico, ID transazione, ecc.
  paid_amount         NUMERIC(12,2),                    -- ammontare effettivamente trasferito
  paid_notes          TEXT,
  -- Audit
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by          UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS vendor_payouts_vendor_idx ON public.vendor_payouts(vendor_id, status);
CREATE INDEX IF NOT EXISTS vendor_payouts_status_idx ON public.vendor_payouts(status);
CREATE INDEX IF NOT EXISTS vendor_payouts_paid_at_idx ON public.vendor_payouts(paid_at);

-- Trigger updated_at
CREATE OR REPLACE FUNCTION public.touch_vendor_payouts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_vendor_payouts_updated_at ON public.vendor_payouts;
CREATE TRIGGER trg_vendor_payouts_updated_at
  BEFORE UPDATE ON public.vendor_payouts
  FOR EACH ROW EXECUTE FUNCTION public.touch_vendor_payouts_updated_at();

-- ── 5. Funzione: crea o aggiorna vendor_payout dopo capture PayPal ────────
-- Chiamata dalla edge function paypal-capture-order (con service_role)
-- oppure dal webhook handler. Idempotente.
CREATE OR REPLACE FUNCTION public.create_vendor_payout_for_order(
  p_order_id UUID
) RETURNS UUID AS $$
DECLARE
  v_order        public.inv_orders%ROWTYPE;
  v_product      public.inv_products%ROWTYPE;
  v_vendor       public.inv_vendors%ROWTYPE;
  v_payout_id    UUID;
  v_gross        NUMERIC(12,2);
  v_pp_fee       NUMERIC(12,2);
  v_commission   NUMERIC(12,2);
  v_net          NUMERIC(12,2);
BEGIN
  -- Carica order
  SELECT * INTO v_order FROM public.inv_orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order % non trovato', p_order_id;
  END IF;

  -- Solo per ordini PayPal completati
  IF v_order.payment_method <> 'paypal' OR v_order.paypal_status <> 'completed' THEN
    RETURN NULL;
  END IF;

  -- Carica product + vendor
  SELECT * INTO v_product FROM public.inv_products WHERE id = v_order.product_id;
  IF v_product.vendor_id IS NULL THEN
    -- Nessun vendor → niente payout (margine RareBlock 100%)
    RETURN NULL;
  END IF;

  SELECT * INTO v_vendor FROM public.inv_vendors WHERE id = v_product.vendor_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor % non trovato', v_product.vendor_id;
  END IF;

  -- Calcoli
  v_gross := COALESCE(v_order.total, v_order.subtotal, 0);
  -- Sottrai la fee PayPal CHARGED dall'utente per ottenere il netto venduto vero
  v_gross := v_gross - COALESCE(v_order.paypal_fee_charged, 0);
  v_pp_fee := COALESCE(v_order.paypal_fee, 0);
  v_commission := ROUND(v_gross * COALESCE(v_vendor.commission_pct, 0) / 100.0, 2);
  v_net := v_gross - v_pp_fee - v_commission;

  -- Upsert
  INSERT INTO public.vendor_payouts (
    order_id, vendor_id, product_id,
    gross_amount, paypal_fee, rb_commission_pct, rb_commission, vendor_net,
    status
  ) VALUES (
    v_order.id, v_vendor.id, v_product.id,
    v_gross, v_pp_fee, v_vendor.commission_pct, v_commission, v_net,
    'due'
  )
  ON CONFLICT (order_id) DO UPDATE SET
    paypal_fee     = EXCLUDED.paypal_fee,
    vendor_net     = EXCLUDED.gross_amount - EXCLUDED.paypal_fee - EXCLUDED.rb_commission,
    updated_at     = now()
  RETURNING id INTO v_payout_id;

  RETURN v_payout_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 6. Vista v_vendor_payouts_pending ─────────────────────────────────────
-- Riepilogo per ciascun vendor: quanto è dovuto in totale, quanti payout pending
DROP VIEW IF EXISTS public.v_vendor_payouts_pending;
CREATE VIEW public.v_vendor_payouts_pending AS
SELECT
  v.id                AS vendor_id,
  v.display_name      AS vendor_name,
  v.legal_name        AS vendor_legal_name,
  v.email             AS vendor_email,
  v.iban              AS vendor_iban,
  v.bic               AS vendor_bic,
  COUNT(vp.id) FILTER (WHERE vp.status = 'due')         AS payouts_due_count,
  COUNT(vp.id) FILTER (WHERE vp.status = 'in_progress') AS payouts_in_progress_count,
  COUNT(vp.id) FILTER (WHERE vp.status = 'paid')        AS payouts_paid_count,
  COALESCE(SUM(vp.vendor_net) FILTER (WHERE vp.status = 'due'), 0)         AS total_due,
  COALESCE(SUM(vp.vendor_net) FILTER (WHERE vp.status = 'in_progress'), 0) AS total_in_progress,
  COALESCE(SUM(vp.vendor_net) FILTER (WHERE vp.status = 'paid'), 0)        AS total_paid,
  COALESCE(SUM(vp.gross_amount), 0)                                        AS total_gross,
  COALESCE(SUM(vp.rb_commission), 0)                                       AS total_rb_commission,
  COALESCE(SUM(vp.paypal_fee), 0)                                          AS total_paypal_fee,
  MAX(vp.created_at)                                                       AS last_order_at
FROM public.inv_vendors v
LEFT JOIN public.vendor_payouts vp ON vp.vendor_id = v.id
GROUP BY v.id, v.display_name, v.legal_name, v.email, v.iban, v.bic;

GRANT SELECT ON public.v_vendor_payouts_pending TO authenticated;

-- ── 7. RLS policies ───────────────────────────────────────────────────────
ALTER TABLE public.paypal_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_payouts        ENABLE ROW LEVEL SECURITY;

-- Webhook events: solo service_role può scrivere; admin può leggere per debug
DROP POLICY IF EXISTS paypal_webhook_admin_read ON public.paypal_webhook_events;
CREATE POLICY paypal_webhook_admin_read ON public.paypal_webhook_events
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.profiles p
            WHERE p.id = auth.uid() AND p.is_admin = true)
  );

-- vendor_payouts: admin vede tutto, vendor vede solo i propri (read-only)
DROP POLICY IF EXISTS vendor_payouts_admin_all ON public.vendor_payouts;
CREATE POLICY vendor_payouts_admin_all ON public.vendor_payouts
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.profiles p
            WHERE p.id = auth.uid() AND p.is_admin = true)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles p
            WHERE p.id = auth.uid() AND p.is_admin = true)
  );

DROP POLICY IF EXISTS vendor_payouts_vendor_read ON public.vendor_payouts;
CREATE POLICY vendor_payouts_vendor_read ON public.vendor_payouts
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.inv_vendors v
            WHERE v.id = vendor_payouts.vendor_id AND v.user_id = auth.uid())
  );

-- ============================================================================
-- FINE 026_paypal.sql
-- ============================================================================
