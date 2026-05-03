// chain/test/pinata.test.js
//
// Test del Pinata client con HTTP iniettato (mock). Nessuna chiamata di rete
// reale: i test sono deterministici e veloci.
//
// Eseguito con: node --test test/pinata.test.js

"use strict";

const test       = require("node:test");
const assert     = require("node:assert/strict");
const { PinataClient, PinataError, PINATA_API_BASE } = require("../lib/pinata");

// Helpers: assertion sul .code degli errori custom (più robusto di regex sul message).
const throwsCode  = (fn, code) =>
  assert.throws (fn, (err) => err instanceof PinataError && err.code === code);
const rejectsCode = (p, code) =>
  assert.rejects(p,  (err) => err instanceof PinataError && err.code === code);

// ──────────────────────────────────────────────────────────────────────
//  Mock fetch helpers
// ──────────────────────────────────────────────────────────────────────

/** Crea un mock fetch che ritorna sempre la stessa risposta. */
function staticFetch({ status = 200, body = {}, headers = {} } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return makeResponse(status, body, headers);
  };
  fn.calls = calls;
  return fn;
}

/** Crea un mock fetch che esegue un callback per ogni call (sequence). */
function scriptedFetch(handlers) {
  let idx = 0;
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const h = handlers[idx++];
    if (!h) throw new Error("scriptedFetch: more calls than handlers");
    return await h(url, opts);
  };
  fn.calls = calls;
  return fn;
}

function makeResponse(status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok:      status >= 200 && status < 300,
    status,
    headers: new Map(Object.entries(headers)),
    text:    async () => text,
    json:    async () => (typeof body === "string" ? JSON.parse(body) : body),
  };
}

// JWT fake ma sintatticamente plausibile (header.payload.sig)
const FAKE_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.signaturepart";

// ─── Constructor ─────────────────────────────────────────────────────
test("constructor: rifiuta JWT mancante o non-string", () => {
  assert.throws(() => new PinataClient({}),               /INVALID_JWT|jwt/i);
  assert.throws(() => new PinataClient({ jwt: "" }),      /INVALID_JWT|jwt/i);
  assert.throws(() => new PinataClient({ jwt: 12345 }),   /INVALID_JWT|jwt/i);
  assert.throws(() => new PinataClient({ jwt: null }),    /INVALID_JWT|jwt/i);
});

test("constructor: accetta JWT valido e configurazioni custom", () => {
  const c = new PinataClient({
    jwt:        FAKE_JWT,
    fetch:      staticFetch(),
    timeoutMs:  5000,
    maxRetries: 1,
  });
  assert.equal(c.jwt,        FAKE_JWT);
  assert.equal(c.timeoutMs,  5000);
  assert.equal(c.maxRetries, 1);
  assert.equal(c.apiBase,    PINATA_API_BASE);
});

// ─── testAuthentication ─────────────────────────────────────────────
test("testAuthentication: success path", async () => {
  const f = staticFetch({
    status: 200,
    body:   { message: "Congratulations! You are communicating with the Pinata API!" },
  });
  const c = new PinataClient({ jwt: FAKE_JWT, fetch: f, maxRetries: 0 });

  const ok = await c.testAuthentication();
  assert.equal(ok, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, `${PINATA_API_BASE}/data/testAuthentication`);
  assert.equal(f.calls[0].opts.method, "GET");
  // Authorization header presente
  assert.equal(f.calls[0].opts.headers.Authorization, `Bearer ${FAKE_JWT}`);
});

test("testAuthentication: 401 → PinataError HTTP_CLIENT_ERROR", async () => {
  const f = staticFetch({ status: 401, body: { error: "Unauthorized" } });
  const c = new PinataClient({ jwt: FAKE_JWT, fetch: f, maxRetries: 0 });

  await assert.rejects(c.testAuthentication(), (err) => {
    return err instanceof PinataError
        && err.code === "HTTP_CLIENT_ERROR"
        && err.statusCode === 401
        && err.responseBody?.error === "Unauthorized";
  });
});

test("testAuthentication: 200 ma message inatteso → AUTH_UNEXPECTED_RESPONSE", async () => {
  const f = staticFetch({ status: 200, body: { message: "weird text" } });
  const c = new PinataClient({ jwt: FAKE_JWT, fetch: f, maxRetries: 0 });

  await assert.rejects(c.testAuthentication(), (err) => {
    return err instanceof PinataError
        && err.code === "AUTH_UNEXPECTED_RESPONSE";
  });
});

