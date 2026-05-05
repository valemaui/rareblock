-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — payments PR6a (Stripe Checkout backend)
--  Migration 056
--
--  COSA FA
--  - Aggiunge campi Stripe a inv_orders (session_id, payment_intent_id,
--    customer_id, amount_received, currency)
--  - Tabella inv_stripe_events (audit webhook, idempotency anti-replay)
--  - RPC mark_order_stripe_paid (chiamato dal webhook con service_role)
--  - View v_admin_stripe_events (debug/audit)
--
--  COSA NON FA
--  - Edge function stripe-create-checkout-session (PR6b)
--  - Edge function stripe-webhook (PR6b)
--  - UI bottone "Paga con carta" (PR6c)
--  - Setup Apple Pay domain verification (PR6d, manuale Stripe Dashboard)
--
--  DECISIONI ARCHITETTURALI
--  - Stripe sempre a RareBlock (no Stripe Connect)
--  - Prodotti vendor_direct: carta NON offerta (solo bonifico)
--    → Logica nel client (PR6c) + check edge function (PR6b)
--  - Webhook obbligatorio: status passa a 'payment_received' SOLO via
--    webhook checkout.session.completed (mai dal redirect client)
--  - Currency forzata EUR (mercato italiano)
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Estensione inv_orders per Stripe ───────────────────────────────
ALTER TABLE public.inv_orders
  -- Stripe Checkout Session ID (es. cs_test_a1B2c3...) — generato al click "Paga"
  ADD COLUMN IF NOT EXISTS stripe_session_id        TEXT,
  -- PaymentIntent ID (es. pi_3...) — generato dopo che l'utente inserisce la carta
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT,
  -- Customer ID (es. cus_...) — Stripe può creare/riutilizzare
  ADD COLUMN IF NOT EXISTS stripe_customer_id       TEXT,
  -- Amount ricevuto in centesimi (per riconciliazione: deve corrispondere a total*100)
  ADD COLUMN IF NOT EXISTS stripe_amount_received   BIGINT,
  -- Currency (default eur, ma store esplicito per safety)
  ADD COLUMN IF NOT EXISTS stripe_currency          TEXT,
  -- Tipo pagamento dettagliato (card | apple_pay | google_pay | sepa_debit ecc.)
  ADD COLUMN IF NOT EXISTS stripe_payment_method_type TEXT,
  -- Brand carta (visa | mastercard | amex...) per audit/admin
  ADD COLUMN IF NOT EXISTS stripe_card_brand        TEXT,
  -- Last 4 cifre carta (mai full number — PCI)
  ADD COLUMN IF NOT EXISTS stripe_card_last4        TEXT;

