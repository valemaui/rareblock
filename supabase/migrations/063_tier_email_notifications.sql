-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Migration 063: Email notifications su cambio tier
--
--  Trigger su inv_tier_history (AFTER INSERT) → enqueue_email per:
--   • tier_promotion  — basic→pro, basic→gold, pro→gold (source='admin')
--   • tier_demotion   — gold→pro, gold→basic, pro→basic (source='admin')
--   • tier_pro_expired— pro→basic per scadenza (source='expired')
--
--  Trigger su profiles (AFTER UPDATE OF gold_eligible_since) → email
--  "Sei eleggibile per GOLD" quando il flag passa da NULL a timestamp.
--
--  Pattern coerente con migration 049 (enqueue_email + email_outbox).
--  Brand: dark luxury, oro #c9a84c, layout coerente con docs/email-templates/.
-- ═══════════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════════
--  1) Helper: render template tier email (DARK luxury, brand-aligned)
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public._render_tier_email(
  p_kind       TEXT,        -- 'promotion' | 'demotion' | 'expired' | 'eligible'
  p_to_tier    TEXT,        -- destinazione (basic/pro/gold) — null per 'eligible'
  p_from_tier  TEXT,        -- origine
  p_first_name TEXT,
  p_aum        NUMERIC      -- AUM corrente (info contestuale)
)
RETURNS TABLE (subject TEXT, body_html TEXT, body_text TEXT)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_eyebrow   TEXT;
  v_headline  TEXT;
  v_intro     TEXT;
  v_detail    TEXT;
  v_cta_text  TEXT;
  v_cta_url   TEXT := 'https://www.rareblock.eu/rareblock-dashboard.html#profile';
  v_subject   TEXT;
  v_html      TEXT;
  v_text      TEXT;
  v_greeting  TEXT;
  v_to_label  TEXT;
  v_aum_str   TEXT;
