-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Migration 080: alias set_name mancanti in cm_set_name_map
--
--  Contesto: la collezione (tabella cards) salva i set EX SENZA il prefisso
--  "EX " (es. "Delta Species", "Deoxys", "Hidden Legends", "Team Rocket
--  Returns"), mentre la mappa CM_SET_NAME_TO_ID / cm_set_name_map (079) li
--  aveva solo con prefisso ("EX Delta Species" -> ex11). Risultato:
--  rb_set_id_from_name('Delta Species') tornava '' e la valutazione della
--  collezione falliva (n_valued=0 su quelle carte).
--
--  Aggiunge gli alias senza prefisso + "Shining Legends" (sm3pt5, mancante).
--  Idempotente (ON CONFLICT). Da applicare DOPO la 079.
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO public.cm_set_name_map (set_name, set_id) VALUES
  ('Ruby & Sapphire',        'ex1'),
  ('Sandstorm',              'ex2'),
  ('Dragon',                 'ex3'),
  ('Team Magma vs Team Aqua','ex4'),
  ('Hidden Legends',         'ex5'),
  ('FireRed & LeafGreen',    'ex6'),
  ('Team Rocket Returns',    'ex7'),
  ('Deoxys',                 'ex8'),
  ('Emerald',                'ex9'),
  ('Unseen Forces',          'ex10'),
  ('Delta Species',          'ex11'),
  ('Legend Maker',           'ex12'),
  ('Holon Phantoms',         'ex13'),
  ('Crystal Guardians',      'ex14'),
  ('Dragon Frontiers',       'ex15'),
  ('Power Keepers',          'ex16'),
  ('Shining Legends',        'sm3pt5')
ON CONFLICT (set_name) DO UPDATE SET set_id = EXCLUDED.set_id;

NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════
--  Verifica:
--   SELECT public.rb_set_id_from_name('Delta Species');  -- atteso: ex11
--   SELECT public.rb_set_id_from_name('Hidden Legends');  -- atteso: ex5
--   SELECT * FROM public.collection_value_compute('<TUO_UUID>');  -- n_valued sale
--    (dopo aver popolato i prezzi: vedi nota nel commit)
-- ═══════════════════════════════════════════════════════════════════════
