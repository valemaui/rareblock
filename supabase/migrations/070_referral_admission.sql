-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Migration 070: Admission gate / codici referral
--
--  Obiettivo: la registrazione al portale NON è aperta. L'accesso è riservato
--  a collezionisti referenziati (codice invito fornito da un membro / dal
--  founder) oppure su richiesta previa call conoscitiva.
--
--  Questa migration crea l'infrastruttura server-side che valida i codici,
--  speculare a validate_memorandum_key (vedi memorandum.html). Il client
--  (rareblock-accesso.html + rareblock-login.html) chiama la RPC
--  validate_referral_code via PostgREST con la sola anon key.
--
--  Componenti:
--    1. inv_referral_codes      — anagrafica codici (chi, quante slot, scadenza)
--    2. inv_referral_redemptions — log tentativi/usi (audit + anti-bruteforce)
--    3. validate_referral_code   — RPC SECURITY DEFINER: valida e logga
--    4. consume_referral_code    — RPC: marca un codice come usato a signup ok
--    5. RLS: lettura/scrittura solo a service_role; le RPC sono l'unica via
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Anagrafica codici ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.inv_referral_codes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Codice normalizzato (lowercase, no spazi). Quello mostrato all'utente può
  -- essere in maiuscolo / con trattini: il client normalizza prima di inviare.
  code            text NOT NULL UNIQUE,
  -- Etichetta interna: chi ha generato il codice / a chi è destinato.
  label           text,
  -- Tipo di provenienza: 'member' (referral di un socio), 'founder' (invito
  -- diretto), 'campaign' (campagna marketing chiusa), 'partner'.
  source_type     text NOT NULL DEFAULT 'member'
                    CHECK (source_type IN ('member','founder','campaign','partner')),
  -- Socio che ha generato il referral (se applicabile).
  referrer_user   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Quante registrazioni può sbloccare il codice. NULL = illimitato.
  max_uses        integer,
  uses            integer NOT NULL DEFAULT 0,
  -- Scadenza opzionale.
  expires_at      timestamptz,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  notes           text
);

CREATE INDEX IF NOT EXISTS idx_inv_referral_codes_code
  ON public.inv_referral_codes (code) WHERE is_active;

-- ── 2. Log redemption (audit + rate-limit) ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.inv_referral_redemptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL,
  code_id       uuid REFERENCES public.inv_referral_codes(id) ON DELETE SET NULL,
  outcome       text NOT NULL CHECK (outcome IN ('valid','invalid','expired','exhausted','inactive','consumed')),
  -- Email dell'utente che ha poi completato il signup (popolata da consume).
  redeemed_email text,
  user_agent    text,
  referrer      text,
  ip_hint       text,
  country_hint  text,
  city_hint     text,
  language      text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inv_referral_redemptions_code
  ON public.inv_referral_redemptions (code, created_at DESC);

-- ── 3. RLS: tutto chiuso, l'accesso passa solo dalle RPC ─────────────────
ALTER TABLE public.inv_referral_codes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inv_referral_redemptions  ENABLE ROW LEVEL SECURITY;

-- Nessuna policy per anon/authenticated: lettura/scrittura diretta negata.
-- Solo service_role (Dashboard, edge functions con service key) bypassa RLS.
-- Le RPC sotto sono SECURITY DEFINER e fanno da unica superficie pubblica.

