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

interface SlabVerifyResult {
  found: boolean;
  supported: boolean;
  grader: string;
  cert: string;
  fraud: boolean;
  details: SlabDetails;
  raw_excerpt: string | null;
  error: string | null;
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
// URL: https://www.psacard.com/cert/<cert>/psa
// La pagina è server-side renderizzata. Se la cert non esiste, l'HTML
// contiene "could not be found" o simili. Se è una cert revocata, contiene
// "Sample/Counterfeit" o "Special Label" warnings.
async function verifyPSA(cert: string): Promise<SlabVerifyResult> {
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

  const url = `https://www.psacard.com/cert/${encodeURIComponent(cert)}/psa`;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 18000);

  try {
    const r = await fetch(url, {
      method: 'GET',
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': pickUA(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,it;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Dest': 'document',
        'Upgrade-Insecure-Requests': '1',
      },
    });
    clearTimeout(to);

    if (!r.ok) {
      out.error = `PSA HTTP ${r.status}`;
      // 404 può significare cert non esistente → restituisci found=false senza error
      if (r.status === 404) { out.error = null; }
      return out;
    }

    const html = await r.text();
    out.raw_excerpt = html.substring(0, 400); // primo bit per debug

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
  } catch (e) {
    clearTimeout(to);
    out.error = 'PSA fetch error: ' + (e instanceof Error ? e.message : String(e));
    return out;
  }
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

  let body: { grader?: string; cert?: string };
  try { body = await req.json(); }
  catch { return json({ error: 'Invalid JSON body' }, 400); }

  const grader = String(body?.grader || '').trim().toUpperCase();
  const cert   = String(body?.cert   || '').trim().replace(/\s+/g, '');

  if (!grader || !cert) return json({ error: 'grader e cert sono richiesti' }, 400);
  if (cert.length > 30) return json({ error: 'cert troppo lungo' }, 400);

  let result: SlabVerifyResult;
  switch (grader) {
    case 'PSA':
      result = await verifyPSA(cert);
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
