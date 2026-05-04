// Supabase Edge Functions: shared OTP helpers
// =============================================================================
// Generazione OTP a 6 cifre con CSPRNG, hashing SHA-256 con per-record salt,
// verifica timing-safe.
//
// Scelta hashing: SHA-256+salt invece di bcrypt perché:
//  - WebCrypto nativo Deno, zero dipendenze esterne
//  - bcrypt non aggiunge sicurezza reale per OTP a 6 cifre + 5 min TTL:
//    anche con 12 round, l'attaccante con DB read-access brute-forza
//    le 10^6 combinazioni in pochi secondi indipendentemente
//  - le difese reali sono: TTL 5 min, max 3 tentativi, rate-limit, RLS chiusa
// =============================================================================

const HEX = '0123456789abcdef';

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) {
    s += HEX[b >> 4] + HEX[b & 15];
  }
  return s;
}

/**
 * Genera un OTP a 6 cifre con CSPRNG (modulo bias trascurabile, < 0.0002%).
 */
export function generateOtpCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1_000_000).padStart(6, '0');
}

/**
 * Genera un salt random a 128 bit, encoded in hex.
 */
export function generateSalt(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf  = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(buf));
}

/**
 * Calcola l'hash di un codice OTP legato a un salt specifico.
 * Restituisce la stringa nel formato `${salt}:${sha256_hex}` da salvare in DB.
 */
export async function hashOtpForStorage(code: string): Promise<string> {
  const salt = generateSalt();
  const h    = await sha256Hex(`${salt}:${code}`);
  return `${salt}:${h}`;
}

/**
 * Verifica un codice OTP contro l'hash salvato.
 * Usa timing-safe comparison per evitare side-channel attacks.
 */
export async function verifyOtpHash(code: string, stored: string): Promise<boolean> {
  const idx = stored.indexOf(':');
  if (idx <= 0) return false;
  const salt    = stored.slice(0, idx);
  const expHash = stored.slice(idx + 1);
  if (!salt || !expHash) return false;

  const actHash = await sha256Hex(`${salt}:${code}`);
  return timingSafeEqualHex(actHash, expHash);
}

/**
 * Confronto timing-safe tra due stringhe hex.
 * Restituisce false se le lunghezze divergono, ma scorre comunque tutto
 * per non leakare la lunghezza del segreto via timing.
 */
function timingSafeEqualHex(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    mismatch |= ca ^ cb;
  }
  return mismatch === 0;
}

/**
 * Maschera un numero E.164 mostrando solo le ultime 4 cifre.
 */
export function maskPhone(e164: string): string {
  if (!e164 || e164.length < 4) return '***';
  return '*** ' + e164.slice(-4);
}

/**
 * Normalizza un numero in formato E.164 (compatto, senza spazi/separatori).
 * Accetta input come "+39 333 1234567", "0039333.1234567", "+393331234567".
 * Per i numeri italiani senza prefisso "+39", lo aggiunge.
 *
 * NOTA: questa è validazione di formato base, non sostituisce libphonenumber.
 * Per la produzione si raccomanda di usare un servizio dedicato lato Twilio
 * o una libreria di parsing a runtime.
 */
export function normalizePhoneE164(input: string, defaultCC = '+39'): string | null {
  if (!input) return null;
  let s = input.trim().replace(/[\s.\-()]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (!s.startsWith('+')) {
    // numero italiano senza prefisso (3-4 cifre + 6-8 cifre)
    if (/^\d{9,11}$/.test(s)) s = defaultCC + s;
    else                      return null;
  }
  // E.164: + seguito da 8-15 cifre
  if (!/^\+\d{8,15}$/.test(s)) return null;
  return s;
}
