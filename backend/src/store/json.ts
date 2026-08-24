import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, fsyncSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Store } from './index.js';
import type { Merchant, Session, WebhookDelivery, PaymentLink, LinkClaim, OrderMeta } from '../types.js';
import { log } from '../logger.js';

const logger = log('store');

interface FileShape {
  cursors: Record<string, number>;
  merchants: Record<string, Merchant>;
  deliveries: Record<string, WebhookDelivery>;
  sessions: Record<string, Session>;
  nonces: Record<string, { address: string; expiresAt: number }>;
  links: Record<string, PaymentLink>;   // key: slug
  claims: Record<string, LinkClaim[]>;  // key: slug — array of all claims for that link
  orderMeta: Record<string, OrderMeta>; // key: lowercased orderId
}

/** Case-insensitive lookup key binding a delivery to its (merchant, orderId). */
function orderKey(merchant: string, orderId: string): string {
  return `${merchant.toLowerCase()}:${orderId.toLowerCase()}`;
}

/**
 * Dependency-free persistence backed by a single JSON file, loaded into memory on start and
 * written atomically (temp file + rename) on each mutation. Correct for a single-process relayer;
 * for HA / high throughput, implement {@link Store} over SQLite or Postgres instead.
 *
 * All persisted values are JSON-native (numbers, strings, booleans) — on-chain amounts are stored
 * as decimal strings inside the webhook payload — so there are no bigint serialization concerns.
 *
 * SECURITY: merchant webhook secrets are stored in plaintext in this file. The file's OS-level
 * permissions are the trust boundary — keep DATABASE_PATH outside shared/backed-up paths and
 * restrict read access to the service user.
 */
export class JsonStore implements Store {
  private readonly path: string;
  private readonly tmpPath: string;
  private data: FileShape;
  private readonly byMerchantId = new Map<string, string>(); // merchantId -> address key
  private readonly byOrderKey = new Map<string, string>(); // "<merchant>:<orderId>" -> delivery id

  constructor(path: string) {
    this.path = path;
    this.tmpPath = `${path}.tmp`;
    // 0700: this file holds plaintext webhook secrets (see class note) — keep the whole directory
    // owner-only. mode is masked by umask on creation and is a no-op if the dir already exists.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.data = this.read();
    for (const [addr, m] of Object.entries(this.data.merchants)) {
      this.byMerchantId.set(m.merchantId, addr);
    }
    for (const [id, d] of Object.entries(this.data.deliveries)) {
      this.byOrderKey.set(orderKey(d.payload.data.merchant, d.payload.data.orderId), id);
    }
    // Expired sessions are dead on arrival — purge them at load so the file can't grow unbounded.
    const now = Date.now();
    const sessionCount = Object.keys(this.data.sessions).length;
    for (const [token, s] of Object.entries(this.data.sessions)) {
      if (s.expiresAt <= now) delete this.data.sessions[token];
    }
    if (Object.keys(this.data.sessions).length < sessionCount) this.flush();
    logger.info(
      { path, merchants: Object.keys(this.data.merchants).length, cursors: Object.keys(this.data.cursors) },
      'store loaded',
    );
  }

  private read(): FileShape {
    if (!existsSync(this.path)) return { cursors: {}, merchants: {}, deliveries: {}, sessions: {}, nonces: {}, links: {}, claims: {}, orderMeta: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as {
        cursor?: number | null;
        cursors?: Record<string, number>;
        merchants?: Record<string, Merchant>;
        deliveries?: Record<string, WebhookDelivery>;
        sessions?: Record<string, Session>;
        nonces?: Record<string, { address: string; expiresAt: number }>;
      };
      if (parsed.cursors === undefined && typeof parsed.cursor === 'number') {
        // Legacy single-cursor file from before cursors were scoped. Keep it under a `legacy`
        // scope so the current (chainId, contract) scope starts fresh; re-enqueuing is safe
        // because payments are idempotent by (txHash, logIndex).
        logger.warn('migrating legacy un-scoped cursor — the indexer will re-scan from START_BLOCK/head');
        parsed.cursors = { legacy: parsed.cursor };
      }
      return {
        cursors: parsed.cursors ?? {},
        merchants: parsed.merchants ?? {},
        deliveries: parsed.deliveries ?? {},
        sessions: parsed.sessions ?? {},
        nonces: parsed.nonces ?? {},
        links: (parsed as Partial<FileShape>).links ?? {},
        claims: (parsed as Partial<FileShape>).claims ?? {},
        orderMeta: (parsed as Partial<FileShape>).orderMeta ?? {},
      };
    } catch (err) {
      throw new Error(`Failed to read store at ${this.path}: ${(err as Error).message}`);
    }
  }

