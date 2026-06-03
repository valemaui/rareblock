// ═══════════════════════════════════════════════════════════════════════
//  RareBlock — Edge Function: hunt-ingest
//  Riceve listing scrapati dal userscript, li matcha ai target dell'utente,
//  calcola deal_score, li inserisce in hunt_listings con dedupe,
//  e fa scattare le hunt_alert_rules.
//
//  Deploy: supabase functions deploy hunt-ingest --no-verify-jwt=false
// ═══════════════════════════════════════════════════════════════════════

import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface IncomingListing {
  platform: string;
  listing_url: string;
  external_id: string;
  title: string;
  price?: number;
  currency?: string;
  shipping_cost?: number;
  listing_type?: "fixed" | "auction" | "best_offer" | "mixed";
  auction_ends_at?: string | null;
  bid_count?: number | null;
  seller_rating?: number | null;
  seller_feedbacks?: number | null;
  seller_country?: string | null;
  image_url?: string | null;
}

interface Target {
  id: string;
  user_id: string;
  card_name: string;
  card_number?: string | null;
  language?: string | null;
  variant?: string | null;
  first_edition?: boolean;
  shadowless?: boolean;
  grading_house?: string | null;
  min_grade?: number | null;
  extra_keywords?: string[] | null;
  max_price?: number | null;
  ref_price_cm?: number | null;
  deal_threshold?: number | null;
  is_active: boolean;
  total_found?: number | null;
  last_scan_at?: string | null;
}

// ── Parser titolo (side-server) ─────────────────────────────────────────
function parseTitle(title: string) {
  const t = (title || "").toLowerCase();
  const out: Record<string, any> = {};

  const g = t.match(/\b(psa|bgs|cgc|ace|sgc|cgs)\s*(10|9\.5|9|8\.5|8|7\.5|7|6\.5|6)\b/i);
  if (g) { out.parsed_grader = g[1].toUpperCase(); out.parsed_grade = parseFloat(g[2]); }
  // Marker di grading senza numero (es. "slab", "graded", "gradata")
  if (!out.parsed_grader && /\b(graded|gradata|gradato|slab(bed)?)\b/i.test(t)) out.parsed_graded_hint = true;

  if (/\b(1st\s*ed|1st\s*edition|prima\s*edizione|first\s*edition|edizione\s*1)\b/i.test(t)) out.parsed_is_1st = true;
  if (/\bshadowless\b/i.test(t)) out.parsed_shadowless = true;

  if (/\b(italiano|italiana|italian|ita)\b/i.test(t)) out.parsed_lang = "ITA";
  else if (/\b(japanese|japan|jap|jpn|giappon)\b/i.test(t)) out.parsed_lang = "JPN";
  else if (/\b(english|eng|inglese)\b/i.test(t)) out.parsed_lang = "ENG";
  else if (/\b(deutsch|german|tedesco|ger)\b/i.test(t)) out.parsed_lang = "GER";
  else if (/\b(francese|french|fra|fre)\b/i.test(t)) out.parsed_lang = "FRA";
  else if (/\b(spagnolo|spanish|esp|spa)\b/i.test(t)) out.parsed_lang = "ESP";

  if (/\b(mint|near\s*mint|nm)\b/i.test(t)) out.parsed_cond = "NM";
  else if (/\b(excellent|ex)\b/i.test(t)) out.parsed_cond = "EX";
  else if (/\b(good|gd)\b/i.test(t)) out.parsed_cond = "GD";

  // Lotto / bundle / playset: NON è una singola carta → da non spacciare per deal
  if (/\b(lotto|lot\b|bundle|stock|playset|collection\s*of|set\s*of|\d+\s*(carte|cards|pcs|pezzi)|x\s*\d{2,})\b/i.test(t)) {
    out.parsed_is_lot = true;
  }
  // Riproduzione / proxy / custom / fake
  if (/\b(proxy|custom|fake|replica|riproduzione|orica)\b/i.test(t)) out.parsed_is_proxy = true;

  return out;
}

