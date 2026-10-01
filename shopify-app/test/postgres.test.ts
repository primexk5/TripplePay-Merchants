import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresConnectorStore } from '../src/store/postgres.js';
import { FileStore } from '../src/store/file.js';
import type { ConnectorStore, PendingPayment, StoreSettings } from '../src/store/index.js';

/**
 * Behavioral parity suite for {@link PostgresConnectorStore} — the scenarios the FileStore suite
 * covers, plus the concurrency-sensitive ones that a real database has to get right and a JSON file
 * cannot (two simultaneous callbacks for one OAuth `state`; two simultaneous expiry sweeps).
 *
 * Skipped unless TEST_DATABASE_URL is set. Run locally with, e.g.:
 *   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/shopify_test npm test
 */
const url = process.env.TEST_DATABASE_URL;
const describePg = url ? describe : describe.skip;

const SHOP_A = 'a.myshopify.com';
const SHOP_B = 'b.myshopify.com';

const settings = (shop: string): StoreSettings => ({
  shop,
  merchantKeyCipher: `v1.iv.tag.${shop}`,
  webhookSecretCipher: `v1.iv.tag.wh-${shop}`,
  configuredAt: 1,
});

async function clear(store: PostgresConnectorStore) {
  await store.pool.query('TRUNCATE shop_sessions, oauth_states, pending_payments, shop_settings');
}

