// chain/test/verify-page.test.js
//
// Test integrazione della logica della pagina chain-verify.html contro il
// contratto REALMENTE deployato sulla Hardhat in-process EVM.
//
// Replica le funzioni JS del browser (selectors, decode ABI, canonical SHA-256)
// e verifica che producano risultati identici a quelli del contratto+orchestrator.

"use strict";

const test       = require("node:test");
const assert     = require("node:assert/strict");
const fs         = require("fs");
const path       = require("path");
const hre        = require("hardhat");
const { ethers } = require("ethers");

const { mintCertificate }  = require("../lib/mint-orchestrator");
const wallet               = require("../lib/wallet");
const metadata             = require("../lib/metadata");
const pdf                  = require("../lib/pdf-certificate");
const { makeChainAdapter } = require("../supabase-functions/_shared/chain-adapter");

// ──────────────────────────────────────────────────────────────────────
//  Replica delle funzioni JS della pagina verify (così posso testarle)
// ──────────────────────────────────────────────────────────────────────

const SELECTORS_FROM_PAGE = {
  pdfHashOf:   '0xfd943b93',
  serialOf:    '0xa97e51a6',
  uri:         '0x0e89341c',
  totalSupply: '0xbd85b039',
  maxSupplyOf: '0x2564eed7',
};

function pad32(hexNoPrefix) { return hexNoPrefix.padStart(64, '0'); }
function tokenIdToHex(tokenIdStr) {
  return pad32(BigInt(tokenIdStr).toString(16));
}

function decodeStringFromAbi(hex) {
  const data = hex.slice(2);
  if (data.length < 128) return '';
  const len = parseInt(data.slice(64, 128), 16);
  const bytesHex = data.slice(128, 128 + len*2);
  let out = '';
  for (let i = 0; i < bytesHex.length; i += 2) {
    out += String.fromCharCode(parseInt(bytesHex.slice(i, i+2), 16));
  }
  return out;
}

// Replica della canonicalPdfSha256 della pagina (usa Web Crypto, qui usiamo node:crypto)
async function browserStyleCanonicalSha256(arrayBuffer, expectedHashHex) {
  const { createHash } = require("crypto");
  const u8 = new Uint8Array(arrayBuffer);
  // Cerca expectedHashHex hex-encoded (ascii→hex)
  const asciiAsHex = Array.from(expectedHashHex)
    .map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  const text = Buffer.from(u8).toString('latin1');
  const idx = text.indexOf(asciiAsHex);
  if (idx === -1) return { found:false, raw: createHash('sha256').update(Buffer.from(u8)).digest('hex') };
  const zerosHex = '30'.repeat(64);
  const zeroed = new Uint8Array(u8);
  for (let i = 0; i < zerosHex.length; i++) zeroed[idx + i] = zerosHex.charCodeAt(i);
  const canonical = createHash('sha256').update(Buffer.from(zeroed)).digest('hex');
  return { found:true, canonical, offset:idx };
}

// ──────────────────────────────────────────────────────────────────────
//  Setup: deploy + mint reale (come step 2.6)
// ──────────────────────────────────────────────────────────────────────

