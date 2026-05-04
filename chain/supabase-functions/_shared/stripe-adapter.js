// chain/supabase-functions/_shared/stripe-adapter.js
//
// Stripe REST adapter. Zero dipendenze esterne (usa fetch + URLSearchParams),
// quindi gira sia in Node 18+ che in Deno senza npm:stripe.
//
// Endpoint usati:
//   POST /v1/payment_intents       — create
//   GET  /v1/payment_intents/:id   — retrieve
//   POST /v1/payment_intents/:id/cancel
"use strict";

const STRIPE_API = "https://api.stripe.com/v1";

class StripeError extends Error {
  constructor(code, message, statusCode = null, body = null) {
    super(message);
    this.name = "StripeError";
    this.code = code;
    this.statusCode = statusCode;
    this.body = body;
  }
}

function makeStripeAdapter({ secretKey, fetchFn = globalThis.fetch }) {
  if (!secretKey || !secretKey.startsWith("sk_")) {
    throw new StripeError("INVALID_KEY", "Stripe secret key required (sk_test_... or sk_live_...)");
  }
  if (typeof fetchFn !== "function") {
    throw new StripeError("NO_FETCH", "fetch is not available — pass cfg.fetch or use Node 18+/Deno");
  }

  // Stripe wants application/x-www-form-urlencoded with bracket notation for nested objects
  function encodeForm(obj, prefix = "") {
    const out = [];
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null) continue;
      const key = prefix ? `${prefix}[${k}]` : k;
      if (typeof v === "object" && !Array.isArray(v)) {
        out.push(encodeForm(v, key));
      } else if (Array.isArray(v)) {
        v.forEach((item, idx) => {
          out.push(`${encodeURIComponent(`${key}[${idx}]`)}=${encodeURIComponent(item)}`);
        });
      } else {
        out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
      }
    }
    return out.join("&");
  }

  async function request(method, path, body) {
    const url = `${STRIPE_API}${path}`;
    const opts = {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
      },
    };
    if (body) {
      opts.headers["Content-Type"] = "application/x-www-form-urlencoded";
      opts.body = encodeForm(body);
    }
    const res = await fetchFn(url, opts);
    const text = await res.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (!res.ok) {
      throw new StripeError(
        parsed?.error?.code || "HTTP_ERROR",
        parsed?.error?.message || `Stripe ${method} ${path} failed with ${res.status}`,
        res.status,
        parsed
      );
    }
    return parsed;
  }

  return {
    /**
     * Create a PaymentIntent.
     * @param {Object} args
     * @param {number} args.amount        in cents
     * @param {string} args.currency      'eur'
     * @param {Object} [args.metadata]    arbitrary key/values
     * @param {string} [args.receipt_email]
     * @param {string} [args.statement_descriptor_suffix]
     */
    async createPaymentIntent(args) {
      if (!args.amount || !args.currency) {
        throw new StripeError("INVALID_INPUT", "amount and currency required");
      }
      const body = {
        amount: args.amount,
        currency: args.currency,
        // PSD2 / SCA — automatic confirmation flow with the PaymentElement
        automatic_payment_methods: { enabled: true },
        capture_method: "automatic",
      };
      if (args.metadata)         body.metadata = args.metadata;
      if (args.receipt_email)    body.receipt_email = args.receipt_email;
      if (args.statement_descriptor_suffix) {
        body.statement_descriptor_suffix = args.statement_descriptor_suffix.slice(0, 22);
      }
      return await request("POST", "/payment_intents", body);
    },

    async retrievePaymentIntent(id) {
      return await request("GET", `/payment_intents/${id}`);
    },

    async cancelPaymentIntent(id) {
      return await request("POST", `/payment_intents/${id}/cancel`, {});
    },
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { makeStripeAdapter, StripeError };
}
