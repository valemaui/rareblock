-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — F4 step 4.4: settlement on-chain (DB side)
--  Migration 031: marketplace_apply_settlement RPC (idempotente, atomic)
--
--  Quando il pagamento e' confermato e abbiamo il tx_hash di
--  custodialTransfer on-chain, questa funzione applica TUTTI gli
--  aggiornamenti DB in una singola transazione:
--
--   1) Seller cert: qty_minted -= order.qty (cert.status = 'transferred'
--      se qty_minted arriva a zero)
--   2) Crea un NUOVO chain_certificates row per il buyer con un NUOVO
--      certificate_serial e qty_minted = order.qty
--   3) Inserisce chain_transfers audit row
--   4) marketplace_listings.status = 'sold' + sold_at
--   5) marketplace_orders.settlement_status = 'transferred', settlement_tx_hash,
--      settlement_at
--
--  IDEMPOTENTE: una seconda chiamata con stesso order ritorna lo stesso
--  risultato senza fare double-transfer.
-- ═══════════════════════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════════════════
--  Aggiunta colonne audit aggiuntive (additive, idempotente)
--
--  parent_certificate_id su chain_certificates: linkage al cert sorgente
--    quando un transfer secondario "splitta" un cert in due.
--  marketplace_order_id su chain_transfers: FK al marketplace_orders.id
--    (al posto di abusare di inv_order_id che è destinato ai primary).
-- ══════════════════════════════════════════════════════════════════════
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'chain_certificates'
       AND column_name  = 'parent_certificate_id'
  ) THEN
    ALTER TABLE chain_certificates
      ADD COLUMN parent_certificate_id UUID REFERENCES chain_certificates(id) ON DELETE SET NULL;
    CREATE INDEX chain_certs_parent_idx ON chain_certificates(parent_certificate_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'chain_transfers'
       AND column_name  = 'marketplace_order_id'
  ) THEN
    ALTER TABLE chain_transfers
      ADD COLUMN marketplace_order_id UUID REFERENCES marketplace_orders(id) ON DELETE SET NULL;
    CREATE INDEX chain_xfers_mp_order_idx ON chain_transfers(marketplace_order_id);
  END IF;
END $$;


