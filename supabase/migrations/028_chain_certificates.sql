-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Modulo Chain (NFT Certificates)
--  Migration 028: tabelle per certificati blockchain ERC-1155 su Base
--
--  Scope: TUTTO additivo. Non tocca nessuna tabella esistente.
--  Aggancio: chain_certificates.holding_id → inv_holdings.id (1:1)
--
--  Esegui nel Supabase SQL Editor (in ordine, una volta sola).
-- ═══════════════════════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════════════════
--  1) chain_wallets — wallet custodial per ogni utente
-- ══════════════════════════════════════════════════════════════════════
-- Modello: ogni utente ha esattamente 1 wallet on-chain (custodial).
-- La chiave privata NON è qui — è derivata in Supabase Vault da una HD
-- master seed con BIP32 path m/44'/60'/0'/0/{derivation_index}.
-- In DB salviamo solo l'indirizzo pubblico e il derivation_index.

CREATE TABLE IF NOT EXISTS public.chain_wallets (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id             UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  address             TEXT NOT NULL UNIQUE,           -- 0x... checksum
  derivation_index    INT  NOT NULL UNIQUE,           -- BIP32 path index
  chain_id            INT  NOT NULL DEFAULT 8453,     -- Base mainnet (84532=sepolia)
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chain_wallets_address_format CHECK (address ~ '^0x[a-fA-F0-9]{40}$')
);

CREATE INDEX IF NOT EXISTS chain_wallets_user_idx    ON chain_wallets(user_id);
CREATE INDEX IF NOT EXISTS chain_wallets_address_idx ON chain_wallets(address);

ALTER TABLE chain_wallets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "chain_wallets_select_own" ON chain_wallets;
CREATE POLICY "chain_wallets_select_own" ON chain_wallets
  FOR SELECT USING (auth.uid() = user_id);

-- Insert/update solo via SECURITY DEFINER function (server-side)
DROP POLICY IF EXISTS "chain_wallets_no_write" ON chain_wallets;
CREATE POLICY "chain_wallets_no_write" ON chain_wallets
  FOR INSERT WITH CHECK (false);


-- ══════════════════════════════════════════════════════════════════════
--  2) Sequence per i serial pubblici (RB-YYYY-NNNNNN)
-- ══════════════════════════════════════════════════════════════════════
CREATE SEQUENCE IF NOT EXISTS chain_certificate_serial_seq START 1;


-- ══════════════════════════════════════════════════════════════════════
--  3) chain_certificates — certificato digitale 1:1 con un holding
-- ══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.chain_certificates (
  id                       UUID DEFAULT gen_random_uuid() PRIMARY KEY,

  -- ── Aggancio allo schema esistente ───────────────────────────────────
  holding_id               UUID UNIQUE REFERENCES inv_holdings(id) ON DELETE SET NULL,
  order_id                 UUID REFERENCES inv_orders(id)   ON DELETE SET NULL,
  product_id               UUID NOT NULL REFERENCES inv_products(id) ON DELETE RESTRICT,

  -- Snapshot proprietà (per query veloci e sopravvivenza al cancellamento)
  current_owner_user_id    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  current_owner_wallet     TEXT NOT NULL,
  qty_minted               INT  NOT NULL CHECK (qty_minted > 0),

  -- ── On-chain ─────────────────────────────────────────────────────────
  chain_id                 INT  NOT NULL DEFAULT 8453,                -- Base mainnet
  contract_address         TEXT NOT NULL,
  token_id                 NUMERIC(78,0) NOT NULL,                    -- uint256
  tx_hash_mint             TEXT NOT NULL,                             -- 0x...
  block_number_mint        BIGINT,
  minted_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- ── Metadata immutabili ─────────────────────────────────────────────
  ipfs_metadata_uri        TEXT NOT NULL,        -- ipfs://Qm...
  ipfs_image_uri           TEXT,                 -- foto carta su IPFS
  arweave_backup_uri       TEXT,                 -- backup permanente
  metadata_frozen          BOOLEAN NOT NULL DEFAULT false,

  -- ── Certificato visivo ──────────────────────────────────────────────
  certificate_serial       TEXT NOT NULL UNIQUE, -- RB-2026-000042
  certificate_pdf_url      TEXT,                 -- URL Supabase Storage
  certificate_pdf_hash     TEXT NOT NULL,        -- SHA-256 hex (64 char) — ancorato on-chain
  qr_payload               TEXT,                 -- payload URL QR di verifica

  -- ── Stato ──────────────────────────────────────────────────────────
  status                   TEXT NOT NULL DEFAULT 'minted'
                           CHECK (status IN (
                             'minting',         -- mint tx submitted, in attesa conferma
                             'minted',          -- attivo, valido
                             'transferred',     -- trasferito a un nuovo proprietario
                             'frozen',          -- bloccato (pendenza legale)
                             'burned'           -- bruciato (rimborso/errore)
                           )),

  -- ── Audit ──────────────────────────────────────────────────────────
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by               UUID REFERENCES auth.users(id),

  CONSTRAINT chain_certs_wallet_format
    CHECK (current_owner_wallet ~ '^0x[a-fA-F0-9]{40}$'),
  CONSTRAINT chain_certs_contract_format
    CHECK (contract_address     ~ '^0x[a-fA-F0-9]{40}$'),
  CONSTRAINT chain_certs_tx_format
    CHECK (tx_hash_mint         ~ '^0x[a-fA-F0-9]{64}$'),
  CONSTRAINT chain_certs_pdf_hash_format
    CHECK (certificate_pdf_hash ~ '^[a-fA-F0-9]{64}$'),
  CONSTRAINT chain_certs_serial_format
    CHECK (certificate_serial   ~ '^RB-\d{4}-\d{6}$')
);

