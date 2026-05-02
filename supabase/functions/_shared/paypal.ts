// Supabase Edge Functions: shared PayPal helpers
// =============================================================================
// Modulo condiviso usato da paypal-create-order, paypal-capture-order, paypal-webhook.
// Gestisce env switch (sandbox/live), OAuth token cache, helper API call.
// =============================================================================

const PAYPAL_API_SANDBOX = 'https://api-m.sandbox.paypal.com';
const PAYPAL_API_LIVE    = 'https://api-m.paypal.com';

export type PayPalEnv = 'sandbox' | 'live';

export function getPayPalEnv(): PayPalEnv {
  const env = (Deno.env.get('PAYPAL_ENV') || 'sandbox').toLowerCase();
  return env === 'live' ? 'live' : 'sandbox';
}

export function getPayPalApiBase(): string {
  return getPayPalEnv() === 'live' ? PAYPAL_API_LIVE : PAYPAL_API_SANDBOX;
}

export function getPayPalCredentials() {
  const env = getPayPalEnv();
  const prefix = env === 'live' ? 'PAYPAL_LIVE' : 'PAYPAL_SANDBOX';
  const clientId     = Deno.env.get(`${prefix}_CLIENT_ID`);
  const clientSecret = Deno.env.get(`${prefix}_CLIENT_SECRET`);
  const webhookId    = Deno.env.get(`${prefix}_WEBHOOK_ID`);
  if (!clientId || !clientSecret) {
    throw new Error(`Credenziali PayPal mancanti per env=${env}. Imposta ${prefix}_CLIENT_ID e ${prefix}_CLIENT_SECRET.`);
  }
  return { env, clientId, clientSecret, webhookId };
}

// In-memory token cache. Edge Function instances vengono ricicolate
// frequentemente, ma se sopravvivono il token resta valido fino a expires_at.
let cachedToken: { value: string; expiresAt: number } | null = null;

export async function getPayPalAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.value;
  }
  const { clientId, clientSecret } = getPayPalCredentials();
  const auth = btoa(`${clientId}:${clientSecret}`);
  const r = await fetch(`${getPayPalApiBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`PayPal OAuth fallito (${r.status}): ${err}`);
  }
  const data = await r.json();
  if (!data.access_token) throw new Error('PayPal OAuth: access_token mancante');
  cachedToken = {
    value: data.access_token,
    expiresAt: now + (data.expires_in || 3600) * 1000,
  };
  return cachedToken.value;
}

export async function paypalApi(
  path: string,
  init: RequestInit = {},
  options: { idempotencyKey?: string } = {},
): Promise<Response> {
  const token = await getPayPalAccessToken();
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (options.idempotencyKey) headers.set('PayPal-Request-Id', options.idempotencyKey);
  return fetch(`${getPayPalApiBase()}${path}`, { ...init, headers });
}

// =============================================================================
// Calcolo fee PayPal mostrata all'utente al checkout
// =============================================================================
// Tariffa standard Italia per "Commercio nazionale": 2,49% + €0,35
// Override possibile via env vars se si negozia tariffa diversa.
// =============================================================================
export interface PayPalFeeConfig {
  percent: number;   // es. 2.49
  fixed:   number;   // es. 0.35
}

export function getPayPalFeeConfig(): PayPalFeeConfig {
  const pct = parseFloat(Deno.env.get('PAYPAL_FEE_PCT')   || '2.49');
  const fix = parseFloat(Deno.env.get('PAYPAL_FEE_FIXED') || '0.35');
  return { percent: pct, fixed: fix };
}

/**
 * Calcola fee da addebitare all'utente per coprire la commissione PayPal,
 * tenendo conto che PayPal stessa la trattiene SUL TOTALE (inclusa la fee).
 *
 * Algebra:
 *   netto_voluto = (subtotale + fee) - fee_paypal_su_totale
 *   fee_paypal_su_totale = (subtotale + fee) × pct/100 + fixed
 *
 * Risolvendo per fee:
 *   fee ≈ (subtotale × pct/100 + fixed) / (1 - pct/100)
 *
 * Così, anche dopo che PayPal trattiene la commissione, RareBlock incassa
 * esattamente il subtotale puro.
 */
export function calcUserFacingFee(subtotal: number, cfg = getPayPalFeeConfig()): number {
  const p = cfg.percent / 100;
  const fee = (subtotal * p + cfg.fixed) / (1 - p);
  return Math.round(fee * 100) / 100;
}

// =============================================================================
// CORS helper
// =============================================================================
export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
