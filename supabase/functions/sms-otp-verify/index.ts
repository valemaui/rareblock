// =============================================================================
// Supabase Edge Function: sms-otp-verify
// =============================================================================
// SELF-CONTAINED: gli helper condivisi sono inlined in cima al file.
// Vedi commento equivalente in sms-otp-send/index.ts per la motivazione.
//
// Verifica un codice OTP contro l'hash salvato. Se valido:
//   • marca otp_codes.consumed_at = now()
//   • per purpose='phone_verify' → aggiorna profiles.phone_verified_at
//   • per purpose='contract_sign' → ritorna audit data per contract-sign
//   • per purpose='critical_action' → solo conferma
//
// Body: { "otp_id": "<uuid>", "code": "123456" }
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';


// ═════════════════════════════════════════════════════════════════════════════
// ─── inlined from _shared/http.ts ────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, apikey',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}

function preflight(req: Request): Response | null {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  return null;
}

function clientIp(req: Request): string | null {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      ?? req.headers.get('cf-connecting-ip')
      ?? req.headers.get('x-real-ip')
      ?? null;
}

function userAgent(req: Request): string | null {
  return req.headers.get('user-agent');
}


// ═════════════════════════════════════════════════════════════════════════════
// ─── inlined from _shared/otp.ts ─────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════
const HEX = '0123456789abcdef';

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += HEX[b >> 4] + HEX[b & 15];
  return s;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf  = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(buf));
}

/**
 * Verifica un codice OTP contro l'hash salvato. Timing-safe.
 * Formato hash storage: `${salt}:${sha256_hex}`.
 */
async function verifyOtpHash(code: string, stored: string): Promise<boolean> {
  const idx = stored.indexOf(':');
  if (idx <= 0) return false;
  const salt    = stored.slice(0, idx);
  const expHash = stored.slice(idx + 1);
  if (!salt || !expHash) return false;

  const actHash = await sha256Hex(`${salt}:${code}`);

  // Timing-safe comparison
  const len = Math.max(actHash.length, expHash.length);
  let mismatch = actHash.length ^ expHash.length;
  for (let i = 0; i < len; i++) {
    const ca = i < actHash.length ? actHash.charCodeAt(i) : 0;
    const cb = i < expHash.length ? expHash.charCodeAt(i) : 0;
    mismatch |= ca ^ cb;
  }
  return mismatch === 0;
}


// ═════════════════════════════════════════════════════════════════════════════
// ─── MAIN HANDLER ────────────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════
interface VerifyInput {
  otp_id: string;
  code:   string;
}

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    // 1. Auth utente
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'missing_authorization' }, 401);

    const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!;
    const SUPABASE_ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY')!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ error: 'invalid_session' }, 401);
    const user = userData.user;

    // 2. Parse body
    const body = (await req.json().catch(() => null)) as VerifyInput | null;
    if (!body?.otp_id || !body?.code) return json({ error: 'missing_otp_id_or_code' }, 400);
    if (!/^\d{4,8}$/.test(body.code)) return json({ error: 'invalid_code_format' }, 400);

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // 3. Carica record OTP
    const { data: otp, error: loadErr } = await adminClient
      .from('otp_codes')
      .select('id, user_id, phone_e164, code_hash, purpose, context_id, attempts, max_attempts, expires_at, consumed_at, channel')
      .eq('id', body.otp_id)
      .maybeSingle();

    if (loadErr) return json({ error: 'otp_load_failed', detail: loadErr.message }, 500);
    if (!otp)    return json({ error: 'otp_not_found' }, 404);

    // 4. Validazioni di stato
    if (otp.user_id !== user.id) {
      // Non rivelare il dettaglio (anti-enumeration)
      return json({ error: 'otp_not_found' }, 404);
    }
    if (otp.consumed_at) return json({ error: 'otp_already_consumed' }, 410);
    const expires = new Date(otp.expires_at).getTime();
    if (Number.isNaN(expires) || expires < Date.now()) {
      return json({ error: 'otp_expired' }, 410);
    }
    if (otp.attempts >= otp.max_attempts) {
      return json({ error: 'otp_max_attempts_reached' }, 429);
    }

    // 5. Verifica del codice (timing-safe)
    const ok = await verifyOtpHash(body.code, otp.code_hash);

    if (!ok) {
      const newAttempts = otp.attempts + 1;
      await adminClient.from('otp_codes')
        .update({ attempts: newAttempts })
        .eq('id', otp.id);
      return json({
        error: 'otp_invalid',
        attempts_remaining: Math.max(0, otp.max_attempts - newAttempts),
      }, 401);
    }

    // 6. OTP VALIDO — marca consumato con guard concurrent-consume
    const consumedAt = new Date().toISOString();
    const { error: consErr } = await adminClient.from('otp_codes')
      .update({ consumed_at: consumedAt })
      .eq('id', otp.id)
      .is('consumed_at', null);
    if (consErr) return json({ error: 'otp_consume_failed', detail: consErr.message }, 500);

    const sideEffects: Record<string, unknown> = {};

    if (otp.purpose === 'phone_verify') {
      const { error: pErr } = await adminClient.from('profiles')
        .update({
          phone_e164:        otp.phone_e164,
          phone:             otp.phone_e164,           // retrocompatibilità
          phone_verified_at: consumedAt,
        })
        .eq('id', user.id);
      if (pErr) return json({ error: 'profile_update_failed', detail: pErr.message }, 500);
      sideEffects.phone_verified_at = consumedAt;
      sideEffects.phone_e164        = otp.phone_e164;
    }

    // Audit per la firma contrattuale (NO codice in chiaro)
    const audit = {
      otp_id:      otp.id,
      verified_at: consumedAt,
      channel:     otp.channel,
      ip:          clientIp(req),
      user_agent:  userAgent(req),
      phone_last4: otp.phone_e164.slice(-4),
    };

    return json({
      ok:           true,
      purpose:      otp.purpose,
      context_id:   otp.context_id,
      side_effects: sideEffects,
      audit,
    });

  } catch (e: any) {
    return json({ error: 'unexpected', detail: e?.message ?? String(e) }, 500);
  }
});
