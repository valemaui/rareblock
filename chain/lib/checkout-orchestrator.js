// ═══════════════════════════════════════════════════════════════════════
//  chain/lib/checkout-orchestrator.js
//
//  Orchestratore del checkout marketplace. Pure logic, runtime-agnostic.
//
//  Flusso:
//    1. Validate input { listing_id, qty, payment_method }
//    2. Auth: caller must be a logged-in user (not seller of this listing)
//    3. Atomic: chiama RPC marketplace_create_order che crea l'order +
//       flippa il listing a 'reserved' nello stesso transaction
//    4. A seconda del payment_method:
//       - bank_transfer: genera causale unica + ritorna istruzioni IBAN
//       - stripe_card:   crea Stripe PaymentIntent + ritorna client_secret
//       - paypal:        crea PayPal order + ritorna approve_url
//    5. Salva il payment_provider_id nell'order
//    6. Ritorna al frontend tutto ciò che serve per il next-step di pagamento
// ═══════════════════════════════════════════════════════════════════════
"use strict";

class CheckoutError extends Error {
  constructor(code, step, message, status = 500, cause = null) {
    super(message);
    this.name = "CheckoutError";
    this.code = code;
    this.step = step;
    this.status = status;
    this.cause = cause;
  }
}

const ERR = Object.freeze({
  INVALID_INPUT:       { step: 1, code: "INVALID_INPUT",       status: 400 },
  UNAUTHORIZED:        { step: 1, code: "UNAUTHORIZED",        status: 401 },
  ORDER_RPC_FAILED:    { step: 3, code: "ORDER_RPC_FAILED",    status: 500 },
  LISTING_NOT_ACTIVE:  { step: 3, code: "LISTING_NOT_ACTIVE",  status: 409 },
  LISTING_NOT_FOUND:   { step: 3, code: "LISTING_NOT_FOUND",   status: 404 },
  CANNOT_BUY_OWN:      { step: 3, code: "CANNOT_BUY_OWN",      status: 403 },
  STRIPE_FAILED:       { step: 4, code: "STRIPE_FAILED",       status: 502 },
  PAYPAL_FAILED:       { step: 4, code: "PAYPAL_FAILED",       status: 502 },
  PROVIDER_UPDATE_FAIL:{ step: 5, code: "PROVIDER_UPDATE_FAIL",status: 500 },
});

// ─── Generate human-friendly bank transfer reference (causale) ────────
//
// Format: RB-MP-NNNNNN-XXXX (deterministico ma con suffisso casuale)
// La causale è ciò che il buyer scriverà nel bonifico, e che useremo per
// matchare manualmente l'ordine in arrivo.
function generateBankReference(orderId) {
  // Take 6 hex chars from the order_id (UUID) for stability + 4 random
  const hex = orderId.replace(/-/g, '').slice(0, 6).toUpperCase();
  const rand = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `RB-MP-${hex}-${rand}`;
}

/**
 * @param {Object} params
 * @param {string} params.listingId
 * @param {number} params.qty
 * @param {'bank_transfer'|'stripe_card'|'paypal'} params.paymentMethod
 * @param {string} params.buyerUserId   from authenticated JWT
 * @param {string} params.buyerEmail    for receipts
 * @param {string} [params.locale]      for Stripe receipt language
 *
 * @param {Object} deps
 * @param {Object} deps.db              { createOrder, updateOrderProviderId, loadOrder }
 * @param {Object} deps.stripe          { createPaymentIntent }
 * @param {Object} deps.paypal          { createOrder }
 * @param {Object} deps.config          { bankIban, bankAccountHolder, bankBic, baseUrl }
 *
 * @returns {Promise<CheckoutResult>}
 */
