-- ═══════════════════════════════════════════════════════════════════════════
-- LISTINGS — tabella per gestire inserzioni eBay/Vinted/altre piattaforme
-- ═══════════════════════════════════════════════════════════════════════════
-- Lifecycle: draft -> ready -> published -> sold | unsold | cancelled
--
-- Flow tipico:
--  1. User crea draft da una carta in collezione (collection_id ref a cards.id)
--  2. Compila titolo, descrizione, prezzo, scegli piattaforma
--  3. Quando pronto, status='ready'
--  4. Pubblica (manuale via copia, o automatico via API se eBay con token):
--     status='published' + ext_url + ext_id + published_at
--  5. Vendita o ritiro: status='sold' + sold_at + sold_price oppure 'unsold'
-- ═══════════════════════════════════════════════════════════════════════════

-- Idempotente: drop pulito se una run parziale precedente ha lasciato spazzatura.
-- CASCADE rimuove anche eventuali index/trigger/policy collegati.
DROP TABLE IF EXISTS rb_listings CASCADE;
DROP TABLE IF EXISTS rb_ebay_auth CASCADE;

CREATE TABLE rb_listings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Origine (opzionale): id della carta nella tabella 'cards' del Collector.
  -- TEXT senza FK rigida perche non sappiamo se cards.id e INT o UUID
  -- nel DB esistente. L'app gestisce i join lato client.
  collection_id   TEXT,
  -- Snapshot della carta (denormalizzato per sopravvivere a delete della
  -- riga in 'cards').
  card_name       TEXT NOT NULL,
  card_set        TEXT,
  card_set_id     TEXT,
  card_number     TEXT,
  card_rarity     TEXT,
  card_condition  TEXT,
  card_language   TEXT,
  card_variant    TEXT,
  card_first_ed   BOOLEAN DEFAULT FALSE,
  card_graded     BOOLEAN DEFAULT FALSE,
  card_grade_house TEXT,
  card_grade_score TEXT,
  -- Inserzione
  platform        TEXT NOT NULL CHECK (platform IN ('ebay', 'vinted', 'other')),
  title           TEXT NOT NULL,
  description     TEXT,
  price           NUMERIC(10,2) NOT NULL,
  currency        TEXT DEFAULT 'EUR',
  shipping_cost   NUMERIC(10,2) DEFAULT 0,
  category_id     TEXT,
  condition_id    TEXT,
  photos          JSONB DEFAULT '[]'::jsonb,
  -- Lifecycle
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'ready', 'published', 'sold', 'unsold', 'cancelled')),
  published_at    TIMESTAMPTZ,
  ext_id          TEXT,
  ext_url         TEXT,
  -- Vendita
  sold_at         TIMESTAMPTZ,
  sold_price      NUMERIC(10,2),
  buyer_handle    TEXT,
  -- Audit
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  meta            JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX rb_listings_user_idx        ON rb_listings(user_id);
CREATE INDEX rb_listings_status_idx      ON rb_listings(user_id, status);
CREATE INDEX rb_listings_platform_idx    ON rb_listings(user_id, platform);
CREATE INDEX rb_listings_collection_idx  ON rb_listings(collection_id);
CREATE INDEX rb_listings_created_idx     ON rb_listings(user_id, created_at DESC);

ALTER TABLE rb_listings ENABLE ROW LEVEL SECURITY;

CREATE POLICY rb_listings_select_own ON rb_listings
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY rb_listings_insert_own ON rb_listings
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY rb_listings_update_own ON rb_listings
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY rb_listings_delete_own ON rb_listings
  FOR DELETE USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION rb_listings_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER rb_listings_updated_at_trg
  BEFORE UPDATE ON rb_listings
  FOR EACH ROW
  EXECUTE FUNCTION rb_listings_set_updated_at();

-- eBay OAuth tokens (preparatorio per Step 3 integration)
CREATE TABLE rb_ebay_auth (
  user_id           UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  ebay_user_id      TEXT,
  access_token      TEXT NOT NULL,
  refresh_token     TEXT NOT NULL,
  access_expires_at TIMESTAMPTZ NOT NULL,
  refresh_expires_at TIMESTAMPTZ NOT NULL,
  scopes            TEXT[],
  environment       TEXT DEFAULT 'sandbox'
                    CHECK (environment IN ('sandbox','production')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rb_ebay_auth ENABLE ROW LEVEL SECURITY;
CREATE POLICY rb_ebay_auth_own ON rb_ebay_auth
  FOR ALL USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER rb_ebay_auth_updated_at_trg
  BEFORE UPDATE ON rb_ebay_auth
  FOR EACH ROW
  EXECUTE FUNCTION rb_listings_set_updated_at();

-- Verifica finale: ti aspetti due righe entrambe con row_count = 0.
SELECT 'rb_listings'  AS tablename, COUNT(*) AS row_count FROM rb_listings
UNION ALL
SELECT 'rb_ebay_auth' AS tablename, COUNT(*) AS row_count FROM rb_ebay_auth;
