// chain/supabase-functions/chain-paypal-capture/index.ts
//
// Supabase Edge Function: /functions/v1/chain-paypal-capture
//
// Quando il buyer completa il pagamento su PayPal e ritorna al nostro
// return_url (passa per ?token=PP-XXX&PayerID=YYY), il frontend chiama
// questa function per:
//   1. Capture l'ordine PayPal lato server (PayPal API: orders/{id}/capture)
//   2. Mark order paid in DB
//   3. Trigger settlement on-chain
//
// POST body: { order_id: string }   (il marketplace_orders.id)
// Auth: Bearer JWT del buyer
//
// Required secrets:
//   PAYPAL_CLIENT_ID, PAYPAL_SECRET, PAYPAL_ENV
//   SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL

// @ts-ignore - Deno specifier
import { serve }        from "https://deno.land/std@0.224.0/http/server.ts";
// @ts-ignore - Deno specifier
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// @ts-ignore
import { makePayPalAdapter } from "../_shared/paypal-adapter.js";

// @ts-ignore
const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
// @ts-ignore
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// @ts-ignore
const PAYPAL_CLIENT_ID = Deno.env.get("PAYPAL_CLIENT_ID")!;
// @ts-ignore
const PAYPAL_SECRET    = Deno.env.get("PAYPAL_SECRET")!;
// @ts-ignore
const PAYPAL_ENV       = (Deno.env.get("PAYPAL_ENV") || "sandbox") as "sandbox"|"live";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (s: number, b: any) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", ...CORS } });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST")    return json(405, { success: false, error: "POST only" });

  try {
    const body = await req.json().catch(() => null);
    if (!body?.order_id) {
      return json(400, { success: false, code: "INVALID_INPUT", error: "order_id required" });
    }

    // ─── Auth: must be the buyer ────────────────────────────────────────
    const authHeader = req.headers.get("Authorization") || "";
    const accessToken = authHeader.replace(/^Bearer\s+/i, "");
    if (!accessToken) {
      return json(401, { success: false, code: "UNAUTHORIZED", error: "Bearer token required" });
    }
    const sbAuth = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userRes, error: userErr } = await sbAuth.auth.getUser(accessToken);
    if (userErr || !userRes?.user) {
      return json(401, { success: false, code: "UNAUTHORIZED", error: "Invalid token" });
    }
    const buyer = userRes.user;

    // ─── Load order, verify it's the buyer's ────────────────────────────
    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: order, error: ordErr } = await sb
      .from("marketplace_orders")
      .select("id,buyer_user_id,payment_method,payment_status,payment_provider_id,total_cents")
      .eq("id", body.order_id)
      .maybeSingle();
    if (ordErr) return json(500, { success: false, code: "DB_ERROR", error: ordErr.message });
    if (!order) return json(404, { success: false, code: "ORDER_NOT_FOUND" });
    if (order.buyer_user_id !== buyer.id) {
      return json(403, { success: false, code: "FORBIDDEN", error: "Not your order" });
    }
    if (order.payment_method !== "paypal") {
      return json(400, { success: false, code: "WRONG_METHOD", error: "Order is not a PayPal order" });
    }

    // Idempotency: if already paid, just return success
    if (order.payment_status === "paid") {
      return json(200, {
        success: true, status: "already_paid", order_id: order.id,
      });
    }
    if (order.payment_status !== "pending") {
      return json(409, { success: false, code: "BAD_STATE",
        error: `order in payment_status=${order.payment_status}, cannot capture` });
    }
    if (!order.payment_provider_id) {
      return json(409, { success: false, code: "NO_PAYPAL_ORDER",
        error: "Order has no PayPal order id stored" });
    }

    // ─── Capture PayPal order ──────────────────────────────────────────
    const paypal = makePayPalAdapter({
      clientId: PAYPAL_CLIENT_ID,
      secret:   PAYPAL_SECRET,
      env:      PAYPAL_ENV,
    });
    let captureRes;
    try {
      captureRes = await paypal.captureOrder(order.payment_provider_id);
    } catch (e: any) {
      console.error("PayPal capture failed:", e?.message);
      return json(502, { success: false, code: "PAYPAL_CAPTURE_FAILED",
        error: e?.message || String(e) });
    }
    if (!captureRes || captureRes.status !== "COMPLETED") {
      return json(409, { success: false, code: "PAYPAL_NOT_COMPLETED",
        error: `PayPal capture status=${captureRes?.status}` });
    }

    // ─── Mark paid + trigger settlement ────────────────────────────────
    const { error: rpcErr } = await sb.rpc("marketplace_mark_payment_paid", {
      p_order_id: order.id,
      p_payment_provider_id: order.payment_provider_id,
    });
    if (rpcErr) {
      console.error("mark_payment_paid failed:", rpcErr.message);
      // Capture è andato a buon fine ma DB no — admin reconciles
      return json(500, { success: false, code: "MARK_PAID_FAILED",
        error: `PayPal captured but DB update failed: ${rpcErr.message}`,
        paypal_capture_id: captureRes.id });
    }

    // Fire settlement (best-effort)
    const settleUrl = `${SUPABASE_URL}/functions/v1/chain-transfer-secondary`;
    try {
      await fetch(settleUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({ order_id: order.id }),
      });
    } catch (e: any) {
      console.error("settlement trigger failed:", e?.message);
    }

    return json(200, {
      success: true,
      status: "captured_and_settled",
      order_id: order.id,
      paypal_capture_id: captureRes.id,
    });

  } catch (err: any) {
    console.error("paypal-capture top-level:", err);
    return json(500, { success: false, code: "UNHANDLED", error: err?.message });
  }
});
