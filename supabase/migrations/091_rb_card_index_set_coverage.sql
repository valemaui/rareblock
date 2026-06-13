-- ════════════════════════════════════════════════════════════════════════
--  091 · Copertura indice per set (pannello admin Censimento)
--  ----------------------------------------------------------------------
--  Aggregato per set_id su rb_card_index: quante carte indicizzate (con URL
--  CM verificato), quante con prezzo NM, quante con immagine, e l'ultimo
--  rinfresco. Alimenta la sezione "Copertura per set" del pannello admin,
--  che poi affianca lato client il totale carte del set (TCG API) per la %.
--  Solo admin (is_admin()), SECURITY DEFINER.
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rb_card_index_set_coverage()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows jsonb;
  v_set_count int;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Forbidden: admin only' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_agg(
           jsonb_build_object(
             'set_id',     set_id,
             'set_name',   set_name,
             'indexed',    indexed,
             'priced',     priced,
             'with_image', with_image,
             'last_at',    last_at
           )
           ORDER BY indexed DESC, set_name ASC
         )
    INTO v_rows
  FROM (
    SELECT
      set_id,
      max(set_name) AS set_name,
      count(*) FILTER (WHERE cm_url IS NOT NULL) AS indexed,
      count(*) FILTER (WHERE cm_url IS NOT NULL
                       AND (price_nm IS NOT NULL OR price_nm_weighted IS NOT NULL)) AS priced,
      count(*) FILTER (WHERE cm_url IS NOT NULL
                       AND (image_url IS NOT NULL OR image_source_url IS NOT NULL)) AS with_image,
      max(coalesce(last_refresh_at, last_verified_at, price_updated_at)) AS last_at
    FROM public.rb_card_index
    WHERE set_id IS NOT NULL
    GROUP BY set_id
    HAVING count(*) FILTER (WHERE cm_url IS NOT NULL) > 0
  ) q;

  SELECT count(DISTINCT set_id)
    INTO v_set_count
  FROM public.rb_card_index
  WHERE set_id IS NOT NULL AND cm_url IS NOT NULL;

  RETURN jsonb_build_object(
    'sets',      COALESCE(v_rows, '[]'::jsonb),
    'set_count', COALESCE(v_set_count, 0)
  );
END $$;

REVOKE ALL ON FUNCTION public.rb_card_index_set_coverage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rb_card_index_set_coverage() TO authenticated;

NOTIFY pgrst, 'reload schema';