-- ══════════════════════════════════════════════════════════════════════
--  RPC: marketplace_apply_settlement
--
--  service-role only. Chiamata da Edge Function chain-transfer-secondary
--  DOPO che custodialTransfer on-chain è andata a buon fine.
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.marketplace_apply_settlement(
  p_order_id          UUID,
  p_tx_hash           TEXT,
  p_block_number      BIGINT,
  p_reason_hash       TEXT,
  p_buyer_wallet      TEXT,
  p_new_serial        TEXT,
  p_buyer_user_id     UUID DEFAULT NULL  -- override per scelte dell'orchestrator
) RETURNS TABLE(
  order_id            UUID,
  seller_cert_id      UUID,
  buyer_cert_id       UUID,
  transfer_id         UUID,
  was_idempotent      BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order        marketplace_orders%ROWTYPE;
  v_seller_cert  chain_certificates%ROWTYPE;
  v_buyer_cert   chain_certificates%ROWTYPE;
  v_transfer_id  UUID;
  v_seller_wallet TEXT;
  v_buyer_user   UUID;
BEGIN
  -- ─── Validate inputs ──────────────────────────────────────────────
  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'order_id required' USING ERRCODE = '22023';
  END IF;
  IF p_tx_hash IS NULL OR p_tx_hash !~ '^0x[a-fA-F0-9]{64}$' THEN
    RAISE EXCEPTION 'invalid tx_hash format' USING ERRCODE = '22023';
  END IF;
  IF p_buyer_wallet IS NULL OR p_buyer_wallet !~ '^0x[a-fA-F0-9]{40}$' THEN
    RAISE EXCEPTION 'invalid buyer_wallet format' USING ERRCODE = '22023';
  END IF;
  IF p_new_serial IS NULL OR length(trim(p_new_serial)) = 0 THEN
    RAISE EXCEPTION 'new_serial required' USING ERRCODE = '22023';
  END IF;

  -- ─── Lock order ───────────────────────────────────────────────────
  SELECT * INTO v_order FROM marketplace_orders
   WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found' USING ERRCODE = '02000';
  END IF;

  -- ─── Idempotency: already transferred? Return existing data ───────
  IF v_order.settlement_status = 'transferred' THEN
    SELECT id INTO v_transfer_id FROM chain_transfers
     WHERE marketplace_order_id = p_order_id AND transfer_type = 'secondary_sale'
     ORDER BY created_at DESC LIMIT 1;
    SELECT * INTO v_seller_cert FROM chain_certificates
     WHERE id = v_order.certificate_id;
    -- Buyer cert: la cerchiamo come ultima cert ricevuta dal buyer per quest'ordine
    SELECT cc.* INTO v_buyer_cert FROM chain_certificates cc
     JOIN chain_transfers ct ON ct.certificate_id = cc.id
     WHERE ct.marketplace_order_id = p_order_id
       AND ct.to_user_id   = v_order.buyer_user_id
     ORDER BY ct.created_at DESC LIMIT 1;

    RETURN QUERY SELECT v_order.id, v_seller_cert.id, v_buyer_cert.id,
                        v_transfer_id, TRUE;
    RETURN;
  END IF;

  -- ─── Pre-check stato ordine ─────────────────────────────────────────
  IF v_order.payment_status NOT IN ('paid','authorized') THEN
    RAISE EXCEPTION 'order is not paid yet (payment_status=%)', v_order.payment_status
      USING ERRCODE = '22023';
  END IF;
  IF v_order.settlement_status NOT IN ('pending') THEN
    RAISE EXCEPTION 'order settlement is in unexpected state (%)', v_order.settlement_status
      USING ERRCODE = '22023';
  END IF;

  -- ─── Lock seller cert ─────────────────────────────────────────────
  SELECT * INTO v_seller_cert FROM chain_certificates
   WHERE id = v_order.certificate_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'seller certificate not found' USING ERRCODE = '02000';
  END IF;
  IF v_seller_cert.current_owner_user_id <> v_order.seller_user_id THEN
    RAISE EXCEPTION 'seller no longer owns this certificate (current owner mismatch)'
      USING ERRCODE = '22023';
  END IF;
  IF v_seller_cert.qty_minted < v_order.qty THEN
    RAISE EXCEPTION 'seller cert qty (%) < order qty (%)',
      v_seller_cert.qty_minted, v_order.qty USING ERRCODE = '22023';
  END IF;

  v_seller_wallet := v_seller_cert.current_owner_wallet;
  v_buyer_user    := COALESCE(p_buyer_user_id, v_order.buyer_user_id);

  -- ─── 1) Seller cert: scala qty ─────────────────────────────────────
  IF v_seller_cert.qty_minted = v_order.qty THEN
    -- Tutta la quantità trasferita: cert seller diventa 'transferred'
    UPDATE chain_certificates
       SET qty_minted = 0,
           status     = 'transferred',
           updated_at = now()
     WHERE id = v_seller_cert.id;
  ELSE
    -- Split parziale: scala qty_minted, status resta 'minted'
    UPDATE chain_certificates
       SET qty_minted = qty_minted - v_order.qty,
           updated_at = now()
     WHERE id = v_seller_cert.id;
  END IF;

  -- ─── 2) Crea NUOVO cert per il buyer ───────────────────────────────
  -- Stesso token_id (è lo stesso ERC-1155 id), ma id e serial nuovi.
  INSERT INTO chain_certificates (
    product_id,
    current_owner_user_id, current_owner_wallet,
    qty_minted, status,
    certificate_serial, token_id,
    chain_id, contract_address,
    minted_at,
    -- I campi opzionali (pdf_url, ipfs_metadata_uri, etc) li lasciamo NULL
    -- per ora; l'orchestrator settlement potrà popolarli con un PDF rigenerato
    -- se necessario (TODO 4.5+).
    parent_certificate_id  -- audit link al cert sorgente
  ) VALUES (
    v_seller_cert.product_id,
    v_buyer_user, p_buyer_wallet,
    v_order.qty, 'minted',
    p_new_serial, v_seller_cert.token_id,
    v_seller_cert.chain_id, v_seller_cert.contract_address,
    now(),
    v_seller_cert.id
  )
  RETURNING * INTO v_buyer_cert;

  -- ─── 3) Audit row in chain_transfers ───────────────────────────────
  INSERT INTO chain_transfers (
    certificate_id,
    from_user_id, to_user_id,
    from_wallet, to_wallet,
    qty,
    transfer_type,
    tx_hash, block_number, reason_hash,
    marketplace_order_id,
    notes
  ) VALUES (
    v_buyer_cert.id,                  -- attribuito al cert nuovo (vista buyer)
    v_order.seller_user_id, v_buyer_user,
    v_seller_wallet, p_buyer_wallet,
    v_order.qty,
    'secondary_sale',
    p_tx_hash, p_block_number, p_reason_hash,
    p_order_id,
    'Marketplace P2P settlement'
  )
  RETURNING id INTO v_transfer_id;

  -- ─── 4) Listing → sold ──────────────────────────────────────────────
  UPDATE marketplace_listings
     SET status         = 'sold',
         sold_at        = now(),
         reserved_until = NULL,
         updated_at     = now()
   WHERE id = v_order.listing_id;

  -- ─── 5) Order → transferred ────────────────────────────────────────
  UPDATE marketplace_orders
     SET settlement_status   = 'transferred',
         settlement_tx_hash  = p_tx_hash,
         settlement_at       = now(),
         updated_at          = now()
   WHERE id = p_order_id;

  RETURN QUERY SELECT v_order.id, v_seller_cert.id, v_buyer_cert.id,
                      v_transfer_id, FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.marketplace_apply_settlement FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.marketplace_apply_settlement TO service_role;


