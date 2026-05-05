-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — auth/payments PR5a (backend bonifico strutturato)
--  Migration 054
--
--  COSA FA
--  - Tabella rb_settings: configurazione globale ammin (singleton row)
--    - IBAN/BIC/intestatario RareBlock per bonifici scenario A
--    - Limiti, scadenze, parametri default
--  - Aggiunge inv_products.payout_mode ('rareblock' | 'vendor_direct')
--    + snapshot inv_products.payout_iban/bic/holder per scenario B
--    (così se il vendor cambia IBAN, gli ordini esistenti restano consistenti)
--  - Aggiunge inv_orders.expires_at (default +7 giorni dal create)
--  - Aggiunge inv_orders.payout_* snapshot al momento del checkout
--  - Aggiorna trigger inv_orders_assign_number: prefisso 'RBK-' (era 'ORD-')
--  - Aggiorna format_order_causale: ritorna 'RBK-2026-000123-Q5'
--  - Cron pg_cron: auto-cancella ordini awaiting_payment scaduti
--  - RPC mark_order_paid (admin) + RPC cancel_order_expired (cron)
--
--  COSA NON FA
--  - UI checkout con IBAN dinamico (PR5b)
--  - Pannello admin riconciliazione (PR5c)
--  - Email notifications (PR5b — usa email_outbox di migration 049)
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Tabella rb_settings (configurazione globale) ───────────────────
-- Singleton: una sola riga con id=1. Storage di parametri globali admin.
CREATE TABLE IF NOT EXISTS public.rb_settings (
  id                  INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),

  -- Dati bonifico RareBlock (scenario A)
  rb_company_name     TEXT,                -- Es. "RareBlock S.r.l."
  rb_iban             TEXT,                -- IT60 X054 ...
  rb_bic              TEXT,                -- BANKITAA
  rb_bank_name        TEXT,                -- Es. "Intesa Sanpaolo"
  rb_bank_address     TEXT,                -- Indirizzo filiale
  rb_iban_holder      TEXT,                -- Intestatario (se diverso da company)

  -- Parametri pagamenti
  payment_expiry_days INT NOT NULL DEFAULT 7   CHECK (payment_expiry_days BETWEEN 1 AND 30),
  reminder_days       INT NOT NULL DEFAULT 3   CHECK (reminder_days BETWEEN 1 AND 14),

  -- Email mittente notifiche pagamenti
  payment_email_from  TEXT DEFAULT 'noreply@rareblock.eu',

  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by          UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Inserisce la singleton row se non esiste (placeholder IBAN da editare in admin)
INSERT INTO public.rb_settings (
  id, rb_company_name, rb_iban, rb_bic, rb_bank_name,
  rb_iban_holder, payment_expiry_days, reminder_days
)
VALUES (
  1,
  'RareBlock S.r.l.',
  'IT00X0000000000000000000000',  -- PLACEHOLDER — admin edita da pannello
  'BANKITAAXXX',
  'Banca da configurare',
  'RareBlock S.r.l.',
  7, 3
)
ON CONFLICT (id) DO NOTHING;

-- RLS: tutti gli authenticated leggono (servizio richiede dati IBAN al checkout)
-- ma SOLO admin scrivono. La sensibilità è bassa (sono dati pubblicizzati al
-- cliente comunque per il bonifico).
ALTER TABLE public.rb_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rb_settings_read ON public.rb_settings;
CREATE POLICY rb_settings_read ON public.rb_settings
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS rb_settings_admin_write ON public.rb_settings;
CREATE POLICY rb_settings_admin_write ON public.rb_settings
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

COMMENT ON TABLE public.rb_settings IS
  'Configurazione globale RareBlock (singleton id=1). Modificabile solo da admin via pannello dedicato (PR5c).';

