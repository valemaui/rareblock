// Supabase Edge Functions: shared HTTP helpers
// =============================================================================
// CORS + JSON response unificati per tutte le edge function RareBlock.
// =============================================================================

export const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, apikey, Prefer, Range, stripe-signature, x-supabase-api-version',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Max-Age':       '86400',
};

export function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json; charset=utf-8',
      ...extra,
    },
  });
}

export function preflight(req: Request): Response | null {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  return null;
}

export function clientIp(req: Request): string | null {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      ?? req.headers.get('cf-connecting-ip')
      ?? req.headers.get('x-real-ip')
      ?? null;
}

export function userAgent(req: Request): string | null {
  return req.headers.get('user-agent');
}
