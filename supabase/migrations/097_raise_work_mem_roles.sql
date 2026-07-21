-- ─────────────────────────────────────────────────────────────────────────
--  RareBlock — Migration 097: Raise work_mem per ruoli PostgREST (I/O fix)
-- ─────────────────────────────────────────────────────────────────────────
--  PROBLEMA (fonte #1 di Disk I/O, da pg_stat_statements):
--    A) Query di introspezione schema di PostgREST: 477 esecuzioni ×
--       8,89 MB temp = ~4,2 GB scritti su disco. Gira ad ogni reload schema
--       (NOTIFY pgrst). Con centinaia di funzioni/viste/tipi l'hash spilla.
--    B) cache_put_external: 1275 chiamate × ~1 MB temp = ~1,2 GB. L'HTML
--       intero passa in json_to_record e spilla.
--    Causa comune: work_mem sul compute e' < del picco richiesto → sort/hash
--    finiscono in temp file su disco (temp_blks_written) ad ogni chiamata.
--
--  FIX: alzo work_mem a livello di RUOLO (non globale) solo per i ruoli usati
--    da PostgREST, così le operazioni stanno in RAM e i temp spill spariscono.
--      - authenticator : ruolo di connessione del pool (esegue l'introspezione,
--                        poche connessioni) → margine ampio, 24MB.
--      - authenticated : esegue le RPC utente (es. cache_put ~1MB), più
--                        concorrente → 12MB.
--      - anon          : traffico pubblico → 8MB.
--
--  ⚠️  work_mem è PER-operazione PER-connessione. Su compute piccolo verifica
--      RAM disponibile: picco ≈ work_mem × (#connessioni che ordinano insieme).
--      Se dopo il deploy vedi pressione RAM/swap, abbassa i valori.
--      Effetto attivo alla riconnessione del pool (o restart PostgREST da
--      Dashboard → Settings → API → Restart server).
--
--  Revert:  ALTER ROLE authenticator  RESET work_mem;
--           ALTER ROLE authenticated  RESET work_mem;
--           ALTER ROLE anon           RESET work_mem;
--
--  NB: NESSUN "NOTIFY pgrst" qui: è un cambio di GUC di ruolo, non di schema.
--      Aggiungerlo farebbe partire un altro reload costoso — da evitare.
-- ─────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    EXECUTE 'ALTER ROLE authenticator SET work_mem = ''24MB''';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'ALTER ROLE authenticated SET work_mem = ''12MB''';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'ALTER ROLE anon SET work_mem = ''8MB''';
  END IF;
END $$;