-- ── 2. Estensione inv_vendors per IBAN intestatario ───────────────────
-- inv_vendors aveva già iban + bic, aggiungiamo l'intestatario esplicito
-- (potrebbe differire da display_name o legal_name)
ALTER TABLE public.inv_vendors
  ADD COLUMN IF NOT EXISTS iban_holder    TEXT,
  ADD COLUMN IF NOT EXISTS bank_name      TEXT;

COMMENT ON COLUMN public.inv_vendors.iban_holder IS
  'Intestatario del conto IBAN (può differire da legal_name/display_name).';
COMMENT ON COLUMN public.inv_vendors.bank_name IS
  'Nome banca (visualizzato al cliente in fase di bonifico per scenario B).';

-- ── 3. Estensione inv_products per scenario A/B ───────────────────────
ALTER TABLE public.inv_products
  ADD COLUMN IF NOT EXISTS payout_mode TEXT NOT NULL DEFAULT 'rareblock'
    CHECK (payout_mode IN ('rareblock', 'vendor_direct'));

COMMENT ON COLUMN public.inv_products.payout_mode IS
  'Scenario bonifico: rareblock (cliente paga RareBlock, default) | vendor_direct (cliente paga direttamente al vendor, accordo specifico)';

CREATE INDEX IF NOT EXISTS inv_products_payout_mode_idx ON public.inv_products(payout_mode);

-- ── 4. Estensione inv_orders per scenario + scadenza + snapshot IBAN ──
ALTER TABLE public.inv_orders
  -- Snapshot dello scenario al momento del checkout (se vendor cambia
  -- IBAN dopo, gli ordini esistenti restano coerenti col bonifico atteso)
  ADD COLUMN IF NOT EXISTS payout_mode    TEXT DEFAULT 'rareblock'
    CHECK (payout_mode IN ('rareblock', 'vendor_direct')),
  ADD COLUMN IF NOT EXISTS payout_iban    TEXT,
  ADD COLUMN IF NOT EXISTS payout_bic     TEXT,
  ADD COLUMN IF NOT EXISTS payout_holder  TEXT,    -- intestatario
  ADD COLUMN IF NOT EXISTS payout_bank    TEXT,    -- nome banca

  -- Scadenza pagamento (default +7 giorni). Cron auto-cancella scaduti.
  ADD COLUMN IF NOT EXISTS expires_at     TIMESTAMPTZ,

  -- Tracking notifiche email (no double-send)
  ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expired_email_sent_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS inv_orders_expires_at_idx ON public.inv_orders(expires_at)
  WHERE status = 'awaiting_payment';

-- ── 5. Trigger: setta expires_at + payout_* snapshot al checkout ──────
CREATE OR REPLACE FUNCTION public.inv_orders_set_payment_metadata()
RETURNS TRIGGER LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_settings RECORD;
  v_product  RECORD;
  v_vendor   RECORD;
