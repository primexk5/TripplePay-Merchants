import { describe, it, expect, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createServer } from '../src/api/server.js';
import { JsonStore } from '../src/store/json.js';
import type { QuaiClient } from '../src/chain/client.js';
import type { Config } from '../src/config.js';
import type { Merchant, WebhookDelivery } from '../src/types.js';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ADMIN_KEY = 'test-admin-key-0123456789abcdef';
const CONTRACT = '0x0000000000000000000000000000000000000001';
const MERCHANT_ADDR = '0x00000000000000000000000000000000000000a1';
const ORDER_ID = '0x' + '11'.repeat(32);

const cfg = {
  ADMIN_API_KEY: ADMIN_KEY,
  CORS_ORIGINS: '*',
  CHAIN_ID: 9,
  PAYWITHQUAI_ADDRESS: CONTRACT,
} as unknown as Config;

const onChainOrder = (over: Partial<ReturnType<QuaiClient['getOrder']> extends Promise<infer T> ? T : never> = {}) => ({
  merchant: MERCHANT_ADDR,
  settled: false,
  exists: true,
  feeBps: 50,
  token: '0x0000000000000000000000000000000000000000',
  amount: 25_000_000n,
  expiry: 0n,
  feeRecipient: '0x00000000000000000000000000000000000000c3',
  settledAt: 0n,
  ...over,
});

function fakeClient(getOrder = vi.fn(async () => onChainOrder())) {
  return { address: CONTRACT, getOrder } as unknown as QuaiClient;
}

function freshStore(): JsonStore {
  const dir = mkdtempSync(join(tmpdir(), 'pwq-api-'));
  dirs.push(dir);
  return new JsonStore(join(dir, 'relayer.db'));
}

async function startApp(
  client: QuaiClient = fakeClient(),
  cfgOverride: Partial<Config> = {},
): Promise<{ base: string; store: JsonStore }> {
  const store = freshStore();
  const app = createServer(store, client, { ...cfg, ...cfgOverride } as Config);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, store };
}

async function req(base: string, path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(base + path, init);
  const body = (await res.json().catch(() => undefined)) as Record<string, unknown>;
  return { status: res.status, body };
}

const auth = (key: string) => ({ authorization: `Bearer ${key}` });
const jsonHeaders = { 'content-type': 'application/json' };

