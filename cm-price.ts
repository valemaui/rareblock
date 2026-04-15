// Supabase Edge Function: cm-price v2
// Deploy: supabase functions deploy cm-price
// Nessun secret necessario — non usa chiavi esterne

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const body = await req.json();
    const url: string = body?.url ?? '';
    if (!url || !url.includes('cardmarket.com')) {
      return json({ error: 'url non valido', prices: [] });
    }

    // Fetch pagina CM con headers browser
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en;q=0.7',
        'Cache-Control': 'no-cache',
      },
    });

    if(!resp.ok) {
      return json({ error: `CM HTTP ${resp.status}${resp.status===403?' — Cardmarket blocca le richieste automatiche (Cloudflare WAF). Usa il link diretto ↗ nella tabella.':''}`, prices: [] });
    }

    const html = await resp.text();

    // Cloudflare challenge?
    if (html.length < 2000 || html.includes('cf-browser-verification')) {
      return json({ error: 'Cloudflare challenge', prices: [], debug_snippet: html.substring(0, 300) });
    }

    const prices = extractPrices(html);

    return json({ prices, url, source: 'cardmarket' });

  } catch (e: any) {
    return json({ error: String(e?.message ?? e), prices: [] });
  }
});

function extractPrices(html: string): number[] {
  const found = new Set<number>();

  // 1. __NEXT_DATA__ — contiene tutti gli articoli con prezzi
  const nd = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nd) {
    try {
      const obj = JSON.parse(nd[1]);
      walk(obj, found, 0);
    } catch { /* ignore */ }
  }

  // 2. JSON-LD structured data
  const jld = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = jld.exec(html)) !== null) {
    try {
      const o = JSON.parse(m[1]);
      const lp = o?.offers?.lowPrice ?? o?.offers?.price;
      if (lp) { const n = parsePrice(String(lp)); if (n) found.add(n); }
    } catch { /* ignore */ }
  }

  // 3. Pattern "€ 26,00" nell'HTML
  const re = /(?:€\s*|"price"\s*:\s*"?)(\d{1,4}(?:[.,]\d{3})*[,\.]\d{2})(?:"|\b)/g;
  let r: RegExpExecArray | null;
  while ((r = re.exec(html)) !== null) {
    const n = parsePrice(r[1]);
    if (n && n > 0.05 && n < 50000) found.add(n);
  }

  return Array.from(found).filter(p => p >= 0.1 && p <= 9999).sort((a, b) => a - b);
}

function parsePrice(s: string): number | null {
  const c = s.trim().replace(/\s/g, '').replace(/[€$]/g, '');
  if (!c) return null;
  // 1.234,56 → 1234.56
  if (/^\d{1,3}(\.\d{3})*(,\d{1,2})$/.test(c)) return parseFloat(c.replace(/\./g, '').replace(',', '.'));
  // 26,50 → 26.50
  if (/^\d+,\d{1,2}$/.test(c)) return parseFloat(c.replace(',', '.'));
  const n = parseFloat(c);
  return isNaN(n) ? null : n;
}

function walk(o: unknown, s: Set<number>, d: number): void {
  if (d > 8 || !o || typeof o !== 'object') return;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (['price','priceGross','sellPrice','lowPrice','trendPrice'].includes(k)) {
      const n = typeof v === 'number' ? v : parsePrice(String(v ?? ''));
      if (n && n > 0.1 && n < 9999) s.add(Math.round(n * 100) / 100);
    }
    if (typeof v === 'object') walk(v, s, d + 1);
  }
}
