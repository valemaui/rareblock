// Supabase Edge Function: cm-price v3
// Estrae i singoli annunci con condizione e prezzo (non più solo prezzi aggregati)
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

// Mappa CM condition string → ordine numerico (più alto = peggio)
const COND_ORDER: Record<string,number> = {
  'Mint':1,'Near Mint':2,'Excellent':3,'Good':4,'Light Played':5,'Played':6,'Poor':7,
  'MT':1,'NM':2,'EX':3,'GD':4,'LP':5,'PL':6,'PO':7,
};

interface Listing { price: number; condition: string; condRank: number; seller?: string; }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const body = await req.json();
    const url: string = body?.url ?? '';
    if (!url || !url.includes('cardmarket.com')) {
      return json({ error: 'url non valido', listings: [], prices: [] });
    }

    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
      },
    });

    if (!resp.ok) {
      return json({
        error: `CM HTTP ${resp.status}${resp.status===403?' — Cloudflare WAF':''}`,
        listings: [], prices: []
      });
    }

    const html = await resp.text();

    if (html.length < 2000 || html.includes('cf-browser-verification') || html.includes('Just a moment')) {
      return json({ error: 'Cloudflare challenge — riprova tra qualche secondo', listings: [], prices: [] });
    }

    const listings = extractListings(html);
    // Compatibilità retroattiva: prices = array di numeri (come prima)
    const prices = listings.map(l => l.price);

    return json({ listings, prices, url, source: 'cardmarket', count: listings.length });

  } catch (e: any) {
    return json({ error: String(e?.message ?? e), listings: [], prices: [] });
  }
});

function extractListings(html: string): Listing[] {
  const listings: Listing[] = [];

  // ── Strategia 1: __NEXT_DATA__ JSON (struttura più affidabile) ─────────────
  const nd = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nd) {
    try {
      const obj = JSON.parse(nd[1]);
      const extracted = extractFromNextData(obj);
      if (extracted.length > 0) return extracted;
    } catch { /* continua */ }
  }

  // ── Strategia 2: HTML strutturato — article.article-table-body / .row-offer ─
  // Cardmarket usa tabelle con righe per ogni annuncio
  // Condizione: span.badge o span con class condition-*
  // Prezzo: span.price-container o .color-primary
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
  if (listings.length > 0) return listings.slice(0, 20);

  // ── Strategia 3: JSON-LD + prezzi pattern ─────────────────────────────────
  const jld = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = jld.exec(html)) !== null) {
    try {
      const o = JSON.parse(m[1]);
      const lp = o?.offers?.lowPrice ?? o?.offers?.price;
      if (lp) {
        const n = parsePrice(String(lp));
        if (n) listings.push({ price: n, condition: 'NM', condRank: 2 });
      }
    } catch { /* */ }
  }

  // ── Strategia 4: fallback pattern numerico ────────────────────────────────
  if (!listings.length) {
    const re = /(?:€\s*|"price"\s*:\s*"?|"priceGross"\s*:\s*)(\d{1,4}(?:[.,]\d{3})*[,.]\d{2})(?:"|[^\d])/g;
    let r: RegExpExecArray | null;
    const seen = new Set<number>();
    while ((r = re.exec(html)) !== null) {
      const n = parsePrice(r[1]);
      if (n && n >= 0.1 && n <= 9999 && !seen.has(n)) {
        seen.add(n);
        listings.push({ price: n, condition: 'NM', condRank: 2 });
      }
    }
  }

  return listings.slice(0, 20).sort((a, b) => a.price - b.price);
}

function extractFromNextData(obj: unknown, depth = 0): Listing[] {
  if (depth > 10 || !obj || typeof obj !== 'object') return [];
  const listings: Listing[] = [];

  // Cerca array di articoli/offerte
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (Array.isArray(v) && v.length > 0 && depth < 6) {
      // Prova a identificare array di listing
      const first = v[0] as Record<string, unknown>;
      if (first && typeof first === 'object' &&
          ('price' in first || 'priceGross' in first || 'sellPrice' in first)) {
        for (const item of v) {
          const i = item as Record<string, unknown>;
          const rawPrice = i.price ?? i.priceGross ?? i.sellPrice ?? i.lowPrice;
          const price = typeof rawPrice === 'number' ? rawPrice
            : rawPrice ? parsePrice(String(rawPrice)) : null;
          if (!price || price < 0.1) continue;

          // Estrai condizione
          let cond = 'NM';
          let condRank = 2;
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
    ? (condField as Record<string,unknown>).label ?? (condField as Record<string,unknown>).abbreviation ?? ''
    : String(condField);
  const str = String(s).trim();
  // Abbreviazioni
  const abbrev: Record<string,string> = {
    'MT':'Mint','NM':'Near Mint','EX':'Excellent',
    'GD':'Good','LP':'Light Played','PL':'Played','PO':'Poor',
    '1':'Mint','2':'Near Mint','3':'Excellent','4':'Good','5':'Light Played','6':'Played','7':'Poor',
  };
  return abbrev[str] ?? (COND_ORDER[str] ? str : null);
}

function extractConditionFromRow(row: string): string | null {
  // Cerca badge condizione
  const condMatch = row.match(/(?:badge-|condition-|cond-)([a-z]+)/i)
    ?? row.match(/\b(Mint|Near Mint|Excellent|Good|Light Played|Played|Poor|NM|EX|GD|LP|PL|PO|MT)\b/i);
  if (!condMatch) return null;
  const raw = condMatch[1];
  const map: Record<string,string> = {
    'mint':'Mint','near':'Near Mint','near-mint':'Near Mint','nearmint':'Near Mint',
    'excellent':'Excellent','good':'Good','lightplayed':'Light Played',
    'light':'Light Played','played':'Played','poor':'Poor',
    'nm':'Near Mint','ex':'Excellent','gd':'Good','lp':'Light Played','pl':'Played','po':'Poor','mt':'Mint',
  };
  return map[raw.toLowerCase()] ?? null;
}

function extractPriceFromRow(row: string): number | null {
  const m = row.match(/(?:€\s*|price[^"]*"[^"]*"?)(\d{1,4}[,.]?\d{0,3}[,.]\d{2})/i);
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
