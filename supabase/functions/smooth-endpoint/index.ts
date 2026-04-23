// Supabase Edge Function: smooth-endpoint (source: cm-price.ts) v5
// Multi-source scraper: CardMarket + PriceCharting + eBay Sold
// Backwards-compatible: se manca `source`, deduce dal dominio dell'URL.
// Deploy: supabase functions deploy smooth-endpoint

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

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
];
const getRandomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

function buildHeaders(url: string, lang = 'it', referer?: string): Record<string,string> {
  const ua = getRandomUA();
  const isIt = lang === 'it';
  const host = new URL(url).host;
  return {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': isIt ? 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7' : 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'max-age=0',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': referer ? 'same-origin' : 'none',
    'Sec-Fetch-User': '?1',
    'Sec-CH-UA': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"Windows"',
    'DNT': '1',
    'Referer': referer ?? `https://${host}/`,
  };
}

async function fetchWithRetry(url: string, maxRetries = 2, referer?: string): Promise<{ html: string; ok: boolean; status: number }> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 600 + Math.random() * 500));
    const isCm = url.includes('cardmarket.com');
    const lang = (isCm && attempt % 2 === 1) ? 'de' : 'it';
    const fetchUrl = isCm && attempt > 0
      ? url.replace('/it/Pokemon', `/${lang}/Pokemon`)
      : url;
    try {
      const resp = await fetch(fetchUrl, { headers: buildHeaders(fetchUrl, lang, referer) });
      const html = await resp.text();
      if (html.length < 1000 || /Just a moment|cf-browser-verification|Attention Required/i.test(html)) {
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

// ─── ROUTER ──────────────────────────────────────────────────────────
function detectSource(url: string, hint?: string): 'cardmarket'|'pricecharting'|'ebay_sold'|'unknown' {
  if (hint) {
    const h = String(hint).toLowerCase();
    if (h.includes('price') || h === 'pc') return 'pricecharting';
    if (h.includes('ebay')) return 'ebay_sold';
    if (h === 'cardmarket' || h === 'cm') return 'cardmarket';
  }
  if (!url) return 'unknown';
  if (url.includes('cardmarket.com')) return 'cardmarket';
  if (url.includes('pricecharting.com')) return 'pricecharting';
  if (/ebay\.(com|it|de|co\.uk|fr|es)/.test(url)) return 'ebay_sold';
  return 'unknown';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const body = await req.json();
    const url: string = body?.url ?? '';
    const source = detectSource(url, body?.source);
    if (source === 'unknown' || !url) {
      return json({ error: 'url/source non valido', listings: [], prices: [] });
    }
    if (source === 'cardmarket')    return await handleCardmarket(url);
    if (source === 'pricecharting') return await handlePriceCharting(url, body?.card_name);
    if (source === 'ebay_sold')     return await handleEbaySold(url);
    return json({ error: 'source non gestita', listings: [], prices: [] });
  } catch (e: any) {
    return json({ error: String(e?.message ?? e), listings: [], prices: [] });
  }
});

// ═════════════════════════════════════════════════════════════════════
//  CARDMARKET (v4 logic invariata)
// ═════════════════════════════════════════════════════════════════════
async function handleCardmarket(url: string): Promise<Response> {
  const { html, ok, status } = await fetchWithRetry(url);
  if (!ok || !html) {
    return json({
      error: `CM HTTP ${status}${status === 403 ? ' — Cloudflare WAF (normale, riprova)' : ''}`,
      listings: [], prices: [], status,
    });
  }
  if (/Just a moment|cf-browser-verification/i.test(html)) {
    return json({ error: 'Cloudflare challenge attivo', listings: [], prices: [], status: 403 });
  }
  const listings = extractCMListings(html);
  const prices = listings.map(l => l.price);
  return json({ listings, prices, url, source: 'cardmarket', count: listings.length });
}

function extractCMListings(html: string): Listing[] {
  const nd = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nd) {
    try {
      const obj = JSON.parse(nd[1]);
      const extracted = extractFromNextData(obj);
      if (extracted.length > 0) return extracted;
    } catch { /* */ }
  }
  const wnd = html.match(/window\.__NEXT_DATA__\s*=\s*(\{[\s\S]*?\});?\s*(?:<\/script>|window\.)/);
  if (wnd) {
    try {
      const obj = JSON.parse(wnd[1]);
      const extracted = extractFromNextData(obj);
      if (extracted.length > 0) return extracted;
    } catch { /* */ }
  }
  const listings: Listing[] = [];
  const rowPattern = /<div[^>]*class="[^"]*article-row[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*article-row|<\/table|<\/article)/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowPattern.exec(html)) !== null) {
    const row = rowMatch[1];
    const cond = extractConditionFromRow(row);
    const price = extractPriceFromRow(row);
    if (cond && price) listings.push({ price, condition: cond, condRank: COND_ORDER[cond] || 5 });
  }
  if (listings.length > 0) return listings.slice(0, 20).sort((a,b) => a.price - b.price);

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
  const c = s.trim().replace(/\s/g, '').replace(/[€$£¥]/g, '');
  if (!c) return null;
  if (/^\d{1,3}(\.\d{3})*(,\d{1,2})$/.test(c)) return parseFloat(c.replace(/\./g, '').replace(',', '.'));
  if (/^\d+,\d{1,2}$/.test(c)) return parseFloat(c.replace(',', '.'));
  if (/^\d{1,3}(,\d{3})*(\.\d{1,2})$/.test(c)) return parseFloat(c.replace(/,/g, ''));
  const n = parseFloat(c.replace(',', '.'));
  return isNaN(n) ? null : n;
}

