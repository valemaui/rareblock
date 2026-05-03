// chain/test/marketplace-list-page.test.js
//
// Test della pagina chain-marketplace-list.html:
//  - HTML smoke (single-file, no external scripts, no service-role)
//  - Fee math purity (la stessa formula del DB lato server)
//  - Form validation logic

"use strict";

const test       = require("node:test");
const assert     = require("node:assert/strict");
const fs         = require("fs");
const path       = require("path");

const HTML_PATH = path.join(__dirname, "..", "rareblock-chain-marketplace-list.html");
const html      = fs.readFileSync(HTML_PATH, "utf8");

// ─── HTML hygiene ─────────────────────────────────────────────────────
test("listing-page: single-file, no external <script src>", () => {
  const externalScripts = html.match(/<script\s+[^>]*src=/gi) || [];
  assert.equal(externalScripts.length, 0);
});

test("listing-page: link esterni solo Google Fonts", () => {
  const linkHrefs = (html.match(/<link[^>]+href="([^"]+)"/g) || [])
    .map(l => l.match(/href="([^"]+)"/)[1]);
  for (const href of linkHrefs) {
    const ok = href.startsWith("https://fonts.googleapis.com")
            || href.startsWith("https://fonts.gstatic.com");
    assert.ok(ok, `non whitelisted link: ${href}`);
  }
});

test("listing-page: usa la stessa session key del resto del progetto", () => {
  assert.ok(html.includes("'rb_auth_session'"));
});

test("listing-page: chiama la RPC marketplace_create_listing", () => {
  assert.ok(html.includes("marketplace_create_listing"),
    "deve usare la RPC, non insert diretto");
  assert.ok(html.includes("p_certificate_id"));
  assert.ok(html.includes("p_qty_listed"));
  assert.ok(html.includes("p_price_per_share_cents"));
});

test("listing-page: legge fee config da marketplace_fee_config", () => {
  assert.ok(html.includes("marketplace_fee_config"),
    "deve fetch fee config dal DB");
  assert.ok(html.includes("is_active=eq.true"),
    "deve filtrare solo fee attive");
});

test("listing-page: nessun service_role nel codice", () => {
  assert.ok(!html.match(/service[_-]?role/i));
});

test("listing-page: tutte le inserzioni di stringhe DB usano escHtml", () => {
  // Cerca pattern come ${cert.foo} o ${product.foo} dentro template strings
  const lines = html.split('\n');
  const offending = [];
  lines.forEach((line, i) => {
    if (!line.includes('${')) return;
    if (!line.includes('innerHTML') && !line.includes('return `')) return;
    // Variables that come from the DB and could contain user input
    const dangerous = line.match(/\$\{(?:cert|product)\.[a-z_]+\}/);
    if (dangerous && !line.includes('escHtml')) {
      offending.push(`L${i+1}: ${line.trim()}`);
    }
  });
  assert.equal(offending.length, 0,
    `Unescaped DB interpolation found:\n${offending.join('\n')}`);
});

// ─── Fee math purity (replicata) ──────────────────────────────────────
//
// Questa funzione è la stessa logica di renderFeeTable nella pagina.
// Qui la testiamo pura.
function computeFeeBreakdown(qty, priceCents, feeConfig) {
  const subtotal = qty * priceCents;
  const sellerFeeBps = feeConfig[0]?.seller_fee_bps ?? 0;
  const sellerFee = Math.round(subtotal * sellerFeeBps / 10000);
  const payout = subtotal - sellerFee;
  const rows = feeConfig.map(f => {
    const buyerFee = Math.round(subtotal * f.buyer_fee_bps / 10000);
    return {
      method: f.payment_method,
      buyer_pays: subtotal + buyerFee,
      premium: buyerFee,
      premium_bps: f.buyer_fee_bps,
    };
  });
  return { subtotal, sellerFeeBps, sellerFee, payout, rows };
}

const FEE_CFG_FIXTURE = [
  { payment_method: 'bank_transfer', buyer_fee_bps: 300, seller_fee_bps: 300 },
  { payment_method: 'stripe_card',   buyer_fee_bps: 450, seller_fee_bps: 300 },
  { payment_method: 'paypal',        buyer_fee_bps: 650, seller_fee_bps: 300 },
];

test("fee math: 5 quote × €10.000 = €50.000 subtotale, payout €48.500", () => {
  const r = computeFeeBreakdown(5, 1_000_000, FEE_CFG_FIXTURE);
  assert.equal(r.subtotal,   5_000_000);   // €50.000,00
  assert.equal(r.sellerFee,    150_000);   // €1.500,00 (3%)
  assert.equal(r.payout,     4_850_000);   // €48.500,00
  assert.equal(r.rows[0].buyer_pays, 5_150_000);  // bonifico: + 3%
  assert.equal(r.rows[1].buyer_pays, 5_225_000);  // carta:    + 4.5%
  assert.equal(r.rows[2].buyer_pays, 5_325_000);  // paypal:   + 6.5%
});

test("fee math: prezzo zero o qty zero produce subtotal zero", () => {
  const r1 = computeFeeBreakdown(0, 1_000_000, FEE_CFG_FIXTURE);
  assert.equal(r1.subtotal, 0);
  assert.equal(r1.payout,   0);
  assert.equal(r1.rows[0].buyer_pays, 0);

  const r2 = computeFeeBreakdown(5, 0, FEE_CFG_FIXTURE);
  assert.equal(r2.subtotal, 0);
});

