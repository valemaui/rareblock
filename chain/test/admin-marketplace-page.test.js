// chain/test/admin-marketplace-page.test.js
//
// Test della pagina admin marketplace + Edge Functions webhook/capture.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const HTML_PATH    = path.join(__dirname, "..", "rareblock-chain-admin-marketplace.html");
const STRIPE_HOOK  = path.join(__dirname, "..", "supabase-functions", "chain-stripe-webhook", "index.ts");
const PAYPAL_CAP   = path.join(__dirname, "..", "supabase-functions", "chain-paypal-capture", "index.ts");
const MIG_032      = path.join(__dirname, "..", "..", "supabase", "migrations", "032_marketplace_admin.sql");

// ─── HTML PAGE ─────────────────────────────────────────────────────
test("admin-page: file presente e single-file", () => {
  assert.ok(fs.existsSync(HTML_PATH));
  const html = fs.readFileSync(HTML_PATH, "utf8");
  const externalScripts = html.match(/<script\s+[^>]*src=/gi) || [];
  assert.equal(externalScripts.length, 0);
});

test("admin-page: link esterni solo Google Fonts", () => {
  const html = fs.readFileSync(HTML_PATH, "utf8");
  const linkHrefs = (html.match(/<link[^>]+href="([^"]+)"/g) || [])
    .map(l => l.match(/href="([^"]+)"/)[1]);
  for (const href of linkHrefs) {
    const ok = href.startsWith("https://fonts.googleapis.com")
            || href.startsWith("https://fonts.gstatic.com");
    assert.ok(ok, `non whitelisted: ${href}`);
  }
});

test("admin-page: nessun service_role key hardcoded", () => {
  const html = fs.readFileSync(HTML_PATH, "utf8");
  assert.ok(!html.match(/service[_-]?role/i));
});

test("admin-page: usa session key condivisa rb_auth_session", () => {
  const html = fs.readFileSync(HTML_PATH, "utf8");
  assert.ok(html.includes("'rb_auth_session'"));
});

test("admin-page: 3 sezioni — bank / settle / fees", () => {
  const html = fs.readFileSync(HTML_PATH, "utf8");
  for (const sec of ["sec-bank", "sec-settle", "sec-fees"]) {
    assert.ok(html.includes(`id="${sec}"`), `manca section ${sec}`);
  }
  for (const tab of ['data-tab="bank"', 'data-tab="settle"', 'data-tab="fees"']) {
    assert.ok(html.includes(tab));
  }
});

test("admin-page: chiama RPC admin (non insert/update diretti)", () => {
  const html = fs.readFileSync(HTML_PATH, "utf8");
  for (const rpc of ["marketplace_admin_mark_paid_bank",
                      "marketplace_admin_cancel_order",
                      "marketplace_admin_update_fee_config"]) {
    assert.ok(html.includes(rpc), `manca chiamata a ${rpc}`);
  }
});

test("admin-page: triggers chain-transfer-secondary dopo mark_paid", () => {
  const html = fs.readFileSync(HTML_PATH, "utf8");
  assert.ok(html.includes("chain-transfer-secondary"));
});

test("admin-page: legge dalle view admin", () => {
  const html = fs.readFileSync(HTML_PATH, "utf8");
  assert.ok(html.includes("v_marketplace_pending_bank_transfers"));
  assert.ok(html.includes("v_marketplace_admin_to_settle"));
});

