import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, fsyncSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Store } from './index.js';
import type { Merchant, Session, WebhookDelivery, PaymentLink, LinkClaim, OrderMeta, QiOrder, MerchantApiKey, MerchantApiKeyMeta, MerchantPayoutAddress, PayoutAddressSource, FixedOrderClaimResult } from '../types.js';
import { hashApiKey, apiKeyRef, constantTimeEqual, DEV_API_KEY_PEPPER } from '../util/apikey.js';
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
  qiOrders: Record<string, QiOrder>;    // key: lowercased orderId
  apiKeys: Record<string, MerchantApiKey>; // key: keyHash
  /** Per-chain payout destinations, keyed `${merchantId}:${chainId}`. */
  payoutAddresses: Record<string, MerchantPayoutAddress>;
  /** Pre-hashing rows: key -> merchantAddress. Migrated to `apiKeys` on first successful use and
   *  then deleted, so an existing database.json keeps working without a manual migration step. */
  legacyApiKeys?: Record<string, string>;
}

/** Map key for one merchant's payout destination on one chain. */
function payoutKey(merchantId: string, chainId: number): string {
  return `${merchantId}:${chainId}`;
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
  /** Keyed-hash pepper for API keys. Optional so existing single-arg call sites keep working;
   *  production always passes cfg.API_KEY_PEPPER (see index.ts). */
  private readonly apiKeyPepper: string;
  private readonly byMerchantId = new Map<string, string>(); // merchantId -> address key
  private readonly byOrderKey = new Map<string, string>(); // "<merchant>:<orderId>" -> delivery id

  /** `defaultChainId`: what a pre-multi-chain record (link/order-meta/delivery with no chainId
   *  of its own) is read back as. Optional so `new JsonStore(path)` keeps working exactly as
   *  before for every existing caller/test; production always passes the real default chain's
   *  chainId (see index.ts). */
  constructor(
    path: string,
    private readonly defaultChainId: number = 9,
    apiKeyPepper: string = '',
  ) {
    this.path = path;
    this.apiKeyPepper = apiKeyPepper || DEV_API_KEY_PEPPER;
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

  /** Backfills `chainId` onto a record loaded from disk that predates multi-chain support. A
   *  genuinely present chainId (including 0, which is not a valid chain id but never occurs in
   *  practice) always wins over the default. */
  private withChainId<T extends { chainId?: number }>(rec: T): T & { chainId: number } {
    const existing = (rec as { chainId?: number }).chainId;
    return existing === undefined ? { ...rec, chainId: this.defaultChainId } : (rec as T & { chainId: number });
  }

  private read(): FileShape {
    if (!existsSync(this.path)) return { cursors: {}, merchants: {}, deliveries: {}, sessions: {}, nonces: {}, links: {}, claims: {}, orderMeta: {}, qiOrders: {}, apiKeys: {}, payoutAddresses: {} };
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
      // Multi-chain migration: links/order-meta/deliveries written before chainId existed carry
      // no such field on disk. Backfill it to the default chain, once, here — every getter then
      // always returns a record with a chainId, with no per-method special-casing.
      const links: Record<string, PaymentLink> = {};
      for (const [slug, l] of Object.entries((parsed as Partial<FileShape>).links ?? {})) {
        links[slug] = this.withChainId(l);
      }
      const orderMeta: Record<string, OrderMeta> = {};
      for (const [id, m] of Object.entries((parsed as Partial<FileShape>).orderMeta ?? {})) {
        orderMeta[id] = this.withChainId(m);
      }
      const deliveries: Record<string, WebhookDelivery> = {};
      for (const [id, d] of Object.entries(parsed.deliveries ?? {})) {
        deliveries[id] = this.withChainId(d);
      }
      // API-key hashing migration. Before this change `apiKeys` was a map of plaintext credential ->
      // record. Those rows are un-hashable here (the pepper lives in the environment, not the
      // file), so move them to `legacyApiKeys` keyed by plaintext and let getMerchantByApiKey()
      // upgrade each one in place the first time its owner actually presents it. Rows already in
      // the new shape carry a keyHash and pass straight through.
      const apiKeys: Record<string, MerchantApiKey> = {};
      const legacyApiKeys: Record<string, string> = { ...((parsed as Partial<FileShape>).legacyApiKeys ?? {}) };
      for (const [k, rec] of Object.entries((parsed as { apiKeys?: Record<string, unknown> }).apiKeys ?? {})) {
        const r = rec as Partial<MerchantApiKey> & { key?: string };
        if (typeof r?.keyHash === 'string' && r.keyHash.length > 0) {
          apiKeys[k] = rec as MerchantApiKey;
        } else if (typeof r?.merchantAddress === 'string' && typeof r?.key === 'string') {
          legacyApiKeys[r.key] = r.merchantAddress ?? '';
        } else {
          logger.warn({ entry: k }, 'dropping unrecognised apiKeys entry during migration');
        }
      }
      if (Object.keys(legacyApiKeys).length > 0) {
        logger.warn({ count: Object.keys(legacyApiKeys).length }, 'found legacy plaintext API keys — they will be hashed on first use');
      }
      return {
        cursors: parsed.cursors ?? {},
        merchants: parsed.merchants ?? {},
        deliveries,
        sessions: parsed.sessions ?? {},
        nonces: parsed.nonces ?? {},
        links,
        claims: (parsed as Partial<FileShape>).claims ?? {},
        orderMeta,
        qiOrders: (parsed as Partial<FileShape>).qiOrders ?? {},
        apiKeys: apiKeys,
        legacyApiKeys: legacyApiKeys,
        // Absent on every file written before per-chain payouts existed — the settlement resolver
        // falls back to the merchant's identity address, so those merchants keep working untouched.
        payoutAddresses: (parsed as Partial<FileShape>).payoutAddresses ?? {},
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

  async getMerchantByPayoutAddress(chainId: number, address: string): Promise<Merchant | undefined> {
    const addr = address.toLowerCase();
    for (const m of Object.values(this.data.merchants)) {
      const rows = await this.listPayoutAddresses(m.merchantId);
      const hit = rows.find((r) => r.chainId === chainId && r.address === addr);
      if (hit) return m;
      // Legacy fallback: a merchant with no configured row for this chain still receives at their
      // identity address. The chain-kind check lives in the resolver, not here, so the store stays
      // a dumb lookup and cannot disagree with it about which chains an address serves.
      if (!rows.some((r) => r.chainId === chainId) && m.address === addr) return m;
    }
    return undefined;
  }

  async listPayoutAddresses(merchantId: string): Promise<MerchantPayoutAddress[]> {
    return Object.values(this.data.payoutAddresses).filter((r) => r.merchantId === merchantId);
  }

  async setPayoutAddress(p: {
    merchantId: string;
    chainId: number;
    address: string;
    source: PayoutAddressSource;
    createdAt: number;
  }): Promise<void> {
    this.data.payoutAddresses[payoutKey(p.merchantId, p.chainId)] = {
      merchantId: p.merchantId,
      chainId: p.chainId,
      address: p.address.toLowerCase(),
      source: p.source,
      createdAt: p.createdAt,
    };
    this.flush();
  }

  async clearPayoutAddress(merchantId: string, chainId: number): Promise<void> {
    delete this.data.payoutAddresses[payoutKey(merchantId, chainId)];
    this.flush();
  }

  async getMerchantById(merchantId: string): Promise<Merchant | undefined> {
    const key = this.byMerchantId.get(merchantId);
    return key ? this.data.merchants[key] : undefined;
  }

  async listMerchants(): Promise<Merchant[]> {
    return Object.values(this.data.merchants);
  }

  // --- merchant API keys ---

  async createMerchantApiKey(k: {
    key: string;
    merchantAddress: string;
    label: string;
    createdAt: number;
  }): Promise<{ keyRef: string }> {
    const keyHash = hashApiKey(k.key, this.apiKeyPepper);
    const keyRef = apiKeyRef(keyHash);
    this.data.apiKeys[keyHash] = {
      keyHash,
      keyRef,
      merchantAddress: k.merchantAddress.toLowerCase(),
      label: k.label,
      createdAt: k.createdAt,
      lastUsedAt: 0,
    };
    this.flush();
    return { keyRef };
  }

  async getMerchantByApiKey(key: string): Promise<Merchant | undefined> {
    const hash = hashApiKey(key, this.apiKeyPepper);
    const rec = this.data.apiKeys[hash];
    if (rec) {
      this.touchApiKey(hash);
      return this.data.merchants[rec.merchantAddress];
    }

    // Legacy: keys issued before hashing were stored as plaintext. Accept one, then rewrite it in
    // place as a hash so the plaintext copy is gone from disk on the very next boot. The merchant
    // keeps using the same credential, so this needs no coordination.
    const legacy = this.data.legacyApiKeys;
    const legacyAddr = legacy?.[key];
    if (legacy && legacyAddr) {
      this.data.apiKeys[hash] = {
        keyHash: hash,
        keyRef: apiKeyRef(hash),
        merchantAddress: legacyAddr.toLowerCase(),
        label: '(migrated)',
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
      };
      delete legacy[key];
      this.flush();
      logger.warn({ merchantAddress: legacyAddr }, 'migrated legacy plaintext API key to hashed form');
      return this.data.merchants[legacyAddr.toLowerCase()];
    }
    return undefined;
  }

  async listMerchantApiKeys(merchantAddress: string): Promise<MerchantApiKeyMeta[]> {
    const addr = merchantAddress.toLowerCase();
    return Object.values(this.data.apiKeys)
      .filter((k) => k.merchantAddress === addr)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(({ keyRef, label, createdAt, lastUsedAt }) => ({ keyRef, label, createdAt, lastUsedAt }));
  }

  async revokeMerchantApiKeyByRef(keyRef: string): Promise<void> {
    for (const [hash, rec] of Object.entries(this.data.apiKeys)) {
      if (constantTimeEqual(rec.keyRef, keyRef)) {
        delete this.data.apiKeys[hash];
        this.flush();
        return;
      }
    }
  }

  /** Best-effort last-used stamp; never worth failing a request over. */
  private touchApiKey(hash: string): void {
    const rec = this.data.apiKeys[hash];
    if (!rec) return;
    rec.lastUsedAt = Date.now();
    this.flush();
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

  async listLinksForMerchant(merchantId: string): Promise<PaymentLink[]> {
    return Object.values(this.data.links)
      .filter((l) => l.merchantId === merchantId)
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

  async mintClaimedOrder(
    slug: string,
    payerAddress: string,
    maxRedemptions: number,
  ): Promise<string | undefined> {
    const link = this.data.links[slug];
    if (!link) return undefined;
    const existing = this.data.claims[slug] ?? [];
    if (maxRedemptions > 0 && existing.length >= maxRedemptions) return undefined;
    // Random rather than sequential: orderIds are unguessable ledger keys, and a customer must
    // never be able to predict the next one and pre-emptively claim it.
    const orderId = '0x' + randomBytes(32).toString('hex');
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

  async listClaims(slug: string): Promise<LinkClaim[]> {
    return [...(this.data.claims[slug] ?? [])].sort((a, b) => a.claimedAt - b.claimedAt);
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

  async claimFixedOrder(
    slug: string,
    orderId: string,
    payerAddress: string,
    staleAfterMs: number,
  ): Promise<FixedOrderClaimResult> {
    if (!this.data.claims[slug]) this.data.claims[slug] = [];
    const list = this.data.claims[slug]!;
    const idx = list.findIndex((c) => c.orderId === orderId);
    const payer = payerAddress.toLowerCase();
    if (idx === -1) {
      list.push({ slug, orderId, payerAddress: payer, claimedAt: Date.now(), settled: false });
      this.flush();
      return { status: 'claimed' };
    }
    const existing = list[idx]!;
    if (existing.settled) return { status: 'settled' };
    const age = Date.now() - existing.claimedAt;
    // Same wallet re-claiming, or a claim abandoned long enough ago: both hand the id over and
    // refresh the timestamp so the current attempt isn't recycled out from under the customer.
    if (existing.payerAddress === payer || age >= staleAfterMs) {
      list[idx] = { ...existing, payerAddress: payer, claimedAt: Date.now() };
      this.flush();
      return { status: 'claimed' };
    }
    return { status: 'taken' };
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
    const key = meta.orderId.toLowerCase();
    const existing = this.data.orderMeta[key];
    // Gateway order creation writes the merchant's shop `reference`; later writes (checkout name /
    // link slug) don't carry one — preserve the reference rather than silently dropping it.
    if (existing && existing.reference !== undefined && meta.reference === undefined) {
      this.data.orderMeta[key] = { ...meta, reference: existing.reference };
    } else {
      this.data.orderMeta[key] = { ...meta, orderId: key };
    }
    this.flush();
  }

  async getOrderMeta(orderId: string): Promise<OrderMeta | undefined> {
    return this.data.orderMeta[orderId.toLowerCase()];
  }

  // --- Qi per-order receive addresses ---

  async insertQiOrder(order: QiOrder): Promise<boolean> {
    const key = order.orderId.toLowerCase();
    // The address is the second uniqueness axis (a payer could reuse an address across orders,
    // which would misattribute payments) — reject that exactly like the Postgres unique index.
    const collision = Object.values(this.data.qiOrders).some((o) => o.address === order.address);
    if (this.data.qiOrders[key] || collision) return false;
    this.data.qiOrders[key] = { ...order, orderId: key };
    this.flush();
    return true;
  }

  async getQiOrder(orderId: string): Promise<QiOrder | undefined> {
    return this.data.qiOrders[orderId.toLowerCase()];
  }

  async listQiOrders(): Promise<QiOrder[]> {
    return Object.values(this.data.qiOrders);
  }

  async listQiOrdersByMerchant(merchantAddress: string): Promise<QiOrder[]> {
    const addr = merchantAddress.toLowerCase();
    return Object.values(this.data.qiOrders)
      .filter((o) => o.merchantAddress === addr)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async markQiOrderSettled(orderId: string, receivedQits: string, txHashes: string[]): Promise<QiOrder | undefined> {
    const key = orderId.toLowerCase();
    const current = this.data.qiOrders[key];
    if (!current) return undefined;
    const updated: QiOrder = { ...current, receivedQits, txHashes, settled: true, settledAt: Date.now() };
    this.data.qiOrders[key] = updated;
    this.flush();
    return updated;
  }

  async reserveQiLinkOrder(slug: string): Promise<string | undefined> {
    return this.claimOrderFromPool(slug, 'qi'); // binds to the sentinel payer 'qi'
  }
}