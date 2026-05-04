-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Modulo Contratti — PR6 fix
--  Migration 041: patch al BUYER_PURCHASE_CUSTODY v1
--
--  Bug fixati (rilevati durante il primo test PDF):
--   • Art. 10.1: il link al marketplace usava erroneamente
--                {{counterparty.company_email}}/marketplace-tos
--                (un'email seguita da slash, sbagliato).
--                Sostituito con riferimento generico ai termini del
--                Marketplace pubblicati sul sito RareBlock.
--
--  NB: questa migration agisce SOLO se il template è ancora a v1.
--  Per audit trail completo, in produzione si dovrebbe creare una
--  v2 invece di mutare la v1. Qui v1 è ancora DRAFT (is_active=true
--  solo temporaneamente per test tecnico, non per firme reali) →
--  UPDATE in-place è accettabile.
-- ═══════════════════════════════════════════════════════════════════════

UPDATE public.contract_templates
SET body_md = REPLACE(
  body_md,
  '10.1 L''Acquirente può rivendere il Bene sul Marketplace di RareBlock, accettando i termini di servizio dello stesso (link {{counterparty.company_email}}/marketplace-tos).',
  '10.1 L''Acquirente può rivendere il Bene sul Marketplace di RareBlock, accettando i termini di servizio del Marketplace pubblicati sul sito ufficiale di RareBlock e disponibili anche su richiesta a {{counterparty.company_email}}.'
)
WHERE code = 'BUYER_PURCHASE_CUSTODY' AND version = 1;

-- Verifica
SELECT code, version, position('marketplace-tos' in body_md) AS bug_still_there
FROM public.contract_templates
WHERE code = 'BUYER_PURCHASE_CUSTODY' AND version = 1;

-- bug_still_there = 0 significa che la stringa non c'è più → fix applicato.

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 041_template_v1_fix.sql
-- ═══════════════════════════════════════════════════════════════════════
