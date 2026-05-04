// Supabase Edge Function: sms-otp-send
// =============================================================================
// Genera un OTP a 6 cifre, lo invia via Twilio (WhatsApp con fallback SMS)
// e ne salva l'hash sha256+salt nella tabella otp_codes.
//
// Rate-limit applicati:
//   • 5 OTP/ora per utente
//   • 10 OTP/giorno per numero di telefono
//   (il limit per IP è demandato a layer Edge Function Supabase)
//
// Body atteso:
//   {
//     "purpose":     "phone_verify" | "contract_sign" | "critical_action",
//     "phone_e164":  "+393331234567",   // opzionale per phone_verify, obbligatorio se diverso da profilo
//     "context_id":  "<uuid>",          // opzionale, p.es. contract_id per firma
//     "channel_hint":"auto"|"whatsapp"|"sms"  // opzionale, default auto
//   }
//
// Risposta:
//   { otp_id, expires_at, channel, masked_phone, ttl_seconds, attempts_max }
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CORS, json, preflight, clientIp, userAgent } from '../_shared/http.ts';
import {
  generateOtpCode,
  hashOtpForStorage,
  maskPhone,
  normalizePhoneE164,
} from '../_shared/otp.ts';
import { sendOtpMessage } from '../_shared/twilio.ts';

const OTP_TTL_SECONDS    = 5 * 60;        // 5 minuti
const OTP_MAX_ATTEMPTS   = 3;
const RL_PER_USER_HOUR   = 5;
const RL_PER_PHONE_DAY   = 10;

interface SendInput {
  purpose:       'phone_verify' | 'contract_sign' | 'critical_action';
  phone_e164?:   string;
  context_id?:   string | null;
  channel_hint?: 'auto' | 'whatsapp' | 'sms';
}

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

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
    const body = (await req.json().catch(() => null)) as SendInput | null;
    if (!body || !body.purpose) {
      return json({ error: 'missing_body_or_purpose' }, 400);
    }
    if (!['phone_verify', 'contract_sign', 'critical_action'].includes(body.purpose)) {
      return json({ error: 'invalid_purpose' }, 400);
    }

    // ── 3. Service-role client per scritture privilegiate ───────────
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // ── 4. Risolvi il numero di telefono da usare ───────────────────
    // Per phone_verify: il numero arriva dal body (utente lo sta verificando per la prima volta)
    // Per contract_sign / critical_action: il numero DEVE essere quello già verificato sul profile
    const { data: profile, error: profErr } = await adminClient
      .from('profiles')
      .select('phone_e164, phone_verified_at')
      .eq('id', user.id)
      .single();
    if (profErr) return json({ error: 'profile_load_failed', detail: profErr.message }, 500);

    let toE164: string;

    if (body.purpose === 'phone_verify') {
      const candidate = body.phone_e164 ?? profile?.phone_e164 ?? null;
      if (!candidate) return json({ error: 'phone_required_for_verify' }, 400);
      const normalized = normalizePhoneE164(candidate);
      if (!normalized) return json({ error: 'invalid_phone_format' }, 400);
      toE164 = normalized;
    } else {
      if (!profile?.phone_verified_at || !profile?.phone_e164) {
        return json({ error: 'phone_not_verified' }, 400);
      }
      toE164 = profile.phone_e164;
    }

    // ── 5. Rate-limit (per utente / per numero) ─────────────────────
    const { data: rl, error: rlErr } = await adminClient.rpc('otp_count_recent', {
      p_user_id: user.id,
      p_phone:   toE164,
      p_window:  '1 hour',
    });
    if (rlErr) return json({ error: 'rate_limit_check_failed', detail: rlErr.message }, 500);
    const userHourCount = Array.isArray(rl) ? rl[0]?.by_user  ?? 0 : (rl as any)?.by_user  ?? 0;
    if (userHourCount >= RL_PER_USER_HOUR) {
      return json({ error: 'rate_limit_user_hour', retry_after_seconds: 3600 }, 429);
    }

    const { data: rl2 } = await adminClient.rpc('otp_count_recent', {
      p_user_id: user.id,
      p_phone:   toE164,
      p_window:  '1 day',
    });
    const phoneDayCount = Array.isArray(rl2) ? rl2[0]?.by_phone ?? 0 : (rl2 as any)?.by_phone ?? 0;
    if (phoneDayCount >= RL_PER_PHONE_DAY) {
      return json({ error: 'rate_limit_phone_day', retry_after_seconds: 86400 }, 429);
    }

    // ── 6. Genera codice + hash ─────────────────────────────────────
    const code      = generateOtpCode();
    const code_hash = await hashOtpForStorage(code);
    const now       = new Date();
    const expiresAt = new Date(now.getTime() + OTP_TTL_SECONDS * 1000);

    // ── 7. Inserisci record OTP (prima dell'invio, per audit garantito) ─
    const { data: otpRow, error: insErr } = await adminClient
      .from('otp_codes')
      .insert({
        user_id:       user.id,
        phone_e164:    toE164,
        code_hash,
        purpose:       body.purpose,
        context_id:    body.context_id ?? null,
        max_attempts:  OTP_MAX_ATTEMPTS,
        expires_at:    expiresAt.toISOString(),
        ip:            clientIp(req),
        user_agent:    userAgent(req),
        sms_provider:  'twilio',
      })
      .select('id')
      .single();
    if (insErr || !otpRow) {
      return json({ error: 'otp_insert_failed', detail: insErr?.message }, 500);
    }

    // ── 8. Carica numero contratto se context_id è un contract_id ───
    let contractRef: string | undefined;
    if (body.purpose === 'contract_sign' && body.context_id) {
      const { data: c } = await adminClient
        .from('contracts')
        .select('contract_number')
        .eq('id', body.context_id)
        .maybeSingle();
      if (c?.contract_number) contractRef = c.contract_number;
    }

    // ── 9. Invia il messaggio via Twilio ────────────────────────────
    let sendOutcome;
    try {
      sendOutcome = await sendOtpMessage({
        toE164,
        code,
        contractRef,
        channelHint: body.channel_hint ?? 'auto',
      });
    } catch (e: any) {
      // Twilio ha rifiutato — marca OTP come scaduto immediatamente
      // così non spreca un tentativo dell'utente
      await adminClient
        .from('otp_codes')
        .update({ expires_at: now.toISOString() })
        .eq('id', otpRow.id);

      return json({
        error: 'send_failed',
        twilio_status: e?.status_code,
        twilio_code:   e?.twilio_code,
        twilio_msg:    e?.twilio_message,
      }, 502);
    }

    // ── 10. Aggiorna il record con esito invio ──────────────────────
    await adminClient
      .from('otp_codes')
      .update({
        channel:                 sendOutcome.result.channel,
        sms_provider_message_id: sendOutcome.result.message_sid,
      })
      .eq('id', otpRow.id);

    // ── 11. Risposta al client ──────────────────────────────────────
    return json({
      otp_id:        otpRow.id,
      expires_at:    expiresAt.toISOString(),
      ttl_seconds:   OTP_TTL_SECONDS,
      channel:       sendOutcome.result.channel,
      masked_phone:  maskPhone(toE164),
      attempts_max:  OTP_MAX_ATTEMPTS,
      fallback_used: sendOutcome.errors.length > 0,
    });

  } catch (e: any) {
    return json({ error: 'unexpected', detail: e?.message ?? String(e) }, 500);
  }
});
