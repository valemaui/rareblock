// chain/test/mint-orchestrator.test.js
//
// Test E2E del mint orchestrator con TUTTE le dipendenze mockate:
// db, wallet, metadata, pdf, pinata, storage, chain.
//
// Verifica:
//   - Happy path: 13 step, return success completo
//   - Idempotency: secondo mint sullo stesso order → ritorna esistente
//   - Fail at each step: ogni step può fallire e il return riporta lo step
//   - No PII/secret leakage in events log
//
// Run: node --test test/mint-orchestrator.test.js

"use strict";

const test       = require("node:test");
const assert     = require("node:assert/strict");

const { mintCertificate, ERR } = require("../lib/mint-orchestrator");

// Use REAL libraries for metadata/pdf/wallet (they're pure & tested),
// only mock the I/O boundary (db, pinata, storage, chain).
const wallet   = require("../lib/wallet");
const metadata = require("../lib/metadata");
const pdf      = require("../lib/pdf-certificate");

// ──────────────────────────────────────────────────────────────────────
//  Test fixtures
// ──────────────────────────────────────────────────────────────────────
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon "
+ "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

const ADMIN_USER_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID       = "22222222-2222-2222-2222-222222222222";
const PRODUCT_ID    = "33333333-3333-3333-3333-333333333333";
const ORDER_ID      = "44444444-4444-4444-4444-444444444444";

