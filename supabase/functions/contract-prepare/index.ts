// =============================================================================
// Supabase Edge Function: contract-prepare
// =============================================================================
// SELF-CONTAINED.
//
// Prepara un nuovo contratto:
//   1. Verifica che l'utente abbia KYC L2 completo
//   2. Carica template attivo + dati piattaforma + anagrafica utente
//   3. Sostituisce i placeholder {{xxx}} nel Markdown
//   4. Genera PDF con pdf-lib (header, footer, tipografia luxury)
//   5. Calcola SHA-256 del PDF unsigned
//   6. Upload a bucket 'contracts-unsigned' (path: <user_id>/<contract_number>.pdf)
//   7. Insert riga in contracts (status='pending_signature')
//   8. Insert audit event 'prepared'
//   9. Ritorna { contract_id, contract_number, pdf_url (signed 1h), expires_at }
//
// Body atteso:
//   {
//     "template_code":  "VENDOR_MANDATE" | "BUYER_PURCHASE_CUSTODY" | "BUYER_FRACTIONAL",
//     "subject_data":   { ... }   // dati specifici del contratto
//                                  // VENDOR_MANDATE: { vendor_id, products: [{product_id,...}], commission_pct, ... }
//                                  // BUYER_PURCHASE_CUSTODY: { product_id, qty, price_eur, ... }
//   }
//
// Auth: utente autenticato. Il contratto viene creato per l'utente chiamante.
// (In PR8 esisterà anche un flusso admin-initiated.)
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { PDFDocument, rgb } from 'https://esm.sh/pdf-lib@1.17.1';
import fontkit from 'https://esm.sh/@pdf-lib/fontkit@1.1.1';


// ═════════════════════════════════════════════════════════════════════════════
// Font UTF-8 (NotoSans) — necessari per testi italiani con caratteri smart
//   (em-dash —, virgolette tipografiche " ", vocali accentate à è é ò ù).
// I font Standard di pdf-lib (Times/Helvetica) usano codifica WinAnsi che NON
// supporta U+27E8/9 ⟨⟩, U+2022 •, U+2014 —, etc.
// Cache in memoria fra le chiamate (Deno mantiene module-level state per lifetime
// dell'edge isolate).
// ═════════════════════════════════════════════════════════════════════════════
const FONT_URLS = {
  regular: 'https://cdn.jsdelivr.net/fontsource/fonts/noto-sans@latest/latin-400-normal.ttf',
  bold:    'https://cdn.jsdelivr.net/fontsource/fonts/noto-sans@latest/latin-700-normal.ttf',
  italic:  'https://cdn.jsdelivr.net/fontsource/fonts/noto-sans@latest/latin-400-italic.ttf',
  // Per i titoli usiamo NotoSerif (più editorial/classy)
  serifBold: 'https://cdn.jsdelivr.net/fontsource/fonts/noto-serif@latest/latin-700-normal.ttf',
};
const _fontCache: Record<string, ArrayBuffer> = {};
async function loadFontBytes(key: keyof typeof FONT_URLS): Promise<ArrayBuffer> {
  if (_fontCache[key]) return _fontCache[key];
  const r = await fetch(FONT_URLS[key]);
  if (!r.ok) throw new Error('font_fetch_failed: ' + key + ' status=' + r.status);
  _fontCache[key] = await r.arrayBuffer();
  return _fontCache[key];
}


// ═════════════════════════════════════════════════════════════════════════════
// HTTP helpers
// ═════════════════════════════════════════════════════════════════════════════
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, apikey',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}


// ═════════════════════════════════════════════════════════════════════════════
// Hashing
// ═════════════════════════════════════════════════════════════════════════════
async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  let s = '0x';
  for (const b of new Uint8Array(buf)) s += b.toString(16).padStart(2, '0');
  return s;
}


// ═════════════════════════════════════════════════════════════════════════════
// Template engine: sostituisce {{key}} con il valore corrispondente.
// Supporta modificatori inline:
//   {{key | money}}  → 50000 → "50.000,00"
//   {{key | int}}    → 50000 → "50.000"
//   {{key | upper}}  → "abc" → "ABC"
//
// Inoltre, alcune chiavi vengono auto-formattate quando matchano pattern noti
// (insurance_*, *_eur, amount_*, *_max_* etc) → nessuna necessità di toccare
// i template MD per ottenere formattazione decente fuori dal box.
// ═════════════════════════════════════════════════════════════════════════════

function fmtMoney(v: any): string {
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^\d.,-]/g, '').replace(',', '.'));
  if (!isFinite(n)) return String(v);
  return n.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtInt(v: any): string {
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^\d.-]/g, ''));
  if (!isFinite(n)) return String(v);
  return Math.round(n).toLocaleString('it-IT');
}

// Pattern di chiavi che riceveranno auto-formattazione monetaria
const AUTO_MONEY_RE = /(amount_eur|price_eur|fee_eur|insurance_max_per_item|insurance_max_aggregate|insurance_deductible|company_capital)$/i;
const AUTO_INT_RE   = /(_days|_years|grace_days|qty)$/i;

