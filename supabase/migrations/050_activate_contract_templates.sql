-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — POST-MVP Task 1
--  Migration 050: attivazione template contratti in produzione
--
--  CONTESTO
--  In PR6/PR9b sono stati creati 3 template DRAFT (is_active=false):
--    - VENDOR_MANDATE_V1            (mandato a vendere con custodia)
--    - BUYER_PURCHASE_CUSTODY_V1    (compravendita Modalità A)
--    - BUYER_FRACTIONAL_V1          (compravendita Modalità B comproprietà)
--
--  Questa migration:
--    1. Crea tabella audit contract_template_activations per tracciare
--       chi/quando/cosa attiva o disattiva un template (audit forense)
--    2. Definisce funzione activate_contract_template() / deactivate_*
--       che incapsulano la transition con audit log automatico
--    3. Attiva i 3 template in produzione con review_by = 'Studio Legale
--       RareBlock' (audit dichiarato dal management)
--
--  IMPORTANTE
--  Una volta attivati, i template diventano disponibili per la generazione
--  di contratti reali via fractional-vote-prepare / contract-prepare.
--  Le firme apposte sui contratti generati da questi template hanno valore
--  legale ai sensi dell'art. 2702 c.c. (FEA con OTP).
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Tabella audit attivazioni ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.contract_template_activations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id     UUID NOT NULL REFERENCES public.contract_templates(id) ON DELETE CASCADE,
  template_code   TEXT NOT NULL,    -- denormalizzato per audit pulito anche se template eliminato
  template_version INT  NOT NULL,
  action          TEXT NOT NULL CHECK (action IN ('activate','deactivate')),
  performed_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  performed_by_email TEXT,          -- denormalizzato per leggibilità
  legal_review_by   TEXT,           -- nome studio legale dichiarato all'attivazione
  legal_review_date DATE,
  legal_review_notes TEXT,
  reason          TEXT,              -- per disattivazioni: motivo (es. "errore clausola X, sostituito con V2")
  performed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_template_act_template
  ON public.contract_template_activations(template_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_template_act_recent
  ON public.contract_template_activations(performed_at DESC);

ALTER TABLE public.contract_template_activations ENABLE ROW LEVEL SECURITY;

-- Solo admin può leggere il log di attivazioni (audit interno)
CREATE POLICY "tpl_act_admin_select" ON public.contract_template_activations
  FOR SELECT USING (public.is_admin());

-- INSERT denied per default → solo via funzioni SECURITY DEFINER

COMMENT ON TABLE public.contract_template_activations IS
  'Audit log delle transition is_active dei template contratto. Una riga per ogni activate/deactivate. Mantenuto come prova forense in caso di contestazioni sulla validità di contratti firmati durante una specifica finestra di attivazione.';

-- ── 2. Funzione di attivazione ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.activate_contract_template(
  p_code             TEXT,
  p_version          INT,
  p_legal_review_by  TEXT,
  p_legal_review_date DATE DEFAULT CURRENT_DATE,
  p_legal_review_notes TEXT DEFAULT NULL
)
RETURNS UUID  -- template_id attivato
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_template_id UUID;
  v_was_active  BOOLEAN;
  v_uid         UUID := auth.uid();
  v_email       TEXT;
BEGIN
  -- Solo admin può attivare (oppure service_role per chiamate sistema)
  IF NOT (public.is_admin() OR current_setting('request.jwt.claim.role', true) = 'service_role') THEN
    RAISE EXCEPTION 'activate_contract_template: solo admin può attivare un template';
  END IF;
  IF p_legal_review_by IS NULL OR p_legal_review_by = '' THEN
    RAISE EXCEPTION 'activate_contract_template: legal_review_by è obbligatorio per audit';
  END IF;

  -- Recupera template
  SELECT id, is_active INTO v_template_id, v_was_active
  FROM public.contract_templates
  WHERE code = p_code AND version = p_version;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'activate_contract_template: template % v% non trovato', p_code, p_version;
  END IF;

  IF v_was_active THEN
    RAISE NOTICE 'Template % v% già attivo, no-op', p_code, p_version;
    RETURN v_template_id;
  END IF;

  -- Email caller (per audit log)
  IF v_uid IS NOT NULL THEN
    SELECT email INTO v_email FROM auth.users WHERE id = v_uid;
  END IF;

  -- UPDATE template
  UPDATE public.contract_templates
  SET
    is_active          = true,
    legal_review_by    = p_legal_review_by,
    legal_review_date  = p_legal_review_date,
    legal_review_notes = p_legal_review_notes
  WHERE id = v_template_id;

  -- INSERT audit row
  INSERT INTO public.contract_template_activations(
    template_id, template_code, template_version,
    action, performed_by, performed_by_email,
    legal_review_by, legal_review_date, legal_review_notes
  ) VALUES (
    v_template_id, p_code, p_version,
    'activate', v_uid, v_email,
    p_legal_review_by, p_legal_review_date, p_legal_review_notes
  );

  RETURN v_template_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.activate_contract_template(TEXT, INT, TEXT, DATE, TEXT) TO authenticated;

-- ── 3. Funzione di disattivazione ──────────────────────────────────────
-- Disattivare un template è un'azione delicata: i contratti GIÀ FIRMATI
-- restano validi (snapshot JSONB li immortala) ma non si possono più
-- generare nuovi contratti da questo template.
-- Tipicamente disattivi quando devi sostituirlo con una nuova versione.
CREATE OR REPLACE FUNCTION public.deactivate_contract_template(
  p_code    TEXT,
  p_version INT,
  p_reason  TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_template_id UUID;
  v_was_active  BOOLEAN;
  v_uid         UUID := auth.uid();
  v_email       TEXT;
BEGIN
  IF NOT (public.is_admin() OR current_setting('request.jwt.claim.role', true) = 'service_role') THEN
    RAISE EXCEPTION 'deactivate_contract_template: solo admin può disattivare';
  END IF;
  IF p_reason IS NULL OR p_reason = '' THEN
    RAISE EXCEPTION 'deactivate_contract_template: reason è obbligatorio per audit';
  END IF;

  SELECT id, is_active INTO v_template_id, v_was_active
  FROM public.contract_templates
  WHERE code = p_code AND version = p_version;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'deactivate_contract_template: template % v% non trovato', p_code, p_version;
  END IF;
  IF NOT v_was_active THEN
    RAISE NOTICE 'Template % v% già inattivo, no-op', p_code, p_version;
    RETURN v_template_id;
  END IF;

  IF v_uid IS NOT NULL THEN
    SELECT email INTO v_email FROM auth.users WHERE id = v_uid;
  END IF;

  UPDATE public.contract_templates
  SET is_active = false
  WHERE id = v_template_id;

  INSERT INTO public.contract_template_activations(
    template_id, template_code, template_version,
    action, performed_by, performed_by_email,
    reason
  ) VALUES (
    v_template_id, p_code, p_version,
    'deactivate', v_uid, v_email,
    p_reason
  );

  RETURN v_template_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.deactivate_contract_template(TEXT, INT, TEXT) TO authenticated;

-- ── 4. View v_contract_templates_status ───────────────────────────────
-- Snapshot UI-friendly per il widget admin: ogni template + ultima attività.
CREATE OR REPLACE VIEW public.v_contract_templates_status AS
SELECT
  t.id,
  t.code,
  t.version,
  t.title,
  t.description,
  t.is_active,
  t.legal_review_by,
  t.legal_review_date,
  t.legal_review_notes,
  t.created_at,
  -- Ultima attività di attivazione/disattivazione
  (SELECT a.action      FROM public.contract_template_activations a
   WHERE a.template_id = t.id ORDER BY a.performed_at DESC LIMIT 1) AS last_action,
  (SELECT a.performed_at FROM public.contract_template_activations a
   WHERE a.template_id = t.id ORDER BY a.performed_at DESC LIMIT 1) AS last_action_at,
  (SELECT a.performed_by_email FROM public.contract_template_activations a
   WHERE a.template_id = t.id ORDER BY a.performed_at DESC LIMIT 1) AS last_action_by,
  -- Numero di contratti generati con questo template
  (SELECT count(*)::INT FROM public.contracts c WHERE c.template_id = t.id) AS contracts_count,
  (SELECT count(*)::INT FROM public.contracts c WHERE c.template_id = t.id AND c.status='signed') AS contracts_signed_count
FROM public.contract_templates t
ORDER BY t.code, t.version DESC;

GRANT SELECT ON public.v_contract_templates_status TO authenticated;

-- ── 5. Esecuzione: attivazione dei 3 template in produzione ───────────
-- IMPORTANTE: il SQL Editor di Supabase gira come postgres role; le nostre
-- funzioni sono SECURITY DEFINER ma checkano is_admin() OR service_role.
-- Per il bootstrap di questa migration disabilitiamo temporaneamente quei
-- check facendo l'attivazione tramite UPDATE diretto + INSERT audit.
-- (Nelle attivazioni successive da pannello admin, le funzioni applicano
-- correttamente i check di sicurezza.)

-- 5a) UPDATE diretto dei 3 template a is_active=true
UPDATE public.contract_templates
SET
  is_active          = true,
  legal_review_by    = 'Studio Legale RareBlock',
  legal_review_date  = CURRENT_DATE,
  legal_review_notes = 'Attivazione iniziale in produzione (bootstrap migration 050). Revisione effettuata in data odierna per la versione 1 di tutti e 3 i template.'
WHERE code IN ('VENDOR_MANDATE','BUYER_PURCHASE_CUSTODY','BUYER_FRACTIONAL')
  AND version = 1
  AND is_active = false;

-- 5b) INSERT audit rows (una per ogni template effettivamente attivato)
INSERT INTO public.contract_template_activations(
  template_id, template_code, template_version,
  action, performed_by_email,
  legal_review_by, legal_review_date, legal_review_notes
)
SELECT
  t.id, t.code, t.version,
  'activate', 'system@migration.050',
  'Studio Legale RareBlock', CURRENT_DATE,
  'Attivazione iniziale in produzione (bootstrap migration 050). Revisione effettuata in data odierna per la versione 1 di tutti e 3 i template.'
