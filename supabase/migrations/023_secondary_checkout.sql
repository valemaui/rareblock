-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Checkout vendita peer-to-peer (mercato secondario)
--  Estende inv_transfers con campi di workflow e RPC atomiche.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Colonne workflow checkout ─────────────────────────────────────
ALTER TABLE public.inv_transfers
  ADD COLUMN IF NOT EXISTS buyer_payment_ref  TEXT,
  ADD COLUMN IF NOT EXISTS buyer_notes        TEXT,
  ADD COLUMN IF NOT EXISTS admin_notes        TEXT,
  ADD COLUMN IF NOT EXISTS reserved_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payment_due_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paid_at            TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS inv_transfers_buyer_idx ON public.inv_transfers(buyer_id);

-- ── 2. RPC: reserve_transfer — buyer prenota un'offerta atomicamente ─
-- Previene race condition: due buyer non possono prenotare la stessa offerta.
CREATE OR REPLACE FUNCTION public.reserve_transfer(
  p_transfer_id UUID,
  p_payment_due_hours INT DEFAULT 48
) RETURNS public.inv_transfers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID;
  v_row public.inv_transfers;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sessione richiesta';
  END IF;

  -- Lock e verifica stato
  SELECT * INTO v_row
  FROM public.inv_transfers
  WHERE id = p_transfer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Offerta non trovata';
  END IF;

  IF v_row.status <> 'open' THEN
    RAISE EXCEPTION 'Offerta non più disponibile (stato: %)', v_row.status;
  END IF;

  IF v_row.seller_id = v_uid THEN
    RAISE EXCEPTION 'Non puoi acquistare la tua stessa offerta';
  END IF;

  IF v_row.expires_at IS NOT NULL AND v_row.expires_at < CURRENT_DATE THEN
    RAISE EXCEPTION 'Offerta scaduta';
  END IF;

  -- Reserve
  UPDATE public.inv_transfers
     SET status = 'reserved',
         buyer_id = v_uid,
         reserved_at = now(),
         payment_due_at = now() + (p_payment_due_hours || ' hours')::interval
   WHERE id = p_transfer_id
   RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reserve_transfer(UUID, INT) TO authenticated;

-- ── 3. RPC: submit_transfer_payment — buyer dichiara pagamento eseguito ─
CREATE OR REPLACE FUNCTION public.submit_transfer_payment(
  p_transfer_id UUID,
  p_payment_ref TEXT,
  p_buyer_notes TEXT DEFAULT NULL
) RETURNS public.inv_transfers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID;
  v_row public.inv_transfers;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Sessione richiesta'; END IF;

  SELECT * INTO v_row FROM public.inv_transfers WHERE id = p_transfer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Offerta non trovata'; END IF;

  IF v_row.buyer_id <> v_uid AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Non autorizzato';
  END IF;

  IF v_row.status NOT IN ('reserved','payment_pending') THEN
    RAISE EXCEPTION 'Stato non valido per submit pagamento (%)', v_row.status;
  END IF;

  UPDATE public.inv_transfers
     SET status = 'payment_pending',
         buyer_payment_ref = p_payment_ref,
         buyer_notes = COALESCE(p_buyer_notes, buyer_notes)
   WHERE id = p_transfer_id
   RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_transfer_payment(UUID, TEXT, TEXT) TO authenticated;

