// =============================================================================
// Supabase Edge Function: cmapi-sync
// -----------------------------------------------------------------------------
// Fonte prezzi LEGITTIMA via cardmarket-api-tcg (RapidAPI) — NIENTE Cloudflare.
// Sostituisce lo scraping server-side di CardMarket per il caso comune:
//   • lowest_near_mint globale + per-paese (IT/DE/FR/ES)
//   • medie 7d / 30d  (il segnale di prezzo affidabile per l'IT è lnm_it + 30d)
//   • graded eBay PSA/CGC/BGS (da prices.ebay.graded)
//   • tcgplayer market/mid
//   • tcgid "bw5-106" = chiave di join diretta con setId+number del client
//
// NB onesto: CMAPI dà SOLO il lowest Near Mint (per paese), NON il ladder
// Mint→Poor. Il breakdown completo per condizione resta affare dello userscript
// (cm_price_by_condition). cmapi-sync copre il 90% dei casi (quanto vale la
// carta, in NM, sul mercato IT) in modo veloce e robusto.
//
// Modalita':
//   { tcgid:"bw5-106", name:"Groudon-EX", language:"IT" }  → match preciso
//   { search:"groudon ex", language:"IT", limit:5 }         → lista mappata
//   { cardNumber:"106", episodeCode:"DEX", name:"...", language:"IT" }
//   persist (default true): se c'e' un JWT utente, scrive su cm_market_price
//                           via RPC cm_ingest_market_prices (inoltra il JWT).
//
// Auth: JWT utente (qualsiasi authenticated) OPPURE header x-test-secret
//       (== CMAPI_TEST_SECRET) per i test rapidi. Senza JWT → persist=false.
//
// Secrets: CMAPI_KEY (RapidAPI), opz. CMAPI_TEST_SECRET, SUPABASE_URL,
//          SUPABASE_ANON_KEY.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-test-secret, prefer',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const CMAPI_HOST = 'cardmarket-api-tcg.p.rapidapi.com';
const CMAPI_BASE = `https://${CMAPI_HOST}`;

const LANG_MAP: Record<string, 'EN' | 'IT' | 'JP'> = { EN: 'EN', IT: 'IT', JP: 'JP', ITA: 'IT', ENG: 'EN', JPN: 'JP' };

interface SyncInput {
  tcgid?: string;
  search?: string;
  name?: string;
  cardNumber?: string | number;
  episodeCode?: string;
  language?: string;
  limit?: number;
  persist?: boolean;
  debug?: boolean;
  variant?: string;     // hint per disambiguare (es. 'shadowless', 'unlimited', '1st')
  slug?: string;        // disambigua per slug CMAPI esatto
  cmapiId?: number;     // disambigua per id CMAPI esatto (scelta dal chooser)
  detailId?: number;    // probe: fetch dettaglio per-id (verifica versioni)
}

