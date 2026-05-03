// chain/test/metadata.test.js
//
// Test suite per il builder + validator del JSON metadata.
// Eseguito con: node --test test/metadata.test.js

"use strict";

const test       = require("node:test");
const assert     = require("node:assert/strict");
const m          = require("../lib/metadata");

// ─── normalizeBigIntString ──────────────────────────────────────────
test("normalizeBigIntString: BigInt → decimal string", () => {
  assert.equal(m.normalizeBigIntString(123n), "123");
  assert.equal(m.normalizeBigIntString(0n),   "0");
  // un valore enorme ben oltre Number.MAX_SAFE_INTEGER
  assert.equal(
    m.normalizeBigIntString(70922435100124324324324324324324324324324324324n),
    "70922435100124324324324324324324324324324324324"
  );
});

test("normalizeBigIntString: number safe integer", () => {
  assert.equal(m.normalizeBigIntString(0),   "0");
  assert.equal(m.normalizeBigIntString(42),  "42");
  assert.equal(m.normalizeBigIntString(Number.MAX_SAFE_INTEGER),
    String(Number.MAX_SAFE_INTEGER));
});

test("normalizeBigIntString: number invalido → throw", () => {
  assert.throws(() => m.normalizeBigIntString(-1));
  assert.throws(() => m.normalizeBigIntString(1.5));
  assert.throws(() => m.normalizeBigIntString(NaN));
  assert.throws(() => m.normalizeBigIntString(Infinity));
  // troppo grande per safe integer ma è ancora un Number → deve forzare l'utente a passare BigInt
  assert.throws(() => m.normalizeBigIntString(2 ** 60));
});

test("normalizeBigIntString: string decimale o hex", () => {
  assert.equal(m.normalizeBigIntString("0"),     "0");
  assert.equal(m.normalizeBigIntString("12345"), "12345");
  assert.equal(m.normalizeBigIntString("0xff"),  "255");
  assert.equal(m.normalizeBigIntString("0xFFFF"), "65535");
  assert.throws(() => m.normalizeBigIntString("abc"));
  assert.throws(() => m.normalizeBigIntString(""));
});

// ─── buildExampleCharizard — happy path ─────────────────────────────
test("buildExampleCharizard: produce un JSON valido secondo lo schema", () => {
  const meta = m.buildExampleCharizard();
  const v    = m.validateMetadata(meta);
  if (!v.valid) {
    console.error("ERRORI VALIDAZIONE:");
    for (const e of v.errors) console.error("  ", e.path, "→", e.msg);
  }
  assert.equal(v.valid, true, "l'esempio canonico deve passare la validazione");
});