// ──────────────────────────────────────────────────────────────────────
//  Build a complete mocked deps tree, customizable by overrides.
//  Returns { deps, mocks } where mocks lets the test inspect call counts.
// ──────────────────────────────────────────────────────────────────────
function buildMocks(overrides = {}) {
  const calls = {
    insertCertificate: 0,
    insertTransfer:    0,
    pinJson:           0,
    mintTx:            0,
    uploadPdf:         0,
  };

  // ─── DB mock ──────────────────────────────────────────────────────
  let existingCert = null;
  let nextSerialIdx = 42;
  const insertedCertificates = [];
  const insertedTransfers    = [];
  const userWallets = new Map();   // user_id → { address, derivationIndex }

  const db = {
    isAdmin:      async (uid) => uid === ADMIN_USER_ID,
    loadOrder:    async (id)  => id === ORDER_ID ? {
      id:          ORDER_ID,
      product_id:  PRODUCT_ID,
      user_id:     USER_ID,
      status:      "payment_received",
      qty:         5,
      holding_id:  null,
    } : null,
    loadProduct: async (id) => id === PRODUCT_ID ? {
      id:                  PRODUCT_ID,
      name:                "Charizard Holo",
      type:                "fractional",
      set:                 "Base Set",
      year:                1999,
      edition:             "1st Edition",
      card_number:         "4/102",
      rarity:              "Holo Rare",
      card_language:       "EN",
      grading_company:     "PSA",
      grading_grade:       9,
      grading_cert_number: "12345678",
      grading_graded_at:   "2024-08-15",
      grading_label:       "PSA 9 — Mint",
      asset_category:      "tcg_card",
      asset_subcategory:   "pokemon",
      primary_image_ipfs:  "ipfs://QmFront/charizard.jpg",
      back_image_ipfs:     "ipfs://QmBack/charizard.jpg",
      shares_total:        100,
      valuation_currency:  "EUR",
      valuation_asset_total: 125000,
      valuation_share_unit: 1250,
    } : null,
    loadUser:    async (id) => id === USER_ID ? {
      id:           USER_ID,
      email:        "valentino@example.com",
      display_name: "Valentino Castiglione",
    } : null,
    loadExistingCertificate: async (orderId) => existingCert,
    getOrCreateUserWallet:   async (uid, address, idx) => {
      // Convenzione: prima call (address=null, idx=null) → ritorna {address:null, derivationIndex:1}
      // Seconda call con (address, idx) → conferma e salva
      if (userWallets.has(uid)) return userWallets.get(uid);
      if (address === null) {
        return { address: null, derivationIndex: 1 };
      }
      const rec = { address, derivationIndex: idx };
      userWallets.set(uid, rec);
      return rec;
    },
    nextSerial: async () => {
      const n = String(nextSerialIdx++).padStart(6, "0");
      return `RB-2026-${n}`;
    },
    productTokenId: async (productUuid) => {
      // Deterministic: same UUID → same token id
      return BigInt("0x" + productUuid.replace(/-/g, "").slice(0, 30));
    },
    insertCertificate: async (rec) => {
      calls.insertCertificate++;
      const out = { id: `cert-${insertedCertificates.length + 1}`, ...rec };
      insertedCertificates.push(out);
      return out;
    },
    insertTransfer: async (rec) => {
      calls.insertTransfer++;
      const out = { id: `xfer-${insertedTransfers.length + 1}`, ...rec };
      insertedTransfers.push(out);
      return out;
    },
    _setExistingCert: (c) => { existingCert = c; },
    _inserted: { cert: insertedCertificates, xfer: insertedTransfers },
  };

  // ─── Storage mock ─────────────────────────────────────────────────
  const storage = {
    uploadPdf: async (serial, buffer) => {
      calls.uploadPdf++;
      return {
        storagePath: `certs/${serial}.pdf`,
        signedUrl:   `https://storage.test/certs/${serial}.pdf?token=signed`,
      };
    },
  };

  // ─── Pinata mock ──────────────────────────────────────────────────
  const pinata = {
    pinJSON: async (body, opts) => {
      calls.pinJson++;
      // CID deterministico (per asserzioni stabili)
      const { createHash } = require("crypto");
      const cid = "Qm" + createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 44);
      return { IpfsHash: cid, PinSize: JSON.stringify(body).length, Timestamp: new Date().toISOString() };
    },
  };

  // ─── Chain mock ───────────────────────────────────────────────────
  const chain = {
    chainId:           84532,
    contractAddress:   "0xCafEbAbE0123456789aBcDeF0123456789AbCDEF",
    mintNewProduct:    async (args) => {
      calls.mintTx++;
      return {
        txHash:      "0x" + "ab".repeat(32),
        blockNumber: 12345678,
      };
    },
    buildExplorerTxUrl:    (cid, tx) => `https://sepolia.basescan.org/tx/${tx}`,
    buildExplorerTokenUrl: (cid, c, t) => `https://sepolia.basescan.org/token/${c}?a=${t}`,
  };

  // ─── Config ───────────────────────────────────────────────────────
  const config = {
    verifyUrlBase:       "https://www.rareblock.eu/chain/verify",
    externalUrlBase:     "https://www.rareblock.eu/chain/verify",
    termsUrl:            "https://www.rareblock.eu/legal/terms",
    privacyUrl:          "https://www.rareblock.eu/legal/privacy",
    custodian:           "RareBlock S.r.l.",
    vaultJurisdiction:   "IT",
    vaultId:             "RB-VAULT-01",
    issuer:              "RareBlock S.r.l.",
    insurance:           true,
    insuranceProvider:   "AXA Art Insurance",
    withdrawalPolicyUrl: "https://www.rareblock.eu/legal/withdrawal",
  };

  const deps = {
    db, wallet, metadata, pdf, pinata, storage, chain, config,
    masterMnemonic: TEST_MNEMONIC,
    ...overrides,
  };
  return { deps, mocks: { calls, db, storage, pinata, chain } };
}

