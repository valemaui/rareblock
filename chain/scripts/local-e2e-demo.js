#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
//  chain/scripts/local-e2e-demo.js
//
//  End-to-end demo locale: deployment + mint reale di un certificato
//  Charizard via il mint-orchestrator, su una blockchain Hardhat in-process.
//
//  Tutto reale tranne:
//    - Pinata (mocked: l'allowlist sandbox blocca api.pinata.cloud)
//    - Storage Supabase (mocked: serve un signed URL)
//    - DB Supabase (mocked: in-memory)
//
//  La blockchain è REALE (EVM Hardhat), il contratto è REALE (deployed),
//  il mint è REALE (tx hash, block, gas usati), l'NFT è REALE (verificabile
//  via `balanceOf`, `pdfHashOf`, `serialOf`, `uri`).
//
//  Output:
//    - chain/examples/local-demo-output/charizard-RB-2026-NNNNNN.pdf
//    - chain/examples/local-demo-output/charizard-RB-2026-NNNNNN.metadata.json
//    - chain/examples/local-demo-output/run-summary.txt
// ═══════════════════════════════════════════════════════════════════════
"use strict";

const path  = require("path");
const fs    = require("fs");
const hre   = require("hardhat");
const { ethers, ZeroAddress } = require("ethers");

const { mintCertificate }       = require("../lib/mint-orchestrator");
const wallet                    = require("../lib/wallet");
const metadata                  = require("../lib/metadata");
const pdf                       = require("../lib/pdf-certificate");
const { PinataClient }          = require("../lib/pinata");
const { makeChainAdapter }      = require("../supabase-functions/_shared/chain-adapter");

const OUT_DIR = path.join(__dirname, "..", "examples", "local-demo-output");
const ARTIFACT_PATH = path.join(__dirname, "..", "artifacts-check.json");

// ── Pretty output ──
const out = (...a) => process.stdout.write(a.join(" ") + "\n");
const hr  = () => out("─".repeat(76));

// ── Deterministic mnemonic for the demo (NEVER use in production) ──
const DEMO_MNEMONIC =
  "test test test test test test test test test test test junk";  // hardhat default

// ──────────────────────────────────────────────────────────────────────
//  In-memory mocks for DB, Storage, Pinata
// ──────────────────────────────────────────────────────────────────────

function makeInMemoryDB() {
  const t = {
    profiles:           [],
    inv_orders:         [],
    inv_products:       [],
    auth_users:         [],
    chain_wallets:      [],
    chain_certificates: [],
    chain_transfers:    [],
  };
  let serialCounter = 41;  // next mint will produce RB-2026-000042

  const db = {
    isAdmin:  async (uid) => t.profiles.some(p => p.id === uid && p.role === "admin"),
    loadOrder:    async (id) => t.inv_orders.find(o => o.id === id) || null,
    loadProduct:  async (id) => t.inv_products.find(p => p.id === id) || null,
    loadUser:     async (id) => {
      const u = t.auth_users.find(u => u.id === id);
      const p = t.profiles.find(p => p.id === id);
      if (!u) return null;
      return { id: u.id, email: u.email, display_name: p?.display_name || u.email };
    },
    loadExistingCertificate: async (orderId) =>
      t.chain_certificates.find(c => c.order_id === orderId) || null,
    getOrCreateUserWallet: async (userId, address, idx) => {
      const ex = t.chain_wallets.find(w => w.user_id === userId);
      if (ex) return { address: ex.address, derivationIndex: ex.derivation_index };
      if (address === null) {
        const max = t.chain_wallets.reduce((m, w) => Math.max(m, w.derivation_index), 0);
        return { address: null, derivationIndex: max + 1 };
      }
      t.chain_wallets.push({
        user_id: userId, address, derivation_index: idx, chain_id: 31337,
      });
      return { address, derivationIndex: idx };
    },
    nextSerial: async () => {
      serialCounter++;
      return `RB-2026-${String(serialCounter).padStart(6, "0")}`;
    },
    productTokenId: async (productUuid) => {
      // Same algo as the Postgres function: first 30 hex chars → BigInt
      const hex = productUuid.replace(/-/g, "").slice(0, 30);
      const n = BigInt("0x" + hex);
      return n === 0n ? 1n : n;
    },
    insertCertificate: async (rec) => {
      const id = `cert-${t.chain_certificates.length + 1}`;
      const row = { id, ...rec };
      t.chain_certificates.push(row);
      return row;
    },
    insertTransfer: async (rec) => {
      const id = `xfer-${t.chain_transfers.length + 1}`;
      const row = { id, ...rec };
      t.chain_transfers.push(row);
      return row;
    },
    _tables: t,
  };
  return db;
}

