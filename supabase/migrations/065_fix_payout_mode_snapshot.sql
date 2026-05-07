-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Migration 065: Fix payout_mode snapshot per stripe/paypal
--
--  Bug nel trigger inv_orders_set_payment_metadata (PR5a):
--   - Il blocco di assegnazione payout_mode era nidificato dentro
--     `IF NEW.payment_method = 'bonifico'`, quindi ordini stripe e paypal
--     uscivano con payout_mode = DEFAULT 'rareblock' indipendentemente
--     dal valore inv_products.payout_mode. Questo portava a errori di
--     accounting per vendor_direct con pagamento carta.
--
--  Fix:
--   - Estrae lo snapshot di payout_mode + vendor_id PRIMA del controllo
--     payment_method, applicandolo a TUTTI i metodi di pagamento.
--   - Lo snapshot IBAN resta nidificato in 'bonifico' (non serve per
--     stripe/paypal: i fondi arrivano su Stripe/PayPal account RareBlock).
--   - Aggiunge backfill: ricalcola payout_mode su ordini esistenti
--     stripe/paypal in stato non terminale che hanno payout_mode='rareblock'
--     ma il prodotto associato ha payout_mode='vendor_direct'.
--     Solo per ordini ancora processabili (escluse refunded/cancelled
--     che sono storia immutabile).
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Trigger fix ──────────────────────────────────────────────────
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
  IF TG_OP <> 'INSERT' THEN RETURN NEW; END IF;

  -- Settings (per expires_at default + IBAN RareBlock)
  SELECT payment_expiry_days, rb_iban, rb_bic,
         COALESCE(rb_iban_holder, rb_company_name) AS holder,
         rb_bank_name
    INTO v_settings
    FROM public.rb_settings WHERE id = 1;

  IF NEW.expires_at IS NULL THEN
    NEW.expires_at := now() + (COALESCE(v_settings.payment_expiry_days, 7) || ' days')::INTERVAL;
  END IF;

  -- Snapshot payout_mode + vendor_id da inv_products — applicato a TUTTI
  -- i metodi di pagamento (bonifico, stripe, paypal). Era il bug: stava
  -- dentro l'IF payment_method='bonifico'.
  IF NEW.product_id IS NOT NULL THEN
    SELECT p.payout_mode, p.vendor_id INTO v_product
      FROM public.inv_products p WHERE p.id = NEW.product_id;

    IF NEW.payout_mode IS NULL THEN
      NEW.payout_mode := COALESCE(v_product.payout_mode, 'rareblock');
    END IF;
  END IF;

  -- Solo bonifico necessita snapshot IBAN payout (per causale + IBAN
  -- mostrato all'utente nella mail). Stripe e paypal regolano i fondi
  -- internamente sui loro account RareBlock.
  IF NEW.payment_method = 'bonifico' THEN
    IF NEW.payout_mode = 'vendor_direct' AND v_product.vendor_id IS NOT NULL THEN
      SELECT v.iban, v.bic,
             COALESCE(v.iban_holder, v.legal_name, v.display_name) AS holder,
             v.bank_name
        INTO v_vendor
      FROM public.inv_vendors v WHERE v.id = v_product.vendor_id;

      NEW.payout_iban   := COALESCE(NEW.payout_iban,   v_vendor.iban);
      NEW.payout_bic    := COALESCE(NEW.payout_bic,    v_vendor.bic);
      NEW.payout_holder := COALESCE(NEW.payout_holder, v_vendor.holder);
      NEW.payout_bank   := COALESCE(NEW.payout_bank,   v_vendor.bank_name);
    ELSE
      NEW.payout_iban   := COALESCE(NEW.payout_iban,   v_settings.rb_iban);
      NEW.payout_bic    := COALESCE(NEW.payout_bic,    v_settings.rb_bic);
      NEW.payout_holder := COALESCE(NEW.payout_holder, v_settings.holder);
      NEW.payout_bank   := COALESCE(NEW.payout_bank,   v_settings.rb_bank_name);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- (Trigger già installato dalla 054, non serve ricrearlo: CREATE OR
-- REPLACE FUNCTION basta.)

-- ── 2. Backfill ordini stripe/paypal con payout_mode disallineato ──
-- Ordini in stato attivo (non terminale) il cui payout_mode è 'rareblock'
-- ma il prodotto è 'vendor_direct'. Skip ordini terminali (history).
DO $$
DECLARE
  v_count INT;
BEGIN
  WITH affected AS (
    SELECT o.id
      FROM public.inv_orders o
      JOIN public.inv_products p ON p.id = o.product_id
     WHERE o.payment_method IN ('stripe','paypal')
       AND o.payout_mode = 'rareblock'
       AND p.payout_mode = 'vendor_direct'
       AND o.status NOT IN ('refunded','cancelled','expired')
  ),
  upd AS (
    UPDATE public.inv_orders o
       SET payout_mode = 'vendor_direct'
      FROM affected a
     WHERE o.id = a.id
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM upd;

  RAISE NOTICE 'Backfill: % ordini stripe/paypal allineati a vendor_direct', v_count;
END $$;

NOTIFY pgrst, 'reload schema';