// ─── Happy path ───────────────────────────────────────────────────────
test("mintCertificate: happy path produce un certificato completo", async () => {
  const { deps, mocks } = buildMocks();
  const result = await mintCertificate({
    orderId:     ORDER_ID,
    adminUserId: ADMIN_USER_ID,
  }, deps);

  assert.equal(result.success, true,
    `expected success, got: ${JSON.stringify(result.events?.slice(-1))}`);
  assert.equal(result.idempotent, false);
  assert.equal(result.step, 13);

  // Output fields
  assert.match(result.certificate_serial, /^RB-2026-\d{6}$/);
  assert.match(result.tx_hash, /^0x[a-f0-9]{64}$/);
  assert.equal(result.block_number, 12345678);
  assert.match(result.ipfs_metadata_cid, /^Qm[a-f0-9]+$/);
  assert.equal(result.ipfs_metadata_uri, `ipfs://${result.ipfs_metadata_cid}`);
  assert.match(result.pdf_sha256, /^[a-f0-9]{64}$/);
  assert.match(result.owner_address, /^0x[a-fA-F0-9]{40}$/);
  assert.match(result.explorer_tx_url, /sepolia\.basescan\.org\/tx\//);

  // Side effects
  assert.equal(mocks.calls.uploadPdf,        1);
  assert.equal(mocks.calls.pinJson,          1);
  assert.equal(mocks.calls.mintTx,           1);
  assert.equal(mocks.calls.insertCertificate,1);
  assert.equal(mocks.calls.insertTransfer,   1);

  // Inserted certificate has expected fields
  const cert = mocks.db._inserted.cert[0];
  assert.equal(cert.order_id,             ORDER_ID);
  assert.equal(cert.current_owner_user_id, USER_ID);
  assert.equal(cert.qty_minted,           5);
  assert.equal(cert.status,               "minted");
  assert.equal(cert.chain_id,             84532);
  assert.match(cert.contract_address,     /^0x[a-fA-F0-9]{40}$/);

  // The transfer record is correctly set as a "mint" event
  const xfer = mocks.db._inserted.xfer[0];
  assert.equal(xfer.transfer_type, "mint");
  assert.equal(xfer.from_wallet,   "0x" + "00".repeat(20));
  assert.equal(xfer.to_user_id,    USER_ID);
});

// ─── Idempotency ──────────────────────────────────────────────────────
test("mintCertificate: idempotent — secondo mint sullo stesso order ritorna esistente", async () => {
  const { deps, mocks } = buildMocks();
  // Pre-popola il DB con un certificato esistente
  mocks.db._setExistingCert({
    id:                 "cert-existing",
    certificate_serial: "RB-2026-000001",
    tx_hash_mint:       "0x" + "ee".repeat(32),
  });
  const result = await mintCertificate({
    orderId: ORDER_ID, adminUserId: ADMIN_USER_ID,
  }, deps);
  assert.equal(result.success,           true);
  assert.equal(result.idempotent,        true);
  assert.equal(result.step,              3);
  assert.equal(result.certificate_id,    "cert-existing");
  assert.equal(result.certificate_serial,"RB-2026-000001");
  // Nessun mint side-effect ripetuto
  assert.equal(mocks.calls.mintTx,    0);
  assert.equal(mocks.calls.pinJson,   0);
  assert.equal(mocks.calls.uploadPdf, 0);
});

// ─── Auth fail ────────────────────────────────────────────────────────
test("mintCertificate: non-admin → UNAUTHORIZED", async () => {
  const { deps } = buildMocks();
  const result = await mintCertificate({
    orderId: ORDER_ID, adminUserId: "non-admin-user-id",
  }, deps);
  assert.equal(result.success, false);
  assert.equal(result.step,    1);
  assert.equal(result.code,    "UNAUTHORIZED");
});

// ─── Validation fails ─────────────────────────────────────────────────
test("mintCertificate: orderId mancante → INVALID_INPUT", async () => {
  const { deps } = buildMocks();
  const result = await mintCertificate({ adminUserId: ADMIN_USER_ID }, deps);
  assert.equal(result.success, false);
  assert.equal(result.code,    "INVALID_INPUT");
});

test("mintCertificate: order non trovato → ORDER_NOT_FOUND", async () => {
  const { deps } = buildMocks();
  const result = await mintCertificate({
    orderId: "nonexistent", adminUserId: ADMIN_USER_ID,
  }, deps);
  assert.equal(result.success, false);
  assert.equal(result.code,    "ORDER_NOT_FOUND");
  assert.equal(result.step,    2);
});

test("mintCertificate: order non pagato → ORDER_NOT_PAID", async () => {
  const { deps } = buildMocks({
    db: { ...buildMocks().deps.db,
      loadOrder: async () => ({
        id: ORDER_ID, product_id: PRODUCT_ID, user_id: USER_ID,
        status: "draft", qty: 5,
      }),
    },
  });
  const result = await mintCertificate({
    orderId: ORDER_ID, adminUserId: ADMIN_USER_ID,
  }, deps);
  assert.equal(result.success, false);
  assert.equal(result.code,    "ORDER_NOT_PAID");
});

// ─── Failure mode propagation ─────────────────────────────────────────
test("mintCertificate: pinata fallisce → IPFS_PIN, no mint, no DB insert", async () => {
  const { deps, mocks } = buildMocks();
  // Override pinata.pinJSON per fallire
  deps.pinata = { pinJSON: async () => { throw new Error("pinata down"); } };

  const result = await mintCertificate({
    orderId: ORDER_ID, adminUserId: ADMIN_USER_ID,
  }, deps);
  assert.equal(result.success, false);
  assert.equal(result.code,    "IPFS_PIN");
  assert.equal(result.step,    9);
  // Nessun side-effect on-chain o DB
  assert.equal(mocks.calls.mintTx,            0);
  assert.equal(mocks.calls.insertCertificate, 0);
  assert.equal(mocks.calls.insertTransfer,    0);
});

test("mintCertificate: chain mint fallisce → MINT_TX_FAILED, no DB insert", async () => {
  const { deps, mocks } = buildMocks();
  deps.chain = { ...deps.chain,
    mintNewProduct: async () => { throw new Error("revert: out of gas"); },
  };
  const result = await mintCertificate({
    orderId: ORDER_ID, adminUserId: ADMIN_USER_ID,
  }, deps);
  assert.equal(result.success, false);
  assert.equal(result.code,    "MINT_TX_FAILED");
  // Pinata già pinnato, ma DB non scritto (consistente)
  assert.equal(mocks.calls.pinJson,           1);
  assert.equal(mocks.calls.insertCertificate, 0);
});

test("mintCertificate: storage upload fallisce → STORAGE_UPLOAD prima del Pinata", async () => {
  const { deps, mocks } = buildMocks();
  deps.storage = { uploadPdf: async () => { throw new Error("S3 timeout"); } };
  const result = await mintCertificate({
    orderId: ORDER_ID, adminUserId: ADMIN_USER_ID,
  }, deps);
  assert.equal(result.success, false);
  assert.equal(result.code,    "STORAGE_UPLOAD");
  // Pinata, mint, DB tutti non chiamati
  assert.equal(mocks.calls.pinJson, 0);
  assert.equal(mocks.calls.mintTx,  0);
});

// ─── Wallet derivation ────────────────────────────────────────────────
test("mintCertificate: deriva wallet utente al primo mint, riusa al secondo", async () => {
  const { deps, mocks } = buildMocks();
  const r1 = await mintCertificate({
    orderId: ORDER_ID, adminUserId: ADMIN_USER_ID,
  }, deps);
  assert.equal(r1.success, true);
  const firstAddress = r1.owner_address;

  // Secondo ordine per stesso user (diverso order)
  // Per testarlo, faccio override loadOrder e existingCert
  deps.db.loadOrder = async (id) => ({
    id: "order-2", product_id: PRODUCT_ID, user_id: USER_ID,
    status: "payment_received", qty: 3,
  });
  // existingCert ancora null, nuovo order
  deps.db.loadExistingCertificate = async () => null;

  const r2 = await mintCertificate({
    orderId: "order-2", adminUserId: ADMIN_USER_ID,
  }, deps);
  assert.equal(r2.success, true);
  // Stesso user → stesso wallet
  assert.equal(r2.owner_address, firstAddress);
});

// ─── Logging hygiene: nessun secret nei log ───────────────────────────
test("mintCertificate: events non leakano mnemonic, jwt, privKey", async () => {
  const { deps } = buildMocks();
  const result = await mintCertificate({
    orderId: ORDER_ID, adminUserId: ADMIN_USER_ID,
  }, deps);
  const eventsBlob = JSON.stringify(result.events);
  assert.ok(!eventsBlob.includes(TEST_MNEMONIC),
    "events log non deve contenere la mnemonic");
  assert.ok(!eventsBlob.includes("abandon abandon"),
    "events log non deve contenere fragments della mnemonic");
  // PrivKey hex non deve apparire in chiaro
  const w = wallet.deriveWallet(TEST_MNEMONIC, "user", 1);
  assert.ok(!eventsBlob.includes(w.privateKey),
    "events log non deve contenere private key");
});
