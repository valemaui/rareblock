# chain-mint — Supabase Edge Function

Orchestra il flusso di mint completo: data un `order_id`, emette il certificato PDF, lo carica su IPFS via Pinata, e mintha il token ERC-1155 su Base.

## Flusso (13 step)

```
POST /functions/v1/chain-mint
Authorization: Bearer <admin_access_token>
{ "order_id": "uuid" }

  1. Validate input + admin auth
  2. Load order + product + user from DB
  3. Idempotency: già mintato? → return existing
  4. Get/create custodial wallet for user (BIP32 derivation)
  5. Generate serial (RB-2026-NNNNNN) + token_id deterministico
  6. Build PDF certificate (con SHA-256 self-referential)
  7. Upload PDF to Supabase Storage (bucket privato "certificates")
  8. Build IPFS metadata JSON (lib/metadata.js)
  9. Pin metadata su Pinata IPFS → CID
 10. mint(): contract.mintNewProduct(to, tokenId, qty, maxSupply, serial, ipfsURI, pdfHash)
 11. Wait tx receipt
 12. Insert chain_certificates + chain_transfers
 13. Return result

→ 200 OK
{
  "success": true,
  "certificate_serial": "RB-2026-000042",
  "tx_hash": "0x...",
  "block_number": 12345678,
  "ipfs_metadata_cid": "Qm...",
  "ipfs_metadata_uri": "ipfs://Qm...",
  "pdf_url": "https://...supabase.co/storage/v1/object/sign/certificates/...",
  "pdf_sha256": "f3a8...",
  "explorer_tx_url": "https://sepolia.basescan.org/tx/0x...",
  "owner_address": "0x..."
}
```

## Errori

| HTTP | code | Spiegazione |
|---|---|---|
| 400 | `INVALID_INPUT` | order_id mancante o malformato |
| 401 | `UNAUTHORIZED` | JWT mancante o utente non admin |
| 404 | `ORDER_NOT_FOUND` | Ordine inesistente |
| 422 | `ORDER_NOT_PAID` | Stato ordine != payment_received |
| 409 | `ALREADY_MINTED` | Già emesso (idempotency) — ma success=true |
| 500 | `WALLET_DERIVATION` | Problema derivazione HD wallet |
| 500 | `PDF_GENERATION` | Generazione PDF fallita |
| 500 | `STORAGE_UPLOAD` | Upload Supabase Storage fallito |
| 500 | `IPFS_PIN` | Pinata API down/errore |
| 500 | `MINT_TX_FAILED` | Tx on-chain reverted o gas insufficiente |
| 500 | `DB_INSERT_FAILED` | Insert chain_certificates fallito (post-mint) |

In caso di **DB_INSERT_FAILED** dopo un mint riuscito, serve riconciliazione manuale: l'asset è on-chain ma non in DB. Risolvibile lanciando uno script che legge gli eventi `CertificateMinted` del contratto e popola `chain_certificates` retroattivamente.

## Deploy

### Prerequisiti

- Supabase CLI installato (`npm i -g supabase`)
- Migration `028_chain_certificates.sql` applicata sul progetto
- Bucket storage `certificates` creato (privato)
- Smart contract `RareBlockCertificate` deployato e address noto
- HD wallet master mnemonic generato (vedi `scripts/wallet-tools.js`)
- Pinata JWT attivo

### Secrets (UNA VOLTA SOLA)

```bash
cd chain

supabase secrets set \
  PINATA_JWT="eyJ..." \
  WALLET_MNEMONIC="snake capital source ..." \
  CHAIN_RPC_URL="https://sepolia.base.org" \
  CHAIN_ID="84532" \
  CONTRACT_ADDRESS="0x..." \
  VERIFY_URL_BASE="https://www.rareblock.eu/chain/verify" \
  TERMS_URL="https://www.rareblock.eu/legal/terms" \
  PRIVACY_URL="https://www.rareblock.eu/legal/privacy" \
  --project-ref rbjaaeyjeeqfpbzyavag
```

### Deploy della function

```bash
supabase functions deploy chain-mint --project-ref rbjaaeyjeeqfpbzyavag
```

### Test smoke (dopo deploy)

```bash
ADMIN_JWT="eyJ..."   # access token di un user con role='admin' in profiles
ORDER_ID="..."       # un order in stato payment_received

curl -X POST \
  "https://rbjaaeyjeeqfpbzyavag.supabase.co/functions/v1/chain-mint" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d "{\"order_id\":\"$ORDER_ID\"}"
```

## Logging

Tutti gli step emettono eventi JSON in stdout (visibili nei Supabase Functions Logs).

Esempio output di un mint riuscito:

```jsonl
{"ts":"...","level":"info","step":1,"order_id":"...","msg":"validate_input","elapsed_ms":2}
{"ts":"...","level":"info","step":2,"order_id":"...","msg":"load_order","elapsed_ms":85}
{"ts":"...","level":"info","step":4,"order_id":"...","msg":"wallet_ready","derivation_index":42,"address_short":"0xa3F8…F231"}
{"ts":"...","level":"info","step":5,"order_id":"...","msg":"serial_issued","serial":"RB-2026-000042"}
{"ts":"...","level":"info","step":6,"order_id":"...","msg":"pdf_ready","size_bytes":20518,"sha256":"c03ec..."}
{"ts":"...","level":"info","step":7,"order_id":"...","msg":"pdf_uploaded","storage_path":"certs/RB-2026-000042.pdf"}
{"ts":"...","level":"info","step":9,"order_id":"...","msg":"pinata_ok","cid":"QmXxx","size":3937}
{"ts":"...","level":"info","step":11,"order_id":"...","msg":"tx_confirmed","tx_hash":"0x...","block_number":12345678}
{"ts":"...","level":"info","step":13,"order_id":"...","msg":"done","elapsed_ms":11800}
```

**Nessun secret** (mnemonic, private key, JWT) appare mai nei log.
