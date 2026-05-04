// chain/test/checkout-orchestrator.test.js
//
// Test E2E del checkout orchestrator con tutte le dipendenze mockate.
// Non richiede Postgres/Stripe/PayPal reali.

"use strict";

const test       = require("node:test");
const assert     = require("node:assert/strict");
const { createCheckoutSession, generateBankReference } = require("../lib/checkout-orchestrator");

// ──────────────────────────────────────────────────────────────────────
//  Mocks
// ──────────────────────────────────────────────────────────────────────
function buildMocks(overrides = {}) {
  const calls = { createOrder: 0, updateProviderId: 0, stripe: 0, paypal: 0 };
  const orders = [];

  const db = {
    createOrder: async ({ listingId, qty, paymentMethod }) => {
      calls.createOrder++;
      // Mimic the RPC: compute fees, return order
      const FEES = {
        bank_transfer: { buyer: 300, seller: 300 },
        stripe_card:   { buyer: 450, seller: 300 },
        paypal:        { buyer: 650, seller: 300 },
      };
      const fee = FEES[paymentMethod];
      const pricePerShare = 1000000;     // €10.000
      const subtotal = qty * pricePerShare;
      const buyerFee = Math.round(subtotal * fee.buyer / 10000);
      const sellerFee = Math.round(subtotal * fee.seller / 10000);
      const order = {
        id: `aaaaaaaa-bbbb-cccc-dddd-${String(orders.length + 1).padStart(12, '0')}`,
        listing_id: listingId,
        qty,
        price_per_share_cents: pricePerShare,
        subtotal_cents: subtotal,
        buyer_fee_bps: fee.buyer,
        seller_fee_bps: fee.seller,
        buyer_fee_cents: buyerFee,
        seller_fee_cents: sellerFee,
        total_cents: subtotal + buyerFee,
        payout_cents: subtotal - sellerFee,
        payment_method: paymentMethod,
        payment_status: "pending",
        settlement_status: "pending",
        expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        payment_provider_id: null,
      };
      orders.push(order);
      return order;
    },
    updateOrderProviderId: async (orderId, providerId) => {
      calls.updateProviderId++;
      const o = orders.find(x => x.id === orderId);
      if (o) o.payment_provider_id = providerId;
    },
    loadOrder: async (orderId) => orders.find(x => x.id === orderId) || null,
    _orders: orders,
  };

  const stripe = {
    createPaymentIntent: async (args) => {
      calls.stripe++;
      return {
        id: 'pi_mock_' + Math.random().toString(36).slice(2, 8),
        client_secret: 'pi_mock_secret_' + Math.random().toString(36).slice(2, 12),
        amount: args.amount,
        currency: args.currency,
      };
    },
  };

  const paypal = {
    createOrder: async (args) => {
      calls.paypal++;
      const ppId = 'PP-' + Math.random().toString(36).slice(2, 12).toUpperCase();
      return {
        id: ppId,
        approve_url: `https://www.sandbox.paypal.com/checkoutnow?token=${ppId}`,
      };
    },
  };

  const config = {
    bankIban: 'IT60 X054 2811 1010 0000 0123 456',
    bankAccountHolder: 'RareBlock S.r.l.',
    bankBic: 'BPMOIT22XXX',
    baseUrl: 'https://www.rareblock.eu',
    stripePublishableKey: 'pk_test_demo',
  };

  const deps = { db, stripe, paypal, config, ...overrides };
  return { deps, mocks: { calls, db, stripe, paypal } };
}

// ─── Bank transfer happy path ─────────────────────────────────────────
test("checkout: bank_transfer happy path", async () => {
  const { deps, mocks } = buildMocks();
  const r = await createCheckoutSession({
    listingId:     "listing-1",
    qty:           5,
    paymentMethod: "bank_transfer",
    buyerUserId:   "user-buyer",
    buyerEmail:    "buyer@example.com",
  }, deps);

  assert.equal(r.success, true);
  assert.equal(r.payment.kind, "bank_transfer");
  assert.match(r.payment.reference, /^RB-MP-[0-9A-F]{6}-\d{4}$/);
  assert.equal(r.payment.iban, "IT60 X054 2811 1010 0000 0123 456");
  assert.equal(r.payment.amount_cents, 5_150_000);  // 5 × 10000 + 3% = 51500.00
  assert.ok(r.payment.instructions.includes("RB-MP-"));
  assert.ok(r.payment.instructions.includes("IBAN:"));

  // No provider call for bank transfer
  assert.equal(mocks.calls.stripe, 0);
  assert.equal(mocks.calls.paypal, 0);
  assert.equal(mocks.calls.updateProviderId, 0);
});

