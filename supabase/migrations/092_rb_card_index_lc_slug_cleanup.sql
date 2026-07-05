-- 092 · Bonifica rb_card_index: URL Legendary Collection con prefisso V1/V2
--
-- CONTESTO: fino alla v6.61 _cmPrimaryVersionFor applicava a base6 (Legendary
-- Collection) il pattern Jungle/Fossil (Rare Holo → V1). Su CM però LC ha un
-- prodotto per numero (come Team Rocket): lo slug corretto è SENZA prefisso V
-- (verificato 2026-07-05: Dark-Slowbro-LC8 corretto, Dark-Slowbro-V1-LC8
-- prodotto sbagliato). I salti/scrape precedenti hanno persistito nell'indice
-- URL -V1-LC*/-V2-LC* come voci "indovinate" (method direct/variant-cascade/
-- discover/census): a L0 scavalcherebbero il fix client, mantenendo il salto
-- sul prodotto sbagliato anche dopo il deploy.
--
-- AZIONE: azzera l'URL (e i campi derivati dall'URL) delle sole voci LC
-- INDOVINATE con prefisso versione. Le voci LOCKED (manual/userscript/
-- authoritative/cmapi_link) sono ground-truth e NON si toccano. I prezzi NM
-- salvati restano: sono condizione-agnostici e non dipendono dallo slug.
-- Alla prossima lookup l'URL viene ricostruito (CMAPI cmLink o slug no-V).

UPDATE rb_card_index
SET    cm_url     = NULL,
       method     = NULL,
       confidence = 0,
       fail_count = 0
WHERE  product_key LIKE 'base6|%'
  AND  cm_url ~* '/Legendary-Collection/[^/?#]+-V[12]-LC'
  AND  COALESCE(method,'') NOT IN ('manual','userscript','authoritative','cmapi_link');

NOTIFY pgrst, 'reload schema';
