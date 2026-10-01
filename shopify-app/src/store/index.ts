export interface ShopSession {
  shop: string;
  accessToken: string;
  installedAt: number;
  scopes: string;
}

export interface PendingPayment {
  gatewayId: string;
  shop: string;
  orderId: number;
  checkoutUrl: string;
  amount: string;
  fiatCurrency: string;
  /** Settlement asset the quote is denominated in ('qi' or the chain's native symbol). The gateway's
   *  quote object names its fields `quaiDisplay`/`quaiWei` regardless of token, so the asset is
   *  recorded here rather than inferred from those names. */
  asset: string;
  status: 'awaiting' | 'paid' | 'expired';
  createdAt: number;
  /** Epoch ms after which the gateway will no longer accept this quote. Drives the `expired`
   *  status — a link that silently dies while we still report `awaiting` is what made this
   *  necessary. Taken from the gateway's own `expiresAt` rather than assumed. */
  expiresAt: number;
}

/** A single in-flight OAuth install. `state` is single-use: consuming it deletes it, so a leaked
 *  callback URL cannot be replayed to install the app again. */
export interface OAuthState {
  state: string;
  shop: string;
  createdAt: number;
}

/**
 * A store's own gateway credentials.
 *
 * Held SEALED (`*Cipher`): these are bearer credentials that can move the merchant's funds, so they
 * are encrypted at rest under the connector's `CONNECTOR_ENCRYPTION_KEY` and only ever decrypted in
 * memory, immediately before a request is signed. `shop` is stored lowercased everywhere.
 */
export interface StoreSettings {
  shop: string;
  merchantKeyCipher: string;
  webhookSecretCipher: string;
  configuredAt: number;
}

/** The plaintext pair, available only for the lifetime of one request. */
export interface StoreCredentials {
  merchantKey: string;
  webhookSecret: string;
}

/**
 * Persistence boundary for the connector.
 *
 * Every method is async because the production implementation is a real database. Nothing outside
 * this directory should know which one it got — see `createStore`.
 */
export interface ConnectorStore {
  getSession(shop: string): Promise<ShopSession | undefined>;
  setSession(session: ShopSession): Promise<void>;
  removeSession(shop: string): Promise<void>;

  /** Records an issued OAuth `state`, bound to the shop it was minted for. */
  putState(state: OAuthState): Promise<void>;
  /** Atomically looks up and deletes a `state`. Returns undefined when it was never issued,
   *  already consumed, or belongs to a different shop — the caller cannot tell these apart, which
   *  is the point. */
  consumeState(state: string, shop: string): Promise<OAuthState | undefined>;
  /** Drops issued states older than `maxAgeMs` so the map can't grow unbounded. */
  pruneStates(maxAgeMs: number): Promise<number>;

  getPending(gatewayId: string): Promise<PendingPayment | undefined>;
  /** By Shopify order id. Shopify order ids are globally unique across stores, so the gateway's
   *  payment webhook can resolve a pending payment from the id alone. */
  getPendingForOrder(orderId: number): Promise<PendingPayment | undefined>;
  /** Shop-scoped lookup, used to make the `orders/create` webhook idempotent. Shopify retries that
   *  webhook (non-2xx, or an ack timeout), and without this guard each retry would mint another
   *  gateway order for the same shop order. */
  getPendingForShopOrder(shop: string, orderId: number): Promise<PendingPayment | undefined>;
  upsertPending(p: PendingPayment): Promise<void>;
  markPaid(gatewayId: string): Promise<PendingPayment | undefined>;
  /** Marks every still-awaiting payment whose gateway quote has lapsed as `expired`. Returns how
   *  many flipped, so the caller can log a single line instead of one per payment. */
  sweepExpired(): Promise<number>;
  /** True when the quote is still payable — i.e. awaiting AND not past its expiry. A payment
   *  that already succeeded stays `paid` so a late/lost webhook can still reconcile it. */
  isLive(gatewayId: string): Promise<boolean>;

  getSettings(shop: string): Promise<StoreSettings | undefined>;
  putSettings(settings: StoreSettings): Promise<void>;
  clearSettings(shop: string): Promise<void>;
}
