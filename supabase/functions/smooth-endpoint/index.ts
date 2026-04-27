// Supabase Edge Function: smooth-endpoint (source: cm-price.ts) v5.1
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

interface Listing { price: number; condition: string; condRank: number; seller?: string; comment?: string; grading?: { house: string; score: number; raw: string } | null; }

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
  const isPc = host.includes('pricecharting.com');

  const headers: Record<string,string> = {
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

  // PriceCharting decide la valuta mostrata principalmente via cookie utente.
  // Vari nomi di cookie possibili — li setto tutti per robustezza.
  if (isPc) {
    headers['Cookie'] = 'preferred_currency=EUR; currency=EUR; country=IT; locale=it_IT';
  }

  return headers;
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
function detectSource(url: string, hint?: string): 'cardmarket'|'pricecharting'|'ebay_sold'|'catawiki_search'|'ebay_search'|'subito_search'|'diag'|'unknown' {
  if (hint) {
    const h = String(hint).toLowerCase();
    if (h === 'diag' || h === 'diagnostic') return 'diag';
    if (h.includes('price') || h === 'pc') return 'pricecharting';
    if (h === 'catawiki_search' || h === 'catawiki') return 'catawiki_search';
    if (h === 'ebay_search') return 'ebay_search';
    if (h === 'subito_search' || h === 'subito') return 'subito_search';
    if (h.includes('ebay')) return 'ebay_sold';
    if (h === 'cardmarket' || h === 'cm') return 'cardmarket';
  }
  if (!url) return 'unknown';
  if (url.includes('cardmarket.com')) return 'cardmarket';
  if (url.includes('pricecharting.com')) return 'pricecharting';
  if (url.includes('catawiki.com')) return 'catawiki_search';
  if (url.includes('subito.it')) return 'subito_search';
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
    if (source === 'cardmarket')      return await handleCardmarket(firstUrl, body?.debug === true);
    if (source === 'pricecharting')   return await handlePriceChartingCascade(urls, body?.card_name, body?.debug === true);
    if (source === 'ebay_sold')       return await handleEbaySoldCascade(urls, Number(body?.min_hits ?? 3), body?.merge === true);
    if (source === 'catawiki_search') return await handleCatawikiSearch(firstUrl, body?.debug === true);
    if (source === 'ebay_search')     return await handleEbaySearch(firstUrl, body?.debug === true);
    if (source === 'subito_search')   return await handleSubitoSearch(firstUrl, body?.debug === true);
    return json({ error: 'source non gestita', listings: [], prices: [] });
  } catch (e: any) {
    return json({ error: String(e?.message ?? e), listings: [], prices: [] });
  }
});

// ═════════════════════════════════════════════════════════════════════
//  CARDMARKET (v4 logic invariata)
// ═════════════════════════════════════════════════════════════════════
async function handleCardmarket(url: string, debug = false): Promise<Response> {
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

  // Se 0 listings e debug richiesto, aggiungi diagnostica dell'HTML ricevuto
  // per capire se CM ha servito consent wall / pagina alternativa / NEXT_DATA
  // con struttura diversa rispetto a quella attesa.
  const baseResp: Record<string, unknown> = {
    listings, prices, url, source: 'cardmarket', count: listings.length,
  };

  if (listings.length === 0 && debug) {
    const nd = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    const rowMatches = (html.match(/class="[^"]*article-row[^"]*"/gi) || []).length;
    const euroMatches = (html.match(/€\s*\d{1,4}[,.]\d{2}/g) || []).length;
    const priceJsonMatches = (html.match(/"price"\s*:\s*"?\d{1,4}[,.]\d{2}/g) || []).length;
    const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
    const hasConsentWall = /cookie[- ]?consent|accetta (tutti i )?cookie|i understand|accept cookies/i.test(html);
    const isGeoBlock = /not available in your (country|region)|geo[- ]?blocked/i.test(html);

    let ndInfo: Record<string, unknown> | null = null;
    if (nd) {
      const ndText = nd[1];
      ndInfo = {
        length: ndText.length,
        has_listings_key: /\"(listings|articles|offers|products)\"/i.test(ndText),
        has_price_key: /\"(price|priceGross|sellPrice|minPrice)\"/i.test(ndText),
        sample_head: ndText.substring(0, 300),
      };
      // Prova un parse grezzo per vedere chiavi top-level
      try {
        const parsed = JSON.parse(ndText);
        const pageProps = (parsed as { props?: { pageProps?: unknown } }).props?.pageProps;
        if (pageProps && typeof pageProps === 'object') {
          ndInfo.pageProps_keys = Object.keys(pageProps).slice(0, 20);
        }
      } catch { /* */ }
    }

    // Estrai un sample della prima article-row trovata (max 1500 chars)
    // per permettere di verificare il markup reale senza re-scrape manuale
    const rowSampleMatch = html.match(/<div[^>]*class="[^"]*article-row[^"]*"[^>]*>([\s\S]{0,1500})/i);
    const rowSample = rowSampleMatch ? rowSampleMatch[0].substring(0, 1500) : null;

    baseResp.debug = {
      http_status: status,
      html_length: html.length,
      has_next_data: !!nd,
      next_data_info: ndInfo,
      article_row_matches: rowMatches,
      price_json_matches: priceJsonMatches,
      euro_symbol_matches: euroMatches,
      page_title: titleMatch ? titleMatch[1].trim().substring(0, 80) : null,
      has_consent_wall: hasConsentWall,
      is_geo_block: isGeoBlock,
      html_head_500: html.substring(0, 500),
      article_row_sample: rowSample,
    };
  }

  return json(baseResp);
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
  // Pattern più robusto per CM 2024+: non dipende da <table>/<article> come
  // boundary. Usa lookahead alla prossima article-row OR fine di un container
  // noto (article-table / col-offer-close / section / main).
  const rowPattern = /<div[^>]*class="[^"]*article-row[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*article-row|<\/section|<\/main|<div[^>]*class="[^"]*(?:article-table-footer|pagination|loadMore))/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowPattern.exec(html)) !== null) {
    const row = rowMatch[1];
    const cond = extractConditionFromRow(row);
    const price = extractPriceFromRow(row);
    const comment = extractCommentFromRow(row);
    const grading = comment ? parseGradingFromText(comment) : null;
    if (price) {
      // Se non riesco a estrarre la condizione assumo NM (comune per CM raw listings)
      const finalCond = cond || 'Near Mint';
      const listing: Listing = { price, condition: finalCond, condRank: COND_ORDER[finalCond] || 2 };
      if (comment) listing.comment = comment;
      if (grading) listing.grading = grading;
      listings.push(listing);
    }
  }
  if (listings.length > 0) return listings.slice(0, 30).sort((a,b) => a.price - b.price);

  const pricePattern = /"price"\s*:\s*"?(\d{1,4}[,.]?\d{0,3}[,.]\d{2})"?/g;
  let m: RegExpExecArray | null;
  const seen = new Set<number>();
  while ((m = pricePattern.exec(html)) !== null) {
    const n = parsePrice(m[1]);
    if (n && n >= 0.1 && n <= 9999 && !seen.has(n)) {
      seen.add(n);
      listings.push({ price: n, condition: 'Near Mint', condRank: 2 });
    }
  }
  if (listings.length > 0) return listings.slice(0, 30).sort((a,b) => a.price - b.price);

  // Fallback ambidestro: € prima O dopo il numero
  const euroPatterns = [
    /€\s*(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})/g,
    /(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})\s*(?:&nbsp;|&#160;|\u00a0|\s)*€/g,
  ];
  for (const ep of euroPatterns) {
    while ((m = ep.exec(html)) !== null) {
      const n = parsePrice(m[1]);
      if (n && n >= 0.1 && n <= 9999 && !seen.has(n)) {
        seen.add(n);
        listings.push({ price: n, condition: 'Near Mint', condRank: 2 });
      }
    }
  }
  return listings.slice(0, 30).sort((a, b) => a.price - b.price);
}

// Estrae il commento/nota del seller dalla row CM. La struttura tipica è:
//  <span class="article-comments">[testo del commento]</span>
// oppure attributi tooltip / data-bs-title sul container del commento.
// Limitiamo a 200 char per sicurezza.
function extractCommentFromRow(row: string): string | null {
  // Strategia A: classe article-comments (CM v2024+)
  const cmtPats = [
    /<span[^>]*class="[^"]*article-comments[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
    /<div[^>]*class="[^"]*article-comments[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<span[^>]*class="[^"]*product-comments[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
    /<span[^>]*class="[^"]*comment[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
    /<small[^>]*class="[^"]*comment[^"]*"[^>]*>([\s\S]*?)<\/small>/i,
  ];
  for (const rx of cmtPats) {
    const m = row.match(rx);
    if (m) {
      const txt = rowToText(m[1]);
      if (txt && txt.length > 0 && txt.length < 300) return txt;
    }
  }
  // Strategia B: attributi tooltip/title con commento (data-bs-title quando il
  // commento è troncato in UI ma riportato in tooltip)
  const tooltipPats = [
    /data-bs-(?:title|content)="([^"]{2,200})"/gi,
    /(?:title|aria-label)="([^"]{5,200})"/gi,
  ];
  for (const rx of tooltipPats) {
    let m: RegExpExecArray | null;
    rx.lastIndex = 0;
    while ((m = rx.exec(row)) !== null) {
      const txt = m[1].trim();
      // Skip tooltips che sono in realtà condizioni/lingue note (escludi label generiche)
      if (/^(Mint|Near Mint|Excellent|Good|Light Played|Played|Poor|Italian|English|Japanese|German|French|Spanish|Portuguese|Korean|Chinese|Russian|Italiano|Inglese|Reverse Holo|Foil|Holo|First Edition|1st Edition)$/i.test(txt)) continue;
      // Se il testo contiene un grading marker o un commento sostanzioso, prendilo
      if (parseGradingFromText(txt) || (txt.length > 8 && /[a-zA-Z]/.test(txt))) {
        return txt;
      }
    }
  }
  return null;
}

