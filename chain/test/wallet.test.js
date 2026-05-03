// chain/test/wallet.test.js
//
// Test offline della libreria HD wallet derivation.
// Usa il test runner built-in di Node (`node:test`) — zero dipendenze extra.
// Eseguito con: `node --test test/wallet.test.js`

"use strict";

const test       = require("node:test");
const assert     = require("node:assert/strict");
const { Wallet, HDNodeWallet, Mnemonic } = require("ethers");

const w = require("../lib/wallet");

// Helper: assert.throws con match sul .code property (più robusto del match
// regex sul message, che cambierebbe se traduciamo gli errori in italiano).
const throwsCode = (fn, expectedCode) =>
  assert.throws(fn, (err) => err instanceof w.WalletError && err.code === expectedCode);

// Vector BIP39 ufficiale (Trezor): mnemonic noto → address noto.
// 24 parole "abandon ... art" (entropia tutta zero) è un test vector universalmente
// riconosciuto. Se i nostri derive cambiassero l'output, ce ne accorgiamo subito.
const TREZOR_VEC = {
  mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon "
          + "abandon abandon abandon abandon abandon abandon abandon abandon "
          + "abandon abandon abandon abandon abandon abandon abandon art",
  // m/44'/60'/0'/0/0 (Ethereum default per la prima account)
  // Address atteso, derivato con ethers v6 — valore deterministico per questa
  // mnemonic standard. Cross-checkabile su iancoleman.io/bip39 (Ethereum coin).
  expectedFirstAddress: "0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb",
};

// ─── generateMnemonic ────────────────────────────────────────────────
test("generateMnemonic: 24 parole, BIP39-valida, ad alta entropia", () => {
  const a = w.generateMnemonic();
  const b = w.generateMnemonic();

  assert.equal(a.split(" ").length, 24, "deve essere 24 parole");
  assert.equal(b.split(" ").length, 24);
  assert.notEqual(a, b, "due chiamate consecutive producono mnemonic diverse");
  assert.ok(w.isValidMnemonic(a), "la mnemonic generata è BIP39-valida");
  assert.ok(w.isValidMnemonic(b));
});

// ─── isValidMnemonic ────────────────────────────────────────────────
test("isValidMnemonic: accetta valide, rifiuta tutto il resto", () => {
  // Valide
  assert.equal(w.isValidMnemonic(TREZOR_VEC.mnemonic), true);
  assert.equal(w.isValidMnemonic(w.generateMnemonic()), true);
  // Spazi extra ammessi (trim interno)
  assert.equal(w.isValidMnemonic("  " + TREZOR_VEC.mnemonic + "  "), true);

  // Invalide
  assert.equal(w.isValidMnemonic(""), false);
  assert.equal(w.isValidMnemonic("not a real mnemonic phrase at all"), false);
  // Mnemonic con checksum sbagliato (cambio l'ultima parola)
  const bad = TREZOR_VEC.mnemonic.replace(/art$/, "ability");
  assert.equal(w.isValidMnemonic(bad), false, "checksum mismatch deve fallire");
  // Lunghezza non standard (5 parole)
  assert.equal(w.isValidMnemonic("abandon abandon abandon abandon abandon"), false);
  // Tipi non-string
  assert.equal(w.isValidMnemonic(null), false);
  assert.equal(w.isValidMnemonic(undefined), false);
  assert.equal(w.isValidMnemonic(12345), false);
  assert.equal(w.isValidMnemonic({}), false);
});

// ─── pathFor ────────────────────────────────────────────────────────
test("pathFor: produce i path corretti per ogni ruolo", () => {
  assert.equal(w.pathFor("minter"),     "m/44'/60'/0'/0/0");
  assert.equal(w.pathFor("metadata"),   "m/44'/60'/0'/1/0");
  assert.equal(w.pathFor("user", 1),    "m/44'/60'/0'/0/1");
  assert.equal(w.pathFor("user", 42),   "m/44'/60'/0'/0/42");
  assert.equal(w.pathFor("user", 9999), "m/44'/60'/0'/0/9999");
});

test("pathFor: rifiuta ruoli sconosciuti", () => {
  throwsCode(() => w.pathFor("hacker"),    "INVALID_ROLE");
  throwsCode(() => w.pathFor(""),          "INVALID_ROLE");
  throwsCode(() => w.pathFor(undefined),   "INVALID_ROLE");
});

test("pathFor: rifiuta indici utente invalidi", () => {
  throwsCode(() => w.pathFor("user"),                    "INVALID_INDEX");
  throwsCode(() => w.pathFor("user", 0),                 "INVALID_INDEX");
  throwsCode(() => w.pathFor("user", -1),                "INVALID_INDEX");
  throwsCode(() => w.pathFor("user", 1.5),               "INVALID_INDEX");
  throwsCode(() => w.pathFor("user", "1"),               "INVALID_INDEX");
  throwsCode(() => w.pathFor("user", 2_147_483_648),     "INVALID_INDEX");
});

// ─── deriveWallet — DETERMINISMO contro test vector ufficiale ──────────
test("deriveWallet: matcha il test vector BIP39 standard (Trezor)", () => {
  // Per matchare il vector standard BIP44 m/44'/60'/0'/0/0, usiamo role='minter'
  // (che mappa esattamente quel path).
  const r = w.deriveWallet(TREZOR_VEC.mnemonic, "minter");
  assert.equal(r.path,    "m/44'/60'/0'/0/0");
  assert.equal(r.address, TREZOR_VEC.expectedFirstAddress,
    "address derivato deve combaciare con il vector standard");
  assert.match(r.privateKey, /^0x[a-f0-9]{64}$/);
  assert.match(r.publicKey,  /^0x[a-f0-9]+$/);
});

