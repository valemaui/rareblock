// =============================================================================
// Supabase Edge Function: cm-image-cache
// -----------------------------------------------------------------------------
// Salva la FOTO REALE della carta (da Cardmarket) nello Storage RareBlock e
// aggancia l'URL pubblico a rb_card_index.image_url. La foto CM è spesso più
// fedele di quella della Pokémon TCG API: una volta catturata diventa la
// fonte primaria mostrata in tutta l'app.
//
// Input (POST JSON):
//   {
//     product_key: "base1|4",            // obbligatoria (chiave rb_card_index)
//     image_url:   "https://product-images.s3.cardmarket.com/...",  // oppure:
//     image_b64:   "<base64>",           // bytes forniti dal client (estensione
//     content_type:"image/jpeg",         //  Hunter / userscript, bypass totale)
//     cm_url:      "https://www.cardmarket.com/.../Singles/..." (opz, contesto)
//   }
//
// Le immagini CM sono asset statici S3 (NON dietro il WAF Cloudflare delle
// pagine HTML), quindi il fetch da datacenter di norma passa. Se invece viene
// bloccato, il client può rimandare la stessa richiesta con image_b64
// (estensione/userscript su IP residenziale) — stesso endpoint, stesso esito.
//
// Auth: JWT utente (qualsiasi authenticated). Scrittura Storage + tabella con
// service role (l'immagine è conoscenza condivisa, non dato personale).
//
// NB architettura: niente import da ../_shared/ (il deploy dashboard non
// risolve i relative import) → CORS/json inline.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, prefer',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// Host ammessi per il fetch server-side dell'immagine (solo CDN Cardmarket).
const ALLOWED_IMG_HOSTS = [
  /(^|\.)cardmarket\.com$/i,
  /^product-images\.s3\./i,
  /(^|\.)cloudfront\.net$/i, // alcuni asset CM passano da CloudFront
];

const MAX_BYTES = 4 * 1024 * 1024; // 4MB hard cap

function extFromContentType(ct: string): string {
  const c = (ct || '').toLowerCase();
  if (c.includes('png')) return 'png';
  if (c.includes('webp')) return 'webp';
  if (c.includes('gif')) return 'gif';
  return 'jpg';
}

// Riconosce il formato immagine dai magic bytes (verità sui contenuti quando
// il content-type HTTP è assente o rotto). Ritorna il MIME o null.
function sniffImageType(b: Uint8Array): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  // ISO-BMFF (AVIF/HEIC): "ftyp" a offset 4 + brand avif/avis
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 &&
      b[8] === 0x61 && b[9] === 0x76 && b[10] === 0x69) return 'image/avif';
  return null;
}

