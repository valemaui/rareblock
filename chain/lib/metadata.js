// ═══════════════════════════════════════════════════════════════════════
//  chain/lib/metadata.js
//
//  Builder e validator per il JSON metadata ERC-1155 di RareBlock.
//  Il documento prodotto da questa libreria finisce su IPFS — è
//  IMMUTABILE una volta caricato.
//
//  Schema completo: vedi chain/lib/metadata-schema.md
//
//  Design:
//   - Zero dipendenze esterne (deve girare in Node, Deno, edge runtime).
//   - Pure functions: nessun I/O, nessuna network call.
//   - validateMetadata() ritorna un oggetto {valid, errors[]} (no throw),
//     così l'Edge Function può loggare errors[] in chiaro per debug.
//   - buildMetadata() costruisce il JSON da un input "applicativo"
//     (record DB) e applica defaults.
//   - normalizeBigIntString() per token_id: accetta BigInt|number|string
//     e ritorna stringa decimale, evitando precision loss in JSON.
// ═══════════════════════════════════════════════════════════════════════
"use strict";

const SCHEMA_VERSION = "1.0.0";

const ALLOWED_CHAIN_IDS = Object.freeze({
  8453:  "Base",
  84532: "Base Sepolia",
  31337: "Hardhat Local",
});

const ALLOWED_GRADING_COMPANIES = Object.freeze(["PSA", "BGS", "CGC", "SGC", "none"]);
const ALLOWED_CERT_TYPES        = Object.freeze(["fractional_ownership", "full_ownership"]);

// ──────────────────────────────────────────────────────────────────────
//  Utility validators (interni, non esposti)
// ──────────────────────────────────────────────────────────────────────
const isStr     = (v) => typeof v === "string" && v.length > 0;
const isInt     = (v) => Number.isInteger(v);
const isPosInt  = (v) => Number.isInteger(v) && v > 0;
const isBool    = (v) => typeof v === "boolean";
const isObj     = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isArray   = Array.isArray;

const RX_IPFS_URI    = /^ipfs:\/\/[A-Za-z0-9]+(?:\/[\w.\-/]+)?$/;
const RX_AR_URI      = /^ar:\/\/[A-Za-z0-9_-]+$/;
const RX_HTTP_URL    = /^https?:\/\/[^\s]+$/;
const RX_SERIAL      = /^RB-\d{4}-\d{6}$/;
const RX_SHA256_HEX  = /^[a-fA-F0-9]{64}$/;
const RX_TX_HASH     = /^0x[a-fA-F0-9]{64}$/;
const RX_ETH_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const RX_ISO8601     = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?$/;
const RX_HEX_COLOR6  = /^[0-9a-fA-F]{6}$/;
const RX_DEC_STRING  = /^[0-9]+$/;

function isValidISODate(v) {
  if (!isStr(v) || !RX_ISO8601.test(v)) return false;
  const d = new Date(v);
  return !isNaN(d.getTime());
}

// ──────────────────────────────────────────────────────────────────────
//  normalizeBigIntString: token_id ed eventuali altri uint256
//    accetta: BigInt | number | string (decimale o "0x..." hex)
//    ritorna: stringa decimale, mai notazione esponenziale
// ──────────────────────────────────────────────────────────────────────
function normalizeBigIntString(v) {
  if (typeof v === "bigint") return v.toString(10);
  if (typeof v === "number") {
    if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
      throw new Error("Cannot normalize non-positive-integer number to BigInt string: " + v);
    }
    if (v > Number.MAX_SAFE_INTEGER) {
      throw new Error("Number exceeds MAX_SAFE_INTEGER, pass a BigInt or string instead");
    }
    return v.toString(10);
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (RX_DEC_STRING.test(s)) return s;
    if (/^0x[a-fA-F0-9]+$/.test(s)) return BigInt(s).toString(10);
    throw new Error("String is not a valid decimal/hex integer: " + v);
  }
  throw new Error("Unsupported type for BigInt normalization: " + typeof v);
}

