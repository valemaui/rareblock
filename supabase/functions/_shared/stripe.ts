// Supabase Edge Functions: shared Stripe helpers
// =============================================================================
// Wrapper minimale Stripe API per le funzioni RareBlock:
//   - stripeApi(path, method, body, idempotencyKey?) → fetch Stripe REST
//   - verifyStripeSignature(payload, header, secret) → HMAC SHA-256 di
//     timestamp.payload, confronto con v1 dell'header (Stripe-Signature)
//   - centsFromEur(eur) / eurFromCents(cents) helper conversioni
//
// CONVENZIONI:
// - Stripe REST API usa form-encoded (NON JSON) per i body
// - Currency forzata 'eur' nel chiamante (decisione operativa RareBlock)
// - Idempotency key: usata su /v1/checkout/sessions per evitare doppia
//   creazione se il client retry-a la chiamata
// =============================================================================

const STRIPE_API_BASE = 'https://api.stripe.com';
const STRIPE_API_VERSION = '2024-06-20';  // pin esplicito per stabilità

/** Converte EUR (numero) in cents (intero) per Stripe */
export function centsFromEur(eur: number): number {
  return Math.round(eur * 100);
}

/** Converte cents (intero) in EUR (numero, 2 decimali) */
export function eurFromCents(cents: number): number {
  return Math.round(cents) / 100;
}

/**
 * Costruisce form-encoded body da un oggetto annidato.
 * Stripe accetta nested params come `line_items[0][price_data][unit_amount]`.
 */
export function toFormBody(obj: Record<string, unknown>, prefix = ''): string {
  const parts: string[] = [];
  for (const [key, val] of Object.entries(obj)) {
    if (val === undefined || val === null) continue;
    const k = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(val)) {
      val.forEach((v, i) => {
        if (typeof v === 'object' && v !== null) {
          parts.push(toFormBody(v as Record<string, unknown>, `${k}[${i}]`));
        } else {
          parts.push(`${encodeURIComponent(`${k}[${i}]`)}=${encodeURIComponent(String(v))}`);
        }
      });
    } else if (typeof val === 'object') {
      parts.push(toFormBody(val as Record<string, unknown>, k));
    } else {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(val))}`);
    }
  }
  return parts.filter(Boolean).join('&');
}

/**
 * Chiamata Stripe API. Auth via Bearer secret_key.
 * Returns parsed JSON. Throws on non-2xx con messaggio Stripe.
 */
export async function stripeApi(
  path: string,
  method: 'GET' | 'POST' | 'DELETE',
  body?: Record<string, unknown>,
  opts: { idempotencyKey?: string } = {},
): Promise<any> {
  const secretKey = Deno.env.get('STRIPE_SECRET_KEY');
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY non configurata');

  const headers: Record<string, string> = {
    'Authorization':       `Bearer ${secretKey}`,
    'Stripe-Version':      STRIPE_API_VERSION,
  };
  if (body && method !== 'GET') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  if (opts.idempotencyKey) {
    headers['Idempotency-Key'] = opts.idempotencyKey;
  }

  const resp = await fetch(`${STRIPE_API_BASE}${path}`, {
    method,
    headers,
    body: body && method !== 'GET' ? toFormBody(body) : undefined,
  });

  const text = await resp.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { /* fallback below */ }

  if (!resp.ok) {
    const msg = parsed?.error?.message || text || `Stripe ${resp.status}`;
    const err: Error & { stripeStatus?: number; stripeCode?: string } = new Error(msg);
    err.stripeStatus = resp.status;
    err.stripeCode = parsed?.error?.code;
    throw err;
  }
  return parsed;
}

/**
 * Verifica firma webhook Stripe.
 * Header `Stripe-Signature` ha formato: t=1234567890,v1=hex...,v0=hex...
 * Calcoliamo HMAC SHA-256 di `${t}.${payload}` con webhookSecret.
 * Confrontiamo con v1 (constant-time).
 *
 * Returns: { valid: boolean, timestamp: number | null, error?: string }
 *
 * Tolerance: 5 minuti (default Stripe). Eventi più vecchi rifiutati.
 */
export async function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
  toleranceSeconds = 300,
): Promise<{ valid: boolean; timestamp: number | null; error?: string }> {
  if (!header) return { valid: false, timestamp: null, error: 'header missing' };
  if (!secret) return { valid: false, timestamp: null, error: 'secret missing' };

  // Parse header: 't=...,v1=...,v0=...'
  const parts = header.split(',').map(p => p.trim().split('='));
  let timestamp: number | null = null;
  const v1Sigs: string[] = [];
  for (const [k, v] of parts) {
    if (k === 't' && v) timestamp = parseInt(v, 10);
    else if (k === 'v1' && v) v1Sigs.push(v);
  }
  if (!timestamp || v1Sigs.length === 0) {
    return { valid: false, timestamp, error: 'malformed header' };
  }

  // Tolerance check
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    return { valid: false, timestamp, error: 'timestamp too old' };
  }

  // Compute expected signature: HMAC-SHA256( t.payload, secret )
  const signedPayload = `${timestamp}.${payload}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(signedPayload));
  const expectedHex = Array.from(new Uint8Array(sigBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Constant-time compare against any v1 signature
  for (const v1 of v1Sigs) {
    if (constantTimeEqual(v1, expectedHex)) {
      return { valid: true, timestamp };
    }
  }
  return { valid: false, timestamp, error: 'signature mismatch' };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