async function cmapiGet(path: string, key: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${CMAPI_BASE}${path}`, {
    headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': CMAPI_HOST },
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

function asList(body: any): any[] {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.data)) return body.data;
  if (body && Array.isArray(body.cards)) return body.cards;
  return [];
}

// Mappa una card CMAPI → riga per cm_ingest_market_prices (chiavi camelCase).
// Ritorna anche un blocco "view" pronto per la UI del client.
function mapCard(card: any, language: 'EN' | 'IT' | 'JP') {
  const cm = (card?.prices?.cardmarket) ?? {};
  // Il graded "ricco" sta in prices.ebay.graded; cardmarket.graded e' spesso [].
  const ebayGraded = card?.prices?.ebay?.graded;
  const graded = (ebayGraded && typeof ebayGraded === 'object' && !Array.isArray(ebayGraded)) ? ebayGraded : null;
  const tcg = (card?.prices?.tcg_player) ?? {};

  const num = (n: any) => (n == null || n === '' || isNaN(+n)) ? null : +n;

  const row = {
    cmapiId:        card?.id ?? null,
    language,
    name:           card?.name ?? null,
    nameNumbered:   card?.name_numbered ?? null,
    cardNumber:     card?.card_number != null ? String(card.card_number) : null,
    rarity:         card?.rarity ?? null,
    episodeCode:    card?.episode?.code ?? card?.episode_code ?? null,
    episodeName:    card?.episode?.name ?? card?.episode_name ?? null,
    currency:       cm?.currency ?? 'EUR',
    lowestNearMint: num(cm?.lowest_near_mint),
    lnmDE:          num(cm?.lowest_near_mint_DE),
    lnmFR:          num(cm?.lowest_near_mint_FR),
    lnmES:          num(cm?.lowest_near_mint_ES),
    lnmIT:          num(cm?.lowest_near_mint_IT),
    avg7d:          num(cm?.['7d_average']),
    avg30d:         num(cm?.['30d_average']),
    graded,
    tcgMarketUsd:   num(tcg?.market_price),
    tcgMidUsd:      num(tcg?.mid_price),
    image:          card?.image ?? null,
    artist:         card?.artist?.name ?? null,
    rbCardId:       card?.tcgid ?? null,   // "bw5-106" = setId+number del client
  };

  // "Prezzo di riferimento" LANGUAGE-AWARE.
  // Bug storico: si usava sempre lnmIT (lowest near mint Italia) a prescindere
  // dalla lingua richiesta → per carte ENG/estere restituiva il floor italiano
  // (es. Skiploom ENG mostrava ~0,09 = floor IT, mentre il vero NM ENG ~0,20).
  // CMAPI espone lnm per-paese solo IT/DE/FR/ES; l'inglese NON è un paese ma il
  // mercato "internazionale" di default, meglio rappresentato dal lowest globale.
  // Strategia per lingua:
  //   IT      → lnmIT  → 30d → 7d → globale
  //   DE/FR/ES→ lnm{paese} → globale → 30d → 7d
  //   EN/altro→ globale → 30d → 7d  (il floor IT non è rappresentativo)
  let refPrice: number | null;
  let refBasis: string | null;
  if (language === 'IT') {
    refPrice = row.lnmIT ?? row.avg30d ?? row.avg7d ?? row.lowestNearMint ?? null;
    refBasis = row.lnmIT != null ? 'IT' :
               row.avg30d != null ? '30d' :
               row.avg7d  != null ? '7d'  :
               row.lowestNearMint != null ? 'global' : null;
  } else {
    // EN/JP e qualunque lingua non-IT: il lowest globale è il segnale corretto.
    refPrice = row.lowestNearMint ?? row.avg30d ?? row.avg7d ?? row.lnmIT ?? null;
    refBasis = row.lowestNearMint != null ? 'global' :
               row.avg30d != null ? '30d' :
               row.avg7d  != null ? '7d'  :
               row.lnmIT != null ? 'IT' : null;
  }

  return {
    row,
    view: {
      cmapiId: row.cmapiId, tcgid: row.rbCardId, name: row.name,
      number: row.cardNumber, set: row.episodeName, setCode: row.episodeCode,
      rarity: row.rarity, image: row.image,
      currency: row.currency,
      refPrice, refBasis,
      lnm_it: row.lnmIT, lnm_de: row.lnmDE, lnm_fr: row.lnmFR,
      lowest_global: row.lowestNearMint,
      avg_7d: row.avg7d, avg_30d: row.avg30d,
      available: num(cm?.available_items),
      graded,
      tcg_market: row.tcgMarketUsd, tcg_mid: row.tcgMidUsd,
      // Link CORRETTO al prodotto su CardMarket (redirect ufficiale tcggo→CM):
      // usato dal client al posto dello slug ricostruito (spesso errato).
      cmLink: card?.links?.cardmarket ?? null,
      tcggoUrl: card?.tcggo_url ?? null,
      cardmarketId: card?.cardmarket_id ?? null,
      slug: card?.slug ?? null,
    },
  };
}


Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const SUPABASE_URL      = Deno.env.get('SUPABASE_URL') || '';
    const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || '';
    const CMAPI_KEY         = Deno.env.get('CMAPI_KEY') || '';
    const TEST_SECRET       = Deno.env.get('CMAPI_TEST_SECRET') || '';

    if (!CMAPI_KEY) return json({ ok: false, error: 'CMAPI_KEY non configurata nei Secrets' }, 500);

    // ── Auth: JWT utente OPPURE x-test-secret ──
    const authHeader     = req.headers.get('Authorization') || '';
    const providedSecret = req.headers.get('x-test-secret') || '';
    const secretOk = !!TEST_SECRET && providedSecret === TEST_SECRET;

    let userJwt = '';
    if (authHeader.toLowerCase().startsWith('bearer ')) {
      const tok = authHeader.slice(7).trim();
      // Distinguo un vero JWT utente dall'anon key passata di default.
      if (tok && tok !== SUPABASE_ANON_KEY) {
        const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
          global: { headers: { Authorization: authHeader } },
        });
        const { data: u } = await userClient.auth.getUser();
        if (u?.user) userJwt = authHeader;       // JWT valido → potremo persistere
      }
    }
    if (!userJwt && !secretOk) {
      return json({ ok: false, error: 'Auth richiesta: JWT utente valido oppure header x-test-secret' }, 401);
    }

    const input = (await req.json().catch(() => ({}))) as SyncInput;
    const language = LANG_MAP[(input.language || 'IT').toUpperCase()] || 'IT';
    const limit = Math.min(Math.max(input.limit ?? 1, 1), 20);
    const persist = input.persist !== false && !!userJwt;   // persiste solo con JWT utente

    // PROBE DETTAGLIO: verifica se CMAPI espone un endpoint per-id con eventuale
    // breakdown di VERSIONE (Shadowless/Unlimited/1st). Prova alcuni path
    // plausibili e ritorna grezzo: serve a capire se le varianti sono ottenibili.
    if (input.detailId != null) {
      const id = String(input.detailId);
      const paths = [
        `/pokemon/cards/${id}`,
        `/pokemon/card/${id}`,
        `/pokemon/cards/${id}/versions`,
        `/pokemon/cards/${id}/prices`,
      ];
      const out: any[] = [];
      for (const p of paths) {
        try {
          const r = await cmapiGet(p, CMAPI_KEY);
          out.push({
            path: p, status: r.status,
            keys: (r.body && typeof r.body === 'object') ? Object.keys(r.body).slice(0, 40) : null,
            sample: typeof r.body === 'string' ? r.body.slice(0, 300) : r.body,
          });
        } catch (e) { out.push({ path: p, error: String((e as any)?.message ?? e) }); }
      }
      return json({ ok: true, probe: 'detail', detailId: id, results: out });
    }

    // Termine di ricerca: search esplicito, altrimenti il name.
    const term = (input.search || input.name || '').trim();
    if (!term) return json({ ok: false, error: 'Serve almeno search o name' }, 400);

    const q = `/pokemon/cards?search=${encodeURIComponent(term)}&sort=price_highest`;
    const { status, body } = await cmapiGet(q, CMAPI_KEY);
    if (status !== 200) {
      return json({ ok: false, error: `CMAPI HTTP ${status}`, detail: typeof body === 'string' ? body.slice(0, 300) : body }, 502);
    }

    const list = asList(body);
    if (!list.length) return json({ ok: false, error: 'Nessun risultato CMAPI', term });

    // DEBUG: dump grezzo dei risultati (campi utili a capire la struttura varianti).
    if (input.debug) {
      return json({
        ok: true, debug: true, term, count: list.length,
        items: list.slice(0, 20).map((c) => ({
          id: c?.id ?? null, tcgid: c?.tcgid ?? null,
          name: c?.name ?? null, name_numbered: c?.name_numbered ?? null,
          slug: c?.slug ?? null, card_number: c?.card_number ?? null,
          rarity: c?.rarity ?? null,
          episode: c?.episode?.code ?? c?.episode_code ?? null,
          cardmarket_id: c?.cardmarket_id ?? null,
          cm_link: c?.links?.cardmarket ?? null,
          lnm: c?.prices?.cardmarket?.lowest_near_mint ?? null,
          lnm_it: c?.prices?.cardmarket?.lowest_near_mint_IT ?? null,
          avg30: c?.prices?.cardmarket?.['30d_average'] ?? null,
        })),
      });
    }

    // Target singolo (tcgid/number+episode) vs lista.
    const wantsSingle = !!(input.tcgid || (input.cardNumber && input.episodeCode));
    let mapped: any[];
    let variants: any[] = [];
    if (wantsSingle) {
      // TUTTE le entry che combaciano con la carta richiesta (stesso tcgid o
      // stesso numero+episodio). Base Set Charizard puo' avere Shadowless +
      // Unlimited come prodotti CM distinti con identico tcgid 'base1-4':
      // NON dobbiamo sceglierne una in silenzio (sort=price_highest darebbe
      // sempre la Shadowless, piu' cara).
      const wantTcg = (input.tcgid || '').toLowerCase().trim();
      const wantNum = input.cardNumber != null ? String(input.cardNumber).trim() : '';
      const wantEp  = (input.episodeCode || '').toUpperCase().trim();
      const matches = list.filter((c) => {
        if (wantTcg) return (c?.tcgid || '').toLowerCase().trim() === wantTcg;
        if (wantNum && wantEp) return String(c?.card_number ?? '').trim() === wantNum &&
          String(c?.episode?.code ?? c?.episode_code ?? '').toUpperCase().trim() === wantEp;
        if (wantNum) return String(c?.card_number ?? '').trim() === wantNum;
        return false;
      });

      if (!matches.length) {
        return json({
          ok: false,
          error: 'CMAPI: nessun match esatto nei risultati della ricerca',
          term,
          wanted: input.tcgid || (String(input.cardNumber) + '/' + (input.episodeCode || '?')),
          candidates: list.slice(0, 12).map((c) => ({
            tcgid: c?.tcgid ?? null, name: c?.name ?? null,
            number: c?.card_number ?? null, episode: c?.episode?.code ?? null,
          })),
        });
      }

      // Mappa tutte le varianti (per il chooser lato client).
      variants = matches.map((c) => {
        const v = mapCard(c, language).view;
        v.cmapiId = c?.id ?? null;
        v.slug = c?.slug ?? null;
        v.cardmarketId = c?.cardmarket_id ?? null;
        return v;
      });

      // Selezione: se il client passa un hint (variant/edition/cmapiId/slug) lo
      // rispetto; altrimenti, se c'e' ambiguita' (piu' varianti), NON scelgo io
      // — restituisco ambiguous:true + variants[] e il client mostra il chooser.
      let chosen: any | null = null;
      const hint = (input.variant || '').toString().toLowerCase().trim();
      if (input.cmapiId != null) chosen = matches.find((c) => c?.id === input.cmapiId) || null;
      else if (input.slug) chosen = matches.find((c) => (c?.slug || '').toLowerCase() === String(input.slug).toLowerCase()) || null;
      else if (hint) {
        chosen = matches.find((c) => {
          const hay = ((c?.name || '') + ' ' + (c?.name_numbered || '') + ' ' + (c?.slug || '')).toLowerCase();
          return hay.includes(hint);
        }) || null;
      }
      if (!chosen && matches.length === 1) chosen = matches[0];

      if (!chosen) {
        // Ambiguo: piu' varianti, nessun hint risolutivo → niente prezzo silenzioso.
        return json({
          ok: true, ambiguous: true, source: 'cmapi', language, term,
          single: true, match: null, variants,
          message: 'Piu\u0027 varianti per questa carta (es. Shadowless/Unlimited): scegliere quale.',
        });
      }
      mapped = [mapCard(chosen, language)];
    } else {
      mapped = list.slice(0, limit).map((c) => mapCard(c, language));
    }
    if (!mapped.length) return json({ ok: false, error: 'Nessun match', term });

    // ── Persistenza via RPC (inoltra il JWT utente: la RPC esige auth.uid()) ──
    let persisted = 0, persistError: string | null = null;
    if (persist) {
      try {
        const rows = mapped.map((m) => m.row).filter((r) => r.cmapiId != null);
        const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/cm_ingest_market_prices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': userJwt,
          },
          body: JSON.stringify({ p_rows: rows }),
        });
        if (r.ok) { persisted = await r.json().catch(() => 0) || 0; }
        else { persistError = `RPC HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`; }
      } catch (e) { persistError = String((e as any)?.message ?? e); }
    }

    return json({
      ok: true,
      source: 'cmapi',
      language,
      term,
      single: wantsSingle,
      match: wantsSingle ? mapped[0].view : null,
      variants: (wantsSingle && variants.length > 1) ? variants : undefined,
      results: wantsSingle ? null : mapped.map((m) => m.view),
      persisted,
      persist_error: persistError,
    });
  } catch (e) {
    return json({ ok: false, error: String((e as any)?.message ?? e) }, 500);
  }
});
