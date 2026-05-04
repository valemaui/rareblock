// Supabase Edge Functions: shared Twilio helpers
// =============================================================================
// Client Twilio Programmable Messaging via API REST (fetch nativo, no SDK).
// Strategia dual channel:
//   - se TWILIO_WHATSAPP_FROM è configurato → tenta WhatsApp prima
//   - se WhatsApp fallisce o non è configurato → SMS via MessagingService o numero
//
// Secrets richiesti su Supabase Edge Functions:
//   TWILIO_ACCOUNT_SID            (AC...)        obbligatorio
//   TWILIO_AUTH_TOKEN             (...)          obbligatorio
//   TWILIO_MESSAGING_SERVICE_SID  (MG...)        consigliato per SMS
//   TWILIO_SMS_FROM               (+...)         alternativa a Messaging Service
//   TWILIO_WHATSAPP_FROM          (whatsapp:+...) opzionale, attiva canale WA
//   TWILIO_WA_TEMPLATE_OTP        (HX... or string with {{1}}) opzionale
// =============================================================================

const TWILIO_API = 'https://api.twilio.com/2010-04-01';

export type Channel = 'whatsapp' | 'sms';

export interface SendResult {
  channel: Channel;
  message_sid: string;        // SID Twilio per audit
  status: string;             // 'queued' | 'sent' | 'failed' | ...
}

export interface SendError {
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

function basicAuth(sid: string, token: string): string {
  return 'Basic ' + btoa(`${sid}:${token}`);
}

async function callTwilio(params: URLSearchParams): Promise<{ ok: boolean; status: number; body: any }> {
  const { sid, token } = getCreds();
  const r = await fetch(`${TWILIO_API}/Accounts/${sid}/Messages.json`, {
    method:  'POST',
    headers: {
      'Authorization': basicAuth(sid, token),
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  let body: any;
  try { body = await r.json(); } catch { body = { _raw: await r.text() }; }
  return { ok: r.ok, status: r.status, body };
}

// ─────────────────────────────────────────────────────────────────────────────
//  WhatsApp Business
// ─────────────────────────────────────────────────────────────────────────────
async function sendWhatsApp(toE164: string, code: string, contractRef?: string): Promise<SendResult> {
  const from        = Deno.env.get('TWILIO_WHATSAPP_FROM');
  const templateSid = Deno.env.get('TWILIO_WA_TEMPLATE_OTP_SID');     // formato HX...
  const templateTxt = Deno.env.get('TWILIO_WA_TEMPLATE_OTP_BODY');    // fallback con {{1}} {{2}}
  if (!from) throw new Error('whatsapp_not_configured');

  const params = new URLSearchParams();
  params.set('From', from);
  params.set('To',   `whatsapp:${toE164}`);

  if (templateSid) {
    // Content API con template approvato Meta (preferito per AUTHENTICATION category)
    params.set('ContentSid', templateSid);
    const variables: Record<string, string> = { '1': code };
    if (contractRef) variables['2'] = contractRef;
    params.set('ContentVariables', JSON.stringify(variables));
  } else if (templateTxt) {
    // Fallback con messaggio testuale (fuori finestra session, può fallire)
    let body = templateTxt.replaceAll('{{1}}', code);
    if (contractRef) body = body.replaceAll('{{2}}', contractRef);
    params.set('Body', body);
  } else {
    // Default minimale (solo per test, in produzione usare template approvato)
    params.set(
      'Body',
      `RareBlock — Codice di firma: ${code}\nValido 5 minuti. Non condividere con nessuno.`,
    );
  }

  const r = await callTwilio(params);
  if (!r.ok) {
    const e: SendError = {
      attempted:      'whatsapp',
      status_code:    r.status,
      twilio_code:    r.body?.code,
      twilio_message: r.body?.message,
    };
    throw e;
  }
  return { channel: 'whatsapp', message_sid: r.body.sid, status: r.body.status };
}

// ─────────────────────────────────────────────────────────────────────────────
//  SMS
// ─────────────────────────────────────────────────────────────────────────────
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

  // Body conciso per stare in 1 segmento SMS (160 char GSM-7)
  params.set(
    'Body',
    `RareBlock: codice ${code}. Valido 5 minuti. Non condividere.`,
  );

  const r = await callTwilio(params);
  if (!r.ok) {
    const e: SendError = {
      attempted:      'sms',
      status_code:    r.status,
      twilio_code:    r.body?.code,
      twilio_message: r.body?.message,
    };
    throw e;
  }
  return { channel: 'sms', message_sid: r.body.sid, status: r.body.status };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Strategia dual channel: WhatsApp primario, SMS fallback
// ─────────────────────────────────────────────────────────────────────────────
export interface SendOtpOptions {
  toE164:       string;
  code:         string;
  contractRef?: string;             // numero contratto da mostrare nel template (firma)
  channelHint?: 'auto' | 'whatsapp' | 'sms';
}

export async function sendOtpMessage(opts: SendOtpOptions): Promise<{
  result: SendResult;
  errors: SendError[];
}> {
  const errors: SendError[] = [];
  const hasWa = !!Deno.env.get('TWILIO_WHATSAPP_FROM');
  const want  = opts.channelHint ?? 'auto';

  // Caso 1: hint esplicito
  if (want === 'sms') {
    const res = await sendSms(opts.toE164, opts.code);
    return { result: res, errors };
  }
  if (want === 'whatsapp') {
    if (!hasWa) throw new Error('whatsapp_not_configured');
    const res = await sendWhatsApp(opts.toE164, opts.code, opts.contractRef);
    return { result: res, errors };
  }

  // Caso 2: auto — prova WhatsApp se disponibile, fallback SMS
  if (hasWa) {
    try {
      const res = await sendWhatsApp(opts.toE164, opts.code, opts.contractRef);
      return { result: res, errors };
    } catch (e) {
      const err = e as SendError;
      errors.push(err);
      // Continua con SMS
    }
  }
  const res = await sendSms(opts.toE164, opts.code);
  return { result: res, errors };
}
