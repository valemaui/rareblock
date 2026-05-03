// scripts/deploy.js — RareBlock Certificate
//
// Usage:
//   npx hardhat run scripts/deploy.js --network baseSepolia
//   npx hardhat run scripts/deploy.js --network base
//
// Required env vars:
//   PRIVATE_KEY            — hot wallet that deploys + becomes initial MINTER
//   ADMIN_ADDRESS          — Gnosis Safe (mainnet) or admin EOA (testnet)
//   METADATA_MANAGER_ADDR  — wallet allowed to update non-frozen URIs
//   ROYALTY_RECEIVER_ADDR  — receives ERC-2981 royalties (RareBlock treasury)
//   ROYALTY_BPS            — basis points, default 250 (2.5%)
//   COLLECTION_BASE_URI    — fallback ipfs:// gateway
//   COLLECTION_URI         — collection-level metadata JSON (OpenSea)

const hre = require("hardhat");

async function main() {
  const env = process.env;
  const required = [
    "ADMIN_ADDRESS",
    "METADATA_MANAGER_ADDR",
    "ROYALTY_RECEIVER_ADDR",
    "COLLECTION_BASE_URI",
    "COLLECTION_URI",
  ];
  for (const k of required) {
    if (!env[k]) throw new Error(`Missing env var: ${k}`);
  }

  const [deployer] = await hre.ethers.getSigners();
  const network    = hre.network.name;
  const royaltyBps = parseInt(env.ROYALTY_BPS || "250", 10);

  console.log("════════════════════════════════════════════════════════");
  console.log("  RareBlock Certificate — deploy");
  console.log("════════════════════════════════════════════════════════");
  console.log(" network          :", network);
  console.log(" deployer/minter  :", deployer.address);
  console.log(" admin (multisig) :", env.ADMIN_ADDRESS);
  console.log(" metadata mgr     :", env.METADATA_MANAGER_ADDR);
  console.log(" royalty receiver :", env.ROYALTY_RECEIVER_ADDR);
  console.log(" royalty bps      :", royaltyBps);
  console.log(" base URI         :", env.COLLECTION_BASE_URI);
  console.log(" contract URI     :", env.COLLECTION_URI);
  console.log("────────────────────────────────────────────────────────");

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(" deployer balance :", hre.ethers.formatEther(balance), "ETH");
  if (balance === 0n) throw new Error("Deployer has zero balance — fund it.");

  const Factory = await hre.ethers.getContractFactory("RareBlockCertificate");
  const c = await Factory.deploy(
    env.ADMIN_ADDRESS,
    deployer.address,                   // initial MINTER = hot wallet
    env.METADATA_MANAGER_ADDR,
    env.ROYALTY_RECEIVER_ADDR,
    royaltyBps,
    env.COLLECTION_BASE_URI,
    env.COLLECTION_URI
  );
  await c.waitForDeployment();

  const addr = await c.getAddress();
  console.log("  ✔ deployed to     :", addr);
  console.log("  tx hash           :", c.deploymentTransaction().hash);
  console.log("════════════════════════════════════════════════════════");
  console.log("Next steps:");
  console.log("  1. Verify on Basescan:");
  console.log(`     npx hardhat verify --network ${network} ${addr} \\`);
  console.log(`       ${env.ADMIN_ADDRESS} \\`);
  console.log(`       ${deployer.address} \\`);
  console.log(`       ${env.METADATA_MANAGER_ADDR} \\`);
  console.log(`       ${env.ROYALTY_RECEIVER_ADDR} \\`);
  console.log(`       ${royaltyBps} \\`);
  console.log(`       "${env.COLLECTION_BASE_URI}" \\`);
  console.log(`       "${env.COLLECTION_URI}"`);
  console.log("  2. Save the address into chain-config.js");
  console.log("  3. Test mint via scripts/sample-mint.js");
}

main().catch((err) => { console.error(err); process.exit(1); });
