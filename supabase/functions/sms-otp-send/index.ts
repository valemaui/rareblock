// =============================================================================
// Supabase Edge Function: sms-otp-send
// =============================================================================
// SELF-CONTAINED: gli helper condivisi sono inlined in cima al file.
//
// Motivazione: il deploy via Dashboard Supabase UI bundla solo `index.ts` e
// non risolve gli import da `../_shared/*.ts`. La CLI Supabase invece include
// la cartella `_shared/` automaticamente.
//
// Fonte canonica degli helper inlined:
//   supabase/functions/_shared/http.ts
//   supabase/functions/_shared/otp.ts
//   supabase/functions/_shared/twilio.ts
// Se modifichi un helper, aggiorna ENTRAMBI i posti.
//
// Genera un OTP a 6 cifre, lo invia via Twilio (WhatsApp con fallback SMS)
// e ne salva l'hash sha256+salt nella tabella otp_codes.
//
// Body atteso:
//   {
//     "purpose":     "phone_verify" | "contract_sign" | "critical_action",
//     "phone_e164":  "+393331234567",   // obbligatorio per phone_verify
//     "context_id":  "<uuid>",          // opzionale
//     "channel_hint":"auto"|"whatsapp"|"sms"  // default auto
//   }
// Risposta:
//   { otp_id, expires_at, channel, masked_phone, ttl_seconds, attempts_max }
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

function generateOtpCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1_000_000).padStart(6, '0');
}

function generateSalt(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf  = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(buf));
}

async function hashOtpForStorage(code: string): Promise<string> {
  const salt = generateSalt();
  const h    = await sha256Hex(`${salt}:${code}`);
  return `${salt}:${h}`;
}

function maskPhone(e164: string): string {
  if (!e164 || e164.length < 4) return '***';
  return '*** ' + e164.slice(-4);
}

