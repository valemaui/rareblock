-- ════════════════════════════════════════════════════════════════════════
--  094 · rb_index_sets() — set distinti presenti in rb_card_index
--  ----------------------------------------------------------------------
--  Problema risolto: le carte CENSITE da Cardmarket possono vivere in set
--  ASSENTI dalla TCG API (pokemontcg.io) — set giapponesi TCGdex (es. VS1
--  "Pokémon Card VS") o set sintetici. Il set-picker dei preventivi e della
--  collezione è seedato SOLO dai set pokemontcg.io, quindi quei set non erano
--  selezionabili: filtrando per "Pokémon Card VS" il picker rispondeva
--  "Set non riconosciuto" e la ricerca si bloccava a zero risultati, pur
--  essendo la carta regolarmente nell'indice.
--
--  Questa RPC ritorna l'elenco dei set distinti dell'indice così il client
--  può fonderli in msSetsAll (il dizionario dei set-picker). A differenza di
--  rb_card_index_set_coverage (091, ADMIN, pesante, per il pannello di
--  copertura), questa è leggera e aperta a QUALSIASI utente autenticato:
--  serve alla ricerca, non è un dato riservato.
--
--  Idempotente. Eseguire nel Supabase SQL Editor (progetto rbjaaeyjeeqfpbzyavag).
-- ════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.rb_index_sets();

CREATE OR REPLACE FUNCTION public.rb_index_sets()
RETURNS TABLE (
  set_id    TEXT,
  set_name  TEXT,
  n_cards   BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    set_id,
    max(set_name)  AS set_name,
    count(*)       AS n_cards
  FROM public.rb_card_index
  WHERE set_id IS NOT NULL
    AND length(trim(set_id)) > 0
    -- Escludiamo i placeholder generici che non identificano un vero set
    AND lower(set_id) NOT IN ('rbidx', 'cmcustom')
  GROUP BY set_id
  ORDER BY max(set_name) NULLS LAST, set_id;
$$;

REVOKE ALL ON FUNCTION public.rb_index_sets() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rb_index_sets() TO authenticated;

NOTIFY pgrst, 'reload schema';
