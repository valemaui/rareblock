-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Migration 087: data di acquisto per-carta
--
--  Feedback #1: quando si aggiunge un preventivo in collezione, la data di
--  acquisto (dealDate) finiva solo nel deal_info del preventivo e nel testo
--  delle note, mai come campo strutturato sulle carte. Così non era
--  filtrabile/ordinabile né visibile nella scheda carta.
--
--  Aggiunge cards.purchase_date (DATE). Valorizzata in blocco dalla conversione
--  preventivo→collezione (una data per tutte le carte di quel preventivo) e
--  modificabile per singola carta dal modal di edit.
--  Idempotente. NOTIFY pgrst per ricaricare la cache PostgREST.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.cards
  ADD COLUMN IF NOT EXISTS purchase_date DATE DEFAULT NULL;

-- Indice per ordinamento/filtri per data di acquisto (parziale: solo righe valorizzate)
CREATE INDEX IF NOT EXISTS idx_cards_purchase_date
  ON public.cards (user_id, purchase_date)
  WHERE purchase_date IS NOT NULL;

NOTIFY pgrst, 'reload schema';

-- Verifica:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name='cards' AND column_name='purchase_date';
