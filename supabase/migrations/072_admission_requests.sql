-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Migration 072: richieste di ammissione (waiting list)
--
--  Quando un utente compila la registrazione SENZA codice referral, non
--  viene creato alcun account: la richiesta viene messa in stato 'waiting'
--  e valutata dall'admin (gestione futura nel pannello esistente).
--
--  Dipende da: 011 (is_admin), 070 (pattern referral).
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Tabella richieste ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.inv_admission_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text NOT NULL,
  status       text NOT NULL DEFAULT 'waiting'
                 CHECK (status IN ('waiting','approved','rejected','contacted')),
  -- Codice eventualmente generato/assegnato in fase di approvazione.
  granted_code text,
  user_agent   text,
  referrer     text,
  language     text,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Una sola richiesta "aperta" per email (waiting/contacted): evita duplicati.
CREATE UNIQUE INDEX IF NOT EXISTS uq_admission_open_email
  ON public.inv_admission_requests (lower(email))
  WHERE status IN ('waiting','contacted');

CREATE INDEX IF NOT EXISTS idx_admission_status
  ON public.inv_admission_requests (status, created_at DESC);

-- ── 2. RLS: chiuso; admin legge/aggiorna, anon solo via RPC ──────────────
ALTER TABLE public.inv_admission_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admission_admin_select" ON public.inv_admission_requests;
DROP POLICY IF EXISTS "admission_admin_update" ON public.inv_admission_requests;
CREATE POLICY "admission_admin_select" ON public.inv_admission_requests
  FOR SELECT USING ( public.is_admin() );
CREATE POLICY "admission_admin_update" ON public.inv_admission_requests
  FOR UPDATE USING ( public.is_admin() ) WITH CHECK ( public.is_admin() );

-- ── 3. RPC: crea richiesta (anon, dal form di registrazione) ─────────────
--  Idempotente per email aperta: se esiste già una richiesta waiting/contacted
--  ritorna ok senza duplicare.
CREATE OR REPLACE FUNCTION public.request_admission(
  p_email      text,
  p_user_agent text DEFAULT NULL,
  p_referrer   text DEFAULT NULL,
  p_language   text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text := lower(btrim(coalesce(p_email,'')));
BEGIN
  IF v_email = '' OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_email');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.inv_admission_requests
     WHERE lower(email) = v_email AND status IN ('waiting','contacted')
  ) THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_pending');
  END IF;

  INSERT INTO public.inv_admission_requests (email, user_agent, referrer, language)
  VALUES (v_email, p_user_agent, p_referrer, p_language);

  RETURN jsonb_build_object('ok', true, 'reason', 'created');
END;
$$;

REVOKE ALL ON FUNCTION public.request_admission(text,text,text,text) FROM public;
GRANT EXECUTE ON FUNCTION public.request_admission(text,text,text,text) TO anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════
--  Gestione admin (futura): leggere inv_admission_requests con status
--  'waiting', approvare generando un codice in inv_referral_codes e settando
--  status='approved' + granted_code, oppure 'rejected'/'contacted'.
-- ═══════════════════════════════════════════════════════════════════════
