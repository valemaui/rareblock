-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Auto-prepare contratti per ordini pagati
--  Migration 058
--
--  CONTESTO
--  In PR5 (mark_order_paid) e PR6 (modulo contratti) il cablaggio fra
--  pagamento confermato e generazione contratto NON era stato chiuso:
--  l'admin marcava il bonifico ricevuto ma nessun contratto veniva
--  preparato. L'edge function contract-prepare risultava orfana
--  (deployata ma mai invocata da alcun call site).
--
--  DESIGN (Opzione A — frontend-driven)
--  Quando il buyer apre la tab "Contratti" nella dashboard, il client
--  rileva gli ordini in stato 'payment_received' o 'completed' che non
--  hanno ancora un contratto associato e richiama contract-prepare in
--  modo idempotente. Questa migration fornisce le primitive server-side:
--
--    1. View v_my_orders_pending_contract — espone gli ordini del caller
--       autenticato che richiedono un contratto (RLS via auth.uid()).
--
--    2. Unique partial index idx_contracts_one_active_per_order — vincolo
--       DB che impedisce la creazione di due contratti acquirente in
--       stato non-terminale (draft/pending_signature/signed) per lo
--       stesso ordine. Protegge da race condition fra tab multiple del
--       browser anche prima che il frontend completi il primo round.
--
--  IDEMPOTENZA
--  Una volta che contract-prepare INSERIsce il contratto, l'order
--  scompare automaticamente dalla view (la clausola NOT EXISTS lo
--  esclude). Gli stati terminali negativi (expired, revoked, rejected)
--  NON consentono auto-rigenerazione: in quel caso il buyer deve
--  contattare l'admin (flusso manuale, fuori scope di questa migration).
-- ═══════════════════════════════════════════════════════════════════════


-- ── 1. Unique partial index: max 1 contratto attivo per ordine/buyer ──
-- Previene race condition: se due tab del browser fanno ctrLoad in
-- contemporanea, entrambe vedrebbero lo stesso order pending e
-- chiamerebbero contract-prepare due volte. Senza questo indice, il
-- secondo INSERT andrebbe a buon fine creando un duplicato.
-- Con questo indice, il secondo INSERT fallisce con duplicate key e il
-- frontend lo gestisce silenziosamente (intent: l'altra tab ha vinto).
CREATE UNIQUE INDEX IF NOT EXISTS idx_contracts_one_active_per_order
  ON public.contracts (related_order_id, party_user_id)
  WHERE related_order_id IS NOT NULL
    AND subject_type IN ('buyer_purchase_custody','buyer_fractional')
    AND status IN ('draft','pending_signature','signed');

COMMENT ON INDEX public.idx_contracts_one_active_per_order IS
  'Garantisce massimo un contratto buyer non-terminale per coppia (order, user). Necessario per idempotenza dell''auto-prepare lato frontend.';


-- ── 2. View v_my_orders_pending_contract ──────────────────────────────
-- Espone gli ordini del caller autenticato che soddisfano TUTTE queste
-- condizioni:
--   - sono in stato 'payment_received' (admin ha confermato il bonifico)
--     oppure 'completed' (holding emesso, ordine chiuso)
--   - NON hanno alcun contratto buyer associato in stato non-terminale
--     (draft / pending_signature / signed)
--
-- Include i dati del prodotto necessari al frontend per costruire il
-- payload subject_data corretto in base al tipo Modalità A vs B:
--   - product_type: 'full' / 'grade_hold' → BUYER_PURCHASE_CUSTODY
--                   'fractional' / 'millesimal' → BUYER_FRACTIONAL
--   - per la Modalità B: total_quotes + target_price + exit_window_years
--
-- Sicurezza: filtro user_id = auth.uid() integrato. La view eredita
-- security_invoker dal default per le view pre-PG15; per esplicitarlo
-- usiamo WITH (security_invoker = true) (supportato in PG15+, Supabase
-- gira PG15.x).
DROP VIEW IF EXISTS public.v_my_orders_pending_contract;

CREATE VIEW public.v_my_orders_pending_contract
WITH (security_invoker = true)
AS
SELECT
  o.id                              AS order_id,
  o.order_number,
  o.user_id,
  o.product_id,
  o.qty,
  o.unit_price,
  o.subtotal,
  o.discount_amount,
  o.total                           AS amount_eur,
  o.status                          AS order_status,
  o.payment_method,
  o.paid_at,
  o.created_at                      AS ordered_at,

  -- Dati prodotto necessari al template
  p.name                            AS product_name,
  p.type                            AS product_type,
  p.set_name                        AS product_set_name,
  p.total_quotes                    AS product_total_quotes,
  p.fractional_target_price_eur     AS product_target_price_eur,
  p.fractional_exit_window_years    AS product_exit_window_years
FROM public.inv_orders o
JOIN public.inv_products p ON p.id = o.product_id
WHERE o.user_id = auth.uid()
  AND o.status IN ('payment_received', 'completed')
  AND NOT EXISTS (
    SELECT 1
    FROM public.contracts c
    WHERE c.related_order_id = o.id
      AND c.party_user_id    = o.user_id
      AND c.subject_type     IN ('buyer_purchase_custody','buyer_fractional')
      AND c.status           IN ('draft','pending_signature','signed')
  )
ORDER BY o.paid_at DESC NULLS LAST, o.created_at DESC;

GRANT SELECT ON public.v_my_orders_pending_contract TO authenticated;

COMMENT ON VIEW public.v_my_orders_pending_contract IS
  'Ordini del caller autenticato (auth.uid()) in stato payment_received/completed senza contratto attivo associato. Consumata dal frontend per auto-triggerare contract-prepare quando il buyer apre la tab Contratti.';


-- ── 3. Sanity ─────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

DO $$
DECLARE
  v_idx_exists BOOLEAN;
  v_view_exists BOOLEAN;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='idx_contracts_one_active_per_order'
  ) INTO v_idx_exists;
  SELECT EXISTS(
    SELECT 1 FROM pg_views
    WHERE schemaname='public' AND viewname='v_my_orders_pending_contract'
  ) INTO v_view_exists;

  RAISE NOTICE '────────── 058 SUMMARY ──────────';
  RAISE NOTICE '  Unique partial index:     %', CASE WHEN v_idx_exists  THEN 'OK' ELSE 'MISSING' END;
  RAISE NOTICE '  View pending_contract:    %', CASE WHEN v_view_exists THEN 'OK' ELSE 'MISSING' END;
END $$;

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 058_pending_contracts_autoprepare.sql
-- ═══════════════════════════════════════════════════════════════════════
