# RareBlock Certificate — JSON Metadata Schema

Documento di riferimento per il JSON che finisce su IPFS per ogni certificato emesso. Questo schema è **versionato** (`schema_version`) e ogni cambio incrementa il numero. Il file è immutabile una volta caricato su IPFS — qualsiasi modifica genera un nuovo CID.

---

## Top-level structure

```jsonc
{
  // ─── ERC-1155 / OpenSea standard fields (mandatory) ──────────────────
  "name":          "RareBlock Certificate · Charizard Holo · 1st Ed Base Set",
  "description":   "Certificate of fractional co-ownership ...",
  "image":         "ipfs://QmXxx.../card.jpg",       // foto carta principale
  "external_url":  "https://www.rareblock.eu/chain/verify?serial=RB-2026-000042",
  "background_color": "0D1117",                       // hex senza #
  "attributes": [                                     // OpenSea-style traits
    { "trait_type": "Set",        "value": "Base Set" },
    { "trait_type": "Year",       "value": 1999, "display_type": "number" },
    { "trait_type": "Rarity",     "value": "Holo Rare" },
    { "trait_type": "Condition",  "value": "PSA 9" },
    { "trait_type": "Edition",    "value": "1st Edition" }
  ],

  // ─── RareBlock custom namespace (mandatory) ──────────────────────────
  "rareblock": {
    "schema_version":   "1.0.0",
    "certificate":      { ... },   // dati del certificato emesso
    "asset":            { ... },   // dati del prodotto fisico custodito
    "fractional":       { ... },   // info su quote, supply, ownership
    "blockchain":       { ... },   // info on-chain
    "custody":          { ... },   // dove sta l'oggetto fisico
    "verification":     { ... },   // hash PDF, QR, links di verifica
    "compliance":       { ... }    // jurisdiction, terms, MiCA disclaimer
  }
}
```

---

## Campi standard ERC-1155

| Campo               | Tipo     | Obbligatorio | Note |
|---------------------|----------|--------------|------|
| `name`              | string   | ✅ | Display name su OpenSea |
| `description`       | string   | ✅ | Descrizione lunga, supporta markdown |
| `image`             | string   | ✅ | `ipfs://CID/path` — sempre IPFS, mai HTTP gateway |
| `external_url`      | string   | ✅ | Link alla pagina verify pubblica |
| `background_color`  | string   | ⚪ | 6-char hex, no `#` |
| `attributes`        | array    | ✅ | OpenSea attribute schema |
| `animation_url`     | string   | ⚪ | Per video/3D in futuro |

---

## Namespace `rareblock`

### `rareblock.schema_version`

Stringa SemVer. Versione corrente: `"1.0.0"`. Un cambio di formato non-retrocompatibile bumpa MAJOR.

### `rareblock.certificate`

```jsonc
{
  "serial":              "RB-2026-000042",
  "issued_at":           "2026-05-03T14:23:01Z",      // ISO 8601 UTC
  "issued_by":           "RareBlock S.r.l.",
  "type":                "fractional_ownership",       // | "full_ownership"
  "language":            "it"                          // ISO 639-1
}
```

### `rareblock.asset`

Descrive l'oggetto fisico custodito.

```jsonc
{
  "category":            "tcg_card",                   // taxonomia interna
  "subcategory":         "pokemon",
  "title":               "Charizard Holo",
  "set":                 "Base Set",
  "year":                1999,
  "edition":             "1st Edition",
  "card_number":         "4/102",
  "rarity":              "Holo Rare",
  "language":            "EN",                         // ISO 639-1
  "grading": {
    "company":           "PSA",                        // PSA | BGS | CGC | none
    "grade":             9,
    "cert_number":       "12345678",
    "graded_at":         "2024-08-15"
  },
  "media": {
    "primary_image":     "ipfs://QmXxx.../front.jpg",
    "back_image":        "ipfs://QmXxx.../back.jpg",
    "additional_images": [
      "ipfs://QmXxx.../slab-front.jpg",
      "ipfs://QmXxx.../slab-back.jpg"
    ]
  }
}
```

