import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Wallet } from 'quais';
import { JsonStore } from '../src/store/json.js';
import { QiIndexer, qiPaymentId } from '../src/indexer/qi-indexer.js';
import { WebhookDispatcher } from '../src/webhooks/dispatcher.js';
import { createServer } from '../src/api/server.js';
import { signPayload, verifySignature, SIGNATURE_HEADER } from '../src/webhooks/signer.js';
import type { QiService } from '../src/chain/qi.js';
import type { QuaiClient } from '../src/chain/client.js';
import type { Config } from '../src/config.js';
import type { Merchant, QiOrder, PaymentLink, WebhookDelivery } from '../src/types.js';

const TX = '0x' + 'bb'.repeat(32);

const dirs: string[] = [];
const servers: Server[] = [];
function freshStore(): JsonStore {
  const dir = mkdtempSync(join(tmpdir(), 'pwq-stress-'));
  dirs.push(dir);
  return new JsonStore(join(dir, 'relayer.db'));
}
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const cfg = {
  QI_POLL_INTERVAL_MS: 8000,
  WEBHOOK_TIMEOUT_MS: 5000,
  WEBHOOK_MAX_ATTEMPTS: 10,
  WEBHOOK_BASE_BACKOFF_MS: 1000,
  WEBHOOK_MAX_BACKOFF_MS: 60_000,
} as unknown as Config;

let an = 0;
const addrFor = () => '0x' + (0xa0 + ++an).toString(16).padStart(40, '0');

const merchant = (address: string, over: Partial<Merchant> = {}): Merchant => ({
  merchantId: 'mch_' + address.slice(2, 6),
  address: address.toLowerCase(),
  name: 'Acme',
  webhookUrl: 'https://example.test/webhook',
  webhookSecret: 'whsec_' + address.slice(2, 10),
  active: true,
  createdAt: 1,
  ...over,
});

const qiOrder = (orderId: string, over: Partial<QiOrder> = {}): QiOrder => ({
  orderId,
  merchantAddress: '0x' + 'aa'.repeat(20),
  address: addrFor(),
  qits: '10000',
  receivedQits: '0',
  settled: false,
  txHashes: [],
  createdAt: 1,
  settledAt: null,
  ...over,
});

let seq = 0;
const oid = () => '0x' + (++seq + 0x11).toString(16).padStart(64, '0');

function makeQi(
  store: JsonStore,
  funds: Record<string, bigint>,
  failures: string[] = [],
) {
  const checkBalance = vi.fn(async (address: string) => {
    if (failures.includes(address)) throw new Error('rpc timeout');
    const v = funds[address] ?? 0n;
    return { receivedQits: v, txHashes: v === 0n ? [] : [TX] };
  });
  const svc = {
    enabled: true,
    rpcUrl: 'https://rpc.test',
    orderQits: (amountWei: bigint) => (amountWei / 10n ** 18n) * 1000n,
    ensureQiOrder: async (orderId: string, merchantAddress: string, qits: bigint) => {
      const order: QiOrder = {
        orderId: orderId.toLowerCase(),
        merchantAddress: merchantAddress.toLowerCase(),
        address: addrFor(),
        qits: qits.toString(),
        receivedQits: '0',
        settled: false,
        txHashes: [],
        createdAt: Date.now(),
        settledAt: null,
      };
      await store.insertQiOrder(order);
      return order;
    },
    checkBalance,
  } as unknown as QiService & { checkBalance: ReturnType<typeof vi.fn> };
  return svc;
}

const indexerFor = (qi: QiService, store: JsonStore, now = 1_700_000_000_000) =>
  new QiIndexer(qi, store, cfg, cfg.CHAIN_ID, () => now);

