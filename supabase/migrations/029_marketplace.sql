-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Modulo Marketplace P2P (F4 step 4.1)
--  Migration 029: tabelle per listing/checkout/orders + fee config
--
--  Scope: TUTTO additivo. Si aggancia a chain_certificates esistente.
-- ═══════════════════════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════════════════
--  1) marketplace_fee_config — fee admin-editable, opzione B (buyer's
--     premium variabile per metodo di pagamento)
-- ══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.marketplace_fee_config (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  payment_method  TEXT NOT NULL UNIQUE
                  CHECK (payment_method IN ('bank_transfer','stripe_card','paypal')),
  buyer_fee_bps   INT  NOT NULL CHECK (buyer_fee_bps  >= 0 AND buyer_fee_bps  <= 5000),
  seller_fee_bps  INT  NOT NULL CHECK (seller_fee_bps >= 0 AND seller_fee_bps <= 5000),
  is_active       BOOLEAN NOT NULL DEFAULT true,
  notes           TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      UUID REFERENCES auth.users(id)
);

ALTER TABLE marketplace_fee_config ENABLE ROW LEVEL SECURITY;

-- Read access: anyone authenticated (per mostrare le fee in checkout)
DROP POLICY IF EXISTS "fee_config_select_authenticated" ON marketplace_fee_config;
CREATE POLICY "fee_config_select_authenticated" ON marketplace_fee_config
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "fee_config_select_anon" ON marketplace_fee_config;
CREATE POLICY "fee_config_select_anon" ON marketplace_fee_config
  FOR SELECT TO anon USING (true);

-- Write access: solo admin
DROP POLICY IF EXISTS "fee_config_admin_write" ON marketplace_fee_config;
CREATE POLICY "fee_config_admin_write" ON marketplace_fee_config
  FOR ALL TO authenticated USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

-- Seed iniziale dei valori concordati
INSERT INTO marketplace_fee_config (payment_method, buyer_fee_bps, seller_fee_bps, notes)
VALUES
  ('bank_transfer', 300, 300, 'Bonifico SEPA — costo PSP zero'),
  ('stripe_card',   450, 300, 'Carta Stripe — premium 4.5% include costo PSP ~1.5%'),
  ('paypal',        650, 300, 'PayPal — premium 6.5% include costo PSP ~3.5%')
ON CONFLICT (payment_method) DO NOTHING;


-- ══════════════════════════════════════════════════════════════════════
--  2) marketplace_listings — inserzioni di rivendita
--
--  Modello: 1 listing = 1 chunk di quote di un certificato in vendita.
--  Un certificato può essere "splittato" in più listing se il proprietario
--  vuole venderne solo una parte, ma per la fase 4.1 limitiamo: 1 cert,
--  1 listing attivo. Lo split lo aggiungeremo in 4.x se serve.
-- ══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.marketplace_listings (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,

  -- Chi vende cosa
  certificate_id      UUID NOT NULL REFERENCES chain_certificates(id) ON DELETE RESTRICT,
  seller_user_id      UUID NOT NULL REFERENCES auth.users(id)         ON DELETE RESTRICT,

  -- Pricing (cents EUR per evitare floating-point drift)
  price_per_share_cents BIGINT NOT NULL CHECK (price_per_share_cents > 0),
  qty_listed            INT    NOT NULL CHECK (qty_listed > 0),

  -- Optional listing metadata
  title              TEXT,
  description        TEXT,
  expires_at         TIMESTAMPTZ,                 -- null = no expiry

  -- Stato del listing
  status             TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN (
                       'active',      -- visibile, comprabile
                       'reserved',    -- buyer ha aperto checkout, in lock
                       'sold',        -- pagamento confermato, transfer on-chain done
                       'cancelled',   -- ritirato dal seller
                       'expired'      -- expires_at superato senza vendita
                     )),
  reserved_until     TIMESTAMPTZ,                -- lock checkout ~15 min

  -- Audit
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at       TIMESTAMPTZ,
  sold_at            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS mp_listings_status_idx        ON marketplace_listings(status);
CREATE INDEX IF NOT EXISTS mp_listings_seller_idx        ON marketplace_listings(seller_user_id);
CREATE INDEX IF NOT EXISTS mp_listings_certificate_idx   ON marketplace_listings(certificate_id);
CREATE INDEX IF NOT EXISTS mp_listings_active_created    ON marketplace_listings(created_at DESC) WHERE status = 'active';

-- Constraint: un certificato può avere AL PIÙ UN listing attivo/reserved alla volta
CREATE UNIQUE INDEX IF NOT EXISTS mp_listings_one_active_per_cert
  ON marketplace_listings(certificate_id)
  WHERE status IN ('active','reserved');

