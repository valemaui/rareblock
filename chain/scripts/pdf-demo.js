#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
//  chain/scripts/pdf-demo.js
//
//  Genera un PDF Charizard demo per visualizzare il template del certificato
//  RareBlock. Salva in chain/examples/charizard-demo.pdf e stampa info utili.
//
//  Uso:
//    node scripts/pdf-demo.js
// ═══════════════════════════════════════════════════════════════════════
"use strict";

const fs   = require("fs");
const path = require("path");
const { buildCertificatePDF, verifyCertificatePDF, sha256Hex } =
  require("../lib/pdf-certificate");

const OUT_DIR  = path.join(__dirname, "..", "examples");
const OUT_FILE = path.join(OUT_DIR, "charizard-demo.pdf");

const out = (...a) => process.stdout.write(a.join(" ") + "\n");
const hr  = ()     => out("─".repeat(72));

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  hr();
  out("  RareBlock — PDF demo: Charizard Holo Base Set 1999, frazione 5/100");
  hr();

  const input = {
    certificate_serial:    "RB-2026-000042",
    issued_at:             "2026-05-03T14:23:01Z",
    type:                  "fractional_ownership",
    owner_display_name:    "Valentino Castiglione",
    asset_title:           "Charizard Holo",
    asset_set:             "Base Set",
    asset_year:            1999,
    asset_edition:         "1st Edition",
    asset_grading:         "PSA 9 — Mint",
    shares_in_certificate: 5,
    shares_total:          100,
    verify_url:            "https://www.rareblock.eu/chain/verify?serial=RB-2026-000042",
    contract_address:      "0xCafEbAbE0123456789aBcDeF0123456789AbCDEF",
    token_id:              "70922435100124324324324324324324324324324324324",
    custodian:             "RareBlock S.r.l.",
    jurisdiction:          "Italy",
  };

  out("");
  out("[1/3] Costruzione PDF…");
  const t0 = Date.now();
  const r  = await buildCertificatePDF(input);
  const dt = Date.now() - t0;
  out(`      ✔ generato in ${dt}ms — ${r.sizeBytes} bytes`);

  out("");
  out("[2/3] Verifica self-referential hash…");
  const v = verifyCertificatePDF(r.buffer, r.hashOffsetHex);
  if (!v.valid) {
    out("      ✗ FAIL — hash mismatch");
    process.exit(1);
  }
  out(`      ✔ printed === computed === ${v.printed.slice(0, 16)}…`);

  out("");
  out("[3/3] Salvataggio file…");
  fs.writeFileSync(OUT_FILE, r.buffer);
  out("      ✔ scritto in:", path.relative(process.cwd(), OUT_FILE));

  out("");
  hr();
  out("  ✅ DEMO PDF PRONTO");
  hr();
  out("");
  out("  Path        :", OUT_FILE);
  out("  Size        :", r.sizeBytes, "bytes");
  out("  SHA-256     :", r.sha256);
  out("  Hash offset :", r.hashOffsetHex, "(byte position of the 128-hex region)");
  out("");
  out("  Apri il PDF nel browser o con un viewer per vedere il design.");
  out("  Il SHA-256 stampato dentro il PDF è VERIFICABILE da chiunque:");
  out("  basta scaricare il PDF, sostituire i 64 char hex stampati a piè di");
  out("  pagina con 64 zeri, calcolare lo SHA-256 del file, e confrontare");
  out("  con i 64 char letti.");
  out("");
  hr();
})().catch((e) => { console.error(e); process.exit(1); });