  private flush(): void {
    // 0600: the store holds plaintext webhook secrets. mode only applies when the temp file is
    // created, so chmod the temp file unconditionally BEFORE the rename too — a stale temp file
    // from a crash could otherwise carry looser permissions onto the new plaintext content.
    writeFileSync(this.tmpPath, JSON.stringify(this.data), { encoding: 'utf8', mode: 0o600 });
    try {
      chmodSync(this.tmpPath, 0o600);
    } catch {
      /* best-effort: filesystems without POSIX perms (e.g. Windows) don't support this */
    }
    // fsync before the rename so a crash after the rename can never leave the *target* file as
    // stale data — otherwise the last delivery/cursor write could be silently lost (a payment
    // would never be webhook-delivered). The rename itself is atomic on POSIX.
    const fd = openSync(this.tmpPath, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(this.tmpPath, this.path);
    try {
      chmodSync(this.path, 0o600);
    } catch {
      /* best-effort: filesystems without POSIX perms (e.g. Windows) don't support this */
    }
    // fsync the parent directory so the rename itself is durable — without this, a crash right
    // after rename could roll back the directory entry on some filesystems, resurfacing the old
    // file. Best-effort: opening a directory for fsync is not portable (fails on Windows).
    try {
      const dirFd = openSync(dirname(this.path), 'r');
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      /* directory fsync unsupported on this platform — the file fsync above still holds */
    }
  }

  async getCursor(scope: string): Promise<number | undefined> {
    return this.data.cursors[scope];
  }

  async setCursor(scope: string, blockNumber: number): Promise<void> {
    this.data.cursors[scope] = blockNumber;
    this.flush();
  }

  async upsertMerchant(m: Merchant): Promise<void> {
    const key = m.address.toLowerCase();
    this.data.merchants[key] = { ...m, address: key };
    this.byMerchantId.set(m.merchantId, key);
    this.flush();
  }

  async getMerchantByAddress(address: string): Promise<Merchant | undefined> {
    return this.data.merchants[address.toLowerCase()];
  }

  async getMerchantById(merchantId: string): Promise<Merchant | undefined> {
    const key = this.byMerchantId.get(merchantId);
    return key ? this.data.merchants[key] : undefined;
  }

  async listMerchants(): Promise<Merchant[]> {
    return Object.values(this.data.merchants);
  }

  async insertDeliveryIfAbsent(d: WebhookDelivery): Promise<boolean> {
    if (this.data.deliveries[d.id]) return false;
    this.data.deliveries[d.id] = d;
    this.byOrderKey.set(orderKey(d.payload.data.merchant, d.payload.data.orderId), d.id);
    this.flush();
    return true;
  }

  async getDelivery(id: string): Promise<WebhookDelivery | undefined> {
    return this.data.deliveries[id];
  }

  async getDeliveryByOrder(merchant: string, orderId: string): Promise<WebhookDelivery | undefined> {
    const id = this.byOrderKey.get(orderKey(merchant, orderId));
    return id ? this.data.deliveries[id] : undefined;
  }

  async requeueSkippedForMerchant(m: Merchant): Promise<number> {
    const addr = m.address.toLowerCase();
    let requeued = 0;
    for (const d of Object.values(this.data.deliveries)) {
      if (d.status !== 'skipped' || d.payload.data.merchant.toLowerCase() !== addr) continue;
      const now = Date.now();
      this.data.deliveries[d.id] = {
        ...d,
        merchantId: m.merchantId,
        url: m.webhookUrl,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now,
        lastError: null,
        updatedAt: now,
        // Rebuild the nested payload id too: while skipped it held the `unregistered:<addr>`
        // placeholder, and that body is what gets HMAC-signed and POSTed. Leaving it stale would
        // deliver a webhook whose data.merchantId never matches the merchant now receiving it.
        payload: { ...d.payload, data: { ...d.payload.data, merchantId: m.merchantId } },
      };
      requeued++;
    }
    if (requeued > 0) {
      this.flush();
      logger.info({ merchantId: m.merchantId, address: addr, requeued }, 're-queued skipped payments');
    }
    return requeued;
  }

  async updateDelivery(d: WebhookDelivery): Promise<void> {
    this.data.deliveries[d.id] = d;
    this.flush();
  }

  /** CAS write: only applied when the stored record still matches `guard` (the caller's read
   *  snapshot) — i.e. nothing (admin retry, requeue, another sweep) touched it in the meantime.
   *  All four fields are compared: a retry resets attempts/status to the same values, so
   *  nextAttemptAt/updatedAt carry the identity. Returns false (update discarded) otherwise. */
  async updateDeliveryIfCurrent(
    d: WebhookDelivery,
    guard: Pick<WebhookDelivery, 'attempts' | 'status' | 'nextAttemptAt' | 'updatedAt'>,
  ): Promise<boolean> {
    const current = this.data.deliveries[d.id];
    if (
      !current ||
      current.attempts !== guard.attempts ||
      current.status !== guard.status ||
      current.nextAttemptAt !== guard.nextAttemptAt ||
      current.updatedAt !== guard.updatedAt
    ) {
      return false;
    }
    this.data.deliveries[d.id] = d;
    this.flush();
    return true;
  }

  async getDueDeliveries(now: number, limit: number): Promise<WebhookDelivery[]> {
    return Object.values(this.data.deliveries)
      .filter((d) => d.status === 'pending' && d.nextAttemptAt <= now)
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)
      .slice(0, limit);
  }