test("deriveWallet: stessa mnemonic + stesso path → stesso wallet (determinismo)", () => {
  const m = w.generateMnemonic();
  const a = w.deriveWallet(m, "user", 5);
  const b = w.deriveWallet(m, "user", 5);
  assert.equal(a.address,    b.address);
  assert.equal(a.privateKey, b.privateKey);
  assert.equal(a.path,       b.path);
});

test("deriveWallet: path diversi → address diversi", () => {
  const m = w.generateMnemonic();
  const minter = w.deriveWallet(m, "minter");
  const meta   = w.deriveWallet(m, "metadata");
  const u1     = w.deriveWallet(m, "user", 1);
  const u2     = w.deriveWallet(m, "user", 2);
  const u100   = w.deriveWallet(m, "user", 100);

  const all = [minter.address, meta.address, u1.address, u2.address, u100.address];
  assert.equal(new Set(all).size, 5, "tutti gli address devono essere distinti");
});

test("deriveWallet: mnemonic invalida → errore esplicito", () => {
  throwsCode(() => w.deriveWallet("rubbish words here", "user", 1), "INVALID_MNEMONIC");
  throwsCode(() => w.deriveWallet("",                   "user", 1), "INVALID_MNEMONIC");
});

test("deriveWallet: la private key derivata firma davvero (sanity)", async () => {
  // Verifica che la chiave privata sia funzionante: creiamo un Wallet ethers
  // e firmiamo un messaggio. Se la derivazione fosse rotta, ethers fallirebbe.
  const r  = w.deriveWallet(TREZOR_VEC.mnemonic, "user", 1);
  const ew = new Wallet(r.privateKey);
  assert.equal(ew.address, r.address, "Wallet(privKey).address === derive.address");
  const sig = await ew.signMessage("RareBlock canary");
  assert.match(sig, /^0x[a-f0-9]{130}$/, "signature ben formata 65 byte hex");
});

test("deriveWallet: address è EIP-55 checksum (mixed case)", () => {
  const r = w.deriveWallet(TREZOR_VEC.mnemonic, "minter");
  // EIP-55: address valido contiene SIA maiuscole CHE minuscole
  const hex = r.address.slice(2);
  assert.ok(/[A-F]/.test(hex), "deve contenere maiuscole (EIP-55)");
  assert.ok(/[a-f]/.test(hex), "deve contenere minuscole (EIP-55)");
});

// ─── deriveAddress (helper) ─────────────────────────────────────────
test("deriveAddress: ritorna stesso address di deriveWallet senza esporre privKey", () => {
  const m       = w.generateMnemonic();
  const full    = w.deriveWallet(m, "user", 7);
  const onlyAdr = w.deriveAddress(m, "user", 7);
  assert.equal(onlyAdr, full.address);
  // typeof guard: deriveAddress non deve essere un oggetto
  assert.equal(typeof onlyAdr, "string");
});

// ─── deriveUserAddressRange ─────────────────────────────────────────
test("deriveUserAddressRange: efficiente e coerente con deriveWallet single", () => {
  const m     = TREZOR_VEC.mnemonic;
  const range = w.deriveUserAddressRange(m, 1, 10);

  assert.equal(range.length, 10);
  for (const r of range) {
    assert.match(r.address, /^0x[a-fA-F0-9]{40}$/);
    // confronto con deriveWallet single per ogni indice → deve combaciare
    const single = w.deriveWallet(m, "user", r.index);
    assert.equal(r.address, single.address,
      `range[${r.index}] deve combaciare con deriveWallet(...,'user',${r.index})`);
    assert.equal(r.path, single.path);
  }
  // tutti distinti
  assert.equal(new Set(range.map(r => r.address)).size, 10);
});

test("deriveUserAddressRange: rifiuta range invalidi", () => {
  const m = TREZOR_VEC.mnemonic;
  throwsCode(() => w.deriveUserAddressRange(m, 0, 5),   "INVALID_INDEX");
  throwsCode(() => w.deriveUserAddressRange(m, 5, 1),   "INVALID_INDEX");
  throwsCode(() => w.deriveUserAddressRange(m, -1, 5),  "INVALID_INDEX");
  throwsCode(() => w.deriveUserAddressRange(m, 1.5, 3), "INVALID_INDEX");
});

// ─── Cross-check con derivazione manuale ethers ──────────────────────
test("deriveWallet: equivalente a HDNodeWallet.fromMnemonic con path manuale", () => {
  // Sanity finale: la nostra derivazione fa la STESSA cosa che farebbe ethers
  // direttamente, e mantenere questa equivalenza è importante per l'audit.
  const m       = TREZOR_VEC.mnemonic;
  const idx     = 42;
  const path    = `m/44'/60'/0'/0/${idx}`;
  const ours    = w.deriveWallet(m, "user", idx);
  const direct  = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(m), path);
  assert.equal(ours.address.toLowerCase(),    direct.address.toLowerCase());
  assert.equal(ours.privateKey,               direct.privateKey);
  assert.equal(ours.path,                     path);
});
