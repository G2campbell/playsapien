/* WebCrypto helpers. Nothing here imports anything: the Worker runtime gives us
   crypto.subtle, crypto.getRandomValues, TextEncoder, atob and btoa, and that is
   the whole toolbox. Deliberately so -- a dependency in the Worker is a supply
   chain you have to watch forever for the sake of thirty lines. */

const enc = new TextEncoder();

/* ---------------------------------------------------------------- encoding */

export function bytesToHex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlToBytes(s) {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

/* ---------------------------------------------------------------- hashing */

export async function sha256Hex(input) {
  const data = typeof input === 'string' ? enc.encode(input) : input;
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
}

/* Compare two strings in time that does not depend on where they first differ.
   Hashes are the only thing we compare this way, and they are fixed length, but
   the length check is folded into the accumulator rather than returned early so
   that a wrong-length input is not distinguishable from a wrong-value one. */
export function timingSafeEqual(a, b) {
  const as = String(a), bs = String(b);
  let diff = as.length ^ bs.length;
  const n = Math.max(as.length, bs.length);
  for (let i = 0; i < n; i++) diff |= as.charCodeAt(i % as.length || 0) ^ bs.charCodeAt(i % bs.length || 0);
  return diff === 0;
}

/* ---------------------------------------------------------------- six digits */

/* Uniform over 000000..999999.

   The obvious `randomUint32() % 1000000` is biased: 2^32 is not a multiple of
   10^6, so the low 4294 values come up fractionally more often. The bias is
   tiny -- about one part in a million -- and completely irrelevant to anyone
   guessing a code by hand. It is still wrong, and rejection sampling costs one
   extra draw once every 1200 codes, so there is no reason to accept it. */
export function randomSixDigits() {
  const limit = Math.floor(0x100000000 / 1000000) * 1000000;
  for (;;) {
    const b = randomBytes(4);
    const v = ((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3];
    if (v < limit) return String(v % 1000000).padStart(6, '0');
  }
}

/* ---------------------------------------------------------------- HMAC */

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function hmacSign(secret, message) {
  const key = await hmacKey(secret);
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message))));
}

export async function hmacVerify(secret, message, signature) {
  /* crypto.subtle.verify is itself constant time, but we go through our own
     comparison so that a malformed (unparseable) signature takes the same path
     as a wrong one rather than throwing. */
  const expected = await hmacSign(secret, message);
  return timingSafeEqual(expected, signature);
}

/* ---------------------------------------------------------------- PKCE */

/* RFC 7636 S256. The verifier never leaves the Worker except inside the signed,
   HttpOnly state cookie; only its hash goes to Google in the redirect. */
export function pkceVerifier() {
  return base64url(randomBytes(32));
}

export async function pkceChallenge(verifier) {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(verifier))));
}

/* ---------------------------------------------------------------- JWT */

/* Verify an RS256 JWT against a JWKS document and check the registered claims.

   The JWKS is passed in rather than fetched here so that the Google path and
   the Cloudflare Access path share this function, and so that tests can hand it
   a key set without a network call. Nothing in here trusts the token before the
   signature checks out: the payload is parsed to read `kid` from the *header*
   only, and the claims are read after verify, not before. */
export async function verifyJwt(token, jwks, { issuers, audience, now }) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('jwt: malformed');
  const [rawHeader, rawPayload, rawSig] = parts;

  let header;
  try { header = JSON.parse(new TextDecoder().decode(base64urlToBytes(rawHeader))); }
  catch { throw new Error('jwt: bad header'); }
  if (header.alg !== 'RS256') throw new Error('jwt: unexpected alg ' + header.alg);

  const jwk = (jwks.keys || []).find((k) => k.kid === header.kid && (!k.alg || k.alg === 'RS256'));
  if (!jwk) throw new Error('jwt: no key for kid');

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['verify']);

  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, base64urlToBytes(rawSig), enc.encode(rawHeader + '.' + rawPayload));
  if (!ok) throw new Error('jwt: bad signature');

  let claims;
  try { claims = JSON.parse(new TextDecoder().decode(base64urlToBytes(rawPayload))); }
  catch { throw new Error('jwt: bad payload'); }

  if (issuers && !issuers.includes(claims.iss)) throw new Error('jwt: wrong issuer');
  if (audience && claims.aud !== audience) throw new Error('jwt: wrong audience');
  /* 60 seconds of leeway for clock skew between Google and the edge. Google's
     own tokens are an hour long, so this costs nothing. */
  if (typeof claims.exp !== 'number' || claims.exp + 60 < now) throw new Error('jwt: expired');
  if (typeof claims.iat === 'number' && claims.iat - 60 > now) throw new Error('jwt: issued in the future');

  return claims;
}
