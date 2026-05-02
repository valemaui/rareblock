// Supabase Edge Function: paypal-create-order
// =============================================================================
// L'utente ha cliccato "Paga con PayPal" sul checkout.
// Questa function:
//   1. Verifica sessione utente
//   2. Carica product + qty dal body
//   3. Calcola subtotal + sconto volume + fee user-facing SERVER-SIDE
//      (mai fidarsi del client per importi)
//   4. Crea l'order su PayPal API con il totale corretto
//   5. Salva paypal_order_id su inv_orders (creando se serve)
//   6. Ritorna { paypalOrderId, orderId, breakdown } al frontend
//
// SICUREZZA:
// - Importi calcolati server-side dal product_id+qty
// - JWT utente verificato via SUPABASE_ANON_KEY
// - Service role key usata solo per scrittura DB privilegiata
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  CORS, json, paypalApi, getPayPalEnv,
  calcUserFacingFee, getPayPalFeeConfig,
} from '../_shared/paypal.ts';

interface CreateOrderInput {
  product_id: string;
  qty: number;
  bill?: Record<string, unknown>;
  notes?: string | null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  try {
    // ── Autenticazione utente ──
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

    // ── Input ──
    const body = (await req.json().catch(() => null)) as CreateOrderInput | null;
    if (!body || !body.product_id || !body.qty || body.qty < 1) {
      return json({ error: 'product_id e qty richiesti' }, 400);
    }

    // ── Carica prodotto + sconti volume server-side ──
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: product, error: prodErr } = await admin
      .from('inv_products')
      .select('id, name, price_per_quote, status, total_quotes, vendor_id')
      .eq('id', body.product_id)
      .single();
    if (prodErr || !product) return json({ error: 'Prodotto non trovato' }, 404);
    if (product.status !== 'open' && product.status !== 'closing_soon') {
      return json({ error: 'Prodotto non acquistabile' }, 409);
    }

    // Sconti volume
    const { data: tiers } = await admin
      .from('volume_discounts')
      .select('min_qty, discount_pct')
      .eq('product_id', product.id)
      .order('min_qty', { ascending: false });

    const unitPrice = parseFloat(product.price_per_quote as unknown as string);
    const gross = Math.round(unitPrice * body.qty * 100) / 100;
    let discountPct = 0;
    let appliedTier = null;
    if (tiers && tiers.length) {
      for (const t of tiers) {
        if (body.qty >= t.min_qty) {
          discountPct = parseFloat(t.discount_pct as unknown as string);
          appliedTier = t;
          break;
        }
      }
    }
    const discountAmount = Math.round(gross * discountPct / 100 * 100) / 100;
    const subtotalNet = Math.round((gross - discountAmount) * 100) / 100;
    const feeCfg = getPayPalFeeConfig();
    const userFee = calcUserFacingFee(subtotalNet, feeCfg);
    const totalToPay = Math.round((subtotalNet + userFee) * 100) / 100;

    if (totalToPay < 1) {
      return json({ error: 'Importo minimo non raggiunto' }, 400);
    }

    // ── Crea ordine PayPal ──
    const ppPayload = {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: product.id,
        description: `${product.name} × ${body.qty}`.slice(0, 127),
        amount: {
          currency_code: 'EUR',
          value: totalToPay.toFixed(2),
          breakdown: {
            item_total:  { currency_code: 'EUR', value: subtotalNet.toFixed(2) },
            handling:    { currency_code: 'EUR', value: userFee.toFixed(2) },
          },
        },
        items: [{
          name: product.name.slice(0, 127),
          quantity: String(body.qty),
          unit_amount: {
            currency_code: 'EUR',
            value: (subtotalNet / body.qty).toFixed(2),
          },
          category: 'DIGITAL_GOODS',
        }],
        custom_id: user.id,
      }],
      application_context: {
        brand_name: 'RareBlock',
        locale: 'it-IT',
        landing_page: 'NO_PREFERENCE',
        user_action: 'PAY_NOW',
        shipping_preference: 'NO_SHIPPING',
      },
    };

    const ppResp = await paypalApi('/v2/checkout/orders', {
      method: 'POST',
      body: JSON.stringify(ppPayload),
    }, { idempotencyKey: `${user.id}:${product.id}:${body.qty}:${Date.now()}` });

    if (!ppResp.ok) {
      const errText = await ppResp.text();
      console.error('[paypal-create-order] PayPal API error:', ppResp.status, errText);
      return json({ error: 'PayPal: creazione ordine fallita', detail: errText }, 502);
    }
    const ppOrder = await ppResp.json();
    const paypalOrderId = ppOrder.id;

    // ── Crea record inv_orders con paypal_order_id ──
    const orderInsert: Record<string, unknown> = {
      user_id:             user.id,
      product_id:          product.id,
      qty:                 body.qty,
      unit_price:          unitPrice,
      subtotal:            gross,
      discount_pct:        discountPct,
      discount_amount:     discountAmount,
      total:               totalToPay,
      payment_method:      'paypal',
      paypal_order_id:     paypalOrderId,
      paypal_fee_charged:  userFee,
      paypal_status:       'pending',
      paypal_environment:  getPayPalEnv(),
      status:              'awaiting_payment',
      notes:               body.notes || null,
    };
    // Billing fields opzionali
    if (body.bill) {
      const b = body.bill as Record<string, string>;
      if (b.name)    orderInsert.bill_full_name = b.name;
      if (b.email)   orderInsert.bill_email = b.email;
      if (b.phone)   orderInsert.bill_phone = b.phone;
      if (b.fc)      orderInsert.bill_fiscal_code = b.fc;
      if (b.vat)     orderInsert.bill_vat_number = b.vat;
      if (b.address) orderInsert.bill_address = b.address;
      if (b.city)    orderInsert.bill_city = b.city;
      if (b.zip)     orderInsert.bill_zip = b.zip;
      if (b.country) orderInsert.bill_country = b.country;
      if (b.pec)     orderInsert.bill_pec = b.pec;
      if (b.sdi)     orderInsert.bill_sdi_code = b.sdi;
      if (typeof b.is_company !== 'undefined') orderInsert.is_company = b.is_company;
    }
    const { data: orderRow, error: orderErr } = await admin
      .from('inv_orders')
      .insert(orderInsert)
      .select()
      .single();
    if (orderErr) {
      console.error('[paypal-create-order] DB insert order failed:', orderErr);
      // Non blocchiamo: l'ordine PayPal è creato, alla capture lo riconcilieremo
    }

    return json({
      paypalOrderId,
      orderId:   orderRow?.id || null,
      breakdown: {
        gross, discountPct, discountAmount, subtotalNet,
        feePct: feeCfg.percent, feeFixed: feeCfg.fixed, userFee, totalToPay,
        appliedTier,
      },
    });
  } catch (e) {
    console.error('[paypal-create-order] Fatal:', e);
    return json({ error: (e as Error).message }, 500);
  }
});
