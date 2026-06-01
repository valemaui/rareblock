-- ============================================================================
-- Migration 081 — Colonne modulo Collezione: cm_url + carte gradate
-- ============================================================================
-- Contesto: il frontend (pokemon-db.html) inserisce nella tabella `cards`
-- diverse colonne opzionali che potrebbero non esistere ancora sul DB di
-- produzione (le migrazioni 078/079 che introducevano cm_url potrebbero non
-- essere state applicate). Senza queste colonne, l'inserimento di una carta
-- fallisce e il retry difensivo lato client le strippa una a una.
--
-- Questa migrazione è SELF-SUFFICIENT e IDEMPOTENTE: si può rieseguire senza
-- effetti collaterali (ADD COLUMN IF NOT EXISTS) e mette in pari tutte le
-- colonne che il modulo Collezione si aspetta.
--
-- Eseguire una volta nel Supabase SQL Editor (progetto rbjaaeyjeeqfpbzyavag).
-- ============================================================================

ALTER TABLE cards
  -- URL Cardmarket autorevole della carta (introdotto in 078/079)
  ADD COLUMN IF NOT EXISTS cm_url             text    DEFAULT NULL,
  -- Carta gradata (slab): flag + dettagli grading
  ADD COLUMN IF NOT EXISTS graded             boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS grade_company      text    DEFAULT NULL,  -- PSA / BGS / CGC / ...
  ADD COLUMN IF NOT EXISTS grade_value        text    DEFAULT NULL,  -- 10 / 9.5 / Authentic ...
  ADD COLUMN IF NOT EXISTS cert_number        text    DEFAULT NULL,  -- n° certificato (opzionale)
  -- Foto reali della slab (oggi popolate via PSA Public API)
  ADD COLUMN IF NOT EXISTS slab_image_front   text    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS slab_image_back    text    DEFAULT NULL,
  -- Stima prezzo slab calcolata (metodo + fonti + data), serializzata in JSON
  ADD COLUMN IF NOT EXISTS price_estimate     jsonb   DEFAULT NULL;

-- Indice parziale per filtrare velocemente le carte gradate in collezione
CREATE INDEX IF NOT EXISTS idx_cards_graded
  ON cards (user_id)
  WHERE graded = true;

-- IMPORTANTE: forza PostgREST a ricaricare lo schema, altrimenti l'API REST
-- continua a NON vedere le nuove colonne (cache vecchia) anche se esistono
-- nel DB — sintomo: "[supa] colonne assenti sul DB → retry senza [cm_url]".
NOTIFY pgrst, 'reload schema';

-- Verifica rapida (commentata): elenca le colonne presenti dopo la migrazione
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_name = 'cards'
--   AND column_name IN ('cm_url','graded','grade_company','grade_value',
--                       'cert_number','slab_image_front','slab_image_back','price_estimate')
-- ORDER BY column_name;