// Default per chiavi che non vengono trovate in `data` — usati prima di
// segnalare un placeholder come MISSING. Questi sono valori "ragionevoli"
// che la maggioranza delle piattaforme tengono come default. Non sostituiscono
// la configurazione esplicita via platform_settings, ma evitano che i template
// risultino non firmabili per omissioni residuali.
const TEMPLATE_DEFAULTS: Record<string, string> = {
  // Numeri di giorni standard del mondo legale italiano
  'counterparty.custody_payment_grace_days': '30',
  'counterparty.contract_offer_validity_days': '7',
  'counterparty.payment_due_days_vendor': '15',
  'counterparty.physical_delivery_days': '15',
  'counterparty.consumer_recess_days': '14',
  // Legge applicabile + foro: defaults se non configurati
  'counterparty.legge_applicabile': 'legge italiana',
  'counterparty.foro_competente': 'Tribunale di Messina',
};

function autoFormat(keyPath: string, val: any): string {
  if (val == null || val === '') return '';
  const last = keyPath.split('.').pop() || keyPath;
  if (AUTO_MONEY_RE.test(last)) return fmtMoney(val);
  if (AUTO_INT_RE.test(last))   return fmtInt(val);
  return String(val);
}

function renderTemplate(md: string, data: Record<string, unknown>): {
  rendered: string;
  missing: string[];
} {
  const missing: string[] = [];

  // Match {{key.path}} oppure {{key.path | filter}}
  const result = md.replace(
    /\{\{\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*(?:\|\s*([a-zA-Z]+)\s*)?\}\}/g,
    (_full, key, filter) => {
      let val = getDeep(data, key);
      // Se non troviamo il valore, prova i defaults built-in
      if (val === undefined || val === null || val === '') {
        if (Object.prototype.hasOwnProperty.call(TEMPLATE_DEFAULTS, key)) {
          val = TEMPLATE_DEFAULTS[key];
        } else {
          missing.push(key);
          return `[[MISSING:${key}]]`;
        }
      }
      // Filter esplicito ha priorità
      if (filter === 'money') return fmtMoney(val);
      if (filter === 'int')   return fmtInt(val);
      if (filter === 'upper') return String(val).toUpperCase();
      // Auto-format basato sul nome della chiave
      return autoFormat(key, val);
    }
  );

  return { rendered: result, missing: [...new Set(missing)] };
}

function getDeep(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}


// ═════════════════════════════════════════════════════════════════════════════
// PDF rendering
// ═════════════════════════════════════════════════════════════════════════════
//
// Strategia: rendering testuale tipograficamente curato del Markdown.
// pdf-lib non ha un parser markdown nativo; implementiamo un mini-parser
// che gestisce: titoli (#, ##, ###), grassetto **, italico *, liste (-, 1.),
// linee orizzontali (---), paragrafi, page breaks (---PAGE---).
//
// Per una v1 "professional": font Times Roman per il body, Helvetica Bold
// per i titoli. Page format A4 (595×842 pt).
// ═════════════════════════════════════════════════════════════════════════════

interface PdfHeader {
  contractNumber: string;
  companyName: string;
}

const PAGE_W = 595.28;   // A4
const PAGE_H = 841.89;
const MARGIN_X = 56;     // ~2cm
const MARGIN_TOP = 64;
const MARGIN_BOTTOM = 64;
const LINE_H = 14;
const FONT_BODY  = 10.5;
const FONT_H1    = 15;   // Era 18 — con NotoSerif Bold + uppercase rischia overflow
const FONT_H2    = 13;
const FONT_H3    = 11.5;

async function renderPdf(opts: {
  title:          string;
  contractNumber: string;
  companyName:    string;
  bodyMd:         string;
  attachments?:   { title: string; bodyMd: string }[];
}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(opts.title);
  pdf.setSubject('RareBlock - Contratto');
  pdf.setProducer('RareBlock Contracts Engine');
  pdf.setCreator('RareBlock');
  pdf.setCreationDate(new Date());

  // Embed font UTF-8 (con subset: true per ridurre dimensione PDF a soli glifi usati)
  const [regBytes, boldBytes, italBytes, serifBoldBytes] = await Promise.all([
    loadFontBytes('regular'),
    loadFontBytes('bold'),
    loadFontBytes('italic'),
    loadFontBytes('serifBold'),
  ]);
  const fontBody     = await pdf.embedFont(regBytes,       { subset: true });
  const fontBodyBold = await pdf.embedFont(boldBytes,      { subset: true });
  const fontBodyIt   = await pdf.embedFont(italBytes,      { subset: true });
  const fontTitle    = await pdf.embedFont(serifBoldBytes, { subset: true });

  const ctx: RenderContext = {
    pdf,
    page: pdf.addPage([PAGE_W, PAGE_H]),
    y: PAGE_H - MARGIN_TOP,
    pageIdx: 1,
    fonts: { body: fontBody, bold: fontBodyBold, italic: fontBodyIt, title: fontTitle },
    header: { contractNumber: opts.contractNumber, companyName: opts.companyName },
    title: opts.title,
  };

  drawHeader(ctx);
  drawTitle(ctx, opts.title);

  renderMd(ctx, opts.bodyMd);

  // Allegati su nuova pagina
  if (opts.attachments && opts.attachments.length) {
    for (const att of opts.attachments) {
      newPage(ctx);
      drawTitle(ctx, att.title, FONT_H2);
      renderMd(ctx, att.bodyMd);
    }
  }

  // Footer su tutte le pagine
  applyFooters(ctx);

  return await pdf.save();
}

