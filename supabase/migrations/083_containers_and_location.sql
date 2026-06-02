-- ============================================================================
-- Migration 083 — Contenitori censibili + ubicazione carta
-- ============================================================================
-- Sistema di "contenitori" (raccoglitore, album, scatolo, altro) dove il
-- collezionista custodisce fisicamente le carte. I contenitori sono censibili
-- perché crescono nel tempo e variano per collezionista, quindi tabella
-- dedicata con CRUD, non un enum fisso.
--
-- Ogni carta può essere associata a un contenitore (cards.container_id), più
-- una nota di posizione libera (cards.location_note, es. "pagina 3, slot 2").
--
-- Idempotente. Eseguire una volta nel Supabase SQL Editor.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.containers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,                       -- "Raccoglitore Base Set", "Scatolo slab"
  kind        TEXT NOT NULL DEFAULT 'raccoglitore', -- 'raccoglitore' | 'album' | 'scatolo' | 'altro'
  note        TEXT,
  color       TEXT,                                 -- accento opzionale per UI
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS containers_user_idx ON public.containers (user_id);

ALTER TABLE public.containers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS containers_select_own ON public.containers;
CREATE POLICY containers_select_own ON public.containers
  FOR SELECT USING (user_id = auth.uid());
DROP POLICY IF EXISTS containers_insert_own ON public.containers;
CREATE POLICY containers_insert_own ON public.containers
  FOR INSERT WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS containers_update_own ON public.containers;
CREATE POLICY containers_update_own ON public.containers
  FOR UPDATE USING (user_id = auth.uid());
DROP POLICY IF EXISTS containers_delete_own ON public.containers;
CREATE POLICY containers_delete_own ON public.containers
  FOR DELETE USING (user_id = auth.uid());

-- Ubicazione sulla carta: contenitore (FK soft: ON DELETE SET NULL) + nota
ALTER TABLE public.cards
  ADD COLUMN IF NOT EXISTS container_id   UUID REFERENCES public.containers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS location_note  TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS cards_container_idx ON public.cards (container_id);

NOTIFY pgrst, 'reload schema';
