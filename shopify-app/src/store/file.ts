import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, fsyncSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { ConnectorStore, ShopSession, PendingPayment, OAuthState, StoreSettings } from './index.js';

interface StoreShape {
  sessions: Record<string, ShopSession>;
  pending: Record<string, PendingPayment>;
  states: Record<string, OAuthState>;
  settings?: Record<string, StoreSettings>;
}

const EMPTY: StoreShape = { sessions: {}, pending: {}, states: {}, settings: {} };

/**
 * Single-process persistence backed by one JSON file.
 *
 * Correct for one connector instance and for local development. The shape is held in memory and
 * mutated in place, and every mutation is written out atomically (temp file + rename) — the previous
 * version re-read and re-parsed the whole file on every single call, which was O(n) per operation and
 * also raced: two concurrent read-modify-write cycles could each start from the same snapshot and the
 * later write would silently drop the earlier one. Serialising the write queue and sharing one
 * in-memory shape removes both problems.
 *
 * For more than one instance, or for durability across a restart, use {@link PostgresConnectorStore}.
 */
export class FileStore implements ConnectorStore {
  private readonly path: string;
  private readonly tmpPath: string;
  private shape: StoreShape;
  /** Serialises writes so two concurrent mutations cannot interleave and lose one. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dirOrPath: string) {
    const dir = dirOrPath.endsWith('.json') ? dirname(dirOrPath) : dirOrPath;
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, 'store.json');
    this.tmpPath = `${this.path}.tmp`;
    this.shape = this.read();
  }

  private read(): StoreShape {
    if (!existsSync(this.path)) return structuredClone(EMPTY);
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StoreShape>;
      // `states` and `settings` were added after the first release; older files simply have none.
      return {
        sessions: parsed.sessions ?? {},
        pending: parsed.pending ?? {},
        states: parsed.states ?? {},
        settings: parsed.settings ?? {},
      };
    } catch {
      return structuredClone(EMPTY);
    }
  }

  /** Atomically persists the current shape, queued behind any write already in flight. */
  private persist(): Promise<void> {
    const next = this.queue.then(
      () =>
        new Promise<void>((resolve) => {
          writeFileSync(this.tmpPath, JSON.stringify(this.shape, null, 2), { encoding: 'utf8', mode: 0o600 });
          try {
            chmodSync(this.tmpPath, 0o600);
          } catch {
            /* filesystems without POSIX perms */
          }
          // fsync before rename so a crash cannot leave the target file as stale data.
          const fd = openSync(this.tmpPath, 'r+');
          try {
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
          renameSync(this.tmpPath, this.path);
          resolve();
        }),
    );
    // Keep the chain alive even if one write rejects, so a single failure can't wedge the store.
    this.queue = next.catch(() => undefined);
    return next;
  }

  async getSession(shop: string): Promise<ShopSession | undefined> {
    return this.shape.sessions[shop.toLowerCase()];
  }

  async setSession(session: ShopSession): Promise<void> {
    this.shape.sessions[session.shop.toLowerCase()] = session;
    return this.persist();
  }

  async removeSession(shop: string): Promise<void> {
    delete this.shape.sessions[shop.toLowerCase()];
    return this.persist();
  }

  async putState(state: OAuthState): Promise<void> {
    this.shape.states[state.state] = state;
    return this.persist();
  }

  async consumeState(state: string, shop: string): Promise<OAuthState | undefined> {
    const found = this.shape.states[state];
    delete this.shape.states[state];
    return this.persist().then(() => {
      if (!found || found.shop.toLowerCase() !== shop.toLowerCase()) return undefined;
      return found;
    });
  }

  async pruneStates(maxAgeMs: number): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    let dropped = 0;
    for (const [key, value] of Object.entries(this.shape.states)) {
      if (value.createdAt < cutoff) {
        delete this.shape.states[key];
        dropped++;
      }
    }
    if (dropped) await this.persist();
    return dropped;
  }

  static isLive(p: PendingPayment): boolean {
    return p.status === 'awaiting' && p.expiresAt > Date.now();
  }

  async getPending(gatewayId: string): Promise<PendingPayment | undefined> {
    return this.shape.pending[gatewayId];
  }

  async getPendingForOrder(orderId: number): Promise<PendingPayment | undefined> {
    return Object.values(this.shape.pending).find((p) => p.orderId === orderId);
  }

  async getPendingForShopOrder(shop: string, orderId: number): Promise<PendingPayment | undefined> {
    const want = shop.toLowerCase();
    return Object.values(this.shape.pending).find((p) => p.shop.toLowerCase() === want && p.orderId === orderId);
  }

  async upsertPending(p: PendingPayment): Promise<void> {
    this.shape.pending[p.gatewayId] = p;
    return this.persist();
  }

  async markPaid(gatewayId: string): Promise<PendingPayment | undefined> {
    const p = this.shape.pending[gatewayId];
    if (!p) return undefined;
    p.status = 'paid';
    await this.persist();
    return p;
  }

  async sweepExpired(): Promise<number> {
    const now = Date.now();
    let changed = 0;
    for (const p of Object.values(this.shape.pending)) {
      if (p.status === 'awaiting' && p.expiresAt <= now) {
        p.status = 'expired';
        changed++;
      }
    }
    if (changed) await this.persist();
    return changed;
  }

  async isLive(gatewayId: string): Promise<boolean> {
    const p = this.shape.pending[gatewayId];
    return p !== undefined && FileStore.isLive(p);
  }

  async getSettings(shop: string): Promise<StoreSettings | undefined> {
    return this.shape.settings?.[shop.toLowerCase()];
  }

  async putSettings(settings: StoreSettings): Promise<void> {
    (this.shape.settings ??= {})[settings.shop.toLowerCase()] = { ...settings, shop: settings.shop.toLowerCase() };
    return this.persist();
  }

  async clearSettings(shop: string): Promise<void> {
    if (this.shape.settings) delete this.shape.settings[shop.toLowerCase()];
    return this.persist();
  }
}
