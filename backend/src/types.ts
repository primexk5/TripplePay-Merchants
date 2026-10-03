/**
 * Shared domain types for the relayer.
 *
 * On-chain amounts are the token's smallest unit and can exceed 2^53, so they are carried as
 * `bigint` internally and serialized to decimal strings at the JSON boundary (webhooks / API).
 */

/** The native-QUAI sentinel used by PayWithQuai (`token == address(0)`). */
export const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';

/** A decoded `PaymentReceived` event, enriched with block/finality metadata. */
export interface PaymentEvent {
  merchant: string; // on-chain payout address (checksummed)
  orderId: string; // bytes32 hex
  payer: string;
  token: string; // ERC-20 address, or NATIVE_TOKEN for native QUAI
  amount: bigint; // gross amount, smallest unit
  eventTimestamp: number; // unix seconds from the contract event
  blockNumber: number;
  txHash: string;
  logIndex: number;
}

/** Stable idempotency key for a settlement: one payment == one (txHash, logIndex). */
export function paymentId(e: Pick<PaymentEvent, 'txHash' | 'logIndex'>): string {
  return `${e.txHash.toLowerCase()}:${e.logIndex}`;
}

/** Per-merchant gateway pricing: the markup applied over the live QUAI market rate at quote time
 *  (in basis points) and the fiat currencies the shop quotes in. Stored on the Merchant record;
 *  absent → use the gateway defaults (GATEWAY_MARKUP_BPS_DEFAULT, ['USD','NGN']). */
export interface MerchantSettings {
  quaiMarkupBps: number; // 0..10000; +100 bps ≈ +1% over the market rate
  fiatCurrencies: string[]; // e.g. ['USD','NGN'] — lowercase-when-compared
}

export interface Merchant {
  merchantId: string; // platform id, e.g. "mch_ab12..."
  /** The merchant's IDENTITY address — the single wallet they sign in and register with.
   *  This is no longer assumed to be where their money lands: see MerchantPayoutAddress. It stays
   *  the merchants table key so every legacy lookup keeps working. */
  address: string; // lowercased on-chain address (the map key)
  name: string;
  webhookUrl: string;
  webhookSecret: string; // used to HMAC-sign deliveries to this merchant
  active: boolean;
  createdAt: number;
  settings?: MerchantSettings;
}

/** Where a merchant's money lands on ONE chain. A merchant identity can hold several of these —
 *  one per chain — which is what lets a single wallet-based account accept payments on Quai AND
 *  Base without needing a second login. */
export interface MerchantPayoutAddress {
  merchantId: string;
  chainId: number;
  /** lowercased payout destination, valid for `chainId`'s address kind (and Quai zone). */
  address: string;
  /** 'login' = seeded from the merchant's identity address; 'declared' = entered by the merchant. */
  source: PayoutAddressSource;
  createdAt: number; // unix ms
}

/** Provenance of a payout destination. Only 'login' rows imply the merchant proved control of the
 *  address (they signed with it at registration); 'declared' rows are accepted on trust, so the UI
 *  makes the merchant confirm them. */
export type PayoutAddressSource = 'login' | 'declared';

/** A server-to-server API key a merchant issues for their store backend (plugins). The key is a
 *  bearer secret (`X-Merchant-Key`) that resolves to the owning merchant, exactly like a session. */
export interface MerchantApiKey {
  /** HMAC-SHA256(pepper, key) hex. The credential itself is never stored — see util/apikey.ts. */
  keyHash: string;
  /** Non-secret short handle (e.g. "qmk_7f3a91c2") for revocation URLs and UI display. */
  keyRef: string;
  merchantAddress: string; // lowercased owner
  label: string;
  createdAt: number; // unix ms
  lastUsedAt: number; // unix ms, best-effort
}

/** What `GET /v1/me/apikeys` returns: metadata only, never a usable credential. */
export interface MerchantApiKeyMeta {
  keyRef: string;
  label: string;
  createdAt: number;
  lastUsedAt: number;
}

