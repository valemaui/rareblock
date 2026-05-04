// =============================================================================
// Supabase Edge Function: contract-notarize
// =============================================================================
// SELF-CONTAINED (deploy-friendly via Dashboard UI o CLI).
//
// Notarizza un contratto firmato ancorando on-chain (Base mainnet)
// l'hash SHA-256 del PDF firmato.
//
// Strategia: invece di smart contract custom, una self-send tx con
// calldata strutturata. La tx finisce in un blocco con timestamp certo,
// la calldata è leggibile su BaseScan, l'hash del PDF è verificabile
// matematicamente da chiunque.
//
// Calldata layout (81 bytes):
//   0x52424b01                       (4 bytes)  — magic "RBK\x01"
//   version                          (1 byte)   — schema version (0x01)
//   sha256(pdf)                      (32 bytes) — SHA-256 del PDF firmato
//   contract_serial_short            (16 bytes) — ASCII, padded NULL
//   keccak256(user_id_uuid_string)   (32 bytes) — pseudonymous user ref
//   ──────────────────────────────────────────
//   = 85 bytes totali
//
// Body atteso:
//   {
//     "contract_id":     "<uuid>",       // opzionale, soft-FK
//     "contract_serial": "RB-VND-2026-000001",
//     "pdf_sha256":      "0x..." or "...",  // 32 bytes hex
//     "user_id":         "<uuid>"        // utente che ha firmato
//   }
//
// Risposta (sincrona): { ok, notarization_id, tx_hash, block_number?, basescan_url }
//   - se la tx viene confermata entro ~15s: tutti i campi popolati
//   - altrimenti: tx_hash è valorizzato ma block_number è null;
//     un secondo polling aggiornerà lo stato
//
// Auth: solo admin o service_role (chiamata server-to-server da contract-sign).
//
// Secrets richiesti:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY        (auto)
//   NOTARIZE_OPERATOR_PRIVATE_KEY  (0x... 32 bytes hex, EOA con saldo Base)
//   NOTARIZE_RPC_URL               (opzionale, default https://mainnet.base.org)
//   NOTARIZE_CHAIN_ID              (opzionale, default 8453)
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  createWalletClient,
  createPublicClient,
  http,
  toHex,
  keccak256,
  encodePacked,
  hexToBytes,
  bytesToHex,
} from 'https://esm.sh/viem@2.21.19';
import { privateKeyToAccount } from 'https://esm.sh/viem@2.21.19/accounts';
import { base, baseSepolia } from 'https://esm.sh/viem@2.21.19/chains';


// ═════════════════════════════════════════════════════════════════════════════
// HTTP helpers (inlined)
// ═════════════════════════════════════════════════════════════════════════════
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, apikey',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}


// ═════════════════════════════════════════════════════════════════════════════
// Calldata builder — layout custom RareBlock
// ═════════════════════════════════════════════════════════════════════════════
const MAGIC = '0x52424b01';   // "RBK\x01"
const SCHEMA_VERSION = 0x01;

/**
 * Costruisce il calldata di notarizzazione (85 bytes hex).
 */
function buildCalldata(opts: {
  pdfSha256:      string;     // 64 hex chars (con o senza 0x)
  contractSerial: string;     // es. "RB-VND-2026-000001" (max 16 chars effettivi)
  userIdHash:     string;     // 64 hex chars (con o senza 0x), keccak256(uuid)
}): { hex: string; userIdHash: string } {
  const sha = opts.pdfSha256.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error('invalid_pdf_sha256');

  // Serial: ASCII, exactly 16 bytes (truncate or pad with NULL)
  const serialBytes = new Uint8Array(16);
  const enc = new TextEncoder().encode(opts.contractSerial);
  for (let i = 0; i < Math.min(16, enc.length); i++) serialBytes[i] = enc[i];
  const serialHex = bytesToHex(serialBytes).slice(2);   // 32 hex chars

  const uHash = opts.userIdHash.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(uHash)) throw new Error('invalid_user_id_hash');

  // Concatena: magic(4) + version(1) + sha(32) + serial(16) + uhash(32) = 85 bytes
  const calldata = '0x'
    + '52424b01'                                // magic
    + SCHEMA_VERSION.toString(16).padStart(2, '0')
    + sha
    + serialHex
    + uHash;

  return { hex: calldata, userIdHash: '0x' + uHash };
}


// ═════════════════════════════════════════════════════════════════════════════
// Hashing helpers
// ═════════════════════════════════════════════════════════════════════════════
/**
 * Calcola keccak256(uuid) — usato per pseudonimizzare l'user_id on-chain.
 */
function hashUserId(uuid: string): string {
  // L'UUID è una stringa di 36 char con dashes; lo manteniamo così come UTF-8 input
  // (forma lowercase canonical) per ottenere un hash deterministico.
  return keccak256(new TextEncoder().encode(uuid.toLowerCase()));
}