test("buildExampleCharizard: contenuti chiave verificati", () => {
  const meta = m.buildExampleCharizard();
  // Standard fields
  assert.match(meta.name, /Charizard Holo/);
  assert.match(meta.name, /Base Set/);
  assert.match(meta.name, /1999/);
  assert.match(meta.image, /^ipfs:\/\//);
  assert.equal(meta.background_color, "0D1117");
  // RareBlock namespace
  assert.equal(meta.rareblock.schema_version, "1.0.0");
  assert.equal(meta.rareblock.certificate.serial, "RB-2026-000042");
  assert.equal(meta.rareblock.certificate.type, "fractional_ownership");
  // Token id deve essere una STRING anche se input era BigInt
  assert.equal(typeof meta.rareblock.blockchain.token_id, "string");
  assert.match(meta.rareblock.blockchain.token_id, /^\d+$/);
  // Fractional details
  assert.equal(meta.rareblock.fractional.shares_total, 100);
  assert.equal(meta.rareblock.fractional.shares_in_certificate, 5);
  assert.equal(meta.rareblock.fractional.share_percentage, 5);
  // Compliance hard-guard
  assert.equal(meta.rareblock.compliance.is_security, false);
});

test("buildExampleCharizard: attributes contiene Set/Year/Rarity/Edition/Condition/Fraction", () => {
  const meta = m.buildExampleCharizard();
  const traits = meta.attributes.map(a => a.trait_type);
  for (const t of ["Set", "Year", "Rarity", "Edition", "Condition", "Fraction"]) {
    assert.ok(traits.includes(t), `attribute "${t}" must be present`);
  }
  const condition = meta.attributes.find(a => a.trait_type === "Condition");
  assert.equal(condition.value, "PSA 9");
  const fraction  = meta.attributes.find(a => a.trait_type === "Fraction");
  assert.equal(fraction.value, "5/100");
});

// ─── buildMetadata: input minimale full_ownership ───────────────────
test("buildMetadata: full_ownership produce JSON senza fractional", () => {
  const meta = m.buildMetadata({
    certificate_serial: "RB-2026-000099",
    issued_at:          "2026-05-03T10:00:00Z",
    type:               "full_ownership",
    language:           "en",

    asset_category:     "tcg_card",
    asset_subcategory:  "pokemon",
    asset_title:        "Pikachu Illustrator",

    primary_image_ipfs: "ipfs://QmPikachuFull/pic.jpg",

    chain_id:           8453,
    contract_address:   "0xCafEbAbE0123456789aBcDeF0123456789AbCDEF",
    token_id:           "1",
    tx_hash_mint:       "0x" + "cd".repeat(32),

    pdf_sha256:         "a".repeat(64),
    verify_url:         "https://www.rareblock.eu/chain/verify?serial=RB-2026-000099",
    external_url:       "https://www.rareblock.eu/chain/verify?serial=RB-2026-000099",
    terms_url:          "https://www.rareblock.eu/legal/terms",
  });
  const v = m.validateMetadata(meta);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.equal(meta.rareblock.fractional, undefined,
    "full_ownership non deve avere il blocco fractional");
});

// ─── buildMetadata: missing required field → throw ──────────────────
test("buildMetadata: campo required mancante → errore esplicito", () => {
  const minimal = {
    issued_at: "2026-05-03T10:00:00Z",
    type:      "full_ownership",
    language:  "en",
    asset_category: "tcg_card", asset_subcategory: "pokemon", asset_title: "X",
    primary_image_ipfs: "ipfs://x/y", chain_id: 8453,
    contract_address: "0xCafEbAbE0123456789aBcDeF0123456789AbCDEF",
    token_id: "1", tx_hash_mint: "0x" + "ab".repeat(32),
    pdf_sha256: "a".repeat(64),
    verify_url: "https://www.rareblock.eu/v",
    external_url: "https://www.rareblock.eu/v",
    terms_url: "https://www.rareblock.eu/t",
    // certificate_serial OMESSO di proposito
  };
  assert.throws(() => m.buildMetadata(minimal), /certificate_serial/);
});

// ─── validateMetadata: catch-all errors ─────────────────────────────
test("validateMetadata: rileva tutti gli errori in una passata", () => {
  const broken = m.buildExampleCharizard();
  // Sabotaggio multiplo intenzionale
  broken.image = "https://evil-cdn.example.com/img.jpg";    // deve essere ipfs://
  broken.rareblock.certificate.serial = "X-NOT-VALID";      // formato sbagliato
  broken.rareblock.blockchain.chain_id = 1;                  // Ethereum mainnet, non consentita
  broken.rareblock.verification.pdf_sha256 = "shorthash";   // troppo corto
  broken.rareblock.compliance.is_security = true;            // hard-guard

  const v = m.validateMetadata(broken);
  assert.equal(v.valid, false);
  const paths = v.errors.map(e => e.path);
  assert.ok(paths.includes("$.image"));
  assert.ok(paths.includes("$.rareblock.certificate.serial"));
  assert.ok(paths.includes("$.rareblock.blockchain.chain_id"));
  assert.ok(paths.includes("$.rareblock.verification.pdf_sha256"));
  assert.ok(paths.includes("$.rareblock.compliance.is_security"));
});

test("validateMetadata: shares_in_certificate > shares_total → invalid", () => {
  const meta = m.buildExampleCharizard({
    shares_in_certificate: 200,  // > shares_total: 100
  });
  const v = m.validateMetadata(meta);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some(e => e.path === "$.rareblock.fractional.shares_in_certificate"));
});

test("validateMetadata: image non-ipfs → invalid", () => {
  const meta = m.buildExampleCharizard();
  meta.image = "https://gateway.pinata.cloud/ipfs/Qmabc";   // gateway HTTP, non ipfs://
  const v = m.validateMetadata(meta);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some(e => e.path === "$.image"));
});

