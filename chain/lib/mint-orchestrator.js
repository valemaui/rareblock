// ═══════════════════════════════════════════════════════════════════════
//  chain/lib/mint-orchestrator.js
//
//  Orchestratore della pipeline di mint. Pure logic, runtime-agnostic:
//  riceve dipendenze come parametri (DI) così è testabile in Node con
//  mock e deployabile in Deno (Edge Function) senza modifiche.
//
//  Flusso 13-step:
//    1. Validate input (order_id, admin auth context)
//    2. Load order + product + user from DB
//    3. Idempotency: if already minted → return existing
//    4. Get/create custodial wallet for user
//    5. Generate serial + token_id (deterministic)
//    6. Build PDF certificate (with placeholder tx_hash)
//    7. Upload PDF to private storage → get signed URL
//    8. Build IPFS metadata JSON (with PDF SHA-256 + URL)
//    9. Pin metadata on Pinata → get IPFS CID
//   10. Mint on-chain: contract.mintNewProduct(...)
//   11. Wait for tx receipt
//   12. Insert chain_certificates + chain_transfers (atomic)
//   13. Return result
//
//  Errors: ogni step può fallire. Stato della transazione è documentato
//  nel return: ogni mintCertificate() ritorna { success, step, ... }
//  così l'admin vede esattamente dove si è bloccato il flusso.
// ═══════════════════════════════════════════════════════════════════════
"use strict";

// ──────────────────────────────────────────────────────────────────────
//  Errori custom
// ──────────────────────────────────────────────────────────────────────
class MintError extends Error {
  constructor(code, step, message, cause = null) {
    super(message);
    this.name  = "MintError";
    this.code  = code;
    this.step  = step;
    this.cause = cause;
  }
}

// Codici errore + step in cui possono presentarsi
const ERR = Object.freeze({
  INVALID_INPUT:        { step: 1, code: "INVALID_INPUT" },
  UNAUTHORIZED:         { step: 1, code: "UNAUTHORIZED" },
  ORDER_NOT_FOUND:      { step: 2, code: "ORDER_NOT_FOUND" },
  ORDER_NOT_PAID:       { step: 2, code: "ORDER_NOT_PAID" },
  PRODUCT_NOT_FOUND:    { step: 2, code: "PRODUCT_NOT_FOUND" },
  ALREADY_MINTED:       { step: 3, code: "ALREADY_MINTED" },
  WALLET_DERIVATION:    { step: 4, code: "WALLET_DERIVATION" },
  PDF_GENERATION:       { step: 6, code: "PDF_GENERATION" },
  STORAGE_UPLOAD:       { step: 7, code: "STORAGE_UPLOAD" },
  METADATA_BUILD:       { step: 8, code: "METADATA_BUILD" },
  IPFS_PIN:             { step: 9, code: "IPFS_PIN" },
  MINT_TX_FAILED:       { step: 10, code: "MINT_TX_FAILED" },
  TX_RECEIPT_TIMEOUT:   { step: 11, code: "TX_RECEIPT_TIMEOUT" },
  DB_INSERT_FAILED:     { step: 12, code: "DB_INSERT_FAILED" },
});

// ──────────────────────────────────────────────────────────────────────
//  Utility: structured logger (no PII, no JWT, no privKey)
// ──────────────────────────────────────────────────────────────────────
function makeLogger(orderId) {
  const start = Date.now();
  const log = (level, step, msg, fields = {}) => {
    const elapsed = Date.now() - start;
    // Strip dangerous fields if accidentally passed
    delete fields.private_key;
    delete fields.privateKey;
    delete fields.mnemonic;
    delete fields.jwt;
    delete fields.PINATA_JWT;
    return {
      ts:       new Date().toISOString(),
      level,
      step,
      order_id: orderId,
      msg,
      elapsed_ms: elapsed,
      ...fields,
    };
  };
  return {
    info:  (step, msg, f) => log("info",  step, msg, f),
    warn:  (step, msg, f) => log("warn",  step, msg, f),
    error: (step, msg, f) => log("error", step, msg, f),
  };
}

