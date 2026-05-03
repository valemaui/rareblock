// chain/test/db-adapter.test.js
//
// Verifica che il DB adapter (Supabase) implementi correttamente l'interfaccia
// `deps.db` richiesta dal mint-orchestrator.
//
// Mock di un Supabase client minimo: registra le call e ritorna data finta.
// Così verifichiamo che le chiamate Supabase siano formate bene (table, eq,
// rpc names) senza dover stare connessi al DB reale.

"use strict";

const test       = require("node:test");
const assert     = require("node:assert/strict");
const { makeDbAdapter } = require("../supabase-functions/_shared/db-adapter");

// ──────────────────────────────────────────────────────────────────────
//  Tiny Supabase mock — chainable .from().select().eq().maybeSingle()
// ──────────────────────────────────────────────────────────────────────
function makeSb({ tableData = {}, rpcData = {}, authUsers = {}, storageOps = [] } = {}) {
  const log = { from: [], rpc: [], auth: [], storage: [] };

  function mockQuery(table, op = {}) {
    const state = { table, ...op };
    const handler = {
      select(cols) { state.select = cols; return handler; },
      eq(col, val) { state.eq = state.eq || {}; state.eq[col] = val; return handler; },
      order(col, { ascending } = {}) { state.order = { col, ascending }; return handler; },
      limit(n) { state.limit = n; return handler; },
      insert(data) { state.insert = data; return handler; },
      single() {
        log.from.push({ ...state, method: "single" });
        return Promise.resolve(resolveTable(table, state, false));
      },
      maybeSingle() {
        log.from.push({ ...state, method: "maybeSingle" });
        return Promise.resolve(resolveTable(table, state, true));
      },
    };
    return handler;
  }

  function resolveTable(table, state, isMaybe) {
    const rows = tableData[table] || [];
    let filtered = rows;
    if (state.eq) {
      filtered = rows.filter(r => Object.entries(state.eq).every(([k,v]) => r[k] === v));
    }
    if (state.order) {
      filtered = [...filtered].sort((a,b) => {
        const m = state.order.ascending ? 1 : -1;
        return (a[state.order.col] - b[state.order.col]) * m;
      });
    }
    if (state.limit) filtered = filtered.slice(0, state.limit);

    // Insert
    if (state.insert) {
      const inserted = Array.isArray(state.insert) ? state.insert : [state.insert];
      inserted.forEach(r => rows.push({ id: `auto-${rows.length+1}`, ...r }));
      const last = inserted[inserted.length - 1];
      const stored = rows[rows.length - 1];
      return { data: stored, error: null };
    }

    if (filtered.length === 0) return isMaybe ? { data: null, error: null } : { data: null, error: { message: "not found" } };
    return { data: filtered[0], error: null };
  }

  return {
    _log: log,
    from: (table) => mockQuery(table),
    rpc:  (name, params) => {
      log.rpc.push({ name, params });
      return Promise.resolve({ data: rpcData[name], error: null });
    },
    auth: {
      admin: {
        getUserById: (uid) => {
          log.auth.push({ method: "getUserById", uid });
          return Promise.resolve({
            data: { user: authUsers[uid] || null },
            error: null,
          });
        },
      },
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────
test("db.isAdmin: profile role check", async () => {
  const sb = makeSb({ tableData: {
    profiles: [
      { id: "u-admin", role: "admin" },
      { id: "u-user",  role: "investor" },
    ],
  }});
  const db = makeDbAdapter(sb);
  assert.equal(await db.isAdmin("u-admin"), true);
  assert.equal(await db.isAdmin("u-user"),  false);
  assert.equal(await db.isAdmin("u-none"),  false);
});

test("db.loadOrder / loadProduct: select + eq id", async () => {
  const sb = makeSb({ tableData: {
    inv_orders:   [{ id: "o1", status: "payment_received", qty: 5 }],
    inv_products: [{ id: "p1", name: "Charizard", type: "fractional" }],
  }});
  const db = makeDbAdapter(sb);
  const o = await db.loadOrder("o1");
  assert.equal(o.id, "o1");
  const p = await db.loadProduct("p1");
  assert.equal(p.name, "Charizard");
  // not found → null
  assert.equal(await db.loadOrder("missing"), null);
});

test("db.loadUser: combina auth.users con profiles", async () => {
  const sb = makeSb({
    authUsers: { "u-1": { id: "u-1", email: "a@b.com" } },
    tableData: { profiles: [{ id: "u-1", display_name: "Alice" }] },
  });
  const db = makeDbAdapter(sb);
  const u = await db.loadUser("u-1");
  assert.equal(u.id, "u-1");
  assert.equal(u.email, "a@b.com");
  assert.equal(u.display_name, "Alice");
});

test("db.loadExistingCertificate: ritorna null se non esiste", async () => {
  const sb = makeSb({ tableData: { chain_certificates: [] }});
  const db = makeDbAdapter(sb);
  assert.equal(await db.loadExistingCertificate("o1"), null);
});

test("db.loadExistingCertificate: ritorna il certificato esistente", async () => {
  const sb = makeSb({ tableData: {
    chain_certificates: [{ id: "c1", order_id: "o1", certificate_serial: "RB-2026-000001" }],
  }});
  const db = makeDbAdapter(sb);
  const c = await db.loadExistingCertificate("o1");
  assert.equal(c.id, "c1");
});

test("db.getOrCreateUserWallet: nessun wallet → ritorna nextIdx con address null", async () => {
  const sb = makeSb({ tableData: {
    chain_wallets: [{ user_id: "other", derivation_index: 5 }],
  }});
  const db = makeDbAdapter(sb);
  const r = await db.getOrCreateUserWallet("u-new", null, null);
  assert.equal(r.address, null);
  assert.equal(r.derivationIndex, 6);
});

test("db.getOrCreateUserWallet: wallet esistente → ritorna esistente", async () => {
  const sb = makeSb({ tableData: {
    chain_wallets: [{ user_id: "u-1", address: "0xabc", derivation_index: 3 }],
  }});
  const db = makeDbAdapter(sb);
  const r = await db.getOrCreateUserWallet("u-1", null, null);
  assert.equal(r.address, "0xabc");
  assert.equal(r.derivationIndex, 3);
});

test("db.getOrCreateUserWallet: insert nuovo wallet con address+idx", async () => {
  const sb = makeSb({ tableData: { chain_wallets: [] }});
  const db = makeDbAdapter(sb);
  const r = await db.getOrCreateUserWallet(
    "u-new", "0x1234567890abcdef1234567890abcdef12345678", 1
  );
  assert.equal(r.address, "0x1234567890abcdef1234567890abcdef12345678");
  assert.equal(r.derivationIndex, 1);
});

test("db.nextSerial / productTokenId: chiamano le RPC corrette", async () => {
  const sb = makeSb({ rpcData: {
    chain_next_certificate_serial: "RB-2026-000099",
    chain_product_token_id:        "70922435100124324324324324324324324324324324324",
  }});
  const db = makeDbAdapter(sb);
  assert.equal(await db.nextSerial(), "RB-2026-000099");
  const tid = await db.productTokenId("33333333-3333-3333-3333-333333333333");
  assert.equal(typeof tid, "bigint");
  assert.equal(tid.toString(), "70922435100124324324324324324324324324324324324");
  // Verify RPC names called are exactly the migration's function names
  assert.deepEqual(sb._log.rpc[0].name, "chain_next_certificate_serial");
  assert.deepEqual(sb._log.rpc[1].name, "chain_product_token_id");
});

test("db.insertCertificate / insertTransfer: insert + select single", async () => {
  const sb = makeSb({ tableData: { chain_certificates: [], chain_transfers: [] }});
  const db = makeDbAdapter(sb);
  const cert = await db.insertCertificate({
    order_id: "o1", certificate_serial: "RB-2026-000001",
    qty_minted: 5, status: "minted",
  });
  assert.equal(cert.certificate_serial, "RB-2026-000001");
  assert.ok(cert.id);

  const xfer = await db.insertTransfer({
    certificate_id: cert.id, transfer_type: "mint",
    qty: 5, from_wallet: "0x0", to_wallet: "0x1",
  });
  assert.equal(xfer.transfer_type, "mint");
});