// Riconosce indicatori di grading nei commenti CM o nei titoli eBay.
// Casi gestiti: "PSA 9", "PSA-9", "PSA9", "BGS 8.5", "CGC 10", "CGC10",
// "SGC 9", "HGA 9.5", "GMA 8", "TAG 10", "ARS 9", "GG 9".
// Restituisce { house, score, raw } oppure null.
function parseGradingFromText(text: string): { house: string; score: number; raw: string } | null {
  if (!text) return null;
  // Normalizza: rimuovi caratteri non utili ma preserva spazi, punti e trattini
  const norm = text.replace(/\s+/g, ' ').trim();
  // House aliases (sinonimi/varianti) — riga: alias → casa canonica
  const houseAliases: Array<[RegExp, string]> = [
    [/\bPSA\b/i, 'PSA'],
    [/\bBGS\b/i, 'BGS'],
    [/\bBeckett\b/i, 'BGS'],
    [/\bCGC\b/i, 'CGC'],
    [/\bSGC\b/i, 'SGC'],
    [/\bHGA\b/i, 'HGA'],
    [/\bGMA\b/i, 'GMA'],
    [/\bTAG\b/i, 'TAG'],
    [/\bARS\b/i, 'ARS'],
    [/\bGetGraded\b/i, 'GG'],
    [/\bGG\b/i, 'GG'],
  ];
  for (const [rx, house] of houseAliases) {
    if (!rx.test(norm)) continue;
    // Cerca un punteggio entro 6 caratteri dalla casa, con vari separatori (-, spazio, niente, punto)
    // Pattern: HOUSE [sep] SCORE — score può essere intero (1-10) o decimale (es 8.5, 9.5)
    const houseStr = house === 'BGS' ? '(?:BGS|Beckett)'
                   : house === 'GG'  ? '(?:GG|GetGraded)'
                   : house;
    // Punteggi: 10, 9.5, 9, 8.5, 8, 7.5, 7, 6.5, 6, 5.5, 5, 4.5, 4, 3, 2, 1
    const scorePat = new RegExp('\\b' + houseStr + '\\s*[-:.\\s]?\\s*(10(?:\\.0)?|[1-9](?:\\.5)?)\\b', 'i');
    const m = norm.match(scorePat);
    if (m) {
      const score = parseFloat(m[1]);
      if (score >= 1 && score <= 10) {
        return { house, score, raw: m[0].trim() };
      }
    }
  }
  return null;
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
          // Estrai eventuale commento dalle chiavi note del NEXT_DATA
          const cmtField = i.comments ?? i.comment ?? i.description ?? i.note ?? i.sellerComment;
          const comment = cmtField ? String(cmtField).trim().substring(0, 300) : null;
          const grading = comment ? parseGradingFromText(comment) : null;
          const listing: Listing = { price: Math.round(price * 100) / 100, condition: cond, condRank };
          if (comment) listing.comment = comment;
          if (grading) listing.grading = grading;
          listings.push(listing);
        }
        if (listings.length > 0) return listings.sort((a,b) => a.price - b.price).slice(0, 30);
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

// Normalizza l'HTML della row in plain text utilizzabile: rimuove tag, decodifica
// entità comuni (&nbsp; → spazio, &euro; → €, etc) e collassa gli spazi.
function rowToText(row: string): string {
  return row
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;|\u00a0/g, ' ')
    .replace(/&euro;|&#8364;/g, '€')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// Mappe canoniche per condizione (full name ← abbreviation, parola singola, ecc)
const COND_MAP_FULL: Record<string, string> = {
  'mint':'Mint','near mint':'Near Mint','excellent':'Excellent','good':'Good',
  'light played':'Light Played','played':'Played','poor':'Poor',
  'nm':'Near Mint','ex':'Excellent','gd':'Good','lp':'Light Played','pl':'Played','po':'Poor','mt':'Mint',
  // Traduzioni locali comuni (IT/DE/FR)
  'perfetto':'Mint','quasi perfetto':'Near Mint','ottimo':'Excellent','buono':'Good',
  'giocato leggermente':'Light Played','giocato':'Played','rovinato':'Poor',
};

function normalizeCondFromLabel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const k = raw.toLowerCase().trim();
  return COND_MAP_FULL[k] ?? null;
}

// Estrae condizione da una row: cerca (a) tooltip / aria-label / title attribute,
// (b) testo nei badge class, (c) pattern testuale plain nel contenuto.
function extractConditionFromRow(row: string): string | null {
  // Strategia A: attributi tooltip/title/aria-label (CM v2024+ usa data-bs-title)
  const attrPats = [
    /(?:title|aria-label|data-bs-title|data-original-title)="([^"]+)"/gi,
  ];
  for (const rx of attrPats) {
    let m: RegExpExecArray | null;
    rx.lastIndex = 0;
    while ((m = rx.exec(row)) !== null) {
      const txt = m[1];
      // Match esatto o contenuto della label
      const cond = normalizeCondFromLabel(txt);
      if (cond) return cond;
      // Fallback: cerca una parola-chiave dentro un testo lungo
      const found = txt.match(/\b(Mint|Near Mint|Excellent|Good|Light Played|Played|Poor)\b/i);
      if (found) return normalizeCondFromLabel(found[1]) ?? null;
    }
  }
  // Strategia B: testo plain dentro elementi badge
  const badgeRe = /<(?:span|abbr|div)[^>]*class="[^"]*(?:badge|condition|cond-)[^"]*"[^>]*>([\s\S]*?)<\/(?:span|abbr|div)>/gi;
  let bm: RegExpExecArray | null;
  while ((bm = badgeRe.exec(row)) !== null) {
    const inner = bm[1].replace(/<[^>]+>/g, '').trim();
    const cond = normalizeCondFromLabel(inner);
    if (cond) return cond;
  }
  // Strategia C: class hint (es. "badge-nm", "condition-excellent")
  const clsMatch = row.match(/\b(?:badge-|condition-|cond-)([a-z]+(?:-[a-z]+)?)/i);
  if (clsMatch) {
    const cond = normalizeCondFromLabel(clsMatch[1].replace('-', ' '));
    if (cond) return cond;
  }
  // Strategia D: testo full
  const plainText = rowToText(row);
  const plainMatch = plainText.match(/\b(Near Mint|Light Played|Mint|Excellent|Good|Played|Poor|NM|EX|GD|LP|PL|PO|MT)\b/);
  if (plainMatch) return normalizeCondFromLabel(plainMatch[1]);
  return null;
}

