// Supabase Edge Function: cm-price v4
// Scraping CM con anti-CF avanzato + multi-strategia parsing
// Deploy: supabase functions deploy cm-price

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

const COND_ORDER: Record<string,number> = {
  'Mint':1,'Near Mint':2,'Excellent':3,'Good':4,'Light Played':5,'Played':6,'Poor':7,
  'MT':1,'NM':2,'EX':3,'GD':4,'LP':5,'PL':6,'PO':7,
};

interface Listing { price: number; condition: string; condRank: number; seller?: string; }

// Pool di User-Agent reali aggiornati
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
];

function getRandomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function buildHeaders(url: string, lang = 'it'): Record<string,string> {
  const ua = getRandomUA();
  const origin = 'https://www.cardmarket.com';
  const isIt = lang === 'it';
  return {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': isIt ? 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7' : 'de-DE,de;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'max-age=0',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Sec-CH-UA': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"Windows"',
    'DNT': '1',
    'Referer': origin + '/it/Pokemon',
  };
}

async function fetchWithRetry(url: string, maxRetries = 2): Promise<{ html: string; ok: boolean; status: number }> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Leggero jitter tra tentativi
    if (attempt > 0) await new Promise(r => setTimeout(r, 800 + Math.random() * 400));

    // Alterna lingua IT/DE per evitare pattern detection
    const lang = attempt % 2 === 0 ? 'it' : 'de';
    const langUrl = attempt > 0 ? url.replace('/it/Pokemon', `/${lang}/Pokemon`) : url;

    try {
      const resp = await fetch(langUrl, { headers: buildHeaders(langUrl, lang) });
      const html = await resp.text();

      // CF challenge: prova prossimo tentativo
      if (html.length < 2000 || html.includes('Just a moment') || html.includes('cf-browser-verification')) {
        if (attempt === maxRetries) return { html, ok: false, status: 403 };
        continue;
      }

      return { html, ok: resp.ok, status: resp.status };
    } catch (e) {
      if (attempt === maxRetries) return { html: '', ok: false, status: 0 };
    }
  }
  return { html: '', ok: false, status: 0 };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const body = await req.json();
    const url: string = body?.url ?? '';
    if (!url || !url.includes('cardmarket.com')) {
      return json({ error: 'url non valido', listings: [], prices: [] });
    }

    const { html, ok, status } = await fetchWithRetry(url);

    if (!ok || !html) {
      return json({
        error: `CM HTTP ${status}${status === 403 ? ' — Cloudflare WAF (normale, riprova)' : ''}`,
        listings: [], prices: [], status
      });
    }

    if (html.includes('Just a moment') || html.includes('cf-browser-verification')) {
      return json({ error: 'Cloudflare challenge attivo', listings: [], prices: [], status: 403 });
    }

    const listings = extractListings(html);
    const prices = listings.map(l => l.price);

    return json({ listings, prices, url, source: 'cardmarket', count: listings.length });

  } catch (e: any) {
    return json({ error: String(e?.message ?? e), listings: [], prices: [] });
  }
});

function extractListings(html: string): Listing[] {
  // ── Strategia 1: __NEXT_DATA__ JSON ──────────────────────────────────────
  const nd = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nd) {
    try {
      const obj = JSON.parse(nd[1]);
      const extracted = extractFromNextData(obj);
      if (extracted.length > 0) return extracted;
    } catch { /* continua */ }
  }

  // ── Strategia 2: window.__NEXT_DATA__ inline ──────────────────────────────
  const wnd = html.match(/window\.__NEXT_DATA__\s*=\s*(\{[\s\S]*?\});?\s*(?:<\/script>|window\.)/);
  if (wnd) {
    try {
      const obj = JSON.parse(wnd[1]);
      const extracted = extractFromNextData(obj);
      if (extracted.length > 0) return extracted;
    } catch { /* continua */ }
  }

  // ── Strategia 3: pattern article-row HTML ────────────────────────────────
  const listings: Listing[] = [];
  const rowPattern = /<div[^>]*class="[^"]*article-row[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*article-row|<\/table|<\/article)/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowPattern.exec(html)) !== null) {
    const row = rowMatch[1];
    const cond = extractConditionFromRow(row);
    const price = extractPriceFromRow(row);
    if (cond && price) {
      listings.push({ price, condition: cond, condRank: COND_ORDER[cond] || 5 });
    }
  }
  if (listings.length > 0) return listings.slice(0, 20).sort((a,b) => a.price - b.price);

  // ── Strategia 4: JSON price pattern ─────────────────────────────────────
  const pricePattern = /"price"\s*:\s*"?(\d{1,4}[,.]?\d{0,3}[,.]\d{2})"?/g;
  let m: RegExpExecArray | null;
  const seen = new Set<number>();
  while ((m = pricePattern.exec(html)) !== null) {
    const n = parsePrice(m[1]);
    if (n && n >= 0.1 && n <= 9999 && !seen.has(n)) {
      seen.add(n);
      listings.push({ price: n, condition: 'NM', condRank: 2 });
    }
  }
  if (listings.length > 0) return listings.slice(0, 20).sort((a,b) => a.price - b.price);

  // ── Strategia 5: fallback € pattern grezzo ───────────────────────────────
  const euroPattern = /€\s*(\d{1,4}(?:[.,]\d{3})*[,.]\d{2})/g;
  while ((m = euroPattern.exec(html)) !== null) {
    const n = parsePrice(m[1]);
    if (n && n >= 0.1 && n <= 9999 && !seen.has(n)) {
      seen.add(n);
      listings.push({ price: n, condition: 'NM', condRank: 2 });
    }
  }

  return listings.slice(0, 20).sort((a, b) => a.price - b.price);
}

