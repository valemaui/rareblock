// ═════════════════════════════════════════════════════════════════════════════
// RareBlock — Fractional vote CAST (PR9c)
// ─────────────────────────────────────────────────────────────────────────────
// L'utente comproprietario esprime il proprio voto in una finestra exit window.
//
// CALLER: comproprietario autenticato
// INPUT:  { vote_id, ballot: 'sell'|'postpone'|'abstain' }
// OUTPUT: { ok, ballot_id, quotes_held, vote_summary:{…} }
//
// FLOW:
//   1. Auth: utente autenticato
//   2. Validation: voto esiste e ancora aperto (closed_at IS NULL, now < closes_at)
//   3. Calcolo quote possedute dall'utente per il prodotto del voto
//      (sum(qty) di inv_holdings WHERE product_id AND user_id)
//   4. Verifica: utente ha effettivamente quote (eligibility)
//   5. Verifica: utente non ha già votato in questo round
//   6. INSERT inv_fractional_vote_ballots (immutabile)
//   7. Aggrega counter su inv_fractional_votes (votes_*_quotes)
//   8. Return summary aggiornato (per UI)
//
// NOTE: la regola "abstain conta come no" (B4.3 nel template Art. 8.3) è
// applicata SOLO al momento della chiusura del voto in fractional-vote-close.
// Qui si registra fedelmente la scelta dell'utente.
// ═════════════════════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

interface CastInput {
  vote_id: string;
  ballot: 'sell' | 'postpone' | 'abstain';
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405);

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'missing_authorization' }, 401);

    const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: uErr } = await sb.auth.getUser();
    if (uErr || !user) return json({ error: 'unauthorized', detail: uErr?.message }, 401);

    // Service-role per scritture aggregate
    const sbAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const body = (await req.json().catch(() => null)) as CastInput | null;
    if (!body || !body.vote_id || !body.ballot) {
      return json({ error: 'missing_fields', required: ['vote_id', 'ballot'] }, 400);
    }
    if (!['sell', 'postpone', 'abstain'].includes(body.ballot)) {
      return json({ error: 'invalid_ballot', detail: 'ballot must be one of: sell, postpone, abstain' }, 400);
    }

    // 1) Carica voto e verifica che sia aperto
    const { data: vote, error: vErr } = await sbAdmin
      .from('inv_fractional_votes')
      .select('id, product_id, round_number, opened_at, closes_at, closed_at, total_eligible_quotes')
      .eq('id', body.vote_id)
      .maybeSingle();
    if (vErr) return json({ error: 'db_error', detail: vErr.message }, 500);
    if (!vote) return json({ error: 'vote_not_found' }, 404);
    if (vote.closed_at) return json({ error: 'vote_already_closed', detail: `Chiuso il ${vote.closed_at}` }, 409);

    const now = Date.now();
    if (now > new Date(vote.closes_at).getTime()) {
      return json({ error: 'vote_window_expired', detail: `Finestra scaduta il ${vote.closes_at}` }, 409);
    }

    // 2) Calcola quote possedute dall'utente per questo product
    const { data: holdings, error: hErr } = await sbAdmin
      .from('inv_holdings')
      .select('qty')
      .eq('product_id', vote.product_id)
      .eq('user_id', user.id);
    if (hErr) return json({ error: 'db_error', detail: hErr.message }, 500);
    const quotesHeld = (holdings || []).reduce((sum, h: any) => sum + (Number(h.qty) || 0), 0);
    if (quotesHeld === 0) {
      return json({ error: 'not_eligible', detail: 'Non possiedi quote di questo prodotto. Non puoi votare.' }, 403);
    }

    // 3) Verifica anti-doublevote
    const { data: existingBallot } = await sbAdmin
      .from('inv_fractional_vote_ballots')
      .select('id, ballot, cast_at')
      .eq('vote_id', vote.id)
      .eq('user_id', user.id)
      .maybeSingle();
    if (existingBallot) {
      return json({
        error: 'already_voted',
        detail: `Hai già votato '${existingBallot.ballot}' il ${existingBallot.cast_at}. I voti sono immutabili.`,
        existing_ballot: existingBallot.ballot,
      }, 409);
    }

    // 4) Audit info: IP + UA (best-effort)
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
    const ua = req.headers.get('user-agent')?.slice(0, 500) || null;

    // 5) INSERT ballot
    const { data: ballotRow, error: bErr } = await sbAdmin
      .from('inv_fractional_vote_ballots')
      .insert({
        vote_id: vote.id,
        user_id: user.id,
        product_id: vote.product_id,
        quotes_held: quotesHeld,
        ballot: body.ballot,
        ip_address: ip,
        user_agent: ua,
      })
      .select('id, cast_at')
      .single();
    if (bErr || !ballotRow) return json({ error: 'insert_ballot_failed', detail: bErr?.message }, 500);

    // 6) Aggrega contatori per UI (votes_sell_quotes, votes_no_quotes, votes_abstain_quotes)
    const { data: allBallots } = await sbAdmin
      .from('inv_fractional_vote_ballots')
      .select('ballot, quotes_held')
      .eq('vote_id', vote.id);

    let qSell = 0, qPostpone = 0, qAbstain = 0;
    for (const b of (allBallots || [])) {
      if (b.ballot === 'sell')     qSell     += Number(b.quotes_held) || 0;
      if (b.ballot === 'postpone') qPostpone += Number(b.quotes_held) || 0;
      if (b.ballot === 'abstain')  qAbstain  += Number(b.quotes_held) || 0;
    }
    await sbAdmin
      .from('inv_fractional_votes')
      .update({
        votes_sell_quotes:    qSell,
        votes_no_quotes:      qPostpone,    // 'no' nel DB schema = 'postpone' lato API
        votes_abstain_quotes: qAbstain,
      })
      .eq('id', vote.id);

    const totalEligible = Number(vote.total_eligible_quotes) || 0;
    const sellPct = totalEligible > 0 ? (qSell / totalEligible) * 100 : 0;

    return json({
      ok: true,
      ballot_id: ballotRow.id,
      cast_at: ballotRow.cast_at,
      vote_id: vote.id,
      product_id: vote.product_id,
      ballot: body.ballot,
      quotes_held: quotesHeld,
      vote_summary: {
        total_eligible_quotes: totalEligible,
        votes_sell_quotes:     qSell,
        votes_postpone_quotes: qPostpone,
        votes_abstain_quotes:  qAbstain,
        votes_cast_total:      qSell + qPostpone + qAbstain,
        sell_pct:              parseFloat(sellPct.toFixed(2)),
        threshold_pct:         66.67,
        threshold_reached:     sellPct >= 66.67,
      },
    });

  } catch (e: any) {
    return json({ error: 'unexpected', detail: e?.message ?? String(e) }, 500);
  }
});
