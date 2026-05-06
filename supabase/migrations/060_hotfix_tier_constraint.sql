-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Migration 060: hotfix per 059 buyer tiers
--
--  Problema: il CHECK constraint profiles_tier_chk fallisce perchè la
--  colonna tier conteneva NULL o valori legacy (es. 'free','member',...)
--  in righe esistenti. La 059 usa ADD COLUMN IF NOT EXISTS con DEFAULT
--  'basic' ma se la colonna esisteva gia' lo skip lascia i valori vecchi.
--
--  Soluzione: normalizza i valori prima di applicare il constraint.
-- ═══════════════════════════════════════════════════════════════════════

-- 1) Drop constraint se gia' presente (per ri-applicarlo dopo normalizzazione)
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_tier_chk;

-- 2) Diagnostica: mostra valori non validi (output informativo)
DO $$
DECLARE
  r RECORD;
BEGIN
  RAISE NOTICE 'Distribuzione attuale colonna tier:';
  FOR r IN
    SELECT COALESCE(tier,'(NULL)') AS v, COUNT(*) AS n
      FROM public.profiles
      GROUP BY 1
      ORDER BY 2 DESC
  LOOP
    RAISE NOTICE '  % → % righe', r.v, r.n;
  END LOOP;
END $$;

-- 3) Normalizza: ogni valore non in ('basic','pro','gold') diventa 'basic'.
--    NULL → 'basic'. Mapping case-insensitive per sicurezza.
UPDATE public.profiles
   SET tier = 'basic'
 WHERE tier IS NULL
    OR LOWER(tier) NOT IN ('basic','pro','gold');

UPDATE public.profiles
   SET tier = LOWER(tier)
 WHERE tier IN ('BASIC','PRO','GOLD','Basic','Pro','Gold');

-- 4) Imposta NOT NULL (la 059 lo fa solo per nuove colonne)
ALTER TABLE public.profiles
  ALTER COLUMN tier SET DEFAULT 'basic',
  ALTER COLUMN tier SET NOT NULL;

-- 5) Riapplica il constraint
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_tier_chk CHECK (tier IN ('basic','pro','gold'));

-- 6) Verifica finale
SELECT tier, COUNT(*) AS n
  FROM public.profiles
  GROUP BY tier
  ORDER BY 1;

NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 060_hotfix_tier_constraint.sql
-- ═══════════════════════════════════════════════════════════════════════