async function deployAndMint() {
  const ARTIFACT = path.join(__dirname, "..", "artifacts-check.json");
  if (!fs.existsSync(ARTIFACT)) {
    // Build artifact se manca
    require("child_process").execSync("node scripts/compile-check.js", {
      cwd: path.join(__dirname, ".."), stdio: "ignore",
    });
  }
  const { abi, bytecode } = JSON.parse(fs.readFileSync(ARTIFACT, "utf8"));
  const provider = new ethers.BrowserProvider(hre.network.provider);
  const accounts = await hre.network.provider.send("eth_accounts");
  const deployer = await provider.getSigner(accounts[0]);
  const factory  = new ethers.ContractFactory(abi, bytecode, deployer);
  const c = await factory.deploy(
    accounts[0], accounts[0], accounts[0], accounts[0],
    250, "ipfs://placeholder/{id}", "ipfs://placeholder-collection.json"
  );
  await c.waitForDeployment();
  const contractAddress = await c.getAddress();

  // In-memory mocks
  let serialN = 41;
  const certs = [];
  const xfers = [];
  const wallets = new Map();
  const db = {
    isAdmin: async () => true,
    loadOrder: async () => ({
      id: "order-1", product_id: "33333333-3333-3333-3333-333333333333",
      user_id: "22222222-2222-2222-2222-222222222222",
      status: "payment_received", qty: 5, holding_id: null,
    }),
    loadProduct: async () => ({
      id: "33333333-3333-3333-3333-333333333333",
      name: "Charizard Holo", type: "fractional",
      set: "Base Set", year: 1999, edition: "1st Edition",
      card_number: "4/102", rarity: "Holo Rare", card_language: "EN",
      grading_company: "PSA", grading_grade: 9,
      grading_cert_number: "12345678", grading_graded_at: "2024-08-15",
      grading_label: "PSA 9 — Mint",
      asset_category: "tcg_card", asset_subcategory: "pokemon",
      primary_image_ipfs: "ipfs://QmFront/charizard.jpg",
      shares_total: 100,
      valuation_currency: "EUR", valuation_asset_total: 125000, valuation_share_unit: 1250,
    }),
    loadUser: async () => ({
      id: "22222222-2222-2222-2222-222222222222",
      email: "test@example.com", display_name: "Test User",
    }),
    loadExistingCertificate: async () => null,
    getOrCreateUserWallet: async (uid, address, idx) => {
      if (wallets.has(uid)) return wallets.get(uid);
      if (address === null) return { address: null, derivationIndex: 1 };
      const r = { address, derivationIndex: idx };
      wallets.set(uid, r);
      return r;
    },
    nextSerial: async () => `RB-2026-${String(++serialN).padStart(6, '0')}`,
    productTokenId: async (uuid) => {
      const hex = uuid.replace(/-/g, '').slice(0, 30);
      return BigInt('0x' + hex);
    },
    insertCertificate: async (rec) => { const r = { id: 'c1', ...rec }; certs.push(r); return r; },
    insertTransfer:    async (rec) => { const r = { id: 'x1', ...rec }; xfers.push(r); return r; },
  };
  const storage = {
    uploadPdf: async (serial, buffer) => ({
      storagePath: `certs/${serial}.pdf`,
      signedUrl: `data:application/pdf;base64,${buffer.toString('base64')}`,  // inline data URL for test
      _buffer: buffer,
    }),
  };
  const _pinned = new Map();
  const pinata = {
    pinJSON: async (body) => {
      const { createHash } = require('crypto');
      const cid = 'Qm' + createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 44);
      _pinned.set(cid, body);
      return { IpfsHash: cid, PinSize: JSON.stringify(body).length, Timestamp: '' };
    },
  };
  const chain = makeChainAdapter({
    ethers, signer: deployer, contractAddress, chainId: 31337,
  });

  const result = await mintCertificate(
    { orderId: "order-1", adminUserId: "admin-1" },
    { db, wallet, masterMnemonic: "test test test test test test test test test test test junk",
      metadata, pdf, pinata, storage, chain,
      config: {
        verifyUrlBase: "https://www.rareblock.eu/chain/verify",
        externalUrlBase: "https://www.rareblock.eu/chain/verify",
        termsUrl: "https://t", privacyUrl: "https://p",
        custodian: "RareBlock S.r.l.", vaultJurisdiction: "IT",
        vaultId: "RB-VAULT-01", issuer: "RareBlock S.r.l.",
      },
    }
  );
  if (!result.success) throw new Error("mint failed: " + JSON.stringify(result));
  return { result, contractAddress, abi, provider, certs, storage };
}

// ──────────────────────────────────────────────────────────────────────
//  Tests
// ──────────────────────────────────────────────────────────────────────

let mintedFixture;
test("setup: deploy + mint reale per i test", async () => {
  mintedFixture = await deployAndMint();
  assert.ok(mintedFixture.result.success);
});

test("verify-page: function selectors matchano il contratto reale", async () => {
  // I selectors hardcoded nella page devono produrre la stessa risposta
  // di una chiamata via Interface.encodeFunctionData.
  const { abi } = mintedFixture;
  const iface = new ethers.Interface(abi);
  const SIG_TO_NAME = {
    pdfHashOf:   'pdfHashOf(uint256)',
    serialOf:    'serialOf(uint256)',
    uri:         'uri(uint256)',
    totalSupply: 'totalSupply(uint256)',
    maxSupplyOf: 'maxSupplyOf(uint256)',
  };
  for (const [name, sig] of Object.entries(SIG_TO_NAME)) {
    const selector = iface.getFunction(sig).selector;
    assert.equal(SELECTORS_FROM_PAGE[name], selector,
      `selector for ${sig} mismatch: page has ${SELECTORS_FROM_PAGE[name]} but contract expects ${selector}`);
  }
});

