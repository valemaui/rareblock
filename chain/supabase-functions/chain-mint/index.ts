// chain/supabase-functions/chain-mint/index.ts
//
// Supabase Edge Function: /functions/v1/chain-mint
//
// POST body: { order_id: string }
// Auth: Bearer JWT dell'admin (Supabase Auth)
//
// Risposta:
//   200 { success: true, certificate_serial, tx_hash, ipfs_metadata_uri, ... }
//   401 { success: false, code: "UNAUTHORIZED" }
//   4xx { success: false, code, error, step }
//   500 { success: false, code, error, step }
//
// Deploy:
//   cd chain
//   supabase functions deploy chain-mint --project-ref rbjaaeyjeeqfpbzyavag
//
// Secrets richiesti (supabase secrets set ...):
//   PINATA_JWT
//   WALLET_MNEMONIC               (master HD seed della piattaforma)
//   CHAIN_RPC_URL                 (Base / Sepolia / Hardhat)
//   CHAIN_ID                      ("8453" | "84532" | "31337")
//   CONTRACT_ADDRESS              ("0x...")
//   VERIFY_URL_BASE               ("https://www.rareblock.eu/chain/verify")
//   TERMS_URL, PRIVACY_URL, etc.

// @ts-ignore - Deno specifier
import { serve }        from "https://deno.land/std@0.224.0/http/server.ts";
// @ts-ignore - Deno specifier
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
// @ts-ignore - Deno specifier
import { ethers }       from "https://esm.sh/ethers@6.13.4";
// @ts-ignore - Deno specifier  
import { Buffer }       from "node:buffer";

// Le librerie pure le importiamo come moduli relativi.
// In Deno, supabase functions deploy le bundla automaticamente.
// @ts-ignore
import { mintCertificate }   from "../../lib/mint-orchestrator.js";
// @ts-ignore
import * as walletLib        from "../../lib/wallet.js";
// @ts-ignore
import * as metadataLib      from "../../lib/metadata.js";
// @ts-ignore
import * as pdfLib           from "../../lib/pdf-certificate.js";
// @ts-ignore
import { PinataClient }      from "../../lib/pinata.js";
// @ts-ignore
import { makeDbAdapter }      from "../_shared/db-adapter.js";
// @ts-ignore
import { makeStorageAdapter } from "../_shared/storage-adapter.js";
// @ts-ignore
import { makeChainAdapter }   from "../_shared/chain-adapter.js";

// ── ENV ──
// @ts-ignore
const SUPABASE_URL          = Deno.env.get("SUPABASE_URL")!;
// @ts-ignore
const SERVICE_ROLE_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// @ts-ignore
const PINATA_JWT            = Deno.env.get("PINATA_JWT")!;
// @ts-ignore
const WALLET_MNEMONIC       = Deno.env.get("WALLET_MNEMONIC")!;
// @ts-ignore
const CHAIN_RPC_URL         = Deno.env.get("CHAIN_RPC_URL")!;
// @ts-ignore
const CHAIN_ID              = Number(Deno.env.get("CHAIN_ID") || "84532");
// @ts-ignore
const CONTRACT_ADDRESS      = Deno.env.get("CONTRACT_ADDRESS")!;
// @ts-ignore
const VERIFY_URL_BASE       = Deno.env.get("VERIFY_URL_BASE") || "https://www.rareblock.eu/chain/verify";
// @ts-ignore
const TERMS_URL             = Deno.env.get("TERMS_URL")       || "https://www.rareblock.eu/legal/terms";
// @ts-ignore
const PRIVACY_URL           = Deno.env.get("PRIVACY_URL")     || "https://www.rareblock.eu/legal/privacy";

// CORS handler (riusabile)
const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (status: number, body: any) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST")    return json(405, { success: false, error: "POST only" });

  try {
    // 1. Parse body
    const body = await req.json().catch(() => null);
    const orderId = body?.order_id;
    if (!orderId || typeof orderId !== "string") {
      return json(400, { success: false, code: "INVALID_INPUT", error: "order_id required" });
    }

    // 2. Auth: caller deve avere un Bearer JWT valido di un admin
    const authHeader = req.headers.get("Authorization") || "";
    const accessToken = authHeader.replace(/^Bearer\s+/i, "");
    if (!accessToken) {
      return json(401, { success: false, code: "UNAUTHORIZED", error: "missing Bearer token" });
    }

    // Resolve admin user_id from the access token (Supabase auth.getUser)
    const sbAuthClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    const { data: userRes, error: userErr } = await sbAuthClient.auth.getUser(accessToken);
    if (userErr || !userRes?.user) {
      return json(401, { success: false, code: "UNAUTHORIZED", error: "invalid token" });
    }
    const adminUserId = userRes.user.id;

    // 3. Build deps tree
    const sb       = createClient(SUPABASE_URL, SERVICE_ROLE_KEY,
                       { auth: { persistSession: false, autoRefreshToken: false }});
    const db       = makeDbAdapter(sb);
    const storage  = makeStorageAdapter(sb);

    const provider = new ethers.JsonRpcProvider(CHAIN_RPC_URL, CHAIN_ID);
    const signer   = ethers.Wallet.fromPhrase(WALLET_MNEMONIC, provider);
    const chain    = makeChainAdapter({
      ethers, signer, contractAddress: CONTRACT_ADDRESS, chainId: CHAIN_ID,
    });

    const pinata   = new PinataClient({ jwt: PINATA_JWT });

    // 4. Run orchestrator
    const result = await mintCertificate(
      { orderId, adminUserId },
      {
        db,
        wallet:   walletLib,
        masterMnemonic: WALLET_MNEMONIC,
        metadata: metadataLib,
        pdf:      pdfLib,
        pinata,
        storage,
        chain,
        config: {
          verifyUrlBase:     VERIFY_URL_BASE,
          externalUrlBase:   VERIFY_URL_BASE,
          termsUrl:          TERMS_URL,
          privacyUrl:        PRIVACY_URL,
          custodian:         "RareBlock S.r.l.",
          vaultJurisdiction: "IT",
          vaultId:           "RB-VAULT-01",
          issuer:            "RareBlock S.r.l.",
          insurance:         true,
          insuranceProvider: "AXA Art Insurance",
          withdrawalPolicyUrl: "https://www.rareblock.eu/legal/withdrawal",
        },
        // Strip events when streaming response (audit log resta nel server-side log)
        logger: (e: any) => console.log(JSON.stringify(e)),
      }
    );

    if (!result.success) {
      const status = result.code === "UNAUTHORIZED"   ? 401
                  : result.code === "INVALID_INPUT"   ? 400
                  : result.code === "ORDER_NOT_FOUND" ? 404
                  : result.code === "ALREADY_MINTED"  ? 409
                  : 500;
      return json(status, { ...result, events: undefined });
    }
    // Success: ritorniamo metadata utili al frontend admin
    return json(200, { ...result, events: undefined });

  } catch (err: any) {
    console.error("chain-mint top-level error:", err);
    return json(500, {
      success: false,
      code: "UNHANDLED",
      error: err?.message || String(err),
    });
  }
});