BEGIN
  v_greeting := 'Ciao ' || COALESCE(NULLIF(TRIM(p_first_name), ''), 'investitore') || ',';
  v_aum_str  := '€ ' || TO_CHAR(COALESCE(p_aum, 0), 'FM999G999G990')
                  || ' di AUM corrente';
  v_to_label := UPPER(COALESCE(p_to_tier, ''));

  IF p_kind = 'promotion' AND p_to_tier = 'gold' THEN
    v_eyebrow  := 'Benvenuto nel club';
    v_headline := 'Sei stato promosso a GOLD.';
    v_intro    := 'Il tuo accesso GOLD è ora attivo. La promozione è discrezionale e curata: rappresenta un riconoscimento del tuo percorso su RareBlock.';
    v_detail   := 'Da subito hai accesso a preview drop di 7 giorni, priority allocation sui pezzi rari, voto fractional con peso, custodia illimitata, finestra exit trimestrale senza penale, advisor dedicato e deal off-market. La tua buyer fee scende allo 0,5%, la success fee al 7%.';
    v_cta_text := 'Apri il tuo profilo';
    v_subject  := 'Benvenuto in RareBlock GOLD';

  ELSIF p_kind = 'promotion' AND p_to_tier = 'pro' THEN
    v_eyebrow  := 'Aggiornamento membership';
    v_headline := 'Il tuo accesso PRO è attivo.';
    v_intro    := 'Da oggi puoi operare in Modalità B fractional, ricevere preview drop 48h prima del pubblico, alert real-time sulla watchlist e un report PDF trimestrale del portafoglio.';
    v_detail   := 'La tua buyer fee è ora 1,5% e la custodia è inclusa fino a € 25.000 di AUM. Il piano PRO ha durata annuale: ti contatteremo prima della scadenza per il rinnovo.';
    v_cta_text := 'Esplora il tuo profilo';
    v_subject  := 'Il tuo RareBlock PRO è attivo';

  ELSIF p_kind = 'demotion' AND p_to_tier = 'basic' AND p_from_tier = 'gold' THEN
    v_eyebrow  := 'Cambio di tier';
    v_headline := 'Il tuo accesso GOLD è terminato.';
    v_intro    := 'A partire da oggi il tuo profilo è tornato al tier BASIC. La decisione è registrata in modo trasparente nel tuo storico tier ed è sempre reversibile.';
    v_detail   := 'Le fee buyer/success tornano a 2,5% / 10%. Mantieni l''accesso al marketplace pubblico, alle Modalità A e a tutti i tuoi asset esistenti. Per qualsiasi domanda sul cambio puoi contattare il tuo advisor.';
    v_cta_text := 'Vai al profilo';
    v_subject  := 'Aggiornamento del tuo tier RareBlock';

  ELSIF p_kind = 'demotion' AND p_to_tier = 'pro' THEN
    v_eyebrow  := 'Cambio di tier';
    v_headline := 'Il tuo accesso GOLD è terminato.';
    v_intro    := 'Il tuo profilo è stato ricondotto al tier PRO. Mantieni Modalità B fractional, preview 48h, alert real-time e custodia inclusa fino a € 25.000 AUM.';
    v_detail   := 'Le fee buyer/success diventano 1,5% / 10%. Per dettagli sul cambio o per discuterne, contatta il tuo advisor.';
    v_cta_text := 'Vai al profilo';
    v_subject  := 'Aggiornamento del tuo tier RareBlock';

  ELSIF p_kind = 'demotion' THEN
    v_eyebrow  := 'Cambio di tier';
    v_headline := 'Il tuo tier RareBlock è cambiato.';
    v_intro    := 'Il tuo profilo è ora ' || v_to_label || '. Il cambio è registrato in modo trasparente nel tuo storico tier.';
    v_detail   := 'Mantieni l''accesso al marketplace e a tutti i tuoi asset. Per qualsiasi domanda contatta il tuo advisor.';
    v_cta_text := 'Vai al profilo';
    v_subject  := 'Aggiornamento del tuo tier RareBlock';

  ELSIF p_kind = 'expired' THEN
    v_eyebrow  := 'Scadenza piano';
    v_headline := 'Il tuo PRO è scaduto.';
    v_intro    := 'Il tuo piano PRO ha raggiunto la scadenza annuale e il profilo è tornato al tier BASIC. Tutti i tuoi asset restano accessibili.';
    v_detail   := 'Per riattivare PRO o discutere il rinnovo prenota una chiamata con il nostro advisor: 30 minuti per fare il punto sul tuo portafoglio e definire i prossimi passi.';
    v_cta_text := 'Prenota una chiamata';
    v_cta_url  := 'https://cal.com/rareblock/30-minuti-rareblock';
    v_subject  := 'Il tuo piano PRO è scaduto';

  ELSIF p_kind = 'eligible' THEN
    v_eyebrow  := 'Eleggibilità GOLD raggiunta';
    v_headline := 'Sei eleggibile per il tier GOLD.';
    v_intro    := 'Hai raggiunto la soglia di AUM richiesta per accedere al club GOLD di RareBlock. Per noi è un riconoscimento del tuo percorso.';
    v_detail   := 'La promozione a GOLD è discrezionale e curata: l''amministrazione valuta caso per caso e ti contatterà direttamente. Se preferisci anticipare i tempi, puoi prenotare una chiamata di 30 minuti con il nostro advisor.';
    v_cta_text := 'Prenota una chiamata';
    v_cta_url  := 'https://cal.com/rareblock/30-minuti-rareblock';
    v_subject  := 'Sei eleggibile per RareBlock GOLD';

  ELSE
    v_eyebrow  := 'Aggiornamento profilo';
    v_headline := 'Il tuo tier RareBlock è cambiato.';
    v_intro    := 'Il cambio è registrato nel tuo storico tier. Per dettagli, apri il tuo profilo.';
    v_detail   := '';
    v_cta_text := 'Vai al profilo';
    v_subject  := 'Aggiornamento RareBlock';
  END IF;

  -- ── HTML body (table-based, dark luxury) ──
  v_html :=