// Estrae il prezzo da una row: strip HTML + regex su testo normalizzato.
// Accetta € prima (€ 12,34) o dopo (12,34 €), con separatore , o .
function extractPriceFromRow(row: string): number | null {
  const text = rowToText(row);
  // Pattern ambidestro: 12,34 € | 12.34 € | € 12,34 | 1.234,56 € | 1,234.56 $
  // Il gruppo numerico supporta migliaia sia con . che ,
  const pats = [
    /(\d{1,3}(?:[.,]\d{3})+[.,]\d{2})\s*€/,         // 1.234,56 € o 1,234.56 €
    /(\d{1,4}[.,]\d{2})\s*€/,                         // 12,34 € o 12.34 €
    /€\s*(\d{1,3}(?:[.,]\d{3})+[.,]\d{2})/,           // € 1.234,56
    /€\s*(\d{1,4}[.,]\d{2})/,                         // € 12,34
  ];
  for (const p of pats) {
    const m = text.match(p);
    if (m) {
      const n = parsePrice(m[1]);
      if (n != null && n >= 0.05 && n < 10000) return n;
    }
  }
  return null;
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
interface GradeListingData {
  median: number;
  count: number;
  min?: number;
  max?: number;
  currency_symbol: string;
  confidence: 'high' | 'medium' | 'low';  // basato su count: ≥10 high, 3-9 medium, 1-2 low
}

interface PCPrices {
  ungraded?: number;
  grade7?: number;
  grade8?: number;
  grade9?: number;
  grade9_5?: number;
  psa10?: number;
  bgs10?: number;
  cgc10?: number;
  // Mediana dei sold listings eBay per qualsiasi coppia casa+grade
  // Chiave: "PSA_8", "BGS_9.5", "CGC_10", "SGC_9"...
  grades_from_listings?: Record<string, GradeListingData>;
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
    // Deduce la currency effettiva della pagina dal simbolo dominante nei listings
    prices.currency = detectDominantCurrency(prices);

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
  prices.currency = detectDominantCurrency(prices);

  return json({ source: 'pricecharting', prices, url: productUrl });
}

// Determina la valuta della pagina PC dal simbolo dominante nei sold listings
// (che abbiamo già estratto via extractAllGradesFromListingsOnePass).
// Se non ci sono listings, fallback a USD.
function detectDominantCurrency(prices: PCPrices): string {
  if (!prices.grades_from_listings) return 'USD';
  const symbolCounts: Record<string, number> = {};
  for (const key of Object.keys(prices.grades_from_listings)) {
    const sym = prices.grades_from_listings[key].currency_symbol;
    symbolCounts[sym] = (symbolCounts[sym] || 0) + prices.grades_from_listings[key].count;
  }
  const entries = Object.entries(symbolCounts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return 'USD';
  const dominant = entries[0][0];
  if (dominant === '€') return 'EUR';
  if (dominant === '£') return 'GBP';
  return 'USD';
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

  // Estrai numero carta dall'hint (formato "Nome 106" o "Nome #106" o "Nome 106/130")
  const numMatch = hint.match(/(?:^|\s)#?(\d{1,3})(?:\/\d+)?(?:\s|$)/);
  const cardNum = numMatch ? numMatch[1] : null;

  // Pattern di prodotti sigillati / non-singoli da penalizzare
  const SEALED_PAT = /(?:booster-box|booster-pack|theme-deck|starter-deck|deck-box|bundle|collection-box|tin|elite-trainer|etb|blister|sleeved|binder|booster(?:-display)?|promo-box|gift-box|japanese-booster|jumbo-pack|mini-tin)/i;
  const INDEX_PAT  = /(?:\/game\/pokemon-cards\/?$|\/pokemon-card-singles\/?$|prices\/singles\/?$)/i;

  // Scoring basato su hint + pokemon + penalità sealed
  for (const c of candidates) {
    const lowerPath  = c.raw_path.toLowerCase();
    const lowerTitle = c.title.toLowerCase();

    // Penalità forti — queste non sono carte singole
    if (SEALED_PAT.test(lowerPath) || SEALED_PAT.test(lowerTitle)) c.score -= 50;
    if (INDEX_PAT.test(lowerPath)) c.score -= 100;

    // Deve essere Pokémon
    if (/pokemon/i.test(c.raw_path) || /pokemon/i.test(c.title)) c.score += 10;

    // Match su parole dell'hint (nome carta + set)
    for (const w of hintWords) {
      if (lowerTitle.includes(w)) c.score += 3;
      if (lowerPath.includes(w))  c.score += 2;
    }

    // Bonus forte per match numero carta: cerca "-106" / "-106-" / "#106" / "_106"
    if (cardNum) {
      const numPats = [
        new RegExp('[-_/#]' + cardNum + '(?:[-_/]|$)'),
        new RegExp('\\b' + cardNum + '\\b'),
      ];
      for (const p of numPats) {
        if (p.test(lowerPath))  { c.score += 15; break; }
        if (p.test(lowerTitle)) { c.score += 12; break; }
      }
    }

    // Bonus se path usa pattern canonico /game/pokemon-{set}/{card}-{num}
    if (/^\/game\/pokemon-[a-z0-9-]+\/[a-z0-9-]+/i.test(c.raw_path)) c.score += 5;
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!/pokemon/i.test(best.raw_path) && !/pokemon/i.test(best.title)) return null;
  // Refuse se il best ha score negativo (probabilmente tutti sealed/index)
  if (best.score < 0) return null;
  return { url: best.url, title: best.title };
}

type PCPriceKey = 'ungraded'|'grade7'|'grade8'|'grade9'|'grade9_5'|'psa10'|'bgs10'|'cgc10';

// Parse "Summary Block" PC: sequenza label→prezzo come
// "Grade 7 $285.05 Grade 8 $955.22 Grade 9 $1,589.03 Grade 9.5 $1,748.00"
//
// IMPORTANTE: il summary block NON contiene PSA 10 / BGS 10 / CGC 10 per le carte Pokémon.
// Quelle label compaiono nell'HTML come header colonna (con prezzo Ungraded adiacente) e come
// qualifier di "Sold Listings" eBay, ma mai come coppia label→prezzo-di-mercato.
// Quindi questa funzione popola SOLO: ungraded, grade7, grade8, grade9, grade9_5.
//
// Per PSA/BGS/CGC 10 serve extractGradedSoldListings.
function extractFromSummaryBlock(html: string, out: PCPrices): void {
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#43;/g, '+')
    .replace(/\s+/g, ' ');

  const patterns: Array<{ rx: RegExp; key: PCPriceKey }> = [
    { rx: /Grade\s*9\.5\s+\$\s*([\d,]+(?:\.\d{2})?)/g, key: 'grade9_5' },
    { rx: /Grade\s*9(?!\.)\s+\$\s*([\d,]+(?:\.\d{2})?)/g, key: 'grade9' },
    { rx: /Grade\s*8\s+\$\s*([\d,]+(?:\.\d{2})?)/g, key: 'grade8' },
    { rx: /Grade\s*7\s+\$\s*([\d,]+(?:\.\d{2})?)/g, key: 'grade7' },
    { rx: /Ungraded\s+\$\s*([\d,]+(?:\.\d{2})?)/g, key: 'ungraded' },
  ];

  for (const { rx, key } of patterns) {
    const matches: Array<{ price: number; pos: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = rx.exec(text)) !== null) {
      const n = parsePrice(m[1]);
      if (n != null && n > 0) matches.push({ price: n, pos: m.index });
      if (matches.length > 15) break;
    }
    if (matches.length === 0) continue;

    // Strategia scelta:
    // - 1 match → prendi quello
    // - 2+ match → mediana: robusta contro header (primo) e sold listings singoli (ultimi)
    //   che hanno variazione naturale. Il summary block è tipicamente al centro.
    let chosen: number;
    if (matches.length === 1) {
      chosen = matches[0].price;
    } else {
      const prices = matches.map(x => x.price).sort((a, b) => a - b);
      chosen = prices[Math.floor(prices.length / 2)];
    }
    out[key] = chosen;
  }
}

// Estrae mediana dei primi N "Sold Listings" eBay per un grade specifico.
// PC pubblica (per ogni carta Pokémon) una sezione tipo:
//   PSA 10 Gem Mint [eBay] $16,400.00
//   PSA 10 Gem Mint #106 [eBay] $15,000.00
//   PSA 10 Gem Mint [eBay] $12,100.00
//   PSA 10 GEM MINT POP 17 [eBay] $5,499.99
//
// Questi sono prezzi di vendita reali, affidabili. Prendiamo i primi 10,
// scartiamo outlier IQR e ritorniamo la mediana.
// Scan single-pass dell'HTML normalizzato per estrarre tutte le coppie
// (HOUSE, SCORE, PREZZO) dai sold listings eBay. Molto più efficiente che
// eseguire N regex separati per ogni combinazione casa+grade.
function extractAllGradesFromListingsOnePass(html: string): Record<string, GradeListingData> {
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#43;/g, '+')
    .replace(/\s+/g, ' ');

  // Pattern unico: (HOUSE) (SCORE) [qualifier] ([eBay|TCGPlayer|Fanatics]) (SYM)(PRICE)
  // Negative lookahead per escludere varianti speciali più prestigiose che PC elenca separatamente:
  // - "BGS 10 Black" è un grade BGS Black Label (diverso da BGS 10 normale)
  // - "CGC 10 Pristine" / "CGC 10 Prist." è CGC Pristine 10 (diverso da CGC 10 normale)
  // Senza questo lookahead il regex matcherebbe "BGS 10" dentro "BGS 10 Black $3,051,430"
  // catturando il prezzo della variante speciale.
  // Il qualifier tra casa+score e il prezzo non deve contenere valute (limita false positive).
  const rx = /\b(PSA|BGS|CGC|SGC|HGA|GMA|TAG|ARS|ACE)\s*(10|9\.5|9|8\.5|8|7\.5|7|6|5|4|3|2|1)\b(?!\s+(?:Black|Pristine|Prist\.))[^$€£]{0,150}?(?:\[(?:eBay|TCGPlayer|Fanatics)\])?\s*([\$€£])\s*([\d,]+(?:[.,]\d{2})?)/gi;

  // Aggrega tutti i match per chiave HOUSE_SCORE
  const buckets: Record<string, { prices: number[]; symbols: string[] }> = {};
  let m: RegExpExecArray | null;
  let iters = 0;
  while ((m = rx.exec(text)) !== null && iters < 2000) {
    iters++;
    const house = m[1].toUpperCase();
    const score = m[2];
    const sym = m[3];
    let raw = m[4];
    if (raw.indexOf(',') >= 0 && raw.indexOf('.') >= 0) {
      if (raw.lastIndexOf('.') > raw.lastIndexOf(',')) raw = raw.replace(/,/g, '');
      else raw = raw.replace(/\./g, '').replace(',', '.');
    } else if (raw.indexOf(',') >= 0) {
      const parts = raw.split(',');
      if (parts.length === 2 && parts[1].length === 2) raw = raw.replace(',', '.');
      else raw = raw.replace(/,/g, '');
    }
    const n = parseFloat(raw);
    if (isNaN(n) || n <= 0) continue;

    const key = `${house}_${score}`;
    if (!buckets[key]) buckets[key] = { prices: [], symbols: [] };
    if (buckets[key].prices.length < 20) {
      buckets[key].prices.push(n);
      buckets[key].symbols.push(sym);
    }
  }

  // Per ogni bucket calcola mediana con IQR filter + raccoglie metadati
  const out: Record<string, GradeListingData> = {};
  for (const key of Object.keys(buckets)) {
    const { prices, symbols } = buckets[key];
    if (prices.length === 0) continue;
    const symCounts: Record<string, number> = {};
    for (const s of symbols) symCounts[s] = (symCounts[s] || 0) + 1;
    const dominantSym = Object.keys(symCounts).sort((a, b) => symCounts[b] - symCounts[a])[0];

    let filtered = prices.slice().sort((a, b) => a - b);
    if (filtered.length >= 4) {
      const q1 = filtered[Math.floor(filtered.length * 0.25)];
      const q3 = filtered[Math.floor(filtered.length * 0.75)];
      const iqr = q3 - q1;
      const lo = q1 - 1.5 * iqr;
      const hi = q3 + 1.5 * iqr;
      const f = filtered.filter(p => p >= lo && p <= hi);
      if (f.length >= 2) filtered = f;
    }
    const median = filtered[Math.floor(filtered.length / 2)];
    const count = filtered.length;
    const confidence: 'high' | 'medium' | 'low' =
      count >= 10 ? 'high' : (count >= 3 ? 'medium' : 'low');
    out[key] = {
      median,
      count,
      min: filtered[0],
      max: filtered[filtered.length - 1],
      currency_symbol: dominantSym,
      confidence,
    };
  }
  return out;
}


//
// PriceCharting pubblica per ogni carta una sezione per ogni grade con fino a ~30 vendite storiche:
//   "PSA 8 2012 FA/Groudon Ex ... [eBay] $727.78"
//   "Pokemon Groudon EX Dark Explorers Full Art #106 PSA 8 [eBay] $1,027.47"
//   ...
//
// NOTA: PC serve i prezzi nella valuta del visitatore (€ per IT, $ per US).
// Il parser accetta entrambe e la currency detection è fatta dal chiamante.
//
// Ritorna { median, count, prices, currency_symbol } o null se nessuna vendita trovata.
interface GradedListings {
  median: number;
  count: number;
  prices: number[];
  currency_symbol: string;
  raw_count: number;   // prima di IQR
}

function extractGradedFromSoldListings(html: string, label: string, maxSamples = 15): GradedListings | null {
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#43;/g, '+')
    .replace(/\s+/g, ' ');

  const lblEsc = label.replace(/\s+/g, '\\s*').replace('.', '\\.');

  // Pattern accetta $ o € o £ (PC serve valuta in base a geolocalizzazione visitatore).
  // "\[eBay\]" opzionale per catturare anche listing senza qualifier.
  const rx = new RegExp(
    `${lblEsc}\\b[^$€£]{0,150}?(?:\\[(?:eBay|TCGPlayer|Fanatics)\\])?\\s*([\\$€£])\\s*([\\d,]+(?:[.,]\\d{2})?)`,
    'gi'
  );

  const prices: number[] = [];
  const symbols: string[] = [];
  let m: RegExpExecArray | null;
  let rawCount = 0;
  while ((m = rx.exec(text)) !== null && rawCount < maxSamples * 2) {
    rawCount++;
    const sym = m[1];
    // parsePrice gestisce formato US (1,027.47) ma non EU (1.027,47).
    // Normalizzo il numero prima di parsePrice:
    let raw = m[2];
    // Se contiene sia , che . : "1,027.47" è US (, migliaia, . decimali), "1.027,47" è EU
    if (raw.indexOf(',') >= 0 && raw.indexOf('.') >= 0) {
      if (raw.lastIndexOf('.') > raw.lastIndexOf(',')) {
        // US format: rimuovi le virgole
        raw = raw.replace(/,/g, '');
      } else {
        // EU format: rimuovi i punti, virgola → punto
        raw = raw.replace(/\./g, '').replace(',', '.');
      }
    } else if (raw.indexOf(',') >= 0) {
      // Solo virgola: se è seguita da 2 cifre finali, è decimale EU
      const parts = raw.split(',');
      if (parts.length === 2 && parts[1].length === 2) raw = raw.replace(',', '.');
      else raw = raw.replace(/,/g, '');  // virgole come separatore migliaia
    }
    const n = parseFloat(raw);
    if (isNaN(n) || n <= 0) continue;
    prices.push(n);
    symbols.push(sym);
    if (prices.length >= maxSamples) break;
  }

  if (prices.length === 0) return null;
  // Simbolo dominante (in genere tutti uguali)
  const symCounts: Record<string, number> = {};
  for (const s of symbols) symCounts[s] = (symCounts[s] || 0) + 1;
  const dominantSym = Object.keys(symCounts).sort((a, b) => symCounts[b] - symCounts[a])[0];

  if (prices.length === 1) {
    return { median: prices[0], count: 1, prices, currency_symbol: dominantSym, raw_count: prices.length };
  }

  // IQR outlier removal
  const sorted = prices.slice().sort((a, b) => a - b);
  let filtered = sorted;
  if (sorted.length >= 4) {
    const q1 = sorted[Math.floor(sorted.length * 0.25)];
    const q3 = sorted[Math.floor(sorted.length * 0.75)];
    const iqr = q3 - q1;
    const lo = q1 - 1.5 * iqr;
    const hi = q3 + 1.5 * iqr;
    const f = sorted.filter(p => p >= lo && p <= hi);
    if (f.length >= 2) filtered = f;
  }
  const median = filtered[Math.floor(filtered.length / 2)];
  return { median, count: filtered.length, prices: filtered, currency_symbol: dominantSym, raw_count: prices.length };
}






// Estrae prezzi da pagina prodotto PriceCharting.
//
// Strategia a due livelli (diagnostica 2026-04-24):
//
// 1) SUMMARY BLOCK (fonte primaria): PC pubblica in ~pos 415000-843000 una
//    sequenza lineare "Grade 7 $X Grade 8 $X Grade 9 $X Grade 9.5 $X ..."
//    e poco dopo "CGC 10 $X PSA 10 $X BGS 10 $X". Associazione 1:1 label→prezzo,
//    zero ambiguità. Questa è la quotazione ufficiale PC.
//
// 2) LABEL ADIACENTE (fallback): cerca pattern "PSA 10 ... $X" nei primi 200
//    char. Meno affidabile perché la label compare più volte nella pagina
//    (header tabella, sold-listings eBay, POP report) e il primo $ non sempre
//    è quello corrispondente. Usato solo se summary block non ha trovato il
//    campo specifico.
//
// NOTA: gli ID HTML di PC (used_price, complete_price, new_price,
// graded_price, box_only_price, manual_only_price, bgs_10_price) sono
// ereditati dalla struttura video-games e sono semanticamente inaffidabili
// per le carte Pokémon — NON USARLI.
function extractPCPrices(html: string): PCPrices {
  const out: PCPrices = {};

  // ─ STRATEGIA 1: Summary Block per Ungraded + Grade 7/8/9/9.5 ─────────
  extractFromSummaryBlock(html, out);

  // ─ STRATEGIA 2: Sold Listings eBay — single-pass scan per casa+grade ──
  // Invece di 81 regex execution (9 case × 9 score) scansioniamo UNA sola volta
  // l'HTML normalizzato cercando qualsiasi coppia HOUSE+SCORE+prezzo, poi
  // aggreghiamo i risultati per chiave. Resource-efficient per Supabase.
  const gradesFromListings = extractAllGradesFromListingsOnePass(html);
  if (Object.keys(gradesFromListings).length) out.grades_from_listings = gradesFromListings;

  // Per retro-compatibilità popola anche i campi top-level psa10/bgs10/cgc10
  if (gradesFromListings['PSA_10']) out.psa10 = gradesFromListings['PSA_10'].median;
  if (gradesFromListings['BGS_10']) out.bgs10 = gradesFromListings['BGS_10'].median;
  if (gradesFromListings['CGC_10']) out.cgc10 = gradesFromListings['CGC_10'].median;

  // ─ STRATEGIA 3: fallback label-based se ancora qualcosa manca ────────
  // Solo per grade_raw mancanti dallo step 1
  const labelPatterns: Array<{ rx: RegExp; key: PCPriceKey }> = [
    { rx: /Grade\s*9\.5\s*(?:&nbsp;|\s)*\$\s*([\d,]+(?:\.\d{2})?)/i, key: 'grade9_5' },
    { rx: /Grade\s*9(?!\.)\s*(?:&nbsp;|\s)*\$\s*([\d,]+(?:\.\d{2})?)/i, key: 'grade9' },
    { rx: /Grade\s*8\s*(?:&nbsp;|\s)*\$\s*([\d,]+(?:\.\d{2})?)/i, key: 'grade8' },
    { rx: /Grade\s*7\s*(?:&nbsp;|\s)*\$\s*([\d,]+(?:\.\d{2})?)/i, key: 'grade7' },
    { rx: /Ungraded\s*(?:&nbsp;|\s)*\$\s*([\d,]+(?:\.\d{2})?)/i, key: 'ungraded' },
  ];
  for (const { rx, key } of labelPatterns) {
    if (out[key] != null) continue;
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

  // Trend 12 mesi — pattern su label "1 year"/"12 month"/"yearly"
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
interface EbayItem { price: number; title: string; currency: string; }
interface EbaySoldResult {
  prices: number[];
  items?: EbayItem[];     // prezzo + titolo per ogni venduto (per filtri lato client)
  median?: number;
  avg?: number;
  min?: number;
  max?: number;
  count: number;
  currency: string;
  outliersRemoved?: number;
}

async function handleEbaySoldCascade(urls: string[], minHits: number, merge = false): Promise<Response> {
  const attempts: Array<{ url: string; count: number; median?: number; error?: string }> = [];
  let best: (EbaySoldResult & { url: string }) | null = null;

  // ─── MERGE MODE ──
  // Esegue TUTTE le query, accumula gli items unici (dedup per title+price+currency)
  // e ricalcola le statistiche aggregate. Pensato per quando il client vuole
  // massimizzare il sample combinando query specifiche e larghe.
  if (merge) {
    type Key = string;
    const seen = new Set<Key>();
    const merged: EbayItem[] = [];
    let primaryCurrency: string | null = null;
    const perQueryCounts: Array<{ url: string; raw: number; new: number }> = [];

    for (let i = 0; i < urls.length; i++) {
      let u = urls[i];
      if (!/LH_Sold=1/.test(u))     u += (u.includes('?') ? '&' : '?') + 'LH_Sold=1';
      if (!/LH_Complete=1/.test(u)) u += '&LH_Complete=1';

      const host = new URL(u).host;
      const { html, ok, status } = await fetchWithRetry(u, 1, `https://${host}/`);
      if (!ok) {
        attempts.push({ url: u, count: 0, error: `HTTP ${status}` });
        perQueryCounts.push({ url: u, raw: 0, new: 0 });
        continue;
      }

      const currency = /ebay\.com\//.test(u) ? 'USD'
        : /ebay\.co\.uk/.test(u) ? 'GBP'
        : 'EUR';
      if (!primaryCurrency) primaryCurrency = currency;

      const result = extractEbayPrices(html, currency);
      attempts.push({ url: u, count: result.count, median: result.median });

      // Se abbiamo items strutturati, dedup per (titleNormalized, price, currency).
      // Altrimenti fallback: usa solo prezzi (key = price+currency, meno preciso).
      let added = 0;
      if (result.items && result.items.length) {
        for (const it of result.items) {
          const titleKey = it.title.toLowerCase().replace(/\s+/g, ' ').trim().substring(0, 80);
          const k: Key = titleKey + '||' + it.price.toFixed(2) + '||' + it.currency;
          if (!seen.has(k)) { seen.add(k); merged.push(it); added++; }
        }
      } else {
        for (const p of result.prices) {
          const k: Key = '__noTitle__||' + p.toFixed(2) + '||' + currency;
          if (!seen.has(k)) {
            seen.add(k);
            merged.push({ price: p, title: '', currency });
            added++;
          }
        }
      }
      perQueryCounts.push({ url: u, raw: result.count, new: added });
    }

    // Calcola statistiche aggregate sul merged set, in valuta primaria (per backward compat)
    if (merged.length === 0) {
      return json({
        source: 'ebay_sold',
        url: urls[urls.length-1] || '',
        attempts,
        prices: [],
        items: [],
        count: 0,
        currency: primaryCurrency || 'EUR',
        merge: true,
        per_query: perQueryCounts,
        error: 'nessun venduto su '+urls.length+' tentativi',
      });
    }

    // Per la mediana del campione aggregato usiamo i prezzi nella valuta primaria
    // (per query mixed currency, il client farà la conversione fine via items[].currency).
    const allPrices = merged.map(it => it.price).sort((a,b) => a - b);
    const mid = Math.floor(allPrices.length / 2);
    const median = allPrices.length % 2 === 0
      ? Math.round(((allPrices[mid - 1] + allPrices[mid]) / 2) * 100) / 100
      : allPrices[mid];
    const avg = Math.round((allPrices.reduce((a,b) => a+b, 0) / allPrices.length) * 100) / 100;

    return json({
      source: 'ebay_sold',
      url: urls[0],
      attempts,
      merge: true,
      per_query: perQueryCounts,
      prices: allPrices.slice(0, 60),
      items: merged.slice(0, 100),
      median,
      avg,
      min: allPrices[0],
      max: allPrices[allPrices.length-1],
      count: merged.length,
      currency: primaryCurrency || 'EUR',
    });
  }

  // ─── CASCADE MODE (default originale) ──
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
  // ─── PHASE 1: s-item container extraction (title + price as a pair) ───
  // Cerca <li class="s-item ..."> ... </li> oppure <div class="s-item ...">.
  // Per ogni container, estrai il titolo + il prezzo.
  const items: EbayItem[] = [];
  const containerPat = /<(?:li|div)[^>]*class="[^"]*s-item(?!__)[^"]*"[^>]*>([\s\S]*?)(?=<(?:li|div)[^>]*class="[^"]*s-item(?!__)|<\/ul>|<\/section>|<\/main>)/gi;
  let cm: RegExpExecArray | null;
  while ((cm = containerPat.exec(html)) !== null) {
    const block = cm[1];
    // Salta placeholder/announcement: title contiene "Shop on eBay" o link
    const titleMatch = block.match(/<(?:span|div|h3)[^>]*class="[^"]*s-item__title[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div|h3)>/i)
                    || block.match(/<a[^>]*class="[^"]*s-item__link[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;
    const title = titleMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!title || /^Shop on eBay$/i.test(title) || title.length < 3) continue;

    const priceMatch = block.match(/<span[^>]*class="[^"]*s-item__price[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    if (!priceMatch) continue;
    const priceText = priceMatch[1].replace(/<[^>]+>/g, ' ').trim();
    if (/\bto\b\s+[\$€£]/i.test(priceText) || /\ba\b\s+[\$€£]/i.test(priceText)) continue;

    let p: number | null = null;
    let cur: string = currency;
    const priceProbes: Array<[RegExp, string]> = [
      [/€\s*([\d.]+,\d{2})/, 'EUR'],
      [/€\s*([\d,]+\.\d{2})/, 'EUR'],
      [/EUR\s*([\d.,]+)/i, 'EUR'],
      [/\$\s*([\d,]+\.\d{2})/, 'USD'],
      [/USD\s*([\d.,]+)/i, 'USD'],
      [/£\s*([\d,]+\.\d{2})/, 'GBP'],
      [/GBP\s*([\d.,]+)/i, 'GBP'],
    ];
    for (const [rx, c] of priceProbes) {
      const mm = priceText.match(rx);
      if (mm) {
        const n = parsePrice(mm[1]);
        if (n && n >= 1 && n <= 99999) { p = n; cur = c; break; }
      }
    }
    if (p == null) continue;
    items.push({ price: p, title, currency: cur });
  }

  // ─── PHASE 2: legacy price-only extraction (fallback / supplementary) ───
  const raw: number[] = items.map(it => it.price);
  if (raw.length === 0) {
    const priceBlocks: string[] = [];
    const blockPat = /<span[^>]*class="[^"]*s-item__price[^"]*"[^>]*>([\s\S]*?)<\/span>/gi;
    let m: RegExpExecArray | null;
    while ((m = blockPat.exec(html)) !== null) {
      priceBlocks.push(m[1].replace(/<[^>]+>/g, ' ').trim());
    }
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
          if (n && n >= 1 && n <= 99999) { raw.push(n); break; }
        }
      }
    }
  }

  let m: RegExpExecArray | null;
  if (raw.length === 0) {
    const jsonPricePat = /"convertedCurrentPrice"\s*:\s*\{?[^}]*?"value"\s*:\s*"?([\d.]+)"?/g;
    while ((m = jsonPricePat.exec(html)) !== null) {
      const n = parseFloat(m[1]);
      if (!isNaN(n) && n >= 1 && n <= 99999) raw.push(n);
    }
  }

  if (raw.length === 0) {
    const soldRowPat = /(SOLD|Venduto|Venduti)[\s\S]{0,400}?(?:\$|€|£)\s*([\d.,]+)/gi;
    while ((m = soldRowPat.exec(html)) !== null) {
      const n = parsePrice(m[2]);
      if (n && n >= 1 && n <= 99999) raw.push(n);
    }
  }

  if (raw.length === 0) {
    return { prices: [], count: 0, currency };
  }

  const sorted = raw.slice().sort((a,b) => a - b);
  let filtered: number[];

  if (sorted.length >= 10) {
    // Campione grande: percentile 10-90 (taglia gli estremi, tiene l'80% centrale)
    const p10 = sorted[Math.floor(sorted.length * 0.10)];
    const p90 = sorted[Math.floor(sorted.length * 0.90)];
    filtered = sorted.filter(p => p >= p10 && p <= p90);
  } else if (sorted.length >= 6) {
    // Campione medio: MAD (Median Absolute Deviation) — più robusto dell'IQR
    const med = sorted[Math.floor(sorted.length / 2)];
    const absDevs = sorted.map(p => Math.abs(p - med)).sort((a,b) => a - b);
    const mad = absDevs[Math.floor(absDevs.length / 2)] || (med * 0.1);
    // Soglia 3.5 * MAD (equivalente a ~2.3 sigma in distribuzione normale)
    const lo = med - 3.5 * mad;
    const hi = med + 3.5 * mad;
    filtered = sorted.filter(p => p >= lo && p <= hi);
  } else {
    // Campione piccolo: IQR classico ma più stretto (1.2 invece di 1.5)
    const q1 = sorted[Math.floor(sorted.length * 0.25)];
    const q3 = sorted[Math.floor(sorted.length * 0.75)];
    const iqr = q3 - q1;
    const lo = q1 - 1.2 * iqr;
    const hi = q3 + 1.2 * iqr;
    filtered = sorted.filter(p => p >= lo && p <= hi);
  }
  const outliersRemoved = sorted.length - filtered.length;

  // Se il filtro ha tagliato troppo, fallback al raw sorted
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
    items: items.length > 0 ? items.slice(0, 60) : undefined,
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

    // Prezzi estratti (output principale, quello che userà il frontend)
    cardReport.extracted = extractPCPrices(prod.html);

    // Anomalie automatiche di validazione
    const ex = cardReport.extracted;
    const anomalies: string[] = [];
    // Anomalia PSA10 vs Ungraded: per carte vintage o rare il gap 10× è normale.
    // Solo gap estremi (>50×) indicano potenziale bug di parsing.
    if (ex.psa10 && ex.ungraded && ex.psa10 > 50 * ex.ungraded) anomalies.push(`PSA 10 (${ex.psa10}) > 50× Ungraded (${ex.ungraded}) — sospetto parsing`);
    if (ex.psa10 && ex.grade9 && ex.psa10 < ex.grade9) anomalies.push('PSA 10 < Grade 9 (incoerente)');
    // Rileva combinazioni con campione troppo piccolo
    if (ex.grades_from_listings) {
      let lowCount = 0;
      for (const k of Object.keys(ex.grades_from_listings)) {
        if (ex.grades_from_listings[k].confidence === 'low') lowCount++;
      }
      if (lowCount > 0) anomalies.push(`${lowCount} grade con campione ≤2 vendite`);
    }
    if (anomalies.length) cardReport.anomalies = anomalies;

    report.push(cardReport);
  }

  return json({ source: 'diag', generated_at: new Date().toISOString(), cards: report });
}