// ═════════════════════════════════════════════════════════════════════
//  PRICECHARTING — prezzi graded reali (USD)
// ═════════════════════════════════════════════════════════════════════
interface PCPrices {
  ungraded?: number;
  grade7?: number;
  grade8?: number;
  grade9?: number;
  grade9_5?: number;
  psa10?: number;
  bgs10?: number;
  cgc10?: number;
  productUrl?: string;
  productTitle?: string;
  currency?: string;
}

async function handlePriceCharting(url: string, cardName?: string): Promise<Response> {
  let productUrl = url;
  let productTitle: string | undefined;

  if (url.includes('/search-products') || url.includes('/search?')) {
    const srch = await fetchWithRetry(url, 2);
    if (!srch.ok) {
      return json({ error: `PC search HTTP ${srch.status}`, source: 'pricecharting' });
    }
    const firstProduct = extractFirstPCProduct(srch.html, cardName);
    if (!firstProduct) {
      return json({ error: 'PC: nessun prodotto nel risultato ricerca', source: 'pricecharting' });
    }
    productUrl = firstProduct.url;
    productTitle = firstProduct.title;
  }

  const { html, ok, status } = await fetchWithRetry(productUrl, 2, 'https://www.pricecharting.com/');
  if (!ok) {
    return json({ error: `PC product HTTP ${status}`, source: 'pricecharting', productUrl });
  }

  const prices = extractPCPrices(html);
  prices.productUrl = productUrl;
  if (productTitle && !prices.productTitle) prices.productTitle = productTitle;
  prices.currency = 'USD';

  return json({ source: 'pricecharting', prices, url: productUrl });
}

function extractFirstPCProduct(html: string, nameHint?: string): { url: string; title: string } | null {
  const linkPat = /<a[^>]+href="(\/game\/[^"]+)"[^>]*>([^<]{2,120})<\/a>/g;
  const candidates: { url: string; title: string; score: number }[] = [];
  let m: RegExpExecArray | null;
  const hint = (nameHint || '').toLowerCase().trim();
  while ((m = linkPat.exec(html)) !== null) {
    const path = m[1];
    const title = m[2].trim().replace(/\s+/g, ' ');
    if (!/pokemon/i.test(path)) continue;
    if (title.length < 3) continue;
    let score = 0;
    if (hint) {
      const words = hint.split(/\s+/).filter(Boolean);
      for (const w of words) if (w.length > 2 && title.toLowerCase().includes(w)) score += 2;
    }
    candidates.push({ url: 'https://www.pricecharting.com' + path, title, score });
    if (candidates.length > 20) break;
  }
  if (!candidates.length) return null;
  candidates.sort((a,b) => b.score - a.score);
  return { url: candidates[0].url, title: candidates[0].title };
}

type PCPriceKey = 'ungraded'|'grade7'|'grade8'|'grade9'|'grade9_5'|'psa10'|'bgs10'|'cgc10';