// ──────────────────────────────────────────────────────────────────────
//  Main orchestrator
// ──────────────────────────────────────────────────────────────────────
/**
 * @param {Object} params
 * @param {string} params.orderId                  inv_orders.id (UUID)
 * @param {string} params.adminUserId              auth.users.id of the admin invoking
 *
 * @param {Object} deps                            Injected dependencies
 * @param {Object} deps.db                         {
 *     loadOrder(orderId),
 *     loadProduct(productId),
 *     loadUser(userId),
 *     loadExistingCertificate(orderId),
 *     getOrCreateUserWallet(userId, walletAddress, derivationIndex),
 *     nextSerial(),
 *     productTokenId(productUuid),
 *     insertCertificate(record),
 *     insertTransfer(record),
 *     isAdmin(userId),
 *   }
 * @param {Object} deps.wallet                     wallet lib (deriveWallet, deriveAddress)
 * @param {string} deps.masterMnemonic             BIP39 mnemonic della piattaforma
 * @param {Object} deps.metadata                   metadata lib (buildMetadata)
 * @param {Object} deps.pdf                        pdf lib (buildCertificatePDF)
 * @param {Object} deps.pinata                     PinataClient instance
 * @param {Object} deps.storage                    {
 *     uploadPdf(serial, buffer)  → { storagePath, signedUrl }
 *   }
 * @param {Object} deps.chain                      {
 *     mintNewProduct({to, tokenId, qty, maxSupply, serial, metadataURI, pdfHash})
 *       → { txHash, blockNumber }
 *     buildExplorerTxUrl(chainId, txHash),
 *     buildExplorerTokenUrl(chainId, contract, tokenId),
 *     contractAddress: '0x...',
 *     chainId: 84532 | 8453 | 31337,
 *   }
 * @param {Object} deps.config                     {
 *     verifyUrlBase: 'https://www.rareblock.eu/chain/verify',
 *     externalUrlBase: 'https://www.rareblock.eu/chain/verify',
 *     termsUrl: '...',
 *     privacyUrl: '...',
 *     custodian: 'RareBlock S.r.l.',
 *     vaultJurisdiction: 'IT',
 *     issuer: 'RareBlock S.r.l.',
 *   }
 * @param {Object} [deps.logger]                   optional structured logger sink
 *
 * @returns {Promise<MintResult>}                  Always resolves; check .success
 */