// ═════════════════════════════════════════════════════════════════════
//  AUCTION/MARKETPLACE SEARCH SCRAPERS (v6: catawiki/ebay/subito search)
//  Restituiscono items[] con: title, price, currency, image_url, url,
//  end_time?, location?, seller?, is_auction, source
// ═════════════════════════════════════════════════════════════════════

interface SearchItem {
  title: string;
  price: number | null;
  currency: string;
  image_url: string | null;
  url: string;
  end_time: string | null;     // ISO se asta, null se buy-now/raw
  location: string | null;
  seller: string | null;
  is_auction: boolean;
  source: string;
  lot_id?: string | null;
  bids?: number | null;
  shipping?: string | null;
}

function unentity(s: string): string {
  return s.replace(/&amp;/g,'&')
          .replace(/&lt;/g,'<').replace(/&gt;/g,'>')
          .replace(/&quot;/g,'"').replace(/&#39;/g,"'")
          .replace(/&nbsp;/g,' ')
          .replace(/&#x27;/g,"'").replace(/&#x2F;/g,'/')
          .replace(/&#(\d+);/g, (_,n)=>String.fromCharCode(+n));
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
}

function priceFromText(s: string): { price: number|null; currency: string } {
  if (!s) return { price: null, currency: 'EUR' };
  const m = s.match(/(?:€|EUR|\$|USD|£|GBP)\s*([\d.,]+)|([\d.,]+)\s*(?:€|EUR|\$|USD|£|GBP)/i);
  let currency = 'EUR';
  if (/\$|USD/i.test(s)) currency = 'USD';
  else if (/£|GBP/i.test(s)) currency = 'GBP';
  if (!m) {
    const m2 = s.match(/([\d]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?)/);
    if (!m2) return { price: null, currency };
    return { price: normalizeNum(m2[1]), currency };
  }
  const raw = m[1] || m[2] || '';
  return { price: normalizeNum(raw), currency };
}

function normalizeNum(raw: string): number|null {
  if (!raw) return null;
  // Heuristic: se ha sia . che , il separatore decimale è quello più a destra
  const lastDot = raw.lastIndexOf('.');
  const lastComma = raw.lastIndexOf(',');
  let s = raw;
  if (lastDot > -1 && lastComma > -1) {
    if (lastComma > lastDot) s = raw.replace(/\./g,'').replace(',','.');
    else s = raw.replace(/,/g,'');
  } else if (lastComma > -1) {
    // solo virgola: se 2 cifre dopo la virgola → decimale
    if (raw.length - lastComma - 1 === 2) s = raw.replace(',','.');
    else s = raw.replace(/,/g,'');
  } else {
    // solo punto o niente
    if (lastDot > -1 && raw.length - lastDot - 1 === 3) s = raw.replace(/\./g,''); // migliaia
  }
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

// ── CATAWIKI ──────────────────────────────────────────────────────────
//
// Catawiki rende i risultati di ricerca in vari modi:
// 1. JSON API endpoints (buyer/api) — spesso bypassano Cloudflare HTML wall
// 2. __NEXT_DATA__ in HTML
// 3. Fallback HTML anchor pattern
async function handleCatawikiSearch(url: string, debug = false): Promise<Response> {
  // Estrae query e categoria dall'URL HTML originale
  const urlObj = new URL(url);
  const q = urlObj.searchParams.get('q') || '';
  const categoryId = urlObj.searchParams.get('category_id') || '';
  const lang = (urlObj.pathname.match(/^\/([a-z]{2})\//)?.[1]) || 'it';

  const items: SearchItem[] = [];
  const seen = new Set<string>();
  const attempts: Array<{strategy:string; status:number; ok:boolean; items:number; sample?:string}> = [];

  // ── Strategia 1: API JSON buyer/api/v3/lots ─────────────────────────
  if (q) {
    const apiCandidates: Array<{url:string; type:'json'}> = [
      { url: `https://www.catawiki.com/buyer/api/v3/lots?q=${encodeURIComponent(q)}&page=1&per_page=24${categoryId?`&category_id=${categoryId}`:''}`, type: 'json' },
      { url: `https://www.catawiki.com/buyer/api/v2/lots/search?q=${encodeURIComponent(q)}&page=1${categoryId?`&category_id=${categoryId}`:''}`, type: 'json' },
      { url: `https://www.catawiki.com/api/v2/search/lots?q=${encodeURIComponent(q)}${categoryId?`&category_id=${categoryId}`:''}`, type: 'json' },
    ];
    for (const cand of apiCandidates) {
      try {
        const ua = getRandomUA();
        const resp = await fetch(cand.url, {
          headers: {
            'User-Agent': ua,
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': lang === 'it' ? 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7' : 'en-US,en;q=0.9',
            'X-Requested-With': 'XMLHttpRequest',
            'Origin': 'https://www.catawiki.com',
            'Referer': url,
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"Windows"',
          },
        });
        const text = await resp.text();
        attempts.push({ strategy: 'api:'+cand.url.split('?')[0].split('catawiki.com')[1], status: resp.status, ok: resp.ok, items: 0, sample: debug ? text.slice(0, 200) : undefined });
        if (!resp.ok) continue;
        let data: any = null;
        try { data = JSON.parse(text); } catch (_) { continue; }
        const lots = findCatawikiLots(data);
        if (!lots || !lots.length) continue;
        for (const lot of lots) {
          extractCatawikiLot(lot, items, seen);
        }
        if (items.length > 0) {
          attempts[attempts.length-1].items = items.length;
          break; // success
        }
      } catch (e) {
        attempts.push({ strategy: 'api:'+cand.url.split('?')[0].split('catawiki.com')[1], status: 0, ok: false, items: 0, sample: debug ? String(e).slice(0,200) : undefined });
      }
    }
  }

  // ── Strategia 2: HTML page con __NEXT_DATA__ + fallback anchor ──────
  if (items.length === 0) {
    const { html, ok, status } = await fetchWithRetry(url);
    attempts.push({ strategy: 'html', status, ok, items: 0, sample: debug ? html.slice(0,200) : undefined });
    if (!ok || !html) {
      // Tutto fallito: ritorna errore strutturato con suggerimento
      return json({
        error: `Catawiki HTTP ${status}${status === 403 ? ' — Cloudflare blocca l\'edge function' : ''}`,
        items: [], status, source: 'catawiki_search',
        requires_userscript: true,
        manual_url: url,
        hint: 'Catawiki blocca lo scraping server-side. Apri manualmente la ricerca: lo userscript Tampermonkey raccoglierà i risultati. Oppure usa il pulsante "🔗 Apri ricerca" e l\'userscript farà il resto.',
        attempts,
      });
    }
    if (/Just a moment|cf-browser-verification|Attention Required/i.test(html)) {
      return json({
        error: 'Cloudflare challenge attivo',
        items: [], status: 403, source: 'catawiki_search',
        requires_userscript: true,
        manual_url: url,
        attempts,
      });
    }

    // Strategia 2a: __NEXT_DATA__
    try {
      const nd = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (nd) {
        const data = JSON.parse(nd[1]);
        const lots = findCatawikiLots(data);
        for (const lot of lots) extractCatawikiLot(lot, items, seen);
      }
    } catch (_) {}

    // Strategia 2b: anchor HTML pattern
    if (items.length === 0) {
      const anchorRe = /<a[^>]+href="(\/[a-z]{2}\/l\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      let m: RegExpExecArray | null;
      let count = 0;
      while ((m = anchorRe.exec(html)) !== null && count < 80) {
        const path = m[1].split('?')[0];
        const fullUrl = 'https://www.catawiki.com' + path;
        if (seen.has(fullUrl)) continue;
        seen.add(fullUrl);
        const inner = m[2];
        const titleMatch = inner.match(/(?:title|alt)="([^"]+)"/) || inner.match(/<h[1-6][^>]*>([\s\S]*?)<\/h/);
        const imgMatch = inner.match(/<img[^>]+src="([^"]+)"/);
        const priceMatch = inner.match(/(?:€|EUR)\s*[\d.,]+|[\d.,]+\s*(?:€|EUR)/i);
        const title = titleMatch ? unentity(stripTags(titleMatch[1])) : '';
        if (!title) continue;
        const { price, currency } = priceMatch ? priceFromText(priceMatch[0]) : { price: null, currency: 'EUR' };
        items.push({
          title: title.slice(0, 300),
          price, currency,
          image_url: imgMatch ? imgMatch[1] : null,
          url: fullUrl,
          end_time: null, location: null, seller: null,
          is_auction: true, source: 'catawiki', lot_id: null,
        });
        count++;
      }
    }
    attempts[attempts.length-1].items = items.length;
  }

  const resp: Record<string, unknown> = {
    source: 'catawiki_search',
    url, items, count: items.length,
  };
  // Se 0 items, segnala fallback userscript
  if (items.length === 0) {
    resp.requires_userscript = true;
    resp.manual_url = url;
    resp.hint = 'Nessun risultato dal scraper server-side. Apri la ricerca manualmente — l\'userscript Tampermonkey raccoglierà i risultati.';
  }
  if (debug) resp.attempts = attempts;
  return json(resp);
}

// Estrae un lot dal JSON Catawiki gestendo i vari schemi
function extractCatawikiLot(lot: any, items: SearchItem[], seen: Set<string>): void {
  if (!lot || typeof lot !== 'object') return;

  let urlPath: string | null = null;
  if (typeof lot.url === 'string') urlPath = lot.url;
  else if (typeof lot.web_url === 'string') urlPath = lot.web_url;
  else if (lot.id) urlPath = `https://www.catawiki.com/it/l/${lot.id}`;
  if (!urlPath) return;
  const fullUrl = urlPath.startsWith('http') ? urlPath : ('https://www.catawiki.com' + urlPath);
  if (seen.has(fullUrl)) return;
  seen.add(fullUrl);

  // Prezzo: catawiki ha varie forme. Per lots in corso il path canonico (Apr 2025+)
  // è lot.live.bid.{currency}. Preferiamo EUR > USD > GBP > prima disponibile.
  let price: number | null = null;
  let currency = 'EUR';

  // 1. Live bid (lot in corso d'asta) — formato verificato 2025
  if (lot.live && lot.live.bid && typeof lot.live.bid === 'object') {
    const bid = lot.live.bid;
    if (typeof bid.EUR === 'number') { price = bid.EUR; currency = 'EUR'; }
    else if (typeof bid.USD === 'number') { price = bid.USD; currency = 'USD'; }
    else if (typeof bid.GBP === 'number') { price = bid.GBP; currency = 'GBP'; }
    else {
      const firstK = Object.keys(bid)[0];
      if (firstK && typeof bid[firstK] === 'number') { price = bid[firstK]; currency = firstK; }
    }
  }

  // 2. Fallback: current_bid / minimum_bid / starting_bid
  if (price === null) {
    const bidObj = lot.current_bid || lot.minimum_bid || lot.starting_bid;
    if (bidObj && typeof bidObj === 'object') {
      if (typeof bidObj.amount === 'number') price = bidObj.amount;
      else if (typeof bidObj.value === 'number') price = bidObj.value;
      else if (bidObj.EUR) price = Number(bidObj.EUR);
      else if (bidObj.formatted) price = priceFromText(bidObj.formatted).price;
      if (bidObj.currency) currency = bidObj.currency;
    }
  }
  if (price === null && typeof lot.price === 'number') price = lot.price;
  if (price === null && lot.price && typeof lot.price === 'object') {
    if (typeof lot.price.amount === 'number') price = lot.price.amount;
    if (lot.price.currency) currency = lot.price.currency;
  }
  if (price !== null && price > 100000) price = price / 100; // alcune API ritornano centesimi

  // End time: prova MOLTI nomi campo (Catawiki ha cambiato schema più volte)
  const endTime = lot.expiresAt || lot.expires_at
    || lot.closingAt || lot.closing_at
    || lot.biddingEndTime || lot.bidding_end_time
    || lot.end_time || lot.endsAt || lot.ends_at
    || lot.live?.expiresAt || lot.live?.expires_at
    || lot.live?.endTime || lot.live?.end_time
    || null;

  // Immagine
  let image_url: string | null = null;
  if (typeof lot.image === 'string') image_url = lot.image;
  else if (lot.image && typeof lot.image === 'object') image_url = lot.image.url || lot.image.large || lot.image.src || null;
  else if (Array.isArray(lot.images) && lot.images.length) {
    const first = lot.images[0];
    image_url = typeof first === 'string' ? first : (first.url || first.large || first.src || null);
  }
  else if (lot.image_url) image_url = lot.image_url;

  items.push({
    title: String(lot.title || lot.name || '').slice(0, 300),
    price, currency,
    image_url,
    url: fullUrl,
    end_time: endTime,
    location: lot.location || lot.seller_country || null,
    seller: lot.seller_name || lot.seller || null,
    is_auction: true,
    source: 'catawiki',
    lot_id: lot.id ? String(lot.id) : null,
    bids: typeof lot.bid_count === 'number' ? lot.bid_count : (typeof lot.bids === 'number' ? lot.bids : null),
    shipping: lot.shipping_costs?.formatted || null,
  });
}

function findCatawikiLots(node: any, depth = 0): any[] {
  if (!node || depth > 10) return [];
  // Se è array di oggetti con id+title o url contenente /l/
  if (Array.isArray(node)) {
    if (node.length && node[0] && typeof node[0] === 'object') {
      const first = node[0];
      if (first.id && (first.title || first.name) && (first.url || first.image || first.current_bid || first.price)) {
        return node;
      }
    }
    let out: any[] = [];
    for (const v of node) out = out.concat(findCatawikiLots(v, depth + 1));
    return out;
  }
  if (typeof node === 'object') {
    // Chiavi note dirette
    for (const key of ['lots','results','searchResults','items','products']) {
      if (Array.isArray(node[key]) && node[key].length && node[key][0] && (node[key][0].id || node[key][0].title)) {
        const candidate = findCatawikiLots(node[key], depth + 1);
        if (candidate.length) return candidate;
      }
    }
    let out: any[] = [];
    for (const v of Object.values(node)) {
      const r = findCatawikiLots(v, depth + 1);
      if (r.length) out = out.concat(r);
    }
    return out;
  }
  return [];
}

// ── EBAY SEARCH (active listings, NOT sold) ───────────────────────────
async function handleEbaySearch(url: string, debug = false): Promise<Response> {
  const { html, ok, status } = await fetchWithRetry(url);
  if (!ok || !html) {
    return json({ error: `eBay HTTP ${status}`, items: [], status, source: 'ebay_search' });
  }
  const items: SearchItem[] = [];
  const seen = new Set<string>();

  // eBay pattern: <li class="s-item ..."> ... </li> (legacy)
  // oppure <li class="s-card ..."> ... </li> (nuovo layout 2025)
  const liRe = /<li[^>]+class="[^"]*(?:s-item|s-card)[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
  let m: RegExpExecArray | null;
  let count = 0;
  while ((m = liRe.exec(html)) !== null && count < 80) {
    const block = m[1];
    if (/s-item__title--tagblock|s-item--placeholder/.test(block)) continue;

    const linkM = block.match(/<a[^>]+class="[^"]*(?:s-item__link|s-card__title)[^"]*"[^>]*href="([^"]+)"/)
      || block.match(/<a[^>]+href="(https?:\/\/www\.ebay\.[^"]+\/itm\/[^"]+)"/);
    if (!linkM) continue;
    const itemUrl = linkM[1].split('?')[0];
    if (seen.has(itemUrl)) continue;
    seen.add(itemUrl);

    const titleM = block.match(/<(?:span|div|h3)[^>]*class="[^"]*(?:s-item__title|s-card__title)[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div|h3)>/);
    const title = titleM ? unentity(stripTags(titleM[1])) : '';
    if (!title || /^Shop on eBay$/i.test(title)) continue;

    // Price: estrai DAL BLOCCO COMPLETO e poi cerca testo prezzo (non importa se nested span)
    // Pattern multipli: s-item__price, s-card__price, s-card-price, prx_price
    const priceText = extractEbayPriceText(block);
    const { price, currency } = priceText ? priceFromText(priceText) : { price: null, currency: 'EUR' };

    const imgM = block.match(/<img[^>]+(?:src|data-src|data-srcset)="([^"]+)"/);
    const image_url = imgM ? imgM[1].split(' ')[0] : null;

    const isAuction = /\bbid\b|\bAsta\b|s-item__bids|s-item__time-left|s-card__time-left/i.test(block);

    // End time: prova testo "time-left" + datetime structured
    let end_time: string | null = null;
    const endM = block.match(/<span[^>]*class="[^"]*(?:s-item__time-left|s-card__time-left)[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    const endText = endM ? unentity(stripTags(endM[1])) : '';
    if (endText) end_time = parseEbayEndText(endText);
    // Fallback: cerca un attributo data-end-date o un timestamp ISO nel blocco
    if (!end_time) {
      const isoM = block.match(/data-end-?(?:date|time)="([^"]+)"/i)
        || block.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^"<]*)/);
      if (isoM) {
        const d = new Date(isoM[1]);
        if (!isNaN(d.getTime())) end_time = d.toISOString();
      }
    }

    const locM = block.match(/<span[^>]*class="[^"]*s-item__location[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    const location = locM ? unentity(stripTags(locM[1])) : null;

    const bidM = block.match(/<span[^>]*class="[^"]*s-item__bids[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    const bidTxt = bidM ? unentity(stripTags(bidM[1])) : '';
    const bidsN = bidTxt.match(/(\d+)/);
    const bids = bidsN ? parseInt(bidsN[1]) : null;

    const shipM = block.match(/<span[^>]*class="[^"]*s-item__shipping[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    const shipping = shipM ? unentity(stripTags(shipM[1])) : null;

    items.push({
      title: title.slice(0, 300),
      price,
      currency,
      image_url,
      url: itemUrl,
      end_time,
      location,
      seller: null,
      is_auction: isAuction,
      source: 'ebay',
      bids,
      shipping,
    });
    count++;
  }

  const resp: Record<string, unknown> = { source: 'ebay_search', url, items, count: items.length };
  if (debug) {
    const noPrice = items.filter(i => i.price == null).length;
    const noEnd = items.filter(i => i.is_auction && !i.end_time).length;
    resp.debug = {
      html_len: html.length,
      has_results: /s-item|s-card/.test(html),
      missing_price: noPrice,
      missing_end_time: noEnd,
      preview: items.length === 0 ? html.slice(0, 2000) : undefined,
    };
  }
  return json(resp);
}

// Estrae il testo prezzo da un blocco HTML eBay item, robusto a nested span,
// classi multiple (s-item__price, s-card__price, prx_price), e formati EUR/USD/GBP.
function extractEbayPriceText(block: string): string {
  // Cerca un container prezzo (qualsiasi tag), poi prendi tutto il testo dentro fino al
  // closing del container — gestito tramite balance-aware extraction semplice.
  const containerPatterns = [
    /<span[^>]+class="[^"]*s-item__price[^"]*"[^>]*>/i,
    /<span[^>]+class="[^"]*s-card__price[^"]*"[^>]*>/i,
    /<span[^>]+class="[^"]*s-card-price[^"]*"[^>]*>/i,
    /<div[^>]+class="[^"]*s-card__price[^"]*"[^>]*>/i,
    /<span[^>]+class="[^"]*prx_price[^"]*"[^>]*>/i,
  ];
  for (const re of containerPatterns) {
    const startM = re.exec(block);
    if (!startM) continue;
    // Trova chiusura span/div bilanciata dal punto startM.index + startM[0].length
    const startTag = startM[0].startsWith('<div') ? 'div' : 'span';
    const after = block.slice(startM.index + startM[0].length);
    const closed = consumeBalanced(after, startTag);
    if (closed) {
      const txt = unentity(stripTags(closed));
      if (/[€$£]|\bEUR\b|\bUSD\b|\bGBP\b/.test(txt) || /\d+[,.]\d{2}/.test(txt)) {
        return txt.trim();
      }
    }
  }
  // Fallback assoluto: cerca qualsiasi pattern monetario nel blocco
  const anyPrice = block.match(/(?:€|EUR|USD|GBP|\$|£)\s*[\d.,]+|[\d.,]+\s*(?:€|EUR|USD|GBP|\$|£)/);
  return anyPrice ? unentity(anyPrice[0]) : '';
}

// Estrae il contenuto di un tag finché non trova la chiusura bilanciata.
// Semplice e tollerante: conta solo le occorrenze del tag corrispondente.
function consumeBalanced(html: string, tag: string): string {
  const openRe = new RegExp(`<${tag}\\b`, 'gi');
  const closeRe = new RegExp(`</${tag}>`, 'gi');
  let depth = 1;
  let pos = 0;
  while (depth > 0 && pos < html.length) {
    openRe.lastIndex = pos;
    closeRe.lastIndex = pos;
    const o = openRe.exec(html);
    const c = closeRe.exec(html);
    if (!c) return html;
    if (o && o.index < c.index) {
      depth++;
      pos = o.index + 1;
    } else {
      depth--;
      if (depth === 0) return html.slice(0, c.index);
      pos = c.index + 1;
    }
  }
  return html;
}

function parseEbayEndText(t: string): string|null {
  // Formati supportati:
  //   "1g 2h" / "5h 12m" / "3m 20s" — durata residua (italiano)
  //   "1d 2h" / "5h 12m"             — duration residua (english)
  //   "Termina 25 apr 14:30"          — data assoluta italiana
  //   "Ends 25 Apr at 14:30"          — data assoluta english
  //   "Mer 25 Apr alle 14:30"
  if (!t) return null;
  const txt = t.trim();
  const now = Date.now();

  // 1. Durata residua
  let ms = 0;
  const dM = txt.match(/(\d+)\s*g(?:iorn[oi])?\b/i);   // giorni IT
  const dM2 = txt.match(/(\d+)\s*d(?:ay)?\b/i);        // days EN
  const hM = txt.match(/(\d+)\s*h(?:our)?\b/i);
  const mM = txt.match(/(\d+)\s*m(?:in)?(?:s|ut[oi])?\b/i);
  const sM = txt.match(/(\d+)\s*s(?:ec)?(?:ondi?)?\b/i);
  if (dM) ms += parseInt(dM[1]) * 86400000;
  else if (dM2) ms += parseInt(dM2[1]) * 86400000;
  if (hM) ms += parseInt(hM[1]) * 3600000;
  if (mM) ms += parseInt(mM[1]) * 60000;
  if (sM) ms += parseInt(sM[1]) * 1000;
  if (ms > 0) return new Date(now + ms).toISOString();

  // 2. Data assoluta "DD MMM HH:MM" o "DD MMM at HH:MM"
  const monthMap: Record<string, number> = {
    gen:0, feb:1, mar:2, apr:3, mag:4, giu:5, lug:6, ago:7, set:8, ott:9, nov:10, dic:11,
    jan:0, feb_en:1, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, dec:11,
  };
  const dateM = txt.match(/(\d{1,2})\s+([A-Za-z]{3,})\.?\s*(?:at|alle)?\s*(\d{1,2}):(\d{2})/);
  if (dateM) {
    const day = parseInt(dateM[1]);
    const monKey = dateM[2].toLowerCase().slice(0, 3);
    const mon = monthMap[monKey];
    if (mon !== undefined) {
      const h = parseInt(dateM[3]);
      const mi = parseInt(dateM[4]);
      const d = new Date();
      d.setMonth(mon, day);
      d.setHours(h, mi, 0, 0);
      // Se la data risulta nel passato, assume anno prossimo
      if (d.getTime() < now) d.setFullYear(d.getFullYear() + 1);
      return d.toISOString();
    }
  }
  return null;
}

// ── SUBITO ────────────────────────────────────────────────────────────
async function handleSubitoSearch(url: string, debug = false): Promise<Response> {
  const { html, ok, status } = await fetchWithRetry(url);
  if (!ok || !html) {
    return json({ error: `Subito HTTP ${status}`, items: [], status, source: 'subito_search' });
  }
  const items: SearchItem[] = [];
  const seen = new Set<string>();

  // Subito usa Next.js: prova __NEXT_DATA__
  try {
    const nd = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nd) {
      const data = JSON.parse(nd[1]);
      const ads = findSubitoAds(data);
      for (const ad of ads) {
        const u = ad.urls?.default || ad.url || (ad.id ? `https://www.subito.it/annunci/${ad.id}` : null);
        if (!u || seen.has(u)) continue;
        seen.add(u);
        let priceN: number|null = null;
        if (ad.features?.['/price']?.values?.[0]?.value) {
          priceN = parseFloat(String(ad.features['/price'].values[0].value).replace(/[^\d.,]/g,'').replace(',','.'));
          if (!isFinite(priceN)) priceN = null;
        } else if (typeof ad.price === 'number') {
          priceN = ad.price;
        } else if (ad.price?.value) {
          priceN = parseFloat(String(ad.price.value).replace(/[^\d.,]/g,'').replace(',','.'));
          if (!isFinite(priceN)) priceN = null;
        }
        const img = ad.images?.[0]?.scale?.[ad.images[0].scale.length-1]?.secureuri
                  || ad.images?.[0]?.uri
                  || ad.image?.url
                  || null;
        // End time per le aste / annunci con scadenza:
        // - features['/expiration_date'].values[0].value
        // - features['/auction_end'].values[0].value
        // - ad.expires_at / ad.expiration_date
        let endTime: string | null = null;
        const endRaw = ad.features?.['/expiration_date']?.values?.[0]?.value
          || ad.features?.['/auction_end']?.values?.[0]?.value
          || ad.features?.['/end_date']?.values?.[0]?.value
          || ad.expires_at || ad.expiration_date || ad.end_at || null;
        if (endRaw) {
          const d = new Date(endRaw);
          if (!isNaN(d.getTime())) endTime = d.toISOString();
        }
        const isAuction = !!(ad.features?.['/auction_end'] || ad.is_auction || /asta/i.test(String(ad.subject||ad.title||'')));
        items.push({
          title: String(ad.subject || ad.title || '').slice(0, 300),
          price: priceN,
          currency: 'EUR',
          image_url: img,
          url: u.startsWith('http') ? u : 'https://www.subito.it' + u,
          end_time: endTime,
          location: ad.geo?.city?.value || ad.geo?.town?.value || null,
          seller: ad.advertiser?.user_id || null,
          is_auction: isAuction,
          source: 'subito',
        });
      }
    }
  } catch (_) { /* fall through */ }

  // Fallback HTML
  if (items.length === 0) {
    const cardRe = /<a[^>]+href="(https:\/\/www\.subito\.it\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m: RegExpExecArray | null;
    let count = 0;
    while ((m = cardRe.exec(html)) !== null && count < 50) {
      const u = m[1].split('?')[0];
      if (!/\/v\/|\/annunci\//.test(u) || seen.has(u)) continue;
      seen.add(u);
      const inner = m[2];
      const titleM = inner.match(/<h[2-6][^>]*>([\s\S]*?)<\/h/);
      if (!titleM) continue;
      const title = unentity(stripTags(titleM[1]));
      const imgM = inner.match(/<img[^>]+src="([^"]+)"/);
      const priceM = inner.match(/€\s*[\d.,]+/);
      const { price } = priceM ? priceFromText(priceM[0]) : { price: null };
      items.push({
        title: title.slice(0, 300),
        price,
        currency: 'EUR',
        image_url: imgM ? imgM[1] : null,
        url: u,
        end_time: null,
        location: null,
        seller: null,
        is_auction: false,
        source: 'subito',
      });
      count++;
    }
  }

  const resp: Record<string, unknown> = { source: 'subito_search', url, items, count: items.length };
  if (debug && items.length === 0) {
    resp.debug = {
      html_len: html.length,
      has_next_data: /__NEXT_DATA__/.test(html),
      preview: html.slice(0, 2000),
    };
  }
  return json(resp);
}

function findSubitoAds(node: any, depth = 0): any[] {
  if (!node || depth > 12) return [];
  if (Array.isArray(node)) {
    if (node.length && node[0] && typeof node[0] === 'object' && (node[0].subject || node[0].title) && (node[0].urls || node[0].url)) {
      return node;
    }
    let out: any[] = [];
    for (const v of node) out = out.concat(findSubitoAds(v, depth + 1));
    return out;
  }
  if (typeof node === 'object') {
    for (const key of ['ads','list','items','results']) {
      if (Array.isArray(node[key]) && node[key].length && (node[key][0]?.subject || node[key][0]?.title)) {
        return node[key];
      }
    }
    let out: any[] = [];
    for (const v of Object.values(node)) {
      const r = findSubitoAds(v, depth + 1);
      if (r.length) out = out.concat(r);
    }
    return out;
  }
  return [];
}
