// ═══════════════════════════════════════════════════════════════════════
//  RareBlock — Edge Function: hunt-monitor
//  Scansiona le aste con is_monitored=true, determina se è stata raggiunta
//  una soglia temporale (24h, 6h, 1h, 10m, ended) non ancora notificata,
//  e invia notifiche sui canali configurati dall'utente (email, Telegram,
//  push browser via hunt_alert_log + Supabase Realtime).
//
//  DEPLOY:
//    supabase functions deploy hunt-monitor --no-verify-jwt
//
//  SCHEDULE (cron ogni 5 minuti) — usa Supabase pg_cron:
//    select cron.schedule(
//      'hunt-monitor-5min',
//      '*/5 * * * *',
//      $$ select net.http_post(
//           url:='https://<PROJECT>.functions.supabase.co/hunt-monitor',
//           headers:=jsonb_build_object('Authorization','Bearer '||current_setting('app.settings.service_role_key'))
//         ); $$
//    );
//  In alternativa si può usare un cron esterno (GitHub Actions, cron-job.org).
//
//  SECRETS richiesti nel dashboard Supabase:
//    RESEND_API_KEY       → per email
//    TELEGRAM_BOT_TOKEN   → per Telegram
//    SUPABASE_URL         → auto-iniettato
//    SUPABASE_SERVICE_ROLE_KEY → auto-iniettato
// ═══════════════════════════════════════════════════════════════════════

import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── SOGLIE TEMPORALI ─────────────────────────────────────────────────────
// Ordinate dalla più lontana alla più vicina alla fine asta.
// Ogni soglia scatta quando `hours_remaining <= threshold_hours` e la soglia
// non è già presente in `monitor_notified`.
interface Threshold {
  key: string;                 // salvato in monitor_notified
  hoursMax: number;            // scatta quando hours_remaining <= hoursMax
  minHoursRemaining: number;   // NON scattare se l'asta è troppo in là nel tempo
  label: string;               // leggibile nei messaggi
}

const THRESHOLDS: Threshold[] = [
  { key: "24h", hoursMax: 24,       minHoursRemaining: 6,     label: "24 ore alla fine" },
  { key: "6h",  hoursMax: 6,        minHoursRemaining: 1,     label: "6 ore alla fine" },
  { key: "1h",  hoursMax: 1,        minHoursRemaining: 10/60, label: "1 ora alla fine" },
  { key: "10m", hoursMax: 10/60,    minHoursRemaining: 0,     label: "10 minuti alla fine" },
];