// ──────────────────────────────────────────────────────────────────────
//  Validator — ritorna {valid, errors}
//
//  Approach: collect-all-errors invece di fail-fast, così l'utente vede
//  TUTTI i problemi in una passata.
// ──────────────────────────────────────────────────────────────────────
function validateMetadata(meta) {
  const errors = [];
  const push   = (path, msg) => errors.push({ path, msg });

  if (!isObj(meta)) {
    return { valid: false, errors: [{ path: "$", msg: "metadata must be an object" }] };
  }

  // ─── Standard ERC-1155/OpenSea ─────────────────────────────────────
  if (!isStr(meta.name))         push("$.name",         "must be non-empty string");
  if (!isStr(meta.description))  push("$.description",  "must be non-empty string");

  if (!isStr(meta.image)) {
    push("$.image", "must be non-empty string");
  } else if (!RX_IPFS_URI.test(meta.image)) {
    push("$.image", "must be ipfs:// URI (no HTTP — NFT image must be decentralized)");
  }

  if (!isStr(meta.external_url) || !RX_HTTP_URL.test(meta.external_url)) {
    push("$.external_url", "must be a valid http(s) URL");
  }

  if (meta.background_color !== undefined) {
    if (!isStr(meta.background_color) || !RX_HEX_COLOR6.test(meta.background_color)) {
      push("$.background_color", "must be 6-char hex without #");
    }
  }

  if (!isArray(meta.attributes)) {
    push("$.attributes", "must be an array");
  } else {
    meta.attributes.forEach((a, i) => {
      if (!isObj(a)) { push(`$.attributes[${i}]`, "must be object"); return; }
      if (!isStr(a.trait_type)) push(`$.attributes[${i}].trait_type`, "must be non-empty string");
      if (a.value === undefined || a.value === null || a.value === "") {
        push(`$.attributes[${i}].value`, "must be non-null/non-empty");
      }
      // display_type opzionale, ma se presente deve essere uno dei valori OpenSea
      if (a.display_type !== undefined) {
        const ALLOWED = ["number", "boost_number", "boost_percentage", "date"];
        if (!ALLOWED.includes(a.display_type)) {
          push(`$.attributes[${i}].display_type`, `must be one of ${ALLOWED.join(", ")}`);
        }
      }
    });
  }

  // ─── rareblock namespace ───────────────────────────────────────────
  const rb = meta.rareblock;
  if (!isObj(rb)) {
    return { valid: errors.length === 0, errors: [...errors, { path: "$.rareblock", msg: "missing rareblock namespace" }] };
  }

  if (rb.schema_version !== SCHEMA_VERSION) {
    push("$.rareblock.schema_version", `must be exactly "${SCHEMA_VERSION}", got "${rb.schema_version}"`);
  }

  // ─ rareblock.certificate ─
  const c = rb.certificate;
  if (!isObj(c)) {
    push("$.rareblock.certificate", "missing");
  } else {
    if (!isStr(c.serial) || !RX_SERIAL.test(c.serial)) {
      push("$.rareblock.certificate.serial", 'must match "RB-YYYY-NNNNNN"');
    }
    if (!isValidISODate(c.issued_at)) {
      push("$.rareblock.certificate.issued_at", "must be ISO 8601 UTC date");
    }
    if (!isStr(c.issued_by)) push("$.rareblock.certificate.issued_by", "must be non-empty string");
    if (!ALLOWED_CERT_TYPES.includes(c.type)) {
      push("$.rareblock.certificate.type", `must be one of ${ALLOWED_CERT_TYPES.join(", ")}`);
    }
    if (!isStr(c.language) || c.language.length !== 2) {
      push("$.rareblock.certificate.language", "must be 2-letter ISO 639-1");
    }
  }

  // ─ rareblock.asset ─
  const a = rb.asset;
  if (!isObj(a)) {
    push("$.rareblock.asset", "missing");
  } else {
    if (!isStr(a.category))    push("$.rareblock.asset.category",    "must be non-empty string");
    if (!isStr(a.subcategory)) push("$.rareblock.asset.subcategory", "must be non-empty string");
    if (!isStr(a.title))       push("$.rareblock.asset.title",       "must be non-empty string");
    if (a.year !== undefined && !isPosInt(a.year)) {
      push("$.rareblock.asset.year", "must be positive integer");
    }
    if (a.grading !== undefined) {
      if (!isObj(a.grading)) push("$.rareblock.asset.grading", "must be object");
      else {
        if (!ALLOWED_GRADING_COMPANIES.includes(a.grading.company)) {
          push("$.rareblock.asset.grading.company",
            `must be one of ${ALLOWED_GRADING_COMPANIES.join(", ")}`);
        }
        if (a.grading.company !== "none") {
          if (!isPosInt(a.grading.grade) && typeof a.grading.grade !== "number") {
            push("$.rareblock.asset.grading.grade", "must be a number when graded");
          }
          if (!isStr(a.grading.cert_number)) {
            push("$.rareblock.asset.grading.cert_number", "must be non-empty string when graded");
          }
        }
      }
    }
    if (!isObj(a.media))         push("$.rareblock.asset.media",                "missing");
    else {
      if (!isStr(a.media.primary_image) || !RX_IPFS_URI.test(a.media.primary_image)) {
        push("$.rareblock.asset.media.primary_image", "must be ipfs:// URI");
      }
      if (a.media.back_image !== undefined && !RX_IPFS_URI.test(a.media.back_image)) {
        push("$.rareblock.asset.media.back_image", "must be ipfs:// URI when present");
      }
      if (a.media.additional_images !== undefined) {
        if (!isArray(a.media.additional_images)) {
          push("$.rareblock.asset.media.additional_images", "must be array when present");
        } else {
          a.media.additional_images.forEach((img, i) => {
            if (!RX_IPFS_URI.test(img)) {
              push(`$.rareblock.asset.media.additional_images[${i}]`, "must be ipfs:// URI");
            }
          });
        }
      }
    }
  }

  // ─ rareblock.fractional ─ (solo se type === fractional_ownership)
  const f = rb.fractional;
  if (c && c.type === "fractional_ownership") {
    if (!isObj(f)) {
      push("$.rareblock.fractional", "missing (required for fractional_ownership)");
    } else {
      if (!isPosInt(f.shares_total)) {
        push("$.rareblock.fractional.shares_total", "must be positive integer");
      }
      if (!isPosInt(f.shares_in_certificate)) {
        push("$.rareblock.fractional.shares_in_certificate", "must be positive integer");
      }
      if (isPosInt(f.shares_total) && isPosInt(f.shares_in_certificate)) {
        if (f.shares_in_certificate > f.shares_total) {
          push("$.rareblock.fractional.shares_in_certificate",
            `cannot exceed shares_total (${f.shares_in_certificate} > ${f.shares_total})`);
        }
        // share_percentage coerente con il rapporto (tolleranza 0.01)
        if (typeof f.share_percentage === "number") {
          const expected = (f.shares_in_certificate / f.shares_total) * 100;
          if (Math.abs(f.share_percentage - expected) > 0.01) {
            push("$.rareblock.fractional.share_percentage",
              `inconsistent: expected ${expected.toFixed(4)}, got ${f.share_percentage}`);
          }
        }
      }
      if (f.valuation !== undefined) {
        if (!isObj(f.valuation)) push("$.rareblock.fractional.valuation", "must be object");
        else {
          if (!isStr(f.valuation.currency) || f.valuation.currency.length !== 3) {
            push("$.rareblock.fractional.valuation.currency", "must be 3-letter ISO 4217");
          }
          if (typeof f.valuation.asset_total !== "number" || f.valuation.asset_total < 0) {
            push("$.rareblock.fractional.valuation.asset_total", "must be non-negative number");
          }
        }
      }
    }
  }

  // ─ rareblock.blockchain ─
  const b = rb.blockchain;
  if (!isObj(b)) {
    push("$.rareblock.blockchain", "missing");
  } else {
    if (!ALLOWED_CHAIN_IDS[b.chain_id]) {
      push("$.rareblock.blockchain.chain_id",
        `must be one of ${Object.keys(ALLOWED_CHAIN_IDS).join(", ")}`);
    }
    if (!isStr(b.chain_name)) push("$.rareblock.blockchain.chain_name", "must be non-empty string");
    if (!isStr(b.contract_address) || !RX_ETH_ADDRESS.test(b.contract_address)) {
      push("$.rareblock.blockchain.contract_address", "must be 0x-prefixed 40-hex address");
    }
    if (!isStr(b.token_id) || !RX_DEC_STRING.test(b.token_id)) {
      push("$.rareblock.blockchain.token_id",
        "must be a decimal string (use normalizeBigIntString to produce it)");
    }
    if (b.token_standard !== "ERC-1155") {
      push("$.rareblock.blockchain.token_standard", 'must be "ERC-1155"');
    }
    if (!isStr(b.minted_at_tx) || !RX_TX_HASH.test(b.minted_at_tx)) {
      push("$.rareblock.blockchain.minted_at_tx", "must be 0x + 64 hex chars");
    }
  }

  // ─ rareblock.custody ─
  const cu = rb.custody;
  if (!isObj(cu)) {
    push("$.rareblock.custody", "missing");
  } else {
    if (!isStr(cu.custodian))           push("$.rareblock.custody.custodian",          "must be non-empty string");
    if (!isStr(cu.vault_jurisdiction))  push("$.rareblock.custody.vault_jurisdiction", "must be non-empty string");
    if (!isBool(cu.insurance))          push("$.rareblock.custody.insurance",          "must be boolean");
    if (cu.insurance === true && !isStr(cu.insurance_provider)) {
      push("$.rareblock.custody.insurance_provider", "must be set when insurance=true");
    }
  }

  // ─ rareblock.verification ─
  const v = rb.verification;
  if (!isObj(v)) {
    push("$.rareblock.verification", "missing");
  } else {
    if (!isStr(v.pdf_sha256) || !RX_SHA256_HEX.test(v.pdf_sha256)) {
      push("$.rareblock.verification.pdf_sha256", "must be 64 hex chars (SHA-256)");
    }
    if (!isStr(v.qr_payload) || !RX_HTTP_URL.test(v.qr_payload)) {
      push("$.rareblock.verification.qr_payload", "must be http(s) URL");
    }
    if (v.arweave_backup_tx !== undefined && !RX_AR_URI.test(v.arweave_backup_tx)) {
      push("$.rareblock.verification.arweave_backup_tx", "must be ar://... when present");
    }
  }

  // ─ rareblock.compliance ─
  const co = rb.compliance;
  if (!isObj(co)) {
    push("$.rareblock.compliance", "missing");
  } else {
    if (!isStr(co.jurisdiction)) push("$.rareblock.compliance.jurisdiction", "must be non-empty string");
    if (!isStr(co.terms_url) || !RX_HTTP_URL.test(co.terms_url)) {
      push("$.rareblock.compliance.terms_url", "must be http(s) URL");
    }
    if (!isBool(co.is_security)) {
      push("$.rareblock.compliance.is_security", "must be boolean");
    } else if (co.is_security === true) {
      // Hard guard: per design RareBlock NON emette security tokens.
      push("$.rareblock.compliance.is_security",
        "RareBlock certificates must NOT be securities — review compliance");
    }
  }

  return { valid: errors.length === 0, errors };
}

