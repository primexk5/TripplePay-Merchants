import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Wallet } from 'quais';
import { createServer } from '../src/api/server.js';
import { JsonStore } from '../src/store/json.js';
import type { Config } from '../src/config.js';
import type { QuaiClient } from '../src/chain/client.js';
import type { QiService } from '../src/chain/qi.js';
import type { QiOrder, WebhookDelivery, PaymentLink } from '../src/types.js';

const ADMIN_KEY = 'test-admin-key-0123456789abcdef';
const CONTRACT = '0x0000000000000000000000000000000000000001';

const cfg = {
  ADMIN_API_KEY: ADMIN_KEY,
  CORS_ORIGINS: '*',
  CHAIN_ID: 9,
  LOGIN_REALM: 'tripplepay',
  TRUST_PROXY: 0,
  PAYWITHQUAI_ADDRESS: CONTRACT,
} as unknown as Config;

const wallet = new Wallet('0x' + randomBytes(32).toString('hex'));

function fakeClient(): QuaiClient {
  return { address: CONTRACT } as unknown as QuaiClient;
}

let addressNonce = 0;
function fakeQi(store: JsonStore): QiService {
  return {
    enabled: true,
    rpcUrl: 'https://rpc.test',
    orderQits: (amountWei: bigint) => (amountWei / 10n ** 18n) * 1000n,
    ensureQiOrder: async (orderId: string, merchantAddress: string, qits: bigint) => {
      addressNonce += 1;
      const order: QiOrder = {
        orderId: orderId.toLowerCase(),
        merchantAddress: merchantAddress.toLowerCase(),
        address: '0x' + addressNonce.toString(16).padStart(40, '0'),
        qits: qits.toString(),
        receivedQits: '0',
        settled: false,
        txHashes: [],
        createdAt: Date.now(),
        settledAt: null,
      };
      await store.insertQiOrder(order); // mirror the real QiService, which persists before returning
      return order;
    },
  } as unknown as QiService;
}