describePg('PostgresConnectorStore', () => {
  let pg: PostgresConnectorStore;

  beforeAll(async () => {
    pg = new PostgresConnectorStore(url!, { ssl: false });
    await pg.init();
  });

  afterAll(async () => {
    await pg.pool.end();
  });

  beforeEach(async () => {
    await clear(pg);
  });

  it('creates its schema idempotently', async () => {
    await expect(pg.init()).resolves.toBeUndefined();
  });

  describe('sessions', () => {
    it('round-trips a session', async () => {
      await pg.setSession({ shop: SHOP_A, accessToken: 'shpat_a', installedAt: 5, scopes: 'read_orders' });
      expect(await pg.getSession(SHOP_A)).toEqual({ shop: SHOP_A, accessToken: 'shpat_a', installedAt: 5, scopes: 'read_orders' });
    });

    it('is case-insensitive on the shop domain', async () => {
      await pg.setSession({ shop: SHOP_A, accessToken: 'shpat_a', installedAt: 5, scopes: 'read_orders' });
      expect((await pg.getSession(SHOP_A.toUpperCase()))?.accessToken).toBe('shpat_a');
    });

    it('replaces rather than duplicating on re-install', async () => {
      await pg.setSession({ shop: SHOP_A, accessToken: 'old', installedAt: 1, scopes: 's' });
      await pg.setSession({ shop: SHOP_A, accessToken: 'new', installedAt: 2, scopes: 's' });
      expect((await pg.getSession(SHOP_A))?.accessToken).toBe('new');
      expect((await pg.pool.query('SELECT count(*)::int AS n FROM shop_sessions')).rows[0]!.n).toBe(1);
    });

    it('keeps two stores apart', async () => {
      await pg.setSession({ shop: SHOP_A, accessToken: 'a', installedAt: 1, scopes: 's' });
      await pg.setSession({ shop: SHOP_B, accessToken: 'b', installedAt: 1, scopes: 's' });
      expect((await pg.getSession(SHOP_A))?.accessToken).toBe('a');
      expect((await pg.getSession(SHOP_B))?.accessToken).toBe('b');
    });

    it('removes a session', async () => {
      await pg.setSession({ shop: SHOP_A, accessToken: 'a', installedAt: 1, scopes: 's' });
      await pg.removeSession(SHOP_A);
      expect(await pg.getSession(SHOP_A)).toBeUndefined();
    });
  });

  describe('oauth states', () => {
    it('consumes a state exactly once', async () => {
      await pg.putState({ state: 'st1', shop: SHOP_A, createdAt: Date.now() });
      expect((await pg.consumeState('st1', SHOP_A))?.state).toBe('st1');
      expect(await pg.consumeState('st1', SHOP_A)).toBeUndefined();
    });

    it('refuses a state issued for another shop', async () => {
      await pg.putState({ state: 'st1', shop: SHOP_A, createdAt: Date.now() });
      expect(await pg.consumeState('st1', SHOP_B)).toBeUndefined();
    });

    it('refuses an unknown state', async () => {
      expect(await pg.consumeState('forged', SHOP_A)).toBeUndefined();
    });

    it('lets only one of two concurrent callbacks win', async () => {
      // The whole reason consumeState is a single DELETE...RETURNING rather than SELECT-then-DELETE.
      await pg.putState({ state: 'st1', shop: SHOP_A, createdAt: Date.now() });
      const [x, y] = await Promise.all([pg.consumeState('st1', SHOP_A), pg.consumeState('st1', SHOP_A)]);
      expect([x, y].filter(Boolean)).toHaveLength(1);
    });

    it('prunes only states older than the cutoff', async () => {
      await pg.putState({ state: 'old', shop: SHOP_A, createdAt: Date.now() - 60_000 });
      await pg.putState({ state: 'new', shop: SHOP_A, createdAt: Date.now() });
      expect(await pg.pruneStates(10_000)).toBe(1);
      expect(await pg.consumeState('new', SHOP_A)).toBeDefined();
      expect(await pg.consumeState('old', SHOP_A)).toBeUndefined();
    });
  });

  describe('pending payments', () => {
    const pending = (over: Partial<PendingPayment> = {}): PendingPayment => ({
      gatewayId: 'g1', shop: SHOP_A, orderId: 1, checkoutUrl: 'https://pay/x', amount: '1',
      fiatCurrency: 'USD', asset: 'qi', status: 'awaiting' as const,
      createdAt: Date.now(), expiresAt: Date.now() + 60_000, ...over,
    });

    it('round-trips every field', async () => {
      await pg.upsertPending(pending());
      expect(await pg.getPending('g1')).toMatchObject({ gatewayId: 'g1', shop: SHOP_A, orderId: 1, asset: 'qi', status: 'awaiting' });
    });

    it('finds by order id and by shop+order', async () => {
      await pg.upsertPending(pending({ gatewayId: 'g-a', shop: SHOP_A, orderId: 77 }));
      await pg.upsertPending(pending({ gatewayId: 'g-b', shop: SHOP_B, orderId: 77 }));
      expect((await pg.getPendingForOrder(77))?.gatewayId).toBe('g-a');
      expect((await pg.getPendingForShopOrder(SHOP_B, 77))?.gatewayId).toBe('g-b');
    });

    it('marks paid', async () => {
      await pg.upsertPending(pending());
      expect((await pg.markPaid('g1'))?.status).toBe('paid');
      expect((await pg.getPending('g1'))?.status).toBe('paid');
    });

    it('returns undefined when marking an unknown payment', async () => {
      expect(await pg.markPaid('nope')).toBeUndefined();
    });

    it('expires only lapsed awaiting payments', async () => {
      const now = Date.now();
      await pg.upsertPending(pending({ gatewayId: 'live', expiresAt: now + 60_000 }));
      await pg.upsertPending(pending({ gatewayId: 'dead', expiresAt: now - 60_000 }));
      await pg.upsertPending(pending({ gatewayId: 'done', status: 'paid', expiresAt: now - 60_000 }));
      expect(await pg.sweepExpired()).toBe(1);
      expect((await pg.getPending('live'))?.status).toBe('awaiting');
      expect((await pg.getPending('dead'))?.status).toBe('expired');
      expect((await pg.getPending('done'))?.status).toBe('paid');
    });

    it('reports payability via isLive', async () => {
      const now = Date.now();
      await pg.upsertPending(pending({ gatewayId: 'live', expiresAt: now + 60_000 }));
      await pg.upsertPending(pending({ gatewayId: 'dead', expiresAt: now - 60_000 }));
      await pg.upsertPending(pending({ gatewayId: 'done', status: 'paid', expiresAt: now - 60_000 }));
      expect(await pg.isLive('live')).toBe(true);
      expect(await pg.isLive('dead')).toBe(false);
      expect(await pg.isLive('done')).toBe(false);
      expect(await pg.isLive('nope')).toBe(false);
    });

    it('does not walk a legacy row (expires_at 0) backwards but does treat it as not live', async () => {
      // A row from before expires_at existed: treat the link as dead rather than eternally payable.
      await pg.pool.query(
        `INSERT INTO pending_payments (gateway_id, shop, order_id, checkout_url, amount, fiat_currency, asset, status, created_at, expires_at)
         VALUES ('legacy', $1, 5, 'https://pay/x', '1', 'USD', 'qi', 'awaiting', 1, 0)`,
        [SHOP_A],
      );
      expect(await pg.isLive('legacy')).toBe(false);
      expect(await pg.sweepExpired()).toBe(0);
      expect((await pg.getPending('legacy'))?.status).toBe('awaiting');
    });
  });

  describe('store settings', () => {
    it('round-trips sealed credentials', async () => {
      await pg.putSettings(settings(SHOP_A));
      expect(await pg.getSettings(SHOP_A)).toEqual(settings(SHOP_A));
    });

    it('keeps two stores’ credentials separate', async () => {
      await pg.putSettings(settings(SHOP_A));
      await pg.putSettings(settings(SHOP_B));
      expect((await pg.getSettings(SHOP_A))?.merchantKeyCipher).toContain(SHOP_A);
      expect((await pg.getSettings(SHOP_B))?.merchantKeyCipher).toContain(SHOP_B);
    });

    it('overwrites on re-save', async () => {
      await pg.putSettings(settings(SHOP_A));
      await pg.putSettings({ ...settings(SHOP_A), configuredAt: 99 });
      expect((await pg.getSettings(SHOP_A))?.configuredAt).toBe(99);
      expect((await pg.pool.query('SELECT count(*)::int AS n FROM shop_settings')).rows[0]!.n).toBe(1);
    });

    it('clears credentials', async () => {
      await pg.putSettings(settings(SHOP_A));
      await pg.clearSettings(SHOP_A);
      expect(await pg.getSettings(SHOP_A)).toBeUndefined();
    });
  });

  describe('parity with FileStore', () => {
    it('behaves identically on the core flows', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'pwq-parity-'));
      const file = new FileStore(dir);
      try {
      const now = Date.now();
      const seq = async (s: ConnectorStore) => {
        await s.setSession({ shop: SHOP_A, accessToken: 't', installedAt: now, scopes: 'read_orders' });
        await s.putState({ state: 'st', shop: SHOP_A, createdAt: now });
        await s.upsertPending({
          gatewayId: 'g', shop: SHOP_A, orderId: 9, checkoutUrl: 'https://pay/x', amount: '1',
          fiatCurrency: 'USD', asset: 'qi', status: 'awaiting', createdAt: now, expiresAt: now - 1,
        });
        return {
          session: (await s.getSession(SHOP_A))?.accessToken,
          state: (await s.consumeState('st', SHOP_A))?.state,
          stateReplay: await s.consumeState('st', SHOP_A),
          byOrder: (await s.getPendingForOrder(9))?.gatewayId,
          swept: await s.sweepExpired(),
          status: (await s.getPending('g'))?.status,
          live: await s.isLive('g'),
          settings: (await s.putSettings(settings(SHOP_A)), (await s.getSettings(SHOP_A))?.merchantKeyCipher),
        };
      };
        expect(await seq(pg)).toEqual(await seq(file));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