// ─── Stripe happy path ────────────────────────────────────────────────
test("checkout: stripe_card creates PaymentIntent + saves provider id", async () => {
  const { deps, mocks } = buildMocks();
  const r = await createCheckoutSession({
    listingId:     "listing-1",
    qty:           2,
    paymentMethod: "stripe_card",
    buyerUserId:   "user-buyer",
    buyerEmail:    "buyer@example.com",
  }, deps);

  assert.equal(r.success, true);
  assert.equal(r.payment.kind, "stripe_card");
  assert.match(r.payment.client_secret, /^pi_mock_secret_/);
  assert.match(r.payment.payment_intent_id, /^pi_mock_/);
  assert.equal(r.payment.amount_cents, 2_090_000);  // 2 × 10000 + 4.5%
  assert.equal(r.payment.publishable_key, "pk_test_demo");
  assert.ok(r.payment.return_url.includes(r.order.id));

  assert.equal(mocks.calls.stripe, 1);
  assert.equal(mocks.calls.updateProviderId, 1);
  // Verify the provider id was saved in mock DB
  const order = mocks.db._orders[0];
  assert.equal(order.payment_provider_id, r.payment.payment_intent_id);
});

// ─── PayPal happy path ────────────────────────────────────────────────
test("checkout: paypal creates order + returns approve_url", async () => {
  const { deps, mocks } = buildMocks();
  const r = await createCheckoutSession({
    listingId:     "listing-1",
    qty:           3,
    paymentMethod: "paypal",
    buyerUserId:   "user-buyer",
    buyerEmail:    "buyer@example.com",
  }, deps);

  assert.equal(r.success, true);
  assert.equal(r.payment.kind, "paypal");
  assert.match(r.payment.approve_url, /^https:\/\/www\.sandbox\.paypal\.com/);
  assert.match(r.payment.order_id, /^PP-/);
  assert.equal(r.payment.amount_cents, 3_195_000);  // 3 × 10000 + 6.5%

  assert.equal(mocks.calls.paypal, 1);
  assert.equal(mocks.calls.updateProviderId, 1);
});

// ─── Validation: missing/invalid input ────────────────────────────────
test("checkout: listing_id mancante → INVALID_INPUT 400", async () => {
  const { deps } = buildMocks();
  const r = await createCheckoutSession({
    qty: 1, paymentMethod: "bank_transfer", buyerUserId: "u1",
  }, deps);
  assert.equal(r.success, false);
  assert.equal(r.code, "INVALID_INPUT");
  assert.equal(r.status, 400);
});

test("checkout: qty non-int o <=0 → INVALID_INPUT", async () => {
  const { deps } = buildMocks();
  const r1 = await createCheckoutSession({
    listingId:'l1', qty: 0, paymentMethod: 'bank_transfer', buyerUserId: 'u1',
  }, deps);
  assert.equal(r1.code, 'INVALID_INPUT');
  const r2 = await createCheckoutSession({
    listingId:'l1', qty: 1.5, paymentMethod: 'bank_transfer', buyerUserId: 'u1',
  }, deps);
  assert.equal(r2.code, 'INVALID_INPUT');
});

test("checkout: payment_method ignoto → INVALID_INPUT", async () => {
  const { deps } = buildMocks();
  const r = await createCheckoutSession({
    listingId:'l1', qty:1, paymentMethod:'crypto', buyerUserId:'u1',
  }, deps);
  assert.equal(r.code, 'INVALID_INPUT');
});

test("checkout: buyerUserId mancante → UNAUTHORIZED 401", async () => {
  const { deps } = buildMocks();
  const r = await createCheckoutSession({
    listingId:'l1', qty:1, paymentMethod:'bank_transfer',
  }, deps);
  assert.equal(r.code, 'UNAUTHORIZED');
  assert.equal(r.status, 401);
});

// ─── DB error mapping ──────────────────────────────────────────────────
test("checkout: listing_not_found dal DB → 404", async () => {
  const { deps } = buildMocks({
    db: { ...buildMocks().deps.db,
      createOrder: async () => { throw new Error('listing not found'); },
    },
  });
  const r = await createCheckoutSession({
    listingId:'missing', qty:1, paymentMethod:'bank_transfer', buyerUserId:'u1',
  }, deps);
  assert.equal(r.code, 'LISTING_NOT_FOUND');
  assert.equal(r.status, 404);
});

