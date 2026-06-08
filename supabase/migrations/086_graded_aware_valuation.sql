-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Migration 086: valutazione collezione GRADED-AWARE
--
--  Bug: collection_value_compute (079) valutava OGNI carta col prezzo RAW di
--  cm_price_by_condition, incluse le carte gradate (slab PSA/BGS/CGC). Una
--  Charizard PSA 10 veniva quindi valutata al prezzo della raw → valori
--  totalmente sballati per chi ha slab in collezione.
--
--  Fix: per le carte con graded=true, usa la stima slab salvata in
--  cards.price_estimate (JSONB {value, method, house, score, ...}, popolata
--  dal flusso "Verifica slab"). Fallback in cascata se la stima manca:
--    1) price_estimate->>'value'  (stima slab calcolata)
--    2) prezzo raw per-condizione (come prima) — meglio di niente
--  Le carte RAW restano identiche a prima (nessuna regressione).
--
--  Aggiunge anche un breakdown raw/graded negli aggregati per trasparenza.
--  Idempotente (CREATE OR REPLACE). Da applicare dopo 079 e 081.
-- ═══════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.collection_value_compute(UUID);

CREATE OR REPLACE FUNCTION public.collection_value_compute(p_user UUID)
RETURNS TABLE (
  total_value   NUMERIC,
  total_cost    NUMERIC,
  n_cards       INT,
  n_valued      INT,
  n_distinct    INT,
  graded_value  NUMERIC,   -- quota di total_value proveniente da slab
  raw_value     NUMERIC,   -- quota di total_value proveniente da raw
  n_graded      INT        -- righe gradate distinte
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH col AS (
    SELECT
      c.id,
      GREATEST(COALESCE(c.qty,1),1)                              AS qty,
      COALESCE(c.buy_price,0)                                    AS buy_price,
      COALESCE(c.graded,false)                                  AS is_graded,
      public.rb_cond_label(c.condition)                         AS cond_label,
      (COALESCE(c.variant,'') ILIKE '%holo%'
        OR COALESCE(c.variant,'') ILIKE '%reverse%')            AS is_foil,
      -- estrazione robusta del valore stima slab da price_estimate (JSONB)
      CASE
        WHEN COALESCE(c.graded,false) AND c.price_estimate IS NOT NULL THEN
          NULLIF(regexp_replace(
            COALESCE(c.price_estimate->>'value',''), '[^0-9.]', '', 'g'
          ), '')::NUMERIC
        ELSE NULL
      END                                                        AS graded_est,
      public.rb_card_key(public.rb_set_id_from_name(c.set_name),
                         c.card_number, c.language,
                         c.variant, COALESCE(c.first_edition,false)) AS card_key
    FROM public.cards c
    WHERE c.user_id = p_user
  ),
  priced AS (
    SELECT
      col.*,
      -- prezzo raw per-condizione (come 079): esatta → condizione più vicina
      COALESCE(
        (SELECT pc.low1 FROM public.cm_price_by_condition pc
          WHERE pc.card_key = col.card_key
            AND pc.condition = col.cond_label
            AND pc.is_foil  = col.is_foil
          LIMIT 1),
        (SELECT pc.low1 FROM public.cm_price_by_condition pc
          WHERE pc.card_key = col.card_key
            AND pc.is_foil = col.is_foil
          ORDER BY abs(COALESCE(pc.cond_rank, public.rb_cond_rank(col.cond_label))
                       - public.rb_cond_rank(col.cond_label)) ASC,
                   pc.cond_rank ASC
          LIMIT 1)
      )                                                          AS raw_price
    FROM col
  ),
  final AS (
    SELECT
      qty, buy_price, is_graded,
      -- prezzo unitario: gradata → stima slab (se c'è) altrimenti raw; raw → raw
      CASE
        WHEN is_graded AND graded_est IS NOT NULL THEN graded_est
        ELSE raw_price
      END AS unit_price,
      -- è valutata tramite stima slab?
      (is_graded AND graded_est IS NOT NULL) AS via_graded
    FROM priced
  )
  SELECT
    COALESCE(SUM(CASE WHEN unit_price IS NOT NULL THEN unit_price*qty ELSE 0 END),0)::NUMERIC AS total_value,
    COALESCE(SUM(buy_price*qty),0)::NUMERIC                                                   AS total_cost,
    COALESCE(SUM(qty),0)::INT                                                                 AS n_cards,
    COALESCE(SUM(CASE WHEN unit_price IS NOT NULL THEN qty ELSE 0 END),0)::INT                AS n_valued,
    COUNT(*)::INT                                                                             AS n_distinct,
    COALESCE(SUM(CASE WHEN via_graded AND unit_price IS NOT NULL THEN unit_price*qty ELSE 0 END),0)::NUMERIC AS graded_value,
    COALESCE(SUM(CASE WHEN (NOT via_graded) AND unit_price IS NOT NULL THEN unit_price*qty ELSE 0 END),0)::NUMERIC AS raw_value,
    COALESCE(SUM(CASE WHEN is_graded THEN 1 ELSE 0 END),0)::INT                               AS n_graded
  FROM final;
$$;

REVOKE ALL ON FUNCTION public.collection_value_compute(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.collection_value_compute(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════
--  Verifica:
--   SELECT * FROM public.collection_value_compute('<TUO_UUID>');
--    → total_value ora separa graded_value / raw_value; n_graded conteggia le slab
--  Nota: collection_snapshot_me / _all usano collection_value_compute, quindi
--  ereditano automaticamente la valutazione graded-aware (i loro INSERT
--  prendono solo total_value/cost/counts — la firma TABLE estesa è compatibile
--  perché vi si accede per nome di colonna).
-- ═══════════════════════════════════════════════════════════════════════
