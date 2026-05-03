// ═══════════════════════════════════════════════════════════════════════
//  chain/lib/pinata.js
//
//  Client per Pinata IPFS pinning. Zero dipendenze esterne — usa fetch,
//  FormData, Blob built-in di Node 18+ e Deno (Edge Function).
//
//  Endpoints supportati:
//    GET  /data/testAuthentication     — sanity check del JWT
//    POST /pinning/pinJSONToIPFS       — upload JSON metadata
//    POST /pinning/pinFileToIPFS       — upload file binari (immagini, PDF)
//
//  Design:
//    - Constructor injection del JWT (mai hardcoded, mai loggato)
//    - Retry esponenziale su 5xx e network errors (non su 4xx — sono client bugs)
//    - Timeout su ogni call (default 60s, configurable)
//    - Errori custom (PinataError) con statusCode e responseBody, mai swallow
//    - HTTP layer iniettabile per testing (default: globalThis.fetch)
// ═══════════════════════════════════════════════════════════════════════
"use strict";

const PINATA_API_BASE   = "https://api.pinata.cloud";
const PINATA_GATEWAY    = "https://gateway.pinata.cloud/ipfs";
const DEFAULT_TIMEOUT   = 60_000;
const DEFAULT_MAX_RETRY = 3;

// ──────────────────────────────────────────────────────────────────────
//  Errori custom
// ──────────────────────────────────────────────────────────────────────
class PinataError extends Error {
  constructor(code, message, statusCode = null, responseBody = null) {
    super(message);
    this.name         = "PinataError";
    this.code         = code;
    this.statusCode   = statusCode;
    this.responseBody = responseBody;
  }
}

// ──────────────────────────────────────────────────────────────────────
//  Helper: sleep + jitter
// ──────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt) => Math.min(1000 * 2 ** attempt, 10_000) + Math.floor(Math.random() * 250);

