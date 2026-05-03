// ═══════════════════════════════════════════════════════════════════════
//  chain/lib/wallet.js — HD wallet derivation per RareBlock
//
//  Libreria pura (nessun I/O, nessuna network call) che gestisce la
//  generazione e derivazione deterministica dei wallet custodial.
//
//  Modello a una sola master seed (BIP39 mnemonic 24 parole) custodita
//  fuori dal repo: in dev → `.env` locale; in produzione → Supabase Vault.
//
//  Convenzione path BIP44 (Ethereum): m / 44' / 60' / account' / change / index
//
//    Account 0 (operativo)         → m/44'/60'/0'/0/{idx}
//      idx = 0  → MINTER           (hot wallet che firma i mint server-side)
//      idx = 1+ → USERS            (un wallet per ogni utente, idx = chain_wallets.derivation_index)
//    Account 0 change=1            → m/44'/60'/0'/1/{idx}
//      idx = 0  → METADATA_SIGNER  (usato per firmare update non-frozen URI)
//
//  Per le funzioni Edge (Deno) si importa lo stesso identico file con un
//  thin wrapper ESM. La logica resta condivisa, no duplicazione.
// ═══════════════════════════════════════════════════════════════════════
"use strict";

const { Mnemonic, HDNodeWallet, randomBytes, getAddress } = require("ethers");

// ──────────────────────────────────────────────────────────────────────
//  Costanti
// ──────────────────────────────────────────────────────────────────────
const BIP44_BASE = "m/44'/60'/0'";

const ROLE_TO_PATH = Object.freeze({
  minter:   `${BIP44_BASE}/0/0`,                       // singleton
  user:     (idx) => `${BIP44_BASE}/0/${idx}`,         // idx >= 1
  metadata: `${BIP44_BASE}/1/0`,                       // singleton
});

const MNEMONIC_WORDS = 24;       // 256 bit di entropia
const ENTROPY_BYTES  = 32;       // 24 parole = 256 bit

// ──────────────────────────────────────────────────────────────────────
//  Errori custom (più facili da catchare a monte)
// ──────────────────────────────────────────────────────────────────────
class WalletError extends Error {
  constructor(code, message) { super(message); this.code = code; this.name = "WalletError"; }
}
const E = {
  invalidMnemonic:  (m) => new WalletError("INVALID_MNEMONIC",  m),
  invalidIndex:     (m) => new WalletError("INVALID_INDEX",     m),
  invalidRole:      (m) => new WalletError("INVALID_ROLE",      m),
  invalidPath:      (m) => new WalletError("INVALID_PATH",      m),
};

// ──────────────────────────────────────────────────────────────────────
//  Generazione mnemonic (24 parole, 256 bit entropia)
// ──────────────────────────────────────────────────────────────────────
/**
 * Genera una nuova mnemonic BIP39 a 24 parole con entropia crittograficamente sicura.
 * USO: una volta sola al bootstrap, poi la phrase va custodita fuori dal repo.
 * @returns {string} 24 parole separate da spazio
 */
function generateMnemonic() {
  const entropy = randomBytes(ENTROPY_BYTES);
  const m = Mnemonic.fromEntropy(entropy);
  return m.phrase;
}

/**
 * Verifica che una mnemonic sia BIP39-valida (checksum, wordlist, lunghezza).
 * @param {string} phrase
 * @returns {boolean}
 */
function isValidMnemonic(phrase) {
  if (typeof phrase !== "string" || !phrase.trim()) return false;
  try {
    const m = Mnemonic.fromPhrase(phrase.trim());
    return Boolean(m && m.phrase);
  } catch { return false; }
}

// ──────────────────────────────────────────────────────────────────────
//  Derivazione
// ──────────────────────────────────────────────────────────────────────
/**
 * Risolve il path BIP44 per un dato (role, index).
 * @param {'minter'|'user'|'metadata'} role
 * @param {number} [index] — richiesto solo per role='user' (>= 1)
 * @returns {string} path es. "m/44'/60'/0'/0/42"
 */
function pathFor(role, index) {
  if (role === "minter")   return ROLE_TO_PATH.minter;
  if (role === "metadata") return ROLE_TO_PATH.metadata;
  if (role === "user") {
    if (!Number.isInteger(index) || index < 1) {
      throw E.invalidIndex(`User index must be an integer >= 1, got: ${index}`);
    }
    if (index > 2_147_483_647) { // 2^31-1, BIP32 non-hardened max
      throw E.invalidIndex(`User index exceeds BIP32 limit (2^31-1): ${index}`);
    }
    return ROLE_TO_PATH.user(index);
  }
  throw E.invalidRole(`Unknown role: ${role}`);
}

/**
 * Deriva il wallet per un dato (mnemonic, role, index).
 * @param {string} mnemonic — BIP39 phrase 12/24 words
 * @param {'minter'|'user'|'metadata'} role
 * @param {number} [index]
 * @returns {{address: string, privateKey: string, publicKey: string, path: string}}
 */
function deriveWallet(mnemonic, role, index) {
  if (!isValidMnemonic(mnemonic)) {
    throw E.invalidMnemonic("Mnemonic is not BIP39-valid (checksum or wordlist mismatch)");
  }
  const path = pathFor(role, index);
  const m    = Mnemonic.fromPhrase(mnemonic.trim());
  // ethers v6: HDNodeWallet.fromMnemonic(mnemonic, path) deriva direttamente
  const w    = HDNodeWallet.fromMnemonic(m, path);
  return {
    address:    getAddress(w.address),    // EIP-55 checksummed
    privateKey: w.privateKey,
    publicKey:  w.publicKey,
    path,
  };
}

/**
 * Helper: solo address (no private key esposta) — utile per UI / DB sync senza
 * rischio di leakage in log.
 */
function deriveAddress(mnemonic, role, index) {
  return deriveWallet(mnemonic, role, index).address;
}

/**
 * Deriva un range di address utente in una sola call (efficiente per backfill).
 * @param {string} mnemonic
 * @param {number} fromIndex inclusive
 * @param {number} toIndex   inclusive
 * @returns {Array<{index:number,address:string,path:string}>}
 */
function deriveUserAddressRange(mnemonic, fromIndex, toIndex) {
  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex < 1 || toIndex < fromIndex) {
    throw E.invalidIndex(`Invalid range [${fromIndex}, ${toIndex}]`);
  }
  const out = [];
  // Ottimizzazione: derivo il nodo padre m/44'/60'/0'/0 una sola volta
  const m       = Mnemonic.fromPhrase(mnemonic.trim());
  const parent  = HDNodeWallet.fromMnemonic(m, `${BIP44_BASE}/0`);
  for (let i = fromIndex; i <= toIndex; i++) {
    const child = parent.deriveChild(i);
    out.push({ index: i, address: getAddress(child.address), path: `${BIP44_BASE}/0/${i}` });
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
//  Export
// ──────────────────────────────────────────────────────────────────────
module.exports = {
  // Public API
  generateMnemonic,
  isValidMnemonic,
  deriveWallet,
  deriveAddress,
  deriveUserAddressRange,
  pathFor,
  // Errors
  WalletError,
  // Constants (read-only)
  BIP44_BASE,
  MNEMONIC_WORDS,
};
