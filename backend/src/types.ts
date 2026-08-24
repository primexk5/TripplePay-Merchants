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

export interface Merchant {
  merchantId: string; // platform id, e.g. "mch_ab12..."
  address: string; // lowercased on-chain payout address (the map key)
  name: string;
  webhookUrl: string;
  webhookSecret: string; // used to HMAC-sign deliveries to this merchant
  active: boolean;
  createdAt: number;
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
    merchant: string; // on-chain address
    orderId: string; // bytes32 hex
    payer: string;
    token: string; // NATIVE_TOKEN for native QUAI
    amount: string; // gross amount the payer sent, smallest unit, decimal string
    feeBps: number; // platform fee rate locked at order registration (basis points)
    fee: string; // platform fee withheld = floor(amount * feeBps / 10000), smallest unit, decimal string
    net: string; // amount - fee, what the merchant actually received, smallest unit, decimal string
    txHash: string;
    blockNumber: number;
    timestamp: number; // on-chain event timestamp
    nonce: number; // per-merchant order nonce; distinguishes order-id reuse after a purge
  };
}

export type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'skipped';

/** A short-link template created by a merchant from the dashboard. */
export interface PaymentLink {
  slug: string;               // 8-char base62 ID — the short URL key
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
  /** Pre-registered orderIds available for customers to claim (multiPay only). */
  orderPool: string[];        // bytes32 hex strings
  createdAt: number;          // unix ms
}

/** Tracks one customer claim of an orderId from a multi-pay link pool. */
export interface LinkClaim {
  slug: string;
  orderId: string;            // claimed from the pool
  payerAddress: string;       // lowercased customer wallet
  claimedAt: number;          // unix ms — used for 5-min double-pay guard
  settled: boolean;           // set true after on-chain confirmation
}

/** Optional payer-supplied context attached to a payment (who paid + where they came from).
 *  Written by the payment pages right after on-chain confirmation — purely informational,
 *  never used for settlement logic. Keyed by orderId. */
export type OrderSource = 'link' | 'checkout';

export interface OrderMeta {
  orderId: string;            // bytes32 hex, lowercased
  merchantAddress: string;    // lowercased
  customerName?: string;      // optional display name the payer typed
  source: OrderSource;        // 'link' = paid a payment-link page, 'checkout' = merchant checkout/API order page
  slug?: string;              // set when source === 'link'
  createdAt: number;
}


export interface WebhookDelivery {
  id: string; // == paymentId
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
