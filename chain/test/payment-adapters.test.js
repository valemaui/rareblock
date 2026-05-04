// chain/test/payment-adapters.test.js
//
// Test degli adapter Stripe + PayPal con fetch mockata. Verifica che le
// request siano formate correttamente: header, body encoding, OAuth flow.

"use strict";

const test       = require("node:test");
const assert     = require("node:assert/strict");
const { makeStripeAdapter, StripeError } = require("../supabase-functions/_shared/stripe-adapter");
const { makePayPalAdapter, PayPalError } = require("../supabase-functions/_shared/paypal-adapter");

// ─── Mock fetch helper ────────────────────────────────────────────────
function captureFetch(handlers) {
  const calls = [];
  let i = 0;
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const h = handlers[i++];
    if (!h) throw new Error("captureFetch: out of handlers");
    return await h(url, opts);
  };
  fn.calls = calls;
  return fn;
}
function makeRes(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  STRIPE
// ═══════════════════════════════════════════════════════════════════════
test("stripe: rifiuta key non valida", () => {
  assert.throws(() => makeStripeAdapter({ secretKey: "" }), /sk_/);
  assert.throws(() => makeStripeAdapter({ secretKey: "invalid" }), /sk_/);
});

test("stripe: createPaymentIntent con metadata e form encoding", async () => {
  const fetchFn = captureFetch([
    async () => makeRes(200, {
      id: 'pi_123',
      client_secret: 'pi_123_secret_abc',
      amount: 5000,
      currency: 'eur',
      status: 'requires_payment_method',
    }),
  ]);
  const stripe = makeStripeAdapter({ secretKey: "sk_test_xxx", fetchFn });
  const intent = await stripe.createPaymentIntent({
    amount: 5000,
    currency: "eur",
    metadata: { order_id: "abc-123", buyer_user_id: "u-456" },
    receipt_email: "buyer@example.com",
    statement_descriptor_suffix: "RAREBLOCK",
  });

  assert.equal(intent.id, "pi_123");
  assert.equal(intent.client_secret, "pi_123_secret_abc");

  // Verify request shape
  const call = fetchFn.calls[0];
  assert.equal(call.url, "https://api.stripe.com/v1/payment_intents");
  assert.equal(call.opts.method, "POST");
  assert.equal(call.opts.headers.Authorization, "Bearer sk_test_xxx");
  assert.equal(call.opts.headers["Content-Type"], "application/x-www-form-urlencoded");
  // Body must be url-encoded with bracket notation for nested metadata
  assert.match(call.opts.body, /amount=5000/);
  assert.match(call.opts.body, /currency=eur/);
  assert.match(call.opts.body, /metadata%5Border_id%5D=abc-123/);
  assert.match(call.opts.body, /metadata%5Bbuyer_user_id%5D=u-456/);
  assert.match(call.opts.body, /receipt_email=buyer%40example\.com/);
  assert.match(call.opts.body, /automatic_payment_methods%5Benabled%5D=true/);
});

test("stripe: troncamento statement_descriptor_suffix a 22 char", async () => {
  const fetchFn = captureFetch([
    async () => makeRes(200, { id: "pi_x", client_secret: "pi_x_s" }),
  ]);
  const stripe = makeStripeAdapter({ secretKey: "sk_test_xxx", fetchFn });
  await stripe.createPaymentIntent({
    amount: 100, currency: "eur",
    statement_descriptor_suffix: "A".repeat(50),
  });
  const body = fetchFn.calls[0].opts.body;
  // Cerca il valore: deve essere esattamente 22 A
  const m = body.match(/statement_descriptor_suffix=([^&]+)/);
  assert.ok(m, "statement_descriptor_suffix must be present");
  assert.equal(decodeURIComponent(m[1]).length, 22);
});

test("stripe: error response → StripeError con code", async () => {
  const fetchFn = captureFetch([
    async () => makeRes(400, {
      error: { code: "amount_too_small", message: "Amount must be at least 50 cents" },
    }),
  ]);
  const stripe = makeStripeAdapter({ secretKey: "sk_test_xxx", fetchFn });
  await assert.rejects(
    stripe.createPaymentIntent({ amount: 10, currency: "eur" }),
    (err) => err instanceof StripeError && err.code === "amount_too_small" && err.statusCode === 400
  );
});

test("stripe: missing amount/currency → StripeError INVALID_INPUT", async () => {
  const stripe = makeStripeAdapter({ secretKey: "sk_test_x", fetchFn: () => {} });
  await assert.rejects(stripe.createPaymentIntent({}), /amount and currency/);
});

// ═══════════════════════════════════════════════════════════════════════
//  PAYPAL
// ═══════════════════════════════════════════════════════════════════════

test("paypal: rifiuta credentials mancanti", () => {
  assert.throws(() => makePayPalAdapter({ clientId: "", secret: "x" }));
  assert.throws(() => makePayPalAdapter({ clientId: "x", secret: "" }));
  assert.throws(() => makePayPalAdapter({ clientId: "x", secret: "x", env: "wrong" }));
});

test("paypal: createOrder esegue oauth + create order in 2 fetch", async () => {
  const fetchFn = captureFetch([
    // 1) OAuth token
    async (url, opts) => {
      assert.match(url, /\/v1\/oauth2\/token$/);
      assert.match(opts.headers.Authorization, /^Basic /);
      assert.equal(opts.body, "grant_type=client_credentials");
      return makeRes(200, { access_token: 'A0', expires_in: 3600 });
    },
    // 2) Create order
    async (url, opts) => {
      assert.match(url, /\/v2\/checkout\/orders$/);
      assert.equal(opts.headers.Authorization, "Bearer A0");
      const body = JSON.parse(opts.body);
      assert.equal(body.intent, "CAPTURE");
      assert.equal(body.purchase_units[0].amount.value, "51.50");
      assert.equal(body.purchase_units[0].amount.currency_code, "EUR");
      assert.equal(body.purchase_units[0].custom_id, "ord-1");
      return makeRes(201, {
        id: "PP-12345",
        status: "CREATED",
        links: [
          { rel: "self",     href: "https://api-m.sandbox.paypal.com/v2/checkout/orders/PP-12345" },
          { rel: "approve",  href: "https://www.sandbox.paypal.com/checkoutnow?token=PP-12345" },
        ],
      });
    },
  ]);
  const pp = makePayPalAdapter({ clientId: "cid", secret: "csec", env: "sandbox", fetchFn });
  const order = await pp.createOrder({
    amount_cents: 5150,
    currency: "EUR",
    order_id: "ord-1",
    return_url: "https://www.rareblock.eu/return",
    cancel_url: "https://www.rareblock.eu/cancel",
  });
  assert.equal(order.id, "PP-12345");
  assert.match(order.approve_url, /sandbox\.paypal\.com\/checkoutnow/);
});

test("paypal: token caching — seconda call non rifa OAuth", async () => {
  let oauthCalls = 0, orderCalls = 0;
  const fetchFn = async (url, opts) => {
    if (url.endsWith("/v1/oauth2/token")) {
      oauthCalls++;
      return makeRes(200, { access_token: 'cached', expires_in: 3600 });
    }
    if (url.endsWith("/v2/checkout/orders")) {
      orderCalls++;
      return makeRes(201, {
        id: 'PP-' + orderCalls,
        links: [{ rel: 'approve', href: 'https://example/approve' }],
      });
    }
    throw new Error("unexpected url " + url);
  };
  const pp = makePayPalAdapter({ clientId: "cid", secret: "csec", env: "sandbox", fetchFn });
  await pp.createOrder({ amount_cents: 100, currency: "EUR", order_id: "a", return_url: "x", cancel_url: "y" });
  await pp.createOrder({ amount_cents: 200, currency: "EUR", order_id: "b", return_url: "x", cancel_url: "y" });
  assert.equal(oauthCalls, 1, "OAuth should be called once and cached");
  assert.equal(orderCalls, 2);
});

test("paypal: error response → PayPalError", async () => {
  const fetchFn = captureFetch([
    async () => makeRes(401, { error: "invalid_client", error_description: "Client Authentication failed" }),
  ]);
  const pp = makePayPalAdapter({ clientId: "bad", secret: "bad", env: "sandbox", fetchFn });
  await assert.rejects(
    pp.createOrder({ amount_cents: 100, currency: "EUR", order_id: "a", return_url: "x", cancel_url: "y" }),
    (err) => err instanceof PayPalError && err.code === "AUTH_FAILED"
  );
});

test("paypal: amount conversion da cents a string EUR", async () => {
  const fetchFn = captureFetch([
    async () => makeRes(200, { access_token: 'A', expires_in: 3600 }),
    async (url, opts) => {
      const body = JSON.parse(opts.body);
      // 12345 cents → "123.45"
      assert.equal(body.purchase_units[0].amount.value, "123.45");
      // 100 cents → "1.00"
      return makeRes(201, { id: "PP-Y", links: [{ rel: 'approve', href: 'x' }] });
    },
  ]);
  const pp = makePayPalAdapter({ clientId: "cid", secret: "csec", env: "sandbox", fetchFn });
  await pp.createOrder({ amount_cents: 12345, currency: "EUR", order_id: "x", return_url: "u", cancel_url: "v" });
});