// ──────────────────────────────────────────────────────────────────────
//  Builder
//
//  Input "applicativo": un oggetto piatto con i dati dal DB. Output: JSON
//  metadata pronto per upload IPFS. Applica defaults sensati.
// ──────────────────────────────────────────────────────────────────────
function buildMetadata(input) {
  if (!isObj(input)) throw new Error("buildMetadata: input must be an object");

  // Required app-level fields — falliamo presto con messaggi chiari
  const REQ = [
    "certificate_serial", "issued_at", "type", "language",
    "asset_title", "asset_category", "asset_subcategory",
    "primary_image_ipfs",
    "chain_id", "contract_address", "token_id", "tx_hash_mint",
    "pdf_sha256", "verify_url", "external_url",
    "terms_url",
  ];
  for (const k of REQ) {
    if (input[k] === undefined || input[k] === null || input[k] === "") {
      throw new Error(`buildMetadata: missing required field "${k}"`);
    }
  }

  const tokenIdStr = normalizeBigIntString(input.token_id);
  const chainName  = ALLOWED_CHAIN_IDS[input.chain_id] || `chain ${input.chain_id}`;

  // Display name: marketplace-friendly e leggibile a colpo d'occhio
  const namePieces = [
    "RareBlock Certificate",
    input.asset_title,
    input.asset_set,
    input.asset_year ? String(input.asset_year) : null,
  ].filter(Boolean);
  const displayName = namePieces.join(" · ");

  // Attributes OpenSea-style (solo i campi presenti)
  const attributes = [];
  if (input.asset_set)      attributes.push({ trait_type: "Set",       value: input.asset_set });
  if (input.asset_year)     attributes.push({ trait_type: "Year",      value: input.asset_year, display_type: "number" });
  if (input.asset_rarity)   attributes.push({ trait_type: "Rarity",    value: input.asset_rarity });
  if (input.asset_edition)  attributes.push({ trait_type: "Edition",   value: input.asset_edition });
  if (input.asset_card_number) attributes.push({ trait_type: "Card #", value: input.asset_card_number });
  if (input.asset_language) attributes.push({ trait_type: "Language",  value: input.asset_language });
  if (input.grading_company && input.grading_company !== "none" && input.grading_grade !== undefined) {
    attributes.push({
      trait_type: "Condition",
      value: `${input.grading_company} ${input.grading_grade}`,
    });
  }
  if (input.type === "fractional_ownership" && input.shares_in_certificate && input.shares_total) {
    attributes.push({
      trait_type: "Fraction",
      value: `${input.shares_in_certificate}/${input.shares_total}`,
    });
  }

  // Description: testo professionale, supporta markdown — nel certificato
  // di fractional include il caveat di custody
  const isFractional = input.type === "fractional_ownership";
  const descLines = [
    `**Certificate of ${isFractional ? "fractional co-ownership" : "ownership"}**`,
    "",
    `This certificate represents ${
      isFractional
        ? `**${input.shares_in_certificate}/${input.shares_total} shares** of`
        : "**full ownership** of"
    } a physical collectible held in custody by RareBlock.`,
    "",
    `**Asset:** ${input.asset_title}` +
      (input.asset_set ? ` · ${input.asset_set}` : "") +
      (input.asset_year ? ` (${input.asset_year})` : ""),
    `**Serial:** ${input.certificate_serial}`,
    "",
    "Verify authenticity at " + input.verify_url,
  ];
  const description = descLines.join("\n");

  // Compose final metadata
  const meta = {
    name:        displayName,
    description,
    image:       input.primary_image_ipfs,
    external_url: input.external_url,
    background_color: input.background_color || "0D1117",
    attributes,

    rareblock: {
      schema_version: SCHEMA_VERSION,

      certificate: {
        serial:    input.certificate_serial,
        issued_at: input.issued_at,
        issued_by: input.issued_by || "RareBlock S.r.l.",
        type:      input.type,
        language:  input.language,
      },

      asset: {
        category:    input.asset_category,
        subcategory: input.asset_subcategory,
        title:       input.asset_title,
        ...(input.asset_set         ? { set:         input.asset_set }         : {}),
        ...(input.asset_year        ? { year:        input.asset_year }        : {}),
        ...(input.asset_edition     ? { edition:     input.asset_edition }     : {}),
        ...(input.asset_card_number ? { card_number: input.asset_card_number } : {}),
        ...(input.asset_rarity      ? { rarity:      input.asset_rarity }      : {}),
        ...(input.asset_language    ? { language:    input.asset_language }    : {}),
        ...(input.grading_company && input.grading_company !== "none"
          ? {
              grading: {
                company:     input.grading_company,
                grade:       input.grading_grade,
                cert_number: input.grading_cert_number || "",
                ...(input.grading_graded_at ? { graded_at: input.grading_graded_at } : {}),
              },
            }
          : {}),
        media: {
          primary_image: input.primary_image_ipfs,
          ...(input.back_image_ipfs       ? { back_image:        input.back_image_ipfs }   : {}),
          ...(input.additional_images_ipfs ? { additional_images: input.additional_images_ipfs } : {}),
        },
      },

      ...(isFractional
        ? {
            fractional: {
              shares_total:          input.shares_total,
              shares_in_certificate: input.shares_in_certificate,
              share_percentage:      Number(((input.shares_in_certificate / input.shares_total) * 100).toFixed(4)),
              ...(input.valuation_currency
                ? {
                    valuation: {
                      currency:   input.valuation_currency,
                      asset_total: input.valuation_asset_total || 0,
                      share_unit: input.valuation_share_unit || 0,
                    },
                  }
                : {}),
            },
          }
        : {}),

      blockchain: {
        chain_id:         input.chain_id,
        chain_name:       chainName,
        contract_address: input.contract_address,
        token_id:         tokenIdStr,
        token_standard:   "ERC-1155",
        minted_at_tx:     input.tx_hash_mint,
        ...(input.block_number ? { minted_at_block: input.block_number } : {}),
      },

      custody: {
        custodian:           input.custodian             || "RareBlock S.r.l.",
        vault_jurisdiction:  input.vault_jurisdiction    || "IT",
        ...(input.vault_id            ? { vault_id:            input.vault_id }            : {}),
        insurance:           input.insurance === true,
        ...(input.insurance_provider  ? { insurance_provider:  input.insurance_provider }  : {}),
        ...(input.withdrawal_policy_url ? { withdrawal_policy_url: input.withdrawal_policy_url } : {}),
      },

      verification: {
        ...(input.pdf_url ? { pdf_url: input.pdf_url } : {}),
        pdf_sha256:          input.pdf_sha256,
        qr_payload:          input.verify_url,
        ...(input.explorer_tx_url    ? { explorer_tx_url:    input.explorer_tx_url }    : {}),
        ...(input.explorer_token_url ? { explorer_token_url: input.explorer_token_url } : {}),
        ...(input.ipfs_metadata_cid  ? { ipfs_metadata_cid:  input.ipfs_metadata_cid }  : {}),
        ...(input.arweave_backup_tx  ? { arweave_backup_tx:  input.arweave_backup_tx }  : {}),
      },

      compliance: {
        jurisdiction:           input.compliance_jurisdiction || "IT",
        regulator_disclaimer:   input.regulator_disclaimer
          || "This token represents fractional co-ownership of a physical collectible "
            + "custodied by RareBlock S.r.l. It is not a security and does not represent "
            + "company shares, debt, or any claim on dividends. Transfers are restricted "
            + "to the RareBlock platform.",
        terms_url:              input.terms_url,
        ...(input.privacy_url ? { privacy_url: input.privacy_url } : {}),
        is_security:            false,
        transfer_restrictions:  input.transfer_restrictions
          || "in-platform only via RareBlock marketplace",
      },
    },
  };

  return meta;
}

