-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — payments PR5b (email queue per bonifico)
--  Migration 055
--
--  COSA FA
--  - RPC enqueue_order_confirmation_email(order_id) — chiamata dal client
--    al checkout (DOPO INSERT inv_orders) per accodare l'email di conferma
--    bonifico con tutti i dati IBAN/causale/scadenza.
--  - Helper interno _build_order_email_html(order_row) — genera HTML
--    brand-aligned coerente con i 5 template auth (gold/dark luxury).
--  - Cron tick reminder: ogni giorno alle 09:00 UTC scansiona ordini in
--    awaiting_payment con expires_at fra 3 giorni → enqueue reminder.
--  - Cron tick expired: alle 04:30 UTC (dopo cancel_expired_orders alle
--    04:00) enqueue email "ordine scaduto" per ordini appena cancellati.
--
--  DIPENDENZE
--  - Migration 049 (email_outbox + enqueue_email)
--  - Migration 054 (inv_orders.payout_*, expires_at, reminder_sent_at,
--                    expired_email_sent_at, rb_settings)
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Helper: builder HTML email ordine bonifico ────────────────────
-- Genera il body HTML con dati ordine. Pattern coerente con i 5 template
-- auth caricati su Supabase (bg #0d1117, gold accent, Plex Sans, max 600px).
CREATE OR REPLACE FUNCTION public._build_order_email_html(
  p_order_row     RECORD,
  p_email_kind    TEXT  -- 'confirm' | 'reminder' | 'expired'
)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_title         TEXT;
  v_intro         TEXT;
  v_cta           TEXT;
  v_total_str     TEXT;
  v_expires_str   TEXT;
  v_scenario_note TEXT;
  v_body          TEXT;
BEGIN
  v_total_str := to_char(p_order_row.total, 'FM999G999D00') || ' €';
  v_expires_str := COALESCE(to_char(p_order_row.expires_at, 'DD Mon YYYY'), '—');

  IF p_email_kind = 'confirm' THEN
    v_title := 'Ordine confermato — Pagamento richiesto';
    v_intro := 'Grazie per il tuo ordine. Per finalizzarlo, ti chiediamo di effettuare il bonifico bancario con i dati riportati di seguito.';
    v_cta   := 'Hai 7 giorni per completare il pagamento.';
  ELSIF p_email_kind = 'reminder' THEN
    v_title := 'Promemoria — Pagamento in scadenza';
    v_intro := 'Ti ricordiamo che il pagamento del tuo ordine è in scadenza. Procedi al bonifico per non perdere la prenotazione delle tue quote.';
    v_cta   := 'Pagamento richiesto entro: ' || v_expires_str;
  ELSE  -- 'expired'
    v_title := 'Ordine scaduto';
    v_intro := 'Purtroppo il termine per il pagamento del tuo ordine è scaduto e l''ordine è stato annullato. Le quote sono tornate disponibili sul marketplace.';
    v_cta   := 'Puoi rieffettuare l''acquisto in qualsiasi momento dalla piattaforma.';
  END IF;

  -- Banner scenario B (vendor_direct)
  IF p_order_row.payout_mode = 'vendor_direct' THEN
    v_scenario_note := '<tr><td style="padding:12px 24px;background:rgba(201,168,76,.08);border-left:3px solid #c9a84c;color:#c9c9c9;font-size:13px;line-height:1.5"><strong style="color:#f0ead8">Pagamento al venditore.</strong> Per accordo specifico, questo ordine prevede il pagamento diretto al venditore. RareBlock confermerà l''ordine al ricevimento del bonifico.</td></tr>';
  ELSE
    v_scenario_note := '';
  END IF;

  v_body := concat(
    '<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1.0">',
    '<title>', v_title, '</title></head>',
    '<body style="margin:0;padding:0;background:#0a0d12;font-family:''IBM Plex Sans'',Arial,sans-serif;color:#e6edf3">',
    '<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0d12;padding:32px 16px">',
      '<tr><td align="center">',
        '<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#161b22;border:1px solid #30363d;border-radius:8px;overflow:hidden">',
          -- Header
          '<tr><td style="padding:24px 32px;border-bottom:1px solid #30363d;text-align:center">',
            '<div style="font-family:''Montserrat'',Arial,sans-serif;font-size:18px;font-weight:300;letter-spacing:.18em;text-transform:uppercase;color:#f0ead8">Rare<span style="color:#c9a84c">Block</span></div>',
          '</td></tr>',
          -- Eyebrow gold
          '<tr><td style="padding:32px 32px 8px;font-family:''IBM Plex Mono'',monospace;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#c9a84c;font-weight:600">Ordine ', p_order_row.order_number, '</td></tr>',
          -- Title
          '<tr><td style="padding:0 32px 12px;font-family:Georgia,serif;font-style:italic;font-size:24px;line-height:1.3;color:#f0ead8">', v_title, '</td></tr>',
          -- Intro
          '<tr><td style="padding:0 32px 24px;font-size:14px;line-height:1.65;color:#9ca3af">', v_intro, '</td></tr>',
          -- Scenario banner (se B)
          v_scenario_note,
          -- Bonifico table (solo per confirm + reminder)
          CASE WHEN p_email_kind IN ('confirm','reminder') THEN concat(
            '<tr><td style="padding:8px 32px 0">',
              '<table width="100%" cellpadding="0" cellspacing="0" style="background:#0d1117;border:1px solid #30363d;border-radius:6px;font-size:13px">',
                '<tr><td style="padding:14px 18px;border-bottom:1px solid #21262d;color:#7d8590;font-family:''IBM Plex Mono'',monospace;font-size:11px;text-transform:uppercase;letter-spacing:.1em" width="35%">Intestatario</td><td style="padding:14px 18px;border-bottom:1px solid #21262d;color:#e6edf3">', COALESCE(p_order_row.payout_holder, '—'), '</td></tr>',
                CASE WHEN p_order_row.payout_bank IS NOT NULL AND p_order_row.payout_bank <> '—' THEN
                  '<tr><td style="padding:14px 18px;border-bottom:1px solid #21262d;color:#7d8590;font-family:''IBM Plex Mono'',monospace;font-size:11px;text-transform:uppercase;letter-spacing:.1em">Banca</td><td style="padding:14px 18px;border-bottom:1px solid #21262d;color:#e6edf3">' || p_order_row.payout_bank || '</td></tr>'
                ELSE '' END,
                '<tr><td style="padding:14px 18px;border-bottom:1px solid #21262d;color:#7d8590;font-family:''IBM Plex Mono'',monospace;font-size:11px;text-transform:uppercase;letter-spacing:.1em">IBAN</td><td style="padding:14px 18px;border-bottom:1px solid #21262d;color:#e6edf3;font-family:''IBM Plex Mono'',monospace;letter-spacing:.04em">', COALESCE(p_order_row.payout_iban, '—'), '</td></tr>',
                CASE WHEN p_order_row.payout_bic IS NOT NULL AND p_order_row.payout_bic <> '—' THEN
                  '<tr><td style="padding:14px 18px;border-bottom:1px solid #21262d;color:#7d8590;font-family:''IBM Plex Mono'',monospace;font-size:11px;text-transform:uppercase;letter-spacing:.1em">BIC/SWIFT</td><td style="padding:14px 18px;border-bottom:1px solid #21262d;color:#e6edf3;font-family:''IBM Plex Mono'',monospace">' || p_order_row.payout_bic || '</td></tr>'
                ELSE '' END,
                '<tr><td style="padding:14px 18px;border-bottom:1px solid #21262d;color:#7d8590;font-family:''IBM Plex Mono'',monospace;font-size:11px;text-transform:uppercase;letter-spacing:.1em">Causale</td><td style="padding:14px 18px;border-bottom:1px solid #21262d;color:#c9a84c;font-family:''IBM Plex Mono'',monospace;font-weight:600;letter-spacing:.04em">', p_order_row.causale, '</td></tr>',
                '<tr><td style="padding:14px 18px;border-bottom:1px solid #21262d;color:#7d8590;font-family:''IBM Plex Mono'',monospace;font-size:11px;text-transform:uppercase;letter-spacing:.1em">Importo</td><td style="padding:14px 18px;border-bottom:1px solid #21262d;color:#c9a84c;font-weight:600;font-size:15px">', v_total_str, '</td></tr>',
                '<tr><td style="padding:14px 18px;color:#7d8590;font-family:''IBM Plex Mono'',monospace;font-size:11px;text-transform:uppercase;letter-spacing:.1em">Scadenza</td><td style="padding:14px 18px;color:#e6edf3">', v_expires_str, '</td></tr>',
              '</table>',
            '</td></tr>'
          ) ELSE '' END,
          -- CTA box
          '<tr><td style="padding:24px 32px"><div style="padding:14px 16px;background:rgba(201,168,76,.06);border:1px solid rgba(201,168,76,.2);border-radius:6px;font-size:13px;line-height:1.55;color:#9ca3af"><strong style="color:#f0ead8">', v_cta, '</strong></div></td></tr>',
          -- Footer
          '<tr><td style="padding:24px 32px;border-top:1px solid #30363d;text-align:center;font-size:11px;line-height:1.6;color:#6b7280">RareBlock — Collezionismo &amp; Investimento<br>noreply@rareblock.eu</td></tr>',
        '</table>',
      '</td></tr>',
    '</table></body></html>'
  );

  RETURN v_body;
END;
$$;

-- ── 2. RPC enqueue_order_confirmation_email(order_id) ─────────────────
-- Chiamabile da client (authenticated) DOPO il checkout per accodare
-- l'email di conferma bonifico.
CREATE OR REPLACE FUNCTION public.enqueue_order_confirmation_email(
  p_order_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order RECORD;
  v_email_id UUID;
  v_subject TEXT;
  v_body TEXT;
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'enqueue_order_confirmation_email: non autenticato';
  END IF;

  SELECT * INTO v_order FROM public.inv_orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order non trovato: %', p_order_id;
  END IF;

  -- Solo l'utente proprietario o un admin può chiamare per quest'ordine
  IF v_order.user_id <> v_uid AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'non autorizzato per quest''ordine';
  END IF;

  v_subject := 'Ordine ' || v_order.order_number || ' — Pagamento richiesto';
  v_body := public._build_order_email_html(v_order, 'confirm');

  v_email_id := public.enqueue_email(
    p_to_email      => v_order.bill_email,
    p_subject       => v_subject,
    p_body_html     => v_body,
    p_to_name       => v_order.bill_full_name,
    p_to_user_id    => v_order.user_id,
    p_template_code => 'order_confirmation',
    p_context       => jsonb_build_object(
                         'order_id',     v_order.id,
                         'order_number', v_order.order_number,
                         'causale',      v_order.causale,
                         'total',        v_order.total,
                         'payout_mode',  v_order.payout_mode
                       )
  );

  RETURN v_email_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.enqueue_order_confirmation_email(UUID) TO authenticated;

-- ── 3. RPC enqueue_order_reminder_emails (cron) ───────────────────────
-- Scansiona ordini awaiting_payment con expires_at nei prossimi N giorni
-- (default 3) e che non hanno ancora ricevuto reminder. Enqueue email +
-- aggiorna reminder_sent_at.
CREATE OR REPLACE FUNCTION public.enqueue_order_reminder_emails()
RETURNS TABLE(sent_count INT, order_ids UUID[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_settings RECORD;
  v_reminder_days INT;
  v_count INT := 0;
  v_ids UUID[] := '{}';
  v_order RECORD;
  v_subject TEXT;
  v_body TEXT;
BEGIN
  -- Solo postgres/admin (chiamato dal cron)
  IF current_user NOT IN ('postgres', 'supabase_admin')
     AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'enqueue_order_reminder_emails: non autorizzato';
  END IF;

  SELECT reminder_days INTO v_settings FROM public.rb_settings WHERE id = 1;
  v_reminder_days := COALESCE(v_settings.reminder_days, 3);

  FOR v_order IN
    SELECT * FROM public.inv_orders
    WHERE status = 'awaiting_payment'
      AND expires_at IS NOT NULL
      AND expires_at > now()
      AND expires_at <= now() + (v_reminder_days || ' days')::INTERVAL
      AND reminder_sent_at IS NULL
      AND bill_email IS NOT NULL
      AND payment_method = 'bonifico'
  LOOP
    v_subject := 'Promemoria — Pagamento ordine ' || v_order.order_number || ' in scadenza';
    v_body := public._build_order_email_html(v_order, 'reminder');

    PERFORM public.enqueue_email(
      p_to_email      => v_order.bill_email,
      p_subject       => v_subject,
      p_body_html     => v_body,
      p_to_name       => v_order.bill_full_name,
      p_to_user_id    => v_order.user_id,
      p_template_code => 'order_reminder',
      p_context       => jsonb_build_object('order_id', v_order.id, 'order_number', v_order.order_number)
    );

    UPDATE public.inv_orders SET reminder_sent_at = now() WHERE id = v_order.id;
    v_count := v_count + 1;
    v_ids   := v_ids || v_order.id;
  END LOOP;

  sent_count := v_count;
  order_ids  := v_ids;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.enqueue_order_reminder_emails() TO authenticated;

-- ── 4. RPC enqueue_order_expired_emails (cron) ────────────────────────
-- Scansiona ordini cancellati per expiry (status='expired', cancelled_at
-- recente) e non ancora notificati. Enqueue email + aggiorna flag.
CREATE OR REPLACE FUNCTION public.enqueue_order_expired_emails()
RETURNS TABLE(sent_count INT, order_ids UUID[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count INT := 0;
  v_ids UUID[] := '{}';
  v_order RECORD;
  v_subject TEXT;
  v_body TEXT;
BEGIN
  IF current_user NOT IN ('postgres', 'supabase_admin')
     AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'enqueue_order_expired_emails: non autorizzato';
  END IF;

  FOR v_order IN
    SELECT * FROM public.inv_orders
    WHERE status = 'expired'
      AND expired_email_sent_at IS NULL
      AND bill_email IS NOT NULL
      AND payment_method = 'bonifico'
      AND cancelled_at > now() - INTERVAL '7 days'  -- safety: non rinotificare ordini molto vecchi
  LOOP
    v_subject := 'Ordine ' || v_order.order_number || ' scaduto';
    v_body := public._build_order_email_html(v_order, 'expired');

    PERFORM public.enqueue_email(
      p_to_email      => v_order.bill_email,
      p_subject       => v_subject,
      p_body_html     => v_body,
      p_to_name       => v_order.bill_full_name,
      p_to_user_id    => v_order.user_id,
      p_template_code => 'order_expired',
      p_context       => jsonb_build_object('order_id', v_order.id, 'order_number', v_order.order_number)
    );

    UPDATE public.inv_orders SET expired_email_sent_at = now() WHERE id = v_order.id;
    v_count := v_count + 1;
    v_ids   := v_ids || v_order.id;
  END LOOP;

  sent_count := v_count;
  order_ids  := v_ids;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.enqueue_order_expired_emails() TO authenticated;

-- ── 5. pg_cron: schedule reminder + expired email ticks ───────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron extension non installata, skip schedule.';
    RETURN;
  END IF;

  -- Reminder giornaliero alle 09:00 UTC (orario europeo lavorativo)
  PERFORM cron.unschedule('rb_send_order_reminders')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rb_send_order_reminders');

  PERFORM cron.schedule(
    'rb_send_order_reminders',
    '0 9 * * *',
    $cron$ SELECT public.enqueue_order_reminder_emails(); $cron$
  );

  -- Expired email tick alle 04:30 UTC (30 min dopo cancel_expired_orders)
  PERFORM cron.unschedule('rb_send_order_expired_emails')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rb_send_order_expired_emails');

  PERFORM cron.schedule(
    'rb_send_order_expired_emails',
    '30 4 * * *',
    $cron$ SELECT public.enqueue_order_expired_emails(); $cron$
  );

  RAISE NOTICE 'pg_cron jobs schedulati: rb_send_order_reminders (09:00 UTC), rb_send_order_expired_emails (04:30 UTC)';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron schedule fallito: %', SQLERRM;
END $$;

-- ── 6. Reload + sanity ───────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

DO $$
BEGIN
  RAISE NOTICE '────────── 055 SUMMARY ──────────';
  RAISE NOTICE '  enqueue_order_confirmation_email():  %',
    EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='public' AND p.proname='enqueue_order_confirmation_email');
  RAISE NOTICE '  enqueue_order_reminder_emails():     %',
    EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='public' AND p.proname='enqueue_order_reminder_emails');
  RAISE NOTICE '  enqueue_order_expired_emails():      %',
    EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='public' AND p.proname='enqueue_order_expired_emails');
END $$;

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 055_pr5b_payment_emails.sql
-- ═══════════════════════════════════════════════════════════════════════