interface RenderContext {
  pdf: PDFDocument;
  page: any;
  y: number;
  pageIdx: number;
  fonts: { body: any; bold: any; italic: any; title: any };
  header: PdfHeader;
  title: string;
}

function drawHeader(ctx: RenderContext) {
  const { page, fonts, header } = ctx;
  // Top-right: numero contratto
  const hdrText = header.contractNumber;
  const hdrWidth = fonts.body.widthOfTextAtSize(hdrText, 9);
  page.drawText(hdrText, {
    x: PAGE_W - MARGIN_X - hdrWidth,
    y: PAGE_H - 36,
    size: 9,
    font: fonts.body,
    color: rgb(0.45, 0.45, 0.45),
  });
  // Top-left: company
  page.drawText(header.companyName || 'RareBlock', {
    x: MARGIN_X,
    y: PAGE_H - 36,
    size: 9,
    font: fonts.bold,
    color: rgb(0.30, 0.30, 0.30),
  });
  // Linea sotto header
  page.drawLine({
    start: { x: MARGIN_X, y: PAGE_H - 46 },
    end:   { x: PAGE_W - MARGIN_X, y: PAGE_H - 46 },
    thickness: 0.5,
    color: rgb(0.78, 0.66, 0.30),  // gold tone
  });
}

function applyFooters(ctx: RenderContext) {
  const totalPages = ctx.pdf.getPageCount();
  for (let i = 0; i < totalPages; i++) {
    const p = ctx.pdf.getPage(i);
    const pageNumStr = `pag. ${i + 1} / ${totalPages}`;
    const w = ctx.fonts.body.widthOfTextAtSize(pageNumStr, 8);
    p.drawText(pageNumStr, {
      x: PAGE_W - MARGIN_X - w,
      y: 32,
      size: 8,
      font: ctx.fonts.body,
      color: rgb(0.5, 0.5, 0.5),
    });
    p.drawText(ctx.header.contractNumber, {
      x: MARGIN_X,
      y: 32,
      size: 8,
      font: ctx.fonts.body,
      color: rgb(0.5, 0.5, 0.5),
    });
    p.drawLine({
      start: { x: MARGIN_X, y: 44 },
      end:   { x: PAGE_W - MARGIN_X, y: 44 },
      thickness: 0.3,
      color: rgb(0.85, 0.85, 0.85),
    });
  }
}

function drawTitle(ctx: RenderContext, title: string, size = FONT_H1) {
  const maxW = PAGE_W - 2 * MARGIN_X;
  const wrapped = wrapText(title, ctx.fonts.title, size, maxW);
  ensureSpace(ctx, wrapped.length * (size + 4) + 16);
  for (const line of wrapped) {
    ensureSpace(ctx, size + 4);
    ctx.page.drawText(line, {
      x: MARGIN_X,
      y: ctx.y - size,
      size,
      font: ctx.fonts.title,
      color: rgb(0.15, 0.15, 0.15),
    });
    ctx.y -= size + 4;
  }
  ctx.y -= 10;
}

function newPage(ctx: RenderContext) {
  ctx.page = ctx.pdf.addPage([PAGE_W, PAGE_H]);
  ctx.pageIdx++;
  ctx.y = PAGE_H - MARGIN_TOP;
  drawHeader(ctx);
}

function ensureSpace(ctx: RenderContext, needed: number) {
  if (ctx.y - needed < MARGIN_BOTTOM) newPage(ctx);
}