// ─── pinJSON ─────────────────────────────────────────────────────────
test("pinJSON: success path con metadata + keyvalues", async () => {
  const f = staticFetch({
    status: 200,
    body: {
      IpfsHash:  "QmTestCid12345",
      PinSize:   42,
      Timestamp: "2026-05-03T12:00:00Z",
    },
  });
  const c = new PinataClient({ jwt: FAKE_JWT, fetch: f, maxRetries: 0 });

  const res = await c.pinJSON(
    { hello: "world", value: 42 },
    { name: "test-file", keyvalues: { env: "test", v: "1" } }
  );

  assert.equal(res.IpfsHash, "QmTestCid12345");
  assert.equal(res.PinSize,  42);

  // Verifica payload inviato
  const sent = JSON.parse(f.calls[0].opts.body);
  assert.deepEqual(sent.pinataContent, { hello: "world", value: 42 });
  assert.equal(sent.pinataOptions.cidVersion, 1);
  assert.equal(sent.pinataMetadata.name, "test-file");
  assert.deepEqual(sent.pinataMetadata.keyvalues, { env: "test", v: "1" });
  // Headers
  assert.equal(f.calls[0].opts.headers["Content-Type"], "application/json");
});

test("pinJSON: payload nullo o non-object → INVALID_BODY", async () => {
  const c = new PinataClient({ jwt: FAKE_JWT, fetch: staticFetch(), maxRetries: 0 });
  await rejectsCode(c.pinJSON(null),       "INVALID_BODY");
  await rejectsCode(c.pinJSON(undefined),  "INVALID_BODY");
  await rejectsCode(c.pinJSON("string"),   "INVALID_BODY");
  await rejectsCode(c.pinJSON(42),         "INVALID_BODY");
});

test("pinJSON: senza opts.name/keyvalues, pinataMetadata è omesso", async () => {
  const f = staticFetch({ status: 200, body: { IpfsHash: "Qm", PinSize: 1, Timestamp: "" } });
  const c = new PinataClient({ jwt: FAKE_JWT, fetch: f, maxRetries: 0 });
  await c.pinJSON({ x: 1 });
  const sent = JSON.parse(f.calls[0].opts.body);
  assert.equal(sent.pinataMetadata, undefined,
    "pinataMetadata non deve essere presente se non passato");
});

// ─── pinFile ─────────────────────────────────────────────────────────
test("pinFile: accetta Buffer", async () => {
  const f = staticFetch({
    status: 200,
    body: { IpfsHash: "QmFile1", PinSize: 10, Timestamp: "" },
  });
  const c = new PinataClient({ jwt: FAKE_JWT, fetch: f, maxRetries: 0 });

  const res = await c.pinFile({
    data:        Buffer.from("hello world"),
    filename:    "test.txt",
    contentType: "text/plain",
    metadata:    { name: "my-file" },
  });

  assert.equal(res.IpfsHash, "QmFile1");
  // body deve essere un FormData
  assert.ok(f.calls[0].opts.body instanceof FormData);
  // Authorization presente, ma NIENTE Content-Type esplicito (lo setta fetch)
  assert.equal(f.calls[0].opts.headers.Authorization, `Bearer ${FAKE_JWT}`);
  assert.equal(f.calls[0].opts.headers["Content-Type"], undefined,
    "Content-Type per multipart deve essere settato automaticamente");
});

test("pinFile: accetta Uint8Array", async () => {
  const f = staticFetch({
    status: 200,
    body: { IpfsHash: "QmFile2", PinSize: 5, Timestamp: "" },
  });
  const c = new PinataClient({ jwt: FAKE_JWT, fetch: f, maxRetries: 0 });
  const res = await c.pinFile({
    data:     new Uint8Array([1, 2, 3, 4, 5]),
    filename: "bytes.bin",
  });
  assert.equal(res.IpfsHash, "QmFile2");
});

test("pinFile: accetta Blob", async () => {
  const f = staticFetch({
    status: 200,
    body: { IpfsHash: "QmFile3", PinSize: 1, Timestamp: "" },
  });
  const c = new PinataClient({ jwt: FAKE_JWT, fetch: f, maxRetries: 0 });
  const res = await c.pinFile({
    data:     new Blob(["abc"], { type: "text/plain" }),
    filename: "abc.txt",
  });
  assert.equal(res.IpfsHash, "QmFile3");
});

test("pinFile: rifiuta data invalida o filename mancante", async () => {
  const c = new PinataClient({ jwt: FAKE_JWT, fetch: staticFetch(), maxRetries: 0 });
  await rejectsCode(c.pinFile({ data: null,                filename: "x" }), "INVALID_FILE");
  await rejectsCode(c.pinFile({ data: "stringnotallowed",  filename: "x" }), "INVALID_FILE");
  await rejectsCode(c.pinFile({ data: Buffer.from("x"),    filename: ""  }), "INVALID_FILE");
  await rejectsCode(c.pinFile({ data: Buffer.from("x") }),                   "INVALID_FILE");
});

