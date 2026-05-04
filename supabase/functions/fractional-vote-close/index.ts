// ═════════════════════════════════════════════════════════════════════════════
// RareBlock — Fractional vote CLOSE (PR9c)
// ─────────────────────────────────────────────────────────────────────────────
// Chiude una finestra di voto exit window. Può essere chiamata da admin
// manualmente, o automaticamente via cron job al raggiungimento di closes_at.
//
// CALLER: admin (verificato via whitelist email + role) oppure
//         service-role (per chiamate da cron jobs interni)
// INPUT:  { vote_id }   oppure  { product_id }  (chiude il vote attivo)
// OUTPUT: { ok, vote_id, result, votes_summary, next_window_opens_at? }
//
// FLOW:
//   1. Auth: admin o service-role
//   2. Carica voto attivo + prodotto
//   3. Aggrega ballots: sum(quotes_held) per ognuno di sell/postpone/abstain
//   4. Calcolo esito (B4.4):
//        - sell_pct >= 66.67% → result = 'sell'
//        - else                → result = 'postpone'
//        - se zero ballots → 'no_quorum' (trattato come postpone per safety)
//   5. UPDATE inv_fractional_votes con result + closed_at + aggregati
//   6. UPDATE inv_products in funzione dell'esito:
//        - result = 'sell' → status='closed_sell',
//                            (la vendita fisica viene gestita off-chain dall'admin)
//        - result = 'postpone'/'no_quorum' → status='closed_postpone',
//                            schedula prossima finestra a +extension_years
//
// REGOLA DECISIONALE (B4.4):
//   La maggioranza qualificata 2/3 si calcola sul TOTALE delle quote eligible
//   (non sui voti espressi). Quote astenute o non espresse contano come 'no'
//   ai fini del raggiungimento della soglia: senza voto attivo del 66.67% per
//   'sell', si rinvia. Questa è la lettura più conservativa e si allinea
//   all'Art. 8.3 del template BUYER_FRACTIONAL_V1.
// ═════════════════════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ADMIN_EMAILS = [
  'admin@rareblock.eu',
  'valemaui@gmail.com',
  'v.castiglia@serifast.it',
];

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

interface CloseInput {
  vote_id?: string;
  product_id?: string;     // alternativa: chiudi il vote attivo del prodotto
  force?: boolean;         // se true, chiude anche se finestra non scaduta (admin only)
}