BEGIN
  -- Solo per nuovi ordini, e solo se non già impostati
  IF TG_OP <> 'INSERT' THEN RETURN NEW; END IF;

  -- Carica settings globali (default 7gg se non configurato)
  SELECT payment_expiry_days INTO v_settings FROM public.rb_settings WHERE id = 1;

  IF NEW.expires_at IS NULL THEN
    NEW.expires_at := now() + (COALESCE(v_settings.payment_expiry_days, 7) || ' days')::INTERVAL;
  END IF;

  -- Se è bonifico, snapshot dei dati IBAN secondo lo scenario del prodotto
  IF NEW.payment_method = 'bonifico' THEN
    SELECT p.payout_mode, p.vendor_id INTO v_product
    FROM public.inv_products p WHERE p.id = NEW.product_id;

    IF NEW.payout_mode IS NULL THEN
      NEW.payout_mode := COALESCE(v_product.payout_mode, 'rareblock');
    END IF;

    IF NEW.payout_mode = 'vendor_direct' AND v_product.vendor_id IS NOT NULL THEN
      -- Scenario B: snapshot IBAN del vendor
      SELECT v.iban, v.bic, COALESCE(v.iban_holder, v.legal_name, v.display_name) AS holder, v.bank_name
        INTO v_vendor
      FROM public.inv_vendors v WHERE v.id = v_product.vendor_id;
      NEW.payout_iban   := COALESCE(NEW.payout_iban, v_vendor.iban);
      NEW.payout_bic    := COALESCE(NEW.payout_bic,  v_vendor.bic);
      NEW.payout_holder := COALESCE(NEW.payout_holder, v_vendor.holder);
      NEW.payout_bank   := COALESCE(NEW.payout_bank, v_vendor.bank_name);
    ELSE
      -- Scenario A (default): snapshot IBAN RareBlock dai settings
      SELECT rb_iban, rb_bic,
             COALESCE(rb_iban_holder, rb_company_name) AS holder,
             rb_bank_name
        INTO v_settings
      FROM public.rb_settings WHERE id = 1;
      NEW.payout_iban   := COALESCE(NEW.payout_iban,   v_settings.rb_iban);
      NEW.payout_bic    := COALESCE(NEW.payout_bic,    v_settings.rb_bic);
      NEW.payout_holder := COALESCE(NEW.payout_holder, v_settings.holder);
      NEW.payout_bank   := COALESCE(NEW.payout_bank,   v_settings.rb_bank_name);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inv_orders_payment_metadata_trg ON public.inv_orders;
CREATE TRIGGER inv_orders_payment_metadata_trg
  BEFORE INSERT ON public.inv_orders
  FOR EACH ROW EXECUTE FUNCTION public.inv_orders_set_payment_metadata();

-- ── 6. Aggiorno il trigger inv_orders_assign_number: ORD- → RBK- ──────
CREATE OR REPLACE FUNCTION public.inv_orders_assign_number()
RETURNS TRIGGER LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_year TEXT;
  v_num  BIGINT;
BEGIN
  IF NEW.order_number IS NOT NULL AND NEW.order_number <> '' THEN
    RETURN NEW;
  END IF;
  v_year := to_char(now(), 'YYYY');
  v_num  := nextval('inv_orders_number_seq');
  -- Nuovo formato: RBK-YYYY-NNNNNN (6 cifre per safety futura)
  NEW.order_number := 'RBK-' || v_year || '-' || lpad(v_num::text, 6, '0');
  RETURN NEW;
END;
$$;

-- ── 7. Aggiorno format_order_causale: include qty in suffisso -Q{n} ───
CREATE OR REPLACE FUNCTION public.format_order_causale(
  p_order_number TEXT,
  p_qty          INT DEFAULT NULL
)
RETURNS TEXT LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_qty IS NULL OR p_qty <= 0 THEN p_order_number
    ELSE p_order_number || '-Q' || p_qty::text
  END;
$$;

COMMENT ON FUNCTION public.format_order_causale(TEXT, INT) IS
  'Formato causale bonifico standard: RBK-YYYY-NNNNNN-Q5 (es. RBK-2026-000123-Q5)';

-- Trigger: popola causale automaticamente al INSERT
CREATE OR REPLACE FUNCTION public.inv_orders_set_causale()
RETURNS TRIGGER LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RETURN NEW; END IF;
  IF NEW.causale IS NULL OR NEW.causale = '' OR NEW.causale NOT LIKE 'RBK-%-Q%' THEN
    -- order_number già popolato dal trigger inv_orders_assign_number
    NEW.causale := public.format_order_causale(NEW.order_number, NEW.qty);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inv_orders_causale_trg ON public.inv_orders;
CREATE TRIGGER inv_orders_causale_trg
  BEFORE INSERT ON public.inv_orders
  FOR EACH ROW EXECUTE FUNCTION public.inv_orders_set_causale();