// "ended" è un caso speciale: hours_remaining <= 0 e non ancora in notified
const ENDED_KEY = "ended";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
  const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!SUPA_URL || !SRK) {
    return json({ error: "missing SUPABASE_URL or SERVICE_ROLE_KEY" }, 500);
  }
  const supa = createClient(SUPA_URL, SRK);

  const now = Date.now();
  const processed: any[] = [];
  const errors: any[] = [];

  try {
    // Carica aste monitorate NON ancora finite (o appena finite da <2h, per inviare 'ended')
    const { data: monitored, error: mErr } = await supa
      .from("hunt_listings")
      .select("*")
      .eq("is_monitored", true)
      .not("auction_ends_at", "is", null);

    if (mErr) throw mErr;
    if (!monitored || monitored.length === 0) {
      return json({ ok: true, message: "no monitored auctions", count: 0 });
    }

    // Raggruppa per user_id (per caricare config una volta sola)
    const byUser: Record<string, any[]> = {};
    for (const l of monitored) {
      (byUser[l.user_id] = byUser[l.user_id] || []).push(l);
    }

    for (const userId of Object.keys(byUser)) {
      // Config canali utente
      const { data: cfg } = await supa
        .from("hunt_channel_config")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();

      for (const listing of byUser[userId]) {
        const hoursRemaining = (new Date(listing.auction_ends_at).getTime() - now) / 3600000;
        const alreadyNotified: string[] = listing.monitor_notified || [];

        // Determina TUTTE le soglie che vanno inviate ora
        // (potrebbe essere la prima esecuzione e l'asta è già vicina → invia quella
        //  più stretta saltando le outer, per non spammare)
        const toFire: Threshold[] = [];

        if (hoursRemaining <= 0) {
          if (!alreadyNotified.includes(ENDED_KEY)) {
            toFire.push({
              key: ENDED_KEY,
              hoursMax: 0, minHoursRemaining: 0,
              label: "asta terminata",
            });
            // Una volta chiusa, disattiva monitoraggio
            await supa
              .from("hunt_listings")
              .update({ is_monitored: false })
              .eq("id", listing.id);
          }
        } else {
          // Trova la soglia più vicina non ancora notificata che ha già superato hoursMax.
          // Le soglie sono ordinate da più ampia a più stretta.
          // Logica: scansiono dalla più ampia verso la più stretta; la prima che:
          //   - hoursRemaining <= hoursMax  AND
          //   - !alreadyNotified.includes(key)
          // la aggiungo e marco le outer come notified (evita di inviare '24h'
          // se scopro ora un'asta già a 2h di distanza → mando solo '6h' e marco '24h'
          // come già notificata per silent-skip).
          for (const th of THRESHOLDS) {
            if (hoursRemaining <= th.hoursMax) {
              if (!alreadyNotified.includes(th.key)) {
                toFire.push(th);
              }
            }
          }
          // Tra quelle da inviare tieni solo la PIÙ STRETTA (più recente) per ridurre rumore,
          // e le altre vengono segnate come "notified" silently.
          if (toFire.length > 1) {
            const keepIdx = toFire.length - 1;
            const silent = toFire.slice(0, keepIdx).map(t => t.key);
            toFire.splice(0, keepIdx);
            // Segna silent
            await supa
              .from("hunt_listings")
              .update({ monitor_notified: [...alreadyNotified, ...silent] })
              .eq("id", listing.id);
            alreadyNotified.push(...silent);
          }
        }

        if (toFire.length === 0) continue;

        for (const th of toFire) {
          const payload = {
            threshold: th.key,
            threshold_label: th.label,
            hours_remaining: Number(hoursRemaining.toFixed(2)),
            listing_title: listing.title,
            listing_url: listing.listing_url,
            price: listing.price,
            currency: listing.currency || "EUR",
            platform: listing.platform,
            bid_count: listing.bid_count,
            auction_ends_at: listing.auction_ends_at,
          };

          const channels: string[] = [];

          // Email
          if (cfg?.email_address) {
            const ok = await sendEmail(cfg.email_address, payload, supa, userId, listing.id);
            if (ok) channels.push("email");
          }
          // Telegram
          if (cfg?.telegram_chat_id) {
            const ok = await sendTelegram(cfg.telegram_chat_id, payload, supa, userId, listing.id);
            if (ok) channels.push("telegram");
          }
          // Web Push browser (VAPID) — invio a tutte le subscriptions dell'utente.
          // Funziona anche con browser chiuso. Service Worker su /sw.js (same-origin).
          const pushOk = await sendWebPush(userId, payload, supa);
          if (pushOk > 0) channels.push(`push:${pushOk}`);
          // Log riassuntivo
          await supa.from("hunt_alert_log").insert({
            user_id: userId,
            listing_id: listing.id,
            channel: "push",
            status: pushOk > 0 ? "sent" : "skipped",
            payload: { ...payload, kind: "monitor", devices: pushOk },
          });

          // Marca questa soglia come notificata
          const newNotified = [...alreadyNotified, th.key];
          await supa
            .from("hunt_listings")
            .update({ monitor_notified: newNotified, alerted_at: new Date().toISOString(), alert_channels: channels })
            .eq("id", listing.id);

          processed.push({
            listing_id: listing.id,
            user_id: userId,
            threshold: th.key,
            channels,
          });
        }
      }
    }

    return json({ ok: true, processed_count: processed.length, processed, errors });
  } catch (e) {
    console.error("[hunt-monitor]", e);
    return json({ error: String(e) }, 500);
  }
});

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ── EMAIL (Resend) ───────────────────────────────────────────────────────
async function sendEmail(to: string, p: any, supa: any, userId: string, listingId: string): Promise<boolean> {
  const RESEND_KEY = Deno.env.get("RESEND_API_KEY");
  if (!RESEND_KEY) {
    await supa.from("hunt_alert_log").insert({
      user_id: userId, listing_id: listingId, channel: "email",
      status: "skipped", error: "no RESEND_API_KEY",
    });
    return false;
  }
  const subject = `📡 Radar — ${p.threshold_label}: ${String(p.listing_title || "").slice(0, 50)}`;
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:560px">
      <h2 style="color:#d63031;margin:0 0 8px">⏰ ${p.threshold_label}</h2>
      <p style="color:#666;margin:0 0 18px">Asta monitorata in scadenza.</p>
      <div style="background:#f7f7f7;border-radius:8px;padding:14px 16px;margin-bottom:12px">
        <div style="font-weight:600;font-size:15px;margin-bottom:6px">${escapeHtml(p.listing_title || "(senza titolo)")}</div>
        <div style="color:#666;font-size:13px">Piattaforma: <b>${p.platform}</b></div>
        ${p.price != null ? `<div style="color:#666;font-size:13px">Prezzo attuale: <b>${p.currency} ${p.price}</b></div>` : ""}
        ${p.bid_count != null ? `<div style="color:#666;font-size:13px">Offerte: <b>${p.bid_count}</b></div>` : ""}
        <div style="color:#666;font-size:13px">Fine asta: ${new Date(p.auction_ends_at).toLocaleString("it-IT")}</div>
      </div>
      <a href="${p.listing_url}" style="display:inline-block;background:#0066cc;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">Apri inserzione →</a>
      <p style="color:#999;font-size:11px;margin-top:20px">Ricevi queste notifiche perché hai attivato il monitoraggio attivo su questa asta. Disattivabile dal Radar in RareBlock.</p>
    </div>`;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "RareBlock Radar <radar@rareblock.eu>",
        to, subject, html,
      }),
    });
    const ok = r.ok;
    await supa.from("hunt_alert_log").insert({
      user_id: userId, listing_id: listingId, channel: "email",
      status: ok ? "sent" : "failed",
      error: ok ? null : (await r.text()).slice(0, 500),
      payload: p,
    });
    return ok;
  } catch (e) {
    await supa.from("hunt_alert_log").insert({
      user_id: userId, listing_id: listingId, channel: "email",
      status: "failed", error: String(e).slice(0, 500),
    });
    return false;
  }
}

// ── TELEGRAM ─────────────────────────────────────────────────────────────
async function sendTelegram(chatId: string, p: any, supa: any, userId: string, listingId: string): Promise<boolean> {
  const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!TG_TOKEN) {
    await supa.from("hunt_alert_log").insert({
      user_id: userId, listing_id: listingId, channel: "telegram",
      status: "skipped", error: "no TELEGRAM_BOT_TOKEN",
    });
    return false;
  }
  const priceStr = p.price != null ? `💰 *${p.currency} ${p.price}*` : "";
  const bidsStr = p.bid_count != null ? `🔨 ${p.bid_count} offerte` : "";
  const text =
    `📡 *Radar* — ⏰ ${escapeMd(p.threshold_label)}\n` +
    `${escapeMd(String(p.listing_title || "").slice(0, 100))}\n\n` +
    `${priceStr} ${bidsStr}\n` +
    `Piattaforma: ${p.platform}\n` +
    `Fine: ${new Date(p.auction_ends_at).toLocaleString("it-IT")}\n\n` +
    `[Apri inserzione →](${p.listing_url})`;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId, text, parse_mode: "Markdown",
        disable_web_page_preview: false,
      }),
    });
    const ok = r.ok;
    await supa.from("hunt_alert_log").insert({
      user_id: userId, listing_id: listingId, channel: "telegram",
      status: ok ? "sent" : "failed",
      error: ok ? null : (await r.text()).slice(0, 500),
      payload: p,
    });
    return ok;
  } catch (e) {
    await supa.from("hunt_alert_log").insert({
      user_id: userId, listing_id: listingId, channel: "telegram",
      status: "failed", error: String(e).slice(0, 500),
    });
    return false;
  }
}

function escapeHtml(s: string): string {
  return String(s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any)[c]
  );
}
function escapeMd(s: string): string {
  // Escape minimo per Markdown Telegram — evita che _*[]` spezzino il parsing
  return String(s || "").replace(/([_*[\]()`])/g, "\\$1");
}


// ═══════════════════════════════════════════════════════════════════════
//  WEB PUSH (VAPID + AES128GCM)
//
//  Implementazione self-contained con WebCrypto API di Deno (no npm libs).
//  Spec: RFC 8030 (Push), RFC 8291 (encryption), RFC 8292 (VAPID).
// ═══════════════════════════════════════════════════════════════════════

interface PushSub {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  failure_count: number;
}

async function sendWebPush(userId: string, payload: any, supa: any): Promise<number> {
  const VAPID_PUB  = Deno.env.get("VAPID_PUBLIC_KEY");
  const VAPID_PRIV = Deno.env.get("VAPID_PRIVATE_KEY");
  const VAPID_SUB  = Deno.env.get("VAPID_SUBJECT") || "mailto:radar@rareblock.eu";
  if (!VAPID_PUB || !VAPID_PRIV) {
    console.warn("[hunt-monitor] missing VAPID keys; skip web push");
    return 0;
  }

  const { data: subs, error } = await supa
    .from("hunt_push_subscriptions")
    .select("*")
    .eq("user_id", userId);
  if (error || !subs || !subs.length) return 0;

  // Payload notifica → ciò che riceve il SW
  const notifPayload = {
    title: `📡 Radar — ${payload.threshold_label}`,
    body: `${(payload.listing_title || "").slice(0, 110)}\n${payload.currency || "EUR"} ${payload.price ?? "?"} · ${payload.platform}`,
    url: payload.listing_url,
    threshold: payload.threshold,
    listing_id: payload.listing_id || null,
    icon: "/favicon.ico",
    tag: `rb-mon-${payload.threshold}-${payload.listing_url}`,
  };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(notifPayload));

  let okCount = 0;
  for (const sub of subs as PushSub[]) {
    try {
      const res = await deliverPush(sub, payloadBytes, VAPID_PUB, VAPID_PRIV, VAPID_SUB);
      if (res.ok) {
        okCount++;
        // Reset failure count + last_seen
        await supa
          .from("hunt_push_subscriptions")
          .update({ failure_count: 0, last_seen: new Date().toISOString() })
          .eq("id", sub.id);
      } else if (res.status === 404 || res.status === 410) {
        // Subscription espirata o cancellata → rimuovi
        await supa.from("hunt_push_subscriptions").delete().eq("id", sub.id);
      } else {
        // Altro errore → incrementa failure_count, dopo 5 elimina
        const newFail = (sub.failure_count || 0) + 1;
        if (newFail >= 5) {
          await supa.from("hunt_push_subscriptions").delete().eq("id", sub.id);
        } else {
          await supa
            .from("hunt_push_subscriptions")
            .update({ failure_count: newFail })
            .eq("id", sub.id);
        }
      }
    } catch (e) {
      console.error("[push deliver]", e);
    }
  }
  return okCount;
}

interface DeliverResult { ok: boolean; status: number; body?: string; }

async function deliverPush(
  sub: PushSub,
  payload: Uint8Array,
  vapidPub: string,
  vapidPriv: string,
  vapidSub: string,
): Promise<DeliverResult> {
  // 1. Costruisci JWT VAPID firmato ES256
  const audience = new URL(sub.endpoint).origin;
  const jwt = await makeVapidJWT(audience, vapidSub, vapidPub, vapidPriv);

  // 2. Encrypta payload con scheme aes128gcm (RFC 8291)
  const encrypted = await encryptPayload(payload, sub.p256dh, sub.auth);

  // 3. POST al Push Service
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "Authorization": `vapid t=${jwt}, k=${vapidPub}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": "86400",
      "Urgency": "high",
    },
    body: encrypted,
  });
  return { ok: res.ok, status: res.status, body: res.ok ? "" : await res.text() };
}

