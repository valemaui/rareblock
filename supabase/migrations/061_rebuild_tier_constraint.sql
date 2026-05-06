-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Migration 061: rebuild constraint profiles.tier
--
--  Sostituisce la 060 (che lasciava l'UPDATE bloccato dal constraint
--  preesistente profiles_tier_check, creato fuori dalle migration con
--  dominio diverso e non compatibile con 'basic').
--
--  Strategia robusta:
--   1. Diagnostica: elenca TUTTI i check constraint sulla tabella
--      profiles la cui definizione menziona "tier".
--   2. Drop dinamico di tutti questi constraint (qualunque sia il nome).
--   3. Normalizzazione valori della colonna tier.
--   4. Set DEFAULT + NOT NULL.
--   5. Apply singolo constraint canonico profiles_tier_chk.
--   6. Verifica finale.
--
--  Idempotente: ri-eseguibile senza effetti collaterali.
-- ═══════════════════════════════════════════════════════════════════════


-- ── 1) Diagnostica + drop dinamico di tutti i CHECK su profiles.tier ──
DO $$
DECLARE
  c RECORD;
  v_dropped INT := 0;
BEGIN
  -- Mostra distribuzione attuale
  RAISE NOTICE '─── Distribuzione attuale colonna profiles.tier ───';
  FOR c IN
    SELECT COALESCE(tier,'(NULL)') AS v, COUNT(*) AS n
      FROM public.profiles
      GROUP BY 1
      ORDER BY 2 DESC
  LOOP
    RAISE NOTICE '  %  →  % righe', c.v, c.n;
  END LOOP;

  -- Enumera tutti i CHECK constraint su public.profiles la cui definizione
  -- menziona "tier" (case-insensitive). Include sia constraint creati da
  -- noi sia constraint creati manualmente fuori dalle migration.
  RAISE NOTICE '─── Check constraint trovati su profiles che riferiscono "tier" ───';
  FOR c IN
    SELECT con.conname, pg_get_constraintdef(con.oid) AS def
      FROM pg_constraint con
      JOIN pg_class      cls ON cls.oid = con.conrelid
      JOIN pg_namespace  nsp ON nsp.oid = cls.relnamespace
     WHERE nsp.nspname = 'public'
       AND cls.relname = 'profiles'
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) ILIKE '%tier%'
       -- Esclude constraint che riguardano colonne diverse il cui nome
       -- contiene "tier" (es. tier_started_at, tier_expires_at): solo
       -- check con riferimento alla colonna esatta `tier`
       AND EXISTS (
         SELECT 1
           FROM unnest(con.conkey) k
           JOIN pg_attribute att
             ON att.attrelid = con.conrelid
            AND att.attnum   = k
          WHERE att.attname = 'tier'
       )
  LOOP
    RAISE NOTICE '  DROP: % → %', c.conname, c.def;
    EXECUTE format('ALTER TABLE public.profiles DROP CONSTRAINT %I', c.conname);
    v_dropped := v_dropped + 1;
  END LOOP;

  RAISE NOTICE '─── Totale constraint droppati: % ───', v_dropped;
END $$;


-- ── 2) Normalizzazione valori ─────────────────────────────────────────
-- NULL e qualunque valore fuori dominio → 'basic'
-- Case-insensitive: 'BASIC','Basic',... → 'basic'
UPDATE public.profiles
   SET tier = 'basic'
 WHERE tier IS NULL
    OR LOWER(TRIM(tier)) NOT IN ('basic','pro','gold');

UPDATE public.profiles
   SET tier = LOWER(TRIM(tier))
 WHERE tier <> LOWER(TRIM(tier));


-- ── 3) DEFAULT + NOT NULL ─────────────────────────────────────────────
ALTER TABLE public.profiles
  ALTER COLUMN tier SET DEFAULT 'basic';

ALTER TABLE public.profiles
  ALTER COLUMN tier SET NOT NULL;


-- ── 4) Apply constraint canonico ──────────────────────────────────────
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_tier_chk
  CHECK (tier IN ('basic','pro','gold'));


-- ── 5) Verifica finale ────────────────────────────────────────────────
DO $$
DECLARE
  c RECORD;
BEGIN
  RAISE NOTICE '─── Distribuzione finale profiles.tier ───';
  FOR c IN
    SELECT tier, COUNT(*) AS n
      FROM public.profiles
      GROUP BY tier
      ORDER BY tier
  LOOP
    RAISE NOTICE '  %  →  % righe', c.tier, c.n;
  END LOOP;

  RAISE NOTICE '─── Check constraint attivi su profiles.tier ───';
  FOR c IN
    SELECT con.conname, pg_get_constraintdef(con.oid) AS def
      FROM pg_constraint con
      JOIN pg_class      cls ON cls.oid = con.conrelid
      JOIN pg_namespace  nsp ON nsp.oid = cls.relnamespace
     WHERE nsp.nspname = 'public'
       AND cls.relname = 'profiles'
       AND con.contype = 'c'
       AND EXISTS (
         SELECT 1 FROM unnest(con.conkey) k
           JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k
          WHERE att.attname = 'tier'
       )
  LOOP
    RAISE NOTICE '  %  →  %', c.conname, c.def;
  END LOOP;
END $$;


NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 061_rebuild_tier_constraint.sql
--
--  Dopo questa migration:
--   • Ri-esegui 059_buyer_tiers.sql (idempotente) per completare gli
--     oggetti che la prima esecuzione potrebbe non aver creato.
-- ═══════════════════════════════════════════════════════════════════════
