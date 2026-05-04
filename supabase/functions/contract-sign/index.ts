// =============================================================================
// Supabase Edge Function: contract-sign
// =============================================================================
// SELF-CONTAINED.
//
// Finalizza la firma di un contratto preparato da contract-prepare.
//
// Flusso:
//   1. Verifica auth + ownership del contract_id
//   2. Verifica che il contratto sia in 'pending_signature' e non scaduto
//   3. Verifica OTP via tabella otp_codes (purpose='contract_sign', context_id=contract_id)
//   4. Verifica che le checkbox di consenso siano tutte spuntate
//   5. Carica il PDF unsigned dal bucket
//   6. Appende la PAGINA DI FIRMA (artigianale, branded) con:
//      - dati firmatario, timestamp UTC, IP, UA, hash unsigned, OTP transaction
//      - riferimento normativo art. 26 Reg. UE 910/2014
//      - link verifica pubblica /verify/{contract_number}
//   7. Calcola SHA-256 del PDF finale
//   8. Upload in bucket 'contracts-signed'
//   9. Aggiorna contracts: status='signed', pdf_signed_*, signed_at, signature_audit
//  10. Chiama contract-notarize (asincrono, no-block) per ancorare on-chain
//  11. Insert audit events: 'pdf_signed' + (poi async) 'notarized'
//  12. Ritorna { contract_id, signed_pdf_url, notarization_status, basescan_url? }
//
// Body:
//   {
//     "contract_id": "<uuid>",
//     "otp_id":      "<uuid>",     // dalla precedente call sms-otp-send
//     "code":        "123456",
//     "consents": {
//       "read_contract": true,
//       "fea_acknowledged": true,
//       "data_processing": true
//     }
//   }
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { PDFDocument, rgb } from 'https://esm.sh/pdf-lib@1.17.1';
import fontkit from 'https://esm.sh/@pdf-lib/fontkit@1.1.1';


// ═════════════════════════════════════════════════════════════════════════════
// Font UTF-8 (vedi commento in contract-prepare)
// ═════════════════════════════════════════════════════════════════════════════
const FONT_URLS = {
  regular:   'https://cdn.jsdelivr.net/fontsource/fonts/noto-sans@latest/latin-400-normal.ttf',
  bold:      'https://cdn.jsdelivr.net/fontsource/fonts/noto-sans@latest/latin-700-normal.ttf',
  mono:      'https://cdn.jsdelivr.net/fontsource/fonts/jetbrains-mono@latest/latin-500-normal.ttf',
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
// HTTP / hashing helpers
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
async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  let s = '0x';
  for (const b of new Uint8Array(buf)) s += b.toString(16).padStart(2, '0');
  return s;
}
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', data);
  let s = '';
  for (const b of new Uint8Array(buf)) s += b.toString(16).padStart(2, '0');
  return s;
}
async function verifyOtpHash(code: string, stored: string): Promise<boolean> {
  const idx = stored.indexOf(':');
  if (idx <= 0) return false;
  const salt = stored.slice(0, idx);
  const expHash = stored.slice(idx + 1);
  if (!salt || !expHash) return false;
  const actHash = await sha256Hex(`${salt}:${code}`);
  // timing-safe
  const len = Math.max(actHash.length, expHash.length);
  let mismatch = actHash.length ^ expHash.length;
  for (let i = 0; i < len; i++) {
    const ca = i < actHash.length ? actHash.charCodeAt(i) : 0;
    const cb = i < expHash.length ? expHash.charCodeAt(i) : 0;
    mismatch |= ca ^ cb;
  }
  return mismatch === 0;
}


// ═════════════════════════════════════════════════════════════════════════════
// Pagina di firma (artigianale, brand-aligned)
// ═════════════════════════════════════════════════════════════════════════════
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 56;

