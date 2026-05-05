// Supabase Edge Function: stripe-webhook
// =============================================================================
// Riceve eventi webhook da Stripe (POST con header Stripe-Signature).
// IMPORTANTE: Stripe richiede risposta 200 entro 30s. Logica idempotente.
//
// Flow:
//   1. Verifica firma HMAC Stripe-Signature con STRIPE_WEBHOOK_SECRET
//   2. INSERT in inv_stripe_events (UNIQUE su stripe_event_id → idempotency)
//      Se già esisteva (replay), ritorna 200 senza riprocessare.
//   3. Switch su event.type:
//      - checkout.session.completed → handler principale
//        a. Estrae metadata.order_id
//        b. Carica session espansa con payment_intent + payment_method
//        c. Chiama RPC mark_order_stripe_paid(order_id, session_id, ...)
//        d. Chiama RPC enqueue_order_paid_email(order_id)
//        e. Marca inv_stripe_events.processed=true
//      - charge.refunded → log + (futuro) refund handler
//      - payment_intent.payment_failed → log
//   4. Risponde sempre 200 a Stripe (anche su errori: errore già loggato
//      in DB, retry su Stripe lato non aggiungerebbe nulla)
//
// SICUREZZA:
// - Firma HMAC obbligatoria (rifiuta tutto senza valid signature)
// - Body letto come testo RAW (necessario per HMAC verify, non JSON.parse
//   prima della verifica)
// - service_role usata per chiamare RPC restricted
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CORS, json, preflight } from './_shared.ts';
import { stripeApi, verifyStripeSignature } from './_shared.ts';

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // ── Verifica firma ──
  const sigHeader = req.headers.get('stripe-signature');
  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  if (!webhookSecret) {
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET non configurato');
    return json({ error: 'webhook secret missing' }, 500);
  }

  // Body raw (NON JSON.parse prima della verifica)
  const rawBody = await req.text();

  const verify = await verifyStripeSignature(rawBody, sigHeader, webhookSecret);
  if (!verify.valid) {
    console.warn('[stripe-webhook] firma non valida:', verify.error);
    return json({ error: 'invalid signature' }, 400);
  }

  // Parse evento
  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return json({ error: 'invalid JSON' }, 400);
  }

  const eventId   = event.id;
  const eventType = event.type;
  const livemode  = !!event.livemode;
  const obj       = event.data?.object || {};

  if (!eventId || !eventType) {
    return json({ error: 'malformed event' }, 400);
  }

  const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ── Idempotency: INSERT con UNIQUE su stripe_event_id ──
  // Se l'INSERT fallisce per UNIQUE violation, evento già processato → ok.
  let orderIdFromEvent: string | null = null;
  let eventDbId: string | null = null;
  try {
    const { data: ins, error: insErr } = await admin
      .from('inv_stripe_events')
      .insert({
        stripe_event_id: eventId,
        event_type: eventType,
        resource_type: obj.object || null,
        resource_id:   obj.id || null,
        livemode,
        api_version: event.api_version || null,
        raw_payload: event,
        processed: false,
      })
      .select('id')
      .single();

    if (insErr) {
      // Duplicate (Postgres unique violation) → evento replay, già processato
      if (insErr.code === '23505') {
        console.log('[stripe-webhook] evento già processato:', eventId);
        return json({ received: true, idempotent: true });
      }
      throw insErr;
    }
    eventDbId = ins?.id || null;
  } catch (e: unknown) {
    console.error('[stripe-webhook] INSERT inv_stripe_events fallito:', e);
    // Risponde 500 → Stripe re-invierà
    return json({ error: 'db insert failed' }, 500);
  }

  // ── Process event ──
  try {
    if (eventType === 'checkout.session.completed') {
      // obj è la Checkout Session completata
      const sessionId = obj.id;
      const orderId   = obj.metadata?.order_id;
      const orderNumber = obj.metadata?.order_number;

      if (!orderId) {
        throw new Error(`metadata.order_id mancante (session ${sessionId})`);
      }
      orderIdFromEvent = orderId;

      // Espandi session per ottenere payment_intent + payment_method
      // (alcuni campi non sono nel payload originale del webhook se non
      // espliciti)
      let pmType: string | null = null;
      let cardBrand: string | null = null;
      let cardLast4: string | null = null;
      let paymentIntent: string | null = obj.payment_intent || null;

      try {
        if (paymentIntent) {
          const pi = await stripeApi(
            `/v1/payment_intents/${paymentIntent}?expand[]=payment_method`,
            'GET',
          );
          const pm = pi?.payment_method;
          if (pm && typeof pm === 'object') {
            pmType    = pm.type || null;
            // Apple/Google Pay arrivano come type='card' con card.wallet.type='apple_pay'|'google_pay'
            const wallet = pm.card?.wallet?.type;
            if (wallet === 'apple_pay')  pmType = 'apple_pay';
            if (wallet === 'google_pay') pmType = 'google_pay';
            cardBrand = pm.card?.brand || null;
            cardLast4 = pm.card?.last4 || null;
          }
        }
      } catch (eExp) {
        console.warn('[stripe-webhook] expand payment_intent fallita:', eExp);
        // Non blocca: i campi method_type/brand/last4 sono nullable
      }

      const amountReceived = obj.amount_total || obj.amount_received || 0;
      const currency       = obj.currency || 'eur';
      const customerId     = obj.customer || null;

      // Chiama RPC mark_order_stripe_paid (idempotent)
      const { error: rpcErr } = await admin.rpc('mark_order_stripe_paid', {
        p_order_id:            orderId,
        p_session_id:          sessionId,
        p_payment_intent_id:   paymentIntent,
        p_customer_id:         customerId,
        p_amount_received:     amountReceived,
        p_currency:            currency,
        p_payment_method_type: pmType,
        p_card_brand:          cardBrand,
        p_card_last4:          cardLast4,
      });
      if (rpcErr) {
        throw new Error(`mark_order_stripe_paid: ${rpcErr.message || rpcErr}`);
      }

      // Enqueue email "pagamento confermato"
      const { error: emailErr } = await admin.rpc('enqueue_order_paid_email', {
        p_order_id: orderId,
      });
      if (emailErr) {
        console.warn('[stripe-webhook] enqueue email fallita (non blocca):', emailErr);
        // Non blocca: il pagamento è già confermato, l'email può essere
        // re-inviata manualmente
      }

      console.log(`[stripe-webhook] ordine ${orderNumber || orderId} confermato (${pmType || 'card'})`);

    } else if (eventType === 'charge.refunded') {
      // Hook futuro: gestire rimborsi automatici
      console.log(`[stripe-webhook] charge.refunded ricevuto (TODO):`, obj.id);

    } else if (eventType === 'payment_intent.payment_failed') {
      const orderId = obj.metadata?.order_id;
      orderIdFromEvent = orderId || null;
      console.warn(`[stripe-webhook] payment failed ordine ${orderId}:`, obj.last_payment_error?.message);
      // Non aggiorniamo lo status: l'ordine resta awaiting_payment, l'utente
      // può ritentare. Stripe gestisce i retry lato cliente.

    } else {
      // Tipi eventi non gestiti: log e ignora
      console.log(`[stripe-webhook] evento non gestito: ${eventType}`);
    }

    // Marca processato con successo
    if (eventDbId) {
      await admin
        .from('inv_stripe_events')
        .update({
          processed: true,
          processed_at: new Date().toISOString(),
          order_id: orderIdFromEvent,
        })
        .eq('id', eventDbId);
    }

    return json({ received: true });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[stripe-webhook] processing error:', msg, e);

    // Marca evento con errore
    if (eventDbId) {
      await admin
        .from('inv_stripe_events')
        .update({
          processed: false,
          processing_error: msg,
          order_id: orderIdFromEvent,
        })
        .eq('id', eventDbId);
    }

    // Risponde 500 → Stripe ri-invierà l'evento (retry policy automatica)
    return json({ error: msg }, 500);
  }
});
