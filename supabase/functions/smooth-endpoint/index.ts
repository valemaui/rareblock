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
function detectSource(url: string, hint?: string): 'cardmarket'|'pricecharting'|'ebay_sold'|'diag'|'unknown' {
  if (hint) {
    const h = String(hint).toLowerCase();
    if (h === 'diag' || h === 'diagnostic') return 'diag';
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
    // Diag: prioritario, non richiede url
    if (body?.source === 'diag') return await handleDiag(body?.cards || null);

    const singleUrl: string = body?.url ?? '';
    const urls: string[] = Array.isArray(body?.urls) && body.urls.length ? body.urls : (singleUrl ? [singleUrl] : []);
    const firstUrl = urls[0] ?? '';
    const source = detectSource(firstUrl, body?.source);
    if (source === 'unknown' || !urls.length) {
      return json({ error: 'url/source non valido', listings: [], prices: [] });
    }
    if (source === 'cardmarket')    return await handleCardmarket(firstUrl);
    if (source === 'pricecharting') return await handlePriceChartingCascade(urls, body?.card_name, body?.debug === true);
    if (source === 'ebay_sold')     return await handleEbaySoldCascade(urls, Number(body?.min_hits ?? 3));
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
  // Trend dati
  trend_ungraded_12m?: number;   // % var 12 mesi ungraded
  trend_grade9_12m?: number;
  trend_psa10_12m?: number;
  // Prezzi storici (12 mesi fa) — utili per calcolare trend
  ungraded_12mAgo?: number;
  grade9_12mAgo?: number;
  psa10_12mAgo?: number;
  productUrl?: string;
  productTitle?: string;
  currency?: string;
}

async function handlePriceChartingCascade(urls: string[], cardName?: string, debug?: boolean): Promise<Response> {
  const attempts: Array<{ url: string; ok: boolean; found?: string; error?: string; html_len?: number; snippet?: string; candidates?: number; sample_links?: string[] }> = [];

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];

    // Risolvi search → product URL
    let productUrl = url;
    let productTitle: string | undefined;

    if (url.includes('/search-products') || url.includes('/search?')) {
      const srch = await fetchWithRetry(url, 1);
      if (!srch.ok) {
        attempts.push({ url, ok: false, error: `search HTTP ${srch.status}`, html_len: srch.html?.length ?? 0 });
        continue;
      }
      const firstProduct = extractFirstPCProduct(srch.html, cardName);
      if (!firstProduct) {
        // Debug: raccoglie info diagnostiche
        const entry: typeof attempts[0] = { url, ok: false, error: 'nessun prodotto', html_len: srch.html.length };
        if (debug) {
          // Trova tutti i link /game/ per capire se il pattern esiste (assoluti o relativi)
          const allLinks: string[] = [];
          const linkRe = /<a[^>]+href="(?:https?:\/\/(?:www\.)?pricecharting\.com)?(\/game\/[^"]+)"/gi;
          let lm: RegExpExecArray | null;
          while ((lm = linkRe.exec(srch.html)) !== null && allLinks.length < 10) {
            allLinks.push(lm[1]);
          }
          entry.candidates = allLinks.length;
          entry.sample_links = allLinks;
          // PC usa <table id="games_table"><tbody>: vai al tbody per snippet utile
          const tbodyM = srch.html.match(/<tbody\b[^>]*>([\s\S]{0,2500})/i);
          if (tbodyM) entry.snippet = tbodyM[0].substring(0, 2000);
          else {
            const tableM = srch.html.match(/<table[^>]*id=["']games_table["'][^>]*>([\s\S]{0,2500})/i);
            if (tableM) entry.snippet = tableM[0].substring(0, 2000);
            else {
              const bodyM = srch.html.match(/<body\b[^>]*>([\s\S]{0,3000})/i);
              if (bodyM) entry.snippet = bodyM[1].substring(0, 2000);
            }
          }
        }
        attempts.push(entry);
        continue;
      }
      productUrl = firstProduct.url;
      productTitle = firstProduct.title;
    }

    const { html, ok, status } = await fetchWithRetry(productUrl, 1, 'https://www.pricecharting.com/');
    if (!ok) {
      attempts.push({ url, ok: false, error: `product HTTP ${status}` });
      continue;
    }

    const prices = extractPCPrices(html);
    prices.productUrl = productUrl;
    if (productTitle && !prices.productTitle) prices.productTitle = productTitle;
    prices.currency = 'USD';

    // Consideriamo "hit" se abbiamo almeno ungraded O un grado
    const hasData = prices.ungraded != null || prices.grade9 != null || prices.psa10 != null || prices.grade8 != null;
    const attempt: typeof attempts[0] = { url, ok: true, found: prices.productTitle };

    if (debug) {
      // Cerca direttamente lo slice attorno agli ID che il parser usa (used_price, graded_price, manual_only_price, bgs_10_price)
      const ids = ['used_price','complete_price','new_price','graded_price','box_only_price','manual_only_price','bgs_10_price'];
      const slices: Record<string, string> = {};
      for (const id of ids) {
        const rx = new RegExp(`<(?:td|span|div)[^>]*id="${id}"[^>]*>([\\s\\S]{0,600}?)<\\/(?:td|span|div)>`, 'i');
        const m = html.match(rx);
        if (m) slices[id] = m[0].substring(0, 500);
      }
      attempt.snippet = JSON.stringify(slices, null, 2).substring(0, 3500);
      attempt.html_len = html.length;
    }
    attempts.push(attempt);

    if (hasData) {
      return json({ source: 'pricecharting', prices, url: productUrl, attempts, query_index: i });
    }
  }

  return json({
    source: 'pricecharting',
    attempts,
    error: `PC: nessun prodotto con dati prezzo su ${urls.length} tentativi`,
  });
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
  // PC usa URL assoluti: href="https://www.pricecharting.com/game/..."
  // Anche se raramente può usare path relativi /game/...
  // Pattern accetta entrambi.
  const linkPat = /<a\b[^>]*\bhref="(https?:\/\/(?:www\.)?pricecharting\.com)?(\/game\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const candidates: { url: string; title: string; score: number; raw_path: string }[] = [];
  let m: RegExpExecArray | null;
  const hint = (nameHint || '').toLowerCase().trim();
  const hintWords = hint.split(/\s+/).filter(w => w.length > 2);
  const seen = new Set<string>();

  while ((m = linkPat.exec(html)) !== null) {
    const path = m[2];
    if (seen.has(path)) continue;
    seen.add(path);
    const innerHtml = m[3];
    let title = innerHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (title.length < 2) {
      const slug = path.replace(/^\/game\//, '').replace(/[-\/]/g, ' ').trim();
      if (slug.length < 3) continue;
      title = slug;
    }
    candidates.push({
      url: 'https://www.pricecharting.com' + path,
      title,
      score: 0,
      raw_path: path,
    });
    if (candidates.length > 80) break;
  }

  if (!candidates.length) return null;

  // Scoring basato su hint + pokemon
  for (const c of candidates) {
    if (/pokemon/i.test(c.raw_path) || /pokemon/i.test(c.title)) c.score += 10;
    for (const w of hintWords) {
      if (c.title.toLowerCase().includes(w)) c.score += 3;
      if (c.raw_path.toLowerCase().includes(w)) c.score += 2;
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!/pokemon/i.test(best.raw_path) && !/pokemon/i.test(best.title)) return null;
  return { url: best.url, title: best.title };
}

type PCPriceKey = 'ungraded'|'grade7'|'grade8'|'grade9'|'grade9_5'|'psa10'|'bgs10'|'cgc10';

// Estrae prezzi da pagina prodotto PC.
//
// IMPORTANTE: PriceCharting usa ID HTML ereditati dalla sua origine video-games
// (used_price, complete_price, new_price, graded_price, box_only_price,
// manual_only_price, bgs_10_price). Per le carte Pokémon questi ID sono
// semanticamente DIVERSI — il label sopra la cella dice "PSA 10", "Grade 9", ecc.
// Diagnostica 2026-04-24 ha dimostrato che mapping ID→grade produce valori errati
// (es. manual_only_price=$15000 per Groudon-EX, ma label-based PSA 10=$16400).
//
// Strategia corretta: usare SOLO i pattern label-based. Il label sopra la cella
// ("PSA 10", "BGS 10", "Grade 9"...) è affidabile perché riflette la semantica
// reale della colonna nella pagina Pokémon.
function extractPCPrices(html: string): PCPrices {
  const out: PCPrices = {};

  // Ordine IMPORTANTE: grade 9.5 prima di grade 9 (altrimenti regex grade9 prende entrambi)
  // PSA/BGS/CGC 10 prima di grade 8/9 per evitare match ambigui
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

  // Trend 12 mesi — PriceCharting espone "1 Year Change" in tabelle o div con class/id variabili
  // Strategia 1: pattern JSON "priceHistory" o "chartData" con datapoint mensili
  // Strategia 2: cerca "+X%" o "-X%" vicino a label "1 year" / "12 month" / "yearly"
  //              PC ha tipicamente: <div class="stats">Was $X a year ago</div>
  // Strategia 3: "Price Change" table con colonne 3 mesi / 6 mesi / 12 mesi
  const trendPats: Array<{ rx: RegExp; key: 'trend_ungraded_12m'|'trend_grade9_12m'|'trend_psa10_12m' }> = [
    { rx: /Ungraded[\s\S]{0,600}?(?:1[\s-]?year|12[\s-]?month|yearly)[\s\S]{0,80}?(-?\+?[\d.]+)\s*%/i, key: 'trend_ungraded_12m' },
    { rx: /Grade\s*9(?!\.)[\s\S]{0,600}?(?:1[\s-]?year|12[\s-]?month|yearly)[\s\S]{0,80}?(-?\+?[\d.]+)\s*%/i, key: 'trend_grade9_12m' },
    { rx: /PSA\s*10[\s\S]{0,600}?(?:1[\s-]?year|12[\s-]?month|yearly)[\s\S]{0,80}?(-?\+?[\d.]+)\s*%/i, key: 'trend_psa10_12m' },
  ];
  for (const { rx, key } of trendPats) {
    const m = html.match(rx);
    if (m) {
      const n = parseFloat(m[1].replace('+',''));
      if (!isNaN(n) && Math.abs(n) < 10000) out[key] = Math.round(n * 10) / 10;
    }
  }

  // Prezzi 12 mesi fa — pattern "was $X" / "a year ago $X"
  const agoPats: Array<{ rx: RegExp; key: 'ungraded_12mAgo'|'grade9_12mAgo'|'psa10_12mAgo' }> = [
    { rx: /Ungraded[\s\S]{0,800}?(?:a\s+year\s+ago|1\s*year\s*ago|12\s*months?\s*ago|was)[\s\S]{0,50}?\$\s*([\d,]+\.\d{2})/i, key: 'ungraded_12mAgo' },
    { rx: /Grade\s*9(?!\.)[\s\S]{0,800}?(?:a\s+year\s+ago|1\s*year\s*ago|12\s*months?\s*ago|was)[\s\S]{0,50}?\$\s*([\d,]+\.\d{2})/i, key: 'grade9_12mAgo' },
    { rx: /PSA\s*10[\s\S]{0,800}?(?:a\s+year\s+ago|1\s*year\s*ago|12\s*months?\s*ago|was)[\s\S]{0,50}?\$\s*([\d,]+\.\d{2})/i, key: 'psa10_12mAgo' },
  ];
  for (const { rx, key } of agoPats) {
    const m = html.match(rx);
    if (m) {
      const n = parsePrice(m[1]);
      if (n) out[key] = n;
    }
  }

  // Se abbiamo sia prezzo attuale sia 12m fa, calcola trend se manca
  if (out.ungraded && out.ungraded_12mAgo && out.trend_ungraded_12m == null) {
    out.trend_ungraded_12m = Math.round(((out.ungraded - out.ungraded_12mAgo) / out.ungraded_12mAgo) * 1000) / 10;
  }
  if (out.grade9 && out.grade9_12mAgo && out.trend_grade9_12m == null) {
    out.trend_grade9_12m = Math.round(((out.grade9 - out.grade9_12mAgo) / out.grade9_12mAgo) * 1000) / 10;
  }
  if (out.psa10 && out.psa10_12mAgo && out.trend_psa10_12m == null) {
    out.trend_psa10_12m = Math.round(((out.psa10 - out.psa10_12mAgo) / out.psa10_12mAgo) * 1000) / 10;
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

async function handleEbaySoldCascade(urls: string[], minHits: number): Promise<Response> {
  const attempts: Array<{ url: string; count: number; median?: number; error?: string }> = [];
  let best: (EbaySoldResult & { url: string }) | null = null;

  for (let i = 0; i < urls.length; i++) {
    let u = urls[i];
    if (!/LH_Sold=1/.test(u))     u += (u.includes('?') ? '&' : '?') + 'LH_Sold=1';
    if (!/LH_Complete=1/.test(u)) u += '&LH_Complete=1';

    const host = new URL(u).host;
    const { html, ok, status } = await fetchWithRetry(u, 1, `https://${host}/`);
    if (!ok) {
      attempts.push({ url: u, count: 0, error: `HTTP ${status}` });
      continue;
    }

    const currency = /ebay\.com\//.test(u) ? 'USD'
      : /ebay\.co\.uk/.test(u) ? 'GBP'
      : 'EUR';

    const result = extractEbayPrices(html, currency);
    attempts.push({ url: u, count: result.count, median: result.median });

    // Se raggiungiamo la soglia → esci subito
    if (result.count >= minHits) {
      return json({ source: 'ebay_sold', url: u, attempts, query_index: i, ...result });
    }

    // Tieni il "meno peggio" come fallback se nessuno raggiunge la soglia
    if (!best || result.count > best.count) {
      best = { ...result, url: u };
    }
  }

  // Nessun tentativo sopra soglia — ritorna il migliore (anche se count < minHits)
  if (best && best.count > 0) {
    const { url: _drop, ...restOfBest } = best;
    return json({
      source: 'ebay_sold',
      url: best.url,
      attempts,
      query_index: attempts.findIndex(a => a.url === best!.url),
      below_threshold: true,
      ...restOfBest,
    });
  }

  return json({
    source: 'ebay_sold',
    url: urls[urls.length-1] || '',
    attempts,
    prices: [],
    count: 0,
    currency: 'EUR',
    error: 'nessun venduto su '+urls.length+' tentativi',
  });
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

// ═════════════════════════════════════════════════════════════════════
//  DIAG — diagnostic runner che parsa PC e stampa tabella ID→prezzi
// ═════════════════════════════════════════════════════════════════════
interface DiagCardInput {
  name: string;       // query PC
  card_name?: string; // hint match (nome+numero)
}

const DIAG_DEFAULT_CARDS: DiagCardInput[] = [
  { name: 'Groudon-EX Dark Explorers', card_name: 'Groudon 106' },
  { name: 'Charizard Base Set', card_name: 'Charizard 4' },
  { name: 'Pikachu Vivid Voltage', card_name: 'Pikachu 44' },
];

async function handleDiag(inputCards: DiagCardInput[] | null): Promise<Response> {
  const cards = (inputCards && inputCards.length) ? inputCards : DIAG_DEFAULT_CARDS;
  const report: any[] = [];

  for (const card of cards) {
    const url = 'https://www.pricecharting.com/search-products?q=' + encodeURIComponent(card.name) + '&type=prices';
    const srch = await fetchWithRetry(url, 1);
    const cardReport: any = { card: card.name, card_name: card.card_name };

    if (!srch.ok) { cardReport.error = `search HTTP ${srch.status}`; report.push(cardReport); continue; }

    const firstProduct = extractFirstPCProduct(srch.html, card.card_name);
    if (!firstProduct) { cardReport.error = 'no product match'; report.push(cardReport); continue; }

    cardReport.product_title = firstProduct.title;
    cardReport.product_url   = firstProduct.url;

    const prod = await fetchWithRetry(firstProduct.url, 1, 'https://www.pricecharting.com/');
    if (!prod.ok) { cardReport.error = `product HTTP ${prod.status}`; report.push(cardReport); continue; }

    // Estrai slice di ogni ID con contesto label
    const ids = ['used_price','complete_price','new_price','graded_price','box_only_price','manual_only_price','bgs_10_price'];
    const idData: any = {};
    for (const id of ids) {
      const rx = new RegExp(`<(?:td|span|div)[^>]*id="${id}"[^>]*>([\\s\\S]{0,600}?)<\\/(?:td|span|div)>`, 'i');
      const m = prod.html.match(rx);
      if (!m) continue;
      const slice = m[0];
      // Estrai primo prezzo $
      const priceM = slice.match(/\$\s*([\d,]+\.\d{2})/);
      const price = priceM ? parseFloat(priceM[1].replace(/,/g, '')) : null;
      // Prendi contesto label: 200 char prima dell'ID
      const idx = prod.html.indexOf(`id="${id}"`);
      const before = idx > 0 ? prod.html.substring(Math.max(0, idx - 250), idx).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(-120) : '';
      idData[id] = { price, label_context: before, raw: slice.substring(0, 200) };
    }
    cardReport.ids = idData;

    // Prova anche label-based (quello che usa fallback parser)
    const labelPatterns: Array<[string, RegExp]> = [
      ['PSA 10',   /PSA\s*10[\s\S]{0,200}?\$([\d,]+\.\d{2})/i],
      ['BGS 10',   /BGS\s*10[\s\S]{0,200}?\$([\d,]+\.\d{2})/i],
      ['CGC 10',   /CGC\s*10[\s\S]{0,200}?\$([\d,]+\.\d{2})/i],
      ['Grade 9.5',/Grade\s*9\.5[\s\S]{0,200}?\$([\d,]+\.\d{2})/i],
      ['Grade 9',  /Grade\s*9(?!\.)[\s\S]{0,200}?\$([\d,]+\.\d{2})/i],
      ['Grade 8',  /Grade\s*8[\s\S]{0,200}?\$([\d,]+\.\d{2})/i],
      ['Grade 7',  /Grade\s*7[\s\S]{0,200}?\$([\d,]+\.\d{2})/i],
      ['Ungraded', /Ungraded[\s\S]{0,200}?\$([\d,]+\.\d{2})/i],
    ];
    const labels: any = {};
    for (const [lbl, rx] of labelPatterns) {
      const m = prod.html.match(rx);
      if (m) labels[lbl] = parseFloat(m[1].replace(/,/g, ''));
    }
    cardReport.labels = labels;

    // Prezzo "estratto" ufficiale (quello che ritornerebbe la funzione)
    cardReport.extracted = extractPCPrices(prod.html);

    // Dump: elenca TUTTI i $XXX.XX del HTML con contesto, per vedere dove stanno davvero i prezzi
    const priceMatches: { price: number; before: string; after: string }[] = [];
    const pricePat = /\$\s*([\d,]+\.\d{2})/g;
    let pm: RegExpExecArray | null;
    while ((pm = pricePat.exec(prod.html)) !== null && priceMatches.length < 80) {
      const before = prod.html.substring(Math.max(0, pm.index - 140), pm.index)
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(-80);
      const after = prod.html.substring(pm.index + pm[0].length, pm.index + pm[0].length + 80)
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50);
      priceMatches.push({ price: parseFloat(pm[1].replace(/,/g, '')), before, after });
    }
    cardReport.price_dump = priceMatches;

    // Per ciascuna label (PSA 10, BGS 10, CGC 10), trova TUTTE le occorrenze
    // e per ognuna prendi il primo $ dopo e 100 char di contesto
    const labelOccurrences: Record<string, Array<{ pos: number; first_price: number | null; context: string }>> = {};
    for (const lbl of ['PSA 10', 'BGS 10', 'CGC 10', 'Grade 7', 'Grade 8', 'Grade 9', 'Grade 9.5', 'Ungraded']) {
      const lblRe = new RegExp(lbl.replace(/\s+/g, '\\s*').replace('.', '\\.'), 'gi');
      const occs: Array<{ pos: number; first_price: number | null; context: string }> = [];
      let lm: RegExpExecArray | null;
      while ((lm = lblRe.exec(prod.html)) !== null && occs.length < 6) {
        const from = lm.index;
        const nextPriceM = prod.html.substring(from, from + 2000).match(/\$\s*([\d,]+\.\d{2})/);
        const price = nextPriceM ? parseFloat(nextPriceM[1].replace(/,/g, '')) : null;
        const ctx = prod.html.substring(from, from + 400)
          .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
        occs.push({ pos: from, first_price: price, context: ctx });
      }
      if (occs.length) labelOccurrences[lbl] = occs;
    }
    cardReport.label_occurrences = labelOccurrences;

    // Rileva anomalie
    const ex = cardReport.extracted;
    const anomalies = [];
    if (ex.psa10 && ex.ungraded && ex.psa10 > 10 * ex.ungraded) anomalies.push(`PSA 10 (${ex.psa10}) > 10× Ungraded (${ex.ungraded})`);
    if (ex.psa10 && ex.grade9 && ex.psa10 < ex.grade9) anomalies.push('PSA 10 < Grade 9');
    if (ex.psa10 > 5000) anomalies.push(`PSA 10 > $5000 (sospetto)`);
    if (ex.bgs10 > 5000) anomalies.push(`BGS 10 > $5000 (sospetto)`);
    if (ex.cgc10 > 5000) anomalies.push(`CGC 10 > $5000 (sospetto)`);
    cardReport.anomalies = anomalies;

    report.push(cardReport);
  }

  return json({ source: 'diag', generated_at: new Date().toISOString(), cards: report });
}
