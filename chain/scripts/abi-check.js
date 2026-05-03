// ABI sanity check — validates the compiled contract surface matches
// what the rest of the system (chain-sdk, edge functions, UI) expects.
//
// Runs offline. Should be executed after compile-check.js.

const fs   = require("fs");
const path = require("path");

const ART = path.join(__dirname, "..", "artifacts-check.json");
if (!fs.existsSync(ART)) {
  console.error("Run compile-check.js first.");
  process.exit(1);
}
const { abi } = JSON.parse(fs.readFileSync(ART, "utf8"));

const EXPECTED = {
  functions: [
    // minting
    "mintNewProduct(address,uint256,uint256,uint256,string,string,bytes32)",
    "mintAdditional(address,uint256,uint256)",
    // custodial transfers
    "custodialTransfer(address,address,uint256,uint256,bytes32)",
    "custodialTransferBatch(address,address,uint256[],uint256[],bytes32)",
    // metadata
    "uri(uint256)",
    "setTokenURI(uint256,string)",
    "freezeMetadata(uint256)",
    "setContractURI(string)",
    // royalties
    "royaltyInfo(uint256,uint256)",
    "setDefaultRoyalty(address,uint96)",
    "setTokenRoyalty(uint256,address,uint96)",
    // pause
    "pause()", "unpause()", "paused()",
    // ERC1155 standard
    "balanceOf(address,uint256)", "balanceOfBatch(address[],uint256[])",
    "safeTransferFrom(address,address,uint256,uint256,bytes)",
    "safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)",
    "setApprovalForAll(address,bool)", "isApprovedForAll(address,address)",
    // supply
    "totalSupply(uint256)", "exists(uint256)",
    // burnable
    "burn(address,uint256,uint256)", "burnBatch(address,uint256[],uint256[])",
    // public storage views
    "name()", "symbol()", "contractURI()", "pdfHashOf(uint256)",
    "maxSupplyOf(uint256)", "serialOf(uint256)", "tokenIdBySerial(string)",
    "metadataFrozen(uint256)",
    // access control
    "hasRole(bytes32,address)", "grantRole(bytes32,address)", "revokeRole(bytes32,address)",
    "DEFAULT_ADMIN_ROLE()", "MINTER_ROLE()", "METADATA_ROLE()", "PAUSER_ROLE()",
    // erc165
    "supportsInterface(bytes4)",
  ],
  events: [
    "CertificateMinted(uint256,address,uint256,string,bytes32,string)",
    "CustodialTransfer(uint256,address,address,uint256,bytes32)",
    "MetadataUpdated(uint256,string)",
    "MetadataFrozen(uint256)",
    "ContractURIUpdated(string)",
    "TransferSingle(address,address,address,uint256,uint256)",
    "TransferBatch(address,address,address,uint256[],uint256[])",
    "RoleGranted(bytes32,address,address)",
    "Paused(address)", "Unpaused(address)",
  ],
  errors: [
    "AlreadyMinted()", "UnknownToken()", "MetadataIsFrozen()",
    "MaxSupplyExceeded()", "SerialAlreadyUsed()", "EmptySerial()", "EmptyURI()",
  ],
};

function sig(item) {
  if (!item.inputs) return item.name + "()";
  return `${item.name}(${item.inputs.map(i => i.type).join(",")})`;
}

const present = {
  functions: new Set(abi.filter(x => x.type === "function").map(sig)),
  events:    new Set(abi.filter(x => x.type === "event").map(sig)),
  errors:    new Set(abi.filter(x => x.type === "error").map(sig)),
};

let failed = 0;
for (const kind of ["functions", "events", "errors"]) {
  console.log(`\n── ${kind} ──`);
  for (const want of EXPECTED[kind]) {
    if (present[kind].has(want)) {
      console.log("  ✓", want);
    } else {
      console.log("  ✗ MISSING:", want);
      failed++;
    }
  }
}

if (failed > 0) {
  console.error(`\n❌ ${failed} expected ABI entries missing.`);
  process.exit(1);
}
console.log("\n✅ ABI surface matches expectations — SDK & edge functions can rely on it.");
