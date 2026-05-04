// ═══════════════════════════════════════════════════════════════════════
//  chain/lib/settlement-orchestrator.js
//
//  Orchestratore settlement on-chain di un ordine marketplace P2P.
//
//  Flusso:
//    1. Pre-checks: ordine paid + settlement_status pending
//    2. Genera reasonHash = keccak256(orderId + ":marketplace_secondary")
//    3. Risolve buyer wallet (custodial: lookup chain_wallets per buyer_user_id)
//    4. Genera nuovo certificate_serial via DB RPC chain_next_certificate_serial()
//    5. Chiama custodialTransfer(from=sellerWallet, to=buyerWallet, tokenId, qty, reasonHash)
//       sul contratto ERC-1155
//    6. Chiama RPC marketplace_apply_settlement con tx_hash + nuovo serial
//    7. Ritorna result con tutti gli ID
//
//  IDEMPOTENT: se settlement_status è già 'transferred', no-op (RPC ritorna
//  was_idempotent=true).
//
//  ATTENTION: l'orchestrator ASSUME che il pagamento sia confermato.
//  Il match payment_status=paid + settlement_status=pending è il "lock"
//  applicativo. La RPC apply_settlement comunque ricontrolla tutto in DB.
// ═══════════════════════════════════════════════════════════════════════
"use strict";

class SettlementError extends Error {
  constructor(code, step, message, status = 500, cause = null) {
    super(message);
    this.name = "SettlementError";
    this.code = code;
    this.step = step;
    this.status = status;
    this.cause = cause;
  }
}

const ERR = Object.freeze({
  INVALID_INPUT:        { step: 1, code: "INVALID_INPUT",        status: 400 },
  ORDER_NOT_FOUND:      { step: 2, code: "ORDER_NOT_FOUND",      status: 404 },
  ORDER_NOT_PAID:       { step: 2, code: "ORDER_NOT_PAID",       status: 409 },
  ALREADY_SETTLED:      { step: 2, code: "ALREADY_SETTLED",      status: 200 },
  BUYER_WALLET_MISSING: { step: 3, code: "BUYER_WALLET_MISSING", status: 422 },
  CHAIN_TX_FAILED:      { step: 5, code: "CHAIN_TX_FAILED",      status: 502 },
  DB_APPLY_FAILED:      { step: 6, code: "DB_APPLY_FAILED",      status: 500 },
});

/**
 * @param {Object} params
 * @param {string} params.orderId
 *
 * @param {Object} deps
 * @param {Object} deps.db        { loadOrderForSettle, getOrCreateBuyerWallet, nextSerial, applySettlement }
 * @param {Object} deps.chain     { custodialTransfer, computeReasonHash }
 *
 * @returns {Promise<{success, order_id, tx_hash, block_number, seller_cert_id, buyer_cert_id, transfer_id, was_idempotent}>}
 */
