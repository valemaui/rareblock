-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — POST-MVP Task 3 (parte 1)
--  Migration 049: tabella email_outbox + helper enqueue_email()
--
--  CONTESTO
--  Task 3 = notifiche email apertura voto fractional. Strategia "outbox now,
--  delivery later" (transactional outbox pattern):
--    - Le notifiche generate dal codice business (edge function) vengono
--      INSERT in email_outbox con status='pending'
--    - Un worker (futuro) o admin manualmente processa la coda inviando
--      via SMTP/Resend/SendGrid
--    - Status track: pending → sent | failed (con retry counter)
--
--  Vantaggi:
--    - Audit completo: vedi sempre cosa è stato "inviato" e quando
--    - Resilienza: se SMTP è giù, la coda resta intatta
--    - Provider-agnostic: cambi delivery senza toccare il business code
--    - Testing E2E senza spam reale
--
--  USAGE (lato edge function PL/pgSQL):
--    SELECT public.enqueue_email(
--      p_to_email := 'user@example.com',
--      p_to_name  := 'Mario Rossi',
--      p_subject  := 'Voto exit window aperto',
--      p_body_html := '<html>…</html>',
--      p_body_text := 'Versione testuale...',
--      p_template_code := 'fractional_vote_open',
--      p_context := jsonb_build_object('vote_id','...','product_id','...')
--    );
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Tabella email_outbox ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.email_outbox (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Destinatario
  to_email        TEXT NOT NULL,
  to_name         TEXT,        -- nome formale del destinatario (per To: header)
  to_user_id      UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Mittente (default impostato da defaults application-level, ma overridabile)
  from_email      TEXT NOT NULL DEFAULT 'noreply@rareblock.eu',
  from_name       TEXT NOT NULL DEFAULT 'RareBlock',
  reply_to        TEXT,

  -- Contenuto
  subject         TEXT NOT NULL,
  body_html       TEXT NOT NULL,
  body_text       TEXT,        -- fallback plaintext (good practice ma non required)

  -- Tracciamento
  template_code   TEXT,        -- 'fractional_vote_open', 'fractional_vote_close', etc
  context         JSONB DEFAULT '{}'::JSONB,  -- dati per debugging/audit (vote_id, product_id...)

  -- Stato
  status          TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sending','sent','failed','cancelled')),
  attempt_count   INT NOT NULL DEFAULT 0,
  last_error      TEXT,

  -- Timestamps
  enqueued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ,
  next_retry_at   TIMESTAMPTZ,

  -- Audit
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_outbox_status
  ON public.email_outbox(status, enqueued_at);
CREATE INDEX IF NOT EXISTS idx_email_outbox_user
  ON public.email_outbox(to_user_id) WHERE to_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_outbox_template
  ON public.email_outbox(template_code, enqueued_at DESC) WHERE template_code IS NOT NULL;

-- RLS: solo admin SELECT/UPDATE; INSERT solo da service_role
ALTER TABLE public.email_outbox ENABLE ROW LEVEL SECURITY;

CREATE POLICY "email_outbox_admin_select" ON public.email_outbox
  FOR SELECT USING (public.is_admin());

CREATE POLICY "email_outbox_admin_update" ON public.email_outbox
  FOR UPDATE USING (public.is_admin());

-- INSERT è negato a default → solo service_role bypassa RLS

COMMENT ON TABLE public.email_outbox IS
  'Coda transactional outbox per notifiche email. Le edge functions inseriscono qui le email da inviare; un worker (futuro) o admin manualmente le processa via SMTP/Resend/SendGrid.';

-- ── 2. Helper enqueue_email ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enqueue_email(
  p_to_email      TEXT,
  p_subject       TEXT,
  p_body_html     TEXT,
  p_to_name       TEXT DEFAULT NULL,
  p_to_user_id    UUID DEFAULT NULL,
  p_body_text     TEXT DEFAULT NULL,
  p_template_code TEXT DEFAULT NULL,
  p_context       JSONB DEFAULT '{}'::JSONB,
  p_from_email    TEXT DEFAULT NULL,
  p_from_name     TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF p_to_email IS NULL OR p_to_email = '' THEN
    RAISE EXCEPTION 'enqueue_email: to_email mancante';
  END IF;
  IF p_subject IS NULL OR p_subject = '' THEN
    RAISE EXCEPTION 'enqueue_email: subject mancante';
  END IF;

  INSERT INTO public.email_outbox(
    to_email, to_name, to_user_id,
    subject, body_html, body_text,
    template_code, context,
    from_email, from_name
  ) VALUES (
    p_to_email,
    p_to_name,
    p_to_user_id,
    p_subject,
    p_body_html,
    p_body_text,
    p_template_code,
    COALESCE(p_context, '{}'::JSONB),
    COALESCE(p_from_email, 'noreply@rareblock.eu'),
    COALESCE(p_from_name, 'RareBlock')
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.enqueue_email(
  TEXT, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, JSONB, TEXT, TEXT
) TO authenticated;

-- ── 3. View v_email_outbox_pending per worker futuro ──────────────────
CREATE OR REPLACE VIEW public.v_email_outbox_pending AS
SELECT *
FROM public.email_outbox
WHERE status = 'pending'
   OR (status = 'failed' AND attempt_count < 5 AND (next_retry_at IS NULL OR next_retry_at <= now()))
ORDER BY enqueued_at ASC;

GRANT SELECT ON public.v_email_outbox_pending TO authenticated;

-- ── 4. Funzione enqueue_fractional_vote_open_emails ───────────────────
-- Helper specializzato che, dato un vote_id, enqueue una email a TUTTI
-- i comproprietari del prodotto avvisandoli dell'apertura voto.
-- Chiamato da fractional_cron_tick + fractional-vote-open edge function.
CREATE OR REPLACE FUNCTION public.enqueue_fractional_vote_open_emails(p_vote_id UUID)
RETURNS INT  -- numero di email enqueued
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r              RECORD;
  v_count        INT := 0;
  v_product_name TEXT;
  v_closes_at    TIMESTAMPTZ;
  v_round        INT;
  v_total_eligible INT;
  v_threshold    INT;
  v_subject      TEXT;
  v_html         TEXT;
  v_text         TEXT;
  v_user_email   TEXT;
  v_user_name    TEXT;
BEGIN
  -- Fetch info del voto
  SELECT
    p.name,
    v.closes_at,
    v.round_number,
    v.total_eligible_quotes
  INTO v_product_name, v_closes_at, v_round, v_total_eligible
  FROM public.inv_fractional_votes v
  JOIN public.inv_products p ON p.id = v.product_id
  WHERE v.id = p_vote_id;

  IF v_product_name IS NULL THEN
    RAISE EXCEPTION 'enqueue_fractional_vote_open_emails: vote % non trovato', p_vote_id;
  END IF;

  v_threshold := CEIL(v_total_eligible * 0.6667)::INT;

  -- Itera sui comproprietari (DISTINCT user per evitare double-email se ha più holdings)
  FOR r IN
    SELECT DISTINCT
      h.user_id,
      u.email,
      COALESCE(p.first_name || ' ' || p.last_name, u.email) AS display_name,
      SUM(h.qty) OVER (PARTITION BY h.user_id) AS my_quotes
    FROM public.inv_holdings h
    JOIN auth.users u   ON u.id = h.user_id
    LEFT JOIN public.profiles p ON p.id = h.user_id
    JOIN public.inv_fractional_votes v ON v.id = p_vote_id
    WHERE h.product_id = v.product_id
      AND u.email IS NOT NULL
  LOOP
    v_subject := 'RareBlock · È aperto il voto sulla vendita di "' || v_product_name || '"';

    -- HTML body — sobrio, brand-aligned, dark luxury
    v_html := '<!DOCTYPE html><html><head><meta charset="UTF-8"></head>'
      || '<body style="margin:0;padding:0;background:#0d1117;color:#c9d1d9;font-family:-apple-system,Segoe UI,Roboto,sans-serif">'
      || '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0d1117">'
      || '<tr><td align="center" style="padding:40px 20px">'
      || '<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#161b22;border:1px solid #30363d;border-radius:8px">'
      || '<tr><td style="padding:32px 36px 20px 36px;border-bottom:1px solid #30363d">'
      || '<div style="font-family:Georgia,serif;font-size:11px;color:#c9a84c;letter-spacing:.2em;text-transform:uppercase;margin-bottom:8px">VOTO ASSEMBLEA · COMPROPRIETÀ</div>'
      || '<div style="font-size:22px;color:#fff;font-weight:600;line-height:1.3">È aperto il voto sulla vendita di<br><em style="font-family:Georgia,serif;font-weight:400;font-style:italic">' || v_product_name || '</em></div>'
      || '</td></tr>'
      || '<tr><td style="padding:24px 36px;font-size:14px;line-height:1.6;color:#c9d1d9">'
      || '<p>Gentile ' || COALESCE(r.display_name, 'Comproprietario') || ',</p>'
      || '<p>In qualità di comproprietario del bene <strong>' || v_product_name || '</strong>, è ora aperta una <strong>finestra di voto exit window</strong> per decidere se procedere alla vendita del bene fisico.</p>'
      || '<table cellpadding="8" cellspacing="0" border="0" width="100%" style="background:#0d1117;border:1px solid #30363d;border-radius:6px;margin:16px 0">'
      || '<tr><td style="padding:12px 16px;font-size:12px;color:#8b949e">Round di voto</td><td style="padding:12px 16px;font-size:13px;color:#fff">N. ' || v_round || '</td></tr>'
      || '<tr><td style="padding:12px 16px;font-size:12px;color:#8b949e;border-top:1px solid #30363d">Le tue quote</td><td style="padding:12px 16px;font-size:13px;color:#fff;border-top:1px solid #30363d">' || COALESCE(r.my_quotes, 0) || '</td></tr>'
      || '<tr><td style="padding:12px 16px;font-size:12px;color:#8b949e;border-top:1px solid #30363d">Quote totali del bene</td><td style="padding:12px 16px;font-size:13px;color:#fff;border-top:1px solid #30363d">' || v_total_eligible || '</td></tr>'
      || '<tr><td style="padding:12px 16px;font-size:12px;color:#8b949e;border-top:1px solid #30363d">Soglia di approvazione</td><td style="padding:12px 16px;font-size:13px;color:#fff;border-top:1px solid #30363d">' || v_threshold || ' quote (66,67%)</td></tr>'
      || '<tr><td style="padding:12px 16px;font-size:12px;color:#8b949e;border-top:1px solid #30363d">Chiude il</td><td style="padding:12px 16px;font-size:13px;color:#fff;border-top:1px solid #30363d">' || to_char(v_closes_at AT TIME ZONE 'Europe/Rome', 'DD Mon YYYY · HH24:MI') || '</td></tr>'
      || '</table>'
      || '<p>Puoi esprimere il tuo voto direttamente dalla dashboard, scegliendo tra: <strong style="color:#3fb950">Vendi</strong>, <strong>Rinvia</strong>, o <strong style="color:#8b949e">Astieniti</strong>.</p>'
      || '<p style="font-size:12px;color:#8b949e;font-style:italic">Ricorda: ai fini del raggiungimento della maggioranza qualificata 2/3, le astensioni e le quote non votate equivalgono a un voto contrario alla vendita.</p>'
      || '<div style="text-align:center;margin:28px 0">'
      || '<a href="https://www.rareblock.eu/rareblock-dashboard.html#tab-port" style="display:inline-block;padding:12px 28px;background:#c9a84c;color:#0d1117;text-decoration:none;font-weight:600;border-radius:6px;letter-spacing:.02em">Vai al voto →</a>'
      || '</div>'
      || '</td></tr>'
      || '<tr><td style="padding:18px 36px 24px 36px;border-top:1px solid #30363d;font-size:11px;color:#6e7681;line-height:1.6">'
      || 'Notifica automatica RareBlock · Questa email viene inviata in adempimento dell''art. 9.2 del contratto di compravendita di quota di comproprietà.'
      || '</td></tr>'
      || '</table>'
      || '</td></tr></table>'
      || '</body></html>';

    -- Plain text fallback
    v_text := 'È aperto il voto sulla vendita di "' || v_product_name || E'"\n\n'
      || 'Gentile ' || COALESCE(r.display_name, 'Comproprietario') || E',\n\n'
      || 'In qualità di comproprietario del bene, è ora aperta una finestra di voto exit window.' || E'\n\n'
      || '  Round: ' || v_round || E'\n'
      || '  Le tue quote: ' || COALESCE(r.my_quotes, 0) || E'\n'
      || '  Quote totali: ' || v_total_eligible || E'\n'
      || '  Soglia: ' || v_threshold || ' quote (66,67%)' || E'\n'
      || '  Chiude il: ' || to_char(v_closes_at AT TIME ZONE 'Europe/Rome', 'DD Mon YYYY HH24:MI') || E'\n\n'
      || 'Vota dalla dashboard: https://www.rareblock.eu/rareblock-dashboard.html#tab-port' || E'\n\n'
      || 'Le astensioni equivalgono a voto contrario ai fini della maggioranza qualificata 2/3.';

    PERFORM public.enqueue_email(
      p_to_email      := r.email,
      p_subject       := v_subject,
      p_body_html     := v_html,
      p_to_name       := r.display_name,
      p_to_user_id    := r.user_id,
      p_body_text     := v_text,
      p_template_code := 'fractional_vote_open',
      p_context       := jsonb_build_object(
        'vote_id', p_vote_id,
        'round_number', v_round,
        'product_name', v_product_name,
        'my_quotes', r.my_quotes
      )
    );

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.enqueue_fractional_vote_open_emails(UUID) TO authenticated;

-- ── 5. Hook fractional_cron_tick: enqueue email post-apertura ──────────
-- Modifichiamo il wrapper per chiamare enqueue dopo apertura voti automatici.
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
  v_emails_total INT := 0;
  r          RECORD;
  v_emails_for_vote INT;
BEGIN
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

  -- Per ogni voto aperto, enqueue email comproprietari
  IF v_count > 0 THEN
    FOR r IN
      SELECT (elem->>'vote_id')::UUID AS vote_id
      FROM jsonb_array_elements(v_results) elem
    LOOP
      BEGIN
        SELECT public.enqueue_fractional_vote_open_emails(r.vote_id) INTO v_emails_for_vote;
        v_emails_total := v_emails_total + COALESCE(v_emails_for_vote, 0);
      EXCEPTION WHEN OTHERS THEN
        -- Email enqueue failure non deve bloccare la chiusura del cron
        -- (l'apertura voto è già committata, il log lo registra)
        RAISE WARNING 'enqueue email per vote_id % fallita: %', r.vote_id, SQLERRM;
      END;
    END LOOP;
  END IF;

  INSERT INTO public.inv_fractional_cron_log(votes_opened, details, duration_ms, source)
  VALUES (
    COALESCE(v_count, 0),
    COALESCE(v_results, '[]'::JSONB) || jsonb_build_object('emails_enqueued', v_emails_total),
    EXTRACT(MILLISECOND FROM (clock_timestamp() - v_start))::INT,
    'pg_cron'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.fractional_cron_tick() TO authenticated;

-- ── 6. Reload + sanity ──────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

DO $$
DECLARE
  v_table_exists BOOLEAN;
  v_func1        BOOLEAN;
  v_func2        BOOLEAN;
  v_view_exists  BOOLEAN;
BEGIN
  SELECT EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='email_outbox') INTO v_table_exists;
  SELECT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='enqueue_email') INTO v_func1;
  SELECT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='enqueue_fractional_vote_open_emails') INTO v_func2;
  SELECT EXISTS(SELECT 1 FROM pg_views WHERE schemaname='public' AND viewname='v_email_outbox_pending') INTO v_view_exists;

  RAISE NOTICE '────────── 049 SUMMARY ──────────';
  RAISE NOTICE '  email_outbox table:                       %', v_table_exists;
  RAISE NOTICE '  enqueue_email() function:                 %', v_func1;
  RAISE NOTICE '  enqueue_fractional_vote_open_emails() fn: %', v_func2;
  RAISE NOTICE '  v_email_outbox_pending view:              %', v_view_exists;
  RAISE NOTICE '  fractional_cron_tick() updated to enqueue emails';
END $$;

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 049_email_outbox.sql
-- ═══════════════════════════════════════════════════════════════════════