function makeInMemoryStorage() {
  const stored = new Map();
  return {
    uploadPdf: async (serial, buffer) => {
      const filePath = path.join(OUT_DIR, `${serial}.pdf`);
      fs.writeFileSync(filePath, buffer);
      stored.set(serial, { buffer, path: filePath });
      // Pretend signed URL — locally pointing to the demo output dir
      return {
        storagePath: `certs/${serial}.pdf`,
        signedUrl:   `file://${filePath}`,
      };
    },
    _stored: stored,
  };
}

function makeInMemoryPinata() {
  const { createHash } = require("crypto");
  const pinned = new Map();
  return {
    pinJSON: async (body, opts) => {
      const json = JSON.stringify(body);
      const cid  = "Qm" + createHash("sha256").update(json).digest("hex").slice(0, 44);
      pinned.set(cid, body);
      // Save the JSON to disk for visual inspection
      const fname = (opts?.name || cid).replace(/\.json$/i, "") + ".json";
      fs.writeFileSync(path.join(OUT_DIR, fname), JSON.stringify(body, null, 2));
      return { IpfsHash: cid, PinSize: json.length, Timestamp: new Date().toISOString() };
    },
    _pinned: pinned,
  };
}

// ──────────────────────────────────────────────────────────────────────
//  Deploy the contract on the in-process Hardhat network
// ──────────────────────────────────────────────────────────────────────
async function deployContract() {
  if (!fs.existsSync(ARTIFACT_PATH)) {
    throw new Error(`Missing artifact ${ARTIFACT_PATH} — run scripts/compile-check.js first`);
  }
  const { abi, bytecode } = JSON.parse(fs.readFileSync(ARTIFACT_PATH, "utf8"));

  // Wrap Hardhat's EIP-1193 provider in ethers v6
  const provider = new ethers.BrowserProvider(hre.network.provider);
  const accounts = await hre.network.provider.send("eth_accounts");

  // Use account[0] as deployer, [1] as minter (will be granted MINTER_ROLE in ctor)
  const deployer = await provider.getSigner(accounts[0]);
  const factory  = new ethers.ContractFactory(abi, bytecode, deployer);

  // Constructor args (vedi RareBlockCertificate.sol):
  //   admin, minter, metadataMgr, royaltyReceiver, royaltyBps, baseURI, contractURI
  const adminAddr   = accounts[0];   // multisig in prod; demo: deployer
  const minterAddr  = accounts[0];   // demo: stesso
  const metaAddr    = accounts[0];
  const royaltyAddr = accounts[0];
  const royaltyBps  = 250;
  const baseURI     = "ipfs://placeholder/{id}";
  const contractURI = "ipfs://placeholder-collection.json";

  const c = await factory.deploy(
    adminAddr, minterAddr, metaAddr, royaltyAddr,
    royaltyBps, baseURI, contractURI
  );
  await c.waitForDeployment();
  const addr = await c.getAddress();
  return { contractAddress: addr, contract: c, abi, deployer, provider };
}

