// ═════════════════════════════════════════════════════════════════════════════
// RareBlock — Fractional vote OPEN (PR9c)
// ─────────────────────────────────────────────────────────────────────────────
// Apre una finestra di voto exit window per un prodotto fractional.
//
// CALLER: admin (verificato via auth.users.email in admin whitelist)
// INPUT:  { product_id, duration_days?:60 }
// OUTPUT: { ok, vote_id, round_number, opens_at, closes_at, eligible_quotes }
//
// FLOW:
//   1. Auth: admin only
//   2. Validation: product esiste, è 'fractional', non c'è già un voto aperto
//   3. Calcolo round_number = max(round_number) + 1 (default 1)
//   4. Snapshot total_eligible_quotes = sum(qty) da inv_holdings WHERE product_id
//   5. INSERT inv_fractional_votes
//   6. UPDATE inv_products.fractional_exit_window_status = 'open',
//             fractional_exit_window_opens_at, fractional_exit_window_closes_at
//   7. Return JSON con dati per UI
// ═════════════════════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { enqueueFractionalVoteOpenEmails } from '../_shared/email.ts';

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

interface OpenInput {
  product_id: string;
  duration_days?: number;     // default 60 giorni (B4.1)
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405);

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // Client per auth via JWT (rispetta RLS)
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'missing_authorization' }, 401);
    const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    // Verifica utente
    const { data: { user }, error: uErr } = await sb.auth.getUser();
    if (uErr || !user) return json({ error: 'unauthorized', detail: uErr?.message }, 401);

    // Solo admin: hardcoded whitelist + check role su profiles (best-effort)
    const isAdminByEmail = ADMIN_EMAILS.includes(user.email || '');
    let isAdminByRole = false;
    try {
      const { data: prof } = await sb.from('profiles').select('role').eq('id', user.id).maybeSingle();
      if (prof?.role === 'admin') isAdminByRole = true;
    } catch { /* ignore */ }
    if (!isAdminByEmail && !isAdminByRole) return json({ error: 'forbidden_admin_only' }, 403);

    // Service-role per le scritture (bypass RLS sulle tabelle voto)
    const sbAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const body = (await req.json().catch(() => null)) as OpenInput | null;
    if (!body || !body.product_id) return json({ error: 'missing_product_id' }, 400);
    const productId = String(body.product_id);
    const durationDays = Math.max(1, Math.min(365, parseInt(String(body.duration_days ?? 60), 10) || 60));

    // 1) Carica prodotto
    const { data: product, error: pErr } = await sbAdmin
      .from('inv_products')
      .select('id, name, type, status, fractional_exit_window_status, fractional_target_price_eur, fractional_exit_window_years, total_quotes')
      .eq('id', productId)
      .maybeSingle();

    if (pErr) return json({ error: 'db_error', detail: pErr.message }, 500);
    if (!product) return json({ error: 'product_not_found' }, 404);
    if (product.type !== 'fractional') return json({ error: 'not_fractional', detail: 'Il prodotto non è di tipo fractional' }, 400);

    // 2) Non deve esserci già un voto aperto per questo prodotto
    const { data: openVote, error: ovErr } = await sbAdmin
      .from('inv_fractional_votes')
      .select('id, round_number, closes_at')
      .eq('product_id', productId)
      .is('closed_at', null)
      .maybeSingle();
    if (ovErr) return json({ error: 'db_error', detail: ovErr.message }, 500);
    if (openVote) {
      return json({
        error: 'vote_already_open',
        detail: `Esiste già un voto aperto (round ${openVote.round_number}, chiude il ${openVote.closes_at})`,
        vote_id: openVote.id,
      }, 409);
    }

    // 3) Calcola round_number = max(round) + 1
    const { data: rounds } = await sbAdmin
      .from('inv_fractional_votes')
      .select('round_number')
      .eq('product_id', productId)
      .order('round_number', { ascending: false })
      .limit(1);
    const lastRound = (Array.isArray(rounds) && rounds.length) ? Number(rounds[0].round_number) : 0;
    const newRound = lastRound + 1;

    // 4) Snapshot eligible quotes: sum(qty) da inv_holdings
    const { data: holdings, error: hErr } = await sbAdmin
      .from('inv_holdings')
      .select('qty')
      .eq('product_id', productId);
    if (hErr) return json({ error: 'db_error', detail: hErr.message }, 500);
    const totalEligibleQuotes = (holdings || []).reduce((sum, h: any) => sum + (Number(h.qty) || 0), 0);
    if (totalEligibleQuotes === 0) {
      return json({
        error: 'no_eligible_quotes',
        detail: 'Nessun comproprietario rilevato per questo prodotto. Voto non apribile.',
      }, 400);
    }

    // 5) Calcola opens_at + closes_at
    const opensAt = new Date();
    const closesAt = new Date(opensAt.getTime() + durationDays * 24 * 60 * 60 * 1000);

    // 6) INSERT inv_fractional_votes
    const { data: voteRow, error: ivErr } = await sbAdmin
      .from('inv_fractional_votes')
      .insert({
        product_id: productId,
        round_number: newRound,
        opened_at: opensAt.toISOString(),
        closes_at: closesAt.toISOString(),
        total_eligible_quotes: totalEligibleQuotes,
        opened_by: user.id,
      })
      .select('id')
      .single();
    if (ivErr || !voteRow) return json({ error: 'insert_vote_failed', detail: ivErr?.message }, 500);

    // 7) UPDATE inv_products
    await sbAdmin
      .from('inv_products')
      .update({
        fractional_exit_window_status: 'open',
        fractional_exit_window_opens_at: opensAt.toISOString(),
        fractional_exit_window_closes_at: closesAt.toISOString(),
      })
      .eq('id', productId);

    // 8) Enqueue notifiche email comproprietari (best-effort, non blocca la risposta)
    let emailsEnqueued = 0;
    try {
      const emailRes = await enqueueFractionalVoteOpenEmails(sbAdmin, voteRow.id);
      if (emailRes.ok) {
        emailsEnqueued = emailRes.emails_count;
      } else {
        console.warn('enqueue emails failed:', emailRes.error);
      }
    } catch (e) {
      console.warn('enqueue emails exception:', e);
    }

    return json({
      ok: true,
      vote_id: voteRow.id,
      round_number: newRound,
      product_id: productId,
      product_name: product.name,
      opens_at: opensAt.toISOString(),
      closes_at: closesAt.toISOString(),
      total_eligible_quotes: totalEligibleQuotes,
      threshold_pct: 66.67,
      threshold_quotes: Math.ceil(totalEligibleQuotes * 0.6667),
      emails_enqueued: emailsEnqueued,
    });

  } catch (e: any) {
    return json({ error: 'unexpected', detail: e?.message ?? String(e) }, 500);
  }
});