function wrapText(text: string, font: any, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    const test = current ? current + ' ' + w : w;
    const width = font.widthOfTextAtSize(test, size);
    if (width > maxWidth && current) {
      lines.push(current);
      current = w;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Rendering minimale del Markdown. Non gestisce tabelle né immagini.
 * Supporta: # ## ###, **bold**, *italic*, - lista, 1. lista numerata,
 *           --- linea orizzontale, ---PAGE--- page break, paragrafi.
 * I marker [[MISSING:xxx]] vengono evidenziati in rosso (segnalano
 * placeholder non risolti — utili per DRAFT, vietano la firma in produzione).
 */
function renderMd(ctx: RenderContext, md: string) {
  const lines = md.split('\n');
  const maxW = PAGE_W - 2 * MARGIN_X;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Page break esplicito
    if (trimmed === '---PAGE---') { newPage(ctx); continue; }

    // Linea orizzontale
    if (/^---+$/.test(trimmed)) {
      ensureSpace(ctx, 14);
      ctx.page.drawLine({
        start: { x: MARGIN_X, y: ctx.y - 4 },
        end:   { x: PAGE_W - MARGIN_X, y: ctx.y - 4 },
        thickness: 0.5,
        color: rgb(0.78, 0.66, 0.30),
      });
      ctx.y -= 14;
      continue;
    }

    // Titoli
    if (/^### /.test(trimmed)) { renderHeading(ctx, trimmed.slice(4), FONT_H3); continue; }
    if (/^## /.test(trimmed))  { renderHeading(ctx, trimmed.slice(3), FONT_H2); continue; }
    if (/^# /.test(trimmed))   { renderHeading(ctx, trimmed.slice(2), FONT_H1); continue; }

    // Liste
    if (/^[-*] /.test(trimmed)) { renderListItem(ctx, '•', trimmed.slice(2), maxW); continue; }
    const numMatch = trimmed.match(/^(\d+)\. (.+)$/);
    if (numMatch) { renderListItem(ctx, numMatch[1] + '.', numMatch[2], maxW); continue; }

    // Riga vuota → spazio
    if (trimmed === '') {
      ctx.y -= LINE_H * 0.5;
      continue;
    }

    // Paragrafo normale (con supporto bold/italic inline)
    renderParagraph(ctx, trimmed, maxW);
  }
}

function renderHeading(ctx: RenderContext, text: string, size: number) {
  const maxW = PAGE_W - 2 * MARGIN_X;
  // Word-wrap dei titoli: serif bold a 16pt+ può facilmente sforare margine.
  const wrapped = wrapText(stripFormat(text), ctx.fonts.title, size, maxW);
  const totalH = wrapped.length * (size + 4) + 12;
  ensureSpace(ctx, totalH);
  ctx.y -= 6;  // top spacing
  for (const line of wrapped) {
    ensureSpace(ctx, size + 4);
    ctx.page.drawText(line, {
      x: MARGIN_X,
      y: ctx.y - size,
      size,
      font: ctx.fonts.title,
      color: rgb(0.15, 0.15, 0.15),
    });
    ctx.y -= size + 4;
  }
  ctx.y -= 6;  // bottom spacing
}

function renderListItem(ctx: RenderContext, bullet: string, text: string, maxW: number) {
  const indent = 18;
  const wrapped = wrapText(stripFormat(text), ctx.fonts.body, FONT_BODY, maxW - indent);
  ensureSpace(ctx, wrapped.length * LINE_H);
  for (let j = 0; j < wrapped.length; j++) {
    ensureSpace(ctx, LINE_H);
    if (j === 0) {
      ctx.page.drawText(bullet, {
        x: MARGIN_X + 2,
        y: ctx.y - FONT_BODY,
        size: FONT_BODY,
        font: ctx.fonts.body,
        color: rgb(0.30, 0.30, 0.30),
      });
    }
    drawInlineFormatted(ctx, wrapped[j], MARGIN_X + indent, ctx.y - FONT_BODY);
    ctx.y -= LINE_H;
  }
}

function renderParagraph(ctx: RenderContext, text: string, maxW: number) {
  const wrapped = wrapText(stripFormat(text), ctx.fonts.body, FONT_BODY, maxW);
  for (const w of wrapped) {
    ensureSpace(ctx, LINE_H);
    drawInlineFormatted(ctx, w, MARGIN_X, ctx.y - FONT_BODY);
    ctx.y -= LINE_H;
  }
  ctx.y -= 3;  // small paragraph spacing
}

function stripFormat(s: string): string {
  // Per il wrap calcoliamo larghezza sul testo "naked" (senza marker md)
  return s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/\[\[MISSING:([^\]]+)\]\]/g, '«$1»');
}

/**
 * Disegna una riga supportando **bold**, *italic*, [[MISSING:xxx]] in rosso.
 * Non sappiamo a priori dove cade un marker su una riga wrapped — semplifichiamo
 * disegnando token-by-token con switch font.
 */
function drawInlineFormatted(ctx: RenderContext, text: string, x: number, y: number) {
  // Tokenize: bold, italic, missing, plain
  const tokens: { txt: string; style: 'b'|'i'|'m'|'n' }[] = [];
  const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|\[\[MISSING:([^\]]+)\]\])/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) tokens.push({ txt: text.slice(last, m.index), style: 'n' });
    if (m[2]) tokens.push({ txt: m[2], style: 'b' });
    else if (m[3]) tokens.push({ txt: m[3], style: 'i' });
    else if (m[4]) tokens.push({ txt: '«' + m[4] + '»', style: 'm' });
    last = re.lastIndex;
  }
  if (last < text.length) tokens.push({ txt: text.slice(last), style: 'n' });

  let curX = x;
  for (const tk of tokens) {
    const font = tk.style === 'b' ? ctx.fonts.bold : tk.style === 'i' ? ctx.fonts.italic : ctx.fonts.body;
    const color = tk.style === 'm' ? rgb(0.85, 0.20, 0.20) : rgb(0.15, 0.15, 0.15);
    ctx.page.drawText(tk.txt, { x: curX, y, size: FONT_BODY, font, color });
    curX += font.widthOfTextAtSize(tk.txt, FONT_BODY);
  }
}