'<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>' || v_subject || '</title></head>'
|| '<body style="margin:0;padding:0;background:#0d1117;font-family:-apple-system,BlinkMacSystemFont,''Segoe UI'',Roboto,sans-serif;color:#c9d1d9;-webkit-font-smoothing:antialiased">'
|| '<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">' || v_eyebrow || ' — RareBlock</div>'
|| '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0d1117;padding:0"><tr><td align="center" style="padding:48px 16px">'
|| '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:#161b22;border:1px solid #30363d;border-radius:8px;overflow:hidden">'
-- HEADER
|| '<tr><td align="center" style="padding:36px 36px 28px 36px;border-bottom:1px solid #30363d;background:linear-gradient(180deg,rgba(201,168,76,.04) 0%,transparent 100%)">'
|| '<div style="font-family:''Montserrat'',Arial,sans-serif;font-size:18px;font-weight:300;letter-spacing:.18em;text-transform:uppercase;color:#f0ead8">'
|| 'Rare<span style="color:#c9a84c;font-weight:400">Block</span></div></td></tr>'
-- HEADLINE
|| '<tr><td style="padding:40px 40px 16px 40px">'
|| '<div style="font-family:''IBM Plex Mono'',Consolas,monospace;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#c9a84c;margin-bottom:14px">' || v_eyebrow || '</div>'
|| '<h1 style="margin:0;font-family:Georgia,''Times New Roman'',serif;font-style:italic;font-weight:400;font-size:28px;line-height:1.25;color:#f0ead8">' || v_headline || '</h1>'
|| '</td></tr>'
-- BODY
|| '<tr><td style="padding:14px 40px 8px 40px;font-size:14px;line-height:1.65;color:#c9d1d9">'
|| '<p style="margin:0 0 14px 0;color:#8b949e;font-size:13px">' || v_greeting || '</p>'
|| '<p style="margin:0 0 16px 0">' || v_intro || '</p>';

  IF v_detail IS NOT NULL AND v_detail <> '' THEN
    v_html := v_html || '<p style="margin:0 0 8px 0;font-size:13px;color:#8b949e">' || v_detail || '</p>';
  END IF;

  v_html := v_html || '</td></tr>'
-- CTA
|| '<tr><td align="center" style="padding:24px 40px 32px 40px">'
|| '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
|| '<td align="center" bgcolor="#c9a84c" style="border-radius:4px">'
|| '<a href="' || v_cta_url || '" target="_blank" style="display:inline-block;padding:14px 36px;font-family:-apple-system,BlinkMacSystemFont,''Segoe UI'',Roboto,sans-serif;font-size:13px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#0d1117;text-decoration:none;border-radius:4px">' || v_cta_text || ' →</a>'
|| '</td></tr></table></td></tr>'
-- AUM context strip (solo se AUM > 0)
|| CASE WHEN COALESCE(p_aum, 0) > 0 THEN
     '<tr><td style="padding:0 40px 28px 40px">'
     || '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0d1117;border-left:3px solid #30363d;border-radius:0 4px 4px 0"><tr>'
     || '<td style="padding:14px 18px;font-size:12px;line-height:1.6;color:#8b949e">'
     || '<strong style="color:#c9d1d9">Stato del tuo portafoglio</strong><br>'
     || v_aum_str
     || '</td></tr></table></td></tr>'
   ELSE '' END
-- FOOTER
|| '<tr><td align="center" style="padding:24px 40px 32px 40px;border-top:1px solid #30363d;background:#0d1117">'
|| '<div style="font-size:11px;color:#6e7681;line-height:1.7">'
|| 'RareBlock · Sealed Pokémon Investment Club<br>'
|| '<a href="https://www.rareblock.eu" style="color:#8b949e;text-decoration:none">rareblock.eu</a>'
|| '</div></td></tr>'
|| '</table></td></tr></table></body></html>';

  -- ── Plain text fallback ──
  v_text := v_greeting || E'\n\n'
         || v_headline || E'\n\n'
         || v_intro || E'\n\n'
         || COALESCE(v_detail, '') || E'\n\n'
         || v_cta_text || ': ' || v_cta_url || E'\n\n'
         || '— RareBlock' || E'\nhttps://www.rareblock.eu';

  subject   := v_subject;
  body_html := v_html;
  body_text := v_text;
  RETURN NEXT;