/** An opaque bearer-token session issued after a wallet-signature login. */
export interface Session {
  token: string; // random opaque token, the only thing the client stores
  merchantId: string;
  address: string; // lowercased merchant address the session belongs to
  createdAt: number; // unix ms
  expiresAt: number; // unix ms — past this, the session is invalid
}

export type WebhookEventType = 'payment.confirmed';

/** The JSON body POSTed to a merchant's webhook endpoint. */
export interface WebhookPayload {
  id: string; // delivery/event id, unique per payment
  type: WebhookEventType;
  created: number; // unix seconds the event was emitted by the relayer
  data: {
    merchantId: string;
    // Which chain this payment arrived on (chains.ts ChainConfig.chainId). Required: this is a
    // payments system, and a delivery must never exist without knowing which chain its payment
    // settled on. A delivery persisted before this field existed is backfilled with the default
    // chain's id on read (JsonStore/PostgresStore) — see store/json.ts and store/postgres.ts.
    chainId: number;
    merchant: string; // on-chain address
    orderId: string; // bytes32 hex
    payer: string;
    token: string; // NATIVE_TOKEN for native QUAI; "qi" for Qi UTXO settlements
    amount: string; // gross amount: smallest-unit for on-chain, qits for Qi
    feeBps: number; // platform fee rate; 0 for Qi (no fee model yet)
    fee: string; // platform fee; "0" for Qi
    net: string; // amount - fee; equals amount for Qi
    txHash: string; // on-chain tx hash; first outpoint tx hash for Qi
    blockNumber: number; // 0 for Qi (no EVM block)
    timestamp: number; // on-chain event timestamp; settledAt (unix ms) for Qi
    nonce: number; // per-merchant order nonce; 0 for Qi
    /** Discriminator: which ledger settled this payment. When absent, assume 'quai'|'token' (pre-Qi payloads). */
    asset?: 'quai' | 'token' | 'qi';
    /** Present only when asset === 'qi'. Full UTXO settlement context for the merchant. */
    qi?: {
      address: string;  // one-time receive address derived for the order
      qits: string;     // required amount (decimal qits)
      receivedQits: string; // total value seen on the address (decimal qits)
      txHashes: string[]; // outpoint tx hashes counted toward settlement
    };
    /** Gateway links only: the merchant's own shop order reference tied to this order. Lets a
     *  plugin map a webhook straight to its order — no need to remember orderId ↔ shop order. */
    reference?: string;
  };
}

export type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'skipped';

/** A short-link template created by a merchant from the dashboard. A link belongs to exactly ONE
 *  chain, chosen by the merchant at creation — orders claimed from it inherit that chain. */
export interface PaymentLink {
  slug: string;               // 8-char base62 ID — the short URL key
  chainId: number;            // the chain (chains.ts ChainConfig.chainId) this link is denominated on
  merchantAddress: string;    // lowercased payout address
  merchantId: string;         // platform ID for display on receipt
  merchantName: string;       // from merchant record at creation time
  shopName: string;           // optional display name the merchant sets
  tokenAddress: string;       // ZERO_ADDRESS = native QUAI
  amount: string;             // smallest unit, decimal string
  amountDisplay: string;      // human-readable e.g. "25.0"
  symbol: string;             // "QUAI" | "mUSDQ"
  expiryDurationSecs: number; // 0 = no expiry on orders
  multiPay: boolean;          // true = many customers can pay
  /**
   * Pre-registered orderIds available for customers to claim. Retained only for links created
   * before signed orders existed (legacy `registerOrderBatch` links). New links leave this empty
   * and mint a fresh orderId per claim instead — see the signer's per-claim authorization.
   */
  orderPool: string[];        // bytes32 hex strings
  /**
   * Cap on how many customers a multi-pay link serves (multiPay only). 0 = unlimited. This
   * replaces the old "pool size" as the merchant-facing limit: there is no pre-registered pool to
   * exhaust, so redemption count is the only thing that can run out.
   *
   * Optional so links persisted before this field existed still typecheck and load; readers treat
   * `undefined` as unlimited, matching the Postgres column default of 0.
   */
  maxRedemptions?: number;    // 0 or undefined = unlimited
  /** Gateway (shop-plugin) links only: the fixed orderId minted at creation time. Single-pay
   *  prefilled orders that never consume a pool slot — Qi is derived up front, and the checkout
   *  resolves the pre-minted Qi order instead of popping the pool. */
  gatewayOrderId?: string;
  createdAt: number;          // unix ms
}