// ═════════════════════════════════════════════════════════════════════════════
// Validazione pre-firma: KYC + dati piattaforma
// ═════════════════════════════════════════════════════════════════════════════
const PLATFORM_REQUIRED_KEYS = [
  'company_legal_name','company_legal_form','company_vat','company_pec',
  'legal_rep_name','legal_rep_role','foro_competente',
  'insurance_company','insurance_policy_number','insurance_max_per_item',
];

function checkPlatformReadiness(settings: Record<string, any>): string[] {
  const missing: string[] = [];
  for (const k of PLATFORM_REQUIRED_KEYS) {
    const v = settings[k];
    if (v === undefined || v === null || v === '' || v === 'DA COMPILARE') missing.push(k);
  }
  // Sede legale (oggetto)
  const addr = settings['company_office_address'] || {};
  if (!addr.street || !addr.zip || !addr.city) missing.push('company_office_address');
  return missing;
}

function checkUserKyc(profile: any): string[] {
  const missing: string[] = [];
  if (!profile?.first_name)        missing.push('first_name');
  if (!profile?.last_name)         missing.push('last_name');
  if (!profile?.birth_date)        missing.push('birth_date');
  if (!profile?.birth_place)       missing.push('birth_place');
  if (!profile?.fiscal_code)       missing.push('fiscal_code');
  if (!profile?.id_doc_type)       missing.push('id_doc_type');
  if (!profile?.id_doc_number)     missing.push('id_doc_number');
  if (!profile?.id_doc_front_path) missing.push('id_doc_front_path');
  if (!profile?.phone_verified_at) missing.push('phone_verified');
  if (!profile?.res_address)       missing.push('res_address');
  if (!profile?.res_zip)           missing.push('res_zip');
  if (!profile?.res_city)          missing.push('res_city');
  if (!profile?.gdpr_privacy_accepted_at) missing.push('gdpr_privacy');
  if (!profile?.gdpr_tos_accepted_at)     missing.push('gdpr_tos');
  return missing;
}