describe('QiIndexer stress', () => {
  it('boundary: underpay stays, exact pays, overpay pays', async () => {
    const store = freshStore();
    const m = merchant('0x' + 'aa'.repeat(20));
    await store.upsertMerchant(m);
    const o1 = qiOrder(oid(), { merchantAddress: m.address });
    const o2 = qiOrder(oid(), { merchantAddress: m.address });
    const o3 = qiOrder(oid(), { merchantAddress: m.address });
    await store.insertQiOrder(o1);
    await store.insertQiOrder(o2);
    await store.insertQiOrder(o3);

    const qi = makeQi(store, { [o1.address]: 9999n, [o2.address]: 10000n, [o3.address]: 10001n });
    await indexerFor(qi, store).sweep();

    expect((await store.getQiOrder(o1.orderId))!.settled).toBe(false);
    expect((await store.getQiOrder(o2.orderId))!.settled).toBe(true);
    expect((await store.getQiOrder(o3.orderId))!.settled).toBe(true);
    expect((await store.getQiOrder(o3.orderId))!.receivedQits).toBe('10001');
    expect(await store.listDeliveries(10)).toHaveLength(2);
  });

  it('exactly one delivery under concurrent sweeps', async () => {
    const store = freshStore();
    const m = merchant('0x' + 'aa'.repeat(20));
    await store.upsertMerchant(m);
    const o = qiOrder(oid(), { merchantAddress: m.address });
    await store.insertQiOrder(o);
    const qi = makeQi(store, { [o.address]: 10000n });
    const indexer = indexerFor(qi, store);
    await Promise.all([indexer.sweep(), indexer.sweep(), indexer.sweep()]);
    const deliveries = await store.listDeliveries(10);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.id).toBe(qiPaymentId(o.orderId));
    expect(deliveries[0]!.status).toBe('pending');
  });

  it('no double-deliver across a restart', async () => {
    const store = freshStore();
    const m = merchant('0x' + 'aa'.repeat(20));
    await store.upsertMerchant(m);
    const o = qiOrder(oid(), { merchantAddress: m.address });
    await store.insertQiOrder(o);
    const qi = makeQi(store, { [o.address]: 10000n });
    await indexerFor(qi, store).sweep();
    await indexerFor(qi, store).sweep();
    expect(await store.listDeliveries(10)).toHaveLength(1);
  });

  it('self-heals a delivery lost between markQiOrderSettled and enqueue', async () => {
    const store = freshStore();
    const m = merchant('0x' + 'aa'.repeat(20));
    await store.upsertMerchant(m);
    const o = qiOrder(oid(), { merchantAddress: m.address });
    await store.insertQiOrder(o);
    // Simulate crash: settled but delivery never created.
    await store.markQiOrderSettled(o.orderId, '10000', [TX]);
    expect(await store.getDelivery(qiPaymentId(o.orderId))).toBeUndefined();
    // Restarted indexer reconciles.
    await indexerFor(makeQi(store, {}), store).sweep();
    const d = (await store.getDelivery(qiPaymentId(o.orderId)))!;
    expect(d).toBeDefined();
    expect(d.status).toBe('pending');
    // Idempotent on next sweep.
    await indexerFor(makeQi(store, {}), store).sweep();
    expect(await store.listDeliveries(10)).toHaveLength(1);
  });

  it('one broken balance check never blocks the rest of the batch', async () => {
    const store = freshStore();
    const m = merchant('0x' + 'aa'.repeat(20));
    await store.upsertMerchant(m);
    const bad = qiOrder(oid(), { merchantAddress: m.address });
    const ok = qiOrder(oid(), { merchantAddress: m.address });
    await store.insertQiOrder(bad);
    await store.insertQiOrder(ok);
    const qi = makeQi(store, { [ok.address]: 10000n }, [bad.address]);
    await indexerFor(qi, store).sweep();
    expect((await store.getQiOrder(bad.orderId))!.settled).toBe(false);
    expect((await store.getQiOrder(ok.orderId))!.settled).toBe(true);
    const deliveries = await store.listDeliveries(10);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.payload.data.orderId).toBe(ok.orderId);
  });

  it('paid link claim is never recycled', async () => {
    const store = freshStore();
    const m = merchant('0x' + 'aa'.repeat(20));
    await store.upsertMerchant(m);
    const slug = 'abc12345';
    const o = oid();
    const link: PaymentLink = {
      slug, chainId: cfg.CHAIN_ID, merchantAddress: m.address, merchantId: m.merchantId, merchantName: 'Acme',
      shopName: 'Test', tokenAddress: '0x0000000000000000000000000000000000000000',
      amount: '10000000000000000000', amountDisplay: '10.0', symbol: 'QUAI',
      expiryDurationSecs: 0, multiPay: true, orderPool: [o], createdAt: 1,
    };
    await store.upsertLink(link);
    await store.reserveQiLinkOrder(slug);
    const order = qiOrder(o, { merchantAddress: m.address });
    await store.insertQiOrder(order);
    await store.saveOrderMeta({ orderId: o, chainId: cfg.CHAIN_ID, merchantAddress: m.address, source: 'link', slug, createdAt: 1 });
    await indexerFor(makeQi(store, { [order.address]: 10000n }), store).sweep();
    const claim = (await store.getLatestClaim(slug, 'qi'))!;
    expect(claim.settled).toBe(true);
    expect(await store.reclaimStaleClaim(slug, 'qi', 1)).toBeUndefined();
  });

  it('unregistered merchant: skipped -> register -> requeue -> pending with correct merchantId', async () => {
    const store = freshStore();
    const m = merchant('0x' + 'ab'.repeat(20));
    const o = qiOrder(oid(), { merchantAddress: m.address });
    await store.insertQiOrder(o);
    await indexerFor(makeQi(store, { [o.address]: 10000n }), store).sweep();
    let d = (await store.getDelivery(qiPaymentId(o.orderId)))!;
    expect(d.status).toBe('skipped');
    expect(d.merchantId).toBe('unregistered:' + m.address);
    expect(d.payload.data.merchantId).toBe('unregistered:' + m.address);

    await store.upsertMerchant(m);
    expect(await store.requeueSkippedForMerchant(m)).toBe(1);
    d = (await store.getDelivery(qiPaymentId(o.orderId)))!;
    expect(d.status).toBe('pending');
    expect(d.merchantId).toBe(m.merchantId);
    expect(d.payload.data.merchantId).toBe(m.merchantId);
    expect(d.url).toBe(m.webhookUrl);
    expect(await store.requeueSkippedForMerchant(m)).toBe(0); // no-op second time
  });

  it('merchant without webhook URL: skipped -> set URL -> requeue -> pending', async () => {
    const store = freshStore();
    const m = merchant('0x' + 'ac'.repeat(20), { webhookUrl: '' });
    await store.upsertMerchant(m);
    const o = qiOrder(oid(), { merchantAddress: m.address });
    await store.insertQiOrder(o);
    await indexerFor(makeQi(store, { [o.address]: 10000n }), store).sweep();
    let d = (await store.getDelivery(qiPaymentId(o.orderId)))!;
    expect(d.status).toBe('skipped');
    expect((d.lastError ?? '').toLowerCase()).toContain('webhook url not configured');
    expect(d.merchantId).toBe(m.merchantId);

    const updated = { ...m, webhookUrl: 'https://example.test/hook' };
    await store.upsertMerchant(updated);
    expect(await store.requeueSkippedForMerchant(updated)).toBe(1);
    d = (await store.getDelivery(qiPaymentId(o.orderId)))!;
    expect(d.status).toBe('pending');
    expect(d.url).toBe('https://example.test/hook');
  });

  it('full pipeline: settlement -> enqueue -> signed dispatch -> delivered', async () => {
    const store = freshStore();
    const m = merchant('0x' + 'ad'.repeat(20));
    await store.upsertMerchant(m);
    const o = qiOrder(oid(), { merchantAddress: m.address });
    await store.insertQiOrder(o);
    const t0 = 1_750_000_000_000;
    await indexerFor(makeQi(store, { [o.address]: 10000n }), store, t0).sweep();
    const d = (await store.getDelivery(qiPaymentId(o.orderId)))!;
    expect(d.status).toBe('pending');

    let sent!: { body: string; headers: Record<string, string> };
    const dispatcher = new WebhookDispatcher(store, cfg, () => t0, async (opts) => {
      sent = { body: opts.body, headers: opts.headers as Record<string, string> };
      return { ok: true, status: 200, error: null };
    });
    await dispatcher.attempt(d);

    const body = JSON.parse(sent.body);
    expect(body.data.asset).toBe('qi');
    expect(body.data.token).toBe('qi');
    expect(body.data.qi.address).toBe(o.address);
    expect(body.data.qi.qits).toBe('10000');
    expect(body.data.amount).toBe('10000');
    expect(body.data.fee).toBe('0');
    expect(body.data.feeBps).toBe(0);
    expect(body.data.txHash).toBe(TX);
    expect(body.data.blockNumber).toBe(0);
    expect(sent.headers['x-paywithquai-delivery']).toBe(qiPaymentId(o.orderId));

    const tsSec = Math.floor(t0 / 1000);
    const expectedSig = signPayload(m.webhookSecret, sent.body, tsSec);
    expect(sent.headers[SIGNATURE_HEADER]).toBe(expectedSig);
    expect(verifySignature(m.webhookSecret, sent.headers[SIGNATURE_HEADER], sent.body, tsSec)).toBe(true);
    expect(verifySignature('whsec_wrong', sent.headers[SIGNATURE_HEADER], sent.body, tsSec)).toBe(false);

    expect((await store.getDelivery(qiPaymentId(o.orderId)))!.status).toBe('delivered');
  });

  it('does not downgrade or duplicate an already-delivered qi webhook', async () => {
    const store = freshStore();
    const m = merchant('0x' + 'ae'.repeat(20));
    await store.upsertMerchant(m);
    const o = qiOrder(oid(), { merchantAddress: m.address });
    await store.insertQiOrder(o);
    const pre: WebhookDelivery = {
      id: qiPaymentId(o.orderId), chainId: cfg.CHAIN_ID, merchantId: m.merchantId, url: m.webhookUrl,
      payload: { id: qiPaymentId(o.orderId), type: 'payment.confirmed', created: 1,
        data: { merchantId: m.merchantId, chainId: cfg.CHAIN_ID, merchant: m.address, orderId: o.orderId,
          payer: '', token: 'qi', amount: '10000', feeBps: 0, fee: '0', net: '10000',
          txHash: TX, blockNumber: 0, timestamp: 1, nonce: 0 } },
      status: 'delivered', attempts: 1, nextAttemptAt: 0, lastError: null, createdAt: 1, updatedAt: 1,
    };
    await store.insertDeliveryIfAbsent(pre);
    const qi = makeQi(store, { [o.address]: 1n });
    await indexerFor(qi, store).sweep();
    const kept = (await store.getDelivery(qiPaymentId(o.orderId)))!;
    expect(kept.status).toBe('delivered');
    expect(kept.attempts).toBe(1);
    expect(await store.listDeliveries(10)).toHaveLength(1);
  });

  it('merchant data isolation in reconciliation', async () => {
    const store = freshStore();
    const mA = merchant('0x' + 'af'.repeat(20));
    const mB = merchant('0x' + 'b0'.repeat(20));
    await Promise.all([
      store.upsertMerchant(mA),
      store.upsertMerchant(mB),
      store.insertQiOrder(qiOrder(oid(), { merchantAddress: mA.address, qits: '25000' })),
      store.insertQiOrder(qiOrder(oid(), { merchantAddress: mA.address, qits: '50000' })),
      store.insertQiOrder(qiOrder(oid(), { merchantAddress: mB.address, qits: '99999' })),
    ]);
    expect((await store.listQiOrdersByMerchant(mA.address)).map((x) => x.qits).sort()).toEqual(['25000', '50000']);
    expect((await store.listQiOrdersByMerchant(mB.address)).map((x) => x.qits)).toEqual(['99999']);
  });

  it('settled order with missing delivery is created on each sweep until it exists', async () => {
    const store = freshStore();
    const m = merchant('0x' + 'aa'.repeat(20));
    await store.upsertMerchant(m);
    const o = qiOrder(oid(), { merchantAddress: m.address });
    await store.insertQiOrder(o);
    // Mark settled but no delivery — simulating repeated crash.
    await store.markQiOrderSettled(o.orderId, '10000', [TX]);
    const qi = makeQi(store, {});
    // First sweep creates the delivery.
    await indexerFor(qi, store).sweep();
    expect(await store.getDelivery(qiPaymentId(o.orderId))).toBeDefined();
    const d1 = (await store.getDelivery(qiPaymentId(o.orderId)))!;
    // Second sweep does not touch it.
    await indexerFor(qi, store).sweep();
    const d2 = (await store.getDelivery(qiPaymentId(o.orderId)))!;
    expect(d2.status).toBe(d1.status);
    expect(d2.updatedAt).toBe(d1.updatedAt);
  });
});

