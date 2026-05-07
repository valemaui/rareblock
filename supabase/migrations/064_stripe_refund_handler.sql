-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Migration 064: Refund support per inv_orders
--
--  - Estende il CHECK su inv_orders.status per includere 'refunded'
--  - Aggiunge campi refund tracking: refunded_at, refund_amount, refund_reason
--  - RPC apply_stripe_refund: chiamata da stripe-webhook su charge.refunded
--    (transitions sicure, idempotente, audit log)
--  - Trigger holdings: se l'ordine aveva un holding emesso, viene marcato
--    come refunded (campo aggiunto a inv_holdings)
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Status 'refunded' ────────────────────────────────────────────
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT con.conname FROM pg_constraint con
    JOIN pg_class cls ON cls.oid=con.conrelid
    JOIN pg_namespace nsp ON nsp.oid=cls.relnamespace
    WHERE nsp.nspname='public' AND cls.relname='inv_orders' AND con.contype='c'
      AND pg_get_constraintdef(con.oid) ILIKE '%refunded%' = false
      AND pg_get_constraintdef(con.oid) ILIKE '%awaiting_payment%'
  LOOP
    EXECUTE format('ALTER TABLE public.inv_orders DROP CONSTRAINT %I', c.conname);
    RAISE NOTICE 'Dropped status constraint: %', c.conname;
  END LOOP;
END $$;

ALTER TABLE public.inv_orders
  ADD CONSTRAINT inv_orders_status_chk
  CHECK (status IN (
    'draft','awaiting_payment','payment_received',
    'completed','cancelled','expired','refunded'
  ));

-- ── 2. Campi refund ─────────────────────────────────────────────────
ALTER TABLE public.inv_orders
  ADD COLUMN IF NOT EXISTS refunded_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refund_amount    NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS refund_reason    TEXT,
  ADD COLUMN IF NOT EXISTS stripe_refund_id TEXT;

CREATE INDEX IF NOT EXISTS inv_orders_stripe_refund_idx
  ON public.inv_orders(stripe_refund_id) WHERE stripe_refund_id IS NOT NULL;

-- Holdings refund flag (se esiste tabella)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema='public' AND table_name='inv_holdings') THEN
    ALTER TABLE public.inv_holdings
      ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS refund_reason TEXT;
  END IF;
END $$;

