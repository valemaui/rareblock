// ═══════════════════════════════════════════════════════════════════════
//  RareBlock — Edge Function: slab-verify
//  Verifica server-side di una slab gradata interrogando il database del
//  grader ufficiale e restituendo i dati estratti (anno, descrizione, voto,
//  population). Il client confronta poi questi dati con quelli letti dall'OCR
//  per decidere il verdetto (ok / mismatch / not_found / suspicious).
//
//  Supporto attuale:
//    - PSA   (scraping HTML server-side, anti-CF amichevole)
//    - BGS   (TODO — landing form-based)
//    - CGC   (TODO)
//    - SGC   (TODO)
//    - altri → return not_supported
//
//  Endpoint: POST /slab-verify
//  Body:     { grader: "PSA", cert: "58205969" }
//  Response: {
//    found:      boolean       // cert esistente nel DB
//    supported:  boolean       // grader implementato lato server
//    grader:     string        // echo dell'input
//    cert:       string        // echo dell'input (sanitizzato)
//    fraud:      boolean       // pagina segnala revoca/fraud
//    details: {
//      year:        string | null
//      brand:       string | null  // es. "1999 Pokemon Game"
//      subject:     string | null  // es. "Charizard - Holo"
//      card_number: string | null  // es. "4"
//      variety:     string | null  // es. "Shadowless"
//      grade:       string | null  // es. "10" o "GEM MT 10"
//      category:    string | null  // es. "TCG Cards"
//      population:  string | null
//    }
//    raw_excerpt: string | null  // snippet HTML per debug
//    error:       string | null
//  }
//
//  DEPLOY:
//    supabase functions deploy slab-verify --no-verify-jwt
// ═══════════════════════════════════════════════════════════════════════

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

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
];
const pickUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

interface SlabDetails {
  year: string | null;
  brand: string | null;
  subject: string | null;
  card_number: string | null;
  variety: string | null;
  grade: string | null;
  category: string | null;
  population: string | null;
}

interface SlabImages {
  front: string | null;
  back: string | null;
}

interface SlabVerifyResult {
  found: boolean;
  supported: boolean;
  grader: string;
  cert: string;
  fraud: boolean;
  details: SlabDetails;
  raw_excerpt: string | null;
  error: string | null;
  // Foto reali della slab (oggi solo PSA via Public API). null = non richieste
  // o non disponibili (PSA aggiunge scan solo da ott. 2021 in poi).
  images?: SlabImages | null;
}

const emptyDetails = (): SlabDetails => ({
  year: null, brand: null, subject: null, card_number: null,
  variety: null, grade: null, category: null, population: null,
});

// ── HTML PARSING HELPERS ────────────────────────────────────────────────
// Pulisce entità HTML e tag rimanenti da un blocco di testo
function cleanText(s: string | null | undefined): string | null {
  if (!s) return null;
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim() || null;
}

// Estrae il valore associato a una label da una tabella key/value
// Esempi di pattern PSA: <dt>Year</dt><dd>1998</dd> oppure <th>Year</th><td>1998</td>
// oppure <span class="label">Year</span><span class="value">1998</span>
function extractFieldByLabel(html: string, labels: string[]): string | null {
  for (const label of labels) {
    // Pattern dt/dd
    const reDl = new RegExp(`<dt[^>]*>\\s*${label}\\s*</dt>\\s*<dd[^>]*>([\\s\\S]*?)</dd>`, 'i');
    let m = html.match(reDl);
    if (m && m[1]) { const v = cleanText(m[1]); if (v) return v; }

    // Pattern th/td (PSA usa molto questo)
    const reTh = new RegExp(`<th[^>]*>\\s*${label}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`, 'i');
    m = html.match(reTh);
    if (m && m[1]) { const v = cleanText(m[1]); if (v) return v; }

    // Pattern td/td adiacenti su stessa riga (label cell + value cell)
    const reTdTd = new RegExp(`<td[^>]*>\\s*${label}\\s*</td>\\s*<td[^>]*>([\\s\\S]*?)</td>`, 'i');
    m = html.match(reTdTd);
    if (m && m[1]) { const v = cleanText(m[1]); if (v) return v; }

    // Pattern label/span generico (Bootstrap-style)
    const reLabel = new RegExp(`<[^>]*class="[^"]*\\blabel\\b[^"]*"[^>]*>\\s*${label}\\s*</[^>]+>\\s*<[^>]+>([\\s\\S]*?)</[^>]+>`, 'i');
    m = html.match(reLabel);
    if (m && m[1]) { const v = cleanText(m[1]); if (v) return v; }
  }
  return null;
}

