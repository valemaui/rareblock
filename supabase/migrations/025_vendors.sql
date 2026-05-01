-- ═══════════════════════════════════════════════════════════════════
-- 025_vendors.sql — Gestione venditori (vendor)
--
-- Modello:
-- - Un "vendor" è un utente che può anche essere investor/collector,
--   ma ha in più la capacità di modificare alcuni campi limitati dei
--   prodotti che l'admin gli ha assegnato.
-- - L'admin censisce manualmente i vendor in inv_vendors.
-- - Quando l'admin crea un prodotto, può assegnarlo a un vendor
--   (campo inv_products.vendor_id).
-- - Il vendor NON può creare/cancellare prodotti, e NON può modificare
--   campi sensibili (prezzo, scadenza, total_quotes, status, type).
-- - Il vendor PUÒ modificare: description, cover_photo_url, foto in
--   inv_product_photos, admin_notes (limitatamente alle proprie note).
-- ═══════════════════════════════════════════════════════════════════

-- 1. Tabella anagrafica venditori
CREATE TABLE IF NOT EXISTS inv_vendors (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Account auth associato (può essere null finché non viene creato)
  user_id         UUID UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Anagrafica
  display_name    TEXT NOT NULL,             -- Nome pubblico/commerciale
  legal_name      TEXT,                       -- Ragione sociale legale
  email           TEXT NOT NULL,
  phone           TEXT,
  -- Sede/identificativi fiscali
  is_company      BOOLEAN NOT NULL DEFAULT false,
  fiscal_code     TEXT,                       -- CF (privati) o stesso CF dell'azienda
  vat_number      TEXT,                       -- P.IVA
  pec             TEXT,
  sdi_code        TEXT,
  address         TEXT,
  city            TEXT,
  zip             TEXT,
  country         TEXT DEFAULT 'IT',
  -- Pagamenti
  iban            TEXT,
  bic             TEXT,
  -- Modello commerciale
  commission_pct  NUMERIC(5,2) DEFAULT 0,     -- % di commissione RareBlock sulle vendite
  notes           TEXT,                        -- Note interne admin
  -- Stato
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','suspended','archived')),
  -- Audit
  created_by      UUID REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inv_vendors_status   ON inv_vendors(status);
CREATE INDEX IF NOT EXISTS idx_inv_vendors_user_id  ON inv_vendors(user_id);

-- 2. Aggancio prodotto ↔ venditore (FK opzionale)
ALTER TABLE inv_products
  ADD COLUMN IF NOT EXISTS vendor_id UUID REFERENCES inv_vendors(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_inv_products_vendor_id ON inv_products(vendor_id);

-- 3. Helper: l'utente è un vendor attivo?
CREATE OR REPLACE FUNCTION is_active_vendor(uid UUID DEFAULT auth.uid())
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM inv_vendors
    WHERE user_id = uid AND status = 'active'
  );
$$;

-- 4. Helper: id del vendor associato all'utente (NULL se non è vendor)
CREATE OR REPLACE FUNCTION current_vendor_id()
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT id FROM inv_vendors WHERE user_id = auth.uid() AND status = 'active' LIMIT 1;
$$;

-- 5. RLS sulla tabella inv_vendors
ALTER TABLE inv_vendors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vendors_admin_all ON inv_vendors;
CREATE POLICY vendors_admin_all ON inv_vendors
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS vendors_self_select ON inv_vendors;
CREATE POLICY vendors_self_select ON inv_vendors
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- 6. RLS su inv_products: il vendor può fare UPDATE solo sui propri prodotti
--    e solo su un set ristretto di colonne. La protezione "colonne specifiche"
--    si fa con un trigger BEFORE UPDATE che ripristina i valori vecchi sui campi
--    sensibili quando l'utente è un vendor (non admin).

-- Trigger: per i vendor, blocca modifica a campi sensibili
CREATE OR REPLACE FUNCTION protect_vendor_product_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Se l'utente è admin, non applichiamo restrizioni
  IF is_admin() THEN
    RETURN NEW;
  END IF;
  -- Se non è un vendor attivo, blocca completamente l'update
  IF NOT is_active_vendor() THEN
    RAISE EXCEPTION 'Solo admin o vendor possono modificare i prodotti';
  END IF;
  -- Se è vendor ma non è il proprietario del prodotto, blocca
  IF OLD.vendor_id IS NULL OR OLD.vendor_id <> current_vendor_id() THEN
    RAISE EXCEPTION 'Non puoi modificare prodotti non assegnati al tuo vendor account';
  END IF;
  -- Ripristina i campi sensibili dal valore precedente (anche se il vendor li ha modificati nella richiesta)
  NEW.id              := OLD.id;
  NEW.vendor_id       := OLD.vendor_id;
  NEW.name            := OLD.name;
  NEW.type            := OLD.type;
  NEW.status          := OLD.status;
  NEW.total_quotes    := OLD.total_quotes;
  NEW.price_per_quote := OLD.price_per_quote;
  NEW.target_date     := OLD.target_date;
  NEW.estimated_value := OLD.estimated_value;
  NEW.quote_unit      := OLD.quote_unit;
  NEW.category        := OLD.category;
  NEW.hold_years      := OLD.hold_years;
  NEW.storage_fee     := OLD.storage_fee;
  NEW.grading_house         := OLD.grading_house;
  NEW.grading_cert_number   := OLD.grading_cert_number;
  NEW.grading_cost_estimated:= OLD.grading_cost_estimated;
  NEW.created_by      := OLD.created_by;
  NEW.created_at      := OLD.created_at;
  -- Permessi vendor: description, cover_photo_url, admin_notes possono cambiare
  NEW.updated_at      := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_vendor_product_fields ON inv_products;
CREATE TRIGGER trg_protect_vendor_product_fields
  BEFORE UPDATE ON inv_products
  FOR EACH ROW
  EXECUTE FUNCTION protect_vendor_product_fields();

-- Policy: vendor può UPDATE i propri prodotti (i campi sensibili sono protetti dal trigger)
DROP POLICY IF EXISTS products_vendor_update ON inv_products;
CREATE POLICY products_vendor_update ON inv_products
  FOR UPDATE TO authenticated
  USING (
    is_admin()
    OR (is_active_vendor() AND vendor_id = current_vendor_id())
  )
  WITH CHECK (
    is_admin()
    OR (is_active_vendor() AND vendor_id = current_vendor_id())
  );

-- 7. Vista admin: aggrega vendor + count prodotti + somma vendite
CREATE OR REPLACE VIEW v_admin_vendors AS
SELECT
  v.*,
  COALESCE(p.products_count, 0)    AS products_count,
  COALESCE(p.products_open, 0)     AS products_open,
  COALESCE(p.products_sold_out, 0) AS products_sold_out,
  COALESCE(s.gross_revenue, 0)     AS gross_revenue,
  COALESCE(s.commission_amount, 0) AS commission_amount
FROM inv_vendors v
LEFT JOIN (
  SELECT
    vendor_id,
    COUNT(*) FILTER (WHERE vendor_id IS NOT NULL)             AS products_count,
    COUNT(*) FILTER (WHERE status='open' OR status='closing_soon') AS products_open,
    COUNT(*) FILTER (WHERE status='sold_out' OR status='liquidated') AS products_sold_out
  FROM inv_products
  WHERE vendor_id IS NOT NULL
  GROUP BY vendor_id
) p ON p.vendor_id = v.id
LEFT JOIN (
  SELECT
    pr.vendor_id,
    SUM(pay.amount)                                AS gross_revenue,
    SUM(pay.amount * v2.commission_pct / 100.0)    AS commission_amount
  FROM inv_payments pay
  JOIN inv_products pr ON pr.id = pay.product_id
  JOIN inv_vendors  v2 ON v2.id = pr.vendor_id
  WHERE pay.status = 'confirmed' AND pr.vendor_id IS NOT NULL
  GROUP BY pr.vendor_id
) s ON s.vendor_id = v.id;

-- RLS sulla view: solo admin
GRANT SELECT ON v_admin_vendors TO authenticated;

-- 8. Vista vendor: solo i propri prodotti con statistiche
CREATE OR REPLACE VIEW v_vendor_products AS
SELECT
  p.*,
  COALESCE(s.sold_quotes, 0)        AS sold_quotes,
  COALESCE(s.available_quotes, p.total_quotes) AS available_quotes,
  COALESCE(s.total_raised, 0)       AS total_raised
FROM inv_products p
LEFT JOIN inv_product_stats s ON s.id = p.id
WHERE p.vendor_id = current_vendor_id();

GRANT SELECT ON v_vendor_products TO authenticated;

-- ═══════════════════════════════════════════════════════════════════
-- FINE 025_vendors.sql
-- ═══════════════════════════════════════════════════════════════════
