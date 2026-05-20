-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Pulizia DB (utenti test/incompleti + referral/admission +
--  dati orfani). Eseguire nel SQL Editor di Supabase.
--
--  ⚠️  PRODUZIONE. Procedura in 2 fasi:
--    FASE 1 (REPORT): esegui SOLO il blocco "REPORT" e leggi i conteggi/righe.
--    FASE 2 (DELETE):  se i numeri tornano, esegui il blocco "DELETE" (è in
--                      transazione: parte con BEGIN, finisce con COMMIT).
--                      Per annullare prima del COMMIT: scrivi ROLLBACK.
--
--  Criteri "utente test/incompleto" (TUTTI veri):
--    • role = 'investor' (mai cancellare admin)
--    • kyc_status = 'pending' (mai approvati/in review/respinti)
--    • created_at < now() - 7 giorni (lascia respiro ai nuovi iscritti)
--    • NESSUNA attività reale: nessun ordine/marketplace/contratto/payout
--      (queste tabelle sono ON DELETE RESTRICT: bloccherebbero comunque il
--       delete, qui le escludiamo a monte per sicurezza ed evitare errori)
--
--  Le altre tabelle utente sono ON DELETE CASCADE: cancellando auth.users
--  vengono ripulite automaticamente (profiles, holdings, kyc, ecc.).
-- ═══════════════════════════════════════════════════════════════════════


-- ╔═══════════════════════════════════════════════════════════════════════╗
-- ║  FASE 1 — REPORT (sola lettura, nessuna modifica)                       ║
-- ╚═══════════════════════════════════════════════════════════════════════╝

-- CTE riusabile: utenti candidati alla cancellazione
WITH candidates AS (
  SELECT u.id, u.email, p.created_at, p.kyc_status
  FROM auth.users u
  JOIN public.profiles p ON p.id = u.id
  WHERE p.role = 'investor'
    AND COALESCE(p.kyc_status,'pending') = 'pending'
    AND p.created_at < now() - interval '7 days'
    -- nessuna attività in tabelle RESTRICT (proteggono dati reali)
    AND NOT EXISTS (SELECT 1 FROM public.inv_orders o
                     WHERE o.buyer_user_id = u.id OR o.seller_user_id = u.id)
    AND NOT EXISTS (SELECT 1 FROM public.marketplace_orders m
                     WHERE m.buyer_user_id = u.id OR m.seller_user_id = u.id)
    AND NOT EXISTS (SELECT 1 FROM public.marketplace_listings l
                     WHERE l.seller_user_id = u.id)
    AND NOT EXISTS (SELECT 1 FROM public.contracts c
                     WHERE c.party_user_id = u.id)
    -- holdings (fractional/full): se possiede quote, NON cancellare
    AND NOT EXISTS (SELECT 1 FROM public.inv_holdings h WHERE h.user_id = u.id)
)
SELECT 'utenti_test_da_cancellare' AS cosa, count(*) AS n FROM candidates
UNION ALL
SELECT 'referral_redemptions_vecchie',  count(*) FROM public.inv_referral_redemptions
  WHERE outcome IN ('invalid','expired','exhausted') AND created_at < now() - interval '30 days'
UNION ALL
SELECT 'admission_requests_rejected',   count(*) FROM public.inv_admission_requests
  WHERE status = 'rejected' AND created_at < now() - interval '30 days';

-- Dettaglio utenti candidati (controlla le email prima di cancellare):
-- (decommenta per vederle)
-- WITH candidates AS ( ...stessa CTE sopra... )
-- SELECT id, email, created_at FROM candidates ORDER BY created_at;


-- ╔═══════════════════════════════════════════════════════════════════════╗
-- ║  FASE 2 — DELETE (in transazione)                                       ║
-- ║  Esegui SOLO dopo aver verificato i numeri del REPORT.                  ║
-- ╚═══════════════════════════════════════════════════════════════════════╝
/*  ⬇️ Rimuovi questo commento di apertura per eseguire la cancellazione ⬇️

BEGIN;

-- 1) Referral redemptions vecchie/fallite (log, nessuna FK critica)
DELETE FROM public.inv_referral_redemptions
 WHERE outcome IN ('invalid','expired','exhausted')
   AND created_at < now() - interval '30 days';

-- 2) Richieste di ammissione respinte e vecchie
DELETE FROM public.inv_admission_requests
 WHERE status = 'rejected'
   AND created_at < now() - interval '30 days';

-- 3) Utenti test/incompleti → CASCADE pulisce profiles e dati collegati
DELETE FROM auth.users u
 USING public.profiles p
 WHERE p.id = u.id
   AND p.role = 'investor'
   AND COALESCE(p.kyc_status,'pending') = 'pending'
   AND p.created_at < now() - interval '7 days'
   AND NOT EXISTS (SELECT 1 FROM public.inv_orders o
                    WHERE o.buyer_user_id = u.id OR o.seller_user_id = u.id)
   AND NOT EXISTS (SELECT 1 FROM public.marketplace_orders m
                    WHERE m.buyer_user_id = u.id OR m.seller_user_id = u.id)
   AND NOT EXISTS (SELECT 1 FROM public.marketplace_listings l
                    WHERE l.seller_user_id = u.id)
   AND NOT EXISTS (SELECT 1 FROM public.contracts c
                    WHERE c.party_user_id = u.id)
   AND NOT EXISTS (SELECT 1 FROM public.inv_holdings h WHERE h.user_id = u.id);

-- Verifica i conteggi nell'output, poi:
--   • se tutto ok →  COMMIT;
--   • se qualcosa non torna →  ROLLBACK;
COMMIT;

⬆️ Rimuovi questo commento di chiusura per eseguire la cancellazione ⬆️  */