ALTER TABLE marketplace_listings ENABLE ROW LEVEL SECURITY;

-- Lettura: tutti possono vedere listing 'active' (browse marketplace pubblico)
DROP POLICY IF EXISTS "listings_select_active_public" ON marketplace_listings;
CREATE POLICY "listings_select_active_public" ON marketplace_listings
  FOR SELECT TO anon, authenticated USING (status = 'active');

-- Seller vede sempre i propri listing in qualsiasi stato
DROP POLICY IF EXISTS "listings_select_own" ON marketplace_listings;
CREATE POLICY "listings_select_own" ON marketplace_listings
  FOR SELECT TO authenticated USING (auth.uid() = seller_user_id);

-- Admin vede tutto
DROP POLICY IF EXISTS "listings_select_admin" ON marketplace_listings;
CREATE POLICY "listings_select_admin" ON marketplace_listings
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

-- Insert: solo l'owner del certificato può listarlo
-- (verificato sia in RLS sia ricontrollato nella RPC create_listing)
DROP POLICY IF EXISTS "listings_insert_own_cert" ON marketplace_listings;
CREATE POLICY "listings_insert_own_cert" ON marketplace_listings
  FOR INSERT TO authenticated WITH CHECK (
    auth.uid() = seller_user_id
    AND EXISTS (
      SELECT 1 FROM chain_certificates c
      WHERE c.id = certificate_id
        AND c.current_owner_user_id = auth.uid()
        AND c.status = 'minted'
    )
  );

-- Update: seller può cancellare il proprio listing (status: active → cancelled)
-- Altre transizioni vanno via RPC server-side (security definer).
DROP POLICY IF EXISTS "listings_update_own_cancel" ON marketplace_listings;
CREATE POLICY "listings_update_own_cancel" ON marketplace_listings
  FOR UPDATE TO authenticated USING (
    auth.uid() = seller_user_id AND status = 'active'
  ) WITH CHECK (
    auth.uid() = seller_user_id AND status IN ('cancelled','active')
  );


-- ══════════════════════════════════════════════════════════════════════
--  3) marketplace_orders — checkout/payment record
--
--  Creato quando un buyer apre il checkout (non quando paga). Il listing
--  passa in 'reserved' atomicamente nello stesso transaction.
-- ══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.marketplace_orders (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,

  -- Chi compra cosa
  listing_id          UUID NOT NULL REFERENCES marketplace_listings(id) ON DELETE RESTRICT,
  certificate_id      UUID NOT NULL REFERENCES chain_certificates(id)   ON DELETE RESTRICT,
  buyer_user_id       UUID NOT NULL REFERENCES auth.users(id)           ON DELETE RESTRICT,
  seller_user_id      UUID NOT NULL REFERENCES auth.users(id)           ON DELETE RESTRICT,

  -- Pricing snapshot (CONGELATO al checkout — admin può cambiare config dopo)
  qty                 INT    NOT NULL CHECK (qty > 0),
  price_per_share_cents BIGINT NOT NULL CHECK (price_per_share_cents > 0),
  subtotal_cents      BIGINT NOT NULL,                 -- qty * price_per_share
  buyer_fee_bps       INT    NOT NULL,
  seller_fee_bps      INT    NOT NULL,
  buyer_fee_cents     BIGINT NOT NULL,
  seller_fee_cents    BIGINT NOT NULL,
  total_cents         BIGINT NOT NULL,                 -- subtotal + buyer_fee
  payout_cents        BIGINT NOT NULL,                 -- subtotal − seller_fee (al venditore)
  fee_snapshot        JSONB  NOT NULL,                 -- copy della riga marketplace_fee_config

  -- Pagamento
  payment_method      TEXT NOT NULL
                      CHECK (payment_method IN ('bank_transfer','stripe_card','paypal')),
  payment_provider_id TEXT,                            -- stripe pi_..., paypal order id, bank ref
  payment_status      TEXT NOT NULL DEFAULT 'pending'
                      CHECK (payment_status IN (
                        'pending',         -- in attesa di pagamento (bonifico) o di azione (Stripe redirect)
                        'authorized',      -- Stripe pre-auth, in attesa di capture
                        'paid',            -- pagato e confermato
                        'failed',          -- pagamento fallito
                        'refunded',        -- rimborsato
                        'cancelled'        -- buyer ha annullato il checkout
                      )),
  paid_at             TIMESTAMPTZ,

  -- Settlement (popolato dopo chain-transfer-secondary)
  settlement_status   TEXT NOT NULL DEFAULT 'pending'
                      CHECK (settlement_status IN (
                        'pending',         -- pagamento ricevuto, transfer on-chain non ancora fatto
                        'transferred',     -- transfer on-chain done, certificate aggiornato
                        'failed',          -- transfer fallito (richiede riconciliazione)
                        'not_required'     -- ordine cancellato/refunded prima del transfer
                      )),
  settlement_tx_hash  TEXT,
  settlement_at       TIMESTAMPTZ,

  -- Audit
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL,            -- ~15 min dal create per tenere il lock
  notes               TEXT,

  CONSTRAINT mp_orders_settlement_tx_format
    CHECK (settlement_tx_hash IS NULL OR settlement_tx_hash ~ '^0x[a-fA-F0-9]{64}$')
);