// ═════════════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═════════════════════════════════════════════════════════════════════════════
interface PrepareInput {
  template_code: 'VENDOR_MANDATE' | 'BUYER_PURCHASE_CUSTODY' | 'BUYER_FRACTIONAL';
  subject_data:  Record<string, any>;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405);

  try {
    const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!;
    const SUPABASE_ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY')!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // ── Auth ──
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'missing_authorization' }, 401);

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: ud, error: ue } = await userClient.auth.getUser();
    if (ue || !ud?.user) return json({ error: 'invalid_session' }, 401);
    const user = ud.user;

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // ── Parse body ──
    const body = (await req.json().catch(() => null)) as PrepareInput | null;
    if (!body || !body.template_code) return json({ error: 'missing_template_code' }, 400);
    if (!['VENDOR_MANDATE','BUYER_PURCHASE_CUSTODY','BUYER_FRACTIONAL'].includes(body.template_code)) {
      return json({ error: 'invalid_template_code' }, 400);
    }
    const subjectData = body.subject_data || {};

    // ── Carica template attivo (massima version per il code) ──
    const { data: tpls, error: tplErr } = await sb
      .from('contract_templates')
      .select('*')
      .eq('code', body.template_code)
      .eq('is_active', true)
      .order('version', { ascending: false })
      .limit(1);
    if (tplErr) return json({ error: 'template_load_failed', detail: tplErr.message }, 500);
    if (!tpls || !tpls.length) {
      return json({ error: 'no_active_template', detail: 'Template ' + body.template_code + ' non attivo. Richiede revisione legale e attivazione admin.' }, 412);
    }
    const tpl = tpls[0];

    // ── Carica anagrafica utente ──
    const { data: profile, error: pErr } = await sb
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle();
    if (pErr) return json({ error: 'profile_load_failed', detail: pErr.message }, 500);

    const kycMissing = checkUserKyc(profile);
    if (kycMissing.length) {
      return json({
        error: 'kyc_incomplete',
        missing: kycMissing,
        message: 'Completa il tuo profilo prima di firmare contratti.',
      }, 412);
    }

    // ── Carica dati piattaforma ──
    const { data: settingsRows } = await sb
      .from('platform_settings')
      .select('key, value, is_sensitive')
      .in('category', ['company','legal','insurance','commercial']);
    const settings: Record<string, any> = {};
    (settingsRows || []).forEach((r: any) => { settings[r.key] = r.value; });

    const platformMissing = checkPlatformReadiness(settings);
    if (platformMissing.length) {
      return json({
        error: 'platform_not_ready',
        missing: platformMissing,
        message: 'I dati di piattaforma (società/polizza) non sono ancora completi. Contatta l\'amministratore.',
      }, 412);
    }

    // ── Genera numero contratto ──
    const subjectType = body.template_code === 'VENDOR_MANDATE'         ? 'vendor_mandate'
                      : body.template_code === 'BUYER_PURCHASE_CUSTODY' ? 'buyer_purchase_custody'
                      :                                                    'buyer_fractional';
    const { data: numRow, error: numErr } = await sb.rpc('next_contract_number', { p_type: subjectType });
    if (numErr || !numRow) return json({ error: 'serial_generation_failed', detail: numErr?.message }, 500);
    const contractNumber: string = numRow as string;

    // ── Compose template data ──
    const today = new Date();
    const itDate = today.toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });

    const partySnapshot = {
      first_name:    profile.first_name,
      last_name:     profile.last_name,
      full_name:     profile.full_name || (profile.first_name + ' ' + profile.last_name),
      birth_date:    profile.birth_date,
      birth_place:   profile.birth_place,
      birth_country: profile.birth_country,
      nationality:   profile.nationality,
      fiscal_code:   profile.fiscal_code,
      id_doc_type:   profile.id_doc_type,
      id_doc_number: profile.id_doc_number,
      id_doc_issuer: profile.id_doc_issuer,
      id_doc_issue_date:  profile.id_doc_issue_date,
      id_doc_expiry_date: profile.id_doc_expiry_date,
      res_address:   profile.res_address,
      res_civic:     profile.res_civic,
      res_zip:       profile.res_zip,
      res_city:      profile.res_city,
      res_province:  profile.res_province,
      res_country:   profile.res_country,
      phone_e164:    profile.phone_e164,
      email:         user.email,
    };

    // Counterparty snapshot (RareBlock)
    const counterpartySnapshot: Record<string, any> = {};
    for (const k of [
      'company_legal_name','company_legal_form','company_vat','company_fiscal_code',
      'company_rea','company_chamber','company_capital','company_pec','company_email',
      'company_office_address','legal_rep_name','legal_rep_fiscal_code','legal_rep_role',
      'foro_competente','legge_applicabile',
      // Polizza (sensitive ma ammessi nel contratto firmato)
      'insurance_company','insurance_policy_number','insurance_policy_type',
      'insurance_max_per_item','insurance_max_aggregate','insurance_deductible',
      'insurance_coverage_start','insurance_coverage_end','insurance_exclusions',
      'insurance_caveau_address',
    ]) {
      counterpartySnapshot[k] = settings[k];
    }

    const tdata = {
      contract: {
        number: contractNumber,
        date_it: itDate,
      },
      party: partySnapshot,
      // Address joinato per leggibilità nei template
      party_address_full: [
        partySnapshot.res_address, partySnapshot.res_civic
      ].filter(Boolean).join(' ') + ', ' +
        [partySnapshot.res_zip, partySnapshot.res_city,
         partySnapshot.res_province ? '(' + partySnapshot.res_province + ')' : ''
        ].filter(Boolean).join(' '),
      counterparty: counterpartySnapshot,
      counterparty_address_full: addressJoin(counterpartySnapshot.company_office_address),
      subject: subjectData,
    };

    // ── Render Markdown ──
    const titleSubject =
      body.template_code === 'VENDOR_MANDATE'         ? 'Mandato a vendere con custodia'
    : body.template_code === 'BUYER_PURCHASE_CUSTODY' ? 'Compravendita con custodia'
    :                                                    'Acquisto di quote di comproprietà';

    const { rendered, missing: renderMissing } = renderTemplate(tpl.body_md, tdata);

    // ── Costruzione Allegato A: scheda tecnica del bene ──
    // Statico per ora — in PR successive prenderà dati da inv_products
    // (foto, certificate id, edizione, condizione gradata).
    const allegatoA_md = buildSchedaTecnicaMd(subjectData, body.template_code);

    // Lista ordinata degli allegati con lettere dinamiche A/B/C/D
    const attachmentList: { title: string; bodyMd: string }[] = [];
    let letter = 0;
    const nextLetter = () => String.fromCharCode(65 + letter++);  // A, B, C, D...
    if (allegatoA_md)        attachmentList.push({ title: 'Allegato ' + nextLetter() + ' — Scheda tecnica del bene', bodyMd: allegatoA_md });
    if (tpl.privacy_doc_md)  attachmentList.push({ title: 'Allegato ' + nextLetter() + ' — Informativa Privacy',     bodyMd: renderTemplate(tpl.privacy_doc_md, tdata).rendered });
    if (tpl.fea_doc_md)      attachmentList.push({ title: 'Allegato ' + nextLetter() + ' — Informativa Firma Elettronica', bodyMd: renderTemplate(tpl.fea_doc_md, tdata).rendered });
    if (tpl.recess_form_md)  attachmentList.push({ title: 'Allegato ' + nextLetter() + ' — Modulo recesso (consumatore)',  bodyMd: renderTemplate(tpl.recess_form_md, tdata).rendered });

    // ── Genera PDF ──
    const pdfBytes = await renderPdf({
      title:          titleSubject,
      contractNumber: contractNumber,
      companyName:    counterpartySnapshot.company_legal_name || 'RareBlock',
      bodyMd:         rendered,
      attachments:    attachmentList,
    });

    const pdfSha = await sha256OfBytes(pdfBytes);

    // ── Upload bucket contracts-unsigned ──
    const path = `${user.id}/${contractNumber}.pdf`;
    const { error: upErr } = await sb.storage
      .from('contracts-unsigned')
      .upload(path, pdfBytes, { contentType: 'application/pdf', upsert: true });
    if (upErr) return json({ error: 'pdf_upload_failed', detail: upErr.message }, 500);

    // ── Insert riga contracts ──
    const validityDays = parseInt(String(settings['contract_offer_validity_days'] || 7), 10);
    const expiresAt = new Date(Date.now() + validityDays * 86400 * 1000).toISOString();

    const { data: cIns, error: cInsErr } = await sb
      .from('contracts')
      .insert({
        contract_number:       contractNumber,
        template_id:           tpl.id,
        template_code:         tpl.code,
        template_version:      tpl.version,
        template_snapshot_md:  tpl.body_md,
        subject_type:          subjectType,
        party_user_id:         user.id,
        party_snapshot:        partySnapshot,
        counterparty_snapshot: counterpartySnapshot,
        related_product_id:    subjectData.product_id || null,
        related_order_id:      subjectData.order_id   || null,
        related_holding_id:    subjectData.holding_id || null,
        related_vendor_id:     subjectData.vendor_id  || null,
        subject_data:          subjectData,
        pdf_unsigned_path:     path,
        pdf_unsigned_sha256:   pdfSha,
        status:                'pending_signature',
        expires_at:            expiresAt,
        created_by:            user.id,
      })
      .select('id')
      .single();
    if (cInsErr || !cIns) return json({ error: 'contract_insert_failed', detail: cInsErr?.message }, 500);

    // ── Audit event ──
    await sb.from('contract_signature_audit').insert({
      contract_id:   cIns.id,
      event_type:    'prepared',
      event_data:    {
        template_code: tpl.code,
        template_version: tpl.version,
        unsigned_sha256: pdfSha,
        render_missing_placeholders: renderMissing,
      },
      actor_user_id: user.id,
      ip:            req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null,
      user_agent:    req.headers.get('user-agent') || null,
    });

    // ── Signed URL per download del draft (1h) ──
    const { data: signed } = await sb.storage
      .from('contracts-unsigned')
      .createSignedUrl(path, 3600);

    return json({
      ok:                true,
      contract_id:       cIns.id,
      contract_number:   contractNumber,
      pdf_signed_url:    signed?.signedUrl || null,
      pdf_unsigned_sha256: pdfSha,
      expires_at:        expiresAt,
      missing_placeholders: renderMissing,   // utili in DRAFT, vuoti in produzione
      warnings: renderMissing.length
        ? ['Il template contiene placeholder non risolti: il contratto è una BOZZA non firmabile in produzione.']
        : [],
    });

  } catch (e: any) {
    return json({ error: 'unexpected', detail: e?.message ?? String(e) }, 500);
  }
});


