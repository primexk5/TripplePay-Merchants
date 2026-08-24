import type { Merchant, Session, WebhookDelivery, PaymentLink, LinkClaim, OrderMeta } from '../types.js';

/**
 * Persistence boundary for the relayer. The default local implementation ({@link JsonStore}) is a
 * dependency-free, atomically-written JSON file — fine for a single-process relayer. The
 * {@link PostgresStore} implementation targets hosted Postgres (e.g. Railway) and is the right
 * choice for HA / multiple relayer instances. All methods are async: a real database cannot be
 * called synchronously.
 */
export interface Store {
  // --- indexer cursor (last fully-processed block, scoped to this contract+chain) ---
  /** Cursor is keyed by a `scope` string (e.g. `${chainId}:${contractAddress}`) so a store
   *  reused across a different chain or contract address can never silently skip events. */
  getCursor(scope: string): Promise<number | undefined>;
  setCursor(scope: string, blockNumber: number): Promise<void>;

  // --- merchants (keyed by lowercased on-chain address) ---
  upsertMerchant(m: Merchant): Promise<void>;
  getMerchantByAddress(address: string): Promise<Merchant | undefined>;
  getMerchantById(merchantId: string): Promise<Merchant | undefined>;
  listMerchants(): Promise<Merchant[]>;

  // --- webhook deliveries (id == paymentId; also the payment idempotency key) ---
  /** Insert a delivery only if its id is new. Returns true if inserted, false if it already existed. */
  insertDeliveryIfAbsent(d: WebhookDelivery): Promise<boolean>;
  getDelivery(id: string): Promise<WebhookDelivery | undefined>;
  updateDelivery(d: WebhookDelivery): Promise<void>;
  /** Persist a delivery transition only if the stored record still matches `guard` (the snapshot
   *  the caller read when it started) — i.e. nothing — an admin retry, a requeue, another sweep —
   *  touched the record while the caller was busy. Returns true when written, false when the CAS
   *  failed and the update was discarded. */
  updateDeliveryIfCurrent(d: WebhookDelivery, guard: Pick<WebhookDelivery, 'attempts' | 'status' | 'nextAttemptAt' | 'updatedAt'>): Promise<boolean>;
  /** Delivery for a given (merchant, orderId), if any — the index counterpart of scanning the list. */
  getDeliveryByOrder(merchant: string, orderId: string): Promise<WebhookDelivery | undefined>;
  /** Re-queue `skipped` payments that belong to `m` (its address was just onboarded). Returns
   *  the number re-queued. Payments to unregistered addresses are not lost — they resume once
   *  the address is registered. */
  requeueSkippedForMerchant(m: Merchant): Promise<number>;
  /** Deliveries in `pending` status whose nextAttemptAt <= now, oldest first. */
  getDueDeliveries(now: number, limit: number): Promise<WebhookDelivery[]>;
  listDeliveries(limit: number): Promise<WebhookDelivery[]>;

  // --- auth sessions (opaque bearer tokens, persisted across restarts) ---
  createSession(s: Session): Promise<void>;
  getSession(token: string): Promise<Session | undefined>;
  deleteSession(token: string): Promise<void>;

  // --- login challenges (single-use nonces bound to an address + expiry) ---
  createNonce(nonce: string, address: string, expiresAt: number): Promise<void>;
  /** Consume a nonce exactly once. Returns the address it was issued for, or undefined if the
   *  nonce is unknown, expired or already used — any of which must fail the login. */
  consumeNonce(nonce: string): Promise<string | undefined>;

  close(): Promise<void>;

  // --- payment links (short slug → link template + order pool) ---
  upsertLink(link: PaymentLink): Promise<void>;
  getLink(slug: string): Promise<PaymentLink | undefined>;
  listLinksForMerchant(merchantAddress: string): Promise<PaymentLink[]>;
  /** Remove one orderId from the pool and return it, or undefined if pool is empty. */
  claimOrderFromPool(slug: string, payerAddress: string): Promise<string | undefined>;
  /** Atomically reassigns the oldest unsettled claim older than `olderThanMs` to `payerAddress`
   *  and returns its orderId — recycling abandoned checkouts instead of consuming a fresh slot.
   *  Safe because link orders are pre-registered on-chain with no payer binding. */
  reclaimStaleClaim(slug: string, payerAddress: string, olderThanMs: number): Promise<string | undefined>;
  /** Mark a previously-claimed orderId as settled (payment confirmed on-chain). */
  settleClaimedOrder(slug: string, orderId: string): Promise<void>;

  // --- link claims (rate-limit + settled tracking) ---
  upsertClaim(claim: LinkClaim): Promise<void>;
  /** Returns the most recent claim for this (slug, payerAddress), or undefined. */
  getLatestClaim(slug: string, payerAddress: string): Promise<LinkClaim | undefined>;

  // --- order metadata (optional payer-supplied context: who paid + link/checkout source) ---
  saveOrderMeta(meta: OrderMeta): Promise<void>;
  getOrderMeta(orderId: string): Promise<OrderMeta | undefined>;
}
