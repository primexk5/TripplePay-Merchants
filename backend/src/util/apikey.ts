import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Merchant server-to-server API keys.
 *
 * These keys are bearer credentials: anyone holding one can create gateway orders and move the
 * merchant's funds, so they must never be recoverable from a database dump. We store only
 * `HMAC-SHA256(pepper, key)` and never the key itself.
 *
 * Why HMAC rather than bcrypt/argon2: authentication needs an *indexed equality lookup*
 * ("which merchant owns this presented key?"). Password hashes are deliberately non-deterministic,
 * which forces a scan-and-verify over every key. That is fine for a handful of human passwords and
 * unacceptable for a table that grows with every installed store. Since these keys are 144 bits of
 * `randomBytes` (not guessable passwords), a fast keyed hash is the correct primitive; the pepper
 * is what stops an attacker with read-only DB access from brute-forcing offline, because without it
 * they must also have `API_KEY_PEPPER`, which lives in the environment, not the database.
 *
 * `keyRef` is a truncated, non-secret handle derived from the same HMAC. It lets us name a key in a
 * URL (`DELETE /v1/me/apikeys/qmk_7f3a…`) without ever putting the credential in a URL, where it
 * would land in access logs, proxy logs and browser history.
 */

const PREFIX = 'qmk';

/**
 * Fallback pepper for tests and `npm run dev` only, so a zero-config local run does not need a
 * generated .env. NEVER rely on this in production: it is a compile-time constant, so anyone with
 * the source (or a DB dump plus this file) could recompute every key hash. `config.ts` makes
 * `API_KEY_PEPPER` mandatory when NODE_ENV=production, so a real deployment cannot boot on it.
 */
export const DEV_API_KEY_PEPPER = 'dev-insecure-api-key-pepper';
const KEY_ID_BYTES = 6; // 12 hex chars — collision-safe at any realistic merchant count.
const REF_BYTES = 4;

function randomHex(bytes: number): string {
  const buf = randomBytes(bytes);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A freshly generated key. `key` is returned to the merchant exactly once and never persisted. */
export function generateApiKey(): { key: string; keyId: string } {
  const keyId = `${PREFIX}_${randomHex(KEY_ID_BYTES)}`;
  return { key: `${keyId}_${randomBytes(24).toString('base64url')}`, keyId };
}

/** The HMAC that is actually stored. */
export function hashApiKey(key: string, pepper: string): string {
  return createHmac('sha256', pepper).update(key, 'utf8').digest('hex');
}

/**
 * A short, non-secret public handle for a key, derived from its hash. Safe to log and to place in a
 * URL: it identifies a key without revealing it and cannot be inverted to recover the HMAC.
 */
export function apiKeyRef(keyHash: string): string {
  return `${PREFIX}_${keyHash.slice(0, REF_BYTES * 2)}`;
}

/** How a key is shown in the UI and in `GET /v1/me/apikeys` — e.g. `qmk_7f3a91c2…wQd`. */
export function maskApiKey(key: string): string {
  if (key.length <= REF_BYTES * 2 + 8) return `${PREFIX}_…`;
  return `${key.slice(0, PREFIX.length + 1 + REF_BYTES * 2)}…${key.slice(-3)}`;
}

/** Constant-time comparison, for the in-memory store path where we hold both values in hand. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** True for keys issued in the current format, false for pre-hashing legacy keys. */
export function isCurrentFormat(key: string): boolean {
  return key.startsWith(`${PREFIX}_`) && key.split('_').length >= 3;
}
