-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — MONITOR ASTE (feed per filtri su Catawiki)
--  Tabella delle DEFINIZIONI filtro. I risultati delle aste NON vengono
--  persistiti: sono dati live ri-scrapeati on-demand dall'estensione Hunter
--  (offerte del giorno/periodo → vogliamo sempre dato fresco).
--
--  Esegui nel Supabase SQL Editor una volta sola.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS auction_monitors (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Identità
  name              TEXT NOT NULL,
  notes             TEXT,

  -- Sorgente Catawiki
  base_url          TEXT,                       -- URL Catawiki già filtrato (incollato dall'utente); se presente ha priorità sul builder
  query             TEXT,                       -- keyword positiva libera per q=  (es. "charizard psa")
  category_id       INT DEFAULT 321,            -- 321 = Carte collezionabili singole

  -- Filtri positivi/negativi (applicati client-side sui lot)
  include_keywords  TEXT[] DEFAULT '{}',        -- tutte devono comparire nel titolo (AND)
  exclude_keywords  TEXT[] DEFAULT '{}',        -- nessuna deve comparire nel titolo
  include_countries TEXT[] DEFAULT '{}',        -- whitelist paese venditore (ISO2); vuoto = qualsiasi
  exclude_countries TEXT[] DEFAULT '{}',        -- blacklist paese venditore (ISO2)

  -- Grading / condizione
  grading_house     TEXT,                       -- 'PSA'|'BGS'|'CGC'|'ACE'|'SGC' | NULL = qualsiasi
  require_graded    BOOL DEFAULT false,         -- solo lot che sembrano gradati

  -- Prezzo / timing
  min_price         NUMERIC(10,2),
  max_price         NUMERIC(10,2),
  ending_within_hours INT,                      -- mostra solo aste che scadono entro X ore; NULL = qualsiasi

  -- Scoring
  ref_price         NUMERIC(10,2),              -- ancora opzionale per indicatore affare/super-affare
  sort_mode         TEXT DEFAULT 'ending_soon'  -- 'ending_soon'|'price_asc'|'price_desc'|'interest'
                      CHECK (sort_mode IN ('ending_soon','price_asc','price_desc','interest')),

  -- Stato
  is_active         BOOL DEFAULT true,
  last_run_at       TIMESTAMPTZ,
  total_found       INT DEFAULT 0,

  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auction_monitors_user_idx   ON auction_monitors(user_id);
CREATE INDEX IF NOT EXISTS auction_monitors_active_idx ON auction_monitors(is_active) WHERE is_active = true;

ALTER TABLE auction_monitors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auction_monitors_own" ON auction_monitors;
CREATE POLICY "auction_monitors_own" ON auction_monitors FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- updated_at trigger (riusa la funzione generica se esiste, altrimenti la crea)
CREATE OR REPLACE FUNCTION rb_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS auction_monitors_touch ON auction_monitors;
CREATE TRIGGER auction_monitors_touch
  BEFORE UPDATE ON auction_monitors
  FOR EACH ROW EXECUTE FUNCTION rb_touch_updated_at();

NOTIFY pgrst, 'reload schema';