-- ── 3. RPC apply_stripe_refund ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.apply_stripe_refund(
  p_payment_intent_id TEXT,
  p_charge_id         TEXT,
  p_refund_id         TEXT,
  p_amount_refunded   NUMERIC,        -- in EUR (NON in cents)
  p_reason            TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order   RECORD;
  v_was_already BOOLEAN := false;
BEGIN
  IF p_payment_intent_id IS NULL OR p_payment_intent_id = '' THEN
    RAISE EXCEPTION 'payment_intent_id required';
  END IF;
  IF p_refund_id IS NULL OR p_refund_id = '' THEN
    RAISE EXCEPTION 'refund_id required';
  END IF;

  -- Lookup ordine
  SELECT * INTO v_order
    FROM public.inv_orders
   WHERE stripe_payment_intent_id = p_payment_intent_id
   LIMIT 1;

  IF v_order IS NULL THEN
    RAISE EXCEPTION 'No order found for payment_intent %', p_payment_intent_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Idempotency: stesso refund_id già processato → no-op
  IF v_order.stripe_refund_id = p_refund_id THEN
    RETURN jsonb_build_object(
      'ok', true, 'idempotent', true,
      'order_id', v_order.id, 'order_number', v_order.order_number
    );
  END IF;

  v_was_already := (v_order.status = 'refunded');

  -- Aggiorna ordine → refunded
  UPDATE public.inv_orders SET
    status            = 'refunded',
    refunded_at       = COALESCE(refunded_at, now()),
    refund_amount     = p_amount_refunded,
    refund_reason     = COALESCE(p_reason, refund_reason),
    stripe_refund_id  = p_refund_id,
    updated_at        = now()
  WHERE id = v_order.id;

  -- Se c'era un holding emesso, lo marca refunded (no delete)
  IF v_order.holding_id IS NOT NULL THEN
    BEGIN
      UPDATE public.inv_holdings SET
        refunded_at   = COALESCE(refunded_at, now()),
        refund_reason = COALESCE(p_reason, 'stripe_refund')
      WHERE id = v_order.holding_id;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'holding update failed: %', SQLERRM;
    END;
  END IF;

  RETURN jsonb_build_object(
    'ok',           true,
    'order_id',     v_order.id,
    'order_number', v_order.order_number,
    'amount',       p_amount_refunded,
    'was_already',  v_was_already,
    'holding_id',   v_order.holding_id
  );
END $$;

GRANT EXECUTE ON FUNCTION public.apply_stripe_refund(TEXT,TEXT,TEXT,NUMERIC,TEXT)
  TO authenticated, service_role;

-- ── 4. RPC enqueue_order_refunded_email ─────────────────────────────
-- Email "rimborso elaborato" allineata al template di enqueue_order_paid_email
-- (056) ma con palette/copy contestuali al refund.
CREATE OR REPLACE FUNCTION public.enqueue_order_refunded_email(
  p_order_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order   RECORD;
  v_subject TEXT;
  v_body    TEXT;
  v_id      UUID;
  v_amount  TEXT;
BEGIN
  -- Solo service_role/admin
  IF current_user NOT IN ('postgres','supabase_admin','service_role')
     AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'enqueue_order_refunded_email: non autorizzato';
  END IF;

  SELECT * INTO v_order FROM public.inv_orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order non trovato: %', p_order_id;
  END IF;

  IF v_order.status <> 'refunded' THEN
    RAISE EXCEPTION 'order non in stato refunded (corrente: %)', v_order.status;
  END IF;

  v_amount := '€ ' || TO_CHAR(COALESCE(v_order.refund_amount, v_order.total),
                              'FM999G999G990D00');
  v_subject := 'Rimborso elaborato — Ordine ' || v_order.order_number;

  v_body :=
'<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>' || v_subject || '</title></head>'
|| '<body style="margin:0;padding:0;background:#0d1117;font-family:-apple-system,BlinkMacSystemFont,''Segoe UI'',Roboto,sans-serif;color:#c9d1d9">'
|| '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0d1117;padding:48px 16px"><tr><td align="center">'
|| '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:#161b22;border:1px solid #30363d;border-radius:8px;overflow:hidden">'
-- Header
|| '<tr><td align="center" style="padding:36px 36px 28px 36px;border-bottom:1px solid #30363d;background:linear-gradient(180deg,rgba(201,168,76,.04) 0%,transparent 100%)">'
|| '<div style="font-family:''Montserrat'',Arial,sans-serif;font-size:18px;font-weight:300;letter-spacing:.18em;text-transform:uppercase;color:#f0ead8">'
|| 'Rare<span style="color:#c9a84c;font-weight:400">Block</span></div></td></tr>'
-- Headline
|| '<tr><td style="padding:40px 40px 16px 40px">'
|| '<div style="font-family:''IBM Plex Mono'',Consolas,monospace;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#c9a84c;margin-bottom:14px">Rimborso elaborato</div>'
|| '<h1 style="margin:0;font-family:Georgia,''Times New Roman'',serif;font-style:italic;font-weight:400;font-size:28px;line-height:1.25;color:#f0ead8">Il tuo rimborso è stato elaborato.</h1>'
|| '</td></tr>'
-- Body
|| '<tr><td style="padding:14px 40px 8px 40px;font-size:14px;line-height:1.65;color:#c9d1d9">'
|| '<p style="margin:0 0 16px 0">Abbiamo elaborato il rimborso per l''ordine <strong style="color:#f0ead8">' || v_order.order_number || '</strong>. L''importo apparirà sul tuo metodo di pagamento originale entro 5–10 giorni lavorativi, a seconda della tua banca.</p>'
|| '</td></tr>'
-- Recap box
|| '<tr><td style="padding:0 40px 28px 40px">'
|| '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0d1117;border:1px solid #30363d;border-radius:6px">'
|| '<tr><td style="padding:14px 18px;border-bottom:1px solid #21262d;color:#7d8590;font-family:''IBM Plex Mono'',monospace;font-size:11px;text-transform:uppercase;letter-spacing:.1em" width="40%">Importo rimborsato</td>'
|| '<td style="padding:14px 18px;border-bottom:1px solid #21262d;color:#c9a84c;font-weight:600;font-family:Georgia,serif;font-size:18px">' || v_amount || '</td></tr>'
|| '<tr><td style="padding:14px 18px;border-bottom:1px solid #21262d;color:#7d8590;font-family:''IBM Plex Mono'',monospace;font-size:11px;text-transform:uppercase;letter-spacing:.1em">Ordine</td>'
|| '<td style="padding:14px 18px;border-bottom:1px solid #21262d;color:#e6edf3;font-family:''IBM Plex Mono'',monospace">' || v_order.order_number || '</td></tr>'
|| CASE WHEN v_order.refund_reason IS NOT NULL AND v_order.refund_reason <> '' THEN
     '<tr><td style="padding:14px 18px;color:#7d8590;font-family:''IBM Plex Mono'',monospace;font-size:11px;text-transform:uppercase;letter-spacing:.1em">Motivo</td>'
     || '<td style="padding:14px 18px;color:#e6edf3">' || v_order.refund_reason || '</td></tr>'
   ELSE '' END
|| '</table></td></tr>'
-- Footer
|| '<tr><td align="center" style="padding:24px 40px 32px 40px;border-top:1px solid #30363d;background:#0d1117">'
|| '<div style="font-size:11px;color:#6e7681;line-height:1.7">Per qualsiasi domanda sul rimborso, rispondi a questa email.<br>RareBlock · <a href="https://www.rareblock.eu" style="color:#8b949e;text-decoration:none">rareblock.eu</a></div>'
|| '</td></tr>'
|| '</table></td></tr></table></body></html>';

  v_id := public.enqueue_email(
    p_to_email      := v_order.bill_email,
    p_subject       := v_subject,
    p_body_html     := v_body,
    p_to_name       := v_order.bill_full_name,
    p_to_user_id    := v_order.user_id,
    p_template_code := 'order_refunded',
    p_context       := jsonb_build_object(
                         'order_id',     v_order.id,
                         'order_number', v_order.order_number,
                         'amount',       v_order.refund_amount,
                         'reason',       v_order.refund_reason
                       )
  );

  RETURN v_id;
END $$;

GRANT EXECUTE ON FUNCTION public.enqueue_order_refunded_email(UUID)
  TO authenticated, service_role;

-- ── 5. Reload ───────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