async function createCheckoutSession(params, deps) {
  const events = [];
  const log = (level, step, msg, extra = {}) => {
    events.push({ ts: new Date().toISOString(), level, step, msg, ...extra });
  };

  // ─── 1. Validate input ─────────────────────────────────────────────
  log("info", 1, "validate_input");
  if (!params || typeof params.listingId !== "string" || !params.listingId) {
    return fail(events, ERR.INVALID_INPUT, "listingId is required");
  }
  if (typeof params.qty !== "number" || !Number.isInteger(params.qty) || params.qty <= 0) {
    return fail(events, ERR.INVALID_INPUT, "qty must be a positive integer");
  }
  if (!["bank_transfer","stripe_card","paypal"].includes(params.paymentMethod)) {
    return fail(events, ERR.INVALID_INPUT, "invalid payment_method");
  }
  if (typeof params.buyerUserId !== "string" || !params.buyerUserId) {
    return fail(events, ERR.UNAUTHORIZED, "buyerUserId required (auth)");
  }

  // ─── 2/3. Atomic order creation (RPC) ──────────────────────────────
  log("info", 3, "create_order_rpc");
  let order;
  try {
    order = await deps.db.createOrder({
      listingId:     params.listingId,
      qty:           params.qty,
      paymentMethod: params.paymentMethod,
    });
  } catch (e) {
    // Map Postgres error codes to user-meaningful errors
    const msg = String(e.message || e);
    if (/listing not found/i.test(msg)) return fail(events, ERR.LISTING_NOT_FOUND, msg);
    if (/listing is not active/i.test(msg) || /listing has expired/i.test(msg)) {
      return fail(events, ERR.LISTING_NOT_ACTIVE, msg);
    }
    if (/cannot buy your own/i.test(msg)) return fail(events, ERR.CANNOT_BUY_OWN, msg);
    if (/qty exceeds listing/i.test(msg) || /qty must be/i.test(msg)) {
      return fail(events, ERR.INVALID_INPUT, msg);
    }
    return fail(events, ERR.ORDER_RPC_FAILED, msg, e);
  }
  log("info", 3, "order_created", { order_id: order.id, total_cents: order.total_cents });

  // ─── 4. Initialize payment provider ────────────────────────────────
  let paymentData;
  try {
    if (params.paymentMethod === "bank_transfer") {
      const reference = generateBankReference(order.id);
      paymentData = {
        kind:       "bank_transfer",
        reference,
        iban:       deps.config.bankIban,
        account_holder: deps.config.bankAccountHolder,
        bic:        deps.config.bankBic,
        amount_cents: order.total_cents,
        instructions: [
          `Transfer the exact amount of €${(order.total_cents/100).toLocaleString('it-IT', {minimumFractionDigits:2})} to:`,
          `IBAN: ${deps.config.bankIban}`,
          `Beneficiary: ${deps.config.bankAccountHolder}`,
          deps.config.bankBic ? `BIC/SWIFT: ${deps.config.bankBic}` : null,
          `Reference / causale: ${reference}`,
          ``,
          `Once received (1–3 business days), your shares will be transferred and the certificate updated.`,
        ].filter(Boolean).join('\n'),
      };
      log("info", 4, "bank_transfer_ref_generated", { reference });
    }
    else if (params.paymentMethod === "stripe_card") {
      const intent = await deps.stripe.createPaymentIntent({
        amount:      order.total_cents,
        currency:    "eur",
        metadata: {
          marketplace_order_id: order.id,
          listing_id:           order.listing_id,
          buyer_user_id:        params.buyerUserId,
        },
        receipt_email: params.buyerEmail,
        statement_descriptor_suffix: "RAREBLOCK",
      });
      if (!intent || !intent.client_secret) {
        return fail(events, ERR.STRIPE_FAILED, "Stripe did not return client_secret");
      }
      paymentData = {
        kind:           "stripe_card",
        client_secret:  intent.client_secret,
        publishable_key: deps.config.stripePublishableKey,
        payment_intent_id: intent.id,
        amount_cents:   order.total_cents,
        return_url:     `${deps.config.baseUrl}/chain/marketplace/order?id=${order.id}`,
      };
      // Save provider id back to the order
      await deps.db.updateOrderProviderId(order.id, intent.id);
      log("info", 4, "stripe_intent_created", { pi_id: intent.id });
    }
    else if (params.paymentMethod === "paypal") {
      const ppOrder = await deps.paypal.createOrder({
        amount_cents: order.total_cents,
        currency:     "EUR",
        order_id:     order.id,
        return_url:   `${deps.config.baseUrl}/chain/marketplace/order?id=${order.id}&pp=ok`,
        cancel_url:   `${deps.config.baseUrl}/chain/marketplace/order?id=${order.id}&pp=cancel`,
      });
      if (!ppOrder || !ppOrder.id || !ppOrder.approve_url) {
        return fail(events, ERR.PAYPAL_FAILED, "PayPal did not return order id / approve_url");
      }
      paymentData = {
        kind:        "paypal",
        approve_url: ppOrder.approve_url,
        order_id:    ppOrder.id,
        amount_cents: order.total_cents,
      };
      await deps.db.updateOrderProviderId(order.id, ppOrder.id);
      log("info", 4, "paypal_order_created", { pp_id: ppOrder.id });
    }
  } catch (e) {
    // Provider failed — order resta 'pending', expire job lo riallinea
    const errSpec = params.paymentMethod === "stripe_card" ? ERR.STRIPE_FAILED : ERR.PAYPAL_FAILED;
    return fail(events, errSpec, String(e.message || e), e);
  }

  // ─── 5. Done ───────────────────────────────────────────────────────
  log("info", 5, "done");
  return {
    success: true,
    order: {
      id:                  order.id,
      listing_id:          order.listing_id,
      qty:                 order.qty,
      subtotal_cents:      order.subtotal_cents,
      buyer_fee_cents:     order.buyer_fee_cents,
      total_cents:         order.total_cents,
      payment_method:      order.payment_method,
      payment_status:      order.payment_status,
      expires_at:          order.expires_at,
    },
    payment: paymentData,
    events,
  };
}

function fail(events, errSpec, message, cause) {
  events.push({
    ts: new Date().toISOString(), level: "error", step: errSpec.step,
    code: errSpec.code, msg: message, cause: cause ? String(cause.message || cause) : null,
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
  createCheckoutSession,
  generateBankReference,
  CheckoutError,
  ERR,
};
