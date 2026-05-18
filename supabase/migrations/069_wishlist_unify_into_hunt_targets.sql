-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — 069 · Wishlist unificata in hunt_targets
--  ────────────────────────────────────────────────────────────────────
--  La vecchia tabella `wishlist` aveva uno schema povero (name/set/cond/
--  max_price/cm_avg30/notes) e duplicava di fatto i dati di `hunt_targets`.
--  Questo migration:
--    1. Aggiunge a hunt_targets le colonne mancanti per assorbire le
--       semantiche wishlist (notes, priority, source)
--    2. Copia le righe esistenti di `wishlist` dentro `hunt_targets` con
--       is_active=false, source='wishlist_legacy'
--    3. NON droppa `wishlist` (safety: rollback rapido). Verrà rimossa in
--       un futuro migration "070_wishlist_drop" dopo verifica produzione.
--
--  Idempotente: rieseguibile senza side-effects (IF NOT EXISTS + ON CONFLICT).
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Colonne nuove su hunt_targets ────────────────────────────────────
ALTER TABLE hunt_targets
  ADD COLUMN IF NOT EXISTS notes              TEXT,
  ADD COLUMN IF NOT EXISTS wishlist_priority  INT DEFAULT 3 CHECK (wishlist_priority BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS source             TEXT DEFAULT 'manual'
                            CHECK (source IN ('manual','wishlist','wishlist_legacy','csv_import','radar_quick'));

COMMENT ON COLUMN hunt_targets.notes IS
  'Note libere utente (ex wishlist.notes). Visibile in entrambe le UI.';
COMMENT ON COLUMN hunt_targets.wishlist_priority IS
  'Priorità 1 (più bassa) - 5 (più alta). Usata per sort nella vista wishlist.';
COMMENT ON COLUMN hunt_targets.source IS
  'Tracking della provenienza: distingue target creati dal radar (manual) '
  'da quelli creati dalla wishlist (wishlist) e dalla migrazione legacy.';

CREATE INDEX IF NOT EXISTS hunt_targets_priority_idx
  ON hunt_targets(wishlist_priority DESC) WHERE wishlist_priority IS NOT NULL;

-- ── 2. Migrazione dati legacy wishlist → hunt_targets ───────────────────
--    Eseguita solo se la tabella wishlist esiste (gate via to_regclass)
--    e solo per righe non ancora migrate (anti-duplicato su user+name+set_name).
DO $$
DECLARE
  v_migrated INT := 0;
BEGIN
  IF to_regclass('public.wishlist') IS NULL THEN
    RAISE NOTICE '[069] Tabella wishlist non esiste, skip migrazione dati.';
    RETURN;
  END IF;

  INSERT INTO hunt_targets (
    user_id, card_name, set_name, language,
    max_price, ref_price_cm, notes, source,
    is_active, deal_threshold, wishlist_priority,
    created_at, updated_at
  )
  SELECT
    w.user_id,
    w.name,
    w.set_name,
    -- Lingua: la vecchia wishlist usava 'ITA'/'ENG'/etc., compatibile con hunt_targets
    COALESCE(w.language, 'ANY'),
    w.max_price,
    w.cm_avg30,
    -- Note: conserviamo la condizione richiesta + le note utente
    NULLIF(trim(BOTH FROM
      COALESCE('Condizione preferita: ' || w.condition || E'\n', '') ||
      COALESCE(w.notes, '')
    ), ''),
    'wishlist_legacy',
    false,                   -- migrate as inactive: l'utente sceglie cosa riattivare
    70,                      -- soglia deal default
    3,                       -- priorità media default
    COALESCE(w.created_at, now()),
    now()
  FROM wishlist w
  WHERE NOT EXISTS (
    -- Anti-duplicato: se per quell'utente esiste già un target con stesso
    -- card_name (case-insensitive) e set_name compatibile, non re-inserire.
    SELECT 1 FROM hunt_targets ht
    WHERE ht.user_id = w.user_id
      AND lower(ht.card_name) = lower(w.name)
      AND (
        ht.set_name IS NOT DISTINCT FROM w.set_name
        OR (ht.set_name IS NULL AND w.set_name IS NULL)
      )
  );

  GET DIAGNOSTICS v_migrated = ROW_COUNT;
  RAISE NOTICE '[069] Migrate % righe da wishlist a hunt_targets.', v_migrated;
END $$;

-- ── 3. View di compatibilità (frame wishlist legge questa) ──────────────
--    Espone hunt_targets con alias compatibili con il nuovo frame wishlist.
--    Nota: NON è un MATERIALIZED VIEW, è una vista live.
CREATE OR REPLACE VIEW hunt_targets_wishlist AS
SELECT
  id,
  user_id,
  card_name,
  card_number,
  set_id,
  set_name,
  tcg_id,
  language,
  variant,
  first_edition,
  shadowless,
  grading_house,
  min_grade,
  extra_keywords,
  max_price,
  ref_price_cm,
  deal_threshold,
  is_active,
  last_scan_at,
  total_found,
  notes,
  wishlist_priority,
  source,
  created_at,
  updated_at,
  -- Derivati per UI
  CASE
    WHEN grading_house IS NOT NULL THEN 'graded'
    ELSE 'raw'
  END AS mode
FROM hunt_targets;

GRANT SELECT ON hunt_targets_wishlist TO authenticated;

-- ── 4. Verifica integrità ───────────────────────────────────────────────
--    Stampa il count post-migrazione (per debug in SQL Editor)
DO $$
DECLARE
  v_wish_legacy INT;
  v_wish_total  INT;
  v_targets     INT;
BEGIN
  SELECT COUNT(*) INTO v_targets FROM hunt_targets;
  SELECT COUNT(*) INTO v_wish_legacy FROM hunt_targets WHERE source='wishlist_legacy';

  IF to_regclass('public.wishlist') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_wish_total FROM wishlist;
    RAISE NOTICE '[069] STATE  wishlist(legacy)=% hunt_targets(total)=% hunt_targets(from_wishlist)=%',
      v_wish_total, v_targets, v_wish_legacy;
  ELSE
    RAISE NOTICE '[069] STATE  hunt_targets(total)=% hunt_targets(from_wishlist)=%',
      v_targets, v_wish_legacy;
  END IF;
END $$;