async function applySettlement(params, deps) {
  const events = [];
  const log = (level, step, msg, extra = {}) => {
    events.push({ ts: new Date().toISOString(), level, step, msg, ...extra });
  };

  // ─── 1. Validate ───────────────────────────────────────────────────
  log("info", 1, "validate_input");
  if (!params || typeof params.orderId !== "string" || !params.orderId) {
    return fail(events, ERR.INVALID_INPUT, "orderId required");
  }

  // ─── 2. Load order ──────────────────────────────────────────────────
  log("info", 2, "load_order");
  let order;
  try {
    order = await deps.db.loadOrderForSettle(params.orderId);
  } catch (e) {
    return fail(events, ERR.ORDER_NOT_FOUND, String(e.message || e), e);
  }
  if (!order) {
    return fail(events, ERR.ORDER_NOT_FOUND, `order ${params.orderId} not found`);
  }

  // Already settled? Short-circuit before doing any work
  if (order.settlement_status === "transferred") {
    log("info", 2, "already_settled");
    return {
      success: true,
      order_id: order.order_id || order.id,
      tx_hash: order.settlement_tx_hash,
      block_number: null,
      was_idempotent: true,
      events,
    };
  }
  if (order.payment_status !== "paid" && order.payment_status !== "authorized") {
    return fail(events, ERR.ORDER_NOT_PAID,
      `order is not paid (payment_status=${order.payment_status})`);
  }
  if (order.settlement_status !== "pending") {
    return fail(events, ERR.ORDER_NOT_PAID,
      `order settlement is not pending (settlement_status=${order.settlement_status})`);
  }

  // ─── 3. Resolve buyer wallet ───────────────────────────────────────
  log("info", 3, "resolve_buyer_wallet");
  let buyerWallet;
  try {
    buyerWallet = await deps.db.getOrCreateBuyerWallet(order.buyer_user_id);
  } catch (e) {
    return fail(events, ERR.BUYER_WALLET_MISSING,
      `cannot resolve buyer wallet: ${e.message || e}`, e);
  }
  if (!buyerWallet || !/^0x[a-fA-F0-9]{40}$/.test(buyerWallet)) {
    return fail(events, ERR.BUYER_WALLET_MISSING,
      `invalid buyer wallet: ${buyerWallet}`);
  }
  log("info", 3, "buyer_wallet_resolved", { wallet: buyerWallet });

  // ─── 4. Generate reasonHash + new serial ───────────────────────────
  log("info", 4, "compute_reason_hash");
  const reasonHash = deps.chain.computeReasonHash(`${order.order_id || order.id}:marketplace_secondary`);

  let newSerial;
  try {
    newSerial = await deps.db.nextSerial();
  } catch (e) {
    return fail(events, ERR.DB_APPLY_FAILED, `nextSerial failed: ${e.message || e}`, e);
  }
  if (!newSerial || typeof newSerial !== "string") {
    return fail(events, ERR.DB_APPLY_FAILED, "nextSerial returned invalid value");
  }
  log("info", 4, "serial_generated", { serial: newSerial });

  // ─── 5. Execute on-chain transfer ──────────────────────────────────
  log("info", 5, "custodial_transfer");
  let txResult;
  try {
    txResult = await deps.chain.custodialTransfer({
      from: order.seller_wallet,
      to: buyerWallet,
      tokenId: order.token_id,
      qty: order.qty,
      reasonHash,
    });
  } catch (e) {
    return fail(events, ERR.CHAIN_TX_FAILED, String(e.message || e), e);
  }
  if (!txResult || !txResult.txHash) {
    return fail(events, ERR.CHAIN_TX_FAILED, "chain returned no txHash");
  }
  log("info", 5, "chain_tx_confirmed", {
    tx_hash: txResult.txHash, block: txResult.blockNumber,
  });

  // ─── 6. Apply DB settlement (atomic) ───────────────────────────────
  log("info", 6, "apply_db_settlement");
  let result;
  try {
    result = await deps.db.applySettlement({
      orderId: order.order_id || order.id,
      txHash: txResult.txHash,
      blockNumber: txResult.blockNumber,
      reasonHash,
      buyerWallet,
      newSerial,
      buyerUserId: order.buyer_user_id,
    });
  } catch (e) {
    // Critical: chain tx is already confirmed. We need a manual reconciliation.
    return fail(events, ERR.DB_APPLY_FAILED,
      `chain TX ${txResult.txHash} succeeded but DB apply failed: ${e.message || e}`, e);
  }
  log("info", 6, "db_apply_done", {
    seller_cert_id: result.seller_cert_id,
    buyer_cert_id: result.buyer_cert_id,
    transfer_id: result.transfer_id,
    was_idempotent: result.was_idempotent,
  });

  return {
    success: true,
    order_id: order.order_id || order.id,
    tx_hash: txResult.txHash,
    block_number: txResult.blockNumber,
    seller_cert_id: result.seller_cert_id,
    buyer_cert_id: result.buyer_cert_id,
    transfer_id: result.transfer_id,
    was_idempotent: !!result.was_idempotent,
    events,
  };
}

function fail(events, errSpec, message, cause) {
  events.push({
    ts: new Date().toISOString(), level: "error", step: errSpec.step,
    code: errSpec.code, msg: message,
    cause: cause ? String(cause.message || cause) : null,
  });
  return {
    success: false,
    step:    errSpec.step,
    code:    errSpec.code,
    status:  errSpec.status,
    error:   message,
    events,
  };
}

module.exports = {
  applySettlement,
  SettlementError,
  ERR,
};
