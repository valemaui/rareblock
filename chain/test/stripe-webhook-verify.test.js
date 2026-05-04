// chain/test/stripe-webhook-verify.test.js
//
// Test della verifica firma webhook Stripe. Genera firme valide
// con HMAC-SHA256 e verifica sia happy path che casi di tampering.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  constructEvent,
  parseStripeSignatureHeader,
  hmacSha256Hex,
  timingSafeEqualHex,
  StripeWebhookError,
} = require("../supabase-functions/_shared/stripe-webhook-verify.js");

const SECRET = "whsec_test_DUMMY_SECRET_FOR_TESTS";

// Firma un payload come fa Stripe
function signPayload(payload, secret = SECRET, ts = Math.floor(Date.now() / 1000)) {
  const signedPayload = `${ts}.${payload}`;
  const sig = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
  return { ts, sig, header: `t=${ts},v1=${sig}` };
}

// ─── Header parsing ──────────────────────────────────────────────────
test("parseSignatureHeader: parsing valid header", () => {
  const { timestamp, signatures } = parseStripeSignatureHeader("t=1492774577,v1=abc123,v1=def456");
  assert.equal(timestamp, "1492774577");
  assert.deepEqual(signatures, ["abc123", "def456"]);
});

test("parseSignatureHeader: header senza timestamp → error", () => {
  assert.throws(() => parseStripeSignatureHeader("v1=abc"), /timestamp/);
});

test("parseSignatureHeader: header senza v1 → error", () => {
  assert.throws(() => parseStripeSignatureHeader("t=1234567"), /v1/);
});

test("parseSignatureHeader: header undefined → error", () => {
  assert.throws(() => parseStripeSignatureHeader(undefined), /missing/);
});

// ─── HMAC + timing-safe equality ─────────────────────────────────────
test("hmacSha256Hex: deterministic output, hex format", async () => {
  const a = await hmacSha256Hex("k", "msg");
  const b = await hmacSha256Hex("k", "msg");
  assert.equal(a, b);
  assert.match(a, /^[a-f0-9]{64}$/);
});

test("hmacSha256Hex: matches Node crypto reference", async () => {
  const ours = await hmacSha256Hex(SECRET, "1700000000.{\"id\":\"evt_test\"}");
  const ref = crypto.createHmac("sha256", SECRET).update("1700000000.{\"id\":\"evt_test\"}").digest("hex");
  assert.equal(ours, ref);
});

test("timingSafeEqualHex: equal/different strings", () => {
  assert.equal(timingSafeEqualHex("aaaa", "aaaa"), true);
  assert.equal(timingSafeEqualHex("aaaa", "aaab"), false);
  assert.equal(timingSafeEqualHex("aaaa", "aaaaaa"), false); // diff length
  assert.equal(timingSafeEqualHex("", ""), true);
});

// ─── constructEvent happy path ───────────────────────────────────────
test("constructEvent: valid signature parses event", async () => {
  const body = JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded", data: { object: {} } });
  const { header } = signPayload(body);
  const event = await constructEvent(body, header, SECRET);
  assert.equal(event.id, "evt_1");
  assert.equal(event.type, "payment_intent.succeeded");
});

// ─── Tampering ─────────────────────────────────────────────────────
test("constructEvent: tampered body → BAD_SIGNATURE", async () => {
  const body = JSON.stringify({ id: "evt_orig", amount: 100 });
  const { header } = signPayload(body);
  const tampered = JSON.stringify({ id: "evt_orig", amount: 99999999 });
  await assert.rejects(
    constructEvent(tampered, header, SECRET),
    err => err instanceof StripeWebhookError && err.code === "BAD_SIGNATURE"
  );
});

test("constructEvent: wrong secret → BAD_SIGNATURE", async () => {
  const body = JSON.stringify({ id: "evt_x" });
  const { header } = signPayload(body, "whsec_OTHER_SECRET");
  await assert.rejects(
    constructEvent(body, header, SECRET),
    err => err.code === "BAD_SIGNATURE"
  );
});

test("constructEvent: stale timestamp → STALE_TIMESTAMP", async () => {
  const body = JSON.stringify({ id: "evt_x" });
  const tsOld = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
  const { header } = signPayload(body, SECRET, tsOld);
  await assert.rejects(
    constructEvent(body, header, SECRET, 300),
    err => err.code === "STALE_TIMESTAMP"
  );
});

test("constructEvent: future timestamp oltre tolerance → STALE_TIMESTAMP", async () => {
  const body = JSON.stringify({ id: "evt_x" });
  const tsFut = Math.floor(Date.now() / 1000) + 600;
  const { header } = signPayload(body, SECRET, tsFut);
  await assert.rejects(
    constructEvent(body, header, SECRET, 300),
    err => err.code === "STALE_TIMESTAMP"
  );
});

test("constructEvent: invalid signing secret format", async () => {
  const body = JSON.stringify({ id: "x" });
  const { header } = signPayload(body);
  await assert.rejects(
    constructEvent(body, header, "sk_bad_secret"),
    err => err.code === "INVALID_SECRET"
  );
});

test("constructEvent: header mancante → MISSING_HEADER", async () => {
  await assert.rejects(
    constructEvent("{}", "", SECRET),
    err => err.code === "MISSING_HEADER"
  );
});

test("constructEvent: rawBody non-string → INVALID_BODY", async () => {
  await assert.rejects(
    constructEvent({ a: 1 }, "t=1,v1=x", SECRET),
    err => err.code === "INVALID_BODY"
  );
});

test("constructEvent: body non-JSON → INVALID_JSON", async () => {
  const body = "not json";
  const { header } = signPayload(body);
  await assert.rejects(
    constructEvent(body, header, SECRET),
    err => err.code === "INVALID_JSON"
  );
});

test("constructEvent: tolleranza esattamente al limite (5 min) accetta", async () => {
  const body = JSON.stringify({ id: "edge" });
  const tsEdge = Math.floor(Date.now() / 1000) - 299;
  const { header } = signPayload(body, SECRET, tsEdge);
  const event = await constructEvent(body, header, SECRET, 300);
  assert.equal(event.id, "edge");
});

test("constructEvent: header con multiple v1 — uno valido basta", async () => {
  const body = JSON.stringify({ id: "evt_multi" });
  const ts = Math.floor(Date.now() / 1000);
  const validSig = crypto.createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex");
  // Mix di firme: una valida + due false
  const header = `t=${ts},v1=${"deadbeef".repeat(8)},v1=${validSig},v1=${"00".repeat(32)}`;
  const event = await constructEvent(body, header, SECRET);
  assert.equal(event.id, "evt_multi");
});
