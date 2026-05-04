-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Modulo Contratti — PR6 #1/4
--  Migration 035: tabelle core dei contratti
--
--  Tre tabelle:
--   1) contract_templates   — versioni dei template Markdown firmabili
--   2) contracts            — istanze concrete (1 riga = 1 contratto firmato/in firma)
--   3) contract_signature_audit — log dettagliato di ogni evento di firma
--
--  Riferimento normativo:
--   - art. 26 Reg. UE 910/2014 (eIDAS): FEA via SMS OTP
--   - art. 20 D.Lgs. 82/2005 (CAD italiano): valore probatorio FEA
--   - D.Lgs. 231/2007: retention 10 anni (vedi platform_settings)
--
--  La FK formale verso contract_notarizations.contract_id viene risolta
--  in fondo al file (alter table) perché la tabella contracts deve esistere
--  prima.
-- ═══════════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════════
--  1) Sequence per i numeri contratto univoci
-- ══════════════════════════════════════════════════════════════════════
-- Pattern numero: RB-{TIPO}-{ANNO}-{NNNNNN}
--   RB-VND-2026-000001  → vendor mandate
--   RB-BUY-2026-000001  → buyer purchase custody
--   RB-FRC-2026-000001  → buyer fractional (modalità B)
CREATE SEQUENCE IF NOT EXISTS public.contract_number_seq
  START 1 INCREMENT 1 CYCLE MAXVALUE 999999;

CREATE OR REPLACE FUNCTION public.next_contract_number(p_type TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_prefix TEXT;
  v_year   TEXT := to_char(now(), 'YYYY');
  v_n      BIGINT;
BEGIN
  v_prefix := CASE p_type
    WHEN 'vendor_mandate'           THEN 'VND'
    WHEN 'buyer_purchase_custody'   THEN 'BUY'
    WHEN 'buyer_fractional'         THEN 'FRC'
    ELSE                                  'OTH'
  END;
  v_n := nextval('contract_number_seq');
  RETURN 'RB-' || v_prefix || '-' || v_year || '-' || lpad(v_n::TEXT, 6, '0');
END $$;


-- ══════════════════════════════════════════════════════════════════════
--  2) contract_templates
-- ══════════════════════════════════════════════════════════════════════
-- Ogni template ha (code, version) univoci. is_active=true significa
-- "usabile in produzione". I draft restano is_active=false fino al
-- via libera del legale (vedi §10 design doc).
CREATE TABLE IF NOT EXISTS public.contract_templates (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  code                TEXT NOT NULL,           -- 'VENDOR_MANDATE' | 'BUYER_PURCHASE_CUSTODY' | ...
  version             INT  NOT NULL,           -- monotono per code

  title               TEXT NOT NULL,
  description         TEXT,
  body_md             TEXT NOT NULL,           -- testo Markdown con placeholder {{xxx}}

  -- Allegati standard (Markdown), opzionali
  privacy_doc_md      TEXT,                    -- Allegato Privacy / GDPR
  fea_doc_md          TEXT,                    -- Informativa Firma Elettronica Avanzata
  recess_form_md      TEXT,                    -- Modulo recesso consumatore (solo buyer)

  -- Metadata dei placeholder usati (per validazione pre-render)
  required_placeholders TEXT[] DEFAULT ARRAY[]::TEXT[],

  is_active           BOOLEAN NOT NULL DEFAULT false,
  effective_from      TIMESTAMPTZ DEFAULT now(),

  -- Audit revisione legale
  legal_review_by     TEXT,
  legal_review_date   DATE,
  legal_review_notes  TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  UNIQUE (code, version)
);

CREATE INDEX IF NOT EXISTS idx_templates_code_active
  ON public.contract_templates (code, version DESC)
  WHERE is_active;


