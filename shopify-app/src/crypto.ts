import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for the per-store gateway credentials held by the connector.
 *
 * These are bearer credentials that can move a merchant's funds, so they are never stored in the
 * clear. Each value is sealed with AES-256-GCM under `CONNECTOR_ENCRYPTION_KEY`, which lives only
 * in the connector's environment — a stolen `shop_settings` table yields ciphertext, not keys.
 *
 * GCM rather than a bare cipher because it authenticates: a value that has been tampered with in the
 * database fails to open instead of decrypting to attacker-chosen bytes.
 */

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, the GCM-recommended size
const VERSION = 'v1';

/** Whether the operator's value is already a raw 256-bit key (hex or base64), so it is used as-is. */
function isRawKey(secret: string): Buffer | undefined {
  if (/^[0-9a-fA-F]{64}$/.test(secret)) return Buffer.from(secret, 'hex');
  if (/^[A-Za-z0-9+/_-]{43,44}=?$/.test(secret)) {
    const buf = Buffer.from(secret, 'base64');
    if (buf.length === 32) return buf;
  }
  return undefined;
}

/**
 * Resolves the 32-byte AES key. A supplied 256-bit value is used verbatim; anything else is
 * stretched with SHA-256 so an operator can paste a memorable passphrase and still get a key of the
 * right length. (scrypt/argon2 would resist passphrase guessing better, but the cost would be paid
 * on every store lookup unless cached — the supported way to get this right is a generated key.)
 */
export function deriveKey(secret: string): Buffer {
  return isRawKey(secret) ?? createHash('sha256').update(`paywithquai-shopify-connector ${secret}`, 'utf8').digest();
}

/** Seals a secret to a storable string: `v1.<iv>.<authTag>.<ciphertext>`, all base64url. */
export function sealSecret(plaintext: string, masterKey: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, masterKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

/**
 * Opens a sealed secret. Returns undefined when the value is absent, malformed, or fails
 * authentication — callers treat all three the same way, because the distinction is not useful to
 * them and reporting it separately would leak whether a given row held valid ciphertext.
 */
export function openSecret(sealed: string | undefined | null, masterKey: Buffer): string | undefined {
  if (!sealed) return undefined;
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) return undefined;
  const [, ivB64, tagB64, ctB64] = parts;
  try {
    const decipher = createDecipheriv(ALGO, masterKey, Buffer.from(ivB64!, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64!, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64!, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}
