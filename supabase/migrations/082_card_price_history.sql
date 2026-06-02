-- ============================================================================
-- Migration 082 — Storico prezzi per singola carta in collezione
-- ============================================================================
-- Obiettivo: alimentare il mini-grafico di andamento prezzo nella scheda di
-- dettaglio. A differenza di cm_condition_history (product-level, per card_key),
-- questa traccia la COPIA SPECIFICA del collezionista (cards.id), così il
-- grafico riflette la singola carta — incluse le gradate, il cui valore non è
-- il prezzo CM raw ma la stima slab.
--
-- Si popola in due modi:
--   1) ad ogni "Aggiorna prezzo / Ricalcola stima" manuale dalla scheda;
--   2) (futuro) dal cron settimanale di aggiornamento prezzi.
--
-- Il prezzo di ACQUISTO non si salva qui: è già su cards.buy_price e viene
-- disegnato come linea di riferimento orizzontale ("Prezzo 0") nel grafico.
--
-- Righe leggere (~poche decine di byte): nessun limite di retention, teniamo
-- tutto lo storico (anche 2 anni = ~100 righe/carta col cron settimanale).
--
-- Idempotente. Eseguire una volta nel Supabase SQL Editor.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.card_price_history (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  card_id      UUID NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE,
  user_id      UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  captured_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  price        NUMERIC(12,2) NOT NULL,            -- valore di mercato/stima al momento
  source       TEXT NOT NULL DEFAULT 'manual',    -- 'manual' | 'cron' | 'estimate'
  method       TEXT,                              -- per gradate: 'crossed' | 'cm' | null
  note         TEXT
);

CREATE INDEX IF NOT EXISTS card_price_history_card_idx
  ON public.card_price_history (card_id, captured_at);
CREATE INDEX IF NOT EXISTS card_price_history_user_idx
  ON public.card_price_history (user_id);

-- RLS: ogni utente vede/scrive solo lo storico delle proprie carte.
ALTER TABLE public.card_price_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cph_select_own ON public.card_price_history;
CREATE POLICY cph_select_own ON public.card_price_history
  FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS cph_insert_own ON public.card_price_history;
CREATE POLICY cph_insert_own ON public.card_price_history
  FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS cph_delete_own ON public.card_price_history;
CREATE POLICY cph_delete_own ON public.card_price_history
  FOR DELETE USING (user_id = auth.uid());

-- Forza PostgREST a ricaricare lo schema (vedi nota in migr. 081)
NOTIFY pgrst, 'reload schema';