-- ══════════════════════════════════════════════════════════════════════
--  3) contracts
-- ══════════════════════════════════════════════════════════════════════
-- 1 riga = 1 contratto generato (in stato draft / signed / revoked / ...)
-- Le snapshots JSONB CONGELANO i dati al momento della firma:
--   - party_snapshot      = anagrafica utente (così se cambia poi, il
--                            contratto firmato resta coerente)
--   - counterparty_snapshot = dati RareBlock (rag.soc., P.IVA, sede, polizza, ...)
--   - subject_data        = dettaglio dell'oggetto (prodotto, prezzi, fee, ...)
--   - template_snapshot   = template_md effettivo usato (perché i template
--                            possono evolvere)
CREATE TABLE IF NOT EXISTS public.contracts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_number       TEXT UNIQUE NOT NULL,

  -- Riferimento al template
  template_id           UUID NOT NULL REFERENCES public.contract_templates(id) ON DELETE RESTRICT,
  template_code         TEXT NOT NULL,
  template_version      INT  NOT NULL,
  template_snapshot_md  TEXT NOT NULL,              -- testo MD effettivo usato

  -- Tipologia (deve combaciare col template ma duplicato per indici/filtri)
  subject_type          TEXT NOT NULL,
  CONSTRAINT contracts_subject_type_chk CHECK (subject_type IN
    ('vendor_mandate','buyer_purchase_custody','buyer_fractional')),

  -- Parti
  party_user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  party_snapshot        JSONB NOT NULL,             -- anagrafica congelata
  counterparty_snapshot JSONB NOT NULL,             -- dati RareBlock al momento

  -- Aggancio a entità di business (se applicabile)
  related_product_id    UUID REFERENCES public.inv_products(id) ON DELETE SET NULL,
  related_order_id      UUID REFERENCES public.inv_orders(id)   ON DELETE SET NULL,
  related_holding_id    UUID REFERENCES public.inv_holdings(id) ON DELETE SET NULL,
  related_vendor_id     UUID REFERENCES public.inv_vendors(id)  ON DELETE SET NULL,

  subject_data          JSONB NOT NULL,             -- prezzi, qty, commissione, custodia, ecc.

  -- PDF
  pdf_unsigned_path     TEXT,                       -- bucket 'contracts-unsigned'
  pdf_signed_path       TEXT,                       -- bucket 'contracts-signed'
  pdf_unsigned_sha256   TEXT,
  pdf_signed_sha256     TEXT,

  -- Stato workflow
  status                TEXT NOT NULL DEFAULT 'draft',
  CONSTRAINT contracts_status_chk CHECK (status IN
    ('draft','pending_signature','signed','rejected','expired','revoked')),

  -- Firma
  signed_at             TIMESTAMPTZ,
  signature_method      TEXT,                       -- 'sms_otp_fea'
  signature_audit       JSONB,                      -- snapshot del verbale firma

  -- Notarizzazione (FK soft a contract_notarizations)
  notarization_id       UUID,                       -- soft FK, non vincolante

  -- Validità / scadenza
  expires_at            TIMESTAMPTZ,
  revoked_at            TIMESTAMPTZ,
  revoked_by            UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  revoke_reason         TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by            UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_contracts_party
  ON public.contracts (party_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contracts_status
  ON public.contracts (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contracts_subject
  ON public.contracts (subject_type, status);
CREATE INDEX IF NOT EXISTS idx_contracts_product
  ON public.contracts (related_product_id) WHERE related_product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contracts_signed_sha
  ON public.contracts (pdf_signed_sha256) WHERE pdf_signed_sha256 IS NOT NULL;


-- ══════════════════════════════════════════════════════════════════════
--  4) contract_signature_audit
-- ══════════════════════════════════════════════════════════════════════
-- Log eventi: una riga per ogni evento del ciclo di vita del contratto.
-- Append-only, mai modificato/cancellato.
CREATE TABLE IF NOT EXISTS public.contract_signature_audit (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id   UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,

  event_type    TEXT NOT NULL,
  event_data    JSONB,
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ip            INET,
  user_agent    TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT audit_event_type_chk CHECK (event_type IN
    ('prepared','viewed','consents_accepted','otp_sent','otp_verified',
     'pdf_signed','notarized','emailed','revoked','rejected','expired'))
);

CREATE INDEX IF NOT EXISTS idx_audit_contract
  ON public.contract_signature_audit (contract_id, created_at);


-- ══════════════════════════════════════════════════════════════════════
--  5) RLS
-- ══════════════════════════════════════════════════════════════════════
ALTER TABLE public.contract_templates         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contracts                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_signature_audit   ENABLE ROW LEVEL SECURITY;

-- contract_templates: lettura pubblica solo dei template attivi (utenti devono
-- vedere il testo prima di firmare); scrittura solo admin.
DROP POLICY IF EXISTS templates_read_active ON public.contract_templates;
CREATE POLICY templates_read_active ON public.contract_templates
  FOR SELECT TO authenticated
  USING (is_active = true);

DROP POLICY IF EXISTS templates_admin_all ON public.contract_templates;
CREATE POLICY templates_admin_all ON public.contract_templates
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- contracts: l'utente vede i propri (firmatario), admin vede tutto.
-- Scrittura: solo via Edge Function service_role.
DROP POLICY IF EXISTS contracts_self_select ON public.contracts;
CREATE POLICY contracts_self_select ON public.contracts
  FOR SELECT TO authenticated
  USING (party_user_id = auth.uid());

DROP POLICY IF EXISTS contracts_admin_all ON public.contracts;
CREATE POLICY contracts_admin_all ON public.contracts
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- audit: stessa logica
DROP POLICY IF EXISTS audit_self_select ON public.contract_signature_audit;
CREATE POLICY audit_self_select ON public.contract_signature_audit
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM contracts c WHERE c.id = contract_id AND c.party_user_id = auth.uid()));