-- NOTA ordine trigger: BEFORE INSERT → assign_number, payment_metadata, set_causale.
-- Postgres esegue trigger in ordine alfabetico del nome → controllo:
--   inv_orders_assign_number_trg     (a)
--   inv_orders_causale_trg            (c) ← OK, parte dopo assign_number
--   inv_orders_payment_metadata_trg   (p) ← OK, parte dopo
-- Risultato: ordine ha order_number → causale lo legge → expires_at + IBAN
-- snapshot.

-- ── 8. RPC mark_order_paid (admin riconciliazione manuale) ────────────
CREATE OR REPLACE FUNCTION public.mark_order_paid(
  p_order_id      UUID,
  p_bank_ref      TEXT DEFAULT NULL,
  p_admin_notes   TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order RECORD;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'mark_order_paid: solo admin';
  END IF;

  SELECT * INTO v_order FROM public.inv_orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order non trovato: %', p_order_id;
  END IF;
  IF v_order.status NOT IN ('awaiting_payment', 'expired') THEN
    RAISE EXCEPTION 'order non è in stato awaiting_payment/expired (corrente: %)', v_order.status;
  END IF;

  UPDATE public.inv_orders
  SET status         = 'payment_received',
      paid_at        = now(),
      bank_reference = COALESCE(p_bank_ref, bank_reference),
      admin_notes    = CASE
                         WHEN p_admin_notes IS NULL THEN admin_notes
                         WHEN admin_notes IS NULL THEN p_admin_notes
                         ELSE admin_notes || E'\n---\n' || p_admin_notes
                       END,
      updated_at     = now()
  WHERE id = p_order_id;

  -- Hook futuro: enqueue email "pagamento ricevuto" via email_outbox (PR5b)
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_order_paid(UUID, TEXT, TEXT) TO authenticated;

-- ── 9. RPC cancel_expired_orders (cron tick giornaliero) ──────────────
-- Auto-cancella ordini awaiting_payment con expires_at < now()
CREATE OR REPLACE FUNCTION public.cancel_expired_orders()
RETURNS TABLE(cancelled_count INT, order_ids UUID[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ids UUID[] := '{}';
  v_count INT := 0;
BEGIN
  -- Solo service_role o admin (chiamato da pg_cron come service_role)
  IF NOT (public.is_admin() OR current_setting('role') = 'service_role') THEN
    -- Permettiamo comunque l'esecuzione se chiamata dal cron (postgres role)
    IF current_user NOT IN ('postgres', 'supabase_admin') THEN
      RAISE EXCEPTION 'cancel_expired_orders: non autorizzato';
    END IF;
  END IF;

  WITH expired AS (
    UPDATE public.inv_orders
    SET status        = 'expired',
        cancelled_at  = now(),
        updated_at    = now(),
        admin_notes   = CASE
                          WHEN admin_notes IS NULL THEN 'Auto-cancellato dal cron: scadenza pagamento bonifico'
                          ELSE admin_notes || E'\n---\nAuto-cancellato dal cron: scadenza pagamento bonifico'
                        END
    WHERE status = 'awaiting_payment'
      AND expires_at IS NOT NULL
      AND expires_at < now()
    RETURNING id
  )
  SELECT array_agg(id), count(*)::INT INTO v_ids, v_count FROM expired;

  cancelled_count := COALESCE(v_count, 0);
  order_ids       := COALESCE(v_ids, '{}');
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_expired_orders() TO authenticated;

-- ── 10. pg_cron: tick giornaliero alle 04:00 UTC ──────────────────────
-- Schedule: ogni giorno alle 04:00 UTC, chiama cancel_expired_orders()
DO $$
BEGIN
  -- Verifica che pg_cron sia disponibile
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron extension non installata, skip schedule. Eseguire CREATE EXTENSION pg_cron prima.';
    RETURN;
  END IF;

  -- Rimuove eventuale schedule precedente (idempotente)
  PERFORM cron.unschedule('rb_cancel_expired_orders')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rb_cancel_expired_orders');

  -- Schedula nuovo (ogni giorno alle 04:00 UTC, dopo il fractional cron)
  PERFORM cron.schedule(
    'rb_cancel_expired_orders',
    '0 4 * * *',                       -- daily 04:00 UTC
    $cron$ SELECT public.cancel_expired_orders(); $cron$
  );
  RAISE NOTICE 'pg_cron job rb_cancel_expired_orders schedulato (04:00 UTC daily)';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron schedule fallito: %', SQLERRM;
END $$;

-- ── 11. View admin: ordini in attesa pagamento (per riconciliazione) ──
CREATE OR REPLACE VIEW public.v_admin_pending_orders
WITH (security_invoker = true)
AS
SELECT
  o.id,
  o.order_number,
  o.causale,
  o.created_at,
  o.expires_at,
  (o.expires_at - now()) AS time_to_expire,
  CASE
    WHEN o.expires_at < now() THEN 'expired'
    WHEN o.expires_at < now() + INTERVAL '24 hours' THEN 'critical'
    WHEN o.expires_at < now() + INTERVAL '72 hours' THEN 'warning'
    ELSE 'ok'
  END AS urgency,
  o.user_id,
  o.bill_full_name,
  o.bill_email,
  o.product_id,
  p.name AS product_name,
  o.qty,
  o.total,
  o.payout_mode,
  o.payout_iban,
  o.payout_holder,
  o.bank_reference,
  o.reminder_sent_at,
  o.status
FROM public.inv_orders o
LEFT JOIN public.inv_products p ON p.id = o.product_id
WHERE o.status IN ('awaiting_payment', 'expired')
  AND public.is_admin()  -- security_invoker filtra: vede solo se admin
ORDER BY o.expires_at ASC NULLS LAST;

GRANT SELECT ON public.v_admin_pending_orders TO authenticated;

COMMENT ON VIEW public.v_admin_pending_orders IS
  'Lista ordini in attesa pagamento + scaduti, per pannello admin riconciliazione (PR5c). Solo admin via WHERE clause.';

-- ── 12. Reload + sanity ───────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

DO $$
DECLARE
  v_settings_count INT;
  v_settings_iban  TEXT;
BEGIN
  SELECT count(*), max(rb_iban) INTO v_settings_count, v_settings_iban FROM public.rb_settings;
  RAISE NOTICE '────────── 054 SUMMARY ──────────';
  RAISE NOTICE '  rb_settings rows:                   %', v_settings_count;
  RAISE NOTICE '  rb_settings IBAN (placeholder?):    %', v_settings_iban;
  RAISE NOTICE '  inv_products.payout_mode added:     %',
    EXISTS(SELECT 1 FROM information_schema.columns
           WHERE table_schema='public' AND table_name='inv_products' AND column_name='payout_mode');
  RAISE NOTICE '  inv_orders.expires_at added:        %',
    EXISTS(SELECT 1 FROM information_schema.columns
           WHERE table_schema='public' AND table_name='inv_orders' AND column_name='expires_at');
  RAISE NOTICE '  inv_orders.payout_iban added:       %',
    EXISTS(SELECT 1 FROM information_schema.columns
           WHERE table_schema='public' AND table_name='inv_orders' AND column_name='payout_iban');
  RAISE NOTICE '  inv_vendors.iban_holder added:      %',
    EXISTS(SELECT 1 FROM information_schema.columns
           WHERE table_schema='public' AND table_name='inv_vendors' AND column_name='iban_holder');
  RAISE NOTICE '  mark_order_paid() function:         %',
    EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='public' AND p.proname='mark_order_paid');
  RAISE NOTICE '  cancel_expired_orders() function:   %',
    EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='public' AND p.proname='cancel_expired_orders');
  RAISE NOTICE '  v_admin_pending_orders view:        %',
    EXISTS(SELECT 1 FROM pg_views WHERE schemaname='public' AND viewname='v_admin_pending_orders');
END $$;

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 054_pr5a_payments_backend.sql
-- ═══════════════════════════════════════════════════════════════════════
