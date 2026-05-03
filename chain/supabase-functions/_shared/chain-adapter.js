// chain/supabase-functions/_shared/chain-adapter.js
//
// Adapter ethers v6 per parlare col contratto RareBlockCertificate.
// Lo stesso codice gira in Node (test) e Deno (Edge Function).
//
// Importa ethers dal CDN/npm a seconda del runtime. La parte qui sotto
// è agnostica: riceve un `signer` già configurato.
"use strict";

// ABI minimale: solo le funzioni che ci servono dall'orchestratore
const RAREBLOCK_ABI = [
  // mintNewProduct(to, tokenId, qty, maxSupply, serial, metadataURI, pdfHash)
  "function mintNewProduct(address to, uint256 tokenId, uint256 qty, uint256 maxSupply, string serial, string metadataURI, bytes32 pdfHash)",
  "function mintAdditional(address to, uint256 tokenId, uint256 qty)",
  "function custodialTransfer(address from, address to, uint256 tokenId, uint256 qty, bytes32 reasonHash)",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function totalSupply(uint256 id) view returns (uint256)",
  "function maxSupplyOf(uint256 id) view returns (uint256)",
  "function pdfHashOf(uint256 id) view returns (bytes32)",
  "function serialOf(uint256 id) view returns (string)",
  "function tokenIdBySerial(string serial) view returns (uint256)",
  "function uri(uint256 id) view returns (string)",
  "event CertificateMinted(uint256 indexed tokenId, address indexed to, uint256 qty, string serial, bytes32 pdfHash, string metadataURI)",
];

const EXPLORERS = Object.freeze({
  8453:  "https://basescan.org",
  84532: "https://sepolia.basescan.org",
  31337: null,                            // Hardhat local: no explorer
});

/**
 * @param {Object} args
 * @param {Object} args.ethers     ethers v6 module
 * @param {Object} args.signer     ethers Signer (con MINTER_ROLE)
 * @param {string} args.contractAddress
 * @param {number} args.chainId
 * @param {Object} [args.txOpts]   extra options for sendTransaction (gasLimit, etc)
 */
function makeChainAdapter({ ethers, signer, contractAddress, chainId, txOpts = {} }) {
  if (!ethers || !signer || !contractAddress || !chainId) {
    throw new Error("makeChainAdapter: missing required args");
  }
  const contract = new ethers.Contract(contractAddress, RAREBLOCK_ABI, signer);

  return {
    chainId,
    contractAddress,
    contract,

    async mintNewProduct({ to, tokenId, qty, maxSupply, serial, metadataURI, pdfHash }) {
      // Validate inputs
      if (!ethers.isAddress(to)) throw new Error(`mintNewProduct: invalid to ${to}`);
      if (!/^0x[a-fA-F0-9]{64}$/.test(pdfHash)) {
        throw new Error(`mintNewProduct: pdfHash must be 0x + 64 hex`);
      }
      // Send tx
      const tx = await contract.mintNewProduct(
        to, tokenId, qty, maxSupply, serial, metadataURI, pdfHash, txOpts
      );
      // Wait for confirmation (default 1 block)
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) {
        throw new Error(`mintNewProduct: tx ${tx.hash} reverted`);
      }
      return {
        txHash:      receipt.hash,
        blockNumber: receipt.blockNumber,
      };
    },

    async custodialTransfer({ from, to, tokenId, qty, reasonHash }) {
      const tx = await contract.custodialTransfer(from, to, tokenId, qty, reasonHash, txOpts);
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) {
        throw new Error(`custodialTransfer: tx ${tx.hash} reverted`);
      }
      return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
    },

    buildExplorerTxUrl(cid, txHash) {
      const base = EXPLORERS[cid];
      return base ? `${base}/tx/${txHash}` : null;
    },

    buildExplorerTokenUrl(cid, contract, tokenId) {
      const base = EXPLORERS[cid];
      return base ? `${base}/token/${contract}?a=${tokenId}` : null;
    },
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { makeChainAdapter, RAREBLOCK_ABI, EXPLORERS };
}