async function seedDelivery(store: JsonStore, over: Partial<WebhookDelivery> = {}): Promise<WebhookDelivery> {
  const d: WebhookDelivery = {
    id: '0x' + 'ab'.repeat(32) + ':0',
    chainId: 9,
    merchantId: 'mch_1',
    url: 'https://example.test/webhook',
    payload: {
      id: '0x' + 'ab'.repeat(32) + ':0',
      type: 'payment.confirmed',
      created: 1,
      data: {
        merchantId: 'mch_1',
        chainId: 9,
        merchant: MERCHANT_ADDR,
        orderId: ORDER_ID,
        payer: '0x00000000000000000000000000000000000000b2',
        token: '0x0000000000000000000000000000000000000000',
        amount: '25000000',
        feeBps: 50,
        fee: '125000',
        net: '24875000',
        txHash: '0x' + 'ab'.repeat(32),
        blockNumber: 10,
        timestamp: 1,
        nonce: 1,
      },
    },
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
  await store.insertDeliveryIfAbsent(d);
  return d;
}

const merchantBody = (over: Record<string, unknown> = {}) => ({
  address: MERCHANT_ADDR,
  name: 'Acme',
  webhookUrl: 'https://example.test/webhook',
  ...over,
});

describe('API', () => {
  describe('GET /health', () => {
    it('reports liveness, contract and cursor without auth', async () => {
      const { base, store } = await startApp();
      await store.setCursor('9:' + CONTRACT, 42);
      const { status, body } = await req(base, '/health');
      expect(status).toBe(200);
      expect(body.status).toBe('ok');
      expect(body.contract).toBe(CONTRACT);
      expect(body.chainId).toBe(9);
      expect(body.cursor).toBe(42);
    });
  });

  describe('GET /v1/orders/:merchant/:orderId', () => {
    it('rejects a malformed merchant address and order id', async () => {
      const { base } = await startApp();
      expect((await req(base, '/v1/orders/not-an-address/' + ORDER_ID)).status).toBe(400);
      expect((await req(base, `/v1/orders/${MERCHANT_ADDR}/short`)).status).toBe(400);
    });

    it('returns 404 for a nonexistent order', async () => {
      const { base } = await startApp(fakeClient(vi.fn(async () => onChainOrder({ exists: false }))));
      const { status } = await req(base, `/v1/orders/${MERCHANT_ADDR}/${ORDER_ID}`);
      expect(status).toBe(404);
    });

    it('returns order + webhook status for a settled order', async () => {
      const { base, store } = await startApp(
        fakeClient(vi.fn(async () => onChainOrder({ settled: true, settledAt: 1000n }))),
      );
      await seedDelivery(store, { status: 'delivered', attempts: 2 });
      const { status, body } = await req(base, `/v1/orders/${MERCHANT_ADDR}/${ORDER_ID}`);
      expect(status).toBe(200);
      expect(body.settled).toBe(true);
      expect(body.amount).toBe('25000000');
      expect(body.webhook).toEqual({ status: 'delivered', attempts: 2 });
    });

    it('shows no webhook block when nothing has been delivered yet', async () => {
      const { base } = await startApp();
      const { body } = await req(base, `/v1/orders/${MERCHANT_ADDR}/${ORDER_ID}`);
      expect(body.webhook).toBeNull();
    });

    it('rate-limits the public order endpoint per IP', async () => {
      const { base } = await startApp(fakeClient(), { PUBLIC_RATE_LIMIT_MAX: 2, PUBLIC_RATE_LIMIT_WINDOW_MS: 60_000 });
      const path = `/v1/orders/${MERCHANT_ADDR}/${ORDER_ID}`;
      expect((await req(base, path)).status).toBe(200);
      expect((await req(base, path)).status).toBe(200);
      const limited = await req(base, path);
      expect(limited.status).toBe(429); // 3rd request in the window is rejected
    });
  });

  describe('admin auth', () => {
    it('rejects requests without or with a wrong bearer token', async () => {
      const { base } = await startApp();
      expect((await req(base, '/v1/merchants')).status).toBe(401);
      expect((await req(base, '/v1/merchants', { headers: auth('wrong-key') })).status).toBe(401);
    });

    it('accepts the configured key', async () => {
      const { base } = await startApp();
      expect((await req(base, '/v1/merchants', { headers: auth(ADMIN_KEY) })).status).toBe(200);
    });
  });

  describe('POST /v1/merchants', () => {
    it('onboards a merchant and returns the webhook secret exactly once', async () => {
      const { base, store } = await startApp();
      const { status, body } = await req(base, '/v1/merchants', {
        method: 'POST',
        headers: { ...auth(ADMIN_KEY), ...jsonHeaders },
        body: JSON.stringify(merchantBody()),
      });
      expect(status).toBe(201);
      expect(body.webhookSecret).toMatch(/^whsec_/);

      const stored = (await store.getMerchantByAddress(MERCHANT_ADDR))!;
      expect(stored.webhookSecret).toBe(body.webhookSecret);
      // The secret never leaks through list/read endpoints.
      const { body: listed } = await req(base, '/v1/merchants', { headers: auth(ADMIN_KEY) });
      expect(JSON.stringify(listed)).not.toContain('webhookSecret');
    });

    it('rejects a duplicate address with a hint to use PATCH (no silent secret rotation)', async () => {
      const { base, store } = await startApp();
      const first = await req(base, '/v1/merchants', {
        method: 'POST',
        headers: { ...auth(ADMIN_KEY), ...jsonHeaders },
        body: JSON.stringify(merchantBody()),
      });
      const second = await req(base, '/v1/merchants', {
        method: 'POST',
        headers: { ...auth(ADMIN_KEY), ...jsonHeaders },
        body: JSON.stringify(merchantBody({ name: 'Renamed' })),
      });
      expect(second.status).toBe(409);
      expect((await store.getMerchantByAddress(MERCHANT_ADDR))!.webhookSecret).toBe(first.body.webhookSecret);
      expect((await store.getMerchantByAddress(MERCHANT_ADDR))!.name).toBe('Acme');
    });

    it('validates the body and checksum', async () => {
      const { base } = await startApp();
      expect(
        (await req(base, '/v1/merchants', {
          method: 'POST',
          headers: { ...auth(ADMIN_KEY), ...jsonHeaders },
          body: JSON.stringify(merchantBody({ address: '0x123' })),
        })).status,
      ).toBe(400); // fails the 40-hex regex
      expect(
        (await req(base, '/v1/merchants', {
          method: 'POST',
          headers: { ...auth(ADMIN_KEY), ...jsonHeaders },
          body: JSON.stringify(merchantBody({ name: '' })),
        })).status,
      ).toBe(400); // fails min length
    });

    it('rejects an insecure or internal webhook URL (SSRF guard)', async () => {
      const { base } = await startApp();
      for (const webhookUrl of ['http://example.test/webhook', 'https://127.0.0.1/webhook', 'https://localhost/webhook']) {
        const { status } = await req(base, '/v1/merchants', {
          method: 'POST',
          headers: { ...auth(ADMIN_KEY), ...jsonHeaders },
          body: JSON.stringify(merchantBody({ webhookUrl })),
        });
        expect(status, webhookUrl).toBe(400);
      }
    });

    it('onboards without a webhook URL (empty webhookUrl stored)', async () => {
      const { base, store } = await startApp();
      const { status } = await req(base, '/v1/merchants', {
        method: 'POST',
        headers: { ...auth(ADMIN_KEY), ...jsonHeaders },
        body: JSON.stringify({ address: MERCHANT_ADDR, name: 'Acme' }),
      });
      expect(status).toBe(201);
      const stored = (await store.getMerchantByAddress(MERCHANT_ADDR))!;
      expect(stored.webhookUrl).toBe('');
    });
  });

  describe('PATCH /v1/merchants/:address', () => {
    it('updates profile fields without rotating the secret', async () => {
      const { base, store } = await startApp();
      await req(base, '/v1/merchants', {
        method: 'POST',
        headers: { ...auth(ADMIN_KEY), ...jsonHeaders },
        body: JSON.stringify(merchantBody()),
      });
      const secretBefore = (await store.getMerchantByAddress(MERCHANT_ADDR))!.webhookSecret;

      const { status, body } = await req(base, `/v1/merchants/${MERCHANT_ADDR}`, {
        method: 'PATCH',
        headers: { ...auth(ADMIN_KEY), ...jsonHeaders },
        body: JSON.stringify({ name: 'Acme 2', active: false }),
      });
      expect(status).toBe(200);
      expect(body.name).toBe('Acme 2');
      expect(body.active).toBe(false);
      expect((await store.getMerchantByAddress(MERCHANT_ADDR))!.webhookSecret).toBe(secretBefore);
    });

    it('404s for an unknown address and rejects an empty body', async () => {
      const { base } = await startApp();
      expect(
        (await req(base, `/v1/merchants/${MERCHANT_ADDR}`, {
          method: 'PATCH',
          headers: { ...auth(ADMIN_KEY), ...jsonHeaders },
          body: JSON.stringify({}),
        })).status,
      ).toBe(404); // merchant never onboarded — checked before body validation
    });

    it('re-queues skipped payments the first time a webhook URL is configured', async () => {
      const { base, store } = await startApp();
      // Onboard WITHOUT a webhook URL.
      await req(base, '/v1/merchants', {
        method: 'POST',
        headers: { ...auth(ADMIN_KEY), ...jsonHeaders },
        body: JSON.stringify({ address: MERCHANT_ADDR, name: 'Acme' }),
      });
      // A payment settled while the URL was empty → recorded as skipped.
      const id = '0x' + 'ab'.repeat(32) + ':0';
      await seedDelivery(store, {
        id,
        url: '',
        status: 'skipped',
        lastError: 'webhook URL not configured yet',
      });

      // Configuring the URL must re-queue it with the new target.
      const { status } = await req(base, `/v1/merchants/${MERCHANT_ADDR}`, {
        method: 'PATCH',
        headers: { ...auth(ADMIN_KEY), ...jsonHeaders },
        body: JSON.stringify({ webhookUrl: 'https://example.test/webhook' }),
      });
      expect(status).toBe(200);
      const d = (await store.getDelivery(id))!;
      expect(d.status).toBe('pending');
      expect(d.url).toBe('https://example.test/webhook');
      expect(d.lastError).toBeNull();
    });
  });

  describe('webhook deliveries', () => {
    it('lists recent deliveries', async () => {
      const { base, store } = await startApp();
      seedDelivery(store);
      const { status, body } = await req(base, '/v1/deliveries', { headers: auth(ADMIN_KEY) });
      expect(status).toBe(200);
      expect(body.deliveries).toHaveLength(1);
    });

    it('re-queues a failed delivery', async () => {
      const { base, store } = await startApp();
      await seedDelivery(store, { status: 'failed', attempts: 5, lastError: 'HTTP 500' });
      const { status, body } = await req(base, `/v1/deliveries/${'0x' + 'ab'.repeat(32) + ':0'}/retry`, {
        method: 'POST',
        headers: auth(ADMIN_KEY),
      });
      expect(status).toBe(200);
      expect(body.status).toBe('pending');
      expect(body.attempts).toBe(0);
      const d = (await store.getDelivery('0x' + 'ab'.repeat(32) + ':0'))!;
      expect(d.status).toBe('pending');
      expect(d.attempts).toBe(0);
    });

    it('refuses to retry delivered and skipped deliveries', async () => {
      const { base, store } = await startApp();
      await seedDelivery(store, { status: 'delivered' });
      expect(
        (await req(base, `/v1/deliveries/${'0x' + 'ab'.repeat(32) + ':0'}/retry`, {
          method: 'POST',
          headers: auth(ADMIN_KEY),
        })).status,
      ).toBe(409);

      await seedDelivery(store, {
        id: '0x' + 'cd'.repeat(32) + ':0',
        merchantId: 'unregistered:' + MERCHANT_ADDR,
        url: '',
        status: 'skipped',
        lastError: 'no merchant registered for payout address',
        payload: {
          ...(await store.getDelivery('0x' + 'ab'.repeat(32) + ':0'))!.payload,
          id: '0x' + 'cd'.repeat(32) + ':0',
          data: {
            ...(await store.getDelivery('0x' + 'ab'.repeat(32) + ':0'))!.payload.data,
            merchant: MERCHANT_ADDR,
          },
        },
      });
      const skipped = await req(base, `/v1/deliveries/${'0x' + 'cd'.repeat(32) + ':0'}/retry`, {
        method: 'POST',
        headers: auth(ADMIN_KEY),
      });
      expect(skipped.status).toBe(409);
      // Skipped deliveries are still queued for re-delivery once the address is onboarded.
      expect((await store.getDelivery('0x' + 'cd'.repeat(32) + ':0'))!.status).toBe('skipped');
    });

    it('404s for an unknown delivery id', async () => {
      const { base } = await startApp();
      const { status } = await req(base, '/v1/deliveries/0xdeadbeef/retry', {
        method: 'POST',
        headers: auth(ADMIN_KEY),
      });
      expect(status).toBe(404);
    });
  });
});