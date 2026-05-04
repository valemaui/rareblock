-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — F4 step 4.5: admin reconciliation
--  Migration 032: RPC admin-only per riconciliazione bonifici e refund
-- ═══════════════════════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════════════════
--  RPC: marketplace_admin_mark_paid_bank
--
--  Admin manualmente marca un ordine bonifico come pagato. Questo è il
--  trigger principale del flusso bonifico: il bonifico arriva in banca,
--  l'admin lo matcha contro la causale, e clicca "Confirm payment received".
--
--  Idempotente: già paid → no-op.
--  Solo metodo bank_transfer (Stripe e PayPal hanno il proprio webhook).
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.marketplace_admin_mark_paid_bank(
  p_order_id    UUID,
  p_bank_ref    TEXT,        -- causale che il buyer ha messo nel bonifico
  p_admin_notes TEXT DEFAULT NULL
) RETURNS marketplace_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user  UUID := auth.uid();
  v_order marketplace_orders%ROWTYPE;
  v_role  TEXT;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '28000';
  END IF;
  -- Solo admin
  SELECT role INTO v_role FROM profiles WHERE id = v_user;
  IF v_role <> 'admin' THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_order FROM marketplace_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found' USING ERRCODE = '02000';
  END IF;
  IF v_order.payment_method <> 'bank_transfer' THEN
    RAISE EXCEPTION 'this RPC is bank_transfer only (got %)', v_order.payment_method
      USING ERRCODE = '22023';
  END IF;
  -- Idempotency
  IF v_order.payment_status = 'paid' THEN
    RETURN v_order;
  END IF;
  IF v_order.payment_status NOT IN ('pending') THEN
    RAISE EXCEPTION 'order in unexpected payment_status: %', v_order.payment_status
      USING ERRCODE = '22023';
  END IF;

  UPDATE marketplace_orders
     SET payment_status      = 'paid',
         paid_at             = now(),
         payment_provider_id = COALESCE(p_bank_ref, payment_provider_id),
         notes               = COALESCE(notes,'')
                               || ' [admin paid by ' || v_user::text
                               || ' at ' || now()
                               || COALESCE(': ' || p_admin_notes, '')
                               || ']',
         updated_at          = now()
   WHERE id = p_order_id
   RETURNING * INTO v_order;
  RETURN v_order;
