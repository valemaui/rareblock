// chain/supabase-functions/_shared/db-adapter.js
//
// Adapter Supabase che implementa l'interfaccia `deps.db` richiesta dal
// mint-orchestrator. Lo facciamo nello stesso runtime sia in Node (per
// i test/integration locali) che in Deno (Edge Function), quindi qui
// usiamo un'API minima compatibile con entrambi:
//
//   const sb = createSupabaseClient(supabaseUrl, serviceRoleKey)
//   const db = makeDbAdapter(sb)
//   await db.loadOrder(orderId)
//
// In Deno (Edge Function): import dal CDN
//   import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
// In Node (test):
//   const { createClient } = require("@supabase/supabase-js")
//
// Solo il client viene iniettato; questo file è runtime-agnostic.
"use strict";

/**
 * @param {SupabaseClient} sb — client con SERVICE_ROLE key (bypass RLS)
 * @returns {DbAdapter}
 */
function makeDbAdapter(sb) {
  return {
    // ─── Auth: profili admin ─────────────────────────────────────────
    async isAdmin(userId) {
      const { data, error } = await sb
        .from("profiles").select("role")
        .eq("id", userId).maybeSingle();
      if (error) throw new Error(`isAdmin: ${error.message}`);
      return data?.role === "admin";
    },

    // ─── Order / product / user ──────────────────────────────────────
    async loadOrder(orderId) {
      const { data, error } = await sb
        .from("inv_orders").select("*")
        .eq("id", orderId).maybeSingle();
      if (error) throw new Error(`loadOrder: ${error.message}`);
      return data;
    },
    async loadProduct(productId) {
      const { data, error } = await sb
        .from("inv_products").select("*")
        .eq("id", productId).maybeSingle();
      if (error) throw new Error(`loadProduct: ${error.message}`);
      return data;
    },
    async loadUser(userId) {
      // Combina auth.users (per email) con profiles (per display_name)
      const [{ data: authUser, error: e1 }, { data: profile, error: e2 }] =
        await Promise.all([
          sb.auth.admin.getUserById(userId),
          sb.from("profiles").select("display_name").eq("id", userId).maybeSingle(),
        ]);
      if (e1) throw new Error(`loadUser auth: ${e1.message}`);
      if (e2) throw new Error(`loadUser profile: ${e2.message}`);
      const u = authUser?.user;
      if (!u) return null;
      return {
        id:           u.id,
        email:        u.email,
        display_name: profile?.display_name || u.email,
      };
    },

    // ─── Idempotency ─────────────────────────────────────────────────
    async loadExistingCertificate(orderId) {
      const { data, error } = await sb
        .from("chain_certificates").select("*")
        .eq("order_id", orderId).maybeSingle();
      if (error) throw new Error(`loadExistingCertificate: ${error.message}`);
      return data;
    },

    // ─── Custodial wallet management ─────────────────────────────────
    async getOrCreateUserWallet(userId, walletAddress, derivationIndex) {
      // 1. Già esistente?
      const { data: existing, error: e1 } = await sb
        .from("chain_wallets").select("address, derivation_index")
        .eq("user_id", userId).maybeSingle();
      if (e1) throw new Error(`chain_wallets select: ${e1.message}`);
      if (existing) {
        return {
          address:         existing.address,
          derivationIndex: existing.derivation_index,
        };
      }
      // 2. Address ancora non passato → ritorna prossimo idx libero (caller deriva)
      if (walletAddress === null) {
        const { data: maxRow, error: e2 } = await sb
          .from("chain_wallets").select("derivation_index")
          .order("derivation_index", { ascending: false }).limit(1).maybeSingle();
        if (e2) throw new Error(`chain_wallets max idx: ${e2.message}`);
        const nextIdx = (maxRow?.derivation_index ?? 0) + 1;
        return { address: null, derivationIndex: nextIdx };
      }
      // 3. Insert vero
      const { data: inserted, error: e3 } = await sb
        .from("chain_wallets")
        .insert({
          user_id:          userId,
          address:          walletAddress,
          derivation_index: derivationIndex,
          chain_id:         84532,    // default Sepolia; il DB constraint accetta anche 8453
        })
        .select("address, derivation_index")
        .single();
      if (e3) throw new Error(`chain_wallets insert: ${e3.message}`);
      return {
        address:         inserted.address,
        derivationIndex: inserted.derivation_index,
      };
    },

    // ─── Serial / token id (delegate a Postgres functions) ───────────
    async nextSerial() {
      const { data, error } = await sb.rpc("chain_next_certificate_serial");
      if (error) throw new Error(`nextSerial: ${error.message}`);
      return data;
    },
    async productTokenId(productUuid) {
      const { data, error } = await sb.rpc("chain_product_token_id",
        { p_product_id: productUuid });
      if (error) throw new Error(`productTokenId: ${error.message}`);
      return BigInt(String(data));
    },

    // ─── Inserts ─────────────────────────────────────────────────────
    async insertCertificate(rec) {
      const { data, error } = await sb
        .from("chain_certificates").insert(rec).select("*").single();
      if (error) throw new Error(`insertCertificate: ${error.message}`);
      return data;
    },
    async insertTransfer(rec) {
      const { data, error } = await sb
        .from("chain_transfers").insert(rec).select("*").single();
      if (error) throw new Error(`insertTransfer: ${error.message}`);
      return data;
    },
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { makeDbAdapter };
}
