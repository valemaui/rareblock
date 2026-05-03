// ═══════════════════════════════════════════════════════════════════════
//  chain/lib/pdf-certificate.js
//
//  Generatore del PDF "Certificate of Co-Ownership" per RareBlock.
//
//  Design system:
//   - Page size      : A4 portrait (595×842 pt)
//   - Background     : #0D1117 (RB dark)
//   - Primary text   : #E6EDF3 (off-white)
//   - Secondary text : #8B949E (muted grey)
//   - Accent gold    : #C9A961 (RB gold) — frame, dividers, serial badge
//   - Watermark      : "RARE BLOCK" in diagonal, gold @ 6% opacity
//   - Frame          : hairline gold rule, 18pt margin from edges
//   - QR code        : 110×110 pt bottom-right, encodes verify URL
//
//  Output:
//   - buildCertificatePDF(input) → { buffer, sha256, sizeBytes }
//   - Buffer è il PDF binario; sha256 è hex 64-char (l'hash on-chain)
//
//  Fonts:
//   - Default: PDFKit built-in (Helvetica / Helvetica-Bold / Times-Italic)
//   - Custom (Fraunces/Figtree): popolare opts.fonts con i percorsi ai .ttf
//     in chain/assets/fonts/. Il layout è invariato.
// ═══════════════════════════════════════════════════════════════════════
"use strict";

const PDFDocument = require("pdfkit");
const QRCode      = require("qrcode");
const { createHash } = require("crypto");
const fs            = require("fs");

// ──────────────────────────────────────────────────────────────────────
//  Design tokens
// ──────────────────────────────────────────────────────────────────────
const PAGE_W = 595.28;            // A4 width  in PDF points
const PAGE_H = 841.89;            // A4 height
const FRAME_MARGIN     = 18;
const CONTENT_PADDING  = 36;

const COLORS = Object.freeze({
  bg:           "#0D1117",
  text:         "#E6EDF3",
  textMuted:    "#8B949E",
  textDim:      "#6E7681",
  gold:         "#C9A961",
  goldDeep:     "#A8893F",
  divider:      "#21262D",
});

// Fallback font names (PDFKit built-in PostScript Type 1)
const DEFAULT_FONTS = Object.freeze({
  serif:           "Times-Roman",
  serifItalic:     "Times-Italic",
  serifBold:       "Times-Bold",
  sans:            "Helvetica",
  sansBold:        "Helvetica-Bold",
  sansLight:       "Helvetica",          // PDFKit non ha Helvetica-Light built-in
  mono:            "Courier",
});

// ──────────────────────────────────────────────────────────────────────
//  Errori custom
// ──────────────────────────────────────────────────────────────────────
class PDFCertError extends Error {
  constructor(code, message) { super(message); this.code = code; this.name = "PDFCertError"; }
}

// ──────────────────────────────────────────────────────────────────────
//  Validazione dell'input
// ──────────────────────────────────────────────────────────────────────
function validateInput(input) {
  const required = [
    "certificate_serial", "issued_at", "type",
    "owner_display_name",
    "asset_title", "asset_set", "asset_year", "asset_grading",
    "shares_in_certificate", "shares_total",
    "verify_url",
    "contract_address", "token_id",
  ];
  for (const k of required) {
    if (input[k] === undefined || input[k] === null || input[k] === "") {
      throw new PDFCertError("MISSING_FIELD", `pdf-cert: missing required field "${k}"`);
    }
  }
  if (!/^RB-\d{4}-\d{6}$/.test(input.certificate_serial)) {
    throw new PDFCertError("BAD_SERIAL", `Invalid serial: ${input.certificate_serial}`);
  }
  if (!/^https?:\/\//.test(input.verify_url)) {
    throw new PDFCertError("BAD_URL", `verify_url must be http(s)`);
  }
  if (input.type !== "fractional_ownership" && input.type !== "full_ownership") {
    throw new PDFCertError("BAD_TYPE", `type must be fractional_ownership|full_ownership`);
  }
}

// ──────────────────────────────────────────────────────────────────────
//  Drawing primitives
// ──────────────────────────────────────────────────────────────────────

