// chain/test/settlement-orchestrator.test.js
//
// Test E2E del settlement orchestrator con mock DB + chain.

"use strict";

const test       = require("node:test");
const assert     = require("node:assert/strict");
const { applySettlement } = require("../lib/settlement-orchestrator");

// ──────────────────────────────────────────────────────────────────────
//  Mocks
// ──────────────────────────────────────────────────────────────────────
function buildMocks(overrides = {}) {
  const calls = { loadOrder: 0, getWallet: 0, nextSerial: 0, chain: 0, apply: 0 };
  const orderFixture = {
    order_id: "11111111-1111-1111-1111-111111111111",
    listing_id: "22222222-2222-2222-2222-222222222222",
    certificate_id: "33333333-3333-3333-3333-333333333333",
    buyer_user_id: "44444444-4444-4444-4444-444444444444",
    seller_user_id: "55555555-5555-5555-5555-555555555555",
    qty: 5,
    payment_method: "stripe_card",
    payment_status: "paid",
    settlement_status: "pending",
    payment_provider_id: "pi_test_123",
    paid_at: new Date().toISOString(),
    token_id: "1234567890",
    chain_id: 84532,
    contract_address: "0xCafEbAbE0123456789aBcDeF0123456789AbCDEF",
    seller_serial: "RB-2026-000001",
    seller_wallet: "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa",
    settlement_tx_hash: null,
    ...(overrides.order || {}),
  };

  const db = {
    loadOrderForSettle: async (orderId) => {
      calls.loadOrder++;
      if (orderId === "missing") return null;
      return orderFixture;
    },
    getOrCreateBuyerWallet: async (userId) => {
      calls.getWallet++;
      if ('buyerWallet' in (overrides || {})) return overrides.buyerWallet;
      return "0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb";
    },
    nextSerial: async () => {
      calls.nextSerial++;
      return overrides.newSerial ?? "RB-2026-000099";
    },
    applySettlement: async (args) => {
      calls.apply++;
      if (overrides.applyError) throw overrides.applyError;
      return overrides.applyResult ?? {
        seller_cert_id: orderFixture.certificate_id,
        buyer_cert_id:  "66666666-6666-6666-6666-666666666666",
        transfer_id:    "77777777-7777-7777-7777-777777777777",
        was_idempotent: false,
      };
    },
  };

  const chain = {
    computeReasonHash: (s) => "0x" + Buffer.from(s).toString('hex').padEnd(64, '0').slice(0, 64),
    custodialTransfer: async ({ from, to, tokenId, qty, reasonHash }) => {
      calls.chain++;
      if (overrides.chainError) throw overrides.chainError;
      return overrides.chainResult ?? {
        txHash: "0x" + "a".repeat(64),
        blockNumber: 18293485,
      };
    },
  };

  return { deps: { db, chain }, calls, orderFixture };
}

// ─── Happy path ─────────────────────────────────────────────────────
test("settlement: happy path", async () => {
  const { deps, calls } = buildMocks();
  const r = await applySettlement({ orderId: "any-id" }, deps);

  assert.equal(r.success, true);
  assert.equal(r.was_idempotent, false);
  assert.match(r.tx_hash, /^0x[a-f0-9]{64}$/);
  assert.equal(r.block_number, 18293485);
  assert.ok(r.buyer_cert_id);
  assert.ok(r.transfer_id);

  assert.equal(calls.loadOrder, 1);
  assert.equal(calls.getWallet, 1);
  assert.equal(calls.nextSerial, 1);
  assert.equal(calls.chain, 1);
  assert.equal(calls.apply, 1);
});

// ─── Already settled → short-circuit ────────────────────────────────
test("settlement: already settled returns idempotent (no chain call)", async () => {
  const { deps, calls } = buildMocks({
    order: {
      settlement_status: "transferred",
      settlement_tx_hash: "0x" + "b".repeat(64),
    },
  });
  const r = await applySettlement({ orderId: "any-id" }, deps);

  assert.equal(r.success, true);
  assert.equal(r.was_idempotent, true);
  assert.equal(r.tx_hash, "0x" + "b".repeat(64));
  // CRITICAL: chain NOT called when already settled
  assert.equal(calls.chain, 0,    "chain custodialTransfer must NOT be called");
  assert.equal(calls.apply, 0,    "apply RPC must NOT be called");
  assert.equal(calls.nextSerial, 0, "nextSerial must NOT be called");
});

// ─── Validation ─────────────────────────────────────────────────────
test("settlement: orderId mancante → INVALID_INPUT", async () => {
  const { deps } = buildMocks();
  const r = await applySettlement({}, deps);
  assert.equal(r.success, false);
  assert.equal(r.code, "INVALID_INPUT");
  assert.equal(r.status, 400);
});

// ─── Order not found ────────────────────────────────────────────────
test("settlement: order non trovato → ORDER_NOT_FOUND 404", async () => {
  const { deps } = buildMocks();
  const r = await applySettlement({ orderId: "missing" }, deps);
  assert.equal(r.code, "ORDER_NOT_FOUND");
  assert.equal(r.status, 404);
});

// ─── Order not paid ─────────────────────────────────────────────────
test("settlement: order non-paid → ORDER_NOT_PAID 409", async () => {
  const { deps } = buildMocks({
    order: { payment_status: "pending", settlement_status: "pending" },
  });
  const r = await applySettlement({ orderId: "any" }, deps);
  assert.equal(r.code, "ORDER_NOT_PAID");
  assert.equal(r.status, 409);
});

