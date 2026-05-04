-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Modulo Investitori — PR9a
--  Migration 045: schema Modalità B (fractional) — comproprietà reale
--                 con trigger di vendita ibrido (target price OR exit window)
--
--  CONTESTO
--  La Modalità A (esistente) modella un fondo che acquista il bene, raccoglie
--  capitale tramite quote di partecipazione e liquida automaticamente alla
--  data target. La Modalità B introduce un modello DIVERSO: i sottoscrittori
--  diventano comproprietari pro-quota di un singolo bene fisico, senza
--  scioglimento automatico, con trigger di vendita configurato al lancio.
--
--  DECISIONI DI PRODOTTO (consolidate prima di questa migration):
--   B4    → Trigger ibrido OR: target price OR exit window
--   B4.1  → Exit window one-shot, con rinvio (default 2 anni dopo "no")
--   B4.2  → OR continuo: il target è valutato sempre, anche prima della finestra
--   B4.3  → Target immutabile al lancio (modificabile solo via voto 2/3)
--   B4.4  → Voto per quote, maggioranza qualificata 2/3 (66.67%)
--   B6    → Nessun obbligo buyback RareBlock; illiquidità con disclosure
--
--  COSA FA QUESTA MIGRATION
--   1. Estende inv_products con campi fractional_*
--   2. Crea inv_fractional_votes (audit votazioni exit window)
--   3. Crea kyc_quote_acknowledgments (3 spunte di consapevolezza Mod B)
--   4. Crea v_fractional_products (view con stats voto in corso)
--   5. RLS policies + indici
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Estende inv_products con campi specifici Modalità B ────────────
ALTER TABLE public.inv_products
  ADD COLUMN IF NOT EXISTS fractional_target_price_eur NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS fractional_exit_window_years INT,
  ADD COLUMN IF NOT EXISTS fractional_extension_years INT DEFAULT 2,
  ADD COLUMN IF NOT EXISTS fractional_launched_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fractional_exit_window_status TEXT
    CHECK (fractional_exit_window_status IN
      ('not_due','open','closed_sell','closed_postpone','closed_target_hit','closed_sold')),
  ADD COLUMN IF NOT EXISTS fractional_exit_window_opens_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fractional_exit_window_closes_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fractional_target_hit_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fractional_sold_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fractional_sold_price_eur NUMERIC(14,2);

COMMENT ON COLUMN public.inv_products.fractional_target_price_eur IS
  'Modalità B: prezzo target di vendita immutabile al lancio. Quando il bene riceve un offerta on-chain o off-chain ≥ a questo valore, parte la procedura di vendita automatica (decisione B4.2 OR continuo).';
COMMENT ON COLUMN public.inv_products.fractional_exit_window_years IS
  'Modalità B: anni dopo fractional_launched_at alla cui scadenza si apre la prima finestra di voto exit (one-shot).';
COMMENT ON COLUMN public.inv_products.fractional_extension_years IS
  'Modalità B: anni di rinvio se al voto vince "non vendere" (default 2 anni). Il rinvio si applica ricorsivamente (sempre 2 anni dopo l ultimo "no").';
COMMENT ON COLUMN public.inv_products.fractional_launched_at IS
  'Timestamp del lancio del prodotto Modalità B (transition da draft → open). Usato come ancora per calcolare opens_at della prima exit window.';
COMMENT ON COLUMN public.inv_products.fractional_exit_window_status IS
  'Stato del trigger di vendita Modalità B:
   - not_due: prima della finestra (o dopo voto "no" prima della prossima)
   - open: finestra di voto attualmente aperta
   - closed_sell: voto chiuso, esito "vendi" (≥66.67% quote favorevoli)
   - closed_postpone: voto chiuso, esito "non vendere" (rinvio di extension_years)
   - closed_target_hit: vendita scattata per target price (B4.2 OR continuo)
   - closed_sold: bene fisicamente venduto, comproprietari liquidati pro-quota';

-- ── 2. inv_fractional_votes — audit chain delle votazioni ─────────────
CREATE TABLE IF NOT EXISTS public.inv_fractional_votes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id          UUID NOT NULL REFERENCES public.inv_products(id) ON DELETE CASCADE,

  -- Identificazione finestra (alcuni prodotti possono avere più cicli di voto
  -- a causa dei rinvii). round=1 per la prima finestra, +1 ad ogni rinvio.
  round_number        INT NOT NULL DEFAULT 1,
  opened_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  closes_at           TIMESTAMPTZ NOT NULL,           -- finestra di 60 gg dopo opens_at
  closed_at           TIMESTAMPTZ,                    -- valorizzato a chiusura (manuale o scheduled)

  -- Esito aggregato (calcolato a chiusura; NULL fino a quel momento)
  result              TEXT CHECK (result IN ('sell','postpone','no_quorum')),
  votes_sell_quotes   INT,
  votes_no_quotes     INT,
  votes_abstain_quotes INT,
  total_eligible_quotes INT,                          -- snapshot al momento dell apertura

  -- Audit
  opened_by           UUID REFERENCES auth.users(id), -- admin che ha aperto (o NULL se schedulato)
  closed_by           UUID REFERENCES auth.users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_fract_votes_round UNIQUE (product_id, round_number)
);

