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
          // Push browser: log + Supabase Realtime invia aggiornamento al client
          await supa.from("hunt_alert_log").insert({
            user_id: userId,
            listing_id: listing.id,
            channel: "push",
            status: "sent",
            payload: { ...payload, kind: "monitor" },
          });
          channels.push("push");

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
