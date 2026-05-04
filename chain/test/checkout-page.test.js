// chain/test/checkout-page.test.js
//
// Test della pagina chain-marketplace-checkout.html

"use strict";

const test       = require("node:test");
const assert     = require("node:assert/strict");
const fs         = require("fs");
const path       = require("path");

const HTML_PATH = path.join(__dirname, "..", "rareblock-chain-marketplace-checkout.html");
const html      = fs.readFileSync(HTML_PATH, "utf8");

// ─── HYGIENE ──────────────────────────────────────────────────────────
test("checkout-page: no <script src> baked in HTML (Stripe/PayPal lazy-loaded)", () => {
  // L'HTML statico non deve includere script di terze parti hardcoded.
  // Stripe.js viene caricato con loadScript() solo quando l'utente sceglie carta.
  const externalScripts = html.match(/<script\s+[^>]*src=/gi) || [];
  assert.equal(externalScripts.length, 0,
    "scripts esterni devono essere lazy-loaded, non in <head>");
});

test("checkout-page: link esterni solo Google Fonts", () => {
  const linkHrefs = (html.match(/<link[^>]+href="([^"]+)"/g) || [])
    .map(l => l.match(/href="([^"]+)"/)[1]);
  for (const href of linkHrefs) {
    const ok = href.startsWith("https://fonts.googleapis.com")
            || href.startsWith("https://fonts.gstatic.com");
    assert.ok(ok, `link non whitelisted: ${href}`);
  }
});

test("checkout-page: usa session key condivisa", () => {
  assert.ok(html.includes("'rb_auth_session'"));
});

test("checkout-page: chiama Edge Function chain-checkout", () => {
  assert.ok(html.includes("/functions/v1/chain-checkout"));
});

test("checkout-page: lazy-load Stripe.js", () => {
  assert.ok(html.includes("https://js.stripe.com/v3/"),
    "deve caricare Stripe.js dinamicamente");
  assert.ok(html.includes("loadScript"),
    "deve avere helper loadScript");
});

test("checkout-page: niente Stripe secret key (sk_) né API key hardcoded", () => {
  assert.ok(!html.match(/sk_(test|live)_[a-zA-Z0-9]/),
    "non deve contenere Stripe secret key");
  assert.ok(!html.match(/PAYPAL_SECRET/),
    "non deve riferire al PayPal secret");
});

test("checkout-page: nessun service_role token", () => {
  assert.ok(!html.match(/service[_-]?role/i));
});

test("checkout-page: Stripe Elements appearance theme dark + brand gold", () => {
  assert.ok(html.includes("'#c9a961'"), "deve usare brand gold");
  assert.ok(html.includes("'night'"),    "deve usare appearance theme dark");
});

// ─── FLOW LOGIC (replicata) ───────────────────────────────────────────
function feeForMethod(method, feeConfig) {
  return feeConfig.find(f => f.payment_method === method) || feeConfig[0];
}
function recomputeAmounts(qty, pricePerShare, method, feeConfig) {
  const fee = feeForMethod(method, feeConfig);
  const subtotal = qty * pricePerShare;
  const buyerFee = Math.round(subtotal * fee.buyer_fee_bps / 10000);
  return { subtotal, buyerFee, total: subtotal + buyerFee };
}

const FEE_CFG = [
  { payment_method:'bank_transfer', buyer_fee_bps:300, seller_fee_bps:300 },
  { payment_method:'stripe_card',   buyer_fee_bps:450, seller_fee_bps:300 },
  { payment_method:'paypal',        buyer_fee_bps:650, seller_fee_bps:300 },
];

test("flow: switching method ricalcola il totale", () => {
  const r1 = recomputeAmounts(5, 1_000_000, 'bank_transfer', FEE_CFG);
  const r2 = recomputeAmounts(5, 1_000_000, 'stripe_card',   FEE_CFG);
  const r3 = recomputeAmounts(5, 1_000_000, 'paypal',        FEE_CFG);
  // Subtotal uguale tra metodi
  assert.equal(r1.subtotal, r2.subtotal);
  assert.equal(r2.subtotal, r3.subtotal);
  // Total varia
  assert.ok(r1.total < r2.total && r2.total < r3.total);
  // Numeri esatti
  assert.equal(r1.total, 5_150_000);
  assert.equal(r2.total, 5_225_000);
  assert.equal(r3.total, 5_325_000);
});

