-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Web Push subscriptions (multi-device)
--
--  Un utente può avere più subscription (desktop chrome, mobile firefox, ...)
--  Ognuna ha un endpoint unico fornito dal Push Service del browser.
--  Il VAPID key pair è uno solo lato server (env hunt-monitor).
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS hunt_push_subscriptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL,
  p256dh      TEXT NOT NULL,           -- chiave pubblica del client per ECDH
  auth        TEXT NOT NULL,           -- secret di autenticazione del client
  user_agent  TEXT,                    -- diagnostica: per identificare il device
  created_at  TIMESTAMPTZ DEFAULT now(),
  last_seen   TIMESTAMPTZ DEFAULT now(),
  failure_count INT DEFAULT 0,         -- incremento se push fallisce con 4xx
  UNIQUE(user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS hunt_push_sub_user_idx ON hunt_push_subscriptions(user_id);

-- RLS
ALTER TABLE hunt_push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_own_subs"        ON hunt_push_subscriptions;
DROP POLICY IF EXISTS "users_insert_own_subs" ON hunt_push_subscriptions;
DROP POLICY IF EXISTS "users_update_own_subs" ON hunt_push_subscriptions;
DROP POLICY IF EXISTS "users_delete_own_subs" ON hunt_push_subscriptions;

CREATE POLICY "users_own_subs"        ON hunt_push_subscriptions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "users_insert_own_subs" ON hunt_push_subscriptions FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users_update_own_subs" ON hunt_push_subscriptions FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "users_delete_own_subs" ON hunt_push_subscriptions FOR DELETE USING (auth.uid() = user_id);

COMMENT ON TABLE hunt_push_subscriptions IS
  'Web Push subscriptions per utente. Una riga per device/browser. Cancellate auto su 410 Gone.';