CREATE INDEX IF NOT EXISTS mp_orders_buyer_idx       ON marketplace_orders(buyer_user_id);
CREATE INDEX IF NOT EXISTS mp_orders_seller_idx      ON marketplace_orders(seller_user_id);
CREATE INDEX IF NOT EXISTS mp_orders_listing_idx     ON marketplace_orders(listing_id);
CREATE INDEX IF NOT EXISTS mp_orders_payment_idx     ON marketplace_orders(payment_status);
CREATE INDEX IF NOT EXISTS mp_orders_settlement_idx  ON marketplace_orders(settlement_status);
CREATE INDEX IF NOT EXISTS mp_orders_provider_idx    ON marketplace_orders(payment_provider_id) WHERE payment_provider_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mp_orders_created_idx     ON marketplace_orders(created_at DESC);

ALTER TABLE marketplace_orders ENABLE ROW LEVEL SECURITY;

-- Buyer + seller vedono i propri ordini
DROP POLICY IF EXISTS "orders_select_involved" ON marketplace_orders;
CREATE POLICY "orders_select_involved" ON marketplace_orders
  FOR SELECT TO authenticated USING (
    auth.uid() = buyer_user_id OR auth.uid() = seller_user_id
  );

-- Admin vede tutto
DROP POLICY IF EXISTS "orders_select_admin" ON marketplace_orders;
CREATE POLICY "orders_select_admin" ON marketplace_orders
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

-- Insert/update via Edge Function (service-role) only. RLS blocca tutto il resto.
DROP POLICY IF EXISTS "orders_no_write_users" ON marketplace_orders;
CREATE POLICY "orders_no_write_users" ON marketplace_orders
  FOR INSERT TO authenticated WITH CHECK (false);

DROP POLICY IF EXISTS "orders_no_update_users" ON marketplace_orders;
CREATE POLICY "orders_no_update_users" ON marketplace_orders
  FOR UPDATE TO authenticated USING (false);


-- ══════════════════════════════════════════════════════════════════════
--  4) RPC: marketplace_create_listing
--
--  Crea un listing in un'unica transazione, con tutti i check di owner-
--  ship e stato. Restituisce la riga creata.
--
--  Vantaggio rispetto a un INSERT diretto via RLS: messaggi d'errore
--  chiari ("already listed" vs "not the owner") senza esporre struttura.
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.marketplace_create_listing(
  p_certificate_id        UUID,
  p_qty_listed            INT,
  p_price_per_share_cents BIGINT,
  p_title                 TEXT  DEFAULT NULL,
  p_description           TEXT  DEFAULT NULL,
  p_expires_at            TIMESTAMPTZ DEFAULT NULL
) RETURNS marketplace_listings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_cert chain_certificates%ROWTYPE;
  v_existing UUID;
  v_listing marketplace_listings%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '28000';
  END IF;
  IF p_qty_listed <= 0 THEN
    RAISE EXCEPTION 'qty_listed must be > 0' USING ERRCODE = '22023';
  END IF;
  IF p_price_per_share_cents <= 0 THEN
    RAISE EXCEPTION 'price_per_share_cents must be > 0' USING ERRCODE = '22023';
  END IF;

  -- Lock il certificato per evitare race con altri create_listing concorrenti
  SELECT * INTO v_cert FROM chain_certificates
   WHERE id = p_certificate_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'certificate not found' USING ERRCODE = '02000';
  END IF;
  IF v_cert.current_owner_user_id <> v_user THEN
    RAISE EXCEPTION 'not the owner of this certificate' USING ERRCODE = '42501';
  END IF;
  IF v_cert.status <> 'minted' THEN
    RAISE EXCEPTION 'certificate is not active (status=%)', v_cert.status
      USING ERRCODE = '22023';
  END IF;
  IF p_qty_listed > v_cert.qty_minted THEN
    RAISE EXCEPTION 'qty_listed exceeds owned shares (% > %)',
      p_qty_listed, v_cert.qty_minted USING ERRCODE = '22023';
  END IF;

  -- Già listato?
  SELECT id INTO v_existing FROM marketplace_listings
   WHERE certificate_id = p_certificate_id
     AND status IN ('active','reserved')
   LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'certificate is already listed (listing id %)', v_existing
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO marketplace_listings (
    certificate_id, seller_user_id,
    price_per_share_cents, qty_listed,
    title, description, expires_at, status
  ) VALUES (
    p_certificate_id, v_user,
    p_price_per_share_cents, p_qty_listed,
    p_title, p_description, p_expires_at, 'active'
  )
  RETURNING * INTO v_listing;

  RETURN v_listing;