test("flow: qty cambiata aggiorna proporzionalmente", () => {
  const r1 = recomputeAmounts(1, 100_000, 'bank_transfer', FEE_CFG);
  const r5 = recomputeAmounts(5, 100_000, 'bank_transfer', FEE_CFG);
  assert.equal(r5.total, r1.total * 5);
});

// ─── DOM STRUCTURE ────────────────────────────────────────────────────
test("checkout-page: contiene tutti gli stati", () => {
  for (const id of ['state-loading','state-auth','state-nolisting','state-done','state-main']) {
    assert.ok(html.includes(`id="${id}"`), `manca state #${id}`);
  }
});

test("checkout-page: bank, stripe, paypal flow handlers presenti", () => {
  assert.ok(html.includes("onBankGo"));
  assert.ok(html.includes("onStripePay"));
  assert.ok(html.includes("onPaypalGo"));
});

test("checkout-page: copy buttons per IBAN e reference", () => {
  assert.ok(html.includes("data-copy="),
    "deve avere bottoni copy per IBAN/reference");
  assert.ok(html.includes("navigator.clipboard.writeText"),
    "deve usare clipboard API");
});

test("checkout-page: PayPal flow è redirect, non popup", () => {
  // Per evitare popup blocker e per UX semplice, redirigiamo
  assert.ok(html.includes("location.href = _checkoutSession.payment.approve_url"),
    "deve redirect alla approve_url di PayPal");
});

test("checkout-page: error handling user-friendly", () => {
  const codes = ['LISTING_NOT_FOUND','LISTING_NOT_ACTIVE','CANNOT_BUY_OWN',
                 'STRIPE_FAILED','PAYPAL_FAILED','UNAUTHORIZED'];
  for (const c of codes) {
    assert.ok(html.includes(`'${c}'`), `error code ${c} deve avere messaggio dedicato`);
  }
});

test("checkout-page: XSS-safe — campi dal listing passati per escHtml", () => {
  const lines = html.split('\n');
  const offending = [];
  lines.forEach((line, i) => {
    if (!line.includes('${')) return;
    if (!line.includes('innerHTML') && !line.includes('return `')) return;
    const dangerous = line.match(/\$\{(?:p|product|_listing)\.[a-z_]+\}/);
    if (dangerous && !line.includes('escHtml') && !line.includes('fmtEUR')) {
      offending.push(`L${i+1}: ${line.trim()}`);
    }
  });
  assert.equal(offending.length, 0, `Unescaped DB interpolation:\n${offending.join('\n')}`);
});

// ─── MIGRATION 030 PRESENT ────────────────────────────────────────────
test("migration 030: file presente con tutti gli oggetti attesi", () => {
  const migPath = path.join(__dirname, "..", "..", "supabase", "migrations", "030_marketplace_orders.sql");
  assert.ok(fs.existsSync(migPath));
  const sql = fs.readFileSync(migPath, "utf8");
  assert.ok(sql.includes("marketplace_create_order"));
  assert.ok(sql.includes("marketplace_release_order"));
  assert.ok(sql.includes("marketplace_expire_stale"));
  // Atomic: nella stessa funzione fa UPDATE listings + INSERT orders
  assert.ok(sql.match(/UPDATE marketplace_listings[\s\S]*INSERT INTO marketplace_orders/),
    "create_order deve aggiornare il listing E inserire l'order nella stessa funzione");
});

test("migration 030: idempotency su release_order", () => {
  const migPath = path.join(__dirname, "..", "..", "supabase", "migrations", "030_marketplace_orders.sql");
  const sql = fs.readFileSync(migPath, "utf8");
  // Quando lo stato è già cancelled/failed/refunded, deve ritornare senza errore
  assert.ok(sql.includes("RETURN v_order"),
    "release_order deve essere idempotente");
});