// ── PSA SCRAPER ─────────────────────────────────────────────────────────
// Strategia a due livelli:
//
// 1. PRIMARIO — PSA Public API ufficiale (api.psacard.com/publicapi)
//    Richiede PSA_API_TOKEN come Deno.env / Supabase Secret. Bearer auth.
//    Risposta JSON pulita, no anti-bot, no Cloudflare.
//    Setup: Project Settings → Edge Functions → Secrets → PSA_API_TOKEN
//
// 2. FALLBACK — scraping HTML server-side della pagina pubblica
//    Solo se il token non è configurato o l'API ufficiale fallisce.
//    Spesso bloccato da Cloudflare quando le richieste arrivano da IP
//    cloud. Mantieni come fallback ma aspettati 403 frequenti.
//
async function verifyPSA(cert: string, withImages = false): Promise<SlabVerifyResult> {
  const out: SlabVerifyResult = {
    found: false, supported: true, grader: 'PSA', cert,
    fraud: false, details: emptyDetails(),
    raw_excerpt: null, error: null,
  };

  // PSA cert numbers sono numerici, 6-12 cifre
  if (!/^\d{6,12}$/.test(cert)) {
    out.error = 'PSA cert # deve essere numerico (6-12 cifre). Ricevuto: ' + cert;
    return out;
  }

  // ── Strategia 1: API ufficiale (se token configurato) ─────────────
  const psaToken = Deno.env.get('PSA_API_TOKEN');
  if (psaToken && psaToken.length > 10) {
    const apiOut = await verifyPSAViaAPI(cert, psaToken);
    // Se l'API ha risposto in modo utile (found o not-found definitivo),
    // ritorniamo direttamente. Solo su errore di rete fallback a scraping.
    if (apiOut.found || apiOut.fraud || apiOut.error === null) {
      // Foto reali della slab: solo se richieste, cert trovato e token presente.
      // Costa 1 chiamata API extra (attenzione al limite giornaliero free 100).
      if (withImages && apiOut.found) {
        try { apiOut.images = await fetchPSAImages(cert, psaToken); }
        catch (e) { console.warn('[slab-verify] PSA images fetch error:', e instanceof Error ? e.message : String(e)); }
      }
      return apiOut;
    }
    // Se errore HTTP (es. token scaduto) logghiamo e proviamo fallback
    console.warn('[slab-verify] PSA API fallita, provo scraping:', apiOut.error);
    out.error = apiOut.error;
  }

  // ── Strategia 2: scraping HTML (fallback) ─────────────────────────
  return await verifyPSAViaScraping(cert, out);
}

