// chain/supabase-functions/chain-checkout/index.ts
//
// Supabase Edge Function: /functions/v1/chain-checkout
//
// POST body: { listing_id: string, qty: int, payment_method: 'bank_transfer'|'stripe_card'|'paypal' }
// Auth: Bearer JWT del buyer (Supabase Auth)
//
// Response 200:
// {
//   success: true,
//   order: { id, total_cents, payment_method, expires_at, ... },
//   payment: {
//     kind: 'bank_transfer' | 'stripe_card' | 'paypal',
//     // bank_transfer: reference, iban, bic, instructions
//     // stripe_card:   client_secret, publishable_key, payment_intent_id, return_url
//     // paypal:        approve_url, order_id
//   }
// }
//
// Errors: 400/401/403/404/409/500/502 con { success:false, code, error }
//
// Required secrets (supabase secrets set ...):
//   STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY
//   PAYPAL_CLIENT_ID, PAYPAL_SECRET, PAYPAL_ENV ('sandbox'|'live')
//   BANK_IBAN, BANK_ACCOUNT_HOLDER, BANK_BIC
//   APP_BASE_URL (for return URLs)

// @ts-ignore - Deno specifier
import { serve }        from "https://deno.land/std@0.224.0/http/server.ts";
// @ts-ignore - Deno specifier
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// @ts-ignore
import { createCheckoutSession } from "../../lib/checkout-orchestrator.js";
// @ts-ignore
import { makeStripeAdapter }     from "../_shared/stripe-adapter.js";
// @ts-ignore
import { makePayPalAdapter }     from "../_shared/paypal-adapter.js";

// @ts-ignore
const SUPABASE_URL          = Deno.env.get("SUPABASE_URL")!;
// @ts-ignore
const SERVICE_ROLE_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// @ts-ignore
const STRIPE_SECRET_KEY     = Deno.env.get("STRIPE_SECRET_KEY") || "";
// @ts-ignore
const STRIPE_PUBLISHABLE    = Deno.env.get("STRIPE_PUBLISHABLE_KEY") || "";
// @ts-ignore
const PAYPAL_CLIENT_ID      = Deno.env.get("PAYPAL_CLIENT_ID") || "";
// @ts-ignore
const PAYPAL_SECRET         = Deno.env.get("PAYPAL_SECRET") || "";
// @ts-ignore
const PAYPAL_ENV            = (Deno.env.get("PAYPAL_ENV") || "sandbox") as "sandbox"|"live";
// @ts-ignore
const BANK_IBAN             = Deno.env.get("BANK_IBAN") || "";
// @ts-ignore
const BANK_ACCOUNT_HOLDER   = Deno.env.get("BANK_ACCOUNT_HOLDER") || "RareBlock S.r.l.";
// @ts-ignore
const BANK_BIC              = Deno.env.get("BANK_BIC") || "";
// @ts-ignore
const APP_BASE_URL          = Deno.env.get("APP_BASE_URL") || "https://www.rareblock.eu";

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
    // 1) Parse body
    const body = await req.json().catch(() => null);
    if (!body) return json(400, { success: false, code: "INVALID_INPUT", error: "Body required" });

    const { listing_id, qty, payment_method } = body;

    // 2) Auth
    const authHeader = req.headers.get("Authorization") || "";
    const accessToken = authHeader.replace(/^Bearer\s+/i, "");
    if (!accessToken) {
      return json(401, { success:false, code:"UNAUTHORIZED", error:"Bearer token required" });
    }

    // Resolve buyer from token
    const sbWithUserToken = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    const { data: userRes, error: userErr } = await sbWithUserToken.auth.getUser(accessToken);
    if (userErr || !userRes?.user) {
      return json(401, { success:false, code:"UNAUTHORIZED", error:"Invalid token" });
    }
    const buyer = userRes.user;

    // 3) Build deps
    // We use a *user-scoped* client so the create_order RPC sees auth.uid() correctly.
    const sb = sbWithUserToken;

    const db = {
      createOrder: async ({ listingId, qty, paymentMethod }: any) => {
        const { data, error } = await sb.rpc("marketplace_create_order", {
          p_listing_id: listingId,
          p_qty: qty,
          p_payment_method: paymentMethod,
        });
        if (error) throw new Error(error.message);
        return data;
      },
      updateOrderProviderId: async (orderId: string, providerId: string) => {
        // This must use service-role (RLS blocks user updates to marketplace_orders)
        const sbAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const { error } = await sbAdmin
          .from("marketplace_orders")
          .update({ payment_provider_id: providerId })
          .eq("id", orderId);
        if (error) throw new Error(`updateOrderProviderId: ${error.message}`);
      },
      loadOrder: async (orderId: string) => {
        const { data, error } = await sb
          .from("marketplace_orders").select("*").eq("id", orderId).maybeSingle();
        if (error) throw new Error(error.message);
        return data;
      },
    };

    let stripe: any = null;
    if (payment_method === "stripe_card") {
      if (!STRIPE_SECRET_KEY) {
        return json(500, { success:false, code:"CONFIG", error:"Stripe not configured" });
      }
      stripe = makeStripeAdapter({ secretKey: STRIPE_SECRET_KEY });
    }

    let paypal: any = null;
    if (payment_method === "paypal") {
      if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) {
        return json(500, { success:false, code:"CONFIG", error:"PayPal not configured" });
      }
      paypal = makePayPalAdapter({
        clientId: PAYPAL_CLIENT_ID,
        secret:   PAYPAL_SECRET,
        env:      PAYPAL_ENV,
      });
    }

    if (payment_method === "bank_transfer" && !BANK_IBAN) {
      return json(500, { success:false, code:"CONFIG", error:"Bank IBAN not configured" });
    }

    // 4) Run orchestrator
    const result = await createCheckoutSession({
      listingId:     listing_id,
      qty:           Number(qty),
      paymentMethod: payment_method,
      buyerUserId:   buyer.id,
      buyerEmail:    buyer.email,
    }, {
      db, stripe, paypal,
      config: {
        bankIban:             BANK_IBAN,
        bankAccountHolder:    BANK_ACCOUNT_HOLDER,
        bankBic:              BANK_BIC,
        baseUrl:              APP_BASE_URL,
        stripePublishableKey: STRIPE_PUBLISHABLE,
      },
    });

    if (!result.success) {
      const status = result.status || 500;
      return json(status, {
        success: false,
        code: result.code,
        error: result.error,
      });
    }

    return json(200, {
      success: true,
      order:   result.order,
      payment: result.payment,
    });

  } catch (err: any) {
    console.error("chain-checkout top-level error:", err);
    return json(500, {
      success: false,
      code: "UNHANDLED",
      error: err?.message || String(err),
    });
  }
});