CREATE INDEX IF NOT EXISTS chain_certs_holding_idx     ON chain_certificates(holding_id);
CREATE INDEX IF NOT EXISTS chain_certs_order_idx       ON chain_certificates(order_id);
CREATE INDEX IF NOT EXISTS chain_certs_product_idx     ON chain_certificates(product_id);
CREATE INDEX IF NOT EXISTS chain_certs_owner_idx       ON chain_certificates(current_owner_user_id);
CREATE INDEX IF NOT EXISTS chain_certs_serial_idx      ON chain_certificates(certificate_serial);
CREATE INDEX IF NOT EXISTS chain_certs_status_idx      ON chain_certificates(status);
CREATE INDEX IF NOT EXISTS chain_certs_token_idx       ON chain_certificates(contract_address, token_id);
CREATE INDEX IF NOT EXISTS chain_certs_minted_at_idx   ON chain_certificates(minted_at DESC);

ALTER TABLE chain_certificates ENABLE ROW LEVEL SECURITY;

-- Owner vede i propri certificati
DROP POLICY IF EXISTS "chain_certs_select_own" ON chain_certificates;
CREATE POLICY "chain_certs_select_own" ON chain_certificates
  FOR SELECT USING (auth.uid() = current_owner_user_id);

-- Admin vede tutto
DROP POLICY IF EXISTS "chain_certs_select_admin" ON chain_certificates;
CREATE POLICY "chain_certs_select_admin" ON chain_certificates
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

-- Insert/update solo via Edge Function (service-role)
DROP POLICY IF EXISTS "chain_certs_no_write_users" ON chain_certificates;
CREATE POLICY "chain_certs_no_write_users" ON chain_certificates
  FOR INSERT WITH CHECK (false);

DROP POLICY IF EXISTS "chain_certs_no_update_users" ON chain_certificates;
CREATE POLICY "chain_certs_no_update_users" ON chain_certificates
  FOR UPDATE USING (false);


-- ══════════════════════════════════════════════════════════════════════
--  4) chain_transfers — audit log dei trasferimenti on-chain
-- ══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.chain_transfers (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  certificate_id      UUID NOT NULL REFERENCES chain_certificates(id) ON DELETE CASCADE,

  -- Parti coinvolte
  from_user_id        UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  to_user_id          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  from_wallet         TEXT NOT NULL,
  to_wallet           TEXT NOT NULL,
  qty                 INT  NOT NULL CHECK (qty > 0),

  -- Tipo evento
  transfer_type       TEXT NOT NULL
                      CHECK (transfer_type IN (
                        'mint',                -- emissione iniziale
                        'secondary_sale',      -- rivendita interna piattaforma
                        'liquidation',         -- liquidazione asset (tutti i quote tornano vault)
                        'admin_correction',    -- correzione manuale
                        'burn'                 -- distruzione
                      )),

  -- On-chain
  tx_hash             TEXT NOT NULL,
  block_number        BIGINT,
  reason_hash         TEXT,                    -- bytes32 hex passato a custodialTransfer

  -- Riferimenti applicativi
  inv_transfer_id     UUID,                    -- → inv_transfers.id se è secondario
  inv_order_id        UUID REFERENCES inv_orders(id) ON DELETE SET NULL,

  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chain_xfers_from_wallet_format CHECK (from_wallet ~ '^0x[a-fA-F0-9]{40}$'),
  CONSTRAINT chain_xfers_to_wallet_format   CHECK (to_wallet   ~ '^0x[a-fA-F0-9]{40}$'),
  CONSTRAINT chain_xfers_tx_format          CHECK (tx_hash     ~ '^0x[a-fA-F0-9]{64}$')
);

