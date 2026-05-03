# RareBlock — Modulo Chain (NFT Certificates)

Modulo isolato per l'emissione, la verifica e il trasferimento di **certificati di proprietà digitali** dei prodotti RareBlock, ancorati su blockchain **Base** (Coinbase L2).

> ⚠ Questo modulo è **completamente separato** da `pokemon-db.html` e `rareblock-dashboard.html`. Vive nella cartella `/chain/` e si interfaccia con lo schema esistente solo via foreign keys (`inv_holdings`, `inv_orders`, `inv_products`).

---

## Architettura in 30 secondi

```
inv_orders (status=payment_received)
        │
        ▼  admin click "Emetti certificato"
Edge Function: chain-mint
        │
        ├──► IPFS (Pinata)        — metadata JSON + foto
        ├──► Arweave              — backup permanente
        ├──► Supabase Storage     — PDF certificato
        └──► RareBlockCertificate.mintNewProduct(...)  on Base
                │
                ▼
        chain_certificates (DB row)
        chain_transfers (audit)
```

Standard token: **ERC-1155** (un token id per prodotto, balance = numero di quote possedute).
Custodial: **sì** — chiavi gestite dalla piattaforma, l'utente non ha wallet da gestire.

---

## Stack

| Componente            | Tecnologia                                    |
|-----------------------|----------------------------------------------|
| Smart contract        | Solidity 0.8.26, OpenZeppelin v5.6           |
| EVM target            | Cancun (mcopy enabled)                       |
| Chain mainnet         | Base (chainId 8453)                          |
| Chain testnet         | Base Sepolia (chainId 84532)                 |
| Toolchain             | Hardhat 2.22 + ethers v6                     |
| Storage metadata      | IPFS (Pinata) + Arweave backup               |
| Certificate PDF       | Supabase Storage (private bucket + signed URLs) |
| Wallet derivation     | BIP32 HD wallet (master in Supabase Vault)   |

---

## File map

```
chain/
├── README.md                          ← questo file
├── package.json                       ← dipendenze hardhat + openzeppelin
├── hardhat.config.js                  ← config compile + networks Base
├── .env.example                       ← template variabili d'ambiente
├── .gitignore                         ← esclude artifacts/cache/.env
│
├── contracts/
│   └── RareBlockCertificate.sol       ← ERC-1155 production-grade
│
├── test/
│   └── RareBlockCertificate.test.js   ← Hardhat suite (mint, transfer, pause, royalty, access)
│
├── scripts/
│   ├── deploy.js                      ← deploy su Base / Base Sepolia
│   ├── compile-check.js               ← compile validation OFFLINE (solc-js puro)
│   └── abi-check.js                   ← validazione ABI surface (post-compile)
│
└── supabase-functions/                ← stub, da implementare in F2
    ├── chain-mint/
    ├── chain-transfer/
    └── chain-verify/
```

E in DB (separato dal codice):

```
supabase/migrations/028_chain_certificates.sql
   ├── chain_wallets        wallet custodial 1:1 user
   ├── chain_certificates   certificato 1:1 holding
   ├── chain_transfers      audit log on-chain
   ├── v_chain_certificate_public  vista pubblica per verifica esterna
   ├── chain_next_certificate_serial()  → "RB-2026-NNNNNN"
   └── chain_product_token_id(uuid)    → uint120 deterministico
```

---

## Smart contract — RareBlockCertificate

**Address (mainnet)**: `TBD` — popolare dopo deploy F4.
**Address (Sepolia)**: `TBD` — popolare dopo deploy F1.

### Roles

| Ruolo | Holder | Permessi |
|-------|--------|----------|
| `DEFAULT_ADMIN_ROLE` | Gnosis Safe (mainnet) / EOA (testnet) | grant/revoke roles, set royalty |
| `PAUSER_ROLE`        | Gnosis Safe                           | pause / unpause emergency |
| `MINTER_ROLE`        | Server hot wallet                     | mint, custodial transfer, burn |
| `METADATA_ROLE`      | Server signer                         | update non-frozen URIs, freeze |

### Funzioni chiave

```solidity
// Emissione iniziale di un nuovo prodotto
mintNewProduct(
  address to,
  uint256 tokenId,        // = chain_product_token_id(product.id)
  uint256 qty,            // quote da mintare ora
  uint256 maxSupply,      // cap permanente per il prodotto
  string  serial,         // RB-2026-000042
  string  metadataURI,    // ipfs://Qm...
  bytes32 pdfHash         // SHA-256 del PDF certificato
)

// Mint successivo (vendite frazionate progressive)
mintAdditional(address to, uint256 tokenId, uint256 qty)

// Trasferimento secondario (custodial → custodial)
custodialTransfer(
  address from, address to,
  uint256 tokenId, uint256 qty,
  bytes32 reasonHash       // keccak256(inv_orders.id)
)
```

### Eventi pubblici

- `CertificateMinted(tokenId, to, qty, serial, pdfHash, metadataURI)`
- `CustodialTransfer(tokenId, from, to, qty, reasonHash)`
- `MetadataUpdated`, `MetadataFrozen`, `ContractURIUpdated`

### Royalties

ERC-2981 standard, default **2.5%** (250 bps), receiver = treasury RareBlock. Override per-token disponibile.

---

## Workflow di sviluppo

### 1. Setup locale

```bash
cd chain
npm install
cp .env.example .env
# Compila .env con PRIVATE_KEY, ADMIN_ADDRESS, ecc.
```

### 2. Compile validation (offline, sempre disponibile)

