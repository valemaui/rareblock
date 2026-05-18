-- ═══════════════════════════════════════════════════════════════════════════
-- LISTINGS — tabella per gestire inserzioni eBay/Vinted/altre piattaforme
-- ═══════════════════════════════════════════════════════════════════════════
-- Lifecycle: draft → ready → published → sold | unsold | cancelled
--
-- Flow tipico:
--  1. User crea draft da una carta in collezione (collection_id FK)
--  2. Compila titolo, descrizione, prezzo, scegli piattaforma
--  3. Quando pronto, status='ready'
--  4. Pubblica (manuale via copia, o automatico via API se eBay con token):
--     status='published' + ext_url + ext_id + published_at
--  5. Vendita o ritiro: status='sold' + sold_at + sold_price oppure 'unsold'
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS rb_listings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Origine (opzionale): id della carta nella tabella 'cards' del Collector.
  -- TEXT invece di BIGINT/UUID: la tabella cards \u00e8 dell'app originale Collector,
  -- non sappiamo a priori se id \u00e8 INT o UUID. Usiamo TEXT senza FK rigida cos\u00ec
  -- evitiamo errori e l'app si occupa di gestire i join lato client.
  collection_id   TEXT,
  -- Snapshot della carta (denormalizzato: l'inserzione sopravvive a delete della riga collezione)
  card_name       TEXT NOT NULL,
  card_set        TEXT,
  card_set_id     TEXT,
  card_number     TEXT,
  card_rarity     TEXT,
  card_condition  TEXT,            -- NM/EX/GD/LP/PL/PO o PSA10/BGS9.5 ecc
  card_language   TEXT,
  card_variant    TEXT,            -- Normal/Holo/Reverse/Shadowless
  card_first_ed   BOOLEAN DEFAULT FALSE,
  card_graded     BOOLEAN DEFAULT FALSE,
  card_grade_house TEXT,           -- PSA/BGS/CGC ecc, solo se card_graded=true
  card_grade_score TEXT,           -- "10", "9.5", "8" ecc
  -- Inserzione
  platform        TEXT NOT NULL CHECK (platform IN ('ebay', 'vinted', 'other')),
  title           TEXT NOT NULL,
  description     TEXT,
  price           NUMERIC(10,2) NOT NULL,
  currency        TEXT DEFAULT 'EUR',
  shipping_cost   NUMERIC(10,2) DEFAULT 0,
  category_id     TEXT,            -- categoria piattaforma (es. eBay 183454 = Pokemon TCG)
  condition_id    TEXT,            -- condition enum della piattaforma
  -- Foto (lista URL pubblici)
  photos          JSONB DEFAULT '[]'::jsonb,
  -- Lifecycle
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'published', 'sold', 'unsold', 'cancelled')),
  published_at    TIMESTAMPTZ,
  ext_id          TEXT,            -- ID inserzione sulla piattaforma esterna
  ext_url         TEXT,            -- URL pubblico dell'inserzione
  -- Vendita
  sold_at         TIMESTAMPTZ,
  sold_price      NUMERIC(10,2),
  buyer_handle    TEXT,            -- username buyer (per supporto/feedback)
  -- Audit
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Meta (raw response API, errori publish, ecc)
  meta            JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS rb_listings_user_idx        ON rb_listings(user_id);
CREATE INDEX IF NOT EXISTS rb_listings_status_idx      ON rb_listings(user_id, status);
CREATE INDEX IF NOT EXISTS rb_listings_platform_idx    ON rb_listings(user_id, platform);
CREATE INDEX IF NOT EXISTS rb_listings_collection_idx  ON rb_listings(collection_id);
CREATE INDEX IF NOT EXISTS rb_listings_created_idx     ON rb_listings(user_id, created_at DESC);

-- RLS: ogni utente vede solo le proprie inserzioni
ALTER TABLE rb_listings ENABLE ROW LEVEL SECURITY;

CREATE POLICY rb_listings_select_own ON rb_listings
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY rb_listings_insert_own ON rb_listings
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY rb_listings_update_own ON rb_listings
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY rb_listings_delete_own ON rb_listings
  FOR DELETE USING (auth.uid() = user_id);

-- Trigger updated_at automatico
CREATE OR REPLACE FUNCTION rb_listings_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS rb_listings_updated_at_trg ON rb_listings;
CREATE TRIGGER rb_listings_updated_at_trg
  BEFORE UPDATE ON rb_listings
  FOR EACH ROW
  EXECUTE FUNCTION rb_listings_set_updated_at();

-- ─── eBay OAuth tokens (per Step 3) ────────────────────────────────────────
-- Tabella separata per gestire i token utente eBay (access_token expires 2h,
-- refresh_token expires 18 mesi). Una riga per utente RareBlock connesso.
CREATE TABLE IF NOT EXISTS rb_ebay_auth (
  user_id           UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  ebay_user_id      TEXT,             -- ID seller eBay (per debug)
  access_token      TEXT NOT NULL,    -- OAuth user access token
  refresh_token     TEXT NOT NULL,
  access_expires_at TIMESTAMPTZ NOT NULL,
  refresh_expires_at TIMESTAMPTZ NOT NULL,
  scopes            TEXT[],           -- lista scope autorizzati
  environment       TEXT DEFAULT 'sandbox' CHECK (environment IN ('sandbox','production')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rb_ebay_auth ENABLE ROW LEVEL SECURITY;
CREATE POLICY rb_ebay_auth_own ON rb_ebay_auth
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP TRIGGER IF EXISTS rb_ebay_auth_updated_at_trg ON rb_ebay_auth;
CREATE TRIGGER rb_ebay_auth_updated_at_trg
  BEFORE UPDATE ON rb_ebay_auth
  FOR EACH ROW
  EXECUTE FUNCTION rb_listings_set_updated_at();
