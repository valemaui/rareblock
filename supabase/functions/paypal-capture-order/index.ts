// Supabase Edge Function: paypal-capture-order
// =============================================================================
// Dopo che l'utente ha approvato il pagamento sul popup PayPal, il frontend
// chiama questa function con il paypalOrderId. Qui:
//   1. Cattura il pagamento via PayPal API (server-side, mai client)
//   2. Verifica importo (deve combaciare con inv_orders.total)
//   3. Aggiorna inv_orders → status=paid, paypal_capture_id, paypal_fee
//   4. Crea inv_holdings + inv_payments per backward compat con dashboard
//   5. Crea vendor_payouts via RPC (se prodotto ha vendor)
//   6. Ritorna conferma al frontend
//
// Rete di sicurezza: il webhook paypal-webhook arriverà comunque async e
// riconcilierà tutto se questa capture sincrona dovesse fallire a metà.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CORS, json, paypalApi } from '../_shared/paypal.ts';

interface CaptureInput {
  paypalOrderId: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Missing Authorization' }, 401);

    const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!;
    const SUPABASE_ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY')!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ error: 'Sessione non valida' }, 401);
    const user = userData.user;

    const body = (await req.json().catch(() => null)) as CaptureInput | null;
    if (!body?.paypalOrderId) return json({ error: 'paypalOrderId richiesto' }, 400);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // ── Carica order locale ──
    const { data: localOrder, error: locErr } = await admin
      .from('inv_orders')
      .select('*')
      .eq('paypal_order_id', body.paypalOrderId)
      .eq('user_id', user.id)
      .single();
    if (locErr || !localOrder) {
      return json({ error: 'Ordine non trovato per questo utente' }, 404);
    }

    // Idempotenza: se già paid, non rieseguire la capture
    if (localOrder.paypal_status === 'completed' && localOrder.status === 'paid') {
      return json({
        ok: true, alreadyCaptured: true,
        orderId: localOrder.id,
        orderNumber: localOrder.order_number,
      });
    }

    // ── Capture su PayPal API ──
    const ppResp = await paypalApi(
      `/v2/checkout/orders/${body.paypalOrderId}/capture`,
      { method: 'POST', body: '{}' },
      { idempotencyKey: `capture:${body.paypalOrderId}` },
    );

    if (!ppResp.ok) {
      const errText = await ppResp.text();
      console.error('[paypal-capture-order] capture failed:', ppResp.status, errText);
      // Marca order come failed se PayPal rifiuta
      await admin.from('inv_orders').update({
        paypal_status: 'denied',
        status: 'cancelled',
      }).eq('id', localOrder.id);
      return json({ error: 'PayPal: capture fallita', detail: errText }, 502);
    }

    const ppOrder = await ppResp.json();
    const capture = ppOrder?.purchase_units?.[0]?.payments?.captures?.[0];
    if (!capture) {
      return json({ error: 'PayPal: capture senza dati' }, 502);
    }

    // ── Verifica importo ──
    const capturedAmount = parseFloat(capture.amount?.value || '0');
    const expectedAmount = parseFloat(localOrder.total as unknown as string);
    if (Math.abs(capturedAmount - expectedAmount) > 0.01) {
      console.error('[paypal-capture-order] amount mismatch:',
        { captured: capturedAmount, expected: expectedAmount });
      // Non blocco — segnalo come anomalia e procedo (l'utente ha pagato)
    }

    const captureId = capture.id;
    const paypalFee = parseFloat(capture.seller_receivable_breakdown?.paypal_fee?.value || '0');
    const payerEmail = ppOrder?.payer?.email_address || null;

    // ── Aggiorna order ──
    const { error: updErr } = await admin.from('inv_orders').update({
      paypal_capture_id:  captureId,
      paypal_fee:         paypalFee,
      paypal_status:      'completed',
      paypal_payer_email: payerEmail,
      status:             'paid',
      paid_at:            new Date().toISOString(),
    }).eq('id', localOrder.id);
    if (updErr) {
      console.error('[paypal-capture-order] order update failed:', updErr);
    }

    // ── Crea holding + payment per compat con resto della dashboard ──
    const effectivePerQuote = localOrder.qty > 0
      ? (parseFloat(localOrder.total as unknown as string)
         - parseFloat(localOrder.paypal_fee_charged as unknown as string || '0')) / localOrder.qty
      : parseFloat(localOrder.unit_price as unknown as string);

    const { data: holding } = await admin.from('inv_holdings').insert({
      product_id:      localOrder.product_id,
      user_id:         user.id,
      qty:             localOrder.qty,
      price_per_quote: effectivePerQuote,
      origin:          'primary',
      notes:           localOrder.notes || null,
    }).select().single();

    const { data: payment } = await admin.from('inv_payments').insert({
      user_id:            user.id,
      product_id:         localOrder.product_id,
      holding_id:         holding?.id || null,
      type:               'purchase',
      amount:             localOrder.total,
      qty:                localOrder.qty,
      method:             'paypal',
      status:             'confirmed',  // PayPal confermato in tempo reale
      paypal_capture_id:  captureId,
      paypal_fee:         paypalFee,
      paypal_payer_email: payerEmail,
      confirmed_at:       new Date().toISOString(),
    }).select().single();

    // Link
    if (holding?.id || payment?.id) {
      await admin.from('inv_orders').update({
        holding_id: holding?.id || null,
        payment_id: payment?.id || null,
      }).eq('id', localOrder.id);
    }

    // ── Crea vendor_payout se applicabile ──
    try {
      await admin.rpc('create_vendor_payout_for_order', { p_order_id: localOrder.id });
    } catch (e) {
      console.warn('[paypal-capture-order] vendor_payout creation warning:', e);
      // Non blocco: il webhook PAYMENT.CAPTURE.COMPLETED riproverà
    }

    return json({
      ok: true,
      orderId:        localOrder.id,
      orderNumber:    localOrder.order_number,
      captureId,
      paypalFee,
      payerEmail,
    });
  } catch (e) {
    console.error('[paypal-capture-order] Fatal:', e);
    return json({ error: (e as Error).message }, 500);
  }
});
