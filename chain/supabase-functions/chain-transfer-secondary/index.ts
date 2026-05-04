// chain/supabase-functions/chain-transfer-secondary/index.ts
//
// Supabase Edge Function: /functions/v1/chain-transfer-secondary
//
// Riceve {order_id} e settla on-chain. Idempotente: se l'ordine è già
// 'transferred' ritorna lo stesso risultato senza fare double transfer.
//
// AUTH: chiamabile DA:
//   - admin-only: lo callano gli admin tramite admin panel (4.5)
//   - service-role: lo callano webhook handler (4.5) o cron job interno
//   In ogni caso il chiamante DEVE essere admin oppure passare il
//   service-role key direttamente.
//
// Deploy:
//   cd chain
//   supabase functions deploy chain-transfer-secondary --project-ref rbjaaeyjeeqfpbzyavag
//
// Required secrets (supabase secrets set ...):
//   WALLET_MNEMONIC, CHAIN_RPC_URL, CHAIN_ID, CONTRACT_ADDRESS

// @ts-ignore - Deno specifier
import { serve }        from "https://deno.land/std@0.224.0/http/server.ts";
// @ts-ignore - Deno specifier
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
// @ts-ignore - Deno specifier
import * as ethers      from "https://esm.sh/ethers@6.13.4";

// @ts-ignore
import { applySettlement } from "../../lib/settlement-orchestrator.js";
// @ts-ignore
import { deriveWallet } from "../../lib/wallet.js";
// @ts-ignore
import { makeChainAdapter } from "../_shared/chain-adapter.js";

