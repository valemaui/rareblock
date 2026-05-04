-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Modulo Contratti — PR5 #1/3
--  Migration 039: notarizzazione on-chain dei PDF firmati FEA
--
--  Scopo:
--    Ancorare on-chain (Base mainnet) l'hash SHA-256 del PDF firmato di
--    un contratto, per ottenere un timestamp criptograficamente certo
--    e pubblicamente verificabile.
--
--  Architettura:
--    Per minimizzare costi, complessità e superficie di rischio, NON
--    deployamo uno smart contract custom. Usiamo invece una "data tx"
--    self-send sul wallet operator RareBlock:
--
--      operator → operator   value=0
--      data = 0x52424b01                   ── magic bytes "RBK\x01"
--           || version (1 byte)            ── schema notarizzazione
--           || sha256(pdf) (32 bytes)
--           || contract_serial_short (16 bytes ASCII, padding)
--           || keccak256(user_id) (32 bytes)
--
--      → totale 81 bytes calldata
--      → gas atteso ~21000 + 16 bytes tx data * cost ≈ 22000 gas total
--      → costo a gas price ~0.05 gwei: ~1.1e-6 ETH ≈ 0.003€
--
--    Ogni notarizzazione = 1 tx → identificata da tx_hash univoco.
--    BaseScan mostra calldata in chiaro → verifica trivial.
--
--    NB: l'effettivo invio della tx è gestito dall'Edge Function
--    contract-notarize (PR5 #2/3). Questa migration crea solo lo
--    schema DB.
--
--  Tabella separata da chain_certificates perché:
--    • diversa semantica (notarization vs ownership)
--    • diverso oggetto referenziato (contracts vs holdings)
--    • diverso modello (event-only vs persistente)
-- ═══════════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════════
--  1) Stato del wallet operator (single-row config)
-- ══════════════════════════════════════════════════════════════════════
-- Memorizza l'indirizzo + chain del wallet operator usato per le
-- notarizzazioni. La private key NON è qui: è in Supabase Edge Function
-- secrets (NOTARIZE_OPERATOR_PRIVATE_KEY).
CREATE TABLE IF NOT EXISTS public.notarize_operator_state (
  id              INT PRIMARY KEY DEFAULT 1,
  operator_addr   TEXT,                            -- 0x... checksum
  chain_id        INT  NOT NULL DEFAULT 8453,      -- Base mainnet
  rpc_url         TEXT NOT NULL DEFAULT 'https://mainnet.base.org',
  next_nonce      BIGINT,                          -- ultimo nonce visto (cache)
  last_synced_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT operator_state_singleton CHECK (id = 1),
  CONSTRAINT operator_addr_format CHECK (
    operator_addr IS NULL OR operator_addr ~ '^0x[a-fA-F0-9]{40}$'
  )
);

-- Riga singleton (idempotente)
INSERT INTO public.notarize_operator_state (id) VALUES (1)
  ON CONFLICT (id) DO NOTHING;


-- ══════════════════════════════════════════════════════════════════════
--  2) Tabella delle notarizzazioni
-- ══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.contract_notarizations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ── Dato notarizzato ──────────────────────────────────────────────
  -- Riferimento al contratto (NULLABLE: la tabella contracts è in PR6,
  -- quindi la FK è "soft" tramite UUID — la wireremo con FK formale
  -- quando arriverà PR6/035_contracts.sql)
  contract_id         UUID,
  contract_serial     TEXT NOT NULL,            -- es. "RB-VND-2026-000001"
  user_id             UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  user_id_hash        TEXT NOT NULL,            -- 0x... keccak256 (no PII on-chain)

  -- Hash del PDF firmato (32 bytes, hex con prefisso 0x)
  pdf_sha256          TEXT NOT NULL,
  CONSTRAINT pdf_sha_format CHECK (pdf_sha256 ~ '^0x[a-fA-F0-9]{64}$'),

  -- ── On-chain ──────────────────────────────────────────────────────
  chain_id            INT  NOT NULL DEFAULT 8453,
  operator_addr       TEXT NOT NULL,
  tx_hash             TEXT,                     -- 0x... 32 bytes (NULL fino a invio)
  block_number        BIGINT,
  block_timestamp     TIMESTAMPTZ,
  tx_nonce            BIGINT,
  gas_used            BIGINT,
  gas_price_wei       NUMERIC(40,0),
  raw_calldata        TEXT,                     -- 0x... per audit forense

  -- ── Stato workflow ────────────────────────────────────────────────
  status              TEXT NOT NULL DEFAULT 'pending',
  -- pending: creata in DB, tx non ancora inviata
  -- broadcasted: tx inviata, in attesa di mining
  -- confirmed: tx minata + ≥1 conferma
  -- failed: tx fallita (revert/dropped/replaced)
  error_message       TEXT,
  attempts            INT NOT NULL DEFAULT 0,
  last_attempt_at     TIMESTAMPTZ,

  -- ── Timestamps ────────────────────────────────────────────────────
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  broadcasted_at      TIMESTAMPTZ,
  confirmed_at        TIMESTAMPTZ,

  CONSTRAINT notar_status_chk
    CHECK (status IN ('pending','broadcasted','confirmed','failed')),
  CONSTRAINT notar_chain_chk
    CHECK (chain_id IN (8453, 84532)),         -- Base mainnet o sepolia
  CONSTRAINT notar_tx_hash_format
    CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[a-fA-F0-9]{64}$')
);