// ── PSA: foto reali della slab via Public API ───────────────────────────
// Endpoint: GET https://api.psacard.com/publicapi/cert/GetImagesByCertNumber/<cert>
// Risposta: array di { IsFrontImage: boolean, ImageURL: string }.
// PSA ha iniziato ad archiviare gli scan solo da ottobre 2021: per cert più
// vecchi l'array è vuoto → ritorniamo { front:null, back:null } senza errore.
async function fetchPSAImages(cert: string, token: string): Promise<SlabImages> {
  const result: SlabImages = { front: null, back: null };
  const url = `https://api.psacard.com/publicapi/cert/GetImagesByCertNumber/${encodeURIComponent(cert)}`;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, {
      method: 'GET',
      signal: ctrl.signal,
      headers: {
        'Authorization': 'bearer ' + token,
        'Accept': 'application/json',
        'User-Agent': 'RareBlock-SlabVerify/1.0',
      },
    });
    clearTimeout(to);
    if (!r.ok) {
      console.warn('[slab-verify] PSA images HTTP', r.status);
      return result;
    }
    const text = await r.text();
    let data: any;
    try { data = JSON.parse(text); } catch (_) { return result; }

    // La risposta è tipicamente un array; alcuni wrapper la annidano.
    const arr: any[] = Array.isArray(data)
      ? data
      : (Array.isArray(data?.PSACertImages) ? data.PSACertImages
        : (Array.isArray(data?.images) ? data.images : []));

    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const u = item.ImageURL || item.imageURL || item.ImageUrl || item.imageUrl || item.url;
      if (!u) continue;
      const isFront = (item.IsFrontImage ?? item.isFrontImage ?? item.IsFront ?? item.isFront);
      if (isFront === true || isFront === 'true') result.front = String(u);
      else if (isFront === false || isFront === 'false') result.back = String(u);
      else if (!result.front) result.front = String(u); // fallback: prima = fronte
      else if (!result.back) result.back = String(u);
    }
    return result;
  } catch (e) {
    clearTimeout(to);
    console.warn('[slab-verify] PSA images fetch exception:', e instanceof Error ? e.message : String(e));
    return result;
  }
}

// ── PSA via API ufficiale ───────────────────────────────────────────────
// Endpoint: GET https://api.psacard.com/publicapi/cert/GetByCertNumber/<cert>
// Auth: Authorization: bearer <token>
// Risposta: JSON con campo PSACert (struttura PSA standard).
async function verifyPSAViaAPI(cert: string, token: string): Promise<SlabVerifyResult> {
  const out: SlabVerifyResult = {
    found: false, supported: true, grader: 'PSA', cert,
    fraud: false, details: emptyDetails(),
    raw_excerpt: null, error: null,
  };

  const url = `https://api.psacard.com/publicapi/cert/GetByCertNumber/${encodeURIComponent(cert)}`;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 15000);

  try {
    const r = await fetch(url, {
      method: 'GET',
      signal: ctrl.signal,
      headers: {
        'Authorization': 'bearer ' + token,
        'Accept': 'application/json',
        'User-Agent': 'RareBlock-SlabVerify/1.0',
      },
    });
    clearTimeout(to);

    // 204 = empty response (no cert number)
    if (r.status === 204) {
      out.error = 'PSA API: richiesta vuota (cert mancante)';
      return out;
    }

    // 401/403 = token invalido/scaduto
    if (r.status === 401 || r.status === 403) {
      out.error = `PSA API: token invalido o scaduto (HTTP ${r.status}). Rigenera PSA_API_TOKEN.`;
      return out;
    }

    if (r.status === 404) {
      // 404 può significare cert inesistente (200 con body vuoto è più comune)
      out.raw_excerpt = 'PSA API 404';
      out.error = null;
      return out;
    }

    if (!r.ok) {
      out.error = `PSA API HTTP ${r.status}`;
      return out;
    }

    const text = await r.text();
    out.raw_excerpt = text.substring(0, 400);

    let data: any;
    try { data = JSON.parse(text); }
    catch (_) {
      out.error = 'PSA API: risposta non JSON';
      return out;
    }

    // PSA API restituisce { PSACert: { ... } } oppure null/empty se cert non esiste
    const cert_data = data?.PSACert || data?.psaCert || data?.cert || data?.certificate || data;
    if (!cert_data || typeof cert_data !== 'object' || Object.keys(cert_data).length === 0) {
      // Nessun dato → cert non esiste
      out.found = false;
      out.error = null;
      return out;
    }

    // Mapping campi (PSA usa PascalCase, ma supportiamo varianti)
    function pick(obj: any, keys: string[]): string | null {
      for (const k of keys) {
        const v = obj[k];
        if (v !== null && v !== undefined && v !== '') return String(v);
      }
      return null;
    }

    const d = out.details;
    d.year        = pick(cert_data, ['Year', 'year', 'CardYear']);
    d.brand       = pick(cert_data, ['Brand', 'brand', 'BrandTitle']);
    d.subject     = pick(cert_data, ['Subject', 'subject', 'Player']);
    d.card_number = pick(cert_data, ['CardNumber', 'cardNumber', 'card_number', 'SpecNumber']);
    d.variety     = pick(cert_data, ['Variety', 'variety', 'VarietyPedigree', 'Pedigree']);
    d.grade       = pick(cert_data, ['CardGrade', 'cardGrade', 'Grade', 'grade', 'ItemGrade', 'GradeDescription']);
    d.category    = pick(cert_data, ['Category', 'category', 'Sport']);

    const pop = pick(cert_data, ['TotalPopulation', 'totalPopulation', 'Population', 'population']);
    const popH = pick(cert_data, ['PopulationHigher', 'populationHigher']);
    if (pop) {
      d.population = pop + (popH ? ` (pop higher: ${popH})` : '');
    }

    // Fraud detection: PSA segnala con campi specifici
    const labelType = pick(cert_data, ['LabelType', 'labelType']) || '';
    const isFake = /counterfeit|fake|fraud|stolen|revoked/i.test(labelType) ||
                   pick(cert_data, ['IsFake', 'isFake', 'IsCounterfeit', 'isCounterfeit']) === 'true';
    out.fraud = isFake;

    // Considera found se abbiamo almeno uno dei campi principali
    out.found = !!(d.grade || d.subject || d.brand || d.year);

    return out;
  } catch (e) {
    clearTimeout(to);
    out.error = `PSA API fetch error: ${e instanceof Error ? e.message : String(e)}`;
    return out;
  }
}

