import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from '../src/store/file.js';
import type { PendingPayment } from '../src/store/index.js';

const fresh = () => new FileStore(mkdtempSync(join(tmpdir(), 'pwq-store-')));

function pending(over: Partial<PendingPayment> = {}): PendingPayment {
  const now = Date.now();
  return {
    gatewayId: 'g1',
    shop: 'a.myshopify.com',
    orderId: 1,
    checkoutUrl: 'https://pay.example/x',
    amount: '120.0',
    fiatCurrency: 'USD',
    asset: 'qi',
    status: 'awaiting',
    createdAt: now,
    expiresAt: now + 60_000,
    ...over,
  };
}

describe('OAuth state', () => {
  let store: FileStore;
  beforeEach(async () => {
    store = fresh();
  });

  it('accepts a freshly issued state', async () => {
    await store.putState({ state: 'abc', shop: 'a.myshopify.com', createdAt: Date.now() });
    expect((await store.consumeState('abc', 'a.myshopify.com'))?.state).toBe('abc');
  });

  it('rejects a replayed state (single-use)', async () => {
    await store.putState({ state: 'abc', shop: 'a.myshopify.com', createdAt: Date.now() });
    await store.consumeState('abc', 'a.myshopify.com');
    // A leaked callback URL must not be able to mint a second token.
    expect(await store.consumeState('abc', 'a.myshopify.com')).toBeUndefined();
  });

  it('rejects a state issued for a different shop', async () => {
    await store.putState({ state: 'def', shop: 'a.myshopify.com', createdAt: Date.now() });
    expect(await store.consumeState('def', 'evil.myshopify.com')).toBeUndefined();
  });

  it('rejects a state that was never issued', async () => {
    expect(await store.consumeState('forged', 'a.myshopify.com')).toBeUndefined();
  });

  it('prunes only states older than the ttl', async () => {
    await store.putState({ state: 'old', shop: 'a.myshopify.com', createdAt: Date.now() - 60_000 });
    await store.putState({ state: 'new', shop: 'a.myshopify.com', createdAt: Date.now() });
    expect(await store.pruneStates(10_000)).toBe(1);
    expect(await store.consumeState('new', 'a.myshopify.com')).toBeDefined();
    expect(await store.consumeState('old', 'a.myshopify.com')).toBeUndefined();
  });
});

describe('quote expiry', () => {
  let store: FileStore;
  beforeEach(async () => {
    store = fresh();
  });

  it('flips exactly the lapsed awaiting payment to expired', async () => {
    const now = Date.now();
    await store.upsertPending(pending({ gatewayId: 'live', expiresAt: now + 60_000 }));
    await store.upsertPending(pending({ gatewayId: 'dead', expiresAt: now - 60_000, createdAt: now - 120_000 }));
    await store.upsertPending(pending({ gatewayId: 'done', status: 'paid', expiresAt: now - 60_000 }));

    expect(await store.sweepExpired()).toBe(1);
    expect((await store.getPending('live'))?.status).toBe('awaiting');
    expect((await store.getPending('dead'))?.status).toBe('expired');
    expect((await store.getPending('done'))?.status).toBe('paid');
  });

  it('is idempotent', async () => {
    const now = Date.now();
    await store.upsertPending(pending({ gatewayId: 'dead', expiresAt: now - 1 }));
    expect(await store.sweepExpired()).toBe(1);
    expect(await store.sweepExpired()).toBe(0);
  });

  it('tracks payability via isLive', async () => {
    const now = Date.now();
    await store.upsertPending(pending({ gatewayId: 'live', expiresAt: now + 60_000 }));
    await store.upsertPending(pending({ gatewayId: 'dead', expiresAt: now - 60_000 }));
    await store.upsertPending(pending({ gatewayId: 'done', status: 'paid', expiresAt: now - 60_000 }));
    expect(await store.isLive('live')).toBe(true);
    expect(await store.isLive('dead')).toBe(false);
    expect(await store.isLive('done')).toBe(false);
    expect(await store.isLive('nope')).toBe(false);
  });
});

describe('shop-scoped lookup', () => {
  it('keeps two stores with the same Shopify order id apart', async () => {
    const store = fresh();
    await store.upsertPending(pending({ gatewayId: 'g-a', shop: 'a.myshopify.com', orderId: 77 }));
    await store.upsertPending(pending({ gatewayId: 'g-b', shop: 'b.myshopify.com', orderId: 77 }));
    expect((await store.getPendingForShopOrder('a.myshopify.com', 77))?.gatewayId).toBe('g-a');
    expect((await store.getPendingForShopOrder('b.myshopify.com', 77))?.gatewayId).toBe('g-b');
    expect(await store.getPendingForShopOrder('c.myshopify.com', 77)).toBeUndefined();
  });

  it('still resolves unscoped, because Shopify order ids are globally unique', async () => {
    const store = fresh();
    await store.upsertPending(pending({ gatewayId: 'g-a', shop: 'a.myshopify.com', orderId: 77 }));
    expect((await store.getPendingForOrder(77))?.gatewayId).toBe('g-a');
  });
});

describe('backwards compatibility', () => {
  it('reads a store.json written before `states` existed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pwq-legacy-'));
    const now = Date.now();
    writeFileSync(
      join(dir, 'store.json'),
      JSON.stringify({
        sessions: { 'a.myshopify.com': { shop: 'a.myshopify.com', accessToken: 'tok', installedAt: 1, scopes: 'read_orders' } },
        pending: { g: { ...pending({ gatewayId: 'g' }), expiresAt: now + 60_000 } },
      }),
    );
    const store = new FileStore(dir);
    expect((await store.getSession('a.myshopify.com'))?.accessToken).toBe('tok');
    expect(await store.getPending('g')).toBeDefined();
    // Must not throw even though there is no `states` map on disk.
    expect(await store.consumeState('anything', 'a.myshopify.com')).toBeUndefined();
  });
});