function sanitizeKey(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9._|-]+/g, '_').replace(/\|/g, '__').slice(0, 180);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
  const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ ok: false, error: 'env mancante' }, 500);

  // ── Auth: JWT utente obbligatorio ─────────────────────────────────────────
  const authHeader = req.headers.get('authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return json({ ok: false, error: 'auth richiesta' }, 401);
  try {
    const authClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: { user }, error } = await authClient.auth.getUser();
    if (error || !user) return json({ ok: false, error: 'auth non valida' }, 401);
  } catch {
    return json({ ok: false, error: 'auth non verificabile' }, 401);
  }

  // ── Input ──────────────────────────────────────────────────────────────────
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: 'JSON non valido' }, 400); }

  const productKey = String(body.product_key ?? '').trim();
  const imageUrl = String(body.image_url ?? '').trim();
  const imageB64 = String(body.image_b64 ?? '').trim();
  let contentType = String(body.content_type ?? '').trim();

  if (!productKey || productKey.length < 3) return json({ ok: false, error: 'product_key mancante' }, 400);
  if (!imageUrl && !imageB64) return json({ ok: false, error: 'image_url o image_b64 richiesti' }, 400);

  // ── Recupera i bytes ───────────────────────────────────────────────────────
  let bytes: Uint8Array | null = null;
  let sourceUrl: string | null = null;

  if (imageB64) {
    try {
      const bin = atob(imageB64.replace(/^data:[^;]+;base64,/, ''));
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      bytes = arr;
      sourceUrl = imageUrl || null;
      if (!contentType) contentType = 'image/jpeg';
    } catch {
      return json({ ok: false, error: 'base64 non decodificabile' }, 400);
    }
  } else {
    let host = '';
    try { host = new URL(imageUrl).hostname; } catch { return json({ ok: false, error: 'image_url non valido' }, 400); }
    if (!ALLOWED_IMG_HOSTS.some((re) => re.test(host))) {
      return json({ ok: false, error: 'host immagine non ammesso: ' + host }, 400);
    }
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(imageUrl, {
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/png,image/jpeg,*/*',
          'Referer': 'https://www.cardmarket.com/',
        },
      });
      clearTimeout(t);
      if (!res.ok) return json({ ok: false, error: 'fetch immagine HTTP ' + res.status, blocked: res.status === 403 }, 200);
      const ct = res.headers.get('content-type') || '';
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > MAX_BYTES) return json({ ok: false, error: 'immagine troppo grande' }, 200);
      if (buf.byteLength < 800) return json({ ok: false, error: 'immagine sospettosamente piccola (placeholder?)' }, 200);
      // Content-type dichiarato inaffidabile? L'S3 di Cardmarket a volte
      // risponde con il letterale "multerS3.AUTO_CONTENT_TYPE" (config rotta
      // lato loro) pur servendo un JPEG valido. La verità sono i bytes:
      // se i magic bytes sono di un formato immagine noto, accettiamo e
      // deriviamo il content-type reale da lì.
      const sniffed = sniffImageType(buf);
      if (ct.startsWith('image/')) {
        contentType = ct.split(';')[0];
      } else if (sniffed) {
        contentType = sniffed;
      } else {
        return json({ ok: false, error: 'content-type non immagine: ' + ct }, 200);
      }
      bytes = buf;
      sourceUrl = imageUrl;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return json({ ok: false, error: 'fetch immagine fallito: ' + msg, blocked: true }, 200);
    }
  }

  if (!bytes || bytes.byteLength > MAX_BYTES) return json({ ok: false, error: 'bytes non validi' }, 400);

  // ── Upload Storage + update rb_card_index (service role) ─────────────────
  const svc = createClient(SUPABASE_URL, SERVICE_KEY);
  const ext = extFromContentType(contentType);
  const path = `cm/${sanitizeKey(productKey)}.${ext}`;

  const up = await svc.storage.from('card-images').upload(path, bytes, {
    contentType: contentType || 'image/jpeg',
    upsert: true,
    cacheControl: '604800', // 7gg
  });
  if (up.error) return json({ ok: false, error: 'upload storage: ' + up.error.message }, 500);

  const nowIso = new Date().toISOString();
  // Cache-bust: il path storage è stabile (upsert sovrascrive lo stesso file),
  // ma CDN e browser cachano l'oggetto per 7gg. Senza un URL diverso, una
  // ri-cattura (es. correzione di una foto sbagliata) continuerebbe a mostrare
  // la vecchia immagine. Un parametro di versione forza il refetch mantenendo
  // lo stesso oggetto sottostante.
  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/card-images/${path}?v=${Date.parse(nowIso) || Date.now()}`;

  // Aggiorna l'indice se la riga esiste; se non esiste ancora (immagine
  // arrivata prima dell'upsert del client) la crea minimale: il client
  // completerà i metadati con rb_index_upsert.
  const updRes = await svc.from('rb_card_index')
    .update({ image_url: publicUrl, image_source_url: sourceUrl, image_captured_at: nowIso, updated_at: nowIso })
    .eq('product_key', productKey)
    .select('product_key');
  if (!updRes.error && (!updRes.data || !updRes.data.length)) {
    await svc.from('rb_card_index').insert({
      product_key: productKey,
      name: String(body.name ?? '?') || '?',
      image_url: publicUrl,
      image_source_url: sourceUrl,
      image_captured_at: nowIso,
      created_at: nowIso,
      updated_at: nowIso,
    });
  }

  return json({ ok: true, image_url: publicUrl, bytes: bytes.byteLength, content_type: contentType });
});