// ── PSA via scraping HTML (fallback) ───────────────────────────────────
// Spesso bloccato da Cloudflare quando il request viene da IP cloud.
// Mantenuto solo come tentativo ultimo prima di dichiarare "non raggiungibile".
async function verifyPSAViaScraping(cert: string, out: SlabVerifyResult): Promise<SlabVerifyResult> {
  const url = `https://www.psacard.com/cert/${encodeURIComponent(cert)}/psa`;

  // Retry loop: prova fino a 2 volte con UA diversi e leggero delay
  let lastError = '';
  let html = '';
  for (let attempt = 0; attempt < 2 && !html; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 600 + Math.random() * 400));
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 18000);
    try {
      const r = await fetch(url, {
        method: 'GET',
        signal: ctrl.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': pickUA(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,it;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br, zstd',
          'Sec-Ch-Ua': '"Chromium";v="132", "Not?A_Brand";v="24"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"macOS"',
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1',
          'Referer': 'https://www.psacard.com/cert',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
        },
      });
      clearTimeout(to);

      if (r.ok) {
        html = await r.text();
        break;
      }
      if (r.status === 404) {
        out.raw_excerpt = 'HTTP 404 from PSA scraping';
        return out;
      }
      lastError = `PSA scraping HTTP ${r.status} (tentativo ${attempt + 1})`;
    } catch (e) {
      clearTimeout(to);
      lastError = `PSA scraping fetch error (tentativo ${attempt + 1}): ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  if (!html) {
    // Se PSA_API_TOKEN non era configurato e scraping fallisce, dai hint chiaro
    const noToken = !Deno.env.get('PSA_API_TOKEN');
    const baseErr = lastError || 'PSA non raggiungibile dopo 2 tentativi';
    out.error = noToken
      ? baseErr + ' — configura PSA_API_TOKEN come Secret Supabase per usare l\'API ufficiale'
      : baseErr;
    return out;
  }

  out.raw_excerpt = html.substring(0, 400);

  // ── Fraud/revoke check ──────────────────────────────────────────────
  // PSA segnala cert problematiche con flag specifici nella pagina
  const fraudKeywords = ['counterfeit', 'fraudulent', 'revoked', 'stolen', 'fake label'];
  const htmlLower = html.toLowerCase();
  out.fraud = fraudKeywords.some(k => htmlLower.includes(k));

  // ── Not-found check ─────────────────────────────────────────────────
  const notFoundMarkers = [
    'could not be found',
    'not found in our database',
    'no results',
    'invalid cert number',
    'cert not found',
  ];
  const isNotFound = notFoundMarkers.some(m => htmlLower.includes(m));
  if (isNotFound) {
    out.found = false;
    return out;
  }

  // ── Estrai i campi ──────────────────────────────────────────────────
  const d = out.details;
  d.year        = extractFieldByLabel(html, ['Year']);
  d.brand       = extractFieldByLabel(html, ['Brand', 'Brand/Title', 'Brand / Title']);
  d.subject     = extractFieldByLabel(html, ['Subject', 'Player', 'Player/Subject']);
  d.card_number = extractFieldByLabel(html, ['Card Number', 'Card #', 'Card#']);
  d.variety     = extractFieldByLabel(html, ['Variety', 'Variety/Pedigree', 'Pedigree']);
  d.grade       = extractFieldByLabel(html, ['Item Grade', 'Grade', 'Card Grade']);
  d.category    = extractFieldByLabel(html, ['Category', 'Sport']);
  d.population  = extractFieldByLabel(html, ['PSA Population', 'Population']);

  // Se abbiamo almeno il grade o il subject, consideriamo "found"
  out.found = !!(d.grade || d.subject || d.brand || d.year);

  // Fallback: cerca il pattern title-based di PSA
  // <title>Cert Verification 58205969</title> seguito da "1998 POKEMON ..."
  if (!out.found) {
    const titleMatch = html.match(/<title[^>]*>\s*Cert Verification\s+(\d+)\s*<\/title>/i);
    if (titleMatch && titleMatch[1] === cert) {
      // Cerca H1 o blocco principale con descrizione
      const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
      if (h1Match) {
        const cleaned = cleanText(h1Match[1]);
        if (cleaned && cleaned.length > 5 && !/cert verification/i.test(cleaned)) {
          d.brand = d.brand || cleaned;
          out.found = true;
        }
      }
    }
  }

  return out;
}

// ── BGS / CGC / SGC: TODO ───────────────────────────────────────────────
// BGS è una landing page form-based (search box che fa POST). Server-side
// è fattibile ma richiede simulare il form. Da implementare in v2.
// CGC e SGC similari.
async function verifyUnsupported(grader: string, cert: string): Promise<SlabVerifyResult> {
  return {
    found: false, supported: false, grader, cert,
    fraud: false, details: emptyDetails(),
    raw_excerpt: null, error: null,
  };
}

// ── ROUTER ──────────────────────────────────────────────────────────────
async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let body: { grader?: string; cert?: string; withImages?: boolean };
  try { body = await req.json(); }
  catch { return json({ error: 'Invalid JSON body' }, 400); }

  const grader = String(body?.grader || '').trim().toUpperCase();
  const cert   = String(body?.cert   || '').trim().replace(/\s+/g, '');
  const withImages = body?.withImages === true;

  if (!grader || !cert) return json({ error: 'grader e cert sono richiesti' }, 400);
  if (cert.length > 30) return json({ error: 'cert troppo lungo' }, 400);

  let result: SlabVerifyResult;
  switch (grader) {
    case 'PSA':
      result = await verifyPSA(cert, withImages);
      break;
    case 'BGS':
    case 'CGC':
    case 'SGC':
    case 'TAG':
    case 'ARS':
    case 'HGA':
    case 'GMA':
      result = await verifyUnsupported(grader, cert);
      break;
    default:
      return json({ error: 'Grader non riconosciuto: ' + grader }, 400);
  }

  return json(result);
}

Deno.serve(handle);
