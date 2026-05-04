// chain/supabase-functions/_shared/paypal-adapter.js
//
// PayPal Orders v2 REST adapter. Zero dipendenze esterne.
//
// Auth flow:
//   1. POST /v1/oauth2/token (Basic auth client_id:secret) → access_token
//   2. POST /v2/checkout/orders (Bearer access_token) → order id + approve_url
//
// Sandbox URL: https://api-m.sandbox.paypal.com
// Live URL:    https://api-m.paypal.com
"use strict";

class PayPalError extends Error {
  constructor(code, message, statusCode = null, body = null) {
    super(message);
    this.name = "PayPalError";
    this.code = code;
    this.statusCode = statusCode;
    this.body = body;
  }
}

function makePayPalAdapter({ clientId, secret, env = "sandbox", fetchFn = globalThis.fetch }) {
  if (!clientId || !secret) {
    throw new PayPalError("INVALID_CREDS", "PayPal clientId and secret required");
  }
  if (env !== "sandbox" && env !== "live") {
    throw new PayPalError("INVALID_ENV", "env must be 'sandbox' or 'live'");
  }
  const apiBase = env === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
  const checkoutBase = env === "live"
    ? "https://www.paypal.com"
    : "https://www.sandbox.paypal.com";

  let _token = null;
  let _tokenExp = 0;

  async function getAccessToken() {
    const now = Date.now();
    if (_token && _tokenExp - 30_000 > now) return _token;

    const auth = Buffer.from(`${clientId}:${secret}`).toString("base64");
    const res = await fetchFn(`${apiBase}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
    });
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
    if (!res.ok) {
      throw new PayPalError("AUTH_FAILED",
        parsed?.error_description || `PayPal auth ${res.status}`, res.status, parsed);
    }
    _token = parsed.access_token;
    _tokenExp = now + (parsed.expires_in * 1000);
    return _token;
  }

  async function request(method, path, body) {
    const token = await getAccessToken();
    const res = await fetchFn(`${apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "PayPal-Request-Id": cryptoRandomId(),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (!res.ok) {
      throw new PayPalError(parsed?.name || "HTTP_ERROR",
        parsed?.message || `PayPal ${method} ${path} failed ${res.status}`,
        res.status, parsed);
    }
    return parsed;
  }

  function cryptoRandomId() {
    // Node 18+ has crypto.randomUUID; Deno does too
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  return {
    /**
     * Create an Orders v2 order with a single purchase unit.
     * @param {Object} args
     * @param {number} args.amount_cents
     * @param {string} args.currency       'EUR'
     * @param {string} args.order_id       our internal marketplace_orders.id
     * @param {string} args.return_url     where PayPal sends the buyer after approval
     * @param {string} args.cancel_url
     */
    async createOrder(args) {
      const amount = (args.amount_cents / 100).toFixed(2);
      const body = {
        intent: "CAPTURE",
        purchase_units: [{
          custom_id: args.order_id,
          amount: { currency_code: args.currency, value: amount },
          description: `RareBlock Marketplace order ${args.order_id}`,
        }],
        application_context: {
          brand_name:  "RareBlock",
          locale:      "it-IT",
          landing_page:"NO_PREFERENCE",
          shipping_preference: "NO_SHIPPING",
          user_action: "PAY_NOW",
          return_url:  args.return_url,
          cancel_url:  args.cancel_url,
        },
      };
      const res = await request("POST", "/v2/checkout/orders", body);
      const approveLink = (res.links || []).find(l => l.rel === "approve" || l.rel === "payer-action");
      const approveUrl = approveLink?.href
        || `${checkoutBase}/checkoutnow?token=${res.id}`;
      return { id: res.id, approve_url: approveUrl, raw: res };
    },

    async captureOrder(orderId) {
      return await request("POST", `/v2/checkout/orders/${orderId}/capture`);
    },

    async getOrder(orderId) {
      return await request("GET", `/v2/checkout/orders/${orderId}`);
    },
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { makePayPalAdapter, PayPalError };
}
