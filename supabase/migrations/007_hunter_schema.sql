-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — HUNTER: scouting inserzioni multi-portale
--  Esegui nel Supabase SQL Editor una volta sola, in ordine
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Target di caccia (carte monitorate) ──────────────────────────
CREATE TABLE IF NOT EXISTS hunt_targets (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Identità carta
  card_name      TEXT NOT NULL,
  card_number    TEXT,                     -- "4/102"
  set_id         TEXT,                     -- TCG API set.id (es. 'base1')
  set_name       TEXT,
  tcg_id         TEXT,                     -- TCG API card.id, se noto

  -- Attributi ricerca
  language       TEXT DEFAULT 'ANY',       -- 'ITA' | 'ENG' | 'JPN' | 'ANY'
  variant        TEXT DEFAULT 'Normal',    -- 'Normal' | 'Reverse Holo' | 'Holo'
  first_edition  BOOL DEFAULT false,
  shadowless     BOOL DEFAULT false,
  grading_house  TEXT,                     -- 'PSA'|'BGS'|'CGC'|'ACE'|NULL
  min_grade      NUMERIC(3,1),             -- 9, 9.5, 10
  extra_keywords TEXT[],                   -- ['staff','sealed','promo',...]

  -- Parametri di soglia
  max_price      NUMERIC(10,2),            -- non considerare annunci sopra
  ref_price_cm   NUMERIC(10,2),            -- prezzo riferimento (autopopolato)
  deal_threshold INT DEFAULT 70,           -- alert se deal_score >= X

  -- Stato
  is_active      BOOL DEFAULT true,
  last_scan_at   TIMESTAMPTZ,
  total_found    INT DEFAULT 0,

  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hunt_targets_user_idx   ON hunt_targets(user_id);
CREATE INDEX IF NOT EXISTS hunt_targets_active_idx ON hunt_targets(is_active) WHERE is_active = true;

ALTER TABLE hunt_targets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "hunt_targets_own" ON hunt_targets FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);


-- ── 2. Registry inserzioni ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hunt_listings (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  target_id       UUID REFERENCES hunt_targets(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Origine
  platform        TEXT NOT NULL CHECK (platform IN
                    ('ebay','catawiki','subito','vinted','tcgplayer',
                     'delver','mercari_it','facebook','other')),
  listing_url     TEXT NOT NULL,
  external_id     TEXT,                    -- item_id eBay, ecc.

  -- Dati listing
  title           TEXT,
  price           NUMERIC(10,2),
  currency        TEXT DEFAULT 'EUR',
  shipping_cost   NUMERIC(10,2),
  listing_type    TEXT CHECK (listing_type IN
                    ('fixed','auction','best_offer','mixed')),

  -- Timing (asta)
  auction_ends_at TIMESTAMPTZ,
  bid_count       INT,
  time_left_hours NUMERIC(6,2),

  -- Condizione/grading (auto-estratto dal titolo)
  parsed_cond     TEXT,                    -- 'NM','EX','GD','Unknown'
  parsed_grade    NUMERIC(3,1),            -- 10, 9.5
  parsed_grader   TEXT,                    -- 'PSA','BGS'
  parsed_lang     TEXT,
  parsed_is_1st   BOOL,

  -- Venditore
  seller_name     TEXT,
  seller_country  TEXT,
  seller_rating   NUMERIC(4,2),            -- es. 99.8
  seller_feedbacks INT,

  -- Scoring
  deal_score      INT,                     -- 0-100 (calcolato)
  deal_reasons    TEXT[],                  -- ['below_cm_40pct','auction_no_bids']

  -- Stato
  status          TEXT DEFAULT 'new'       -- 'new'|'seen'|'watched'|'bought'|'expired'|'dismissed'
                    CHECK (status IN ('new','seen','watched','bought','expired','dismissed')),
  image_url       TEXT,

  -- Notifiche
  alerted_at      TIMESTAMPTZ,
  alert_channels  TEXT[],                  -- canali usati

  first_seen_at   TIMESTAMPTZ DEFAULT now(),
  last_seen_at    TIMESTAMPTZ DEFAULT now(),

  UNIQUE(user_id, platform, external_id)
);

CREATE INDEX IF NOT EXISTS hunt_listings_target_idx     ON hunt_listings(target_id);
CREATE INDEX IF NOT EXISTS hunt_listings_user_idx       ON hunt_listings(user_id);
CREATE INDEX IF NOT EXISTS hunt_listings_platform_idx   ON hunt_listings(platform);
CREATE INDEX IF NOT EXISTS hunt_listings_deal_score_idx ON hunt_listings(deal_score DESC);
CREATE INDEX IF NOT EXISTS hunt_listings_status_idx     ON hunt_listings(status);
CREATE INDEX IF NOT EXISTS hunt_listings_auction_idx    ON hunt_listings(auction_ends_at) WHERE auction_ends_at IS NOT NULL;

ALTER TABLE hunt_listings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "hunt_listings_own" ON hunt_listings FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);


