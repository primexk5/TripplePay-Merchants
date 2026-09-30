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
  status: 'awaiting' | 'paid' | 'expired';
  createdAt: number;
}

interface StoreShape {
  sessions: Record<string, ShopSession>;
  pending: Record<string, PendingPayment>;
}

export class FileStore {
  private readonly path: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, 'store.json');
  }

  private read(): StoreShape {
    if (!existsSync(this.path)) return { sessions: {}, pending: {} };
    return JSON.parse(readFileSync(this.path, 'utf8')) as StoreShape;
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

  getPending(gatewayId: string): PendingPayment | undefined {
    return this.read().pending[gatewayId];
  }

  getPendingForOrder(orderId: number): PendingPayment | undefined {
    const shape = this.read();
    return Object.values(shape.pending).find((p) => p.orderId === orderId);
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
}