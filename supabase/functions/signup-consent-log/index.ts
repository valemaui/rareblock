// ═════════════════════════════════════════════════════════════════════════════
// RareBlock — Signup Consent Log (PR1)
// ─────────────────────────────────────────────────────────────────────────────
// Persistere i consensi GDPR esplicitati al signup (privacy + T&C).
//
// CALLER: utente appena registrato (sessione fresh post-signup, JWT valido)
// INPUT:  { consents: { privacy: true, tos: true } }
// OUTPUT: { ok, logged_count }
//
// FLOW:
//   1. Auth: utente autenticato (qualsiasi)
//   2. Validazione: privacy=true e tos=true obbligatori (gating del signup)
//   3. INSERT N righe in gdpr_consent_log con source='signup', IP+UA
//
// SECURITY: service_role bypassa RLS sulla tabella (che è seal).
// Le righe sono tracciate forensicamente: chi+quando+da-dove ha consentito.
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

interface ConsentInput {
  consents: {
    privacy: boolean;
    tos: boolean;
    marketing?: boolean;     // opzionale per estensione futura
  };
  // Versione testo informative al momento del consenso (per audit storico)
  privacy_version?: string;
  tos_version?: string;
}

const PRIVACY_VERSION_DEFAULT = '1.0';
const TOS_VERSION_DEFAULT = '1.0';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405);

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // 1) Auth
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'missing_authorization' }, 401);
    const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: uErr } = await sb.auth.getUser();
    if (uErr || !user) return json({ error: 'unauthorized', detail: uErr?.message }, 401);

    // 2) Body parse + validation
    const body = (await req.json().catch(() => null)) as ConsentInput | null;
    if (!body || !body.consents) {
      return json({ error: 'missing_consents' }, 400);
    }
    if (body.consents.privacy !== true) {
      return json({ error: 'privacy_consent_required', detail: 'Devi accettare l\'informativa privacy per procedere.' }, 400);
    }
    if (body.consents.tos !== true) {
      return json({ error: 'tos_consent_required', detail: 'Devi accettare i termini e condizioni per procedere.' }, 400);
    }

    // 3) Audit context
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
    const ua = req.headers.get('user-agent')?.slice(0, 500) || null;
    const privacyVer = body.privacy_version || PRIVACY_VERSION_DEFAULT;
    const tosVer     = body.tos_version     || TOS_VERSION_DEFAULT;

    // 4) Service-role per scritture in gdpr_consent_log (RLS sealed)
    const sbAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // 5) Idempotenza: se l'utente ha già loggato questi consensi al signup,
    //    non creiamo duplicati. Verifica via SELECT.
    const { data: existing } = await sbAdmin
      .from('gdpr_consent_log')
      .select('consent_key')
      .eq('user_id', user.id)
      .eq('source', 'signup');

    const alreadyLogged = new Set((existing || []).map((r: any) => r.consent_key));

    // 6) Costruisci righe da inserire
    const rowsToInsert: any[] = [];
    if (!alreadyLogged.has('privacy')) {
      rowsToInsert.push({
        user_id:    user.id,
        consent_key:'privacy',
        old_value:  null,
        new_value:  { accepted: true, version: privacyVer },
        ip:         ip,
        user_agent: ua,
        source:     'signup',
      });
    }
    if (!alreadyLogged.has('tos')) {
      rowsToInsert.push({
        user_id:    user.id,
        consent_key:'tos',
        old_value:  null,
        new_value:  { accepted: true, version: tosVer },
        ip:         ip,
        user_agent: ua,
        source:     'signup',
      });
    }
    if (body.consents.marketing === true && !alreadyLogged.has('marketing')) {
      rowsToInsert.push({
        user_id:    user.id,
        consent_key:'marketing',
        old_value:  null,
        new_value:  { accepted: true },
        ip:         ip,
        user_agent: ua,
        source:     'signup',
      });
    }

    if (rowsToInsert.length === 0) {
      return json({ ok: true, logged_count: 0, message: 'consensi già registrati' });
    }

    const { error: iErr } = await sbAdmin
      .from('gdpr_consent_log')
      .insert(rowsToInsert);

    if (iErr) {
      return json({ error: 'log_insert_failed', detail: iErr.message }, 500);
    }

    return json({
      ok: true,
      logged_count: rowsToInsert.length,
      consent_keys: rowsToInsert.map(r => r.consent_key),
    });

  } catch (e: any) {
    return json({ error: 'unexpected', detail: e?.message ?? String(e) }, 500);
  }
});
