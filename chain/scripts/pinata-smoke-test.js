#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
//  chain/scripts/pinata-smoke-test.js
//
//  Smoke test live: carica davvero il JSON Charizard d'esempio su Pinata
//  e stampa il CID + il link al gateway pubblico così l'utente può aprirlo
//  nel browser e VEDERE che funziona.
//
//  Uso:
//    PINATA_JWT="eyJ..." node scripts/pinata-smoke-test.js
//
//  Step eseguiti:
//    1. testAuthentication()  — verifica JWT
//    2. pinJSON(metadata)     — uploada il Charizard d'esempio
//    3. fetch(gateway URL)    — verifica che il JSON sia raggiungibile
//    4. integrità: il JSON ricaricato è IDENTICO a quello pinnato (deep eq)
//
//  Mai stampa il JWT. Mai lo committa. Lo legge solo da env.
// ═══════════════════════════════════════════════════════════════════════
"use strict";

const { PinataClient }          = require("../lib/pinata");
const { buildExampleCharizard,
        validateMetadata }      = require("../lib/metadata");

// ─── Output helpers ───────────────────────────────────────────────────
const out = (...a) => process.stdout.write(a.join(" ") + "\n");
const err = (...a) => process.stderr.write(a.join(" ") + "\n");
const hr  = ()     => out("─".repeat(72));

async function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

(async () => {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) {
    err("✗ PINATA_JWT env var is empty.");
    err("");
    err("  Run with:");
    err("    PINATA_JWT='eyJ...' node scripts/pinata-smoke-test.js");
    err("");
    err("  Or persist it (current shell session only):");
    err("    export PINATA_JWT='eyJ...'");
    err("    node scripts/pinata-smoke-test.js");
    process.exit(1);
  }

  hr();
  out("  RareBlock — Pinata smoke test");
  hr();
  out("");

  const c = new PinataClient({ jwt });

  // ─── 1) Auth ────────────────────────────────────────────────────────
  out("[1/4] Verifica JWT…");
  try {
    await c.testAuthentication();
    out("       ✔ JWT valido, autenticazione riuscita");
  } catch (e) {
    err("       ✗ FALLIMENTO autenticazione:", e.message);
    if (e.statusCode) err("         HTTP", e.statusCode, "—", JSON.stringify(e.responseBody));
    process.exit(2);
  }

  // ─── 2) Build metadata ──────────────────────────────────────────────
  out("");
  out("[2/4] Costruzione metadata Charizard di esempio…");
  const meta = buildExampleCharizard();
  const v    = validateMetadata(meta);
  if (!v.valid) {
    err("       ✗ metadata locale INVALIDO (bug nel builder):");
    for (const e of v.errors) err("         ", e.path, "→", e.msg);
    process.exit(3);
  }
  const metaSize = JSON.stringify(meta).length;
  out("       ✔ metadata generato, size:", metaSize, "bytes, validation: OK");

  // ─── 3) pinJSON ─────────────────────────────────────────────────────
  out("");
  out("[3/4] Upload su IPFS via Pinata…");
  let pinResult;
  try {
    pinResult = await c.pinJSON(meta, {
      name:      `smoke-test-${Date.now()}.json`,
      keyvalues: {
        env:    "smoke-test",
        serial: meta.rareblock.certificate.serial,
        purpose: "rareblock-step-2.3-validation",
      },
    });
  } catch (e) {
    err("       ✗ FALLIMENTO pinJSON:", e.message);
    if (e.statusCode) err("         HTTP", e.statusCode, "—", JSON.stringify(e.responseBody));
    process.exit(4);
  }
  out("       ✔ pinned!");
  out("         CID       :", pinResult.IpfsHash);
  out("         PinSize   :", pinResult.PinSize, "bytes");
  out("         Timestamp :", pinResult.Timestamp);

  // ─── 4) Round-trip via gateway ──────────────────────────────────────
  out("");
  out("[4/4] Verifica round-trip via Pinata gateway…");
  const gatewayUrl = PinataClient.gatewayUrl(pinResult.IpfsHash);
  let downloaded;
  // Pinata propaga il pin in pochi secondi: un piccolo retry evita falsi negativi
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(gatewayUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      downloaded = await res.json();
      break;
    } catch (e) {
      if (attempt === 4) {
        err("       ⚠ gateway non risponde dopo 5 tentativi:", e.message);
        err("         (il pin è stato registrato, propagazione gateway lenta)");
        downloaded = null;
        break;
      }
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }

  if (downloaded) {
    const same = await deepEqual(downloaded, meta);
    if (same) {
      out("       ✔ JSON scaricato dal gateway è IDENTICO a quello pinnato (deep eq)");
    } else {
      err("       ✗ MISMATCH tra JSON pinnato e JSON ricevuto dal gateway");
      err("         (questo non dovrebbe MAI succedere — bug Pinata o nel client)");
      process.exit(5);
    }
  }

  // ─── Riepilogo finale ──────────────────────────────────────────────
  out("");
  hr();
  out("  ✅ SMOKE TEST PASSATO");
  hr();
  out("");
  out("  CID            :", pinResult.IpfsHash);
  out("  IPFS URI       :", PinataClient.ipfsUri(pinResult.IpfsHash));
  out("  Gateway link   :", gatewayUrl);
  out("");
  out("  Apri il gateway link nel browser per vedere il JSON Charizard live.");
  out("  È un upload PERMANENTE — Pinata lo terrà replicato (FRA1 + NYC1) finché");
  out("  l'account è attivo.");
  out("");
  hr();
})();
