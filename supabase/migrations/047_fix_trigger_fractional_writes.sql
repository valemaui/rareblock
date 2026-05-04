-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — patch trigger inv_products
--  Migration 047: aggiusta protect_vendor_product_fields per consentire
--                 update sulle colonne fractional_* dalle edge functions PR9c
--
--  CONTESTO
--  Il trigger trg_protect_vendor_product_fields (creato in PR sui vendor,
--  migration 025) blocca completamente l'UPDATE di inv_products quando
--  is_admin() ritorna FALSE. Ma is_admin() controlla auth.uid()=admin role,
--  che è NULL quando la chiamata arriva da una edge function in service_role.
--
--  Le edge functions di PR9c (fractional-vote-open, fractional-vote-close)
--  devono aggiornare colonne fractional_exit_window_status e correlate
--  come parte del loro flow di amministrazione del voto. Senza questo fix,
--  l'UPDATE è silenziosamente bloccato (RAISE EXCEPTION non sale a
--  console di Supabase Edge Function se la transazione è auto-commit
--  via supabase-js — dipende dalla config).
--
--  RISULTATO OSSERVATO PRIMA DEL FIX
--  fractional-vote-open creava la riga in inv_fractional_votes ma NON
--  aggiornava inv_products.fractional_exit_window_status='open',
--  causando la UI di non mostrare il banner "Vota ora" perché la card
--  controllava (status==='open' && active_vote_id).
--
--  STRATEGIA DEL FIX
--  Rendiamo il trigger "consapevole" che le colonne fractional_* sono
--  colonne di sistema, gestite da workflow admin (edge functions), e
--  NON sono campi vendor-editable. Il trigger deve:
--    1. Identificare se il caller è service_role (pg_role) → bypass totale
--    2. Se non è service_role né admin né vendor → blocca
--    3. Se è vendor → ripristina i campi sensibili come prima, MA NON
--       toccare i campi fractional_* (che sono fuori dal suo perimetro)
--
--  La via 1 è la più pulita: usa current_setting che è popolato dal
--  PostgREST quando la JWT contiene role=service_role.
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.protect_vendor_product_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_jwt_role TEXT;
BEGIN
  -- Bypass 1: chiamate service_role (edge functions interne) hanno bypass totale.
  -- PostgREST espone il claim "role" della JWT in request.jwt.claim.role.
  -- Quando una edge function usa SUPABASE_SERVICE_ROLE_KEY, questo è 'service_role'.
  BEGIN
    v_jwt_role := current_setting('request.jwt.claim.role', true);
  EXCEPTION WHEN OTHERS THEN
    v_jwt_role := NULL;
  END;
  IF v_jwt_role = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Bypass 2: utente admin classico (auth.uid() = profiles.role='admin')
  IF is_admin() THEN
    RETURN NEW;
  END IF;

  -- Se non è un vendor attivo, blocca completamente l'update
  IF NOT is_active_vendor() THEN
    RAISE EXCEPTION 'Solo admin o vendor possono modificare i prodotti';
  END IF;
  -- Se è vendor ma non è il proprietario del prodotto, blocca
  IF OLD.vendor_id IS NULL OR OLD.vendor_id <> current_vendor_id() THEN
    RAISE EXCEPTION 'Non puoi modificare prodotti non assegnati al tuo vendor account';
  END IF;
  -- Ripristina i campi sensibili dal valore precedente (anche se il vendor li ha modificati nella richiesta)
  NEW.id              := OLD.id;
  NEW.vendor_id       := OLD.vendor_id;
  NEW.name            := OLD.name;
  NEW.type            := OLD.type;
  NEW.status          := OLD.status;
  NEW.total_quotes    := OLD.total_quotes;
  NEW.price_per_quote := OLD.price_per_quote;
  NEW.target_date     := OLD.target_date;
  NEW.estimated_value := OLD.estimated_value;
  NEW.quote_unit      := OLD.quote_unit;
  NEW.category        := OLD.category;
  NEW.hold_years      := OLD.hold_years;
  NEW.storage_fee     := OLD.storage_fee;
  NEW.grading_house         := OLD.grading_house;
  NEW.grading_cert_number   := OLD.grading_cert_number;
  NEW.grading_cost_estimated:= OLD.grading_cost_estimated;
  NEW.created_by      := OLD.created_by;
  NEW.created_at      := OLD.created_at;
  -- Ripristina anche i campi fractional_* dal vecchio valore: il vendor non
  -- può modificarli (sono gestiti dalle edge functions admin di PR9c). Se
  -- arriva qui significa che NON è admin né service_role, quindi i campi
  -- fractional_* devono essere immutabili dal suo punto di vista.
  NEW.fractional_target_price_eur     := OLD.fractional_target_price_eur;
  NEW.fractional_exit_window_years    := OLD.fractional_exit_window_years;
  NEW.fractional_extension_years      := OLD.fractional_extension_years;
  NEW.fractional_launched_at          := OLD.fractional_launched_at;
  NEW.fractional_exit_window_status   := OLD.fractional_exit_window_status;
  NEW.fractional_exit_window_opens_at := OLD.fractional_exit_window_opens_at;
  NEW.fractional_exit_window_closes_at:= OLD.fractional_exit_window_closes_at;
  NEW.fractional_target_hit_at        := OLD.fractional_target_hit_at;
  NEW.fractional_sold_at              := OLD.fractional_sold_at;
  NEW.fractional_sold_price_eur       := OLD.fractional_sold_price_eur;
  -- Permessi vendor: description, cover_photo_url, admin_notes possono cambiare
  NEW.updated_at      := now();
  RETURN NEW;
END;
$$;

-- BACKFILL retroattivo: il prodotto di test 8a22a329-... ha vote_id valido
-- ma exit_window_status=null per il bug pre-fix. Riallineiamo lo stato
-- guardando se ha un voto attualmente aperto (closed_at IS NULL).
UPDATE public.inv_products p
SET
  fractional_exit_window_status   = 'open',
  fractional_exit_window_opens_at = v.opened_at,
  fractional_exit_window_closes_at= v.closes_at
FROM public.inv_fractional_votes v
WHERE v.product_id = p.id
  AND v.closed_at IS NULL
  AND p.type = 'fractional'
  AND p.fractional_exit_window_status IS NULL;

DO $$
DECLARE n_fixed INT;
BEGIN
  SELECT count(*) INTO n_fixed
  FROM public.inv_products p
  JOIN public.inv_fractional_votes v ON v.product_id = p.id
  WHERE p.fractional_exit_window_status = 'open'
    AND v.closed_at IS NULL;
  RAISE NOTICE '047_fix_trigger: prodotti con stato voto allineato = %', n_fixed;
END $$;

NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 047_fix_trigger_fractional_writes.sql
-- ═══════════════════════════════════════════════════════════════════════