-- ── 4. RPC: validazione (chiamata dal gate, anon key) ────────────────────
--  Ritorna jsonb { valid:boolean, reason:text, source_type:text, label:text }.
--  NON consuma il codice (quello avviene a signup completato, vedi consume).
--  Logga ogni tentativo per audit/anti-bruteforce.
CREATE OR REPLACE FUNCTION public.validate_referral_code(
  p_code          text,
  p_user_agent    text DEFAULT NULL,
  p_referrer      text DEFAULT NULL,
  p_ip_hint       text DEFAULT NULL,
  p_country_hint  text DEFAULT NULL,
  p_city_hint     text DEFAULT NULL,
  p_language      text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code   text := lower(btrim(coalesce(p_code,'')));
  rec      public.inv_referral_codes%ROWTYPE;
  v_outcome text;
  v_valid  boolean := false;
  v_reason text;
BEGIN
  IF v_code = '' THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'empty');
  END IF;

  SELECT * INTO rec FROM public.inv_referral_codes
   WHERE code = v_code
   ORDER BY created_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    v_outcome := 'invalid'; v_reason := 'not_found';
  ELSIF NOT rec.is_active THEN
    v_outcome := 'inactive'; v_reason := 'inactive';
  ELSIF rec.expires_at IS NOT NULL AND rec.expires_at < now() THEN
    v_outcome := 'expired'; v_reason := 'expired';
  ELSIF rec.max_uses IS NOT NULL AND rec.uses >= rec.max_uses THEN
    v_outcome := 'exhausted'; v_reason := 'exhausted';
  ELSE
    v_outcome := 'valid'; v_valid := true; v_reason := 'ok';
  END IF;

  INSERT INTO public.inv_referral_redemptions
    (code, code_id, outcome, user_agent, referrer, ip_hint, country_hint, city_hint, language)
  VALUES
    (v_code, rec.id, v_outcome, p_user_agent, p_referrer, p_ip_hint, p_country_hint, p_city_hint, p_language);

  RETURN jsonb_build_object(
    'valid',       v_valid,
    'reason',      v_reason,
    'source_type', rec.source_type,
    'label',       rec.label
  );
END;
$$;

-- ── 5. RPC: consumo (chiamata a signup completato con successo) ──────────
--  Incrementa il contatore usi in modo atomico e logga l'email associata.
--  Idempotente per (code, email): più chiamate con la stessa email non
--  incrementano due volte (utile coi retry di rete del client).
CREATE OR REPLACE FUNCTION public.consume_referral_code(
  p_code  text,
  p_email text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code  text := lower(btrim(coalesce(p_code,'')));
  v_email text := lower(btrim(coalesce(p_email,'')));
  rec     public.inv_referral_codes%ROWTYPE;
BEGIN
  IF v_code = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'empty');
  END IF;

  SELECT * INTO rec FROM public.inv_referral_codes WHERE code = v_code FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- Idempotenza: se questa email ha già consumato il codice, no-op.
  IF EXISTS (
    SELECT 1 FROM public.inv_referral_redemptions
     WHERE code = v_code AND outcome = 'consumed' AND redeemed_email = v_email
  ) THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_consumed');
  END IF;

  UPDATE public.inv_referral_codes SET uses = uses + 1 WHERE id = rec.id;

  INSERT INTO public.inv_referral_redemptions (code, code_id, outcome, redeemed_email)
  VALUES (v_code, rec.id, 'consumed', v_email);

  RETURN jsonb_build_object('ok', true, 'reason', 'consumed');
END;
$$;

-- ── 6. Grants: anon/authenticated possono SOLO eseguire le RPC ───────────
REVOKE ALL ON FUNCTION public.validate_referral_code(text,text,text,text,text,text,text) FROM public;
REVOKE ALL ON FUNCTION public.consume_referral_code(text,text) FROM public;
GRANT EXECUTE ON FUNCTION public.validate_referral_code(text,text,text,text,text,text,text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_referral_code(text,text) TO anon, authenticated;

-- ── 7. Seed di comodo (DISATTIVATO) ──────────────────────────────────────
--  Decommenta e personalizza per creare i primi codici founder.
-- INSERT INTO public.inv_referral_codes (code, label, source_type, max_uses)
-- VALUES
--   ('founder-2026',  'Inviti diretti founder', 'founder',  50),
--   ('rb-vintage',    'Campagna collezionisti vintage', 'campaign', 100);

-- ═══════════════════════════════════════════════════════════════════════
--  Note rollout:
--   • Applicare PRIMA del deploy front-end, altrimenti il gate (fail-closed)
--     respinge tutti finché la RPC non esiste.
--   • Per generare codici: INSERT in inv_referral_codes (o futura UI admin,
--     speculare a "Chiavi invito" del memorandum in frames-investor/admin.html).
--   • Link referral pronto all'uso:  https://rareblock.eu/rareblock-accesso.html?ref=CODICE
-- ═══════════════════════════════════════════════════════════════════════
