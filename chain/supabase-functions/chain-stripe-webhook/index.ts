// chain/supabase-functions/chain-stripe-webhook/index.ts
//
// Supabase Edge Function: /functions/v1/chain-stripe-webhook
//
// Stripe POSTa qui ad ogni evento configurato. Noi gestiamo:
//   - payment_intent.succeeded   → marca order paid + trigger settlement
//   - payment_intent.payment_failed → notes only, niente status change
//   - charge.refunded            → notes only (refund flow è admin manual)
//
// IMPORTANTE: Il webhook deve rispondere 200 SEMPRE che la firma sia
// valida, anche se internamente abbiamo errori. Stripe altrimenti riprova
// in loop. Se la chain transfer fallisce, registriamo nei log e lasciamo
// l'admin a riconciliare manualmente via panel.
//
// Configurazione Stripe Dashboard:
//   https://dashboard.stripe.com/webhooks
//   - URL: https://rbjaaeyjeeqfpbzyavag.supabase.co/functions/v1/chain-stripe-webhook
//   - Events: payment_intent.succeeded, payment_intent.payment_failed,
//             charge.refunded
//   - Copy 'whsec_...' to STRIPE_WEBHOOK_SECRET env
//
// Required secrets:
//   STRIPE_WEBHOOK_SECRET, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL,
//   APP_BASE_URL (for triggering chain-transfer-secondary internally)

// @ts-ignore - Deno specifier
import { serve }        from "https://deno.land/std@0.224.0/http/server.ts";
// @ts-ignore - Deno specifier
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// @ts-ignore
import { constructEvent, StripeWebhookError } from "../_shared/stripe-webhook-verify.js";

// @ts-ignore
const SUPABASE_URL          = Deno.env.get("SUPABASE_URL")!;
// @ts-ignore
const SERVICE_ROLE_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// @ts-ignore
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

const json = (status: number, body: any) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  // ─── 1. Read raw body + signature header ─────────────────────────────
  const sigHeader = req.headers.get("stripe-signature") || "";
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch (e) {
    return json(400, { error: "cannot read body" });
  }

  // ─── 2. Verify signature ─────────────────────────────────────────────
  let event;
  try {
    event = await constructEvent(rawBody, sigHeader, STRIPE_WEBHOOK_SECRET, 300);
  } catch (err: any) {
    console.error("Stripe webhook signature failed:", err?.code, err?.message);
    // 400 (NOT 401) per Stripe: spiega che la firma è invalida; non riprovano
    return json(400, { error: "signature verification failed", code: err?.code });
  }

  console.log(`Stripe event ${event.id} (${event.type})`);

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    // ─── 3. Dispatch on event type ────────────────────────────────────
    if (event.type === "payment_intent.succeeded") {
      const pi = event.data.object;
      const orderId = pi.metadata?.marketplace_order_id;
      if (!orderId) {
        console.warn(`PI ${pi.id} succeeded but no marketplace_order_id metadata — skipping`);
        return json(200, { received: true, action: "skipped_no_order_id" });
      }

      // 3a) Mark order paid (idempotent)
      const { error: rpcErr } = await sb.rpc("marketplace_mark_payment_paid", {
        p_order_id: orderId,
        p_payment_provider_id: pi.id,
      });
      if (rpcErr) {
        console.error(`mark_payment_paid failed for order ${orderId}: ${rpcErr.message}`);
        // Tornare 500 farebbe Stripe ritentare. Per evitare loop su errori
        // permanenti lo logghiamo e ritorniamo 200; admin riconcilia.
        return json(200, { received: true, action: "logged_db_error", error: rpcErr.message });
      }

      // 3b) Trigger settlement on-chain (fire-and-forget interno)
      const settleUrl = `${SUPABASE_URL}/functions/v1/chain-transfer-secondary`;
      try {
        const r = await fetch(settleUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
          },
          body: JSON.stringify({ order_id: orderId }),
        });
        const txt = await r.text();
        if (!r.ok) {
          console.error(`chain-transfer-secondary returned ${r.status}: ${txt.slice(0,200)}`);
          // Admin reconcilia via panel
        } else {
          console.log(`Settlement triggered for order ${orderId}: ${txt.slice(0,200)}`);
        }
      } catch (e: any) {
        console.error(`chain-transfer-secondary call failed: ${e?.message}`);
      }

      return json(200, { received: true, action: "marked_paid_and_settle_triggered", order_id: orderId });
    }

    if (event.type === "payment_intent.payment_failed") {
      const pi = event.data.object;
      const orderId = pi.metadata?.marketplace_order_id;
      const reason = pi.last_payment_error?.message || "unknown";
      console.log(`PI ${pi.id} failed for order ${orderId}: ${reason}`);
      // Non cambiamo lo stato: l'utente può riprovare il pagamento.
      // Lasciamo il listing 'reserved' fino a expire o nuovo tentativo riuscito.
      return json(200, { received: true, action: "logged_failure" });
    }

    if (event.type === "charge.refunded") {
      // Refund flow è gestito separatamente (admin panel + RPC apposita).
      // Qui solo log per audit.
      const charge = event.data.object;
      console.log(`Charge refunded: ${charge.id} amount=${charge.amount_refunded}`);
      return json(200, { received: true, action: "logged_refund" });
    }

    // Eventi non gestiti: log e accept
    console.log(`Unhandled event type: ${event.type}`);
    return json(200, { received: true, action: "ignored" });

  } catch (err: any) {
    console.error("Webhook top-level error:", err);
    // Anche su errore interno torniamo 200 per evitare loop di retry
    return json(200, { received: true, action: "error_logged", error: err?.message });
  }
});
