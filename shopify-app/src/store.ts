import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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

interface StoreShape {
  sessions: Record<string, ShopSession>;
  pending: Record<string, PendingPayment>;
  states: Record<string, OAuthState>;
}

export class FileStore {
  private readonly path: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, 'store.json');
  }

  private read(): StoreShape {
    if (!existsSync(this.path)) return { sessions: {}, pending: {}, states: {} };
    const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StoreShape>;
    // `states` was added after the first release; older files simply have none.
    return { sessions: parsed.sessions ?? {}, pending: parsed.pending ?? {}, states: parsed.states ?? {} };
  }

  private write(shape: StoreShape): void {
    writeFileSync(this.path, JSON.stringify(shape, null, 2));
  }

  getSession(shop: string): ShopSession | undefined {
    return this.read().sessions[shop.toLowerCase()];
  }

  setSession(session: ShopSession): void {
    const shape = this.read();
    shape.sessions[session.shop.toLowerCase()] = session;
    this.write(shape);
  }

  removeSession(shop: string): void {
    const shape = this.read();
    delete shape.sessions[shop.toLowerCase()];
    this.write(shape);
  }

  /** Records an issued OAuth `state`, bound to the shop it was minted for. */
  putState(state: OAuthState): void {
    const shape = this.read();
    shape.states[state.state] = state;
    this.write(shape);
  }

  /** Atomically looks up and deletes a `state`. Returns undefined when it was never issued,
   *  already consumed, or belongs to a different shop — the caller cannot tell these apart, which
   *  is the point. */
  consumeState(state: string, shop: string): OAuthState | undefined {
    const shape = this.read();
    const found = shape.states[state];
    delete shape.states[state];
    this.write(shape);
    if (!found || found.shop.toLowerCase() !== shop.toLowerCase()) return undefined;
    return found;
  }

  /** Drops issued states older than `maxAgeMs` so the map can't grow unbounded. */
  pruneStates(maxAgeMs: number): number {
    const shape = this.read();
    const cutoff = Date.now() - maxAgeMs;
    let dropped = 0;
    for (const [key, value] of Object.entries(shape.states)) {
      if (value.createdAt < cutoff) {
        delete shape.states[key];
        dropped++;
      }
    }
    if (dropped) this.write(shape);
    return dropped;
  }

  private static isLive(p: PendingPayment): boolean {
    return p.status === 'awaiting' && p.expiresAt > Date.now();
  }

  getPending(gatewayId: string): PendingPayment | undefined {
    return this.read().pending[gatewayId];
  }

  /** By Shopify order id. Shopify order ids are globally unique across stores, so the gateway's
   *  payment webhook can resolve a pending payment from the id alone. */
  getPendingForOrder(orderId: number): PendingPayment | undefined {
    const shape = this.read();
    return Object.values(shape.pending).find((p) => p.orderId === orderId);
  }

  /** Shop-scoped lookup, used to make the `orders/create` webhook idempotent. Shopify retries that
   *  webhook (non-2xx, or an ack timeout), and without this guard each retry would mint another
   *  gateway order for the same shop order. */
  getPendingForShopOrder(shop: string, orderId: number): PendingPayment | undefined {
    const shape = this.read();
    const want = shop.toLowerCase();
    return Object.values(shape.pending).find((p) => p.shop.toLowerCase() === want && p.orderId === orderId);
  }

  upsertPending(p: PendingPayment): void {
    const shape = this.read();
    shape.pending[p.gatewayId] = p;
    this.write(shape);
  }

  markPaid(gatewayId: string): PendingPayment | undefined {
    const shape = this.read();
    const p = shape.pending[gatewayId];
    if (!p) return undefined;
    p.status = 'paid';
    this.write(shape);
    return p;
  }

  /** Marks every still-awaiting payment whose gateway quote has lapsed as `expired`. Returns how
   *  many flipped, so the caller can log a single line instead of one per payment. */
  sweepExpired(): number {
    const shape = this.read();
    const now = Date.now();
    let changed = 0;
    for (const p of Object.values(shape.pending)) {
      if (p.status === 'awaiting' && p.expiresAt <= now) {
        p.status = 'expired';
        changed++;
      }
    }
    if (changed) this.write(shape);
    return changed;
  }

  /** True when the quote is still payable — i.e. awaiting AND not past its expiry. A payment
   *  that already succeeded stays `paid` so a late/lost webhook can still reconcile it. */
  isLive(gatewayId: string): boolean {
    const p = this.read().pending[gatewayId];
    return p !== undefined && FileStore.isLive(p);
  }
}
