-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Modulo Fractional — POST-MVP Task 2
--  Migration 048: cron auto-apertura voti fractional
--
--  CONTESTO
--  In PR9c-d le finestre di voto exit window erano aperte solo su trigger
--  manuale (admin click in dashboard). Per un sistema HNWI in produzione
--  serve apertura automatica al raggiungimento del termine di
--  fractional_launched_at + fractional_exit_window_years (prima finestra)
--  o di fractional_exit_window_opens_at (finestre successive dopo rinvio).
--
--  IMPLEMENTAZIONE
--  Funzione PL/pgSQL `fractional_open_due_votes()` che:
--    1. Trova prodotti fractional eligible:
--       - status='open'
--       - launched_at popolato
--       - exit_window_status IN ('not_due','closed_postpone')
--       - se 'not_due': launched_at + exit_window_years <= now()
--       - se 'closed_postpone': exit_window_opens_at <= now()
--       - non c'è già un voto aperto in inv_fractional_votes
--    2. Per ognuno apre una nuova finestra di 60 giorni:
--       - calcola round_number = max+1
--       - snapshot total_eligible_quotes da inv_holdings
--       - INSERT inv_fractional_votes
--       - UPDATE inv_products status=open + opens_at + closes_at
--    3. Ritorna count e dettagli per audit
--
--  Funzione SECURITY DEFINER per bypassare il trigger
--  protect_vendor_product_fields (lo facciamo via SET LOCAL role o
--  con DISABLE TRIGGER LOCAL nella transazione).
--
--  SCHEDULING
--  Se pg_cron è abilitato (default su Supabase Pro+), la migration
--  registra un job giornaliero alle 03:00 UTC.
--  Se pg_cron NON è disponibile, la funzione resta callable manualmente
--  da admin via SQL Editor o via futuro pulsante UI admin.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Funzione di apertura automatica ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.fractional_open_due_votes()
RETURNS TABLE(
  product_id      UUID,
  product_name    TEXT,
  vote_id         UUID,
  round_number    INT,
  trigger_reason  TEXT,
  eligible_quotes INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r              RECORD;
  v_round        INT;
  v_eligible     INT;
  v_vote_id      UUID;
  v_now          TIMESTAMPTZ := now();
  v_window_days  INT := 60;
  v_reason       TEXT;
BEGIN
  -- Iteriamo sui prodotti eligible. La query scegli SOLO quelli che:
  --   - sono attualmente in stato voto-eligible (not_due / closed_postpone)
  --   - il termine è effettivamente arrivato
  --   - non hanno già un voto aperto (closed_at IS NULL)
  FOR r IN
    SELECT p.id, p.name, p.fractional_launched_at, p.fractional_exit_window_years,
           p.fractional_exit_window_status, p.fractional_exit_window_opens_at
    FROM public.inv_products p
    WHERE p.type = 'fractional'
      AND p.status = 'open'
      AND p.fractional_launched_at IS NOT NULL
      AND COALESCE(p.fractional_exit_window_status, 'not_due') IN ('not_due','closed_postpone')
      AND (
        -- Caso A: prima finestra mai aperta — usa launched_at + exit_window_years
        (p.fractional_exit_window_status IS NULL OR p.fractional_exit_window_status = 'not_due')
          AND p.fractional_exit_window_years IS NOT NULL
          AND (p.fractional_launched_at + (p.fractional_exit_window_years || ' years')::INTERVAL) <= v_now
        OR
        -- Caso B: post-rinvio — usa exit_window_opens_at (popolato in fractional-vote-close)
        p.fractional_exit_window_status = 'closed_postpone'
          AND p.fractional_exit_window_opens_at IS NOT NULL
          AND p.fractional_exit_window_opens_at <= v_now
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.inv_fractional_votes v
        WHERE v.product_id = p.id AND v.closed_at IS NULL
      )
  LOOP
    -- Trigger reason per audit
    v_reason := CASE
      WHEN r.fractional_exit_window_status = 'closed_postpone' THEN 'extension_window_due'
      ELSE 'first_exit_window_due'
    END;

    -- Snapshot quote eligible
    SELECT COALESCE(SUM(qty), 0) INTO v_eligible
    FROM public.inv_holdings
    WHERE product_id = r.id;

    -- Skip se 0 quote (nessun comproprietario): segnaliamo come closed_no_eligible
    -- per evitare di re-iterare in eterno
    IF v_eligible = 0 THEN
      -- Disabilito temporaneamente il trigger UPDATE (dentro questa transazione)
      ALTER TABLE public.inv_products DISABLE TRIGGER trg_protect_vendor_product_fields;
      UPDATE public.inv_products
      SET fractional_exit_window_status = 'closed_postpone',
          fractional_exit_window_opens_at = v_now + (COALESCE(fractional_extension_years, 2) || ' years')::INTERVAL,
          fractional_exit_window_closes_at = NULL
      WHERE id = r.id;
      ALTER TABLE public.inv_products ENABLE TRIGGER trg_protect_vendor_product_fields;
      CONTINUE;
    END IF;

    -- Calcola round_number
    SELECT COALESCE(MAX(round_number), 0) + 1 INTO v_round
    FROM public.inv_fractional_votes
    WHERE product_id = r.id;

    -- INSERT voto
    INSERT INTO public.inv_fractional_votes(
      product_id, round_number, opened_at, closes_at,
      total_eligible_quotes, opened_by
    )
    VALUES (
      r.id, v_round, v_now, v_now + (v_window_days || ' days')::INTERVAL,
      v_eligible, NULL  -- opened_by NULL = aperto da sistema (cron)
    )
    RETURNING id INTO v_vote_id;

    -- UPDATE prodotto (con bypass trigger come sopra)
    ALTER TABLE public.inv_products DISABLE TRIGGER trg_protect_vendor_product_fields;
    UPDATE public.inv_products
    SET fractional_exit_window_status   = 'open',
        fractional_exit_window_opens_at = v_now,
        fractional_exit_window_closes_at= v_now + (v_window_days || ' days')::INTERVAL
    WHERE id = r.id;
    ALTER TABLE public.inv_products ENABLE TRIGGER trg_protect_vendor_product_fields;

    -- Yield per audit/UI
    product_id      := r.id;
    product_name    := r.name;
    vote_id         := v_vote_id;
    round_number    := v_round;
    trigger_reason  := v_reason;
    eligible_quotes := v_eligible;
    RETURN NEXT;
  END LOOP;

  RETURN;
END;
$$;

GRANT EXECUTE ON FUNCTION public.fractional_open_due_votes() TO authenticated;

COMMENT ON FUNCTION public.fractional_open_due_votes() IS
  'Apre automaticamente le finestre di voto fractional al raggiungimento dell exit window. Designed per essere chiamato da pg_cron giornaliero alle 03:00 UTC. Idempotente: se non c è nulla da fare, non ritorna righe.';

-- ── 2. Tabella di audit log delle esecuzioni cron ──────────────────────
CREATE TABLE IF NOT EXISTS public.inv_fractional_cron_log (
  id              BIGSERIAL PRIMARY KEY,
  run_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  votes_opened    INT NOT NULL DEFAULT 0,
  details         JSONB,         -- array di {product_id, vote_id, reason, eligible_quotes}
  duration_ms     INT,
  source          TEXT NOT NULL DEFAULT 'pg_cron'  -- pg_cron | manual | api
);

ALTER TABLE public.inv_fractional_cron_log ENABLE ROW LEVEL SECURITY;

-- Solo admin può leggere il log (audit interno)
CREATE POLICY "fract_cron_log_admin_select" ON public.inv_fractional_cron_log
  FOR SELECT USING (public.is_admin());

CREATE INDEX IF NOT EXISTS idx_fract_cron_log_run_at ON public.inv_fractional_cron_log(run_at DESC);

-- ── 3. Wrapper "ergonomico" per pg_cron + log automatico ───────────────
CREATE OR REPLACE FUNCTION public.fractional_cron_tick()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start    TIMESTAMPTZ := clock_timestamp();
  v_results  JSONB;
  v_count    INT;
BEGIN
  -- Aggrega risultati come JSONB array
  SELECT
    jsonb_agg(jsonb_build_object(
      'product_id',      product_id,
      'product_name',    product_name,
      'vote_id',         vote_id,
      'round_number',    round_number,
      'trigger_reason',  trigger_reason,
      'eligible_quotes', eligible_quotes
    )),
    count(*)
  INTO v_results, v_count
  FROM public.fractional_open_due_votes();

  INSERT INTO public.inv_fractional_cron_log(votes_opened, details, duration_ms, source)
  VALUES (
    COALESCE(v_count, 0),
    COALESCE(v_results, '[]'::JSONB),
    EXTRACT(MILLISECOND FROM (clock_timestamp() - v_start))::INT,
    'pg_cron'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.fractional_cron_tick() TO authenticated;

-- ── 4. Schedule pg_cron job (best-effort) ──────────────────────────────
-- Su Supabase Pro+ il modulo pg_cron è già installato nello schema `cron`.
-- Su free tier non è disponibile: in quel caso questa parte fallisce
-- gracefully con DO block che cattura l errore e lo segnala come notice.
DO $$
BEGIN
  -- Verifica se pg_cron è disponibile
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Rimuovi job esistente (idempotenza)
    BEGIN
      PERFORM cron.unschedule('fractional-cron-tick');
    EXCEPTION WHEN OTHERS THEN
      -- ignore: il job non esisteva
    END;

    -- Schedule giornaliero alle 03:00 UTC
    -- Format: '0 3 * * *' = ogni giorno alle 03:00
    PERFORM cron.schedule(
      'fractional-cron-tick',
      '0 3 * * *',
      'SELECT public.fractional_cron_tick();'
    );

    RAISE NOTICE '048: pg_cron job "fractional-cron-tick" registrato (daily 03:00 UTC)';
  ELSE
    RAISE NOTICE '048: pg_cron non disponibile su questo progetto Supabase. La funzione fractional_cron_tick() resta callable manualmente. Per attivare scheduling: Database → Extensions → pg_cron, poi rieseguire questa migration.';
  END IF;
END $$;

-- ── 5. Reload + sanity ──────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

DO $$
DECLARE
  v_func_exists  BOOLEAN;
  v_log_exists   BOOLEAN;
  v_cron_exists  BOOLEAN := false;
  v_jobs_count   INT := 0;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='fractional_open_due_votes'
  ) INTO v_func_exists;

  SELECT EXISTS(
    SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='inv_fractional_cron_log'
  ) INTO v_log_exists;

  SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron') INTO v_cron_exists;

  IF v_cron_exists THEN
    SELECT count(*) INTO v_jobs_count FROM cron.job WHERE jobname='fractional-cron-tick';
  END IF;

  RAISE NOTICE '────────── 048 SUMMARY ──────────';
  RAISE NOTICE '  fractional_open_due_votes function: %', v_func_exists;
  RAISE NOTICE '  inv_fractional_cron_log table:      %', v_log_exists;
  RAISE NOTICE '  pg_cron extension installed:        %', v_cron_exists;
  RAISE NOTICE '  pg_cron job registered:             %', v_jobs_count;
END $$;

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 048_fractional_cron.sql
-- ═══════════════════════════════════════════════════════════════════════