```bash
node scripts/compile-check.js
node scripts/abi-check.js
```

L'output atteso è:
```
Compiling with solc 0.8.26+commit.8a97fa7a.Emscripten.clang
Source units loaded: 28
✅ Compilation OK
  ABI entries     : 80
  Bytecode size   : 13,161 bytes
✅ ABI surface matches expectations
```

### 3. Test suite Hardhat (richiede internet per scaricare solc)

```bash
npx hardhat test
```

Coverage attesa:
- Deploy & ruoli
- `mintNewProduct` (success, double-mint revert, empty serial, qty > maxSupply)
- `mintAdditional` (cap rispettato, unknown token revert)
- `custodialTransfer` (success, only-minter)
- Metadata update / freeze
- Pausable (block transfers, resume)
- ERC-2981 royalty info

### 4. Deploy

```bash
# Testnet
npm run deploy:sepolia

# Mainnet (richiede multisig + verifiche legali OK)
npm run deploy:mainnet

# Verify on Basescan (segue le istruzioni stampate dal deploy)
npx hardhat verify --network baseSepolia <ADDRESS> <ARGS...>
```

### 5. DB migration

```bash
# Sul Supabase Dashboard → SQL Editor
# Incolla e esegui: supabase/migrations/028_chain_certificates.sql
```

La migration è **idempotente** (tutti i `CREATE … IF NOT EXISTS` / `DROP POLICY IF EXISTS`). Validata sintatticamente su Postgres 16 con stub Supabase auth/profiles/inv_*.

---

## Stato del modulo

### F1 — Foundation ✅ COMPLETATO

- [x] Smart contract `RareBlockCertificate.sol` (compila, 13KB bytecode)
- [x] OpenZeppelin v5.6 ERC-1155 + Pausable + Burnable + Supply + AccessControl + ERC-2981
- [x] Test suite Hardhat (mint, transfer, pause, royalty, access control)
- [x] ABI surface validator (40 funzioni / 10 eventi / 7 errori custom)
- [x] Hardhat config Base mainnet + Sepolia
- [x] Deploy script con verifica args + balance check
- [x] Migration DB `028_chain_certificates.sql` (validata su Postgres 16)
- [x] Funzioni `chain_next_certificate_serial()` e `chain_product_token_id()`
- [x] Vista pubblica `v_chain_certificate_public` per verifica esterna
- [x] RLS policies (owner-only + admin override)

### F2 — Mint pipeline 🚧 PROSSIMO

- [ ] Edge Function `chain-mint` (Supabase, Deno + ethers v6)
- [ ] HD wallet derivation tramite Supabase Vault (master seed safe)
- [ ] Pinata client per upload IPFS metadata + image
- [ ] Arweave backup client
- [ ] PDF certificato (template Fraunces/Figtree, watermark gold, QR verifica)
- [ ] Trigger admin "Emetti certificato" da `rareblock-admin-users.html` (o pagina nuova)
- [ ] SHA-256 hash del PDF ancorato on-chain
- [ ] Email transazionale al cliente con link blockchain explorer

### F3 — Verify + Portfolio 🟢 PIANIFICATO

- [ ] Pagina pubblica `chain/rareblock-chain-verify.html` (no auth, QR scan friendly)
- [ ] Pagina utente `chain/rareblock-chain-portfolio.html` (i miei certificati + download PDF)
- [ ] Integrazione lettura on-chain via Base RPC (Alchemy)

### F4 — Marketplace P2P + Mainnet 🟢 PIANIFICATO

- [ ] Listing secondario `chain/rareblock-chain-marketplace.html`
- [ ] Trigger `chain-transfer` post-checkout secondario
- [ ] Audit smart contract (CertiK / OpenZeppelin Defender / Spearbit)
- [ ] Deploy mainnet con Gnosis Safe 2-of-3
- [ ] Royalty enforcement check su OpenSea / Blur

---

## Sicurezza & disclaimer

- **Custody**: tutte le chiavi private dei wallet utente sono custodite dal server tramite HD wallet con master seed in Supabase Vault. Backup off-site obbligatorio prima di qualsiasi mint mainnet.
- **Multisig**: il `DEFAULT_ADMIN_ROLE` su mainnet **deve** essere un Gnosis Safe 2-of-3, mai un EOA.
- **Compliance MiCA**: parere legale già acquisito (vedi `/legal/`). Termini d'uso devono chiarire che il certificato rappresenta diritto a un asset fisico custodito, non quote societarie.
- **Pausable**: in caso di emergenza (vulnerability discovery, contestazione legale) l'admin può sospendere tutti i transfer con `pause()`.
- **Mai committare** chiavi private, mnemonics, o variabili `.env`. Il `.gitignore` lo previene.

---

## Verifica esterna di un certificato

Chiunque può verificare un certificato senza login:

1. Aprire `https://www.rareblock.eu/chain/verify?serial=RB-2026-000042` (F3)
2. Oppure scansionare il QR sul PDF
3. Oppure cliccare il tx hash su Basescan: `https://basescan.org/tx/0x...`

I dati esposti pubblicamente (vista `v_chain_certificate_public`):
- Serial certificato
- SHA-256 hash del PDF (verificabile localmente sul file)
- Contract address + token id + chain id
- Tx hash mint + timestamp
- Quantità quote
- Status (minted / transferred / frozen / burned)
- Wallet proprietario anonimizzato (`0x...XXXX`)
- Nome prodotto + immagine

I dati personali del proprietario **non** sono mai esposti pubblicamente né messi on-chain.
