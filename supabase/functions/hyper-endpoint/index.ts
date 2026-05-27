// Supabase Edge Function: hyper-endpoint
// =============================================================================
// Proxy server-side per la Pokémon TCG API (https://api.pokemontcg.io/v2).
// Esiste per due ragioni:
//   1. CORS: api.pokemontcg.io NON espone Access-Control-Allow-Origin sul
//      browser → tutte le fetch dirette dal client fallivano. Il proxy gira
//      lato server, dove CORS non si applica, e restituisce CORS:* al client.
//   2. Concentrare la TCG_KEY in un unico posto (env var) anziché propagarla
//      ovunque nel client.
//
// Contratto (tutti GET, response shape identica a quella della TCG API):
//
//   ?name=<string>
//       Ricerca semplice per nome carta. Equivale a /v2/cards?q=name:"<string>"
//       Path STORICO usato da _fetchRaw (riga ~4983 di pokemon-db.html).
//
//   ?q=<raw>&pageSize=<n>&orderBy=<...>&page=<n>
//       Query libera alla TCG API (sintassi Lucene di pokemontcg.io).
//       Esempi: q=set.id:swsh1+name:"Pikachu"  oppure  q=name:*char*
//       Usato da _fetchTCGDirect (riga ~4722) e da tutte le ricerche con set
//       selezionato che entrano nel ramo if(setId) di rbSearchCards.
//
//   ?sets=1&orderBy=<...>&pageSize=<n>
//       Restituisce /v2/sets (lista set). Usato da scLoadAllSets (riga ~11042)
//       per aggiornare la lista statica con i set più recenti.
//
// Risposta:
//   200 { data: [...], page, pageSize, count, totalCount }   // formato TCG API
//   200 { data: [], error: 'upstream <status>' }             // TCG API down → array vuoto, il client va in fallback
//   400 { error: '<msg>', data: [] }                          // bad request
//   504 { error: 'upstream timeout', data: [] }               // timeout > 15s
//   500 { error: '<msg>', data: [] }                          // errore interno
//
// Auth: deploy con --no-verify-jwt (come le altre edge function pubbliche
// del progetto). Il client manda Authorization: Bearer <anon> ma non viene
// verificato — basta il CORS aperto.
//
// Deploy:
//   supabase functions deploy hyper-endpoint --project-ref rbjaaeyjeeqfpbzyavag --no-verify-jwt
//   (oppure: push su main → CI/CD lo fa via .github/workflows/deploy-supabase.yml)
// =============================================================================

import { CORS, json, preflight } from '../_shared/http.ts';

// ─── Config ──────────────────────────────────────────────────────────────────
// TCG_KEY non è realmente segreta: è già hardcodata in pokemon-db.html lato
// client. La leggiamo da env per pulizia, con fallback al valore noto così la
// function rimane operativa anche se la env var non è ancora settata.
const TCG_KEY = Deno.env.get('TCG_KEY') || 'ca385a14-d149-4a9f-a275-3bda5b7b1555';
const TCG_BASE = 'https://api.pokemontcg.io/v2';
const UPSTREAM_TIMEOUT_MS = 15_000;

// Cache in-memory: TTL breve (3 min). Riduce carico sull'API quando lo stesso
// utente fa più ricerche identiche (es. seleziona un set, poi cambia carta).
// Su cold start il container è nuovo → cache vuota, comportamento identico.
const CACHE_TTL_MS = 3 * 60 * 1000;
const cache = new Map<string, { exp: number; body: unknown }>();

function cacheGet(key: string): unknown | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) { cache.delete(key); return null; }
  return hit.body;
}
function cacheSet(key: string, body: unknown) {
  // Mantieni la cache piccola: max 200 entries (LRU rudimentale via delete+set).
  if (cache.size >= 200) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  cache.set(key, { exp: Date.now() + CACHE_TTL_MS, body });
}

