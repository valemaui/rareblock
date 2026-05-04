-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — F4 step 4.3: marketplace order creation (atomic)
--  Migration 030: RPC marketplace_create_order + expired-cleanup helpers
--
--  Aggiunte additive: niente cambio di schema su tabelle esistenti.
-- ═══════════════════════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════════════════
--  1) RPC: marketplace_create_order
--
--  Crea un ordine + congela il listing 'active' → 'reserved' in
--  un'unica transazione. Lo SECURITY DEFINER permette al buyer di
--  scrivere in marketplace_orders (che dalla RLS sarebbe bloccato).
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.marketplace_create_order(
  p_listing_id     UUID,
  p_qty            INT,
  p_payment_method TEXT
) RETURNS marketplace_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user      UUID := auth.uid();
  v_listing   marketplace_listings%ROWTYPE;
  v_fee       marketplace_fee_config%ROWTYPE;
  v_order     marketplace_orders%ROWTYPE;
  v_subtotal  BIGINT;
  v_buyer_fee BIGINT;
  v_seller_fee BIGINT;
  v_total     BIGINT;
  v_payout    BIGINT;
  v_expires   TIMESTAMPTZ := now() + INTERVAL '15 minutes';
BEGIN
  -- ─── Auth ─────────────────────────────────────────────────────────
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '28000';
  END IF;
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RAISE EXCEPTION 'qty must be > 0' USING ERRCODE = '22023';
  END IF;
  IF p_payment_method NOT IN ('bank_transfer','stripe_card','paypal') THEN
    RAISE EXCEPTION 'unknown payment method: %', p_payment_method USING ERRCODE = '22023';
  END IF;

  -- ─── Lock listing ───────────────────────────────────────────────────
  SELECT * INTO v_listing FROM marketplace_listings
   WHERE id = p_listing_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'listing not found' USING ERRCODE = '02000';
  END IF;
  IF v_listing.status <> 'active' THEN
    RAISE EXCEPTION 'listing is not active (status=%)', v_listing.status
      USING ERRCODE = '22023';
  END IF;
  IF v_listing.expires_at IS NOT NULL AND v_listing.expires_at < now() THEN
    -- Auto-expire if past expiry
    UPDATE marketplace_listings SET status = 'expired', updated_at = now()
     WHERE id = p_listing_id;
    RAISE EXCEPTION 'listing has expired' USING ERRCODE = '22023';
  END IF;
  IF v_listing.seller_user_id = v_user THEN
    RAISE EXCEPTION 'cannot buy your own listing' USING ERRCODE = '42501';
  END IF;
  IF p_qty > v_listing.qty_listed THEN
    RAISE EXCEPTION 'qty exceeds listing (% > %)', p_qty, v_listing.qty_listed
      USING ERRCODE = '22023';
  END IF;

  -- ─── Fee snapshot ──────────────────────────────────────────────────
  SELECT * INTO v_fee FROM marketplace_fee_config
   WHERE payment_method = p_payment_method AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no active fee config for %', p_payment_method
      USING ERRCODE = '02000';
  END IF;

  -- ─── Compute amounts (cents, integer math) ─────────────────────────
  v_subtotal   := p_qty * v_listing.price_per_share_cents;
  v_buyer_fee  := ROUND(v_subtotal * v_fee.buyer_fee_bps / 10000.0)::BIGINT;
  v_seller_fee := ROUND(v_subtotal * v_fee.seller_fee_bps / 10000.0)::BIGINT;
  v_total      := v_subtotal + v_buyer_fee;
  v_payout     := v_subtotal - v_seller_fee;

  -- ─── Reserve the listing (atomic via FOR UPDATE) ───────────────────
  UPDATE marketplace_listings
     SET status = 'reserved',
         reserved_until = v_expires,
         updated_at = now()
   WHERE id = p_listing_id;

  -- ─── Insert order ──────────────────────────────────────────────────
  INSERT INTO marketplace_orders (
    listing_id, certificate_id, buyer_user_id, seller_user_id,
    qty, price_per_share_cents,
    subtotal_cents, buyer_fee_bps, seller_fee_bps,
    buyer_fee_cents, seller_fee_cents, total_cents, payout_cents,
    fee_snapshot,
    payment_method, payment_status, settlement_status,
    expires_at
  ) VALUES (
    v_listing.id, v_listing.certificate_id, v_user, v_listing.seller_user_id,
    p_qty, v_listing.price_per_share_cents,
    v_subtotal, v_fee.buyer_fee_bps, v_fee.seller_fee_bps,
    v_buyer_fee, v_seller_fee, v_total, v_payout,
    jsonb_build_object(
      'payment_method',  v_fee.payment_method,
      'buyer_fee_bps',   v_fee.buyer_fee_bps,
      'seller_fee_bps',  v_fee.seller_fee_bps,
      'snapshotted_at',  now()
    ),
    p_payment_method, 'pending', 'pending',
    v_expires
  )
  RETURNING * INTO v_order;

  RETURN v_order;