-- ══════════════════════════════════════════════════════════════════════
--  RPC: marketplace_mark_payment_paid
--
--  service-role only. Chiamata da:
--   - Stripe webhook handler (4.5)   quando arriva payment_intent.succeeded
--   - PayPal capture                 quando captureOrder ha esito ok
--   - Admin manual                   quando bonifico è arrivato in banca
--
--  Idempotente: già 'paid' → no-op.
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.marketplace_mark_payment_paid(
  p_order_id           UUID,
  p_payment_provider_id TEXT DEFAULT NULL
) RETURNS marketplace_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order marketplace_orders%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM marketplace_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found' USING ERRCODE = '02000';
  END IF;
  -- Idempotency
  IF v_order.payment_status = 'paid' THEN
    RETURN v_order;
  END IF;
  IF v_order.payment_status NOT IN ('pending','authorized') THEN
    RAISE EXCEPTION 'order in unexpected payment_status: %', v_order.payment_status
      USING ERRCODE = '22023';
  END IF;
  UPDATE marketplace_orders
     SET payment_status     = 'paid',
         paid_at            = now(),
         payment_provider_id = COALESCE(p_payment_provider_id, payment_provider_id),
         updated_at         = now()
   WHERE id = p_order_id
   RETURNING * INTO v_order;
  RETURN v_order;
END;
$$;
REVOKE ALL ON FUNCTION public.marketplace_mark_payment_paid FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.marketplace_mark_payment_paid TO service_role;


-- ══════════════════════════════════════════════════════════════════════
--  View: marketplace_orders_to_settle
--  (per Edge Function di settlement / admin dashboard)
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW public.v_marketplace_orders_to_settle AS
SELECT
  o.id                  AS order_id,
  o.listing_id,
  o.certificate_id,
  o.buyer_user_id, o.seller_user_id,
  o.qty,
  o.payment_method, o.payment_status,
  o.settlement_status,
  o.payment_provider_id,
  o.paid_at, o.created_at,
  c.token_id, c.chain_id, c.contract_address, c.certificate_serial AS seller_serial,
  c.current_owner_wallet AS seller_wallet
FROM marketplace_orders o
JOIN chain_certificates c ON c.id = o.certificate_id
WHERE o.payment_status     = 'paid'
  AND o.settlement_status  = 'pending';

REVOKE ALL ON public.v_marketplace_orders_to_settle FROM PUBLIC;
GRANT SELECT ON public.v_marketplace_orders_to_settle TO service_role;


DO $$ BEGIN
  RAISE NOTICE '✔ marketplace_apply_settlement RPC ready';
  RAISE NOTICE '✔ marketplace_mark_payment_paid RPC ready';
  RAISE NOTICE '✔ v_marketplace_orders_to_settle view ready';
  RAISE NOTICE '✔ chain_certificates.parent_certificate_id column ready';
END $$;