// ─── Helper: fetch TCG con timeout + retry leggero su 5xx ────────────────────
async function fetchTCG(path: string, params: Record<string,string>): Promise<{
  ok: boolean; status: number; body: any; error?: string;
}> {
  const qs = new URLSearchParams(params).toString();
  const url = `${TCG_BASE}${path}${qs ? '?' + qs : ''}`;
  const cacheKey = path + '?' + qs;

  const hit = cacheGet(cacheKey);
  if (hit) return { ok: true, status: 200, body: hit };

  // Un retry SOLO su 5xx/timeout. Niente backoff complesso: la TCG API è
  // generalmente affidabile e i timeout sono rari.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        headers: { 'X-Api-Key': TCG_KEY, 'Accept': 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (r.ok) {
        const body = await r.json();
        cacheSet(cacheKey, body);
        return { ok: true, status: r.status, body };
      }
      // 5xx → retry una volta sola
      if (r.status >= 500 && attempt === 1) continue;
      // 4xx o 5xx finale → torna l'errore al chiamante (che ritornerà 200 con data:[])
      let detail = '';
      try { detail = (await r.text()).slice(0, 200); } catch { /* ignore */ }
      return { ok: false, status: r.status, body: null, error: `upstream ${r.status}${detail ? ': ' + detail : ''}` };
    } catch (e: any) {
      clearTimeout(timer);
      const isAbort = e?.name === 'AbortError';
      if (attempt === 1 && (isAbort || e?.message?.includes('network'))) continue;
      return { ok: false, status: isAbort ? 504 : 500, body: null, error: isAbort ? 'upstream timeout' : String(e?.message ?? e) };
    }
  }
  return { ok: false, status: 500, body: null, error: 'unreachable' };
}

// ─── Helper: sanitize numeric params ─────────────────────────────────────────
function intParam(value: string | null, def: number, min: number, max: number): number {
  const n = parseInt(value ?? '', 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

// ─── Handler ─────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method !== 'GET') {
    return json({ error: 'method not allowed, use GET', data: [] }, 405);
  }

  try {
    const url = new URL(req.url);
    const sp = url.searchParams;

    const name = sp.get('name');
    const q = sp.get('q');
    const sets = sp.get('sets');

    const pageSize = intParam(sp.get('pageSize'), 30, 1, 250);
    const page = intParam(sp.get('page'), 1, 1, 1000);
    const orderBy = sp.get('orderBy') || '';

    // ── Mode 1: ?sets=1 → /v2/sets ───────────────────────────────────────────
    if (sets === '1' || sets === 'true') {
      const params: Record<string,string> = {
        pageSize: String(pageSize),
        page: String(page),
      };
      if (orderBy) params.orderBy = orderBy;
      const r = await fetchTCG('/sets', params);
      if (r.ok) return json(r.body, 200);
      console.warn('[hyper-endpoint] /sets upstream fail:', r.error);
      return json({ data: [], error: r.error || 'upstream error' }, 200);
    }

    // ── Mode 2: ?q=<raw> → /v2/cards con query libera ────────────────────────
    if (q !== null) {
      const trimmed = q.trim();
      if (!trimmed) {
        return json({ error: 'q vuoto', data: [] }, 400);
      }
      const params: Record<string,string> = {
        q: trimmed,
        pageSize: String(pageSize),
        page: String(page),
      };
      if (orderBy) params.orderBy = orderBy;
      const r = await fetchTCG('/cards', params);
      if (r.ok) return json(r.body, 200);
      console.warn('[hyper-endpoint] /cards (q) upstream fail:', r.error, '| query:', trimmed.slice(0, 80));
      return json({ data: [], error: r.error || 'upstream error' }, 200);
    }

    // ── Mode 3: ?name=<string> → /v2/cards con name:"..." ────────────────────
    if (name !== null) {
      const trimmed = name.trim();
      if (!trimmed) {
        return json({ error: 'name vuoto', data: [] }, 400);
      }
      // Quote interne: la TCG API non gradisce " annidate. Le strippiamo.
      const safe = trimmed.replace(/"/g, '');
      const params: Record<string,string> = {
        q: `name:"${safe}"`,
        pageSize: String(pageSize),
        page: String(page),
      };
      if (orderBy) params.orderBy = orderBy;
      const r = await fetchTCG('/cards', params);
      if (r.ok) return json(r.body, 200);
      console.warn('[hyper-endpoint] /cards (name) upstream fail:', r.error, '| name:', safe.slice(0, 60));
      return json({ data: [], error: r.error || 'upstream error' }, 200);
    }

    // ── Nessun parametro riconosciuto ────────────────────────────────────────
    return json({
      error: 'missing parameter: use ?name=, ?q=, or ?sets=1',
      data: [],
      hint: 'GET /functions/v1/hyper-endpoint?name=Pikachu  (oppure ?q=set.id:swsh1 name:Pikachu  oppure ?sets=1)',
    }, 400);

  } catch (e: any) {
    console.error('[hyper-endpoint] handler error:', e?.message ?? e);
    return json({ error: String(e?.message ?? e), data: [] }, 500);
  }
});
