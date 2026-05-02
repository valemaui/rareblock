-- ============================================================================
-- 027_quote_slots.sql — Numerazione quote per prodotti fractional
-- ============================================================================
-- Modello (concordato con utente):
--  · Selezione numeri POST-PAGAMENTO con TTL reservation 24h
--  · Numeri 1-based, label '#01'..'#36' (padding 2 cifre per ordering)
--  · Slot auto-seeded al momento della creazione del prodotto fractional
--
-- Componenti:
--  1. Tabella inv_quote_slots (1 riga per slot)
--  2. Trigger seed automatico alla creazione di prodotti fractional
--  3. RPC claim_slots(holding_id, slot_numbers[]) — assegnazione atomica
--  4. RPC release_expired_reservations() — pulizia TTL scaduti
--  5. Vista v_inv_product_slots_summary
--  6. RLS policies
-- ============================================================================

-- ── 1. inv_quote_slots ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.inv_quote_slots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id      UUID NOT NULL REFERENCES public.inv_products(id) ON DELETE CASCADE,
  slot_number     INT  NOT NULL CHECK (slot_number >= 1),
  status          TEXT NOT NULL DEFAULT 'available'
                  CHECK (status IN ('available','reserved','assigned')),
  -- Quando assigned: link alla holding del proprietario
  holding_id      UUID REFERENCES public.inv_holdings(id) ON DELETE SET NULL,
  user_id         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Quando reserved: scadenza per liberazione automatica
  reserved_until  TIMESTAMPTZ,
  reserved_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Audit
  assigned_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Vincoli: un solo slot per (product_id, slot_number)
  UNIQUE (product_id, slot_number)
);

