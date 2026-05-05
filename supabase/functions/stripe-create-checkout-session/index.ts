// Supabase Edge Function: stripe-create-checkout-session
// =============================================================================
// L'utente ha cliccato "Paga con carta" sul checkout.
// Questa function:
//   1. Verifica sessione utente (JWT)
//   2. Carica order_id da body, verifica owner + status='awaiting_payment'
//   3. Carica prodotto associato e VERIFICA che payout_mode != 'vendor_direct'
//      (per scenario B Stripe NON è disponibile, solo bonifico)
//   4. Crea Stripe Checkout Session con:
//      - currency=eur, line_items con totale snapshot ordine
//      - payment_method_types=['card'] (Apple/Google Pay automatici)
//      - customer_email pre-fill da bill_email
//      - metadata={order_id, order_number} → letti dal webhook
//      - success_url + cancel_url
//      - email_disabled (Stripe receipt OFF, usiamo email custom)
//      - expires_at = order.expires_at (max 24h da Stripe → cap a min)
//   5. Salva stripe_session_id su inv_orders (idempotency: se già presente,
//      verifica che non sia ancora completed e ritorna URL della session
//      esistente)
//   6. Ritorna { checkout_url, session_id }
//
// SICUREZZA:
// - Importi calcolati lato server da inv_orders.total (snapshot)
// - Mai fidarsi del client per importi
// - JWT user verificato via SUPABASE_ANON_KEY
// - Service role usata solo per scrittura DB privilegiata
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CORS, json, preflight } from './_shared.ts';
import { stripeApi, centsFromEur } from './_shared.ts';

interface CreateSessionInput {
  order_id: string;
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

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
    const body = (await req.json().catch(() => null)) as CreateSessionInput | null;
    if (!body || !body.order_id) {
      return json({ error: 'order_id richiesto' }, 400);
    }