test("fee math: rounding banker — 1 share × €1,01 con buyer fee 6.5%", () => {
  // 101 cents × 6.5% = 6.565, deve diventare 7 (round half up)
  const r = computeFeeBreakdown(1, 101, FEE_CFG_FIXTURE);
  assert.equal(r.subtotal, 101);
  assert.equal(r.rows[2].premium, Math.round(101 * 650 / 10000)); // = 7
});

test("fee math: i numeri interi non producono floating drift", () => {
  // Test con cifre tonde non sospette
  const r = computeFeeBreakdown(100, 12_345, FEE_CFG_FIXTURE);
  assert.equal(r.subtotal, 1_234_500);
  // Verifichiamo che ogni componente sia un intero esatto
  r.rows.forEach(row => {
    assert.equal(Number.isInteger(row.buyer_pays), true);
    assert.equal(Number.isInteger(row.premium), true);
  });
  assert.equal(Number.isInteger(r.payout), true);
  assert.equal(Number.isInteger(r.sellerFee), true);
});

test("fee math: percentuale buyer è coerente con buyer_fee_bps", () => {
  const r = computeFeeBreakdown(10, 500_000, FEE_CFG_FIXTURE);
  // Subtotal = 5.000.000 cents
  // Bonifico 300 bps → 150.000 cents
  // Card     450 bps → 225.000 cents
  // PayPal   650 bps → 325.000 cents
  assert.equal(r.rows[0].premium, 150_000);
  assert.equal(r.rows[1].premium, 225_000);
  assert.equal(r.rows[2].premium, 325_000);
});

// ─── Form validation logic ────────────────────────────────────────────
function validateListing({ qty, priceCents, owned }) {
  const errs = {};
  if (!Number.isInteger(qty) || qty < 1 || qty > owned) errs.qty = true;
  if (!Number.isFinite(priceCents) || priceCents <= 0) errs.price = true;
  return Object.keys(errs).length === 0 ? null : errs;
}

test("validation: qty < 1 invalido", () => {
  assert.deepEqual(validateListing({ qty: 0, priceCents: 100, owned: 10 }), { qty: true });
  assert.deepEqual(validateListing({ qty: -3, priceCents: 100, owned: 10 }), { qty: true });
});

test("validation: qty > owned invalido", () => {
  assert.deepEqual(validateListing({ qty: 11, priceCents: 100, owned: 10 }), { qty: true });
});

test("validation: prezzo zero o negativo invalido", () => {
  assert.deepEqual(validateListing({ qty: 1, priceCents: 0,    owned: 10 }), { price: true });
  assert.deepEqual(validateListing({ qty: 1, priceCents: -100, owned: 10 }), { price: true });
});

test("validation: input validi → null", () => {
  assert.equal(validateListing({ qty: 5, priceCents: 100_000, owned: 10 }), null);
});

test("listing-page: chiamato il file con certificate_id query param", () => {
  // La pagina deve leggere ?certificate_id= o ?cert=
  assert.ok(html.includes("certificate_id"));
  assert.ok(html.includes("URL(location.href)"));
});

test("listing-page: stato di completion redirige a marketplace con listing id", () => {
  assert.ok(html.includes("rareblock-chain-marketplace.html"),
    "success state deve linkare al marketplace");
  assert.ok(html.includes("?listing="));
});

// ─── Migration smoke (just check it exists, was tested via psql separately) ──
test("migration 029: presente nel repo", () => {
  const migPath = path.join(__dirname, "..", "..", "supabase", "migrations", "029_marketplace.sql");
  assert.ok(fs.existsSync(migPath), "migration 029_marketplace.sql deve esistere");
  const sql = fs.readFileSync(migPath, "utf8");
  assert.ok(sql.includes("marketplace_fee_config"));
  assert.ok(sql.includes("marketplace_listings"));
  assert.ok(sql.includes("marketplace_orders"));
  assert.ok(sql.includes("marketplace_create_listing"));
  assert.ok(sql.includes("marketplace_cancel_listing"));
  assert.ok(sql.includes("v_marketplace_active_listings"));
});

test("migration 029: fee config seed con i 3 metodi e i bps concordati", () => {
  const migPath = path.join(__dirname, "..", "..", "supabase", "migrations", "029_marketplace.sql");
  const sql = fs.readFileSync(migPath, "utf8");
  assert.ok(sql.includes("'bank_transfer', 300, 300"), "bonifico 3% + 3%");
  assert.ok(sql.includes("'stripe_card',   450, 300"), "carta 4.5% + 3%");
  assert.ok(sql.includes("'paypal',        650, 300"), "paypal 6.5% + 3%");
});

test("migration 029: unique partial index su listing attivi/reserved", () => {
  const migPath = path.join(__dirname, "..", "..", "supabase", "migrations", "029_marketplace.sql");
  const sql = fs.readFileSync(migPath, "utf8");
  assert.ok(sql.match(/UNIQUE INDEX[^;]*mp_listings_one_active_per_cert[^;]*active.*reserved/s),
    "unique partial index deve esistere per evitare doppi listing");
});
