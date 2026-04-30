-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Storico vendite pubblico (per detail page fractional)
--
--  Vista pubblica con dati anonimizzati:
--   - data acquisizione
--   - quantità quote
--   - hash 8-char dell'user_id (privacy: niente email/nome/full uuid)
--   - origin (primary = catalogo, secondary = scambio peer-to-peer)
--   - prezzo per quota
--   - tipo prodotto (filtro fractional applicato lato view)
-- ═══════════════════════════════════════════════════════════════════════

DROP VIEW IF EXISTS public.v_inv_holdings_public;

CREATE VIEW public.v_inv_holdings_public
WITH (security_invoker = false)  -- bypass RLS holdings: la view stessa filtra
AS
SELECT
  h.id,
  h.product_id,
  h.qty,
  h.price_per_quote,
  h.acquired_at,
  h.origin,
  -- Hash deterministico dell'user_id: 8 caratteri esa sufficienti
  -- per pseudo-anonymization (16M combinazioni). Niente email/nome.
  upper(substr(md5(h.user_id::text), 1, 8)) AS user_hash
FROM public.inv_holdings h
JOIN public.inv_products p ON p.id = h.product_id
WHERE p.type = 'fractional';

-- Lettura pubblica (chiunque autenticato può vedere lo storico anonimizzato)
GRANT SELECT ON public.v_inv_holdings_public TO authenticated;

-- Reload PostgREST
NOTIFY pgrst, 'reload schema';

-- Verifica
SELECT product_id, qty, user_hash, acquired_at, origin
FROM public.v_inv_holdings_public
ORDER BY acquired_at DESC
LIMIT 5;
