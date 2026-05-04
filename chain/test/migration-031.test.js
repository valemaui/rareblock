// chain/test/migration-031.test.js
//
// Smoke tests della migration 031 + edge function chain-transfer-secondary.
// I test funzionali della migration sono già stati eseguiti su Postgres
// reale (vedi commit message). Qui verifichiamo che i file siano nel repo,
// che la migration contenga gli oggetti attesi, e che l'edge function
// importi correttamente le sue dipendenze.

"use strict";

const test       = require("node:test");
const assert     = require("node:assert/strict");
const fs         = require("fs");
const path       = require("path");

const MIG_PATH = path.join(__dirname, "..", "..", "supabase", "migrations",
                           "031_marketplace_settlement.sql");
const EDGE_FN  = path.join(__dirname, "..", "supabase-functions",
                           "chain-transfer-secondary", "index.ts");
const ORCH     = path.join(__dirname, "..", "lib", "settlement-orchestrator.js");

// ─── Migration presence + structure ──────────────────────────────────
test("migration 031: file presente nel repo", () => {
  assert.ok(fs.existsSync(MIG_PATH), "migration 031 deve esistere");
});

test("migration 031: definisce marketplace_apply_settlement RPC", () => {
  const sql = fs.readFileSync(MIG_PATH, "utf8");
  assert.ok(sql.includes("CREATE OR REPLACE FUNCTION public.marketplace_apply_settlement"));
  // RETURNS TABLE con i campi attesi
  for (const f of ["order_id","seller_cert_id","buyer_cert_id","transfer_id","was_idempotent"]) {
    assert.ok(sql.includes(f), `RETURNS TABLE deve includere ${f}`);
  }
});

test("migration 031: SECURITY DEFINER + service_role grant", () => {
  const sql = fs.readFileSync(MIG_PATH, "utf8");
  assert.ok(sql.includes("SECURITY DEFINER"));
  assert.ok(sql.includes("GRANT EXECUTE ON FUNCTION public.marketplace_apply_settlement TO service_role"));
});

test("migration 031: idempotency check basato su settlement_status='transferred'", () => {
  const sql = fs.readFileSync(MIG_PATH, "utf8");
  assert.ok(sql.match(/settlement_status\s*=\s*'transferred'/));
  assert.ok(sql.includes("was_idempotent"));
});

test("migration 031: split logic — full vs partial qty", () => {
  const sql = fs.readFileSync(MIG_PATH, "utf8");
  // Quando qty_minted == order.qty → status 'transferred', qty=0
  assert.ok(sql.match(/qty_minted\s*=\s*v_order\.qty/));
  assert.ok(sql.match(/status\s*=\s*'transferred'/));
  // Partial: subtract order.qty
  assert.ok(sql.match(/qty_minted\s*=\s*qty_minted\s*-\s*v_order\.qty/));
});

test("migration 031: validazioni regex su tx_hash e buyer_wallet", () => {
  const sql = fs.readFileSync(MIG_PATH, "utf8");
  assert.ok(sql.includes("^0x[a-fA-F0-9]{64}$"), "tx_hash regex");
  assert.ok(sql.includes("^0x[a-fA-F0-9]{40}$"), "wallet regex");
});

test("migration 031: marketplace_mark_payment_paid RPC presente", () => {
  const sql = fs.readFileSync(MIG_PATH, "utf8");
  assert.ok(sql.includes("CREATE OR REPLACE FUNCTION public.marketplace_mark_payment_paid"));
  assert.ok(sql.includes("payment_status = 'paid'"));
  assert.ok(sql.includes("RETURN v_order"), "deve essere idempotente (no-op se già paid)");
});

test("migration 031: view v_marketplace_orders_to_settle filtra paid+pending", () => {
  const sql = fs.readFileSync(MIG_PATH, "utf8");
  assert.ok(sql.includes("CREATE OR REPLACE VIEW public.v_marketplace_orders_to_settle"));
  assert.ok(sql.match(/payment_status\s*=\s*'paid'/));
  assert.ok(sql.match(/settlement_status\s*=\s*'pending'/));
});