CREATE INDEX IF NOT EXISTS inv_orders_stripe_session_idx
  ON public.inv_orders(stripe_session_id) WHERE stripe_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inv_orders_stripe_pi_idx
  ON public.inv_orders(stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;

COMMENT ON COLUMN public.inv_orders.stripe_session_id IS
  'Stripe Checkout Session ID. Univoco per ordine. Lookup chiave per webhook handler.';
COMMENT ON COLUMN public.inv_orders.stripe_payment_intent_id IS
  'Stripe PaymentIntent ID. Generato da Stripe quando l''utente inserisce un metodo di pagamento. Usato per refund.';

-- ── 2. Tabella inv_stripe_events (audit webhook + idempotency) ────────
-- Stripe consiglia di salvare ogni evento webhook ricevuto per:
--  (a) Audit (chi ha pagato cosa quando)
--  (b) Idempotency: Stripe può re-inviare lo stesso evento, evitiamo
--      di processare 2 volte (es. doppia conferma ordine)
CREATE TABLE IF NOT EXISTS public.inv_stripe_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stripe event ID (es. evt_1...) — UNIQUE per dedup
  stripe_event_id TEXT NOT NULL UNIQUE,
  event_type      TEXT NOT NULL,           -- es. 'checkout.session.completed'
  -- Payload completo del webhook (per debug se serve replay)
  payload         JSONB NOT NULL,
  -- Riferimenti ordine se identificabile
  order_id        UUID REFERENCES public.inv_orders(id) ON DELETE SET NULL,
  stripe_session_id TEXT,
  -- Stato processing
  processed_at    TIMESTAMPTZ,
  processed_ok    BOOLEAN,
  process_error   TEXT,
  -- Audit
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inv_stripe_events_type_idx ON public.inv_stripe_events(event_type);
CREATE INDEX IF NOT EXISTS inv_stripe_events_order_idx ON public.inv_stripe_events(order_id);
CREATE INDEX IF NOT EXISTS inv_stripe_events_session_idx ON public.inv_stripe_events(stripe_session_id);
CREATE INDEX IF NOT EXISTS inv_stripe_events_received_idx ON public.inv_stripe_events(received_at DESC);

COMMENT ON TABLE public.inv_stripe_events IS
  'Log eventi webhook Stripe. UNIQUE su stripe_event_id per idempotency. Solo edge function (service_role) può scrivere.';

-- RLS: solo admin/service_role legge, nessuno scrive direttamente (solo edge)
ALTER TABLE public.inv_stripe_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inv_stripe_events_admin_read ON public.inv_stripe_events;
CREATE POLICY inv_stripe_events_admin_read ON public.inv_stripe_events
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- ── 3. RPC mark_order_stripe_paid (chiamato dal webhook) ──────────────
-- Versione "Stripe" di mark_order_paid: prende anche i campi snapshot
-- Stripe e setta payment_method='stripe'.
-- Idempotent: se già 'payment_received', no-op (importante per webhook
-- replay).
CREATE OR REPLACE FUNCTION public.mark_order_stripe_paid(
  p_order_id              UUID,
  p_session_id            TEXT,
  p_payment_intent_id     TEXT,
  p_customer_id           TEXT DEFAULT NULL,
  p_amount_received       BIGINT DEFAULT NULL,
  p_currency              TEXT DEFAULT 'eur',
  p_payment_method_type   TEXT DEFAULT NULL,
  p_card_brand            TEXT DEFAULT NULL,
  p_card_last4            TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order RECORD;
BEGIN
  -- Solo service_role o admin (l'edge function userà service_role key)
  IF current_user NOT IN ('postgres', 'supabase_admin', 'service_role')
     AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'mark_order_stripe_paid: non autorizzato';
  END IF;

  SELECT * INTO v_order FROM public.inv_orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order non trovato: %', p_order_id;
  END IF;

  -- Idempotency: se già pagato/completato, no-op (webhook può replay)
  IF v_order.status IN ('payment_received', 'completed') THEN
    RETURN true;  -- success silente (evita errore che farebbe re-tentare il webhook)
  END IF;

  -- Validazione: importo Stripe deve corrispondere a total*100 (centesimi)
  IF p_amount_received IS NOT NULL AND v_order.total IS NOT NULL THEN
    IF abs(p_amount_received - (v_order.total * 100)::BIGINT) > 1 THEN
      -- Tolleranza 1 centesimo per arrotondamenti
      RAISE EXCEPTION 'mark_order_stripe_paid: amount mismatch — atteso % cents, ricevuto %',
        (v_order.total * 100)::BIGINT, p_amount_received;
    END IF;
  END IF;

  UPDATE public.inv_orders
  SET status                     = 'payment_received',
      paid_at                    = now(),
      payment_method             = 'stripe',
      stripe_session_id          = COALESCE(p_session_id,            stripe_session_id),
      stripe_payment_intent_id   = COALESCE(p_payment_intent_id,     stripe_payment_intent_id),
      stripe_customer_id         = COALESCE(p_customer_id,           stripe_customer_id),
      stripe_amount_received     = COALESCE(p_amount_received,       stripe_amount_received),
      stripe_currency            = COALESCE(p_currency,              stripe_currency),
      stripe_payment_method_type = COALESCE(p_payment_method_type,   stripe_payment_method_type),
      stripe_card_brand          = COALESCE(p_card_brand,            stripe_card_brand),
      stripe_card_last4          = COALESCE(p_card_last4,            stripe_card_last4),
      updated_at                 = now(),
      admin_notes                = CASE
                                     WHEN admin_notes IS NULL THEN 'Pagamento Stripe ricevuto via webhook'
                                     ELSE admin_notes || E'\n---\nPagamento Stripe ricevuto via webhook'
                                   END
  WHERE id = p_order_id;

  -- Hook futuro: enqueue email "pagamento ricevuto" via email_outbox
  -- Questo lo facciamo nello stesso flow webhook (PR6b) per atomicità.

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_order_stripe_paid(
  UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT
) TO authenticated;

-- ── 4. RPC enqueue_order_paid_email — conferma post-pagamento ─────────
-- Email "pagamento ricevuto" (per Stripe e in futuro per bonifico marked-paid).
-- Usa email_outbox + brand-aligned HTML.
CREATE OR REPLACE FUNCTION public.enqueue_order_paid_email(
  p_order_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order RECORD;
  v_subject TEXT;
  v_body TEXT;
  v_email_id UUID;
  v_method_label TEXT;
BEGIN
  -- Solo service_role/admin/owner
  IF current_user NOT IN ('postgres', 'supabase_admin', 'service_role')
     AND NOT public.is_admin() THEN
    -- Permettiamo anche all'owner dell'ordine (in caso di re-trigger UI)
    SELECT * INTO v_order FROM public.inv_orders WHERE id = p_order_id;
    IF NOT FOUND OR v_order.user_id <> auth.uid() THEN
      RAISE EXCEPTION 'enqueue_order_paid_email: non autorizzato';
    END IF;
  ELSE
    SELECT * INTO v_order FROM public.inv_orders WHERE id = p_order_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'order non trovato: %', p_order_id;
    END IF;
  END IF;

  -- Solo se status è payment_received (no doppio invio)
  IF v_order.status NOT IN ('payment_received', 'completed') THEN
    RAISE EXCEPTION 'order non in stato payment_received (corrente: %)', v_order.status;
  END IF;

  -- Label metodo pagamento
  v_method_label := CASE
    WHEN v_order.payment_method = 'stripe' THEN
      CASE
        WHEN v_order.stripe_payment_method_type = 'apple_pay' THEN 'Apple Pay'
        WHEN v_order.stripe_payment_method_type = 'google_pay' THEN 'Google Pay'
        WHEN v_order.stripe_card_brand IS NOT NULL THEN
          'Carta ' || initcap(v_order.stripe_card_brand) ||
            COALESCE(' ····' || v_order.stripe_card_last4, '')
        ELSE 'Carta'
      END
    WHEN v_order.payment_method = 'bonifico' THEN 'Bonifico bancario'
    WHEN v_order.payment_method = 'paypal' THEN 'PayPal'
    ELSE 'Pagamento ricevuto'
  END;

  v_subject := 'Pagamento confermato — Ordine ' || v_order.order_number;

  v_body := concat(
    '<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">',
    '<title>', v_subject, '</title></head>',
    '<body style="margin:0;padding:0;background:#0a0d12;font-family:''IBM Plex Sans'',Arial,sans-serif;color:#e6edf3">',
    '<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0d12;padding:32px 16px">',
      '<tr><td align="center">',
        '<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#161b22;border:1px solid #30363d;border-radius:8px;overflow:hidden">',
          '<tr><td style="padding:24px 32px;border-bottom:1px solid #30363d;text-align:center">',
            '<div style="font-family:''Montserrat'',Arial,sans-serif;font-size:18px;font-weight:300;letter-spacing:.18em;text-transform:uppercase;color:#f0ead8">Rare<span style="color:#c9a84c">Block</span></div>',
          '</td></tr>',
          -- Success icon
          '<tr><td style="padding:32px 32px 0;text-align:center">',
            '<div style="display:inline-block;width:56px;height:56px;border-radius:50%;background:rgba(63,185,80,.15);border:1px solid rgba(63,185,80,.3);color:#3fb950;font-size:26px;font-weight:600;line-height:54px">✓</div>',
          '</td></tr>',
          '<tr><td style="padding:16px 32px 8px;font-family:''IBM Plex Mono'',monospace;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#3fb950;font-weight:600;text-align:center">Pagamento confermato</td></tr>',
          '<tr><td style="padding:0 32px 12px;font-family:Georgia,serif;font-style:italic;font-size:24px;line-height:1.3;color:#f0ead8;text-align:center">Ordine ', v_order.order_number, '</td></tr>',
          '<tr><td style="padding:0 32px 24px;font-size:14px;line-height:1.65;color:#9ca3af;text-align:center">Abbiamo ricevuto il tuo pagamento. L''ordine è ora confermato e procederemo all''emissione delle quote a breve.</td></tr>',
          -- Recap
          '<tr><td style="padding:8px 32px 24px">',
            '<table width="100%" cellpadding="0" cellspacing="0" style="background:#0d1117;border:1px solid #30363d;border-radius:6px;font-size:13px">',
              '<tr><td style="padding:14px 18px;border-bottom:1px solid #21262d;color:#7d8590;font-family:''IBM Plex Mono'',monospace;font-size:11px;text-transform:uppercase;letter-spacing:.1em" width="40%">Metodo</td><td style="padding:14px 18px;border-bottom:1px solid #21262d;color:#e6edf3">', v_method_label, '</td></tr>',
              '<tr><td style="padding:14px 18px;border-bottom:1px solid #21262d;color:#7d8590;font-family:''IBM Plex Mono'',monospace;font-size:11px;text-transform:uppercase;letter-spacing:.1em">Importo</td><td style="padding:14px 18px;border-bottom:1px solid #21262d;color:#c9a84c;font-weight:600;font-size:15px">', to_char(v_order.total, 'FM999G999D00'), ' €</td></tr>',
              '<tr><td style="padding:14px 18px;color:#7d8590;font-family:''IBM Plex Mono'',monospace;font-size:11px;text-transform:uppercase;letter-spacing:.1em">Data pagamento</td><td style="padding:14px 18px;color:#e6edf3">', to_char(COALESCE(v_order.paid_at, now()), 'DD Mon YYYY HH24:MI'), '</td></tr>',
            '</table>',
          '</td></tr>',
          -- Footer
          '<tr><td style="padding:24px 32px;border-top:1px solid #30363d;text-align:center;font-size:11px;line-height:1.6;color:#6b7280">RareBlock — Collezionismo &amp; Investimento<br>noreply@rareblock.eu</td></tr>',
        '</table>',
      '</td></tr>',
    '</table></body></html>'
  );

  v_email_id := public.enqueue_email(
    p_to_email      => v_order.bill_email,
    p_subject       => v_subject,
    p_body_html     => v_body,
    p_to_name       => v_order.bill_full_name,
    p_to_user_id    => v_order.user_id,
    p_template_code => 'order_paid',
    p_context       => jsonb_build_object(
                         'order_id',     v_order.id,
                         'order_number', v_order.order_number,
                         'method',       v_order.payment_method,
                         'total',        v_order.total
                       )
  );

  RETURN v_email_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.enqueue_order_paid_email(UUID) TO authenticated;

-- ── 5. View admin: eventi Stripe (debug/audit) ────────────────────────
CREATE OR REPLACE VIEW public.v_admin_stripe_events
WITH (security_invoker = true)
AS
SELECT
  e.id,
  e.stripe_event_id,
  e.event_type,
  e.received_at,
  e.processed_at,
  e.processed_ok,
  e.process_error,
  e.order_id,
  e.stripe_session_id,
  o.order_number,
  o.bill_email,
  o.total
FROM public.inv_stripe_events e
LEFT JOIN public.inv_orders o ON o.id = e.order_id
WHERE public.is_admin()
ORDER BY e.received_at DESC
LIMIT 500;

GRANT SELECT ON public.v_admin_stripe_events TO authenticated;

COMMENT ON VIEW public.v_admin_stripe_events IS
  'Audit eventi webhook Stripe (ultimi 500). Solo admin via WHERE clause.';

-- ── 6. Reload + sanity ───────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

DO $$
BEGIN
  RAISE NOTICE '────────── 056 SUMMARY ──────────';
  RAISE NOTICE '  inv_orders.stripe_session_id added:    %',
    EXISTS(SELECT 1 FROM information_schema.columns
           WHERE table_schema='public' AND table_name='inv_orders' AND column_name='stripe_session_id');
  RAISE NOTICE '  inv_orders.stripe_payment_intent_id:   %',
    EXISTS(SELECT 1 FROM information_schema.columns
           WHERE table_schema='public' AND table_name='inv_orders' AND column_name='stripe_payment_intent_id');
  RAISE NOTICE '  inv_stripe_events table created:       %',
    EXISTS(SELECT 1 FROM information_schema.tables
           WHERE table_schema='public' AND table_name='inv_stripe_events');
  RAISE NOTICE '  mark_order_stripe_paid() function:     %',
    EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='public' AND p.proname='mark_order_stripe_paid');
  RAISE NOTICE '  enqueue_order_paid_email() function:   %',
    EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='public' AND p.proname='enqueue_order_paid_email');
  RAISE NOTICE '  v_admin_stripe_events view:            %',
    EXISTS(SELECT 1 FROM pg_views WHERE schemaname='public' AND viewname='v_admin_stripe_events');
END $$;

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 056_pr6a_stripe_backend.sql
-- ═══════════════════════════════════════════════════════════════════════