function normalizePhoneE164(input: string, defaultCC = '+39'): string | null {
  if (!input) return null;
  let s = input.trim().replace(/[\s.\-()]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (!s.startsWith('+')) {
    if (/^\d{9,11}$/.test(s)) s = defaultCC + s;
    else                      return null;
  }
  if (!/^\+\d{8,15}$/.test(s)) return null;
  return s;
}


// ═════════════════════════════════════════════════════════════════════════════
// ─── inlined from _shared/twilio.ts ──────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════
const TWILIO_API = 'https://api.twilio.com/2010-04-01';

type Channel = 'whatsapp' | 'sms';

interface SendResult {
  channel: Channel;
  message_sid: string;
  status: string;
}

interface SendError {
  attempted: Channel;
  status_code: number;
  twilio_code?: number;
  twilio_message?: string;
}

function getCreds() {
  const sid   = Deno.env.get('TWILIO_ACCOUNT_SID');
  const token = Deno.env.get('TWILIO_AUTH_TOKEN');
  if (!sid || !token) {
    throw new Error('Twilio credentials missing: set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN as Edge Function secrets');
  }
  return { sid, token };
}

async function callTwilio(params: URLSearchParams): Promise<{ ok: boolean; status: number; body: any }> {
  const { sid, token } = getCreds();
  const r = await fetch(`${TWILIO_API}/Accounts/${sid}/Messages.json`, {
    method:  'POST',
    headers: {
      'Authorization': 'Basic ' + btoa(`${sid}:${token}`),
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  let body: any;
  try { body = await r.json(); } catch { body = { _raw: await r.text() }; }
  return { ok: r.ok, status: r.status, body };
}

async function sendWhatsApp(toE164: string, code: string, contractRef?: string): Promise<SendResult> {
  const from        = Deno.env.get('TWILIO_WHATSAPP_FROM');
  const templateSid = Deno.env.get('TWILIO_WA_TEMPLATE_OTP_SID');
  const templateTxt = Deno.env.get('TWILIO_WA_TEMPLATE_OTP_BODY');
  if (!from) throw new Error('whatsapp_not_configured');

  const params = new URLSearchParams();
  params.set('From', from);
  params.set('To',   `whatsapp:${toE164}`);

  if (templateSid) {
    params.set('ContentSid', templateSid);
    const variables: Record<string, string> = { '1': code };
    if (contractRef) variables['2'] = contractRef;
    params.set('ContentVariables', JSON.stringify(variables));
  } else if (templateTxt) {
    let body = templateTxt.replaceAll('{{1}}', code);
    if (contractRef) body = body.replaceAll('{{2}}', contractRef);
    params.set('Body', body);
  } else {
    params.set('Body', `RareBlock — Codice di firma: ${code}\nValido 5 minuti. Non condividere con nessuno.`);
  }

  const r = await callTwilio(params);
  if (!r.ok) {
    const e: SendError = {
      attempted: 'whatsapp', status_code: r.status,
      twilio_code: r.body?.code, twilio_message: r.body?.message,
    };
    throw e;
  }
  return { channel: 'whatsapp', message_sid: r.body.sid, status: r.body.status };
}

async function sendSms(toE164: string, code: string): Promise<SendResult> {
  const messagingService = Deno.env.get('TWILIO_MESSAGING_SERVICE_SID');
  const fromNumber       = Deno.env.get('TWILIO_SMS_FROM');
  if (!messagingService && !fromNumber) {
    throw new Error('sms_not_configured: set TWILIO_MESSAGING_SERVICE_SID or TWILIO_SMS_FROM');
  }
  const params = new URLSearchParams();
  params.set('To', toE164);
  if (messagingService) params.set('MessagingServiceSid', messagingService);
  else                  params.set('From', fromNumber!);
  params.set('Body', `RareBlock: codice ${code}. Valido 5 minuti. Non condividere.`);

  const r = await callTwilio(params);
  if (!r.ok) {
    const e: SendError = {
      attempted: 'sms', status_code: r.status,
      twilio_code: r.body?.code, twilio_message: r.body?.message,
    };
    throw e;
  }
  return { channel: 'sms', message_sid: r.body.sid, status: r.body.status };
}

interface SendOtpOptions {
  toE164:       string;
  code:         string;
  contractRef?: string;
  channelHint?: 'auto' | 'whatsapp' | 'sms';
}

async function sendOtpMessage(opts: SendOtpOptions): Promise<{ result: SendResult; errors: SendError[] }> {
  const errors: SendError[] = [];
  const hasWa = !!Deno.env.get('TWILIO_WHATSAPP_FROM');
  const want  = opts.channelHint ?? 'auto';

  if (want === 'sms') {
    return { result: await sendSms(opts.toE164, opts.code), errors };
  }
  if (want === 'whatsapp') {
    if (!hasWa) throw new Error('whatsapp_not_configured');
    return { result: await sendWhatsApp(opts.toE164, opts.code, opts.contractRef), errors };
  }
  if (hasWa) {
    try {
      return { result: await sendWhatsApp(opts.toE164, opts.code, opts.contractRef), errors };
    } catch (e) { errors.push(e as SendError); /* fallback SMS */ }
  }
  return { result: await sendSms(opts.toE164, opts.code), errors };
}


// ═════════════════════════════════════════════════════════════════════════════
// ─── MAIN HANDLER ────────────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════
const OTP_TTL_SECONDS    = 5 * 60;
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
    const body = (await req.json().catch(() => null)) as SendInput | null;
    if (!body || !body.purpose) return json({ error: 'missing_body_or_purpose' }, 400);
    if (!['phone_verify', 'contract_sign', 'critical_action'].includes(body.purpose)) {
      return json({ error: 'invalid_purpose' }, 400);
    }

    // 3. Service-role client per scritture privilegiate
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // 4. Risolvi numero di telefono
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

    // 5. Rate-limit
    const { data: rl, error: rlErr } = await adminClient.rpc('otp_count_recent', {
      p_user_id: user.id, p_phone: toE164, p_window: '1 hour',
    });
    if (rlErr) return json({ error: 'rate_limit_check_failed', detail: rlErr.message }, 500);
    const userHourCount = Array.isArray(rl) ? rl[0]?.by_user ?? 0 : (rl as any)?.by_user ?? 0;
    if (userHourCount >= RL_PER_USER_HOUR) {
      return json({ error: 'rate_limit_user_hour', retry_after_seconds: 3600 }, 429);
    }
    const { data: rl2 } = await adminClient.rpc('otp_count_recent', {
      p_user_id: user.id, p_phone: toE164, p_window: '1 day',
    });
    const phoneDayCount = Array.isArray(rl2) ? rl2[0]?.by_phone ?? 0 : (rl2 as any)?.by_phone ?? 0;
    if (phoneDayCount >= RL_PER_PHONE_DAY) {
      return json({ error: 'rate_limit_phone_day', retry_after_seconds: 86400 }, 429);
    }

    // 6. Genera codice + hash
    const code      = generateOtpCode();
    const code_hash = await hashOtpForStorage(code);
    const now       = new Date();
    const expiresAt = new Date(now.getTime() + OTP_TTL_SECONDS * 1000);

    // 7. Insert record OTP prima dell'invio (audit)
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
    if (insErr || !otpRow) return json({ error: 'otp_insert_failed', detail: insErr?.message }, 500);

    // 8. Carica numero contratto se context_id è un contract_id
    let contractRef: string | undefined;
    if (body.purpose === 'contract_sign' && body.context_id) {
      try {
        const { data: c } = await adminClient
          .from('contracts')
          .select('contract_number')
          .eq('id', body.context_id)
          .maybeSingle();
        if (c?.contract_number) contractRef = c.contract_number;
      } catch { /* tabella contracts non ancora esistente: ignora */ }
    }

    // 9. Invia il messaggio via Twilio
    let sendOutcome;
    try {
      sendOutcome = await sendOtpMessage({
        toE164, code, contractRef,
        channelHint: body.channel_hint ?? 'auto',
      });
    } catch (e: any) {
      // Marca scaduto subito per non bruciare tentativi
      await adminClient.from('otp_codes')
        .update({ expires_at: now.toISOString() })
        .eq('id', otpRow.id);
      return json({
        error: 'send_failed',
        twilio_status: e?.status_code,
        twilio_code:   e?.twilio_code,
        twilio_msg:    e?.twilio_message,
      }, 502);
    }

    // 10. Aggiorna record con esito invio
    await adminClient.from('otp_codes')
      .update({
        channel:                 sendOutcome.result.channel,
        sms_provider_message_id: sendOutcome.result.message_sid,
      })
      .eq('id', otpRow.id);

    // 11. Risposta al client
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