describe('Qi HTTP lifecycle end-to-end', () => {
  const ADMIN_KEY = 'test-admin-key-0123456789abcdef';
  const CONTRACT = '0x0000000000000000000000000000000000000001';
  const wallet = new Wallet('0x' + randomBytes(32).toString('hex'));
  const jsonHeaders = { 'content-type': 'application/json' };

  const cfgE2E = {
    ADMIN_API_KEY: ADMIN_KEY, CORS_ORIGINS: '*', CHAIN_ID: 9,
    LOGIN_REALM: 'tripplepay', TRUST_PROXY: 0, PAYWITHQUAI_ADDRESS: CONTRACT,
    WEBHOOK_TIMEOUT_MS: 5000, WEBHOOK_MAX_ATTEMPTS: 10,
    WEBHOOK_BASE_BACKOFF_MS: 1000, WEBHOOK_MAX_BACKOFF_MS: 60_000,
  } as unknown as Config;

  async function req(base: string, path: string, init?: RequestInit) {
    const res = await fetch(base + path, init);
    const body = (await res.json().catch(() => undefined)) as Record<string, unknown>;
    return { status: res.status, body };
  }

  async function login(base: string): Promise<string> {
    const challenge = await req(base, '/v1/auth/challenge', {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ address: wallet.address }),
    });
    if (challenge.status !== 200 || !challenge.body.message) throw new Error('challenge failed');
    const res = await req(base, '/v1/auth/login', {
      method: 'POST', headers: jsonHeaders,
      body: JSON.stringify({ address: wallet.address, message: challenge.body.message, signature: await wallet.signMessage(challenge.body.message as string) }),
    });
    return res.body.token as string;
  }

  it('full link lifecycle: claim -> settle -> skipped -> configure URL -> pending -> reconcile', async () => {
    const store = freshStore();
    const qi = makeQi(store, {});
    const app = createServer(store, { address: CONTRACT } as unknown as QuaiClient, cfgE2E, qi);
    const server = app.listen(0);
    servers.push(server);
    await new Promise<void>((r) => server.once('listening', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // Onboard WITHOUT webhook URL.
    const onboard = await req(base, '/v1/merchants', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_KEY}`, ...jsonHeaders },
      body: JSON.stringify({ address: wallet.address, name: 'Acme' }),
    });
    expect(onboard.status).toBe(201);

    const slug = 'abc12345';
    const orderId = '0x' + '44'.repeat(32);
    await store.upsertLink({
      slug, chainId: cfg.CHAIN_ID, merchantAddress: wallet.address.toLowerCase(),
      merchantId: (await store.getMerchantByAddress(wallet.address.toLowerCase()))!.merchantId,
      merchantName: 'Acme', shopName: 'Test',
      tokenAddress: '0x0000000000000000000000000000000000000000',
      amount: '120000000000000000000', amountDisplay: '120.0', symbol: 'QUAI',
      expiryDurationSecs: 0, multiPay: true, orderPool: [orderId], createdAt: 1,
    });

    // Customer requests Qi address.
    const claim = await req(base, '/v1/links/' + slug + '/qi-claim', { method: 'POST' });
    expect(claim.status).toBe(200);
    expect(claim.body.orderId).toBe(orderId);
    const recvAddr = (claim.body.qi as Record<string, string>).address;

    // Fund the order.
    qi.checkBalance.mockImplementationOnce(async (addr: string) =>
      addr === recvAddr ? { receivedQits: 120000n, txHashes: [TX] } : { receivedQits: 0n, txHashes: [] },
    );
    await indexerFor(qi, store).sweep();

    // Verify skipped (no webhook URL).
    const d0 = (await store.getDelivery(qiPaymentId(orderId)))!;
    expect(d0.status).toBe('skipped');

    // Merchant configures webhook via PATCH.
    const token = await login(base);
    const patch = await req(base, '/v1/me', {
      method: 'PATCH', headers: { authorization: `Bearer ${token}`, ...jsonHeaders },
      body: JSON.stringify({ webhookUrl: 'https://example.test/hook' }),
    });
    expect(patch.status).toBe(200);
    const d1 = (await store.getDelivery(qiPaymentId(orderId)))!;
    expect(d1.status).toBe('pending');
    expect(d1.url).toBe('https://example.test/hook');

    // Reconcile via Qi dashboard endpoint.
    const recon = await req(base, '/v1/me/qi', { headers: { authorization: `Bearer ${token}` } });
    expect(recon.status).toBe(200);
    const orders = recon.body.orders as Array<Record<string, unknown>>;
    expect(orders).toHaveLength(1);
    expect(orders[0]!.settled).toBe(true);
    expect(orders[0]!.qits).toBe('120000');
    expect(orders[0]!.meta).toEqual({ source: 'link', slug, shopName: 'Test', reference: null });
    expect((orders[0]!.webhook as Record<string, unknown>).status).toBe('pending');
    expect(recon.body.summary).toEqual({
      total: 1, settled: 1, pending: 0, qitsRequired: '120000', qitsReceived: '120000',
    });

    // Delivery shows up in /v1/me/deliveries too.
    const delivs = await req(base, '/v1/me/deliveries', { headers: { authorization: `Bearer ${token}` } });
    expect(delivs.status).toBe(200);
    const qiDelivs = (delivs.body.deliveries as Array<Record<string, unknown>>).filter(
      (d) => (d.payload as Record<string, unknown>)?.data &&
             ((d.payload as Record<string, unknown>).data as Record<string, unknown>)?.asset === 'qi',
    );
    expect(qiDelivs).toHaveLength(1);
  });
});
