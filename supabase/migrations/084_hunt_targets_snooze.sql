-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — 084 · Snooze per-carta su hunt_targets
--  ────────────────────────────────────────────────────────────────────
--  Aggiunge la colonna `snooze_until` usata dalla nuova UX wishlist
--  (frames/wishlist.html) per mettere "in pausa fino a data" il monitoraggio
--  di una singola carta senza disattivarla del tutto (is_active resta true).
--
--  Semantica:
--    - snooze_until NULL              → nessuno snooze (comportamento normale)
--    - snooze_until > now()           → carta in pausa, esclusa da alert/scan
--    - snooze_until <= now()          → snooze scaduto, torna attiva
--
--  La UI degrada con grazia se questa colonna manca (_wlHasSnooze=false),
--  ma applicando questo migration la funzionalità snooze diventa persistente.
--
--  Idempotente e auto-sufficiente: include i prerequisiti delle colonne
--  introdotte in 069 (notes/wishlist_priority/source) con ADD COLUMN IF NOT
--  EXISTS, così è ri-eseguibile e non dipende dall'ordine di applicazione.
-- ═══════════════════════════════════════════════════════════════════════

-- ── Prerequisiti 069 (idempotenti, per auto-sufficienza) ────────────────
ALTER TABLE hunt_targets
  ADD COLUMN IF NOT EXISTS notes              TEXT,
  ADD COLUMN IF NOT EXISTS wishlist_priority  INT DEFAULT 3 CHECK (wishlist_priority BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS source             TEXT DEFAULT 'manual'
                            CHECK (source IN ('manual','wishlist','wishlist_legacy','csv_import','radar_quick'));

-- ── Nuova colonna snooze ────────────────────────────────────────────────
ALTER TABLE hunt_targets
  ADD COLUMN IF NOT EXISTS snooze_until TIMESTAMPTZ;

COMMENT ON COLUMN hunt_targets.snooze_until IS
  'Pausa monitoraggio per-carta fino a questa data (TIMESTAMPTZ). NULL = nessuno '
  'snooze. Se > now() la carta è esclusa da scan/alert pur restando is_active. '
  'Usata dalla UX wishlist (snooze rapido) e da hunt-monitor per saltare i target in pausa.';

-- ── Indice parziale: velocizza il filtro "target attivi non in pausa" ───
--  Solo le righe con snooze attivo finiscono nell'indice (parziale = leggero).
CREATE INDEX IF NOT EXISTS idx_hunt_targets_snooze_active
  ON hunt_targets (user_id, snooze_until)
  WHERE snooze_until IS NOT NULL;