test("checkout: listing_not_active dal DB → 409", async () => {
  const { deps } = buildMocks({
    db: { ...buildMocks().deps.db,
      createOrder: async () => { throw new Error('listing is not active (status=reserved)'); },
    },
  });
  const r = await createCheckoutSession({
    listingId:'l1', qty:1, paymentMethod:'bank_transfer', buyerUserId:'u1',
  }, deps);
  assert.equal(r.code, 'LISTING_NOT_ACTIVE');
  assert.equal(r.status, 409);
});

test("checkout: cannot_buy_own dal DB → 403", async () => {
  const { deps } = buildMocks({
    db: { ...buildMocks().deps.db,
      createOrder: async () => { throw new Error('cannot buy your own listing'); },
    },
  });
  const r = await createCheckoutSession({
    listingId:'l1', qty:1, paymentMethod:'bank_transfer', buyerUserId:'u1',
  }, deps);
  assert.equal(r.code, 'CANNOT_BUY_OWN');
  assert.equal(r.status, 403);
});

test("checkout: qty_exceeds dal DB → INVALID_INPUT 400", async () => {
  const { deps } = buildMocks({
    db: { ...buildMocks().deps.db,
      createOrder: async () => { throw new Error('qty exceeds listing (5 > 3)'); },
    },
  });
  const r = await createCheckoutSession({
    listingId:'l1', qty:5, paymentMethod:'bank_transfer', buyerUserId:'u1',
  }, deps);
  assert.equal(r.code, 'INVALID_INPUT');
});

// ─── Provider failures ─────────────────────────────────────────────────
test("checkout: Stripe down → STRIPE_FAILED 502", async () => {
  const { deps } = buildMocks({
    stripe: { createPaymentIntent: async () => { throw new Error('stripe API timeout'); } },
  });
  const r = await createCheckoutSession({
    listingId:'l1', qty:1, paymentMethod:'stripe_card', buyerUserId:'u1',
  }, deps);
  assert.equal(r.code, 'STRIPE_FAILED');
  assert.equal(r.status, 502);
});

test("checkout: Stripe ritorna senza client_secret → STRIPE_FAILED", async () => {
  const { deps } = buildMocks({
    stripe: { createPaymentIntent: async () => ({ id: 'pi_x', client_secret: null }) },
  });
  const r = await createCheckoutSession({
    listingId:'l1', qty:1, paymentMethod:'stripe_card', buyerUserId:'u1',
  }, deps);
  assert.equal(r.code, 'STRIPE_FAILED');
});

test("checkout: PayPal down → PAYPAL_FAILED 502", async () => {
  const { deps } = buildMocks({
    paypal: { createOrder: async () => { throw new Error('paypal 503'); } },
  });
  const r = await createCheckoutSession({
    listingId:'l1', qty:1, paymentMethod:'paypal', buyerUserId:'u1',
  }, deps);
  assert.equal(r.code, 'PAYPAL_FAILED');
});

// ─── Bank reference generator ─────────────────────────────────────────
test("generateBankReference: format RB-MP-NNNNNN-XXXX", () => {
  const ref = generateBankReference("12345678-aaaa-bbbb-cccc-deadbeef0001");
  assert.match(ref, /^RB-MP-[0-9A-F]{6}-\d{4}$/);
  // Stable prefix from order_id
  assert.ok(ref.startsWith("RB-MP-123456-"));
});

test("generateBankReference: stesso order_id → stesso prefix, suffix random", () => {
  const a = generateBankReference("12345678-0000-0000-0000-000000000000");
  const b = generateBankReference("12345678-0000-0000-0000-000000000000");
  // Stesso prefix
  assert.equal(a.slice(0, 12), b.slice(0, 12));
  // Suffisso può differire (random) ma è hex/digit
});

// ─── Hygiene: no secret leak in events ────────────────────────────────
test("checkout: events log non leaka client_secret né IBAN né Stripe key", async () => {
  const { deps } = buildMocks();
  const r = await createCheckoutSession({
    listingId:'l1', qty:5, paymentMethod:'stripe_card', buyerUserId:'u1', buyerEmail:'a@b.c',
  }, deps);
  assert.equal(r.success, true);
  const blob = JSON.stringify(r.events);
  assert.ok(!blob.includes(r.payment.client_secret),  "client_secret leak in events");
  assert.ok(!blob.includes(deps.config.bankIban),     "IBAN leak in events");
  assert.ok(!blob.includes(deps.config.stripePublishableKey),
    "stripe key leak in events");
});