// @ts-ignore
const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
// @ts-ignore
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// @ts-ignore
const WALLET_MNEMONIC  = Deno.env.get("WALLET_MNEMONIC")!;
// @ts-ignore
const CHAIN_RPC_URL    = Deno.env.get("CHAIN_RPC_URL")!;
// @ts-ignore
const CHAIN_ID         = parseInt(Deno.env.get("CHAIN_ID") || "84532", 10);
// @ts-ignore
const CONTRACT_ADDRESS = Deno.env.get("CONTRACT_ADDRESS")!;

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
    // ─── Body ──────────────────────────────────────────────────────────
    const body = await req.json().catch(() => null);
    if (!body || !body.order_id) {
      return json(400, { success:false, code:"INVALID_INPUT", error:"order_id required" });
    }

    // ─── Auth: caller deve essere admin o service-role ───────────────
    const authHeader = req.headers.get("Authorization") || "";
    const accessToken = authHeader.replace(/^Bearer\s+/i, "");
    if (!accessToken) {
      return json(401, { success:false, code:"UNAUTHORIZED", error:"Bearer token required" });
    }

    // Service-role key bypassa tutti i check (usato da webhook 4.5)
    const isServiceRole = (accessToken === SERVICE_ROLE_KEY);

    if (!isServiceRole) {
      // Risolvi user → verifica role 'admin'
      const sbU = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: userRes, error: userErr } = await sbU.auth.getUser(accessToken);
      if (userErr || !userRes?.user) {
        return json(401, { success:false, code:"UNAUTHORIZED", error:"Invalid token" });
      }
      const { data: profile } = await sbU.from("profiles")
        .select("role").eq("id", userRes.user.id).maybeSingle();
      if (!profile || profile.role !== "admin") {
        return json(403, { success:false, code:"FORBIDDEN", error:"Admin role required" });
      }
    }

    // ─── Service-role client per RPC che richiedono service_role ───────
    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // ─── Build chain adapter ────────────────────────────────────────────
    const provider = new ethers.JsonRpcProvider(CHAIN_RPC_URL, {
      chainId: CHAIN_ID, name: `chain-${CHAIN_ID}`,
    });
    // The MINTER signer: same canonical derivation as chain-mint
    const signer = ethers.Wallet.fromPhrase(WALLET_MNEMONIC, provider);
    const chainAdapter = makeChainAdapter({
      ethers, signer, contractAddress: CONTRACT_ADDRESS, chainId: CHAIN_ID,
    });

    // ─── Build deps for orchestrator ────────────────────────────────────
    const db = {
      loadOrderForSettle: async (orderId: string) => {
        const { data, error } = await sb
          .from("v_marketplace_orders_to_settle")
          .select("*")
          .eq("order_id", orderId)
          .maybeSingle();
        if (error) throw new Error(error.message);
        if (data) return data;
        // If not in the view, the order may already be transferred.
        // Look it up directly to allow the orchestrator's idempotency path.
        const { data: ord, error: ordErr } = await sb
          .from("marketplace_orders")
          .select("id, listing_id, certificate_id, buyer_user_id, seller_user_id, qty, payment_status, settlement_status, settlement_tx_hash")
          .eq("id", orderId)
          .maybeSingle();
        if (ordErr) throw new Error(ordErr.message);
        if (!ord) return null;
        // Adapt shape to match the view
        return { ...ord, order_id: ord.id };
      },

      getOrCreateBuyerWallet: async (userId: string) => {
        // Step 1: lookup esistente
        const { data: existing, error: e1 } = await sb
          .from("chain_wallets").select("address, derivation_index")
          .eq("user_id", userId).maybeSingle();
        if (e1) throw new Error(`chain_wallets lookup: ${e1.message}`);
        if (existing?.address) return existing.address;

        // Step 2: pick next derivation index
        const { data: maxRow, error: e2 } = await sb
          .from("chain_wallets").select("derivation_index")
          .order("derivation_index", { ascending: false })
          .limit(1).maybeSingle();
        if (e2) throw new Error(`chain_wallets max idx: ${e2.message}`);
        const nextIdx = (maxRow?.derivation_index ?? 0) + 1;

        // Step 3: deriva wallet HD per "user" role
        const w = deriveWallet(WALLET_MNEMONIC, "user", nextIdx);

        // Step 4: persist
        const { error: e3 } = await sb.from("chain_wallets").insert({
          user_id: userId,
          address: w.address,
          derivation_index: nextIdx,
          chain_id: CHAIN_ID,
        });
        if (e3 && !/duplicate/i.test(e3.message)) throw new Error(`chain_wallets insert: ${e3.message}`);
        return w.address;
      },

      nextSerial: async () => {
        const { data, error } = await sb.rpc("chain_next_certificate_serial");
        if (error) throw new Error(error.message);
        return data;
      },

      applySettlement: async (args: any) => {
        const { data, error } = await sb.rpc("marketplace_apply_settlement", {
          p_order_id:       args.orderId,
          p_tx_hash:        args.txHash,
          p_block_number:   args.blockNumber,
          p_reason_hash:    args.reasonHash,
          p_buyer_wallet:   args.buyerWallet,
          p_new_serial:     args.newSerial,
          p_buyer_user_id:  args.buyerUserId,
        });
        if (error) throw new Error(error.message);
        // RPC returns a row set; pick first
        const row = Array.isArray(data) ? data[0] : data;
        return {
          seller_cert_id: row.seller_cert_id,
          buyer_cert_id:  row.buyer_cert_id,
          transfer_id:    row.transfer_id,
          was_idempotent: row.was_idempotent,
        };
      },
    };

    const chain = {
      computeReasonHash: (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s)),
      custodialTransfer: chainAdapter.custodialTransfer,
    };

    // ─── Run orchestrator ─────────────────────────────────────────────
    const result = await applySettlement({ orderId: body.order_id }, { db, chain });

    if (!result.success) {
      return json(result.status || 500, {
        success: false,
        code: result.code,
        error: result.error,
        step: result.step,
      });
    }

    return json(200, {
      success: true,
      order_id: result.order_id,
      tx_hash: result.tx_hash,
      block_number: result.block_number,
      seller_cert_id: result.seller_cert_id,
      buyer_cert_id: result.buyer_cert_id,
      transfer_id: result.transfer_id,
      was_idempotent: result.was_idempotent,
    });

  } catch (err: any) {
    console.error("chain-transfer-secondary top-level:", err);
    return json(500, {
      success: false,
      code: "UNHANDLED",
      error: err?.message || String(err),
    });
  }
});
