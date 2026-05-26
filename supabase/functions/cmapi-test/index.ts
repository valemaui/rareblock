// Supabase Edge Function: cmapi-test
// =============================================================================
// Test diagnostico per cardmarket-api.com (RapidAPI) PRIMA di pagare/bootstrap.
// Legge CMAPI_KEY dai Secrets, interroga N carte di set diversi (EN/IT/JP) e
// ritorna un report su:
//   1. granularità per-condizione effettiva (NM only? altre condizioni?)
//   2. campi per-paese realmente popolati (_IT in primis)
//   3. presenza graded, medie 7d/30d
//   4. forma del mapping (id/card_number/episode.code)
//   5. raw della prima carta, per ispezione campi non documentati
//
// NON scrive su DB. Solo lettura + report. Serve a decidere lo schema finale.
//
// Chiamata (POST, JWT admin):
//   { "samples": ["charizard ex","pikachu","giratina vstar"], "language":"EN" }
// oppure { "episodeId": 21, "limit": 10 }
//
// SICUREZZA:
// - CMAPI_KEY mai esposta al client: vive solo nei Secrets, usata server-side
// - Solo admin può chiamare (evita di bruciare quota dal client)
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

// Host RapidAPI per questa API (dalla doc cardmarket-api / tcggo)
const CMAPI_HOST = 'cardmarket-api-tcg.p.rapidapi.com';
const CMAPI_BASE = `https://${CMAPI_HOST}`;

interface TestInput {
  samples?: string[];
  language?: 'EN' | 'IT' | 'JP';
  episodeId?: number;
  limit?: number;
}

// Analizza una card CMAPI e estrae cosa ci interessa per la decisione schema
function analyzeCard(card: any) {
  const cm = card?.prices?.cardmarket ?? {};
  // Quali chiavi "lowest_*" / condizioni esistono davvero?
  const condKeys = Object.keys(cm).filter((k) =>
    /near_mint|mint|excellent|good|played|poor|lowest/i.test(k),
  );
  const countryKeys = Object.keys(cm).filter((k) => /_(DE|FR|ES|IT)$/i.test(k));
  return {
    id: card?.id ?? null,
    name: card?.name ?? null,
    card_number: card?.card_number ?? null,
    episode_code: card?.episode?.code ?? null,
    episode_name: card?.episode?.name ?? null,
    cm_condition_keys: condKeys,           // ← granularità per-condizione reale
    cm_country_keys: countryKeys,          // ← _IT presente?
    has_7d: cm['7d_average'] != null,
    has_30d: cm['30d_average'] != null,
    has_graded: cm?.graded != null,
    graded_companies: cm?.graded ? Object.keys(cm.graded) : [],
    lowest_near_mint: cm?.lowest_near_mint ?? null,
    lowest_near_mint_IT: cm?.lowest_near_mint_IT ?? null,
  };
}

async function cmapiGet(path: string, key: string) {
  const res = await fetch(`${CMAPI_BASE}${path}`, {
    headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': CMAPI_HOST },
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    // ── Auth: admin via JWT, OPPURE test-secret dal Dashboard ──
    const authHeader = req.headers.get('Authorization');
    const TEST_SECRET = Deno.env.get('CMAPI_TEST_SECRET');
    const providedSecret = req.headers.get('x-test-secret');
    const secretOk = !!TEST_SECRET && providedSecret === TEST_SECRET;

    const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!;
    const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

    if (!secretOk) {
      if (!authHeader) return json({ error: 'Missing Authorization (o usa header x-test-secret)' }, 401);
      const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: u, error: uErr } = await userClient.auth.getUser();
      if (uErr || !u?.user) return json({ error: 'Sessione non valida' }, 401);
      const { data: isAdmin } = await userClient.rpc('is_admin');
      if (!isAdmin) return json({ error: 'Forbidden: admin required' }, 403);
    }

    // ── Secret ──
    const CMAPI_KEY = Deno.env.get('CMAPI_KEY');
    if (!CMAPI_KEY) {
      return json({ error: 'CMAPI_KEY non configurata nei Secrets' }, 500);
    }

    const input = (await req.json().catch(() => ({}))) as TestInput;
    const language = input.language ?? 'EN';
    const samples = input.samples ?? ['charizard', 'pikachu', 'giratina vstar'];

    const report: any = {
      api_host: CMAPI_HOST,
      language_requested: language,
      probes: [],
      raw_first_card: null,
      notes: [],
    };

    // ── Probe per search term ──
    for (const term of samples) {
      const q = `/pokemon/cards?search=${encodeURIComponent(term)}&sort=price_highest`;
      const { status, body } = await cmapiGet(q, CMAPI_KEY);

      if (status !== 200) {
        report.probes.push({ term, status, error: typeof body === 'string' ? body.slice(0, 300) : body });
        continue;
      }
      // CMAPI può tornare {data:[...]} o array diretto: gestiamo entrambi
      const list = Array.isArray(body) ? body : (body?.data ?? body?.cards ?? []);
      const first = Array.isArray(list) ? list[0] : null;
      report.probes.push({
        term,
        status,
        results: Array.isArray(list) ? list.length : 0,
        first_card: first ? analyzeCard(first) : null,
      });
      if (!report.raw_first_card && first) report.raw_first_card = first;
    }

    // ── Auto-note sulla decisione schema ──
    const anyCard = report.probes.find((p: any) => p.first_card)?.first_card;
    if (anyCard) {
      if (anyCard.cm_condition_keys.length <= 1) {
        report.notes.push(
          'CMAPI sembra esporre SOLO lowest_near_mint (nessun breakdown Mint→Poor). ' +
          'Il per-condizione completo NON arriva da qui → resta lo userscript per quello.',
        );
      } else {
        report.notes.push(
          'CMAPI espone più condizioni: ' + anyCard.cm_condition_keys.join(', '),
        );
      }
      report.notes.push(
        anyCard.cm_country_keys.length
          ? 'Prezzi per-paese presenti: ' + anyCard.cm_country_keys.join(', ')
          : 'ATTENZIONE: nessun prezzo per-paese (_IT) in questa risposta.',
      );
      report.notes.push(
        'Mapping: id=' + anyCard.id + ' card_number=' + anyCard.card_number +
        ' episode_code=' + anyCard.episode_code +
        ' → usare (card_number + episode_code) per agganciare rb_card_id.',
      );
    }

    return json(report);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
