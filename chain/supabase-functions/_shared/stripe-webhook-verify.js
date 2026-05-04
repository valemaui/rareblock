// chain/supabase-functions/_shared/stripe-webhook-verify.js
//
// Stripe webhook signature verification (HMAC-SHA256).
//
// Stripe firma il payload e mette la firma nell'header 'stripe-signature':
//   "t=1492774577,v1=5257a869e7..."
//
// Per verificare:
//   1. Estrai timestamp 't' e signature 'v1' dall'header
//   2. signed_payload = t + '.' + raw_body
//   3. expected = HMAC-SHA256(signed_payload, signing_secret)
//   4. compare expected con v1 (timing-safe)
//   5. verifica che t non sia troppo vecchio (default 5 min) per prevenire replay
//
// Funziona in Deno e Node 18+ (entrambi hanno Web Crypto via crypto.subtle).
"use strict";

const DEFAULT_TOLERANCE_SECONDS = 300; // 5 minutes

class StripeWebhookError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StripeWebhookError";
    this.code = code;
  }
}

function parseStripeSignatureHeader(header) {
  if (!header || typeof header !== "string") {
    throw new StripeWebhookError("MISSING_HEADER", "Stripe-Signature header missing");
  }
  const parts = header.split(",").map(p => p.trim());
  let timestamp = null;
  const signatures = [];
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    const k = p.slice(0, eq);
    const v = p.slice(eq + 1);
    if (k === "t")  timestamp = v;
    if (k === "v1") signatures.push(v);
  }
  if (!timestamp) throw new StripeWebhookError("INVALID_HEADER", "no timestamp 't' in signature");
  if (signatures.length === 0) throw new StripeWebhookError("INVALID_HEADER", "no v1 signature");
  return { timestamp, signatures };
}

async function hmacSha256Hex(secret, payload) {
  // Web Crypto: importa la chiave HMAC, calcola firma, esporta hex
  const enc = new TextEncoder();
  const keyData = enc.encode(secret);
  const dataBytes = enc.encode(payload);
  const key = await crypto.subtle.importKey(
    "raw", keyData,
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, dataBytes);
  // To hex
  const bytes = new Uint8Array(sig);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Verify and parse a Stripe webhook event.
 *
 * @param {string} rawBody         The raw request body as a string
 * @param {string} signatureHeader The 'stripe-signature' request header
 * @param {string} signingSecret   The whsec_... value from Stripe dashboard
 * @param {number} [toleranceSec]  Max age of the timestamp (default 300s)
 * @returns {Promise<Object>}      The parsed event JSON
 * @throws {StripeWebhookError}    If signature is invalid or timestamp too old
 */
async function constructEvent(rawBody, signatureHeader, signingSecret, toleranceSec = DEFAULT_TOLERANCE_SECONDS) {
  if (typeof rawBody !== "string") {
    throw new StripeWebhookError("INVALID_BODY", "rawBody must be a string");
  }
  if (!signingSecret || !signingSecret.startsWith("whsec_")) {
    throw new StripeWebhookError("INVALID_SECRET", "signingSecret must start with whsec_");
  }
  const { timestamp, signatures } = parseStripeSignatureHeader(signatureHeader);

  // Verify timestamp not stale
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) throw new StripeWebhookError("INVALID_HEADER", "timestamp not numeric");
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > toleranceSec) {
    throw new StripeWebhookError("STALE_TIMESTAMP",
      `timestamp ${ts} outside tolerance window (${toleranceSec}s)`);
  }

  // Compute expected signature
  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = await hmacSha256Hex(signingSecret, signedPayload);

  // Stripe may send multiple v1; one valid is enough
  const ok = signatures.some(s => timingSafeEqualHex(expected, s));
  if (!ok) {
    throw new StripeWebhookError("BAD_SIGNATURE", "signature verification failed");
  }

  // Parse JSON
  let event;
  try { event = JSON.parse(rawBody); }
  catch (e) { throw new StripeWebhookError("INVALID_JSON", "body is not valid JSON"); }
  return event;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    constructEvent,
    parseStripeSignatureHeader,
    hmacSha256Hex,
    timingSafeEqualHex,
    StripeWebhookError,
  };
}