// ── VAPID JWT (ES256) ──────────────────────────────────────────────────
async function makeVapidJWT(aud: string, sub: string, pubB64u: string, privB64u: string): Promise<string> {
  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub,
  };
  const headerB64 = b64uEncode(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = b64uEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

  // Importa private key VAPID come PKCS8/raw P-256
  const privBytes = b64uDecode(privB64u);   // 32 bytes raw d
  const pubBytes = b64uDecode(pubB64u);     // 65 bytes uncompressed (0x04 || x || y)
  const jwk = {
    kty: "EC",
    crv: "P-256",
    d: b64uEncode(privBytes),
    x: b64uEncode(pubBytes.slice(1, 33)),
    y: b64uEncode(pubBytes.slice(33, 65)),
    ext: true,
  };
  const key = await crypto.subtle.importKey(
    "jwk", jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data);
  return `${headerB64}.${payloadB64}.${b64uEncode(new Uint8Array(sig))}`;
}

// ── Payload encryption aes128gcm (RFC 8291) ────────────────────────────
async function encryptPayload(payload: Uint8Array, p256dhB64u: string, authB64u: string): Promise<Uint8Array> {
  const clientPub = b64uDecode(p256dhB64u);     // 65 bytes uncompressed
  const authSecret = b64uDecode(authB64u);      // 16 bytes

  // 1. Genera keypair P-256 server effimero
  const ephem = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const ephemPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", ephem.publicKey));

  // 2. Importa client public come ECDH peer
  const clientKey = await crypto.subtle.importKey(
    "raw", clientPub,
    { name: "ECDH", namedCurve: "P-256" },
    false, [],
  );

  // 3. ECDH shared secret (32 bytes)
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: clientKey },
    ephem.privateKey,
    256,
  ));

  // 4. PRK_key = HKDF(IKM=shared, salt=auth, info="WebPush: info\0"+clientPub+ephemPub)
  const info1 = concat(
    new TextEncoder().encode("WebPush: info\0"),
    clientPub,
    ephemPubRaw,
  );
  const ikm = await hkdf(shared, authSecret, info1, 32);

  // 5. Salt 16 random bytes per HKDF di ekey/nonce
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // 6. Content Encryption Key (16 bytes) e Nonce (12 bytes) via HKDF(salt, IKM=ikm)
  const cek = await hkdf(ikm, salt, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(ikm, salt, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);

  // 7. Padding delimiter 0x02 + ciphertext (RFC 8188)
  const padded = concat(payload, new Uint8Array([0x02]));

  const cekKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    cekKey,
    padded,
  ));

  // 8. Header binario aes128gcm: salt(16) || rs(4 BE = 4096) || idlen(1) || keyid(idlen)
  // Per webpush keyid = ephemPub (65 bytes), idlen=65
  const rs = new Uint8Array([0, 0, 0x10, 0]);   // 4096 in BE
  const header = concat(
    salt,
    rs,
    new Uint8Array([ephemPubRaw.byteLength]),
    ephemPubRaw,
  );
  return concat(header, ciphertext);
}