test("admin-page: gate auth + role check", () => {
  const html = fs.readFileSync(HTML_PATH, "utf8");
  assert.ok(html.includes("state-forbidden"));
  assert.ok(html.match(/role\s*!==?\s*['"]admin['"]/));
});

test("admin-page: confirmation modal per azioni distruttive", () => {
  const html = fs.readFileSync(HTML_PATH, "utf8");
  assert.ok(html.includes("openModal"));
  assert.ok(html.includes("promptCancel"));
  assert.ok(html.includes("promptMarkPaid"));
});

test("admin-page: XSS-safe (escHtml usato per dati DB)", () => {
  const html = fs.readFileSync(HTML_PATH, "utf8");
  // I template literal con dati DB devono usare escHtml
  const lines = html.split("\n");
  const bad = [];
  lines.forEach((line, i) => {
    if (!line.includes("${")) return;
    if (!line.includes("innerHTML") && !line.includes("return `") && !line.includes(".map(")) return;
    const m = line.match(/\$\{(?:o|f|p)\.[a-z_]+\}/);
    if (m && !line.includes("escHtml") && !line.includes("fmtEUR") && !line.includes("fmtDate")
            && !line.includes("Math.") && !line.includes("toFixed")) {
      bad.push(`L${i+1}: ${line.trim()}`);
    }
  });
  assert.equal(bad.length, 0, `Unescaped DB interpolation:\n${bad.join('\n')}`);
});

test("admin-page: validation client-side fee bps range [0,5000]", () => {
  const html = fs.readFileSync(HTML_PATH, "utf8");
  assert.ok(html.includes("> 5000"), "validazione max bps");
  assert.ok(html.includes("max=\"5000\""), "input attribute max");
});

// ─── STRIPE WEBHOOK ─────────────────────────────────────────────────
test("stripe-webhook fn: file presente", () => {
  assert.ok(fs.existsSync(STRIPE_HOOK));
});

test("stripe-webhook fn: usa constructEvent per verifica firma", () => {
  const src = fs.readFileSync(STRIPE_HOOK, "utf8");
  assert.ok(src.includes("constructEvent"));
  assert.ok(src.includes("STRIPE_WEBHOOK_SECRET"));
});

test("stripe-webhook fn: gestisce payment_intent.succeeded", () => {
  const src = fs.readFileSync(STRIPE_HOOK, "utf8");
  assert.ok(src.includes('"payment_intent.succeeded"'));
  assert.ok(src.includes("marketplace_mark_payment_paid"));
});

test("stripe-webhook fn: triggera chain-transfer-secondary internamente", () => {
  const src = fs.readFileSync(STRIPE_HOOK, "utf8");
  assert.ok(src.includes("chain-transfer-secondary"));
  // E si autentica con SERVICE_ROLE_KEY (non JWT del buyer)
  assert.ok(src.match(/Bearer.*SERVICE_ROLE_KEY/));
});

test("stripe-webhook fn: ritorna 200 anche su errori interni (no retry loop)", () => {
  const src = fs.readFileSync(STRIPE_HOOK, "utf8");
  // Deve esserci almeno un 200 nel try/catch top-level
  assert.ok(src.match(/catch\s*\([^)]*\)\s*\{[\s\S]*json\(200/));
});

test("stripe-webhook fn: ritorna 400 solo su firma invalida", () => {
  const src = fs.readFileSync(STRIPE_HOOK, "utf8");
  // 400 must follow signature failure
  assert.ok(src.match(/signature[\s\S]{0,200}400/));
});

test("stripe-webhook fn: legge metadata.marketplace_order_id", () => {
  const src = fs.readFileSync(STRIPE_HOOK, "utf8");
  assert.ok(src.includes("marketplace_order_id"));
  assert.ok(src.includes("metadata"));
});

// ─── PAYPAL CAPTURE ─────────────────────────────────────────────────
test("paypal-capture fn: file presente", () => {
  assert.ok(fs.existsSync(PAYPAL_CAP));
});

test("paypal-capture fn: auth via JWT buyer + verifica buyer_user_id", () => {
  const src = fs.readFileSync(PAYPAL_CAP, "utf8");
  assert.ok(src.includes("auth.getUser"));
  assert.ok(src.match(/buyer_user_id\s*!==?\s*buyer\.id/));
});

test("paypal-capture fn: idempotency su already-paid", () => {
  const src = fs.readFileSync(PAYPAL_CAP, "utf8");
  assert.ok(src.includes("already_paid"));
  assert.ok(src.match(/payment_status\s*===?\s*['"]paid['"]/));
});

test("paypal-capture fn: refuse non-paypal orders", () => {
  const src = fs.readFileSync(PAYPAL_CAP, "utf8");
  assert.ok(src.match(/payment_method\s*!==?\s*['"]paypal['"]/));
});

test("paypal-capture fn: chiama paypal.captureOrder + verifica COMPLETED", () => {
  const src = fs.readFileSync(PAYPAL_CAP, "utf8");
  assert.ok(src.includes("captureOrder"));
  assert.ok(src.includes("COMPLETED"));
});

test("paypal-capture fn: triggera chain-transfer-secondary", () => {
  const src = fs.readFileSync(PAYPAL_CAP, "utf8");
  assert.ok(src.includes("chain-transfer-secondary"));
});

// ─── MIGRATION 032 ─────────────────────────────────────────────────
test("migration 032: 3 RPC admin presenti", () => {
  const sql = fs.readFileSync(MIG_032, "utf8");
  for (const rpc of ["marketplace_admin_mark_paid_bank",
                      "marketplace_admin_cancel_order",
                      "marketplace_admin_update_fee_config"]) {
    assert.ok(sql.includes(`CREATE OR REPLACE FUNCTION public.${rpc}`),
      `manca RPC ${rpc}`);
  }
});

test("migration 032: tutte le RPC admin verificano role='admin'", () => {
  const sql = fs.readFileSync(MIG_032, "utf8");
  // Ogni admin RPC deve avere il check
  const rpcBlocks = sql.split("CREATE OR REPLACE FUNCTION public.marketplace_admin_");
  // Skip the first split (before any admin RPC)
  for (let i = 1; i < rpcBlocks.length; i++) {
    assert.ok(rpcBlocks[i].includes("v_role <> 'admin'") ||
              rpcBlocks[i].includes("admin role required"),
              `RPC #${i} non verifica role admin`);
  }
});

test("migration 032: 2 view admin presenti", () => {
  const sql = fs.readFileSync(MIG_032, "utf8");
  assert.ok(sql.includes("v_marketplace_pending_bank_transfers"));
  assert.ok(sql.includes("v_marketplace_admin_to_settle"));
});

test("migration 032: view admin con security_invoker (rispetta RLS chiamante)", () => {
  const sql = fs.readFileSync(MIG_032, "utf8");
  assert.ok(sql.includes("security_invoker"));
});

test("migration 032: bps range validation [0, 5000] in update_fee", () => {
  const sql = fs.readFileSync(MIG_032, "utf8");
  assert.ok(sql.match(/buyer_fee_bps.*<\s*0\s*OR.*buyer_fee_bps\s*>\s*5000/s) ||
            sql.match(/p_buyer_fee_bps\s*>\s*5000/));
});

test("migration 032: cancel_order rifiuta su paid (no refund silenzioso)", () => {
  const sql = fs.readFileSync(MIG_032, "utf8");
  assert.ok(sql.match(/cannot cancel a paid order/));
});

test("migration 032: mark_paid_bank è bank_transfer-only", () => {
  const sql = fs.readFileSync(MIG_032, "utf8");
  assert.ok(sql.match(/payment_method\s*<>\s*'bank_transfer'/));
});
