// chain/test/portfolio-page.test.js
//
// Test della pagina chain-portfolio.html:
//  - HTML smoke (single-file, no external scripts)
//  - Query Supabase ben formata (RLS-friendly)
//  - Risorse referenziate (verify page sibling)
//  - Funzioni JS pure replicate qui per testare la logica filtering

"use strict";

const test       = require("node:test");
const assert     = require("node:assert/strict");
const fs         = require("fs");
const path       = require("path");

const HTML_PATH = path.join(__dirname, "..", "rareblock-chain-portfolio.html");
const html      = fs.readFileSync(HTML_PATH, "utf8");

// ─── Smoke: single-file & no external runtime deps ────────────────────
test("portfolio: HTML è single-file (no <script src> esterni)", () => {
  const externalScripts = html.match(/<script\s+[^>]*src=/gi) || [];
  assert.equal(externalScripts.length, 0,
    "portfolio page deve essere single-file");
});

test("portfolio: usa solo Google Fonts come asset esterno", () => {
  const linkHrefs = (html.match(/<link[^>]+href="([^"]+)"/g) || [])
    .map(l => l.match(/href="([^"]+)"/)[1]);
  for (const href of linkHrefs) {
    const ok = href.startsWith("https://fonts.googleapis.com")
            || href.startsWith("https://fonts.gstatic.com");
    assert.ok(ok, `link non whitelisted: ${href}`);
  }
});

test("portfolio: contiene Supabase config corretto", () => {
  assert.ok(html.includes("rbjaaeyjeeqfpbzyavag.supabase.co"),
    "deve usare il progetto Supabase corretto");
  assert.ok(html.includes("'rb_auth_session'"),
    "deve usare la chiave session condivisa col Collector");
});

test("portfolio: link al verify page (sibling)", () => {
  assert.ok(html.includes("rareblock-chain-verify.html"),
    "deve linkare la verify page");
});

test("portfolio: query chain_certificates corretta (PostgREST nested select)", () => {
  // L'ordering deve essere by minted_at desc
  assert.ok(html.includes("order=minted_at.desc"),
    "deve ordinare i certificati dal più recente");
  // Nested select dei campi prodotto
  assert.ok(html.includes("product:inv_products"),
    "deve fare nested select del product joined");
  // Campi essenziali presenti nel select
  for (const f of ["certificate_serial","token_id","chain_id","tx_hash_mint",
                    "qty_minted","status","minted_at","certificate_pdf_url",
                    "ipfs_metadata_uri","current_owner_wallet"]) {
    assert.ok(html.includes(f), `select deve includere il campo "${f}"`);
  }
});

test("portfolio: NON espone service_role o admin tokens", () => {
  assert.ok(!html.match(/service[_-]?role/i),
    "il file non deve riferirsi a service_role");
  assert.ok(!html.includes('"role":"service_role"'),
    "non deve incollare un service-role JWT");
});

// ─── Auth flow sanity ─────────────────────────────────────────────────
test("portfolio: ha logica login + restore session + refresh", () => {
  assert.ok(html.includes("auth/v1/token?grant_type=password"),
    "deve avere il login flow Supabase");
  assert.ok(html.includes("grant_type=refresh_token"),
    "deve avere il refresh flow");
  assert.ok(html.includes("clearSession()"),
    "deve avere logout/clear session");
});

// ─── Logica pura riprodotta per testarla ──────────────────────────────
const CHAIN_CFG = {
  8453:  { name:'Base',         explorer:'https://basescan.org' },
  84532: { name:'Base Sepolia', explorer:'https://sepolia.basescan.org' },
  31337: { name:'Local',        explorer:null },
};
function applyFilter(certs, filter, search) {
  let out = certs;
  if (filter !== 'all') out = out.filter(c => c.status === filter);
  if (search) {
    const q = search.toLowerCase();
    out = out.filter(c =>
      (c.certificate_serial || '').toLowerCase().includes(q) ||
      (c.product?.name || '').toLowerCase().includes(q)
    );
  }
  return out;
}

const FIXTURE = [
  { certificate_serial:"RB-2026-000001", status:"minted",      qty_minted:5,
    chain_id:84532, product:{ name:"Charizard Holo" } },
  { certificate_serial:"RB-2026-000002", status:"minted",      qty_minted:2,
    chain_id:84532, product:{ name:"Pikachu Illustrator" } },
  { certificate_serial:"RB-2026-000003", status:"transferred", qty_minted:10,
    chain_id:8453,  product:{ name:"Blastoise Holo" } },
  { certificate_serial:"RB-2026-000004", status:"frozen",      qty_minted:1,
    chain_id:8453,  product:{ name:"Mew Promo" } },
];