test("verify-page: lettura on-chain via raw eth_call ritorna gli stessi dati dell'orchestrator", async () => {
  const { result, contractAddress, provider } = mintedFixture;
  const tHex = tokenIdToHex(result.token_id);

  // Call pdfHashOf
  const pdfHashRaw = await provider.send('eth_call', [
    { to: contractAddress, data: SELECTORS_FROM_PAGE.pdfHashOf + tHex }, 'latest'
  ]);
  // Call serialOf
  const serialRaw  = await provider.send('eth_call', [
    { to: contractAddress, data: SELECTORS_FROM_PAGE.serialOf  + tHex }, 'latest'
  ]);
  // Call uri
  const uriRaw     = await provider.send('eth_call', [
    { to: contractAddress, data: SELECTORS_FROM_PAGE.uri       + tHex }, 'latest'
  ]);

  // Cosa si aspetta la page:
  // - pdfHashRaw è un bytes32 → confrontiamo direttamente la stringa hex
  assert.equal(pdfHashRaw.toLowerCase(), '0x' + result.pdf_sha256.toLowerCase(),
    "pdfHashOf on-chain != orchestrator.pdf_sha256");

  // - serial is dynamic string → decode con la stessa logica della page
  const decodedSerial = decodeStringFromAbi(serialRaw);
  assert.equal(decodedSerial, result.certificate_serial,
    "serialOf decoded != certificate_serial");

  // - uri dynamic string
  const decodedUri = decodeStringFromAbi(uriRaw);
  assert.equal(decodedUri, result.ipfs_metadata_uri,
    "uri decoded != ipfs_metadata_uri");
});

test("verify-page: canonical SHA-256 in stile browser produce stesso hash di pdf-certificate.js", async () => {
  const { result, storage } = mintedFixture;
  const pdfBuffer = storage._lastBuffer || (await (async () => {
    // recover last uploaded buffer from the storage mock
    return null;
  })());

  // Use the upload-stored buffer (we stashed it on the result via signedUrl data:)
  const dataUrl = result.pdf_url; // 'data:application/pdf;base64,...'
  const base64  = dataUrl.replace(/^data:[^;]+;base64,/, '');
  const buffer  = Buffer.from(base64, 'base64');

  const r = await browserStyleCanonicalSha256(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), result.pdf_sha256);
  assert.equal(r.found, true, 'canonical hash region not found in PDF');
  assert.equal(r.canonical, result.pdf_sha256,
    `browser canonical SHA-256 != orchestrator pdf_sha256`);
});

test("verify-page: tampering del PDF rilevato dal canonical SHA-256 simulato in browser", async () => {
  const { result } = mintedFixture;
  const dataUrl = result.pdf_url;
  const base64  = dataUrl.replace(/^data:[^;]+;base64,/, '');
  const buffer  = Buffer.from(base64, 'base64');
  // Tamper a byte fuori dalla hash region
  const tampered = Buffer.from(buffer);
  tampered[200] = (tampered[200] + 1) & 0xff;

  const r = await browserStyleCanonicalSha256(
    tampered.buffer.slice(tampered.byteOffset, tampered.byteOffset + tampered.byteLength),
    result.pdf_sha256
  );
  // Deve trovare la region (è stata solo cambiata fuori), ma l'hash canonico è diverso
  assert.equal(r.found, true);
  assert.notEqual(r.canonical, result.pdf_sha256, 'tampering deve cambiare il canonical hash');
});

test("verify-page: HTML è single-file e non importa script esterni non-essenziali", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "rareblock-chain-verify.html"), "utf8");
  // Solo Google Fonts CDN ammesso; nessun JS esterno (no jQuery, no Supabase SDK CDN, no ethers CDN)
  // La pagina parla con Supabase e RPC via fetch nativo.
  const externalScripts = html.match(/<script\s+[^>]*src=/gi) || [];
  assert.equal(externalScripts.length, 0,
    "verify page deve essere single-file senza <script src=...> esterni");
  // Deve contenere SHA-256, decode ABI, fetch RPC
  assert.ok(html.includes('crypto.subtle.digest'),  'manca Web Crypto');
  assert.ok(html.includes('eth_call'),               'manca JSON-RPC eth_call');
  assert.ok(html.includes('v_chain_certificate_public'), 'manca query alla view pubblica');
});
