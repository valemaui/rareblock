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

  // "Prezzo di riferimento" per un utente IT: priorita' IT → media 30d → media 7d
  // → lowest globale (ultimo, perche' inquinato da listing esteri misprezzati).
  const refPrice = row.lnmIT ?? row.avg30d ?? row.avg7d ?? row.lowestNearMint ?? null;
  const refBasis = row.lnmIT != null ? 'IT' :
                   row.avg30d != null ? '30d' :
                   row.avg7d  != null ? '7d'  :
                   row.lowestNearMint != null ? 'global' : null;

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
    },
  };
}

// Sceglie il match migliore da una lista, dato cosa sappiamo della carta target.
function pickBest(list: any[], opts: { tcgid?: string; cardNumber?: string; episodeCode?: string }): any | null {
  if (!list.length) return null;
  const wantTcg = (opts.tcgid || '').toLowerCase().trim();
  if (wantTcg) {
    const exact = list.find((c) => (c?.tcgid || '').toLowerCase().trim() === wantTcg);
    if (exact) return exact;
  }
  const wantNum = opts.cardNumber != null ? String(opts.cardNumber).trim() : '';
  const wantEp  = (opts.episodeCode || '').toUpperCase().trim();
  if (wantNum && wantEp) {
    const byNumEp = list.find((c) =>
      String(c?.card_number ?? '').trim() === wantNum &&
      String(c?.episode?.code ?? c?.episode_code ?? '').toUpperCase().trim() === wantEp);
    if (byNumEp) return byNumEp;
  }
  if (wantNum) {
    const byNum = list.find((c) => String(c?.card_number ?? '').trim() === wantNum);
    if (byNum) return byNum;
  }
  return list[0];
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

    // Target singolo (tcgid/number+episode) vs lista.
    const wantsSingle = !!(input.tcgid || (input.cardNumber && input.episodeCode));
    let mapped: any[];
    if (wantsSingle) {
      const best = pickBest(list, {
        tcgid: input.tcgid,
        cardNumber: input.cardNumber != null ? String(input.cardNumber) : undefined,
        episodeCode: input.episodeCode,
      });
      mapped = best ? [mapCard(best, language)] : [];
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
      results: wantsSingle ? null : mapped.map((m) => m.view),
      persisted,
      persist_error: persistError,
    });
  } catch (e) {
    return json({ ok: false, error: String((e as any)?.message ?? e) }, 500);
  }
});