// ──────────────────────────────────────────────────────────────────────
//  Helper: fetch con timeout (AbortController)
// ──────────────────────────────────────────────────────────────────────
async function fetchWithTimeout(fetchFn, url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ──────────────────────────────────────────────────────────────────────
//  Pinata client class
// ──────────────────────────────────────────────────────────────────────
class PinataClient {
  /**
   * @param {Object} cfg
   * @param {string} cfg.jwt                JWT token Pinata
   * @param {string} [cfg.apiBase]          override base URL (test)
   * @param {Function} [cfg.fetch]          override fetch (test)
   * @param {number} [cfg.timeoutMs]        timeout per request (default 60s)
   * @param {number} [cfg.maxRetries]       retry su 5xx/network (default 3)
   */
  constructor(cfg = {}) {
    if (!cfg.jwt || typeof cfg.jwt !== "string") {
      throw new PinataError("INVALID_JWT", "Pinata client requires a non-empty JWT string");
    }
    this.jwt        = cfg.jwt;
    this.apiBase    = cfg.apiBase    || PINATA_API_BASE;
    this.fetchFn    = cfg.fetch      || globalThis.fetch;
    this.timeoutMs  = cfg.timeoutMs  || DEFAULT_TIMEOUT;
    this.maxRetries = cfg.maxRetries ?? DEFAULT_MAX_RETRY;

    if (typeof this.fetchFn !== "function") {
      throw new PinataError("NO_FETCH",
        "fetch is not available — pass cfg.fetch or use Node 18+/Deno");
    }
  }

  // ─── Headers helper ───────────────────────────────────────────────
  _authHeaders(extra = {}) {
    return { Authorization: `Bearer ${this.jwt}`, ...extra };
  }

  // ─── Centralized request runner with retry ─────────────────────────
  async _request(method, path, { headers = {}, body = undefined, retryable = true } = {}) {
    const url = `${this.apiBase}${path}`;
    let lastError;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await fetchWithTimeout(
          this.fetchFn,
          url,
          { method, headers: this._authHeaders(headers), body },
          this.timeoutMs
        );

        // Read body once (può essere usato sia in success che in error reporting)
        const text = await res.text();
        let parsed;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }

        if (res.ok) return parsed;

        // 4xx → fail-fast (client error, retry sarebbe inutile)
        if (res.status >= 400 && res.status < 500) {
          throw new PinataError(
            "HTTP_CLIENT_ERROR",
            `Pinata ${method} ${path} failed with ${res.status}`,
            res.status,
            parsed
          );
        }

        // 5xx → retryable
        lastError = new PinataError(
          "HTTP_SERVER_ERROR",
          `Pinata ${method} ${path} failed with ${res.status}`,
          res.status,
          parsed
        );
      } catch (err) {
        // PinataError 4xx già rilanciata sopra
        if (err instanceof PinataError && err.code === "HTTP_CLIENT_ERROR") throw err;
        // Network/timeout → retryable
        lastError = err instanceof PinataError
          ? err
          : new PinataError("NETWORK", `Network error on ${method} ${path}: ${err.message}`);
      }

      if (!retryable || attempt === this.maxRetries) break;
      await sleep(backoff(attempt));
    }
    throw lastError;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Public API
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Verifica che il JWT sia valido. Ritorna `true` o lancia.
   * Usato dallo smoke test e all'avvio dell'Edge Function.
   */
  async testAuthentication() {
    const res = await this._request("GET", "/data/testAuthentication");
    if (res && typeof res.message === "string" && /Congratulations/i.test(res.message)) {
      return true;
    }
    throw new PinataError("AUTH_UNEXPECTED_RESPONSE",
      "Pinata responded but the message did not match expected format",
      200, res);
  }

  /**
   * Pin di un oggetto JavaScript come JSON su IPFS.
   *
   * @param {Object} body            l'oggetto da pinnare (verrà JSON.stringified)
   * @param {Object} [opts]
   * @param {string} [opts.name]     nome leggibile (Pinata pinata_metadata.name)
   * @param {Object} [opts.keyvalues] custom key-values (cercabili da Pinata UI)
   * @param {1|0}    [opts.cidVersion] 1 (default) o 0
   * @returns {Promise<{IpfsHash:string, PinSize:number, Timestamp:string}>}
   */
  async pinJSON(body, opts = {}) {
    if (body === null || typeof body !== "object") {
      throw new PinataError("INVALID_BODY", "pinJSON requires an object body");
    }

    const payload = {
      pinataContent: body,
      pinataOptions: { cidVersion: opts.cidVersion ?? 1 },
      ...(opts.name || opts.keyvalues
        ? {
            pinataMetadata: {
              ...(opts.name      ? { name: opts.name }           : {}),
              ...(opts.keyvalues ? { keyvalues: opts.keyvalues } : {}),
            },
          }
        : {}),
    };

    return this._request("POST", "/pinning/pinJSONToIPFS", {
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
    });
  }

  /**
   * Pin di un file binario su IPFS.
   *
   * @param {Object} args
   * @param {Buffer|Uint8Array|Blob} args.data   payload del file
   * @param {string} args.filename               nome del file
   * @param {string} [args.contentType]          es. "image/jpeg" — default "application/octet-stream"
   * @param {Object} [args.metadata]             {name, keyvalues}
   * @param {1|0}    [args.cidVersion]           default 1
   * @returns {Promise<{IpfsHash:string, PinSize:number, Timestamp:string}>}
   */
  async pinFile({ data, filename, contentType, metadata = {}, cidVersion = 1 }) {
    if (data == null) throw new PinataError("INVALID_FILE", "pinFile requires data");
    if (!filename || typeof filename !== "string") {
      throw new PinataError("INVALID_FILE", "pinFile requires a filename string");
    }

    // Normalizziamo `data` in un Blob: il modo più portabile su Node 18+/Deno.
    let blob;
    if (data instanceof Blob) {
      blob = data;
    } else if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
      blob = new Blob([data], { type: contentType || "application/octet-stream" });
    } else {
      throw new PinataError("INVALID_FILE",
        "pinFile data must be Buffer, Uint8Array, or Blob");
    }

    const form = new FormData();
    form.append("file", blob, filename);
    form.append("pinataOptions", JSON.stringify({ cidVersion }));
    if (metadata.name || metadata.keyvalues) {
      form.append("pinataMetadata", JSON.stringify({
        ...(metadata.name      ? { name: metadata.name }           : {}),
        ...(metadata.keyvalues ? { keyvalues: metadata.keyvalues } : {}),
      }));
    }

    return this._request("POST", "/pinning/pinFileToIPFS", { body: form });
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Helpers (puri, senza network)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Costruisce un URI ipfs:// dato un CID e un eventuale path.
   * Usato per popolare `image`, `media.primary_image`, ecc nello schema metadata.
   */
  static ipfsUri(cid, path) {
    if (!cid || typeof cid !== "string") {
      throw new PinataError("INVALID_CID", "ipfsUri requires a CID string");
    }
    return path ? `ipfs://${cid}/${path.replace(/^\/+/, "")}` : `ipfs://${cid}`;
  }

  /**
   * Costruisce un URL HTTP gateway-served (Pinata public gateway).
   * NON usare questo URL nel JSON metadata — lì serve sempre `ipfs://CID`.
   * Usalo solo per anteprima / debug / link "open in browser".
   */
  static gatewayUrl(cid, path) {
    if (!cid) throw new PinataError("INVALID_CID", "gatewayUrl requires a CID string");
    const base = `${PINATA_GATEWAY}/${cid}`;
    return path ? `${base}/${path.replace(/^\/+/, "")}` : base;
  }
}

// ──────────────────────────────────────────────────────────────────────
module.exports = {
  PinataClient,
  PinataError,
  PINATA_API_BASE,
  PINATA_GATEWAY,
};