test("validateMetadata: contract_address non checksum-bypass — accetta sia tutto-lower sia EIP-55", () => {
  const meta = m.buildExampleCharizard();
  // tutto lowercase
  meta.rareblock.blockchain.contract_address = "0xcafebabe0123456789abcdef0123456789abcdef";
  let v = m.validateMetadata(meta);
  assert.equal(v.valid, true);
  // EIP-55 mixed
  meta.rareblock.blockchain.contract_address = "0xCafEbAbE0123456789aBcDeF0123456789AbCDEF";
  v = m.validateMetadata(meta);
  assert.equal(v.valid, true);
  // Lunghezza sbagliata → fail
  meta.rareblock.blockchain.contract_address = "0xCafEbAbE";
  v = m.validateMetadata(meta);
  assert.equal(v.valid, false);
});

test("validateMetadata: tx hash deve essere 0x + 64 hex", () => {
  const meta = m.buildExampleCharizard();
  meta.rareblock.blockchain.minted_at_tx = "0xshort";
  const v = m.validateMetadata(meta);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some(e => e.path === "$.rareblock.blockchain.minted_at_tx"));
});

test("validateMetadata: chain_id ammessi solo Base mainnet/Sepolia/Hardhat", () => {
  const meta = m.buildExampleCharizard();
  for (const ok of [8453, 84532, 31337]) {
    meta.rareblock.blockchain.chain_id   = ok;
    meta.rareblock.blockchain.chain_name = m.ALLOWED_CHAIN_IDS[ok];
    const v = m.validateMetadata(meta);
    assert.equal(v.valid, true, `chain ${ok} doveva essere accettata`);
  }
  for (const ko of [1, 137, 42161]) {       // Ethereum, Polygon, Arbitrum
    meta.rareblock.blockchain.chain_id = ko;
    const v = m.validateMetadata(meta);
    assert.equal(v.valid, false, `chain ${ko} doveva essere rifiutata`);
  }
});

test("validateMetadata: serial deve matchare RB-YYYY-NNNNNN", () => {
  for (const ok of ["RB-2026-000042", "RB-1999-999999", "RB-2030-000001"]) {
    const meta = m.buildExampleCharizard({ certificate_serial: ok });
    const v = m.validateMetadata(meta);
    assert.equal(v.valid, true, `serial ${ok} doveva passare`);
  }
  for (const ko of ["RB-26-000042", "rb-2026-000042", "RB-2026-42", "FOO", ""]) {
    // Per i serial brutti dobbiamo bypassare il builder che fail-fast in modo
    // più aggressivo, e validare direttamente un meta manualmente sabotato.
    const meta = m.buildExampleCharizard();
    meta.rareblock.certificate.serial = ko;
    const v = m.validateMetadata(meta);
    assert.equal(v.valid, false, `serial "${ko}" doveva essere rifiutato`);
  }
});

test("validateMetadata: schema_version mismatch → invalid (forward-incompat protect)", () => {
  const meta = m.buildExampleCharizard();
  meta.rareblock.schema_version = "2.0.0";
  const v = m.validateMetadata(meta);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some(e => e.path === "$.rareblock.schema_version"));
});

// ─── JSON serializzazione: deve essere round-tripable ───────────────
test("buildExampleCharizard: JSON round-trip stabile", () => {
  const meta1 = m.buildExampleCharizard();
  const json  = JSON.stringify(meta1);
  // No BigInt residui (JSON.stringify avrebbe gettato eccezione)
  assert.ok(json.length > 0);
  const meta2 = JSON.parse(json);
  // Validation round-trip OK
  assert.equal(m.validateMetadata(meta2).valid, true);
  // Deep equality (gli oggetti devono essere identici dopo serialize/parse)
  assert.deepEqual(meta1, meta2);
});

test("buildMetadata: token_id BigInt non perde precisione attraverso JSON", () => {
  const big = 70922435100124324324324324324324324324324324324n;
  const meta = m.buildExampleCharizard({ token_id: big });
  const json = JSON.stringify(meta);
  const back = JSON.parse(json);
  assert.equal(back.rareblock.blockchain.token_id, big.toString(10));
  // E ricostruendo come BigInt, è identico all'originale
  assert.equal(BigInt(back.rareblock.blockchain.token_id), big);
});
