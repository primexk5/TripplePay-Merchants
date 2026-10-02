import type { Merchant, Session, WebhookDelivery, PaymentLink, LinkClaim, OrderMeta, QiOrder, MerchantApiKeyMeta, MerchantPayoutAddress, PayoutAddressSource, FixedOrderClaimResult } from '../types.js';

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
  /**
   * Resolve the merchant that RECEIVED a payment at `address` on `chainId`.
   *
   * This is deliberately NOT the same lookup as getMerchantByAddress. A merchant's identity address
   * (merchants.address) and the address their money actually lands on are different things: a link's
   * payout address is resolved per chain from merchant_payout_addresses, so a single identity can
   * receive on Quai at one address and on Base at another. The indexer only ever sees the on-chain
   * payout address off the PaymentReceived event, so it MUST resolve through here — calling
   * getMerchantByAddress with a payout address silently misses once the two diverge, and every
   * payment is recorded as `skipped` against an unknown merchant instead of delivering its webhook.
   */
  getMerchantByPayoutAddress(chainId: number, address: string): Promise<Merchant | undefined>;
  getMerchantById(merchantId: string): Promise<Merchant | undefined>;
  listMerchants(): Promise<Merchant[]>;

  // --- per-chain payout addresses (identity stays one wallet; money moves per chain) ---
  /** Every configured payout destination for a merchant, keyed by chainId. */
  listPayoutAddresses(merchantId: string): Promise<MerchantPayoutAddress[]>;
  /** Set (or replace) one chain's payout destination. `source` records whether it was seeded from
   *  the merchant's identity address or declared by hand. */
  setPayoutAddress(p: {
    merchantId: string;
    chainId: number;
    address: string;
    source: PayoutAddressSource;
    createdAt: number;
  }): Promise<void>;
  /** Drop one chain's configured destination. The merchant's identity address still applies as a
   *  fallback for chains whose address kind it matches, so this never orphans an identity. */
  clearPayoutAddress(merchantId: string, chainId: number): Promise<void>;

  // --- merchant API keys (server-to-server gateway auth) ---
  // Implementations hash incoming keys with the server pepper; the credential is never persisted.
  // See util/apikey.ts for why this is a keyed HMAC and not bcrypt.
  /** Issue a key from a plaintext credential. The implementation hashes it with its pepper, so
   *  the pepper never has to reach the API layer; returns the non-secret ref for later revocation. */
  createMerchantApiKey(k: {
    key: string;
    merchantAddress: string;
    label: string;
    createdAt: number;
  }): Promise<{ keyRef: string }>;
  /** Resolve the merchant owning an API key, or undefined if unknown/revoked. */
  getMerchantByApiKey(key: string): Promise<Merchant | undefined>;
  /** Metadata only — never a usable credential. */
  listMerchantApiKeys(merchantAddress: string): Promise<MerchantApiKeyMeta[]>;
  /** Revoke by the non-secret `keyRef`, so a credential never has to appear in a URL. */
  revokeMerchantApiKeyByRef(keyRef: string): Promise<void>;

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
  /**
   * Mint a brand-new orderId for `payerAddress` and record the claim, atomically honouring
   * `maxRedemptions` (0 = unlimited). Returns undefined when the link has reached its cap, so a
   * multi-pay link still has a bounded number of customers without any pre-registered pool.
   *
   * This is what lets a merchant publish a link without holding gas: the order does not exist
   * until the customer spends it, and the authorization for it is signed per claim.
   */
  mintClaimedOrder(
    slug: string,
    payerAddress: string,
    maxRedemptions: number,
  ): Promise<string | undefined>;
  /**
   * Atomically reassigns the oldest unsettled claim older than `olderThanMs` to `payerAddress`
   * and returns its orderId — recycling abandoned checkouts instead of consuming a fresh
   * redemption. With signed orders the returned id needs a FRESH authorization, because the
   * previous one was bound to the original payer's address.
   */
  reclaimStaleClaim(slug: string, payerAddress: string, olderThanMs: number): Promise<string | undefined>;
  /**
   * Take exclusive ownership of a fixed orderId (a gateway order), which cannot be duplicated per
   * payer like a minted claim: the same id is being sold to exactly one customer.
   *
   * Idempotent for the owner (re-claims are allowed and re-sign), refuses a DIFFERENT wallet while
   * the current claim is unsettled and still inside the reuse window, refuses an already-settled
   * order, and hands an abandoned claim (unsettled, older than `staleAfterMs`) to the new payer.
   * Implemented as a single atomic operation so two concurrent wallets cannot both win.
   */
  claimFixedOrder(
    slug: string,
    orderId: string,
    payerAddress: string,
    staleAfterMs: number,
  ): Promise<FixedOrderClaimResult>;
  /** Mark a previously-claimed orderId as settled (payment confirmed on-chain). */
  settleClaimedOrder(slug: string, orderId: string): Promise<void>;

  // --- link claims (rate-limit + settled tracking) ---
  upsertClaim(claim: LinkClaim): Promise<void>;
  /** Returns the most recent claim for this (slug, payerAddress), or undefined. */
  getLatestClaim(slug: string, payerAddress: string): Promise<LinkClaim | undefined>;
  /**
   * Every claim made against a link, oldest first. This is the redemption ledger for a link: the
   * number of rows is what `maxRedemptions` is checked against (recycling rewrites a row rather
   * than adding one), so reconciliation and audit both need to be able to read it.
   */
  listClaims(slug: string): Promise<LinkClaim[]>;

  // --- order metadata (optional payer-supplied context: who paid + link/checkout source) ---
  saveOrderMeta(meta: OrderMeta): Promise<void>;
  getOrderMeta(orderId: string): Promise<OrderMeta | undefined>;

  // --- Qi per-order receive addresses (UTXO-ledger payments) ---
  /** Insert a per-order Qi address, or return false when the orderId already has one or the
   *  address collides with another order. The store's unique constraints are the source of truth
   *  for address uniqueness; the caller retries with a freshly derived address on false. */
  insertQiOrder(order: QiOrder): Promise<boolean>;
  getQiOrder(orderId: string): Promise<QiOrder | undefined>;
  listQiOrders(): Promise<QiOrder[]>;
  /** Qi orders for a specific merchant payout address, newest first. */
  listQiOrdersByMerchant(merchantAddress: string): Promise<QiOrder[]>;
  /** Record that the order's receive address has accumulated at least its required qits. Returns
   *  the updated order, or undefined if the orderId doesn't exist. */
  markQiOrderSettled(orderId: string, receivedQits: string, txHashes: string[]): Promise<QiOrder | undefined>;
  /** Pop the next orderId off a link pool WITHOUT binding a payer (the Qi path reserves an order
   *  and shows its address before the payer's wallet is known), or undefined when the pool is
   *  empty. Mirrors {@link claimOrderFromPool} minus the payer binding. */
  reserveQiLinkOrder(slug: string): Promise<string | undefined>;
}
