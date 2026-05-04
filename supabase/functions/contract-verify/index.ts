// =============================================================================
// Supabase Edge Function: contract-verify
// =============================================================================
// SELF-CONTAINED.
// Endpoint PUBBLICO (anche anonimo) per verificare la notarizzazione di un
// contratto RareBlock. Usa la function SECURITY DEFINER notarize_lookup_*
// (migration 039) che espone SOLO i dati tecnici (no PII).
//
// Due modalità:
//
//   A) GET ?serial=RB-VND-2026-000001
//      → cerca per numero contratto
//
//   B) GET ?sha256=0x...
//      → cerca per hash del PDF (il chiamante calcola lo SHA-256 dal PDF
//        in suo possesso e verifica che sia stato notarizzato)
//
//   C) POST con file PDF binario
//      → calcola sha256 lato server e cerca (utility per chi non vuole
//        farlo lato client)
//
// Risposta:
// {
//   ok: true,
//   contract_serial:  "...",
//   pdf_sha256:       "0x...",
//   chain_id:         8453,
//   tx_hash:          "0x...",
//   block_number:     12345678,
//   block_timestamp:  "2026-05-04T...",
//   notarized_at:     "2026-05-04T...",
//   basescan_url:     "https://basescan.org/tx/...",
//   verified_at:      "2026-05-04T..."  // ora di questa verifica (utile per pdf-print)
// }
//
// CORS aperto per consentire chiamate da pagine pubbliche di verifica.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';


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

function txUrl(chainId: number | null | undefined, txHash: string | null | undefined): string | null {
  if (!txHash) return null;
  if (chainId === 84532) return `https://sepolia.basescan.org/tx/${txHash}`;
  return `https://basescan.org/tx/${txHash}`;
}


// SHA-256 di binari per la modalità POST
async function sha256OfBytes(bytes: ArrayBuffer): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  const arr = new Uint8Array(buf);
  let s = '0x';
  for (const b of arr) s += b.toString(16).padStart(2, '0');
  return s;
}


Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'GET' && req.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // Usa l'anon client: le funzioni notarize_lookup_* sono GRANT EXECUTE TO anon.
    const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    // Service-role usato SOLO per il fallback "contratto firmato ma non
    // notarizzato": serve per bypassare RLS su `contracts`. La response
    // espone solo dati pseudonimizzati (numero contratto, status, hash, data),
    // mai PII delle parti — coerente con il principio di verifica pubblica.
    const sbAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    let serial: string | null = null;
    let sha256: string | null = null;

    if (req.method === 'GET') {
      const url = new URL(req.url);
      serial = url.searchParams.get('serial');
      sha256 = url.searchParams.get('sha256');
    } else {
      // POST: può essere JSON {serial,sha256} o multipart con un file PDF
      const ctype = req.headers.get('content-type') || '';
      if (ctype.includes('application/json')) {
        const body = await req.json().catch(() => null);
        if (body) {
          serial = body.serial ?? null;
          sha256 = body.sha256 ?? null;
        }
      } else if (ctype.includes('multipart/form-data')) {
        const form = await req.formData();
        const f = form.get('pdf');
        if (f instanceof File) {
          const bytes = await f.arrayBuffer();
          sha256 = await sha256OfBytes(bytes);
        }
        serial = (form.get('serial') as string) || null;
      } else if (ctype.startsWith('application/pdf')) {
        const bytes = await req.arrayBuffer();
        sha256 = await sha256OfBytes(bytes);
      }
    }

    if (!serial && !sha256) {
      return json({
        error: 'missing_query',
        hint:  'Pass ?serial=RB-... or ?sha256=0x... or POST a PDF.',
      }, 400);
    }

    let row: any = null;
    if (sha256) {
      const norm = '0x' + sha256.toLowerCase().replace(/^0x/, '');
      if (!/^0x[0-9a-f]{64}$/.test(norm)) {
        return json({ error: 'invalid_sha256_format' }, 400);
      }
      const { data, error } = await sb.rpc('notarize_lookup_by_hash', { p_sha256: norm });
      if (error) return json({ error: 'rpc_error', detail: error.message }, 500);
      row = Array.isArray(data) && data.length ? data[0] : null;
    } else if (serial) {
      const { data, error } = await sb.rpc('notarize_lookup_public', { p_serial: serial });
      if (error) return json({ error: 'rpc_error', detail: error.message }, 500);
      row = Array.isArray(data) && data.length ? data[0] : null;
    }

    if (!row) {
      // Caso intermedio: il serial è in input ma non c'è notarizzazione.
      // Controlliamo se almeno il CONTRATTO esiste ed è firmato — in quel
      // caso la firma FEA è valida (eIDAS art. 26) ma manca solo l'ancoraggio
      // on-chain. È diverso dal serial completamente sconosciuto.
      if (serial) {
        const { data: contractRow } = await sbAdmin
          .from('contracts')
          .select('contract_number, status, signed_at, pdf_signed_sha256')
          .eq('contract_number', serial)
          .in('status', ['signed','revoked'])
          .maybeSingle();
        if (contractRow) {
          return json({
            ok:               true,
            found:            false,
            signed_but_not_notarized: true,
            contract_serial:  contractRow.contract_number,
            status:           contractRow.status,
            signed_at:        contractRow.signed_at,
            pdf_sha256:       contractRow.pdf_signed_sha256,
            message:          contractRow.status === 'revoked'
              ? 'Il contratto esiste ma è stato revocato.'
              : 'Il contratto è firmato e valido come Firma Elettronica Avanzata (eIDAS art. 26 + CAD art. 20). L\'ancoraggio on-chain non è stato eseguito o non è ancora pervenuto: la firma resta legalmente valida.',
          }, 200);
        }
      }
      return json({
        ok: false,
        found: false,
        message: sha256
          ? 'Nessuna notarizzazione trovata per questo hash. Il PDF potrebbe essere stato modificato dopo la firma, oppure non è mai stato notarizzato.'
          : 'Nessun contratto trovato con questo serial.',
      }, 200);
    }

    return json({
      ok:               true,
      found:            true,
      contract_serial:  row.contract_serial,
      pdf_sha256:       row.pdf_sha256,
      chain_id:         row.chain_id,
      tx_hash:          row.tx_hash,
      block_number:     row.block_number,
      block_timestamp:  row.block_timestamp,
      notarized_at:     row.notarized_at,
      status:           row.status,
      basescan_url:     txUrl(row.chain_id, row.tx_hash),
      verified_at:      new Date().toISOString(),
      verifier_note:    "Dato pseudonimizzato: l'identità delle parti non è esposta on-chain. Per contestare l'autenticità del PDF, calcola lo SHA-256 dal file in tuo possesso e confrontalo con `pdf_sha256`.",
    });

  } catch (e: any) {
    return json({ error: 'unexpected', detail: e?.message ?? String(e) }, 500);
  }
});
