#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
//  chain/scripts/wallet-tools.js
//
//  CLI per ops sui wallet RareBlock. Mai passare mnemonic via argv (sarebbero
//  visibili in `ps`/history): la phrase si legge sempre da env var o stdin.
//
//  Comandi:
//    generate-mnemonic
//        Genera una nuova mnemonic 24 parole BIP39. STAMPA SU STDOUT UNA VOLTA.
//        Salvala subito (password manager, Supabase Vault). Mai committare.
//
//    derive <role> [index] [--mnemonic-env VAR]
//        Deriva un wallet da una mnemonic letta da env (default: WALLET_MNEMONIC).
//        Stampa: address, derivation path. La privKey viene stampata SOLO se passi
//        --reveal (default: false, per sicurezza).
//
//    generate-testnet-minter
//        Bootstrap one-shot per il MINTER di Base Sepolia: genera una mnemonic
//        dedicata (NON la prod), deriva il wallet MINTER, stampa istruzioni
//        per finanziarlo dal Coinbase faucet.
//
//  Esempi:
//    node scripts/wallet-tools.js generate-mnemonic
//    WALLET_MNEMONIC="..." node scripts/wallet-tools.js derive minter
//    WALLET_MNEMONIC="..." node scripts/wallet-tools.js derive user 42
//    node scripts/wallet-tools.js generate-testnet-minter
// ═══════════════════════════════════════════════════════════════════════
"use strict";

const w = require("../lib/wallet");

// ─── tiny output helpers ─────────────────────────────────────────────
const out  = (...a) => process.stdout.write(a.join(" ") + "\n");
const err  = (...a) => process.stderr.write(a.join(" ") + "\n");
const hr   = ()     => out("─".repeat(72));
const die  = (msg)  => { err("✗", msg); process.exit(1); };

// ─── cmd: generate-mnemonic ─────────────────────────────────────────
function cmdGenerateMnemonic() {
  const phrase = w.generateMnemonic();
  hr();
  out("  RareBlock — new BIP39 mnemonic (24 words, 256-bit entropy)");
  hr();
  out("");
  // Stampato come blocco "indented" per facilitare lo screenshot/copy
  out("  " + phrase.split(" ").reduce((acc, word, i) => {
    return acc + ((i % 6 === 0 && i > 0) ? "\n  " : (i > 0 ? " " : "")) + word;
  }, ""));
  out("");
  hr();
  out("  ⚠  STORE THIS MNEMONIC IN A PASSWORD MANAGER NOW.");
  out("     Once this terminal closes, it cannot be recovered.");
  out("     Anyone with this phrase controls every wallet derived from it.");
  hr();
}

// ─── cmd: derive ─────────────────────────────────────────────────────
function cmdDerive(args) {
  const role  = args[0];
  if (!role) die("usage: derive <minter|user|metadata> [index]");

  let index;
  if (role === "user") {
    index = parseInt(args[1], 10);
    if (!Number.isInteger(index) || index < 1) {
      die("user role requires an integer index >= 1");
    }
  }

  const envName  = parseFlag(args, "--mnemonic-env") || "WALLET_MNEMONIC";
  const mnemonic = process.env[envName];
  if (!mnemonic) die(`env var ${envName} is empty. Set it before running.`);
  if (!w.isValidMnemonic(mnemonic)) die(`mnemonic in ${envName} is not BIP39-valid`);

  const reveal = args.includes("--reveal");
  const wallet = w.deriveWallet(mnemonic, role, index);

  hr();
  out("  RareBlock — derived wallet");
  hr();
  out("  role            :", role + (index !== undefined ? ` (index ${index})` : ""));
  out("  derivation path :", wallet.path);
  out("  address         :", wallet.address);
  out("  public key      :", wallet.publicKey);
  if (reveal) {
    out("  private key     :", wallet.privateKey);
    out("  ⚠  --reveal was passed: keep this terminal output secret.");
  } else {
    out("  private key     : <hidden — pass --reveal to show>");
  }
  hr();
}

// ─── cmd: generate-testnet-minter ────────────────────────────────────
function cmdGenerateTestnetMinter() {
  const phrase = w.generateMnemonic();
  const minter = w.deriveWallet(phrase, "minter");

  hr();
  out("  RareBlock — Base Sepolia MINTER bootstrap");
  hr();
  out("");
  out("  TESTNET-ONLY mnemonic (24 words):");
  out("  " + phrase.split(" ").reduce((acc, word, i) => {
    return acc + ((i % 6 === 0 && i > 0) ? "\n  " : (i > 0 ? " " : "")) + word;
  }, ""));
  out("");
  hr();
  out("  Derived MINTER wallet (path m/44'/60'/0'/0/0):");
  out("");
  out("    Address  : " + minter.address);
  out("");
  hr();
  out("");
  out("  NEXT STEPS:");
  out("");
  out("  1. Save the mnemonic above in a password manager. Tag it 'RB testnet'.");
  out("     This is NOT your production master seed — it's just for Sepolia.");
  out("");
  out("  2. Add the mnemonic to chain/.env (gitignored):");
  out("");
  out("       WALLET_MNEMONIC=\"" + phrase + "\"");
  out("       PRIVATE_KEY=" + minter.privateKey);
  out("");
  out("     (PRIVATE_KEY is what hardhat reads for deploys.)");
  out("");
  out("  3. Fund the MINTER address on Base Sepolia from the Coinbase faucet:");
  out("");
  out("       https://www.coinbase.com/faucets/base-sepolia-faucet");
  out("");
  out("     Paste this address into the faucet input field:");
  out("");
  out("       " + minter.address);
  out("");
  out("     0.05 ETH is plenty for hundreds of mints.");
  out("");
  out("  4. Confirm the funding on the Sepolia explorer:");
  out("");
  out("       https://sepolia.basescan.org/address/" + minter.address);
  out("");
  out("  5. You can now deploy the contract:");
  out("");
  out("       npm run deploy:sepolia");
  out("");
  hr();
}

// ─── arg parsing helper ──────────────────────────────────────────────
function parseFlag(args, flagName) {
  const i = args.indexOf(flagName);
  if (i === -1) return null;
  return args[i + 1];
}

// ─── main ─────────────────────────────────────────────────────────────
function main() {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case "generate-mnemonic":         cmdGenerateMnemonic();         break;
    case "derive":                    cmdDerive(rest);               break;
    case "generate-testnet-minter":   cmdGenerateTestnetMinter();    break;
    case undefined:
    case "--help":
    case "-h":
      out("RareBlock wallet-tools — usage:");
      out("  node scripts/wallet-tools.js generate-mnemonic");
      out("  WALLET_MNEMONIC='...' node scripts/wallet-tools.js derive <role> [index] [--reveal]");
      out("  node scripts/wallet-tools.js generate-testnet-minter");
      break;
    default:
      die(`unknown command: ${cmd}`);
  }
}

main();