/** Riempie l'intera pagina con il colore bg */
function paintBackground(doc) {
  doc.save()
     .rect(0, 0, PAGE_W, PAGE_H)
     .fill(COLORS.bg)
     .restore();
}

/** Hairline gold frame */
function drawFrame(doc) {
  doc.save()
     .lineWidth(0.5)
     .strokeColor(COLORS.gold)
     .rect(FRAME_MARGIN, FRAME_MARGIN,
           PAGE_W - 2 * FRAME_MARGIN,
           PAGE_H - 2 * FRAME_MARGIN)
     .stroke()
     .restore();
}

/** Watermark "RARE BLOCK" in diagonale */
function drawWatermark(doc, fonts) {
  doc.save();
  doc.fillColor(COLORS.gold).fillOpacity(0.06);
  doc.font(fonts.serifBold).fontSize(72);
  // Centro pagina, ruotato -30°
  const cx = PAGE_W / 2;
  const cy = PAGE_H / 2;
  doc.rotate(-30, { origin: [cx, cy] });
  // Tre righe staccate per riempire l'area in diagonale
  for (let row = -2; row <= 2; row++) {
    const y = cy + row * 100 - 36;
    doc.text("RARE  BLOCK", 0, y, { width: PAGE_W, align: "center" });
  }
  doc.restore();
  doc.fillOpacity(1);
}

/** Linea sottile orizzontale */
function hLine(doc, x, y, w, color = COLORS.divider, weight = 0.5) {
  doc.save()
     .lineWidth(weight)
     .strokeColor(color)
     .moveTo(x, y).lineTo(x + w, y).stroke()
     .restore();
}

/** Decorazione gold ornament centrale (3 lozenge) */
function drawOrnament(doc, x, y, w) {
  const cx = x + w / 2;
  doc.save();
  doc.strokeColor(COLORS.gold).lineWidth(0.6);
  // linea sinistra
  doc.moveTo(x, y).lineTo(cx - 20, y).stroke();
  // 3 diamanti
  for (let i = -1; i <= 1; i++) {
    const dx = cx + i * 12;
    doc.moveTo(dx, y - 3).lineTo(dx + 3, y).lineTo(dx, y + 3).lineTo(dx - 3, y).closePath();
    if (i === 0) doc.fill(COLORS.gold);
    else         doc.stroke();
  }
  // linea destra
  doc.moveTo(cx + 20, y).lineTo(x + w, y).stroke();
  doc.restore();
}

// ──────────────────────────────────────────────────────────────────────
//  Sezioni del certificato
// ──────────────────────────────────────────────────────────────────────

function drawHeader(doc, fonts, opts) {
  const y = FRAME_MARGIN + 24;
  // Marca a sinistra
  doc.font(fonts.sansBold).fontSize(11).fillColor(COLORS.text)
     .text("RARE BLOCK", CONTENT_PADDING, y, { characterSpacing: 4 });
  // Sottolinea brand
  doc.font(fonts.sans).fontSize(7).fillColor(COLORS.textMuted)
     .text("BLOCKCHAIN-ANCHORED CERTIFICATE", CONTENT_PADDING, y + 14, { characterSpacing: 1.5 });
  // Serial badge a destra
  const serialText = opts.certificate_serial;
  const sw = doc.widthOfString(serialText);
  doc.font(fonts.mono).fontSize(9).fillColor(COLORS.gold)
     .text(serialText, PAGE_W - CONTENT_PADDING - sw, y + 1);
  // sub-serial label
  const labelText = "CERTIFICATE №";
  const lw = doc.font(fonts.sans).fontSize(7).widthOfString(labelText);
  doc.fillColor(COLORS.textMuted)
     .text(labelText, PAGE_W - CONTENT_PADDING - lw, y + 14, { characterSpacing: 1.5 });
}