const SELL_THRESHOLD_PCT = 66.67;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405);

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'missing_authorization' }, 401);

    // Detect chiamata service-role (per cron interni)
    const incomingToken = authHeader.replace(/^Bearer\s+/i, '').trim();
    const isServiceRoleCall = incomingToken === SUPABASE_SERVICE_ROLE_KEY;

    let userId: string | null = null;
    let isAdmin = false;

    if (!isServiceRoleCall) {
      // Chiamata utente: verifica admin
      const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user }, error: uErr } = await sb.auth.getUser();
      if (uErr || !user) return json({ error: 'unauthorized', detail: uErr?.message }, 401);

      userId = user.id;
      const isAdminByEmail = ADMIN_EMAILS.includes(user.email || '');
      let isAdminByRole = false;
      try {
        const { data: prof } = await sb.from('profiles').select('role').eq('id', user.id).maybeSingle();
        if (prof?.role === 'admin') isAdminByRole = true;
      } catch { /* ignore */ }
      isAdmin = isAdminByEmail || isAdminByRole;
      if (!isAdmin) return json({ error: 'forbidden_admin_only' }, 403);
    }

    const sbAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const body = (await req.json().catch(() => null)) as CloseInput | null;
    if (!body || (!body.vote_id && !body.product_id)) {
      return json({ error: 'missing_fields', required: ['vote_id OR product_id'] }, 400);
    }

    // 1) Carica voto attivo
    let voteQuery = sbAdmin.from('inv_fractional_votes').select('*');
    if (body.vote_id) voteQuery = voteQuery.eq('id', body.vote_id);
    else              voteQuery = voteQuery.eq('product_id', body.product_id!).is('closed_at', null);

    const { data: vote, error: vErr } = await voteQuery.maybeSingle();
    if (vErr) return json({ error: 'db_error', detail: vErr.message }, 500);
    if (!vote) return json({ error: 'vote_not_found' }, 404);
    if (vote.closed_at) return json({ error: 'vote_already_closed', detail: `Chiuso il ${vote.closed_at}` }, 409);

    // 2) Verifica scadenza (a meno che force=true e admin)
    const now = Date.now();
    const closesAtMs = new Date(vote.closes_at).getTime();
    if (now < closesAtMs && !(body.force && isAdmin)) {
      return json({
        error: 'vote_window_still_open',
        detail: `La finestra è ancora aperta fino al ${vote.closes_at}. Usa force=true per chiusura anticipata (solo admin).`,
        closes_at: vote.closes_at,
      }, 409);
    }

    // 3) Aggrega ballots finali (re-conto da ground truth)
    const { data: ballots, error: bErr } = await sbAdmin
      .from('inv_fractional_vote_ballots')
      .select('ballot, quotes_held')
      .eq('vote_id', vote.id);
    if (bErr) return json({ error: 'db_error', detail: bErr.message }, 500);

    let qSell = 0, qPostpone = 0, qAbstain = 0;
    for (const b of (ballots || [])) {
      if (b.ballot === 'sell')     qSell     += Number(b.quotes_held) || 0;
      if (b.ballot === 'postpone') qPostpone += Number(b.quotes_held) || 0;
      if (b.ballot === 'abstain')  qAbstain  += Number(b.quotes_held) || 0;
    }
    const totalEligible = Number(vote.total_eligible_quotes) || 0;
    const sellPct = totalEligible > 0 ? (qSell / totalEligible) * 100 : 0;

    // 4) Calcolo esito
    let result: 'sell' | 'postpone' | 'no_quorum';
    if ((ballots?.length || 0) === 0) {
      result = 'no_quorum';
    } else if (sellPct >= SELL_THRESHOLD_PCT) {
      result = 'sell';
    } else {
      result = 'postpone';
    }

    // 5) UPDATE vote
    await sbAdmin
      .from('inv_fractional_votes')
      .update({
        result: result,
        votes_sell_quotes:    qSell,
        votes_no_quotes:      qPostpone,
        votes_abstain_quotes: qAbstain,
        closed_at: new Date().toISOString(),
        closed_by: userId,    // null per cron service-role
      })
      .eq('id', vote.id);

    // 6) Carica prodotto + applica conseguenze
    const { data: product } = await sbAdmin
      .from('inv_products')
      .select('id, fractional_extension_years')
      .eq('id', vote.product_id)
      .maybeSingle();

    const extYears = Math.max(1, Number(product?.fractional_extension_years) || 2);
    let nextWindowOpensAt: string | null = null;

    if (result === 'sell') {
      await sbAdmin
        .from('inv_products')
        .update({
          fractional_exit_window_status: 'closed_sell',
          fractional_exit_window_opens_at: null,
          fractional_exit_window_closes_at: null,
        })
        .eq('id', vote.product_id);
    } else {
      // postpone OR no_quorum → schedula nuova finestra a +extension_years
      const next = new Date();
      next.setFullYear(next.getFullYear() + extYears);
      nextWindowOpensAt = next.toISOString();
      await sbAdmin
        .from('inv_products')
        .update({
          fractional_exit_window_status: 'closed_postpone',
          fractional_exit_window_opens_at: nextWindowOpensAt,
          fractional_exit_window_closes_at: null,
        })
        .eq('id', vote.product_id);
    }

    return json({
      ok: true,
      vote_id: vote.id,
      product_id: vote.product_id,
      round_number: vote.round_number,
      result: result,
      votes_summary: {
        total_eligible_quotes: totalEligible,
        votes_sell_quotes:     qSell,
        votes_postpone_quotes: qPostpone,
        votes_abstain_quotes:  qAbstain,
        votes_cast_total:      qSell + qPostpone + qAbstain,
        sell_pct:              parseFloat(sellPct.toFixed(2)),
        threshold_pct:         SELL_THRESHOLD_PCT,
      },
      next_window_opens_at: nextWindowOpensAt,
      message: result === 'sell'
        ? 'Voto approvato per la vendita. Procedere con la liquidazione del bene fisico off-chain.'
        : result === 'postpone'
          ? `Voto contrario. La prossima finestra si aprirà tra ${extYears} anni (${nextWindowOpensAt?.slice(0,10)}).`
          : `Nessun voto espresso. Trattato come 'postpone'. Prossima finestra tra ${extYears} anni (${nextWindowOpensAt?.slice(0,10)}).`,
    });

  } catch (e: any) {
    return json({ error: 'unexpected', detail: e?.message ?? String(e) }, 500);
  }
});