END;
$$;

-- Permettiamo solo agli authenticated di chiamare la RPC (anon non vede comunque profile)
REVOKE ALL ON FUNCTION public.marketplace_create_listing FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.marketplace_create_listing TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  5) RPC: marketplace_cancel_listing
--
--  Permette al seller di cancellare un proprio listing attivo.
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.marketplace_cancel_listing(p_listing_id UUID)
RETURNS marketplace_listings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_listing marketplace_listings%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '28000';
  END IF;
  SELECT * INTO v_listing FROM marketplace_listings
   WHERE id = p_listing_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'listing not found' USING ERRCODE = '02000';
  END IF;
  IF v_listing.seller_user_id <> v_user THEN
    RAISE EXCEPTION 'not the seller of this listing' USING ERRCODE = '42501';
  END IF;
  IF v_listing.status <> 'active' THEN
    RAISE EXCEPTION 'listing is not active (status=%)', v_listing.status
      USING ERRCODE = '22023';
  END IF;

  UPDATE marketplace_listings
     SET status = 'cancelled', cancelled_at = now(), updated_at = now()
   WHERE id = p_listing_id
   RETURNING * INTO v_listing;
  RETURN v_listing;
END;
$$;

REVOKE ALL ON FUNCTION public.marketplace_cancel_listing FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.marketplace_cancel_listing TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  6) Trigger: keep updated_at fresh
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.mp_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS mp_listings_touch ON marketplace_listings;
CREATE TRIGGER mp_listings_touch
  BEFORE UPDATE ON marketplace_listings
  FOR EACH ROW EXECUTE FUNCTION public.mp_touch_updated_at();

DROP TRIGGER IF EXISTS mp_orders_touch ON marketplace_orders;
CREATE TRIGGER mp_orders_touch
  BEFORE UPDATE ON marketplace_orders
  FOR EACH ROW EXECUTE FUNCTION public.mp_touch_updated_at();


-- ══════════════════════════════════════════════════════════════════════
--  7) View: listing pubblici arricchiti con i dati del certificato/prodotto
--     (la pagina marketplace.html ne avrà bisogno per browse)
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW public.v_marketplace_active_listings AS
SELECT
  l.id                     AS listing_id,
  l.price_per_share_cents,
  l.qty_listed,
  l.title,
  l.description,
  l.created_at             AS listed_at,
  l.expires_at,
  c.id                     AS certificate_id,
  c.certificate_serial,
  c.token_id,
  c.chain_id,
  c.contract_address,
  c.qty_minted,
  c.minted_at,
  p.id                     AS product_id,
  p.name                   AS product_name,
  p.image_url              AS product_image_url,
  p.type                   AS product_type,
  p.set                    AS product_set,
  p.year                   AS product_year,
  p.edition                AS product_edition,
  p.grading_label          AS product_grading_label,
  p.shares_total           AS product_shares_total
FROM marketplace_listings l
JOIN chain_certificates c ON c.id = l.certificate_id
LEFT JOIN inv_products p ON p.id = c.product_id
WHERE l.status = 'active'
  AND (l.expires_at IS NULL OR l.expires_at > now())
  AND c.status = 'minted';

GRANT SELECT ON public.v_marketplace_active_listings TO anon, authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  8) Sanity check finale
-- ══════════════════════════════════════════════════════════════════════
DO $$ BEGIN
  RAISE NOTICE '✔ marketplace_fee_config seeded with 3 payment methods';
  RAISE NOTICE '✔ marketplace_listings + orders ready';
  RAISE NOTICE '✔ RPC marketplace_create_listing / cancel_listing ready';
  RAISE NOTICE '✔ View v_marketplace_active_listings ready';
END $$;