DROP POLICY IF EXISTS audit_admin_all ON public.contract_signature_audit;
CREATE POLICY audit_admin_all ON public.contract_signature_audit
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());


-- ══════════════════════════════════════════════════════════════════════
--  6) Storage buckets per PDF
-- ══════════════════════════════════════════════════════════════════════
-- Bucket privati: solo il proprietario + admin possono leggere/scrivere.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('contracts-unsigned', 'contracts-unsigned', false, 26214400, ARRAY['application/pdf']),
  ('contracts-signed',   'contracts-signed',   false, 26214400, ARRAY['application/pdf'])
ON CONFLICT (id) DO NOTHING;

-- Policy: il path inizia con '<user_id>/' → owner only
DROP POLICY IF EXISTS "contracts_unsigned_self_read" ON storage.objects;
CREATE POLICY "contracts_unsigned_self_read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'contracts-unsigned' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "contracts_signed_self_read" ON storage.objects;
CREATE POLICY "contracts_signed_self_read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'contracts-signed' AND (storage.foldername(name))[1] = auth.uid()::text);

-- Admin: full access su entrambi i bucket
DROP POLICY IF EXISTS "contracts_admin_all" ON storage.objects;
CREATE POLICY "contracts_admin_all" ON storage.objects
  FOR ALL TO authenticated
  USING ((bucket_id IN ('contracts-unsigned','contracts-signed')) AND public.is_admin())
  WITH CHECK ((bucket_id IN ('contracts-unsigned','contracts-signed')) AND public.is_admin());


-- ══════════════════════════════════════════════════════════════════════
--  7) Soft FK contract_notarizations → contracts
-- ══════════════════════════════════════════════════════════════════════
-- Ora che contracts esiste, rendiamo formale la FK.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_notar_contract'
  ) THEN
    ALTER TABLE public.contract_notarizations
      ADD CONSTRAINT fk_notar_contract
      FOREIGN KEY (contract_id)
      REFERENCES public.contracts(id)
      ON DELETE SET NULL;
  END IF;
END $$;


-- ══════════════════════════════════════════════════════════════════════
--  8) View: contracts dell'utente con stato leggibile
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW public.v_my_contracts AS
SELECT
  c.id,
  c.contract_number,
  c.subject_type,
  c.template_code,
  c.template_version,
  c.status,
  c.signed_at,
  c.expires_at,
  c.created_at,
  c.related_product_id,
  c.related_vendor_id,
  -- Info dal counterparty snapshot (rag. soc. RareBlock)
  c.counterparty_snapshot->>'company_legal_name' AS counterparty_name,
  -- Riferimento al subject (es. nome prodotto)
  c.subject_data->>'product_name' AS subject_label,
  c.subject_data->>'amount_eur'   AS subject_amount,
  -- Notarizzazione status
  n.status        AS notarization_status,
  n.tx_hash       AS notarization_tx_hash,
  n.block_number  AS notarization_block
FROM public.contracts c
LEFT JOIN public.contract_notarizations n
  ON n.id = c.notarization_id
WHERE c.party_user_id = auth.uid();

GRANT SELECT ON public.v_my_contracts TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
--  9) View admin: contratti con join party + audit count
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW public.v_admin_contracts AS
SELECT
  c.*,
  p.email      AS party_email,
  p.full_name  AS party_full_name,
  p.first_name AS party_first_name,
  p.last_name  AS party_last_name,
  (SELECT COUNT(*) FROM contract_signature_audit a WHERE a.contract_id = c.id) AS audit_count,
  n.status        AS notarization_status,
  n.tx_hash       AS notarization_tx_hash,
  n.block_number  AS notarization_block,
  n.block_timestamp AS notarization_block_ts
FROM public.contracts c
LEFT JOIN public.profiles p ON p.id = c.party_user_id
LEFT JOIN public.contract_notarizations n ON n.id = c.notarization_id;

-- La RLS della tabella sottostante (contracts) si applica → questa view
-- mostrerà tutto solo se l'utente è admin.
GRANT SELECT ON public.v_admin_contracts TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
-- 10) Reload PostgREST + verifica
-- ══════════════════════════════════════════════════════════════════════
NOTIFY pgrst, 'reload schema';

SELECT
  'contract_templates'        AS object, COUNT(*)::TEXT AS rows FROM public.contract_templates
UNION ALL SELECT 'contracts', COUNT(*)::TEXT FROM public.contracts
UNION ALL SELECT 'contract_signature_audit', COUNT(*)::TEXT FROM public.contract_signature_audit
UNION ALL SELECT 'next_contract_number(vendor)', public.next_contract_number('vendor_mandate')
UNION ALL SELECT 'next_contract_number(buyer)',  public.next_contract_number('buyer_purchase_custody');

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 035_contracts.sql
-- ═══════════════════════════════════════════════════════════════════════