function drawTitleBlock(doc, fonts, opts) {
  const startY = 130;
  const isFractional = opts.type === "fractional_ownership";

  // Eyebrow piccolo
  doc.font(fonts.sans).fontSize(8).fillColor(COLORS.gold)
     .text("CERTIFICATE OF",
           CONTENT_PADDING, startY, {
             width: PAGE_W - 2 * CONTENT_PADDING,
             align: "center",
             characterSpacing: 6,
           });

  // Titolone serif
  doc.font(fonts.serifItalic).fontSize(34).fillColor(COLORS.text)
     .text(isFractional ? "Fractional Co-Ownership" : "Sole Ownership",
           CONTENT_PADDING, startY + 16, {
             width: PAGE_W - 2 * CONTENT_PADDING,
             align: "center",
           });

  // Ornament
  drawOrnament(doc, CONTENT_PADDING, startY + 70, PAGE_W - 2 * CONTENT_PADDING);

  // Sub-titolo
  doc.font(fonts.sans).fontSize(9).fillColor(COLORS.textMuted)
     .text(
       isFractional
         ? "This certificate represents fractional co-ownership of a physical collectible held in custody by RareBlock."
         : "This certificate represents sole ownership of a physical collectible held in custody by RareBlock.",
       CONTENT_PADDING + 60, startY + 84,
       { width: PAGE_W - 2 * CONTENT_PADDING - 120, align: "center" }
     );
}

function drawAssetBlock(doc, fonts, opts) {
  const blockY = 270;
  const blockH = 220;
  const cardW  = 160;
  const cardX  = CONTENT_PADDING + 20;
  const detailX = cardX + cardW + 28;
  const detailW = PAGE_W - detailX - CONTENT_PADDING - 20;

  // Box carta (placeholder con bordo gold se non c'è immagine)
  doc.save();
  doc.lineWidth(0.5).strokeColor(COLORS.gold);
  doc.rect(cardX, blockY, cardW, blockH).stroke();
  // Etichetta interna placeholder
  if (!opts.card_image_buffer) {
    doc.font(fonts.serifItalic).fontSize(11).fillColor(COLORS.textDim)
       .text("Card Image", cardX, blockY + blockH / 2 - 8,
             { width: cardW, align: "center" });
  }
  doc.restore();

  // Se passata un'immagine reale, la mettiamo dentro
  if (opts.card_image_buffer) {
    try {
      doc.image(opts.card_image_buffer, cardX + 4, blockY + 4, {
        fit:   [cardW - 8, blockH - 8],
        align: "center",
        valign: "center",
      });
    } catch (_) { /* skip if not a renderable image */ }
  }

  // Dettagli a destra — formato "label / value" con divider sottile
  let dy = blockY + 4;
  const writeRow = (label, value) => {
    doc.font(fonts.sans).fontSize(7).fillColor(COLORS.textMuted)
       .text(label, detailX, dy, { characterSpacing: 1.5 });
    doc.font(fonts.serifItalic).fontSize(15).fillColor(COLORS.text)
       .text(String(value), detailX, dy + 12, { width: detailW });
    dy += 38;
    hLine(doc, detailX, dy - 8, detailW);
  };

  writeRow("ASSET", opts.asset_title);
  writeRow("SET / YEAR", `${opts.asset_set} · ${opts.asset_year}`);
  if (opts.asset_edition) writeRow("EDITION", opts.asset_edition);
  writeRow("GRADING",   opts.asset_grading);
}

function drawOwnershipBlock(doc, fonts, opts) {
  const y = 510;
  const isFractional = opts.type === "fractional_ownership";

  // Eyebrow
  doc.font(fonts.sans).fontSize(7).fillColor(COLORS.gold)
     .text("REGISTERED OWNER", CONTENT_PADDING, y,
           { width: PAGE_W - 2 * CONTENT_PADDING, align: "center", characterSpacing: 3 });

  // Owner name
  doc.font(fonts.serifItalic).fontSize(22).fillColor(COLORS.text)
     .text(opts.owner_display_name, CONTENT_PADDING, y + 14,
           { width: PAGE_W - 2 * CONTENT_PADDING, align: "center" });

  // Badge fraction
  if (isFractional) {
    const fracText = `${opts.shares_in_certificate} of ${opts.shares_total} shares`;
    const pctText  = `(${((opts.shares_in_certificate / opts.shares_total) * 100).toFixed(2)}%)`;

    // measure
    doc.font(fonts.sansBold).fontSize(11);
    const fw = doc.widthOfString(fracText);
    doc.font(fonts.sans).fontSize(10);
    const pw = doc.widthOfString(" " + pctText);
    const totalW = fw + pw + 32; // padding interno
    const bx = (PAGE_W - totalW) / 2;
    const by = y + 56;

    // pill di sfondo
    doc.save();
    doc.lineWidth(0.6).strokeColor(COLORS.gold)
       .roundedRect(bx, by, totalW, 24, 12).stroke();
    doc.restore();

    doc.font(fonts.sansBold).fontSize(11).fillColor(COLORS.gold)
       .text(fracText, bx + 16, by + 7, { lineBreak: false });
    doc.font(fonts.sans).fontSize(10).fillColor(COLORS.textMuted)
       .text(" " + pctText, bx + 16 + fw, by + 7, { lineBreak: false });
  } else {
    doc.font(fonts.sansBold).fontSize(11).fillColor(COLORS.gold)
       .text("FULL OWNERSHIP", CONTENT_PADDING, y + 56,
             { width: PAGE_W - 2 * CONTENT_PADDING, align: "center", characterSpacing: 3 });
  }
}