  async listDeliveries(limit: number): Promise<WebhookDelivery[]> {
    return Object.values(this.data.deliveries)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  /** Max live sessions per merchant: bounds the file size and prevents a replayed/brute-forced
   *  login from minting unbounded sessions. Oldest sessions are evicted first. */
  private static readonly MAX_SESSIONS_PER_MERCHANT = 20;

  async createSession(s: Session): Promise<void> {
    const own = Object.hasOwn(this.data.sessions, s.token);
    if (!own) {
      const existing = Object.values(this.data.sessions).filter((x) => x.merchantId === s.merchantId);
      if (existing.length >= JsonStore.MAX_SESSIONS_PER_MERCHANT) {
        existing.sort((a, b) => a.createdAt - b.createdAt);
        const victim = existing[0];
        if (victim) delete this.data.sessions[victim.token];
      }
    }
    this.data.sessions[s.token] = s;
    this.flush();
  }

  async getSession(token: string): Promise<Session | undefined> {
    // Object.hasOwn is load-bearing: a plain-object index with a `__proto__`/`constructor` key
    // lookup would otherwise leak Object.prototype as a "session" (truthy, unexpired).
    if (!Object.hasOwn(this.data.sessions, token)) return undefined;
    const s = this.data.sessions[token];
    if (!s) return undefined;
    if (s.expiresAt <= Date.now()) {
      delete this.data.sessions[token];
      this.flush();
      return undefined;
    }
    return s;
  }

  async deleteSession(token: string): Promise<void> {
    if (Object.hasOwn(this.data.sessions, token)) {
      delete this.data.sessions[token];
      this.flush();
    }
  }

  async createNonce(nonce: string, address: string, expiresAt: number): Promise<void> {
    const now = Date.now();
    // Opportunistic sweep so expired nonces can't accumulate unboundedly.
    for (const [n, v] of Object.entries(this.data.nonces)) {
      if (v.expiresAt <= now) delete this.data.nonces[n];
    }
    this.data.nonces[nonce] = { address, expiresAt };
    this.flush();
  }

  async consumeNonce(nonce: string): Promise<string | undefined> {
    if (!Object.hasOwn(this.data.nonces, nonce)) return undefined;
    const v = this.data.nonces[nonce];
    if (!v) return undefined;
    delete this.data.nonces[nonce]; // single-use: a replayed login can never re-consume it
    this.flush();
    if (v.expiresAt <= Date.now()) return undefined;
    return v.address;
  }

  async close(): Promise<void> {
    this.flush();
  }

  // --- payment links ---

  async upsertLink(link: PaymentLink): Promise<void> {
    this.data.links[link.slug] = link;
    this.flush();
  }

  async getLink(slug: string): Promise<PaymentLink | undefined> {
    return Object.hasOwn(this.data.links, slug) ? this.data.links[slug] : undefined;
  }

  async listLinksForMerchant(merchantAddress: string): Promise<PaymentLink[]> {
    const addr = merchantAddress.toLowerCase();
    return Object.values(this.data.links)
      .filter((l) => l.merchantAddress === addr)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async claimOrderFromPool(slug: string, payerAddress: string): Promise<string | undefined> {
    const link = this.data.links[slug];
    if (!link || link.orderPool.length === 0) return undefined;
    const orderId = link.orderPool.shift()!; // pop from front
    this.data.links[slug] = link;
    const claim: LinkClaim = {
      slug,
      orderId,
      payerAddress: payerAddress.toLowerCase(),
      claimedAt: Date.now(),
      settled: false,
    };
    if (!this.data.claims[slug]) this.data.claims[slug] = [];
    this.data.claims[slug]!.push(claim);
    this.flush();
    return orderId;
  }

  async reclaimStaleClaim(slug: string, payerAddress: string, olderThanMs: number): Promise<string | undefined> {
    const claims = this.data.claims[slug];
    if (!claims) return undefined;
    const cutoff = Date.now() - olderThanMs;
    const idx = claims.findIndex((c) => !c.settled && c.claimedAt < cutoff);
    if (idx === -1) return undefined;
    claims[idx]!.payerAddress = payerAddress.toLowerCase();
    claims[idx]!.claimedAt = Date.now();
    this.flush();
    return claims[idx]!.orderId;
  }

  async settleClaimedOrder(slug: string, orderId: string): Promise<void> {
    const claims = this.data.claims[slug];
    if (!claims) return;
    const idx = claims.findIndex((c) => c.orderId === orderId);
    if (idx !== -1) {
      claims[idx]!.settled = true;
      this.flush();
    }
  }

  async upsertClaim(claim: LinkClaim): Promise<void> {
    if (!this.data.claims[claim.slug]) this.data.claims[claim.slug] = [];
    const list = this.data.claims[claim.slug]!;
    const idx = list.findIndex((c) => c.orderId === claim.orderId);
    if (idx !== -1) list[idx] = claim;
    else list.push(claim);
    this.flush();
  }

  async getLatestClaim(slug: string, payerAddress: string): Promise<LinkClaim | undefined> {
    const claims = this.data.claims[slug];
    if (!claims) return undefined;
    const addr = payerAddress.toLowerCase();
    return claims
      .filter((c) => c.payerAddress === addr)
      .sort((a, b) => b.claimedAt - a.claimedAt)[0];
  }

  // --- order metadata ---

  async saveOrderMeta(meta: OrderMeta): Promise<void> {
    this.data.orderMeta[meta.orderId] = meta;
    this.flush();
  }

  async getOrderMeta(orderId: string): Promise<OrderMeta | undefined> {
    return this.data.orderMeta[orderId.toLowerCase()];
  }
}