CREATE INDEX IF NOT EXISTS idx_fract_votes_product ON public.inv_fractional_votes(product_id);
CREATE INDEX IF NOT EXISTS idx_fract_votes_open ON public.inv_fractional_votes(product_id) WHERE closed_at IS NULL;

ALTER TABLE public.inv_fractional_votes ENABLE ROW LEVEL SECURITY;

-- Lettura: chiunque vede i voti aggregati (la trasparenza è feature, non bug)
CREATE POLICY "inv_fractional_votes_select" ON public.inv_fractional_votes
  FOR SELECT USING (true);

-- Insert/update: solo da edge function con service_role (vincolato a flow controllato)
-- Le RLS rifiutano insert da utenti normali; gli admin possono via dashboard
-- (inserts diretti sono comunque rari, di solito è la edge function fractional-vote-open).

-- ── 3. inv_fractional_vote_ballots — singoli voti per quote ────────────
CREATE TABLE IF NOT EXISTS public.inv_fractional_vote_ballots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vote_id         UUID NOT NULL REFERENCES public.inv_fractional_votes(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product_id      UUID NOT NULL REFERENCES public.inv_products(id) ON DELETE CASCADE,

  -- Snapshot delle quote al momento del voto (immutabile per audit)
  quotes_held     INT NOT NULL,

  -- Voto
  ballot          TEXT NOT NULL CHECK (ballot IN ('sell','postpone','abstain')),

  -- Audit
  cast_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address      TEXT,
  user_agent      TEXT,

  -- Un voto per utente per round (anti-doublevote)
  CONSTRAINT uq_ballot_user_vote UNIQUE (vote_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_ballots_vote ON public.inv_fractional_vote_ballots(vote_id);
CREATE INDEX IF NOT EXISTS idx_ballots_user ON public.inv_fractional_vote_ballots(user_id);

ALTER TABLE public.inv_fractional_vote_ballots ENABLE ROW LEVEL SECURITY;

-- Self-select: ogni utente vede i propri voti (per UI "ho già votato?")
CREATE POLICY "inv_fract_ballots_select_own" ON public.inv_fractional_vote_ballots
  FOR SELECT USING (auth.uid() = user_id);

-- Self-insert: l utente può votare per sé stesso
-- NB: la edge function farà ulteriori check (è effettivamente comproprietario? round è ancora aperto?)
CREATE POLICY "inv_fract_ballots_insert_own" ON public.inv_fractional_vote_ballots
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Update: NESSUNO. I voti sono immutabili una volta espressi.

-- ── 4. kyc_quote_acknowledgments — 3 spunte di consapevolezza Mod B ────
-- Gate obbligatorio prima di poter acquistare quote di prodotti Modalità B.
-- L utente deve esplicitamente acknowledgere: illiquidità, no-buyback, perdita capitale.
CREATE TABLE IF NOT EXISTS public.kyc_quote_acknowledgments (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- 3 acknowledgments distinti (tutti TRUE per essere "completo")
  ack_illiquidity                 BOOLEAN NOT NULL DEFAULT false,
  ack_no_buyback                  BOOLEAN NOT NULL DEFAULT false,
  ack_capital_loss                BOOLEAN NOT NULL DEFAULT false,

  -- Versionamento del wording: se Anthropic legal cambia il testo dei disclaimer,
  -- bumpiamo questo numero e gli ack precedenti decadono → l utente deve ri-spuntare.
  ack_text_version                INT NOT NULL DEFAULT 1,

  -- Audit
  acknowledged_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address                      TEXT,
  user_agent                      TEXT,

  -- Un solo record per (user, version): se cambia version → INSERT nuovo, vecchio resta come storico
  CONSTRAINT uq_kyc_ack_user_version UNIQUE (user_id, ack_text_version)
);

CREATE INDEX IF NOT EXISTS idx_kyc_ack_user ON public.kyc_quote_acknowledgments(user_id);

ALTER TABLE public.kyc_quote_acknowledgments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "kyc_quote_ack_select_own" ON public.kyc_quote_acknowledgments
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "kyc_quote_ack_insert_own" ON public.kyc_quote_acknowledgments
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ── 5. View v_fractional_products — stats Mod B per UI ─────────────────
-- Aggrega dati dalle 3 tabelle per fornire alla UI un singolo SELECT con
-- tutto ciò che serve per renderizzare un prodotto fractional.
CREATE OR REPLACE VIEW public.v_fractional_products AS
SELECT
  p.*,
  -- Voto attualmente aperto, se esiste
  v.id              AS active_vote_id,
  v.round_number    AS active_vote_round,
  v.opened_at       AS active_vote_opened_at,
  v.closes_at       AS active_vote_closes_at,
  v.total_eligible_quotes AS active_vote_eligible_quotes,
  -- Conteggio voti espressi finora nel round attivo
  (SELECT count(*) FROM public.inv_fractional_vote_ballots b
   WHERE b.vote_id = v.id) AS active_vote_ballots_count,
  (SELECT coalesce(sum(quotes_held), 0) FROM public.inv_fractional_vote_ballots b
   WHERE b.vote_id = v.id AND b.ballot = 'sell') AS active_vote_quotes_sell,
  (SELECT coalesce(sum(quotes_held), 0) FROM public.inv_fractional_vote_ballots b
   WHERE b.vote_id = v.id AND b.ballot = 'postpone') AS active_vote_quotes_postpone,
  -- Dati storici degli ultimi voti chiusi
  (SELECT count(*) FROM public.inv_fractional_votes vh
   WHERE vh.product_id = p.id AND vh.closed_at IS NOT NULL) AS past_votes_count
FROM public.inv_products p
LEFT JOIN public.inv_fractional_votes v
  ON v.product_id = p.id AND v.closed_at IS NULL    -- solo voto attualmente aperto
WHERE p.type = 'fractional';

GRANT SELECT ON public.v_fractional_products TO authenticated, anon;

-- ── 6. View v_my_fractional_holdings — quote dell utente in prodotti B ──
-- Helper per la dashboard utente: lista delle sue quote fractional con
-- info aggregata sul prodotto e voto attivo (se l utente è eligible a votare).
CREATE OR REPLACE VIEW public.v_my_fractional_holdings AS
SELECT
  h.id              AS holding_id,
  h.user_id,
  h.product_id,
  h.qty             AS quotes_held,
  h.price_per_quote AS purchase_price_per_quote,
  h.acquired_at,
  p.name            AS product_name,
  p.fractional_target_price_eur,
  p.fractional_exit_window_status,
  p.status          AS product_status,
  v.id              AS active_vote_id,
  v.closes_at       AS active_vote_closes_at,
  -- L utente ha già votato in questo round?
  (SELECT b.ballot FROM public.inv_fractional_vote_ballots b
   WHERE b.vote_id = v.id AND b.user_id = h.user_id LIMIT 1) AS my_ballot
FROM public.inv_holdings h
JOIN public.inv_products p ON p.id = h.product_id
LEFT JOIN public.inv_fractional_votes v
  ON v.product_id = p.id AND v.closed_at IS NULL
WHERE p.type = 'fractional';

GRANT SELECT ON public.v_my_fractional_holdings TO authenticated;

-- La RLS della tabella sottostante (inv_holdings) si applica → la view
-- mostra solo le righe dell utente connesso.

-- ── 7. Funzione helper — controllo eligibilità Mod B per un user ───────
-- Usata dalla UI prima di mostrare il flow di acquisto fractional:
-- ritorna true se l utente ha le 3 spunte alla versione corrente.
CREATE OR REPLACE FUNCTION public.is_eligible_for_fractional(p_user_id UUID, p_version INT DEFAULT 1)
RETURNS BOOLEAN
LANGUAGE sql STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.kyc_quote_acknowledgments
    WHERE user_id = p_user_id
      AND ack_text_version = p_version
      AND ack_illiquidity = true
      AND ack_no_buyback = true
      AND ack_capital_loss = true
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_eligible_for_fractional(UUID, INT) TO authenticated;

-- ── 8. Reload PostgREST + verifica ─────────────────────────────────────
NOTIFY pgrst, 'reload schema';

-- Verifica colonne aggiunte a inv_products
DO $$
DECLARE col_count INT;
BEGIN
  SELECT count(*) INTO col_count
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='inv_products'
    AND column_name LIKE 'fractional_%';
  RAISE NOTICE '045_fractional: inv_products fractional_* columns = %', col_count;

  SELECT count(*) INTO col_count FROM pg_tables WHERE schemaname='public' AND tablename='inv_fractional_votes';
  RAISE NOTICE '045_fractional: inv_fractional_votes table created = %', col_count;

  SELECT count(*) INTO col_count FROM pg_tables WHERE schemaname='public' AND tablename='kyc_quote_acknowledgments';
  RAISE NOTICE '045_fractional: kyc_quote_acknowledgments table created = %', col_count;

  SELECT count(*) INTO col_count FROM pg_views WHERE schemaname='public' AND viewname IN ('v_fractional_products', 'v_my_fractional_holdings');
  RAISE NOTICE '045_fractional: views created = %/2', col_count;
END $$;

-- Atteso:
--   inv_products fractional_* columns = 10
--   inv_fractional_votes table created = 1
--   kyc_quote_acknowledgments table created = 1
--   views created = 2/2

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 045_fractional_schema.sql
-- ═══════════════════════════════════════════════════════════════════════
