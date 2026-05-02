// Supabase Edge Function: paypal-webhook
// =============================================================================
// Riceve eventi async da PayPal:
//   - PAYMENT.CAPTURE.COMPLETED      (rete sicurezza vs capture sincrona)
//   - PAYMENT.CAPTURE.REFUNDED       (rimborso eseguito)
//   - PAYMENT.CAPTURE.DENIED         (capture rifiutata post-fatto)
//   - CHECKOUT.ORDER.APPROVED        (info, non azione)
//   - CUSTOMER.DISPUTE.CREATED       (apertura controversia)
//
// SICUREZZA:
// - Ogni evento PayPal viene verificato chiamando /v1/notifications/verify-webhook-signature
// - Salviamo in paypal_webhook_events con event_id UNIQUE → idempotenza nativa
// - Errori non bloccanti: ritorniamo 200 anche su problemi interni (PayPal
//   smetterebbe di mandare eventi se rispondessimo 4xx/5xx); logghiamo per debug.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  CORS, json, paypalApi,
  getPayPalCredentials, getPayPalEnv,
} from '../_shared/paypal.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  let event: Record<string, unknown>;
  let rawBody: string;

  try {
    rawBody = await req.text();
    event = JSON.parse(rawBody);
  } catch (e) {
    console.error('[paypal-webhook] body parse failed:', e);
    return json({ ok: false, reason: 'invalid body' }, 200);
  }

  // ── Verifica firma webhook ──
  const verified = await verifyWebhookSignature(req.headers, rawBody);
  if (!verified) {
    console.warn('[paypal-webhook] signature verification FAILED — event rejected');
    // Logghiamo comunque per debug, ma marchiamo come non processato
    await admin.from('paypal_webhook_events').insert({
      event_id:      String(event.id || crypto.randomUUID()),
      event_type:    String(event.event_type || 'UNKNOWN'),
      resource_type: String(event.resource_type || ''),
      raw_payload:   event,
      processed:     false,
      processing_error: 'signature_verification_failed',
    }).select().maybeSingle().catch(() => {});
    return json({ ok: false, reason: 'signature invalid' }, 401);
  }

  // ── Idempotenza ──
  const eventId    = String(event.id || '');
  const eventType  = String(event.event_type || '');
  const resource   = (event.resource || {}) as Record<string, unknown>;
  const resourceId = String(resource.id || '');

  const { data: existing } = await admin
    .from('paypal_webhook_events')
    .select('id, processed')
    .eq('event_id', eventId)
    .maybeSingle();

  if (existing?.processed) {
    return json({ ok: true, alreadyProcessed: true });
  }

  if (!existing) {
    await admin.from('paypal_webhook_events').insert({
      event_id:      eventId,
      event_type:    eventType,
      resource_type: String(event.resource_type || ''),
      resource_id:   resourceId,
      raw_payload:   event,
      processed:     false,
    });
  }

  // ── Routing per tipo ──
  try {
    switch (eventType) {
      case 'PAYMENT.CAPTURE.COMPLETED':
        await handleCaptureCompleted(admin, resource);
        break;
      case 'PAYMENT.CAPTURE.REFUNDED':
        await handleCaptureRefunded(admin, resource);
        break;
      case 'PAYMENT.CAPTURE.DENIED':
        await handleCaptureDenied(admin, resource);
        break;
      case 'CHECKOUT.ORDER.APPROVED':
        // Solo log: la capture la facciamo dal frontend onApprove
        break;
      case 'CUSTOMER.DISPUTE.CREATED':
        await handleDisputeCreated(admin, resource);
        break;
      default:
        console.log('[paypal-webhook] unhandled event_type:', eventType);
    }

    await admin.from('paypal_webhook_events')
      .update({ processed: true, processed_at: new Date().toISOString(), processing_error: null })
      .eq('event_id', eventId);

    return json({ ok: true });
  } catch (e) {
    const msg = (e as Error).message;
    console.error('[paypal-webhook] processing error:', eventType, msg);
    await admin.from('paypal_webhook_events')
      .update({ processed: false, processing_error: msg.slice(0, 500) })
      .eq('event_id', eventId);
    // Ritorniamo 200 per evitare retry infiniti di PayPal su errori applicativi
    // (PayPal retry solo su 4xx/5xx; gli eventi non processati restano nel DB
    // per riconciliazione manuale)
    return json({ ok: false, reason: msg }, 200);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Verifica firma webhook tramite endpoint PayPal /verify-webhook-signature
// ─────────────────────────────────────────────────────────────────────────────
async function verifyWebhookSignature(headers: Headers, rawBody: string): Promise<boolean> {
  const { webhookId } = getPayPalCredentials();
  if (!webhookId) {
    console.warn('[paypal-webhook] PAYPAL_*_WEBHOOK_ID non configurato — skip verifica (NON USARE IN PROD)');
    return getPayPalEnv() === 'sandbox';  // sandbox: tollera; live: rifiuta
  }

  const transmissionId   = headers.get('paypal-transmission-id');
  const transmissionTime = headers.get('paypal-transmission-time');
  const certUrl          = headers.get('paypal-cert-url');
  const authAlgo         = headers.get('paypal-auth-algo');
  const transmissionSig  = headers.get('paypal-transmission-sig');

  if (!transmissionId || !transmissionTime || !certUrl || !authAlgo || !transmissionSig) {
    return false;
  }

  let webhookEvent: Record<string, unknown>;
  try {
    webhookEvent = JSON.parse(rawBody);
  } catch {
    return false;
  }

  const r = await paypalApi('/v1/notifications/verify-webhook-signature', {
    method: 'POST',
    body: JSON.stringify({
      transmission_id:   transmissionId,
      transmission_time: transmissionTime,
      cert_url:          certUrl,
      auth_algo:         authAlgo,
      transmission_sig:  transmissionSig,
      webhook_id:        webhookId,
      webhook_event:     webhookEvent,
    }),
  });
  if (!r.ok) {
    console.error('[paypal-webhook] verify endpoint error:', r.status);
    return false;
  }
  const data = await r.json();
  return data?.verification_status === 'SUCCESS';
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

async function handleCaptureCompleted(admin: ReturnType<typeof createClient>, capture: Record<string, unknown>) {
  // capture.id = capture_id, capture.supplementary_data.related_ids.order_id = order id PayPal
  const captureId = String(capture.id || '');
  const links     = (capture.links || []) as Array<{ rel: string; href: string }>;
  const orderLink = links.find((l) => l.rel === 'up');
  const ppOrderId = orderLink ? orderLink.href.split('/').pop() : null;

  if (!ppOrderId) return;

  const fee = parseFloat(
    ((capture.seller_receivable_breakdown as Record<string, Record<string, string>> | undefined)
      ?.paypal_fee?.value) || '0',
  );

  // Aggiorna order se esiste
  const { data: order } = await admin
    .from('inv_orders')
    .select('id, paypal_status, status')
    .eq('paypal_order_id', ppOrderId)
    .maybeSingle();
  if (!order) return;

  // Se la capture sincrona ha già fatto tutto, aggiorniamo solo eventuali differenze
  await admin.from('inv_orders').update({
    paypal_capture_id: captureId,
    paypal_fee:        fee,
    paypal_status:     'completed',
    status:            'paid',
  }).eq('id', order.id);

  // Crea/aggiorna vendor_payout
  await admin.rpc('create_vendor_payout_for_order', { p_order_id: order.id });
}

async function handleCaptureRefunded(admin: ReturnType<typeof createClient>, refund: Record<string, unknown>) {
  // refund.id = refund_id; il capture refundato è in links rel='up'
  const links     = (refund.links || []) as Array<{ rel: string; href: string }>;
  const captureLink = links.find((l) => l.rel === 'up');
  const captureId = captureLink ? captureLink.href.split('/').pop() : null;
  if (!captureId) return;

  const { data: order } = await admin
    .from('inv_orders')
    .select('id')
    .eq('paypal_capture_id', captureId)
    .maybeSingle();
  if (!order) return;

  await admin.from('inv_orders').update({
    paypal_status: 'refunded',
    status:        'refunded',
  }).eq('id', order.id);

  // Marca anche payment + invalida vendor_payout (cancellato)
  await admin.from('inv_payments').update({
    status: 'refunded',
  }).eq('paypal_capture_id', captureId);

  await admin.from('vendor_payouts').update({
    status: 'cancelled',
    paid_notes: 'Cancellato per refund PayPal',
  }).eq('order_id', order.id);
}

async function handleCaptureDenied(admin: ReturnType<typeof createClient>, capture: Record<string, unknown>) {
  const captureId = String(capture.id || '');
  await admin.from('inv_orders').update({
    paypal_status: 'denied',
    status:        'cancelled',
  }).eq('paypal_capture_id', captureId);
  await admin.from('inv_payments').update({
    status: 'rejected',
  }).eq('paypal_capture_id', captureId);
}

async function handleDisputeCreated(admin: ReturnType<typeof createClient>, dispute: Record<string, unknown>) {
  // Marchio l'ordine come disputed così l'admin lo vede a colpo d'occhio
  const disputedTx = (dispute.disputed_transactions || []) as Array<Record<string, unknown>>;
  const captureId = disputedTx[0] && String((disputedTx[0] as Record<string, string>).seller_transaction_id || '');
  if (!captureId) return;

  const { data: order } = await admin
    .from('inv_orders')
    .select('id')
    .eq('paypal_capture_id', captureId)
    .maybeSingle();
  if (!order) return;

  await admin.from('vendor_payouts').update({
    status: 'disputed',
    paid_notes: 'Controversia PayPal aperta — sospendere pagamento vendor',
  }).eq('order_id', order.id);
}