END;
$$;
REVOKE ALL ON FUNCTION public.marketplace_admin_mark_paid_bank FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.marketplace_admin_mark_paid_bank TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  RPC: marketplace_admin_cancel_order
--
--  Admin cancella un ordine pending (es. il bonifico non è mai arrivato
--  dopo X giorni e l'admin ne deve liberare il listing).
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.marketplace_admin_cancel_order(
  p_order_id    UUID,
  p_reason      TEXT DEFAULT NULL
) RETURNS marketplace_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user  UUID := auth.uid();
  v_order marketplace_orders%ROWTYPE;
  v_role  TEXT;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '28000';
  END IF;
  SELECT role INTO v_role FROM profiles WHERE id = v_user;
  IF v_role <> 'admin' THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_order FROM marketplace_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found' USING ERRCODE = '02000';
  END IF;
  IF v_order.payment_status IN ('paid','authorized') THEN
    RAISE EXCEPTION 'cannot cancel a paid order — use refund flow' USING ERRCODE = '22023';
  END IF;
  IF v_order.payment_status IN ('cancelled','failed','refunded') THEN
    RETURN v_order;  -- idempotent
  END IF;

  UPDATE marketplace_orders
     SET payment_status    = 'cancelled',
         settlement_status = 'not_required',
         notes             = COALESCE(notes,'') || ' [admin cancelled by ' || v_user::text
                              || ' at ' || now()
                              || COALESCE(': ' || p_reason, '') || ']',
         updated_at        = now()
   WHERE id = p_order_id
   RETURNING * INTO v_order;

  -- Libera il listing se era reserved
  UPDATE marketplace_listings
     SET status = 'active', reserved_until = NULL, updated_at = now()
   WHERE id = v_order.listing_id AND status = 'reserved';

  RETURN v_order;
END;
$$;
REVOKE ALL ON FUNCTION public.marketplace_admin_cancel_order FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.marketplace_admin_cancel_order TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  RPC: marketplace_admin_update_fee_config
--
--  Admin modifica le percentuali della tabella fee. La modifica si
--  applica solo a NUOVI ordini: ordini esistenti hanno fee_snapshot
--  congelato.
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.marketplace_admin_update_fee_config(
  p_payment_method TEXT,
  p_buyer_fee_bps  INT,
  p_seller_fee_bps INT,
  p_notes          TEXT DEFAULT NULL
) RETURNS marketplace_fee_config
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_role TEXT;
  v_row  marketplace_fee_config%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '28000';
  END IF;
  SELECT role INTO v_role FROM profiles WHERE id = v_user;
  IF v_role <> 'admin' THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  IF p_payment_method NOT IN ('bank_transfer','stripe_card','paypal') THEN
    RAISE EXCEPTION 'invalid payment_method' USING ERRCODE = '22023';
  END IF;
  IF p_buyer_fee_bps  < 0 OR p_buyer_fee_bps  > 5000 THEN
    RAISE EXCEPTION 'buyer_fee_bps out of range [0,5000]' USING ERRCODE = '22023';
  END IF;
  IF p_seller_fee_bps < 0 OR p_seller_fee_bps > 5000 THEN
    RAISE EXCEPTION 'seller_fee_bps out of range [0,5000]' USING ERRCODE = '22023';
  END IF;

  UPDATE marketplace_fee_config
     SET buyer_fee_bps  = p_buyer_fee_bps,
         seller_fee_bps = p_seller_fee_bps,
         notes          = COALESCE(p_notes, notes),
         updated_at     = now(),
         updated_by     = v_user
   WHERE payment_method = p_payment_method
   RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fee config row not found for %', p_payment_method
      USING ERRCODE = '02000';
  END IF;
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.marketplace_admin_update_fee_config FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.marketplace_admin_update_fee_config TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  View admin: tutti i bonifici in attesa
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW public.v_marketplace_pending_bank_transfers AS
SELECT
  o.id                  AS order_id,
  o.listing_id,
  o.buyer_user_id,
  o.seller_user_id,
  o.qty,
  o.subtotal_cents,
  o.buyer_fee_cents,
  o.total_cents,
  o.payment_provider_id AS bank_reference,
  o.created_at,
  o.expires_at,
  c.certificate_serial,
  c.token_id, c.chain_id,
  p.name                AS product_name,
  pb.email              AS buyer_email,
  ps.email              AS seller_email
FROM marketplace_orders o
JOIN chain_certificates c   ON c.id = o.certificate_id
LEFT JOIN inv_products p    ON p.id = c.product_id
LEFT JOIN auth.users pb     ON pb.id = o.buyer_user_id
LEFT JOIN auth.users ps     ON ps.id = o.seller_user_id
WHERE o.payment_method  = 'bank_transfer'
  AND o.payment_status  = 'pending'
ORDER BY o.created_at ASC;

REVOKE ALL ON public.v_marketplace_pending_bank_transfers FROM PUBLIC;
GRANT SELECT ON public.v_marketplace_pending_bank_transfers TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  View admin: ordini paid+settlement_pending (da settle on-chain)
-- ══════════════════════════════════════════════════════════════════════
-- Già creata in 031 come v_marketplace_orders_to_settle, ma quella è
-- service_role-only. Aggiungiamo una variante admin-readable arricchita.
CREATE OR REPLACE VIEW public.v_marketplace_admin_to_settle AS
SELECT
  o.id                  AS order_id,
  o.listing_id,
  o.payment_method, o.payment_status, o.settlement_status,
  o.qty, o.total_cents, o.payout_cents,
  o.payment_provider_id,
  o.paid_at, o.created_at,
  c.token_id, c.chain_id, c.contract_address,
  c.certificate_serial AS seller_serial,
  c.current_owner_wallet AS seller_wallet,
  p.name                AS product_name,
  pb.email              AS buyer_email,
  ps.email              AS seller_email
FROM marketplace_orders o
JOIN chain_certificates c   ON c.id = o.certificate_id
LEFT JOIN inv_products p    ON p.id = c.product_id
LEFT JOIN auth.users pb     ON pb.id = o.buyer_user_id
LEFT JOIN auth.users ps     ON ps.id = o.seller_user_id
WHERE o.payment_status     = 'paid'
  AND o.settlement_status  = 'pending';

REVOKE ALL ON public.v_marketplace_admin_to_settle FROM PUBLIC;
GRANT SELECT ON public.v_marketplace_admin_to_settle TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  RLS guard: ammettiamo SELECT sulle view solo agli admin
--  (le view non hanno RLS proprio, controlliamo con security_invoker)
-- ══════════════════════════════════════════════════════════════════════
ALTER VIEW public.v_marketplace_pending_bank_transfers SET (security_invoker = on);
ALTER VIEW public.v_marketplace_admin_to_settle        SET (security_invoker = on);

-- Aggiungiamo policy SELECT esplicite per admin sulla tabella ordini
-- (la 029 esisteva già "orders_select_admin", la riapplichiamo idempotente)
DROP POLICY IF EXISTS "orders_select_admin_v2" ON marketplace_orders;
CREATE POLICY "orders_select_admin_v2" ON marketplace_orders
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );


DO $$ BEGIN
  RAISE NOTICE '✔ marketplace_admin_mark_paid_bank RPC ready';
  RAISE NOTICE '✔ marketplace_admin_cancel_order RPC ready';
  RAISE NOTICE '✔ marketplace_admin_update_fee_config RPC ready';
  RAISE NOTICE '✔ v_marketplace_pending_bank_transfers view ready';
  RAISE NOTICE '✔ v_marketplace_admin_to_settle view ready';
END $$;