### `rareblock.fractional`

Info sulla frazione che il certificato rappresenta. **Solo per type = `fractional_ownership`** — assente per oggetti full.

```jsonc
{
  "shares_total":        100,         // totale supply on-chain del token
  "shares_in_certificate": 5,         // quante quote questo specifico certificato rappresenta
  "share_percentage":    5.0,         // % calcolata, ridondante ma utile per UI
  "valuation": {
    "currency":          "EUR",
    "asset_total":       125000,      // valore totale stimato dell'asset
    "share_unit":        1250         // valore di 1 quota
  }
}
```

### `rareblock.blockchain`

```jsonc
{
  "chain_id":            8453,                         // 84532 = sepolia
  "chain_name":          "Base",
  "contract_address":    "0xCafe...",
  "token_id":            "70922...43210",              // string per evitare overflow JS
  "token_standard":      "ERC-1155",
  "minted_at_tx":        "0xabc...",
  "minted_at_block":     12345678
}
```

### `rareblock.custody`

```jsonc
{
  "custodian":           "RareBlock S.r.l.",
  "vault_jurisdiction":  "IT",
  "vault_id":            "RB-VAULT-01",                // identificativo opaco
  "insurance":           true,
  "insurance_provider":  "AXA Art Insurance",
  "withdrawal_policy_url": "https://www.rareblock.eu/legal/withdrawal"
}
```

### `rareblock.verification`

Tutto ciò che serve a chi vuole verificare l'autenticità del certificato senza fidarsi di noi.

```jsonc
{
  "pdf_url":             "https://...",                // signed URL Supabase
  "pdf_sha256":          "f3a8...e92b",                // hash anche on-chain
  "qr_payload":          "https://www.rareblock.eu/chain/verify?serial=RB-2026-000042",
  "explorer_tx_url":     "https://basescan.org/tx/0xabc...",
  "explorer_token_url":  "https://basescan.org/token/0xCafe...?a=70922...",
  "ipfs_metadata_cid":   "QmYyy...",                   // self-reference (CID di QUESTO file)
  "arweave_backup_tx":   "ar://abc..."                 // optional
}
```

### `rareblock.compliance`

Disclaimer e riferimenti legali. Statici per la maggior parte.

```jsonc
{
  "jurisdiction":        "IT",
  "regulator_disclaimer": "This token represents fractional co-ownership ...",
  "terms_url":           "https://www.rareblock.eu/legal/terms",
  "privacy_url":         "https://www.rareblock.eu/legal/privacy",
  "is_security":         false,                        // mai una security per design
  "transfer_restrictions": "in-platform only via RareBlock marketplace"
}
```

---

## Regole di validazione

Il validator (`metadata.js → validateMetadata()`) impone:

- Tutti i campi `required` presenti
- `image`, `external_url`, `media.*_image`, `verification.pdf_url` ben formati (URI scheme valido)
- `image` e `media.*_image` **devono** essere `ipfs://...` (mai HTTP — l'NFT non deve dipendere da server proprietari)
- `pdf_sha256` è 64 caratteri hex
- `chain_id` è in `{8453, 84532, 31337}` (Base mainnet, Base Sepolia, Hardhat local)
- `serial` matcha `^RB-\d{4}-\d{6}$`
- `shares_in_certificate` ≤ `shares_total`
- `share_percentage` = `shares_in_certificate / shares_total * 100` (entro tolleranza floating point)
- Date ISO 8601 valide
- `token_id` è una stringa numerica (per non perdere precisione su uint256 in JS)

---

## Esempio completo

Vedi `chain/test/metadata.test.js` → "esempio reale Charizard Holo Base Set 1999". Il test genera un JSON valido completo che puoi visualizzare con:

```bash
cd chain && node -e "console.log(JSON.stringify(require('./lib/metadata').buildExampleCharizard(), null, 2))"
```