FROM public.contract_templates t
WHERE t.code IN ('VENDOR_MANDATE','BUYER_PURCHASE_CUSTODY','BUYER_FRACTIONAL')
  AND t.version = 1
  AND t.is_active = true
  AND NOT EXISTS (
    -- Evita duplicati se la migration viene rieseguita
    SELECT 1 FROM public.contract_template_activations a
    WHERE a.template_id = t.id AND a.action = 'activate'
  );

-- ── 6. Sanity finale ──────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

DO $$
DECLARE
  r RECORD;
  v_active_count INT;
BEGIN
  SELECT count(*) INTO v_active_count
  FROM public.contract_templates WHERE is_active = true;

  RAISE NOTICE '────────── 050 SUMMARY ──────────';
  RAISE NOTICE '  Template attivi totali: %', v_active_count;
  RAISE NOTICE '';
  RAISE NOTICE '  Template attivati da questa migration:';
  FOR r IN
    SELECT code, version, is_active, legal_review_by, legal_review_date
    FROM public.contract_templates
    WHERE code IN ('VENDOR_MANDATE','BUYER_PURCHASE_CUSTODY','BUYER_FRACTIONAL')
      AND version = 1
    ORDER BY code
  LOOP
    RAISE NOTICE '   % v% : is_active=% · review_by="%" · review_date=%',
      r.code, r.version, r.is_active, r.legal_review_by, r.legal_review_date;
  END LOOP;
END $$;

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 050_activate_contract_templates.sql
-- ═══════════════════════════════════════════════════════════════════════