-- ── 4. RPC: complete_transfer — admin chiude e trasferisce le quote ───
-- Esegue: decrement seller holding, increment/create buyer holding,
-- chiude transfer come completed, crea record payment.
CREATE OR REPLACE FUNCTION public.complete_transfer(
  p_transfer_id UUID,
  p_admin_notes TEXT DEFAULT NULL
) RETURNS public.inv_transfers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_t public.inv_transfers;
  v_seller_h RECORD;
  v_buyer_holding_id UUID;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo admin può completare un trasferimento';
  END IF;

  SELECT * INTO v_t FROM public.inv_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Offerta non trovata'; END IF;

  IF v_t.status <> 'payment_pending' THEN
    RAISE EXCEPTION 'Trasferimento non è in stato payment_pending (è %)', v_t.status;
  END IF;
  IF v_t.buyer_id IS NULL THEN
    RAISE EXCEPTION 'Buyer non assegnato';
  END IF;

  -- Verifica seller holding sufficiente
  SELECT id, qty INTO v_seller_h
  FROM public.inv_holdings
  WHERE user_id = v_t.seller_id AND product_id = v_t.product_id
  ORDER BY acquired_at ASC
  LIMIT 1;

  IF NOT FOUND OR v_seller_h.qty < v_t.qty THEN
    RAISE EXCEPTION 'Seller non ha abbastanza quote per completare';
  END IF;

  -- Decrement (o delete se va a 0)
  IF v_seller_h.qty = v_t.qty THEN
    DELETE FROM public.inv_holdings WHERE id = v_seller_h.id;
  ELSE
    UPDATE public.inv_holdings
       SET qty = qty - v_t.qty
     WHERE id = v_seller_h.id;
  END IF;

  -- Crea/aggiorna buyer holding
  SELECT id INTO v_buyer_holding_id
  FROM public.inv_holdings
  WHERE user_id = v_t.buyer_id AND product_id = v_t.product_id
  LIMIT 1;

  IF v_buyer_holding_id IS NOT NULL THEN
    UPDATE public.inv_holdings
       SET qty = qty + v_t.qty
     WHERE id = v_buyer_holding_id;
  ELSE
    INSERT INTO public.inv_holdings(product_id, user_id, qty, price_per_quote, origin, notes)
    VALUES (v_t.product_id, v_t.buyer_id, v_t.qty, v_t.ask_price, 'secondary',
            'Acquistato sul mercato secondario (transfer ' || v_t.id::text || ')');
  END IF;

  -- Record payment buyer (ricevuto da admin)
  INSERT INTO public.inv_payments(user_id, product_id, type, amount, qty, method, status, bank_reference, admin_notes)
  VALUES (v_t.buyer_id, v_t.product_id, 'purchase',
          v_t.qty * v_t.ask_price, v_t.qty, 'bonifico', 'confirmed',
          v_t.buyer_payment_ref,
          'Mercato secondario · Transfer ' || v_t.id::text);

  -- Chiudi transfer
  UPDATE public.inv_transfers
     SET status = 'completed',
         completed_at = now(),
         paid_at = COALESCE(paid_at, now()),
         admin_notes = COALESCE(p_admin_notes, admin_notes)
   WHERE id = p_transfer_id
   RETURNING * INTO v_t;

  RETURN v_t;
END;
$$;

GRANT EXECUTE ON FUNCTION public.complete_transfer(UUID, TEXT) TO authenticated;

-- ── 5. RPC: cancel_reservation — buyer rinuncia o admin annulla ─────
CREATE OR REPLACE FUNCTION public.cancel_reservation(
  p_transfer_id UUID,
  p_reason TEXT DEFAULT NULL
) RETURNS public.inv_transfers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID;
  v_row public.inv_transfers;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Sessione richiesta'; END IF;

  SELECT * INTO v_row FROM public.inv_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Offerta non trovata'; END IF;

  -- Solo buyer, seller o admin possono cancellare
  IF v_row.buyer_id <> v_uid AND v_row.seller_id <> v_uid AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Non autorizzato';
  END IF;

  IF v_row.status NOT IN ('reserved','payment_pending') THEN
    RAISE EXCEPTION 'Solo prenotazioni attive possono essere cancellate (stato attuale: %)', v_row.status;
  END IF;

  -- Reset a open (l'offerta torna disponibile)
  UPDATE public.inv_transfers
     SET status = 'open',
         buyer_id = NULL,
         reserved_at = NULL,
         payment_due_at = NULL,
         buyer_payment_ref = NULL,
         buyer_notes = NULL,
         admin_notes = COALESCE(p_reason, admin_notes)
   WHERE id = p_transfer_id
   RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_reservation(UUID, TEXT) TO authenticated;

-- ── 6. Auto-expire reservations: prenotazioni scadute tornano open ───
CREATE OR REPLACE FUNCTION public.expire_stale_reservations()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE n INT;
BEGIN
  UPDATE public.inv_transfers
     SET status = 'open',
         buyer_id = NULL,
         reserved_at = NULL,
         payment_due_at = NULL,
         admin_notes = COALESCE(admin_notes,'') || ' [auto-expired ' || now() || ']'
   WHERE status = 'reserved'
     AND payment_due_at IS NOT NULL
     AND payment_due_at < now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.expire_stale_reservations() TO authenticated;

-- ── 7. Policy update: buyer può fare update sulla sua prenotazione ───
DROP POLICY IF EXISTS "inv_transfers_update_buyer" ON public.inv_transfers;
CREATE POLICY "inv_transfers_update_buyer" ON public.inv_transfers
  FOR UPDATE USING (auth.uid() = buyer_id)
  WITH CHECK (auth.uid() = buyer_id);

NOTIFY pgrst, 'reload schema';