// ── Helpers di matching robusto ─────────────────────────────────────────
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Match "parola intera" della carta nel titolo: evita Mew→Mewtwo, Eevee→Eeveelutions.
// I confini sono non-alfanumerici (gestisce accenti/spazi/apostrofi nei nomi).
function nameWholeWord(title: string, name: string): boolean {
  if (!name) return false;
  const re = new RegExp("(^|[^a-z0-9àèéìòù])" + escapeRe(name) + "([^a-z0-9àèéìòù]|$)", "i");
  return re.test(title);
}

// Match numero carta con confini di cifra: "4" NON deve matchare "104"/"2024".
// Riconosce le forme: "#4", "4/102", " 4 ", "no. 4". Esclude prezzi tipo "4,99".
function numberMatch(title: string, cardNumber: string): { hit: boolean; exactFull: boolean } {
  const base = (cardNumber || "").split("/")[0].trim();
  if (!base) return { hit: false, exactFull: false };
  const n = escapeRe(base);
  // Forma piena "N/total" → match forte e inequivocabile
  const full = new RegExp("(^|[^0-9/])" + escapeRe(cardNumber.trim()) + "([^0-9]|$)", "i");
  if (cardNumber.includes("/") && full.test(title)) return { hit: true, exactFull: true };
  // Numero isolato (#N | N/.. | spazi), MA non dentro un numero più lungo
  // e non come prezzo (no "," o "." decimale subito dopo).
  const re = new RegExp("(^|[^0-9])(#|n[.°]?\\s*)?" + n + "(/[0-9]+)?([^0-9.,]|$)", "i");
  return { hit: re.test(title), exactFull: false };
}

// Soglia minima sotto la quale NON assegniamo il target (riduce falsi positivi
// da match solo-nome o incoerenti raw/graded).
const MIN_MATCH_SCORE = 35;

// ── Match listing ↔ target ──────────────────────────────────────────────
// Ritorna il target più specifico (score maggiore) o null.
// Migliorie 2026-06:
//   - nome a parola intera (no Mew→Mewtwo)
//   - numero con confini di cifra (no 4→104/2024/prezzi)
//   - gate lingua: lingua del target specificata e titolo in lingua diversa → skip
//   - coerenza raw/graded: penalità se il listing è gradato ma il target è raw
//     (e viceversa) → i collezionisti raw non vogliono slab e viceversa
//   - guard lotti/proxy: penalità forte (raramente è una singola carta)
//   - soglia minima MIN_MATCH_SCORE per assegnare il target
function matchTarget(listing: IncomingListing, targets: Target[], parsed: any): Target | null {
  const title = (listing.title || "").toLowerCase();
  if (!title) return null;
  let best: Target | null = null;
  let bestScore = 0;

  for (const t of targets) {
    if (!t.is_active) continue;
    const name = (t.card_name || "").toLowerCase().trim();
    if (!name || !nameWholeWord(title, name)) continue;

    // Gate lingua: se il target vuole una lingua precisa e il titolo dichiara
    // una lingua diversa, scartiamo (ITA vs JPN sono mercati distinti).
    const wantLang = (t.language || "ANY").toUpperCase();
    if (wantLang !== "ANY" && parsed.parsed_lang && parsed.parsed_lang !== wantLang) continue;

    let score = 40; // base: nome a parola intera è già piuttosto specifico

    // Numero
    if (t.card_number) {
      const nm = numberMatch(title, t.card_number);
      if (nm.exactFull) score += 35;
      else if (nm.hit) score += 25;
      else score -= 10; // numero richiesto ma assente → meno probabile
    }

    // Lingua coerente → piccolo bonus
    if (wantLang !== "ANY" && parsed.parsed_lang === wantLang) score += 5;

    // Coerenza raw / graded
    const listingGraded = !!parsed.parsed_grader || !!parsed.parsed_graded_hint;
    if (t.grading_house || t.min_grade) {
      // Target GRADATO
      if (parsed.parsed_grader) {
        if (t.grading_house && parsed.parsed_grader === t.grading_house.toUpperCase()) score += 15;
        else if (t.grading_house) score += 4; // gradata ma casa diversa
        else score += 8;                       // casa "qualsiasi"
        if (t.min_grade && parsed.parsed_grade && parsed.parsed_grade >= t.min_grade) score += 8;
        else if (t.min_grade && parsed.parsed_grade && parsed.parsed_grade < t.min_grade) score -= 12;
      } else if (parsed.parsed_graded_hint) {
        score += 2;
      } else {
        score -= 20; // target vuole gradata ma il listing sembra raw
      }
    } else {
      // Target RAW
      if (listingGraded) score -= 15; // chi cerca raw di solito non vuole slab
      if (t.first_edition && parsed.parsed_is_1st) score += 8;
      if (t.shadowless && parsed.parsed_shadowless) score += 8;
    }

    // Guard lotti/proxy
    if (parsed.parsed_is_lot) score -= 20;
    if (parsed.parsed_is_proxy) score -= 30;

    if (score > bestScore) { bestScore = score; best = t; }
  }

  return bestScore >= MIN_MATCH_SCORE ? best : null;
}

