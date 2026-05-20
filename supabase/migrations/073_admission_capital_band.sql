-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Migration 073: capital band sulla lista d'attesa
--
--  La landing pubblica (index.html → sezione "Richiedi il tuo invito")
--  raccoglie, oltre all'email, una fascia di capitale orientativa come
--  segnale di domanda pre-lancio. Questa migration:
--    1. aggiunge la colonna inv_admission_requests.capital_band
--    2. estende la RPC request_admission con un 5° parametro OPZIONALE
--       (p_capital_band) MANTENENDO la firma a 4 argomenti invariata, così
--       eventuali chiamanti esistenti non si rompono.
--
--  Dipende da: 072 (inv_admission_requests + request_admission).
--  Additiva e idempotente: sicura da rieseguire.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Colonna fascia capitale ───────────────────────────────────────────
ALTER TABLE public.inv_admission_requests
  ADD COLUMN IF NOT EXISTS capital_band text
    CHECK (capital_band IS NULL OR capital_band IN ('lt5k','5k-25k','25k-100k','gt100k'));

-- ── 2. RPC estesa (5° arg opzionale) ─────────────────────────────────────
--  NB: PostgreSQL distingue le funzioni per firma. Definendo la versione a
--  5 argomenti NON si sovrascrive quella a 4 di 072: entrambe coesistono e
--  la 4-arg resta valida. Qui ridefiniamo la logica completa per la 5-arg.
CREATE OR REPLACE FUNCTION public.request_admission(
  p_email        text,
  p_user_agent   text DEFAULT NULL,
  p_referrer     text DEFAULT NULL,
  p_language     text DEFAULT NULL,
  p_capital_band text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text := lower(btrim(coalesce(p_email,'')));
  v_band  text := nullif(btrim(coalesce(p_capital_band,'')), '');
BEGIN
  IF v_email = '' OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_email');
  END IF;

  -- Normalizza band: valori fuori dall'enum diventano NULL (no errore).
  IF v_band IS NOT NULL AND v_band NOT IN ('lt5k','5k-25k','25k-100k','gt100k') THEN
    v_band := NULL;
  END IF;

  -- Già in lista (waiting/contacted): aggiorna solo la band se ora fornita,
  -- e ritorna ok senza duplicare.
  IF EXISTS (
    SELECT 1 FROM public.inv_admission_requests
     WHERE lower(email) = v_email AND status IN ('waiting','contacted')
  ) THEN
    IF v_band IS NOT NULL THEN
      UPDATE public.inv_admission_requests
         SET capital_band = v_band, updated_at = now()
       WHERE lower(email) = v_email AND status IN ('waiting','contacted')
         AND capital_band IS DISTINCT FROM v_band;
    END IF;
    RETURN jsonb_build_object('ok', true, 'reason', 'already_pending');
  END IF;

  INSERT INTO public.inv_admission_requests (email, user_agent, referrer, language, capital_band)
  VALUES (v_email, p_user_agent, p_referrer, p_language, v_band);

  RETURN jsonb_build_object('ok', true, 'reason', 'created');
END;
$$;

REVOKE ALL ON FUNCTION public.request_admission(text,text,text,text,text) FROM public;
GRANT EXECUTE ON FUNCTION public.request_admission(text,text,text,text,text) TO anon, authenticated;