test("migration 031: nuove colonne audit (parent_certificate_id, marketplace_order_id)", () => {
  const sql = fs.readFileSync(MIG_PATH, "utf8");
  assert.ok(sql.includes("parent_certificate_id"));
  assert.ok(sql.includes("marketplace_order_id"));
  // Additive guard: usa IF NOT EXISTS per essere idempotente in re-apply
  assert.ok(sql.match(/IF NOT EXISTS[\s\S]*parent_certificate_id/));
  assert.ok(sql.match(/IF NOT EXISTS[\s\S]*marketplace_order_id/));
});

test("migration 031: aggiorna listing→sold + order→transferred + settlement_tx_hash", () => {
  const sql = fs.readFileSync(MIG_PATH, "utf8");
  assert.ok(sql.match(/UPDATE marketplace_listings[\s\S]*status\s*=\s*'sold'/));
  assert.ok(sql.match(/settlement_status\s*=\s*'transferred'/));
  assert.ok(sql.match(/settlement_tx_hash\s*=\s*p_tx_hash/));
});

// ─── Edge function ───────────────────────────────────────────────────
test("edge fn: chain-transfer-secondary file presente", () => {
  assert.ok(fs.existsSync(EDGE_FN));
});

test("edge fn: importa correttamente settlement-orchestrator", () => {
  const src = fs.readFileSync(EDGE_FN, "utf8");
  assert.ok(src.includes('from "../../lib/settlement-orchestrator.js"'));
  assert.ok(src.includes("applySettlement"));
});

test("edge fn: import deriveWallet (non un nome inesistente)", () => {
  const src = fs.readFileSync(EDGE_FN, "utf8");
  // Bug fix verifying the import is the existing one in wallet.js
  assert.ok(src.includes('import { deriveWallet }'));
  assert.ok(!src.includes("deriveWalletForUser"), "deriveWalletForUser non esiste in wallet.js");
});

test("edge fn: auth bicodale — service_role bypass + admin role check", () => {
  const src = fs.readFileSync(EDGE_FN, "utf8");
  assert.ok(src.includes("isServiceRole"), "deve riconoscere service-role");
  assert.ok(src.match(/role\s*!==?\s*['"]admin['"]/), "deve verificare admin role per non-service");
});

test("edge fn: chiama RPC marketplace_apply_settlement con tutti i parametri", () => {
  const src = fs.readFileSync(EDGE_FN, "utf8");
  for (const p of ["p_order_id","p_tx_hash","p_block_number","p_reason_hash",
                    "p_buyer_wallet","p_new_serial","p_buyer_user_id"]) {
    assert.ok(src.includes(p), `manca parametro RPC ${p}`);
  }
});

test("edge fn: usa keccak256 per reasonHash (deterministico)", () => {
  const src = fs.readFileSync(EDGE_FN, "utf8");
  assert.ok(src.includes("ethers.keccak256"));
});

test("orchestrator: reasonHash include marker 'marketplace_secondary'", () => {
  const src = fs.readFileSync(ORCH, "utf8");
  assert.ok(src.includes("marketplace_secondary"),
    "reasonHash payload deve includere il marker che identifica il tipo di transfer");
});

test("edge fn: niente Stripe/PayPal secrets riferiti (settlement è chain-only)", () => {
  const src = fs.readFileSync(EDGE_FN, "utf8");
  // Settlement non deve sapere nulla dei provider di pagamento
  assert.ok(!src.includes("STRIPE_SECRET_KEY"));
  assert.ok(!src.includes("PAYPAL_SECRET"));
});

// ─── Orchestrator structural ─────────────────────────────────────────
test("orchestrator: file presente + export applySettlement", () => {
  assert.ok(fs.existsSync(ORCH));
  const src = fs.readFileSync(ORCH, "utf8");
  assert.ok(src.includes("module.exports"));
  assert.ok(src.includes("applySettlement"));
});

test("orchestrator: short-circuit on already-transferred (no chain call)", () => {
  const src = fs.readFileSync(ORCH, "utf8");
  // Cerca il pattern: if (order.settlement_status === "transferred") return ...
  assert.ok(src.match(/settlement_status\s*===?\s*['"]transferred['"]/));
});

test("orchestrator: error code DB_APPLY_FAILED include tx_hash nel messaggio", () => {
  const src = fs.readFileSync(ORCH, "utf8");
  // Il messaggio deve menzionare il tx_hash quando l'apply DB fallisce dopo chain TX,
  // così admin può riconciliare manualmente
  assert.ok(src.match(/chain TX[^"`]*\$\{[^}]*txHash[^}]*\}/));
});