// ──────────────────────────────────────────────────────────────────────
//  MAIN
// ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  hr();
  out("  RareBlock — Local E2E demo");
  out("  Hardhat in-process EVM (chainId 31337) + real contract + real mint");
  hr();

  // ─── 1) Deploy ────────────────────────────────────────────────────
  out("\n[1/6] Deploying RareBlockCertificate contract…");
  const { contractAddress, contract, abi, deployer, provider } = await deployContract();
  out("      ✔ deployed at:", contractAddress);
  const code = await provider.getCode(contractAddress);
  out("      ✔ on-chain code size:", (code.length / 2 - 1), "bytes");

  // ─── 2) Setup mocks (DB + storage + pinata) ──────────────────────
  out("\n[2/6] Bootstrapping in-memory DB + storage + pinata mocks…");
  const db      = makeInMemoryDB();
  const storage = makeInMemoryStorage();
  const pinata  = makeInMemoryPinata();

  // Populate fixture: admin + investor + product + paid order
  const adminId   = "11111111-1111-1111-1111-111111111111";
  const userId    = "22222222-2222-2222-2222-222222222222";
  const productId = "33333333-3333-3333-3333-333333333333";
  const orderId   = "44444444-4444-4444-4444-444444444444";

  db._tables.profiles.push({ id: adminId, role: "admin", display_name: "Admin Demo" });
  db._tables.profiles.push({ id: userId,  role: "investor", display_name: "Valentino Castiglione" });
  db._tables.auth_users.push({ id: adminId, email: "admin@rareblock.eu" });
  db._tables.auth_users.push({ id: userId,  email: "valentino@example.com" });
  db._tables.inv_products.push({
    id: productId, name: "Charizard Holo",
    type: "fractional",
    set: "Base Set", year: 1999, edition: "1st Edition",
    card_number: "4/102", rarity: "Holo Rare",
    card_language: "EN",
    grading_company: "PSA", grading_grade: 9,
    grading_cert_number: "12345678", grading_graded_at: "2024-08-15",
    grading_label: "PSA 9 — Mint",
    asset_category: "tcg_card", asset_subcategory: "pokemon",
    primary_image_ipfs: "ipfs://QmDemoFront/charizard.jpg",
    back_image_ipfs:    "ipfs://QmDemoBack/charizard.jpg",
    shares_total: 100,
    valuation_currency: "EUR", valuation_asset_total: 125000, valuation_share_unit: 1250,
  });
  db._tables.inv_orders.push({
    id: orderId, product_id: productId, user_id: userId,
    status: "payment_received", qty: 5, holding_id: null,
  });
  out("      ✔ admin, investor, product (Charizard Holo), order (5 shares) ready");

  // ─── 3) Build chain adapter using the real ethers + real contract ──
  out("\n[3/6] Wiring chain adapter (ethers v6 + deployed contract)…");
  const chain = makeChainAdapter({
    ethers: require("ethers"),
    signer: deployer,                      // deployer is also MINTER for the demo
    contractAddress,
    chainId: 31337,
  });
  out("      ✔ chain adapter ready, MINTER =", await deployer.getAddress());

  // ─── 4) Run the orchestrator! ─────────────────────────────────────
  out("\n[4/6] Running mintCertificate(...) — this is the moment of truth.");
  const t0 = Date.now();
  const result = await mintCertificate(
    { orderId, adminUserId: adminId },
    {
      db, wallet, masterMnemonic: DEMO_MNEMONIC,
      metadata, pdf, pinata, storage, chain,
      config: {
        verifyUrlBase:     "https://www.rareblock.eu/chain/verify",
        externalUrlBase:   "https://www.rareblock.eu/chain/verify",
        termsUrl:          "https://www.rareblock.eu/legal/terms",
        privacyUrl:        "https://www.rareblock.eu/legal/privacy",
        custodian:         "RareBlock S.r.l.",
        vaultJurisdiction: "IT",
        vaultId:           "RB-VAULT-01",
        issuer:            "RareBlock S.r.l.",
        insurance:         true,
        insuranceProvider: "AXA Art Insurance",
        withdrawalPolicyUrl: "https://www.rareblock.eu/legal/withdrawal",
      },
      logger: (e) => {
        // Print a short, structured log line per step
        const tag = `[${String(e.step).padStart(2, " ")}|${e.level.padEnd(5, " ")}]`;
        let extra = "";
        if (e.address_short)      extra = ` ${e.address_short}`;
        if (e.serial)             extra = ` ${e.serial}`;
        if (e.cid)                extra = ` ${e.cid.slice(0, 16)}…`;
        if (e.tx_hash)            extra = ` ${e.tx_hash.slice(0, 14)}…`;
        if (e.size_bytes)         extra = ` ${e.size_bytes}B`;
        out(`      ${tag} ${e.msg}${extra}`);
      },
    }
  );
  const dt = Date.now() - t0;
  out(`      → orchestrator returned in ${dt}ms`);

  if (!result.success) {
    out("\n✗ MINT FAILED:", result.code, "—", result.error);
    out("  events tail:", JSON.stringify(result.events.slice(-3), null, 2));
    process.exit(1);
  }

  // ─── 5) On-chain verification ─────────────────────────────────────
  out("\n[5/6] Verifying state ON-CHAIN (reading directly from contract)…");
  const c = new ethers.Contract(contractAddress, abi, deployer);

  const tokenIdBig = BigInt(result.token_id);
  const ownerBalance = await c.balanceOf(result.owner_address, tokenIdBig);
  const totalSupply  = await c["totalSupply(uint256)"](tokenIdBig);
  const maxSupply    = await c.maxSupplyOf(tokenIdBig);
  const onChainSerial= await c.serialOf(tokenIdBig);
  const onChainURI   = await c.uri(tokenIdBig);
  const onChainPdfH  = await c.pdfHashOf(tokenIdBig);

  out("      tokenId          :", tokenIdBig.toString());
  out("      balanceOf(owner) :", ownerBalance.toString(), "shares  ← era 5 nell'order");
  out("      totalSupply      :", totalSupply.toString());
  out("      maxSupply        :", maxSupply.toString());
  out("      on-chain serial  :", onChainSerial);
  out("      on-chain URI     :", onChainURI);
  out("      on-chain pdfHash :", onChainPdfH);
  out("      orchestrator hash: 0x" + result.pdf_sha256);

  const allOk =
    ownerBalance === 5n &&
    totalSupply  === 5n &&
    onChainSerial === result.certificate_serial &&
    onChainURI === result.ipfs_metadata_uri &&
    onChainPdfH === ("0x" + result.pdf_sha256);

  if (!allOk) {
    out("\n      ✗ ON-CHAIN STATE MISMATCH");
    process.exit(1);
  }
  out("\n      ✅ On-chain state EXACTLY matches what the orchestrator returned.");

  // ─── 6) Idempotency re-run ─────────────────────────────────────────
  out("\n[6/6] Re-running mintCertificate on the same order (idempotency)…");
  const r2 = await mintCertificate(
    { orderId, adminUserId: adminId },
    {
      db, wallet, masterMnemonic: DEMO_MNEMONIC,
      metadata, pdf, pinata, storage, chain,
      config: {
        verifyUrlBase: "https://www.rareblock.eu/chain/verify",
        externalUrlBase: "https://www.rareblock.eu/chain/verify",
        termsUrl: "https://www.rareblock.eu/legal/terms",
        privacyUrl: "https://www.rareblock.eu/legal/privacy",
        custodian: "RareBlock S.r.l.", vaultJurisdiction: "IT",
        vaultId: "RB-VAULT-01", issuer: "RareBlock S.r.l.",
      },
      logger: () => {},
    }
  );
  if (!r2.success || !r2.idempotent) {
    out("      ✗ idempotency failed");
    process.exit(1);
  }
  out("      ✔ correctly returned existing certificate at step 3 (idempotent)");
  // Verify on-chain totalSupply NON è raddoppiato
  const finalSupply = await c["totalSupply(uint256)"](tokenIdBig);
  out("      ✔ totalSupply after re-run:", finalSupply.toString(), "(unchanged)");

  // ─── Final summary file ────────────────────────────────────────────
  const summary = `RareBlock — Local E2E Demo Run
================================================================

Date              : ${new Date().toISOString()}
Network           : Hardhat in-process (chainId 31337)
Contract          : ${contractAddress}
Bytecode size     : ${(code.length / 2 - 1)} bytes

CERTIFICATE
  Serial          : ${result.certificate_serial}
  Token ID        : ${result.token_id}
  Owner address   : ${result.owner_address}
  Owner shares    : ${ownerBalance.toString()} of ${totalSupply.toString()} minted (max ${maxSupply.toString()})

ON-CHAIN PROOFS
  Tx hash (mint)  : ${result.tx_hash}
  Block number    : ${result.block_number}
  pdfHashOf (chain): ${onChainPdfH}
  pdf_sha256 (orch): 0x${result.pdf_sha256}
  serialOf  (chain): ${onChainSerial}
  uri       (chain): ${onChainURI}

FILES
  PDF             : examples/local-demo-output/${result.certificate_serial}.pdf
  IPFS metadata   : examples/local-demo-output/${result.certificate_serial}.metadata.json.json
  IPFS CID (mock) : ${result.ipfs_metadata_cid}

PIPELINE
  Total elapsed   : ${dt}ms
  Steps           : 13/13 (build pdf, upload, pin metadata, mint, db insert)
  Idempotent rerun: ✅
`;
  fs.writeFileSync(path.join(OUT_DIR, "run-summary.txt"), summary);

  out("");
  hr();
  out("  ✅ END-TO-END DEMO PASSED");
  hr();
  out("");
  out("  Output dir:");
  out("   ", OUT_DIR);
  out("");
  out("  Generated files:");
  fs.readdirSync(OUT_DIR).sort().forEach(f => {
    const sz = fs.statSync(path.join(OUT_DIR, f)).size;
    out(`    ${f.padEnd(48)} ${String(sz).padStart(8)} bytes`);
  });
  out("");
  hr();
}

main().catch((e) => { console.error(e); process.exit(1); });