// ─── Retry logic ─────────────────────────────────────────────────────
test("retry: 5xx viene ritentato fino a maxRetries volte poi fallisce", async () => {
  const f = scriptedFetch([
    async () => makeResponse(500, { error: "boom" }),
    async () => makeResponse(503, { error: "boom" }),
    async () => makeResponse(502, { error: "boom" }),
    async () => makeResponse(500, { error: "boom" }),
  ]);
  const c = new PinataClient({ jwt: FAKE_JWT, fetch: f, maxRetries: 3 });
  await assert.rejects(c.pinJSON({ x: 1 }), (err) => {
    return err instanceof PinataError
        && err.code === "HTTP_SERVER_ERROR"
        && err.statusCode === 500;
  });
  assert.equal(f.calls.length, 4, "tentativo iniziale + 3 retry = 4 call");
});

test("retry: 5xx seguito da 200 → success", async () => {
  const f = scriptedFetch([
    async () => makeResponse(503, { error: "transient" }),
    async () => makeResponse(200, { IpfsHash: "QmRecovered", PinSize: 1, Timestamp: "" }),
  ]);
  const c = new PinataClient({ jwt: FAKE_JWT, fetch: f, maxRetries: 3 });
  const res = await c.pinJSON({ x: 1 });
  assert.equal(res.IpfsHash, "QmRecovered");
  assert.equal(f.calls.length, 2);
});

test("retry: 4xx NON viene ritentato (fail-fast)", async () => {
  const f = scriptedFetch([
    async () => makeResponse(400, { error: "bad request" }),
  ]);
  const c = new PinataClient({ jwt: FAKE_JWT, fetch: f, maxRetries: 3 });
  await assert.rejects(c.pinJSON({ x: 1 }), (err) => {
    return err instanceof PinataError
        && err.code === "HTTP_CLIENT_ERROR"
        && err.statusCode === 400;
  });
  assert.equal(f.calls.length, 1, "4xx deve fallire al primo tentativo");
});

test("retry: errore di rete viene ritentato", async () => {
  const f = scriptedFetch([
    async () => { throw new Error("ECONNRESET"); },
    async () => { throw new Error("ETIMEDOUT"); },
    async () => makeResponse(200, { IpfsHash: "QmAfterNet", PinSize: 1, Timestamp: "" }),
  ]);
  const c = new PinataClient({ jwt: FAKE_JWT, fetch: f, maxRetries: 3 });
  const res = await c.pinJSON({ x: 1 });
  assert.equal(res.IpfsHash, "QmAfterNet");
  assert.equal(f.calls.length, 3);
});

// ─── Static helpers ──────────────────────────────────────────────────
test("ipfsUri: con e senza path", () => {
  assert.equal(PinataClient.ipfsUri("Qm123"),                "ipfs://Qm123");
  assert.equal(PinataClient.ipfsUri("Qm123", "image.jpg"),   "ipfs://Qm123/image.jpg");
  assert.equal(PinataClient.ipfsUri("Qm123", "/image.jpg"),  "ipfs://Qm123/image.jpg");
  throwsCode(() => PinataClient.ipfsUri(""),   "INVALID_CID");
  throwsCode(() => PinataClient.ipfsUri(null), "INVALID_CID");
});

test("gatewayUrl: produce URL HTTP", () => {
  assert.equal(
    PinataClient.gatewayUrl("Qm123"),
    "https://gateway.pinata.cloud/ipfs/Qm123"
  );
  assert.equal(
    PinataClient.gatewayUrl("Qm123", "image.jpg"),
    "https://gateway.pinata.cloud/ipfs/Qm123/image.jpg"
  );
});

// ─── Round-trip: metadata reale Charizard → mock pinJSON ──────────
test("pinJSON integration: invia un JSON RareBlock metadata reale", async () => {
  const { buildExampleCharizard } = require("../lib/metadata");
  const meta = buildExampleCharizard();

  const f = staticFetch({
    status: 200,
    body: {
      IpfsHash:  "QmCharizardCharm",
      PinSize:   3937,
      Timestamp: "2026-05-03T20:00:00Z",
    },
  });
  const c = new PinataClient({ jwt: FAKE_JWT, fetch: f, maxRetries: 0 });

  const res = await c.pinJSON(meta, {
    name: "RB-2026-000042.metadata.json",
    keyvalues: { serial: "RB-2026-000042", env: "test" },
  });

  assert.equal(res.IpfsHash, "QmCharizardCharm");

  // Verify che il body inviato sia identico al metadata originale
  const sent = JSON.parse(f.calls[0].opts.body);
  assert.deepEqual(sent.pinataContent, meta);
  assert.equal(sent.pinataMetadata.keyvalues.serial, "RB-2026-000042");
});
