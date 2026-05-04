-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Modulo Contratti — patch
--  Migration 044: reconcile FK contracts.notarization_id
--
--  CONTESTO
--  In PR5 la edge function contract-notarize creava la riga in
--  contract_notarizations e aggiornava il suo status a 'confirmed', ma
--  NON aggiornava contracts.notarization_id. Questa write era delegata
--  al caller (contract-sign) che la faceva nel flow normale di firma.
--
--  Quando in PR8 abbiamo introdotto il pulsante "Re-notarizza" admin,
--  il caller (admCtrRetryNotarize lato frontend) NON aggiornava la FK,
--  lasciando i contratti rinotarizzati con notarization_id = NULL pur
--  avendo la tx confermata sulla blockchain.
--
--  La 044 fa due cose:
--   1. Ripara retroattivamente i contratti già notarizzati ma con FK
--      mancante (tipicamente il backfill PR8 è il caso più probabile,
--      ma teoricamente anche altri scenari di flow rotto).
--   2. La nuova edge function contract-notarize (commit successivo a
--      questa migration) fa l'update SEMPRE — nessun caller può più
--      dimenticarsene.
--
--  IDEMPOTENTE: i WHERE clause garantiscono no-op a re-applicare.
-- ═══════════════════════════════════════════════════════════════════════

-- Reconcile: ogni contratto signed senza FK ma con una notarizzazione
-- 'confirmed' che ha lo stesso pdf_sha256 e contract_id (o contract_serial).
UPDATE public.contracts c
SET notarization_id = n.id
FROM public.contract_notarizations n
WHERE c.notarization_id IS NULL
  AND c.status IN ('signed','revoked')
  AND n.status = 'confirmed'
  AND (
    -- Match preferito: stesso contract_id (FK soft)
    n.contract_id = c.id
    OR
    -- Fallback: stesso serial e stesso hash (per notarizzazioni vecchie
    -- create senza contract_id valorizzato)
    (n.contract_serial = c.contract_number AND n.pdf_sha256 = c.pdf_signed_sha256)
  );

-- Verifica risultato: count contratti riparati
DO $$
DECLARE v_signed INT; v_linked INT; v_orphan INT;
BEGIN
  SELECT count(*) INTO v_signed FROM public.contracts WHERE status='signed';
  SELECT count(*) INTO v_linked FROM public.contracts WHERE status='signed' AND notarization_id IS NOT NULL;
  SELECT count(*) INTO v_orphan FROM public.contracts WHERE status='signed' AND notarization_id IS NULL;
  RAISE NOTICE '044_reconcile: signed=% | con notarizzazione=% | senza notarizzazione=%',
    v_signed, v_linked, v_orphan;
END $$;

-- Nota: i contratti rimasti con notarization_id NULL dopo questa migration
-- sono quelli che genuinamente NON hanno mai avuto una notarizzazione
-- (es. firmati prima del setup wallet, mai re-notarizzati). Per ripararli
-- basta chiamare il pulsante "Re-notarizza" dal pannello admin: la nuova
-- edge function farà l'update FK automaticamente.

NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 044_reconcile_notarization_fk.sql
-- ═══════════════════════════════════════════════════════════════════════