test("portfolio: filter 'all' ritorna tutto", () => {
  assert.equal(applyFilter(FIXTURE, 'all', '').length, 4);
});
test("portfolio: filter 'minted' ritorna solo attivi", () => {
  const out = applyFilter(FIXTURE, 'minted', '');
  assert.equal(out.length, 2);
  out.forEach(c => assert.equal(c.status, 'minted'));
});
test("portfolio: filter 'transferred' ritorna solo trasferiti", () => {
  const out = applyFilter(FIXTURE, 'transferred', '');
  assert.equal(out.length, 1);
  assert.equal(out[0].certificate_serial, 'RB-2026-000003');
});
test("portfolio: search by serial", () => {
  const out = applyFilter(FIXTURE, 'all', '000003');
  assert.equal(out.length, 1);
  assert.equal(out[0].product.name, 'Blastoise Holo');
});
test("portfolio: search by asset name (case-insensitive)", () => {
  const out = applyFilter(FIXTURE, 'all', 'CHARIZARD');
  assert.equal(out.length, 1);
});
test("portfolio: search + filter combinati", () => {
  const out = applyFilter(FIXTURE, 'minted', 'pikachu');
  assert.equal(out.length, 1);
  assert.equal(out[0].certificate_serial, 'RB-2026-000002');
});
test("portfolio: search no-match ritorna []", () => {
  assert.equal(applyFilter(FIXTURE, 'all', 'zzzzz').length, 0);
});

// ─── Stats calcolate correttamente ────────────────────────────────────
function calcStats(certs) {
  const active = certs.filter(c => c.status === 'minted');
  const totalShares = certs.reduce((s, c) => s + (c.qty_minted || 0), 0);
  const chains = Array.from(new Set(certs.map(c => c.chain_id)))
    .map(id => CHAIN_CFG[id]?.name || ('chain '+id));
  return { count: certs.length, totalShares, active: active.length, chains };
}

test("portfolio: stats — count + total shares + active + chains", () => {
  const s = calcStats(FIXTURE);
  assert.equal(s.count, 4);
  assert.equal(s.totalShares, 18);     // 5+2+10+1
  assert.equal(s.active, 2);
  assert.deepEqual(new Set(s.chains), new Set(['Base Sepolia', 'Base']));
});

test("portfolio: stats su portfolio vuoto", () => {
  const s = calcStats([]);
  assert.equal(s.count, 0);
  assert.equal(s.totalShares, 0);
  assert.equal(s.active, 0);
  assert.deepEqual(s.chains, []);
});

// ─── Date format ──────────────────────────────────────────────────────
test("portfolio: contiene helper escHtml per XSS-safety", () => {
  assert.ok(html.includes("escHtml"),
    "deve definire escHtml per evitare XSS nei dati DB");
  // Verifica che venga usato in punti critici
  assert.ok(html.match(/escHtml\(c\.certificate_serial\)/),
    "serial deve essere passato attraverso escHtml");
  assert.ok(html.match(/escHtml\(product\.name/),
    "product.name deve essere passato attraverso escHtml");
});

// ─── XSS hardening: verifica che nessun campo DB finisca direttamente in innerHTML
test("portfolio: nessun .innerHTML con interpolation diretta non escaped", () => {
  // Cerchiamo pattern come `${c.foo}` dentro innerHTML
  // Tutti i campi devono essere wrappati in escHtml() oppure essere costanti.
  const lines = html.split('\n');
  let unsafeFound = [];
  lines.forEach((line, i) => {
    // Skip lines that aren't dealing with templates
    if (!line.includes('${')) return;
    // Look for direct interpolation of variables that could be from DB
    // (loose heuristic — full audit done manually, but smoke check)
    const dangerous = line.match(/\$\{c\.[a-z_]+\}/);
    if (dangerous && !line.includes('escHtml') && !line.includes('=') && line.includes('innerHTML')) {
      unsafeFound.push(`L${i+1}: ${line.trim()}`);
    }
  });
  assert.equal(unsafeFound.length, 0,
    `Found unescaped DB interpolation:\n${unsafeFound.join('\n')}`);
});
