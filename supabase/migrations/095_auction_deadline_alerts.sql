-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — SCADENZE ASTE (alert push a −N minuti dalla fine)
--
--  L'utente carica manualmente un'asta (qualsiasi piattaforma) con:
--  piattaforma, titolo, data/ora di fine, prezzo di valutazione
--  (da rb_card_index o manuale). A end_at − notify_minutes la edge
--  function `auction-alert` (cron ogni minuto) invia una Web Push
--  a tutte le subscription in hunt_push_subscriptions.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS rb_auction_alerts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Identità asta
  platform         TEXT NOT NULL DEFAULT 'altro',   -- catawiki|ebay|vinted|cardmarket|subito|altro
  title            TEXT NOT NULL,                   -- nome carta / oggetto
  source_url       TEXT,                            -- link all'inserzione (aperto dal tap sulla notifica)

  -- Timing
  end_at           TIMESTAMPTZ NOT NULL,            -- fine asta (UTC)
  notify_minutes   INT NOT NULL DEFAULT 5           -- anticipo notifica in minuti
                     CHECK (notify_minutes BETWEEN 1 AND 240),

  -- Valutazione
  valuation_eur    NUMERIC(12,2),
  valuation_source TEXT DEFAULT 'manual'
                     CHECK (valuation_source IN ('manual','cardmarket')),

  -- Stato
  notified_at      TIMESTAMPTZ,                     -- push inviata (o mancata: vedi notify_result)
  notify_result    TEXT,                            -- 'sent:N' | 'no_subs' | 'missed' | 'error:…'
  dismissed        BOOL NOT NULL DEFAULT false,     -- archiviata dall'utente

  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);

-- Scan del cron: solo pending, ordinate per fine
CREATE INDEX IF NOT EXISTS rb_auction_alerts_pending_idx
  ON rb_auction_alerts (end_at)
  WHERE notified_at IS NULL AND dismissed = false;

CREATE INDEX IF NOT EXISTS rb_auction_alerts_user_idx ON rb_auction_alerts (user_id);

ALTER TABLE rb_auction_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rb_auction_alerts_own" ON rb_auction_alerts;
CREATE POLICY "rb_auction_alerts_own" ON rb_auction_alerts FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- updated_at (riusa la funzione generica di 091)
CREATE OR REPLACE FUNCTION rb_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS rb_auction_alerts_touch ON rb_auction_alerts;
CREATE TRIGGER rb_auction_alerts_touch
  BEFORE UPDATE ON rb_auction_alerts
  FOR EACH ROW EXECUTE FUNCTION rb_touch_updated_at();

COMMENT ON TABLE rb_auction_alerts IS
  'Scadenze aste caricate manualmente. Push a end_at − notify_minutes via edge function auction-alert (cron 1 min).';

-- ══════════════════════════════════════════════════════════════════════
--  CRON: tick ogni minuto → invoca edge function auction-alert
--  (deployata --no-verify-jwt; idempotente: notified_at marca l'invio).
--  pg_net necessario per net.http_post.
-- ══════════════════════════════════════════════════════════════════════
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_net;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_net non attivabile da migration: % (attivare dal dashboard Database → Extensions)', SQLERRM;
END $$;

DO $$ BEGIN
  PERFORM cron.unschedule('rb_auction_alert_tick');
EXCEPTION WHEN OTHERS THEN NULL;  -- job non ancora esistente
END $$;

DO $$ BEGIN
  PERFORM cron.schedule(
    'rb_auction_alert_tick',
    '* * * * *',
    $cron$
      SELECT net.http_post(
        url     := 'https://rbjaaeyjeeqfpbzyavag.supabase.co/functions/v1/auction-alert',
        headers := '{"Content-Type":"application/json"}'::jsonb,
        body    := '{"trigger":"pg_cron"}'::jsonb
      );
    $cron$
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'rb_auction_alert_tick schedule fallito: %', SQLERRM;
END $$;

NOTIFY pgrst, 'reload schema';