// ── Helpers ────────────────────────────────────────────────────────────
async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  // Implementazione manuale HKDF-SHA256 perché WebCrypto Deno non sempre supporta deriveKey con HKDF su tutti i target.
  // Step 1: extract → PRK = HMAC(salt, ikm)
  const saltKey = await crypto.subtle.importKey("raw", salt.byteLength ? salt : new Uint8Array(32),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prk = new Uint8Array(await crypto.subtle.sign("HMAC", saltKey, ikm));

  // Step 2: expand → T(1)=HMAC(PRK, info||0x01)
  const prkKey = await crypto.subtle.importKey("raw", prk,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const out = new Uint8Array(len);
  let prev = new Uint8Array(0);
  let written = 0;
  let counter = 1;
  while (written < len) {
    const data = concat(prev, info, new Uint8Array([counter]));
    const t = new Uint8Array(await crypto.subtle.sign("HMAC", prkKey, data));
    const take = Math.min(t.byteLength, len - written);
    out.set(t.subarray(0, take), written);
    written += take;
    prev = t;
    counter++;
  }
  return out;
}

function concat(...arrs: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const a of arrs) n += a.byteLength;
  const out = new Uint8Array(n);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.byteLength; }
  return out;
}

function b64uEncode(buf: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < buf.byteLength; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64uDecode(s: string): Uint8Array {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
