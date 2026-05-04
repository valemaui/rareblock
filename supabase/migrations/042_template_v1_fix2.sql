-- ═══════════════════════════════════════════════════════════════════════
--  RareBlock — Modulo Contratti — PR6 fix iterativo
--  Migration 042: re-fix art. 10.1 (REPLACE ora robusto)
--
--  La migration 041 usava REPLACE() exact-match su una stringa lunga
--  che includeva un apostrofo \\'. Postgres tratta '...''...' come
--  una stringa con apostrofo singolo. È possibile che il match sia
--  fallito nel DB (per encoding/escaping diverso fra server e client),
--  lasciando il testo originale, oppure ne abbia mangiato un pezzo.
--
--  Questa migration usa due REPLACE indipendenti su porzioni piccole:
--   1. Sostituisce solo la stringa difettosa "(link xxx/marketplace-tos)"
--      → "del Marketplace pubblicati sul sito ufficiale..." se trova
--   2. Se la frase difettosa non c'è già (perché 041 ha funzionato
--      o per qualunque motivo), no-op.
-- ═══════════════════════════════════════════════════════════════════════

-- Step 1: sostituisce SOLO il pezzo problematico, senza toccare il resto
UPDATE public.contract_templates
SET body_md = REPLACE(
  body_md,
  'dello stesso (link {{counterparty.company_email}}/marketplace-tos).',
  'del Marketplace pubblicati sul sito ufficiale di RareBlock e disponibili anche su richiesta a {{counterparty.company_email}}.'
)
WHERE code = 'BUYER_PURCHASE_CUSTODY' AND version = 1;

-- Step 2: gestisce eventuali varianti dove la 041 ha rotto la frase
-- (es. ha sostituito mezza stringa lasciando un frammento)
-- Queste 2 update sono safe-by-design: trovano solo se c'è la stringa specifica.
UPDATE public.contract_templates
SET body_md = REPLACE(
  body_md,
  'accettando i termini di servizio dello stesso .',
  'accettando i termini di servizio del Marketplace pubblicati sul sito ufficiale di RareBlock e disponibili anche su richiesta a {{counterparty.company_email}}.'
)
WHERE code = 'BUYER_PURCHASE_CUSTODY' AND version = 1;

-- Step 3: variante con frase troncata da 041
UPDATE public.contract_templates
SET body_md = REPLACE(
  body_md,
  'accettando i termini di servizio dello stesso.',
  'accettando i termini di servizio del Marketplace pubblicati sul sito ufficiale di RareBlock e disponibili anche su richiesta a {{counterparty.company_email}}.'
)
WHERE code = 'BUYER_PURCHASE_CUSTODY' AND version = 1;

-- Verifica finale: estrae i ~300 caratteri attorno a 10.1
SELECT substring(body_md from position('10.1' in body_md) for 350) AS art_10_1
FROM contract_templates
WHERE code = 'BUYER_PURCHASE_CUSTODY' AND version = 1;

-- Atteso: "10.1 L'Acquirente può rivendere il Bene sul Marketplace di
-- RareBlock, accettando i termini di servizio del Marketplace pubblicati
-- sul sito ufficiale di RareBlock e disponibili anche su richiesta a
-- admin@rareblock.eu."

-- ═══════════════════════════════════════════════════════════════════════
--  FINE 042_template_v1_fix2.sql
-- ═══════════════════════════════════════════════════════════════════════