CREATE INDEX IF NOT EXISTS chain_xfers_cert_idx       ON chain_transfers(certificate_id);
CREATE INDEX IF NOT EXISTS chain_xfers_from_user_idx  ON chain_transfers(from_user_id);
CREATE INDEX IF NOT EXISTS chain_xfers_to_user_idx    ON chain_transfers(to_user_id);
CREATE INDEX IF NOT EXISTS chain_xfers_type_idx       ON chain_transfers(transfer_type);
CREATE INDEX IF NOT EXISTS chain_xfers_created_at_idx ON chain_transfers(created_at DESC);

ALTER TABLE chain_transfers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "chain_xfers_select_involved" ON chain_transfers;
CREATE POLICY "chain_xfers_select_involved" ON chain_transfers
  FOR SELECT USING (
    auth.uid() = from_user_id OR auth.uid() = to_user_id
  );

DROP POLICY IF EXISTS "chain_xfers_select_admin" ON chain_transfers;
CREATE POLICY "chain_xfers_select_admin" ON chain_transfers
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

DROP POLICY IF EXISTS "chain_xfers_no_write_users" ON chain_transfers;
CREATE POLICY "chain_xfers_no_write_users" ON chain_transfers
  FOR INSERT WITH CHECK (false);


-- ══════════════════════════════════════════════════════════════════════
--  5) Funzione: genera serial RB-YYYY-NNNNNN
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.chain_next_certificate_serial()
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_year TEXT := to_char(now(), 'YYYY');
  v_num  BIGINT := nextval('chain_certificate_serial_seq');
BEGIN
  RETURN format('RB-%s-%s', v_year, lpad(v_num::TEXT, 6, '0'));
END;
$$;


-- ══════════════════════════════════════════════════════════════════════
--  6) Funzione: token_id deterministico da product_id (UUID → uint256)
--     Usato dal contratto come token id stabile per ogni prodotto.
--     Restituisce SEMPRE un valore positivo (fino a ~120 bit, comodo in uint256).
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.chain_product_token_id(p_product_id UUID)
RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_hex   TEXT;
  v_num   NUMERIC := 0;
  v_char  CHAR(1);
  i       INT;
BEGIN
  -- Strip i trattini → 32 hex chars. Usiamo i primi 30 (120 bit) → sicuramente
  -- positivo, abbondantemente dentro uint256, e con range >> 10^36 (zero rischio
  -- collisioni anche con miliardi di prodotti).
  v_hex := replace(p_product_id::TEXT, '-', '');
  FOR i IN 1..30 LOOP
    v_char := substring(v_hex, i, 1);
    v_num  := v_num * 16 + ('x' || v_char)::bit(4)::int;
  END LOOP;
  -- Guardia (probabilità ≈ 0) contro tokenId = 0 che il contratto rifiuterebbe
  IF v_num = 0 THEN v_num := 1; END IF;
  RETURN v_num;
END;
$$;


-- ══════════════════════════════════════════════════════════════════════
--  7) Vista pubblica per la pagina di verifica esterna (NO RLS)
--     Espone solo dati non sensibili: serial, hash, contract, tx, status.
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW public.v_chain_certificate_public AS
SELECT
  c.certificate_serial,
  c.certificate_pdf_hash,
  c.contract_address,
  c.token_id,
  c.chain_id,
  c.tx_hash_mint,
  c.minted_at,
  c.qty_minted,
  c.status,
  c.ipfs_metadata_uri,
  -- product info pubblica
  p.name        AS product_name,
  p.image_url   AS product_image_url,
  p.type        AS product_type,
  -- owner anonimizzato (ultime 4 lettere del wallet)
  '0x...' || right(c.current_owner_wallet, 4) AS current_owner_short
FROM chain_certificates c
LEFT JOIN inv_products p ON p.id = c.product_id;

GRANT SELECT ON public.v_chain_certificate_public TO anon, authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  8) Trigger: keep updated_at fresh
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.chain_certs_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS chain_certs_touch_updated_at_trg ON chain_certificates;
CREATE TRIGGER chain_certs_touch_updated_at_trg
  BEFORE UPDATE ON chain_certificates
  FOR EACH ROW EXECUTE FUNCTION public.chain_certs_touch_updated_at();


-- ══════════════════════════════════════════════════════════════════════
--  9) Sanity check finale
-- ══════════════════════════════════════════════════════════════════════
DO $$ BEGIN
  RAISE NOTICE '✔ chain_wallets, chain_certificates, chain_transfers ready';
  RAISE NOTICE '✔ next serial preview: %', public.chain_next_certificate_serial();
  -- la chiamata sopra incrementa la sequence; rollbackiamo "manualmente"
  PERFORM setval('chain_certificate_serial_seq', currval('chain_certificate_serial_seq') - 1);
END $$;