END $$;


-- ══════════════════════════════════════════════════════════════════════
--  2) Trigger AFTER INSERT su inv_tier_history → enqueue email
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.notify_tier_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email      TEXT;
  v_first_name TEXT;
  v_kind       TEXT;
  v_aum        NUMERIC;
  v_tpl        RECORD;
BEGIN
  -- Decide il tipo di notifica:
  --   admin promotion (rank up):    'promotion'
  --   admin demotion (rank down):   'demotion'
  --   expired source:               'expired'
  --   altre fonti (system/signup):  skip
  IF NEW.source = 'expired' THEN
    v_kind := 'expired';
  ELSIF NEW.source = 'admin' THEN
    IF _tier_rank(NEW.to_tier) > _tier_rank(NEW.from_tier) THEN
      v_kind := 'promotion';
    ELSIF _tier_rank(NEW.to_tier) < _tier_rank(NEW.from_tier) THEN
      v_kind := 'demotion';
    ELSE
      RETURN NEW; -- same rank, niente email
    END IF;
  ELSE
    RETURN NEW; -- system/self_signup: niente email
  END IF;

  -- Lookup destinatario
  SELECT u.email,
         COALESCE(p.first_name, p.full_name)
    INTO v_email, v_first_name
    FROM auth.users u
    LEFT JOIN public.profiles p ON p.id = u.id
   WHERE u.id = NEW.user_id;

  IF v_email IS NULL OR v_email = '' THEN
    RETURN NEW; -- senza email niente da inviare
  END IF;

  v_aum := COALESCE(NEW.aum_at_change, public.get_user_aum(NEW.user_id));

  SELECT * INTO v_tpl
    FROM public._render_tier_email(v_kind, NEW.to_tier, NEW.from_tier, v_first_name, v_aum);

  PERFORM public.enqueue_email(
    p_to_email      := v_email,
    p_subject       := v_tpl.subject,
    p_body_html     := v_tpl.body_html,
    p_to_name       := v_first_name,
    p_to_user_id    := NEW.user_id,
    p_body_text     := v_tpl.body_text,
    p_template_code := 'tier_' || v_kind,
    p_context       := jsonb_build_object(
                         'from_tier',     NEW.from_tier,
                         'to_tier',       NEW.to_tier,
                         'manual_override', NEW.manual_override,
                         'source',        NEW.source,
                         'tier_history_id', NEW.id,
                         'aum',           v_aum
                       )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Mai bloccare il cambio tier per un fallimento email
  RAISE WARNING 'notify_tier_change failed (id=%): %', NEW.id, SQLERRM;
  RETURN NEW;
END $$;

-- Helper rank
CREATE OR REPLACE FUNCTION public._tier_rank(p_tier TEXT)
RETURNS INT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE LOWER(COALESCE(p_tier,'basic'))
    WHEN 'gold'  THEN 3
    WHEN 'pro'   THEN 2
    WHEN 'basic' THEN 1
    ELSE 0
  END;
$$;

DROP TRIGGER IF EXISTS trg_notify_tier_change ON public.inv_tier_history;
CREATE TRIGGER trg_notify_tier_change
  AFTER INSERT ON public.inv_tier_history
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_tier_change();


-- ══════════════════════════════════════════════════════════════════════
--  3) Trigger AFTER UPDATE su profiles.gold_eligible_since → email
--     "Sei eleggibile per GOLD" — solo quando passa NULL → timestamp
--     (no spam su update di gold_eligible_aum)
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.notify_gold_eligibility()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email      TEXT;
  v_first_name TEXT;
  v_aum        NUMERIC;
  v_tpl        RECORD;