CREATE INDEX IF NOT EXISTS inv_quote_slots_product_idx ON public.inv_quote_slots(product_id, status);
CREATE INDEX IF NOT EXISTS inv_quote_slots_holding_idx ON public.inv_quote_slots(holding_id) WHERE holding_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inv_quote_slots_user_idx ON public.inv_quote_slots(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inv_quote_slots_reserved_idx ON public.inv_quote_slots(reserved_until) WHERE status='reserved';

-- Trigger updated_at
CREATE OR REPLACE FUNCTION public.touch_inv_quote_slots_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_inv_quote_slots_updated_at ON public.inv_quote_slots;
CREATE TRIGGER trg_inv_quote_slots_updated_at
  BEFORE UPDATE ON public.inv_quote_slots
  FOR EACH ROW EXECUTE FUNCTION public.touch_inv_quote_slots_updated_at();


-- ── 2. Seed automatico alla creazione del prodotto ────────────────────────
-- Quando viene inserito un prodotto fractional/millesimal con total_quotes > 1,
-- crea automaticamente N slot 1..total_quotes in stato 'available'.
-- Idempotente: se già esistono slot per il prodotto, non duplica.
CREATE OR REPLACE FUNCTION public.seed_quote_slots_for_product(p_product_id UUID)
RETURNS INT AS $$
DECLARE
  v_total INT;
  v_type  TEXT;
  v_existing INT;
  v_inserted INT := 0;
BEGIN
  SELECT total_quotes, type INTO v_total, v_type
  FROM public.inv_products WHERE id = p_product_id;
  IF v_total IS NULL OR v_total < 2 THEN
    RETURN 0;  -- Full ownership o prodotto malformato: niente slot
  END IF;
  -- Solo per fractional/millesimal: questi sono i tipi con quote multiple.
  IF v_type NOT IN ('fractional','millesimal') THEN
    RETURN 0;
  END IF;
  -- Quanti slot esistono già?
  SELECT COUNT(*) INTO v_existing FROM public.inv_quote_slots WHERE product_id = p_product_id;
  IF v_existing >= v_total THEN
    RETURN 0;  -- già seeded
  END IF;
  -- Inserisci i mancanti (gestisce anche aumento di total_quotes nel tempo)
  INSERT INTO public.inv_quote_slots (product_id, slot_number, status)
  SELECT p_product_id, n, 'available'
  FROM generate_series(v_existing + 1, v_total) n
  ON CONFLICT (product_id, slot_number) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger AFTER INSERT/UPDATE su inv_products
CREATE OR REPLACE FUNCTION public.trg_seed_slots_on_product()
RETURNS TRIGGER AS $$
BEGIN
  -- Esegui seed in best-effort: errori non bloccano insert/update prodotto
  BEGIN
    PERFORM public.seed_quote_slots_for_product(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'seed_quote_slots_for_product failed for %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_inv_products_seed_slots ON public.inv_products;
CREATE TRIGGER trg_inv_products_seed_slots
  AFTER INSERT OR UPDATE OF total_quotes, type ON public.inv_products
  FOR EACH ROW EXECUTE FUNCTION public.trg_seed_slots_on_product();

-- Backfill: seed per prodotti già esistenti
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM public.inv_products WHERE type IN ('fractional','millesimal') AND total_quotes > 1 LOOP
    PERFORM public.seed_quote_slots_for_product(r.id);
  END LOOP;
END$$;


-- ── 3. RPC claim_slots — assegnazione atomica ─────────────────────────────
-- Chiamata dal frontend quando l'utente conferma la selezione dei numeri.
-- Verifica che:
--   · L'utente sia il proprietario della holding
--   · Tutti gli slot richiesti siano available o riservati dall'utente stesso
--   · Il numero di slot richiesti corrisponda alla qty della holding
--   · Il prodotto della holding combaci con quello degli slot
-- Usa SELECT FOR UPDATE per prevenire race condition.
--
-- DROP esplicito: un CREATE OR REPLACE FUNCTION non può cambiare la
-- signature dei parametri di OUTPUT in PostgreSQL — serve DROP+CREATE
-- quando si modifica RETURNS TABLE(...). Idempotente con IF EXISTS.
DROP FUNCTION IF EXISTS public.claim_slots(UUID, INT[]);
CREATE FUNCTION public.claim_slots(
  p_holding_id UUID,
  p_slot_numbers INT[]
) RETURNS TABLE(out_slot_number INT, out_status TEXT) AS $$
DECLARE
  v_holding   public.inv_holdings%ROWTYPE;
  v_user_id   UUID := auth.uid();
  v_count     INT;
  v_existing_count INT;
BEGIN
  -- Verifica autenticazione
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Non autenticato' USING ERRCODE = '42501';
  END IF;
  -- Carica holding e verifica ownership
  SELECT * INTO v_holding FROM public.inv_holdings WHERE id = p_holding_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Holding % non trovata', p_holding_id USING ERRCODE = '02000';
  END IF;
  IF v_holding.user_id <> v_user_id THEN
    RAISE EXCEPTION 'Non autorizzato per questa holding' USING ERRCODE = '42501';
  END IF;
  -- Verifica numero slot richiesti coerente con holding:
  -- · v_count > 0
  -- · qty_già_assegnata + v_count <= holding.qty
  -- (così l'utente può completare progressivamente la sua holding senza
  --  dover scegliere tutti i numeri in un'unica sessione)
  v_count := array_length(p_slot_numbers, 1);
  IF v_count IS NULL OR v_count <= 0 THEN
    RAISE EXCEPTION 'Devi selezionare almeno 1 numero'
      USING ERRCODE = '23514';
  END IF;
  -- Slot già assegnati a questa holding (per consentire completamento parziale)
  SELECT COUNT(*) INTO v_existing_count
  FROM public.inv_quote_slots s
  WHERE s.holding_id = p_holding_id AND s.status = 'assigned';
  IF v_existing_count + v_count > v_holding.qty THEN
    RAISE EXCEPTION 'Selezione eccede la qty della quota: % già assegnati + % nuovi > % totali',
      v_existing_count, v_count, v_holding.qty
      USING ERRCODE = '23514';
  END IF;
  -- I nuovi slot richiesti NON possono coincidere con quelli già assegnati
  -- a questa holding (sarebbe un duplicato logico dello stesso numero)
  IF EXISTS (
    SELECT 1 FROM public.inv_quote_slots s
    WHERE s.holding_id = p_holding_id
      AND s.status = 'assigned'
      AND s.slot_number = ANY(p_slot_numbers)
  ) THEN
    RAISE EXCEPTION 'Uno o più numeri sono già assegnati a questa quota'
      USING ERRCODE = '23505';
  END IF;
  -- Lock degli slot richiesti per evitare race condition
  PERFORM 1 FROM public.inv_quote_slots s
   WHERE s.product_id = v_holding.product_id
     AND s.slot_number = ANY(p_slot_numbers)
   FOR UPDATE;
  -- Verifica che siano tutti claimable: available, OPPURE riservati dallo stesso utente
  IF EXISTS (
    SELECT 1 FROM public.inv_quote_slots s
     WHERE s.product_id = v_holding.product_id
       AND s.slot_number = ANY(p_slot_numbers)
       AND NOT (
         s.status = 'available'
         OR (s.status = 'reserved' AND s.reserved_by = v_user_id AND (s.reserved_until IS NULL OR s.reserved_until > now()))
       )
  ) THEN
    RAISE EXCEPTION 'Uno o più numeri non sono più disponibili. Aggiorna la pagina.'
      USING ERRCODE = '23505';
  END IF;
  -- Verifica che esistano tutti gli slot richiesti
  IF (SELECT COUNT(*) FROM public.inv_quote_slots s
       WHERE s.product_id = v_holding.product_id AND s.slot_number = ANY(p_slot_numbers)) <> v_count THEN
    RAISE EXCEPTION 'Numeri non validi per questo prodotto'
      USING ERRCODE = '22023';
  END IF;
  -- Assegna
  UPDATE public.inv_quote_slots AS s
     SET status = 'assigned',
         holding_id = p_holding_id,
         user_id = v_user_id,
         assigned_at = now(),
         reserved_until = NULL,
         reserved_by = NULL
   WHERE s.product_id = v_holding.product_id
     AND s.slot_number = ANY(p_slot_numbers);

  RETURN QUERY
    SELECT s.slot_number, s.status
    FROM public.inv_quote_slots s
    WHERE s.holding_id = p_holding_id
    ORDER BY s.slot_number;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ── 4. RPC reserve_slots_temp — reserve TTL durante selezione ─────────────
-- Frontend chiama questa quando l'utente seleziona slot ma non ha ancora confermato.
-- Permette al server di tenere "in lavorazione" gli slot per max 10 minuti,
-- evitando che altri li prendano mentre l'utente decide.
CREATE OR REPLACE FUNCTION public.reserve_slots_temp(
  p_product_id UUID,
  p_slot_numbers INT[],
  p_ttl_minutes INT DEFAULT 10
) RETURNS INT AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_updated INT := 0;
  v_until TIMESTAMPTZ;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Non autenticato' USING ERRCODE = '42501';
  END IF;
  v_until := now() + (p_ttl_minutes || ' minutes')::interval;
  -- Libera prima eventuali reservation precedenti dell'utente sullo stesso prodotto
  UPDATE public.inv_quote_slots
     SET status='available', reserved_until=NULL, reserved_by=NULL
   WHERE product_id = p_product_id
     AND status='reserved'
     AND reserved_by = v_user_id;
  -- Riserva i nuovi slot (solo se available)
  UPDATE public.inv_quote_slots
     SET status='reserved', reserved_until = v_until, reserved_by = v_user_id
   WHERE product_id = p_product_id
     AND slot_number = ANY(p_slot_numbers)
     AND status = 'available';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ── 5. RPC release_expired_reservations — pulizia TTL scaduti ─────────────
-- Chiamata da cron o on-demand prima delle operazioni sensibili.
CREATE OR REPLACE FUNCTION public.release_expired_reservations()
RETURNS INT AS $$
DECLARE v_count INT;
BEGIN
  UPDATE public.inv_quote_slots
     SET status='available', reserved_until=NULL, reserved_by=NULL
   WHERE status='reserved'
     AND reserved_until IS NOT NULL
     AND reserved_until < now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ── 6. RPC admin_release_holding_slots — admin può liberare slot ─────────
-- Caso d'uso: holding cancellata, errore, riassegnazione.
CREATE OR REPLACE FUNCTION public.admin_release_holding_slots(p_holding_id UUID)
RETURNS INT AS $$
DECLARE
  v_count INT;
  v_is_admin BOOLEAN;
BEGIN
  SELECT COALESCE(p.is_admin, false) INTO v_is_admin
  FROM public.profiles p WHERE p.id = auth.uid();
  IF NOT v_is_admin THEN
    RAISE EXCEPTION 'Solo admin' USING ERRCODE = '42501';
  END IF;
  UPDATE public.inv_quote_slots
     SET status='available', holding_id=NULL, user_id=NULL,
         assigned_at=NULL, reserved_until=NULL, reserved_by=NULL
   WHERE holding_id = p_holding_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ── 7. Vista v_inv_product_slots_summary ──────────────────────────────────
DROP VIEW IF EXISTS public.v_inv_product_slots_summary;
CREATE VIEW public.v_inv_product_slots_summary AS
SELECT
  p.id                                                                AS product_id,
  p.total_quotes                                                      AS total_slots,
  COUNT(s.id) FILTER (WHERE s.status = 'available')                   AS available_count,
  COUNT(s.id) FILTER (WHERE s.status = 'reserved' AND (s.reserved_until IS NULL OR s.reserved_until > now())) AS reserved_count,
  COUNT(s.id) FILTER (WHERE s.status = 'assigned')                    AS assigned_count
FROM public.inv_products p
LEFT JOIN public.inv_quote_slots s ON s.product_id = p.id
WHERE p.type IN ('fractional','millesimal')
GROUP BY p.id, p.total_quotes;

GRANT SELECT ON public.v_inv_product_slots_summary TO authenticated;


-- ── 8. RLS policies ───────────────────────────────────────────────────────
ALTER TABLE public.inv_quote_slots ENABLE ROW LEVEL SECURITY;

-- Lettura pubblica (autenticati): tutti possono vedere lo stato available/reserved/assigned
-- per scegliere correttamente al checkout. user_id e holding_id restano visibili
-- agli admin e all'owner; per gli altri utenti questi campi non sono leggibili tramite
-- una vista filtrata (qui RLS lascia tutto leggibile per semplicità — le info sensibili
-- sono solo l'associazione user→slot, che possiamo nascondere via vista anonimizzata se serve).
DROP POLICY IF EXISTS inv_quote_slots_read_all ON public.inv_quote_slots;
CREATE POLICY inv_quote_slots_read_all ON public.inv_quote_slots
  FOR SELECT TO authenticated USING (true);

-- Scrittura: solo via RPC (security definer) — nessuno scrive direttamente.
DROP POLICY IF EXISTS inv_quote_slots_admin_write ON public.inv_quote_slots;
CREATE POLICY inv_quote_slots_admin_write ON public.inv_quote_slots
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true)
  );

-- Privilegi RPC
GRANT EXECUTE ON FUNCTION public.claim_slots(UUID, INT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_slots_temp(UUID, INT[], INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_expired_reservations() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_release_holding_slots(UUID) TO authenticated;

-- ============================================================================
-- FINE 027_quote_slots.sql
-- ============================================================================