// ── Deal score engine (mirror client) ───────────────────────────────────
function calcDealScore(listing: IncomingListing, target: Target | null, parsed: any) {
  let score = 0;
  const reasons: string[] = [];
  const ref = target?.ref_price_cm;

  if (ref && listing.price) {
    const disc = (ref - listing.price) / ref;
    if (disc >= 0.5) { score += 50; reasons.push("below_cm_50pct"); }
    else if (disc >= 0.35) { score += 40; reasons.push("below_cm_35pct"); }
    else if (disc >= 0.2) { score += 25; reasons.push("below_cm_20pct"); }
    else if (disc >= 0.1) { score += 12; reasons.push("below_cm_10pct"); }
    else if (disc > 0) { score += 5; }
    else if (disc < -0.15) { reasons.push("above_cm_overpriced"); }
  }

  if (listing.listing_type === "auction" && listing.auction_ends_at) {
    const hoursLeft = (new Date(listing.auction_ends_at).getTime() - Date.now()) / 3600000;
    if (hoursLeft > 0 && hoursLeft < 24) {
      if ((listing.bid_count ?? 0) === 0) { score += 25; reasons.push("auction_no_bids_ending"); }
      else if (hoursLeft < 6) { score += 15; reasons.push("auction_ending_6h"); }
      else { score += 8; reasons.push("auction_ending_24h"); }
    }
  }

  if ((listing.seller_rating ?? 0) >= 99) { score += 5; reasons.push("top_seller"); }
  if ((listing.seller_feedbacks ?? 0) >= 1000) { score += 5; reasons.push("high_volume_seller"); }

  if (target) {
    if (target.grading_house && parsed.parsed_grader === target.grading_house) { score += 5; reasons.push("grader_match"); }
    if (target.min_grade && parsed.parsed_grade && parsed.parsed_grade >= target.min_grade) { score += 5; reasons.push("grade_match"); }
    if (target.first_edition && parsed.parsed_is_1st) { score += 5; reasons.push("1st_ed_match"); }
  }

  // Lotti/proxy: non sono la singola carta cercata → abbattiamo il punteggio
  if (parsed.parsed_is_lot) { score -= 30; reasons.push("lotto_o_bundle"); }
  if (parsed.parsed_is_proxy) { score -= 60; reasons.push("proxy_o_riproduzione"); }

  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons };
}