// ──────────────────────────────────────────────────────────────────────
//  Helper: esempio canonico — Charizard Holo Base Set 1999
//  Usato dai test e dalla documentazione. Self-contained.
// ──────────────────────────────────────────────────────────────────────
function buildExampleCharizard(overrides = {}) {
  const baseInput = {
    certificate_serial: "RB-2026-000042",
    issued_at:          "2026-05-03T14:23:01Z",
    issued_by:          "RareBlock S.r.l.",
    type:               "fractional_ownership",
    language:           "it",

    asset_category:     "tcg_card",
    asset_subcategory:  "pokemon",
    asset_title:        "Charizard Holo",
    asset_set:          "Base Set",
    asset_year:         1999,
    asset_edition:      "1st Edition",
    asset_card_number:  "4/102",
    asset_rarity:       "Holo Rare",
    asset_language:     "EN",
    grading_company:    "PSA",
    grading_grade:      9,
    grading_cert_number:"123456789",
    grading_graded_at:  "2024-08-15",

    primary_image_ipfs: "ipfs://QmExampleCharizardFront/charizard-front.jpg",
    back_image_ipfs:    "ipfs://QmExampleCharizardBack/charizard-back.jpg",

    shares_total:          100,
    shares_in_certificate: 5,
    valuation_currency:    "EUR",
    valuation_asset_total: 125000,
    valuation_share_unit:  1250,

    chain_id:           84532,
    contract_address:   "0xCafEbAbE0123456789aBcDeF0123456789AbCDEF",
    token_id:           70922435100124324324324324324324324324324324324n,
    tx_hash_mint:       "0x" + "ab".repeat(32),
    block_number:       12345678,

    custodian:          "RareBlock S.r.l.",
    vault_jurisdiction: "IT",
    vault_id:           "RB-VAULT-01",
    insurance:          true,
    insurance_provider: "AXA Art Insurance",
    withdrawal_policy_url: "https://www.rareblock.eu/legal/withdrawal",

    pdf_url:            "https://rbjaaeyjeeqfpbzyavag.supabase.co/storage/v1/object/sign/certs/RB-2026-000042.pdf?token=...",
    pdf_sha256:         "f3a8b9c2d1e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0",
    verify_url:         "https://www.rareblock.eu/chain/verify?serial=RB-2026-000042",
    external_url:       "https://www.rareblock.eu/chain/verify?serial=RB-2026-000042",
    explorer_tx_url:    "https://sepolia.basescan.org/tx/0x" + "ab".repeat(32),

    compliance_jurisdiction: "IT",
    terms_url:          "https://www.rareblock.eu/legal/terms",
    privacy_url:        "https://www.rareblock.eu/legal/privacy",
  };
  return buildMetadata({ ...baseInput, ...overrides });
}

// ──────────────────────────────────────────────────────────────────────
module.exports = {
  // Public API
  buildMetadata,
  validateMetadata,
  buildExampleCharizard,
  normalizeBigIntString,
  // Constants (read-only)
  SCHEMA_VERSION,
  ALLOWED_CHAIN_IDS,
};