END;
$$;

REVOKE ALL ON FUNCTION public.marketplace_create_order FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.marketplace_create_order TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  2) RPC: marketplace_release_order
--
--  Cancella un ordine 'pending' (es. buyer abbandona checkout) e
--  ripristina il listing a 'active'. Idempotente.
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.marketplace_release_order(p_order_id UUID)
RETURNS marketplace_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user  UUID := auth.uid();
  v_order marketplace_orders%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '28000';
  END IF;
  SELECT * INTO v_order FROM marketplace_orders
   WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found' USING ERRCODE = '02000';
  END IF;
  -- Solo il buyer può rilasciare il proprio ordine
  IF v_order.buyer_user_id <> v_user THEN
    RAISE EXCEPTION 'not the buyer of this order' USING ERRCODE = '42501';
  END IF;
  -- Idempotente: se già cancellato, ritorna così com'è
  IF v_order.payment_status IN ('cancelled','failed','refunded') THEN
    RETURN v_order;
  END IF;
  -- Solo da 'pending' può andare a 'cancelled' tramite questa funzione.
  -- 'authorized' e 'paid' richiedono refund flow (admin / Stripe webhook).
  IF v_order.payment_status <> 'pending' THEN
    RAISE EXCEPTION 'order cannot be released (payment_status=%)', v_order.payment_status
      USING ERRCODE = '22023';
  END IF;

  UPDATE marketplace_orders
     SET payment_status = 'cancelled',
         settlement_status = 'not_required',
         updated_at = now()
   WHERE id = p_order_id
   RETURNING * INTO v_order;

  -- Ripristina il listing a 'active' (se era reserved da questo order)
  UPDATE marketplace_listings
     SET status = 'active', reserved_until = NULL, updated_at = now()
   WHERE id = v_order.listing_id
     AND status = 'reserved';

  RETURN v_order;
END;
$$;

REVOKE ALL ON FUNCTION public.marketplace_release_order FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.marketplace_release_order TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  3) Helper: cleanup di order/listing scaduti
--
--  Designed per essere chiamato da una pg_cron job ogni minuto.
--  Senza pg_cron disponibile, l'admin può chiamarla manualmente.
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.marketplace_expire_stale()
RETURNS TABLE(orders_expired INT, listings_released INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_orders_expired   INT := 0;
  v_listings_released INT := 0;
BEGIN
  -- 1) Order pending oltre il timeout di 15 min → cancel
  WITH expired_orders AS (
    UPDATE marketplace_orders
       SET payment_status    = 'cancelled',
           settlement_status = 'not_required',
           notes             = COALESCE(notes,'') || ' [auto-expired at ' || now() || ']',
           updated_at        = now()
     WHERE payment_status = 'pending'
       AND expires_at < now()
     RETURNING listing_id
  )
  SELECT count(*)::INT INTO v_orders_expired FROM expired_orders;

  -- 2) Listing 'reserved' senza ordine pending attivo → torna 'active'
  WITH released AS (
    UPDATE marketplace_listings l
       SET status         = 'active',
           reserved_until = NULL,
           updated_at     = now()
     WHERE l.status = 'reserved'
       AND NOT EXISTS (
         SELECT 1 FROM marketplace_orders o
          WHERE o.listing_id = l.id
            AND o.payment_status IN ('pending','authorized','paid')
       )
     RETURNING l.id
  )
  SELECT count(*)::INT INTO v_listings_released FROM released;

  -- 3) Listing 'active' con expires_at superato → 'expired'
  UPDATE marketplace_listings
     SET status = 'expired', updated_at = now()
   WHERE status = 'active'
     AND expires_at IS NOT NULL
     AND expires_at < now();

  RETURN QUERY SELECT v_orders_expired, v_listings_released;
END;
$$;

REVOKE ALL ON FUNCTION public.marketplace_expire_stale FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.marketplace_expire_stale TO service_role;


-- ══════════════════════════════════════════════════════════════════════
--  4) Sanity check
-- ══════════════════════════════════════════════════════════════════════
DO $$ BEGIN
  RAISE NOTICE '✔ marketplace_create_order RPC ready';
  RAISE NOTICE '✔ marketplace_release_order RPC ready';
  RAISE NOTICE '✔ marketplace_expire_stale helper ready';
END $$;