// ── HTTP handler ────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: CORS });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return new Response(JSON.stringify({ error: "no auth" }), { status: 401, headers: { ...CORS, "Content-Type": "application/json" } });

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );

  // Verifica utente
  const { data: auth, error: authErr } = await supa.auth.getUser();
  if (authErr || !auth?.user) {
    return new Response(JSON.stringify({ error: "invalid token" }), { status: 401, headers: { ...CORS, "Content-Type": "application/json" } });
  }
  const userId = auth.user.id;

  // Parse body
  let body: any;
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: "bad json" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }); }
  const incoming: IncomingListing[] = body?.listings || [];
  if (!Array.isArray(incoming) || !incoming.length) {
    return new Response(JSON.stringify({ error: "no listings" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // Carica target attivi dell'utente
  const { data: targets } = await supa.from("hunt_targets").select("*").eq("user_id", userId).eq("is_active", true);
  const tList = (targets || []) as Target[];

  // Prepara righe
  const rows: any[] = [];
  for (const l of incoming) {
    if (!l.platform || !l.listing_url || !l.external_id) continue;
    const parsed = parseTitle(l.title || "");
    const target = matchTarget(l, tList, parsed);
    const { score, reasons } = calcDealScore(l, target, parsed);

    rows.push({
      user_id: userId,
      target_id: target?.id ?? null,
      platform: l.platform,
      listing_url: l.listing_url,
      external_id: String(l.external_id),
      title: l.title,
      price: l.price ?? null,
      currency: l.currency || "EUR",
      shipping_cost: l.shipping_cost ?? null,
      listing_type: l.listing_type ?? "fixed",
      auction_ends_at: l.auction_ends_at ?? null,
      bid_count: l.bid_count ?? null,
      time_left_hours: l.auction_ends_at ? (new Date(l.auction_ends_at).getTime() - Date.now()) / 3600000 : null,
      seller_rating: l.seller_rating ?? null,
      seller_feedbacks: l.seller_feedbacks ?? null,
      seller_country: l.seller_country ?? null,
      image_url: l.image_url ?? null,
      parsed_cond: parsed.parsed_cond ?? null,
      parsed_grade: parsed.parsed_grade ?? null,
      parsed_grader: parsed.parsed_grader ?? null,
      parsed_lang: parsed.parsed_lang ?? null,
      parsed_is_1st: parsed.parsed_is_1st ?? false,
      deal_score: score,
      deal_reasons: reasons,
      status: "new",
      last_seen_at: new Date().toISOString(),
    });
  }

  // Upsert con on conflict (user_id, platform, external_id)
  const { data: upserted, error: upErr } = await supa
    .from("hunt_listings")
    .upsert(rows, { onConflict: "user_id,platform,external_id", ignoreDuplicates: false })
    .select();

  if (upErr) {
    return new Response(JSON.stringify({ error: upErr.message }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // Aggiorna contatori target
  const byTarget: Record<string, number> = {};
  for (const r of rows) if (r.target_id) byTarget[r.target_id] = (byTarget[r.target_id] || 0) + 1;

  // Efficienza: un solo update batch per last_scan_at su TUTTI i target attivi scansionati
  const nowIso = new Date().toISOString();
  const activeIds = tList.map((t) => t.id);
  if (activeIds.length) {
    await supa.from("hunt_targets")
      .update({ last_scan_at: nowIso })
      .in("id", activeIds)
      .eq("user_id", userId);
  }

  // Incremento reale di total_found solo sui target con nuovi match (valore per-target)
  for (const [tid, cnt] of Object.entries(byTarget)) {
    const prev = tList.find((t) => t.id === tid)?.total_found ?? 0;
    await supa.from("hunt_targets")
      .update({ total_found: (prev || 0) + cnt })
      .eq("id", tid)
      .eq("user_id", userId);
  }

  // Triggera alert rules sui listing NUOVI con deal_score sopra soglia
  try {
    await fireAlerts(supa, userId, upserted || []);
  } catch (e) {
    console.error("fireAlerts error:", e);
  }

  return new Response(JSON.stringify({
    ok: true,
    received: incoming.length,
    inserted: rows.length,
    matched_target: rows.filter(r => r.target_id).length,
    hot_deals: rows.filter(r => (r.deal_score ?? 0) >= 80).length,
  }), { headers: { ...CORS, "Content-Type": "application/json" } });
});

// ── Alert firing ────────────────────────────────────────────────────────
async function fireAlerts(supa: any, userId: string, listings: any[]) {
  if (!listings.length) return;
  const { data: rules } = await supa
    .from("hunt_alert_rules")
    .select("*")
    .eq("user_id", userId)
    .eq("is_active", true);
  if (!rules || !rules.length) return;

  const { data: cfg } = await supa
    .from("hunt_channel_config")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  for (const rule of rules) {
    // throttle
    if (rule.last_fired_at && rule.cooldown_minutes) {
      const mins = (Date.now() - new Date(rule.last_fired_at).getTime()) / 60000;
      if (mins < rule.cooldown_minutes) continue;
    }

    const matches = listings.filter((l: any) => {
      if (rule.min_deal_score != null && (l.deal_score ?? 0) < rule.min_deal_score) return false;
      if (rule.max_price != null && (l.price ?? Infinity) > rule.max_price) return false;
      if (rule.platforms && rule.platforms.length && !rule.platforms.includes(l.platform)) return false;
      if (rule.auction_only && l.listing_type !== "auction") return false;
      if (rule.ending_within_hours && l.auction_ends_at) {
        const h = (new Date(l.auction_ends_at).getTime() - Date.now()) / 3600000;
        if (h > rule.ending_within_hours) return false;
      }
      return true;
    });
    if (!matches.length) continue;

    for (const l of matches) {
      const payload = {
        rule_name: rule.name,
        listing_title: l.title,
        listing_url: l.listing_url,
        price: l.price,
        platform: l.platform,
        deal_score: l.deal_score,
      };

      if (rule.channel_email && cfg?.email_address) {
        await sendEmail(cfg.email_address, payload, supa, userId, rule.id, l.id);
      }
      if (rule.channel_telegram && cfg?.telegram_chat_id) {
        await sendTelegram(cfg.telegram_chat_id, payload, supa, userId, rule.id, l.id);
      }
      // Push browser: salvato nel log, consumato lato client via realtime
      if (rule.channel_push) {
        await supa.from("hunt_alert_log").insert({
          user_id: userId, rule_id: rule.id, listing_id: l.id,
          channel: "push", status: "sent", payload,
        });
      }
    }

    await supa.from("hunt_alert_rules").update({
      last_fired_at: new Date().toISOString(),
      fire_count: (rule.fire_count || 0) + matches.length,
    }).eq("id", rule.id);
  }
}

async function sendEmail(to: string, p: any, supa: any, userId: string, ruleId: string, listingId: string) {
  const RESEND_KEY = Deno.env.get("RESEND_API_KEY");
  if (!RESEND_KEY) {
    await supa.from("hunt_alert_log").insert({ user_id: userId, rule_id: ruleId, listing_id: listingId, channel: "email", status: "skipped", error: "no RESEND_API_KEY" });
    return;
  }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "RareBlock Hunter <hunter@rareblock.eu>",
        to, subject: `🎯 Deal ${p.deal_score}/100 — ${p.listing_title.slice(0, 60)}`,
        html: `<h2>${p.rule_name}</h2><p><b>${p.platform}</b> — €${p.price}</p><p>${p.listing_title}</p><p><a href="${p.listing_url}">Apri inserzione →</a></p>`,
      }),
    });
    const ok = r.ok;
    await supa.from("hunt_alert_log").insert({ user_id: userId, rule_id: ruleId, listing_id: listingId, channel: "email", status: ok ? "sent" : "failed", error: ok ? null : await r.text(), payload: p });
  } catch (e) {
    await supa.from("hunt_alert_log").insert({ user_id: userId, rule_id: ruleId, listing_id: listingId, channel: "email", status: "failed", error: String(e) });
  }
}

async function sendTelegram(chatId: string, p: any, supa: any, userId: string, ruleId: string, listingId: string) {
  const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!TG_TOKEN) {
    await supa.from("hunt_alert_log").insert({ user_id: userId, rule_id: ruleId, listing_id: listingId, channel: "telegram", status: "skipped", error: "no TELEGRAM_BOT_TOKEN" });
    return;
  }
  const text = `🎯 *Deal ${p.deal_score}/100* — ${p.platform.toUpperCase()}\n${p.listing_title}\n💰 €${p.price}\n[Apri →](${p.listing_url})`;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: false }),
    });
    await supa.from("hunt_alert_log").insert({ user_id: userId, rule_id: ruleId, listing_id: listingId, channel: "telegram", status: r.ok ? "sent" : "failed", error: r.ok ? null : await r.text(), payload: p });
  } catch (e) {
    await supa.from("hunt_alert_log").insert({ user_id: userId, rule_id: ruleId, listing_id: listingId, channel: "telegram", status: "failed", error: String(e) });
  }
}
