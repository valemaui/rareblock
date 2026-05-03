// chain/test/pdf-certificate.test.js
//
// Test suite per il generatore PDF certificato. Genera PDF reali in memoria
// (non scrive su disco) e verifica struttura, hash self-referential, determinismo.
//
// Run: node --test test/pdf-certificate.test.js

"use strict";

const test           = require("node:test");
const assert         = require("node:assert/strict");
const { createHash } = require("crypto");

const {
  buildCertificatePDF,
  verifyCertificatePDF,
  sha256Hex,
  PDFCertError,
} = require("../lib/pdf-certificate");

const throwsCode  = (fn, code) =>
  assert.throws (fn, (err) => err instanceof PDFCertError && err.code === code);
const rejectsCode = (p, code) =>
  assert.rejects(p,  (err) => err instanceof PDFCertError && err.code === code);

// Fixture canonica
const baseInput = () => ({
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
});

// ─── Smoke ────────────────────────────────────────────────────────────
test("buildCertificatePDF: produce un PDF non vuoto", async () => {
  const r = await buildCertificatePDF(baseInput());
  assert.ok(Buffer.isBuffer(r.buffer));
  assert.ok(r.sizeBytes > 5000, `PDF deve essere > 5KB, è ${r.sizeBytes}`);
  // Magic bytes PDF "%PDF-"
  assert.equal(r.buffer.slice(0, 5).toString("ascii"), "%PDF-");
});

test("buildCertificatePDF: SHA-256 nel result è una hex string lowercase 64-char", async () => {
  const r = await buildCertificatePDF(baseInput());
  assert.match(r.sha256, /^[a-f0-9]{64}$/);
});

test("buildCertificatePDF: hashOffsetHex valido e dentro il buffer", async () => {
  const r = await buildCertificatePDF(baseInput());
  assert.ok(typeof r.hashOffsetHex === "number" && r.hashOffsetHex > 0);
  assert.ok(r.hashOffsetHex + 128 <= r.buffer.length);
});

// ─── Self-referential hash ────────────────────────────────────────────
test("verifyCertificatePDF: hash stampato === hash ricalcolato (canonical)", async () => {
  const r = await buildCertificatePDF(baseInput());
  const v = verifyCertificatePDF(r.buffer, r.hashOffsetHex);
  assert.equal(v.valid, true);
  assert.equal(v.printed, v.computed);
  assert.equal(v.printed, r.sha256);
});

test("verifyCertificatePDF: tampering rilevato", async () => {
  const r = await buildCertificatePDF(baseInput());
  // Manomissione: cambio un byte FUORI dalla hash region
  const tampered = Buffer.from(r.buffer);
  // Cambia un byte vicino all'inizio del file (ma dopo header)
  tampered[200] = (tampered[200] + 1) & 0xff;
  const v = verifyCertificatePDF(tampered, r.hashOffsetHex);
  assert.equal(v.valid, false, "il tampering deve invalidare il PDF");
  assert.notEqual(v.printed, v.computed);
});

test("verifyCertificatePDF: senza offset → throw OFFSET_REQUIRED", async () => {
  const r = await buildCertificatePDF(baseInput());
  throwsCode(() => verifyCertificatePDF(r.buffer), "OFFSET_REQUIRED");
  throwsCode(() => verifyCertificatePDF(r.buffer, -1), "OFFSET_REQUIRED");
  throwsCode(() => verifyCertificatePDF(r.buffer, "abc"), "OFFSET_REQUIRED");
});

// ─── Determinismo ──────────────────────────────────────────────────────
test("buildCertificatePDF: due chiamate con lo stesso input → buffer identici", async () => {
  const r1 = await buildCertificatePDF(baseInput());
  const r2 = await buildCertificatePDF(baseInput());
  assert.equal(r1.sha256,    r2.sha256);
  assert.equal(r1.sizeBytes, r2.sizeBytes);
  assert.ok(r1.buffer.equals(r2.buffer),
    "i buffer devono essere byte-identici (deterministico)");
});

test("buildCertificatePDF: input diversi → buffer diversi", async () => {
  const a = await buildCertificatePDF({ ...baseInput(), certificate_serial: "RB-2026-000043" });
  const b = await buildCertificatePDF(baseInput());
  assert.notEqual(a.sha256, b.sha256);
});

// ─── Validazioni input ────────────────────────────────────────────────
test("buildCertificatePDF: campi mancanti → MISSING_FIELD", async () => {
  const incomplete = baseInput();
  delete incomplete.owner_display_name;
  await rejectsCode(buildCertificatePDF(incomplete), "MISSING_FIELD");
});

test("buildCertificatePDF: serial malformato → BAD_SERIAL", async () => {
  await rejectsCode(
    buildCertificatePDF({ ...baseInput(), certificate_serial: "XX-2026-1" }),
    "BAD_SERIAL"
  );
});

test("buildCertificatePDF: verify_url non http(s) → BAD_URL", async () => {
  await rejectsCode(
    buildCertificatePDF({ ...baseInput(), verify_url: "javascript:alert(1)" }),
    "BAD_URL"
  );
});

test("buildCertificatePDF: type sconosciuto → BAD_TYPE", async () => {
  await rejectsCode(
    buildCertificatePDF({ ...baseInput(), type: "weird_type" }),
    "BAD_TYPE"
  );
});

// ─── Type-specific output ─────────────────────────────────────────────
test("buildCertificatePDF: full_ownership produce PDF distinto", async () => {
  const fr = await buildCertificatePDF(baseInput());
  const fu = await buildCertificatePDF({ ...baseInput(), type: "full_ownership" });
  assert.notEqual(fr.sha256, fu.sha256);
});

// ─── sha256Hex ────────────────────────────────────────────────────────
test("sha256Hex: helper produce hash atteso", () => {
  assert.equal(
    sha256Hex(Buffer.from("hello")),
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
  );
});

// ─── Self-referential verifica + tampering della hash region ─────────
test("verifyCertificatePDF: tampering DENTRO la hash region viene rilevato", async () => {
  const r = await buildCertificatePDF(baseInput());
  const tampered = Buffer.from(r.buffer);
  // Cambia il primo char hex della regione hash (es. da "6" a "7" → 0x36→0x37)
  tampered[r.hashOffsetHex] = tampered[r.hashOffsetHex] === 0x36 ? 0x37 : 0x36;
  // Il tampering è rilevato se: (a) il verify ritorna valid=false, oppure
  // (b) il verify lancia INVALID_PRINTED_HASH perché la regione non è più hex
  // pulito (cambiando 1 byte di un char hex potremmo finire fuori dal set hex
  // del Tj operator). Entrambi gli outcome confermano la rilevazione.
  let detected = false;
  try {
    const v = verifyCertificatePDF(tampered, r.hashOffsetHex);
    detected = (v.valid === false);
  } catch (err) {
    detected = err instanceof PDFCertError && err.code === "INVALID_PRINTED_HASH";
  }
  assert.equal(detected, true, "il tampering nella hash region deve essere rilevato");
});

// ─── Edge case: il buffer prodotto può sopravvivere al round-trip Buffer ↔ Uint8Array ─
test("buildCertificatePDF: result.buffer è verificabile dopo conversione Uint8Array", async () => {
  const r = await buildCertificatePDF(baseInput());
  const u8 = new Uint8Array(r.buffer);
  const reconstructed = Buffer.from(u8);
  const v = verifyCertificatePDF(reconstructed, r.hashOffsetHex);
  assert.equal(v.valid, true);
});