interface SignaturePageData {
  contractNumber: string;
  signerName:     string;
  signerFiscalCode: string;
  signerBirthDate:  string;
  signerBirthPlace: string;
  phoneLast4:     string;
  signedAtUtc:    string;
  ip:             string;
  userAgent:      string;
  unsignedSha256: string;
  otpTransactionId: string;       // sms_provider_message_id Twilio
  otpId:          string;
  channel:        string;         // 'sms' | 'whatsapp'
  verifyUrl:      string;
  companyName:    string;
}

async function appendSignaturePage(pdfBytes: Uint8Array, data: SignaturePageData): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(pdfBytes);
  pdf.registerFontkit(fontkit);
  const page = pdf.addPage([PAGE_W, PAGE_H]);

  const [regBytes, boldBytes, monoBytes, serifBoldBytes] = await Promise.all([
    loadFontBytes('regular'),
    loadFontBytes('bold'),
    loadFontBytes('mono'),
    loadFontBytes('serifBold'),
  ]);
  const fontBody  = await pdf.embedFont(regBytes,       { subset: true });
  const fontBold  = await pdf.embedFont(boldBytes,      { subset: true });
  const fontMono  = await pdf.embedFont(monoBytes,      { subset: true });
  const fontTitle = await pdf.embedFont(serifBoldBytes, { subset: true });

  const gold = rgb(0.78, 0.66, 0.30);
  const dark = rgb(0.15, 0.15, 0.15);
  const muted = rgb(0.45, 0.45, 0.45);
  const mutedLight = rgb(0.65, 0.65, 0.65);

  // Top: gold line + company
  page.drawLine({
    start: { x: MARGIN, y: PAGE_H - 56 },
    end:   { x: PAGE_W - MARGIN, y: PAGE_H - 56 },
    thickness: 1.2, color: gold,
  });
  page.drawText(data.companyName, {
    x: MARGIN, y: PAGE_H - 48,
    size: 9, font: fontBold, color: muted,
  });
  const num = data.contractNumber;
  const numW = fontBody.widthOfTextAtSize(num, 9);
  page.drawText(num, {
    x: PAGE_W - MARGIN - numW, y: PAGE_H - 48,
    size: 9, font: fontBody, color: muted,
  });

  // Eyebrow
  page.drawText('FIRMA ELETTRONICA AVANZATA', {
    x: MARGIN, y: PAGE_H - 100,
    size: 9, font: fontBold, color: gold,
  });

  // Title
  page.drawText('Verbale di sottoscrizione', {
    x: MARGIN, y: PAGE_H - 128,
    size: 22, font: fontTitle, color: dark,
  });

  // Subtitle
  page.drawText(
    'Sottoscrizione del documento ai sensi dell\'art. 26 Reg. UE 910/2014 (eIDAS)',
    {
      x: MARGIN, y: PAGE_H - 152,
      size: 10, font: fontBody, color: muted,
    }
  );
  page.drawText(
    'e dell\'art. 20 D.Lgs. 82/2005 (Codice dell\'Amministrazione Digitale).',
    {
      x: MARGIN, y: PAGE_H - 167,
      size: 10, font: fontBody, color: muted,
    }
  );

  // Body — dichiarazione formale
  const dichY = PAGE_H - 210;
  const dichWidth = PAGE_W - 2 * MARGIN;
  const dichText = `Il sottoscritto ${data.signerName}, nato il ${data.signerBirthDate} a ${data.signerBirthPlace}, codice fiscale ${data.signerFiscalCode}, dichiara di aver letto integralmente il documento contrattuale n. ${data.contractNumber} e di sottoscriverlo apponendo la propria Firma Elettronica Avanzata, identificata mediante codice OTP ricevuto al numero di cellulare verificato terminante in ${data.phoneLast4}.`;

  // word wrap manuale
  const wrapped = wrapText(dichText, fontBody, 10.5, dichWidth);
  let cy = dichY;
  for (const line of wrapped) {
    page.drawText(line, { x: MARGIN, y: cy, size: 10.5, font: fontBody, color: dark });
    cy -= 16;
  }

  // Box dati tecnici (gold border, light bg)
  const boxY = cy - 24;
  const boxH = 200;
  page.drawRectangle({
    x: MARGIN, y: boxY - boxH, width: dichWidth, height: boxH,
    borderColor: gold, borderWidth: 0.8,
  });
  // Sezione header
  page.drawText('DATI TECNICI DI FIRMA', {
    x: MARGIN + 12, y: boxY - 18,
    size: 8, font: fontBold, color: gold,
  });

  // Tabella dati
  const rows = [
    ['Numero contratto',        data.contractNumber],
    ['Firmatario',              `${data.signerName} (CF ${data.signerFiscalCode})`],
    ['Cellulare',               `+•• •• •• ${data.phoneLast4} (verificato)`],
    ['Canale OTP',              data.channel === 'whatsapp' ? 'WhatsApp Business' : 'SMS'],
    ['Timestamp UTC',           data.signedAtUtc],
    ['Indirizzo IP',            data.ip || 'n/d'],
    ['User Agent',              (data.userAgent || 'n/d').slice(0, 60)],
    ['SHA-256 documento',       short(data.unsignedSha256, 28)],
    ['OTP Transaction ID',      data.otpTransactionId || data.otpId.slice(0, 16)],
  ];

  const tblTop = boxY - 36;
  const labelX = MARGIN + 14;
  const valueX = MARGIN + 160;
  let ry = tblTop;
  for (const [label, val] of rows) {
    page.drawText(label, { x: labelX, y: ry, size: 8.5, font: fontBody, color: muted });
    page.drawText(val,   { x: valueX, y: ry, size: 8.5, font: fontMono, color: dark });
    ry -= 17;
  }

  // Footer note
  const noteY = boxY - boxH - 30;
  page.drawText(
    'La firma elettronica avanzata identifica il firmatario in modo univoco tramite il',
    { x: MARGIN, y: noteY, size: 9, font: fontBody, color: muted }
  );
  page.drawText(
    'cellulare verificato e l\'OTP monouso, ed è collegata al documento mediante',
    { x: MARGIN, y: noteY - 12, size: 9, font: fontBody, color: muted }
  );
  page.drawText(
    'l\'hash crittografico SHA-256 sopra riportato. Qualsiasi modifica al documento',
    { x: MARGIN, y: noteY - 24, size: 9, font: fontBody, color: muted }
  );
  page.drawText(
    'invalida la firma in modo matematicamente verificabile.',
    { x: MARGIN, y: noteY - 36, size: 9, font: fontBody, color: muted }
  );

  // Verify URL prominente
  page.drawText('Verifica autenticità del documento:', {
    x: MARGIN, y: noteY - 64,
    size: 9, font: fontBold, color: dark,
  });
  page.drawText(data.verifyUrl, {
    x: MARGIN, y: noteY - 78,
    size: 9.5, font: fontMono, color: rgb(0.30, 0.55, 0.95),
  });

  // Bottom gold line
  page.drawLine({
    start: { x: MARGIN, y: 56 },
    end:   { x: PAGE_W - MARGIN, y: 56 },
    thickness: 0.5, color: gold,
  });
  page.drawText(`pag. ${pdf.getPageCount()} / ${pdf.getPageCount()}`, {
    x: PAGE_W - MARGIN - 50, y: 40,
    size: 8, font: fontBody, color: mutedLight,
  });
  page.drawText(data.contractNumber, {
    x: MARGIN, y: 40,
    size: 8, font: fontBody, color: mutedLight,
  });

  return await pdf.save();
}