/**
 * Outcome of trying to take ownership of a FIXED order id (a gateway order id, which is minted once
 * at gateway-order-creation time and therefore cannot be handed out per-redemption).
 */
export type FixedOrderClaimResult =
  /** This payer owns the order now — either a fresh take-over or a re-claim of its own. */
  | { status: 'claimed' }
  /** Another wallet holds an unsettled claim and is still inside the reuse window. */
  | { status: 'taken' }
  /** The order has already been paid. Signing anything for it could only revert on-chain. */
  | { status: 'settled' };

/** Tracks one customer claim of an orderId from a link (minted, pooled, or fixed gateway id). */
export interface LinkClaim {
  slug: string;
  orderId: string;            // claimed from the pool
  payerAddress: string;       // lowercased customer wallet
  claimedAt: number;          // unix ms — used for 5-min double-pay guard
  settled: boolean;           // set true after on-chain confirmation
}

/**
 * A per-order Qi receive address and its settlement state.
 *
 * Qi is a UTXO ledger with no memo/data field, so to attribute a payment to an order the order
 * MUST have its own receive address. The backend derives it from the merchant's Qi HD wallet
 * (BIP44 path m/44'/969'/0'/0/<n>, Cyprus-1), persists it here, and the Qi indexer watches the
 * address's outpoints for incoming value. Amounts are in qits (1000 qits = 1 Qi), stored as
 * decimal strings to stay JSON-native; Qi UTXOs have fixed denominations (1/5/10/50/... qits).
 */
export interface QiOrder {
  orderId: string; // bytes32 hex, lowercased
  merchantAddress: string; // lowercased payout address
  address: string; // qi:... Cyprus-1 receive address derived for this order
  qits: string; // required amount, decimal qits
  receivedQits: string; // total value of unspent outpoints seen on `address`, decimal qits
  settled: boolean;
  txHashes: string[]; // outpoint tx hashes counted toward settlement (informational)
  createdAt: number; // unix ms
  settledAt: number | null; // unix ms
}

/** Optional payer-supplied context attached to a payment (who paid + where they came from).
 *  Written by the payment pages right after on-chain confirmation — purely informational,
 *  never used for settlement logic. Keyed by orderId. */
export type OrderSource = 'link' | 'checkout';

export interface OrderMeta {
  orderId: string;            // bytes32 hex, lowercased
  chainId: number;            // inherited from the link (source === 'link'), else the default chain
  merchantAddress: string;    // lowercased
  customerName?: string;      // optional display name the payer typed
  source: OrderSource;        // 'link' = paid a payment-link page, 'checkout' = merchant checkout/API order page
  slug?: string;              // set when source === 'link'
  reference?: string;         // gateway links: the shop's order reference (merchant's own order #)
  createdAt: number;
}


export interface WebhookDelivery {
  id: string; // == paymentId
  // Which chain this payment arrived on. Required — see WebhookPayload.data.chainId. A delivery
  // persisted before this field existed is backfilled with the default chain's id on read.
  chainId: number;
  merchantId: string;
  url: string;
  payload: WebhookPayload;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: number; // unix ms; when this delivery becomes eligible again
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}