    // ── Carica ordine + prodotto (service_role per bypassare RLS) ──
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: order, error: orderErr } = await admin
      .from('inv_orders')
      .select('id, order_number, user_id, product_id, qty, total, status, bill_email, bill_full_name, payout_mode, stripe_session_id, expires_at')
      .eq('id', body.order_id)
      .maybeSingle();

    if (orderErr || !order) return json({ error: 'ordine non trovato' }, 404);

    // Owner check
    if (order.user_id !== user.id) {
      return json({ error: 'non autorizzato per quest\'ordine' }, 403);
    }

    // Status check: solo awaiting_payment può generare nuova session
    if (order.status !== 'awaiting_payment') {
      return json({
        error: `ordine in stato '${order.status}', impossibile creare sessione di pagamento`,
      }, 400);
    }

    // Scenario A/B check: Stripe non disponibile per vendor_direct
    if (order.payout_mode === 'vendor_direct') {
      return json({
        error: 'Per questo prodotto è disponibile solo il bonifico bancario (pagamento al venditore).',
      }, 400);
    }

    // ── Idempotency: se session già esiste, recupera e ritorna URL ──
    if (order.stripe_session_id) {
      try {
        const existing = await stripeApi(`/v1/checkout/sessions/${order.stripe_session_id}`, 'GET');
        // Se la session è ancora valida (open) e non completed, riusa l'URL
        if (existing && existing.status === 'open' && existing.url) {
          return json({
            checkout_url: existing.url,
            session_id: existing.id,
            reused: true,
          });
        }
        // Altrimenti (expired/complete), creiamo una nuova sotto.
      } catch (eExist) {
        console.warn('[stripe] session esistente non recuperabile, creo nuova:', eExist);
      }
    }

    // ── Carica prodotto per name/image ──
    const { data: product, error: prodErr } = await admin
      .from('inv_products')
      .select('id, name, type, payout_mode')
      .eq('id', order.product_id)
      .maybeSingle();

    if (prodErr || !product) return json({ error: 'prodotto non trovato' }, 404);

    // Defense in depth: richeck payout_mode anche dal prodotto (potrebbe
    // essere stato cambiato dopo l'INSERT order, raro ma possibile)
    if (product.payout_mode === 'vendor_direct') {
      return json({
        error: 'Per questo prodotto è disponibile solo il bonifico bancario.',
      }, 400);
    }

    // ── Costruisce URLs success/cancel ──
    const SITE_URL = Deno.env.get('SITE_URL') || 'https://www.rareblock.eu';
    const successUrl = `${SITE_URL}/pagamento-ok.html?order=${encodeURIComponent(order.order_number)}&session={CHECKOUT_SESSION_ID}`;
    const cancelUrl  = `${SITE_URL}/pagamento-annullato.html?order=${encodeURIComponent(order.order_number)}`;

    // ── Crea Stripe Checkout Session ──
    const totalCents = centsFromEur(parseFloat(String(order.total)));
    if (totalCents <= 0) return json({ error: 'totale ordine non valido' }, 400);

    // Stripe accept session expires_at fino a 24h dal create. Usiamo
    // min(order.expires_at, now+24h) per non bloccare più del dovuto.
    const orderExpiresMs = order.expires_at ? new Date(order.expires_at).getTime() : 0;
    const max24hMs = Date.now() + 24 * 3600 * 1000;
    const minExpire = Math.min(orderExpiresMs || max24hMs, max24hMs);
    const sessionExpiresAt = Math.floor(Math.max(minExpire, Date.now() + 35 * 60 * 1000) / 1000);  // min Stripe = 30 min, prendo 35 per sicurezza

    // Email pre-fill: bill_email (form fatturazione) → fallback user.email
    // (auth account, sempre presente). Se entrambi mancano, omettiamo
    // completamente il campo: Stripe NON accetta empty string ('Invalid
    // email address: ') e fa 400. Lo step Stripe Checkout chiederà
    // l'email all'utente in quel caso.
    const customerEmail = (order.bill_email && String(order.bill_email).trim())
                       || (user.email && String(user.email).trim())
                       || null;

    const sessionBody: Record<string, unknown> = {
      mode: 'payment',
      currency: 'eur',
      payment_method_types: ['card'],  // Apple/Google Pay automatici come carte mobile
      // Disabilita Stripe receipt nativo (usiamo email custom da PR6a).
      // NB: NON passare receipt_email='' — Stripe rifiuta empty string.
      // Per disabilitare la ricevuta, basta NON popolare receipt_email
      // nel payment_intent_data.
      payment_intent_data: {
        metadata: {
          order_id: order.id,
          order_number: order.order_number,
          user_id: order.user_id,
        },
      },
      // Metadata sulla session (letti dal webhook)
      metadata: {
        order_id: order.id,
        order_number: order.order_number,
        user_id: order.user_id,
      },
      // Line items: 1 riga per il totale ordine
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'eur',
          unit_amount: totalCents,
          product_data: {
            name: `${product.name} — Ordine ${order.order_number}`,
            description: `RareBlock · ${order.qty} ${order.qty === 1 ? 'quota' : 'quote'}`,
          },
        },
      }],
      // Locale italiano
      locale: 'it',
      // URLs
      success_url: successUrl,
      cancel_url:  cancelUrl,
      // Scadenza session
      expires_at: sessionExpiresAt,
      // Disabilita save di metodi di pagamento (no PII su nostro account)
      // (default: non salva, va specificato solo se vuoi setup_future_usage)
    };

    // Aggiungi customer_email SOLO se valido (non null/empty).
    // Stripe rifiuta empty string con 400 'Invalid email address: '.
    if (customerEmail) {
      sessionBody.customer_email = customerEmail;
    }

    // Idempotency key: ordine + ultimo update (riusa session se stesso ordine
    // entro pochi secondi, ma rigenera se l'ordine è cambiato)
    const idemKey = `order_${order.id}_${Date.now()}`;
    const session = await stripeApi('/v1/checkout/sessions', 'POST', sessionBody, {
      idempotencyKey: idemKey,
    });

    // ── Salva session_id su inv_orders ──
    const { error: updateErr } = await admin
      .from('inv_orders')
      .update({
        stripe_session_id: session.id,
        // Marca payment_method='stripe' nel momento in cui l'utente sceglie
        // il pagamento carta (era default 'bonifico'). Il webhook al
        // completed confermerà.
        payment_method: 'stripe',
        updated_at: new Date().toISOString(),
      })
      .eq('id', order.id);

    if (updateErr) {
      console.warn('[stripe] update session_id fallito:', updateErr);
      // Non blocca: la session è creata, l'utente può comunque pagare
      // (al webhook recupereremo via metadata.order_id)
    }

    return json({
      checkout_url: session.url,
      session_id:   session.id,
      expires_at:   sessionExpiresAt,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[stripe-create-checkout-session] errore:', msg, e);
    return json({ error: msg || 'Errore creazione sessione' }, 500);
  }
});
