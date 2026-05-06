-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — payments PR6 follow-up
--  Migration 057: fix trigger payout_mode snapshot + backfill ordini
--
--  COSA FA
--  - Aggiorna inv_orders_set_payment_metadata: lo snapshot di payout_mode
--    viene fatto SEMPRE (per qualsiasi payment_method), non solo per
--    bonifico. I campi IBAN-specifici (payout_iban/bic/holder/bank)
--    restano popolati solo per bonifico (Stripe/PayPal non li usano).
--  - Backfill: ordini awaiting_payment esistenti con payout_mode default
--    'rareblock' ma prodotto 'vendor_direct' vengono ri-snapshotati al
--    valore corretto del prodotto.
--
--  PERCHÉ
--  Senza questo fix, ordini Stripe/PayPal di prodotti vendor_direct
--  vengono salvati con payout_mode='rareblock' (default), causando
--  incoerenza nel record: l'ordine sembra scenario A ma il prodotto
--  è scenario B.
--
--  Conseguenze fixate:
--  - Edge stripe-create-checkout-session basava il check vendor_direct
--    su order.payout_mode (che era 'rareblock' anche per prodotti B)
--  - Pannello admin v_admin_pending_orders mostrava badge 'RareBlock'
--    per ordini Stripe che logicamente vanno al vendor
--  - Reportistica futura sarebbe stata distorta
--
--  Decisione operativa rimane: Stripe incassa SEMPRE a RareBlock anche
--  per prodotti vendor_direct (semplifica payout, gestione vendor
--  offline). Ma il campo payout_mode su inv_orders ora riflette
--  fedelmente la natura del prodotto.
--
--  DIPENDENZE
--  - Migration 054 (PR5a): definizione iniziale del trigger
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Aggiornamento trigger inv_orders_set_payment_metadata ──────────
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
  -- Solo per nuovi ordini
  IF TG_OP <> 'INSERT' THEN RETURN NEW; END IF;

  -- Carica settings globali (default 7gg se non configurato)
  SELECT payment_expiry_days INTO v_settings FROM public.rb_settings WHERE id = 1;

  IF NEW.expires_at IS NULL THEN
    NEW.expires_at := now() + (COALESCE(v_settings.payment_expiry_days, 7) || ' days')::INTERVAL;
  END IF;

  -- ─────────────────────────────────────────────────────────────────
  -- SNAPSHOT PAYOUT_MODE (sempre, per qualsiasi payment_method)
  -- ─────────────────────────────────────────────────────────────────
  -- payout_mode riflette la natura del prodotto al momento dell'ordine.
  -- Anche se Stripe incassa sempre a RareBlock, il campo deve riflettere
  -- se il prodotto è 'rareblock' o 'vendor_direct' per:
  --   - Gating Stripe (edge function blocca card su vendor_direct)
  --   - Visualizzazione admin (badge scenario corretto)
  --   - Reportistica payout futura
  SELECT p.payout_mode, p.vendor_id INTO v_product
  FROM public.inv_products p WHERE p.id = NEW.product_id;

  IF NEW.payout_mode IS NULL OR NEW.payout_mode = 'rareblock' THEN
    -- Override solo se non esplicitamente impostato dal client
    -- (Nota: 'rareblock' è il DEFAULT colonna, quindi il client che
    --  non passa payout_mode arriva qui con 'rareblock' di default,
    --  e noi lo sovrascriviamo col valore reale del prodotto.)
    NEW.payout_mode := COALESCE(v_product.payout_mode, 'rareblock');
  END IF;

  -- ─────────────────────────────────────────────────────────────────
  -- SNAPSHOT IBAN (solo per bonifico — gli altri metodi non lo usano)
  -- ─────────────────────────────────────────────────────────────────
  IF NEW.payment_method = 'bonifico' THEN
    IF NEW.payout_mode = 'vendor_direct' AND v_product.vendor_id IS NOT NULL THEN
      -- Scenario B: IBAN vendor
      SELECT v.iban, v.bic, COALESCE(v.iban_holder, v.legal_name, v.display_name) AS holder, v.bank_name
        INTO v_vendor
      FROM public.inv_vendors v WHERE v.id = v_product.vendor_id;
      NEW.payout_iban   := COALESCE(NEW.payout_iban, v_vendor.iban);
      NEW.payout_bic    := COALESCE(NEW.payout_bic,  v_vendor.bic);
      NEW.payout_holder := COALESCE(NEW.payout_holder, v_vendor.holder);
      NEW.payout_bank   := COALESCE(NEW.payout_bank, v_vendor.bank_name);
    ELSE
      -- Scenario A (o vendor_direct senza vendor configurato): IBAN RareBlock
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
  -- Per stripe/paypal: payout_iban/bic/holder/bank restano NULL
  -- (è corretto: non sono dati pertinenti).

  RETURN NEW;
END;
$$;

-- Trigger già esistente (creato in 054), il CREATE OR REPLACE FUNCTION
-- aggiorna il body senza ricrearlo.

-- ── 2. Backfill ordini esistenti incoerenti ──────────────────────────
-- Cerca ordini awaiting_payment con payout_mode='rareblock' (default)
-- ma il loro prodotto è vendor_direct → ri-snapshot.
DO $$
DECLARE
  v_count INT := 0;
BEGIN
  WITH to_fix AS (
    SELECT o.id, p.payout_mode AS correct_mode
    FROM public.inv_orders o
    JOIN public.inv_products p ON p.id = o.product_id
    WHERE o.status = 'awaiting_payment'
      AND o.payout_mode = 'rareblock'
      AND p.payout_mode = 'vendor_direct'
  ),
  upd AS (
    UPDATE public.inv_orders o
    SET payout_mode = tf.correct_mode,
        updated_at  = now(),
        admin_notes = CASE
                        WHEN admin_notes IS NULL THEN 'Migration 057: payout_mode ri-sincronizzato da prodotto'
                        ELSE admin_notes || E'\n---\nMigration 057: payout_mode ri-sincronizzato da prodotto'
                      END
    FROM to_fix tf
    WHERE o.id = tf.id
    RETURNING o.id
  )
  SELECT COUNT(*) INTO v_count FROM upd;

  RAISE NOTICE 'Backfill ordini incoerenti: % righe aggiornate', v_count;
END $$;

-- ── 3. Sanity: report finale ─────────────────────────────────────────
DO $$
DECLARE
  v_total_awaiting INT;
  v_inconsistent   INT;
BEGIN
  SELECT COUNT(*) INTO v_total_awaiting
  FROM public.inv_orders WHERE status = 'awaiting_payment';

  SELECT COUNT(*) INTO v_inconsistent
  FROM public.inv_orders o
  JOIN public.inv_products p ON p.id = o.product_id
  WHERE o.status = 'awaiting_payment'
    AND o.payout_mode <> p.payout_mode;

  RAISE NOTICE '────────── 057 SUMMARY ──────────';
  RAISE NOTICE '  Trigger inv_orders_set_payment_metadata aggiornato (snapshot payout_mode SEMPRE)';
  RAISE NOTICE '  Ordini awaiting_payment totali:        %', v_total_awaiting;
  RAISE NOTICE '  Ordini ancora incoerenti dopo backfill: %', v_inconsistent;
  RAISE NOTICE '  (atteso 0; se >0, sono casi limite con vendor non configurato)';
END $$;

NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 057_pr6_followup_payout_mode_snapshot.sql
-- ═══════════════════════════════════════════════════════════════════════