// ═════════════════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════════════════
function addressJoin(addr: any): string {
  if (!addr || typeof addr !== 'object') return '';
  const parts = [
    [addr.street, addr.civic].filter(Boolean).join(' '),
    [addr.zip, addr.city].filter(Boolean).join(' '),
    addr.province ? `(${addr.province})` : '',
    addr.country && addr.country !== 'IT' ? addr.country : '',
  ].filter(Boolean);
  return parts.join(', ');
}

// ═════════════════════════════════════════════════════════════════════════════
// Scheda tecnica del bene (Allegato A) — generata dinamicamente dal subject_data.
// In PR successive verrà arricchita con dati da inv_products (foto, certificato
// di grading, edizione, condizione, hash certificato digitale).
// ═════════════════════════════════════════════════════════════════════════════
function buildSchedaTecnicaMd(s: any, templateCode: string): string {
  if (!s || typeof s !== 'object') return '';
  const lines: string[] = [];

  if (templateCode === 'BUYER_PURCHASE_CUSTODY' || templateCode === 'BUYER_FRACTIONAL') {
    lines.push('# Scheda tecnica del bene');
    lines.push('');
    lines.push('Il presente allegato descrive in dettaglio il bene oggetto del contratto.');
    lines.push('');
    lines.push('## Identificazione');
    lines.push('');
    if (s.product_name)     lines.push(`- **Denominazione**: ${s.product_name}`);
    if (s.product_id)       lines.push(`- **Codice prodotto RareBlock**: ${s.product_id}`);
    if (s.set_name)         lines.push(`- **Set**: ${s.set_name}`);
    if (s.card_number)      lines.push(`- **Numero**: ${s.card_number}`);
    if (s.edition)          lines.push(`- **Edizione**: ${s.edition}`);
    if (s.language)         lines.push(`- **Lingua**: ${s.language}`);
    lines.push('');
    lines.push('## Condizione e autenticazione');
    lines.push('');
    if (s.grading_company)  lines.push(`- **Ente di grading**: ${s.grading_company}`);
    if (s.grade)            lines.push(`- **Grado**: ${s.grade}`);
    if (s.grading_cert)     lines.push(`- **Numero certificato**: ${s.grading_cert}`);
    if (!s.grading_company && !s.grade) {
      lines.push('- **Stato**: condizione documentata mediante audit interno RareBlock con report fotografico ad alta risoluzione, archiviato presso il caveau e disponibile su richiesta.');
    }
    lines.push('');
    lines.push('## Termini economici');
    lines.push('');
    if (s.amount_eur)        lines.push(`- **Prezzo di acquisto**: ${fmtMoney(s.amount_eur)} EUR`);
    if (s.qty != null)       lines.push(`- **Quantità**: ${fmtInt(s.qty)}`);
    if (s.custody_fee_eur != null) lines.push(`- **Fee di custodia annua**: ${fmtMoney(s.custody_fee_eur)} EUR`);
    if (s.custody_tier_name) lines.push(`- **Fascia di custodia**: ${s.custody_tier_name}`);
    lines.push('');

    // Sezione SOLO per fractional: regime di comproprietà + trigger di vendita.
    if (templateCode === 'BUYER_FRACTIONAL') {
      lines.push('## Regime di comproprietà');
      lines.push('');
      if (s.total_quotes != null)      lines.push(`- **Quote totali del Bene**: ${fmtInt(s.total_quotes)}`);
      if (s.qty != null && s.total_quotes != null) {
        const pct = (Number(s.qty) / Number(s.total_quotes)) * 100;
        if (isFinite(pct)) lines.push(`- **Percentuale di proprietà acquistata**: ${pct.toFixed(2).replace('.', ',')}%`);
      }
      lines.push('');
      lines.push('## Trigger di vendita del Bene');
      lines.push('');
      if (s.target_price_eur != null)  lines.push(`- **Target Price (Trigger A — OR continuo)**: ${fmtMoney(s.target_price_eur)} EUR`);
      if (s.exit_window_years != null) lines.push(`- **Exit Window (Trigger B)**: ${fmtInt(s.exit_window_years)} anni dal lancio del Bene sulla piattaforma`);
      if (s.extension_years != null)   lines.push(`- **Rinvio in caso di voto contrario**: ${fmtInt(s.extension_years)} anni`);
      lines.push('');
      lines.push('Una volta raggiunto uno dei due trigger, il Bene viene venduto e il ricavato netto distribuito ai Comproprietari pro-quota.');
      lines.push('');
    }

    lines.push('## Certificato Digitale');
    lines.push('');
    if (s.nft_chain_id && s.nft_contract && s.nft_token_id) {
      lines.push(`- **Blockchain**: chain id ${s.nft_chain_id}`);
      lines.push(`- **Smart contract**: ${s.nft_contract}`);
      lines.push(`- **Token ID**: ${s.nft_token_id}`);
    } else {
      lines.push('Il Certificato Digitale viene emesso a favore dell\'Acquirente al momento del trasferimento di proprietà ed è verificabile pubblicamente sulla blockchain Base.');
    }
  }
  else if (templateCode === 'VENDOR_MANDATE') {
    lines.push('# Lista dei beni conferiti in mandato');
    lines.push('');
    lines.push('Elenco dei beni oggetto del presente mandato a vendere.');
    lines.push('');
    if (s.commission_pct != null) {
      lines.push(`**Commissione applicata**: ${fmtMoney(s.commission_pct)}% sul prezzo lordo di vendita`);
      lines.push('');
    }
    if (Array.isArray(s.products) && s.products.length) {
      let i = 1;
      for (const p of s.products) {
        lines.push(`### Bene ${i}: ${p.name || p.product_name || 'Da specificare'}`);
        lines.push('');
        if (p.set_name)        lines.push(`- **Set**: ${p.set_name}`);
        if (p.card_number)     lines.push(`- **Numero**: ${p.card_number}`);
        if (p.condition)       lines.push(`- **Condizione**: ${p.condition}`);
        if (p.grading_company) lines.push(`- **Grading**: ${p.grading_company} ${p.grade || ''}`);
        if (p.reserve_price)   lines.push(`- **Prezzo di riserva**: ${fmtMoney(p.reserve_price)} EUR`);
        lines.push('');
        i++;
      }
    } else {
      lines.push('*Lista beni da compilare in fase di stipula.*');
    }
  }
  return lines.join('\n');
}