BEGIN
  -- Solo transizione NULL → not null
  IF OLD.gold_eligible_since IS NOT NULL OR NEW.gold_eligible_since IS NULL THEN
    RETURN NEW;
  END IF;

  -- Skip se già GOLD (improbabile ma difensivo)
  IF NEW.tier = 'gold' THEN
    RETURN NEW;
  END IF;

  SELECT u.email,
         COALESCE(p.first_name, p.full_name)
    INTO v_email, v_first_name
    FROM auth.users u
    LEFT JOIN public.profiles p ON p.id = u.id
   WHERE u.id = NEW.id;

  IF v_email IS NULL OR v_email = '' THEN
    RETURN NEW;
  END IF;

  v_aum := COALESCE(NEW.gold_eligible_aum, public.get_user_aum(NEW.id));

  SELECT * INTO v_tpl
    FROM public._render_tier_email('eligible', NULL, NEW.tier, v_first_name, v_aum);

  PERFORM public.enqueue_email(
    p_to_email      := v_email,
    p_subject       := v_tpl.subject,
    p_body_html     := v_tpl.body_html,
    p_to_name       := v_first_name,
    p_to_user_id    := NEW.id,
    p_body_text     := v_tpl.body_text,
    p_template_code := 'tier_eligible',
    p_context       := jsonb_build_object(
                         'current_tier', NEW.tier,
                         'aum',          v_aum,
                         'eligible_since', NEW.gold_eligible_since
                       )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'notify_gold_eligibility failed (user=%): %', NEW.id, SQLERRM;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_notify_gold_eligibility ON public.profiles;
CREATE TRIGGER trg_notify_gold_eligibility
  AFTER UPDATE OF gold_eligible_since ON public.profiles
  FOR EACH ROW
  WHEN (OLD.gold_eligible_since IS NULL AND NEW.gold_eligible_since IS NOT NULL)
  EXECUTE FUNCTION public.notify_gold_eligibility();


-- ══════════════════════════════════════════════════════════════════════
--  4) RPC admin: invia preview test (per verifica template senza creare
--     una vera promozione)
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.admin_send_tier_email_preview(
  p_to_email TEXT,
  p_kind     TEXT,           -- 'promotion'|'demotion'|'expired'|'eligible'
  p_to_tier  TEXT DEFAULT 'gold',
  p_from_tier TEXT DEFAULT 'basic'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id  UUID;
  v_tpl RECORD;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Forbidden: admin role required' USING ERRCODE = '42501';
  END IF;

  IF p_kind NOT IN ('promotion','demotion','expired','eligible') THEN
    RAISE EXCEPTION 'Invalid kind: %', p_kind;
  END IF;

  SELECT * INTO v_tpl
    FROM public._render_tier_email(p_kind, p_to_tier, p_from_tier, 'Test', 75000);

  v_id := public.enqueue_email(
    p_to_email      := p_to_email,
    p_subject       := '[PREVIEW] ' || v_tpl.subject,
    p_body_html     := v_tpl.body_html,
    p_to_name       := 'Test',
    p_body_text     := v_tpl.body_text,
    p_template_code := 'tier_preview_' || p_kind
  );

  RETURN v_id;
END $$;

GRANT EXECUTE ON FUNCTION public.admin_send_tier_email_preview(TEXT,TEXT,TEXT,TEXT) TO authenticated;


NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 063_tier_email_notifications.sql
--
--  Note operative:
--   • Le email finiscono in email_outbox status='pending'.
--     Lo worker SMTP (Aruba) le processa nel ciclo standard.
--   • Test rapido senza promozione reale:
--     SELECT public.admin_send_tier_email_preview(
--       p_to_email := 'tu@esempio.com',
--       p_kind     := 'promotion',
--       p_to_tier  := 'gold',
--       p_from_tier:= 'pro'
--     );
-- ═══════════════════════════════════════════════════════════════════════