function drawIssuanceBlock(doc, fonts, opts) {
  const y = 620;
  // 3 colonne: Issued, Custodian, Jurisdiction
  const colW = (PAGE_W - 2 * CONTENT_PADDING) / 3;
  const cols = [
    { label: "ISSUED ON",   value: formatDate(opts.issued_at) },
    { label: "CUSTODIAN",   value: opts.custodian || "RareBlock S.r.l." },
    { label: "JURISDICTION",value: opts.jurisdiction || "Italy" },
  ];
  cols.forEach((c, i) => {
    const x = CONTENT_PADDING + colW * i;
    doc.font(fonts.sans).fontSize(7).fillColor(COLORS.textMuted)
       .text(c.label, x, y, { width: colW, align: "center", characterSpacing: 2 });
    doc.font(fonts.serifItalic).fontSize(13).fillColor(COLORS.text)
       .text(c.value, x, y + 14, { width: colW, align: "center" });
  });
  // divider in basso
  hLine(doc, CONTENT_PADDING, y + 60, PAGE_W - 2 * CONTENT_PADDING, COLORS.divider);
}

async function drawFooter(doc, fonts, opts) {
  const y = 700;

  // QR code in basso a destra
  const qrSize = 110;
  const qrX = PAGE_W - CONTENT_PADDING - qrSize;
  const qrY = y - 4;

  // Generiamo il QR come PNG buffer (qrcode npm)
  const qrPng = await QRCode.toBuffer(opts.verify_url, {
    type:   "png",
    margin: 1,
    width:  qrSize * 4,           // 4x density per stampa nitida
    color:  { dark: "#0D1117", light: "#E6EDF3" },
  });
  // sfondo bianco-soft per il QR
  doc.save();
  doc.fillColor(COLORS.text);
  doc.roundedRect(qrX - 6, qrY - 6, qrSize + 12, qrSize + 12, 4).fill();
  doc.restore();
  doc.image(qrPng, qrX, qrY, { width: qrSize, height: qrSize });

  // Caption sotto il QR
  doc.font(fonts.sans).fontSize(6).fillColor(COLORS.textMuted)
     .text("SCAN TO VERIFY ON-CHAIN", qrX, qrY + qrSize + 6,
           { width: qrSize, align: "center", characterSpacing: 1 });

  // Block sinistro: blockchain proofs
  const leftX = CONTENT_PADDING;
  const leftW = qrX - 24 - leftX;
  let ly = y;

  doc.font(fonts.sans).fontSize(7).fillColor(COLORS.gold)
     .text("BLOCKCHAIN PROOF", leftX, ly, { characterSpacing: 2 });
  ly += 14;

  const writeProofRow = (label, value, isMono = true) => {
    doc.font(fonts.sans).fontSize(6).fillColor(COLORS.textMuted)
       .text(label, leftX, ly, { characterSpacing: 1 });
    doc.font(isMono ? fonts.mono : fonts.sans).fontSize(7).fillColor(COLORS.text)
       .text(value, leftX, ly + 8, { width: leftW, ellipsis: true, lineBreak: false });
    ly += 22;
  };

  writeProofRow("CONTRACT (Base)", opts.contract_address);
  writeProofRow("TOKEN ID",        String(opts.token_id));
  writeProofRow("PDF SHA-256",     opts._pdfHashPlaceholder);  // verrà ri-stampato
  writeProofRow("VERIFY URL",      opts.verify_url, false);
}