function wrapText(text: string, font: any, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (font.widthOfTextAtSize(test, size) > maxWidth && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function short(s: string, len = 24): string {
  if (!s) return '';
  if (s.length <= len) return s;
  return s.slice(0, len/2) + '…' + s.slice(-len/2);
}


// ═════════════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═════════════════════════════════════════════════════════════════════════════
interface SignInput {
  contract_id: string;
  otp_id:      string;
  code:        string;
  consents: {
    read_contract:    boolean;
    fea_acknowledged: boolean;
    data_processing:  boolean;
  };
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
    const body = (await req.json().catch(() => null)) as SignInput | null;
    if (!body || !body.contract_id || !body.otp_id || !body.code) {
      return json({ error: 'missing_fields' }, 400);
    }
    if (!body.consents?.read_contract || !body.consents?.fea_acknowledged || !body.consents?.data_processing) {
      return json({ error: 'missing_consents', detail: 'Tutti i consensi sono obbligatori' }, 400);
    }
    if (!/^\d{4,8}$/.test(body.code)) return json({ error: 'invalid_code_format' }, 400);

    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
    const ua = req.headers.get('user-agent') || null;

    // ── Carica contratto ──
    const { data: contract, error: cErr } = await sb
      .from('contracts')
      .select('*')
      .eq('id', body.contract_id)
      .maybeSingle();
    if (cErr) return json({ error: 'contract_load_failed', detail: cErr.message }, 500);
    if (!contract) return json({ error: 'contract_not_found' }, 404);
    if (contract.party_user_id !== user.id) return json({ error: 'not_authorized' }, 403);
    if (contract.status !== 'pending_signature') {
      return json({ error: 'invalid_status', current: contract.status }, 409);
    }
    if (contract.expires_at && new Date(contract.expires_at) < new Date()) {
      // Marca scaduto
      await sb.from('contracts').update({ status: 'expired' }).eq('id', contract.id);
      return json({ error: 'contract_expired' }, 410);
    }

    // ── Verifica OTP ──
    const { data: otp, error: otpErr } = await sb
      .from('otp_codes')
      .select('*')
      .eq('id', body.otp_id)
      .maybeSingle();
    if (otpErr) return json({ error: 'otp_load_failed', detail: otpErr.message }, 500);
    if (!otp) return json({ error: 'otp_not_found' }, 404);
    if (otp.user_id !== user.id) return json({ error: 'otp_not_found' }, 404);
    if (otp.purpose !== 'contract_sign') return json({ error: 'otp_purpose_mismatch' }, 400);
    if (otp.context_id !== body.contract_id) return json({ error: 'otp_context_mismatch' }, 400);
    if (otp.consumed_at) return json({ error: 'otp_already_consumed' }, 410);
    if (new Date(otp.expires_at).getTime() < Date.now()) return json({ error: 'otp_expired' }, 410);
    if (otp.attempts >= otp.max_attempts) return json({ error: 'otp_max_attempts_reached' }, 429);

    const ok = await verifyOtpHash(body.code, otp.code_hash);
    if (!ok) {
      const newAttempts = otp.attempts + 1;
      await sb.from('otp_codes').update({ attempts: newAttempts }).eq('id', otp.id);
      return json({
        error: 'otp_invalid',
        attempts_remaining: Math.max(0, otp.max_attempts - newAttempts),
      }, 401);
    }

    // OTP OK — marca consumato
    const consumedAt = new Date().toISOString();
    await sb.from('otp_codes')
      .update({ consumed_at: consumedAt })
      .eq('id', otp.id)
      .is('consumed_at', null);

    // ── Audit consents + otp_verified ──
    await sb.from('contract_signature_audit').insert([
      {
        contract_id: contract.id,
        event_type:  'consents_accepted',
        event_data:  body.consents,
        actor_user_id: user.id,
        ip, user_agent: ua,
      },
      {
        contract_id: contract.id,
        event_type:  'otp_verified',
        event_data:  {
          otp_id: otp.id,
          channel: otp.channel,
          phone_last4: otp.phone_e164.slice(-4),
          sms_provider_message_id: otp.sms_provider_message_id,
        },
        actor_user_id: user.id,
        ip, user_agent: ua,
      },
    ]);

    // ── Carica PDF unsigned ──
    if (!contract.pdf_unsigned_path) return json({ error: 'no_unsigned_pdf' }, 500);
    const { data: dl, error: dlErr } = await sb.storage
      .from('contracts-unsigned')
      .download(contract.pdf_unsigned_path);
    if (dlErr || !dl) return json({ error: 'pdf_download_failed', detail: dlErr?.message }, 500);
    const unsignedBytes = new Uint8Array(await dl.arrayBuffer());
    const unsignedSha = await sha256OfBytes(unsignedBytes);

    // Verifica integrità (l'hash dovrebbe matchare quello salvato in prepare)
    if (contract.pdf_unsigned_sha256 && contract.pdf_unsigned_sha256.toLowerCase() !== unsignedSha.toLowerCase()) {
      return json({
        error: 'pdf_integrity_check_failed',
        detail: 'Il PDF unsigned è cambiato dopo prepare. Re-prepare il contratto.',
      }, 409);
    }

    // ── URL di verifica pubblica ──
    const baseUrl = Deno.env.get('PUBLIC_VERIFY_BASE_URL') || 'https://www.rareblock.eu/rareblock-verify.html';
    const verifyUrl = `${baseUrl}?serial=${encodeURIComponent(contract.contract_number)}`;

    // ── Carica company name dal counterparty snapshot ──
    const counterparty = (contract.counterparty_snapshot || {}) as Record<string, any>;
    const partySnap    = (contract.party_snapshot || {}) as Record<string, any>;

    // ── Append pagina firma ──
    const signedAtUtc = new Date().toISOString();
    const signedBytes = await appendSignaturePage(unsignedBytes, {
      contractNumber:   contract.contract_number,
      signerName:       partySnap.full_name || `${partySnap.first_name || ''} ${partySnap.last_name || ''}`.trim(),
      signerFiscalCode: partySnap.fiscal_code || 'n/d',
      signerBirthDate:  partySnap.birth_date  || 'n/d',
      signerBirthPlace: partySnap.birth_place || 'n/d',
      phoneLast4:       otp.phone_e164.slice(-4),
      signedAtUtc:      signedAtUtc,
      ip:               ip || 'n/d',
      userAgent:        ua || 'n/d',
      unsignedSha256:   unsignedSha,
      otpTransactionId: otp.sms_provider_message_id || '',
      otpId:            otp.id,
      channel:          otp.channel || 'sms',
      verifyUrl,
      companyName:      counterparty.company_legal_name || 'RareBlock',
    });

    const signedSha = await sha256OfBytes(signedBytes);

    // ── Upload bucket contracts-signed ──
    const signedPath = `${user.id}/${contract.contract_number}.pdf`;
    const { error: upErr } = await sb.storage
      .from('contracts-signed')
      .upload(signedPath, signedBytes, { contentType: 'application/pdf', upsert: true });
    if (upErr) return json({ error: 'signed_upload_failed', detail: upErr.message }, 500);

    // ── Audit pdf_signed ──
    const signatureAudit = {
      otp_id:                   otp.id,
      sms_provider_message_id:  otp.sms_provider_message_id,
      channel:                  otp.channel,
      phone_last4:              otp.phone_e164.slice(-4),
      verified_at:              consumedAt,
      signed_at:                signedAtUtc,
      ip,
      user_agent:               ua,
      pdf_unsigned_sha256:      unsignedSha,
      pdf_signed_sha256:        signedSha,
      consents:                 body.consents,
      verify_url:               verifyUrl,
      legal_basis:              'art. 26 Reg. UE 910/2014 (eIDAS) + art. 20 D.Lgs. 82/2005',
    };

    await sb.from('contract_signature_audit').insert({
      contract_id: contract.id,
      event_type:  'pdf_signed',
      event_data:  { signed_sha256: signedSha, page_appended: true },
      actor_user_id: user.id,
      ip, user_agent: ua,
    });

    // ── Update contracts (fully signed) ──
    await sb.from('contracts').update({
      status:              'signed',
      signed_at:           signedAtUtc,
      signature_method:    'sms_otp_fea',
      signature_audit:     signatureAudit,
      pdf_signed_path:     signedPath,
      pdf_signed_sha256:   signedSha,
    }).eq('id', contract.id);

    // ── Notarizzazione on-chain (best-effort, no-block) ──
    let notarizationResult: any = null;
    try {
      const notarRes = await fetch(`${SUPABASE_URL}/functions/v1/contract-notarize`, {
        method:  'POST',
        headers: {
          'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          contract_id:     contract.id,
          contract_serial: contract.contract_number,
          pdf_sha256:      signedSha,
          user_id:         user.id,
        }),
      });
      const notarText = await notarRes.text();
      try {
        notarizationResult = JSON.parse(notarText);
      } catch {
        notarizationResult = { error: 'notarize_unparseable_response', detail: notarText.slice(0, 200), http_status: notarRes.status };
      }
      // Aggiungi status HTTP per debug
      if (!notarizationResult.http_status) notarizationResult.http_status = notarRes.status;

      if (notarizationResult?.ok && notarizationResult.notarization_id) {
        // Aggiorna contracts con notarization_id
        await sb.from('contracts').update({
          notarization_id: notarizationResult.notarization_id,
        }).eq('id', contract.id);

        await sb.from('contract_signature_audit').insert({
          contract_id: contract.id,
          event_type:  'notarized',
          event_data:  {
            notarization_id: notarizationResult.notarization_id,
            tx_hash:         notarizationResult.tx_hash,
            block_number:    notarizationResult.block_number,
            chain_id:        notarizationResult.chain_id,
            status:          notarizationResult.status,
          },
          actor_user_id: user.id,
          ip, user_agent: ua,
        });
      }
    } catch (e) {
      // Non blocchiamo la firma se la notarizzazione fallisce: il PDF è
      // comunque firmato e valido (FEA), la notarizzazione si può rifare.
      notarizationResult = { error: 'notarize_call_failed', detail: String(e) };
    }

    // ── Signed URL per download (1h) ──
    const { data: signedUrl } = await sb.storage
      .from('contracts-signed')
      .createSignedUrl(signedPath, 3600);

    return json({
      ok:                  true,
      contract_id:         contract.id,
      contract_number:     contract.contract_number,
      signed_at:           signedAtUtc,
      pdf_signed_url:      signedUrl?.signedUrl || null,
      pdf_signed_sha256:   signedSha,
      verify_url:          verifyUrl,
      notarization: notarizationResult?.ok
        ? {
            ok:           true,
            tx_hash:      notarizationResult.tx_hash,
            block_number: notarizationResult.block_number,
            basescan_url: notarizationResult.basescan_url,
            status:       notarizationResult.status,
          }
        : {
            ok:          false,
            error:       notarizationResult?.error || 'unknown',
            detail:      notarizationResult?.detail || '',
            http_status: notarizationResult?.http_status,
            // Messaggio user-friendly localizzato
            user_message: (notarizationResult?.error === 'operator_not_configured')
              ? 'Notarizzazione on-chain non eseguita: il wallet operator non è ancora configurato sul backend. Il contratto è comunque firmato e legalmente valido (FEA eIDAS art. 26 + CAD art. 20).'
              : 'Notarizzazione on-chain non riuscita. Il contratto è comunque firmato e legalmente valido (FEA). Sarà possibile rifare la notarizzazione manualmente dal pannello admin.',
          },
    });

  } catch (e: any) {
    return json({ error: 'unexpected', detail: e?.message ?? String(e) }, 500);
  }
});