const dirs: string[] = [];
const servers: Server[] = [];
afterAll(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshStore(): JsonStore {
  const dir = mkdtempSync(join(tmpdir(), 'pwq-qirecon-'));
  dirs.push(dir);
  return new JsonStore(join(dir, 'relayer.db'));
}

async function startApp(qi?: QiService, storeOverride?: JsonStore): Promise<{ base: string; store: JsonStore }> {
  const store = storeOverride ?? freshStore();
  const app = createServer(store, fakeClient(), cfg, qi);
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

const jsonHeaders = { 'content-type': 'application/json' };

async function onboardAndLogin(base: string): Promise<string> {
  await fetch(`${base}/v1/merchants`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN_KEY}`, ...jsonHeaders },
    body: JSON.stringify({ address: wallet.address, name: 'Acme', webhookUrl: 'https://example.test/webhook' }),
  });
  const challenge = await req(base, '/v1/auth/challenge', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ address: wallet.address }),
  });
  const signature = await wallet.signMessage(challenge.body.message as string);
  const res = await req(base, '/v1/auth/login', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ address: wallet.address, message: challenge.body.message, signature }),
  });
  return res.body.token as string;
}

const qiOrder = (orderId: string, over: Partial<QiOrder> = {}): QiOrder => {
  let n = parseInt(orderId.slice(2, 4), 16) || 0;
  return {
    orderId,
    merchantAddress: wallet.address.toLowerCase(),
    address: '0x' + (0xa0 + n).toString(16).padStart(40, '0'),
    qits: '25000',
    receivedQits: '25000',
    settled: true,
    txHashes: ['0x' + 'bb'.repeat(32)],
    createdAt: 1,
    settledAt: 2,
    ...over,
  };
};

const deliveryFor = (orderId: string, status: WebhookDelivery['status']): WebhookDelivery => ({
  id: 'qi:' + orderId,
  chainId: cfg.CHAIN_ID,
  merchantId: 'unregistered:' + wallet.address.toLowerCase(),
  url: '',
  payload: {
    id: 'qi:' + orderId,
    type: 'payment.confirmed',
    created: 1,
    data: {
      merchantId: 'unregistered:' + wallet.address.toLowerCase(),
      chainId: cfg.CHAIN_ID,
      merchant: wallet.address.toLowerCase(),
      orderId,
      payer: '',
      token: 'qi',
      amount: '25000',
      feeBps: 0,
      fee: '0',
      net: '25000',
      txHash: '0x' + 'bb'.repeat(32),
      blockNumber: 0,
      timestamp: 2,
      nonce: 0,
    },
  },
  status,
  attempts: 0,
  nextAttemptAt: 0,
  lastError: null,
  createdAt: 1,
  updatedAt: 1,
});

describe('merchant Qi reconciliation (GET /v1/me/qi)', () => {
  it('lists the merchant\'s Qi orders with a value summary and delivery status', async () => {
    const { base, store } = await startApp();
    await store.upsertMerchant({
      merchantId: 'mch_1',
      address: wallet.address.toLowerCase(),
      name: 'Acme',
      webhookUrl: 'https://example.test/webhook',
      webhookSecret: 'whsec_x',
      active: true,
      createdAt: 1,
    });
    const paid = qiOrder('0x' + '11'.repeat(32), { createdAt: 2, settledAt: 3 });
    const overpaid = qiOrder('0x' + '22'.repeat(32), { qits: '10000', receivedQits: '15000', createdAt: 3, settledAt: 4 });
    const awaiting = qiOrder('0x' + '33'.repeat(32), { settled: false, receivedQits: '0', createdAt: 1 });
    await store.insertQiOrder(paid);
    await store.insertQiOrder(overpaid);
    await store.insertQiOrder(awaiting);
    await store.insertDeliveryIfAbsent(deliveryFor(paid.orderId, 'delivered'));

    const token = await onboardAndLogin(base);
    const { status, body } = await req(base, '/v1/me/qi', { headers: { authorization: `Bearer ${token}` } });

    expect(status).toBe(200);
    // Newest first.
    const orders = body.orders as Array<Record<string, unknown>>;
    expect(orders.map((o) => o.orderId)).toEqual([overpaid.orderId, paid.orderId, awaiting.orderId]);
    expect(orders[1]!.webhook).toEqual({ status: 'delivered', attempts: 0 });
    expect(orders[1]!.meta).toEqual({ source: null, slug: null, shopName: null, reference: null });
    expect(orders[2]!.settled).toBe(false);

    expect(body.summary).toEqual({
      total: 3,
      settled: 2,
      pending: 1,
      qitsRequired: '35000', // 25000 + 10000 — only settled orders count toward the payout total
      qitsReceived: '40000', // 25000 + 15000 (overpayment credited)
    });
  });

  it('rejects unauthenticated reads', async () => {
    const { base } = await startApp();
    expect((await req(base, '/v1/me/qi')).status).toBe(401);
  });

  it('tags an order reserved through qi-claim with its payment-link source for reconciliation', async () => {
    const store = freshStore();
    const qi = fakeQi(store);
    const { base } = await startApp(qi, store);
    const link: PaymentLink = {
      slug: 'abc12345',
      chainId: cfg.CHAIN_ID,
      merchantAddress: wallet.address.toLowerCase(),
      merchantId: 'mch_1',
      merchantName: 'Acme',
      shopName: 'Test Shop',
      tokenAddress: '0x0000000000000000000000000000000000000000',
      amount: '120000000000000000000', // 120 Qi
      amountDisplay: '120.0',
      symbol: 'QUAI',
      expiryDurationSecs: 0,
      multiPay: true,
      orderPool: ['0x' + '44'.repeat(32)],
      createdAt: 1,
    };
    await store.upsertMerchant({
      merchantId: 'mch_1',
      address: wallet.address.toLowerCase(),
      name: 'Acme',
      webhookUrl: 'https://example.test/webhook',
      webhookSecret: 'whsec_x',
      active: true,
      createdAt: 1,
    });
    await store.upsertLink(link);

    // Customer requests a Qi address for the link.
    const claim = await req(base, '/v1/links/abc12345/qi-claim', { method: 'POST' });
    expect(claim.status).toBe(200);

    const token = await onboardAndLogin(base);
    const { body } = await req(base, '/v1/me/qi', { headers: { authorization: `Bearer ${token}` } });
    const order = (body.orders as Array<Record<string, unknown>>)?.[0];
    expect(order).toBeDefined();
    // Order shows the required qits (120 Qi = 120_000 qits) and the link attribution.
    expect(order!.orderId).toBe('0x' + '44'.repeat(32));
    expect(order!.qits).toBe('120000');
    expect(order!.meta).toEqual({ source: 'link', slug: 'abc12345', shopName: 'Test Shop', reference: null });
  });
});