-- Indici di lavoro
CREATE INDEX IF NOT EXISTS idx_notar_contract  ON public.contract_notarizations (contract_id);
CREATE INDEX IF NOT EXISTS idx_notar_serial    ON public.contract_notarizations (contract_serial);
CREATE INDEX IF NOT EXISTS idx_notar_status    ON public.contract_notarizations (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notar_pdf_hash  ON public.contract_notarizations (pdf_sha256);
CREATE INDEX IF NOT EXISTS idx_notar_tx_hash   ON public.contract_notarizations (tx_hash)
  WHERE tx_hash IS NOT NULL;

-- Univocità: un certo PDF hash dovrebbe avere UNA notarizzazione attiva.
-- Più tentativi (failed retry) sono ammessi, ma una sola "confirmed".
CREATE UNIQUE INDEX IF NOT EXISTS uq_notar_pdf_confirmed
  ON public.contract_notarizations (pdf_sha256)
  WHERE status = 'confirmed';


-- ══════════════════════════════════════════════════════════════════════
--  3) RLS
-- ══════════════════════════════════════════════════════════════════════
ALTER TABLE public.notarize_operator_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_notarizations  ENABLE ROW LEVEL SECURITY;

-- operator_state: lettura pubblica (l'address è pubblico per definizione),
-- scrittura solo admin/service_role.
DROP POLICY IF EXISTS notar_op_read ON public.notarize_operator_state;
CREATE POLICY notar_op_read ON public.notarize_operator_state
  FOR SELECT TO authenticated, anon
  USING (true);

DROP POLICY IF EXISTS notar_op_admin ON public.notarize_operator_state;
CREATE POLICY notar_op_admin ON public.notarize_operator_state
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- contract_notarizations:
--  • il proprietario del contratto (= user_id) vede la propria
--  • admin vede tutto
--  • lettura pubblica via funzione SECURITY DEFINER `notarize_lookup_public`
--    (definita sotto) per la pagina /verify
--  • scritture solo da Edge Function service_role
DROP POLICY IF EXISTS notar_self ON public.contract_notarizations;
CREATE POLICY notar_self ON public.contract_notarizations
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS notar_admin ON public.contract_notarizations;
CREATE POLICY notar_admin ON public.contract_notarizations
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());


-- ══════════════════════════════════════════════════════════════════════
--  4) Helper public verify lookup
-- ══════════════════════════════════════════════════════════════════════
-- Funzione SECURITY DEFINER che chiunque (anche anon) può chiamare per
-- verificare un contratto. Espone SOLO i dati tecnici (hash, tx, block,
-- timestamp), MAI l'identità dell'utente o il contenuto del PDF.
--
-- Vista pubblica = strumento di trust per controparti / regolatori /
-- pubblico ministero in caso di contestazione.
CREATE OR REPLACE FUNCTION public.notarize_lookup_public(p_serial TEXT)
RETURNS TABLE (
  contract_serial   TEXT,
  pdf_sha256        TEXT,
  chain_id          INT,
  tx_hash           TEXT,
  block_number      BIGINT,
  block_timestamp   TIMESTAMPTZ,
  status            TEXT,
  notarized_at      TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    n.contract_serial,
    n.pdf_sha256,
    n.chain_id,
    n.tx_hash,
    n.block_number,
    n.block_timestamp,
    n.status,
    n.confirmed_at AS notarized_at
  FROM public.contract_notarizations n
  WHERE n.contract_serial = p_serial
    AND n.status IN ('confirmed','broadcasted')
  ORDER BY n.confirmed_at DESC NULLS LAST, n.created_at DESC
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.notarize_lookup_public(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.notarize_lookup_public(TEXT) TO anon, authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  5) Helper: lookup per hash (utile in caso il chiamante abbia il PDF)
-- ══════════════════════════════════════════════════════════════════════
-- Permette di verificare un PDF: l'utente carica un PDF, calcola il
-- SHA-256 lato client, chiede via questa funzione se quel hash risulta
-- notarizzato. Conferma in 1 query.
CREATE OR REPLACE FUNCTION public.notarize_lookup_by_hash(p_sha256 TEXT)
RETURNS TABLE (
  contract_serial   TEXT,
  pdf_sha256        TEXT,
  chain_id          INT,
  tx_hash           TEXT,
  block_number      BIGINT,
  block_timestamp   TIMESTAMPTZ,
  status            TEXT,
  notarized_at      TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    n.contract_serial,
    n.pdf_sha256,
    n.chain_id,
    n.tx_hash,
    n.block_number,
    n.block_timestamp,
    n.status,
    n.confirmed_at AS notarized_at
  FROM public.contract_notarizations n
  WHERE lower(n.pdf_sha256) = lower(p_sha256)
    AND n.status IN ('confirmed','broadcasted')
  ORDER BY n.confirmed_at DESC NULLS LAST, n.created_at DESC
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.notarize_lookup_by_hash(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.notarize_lookup_by_hash(TEXT) TO anon, authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  6) Trigger: aggiorna updated_at sull'operator state
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.notar_op_state_touch()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_notar_op_state_touch ON public.notarize_operator_state;
CREATE TRIGGER trg_notar_op_state_touch
  BEFORE UPDATE ON public.notarize_operator_state
  FOR EACH ROW EXECUTE FUNCTION public.notar_op_state_touch();


-- ══════════════════════════════════════════════════════════════════════
--  7) Reload PostgREST + smoke test
-- ══════════════════════════════════════════════════════════════════════
NOTIFY pgrst, 'reload schema';

SELECT
  'notarize_operator_state'  AS object, COUNT(*)::TEXT AS rows FROM public.notarize_operator_state
UNION ALL
SELECT 'contract_notarizations', COUNT(*)::TEXT FROM public.contract_notarizations
UNION ALL
SELECT 'notarize_lookup_public(test)',
  COALESCE((SELECT contract_serial FROM public.notarize_lookup_public('TEST')), 'no-row');

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 039_notarizations.sql
-- ═══════════════════════════════════════════════════════════════════════
