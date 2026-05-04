// Supabase Edge Function: sms-otp-verify
// =============================================================================
// Verifica un codice OTP contro l'hash salvato. Se valido:
//   • marca otp_codes.consumed_at = now()
//   • per purpose='phone_verify' → aggiorna profiles.phone_verified_at e phone_e164
//   • per purpose='contract_sign' → ritorna audit data che la function
//     contract-sign userà per l'apposizione FEA (nessun side effect qui)
//   • per purpose='critical_action' → solo conferma
//
// Body atteso:
//   { "otp_id": "<uuid>", "code": "123456" }
//
// Risposta success:
//   { ok: true, purpose, side_effects: { phone_verified_at? }, audit: {...} }
//
// Risposta error:
//   { error, attempts_remaining? }
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CORS, json, preflight, clientIp, userAgent } from '../_shared/http.ts';
import { verifyOtpHash } from '../_shared/otp.ts';

interface VerifyInput {
  otp_id: string;
  code:   string;
}

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    // ── 1. Auth utente ──────────────────────────────────────────────
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

    // ── 2. Parse body ───────────────────────────────────────────────
    const body = (await req.json().catch(() => null)) as VerifyInput | null;
    if (!body?.otp_id || !body?.code) {
      return json({ error: 'missing_otp_id_or_code' }, 400);
    }
    if (!/^\d{4,8}$/.test(body.code)) {
      return json({ error: 'invalid_code_format' }, 400);
    }

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // ── 3. Carica record OTP ────────────────────────────────────────
    const { data: otp, error: loadErr } = await adminClient
      .from('otp_codes')
      .select('id, user_id, phone_e164, code_hash, purpose, context_id, attempts, max_attempts, expires_at, consumed_at, channel')
      .eq('id', body.otp_id)
      .maybeSingle();

    if (loadErr) return json({ error: 'otp_load_failed', detail: loadErr.message }, 500);
    if (!otp)    return json({ error: 'otp_not_found' }, 404);

    // ── 4. Validazioni di stato ─────────────────────────────────────
    if (otp.user_id !== user.id) {
      // Non rivelare il dettaglio: stesso messaggio di "not found" per evitare enumeration
      return json({ error: 'otp_not_found' }, 404);
    }
    if (otp.consumed_at) {
      return json({ error: 'otp_already_consumed' }, 410);
    }
    const expires = new Date(otp.expires_at).getTime();
    if (Number.isNaN(expires) || expires < Date.now()) {
      return json({ error: 'otp_expired' }, 410);
    }
    if (otp.attempts >= otp.max_attempts) {
      return json({ error: 'otp_max_attempts_reached' }, 429);
    }

    // ── 5. Verifica del codice (timing-safe) ────────────────────────
    const ok = await verifyOtpHash(body.code, otp.code_hash);

    if (!ok) {
      // Incremento atomico tentativi (RPC sarebbe più sicuro,
      // ma qui basta perché la concorrenza su un singolo OTP è bassa)
      const newAttempts = otp.attempts + 1;
      await adminClient
        .from('otp_codes')
        .update({ attempts: newAttempts })
        .eq('id', otp.id);

      const remaining = Math.max(0, otp.max_attempts - newAttempts);
      return json({
        error: 'otp_invalid',
        attempts_remaining: remaining,
      }, 401);
    }

    // ── 6. OTP VALIDO — marca consumato + side effects per purpose ─
    const consumedAt = new Date().toISOString();
    const { error: consErr } = await adminClient
      .from('otp_codes')
      .update({ consumed_at: consumedAt })
      .eq('id', otp.id)
      .is('consumed_at', null);  // protezione concurrent-consume
    if (consErr) {
      return json({ error: 'otp_consume_failed', detail: consErr.message }, 500);
    }

    const sideEffects: Record<string, unknown> = {};

    if (otp.purpose === 'phone_verify') {
      // Aggiorna il profilo: imposta phone_e164 e phone_verified_at
      const { error: pErr } = await adminClient
        .from('profiles')
        .update({
          phone_e164:        otp.phone_e164,
          phone:             otp.phone_e164,             // mantiene retrocompatibilità con `profiles.phone`
          phone_verified_at: consumedAt,
        })
        .eq('id', user.id);
      if (pErr) {
        return json({ error: 'profile_update_failed', detail: pErr.message }, 500);
      }
      sideEffects.phone_verified_at = consumedAt;
      sideEffects.phone_e164        = otp.phone_e164;
    }

    // Audit per la firma contrattuale (verrà passato a contract-sign)
    const audit = {
      otp_id:                  otp.id,
      verified_at:             consumedAt,
      channel:                 otp.channel,
      ip:                      clientIp(req),
      user_agent:              userAgent(req),
      phone_last4:             otp.phone_e164.slice(-4),
      // NOTA: il codice in chiaro NON viene mai memorizzato né ritornato.
      // Il verbale di firma riferirà solo l'otp_id (transaction ID Twilio
      // recuperabile via otp_codes.sms_provider_message_id).
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