// ──────────────────────────────────────────────────────────────────────
//  formatDate: '2026-05-03T14:23:01Z' → '03 May 2026'
// ──────────────────────────────────────────────────────────────────────
function formatDate(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${String(d.getUTCDate()).padStart(2, "0")} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// ──────────────────────────────────────────────────────────────────────
//  Main API
// ──────────────────────────────────────────────────────────────────────

/**
 * Genera il PDF e ritorna { buffer, sha256, sizeBytes }.
 *
 * Strategia per l'hash self-referential (CRITICA):
 *  1) Genero il PDF con un placeholder marker univoco a 64 char (RB-PDF-HASH-...).
 *  2) Faccio ricerca BINARIA del marker nel buffer e lo sostituisco con un
 *     placeholder di tutti zeri (stessa lunghezza esatta → layout immutato).
 *  3) Calcolo SHA-256 del buffer con i 64 zeri.
 *  4) Sostituisco di nuovo (byte-replace) i 64 zeri con l'hash reale.
 *  5) Lo SHA-256 del PDF finale = quello stampato nel footer.
 *
 *  Verifica esterna: chiunque scarichi il PDF, ricalcola SHA-256 sul file
 *  intero, deve ottenere ESATTAMENTE la stringa stampata nel footer e
 *  registrata on-chain (pdfHashOf[tokenId] del contratto).
 *
 *  NB: serve che la CreationDate del PDF sia deterministica (settata via
 *  info.CreationDate), altrimenti tra render e mint l'hash drifterebbe.
 */
async function buildCertificatePDF(input, opts = {}) {
  validateInput(input);
  const fonts = { ...DEFAULT_FONTS, ...(opts.fonts || {}) };

  // Marker di 64 char facile da localizzare nel buffer e impossibile da
  // collidere con altro contenuto del PDF.
  // PDFKit con WinAnsiEncoding scrive il testo come hex literal nei content
  // streams (es. "RB" → "5242"), quindi cerchiamo il marker già encoded.
  const MARKER = "RB-PDF-HASH-PLACEHOLDER-DO-NOT-EDIT-XXXXXXXXXXXXXXXXXXXXXXXXXXXX";
  if (MARKER.length !== 64) throw new Error("internal: marker length must be 64");
  const MARKER_HEX = Buffer.from(MARKER, "ascii").toString("hex");  // lowercase, as PDFKit produces
  if (MARKER_HEX.length !== 128) throw new Error("internal: marker hex length must be 128");

  const buf1 = await renderPDF(input, fonts, MARKER, opts.deterministicDate);

  // Localizza la versione hex-encoded del marker dentro il content stream
  const idxHex = buf1.toString("latin1").indexOf(MARKER_HEX);
  if (idxHex === -1) {
    throw new PDFCertError("MARKER_NOT_FOUND",
      "Hash marker not found in PDF buffer (hex-encoded form)");
  }

  // Sostituisci con 64 zeri (che in hex sono 128 char "30")
  const ZEROS_HEX = "30".repeat(64);  // "0" → 0x30
  const buf2 = Buffer.from(buf1);
  buf2.write(ZEROS_HEX, idxHex, 128, "latin1");

  // Hash del PDF "neutralizzato"
  const sha256 = createHash("sha256").update(buf2).digest("hex");

  // Iniettiamo l'hash reale al posto degli zeri.
  // L'hash è 64 chars hex lowercase → encoded come 128 char hex (es. "a"→"61")
  const hashHexAscii = Buffer.from(sha256, "ascii").toString("hex");  // lowercase
  if (hashHexAscii.length !== 128) throw new Error("internal: hash hex-ascii length");
  const buf3 = Buffer.from(buf2);
  buf3.write(hashHexAscii, idxHex, 128, "latin1");

  // Verifica self-check immediata: lo SHA-256 di buf2 (con zeri) deve corrispondere
  // a `sha256`. Documenta nell'output che la verifica esterna lavora su buf2,
  // non su buf3 — chi verifica deve sostituire i 64 char hex letti con "0"*64.
  return {
    buffer:        buf3,
    sha256:        sha256,                 // hash canonico (PDF con zeri)
    sizeBytes:     buf3.length,
    hashOffsetHex: idxHex,                 // offset BYTE della hex-encoded region (128 char)
    verifyAlgo:    "sha256-zeroed-hash-region-hex",
  };
}

/**
 * Funzione di verifica complementare: ricalcola lo SHA-256 canonico di un
 * PDF prodotto da buildCertificatePDF.
 */
function verifyCertificatePDF(buffer, hashOffsetHex) {
  if (typeof hashOffsetHex !== "number" || hashOffsetHex < 0) {
    throw new PDFCertError("OFFSET_REQUIRED",
      "verifyCertificatePDF requires the hashOffsetHex returned by buildCertificatePDF " +
      "(also stored in chain_certificates.cert_pdf_hash_offset)");
  }
  // Estrai i 128 char hex-encoded dal buffer
  const region = buffer.slice(hashOffsetHex, hashOffsetHex + 128).toString("latin1");
  if (!/^[0-9a-fA-F]{128}$/.test(region)) {
    throw new PDFCertError("INVALID_PRINTED_HASH",
      "Hash region is not 128 hex chars");
  }
  // Decode i 128 char hex back to ascii (questo è lo SHA-256 stampato)
  const printedHash = Buffer.from(region, "hex").toString("ascii");
  if (!/^[a-f0-9]{64}$/.test(printedHash)) {
    throw new PDFCertError("INVALID_PRINTED_HASH",
      "Decoded printed hash is not 64 hex chars lowercase");
  }
  // Ricostruisci buffer "neutralizzato" con i 64 char come "0"*64
  const ZEROS_HEX = "30".repeat(64);
  const zeroed = Buffer.from(buffer);
  zeroed.write(ZEROS_HEX, hashOffsetHex, 128, "latin1");
  const computed = createHash("sha256").update(zeroed).digest("hex");
  return { printed: printedHash, computed, valid: printedHash === computed };
}

/**
 * Render single-pass del PDF in un Buffer.
 */
function renderPDF(input, fonts, pdfHashStr, deterministicDate) {
  return new Promise((resolve, reject) => {
    try {
      // CreationDate deterministica = derivata dall'issued_at o passata esplicita.
      // Senza, PDFKit usa new Date() e ogni run produce binari diversi → hash drift.
      const creationDate = deterministicDate
        || (input.issued_at ? new Date(input.issued_at) : new Date(0));

      const doc = new PDFDocument({
        size:    "A4",
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        compress: false,                        // CRITICAL: keep stream content searchable
                                                // for the hash placeholder marker substitution
        info: {
          Title:        `RareBlock Certificate ${input.certificate_serial}`,
          Author:       "RareBlock S.r.l.",
          Subject:      "Blockchain-anchored certificate of co-ownership",
          Keywords:     `RareBlock, NFT, ${input.certificate_serial}`,
          Creator:      "RareBlock — pdf-certificate.js",
          Producer:     "PDFKit + RareBlock",
          CreationDate: creationDate,
          ModDate:      creationDate,
        },
      });

      const chunks = [];
      doc.on("data",  (c) => chunks.push(c));
      doc.on("end",   ()  => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // Compose the page
      paintBackground(doc);
      drawWatermark(doc, fonts);
      drawFrame(doc);

      drawHeader(doc, fonts, input);
      drawTitleBlock(doc, fonts, input);
      drawAssetBlock(doc, fonts, input);
      drawOwnershipBlock(doc, fonts, input);
      drawIssuanceBlock(doc, fonts, input);

      // Footer (async per via del QR PNG)
      drawFooter(doc, fonts, { ...input, _pdfHashPlaceholder: pdfHashStr })
        .then(() => doc.end())
        .catch(reject);
    } catch (e) {
      reject(e);
    }
  });
}

// ──────────────────────────────────────────────────────────────────────
//  sha256 helper riutilizzabile (per altre parti della pipeline)
// ──────────────────────────────────────────────────────────────────────
function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

module.exports = {
  buildCertificatePDF,
  verifyCertificatePDF,
  sha256Hex,
  PDFCertError,
  COLORS,
  DEFAULT_FONTS,
};
