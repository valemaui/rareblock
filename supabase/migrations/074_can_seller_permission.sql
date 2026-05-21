-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Permesso area Seller (can_seller)
--  Esegui nel Supabase SQL Editor (una volta sola).
--  Coerente con migration 011 (can_collector / can_investor), ma con
--  default FALSE: l'area Seller è una capacità OPT-IN, abilitata per
--  profilo, non attiva per tutti. L'admin la riceve sempre via override
--  applicativo (ADMIN_EMAILS / role='admin').
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Colonna permesso (default false → opt-in) ────────────────────
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS can_seller BOOLEAN NOT NULL DEFAULT FALSE;

-- Index per filtri admin (coerente con gli altri can_*)
CREATE INDEX IF NOT EXISTS profiles_can_seller_idx ON profiles(can_seller);

-- ── 2. (Opzionale) abilita Seller agli admin già presenti ───────────
-- Gli admin ottengono comunque l'area via override lato client, ma
-- allineiamo anche il dato per coerenza nei pannelli di gestione.
UPDATE profiles SET can_seller = TRUE WHERE role = 'admin';

-- Le policy RLS admin (select/update) di migration 011 coprono già
-- questa colonna: nessuna nuova policy necessaria.
