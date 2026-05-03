// Standalone compile validation using solc-js — no network needed.
// Pre-resolves ALL imports manually with canonical source names so that
// relative imports inside OZ contracts (e.g. "../utils/Context.sol")
// resolve to the same source unit name solc expects.

const fs   = require("fs");
const path = require("path");
const solc = require("solc");

const ROOT    = path.join(__dirname, "..");
const SRC_DIR = path.join(ROOT, "contracts");
const NM_DIR  = path.join(ROOT, "node_modules");

const sources = {};       // sourceName → { content }
const visited = new Map(); // diskPath → sourceName

// Local contracts get a "local/" prefix to avoid colliding with OZ paths
function localSourceName(diskPath) {
  return "local/" + path.relative(SRC_DIR, diskPath).replace(/\\/g, "/");
}

// For OZ files: source name is "@openzeppelin/contracts/<rel>"
function ozSourceName(diskPath) {
  const rel = path.relative(NM_DIR, diskPath).replace(/\\/g, "/");
  return rel; // already starts with "@openzeppelin/contracts/..."
}

function diskPathToSourceName(diskPath) {
  if (diskPath.startsWith(NM_DIR))  return ozSourceName(diskPath);
  if (diskPath.startsWith(SRC_DIR)) return localSourceName(diskPath);
  throw new Error("Outside both src and node_modules: " + diskPath);
}

function loadRecursive(diskPath) {
  if (visited.has(diskPath)) return visited.get(diskPath);

  const sourceName = diskPathToSourceName(diskPath);
  visited.set(diskPath, sourceName);

  const content = fs.readFileSync(diskPath, "utf8");
  sources[sourceName] = { content };

  const importRe = /^\s*import\s+(?:\{[^}]*\}\s+from\s+)?["']([^"']+)["']/gm;
  let m;
  while ((m = importRe.exec(content)) !== null) {
    const importPath = m[1];
    let resolved;
    if (importPath.startsWith("@openzeppelin/")) {
      resolved = path.join(NM_DIR, importPath);
    } else if (importPath.startsWith("./") || importPath.startsWith("../")) {
      resolved = path.resolve(path.dirname(diskPath), importPath);
    } else {
      // bare local import
      const local = path.join(SRC_DIR, importPath);
      if (fs.existsSync(local)) resolved = local;
      else                       resolved = path.join(NM_DIR, importPath);
    }
    if (!fs.existsSync(resolved)) {
      throw new Error(`Cannot resolve "${importPath}" from ${diskPath}`);
    }
    loadRecursive(resolved);
  }
  return sourceName;
}

for (const f of fs.readdirSync(SRC_DIR)) {
  if (f.endsWith(".sol")) loadRecursive(path.join(SRC_DIR, f));
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    evmVersion: "cancun",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

console.log("Compiling with solc", solc.version());
console.log("Source units loaded:", Object.keys(sources).length);

const out = JSON.parse(solc.compile(JSON.stringify(input)));

let hasError = false;
if (out.errors) {
  for (const e of out.errors) {
    if (e.severity === "error") { hasError = true; console.error("✗", e.formattedMessage); }
  }
}
if (hasError) { console.error("\n❌ Compilation FAILED"); process.exit(1); }

console.log("\n✅ Compilation OK");
const ourSourceName = "local/RareBlockCertificate.sol";
if (out.contracts?.[ourSourceName]) {
  const c = out.contracts[ourSourceName].RareBlockCertificate;
  console.log("  ABI entries     :", c.abi.length);
  console.log("  Bytecode size   :", (c.evm.bytecode.object.length / 2).toLocaleString(), "bytes");
  const artifactPath = path.join(ROOT, "artifacts-check.json");
  fs.writeFileSync(artifactPath, JSON.stringify({
    contractName: "RareBlockCertificate",
    abi: c.abi,
    bytecode: "0x" + c.evm.bytecode.object,
  }, null, 2));
  console.log("  Artifact saved  :", path.relative(ROOT, artifactPath));
}