async function mintCertificate(params, deps) {
  const log = makeLogger(params?.orderId);
  const events = [];
  const emit = (e) => { events.push(e); deps.logger?.(e); };

  // ─── 1. Validate input + admin auth ─────────────────────────────────
  emit(log.info(1, "validate_input"));
  if (!params || typeof params.orderId !== "string" || !params.orderId) {
    return fail(events, ERR.INVALID_INPUT, "orderId is required");
  }
  if (typeof params.adminUserId !== "string" || !params.adminUserId) {
    return fail(events, ERR.INVALID_INPUT, "adminUserId is required");
  }
  // Admin authorization (DB check)
  let isAdmin;
  try {
    isAdmin = await deps.db.isAdmin(params.adminUserId);
  } catch (e) {
    return fail(events, ERR.UNAUTHORIZED, "isAdmin check failed", e);
  }
  if (!isAdmin) {
    return fail(events, ERR.UNAUTHORIZED,
      "user is not in profiles with role='admin'");
  }

  // ─── 2. Load order + product + user ────────────────────────────────
  emit(log.info(2, "load_order"));
  let order, product, user;
  try {
    order = await deps.db.loadOrder(params.orderId);
  } catch (e) {
    return fail(events, ERR.ORDER_NOT_FOUND, `loadOrder failed`, e);
  }
  if (!order) return fail(events, ERR.ORDER_NOT_FOUND, `order ${params.orderId}`);
  if (order.status !== "payment_received" && order.status !== "paid") {
    return fail(events, ERR.ORDER_NOT_PAID,
      `order status is "${order.status}", expected "payment_received"`);
  }
  try {
    product = await deps.db.loadProduct(order.product_id);
    user    = await deps.db.loadUser(order.user_id);
  } catch (e) {
    return fail(events, ERR.PRODUCT_NOT_FOUND, "load product/user failed", e);
  }
  if (!product) return fail(events, ERR.PRODUCT_NOT_FOUND, `product ${order.product_id}`);
  if (!user)    return fail(events, ERR.PRODUCT_NOT_FOUND, `user ${order.user_id}`);

  // ─── 3. Idempotency check ──────────────────────────────────────────
  emit(log.info(3, "idempotency_check"));
  const existing = await deps.db.loadExistingCertificate(params.orderId);
  if (existing) {
    emit(log.warn(3, "already_minted", { certificate_id: existing.id }));
    return {
      success:           true,
      idempotent:        true,
      step:              3,
      certificate_id:    existing.id,
      certificate_serial:existing.certificate_serial,
      tx_hash:           existing.tx_hash_mint,
      events,
    };
  }

  // ─── 4. Custodial wallet for user ──────────────────────────────────
  emit(log.info(4, "wallet_derivation"));
  let userWallet;
  try {
    // Deriva o recupera dal DB (the DB layer decides if existing or new index)
    const { address, derivationIndex } = await deps.db.getOrCreateUserWallet(
      user.id,
      // fallback: deriva on-the-fly per *suggerire* l'indirizzo se è il primo
      // accesso. L'implementazione DB può scegliere se accettarlo o ricalcolare.
      null, null
    );
    if (!address) {
      // Il DB layer ci sta chiedendo di derivare un nuovo wallet
      const nextIdx = derivationIndex;
      const w       = deps.wallet.deriveWallet(deps.masterMnemonic, "user", nextIdx);
      const result  = await deps.db.getOrCreateUserWallet(user.id, w.address, nextIdx);
      userWallet    = { address: result.address, derivationIndex: result.derivationIndex };
    } else {
      userWallet = { address, derivationIndex };
    }
  } catch (e) {
    return fail(events, ERR.WALLET_DERIVATION, "wallet derivation failed", e);
  }
  emit(log.info(4, "wallet_ready", {
    derivation_index: userWallet.derivationIndex,
    address_short:    shortAddress(userWallet.address),
  }));

  // ─── 5. Serial + token_id ──────────────────────────────────────────
  emit(log.info(5, "issue_serial_and_tokenid"));
  let serial, tokenIdBig;
  try {
    serial     = await deps.db.nextSerial();
    tokenIdBig = await deps.db.productTokenId(product.id);
  } catch (e) {
    return fail(events, ERR.DB_INSERT_FAILED, "serial/tokenId generation failed", e);
  }
  if (!/^RB-\d{4}-\d{6}$/.test(serial)) {
    return fail(events, ERR.DB_INSERT_FAILED, `nextSerial returned "${serial}", expected RB-YYYY-NNNNNN`);
  }
  emit(log.info(5, "serial_issued", { serial }));

  // ─── 6. PDF generation ─────────────────────────────────────────────
  emit(log.info(6, "pdf_generation"));
  const issuedAt = new Date().toISOString();
  const verifyUrl = `${deps.config.verifyUrlBase}?serial=${encodeURIComponent(serial)}`;
  let pdfResult;
  try {
    pdfResult = await deps.pdf.buildCertificatePDF({
      certificate_serial:    serial,
      issued_at:             issuedAt,
      type:                  product.type === "fractional" ? "fractional_ownership" : "full_ownership",
      owner_display_name:    user.display_name || user.email || "Owner",
      asset_title:           product.name,
      asset_set:             product.set      || "",
      asset_year:            product.year     || "",
      asset_edition:         product.edition  || "",
      asset_grading:         product.grading_label || "",
      shares_in_certificate: order.qty,
      shares_total:          product.shares_total || 1,
      verify_url:            verifyUrl,
      contract_address:      deps.chain.contractAddress,
      token_id:              tokenIdBig.toString(),
      custodian:             deps.config.custodian,
      jurisdiction:          deps.config.vaultJurisdiction,
    });
  } catch (e) {
    return fail(events, ERR.PDF_GENERATION, "buildCertificatePDF failed", e);
  }
  emit(log.info(6, "pdf_ready", {
    size_bytes: pdfResult.sizeBytes,
    sha256:     pdfResult.sha256,
  }));

  // ─── 7. Upload PDF to storage ──────────────────────────────────────
  emit(log.info(7, "storage_upload"));
  let storage;
  try {
    storage = await deps.storage.uploadPdf(serial, pdfResult.buffer);
  } catch (e) {
    return fail(events, ERR.STORAGE_UPLOAD, "uploadPdf failed", e);
  }
  if (!storage?.signedUrl) {
    return fail(events, ERR.STORAGE_UPLOAD, "uploadPdf did not return signedUrl");
  }
  emit(log.info(7, "pdf_uploaded", { storage_path: storage.storagePath }));

  // ─── 8. Build metadata JSON ────────────────────────────────────────
  emit(log.info(8, "metadata_build"));
  let meta;
  try {
    meta = deps.metadata.buildMetadata({
      certificate_serial: serial,
      issued_at:          issuedAt,
      issued_by:          deps.config.issuer,
      type:               product.type === "fractional" ? "fractional_ownership" : "full_ownership",
      language:           "it",

      asset_category:     product.asset_category    || "tcg_card",
      asset_subcategory:  product.asset_subcategory || "pokemon",
      asset_title:        product.name,
      asset_set:          product.set,
      asset_year:         product.year,
      asset_edition:      product.edition,
      asset_card_number:  product.card_number,
      asset_rarity:       product.rarity,
      asset_language:     product.card_language,
      grading_company:    product.grading_company || "none",
      grading_grade:      product.grading_grade,
      grading_cert_number:product.grading_cert_number,
      grading_graded_at:  product.grading_graded_at,

      primary_image_ipfs: product.primary_image_ipfs,
      back_image_ipfs:    product.back_image_ipfs,
      additional_images_ipfs: product.additional_images_ipfs,

      shares_total:          product.shares_total,
      shares_in_certificate: order.qty,
      valuation_currency:    product.valuation_currency,
      valuation_asset_total: product.valuation_asset_total,
      valuation_share_unit:  product.valuation_share_unit,

      chain_id:           deps.chain.chainId,
      contract_address:   deps.chain.contractAddress,
      token_id:           tokenIdBig,
      // Placeholder: il vero tx hash si conoscerà solo DOPO il mint.
      // Il metadata su IPFS è immutabile, quindi questo campo resta come placeholder.
      // Il vero tx_hash_mint vive solo on-chain e in chain_certificates.
      tx_hash_mint:       "0x" + "00".repeat(32),
      block_number:       null,

      custodian:          deps.config.custodian,
      vault_jurisdiction: deps.config.vaultJurisdiction,
      vault_id:           deps.config.vaultId,
      insurance:          deps.config.insurance === true,
      insurance_provider: deps.config.insuranceProvider,
      withdrawal_policy_url: deps.config.withdrawalPolicyUrl,

      pdf_url:            storage.signedUrl,
      pdf_sha256:         pdfResult.sha256,
      verify_url:         verifyUrl,
      external_url:       verifyUrl,
      explorer_tx_url:    null,  // placeholder, come tx_hash_mint
      compliance_jurisdiction: deps.config.vaultJurisdiction,
      terms_url:          deps.config.termsUrl,
      privacy_url:        deps.config.privacyUrl,
    });

    // Validate prima di mandare a Pinata
    const v = deps.metadata.validateMetadata(meta);
    if (!v.valid) {
      return fail(events, ERR.METADATA_BUILD,
        `metadata validation failed: ${JSON.stringify(v.errors)}`);
    }
  } catch (e) {
    return fail(events, ERR.METADATA_BUILD, "buildMetadata failed", e);
  }

  // ─── 9. Pin metadata on Pinata IPFS ────────────────────────────────
  emit(log.info(9, "pinata_pin"));
  let pin;
  try {
    pin = await deps.pinata.pinJSON(meta, {
      name:      `${serial}.metadata.json`,
      keyvalues: {
        serial,
        chain_id: String(deps.chain.chainId),
        token_id: tokenIdBig.toString(),
      },
    });
  } catch (e) {
    return fail(events, ERR.IPFS_PIN, "pinJSON failed", e);
  }
  const ipfsMetadataUri = `ipfs://${pin.IpfsHash}`;
  emit(log.info(9, "pinata_ok", { cid: pin.IpfsHash, size: pin.PinSize }));

  // ─── 10. Mint on-chain ─────────────────────────────────────────────
  emit(log.info(10, "mint_tx_send"));
  let mintTx;
  try {
    mintTx = await deps.chain.mintNewProduct({
      to:          userWallet.address,
      tokenId:     tokenIdBig,
      qty:         BigInt(order.qty),
      maxSupply:   BigInt(product.shares_total || order.qty),
      serial,
      metadataURI: ipfsMetadataUri,
      pdfHash:     "0x" + pdfResult.sha256,    // bytes32 → 0x + 64 hex
    });
  } catch (e) {
    return fail(events, ERR.MINT_TX_FAILED, "contract.mintNewProduct failed", e);
  }

  // ─── 11. Wait for receipt ──────────────────────────────────────────
  emit(log.info(11, "tx_confirmed", {
    tx_hash:      mintTx.txHash,
    block_number: mintTx.blockNumber,
  }));

  // ─── 12. Insert chain_certificates + chain_transfers ───────────────
  emit(log.info(12, "db_insert"));
  let certificate;
  try {
    certificate = await deps.db.insertCertificate({
      holding_id:            order.holding_id || null,
      order_id:              order.id,
      product_id:            product.id,
      current_owner_user_id: user.id,
      current_owner_wallet:  userWallet.address,
      qty_minted:            order.qty,
      chain_id:              deps.chain.chainId,
      contract_address:      deps.chain.contractAddress,
      token_id:              tokenIdBig.toString(),
      tx_hash_mint:          mintTx.txHash,
      block_number_mint:     mintTx.blockNumber,
      ipfs_metadata_uri:     ipfsMetadataUri,
      ipfs_image_uri:        product.primary_image_ipfs || null,
      certificate_serial:    serial,
      certificate_pdf_url:   storage.signedUrl,
      certificate_pdf_hash:  pdfResult.sha256,
      qr_payload:            verifyUrl,
      status:                "minted",
      created_by:            params.adminUserId,
    });
    await deps.db.insertTransfer({
      certificate_id: certificate.id,
      from_user_id:   null,
      to_user_id:     user.id,
      from_wallet:    "0x" + "00".repeat(20),       // mint = transfer da address(0)
      to_wallet:      userWallet.address,
      qty:            order.qty,
      transfer_type:  "mint",
      tx_hash:        mintTx.txHash,
      block_number:   mintTx.blockNumber,
      reason_hash:    null,
      inv_order_id:   order.id,
    });
  } catch (e) {
    return fail(events, ERR.DB_INSERT_FAILED,
      "DB insert failed AFTER successful mint — manual reconciliation required", e);
  }

  // ─── 13. Done ──────────────────────────────────────────────────────
  emit(log.info(13, "done"));
  return {
    success:               true,
    idempotent:            false,
    step:                  13,
    certificate_id:        certificate.id,
    certificate_serial:    serial,
    token_id:              tokenIdBig.toString(),
    tx_hash:               mintTx.txHash,
    block_number:          mintTx.blockNumber,
    explorer_tx_url:       deps.chain.buildExplorerTxUrl?.(deps.chain.chainId, mintTx.txHash),
    explorer_token_url:    deps.chain.buildExplorerTokenUrl?.(deps.chain.chainId, deps.chain.contractAddress, tokenIdBig.toString()),
    ipfs_metadata_cid:     pin.IpfsHash,
    ipfs_metadata_uri:     ipfsMetadataUri,
    pdf_url:               storage.signedUrl,
    pdf_sha256:            pdfResult.sha256,
    owner_address:         userWallet.address,
    events,
  };
}

// ──────────────────────────────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────────────────────────────
function fail(events, errSpec, message, cause) {
  const event = {
    ts:     new Date().toISOString(),
    level:  "error",
    step:   errSpec.step,
    code:   errSpec.code,
    msg:    message,
    cause:  cause ? String(cause.message || cause) : null,
  };
  events.push(event);
  return {
    success: false,
    step:    errSpec.step,
    code:    errSpec.code,
    error:   message,
    events,
  };
}

function shortAddress(addr) {
  if (!addr || typeof addr !== "string" || addr.length < 10) return "0x?";
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

module.exports = {
  mintCertificate,
  MintError,
  ERR,
};