function extractPCPrices(html: string): PCPrices {
  const out: PCPrices = {};
  const idMap: Record<string, PCPriceKey> = {
    'used_price':    'ungraded',
    'complete_price':'grade7',
    'new_price':     'grade8',
    'graded_price':  'grade9',
    'box_only_price':'grade9_5',
    'manual_only_price':'psa10',
    'bgs_10_price':  'bgs10',
  };

  for (const [id, key] of Object.entries(idMap)) {
    const re = new RegExp(
      `<(?:td|span|div)[^>]*id="${id}"[^>]*>([\\s\\S]{0,400}?)<\\/(?:td|span|div)>`,
      'i'
    );
    const m = html.match(re);
    if (m) {
      const price = extractFirstUSD(m[1]);
      if (price) out[key] = price;
    }
  }

  const labelPatterns: Array<{ rx: RegExp; key: PCPriceKey }> = [
    { rx: /PSA\s*10[\s\S]{0,200}?\$([\d,]+\.\d{2})/i, key: 'psa10' },
    { rx: /BGS\s*10[\s\S]{0,200}?\$([\d,]+\.\d{2})/i, key: 'bgs10' },
    { rx: /CGC\s*10[\s\S]{0,200}?\$([\d,]+\.\d{2})/i, key: 'cgc10' },
    { rx: /Grade\s*9\.5[\s\S]{0,200}?\$([\d,]+\.\d{2})/i, key: 'grade9_5' },
    { rx: /Grade\s*9(?!\.)[\s\S]{0,200}?\$([\d,]+\.\d{2})/i, key: 'grade9' },
    { rx: /Grade\s*8[\s\S]{0,200}?\$([\d,]+\.\d{2})/i, key: 'grade8' },
    { rx: /Grade\s*7[\s\S]{0,200}?\$([\d,]+\.\d{2})/i, key: 'grade7' },
    { rx: /Ungraded[\s\S]{0,200}?\$([\d,]+\.\d{2})/i, key: 'ungraded' },
  ];
  for (const { rx, key } of labelPatterns) {
    if (out[key]) continue;
    const m = html.match(rx);
    if (m) {
      const n = parsePrice(m[1]);
      if (n) out[key] = n;
    }
  }

  const titleM = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (titleM) {
    const t = titleM[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (t.length > 2 && t.length < 200) out.productTitle = t;
  }

  return out;
}

function extractFirstUSD(s: string): number | null {
  const m = s.match(/\$\s*([\d,]+\.\d{2})/);
  return m ? parsePrice(m[1]) : null;
}

// ═════════════════════════════════════════════════════════════════════
//  EBAY SOLD — listings venduti/completati con stats
// ═════════════════════════════════════════════════════════════════════
interface EbaySoldResult {
  prices: number[];
  median?: number;
  avg?: number;
  min?: number;
  max?: number;
  count: number;
  currency: string;
  outliersRemoved?: number;
}

async function handleEbaySold(url: string): Promise<Response> {
  let finalUrl = url;
  if (!/LH_Sold=1/.test(finalUrl))     finalUrl += (finalUrl.includes('?') ? '&' : '?') + 'LH_Sold=1';
  if (!/LH_Complete=1/.test(finalUrl)) finalUrl += '&LH_Complete=1';

  const host = new URL(finalUrl).host;
  const { html, ok, status } = await fetchWithRetry(finalUrl, 2, `https://${host}/`);
  if (!ok) return json({ error: `eBay HTTP ${status}`, source: 'ebay_sold' });

  const currency = /ebay\.com[^.]/.test(finalUrl) || finalUrl.includes('ebay.com/') ? 'USD'
    : /ebay\.co\.uk/.test(finalUrl) ? 'GBP'
    : 'EUR';

  const result = extractEbayPrices(html, currency);
  return json({ source: 'ebay_sold', url: finalUrl, ...result });
}

function extractEbayPrices(html: string, currency: string): EbaySoldResult {
  const priceBlocks: string[] = [];
  const blockPat = /<span[^>]*class="[^"]*s-item__price[^"]*"[^>]*>([\s\S]*?)<\/span>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockPat.exec(html)) !== null) {
    priceBlocks.push(m[1].replace(/<[^>]+>/g, ' ').trim());
  }

  const raw: number[] = [];
  for (const block of priceBlocks) {
    if (/\bto\b\s+[\$€£]/i.test(block) || /\ba\b\s+[\$€£]/i.test(block)) continue;
    const pats = [
      /\$\s*([\d,]+\.\d{2})/,
      /€\s*([\d.]+,\d{2})/,
      /£\s*([\d,]+\.\d{2})/,
      /EUR\s*([\d.]+,\d{2})/i,
      /EUR\s*([\d,]+\.\d{2})/i,
      /USD\s*([\d,]+\.\d{2})/i,
      /GBP\s*([\d,]+\.\d{2})/i,
    ];
    for (const p of pats) {
      const mm = block.match(p);
      if (mm) {
        const n = parsePrice(mm[1]);
        if (n && n >= 0.5 && n <= 99999) { raw.push(n); break; }
      }
    }
  }

  if (raw.length === 0) {
    const jsonPricePat = /"convertedCurrentPrice"\s*:\s*\{?[^}]*?"value"\s*:\s*"?([\d.]+)"?/g;
    while ((m = jsonPricePat.exec(html)) !== null) {
      const n = parseFloat(m[1]);
      if (!isNaN(n) && n >= 0.5 && n <= 99999) raw.push(n);
    }
  }

  if (raw.length === 0) {
    const soldRowPat = /(SOLD|Venduto|Venduti)[\s\S]{0,400}?(?:\$|€|£)\s*([\d.,]+)/gi;
    while ((m = soldRowPat.exec(html)) !== null) {
      const n = parsePrice(m[2]);
      if (n && n >= 0.5 && n <= 99999) raw.push(n);
    }
  }

  if (raw.length === 0) {
    return { prices: [], count: 0, currency };
  }

  const sorted = raw.slice().sort((a,b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  const filtered = sorted.filter(p => p >= lo && p <= hi);
  const outliersRemoved = sorted.length - filtered.length;

  const use = filtered.length >= 3 ? filtered : sorted;
  const count = use.length;
  const sum = use.reduce((a,b) => a + b, 0);
  const avg = Math.round((sum / count) * 100) / 100;
  const mid = Math.floor(count / 2);
  const median = count % 2 === 0
    ? Math.round(((use[mid - 1] + use[mid]) / 2) * 100) / 100
    : use[mid];

  return {
    prices: use.slice(0, 30),
    median,
    avg,
    min: use[0],
    max: use[count - 1],
    count,
    currency,
    outliersRemoved,
  };
}