// ═════════════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═════════════════════════════════════════════════════════════════════════════
interface NotarizeInput {
  contract_id?:     string;
  contract_serial:  string;
  pdf_sha256:       string;
  user_id:          string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405);

  try {
    // ── 1. Auth ───────────────────────────────────────────────────────
    const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const SUPABASE_ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY')!;

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'missing_authorization' }, 401);

    // Caller deve essere admin OPPURE service_role (chiamata server-to-server
    // da contract-sign, che bypassa la RLS via service_role).
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: ud, error: userErr } = await userClient.auth.getUser();
    let isAdminCaller = false;
    if (!userErr && ud?.user) {
      // verifica admin
      const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const { data: prof } = await adminClient.from('profiles').select('role').eq('id', ud.user.id).maybeSingle();
      isAdminCaller = prof?.role === 'admin';
    }
    // Se il chiamante è il service_role JWT, ud sarà null ma authHeader contiene
    // la service role key. Riconosciamolo confrontando con SUPABASE_SERVICE_ROLE_KEY.
    const isServiceRole = authHeader.replace(/^Bearer\s+/i, '') === SUPABASE_SERVICE_ROLE_KEY;
    if (!isAdminCaller && !isServiceRole) {
      return json({ error: 'forbidden' }, 403);
    }

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // ── 2. Parse body ─────────────────────────────────────────────────
    const body = (await req.json().catch(() => null)) as NotarizeInput | null;
    if (!body || !body.contract_serial || !body.pdf_sha256 || !body.user_id) {
      return json({ error: 'missing_fields', required: ['contract_serial','pdf_sha256','user_id'] }, 400);
    }

    const sha256normalized = '0x' + body.pdf_sha256.toLowerCase().replace(/^0x/, '');
    if (!/^0x[0-9a-f]{64}$/.test(sha256normalized)) {
      return json({ error: 'invalid_pdf_sha256_format' }, 400);
    }
    if (body.contract_serial.length > 64) {
      return json({ error: 'contract_serial_too_long' }, 400);
    }

    // ── 3. Idempotenza: se questo PDF è già 'confirmed', restituisci esistente
    const existing = await adminClient
      .from('contract_notarizations')
      .select('id, tx_hash, block_number, status, chain_id')
      .eq('pdf_sha256', sha256normalized)
      .eq('status', 'confirmed')
      .maybeSingle();
    if (existing.data) {
      return json({
        ok: true,
        already_notarized: true,
        notarization_id: existing.data.id,
        tx_hash:         existing.data.tx_hash,
        block_number:    existing.data.block_number,
        basescan_url:    txUrl(existing.data.chain_id, existing.data.tx_hash),
      });
    }

    // ── 4. Carica wallet operator ─────────────────────────────────────
    const operatorPk = Deno.env.get('NOTARIZE_OPERATOR_PRIVATE_KEY');
    if (!operatorPk) {
      return json({ error: 'operator_not_configured', detail: 'set NOTARIZE_OPERATOR_PRIVATE_KEY secret' }, 500);
    }
    const pkNormalized = ('0x' + operatorPk.replace(/^0x/, '')) as `0x${string}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(pkNormalized)) {
      return json({ error: 'invalid_operator_private_key_format' }, 500);
    }
    const account = privateKeyToAccount(pkNormalized);
    const operatorAddr = account.address;

    // ── 5. Configura chain & RPC ──────────────────────────────────────
    const chainIdStr = Deno.env.get('NOTARIZE_CHAIN_ID') ?? '8453';
    const chainId    = parseInt(chainIdStr, 10);
    const chain      = chainId === 84532 ? baseSepolia : base;
    const rpcUrl     = Deno.env.get('NOTARIZE_RPC_URL') ?? chain.rpcUrls.default.http[0];

    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

    // ── 6. Costruisci calldata ────────────────────────────────────────
    const userIdHashHex = hashUserId(body.user_id);   // 0x...64
    const { hex: calldata } = buildCalldata({
      pdfSha256:      sha256normalized,
      contractSerial: body.contract_serial,
      userIdHash:     userIdHashHex,
    });

    // ── 7. Insert record DB (status='pending') ────────────────────────
    const { data: insRow, error: insErr } = await adminClient
      .from('contract_notarizations')
      .insert({
        contract_id:     body.contract_id ?? null,
        contract_serial: body.contract_serial,
        user_id:         body.user_id,
        user_id_hash:    userIdHashHex,
        pdf_sha256:      sha256normalized,
        chain_id:        chainId,
        operator_addr:   operatorAddr,
        raw_calldata:    calldata,
        status:          'pending',
        attempts:        0,
      })
      .select('id')
      .single();
    if (insErr || !insRow) {
      return json({ error: 'db_insert_failed', detail: insErr?.message }, 500);
    }
    const notarId = insRow.id;

    // ── 8. Aggiorna operator state (best-effort) ──────────────────────
    try {
      await adminClient.from('notarize_operator_state').update({
        operator_addr:   operatorAddr,
        chain_id:        chainId,
        last_synced_at:  new Date().toISOString(),
      }).eq('id', 1);
    } catch { /* best-effort */ }

    // ── 9. Verifica saldo operator (warning, non bloccante) ───────────
    let balance: bigint = 0n;
    try {
      balance = await publicClient.getBalance({ address: operatorAddr });
    } catch (e) {
      // RPC down? proviamo lo stesso, ma è probabile fallimento
    }
    if (balance < 100_000_000_000_000n) {  // < 0.0001 ETH
      // saldo potenzialmente insufficiente: non blocchiamo, ma lo notiamo
      await adminClient.from('contract_notarizations').update({
        error_message: 'low_operator_balance:' + balance.toString(),
      }).eq('id', notarId);
    }

    // ── 10. Invia tx ──────────────────────────────────────────────────
    let txHash: `0x${string}`;
    let nonce: number;
    try {
      // Costruisci tx self-send con calldata
      const fees = await publicClient.estimateFeesPerGas();
      nonce = await publicClient.getTransactionCount({ address: operatorAddr, blockTag: 'pending' });

      // Stima gas (typically ~21000 + 16/byte non-zero, ~22-25k totale)
      let gasLimit: bigint;
      try {
        gasLimit = await publicClient.estimateGas({
          account: operatorAddr,
          to:      operatorAddr,
          value:   0n,
          data:    calldata as `0x${string}`,
        });
        gasLimit = (gasLimit * 120n) / 100n;  // +20% margin
      } catch {
        gasLimit = 60000n;  // safe fallback
      }

      txHash = await walletClient.sendTransaction({
        account,
        to:    operatorAddr,
        value: 0n,
        data:  calldata as `0x${string}`,
        gas:   gasLimit,
        maxFeePerGas:         fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        nonce,
      });
    } catch (e: any) {
      await adminClient.from('contract_notarizations').update({
        status:           'failed',
        error_message:    String(e?.shortMessage || e?.message || e).slice(0, 1000),
        attempts:         1,
        last_attempt_at:  new Date().toISOString(),
      }).eq('id', notarId);
      return json({
        error: 'tx_send_failed',
        detail: String(e?.shortMessage || e?.message || e),
        notarization_id: notarId,
      }, 502);
    }

    // ── 11. Update record con tx_hash + status='broadcasted' ─────────
    await adminClient.from('contract_notarizations').update({
      tx_hash:          txHash,
      tx_nonce:         nonce,
      status:           'broadcasted',
      broadcasted_at:   new Date().toISOString(),
      attempts:         1,
      last_attempt_at:  new Date().toISOString(),
    }).eq('id', notarId);

    // ── 12. Wait for receipt (best-effort, max ~12s) ──────────────────
    let blockNumber: bigint | null = null;
    let blockTimestamp: bigint | null = null;
    let gasUsed: bigint | null = null;
    let effectiveGasPrice: bigint | null = null;
    let txStatus: 'success' | 'reverted' | null = null;

    try {
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: 12_000,         // 12s max in funzione
        confirmations: 1,
      });
      blockNumber       = receipt.blockNumber;
      gasUsed           = receipt.gasUsed;
      effectiveGasPrice = receipt.effectiveGasPrice;
      txStatus          = receipt.status;

      if (blockNumber != null) {
        try {
          const block = await publicClient.getBlock({ blockNumber });
          blockTimestamp = block.timestamp;
        } catch { /* non blocchiamo per il timestamp */ }
      }

      if (txStatus === 'reverted') {
        await adminClient.from('contract_notarizations').update({
          status: 'failed',
          error_message: 'tx_reverted',
          tx_hash: txHash,
          block_number: Number(blockNumber),
          gas_used: Number(gasUsed),
        }).eq('id', notarId);
        return json({
          error: 'tx_reverted',
          notarization_id: notarId,
          tx_hash: txHash,
        }, 502);
      }

      // Successo
      await adminClient.from('contract_notarizations').update({
        status:          'confirmed',
        confirmed_at:    new Date().toISOString(),
        block_number:    blockNumber != null ? Number(blockNumber) : null,
        block_timestamp: blockTimestamp != null
          ? new Date(Number(blockTimestamp) * 1000).toISOString()
          : null,
        gas_used:        gasUsed != null ? Number(gasUsed) : null,
        gas_price_wei:   effectiveGasPrice != null ? effectiveGasPrice.toString() : null,
      }).eq('id', notarId);

    } catch (e: any) {
      // Timeout — la tx è broadcast ma non ancora confermata.
      // È OK: lo stato resta 'broadcasted', un job successivo (o un retry
      // del client) la riconfermerà via lookup pubblico.
      // Non return errore: la notarizzazione è in corso, non fallita.
    }

    return json({
      ok:               true,
      notarization_id:  notarId,
      tx_hash:          txHash,
      block_number:     blockNumber != null ? Number(blockNumber) : null,
      block_timestamp:  blockTimestamp != null
        ? new Date(Number(blockTimestamp) * 1000).toISOString()
        : null,
      chain_id:         chainId,
      basescan_url:     txUrl(chainId, txHash),
      status:           blockNumber != null ? 'confirmed' : 'broadcasted',
    });

  } catch (e: any) {
    return json({ error: 'unexpected', detail: e?.message ?? String(e) }, 500);
  }
});


function txUrl(chainId: number, txHash: string): string {
  if (chainId === 84532) return `https://sepolia.basescan.org/tx/${txHash}`;
  return `https://basescan.org/tx/${txHash}`;
}