-- ── 3. Regole alert utente ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hunt_alert_rules (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  target_id      UUID REFERENCES hunt_targets(id) ON DELETE CASCADE, -- NULL = global

  name           TEXT NOT NULL,
  is_active      BOOL DEFAULT true,

  -- Condizioni (tutte in AND)
  min_deal_score INT,                     -- es. 70
  max_price      NUMERIC(10,2),
  platforms      TEXT[],                  -- ['ebay','subito'] o NULL = tutti
  auction_only   BOOL DEFAULT false,
  ending_within_hours INT,                -- aste <X ore

  -- Canali notifica
  channel_push       BOOL DEFAULT true,
  channel_email      BOOL DEFAULT false,
  channel_whatsapp   BOOL DEFAULT false,
  channel_telegram   BOOL DEFAULT false,

  -- Throttle
  cooldown_minutes   INT DEFAULT 60,      -- non rispammare stessa carta
  last_fired_at      TIMESTAMPTZ,
  fire_count         INT DEFAULT 0,

  created_at         TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE hunt_alert_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "hunt_alert_rules_own" ON hunt_alert_rules FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);


-- ── 4. Config canali notifica (admin) ───────────────────────────────
CREATE TABLE IF NOT EXISTS hunt_channel_config (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,

  -- Email (Resend)
  email_address  TEXT,
  email_verified BOOL DEFAULT false,

  -- Push web (VAPID subscription)
  push_subscription JSONB,

  -- WhatsApp (Twilio)
  whatsapp_number TEXT,                   -- es. '+39333...'
  whatsapp_verified BOOL DEFAULT false,

  -- Telegram
  telegram_chat_id TEXT,
  telegram_verified BOOL DEFAULT false,

  -- Preferenze globali
  quiet_hours_start  TIME,                -- es. 22:00
  quiet_hours_end    TIME,                -- es. 08:00
  digest_frequency   TEXT DEFAULT 'daily' -- 'never'|'daily'|'hourly'
                     CHECK (digest_frequency IN ('never','daily','hourly')),
  digest_hour        INT DEFAULT 9,       -- ora invio digest (0-23)

  updated_at         TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE hunt_channel_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "hunt_channel_config_own" ON hunt_channel_config FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);


-- ── 5. Log eventi notifica ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hunt_alert_log (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  rule_id      UUID REFERENCES hunt_alert_rules(id) ON DELETE SET NULL,
  listing_id   UUID REFERENCES hunt_listings(id) ON DELETE CASCADE,

  channel      TEXT NOT NULL CHECK (channel IN ('push','email','whatsapp','telegram')),
  status       TEXT NOT NULL CHECK (status IN ('sent','failed','skipped')),
  error        TEXT,
  payload      JSONB,

  sent_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hunt_alert_log_user_idx ON hunt_alert_log(user_id);
CREATE INDEX IF NOT EXISTS hunt_alert_log_sent_idx ON hunt_alert_log(sent_at DESC);

ALTER TABLE hunt_alert_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "hunt_alert_log_own" ON hunt_alert_log FOR SELECT USING (auth.uid() = user_id);


-- ── 6. Metrica scarcity (PSA pop + listing count) ───────────────────
CREATE TABLE IF NOT EXISTS hunt_scarcity_daily (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  target_id      UUID NOT NULL REFERENCES hunt_targets(id) ON DELETE CASCADE,

  snapshot_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  psa_pop_10     INT,
  psa_pop_9      INT,
  psa_pop_total  INT,
  active_listings INT,                    -- somma attive multi-portale
  avg_price      NUMERIC(10,2),
  median_price   NUMERIC(10,2),
  scarcity_index NUMERIC(6,2),            -- pop_10 / active_listings (>1 = scarse)

  UNIQUE(target_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS hunt_scarcity_target_idx ON hunt_scarcity_daily(target_id);


-- ── 7. View: feed opportunità attive ordinate per deal_score ────────
CREATE OR REPLACE VIEW hunt_feed AS
SELECT
  l.*,
  t.card_name,
  t.card_number,
  t.set_name,
  t.grading_house,
  t.min_grade,
  t.ref_price_cm,
  CASE
    WHEN t.ref_price_cm > 0 THEN ROUND(((t.ref_price_cm - l.price) / t.ref_price_cm * 100)::numeric, 1)
    ELSE NULL
  END AS discount_pct,
  CASE
    WHEN l.auction_ends_at IS NOT NULL
      THEN EXTRACT(EPOCH FROM (l.auction_ends_at - now())) / 3600
    ELSE NULL
  END AS hours_remaining
FROM hunt_listings l
LEFT JOIN hunt_targets t ON t.id = l.target_id
WHERE l.status IN ('new','seen','watched')
ORDER BY l.deal_score DESC NULLS LAST, l.first_seen_at DESC;
