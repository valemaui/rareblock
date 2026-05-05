-- ════════════════════════════════════════════════════════════════════════
--  Migration 057 — Allinea kyc_save_document ai valori canonici doc_type
--
--  Bug fix: la RPC kyc_save_document (mig 053) validava p_doc_type contro
--  ('CIE','passport','license','id_card'), valori inglesi disallineati sia
--  dal CHECK constraint profiles_id_doc_type_chk (mig 033, valori canonici
--  'CI','PATENTE','PASSAPORTO') sia dalla dashboard rareblock-dashboard.html
--  che fa UPDATE diretto su profiles con i valori italiani.
--
--  Conseguenza: l onboarding modal in pokemon-db.html, dopo il fix UI v5.8
--  che ha allineato il <select> ai valori canonici DB, falliva con
--    "doc_type non valido (atteso CIE | passport | license | id_card)"
--  perché la RPC era rimasta indietro.
--
--  Sintesi della scelta: i valori canonici sono quelli ITALIANI ('CI',
--  'PATENTE','PASSAPORTO'), perché:
--    1) sono fissati nel CHECK constraint DB (autorità ultima)
--    2) la dashboard li usa già da prima
--    3) sono visibili nei contratti FEA e nelle viste admin
--    4) coerenti con il dominio (utenti italiani, documenti italiani)
--
--  Questa migration sostituisce solo il blocco di validazione, lasciando
--  identica tutta la logica di UPDATE/UPSERT del documento.
--
--  Idempotente: CREATE OR REPLACE non rompe deploy ripetuti.
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.kyc_save_document(
  p_doc_type        TEXT,
  p_doc_number      TEXT,
  p_doc_issuer      TEXT,
  p_doc_issue_date  DATE,
  p_doc_expiry_date DATE,
  p_front_path      TEXT,
  p_back_path       TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'kyc_save_document: non autenticato';
  END IF;

  -- Validazioni
  -- Allineato al CHECK constraint profiles_id_doc_type_chk (mig 033)
  -- e al <select> della dashboard. Niente più valori inglesi.
  IF p_doc_type NOT IN ('CI','PATENTE','PASSAPORTO') THEN
    RAISE EXCEPTION 'doc_type non valido (atteso CI | PATENTE | PASSAPORTO)';
  END IF;
  IF p_doc_number IS NULL OR length(trim(p_doc_number)) < 3 THEN
    RAISE EXCEPTION 'doc_number troppo corto';
  END IF;
  IF p_doc_expiry_date IS NULL OR p_doc_expiry_date < CURRENT_DATE THEN
    RAISE EXCEPTION 'doc_expiry_date deve essere futura';
  END IF;
  IF p_front_path IS NULL OR p_front_path = '' THEN
    RAISE EXCEPTION 'front_path mancante';
  END IF;
  IF p_back_path IS NULL OR p_back_path = '' THEN
    RAISE EXCEPTION 'back_path mancante';
  END IF;

  -- Verifica che i path delle foto appartengano effettivamente all utente
  -- (defense in depth: lo storage RLS già filtra, ma controlliamo anche qui)
  IF NOT (p_front_path LIKE v_uid::text || '/%') THEN
    RAISE EXCEPTION 'front_path non valido per questo utente';
  END IF;
  IF NOT (p_back_path LIKE v_uid::text || '/%') THEN
    RAISE EXCEPTION 'back_path non valido per questo utente';
  END IF;

  UPDATE public.profiles SET
    id_doc_type        = p_doc_type,
    id_doc_number      = trim(p_doc_number),
    id_doc_issuer      = NULLIF(trim(COALESCE(p_doc_issuer,'')), ''),
    id_doc_issue_date  = p_doc_issue_date,
    id_doc_expiry_date = p_doc_expiry_date,
    id_doc_front_path  = p_front_path,
    id_doc_back_path   = p_back_path,
    kyc_level          = GREATEST(COALESCE(kyc_level, 0), 2),
    -- Documento appena caricato → kyc_status torna a 'review' per nuova revisione admin
    kyc_status         = CASE
                           WHEN kyc_status = 'rejected' THEN 'review'  -- riproposta dopo refuse
                           WHEN kyc_status = 'approved' THEN 'review'  -- ri-upload dopo scadenza
                           ELSE COALESCE(kyc_status, 'pending')
                         END,
    updated_at         = now()
  WHERE id = v_uid;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.kyc_save_document(
  TEXT, TEXT, TEXT, DATE, DATE, TEXT, TEXT
) TO authenticated;

-- ── Sanity: verifica constraint presente e valori coerenti ─────────────
-- (puramente informativo, raise notice in caso di disallineamenti residui)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM   public.profiles
    WHERE  id_doc_type IS NOT NULL
      AND  id_doc_type NOT IN ('CI','PATENTE','PASSAPORTO')
  ) THEN
    RAISE NOTICE 'WARNING: trovati profiles con id_doc_type fuori whitelist — controllare manualmente';
  END IF;
END $$;
