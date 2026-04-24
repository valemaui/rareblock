#!/usr/bin/env node
/**
 * Diagnostic runner — chiama smooth-endpoint in modalità diag.
 *
 * Uso:
 *   node tools/diag-pc.js
 *   node tools/diag-pc.js "Groudon-EX Dark Explorers" "Groudon 106"
 *   node tools/diag-pc.js "Card A" "Name A" "Card B" "Name B"
 */

const SUPA_URL = 'https://rbjaaeyjeeqfpbzyavag.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJiamFhZXlqZWVxZnBienlhdmFnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4NDUxMzUsImV4cCI6MjA4OTQyMTEzNX0.NyIKfc4cR93WrCERoT1FURWGo--vHD7Bbs3fS8OaE6E';

async function runDiag(cards) {
  const body = cards && cards.length ? { source: 'diag', cards } : { source: 'diag' };
  const res = await fetch(SUPA_URL + '/functions/v1/smooth-endpoint', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPA_KEY },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { return { error: 'non-json: ' + text.slice(0, 200) }; }
}

function pad(s, n) { return String(s).padEnd(n); }

function formatReport(diag) {
  if (diag.error && !diag.cards) return '❌ ' + diag.error + '\n\nRAW: ' + JSON.stringify(diag).slice(0, 500);
  if (!diag.cards || !diag.cards.length) return '⚠ response senza cards\n\nRAW: ' + JSON.stringify(diag).slice(0, 1000);
  let out = `\n📊 Diagnostica smooth-endpoint · ${diag.generated_at}\n`;
  out += '═'.repeat(80) + '\n';

  for (const c of diag.cards) {
    out += `\n▸ ${c.card}` + (c.card_name ? ` (hint: ${c.card_name})` : '') + '\n';
    if (c.error) { out += `  ❌ ${c.error}\n`; continue; }
    out += `  title: ${c.product_title}\n`;
    out += `  url:   ${c.product_url}\n`;

    if (c.ids) {
      out += '\n  ─── ID HTML → prezzo + contesto label ───\n';
      for (const [id, d] of Object.entries(c.ids)) {
        const price = d.price != null ? '$' + String(d.price).padStart(8) : '   —    ';
        const ctx = (d.label_context || '').substring(0, 55);
        out += `  ${pad(id, 22)} ${price}  ← "${ctx}"\n`;
      }
    }

    if (c.labels && Object.keys(c.labels).length) {
      out += '\n  ─── Label-based extraction ───\n';
      for (const [lbl, p] of Object.entries(c.labels)) out += `  ${pad(lbl, 12)} $${p}\n`;
    }

    if (c.extracted) {
      out += '\n  ─── Prezzi estratti (finale) ───\n';
      const order = ['ungraded','grade7','grade8','grade9','grade9_5','psa10','bgs10','cgc10'];
      for (const k of order) {
        if (c.extracted[k] != null) out += `  ${pad(k, 12)} $${c.extracted[k]}\n`;
      }

      if (c.extracted.grades_from_listings && Object.keys(c.extracted.grades_from_listings).length) {
        out += '\n  ─── Grades from Sold Listings (casa+grade → mediana) ───\n';
        const entries = Object.entries(c.extracted.grades_from_listings)
          .sort(([a], [b]) => a.localeCompare(b));
        for (const [key, data] of entries) {
          const sym = data.currency_symbol || '$';
          out += `  ${pad(key, 10)} ${sym}${String(data.median).padStart(8)}  (${data.count} vend., range ${sym}${data.min}–${sym}${data.max})\n`;
        }
      }
    }

    if (c.price_dump && c.price_dump.length) {
      out += '\n  ─── Dump prezzi HTML (primi 40 $) ───\n';
      c.price_dump.forEach((p, i) => {
        out += `  [${String(i).padStart(2)}] $${String(p.price).padStart(10)}  ← "${(p.before || '').slice(-60)}" … "${(p.after || '').slice(0, 30)}"\n`;
      });
    }

    if (c.trend_slices && Object.keys(c.trend_slices).length) {
      out += '\n  ─── Trend markers (sezioni Price Change/1 Year/ago) ───\n';
      for (const [marker, sl] of Object.entries(c.trend_slices)) {
        out += `  [${marker}]\n     ${sl}\n`;
      }
    }

    if (c.label_occurrences && Object.keys(c.label_occurrences).length) {
      out += '\n  ─── Label occurrences (ogni label + primo \$ dopo) ───\n';
      for (const [lbl, occs] of Object.entries(c.label_occurrences)) {
        out += `  "${lbl}":\n`;
        occs.forEach((o, i) => {
          const price = o.first_price != null ? `$${o.first_price}` : '—';
          out += `     [#${i} pos=${o.pos}] ${price.padStart(10)}  "${(o.context || '').slice(0, 120)}"\n`;
        });
      }
    }

    if (c.summary_block) {
      out += '\n  ─── Summary block (blocco prezzi in fondo pagina) ───\n';
      out += '  "' + c.summary_block + '"\n';
    }

    if (c.anomalies && c.anomalies.length) {
      out += '\n  ⚠  ANOMALIE:\n';
      c.anomalies.forEach(a => out += `     - ${a}\n`);
    }
  }
  return out;
}

(async () => {
  const args = process.argv.slice(2);
  let cards = null;
  if (args.length >= 2 && args.length % 2 === 0) {
    cards = [];
    for (let i = 0; i < args.length; i += 2) cards.push({ name: args[i], card_name: args[i + 1] });
  }
  const diag = await runDiag(cards);
  console.log(formatReport(diag));
})();