function extractFromNextData(obj: unknown, depth = 0): Listing[] {
  if (depth > 12 || !obj || typeof obj !== 'object') return [];
  const listings: Listing[] = [];

  for (const [, v] of Object.entries(obj as Record<string, unknown>)) {
    if (Array.isArray(v) && v.length > 0 && depth < 8) {
      const first = v[0] as Record<string, unknown>;
      if (first && typeof first === 'object' &&
          ('price' in first || 'priceGross' in first || 'sellPrice' in first || 'minPrice' in first)) {
        for (const item of v) {
          const i = item as Record<string, unknown>;
          const rawPrice = i.price ?? i.priceGross ?? i.sellPrice ?? i.minPrice;
          const price = typeof rawPrice === 'number' ? rawPrice
            : rawPrice ? parsePrice(String(rawPrice)) : null;
          if (!price || price < 0.1 || price > 9999) continue;

          let cond = 'NM', condRank = 2;
          const condField = i.condition ?? i.cardCondition ?? i.minCondition;
          if (condField) {
            const condStr = extractConditionLabel(condField);
            if (condStr) { cond = condStr; condRank = COND_ORDER[condStr] || 2; }
          }
          listings.push({ price: Math.round(price * 100) / 100, condition: cond, condRank });
        }
        if (listings.length > 0) return listings.sort((a,b) => a.price - b.price).slice(0, 20);
      }
    }
    if (typeof v === 'object' && v !== null) {
      const sub = extractFromNextData(v, depth + 1);
      if (sub.length > 0) return sub;
    }
  }
  return listings;
}

function extractConditionLabel(condField: unknown): string | null {
  if (!condField) return null;
  const s = typeof condField === 'object'
    ? (condField as Record<string,unknown>).label ?? (condField as Record<string,unknown>).abbreviation ?? (condField as Record<string,unknown>).name ?? ''
    : String(condField);
  const str = String(s).trim();
  const abbrev: Record<string,string> = {
    'MT':'Mint','NM':'Near Mint','EX':'Excellent','GD':'Good',
    'LP':'Light Played','PL':'Played','PO':'Poor',
    '1':'Mint','2':'Near Mint','3':'Excellent','4':'Good','5':'Light Played','6':'Played','7':'Poor',
  };
  return abbrev[str] ?? (COND_ORDER[str] ? str : null);
}

function extractConditionFromRow(row: string): string | null {
  const condMatch = row.match(/(?:badge-|condition-|cond-)([a-z-]+)/i)
    ?? row.match(/\b(Mint|Near Mint|Excellent|Good|Light Played|Played|Poor|NM|EX|GD|LP|PL|PO|MT)\b/i);
  if (!condMatch) return null;
  const raw = condMatch[1];
  const map: Record<string,string> = {
    'mint':'Mint','near':'Near Mint','near-mint':'Near Mint','nearmint':'Near Mint',
    'excellent':'Excellent','good':'Good','lightplayed':'Light Played',
    'light-played':'Light Played','light':'Light Played','played':'Played','poor':'Poor',
    'nm':'Near Mint','ex':'Excellent','gd':'Good','lp':'Light Played','pl':'Played','po':'Poor','mt':'Mint',
  };
  return map[raw.toLowerCase()] ?? null;
}

function extractPriceFromRow(row: string): number | null {
  const m = row.match(/(?:€\s*|"price"\s*:\s*"?)(\d{1,4}[,.]?\d{0,3}[,.]\d{2})/i);
  return m ? parsePrice(m[1]) : null;
}

function parsePrice(s: string): number | null {
  const c = s.trim().replace(/\s/g, '').replace(/[€$]/g, '');
  if (!c) return null;
  if (/^\d{1,3}(\.\d{3})*(,\d{1,2})$/.test(c)) return parseFloat(c.replace(/\./g, '').replace(',', '.'));
  if (/^\d+,\d{1,2}$/.test(c)) return parseFloat(c.replace(',', '.'));
  const n = parseFloat(c.replace(',', '.'));
  return isNaN(n) ? null : n;
}
