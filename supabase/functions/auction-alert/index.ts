// ═══════════════════════════════════════════════════════════════════════
//  RareBlock — Edge Function: auction-alert
//  Scansiona rb_auction_alerts e invia una Web Push a end_at − notify_minutes
//  (default 5 min). Idempotente: notified_at marca l'invio, quindi il cron
//  può girare ogni minuto senza duplicati.
//
//  DEPLOY:
//    supabase functions deploy auction-alert --no-verify-jwt
//    (automatico via workflow deploy-supabase.yml)
//
//  SCHEDULE: pg_cron 'rb_auction_alert_tick' (* * * * *) → net.http_post
//    (creato dalla migration 095_auction_deadline_alerts.sql)
//
//  SECRETS (già presenti per hunt-monitor):
//    VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT
//    SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY → auto-iniettati
//
//  Web Push self-contained (VAPID + aes128gcm) — stessa implementazione
//  di hunt-monitor, inlined perché _shared non è importabile relativamente.
// ═══════════════════════════════════════════════════════════════════════

import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Finestra massima di scan: alert con anticipo fino a 240 min
const MAX_NOTIFY_MINUTES = 240;
// Grace: se il tick arriva fino a 90s dopo la fine, invia comunque ("ultimi istanti")
const GRACE_MS = 90_000;

const PLATFORM_LABEL: Record<string, string> = {
  catawiki: "Catawiki",
  ebay: "eBay",
  vinted: "Vinted",
  cardmarket: "CardMarket",
  subito: "Subito",
  altro: "Asta",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const now = Date.now();
  const horizon = new Date(now + MAX_NOTIFY_MINUTES * 60_000).toISOString();

  // Tutti i pending che finiscono entro l'orizzonte massimo (o già finiti e mai marcati)
  const { data: alerts, error } = await supa
    .from("rb_auction_alerts")
    .select("id,user_id,platform,title,source_url,end_at,notify_minutes,valuation_eur,valuation_source")
    .is("notified_at", null)
    .eq("dismissed", false)
    .lte("end_at", horizon)
    .order("end_at", { ascending: true })
    .limit(100);

  if (error) {
    console.error("[auction-alert] scan error", error);
    return json({ ok: false, error: error.message }, 500);
  }
  if (!alerts || !alerts.length) return json({ ok: true, scanned: 0, sent: 0 });

  let sent = 0, missed = 0, waiting = 0;

  for (const a of alerts) {
    const endMs = Date.parse(a.end_at);
    const msLeft = endMs - Date.now();
    const windowMs = (a.notify_minutes || 5) * 60_000;

    if (msLeft > windowMs) { waiting++; continue; }          // troppo presto: prossimi tick

    if (msLeft < -GRACE_MS) {
      // Asta già finita da troppo: marca come mancata, niente push tardiva
      await supa.from("rb_auction_alerts")
        .update({ notified_at: new Date().toISOString(), notify_result: "missed" })
        .eq("id", a.id).is("notified_at", null);
      missed++;
      continue;
    }

    // ── Dentro la finestra: invia push ──────────────────────────────────
    const minLeft = Math.max(0, Math.round(msLeft / 60_000));
    const endLocal = new Date(endMs).toLocaleTimeString("it-IT", {
      hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome",
    });
    const plat = PLATFORM_LABEL[a.platform] || a.platform;
    const val = a.valuation_eur != null
      ? ` · Val. €${Number(a.valuation_eur).toLocaleString("it-IT", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}${a.valuation_source === "cardmarket" ? " (CM)" : ""}`
      : "";

    const payload = {
      title: `⏰ ${plat} — ${minLeft <= 0 ? "sta finendo ORA" : `−${minLeft} min`}`,
      body: `${(a.title || "").slice(0, 110)}\nFine ${endLocal}${val}`,
      url: a.source_url || "/pokemon-db.html",
      requireInteraction: true,
      threshold: "10m", // compat sw.js v1: forza requireInteraction anche su SW non aggiornato
      tag: `rb-scad-${a.id}`,
      icon: "/favicon.ico",
    };

    const okCount = await sendWebPush(a.user_id, payload, supa);
    await supa.from("rb_auction_alerts")
      .update({
        notified_at: new Date().toISOString(),
        notify_result: okCount > 0 ? `sent:${okCount}` : "no_subs",
      })
      .eq("id", a.id).is("notified_at", null);
    if (okCount > 0) sent++;
  }

  return json({ ok: true, scanned: alerts.length, sent, missed, waiting });
});

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ═══════════════════════════════════════════════════════════════════════
//  WEB PUSH (VAPID + AES128GCM) — RFC 8030/8291/8292
//  Identico a hunt-monitor (self-contained, WebCrypto Deno, no npm).
// ═══════════════════════════════════════════════════════════════════════

interface PushSub {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  failure_count: number;
}

async function sendWebPush(userId: string, notifPayload: any, supa: any): Promise<number> {
  const VAPID_PUB  = Deno.env.get("VAPID_PUBLIC_KEY");
  const VAPID_PRIV = Deno.env.get("VAPID_PRIVATE_KEY");
  const VAPID_SUB  = Deno.env.get("VAPID_SUBJECT") || "mailto:radar@rareblock.eu";
  if (!VAPID_PUB || !VAPID_PRIV) {
    console.warn("[auction-alert] missing VAPID keys; skip web push");
    return 0;
  }

  const { data: subs, error } = await supa
    .from("hunt_push_subscriptions")
    .select("*")
    .eq("user_id", userId);
  if (error || !subs || !subs.length) return 0;

  const payloadBytes = new TextEncoder().encode(JSON.stringify(notifPayload));

  let okCount = 0;
  for (const sub of subs as PushSub[]) {
    try {
      const res = await deliverPush(sub, payloadBytes, VAPID_PUB, VAPID_PRIV, VAPID_SUB);
      if (res.ok) {
        okCount++;
        await supa
          .from("hunt_push_subscriptions")
          .update({ failure_count: 0, last_seen: new Date().toISOString() })
          .eq("id", sub.id);
      } else if (res.status === 404 || res.status === 410) {
        await supa.from("hunt_push_subscriptions").delete().eq("id", sub.id);
      } else {
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
  const audience = new URL(sub.endpoint).origin;
  const jwt = await makeVapidJWT(audience, vapidSub, vapidPub, vapidPriv);
  const encrypted = await encryptPayload(payload, sub.p256dh, sub.auth);

  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "Authorization": `vapid t=${jwt}, k=${vapidPub}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": "300",          // notifica −5min: inutile dopo pochi minuti
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

  const ephem = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const ephemPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", ephem.publicKey));

  const clientKey = await crypto.subtle.importKey(
    "raw", clientPub,
    { name: "ECDH", namedCurve: "P-256" },
    false, [],
  );

  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: clientKey },
    ephem.privateKey,
    256,
  ));

  const info1 = concat(
    new TextEncoder().encode("WebPush: info\0"),
    clientPub,
    ephemPubRaw,
  );
  const ikm = await hkdf(shared, authSecret, info1, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));

  const cek = await hkdf(ikm, salt, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(ikm, salt, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);

  const padded = concat(payload, new Uint8Array([0x02]));

  const cekKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    cekKey,
    padded,
  ));

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
  const saltKey = await crypto.subtle.importKey("raw", salt.byteLength ? salt : new Uint8Array(32),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prk = new Uint8Array(await crypto.subtle.sign("HMAC", saltKey, ikm));

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