// ─── Settlement in unexpected state ─────────────────────────────────
test("settlement: settlement_status = failed → ORDER_NOT_PAID", async () => {
  const { deps } = buildMocks({
    order: { payment_status: "paid", settlement_status: "failed" },
  });
  const r = await applySettlement({ orderId: "any" }, deps);
  assert.equal(r.code, "ORDER_NOT_PAID");
});

// ─── Buyer wallet missing ───────────────────────────────────────────
test("settlement: buyer wallet missing → BUYER_WALLET_MISSING 422", async () => {
  const { deps } = buildMocks({ buyerWallet: null });
  const r = await applySettlement({ orderId: "any" }, deps);
  assert.equal(r.code, "BUYER_WALLET_MISSING");
  assert.equal(r.status, 422);
});

test("settlement: buyer wallet invalido (non-hex) → BUYER_WALLET_MISSING", async () => {
  const { deps } = buildMocks({ buyerWallet: "not-a-wallet" });
  const r = await applySettlement({ orderId: "any" }, deps);
  assert.equal(r.code, "BUYER_WALLET_MISSING");
});

test("settlement: buyer wallet con caratteri non-hex → BUYER_WALLET_MISSING", async () => {
  const { deps } = buildMocks({ buyerWallet: "0xZZZZ" });
  const r = await applySettlement({ orderId: "any" }, deps);
  assert.equal(r.code, "BUYER_WALLET_MISSING");
});

// ─── Chain TX fails ─────────────────────────────────────────────────
test("settlement: chain TX revert → CHAIN_TX_FAILED 502", async () => {
  const { deps, calls } = buildMocks({
    chainError: new Error("execution reverted: insufficient balance"),
  });
  const r = await applySettlement({ orderId: "any" }, deps);
  assert.equal(r.code, "CHAIN_TX_FAILED");
  assert.equal(r.status, 502);
  // CRITICAL: DB.applySettlement must NOT be called if chain failed
  assert.equal(calls.apply, 0);
});

test("settlement: chain ritorna senza txHash → CHAIN_TX_FAILED", async () => {
  const { deps } = buildMocks({
    chainResult: { txHash: null, blockNumber: 0 },
  });
  const r = await applySettlement({ orderId: "any" }, deps);
  assert.equal(r.code, "CHAIN_TX_FAILED");
});

// ─── DB apply fails AFTER chain TX ──────────────────────────────────
test("settlement: DB apply fails dopo chain TX → DB_APPLY_FAILED + tx_hash menzionato", async () => {
  const { deps, calls } = buildMocks({
    applyError: new Error("Postgres deadlock"),
  });
  const r = await applySettlement({ orderId: "any" }, deps);
  assert.equal(r.code, "DB_APPLY_FAILED");
  assert.equal(r.status, 500);
  // The chain tx WAS executed
  assert.equal(calls.chain, 1);
  assert.equal(calls.apply, 1);
  // Error message should contain the tx_hash so admin can reconcile manually
  assert.match(r.error, /0x[a-f0-9]{64}/);
});

// ─── Sequence verification ──────────────────────────────────────────
test("settlement: sequenza 1.load → 2.wallet → 3.serial → 4.chain → 5.apply", async () => {
  const sequence = [];
  const { deps } = buildMocks({
    order: { settlement_status: "pending", payment_status: "paid" },
  });
  // Override to record sequence
  const origLoad = deps.db.loadOrderForSettle;
  const origWallet = deps.db.getOrCreateBuyerWallet;
  const origSerial = deps.db.nextSerial;
  const origChain = deps.chain.custodialTransfer;
  const origApply = deps.db.applySettlement;
  deps.db.loadOrderForSettle = async (...a) => { sequence.push("load");   return origLoad(...a); };
  deps.db.getOrCreateBuyerWallet = async (...a) => { sequence.push("wallet"); return origWallet(...a); };
  deps.db.nextSerial = async (...a) => { sequence.push("serial"); return origSerial(...a); };
  deps.chain.custodialTransfer = async (...a) => { sequence.push("chain"); return origChain(...a); };
  deps.db.applySettlement = async (...a) => { sequence.push("apply"); return origApply(...a); };

  await applySettlement({ orderId: "any" }, deps);
  assert.deepEqual(sequence, ["load", "wallet", "serial", "chain", "apply"]);
});

// ─── reasonHash is deterministic per order ──────────────────────────
test("settlement: reasonHash deterministic per orderId", async () => {
  let captured;
  const { deps } = buildMocks();
  const origChain = deps.chain.custodialTransfer;
  deps.chain.custodialTransfer = async (args) => {
    captured = args.reasonHash;
    return origChain(args);
  };
  await applySettlement({ orderId: "any" }, deps);
  // hash should start with hex of the orderId prefix
  assert.match(captured, /^0x[a-f0-9]{64}$/);
});

// ─── Events log doesn't leak sensitive data ─────────────────────────
test("settlement: events log non leaka PaymentIntent id o IBAN", async () => {
  const { deps } = buildMocks({
    order: { payment_provider_id: "pi_test_SECRET_DATA" },
  });
  const r = await applySettlement({ orderId: "any" }, deps);
  const blob = JSON.stringify(r.events);
  assert.ok(!blob.includes("pi_test_SECRET_DATA"));
});
