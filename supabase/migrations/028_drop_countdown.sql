-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Drop Countdown
--
--  Singleton-style table per configurare un countdown 16:9 cinematic
--  visibile a tutti gli investor sopra il marketplace.
--
--  Funzionamento:
--    - Admin imposta product_id (un inv_products in stato 'draft') + target_at
--    - Banner mostra countdown live nella vista marketplace
--    - Quando target_at <= now(), RPC drop_release_product() promuove
--      il prodotto da 'draft' a 'open' (o lascia status corrente se != draft)
--    - Banner mostra "DROP LIVE" + CTA al prodotto
--
--  Idempotente: si può rieseguire senza errori.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.inv_drop_countdown (
  id            INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- singleton
  active        BOOLEAN NOT NULL DEFAULT FALSE,
  product_id    UUID REFERENCES public.inv_products(id) ON DELETE SET NULL,
  target_at     TIMESTAMPTZ,
  title_override TEXT,            -- override del nome prodotto se valorizzato
  subtitle      TEXT,             -- riga aggiuntiva opzionale (es. "Drop esclusivo")
  released_at   TIMESTAMPTZ,      -- popolato dalla RPC quando il prodotto viene rilasciato
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by    UUID REFERENCES auth.users(id)
);

-- Riga singleton iniziale
INSERT INTO public.inv_drop_countdown (id, active)
VALUES (1, FALSE)
ON CONFLICT (id) DO NOTHING;

-- ── RLS: tutti gli auth users leggono, solo admin scrive ─────────────
ALTER TABLE public.inv_drop_countdown ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "drop_countdown_select_all" ON public.inv_drop_countdown;
CREATE POLICY "drop_countdown_select_all"
  ON public.inv_drop_countdown
  FOR SELECT
  USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "drop_countdown_admin_write" ON public.inv_drop_countdown;
CREATE POLICY "drop_countdown_admin_write"
  ON public.inv_drop_countdown
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role = 'admin'
    )
  );

-- ── RPC: rilascia prodotto se countdown scaduto ──────────────────────
-- Chiamabile da qualsiasi auth user (rendiamo idempotente: agisce solo
-- se target_at <= now(), released_at IS NULL e prodotto in stato draft).
CREATE OR REPLACE FUNCTION public.drop_release_product()
RETURNS TABLE(released BOOLEAN, product_id UUID, new_status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  cfg   RECORD;
  prod  RECORD;
BEGIN
  SELECT * INTO cfg FROM public.inv_drop_countdown WHERE id = 1;

  IF cfg IS NULL OR NOT cfg.active OR cfg.product_id IS NULL
     OR cfg.target_at IS NULL OR cfg.target_at > NOW()
     OR cfg.released_at IS NOT NULL THEN
    RETURN QUERY SELECT FALSE, cfg.product_id, NULL::TEXT;
    RETURN;
  END IF;

  SELECT id, status INTO prod FROM public.inv_products WHERE id = cfg.product_id;
  IF prod IS NULL THEN
    UPDATE public.inv_drop_countdown SET released_at = NOW() WHERE id = 1;
    RETURN QUERY SELECT FALSE, cfg.product_id, NULL::TEXT;
    RETURN;
  END IF;

  -- Promuove solo se in draft, altrimenti lascia stato corrente
  IF prod.status = 'draft' THEN
    UPDATE public.inv_products
       SET status = 'open', updated_at = NOW()
     WHERE id = cfg.product_id;
  END IF;

  UPDATE public.inv_drop_countdown
     SET released_at = NOW()
   WHERE id = 1;

  RETURN QUERY
    SELECT TRUE, cfg.product_id,
           (SELECT status FROM public.inv_products WHERE id = cfg.product_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.drop_release_product() TO authenticated;

-- ── View pubblica: include nome prodotto + slug-friendly per il banner
DROP VIEW IF EXISTS public.v_drop_countdown CASCADE;
CREATE VIEW public.v_drop_countdown AS
SELECT
  c.id,
  c.active,
  c.product_id,
  c.target_at,
  c.title_override,
  c.subtitle,
  c.released_at,
  c.updated_at,
  p.name      AS product_name,
  p.status    AS product_status,
  p.image_url AS product_image_url
FROM public.inv_drop_countdown c
LEFT JOIN public.inv_products p ON p.id = c.product_id
WHERE c.id = 1;

GRANT SELECT ON public.v_drop_countdown TO authenticated, anon;

-- ═══════════════════════════════════════════════════════════════════════
--  Verifica:
--    SELECT * FROM v_drop_countdown;
--    SELECT * FROM drop_release_product();
-- ═══════════════════════════════════════════════════════════════════════
