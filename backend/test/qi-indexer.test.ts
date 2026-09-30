import { describe, it, expect, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdtempSync } from 'node:fs';
import { JsonStore } from '../src/store/json.js';
import { QiIndexer, qiPaymentId } from '../src/indexer/qi-indexer.js';
import type { QiService } from '../src/chain/qi.js';
import type { QiOrder, Merchant } from '../src/types.js';
import type { Config } from '../src/config.js';

const dirs: string[] = [];
function freshStore(): JsonStore {
  const dir = mkdtempSync(join(tmpdir(), 'pwq-qi-'));
  dirs.push(dir);
  return new JsonStore(join(dir, 'relayer.db'));
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const MERCHANT = '0x00000000000000000000000000000000000000a1';
const ORDER_ID = '0x' + '11'.repeat(32);
const ADDRESS = '0x' + 'aa'.repeat(20);
const TX = '0x' + 'bb'.repeat(32);

const cfg = { QI_POLL_INTERVAL_MS: 8000 } as unknown as Config;

const merchant = (over: Partial<Merchant> = {}): Merchant => ({
  merchantId: 'mch_1',
  address: MERCHANT,
  name: 'Acme',
  webhookUrl: 'https://example.test/webhook',
  webhookSecret: 'whsec_x',
  active: true,
  createdAt: 1,
  ...over,
});

const qiOrder = (over: Partial<QiOrder> = {}): QiOrder => ({
  orderId: ORDER_ID,
  merchantAddress: MERCHANT,
  address: ADDRESS,
  qits: '25000',
  receivedQits: '0',
  settled: false,
  txHashes: [],
  createdAt: 1,
  settledAt: null,
  ...over,
});

function fakeQi(receivedQits: bigint): QiService {
  return {
    enabled: true,
    rpcUrl: 'https://rpc.test',
    checkBalance: vi.fn(async () => ({ receivedQits, txHashes: [TX] })),
  } as unknown as QiService;
}

describe('QiIndexer', () => {
  it('settles an order once the receive address holds enough qits', async () => {
    const store = freshStore();
    await store.insertQiOrder(qiOrder());
    const qi = fakeQi(25_000n);
    const indexer = new QiIndexer(qi, store, cfg, cfg.CHAIN_ID, () => 1_700_000_000_000);
    await indexer.sweep();
    const rec = (await store.getQiOrder(ORDER_ID))!;
    expect(rec.settled).toBe(true);
    expect(rec.receivedQits).toBe('25000');
    expect(rec.txHashes).toEqual([TX]);
    expect(typeof rec.settledAt).toBe('number'); // store stamps real wall-clock time, not the injected clock
  });

  it('does not settle an order below the required qits', async () => {
    const store = freshStore();
    await store.insertQiOrder(qiOrder());
    const indexer = new QiIndexer(fakeQi(24_999n), store, cfg);
    await indexer.sweep();
    expect((await store.getQiOrder(ORDER_ID))!.settled).toBe(false);
  });

  it('enqueues exactly one pending delivery for a settled order of a registered merchant', async () => {
    const store = freshStore();
    await store.upsertMerchant(merchant());
    await store.insertQiOrder(qiOrder());
    const indexer = new QiIndexer(fakeQi(25_000n), store, cfg, cfg.CHAIN_ID, () => 1_700_000_000_000);
    await indexer.sweep();

    const d = (await store.getDelivery(qiPaymentId(ORDER_ID)))!;
    expect(d).toBeDefined();
    expect(d.status).toBe('pending');
    expect(d.url).toBe('https://example.test/webhook');
    expect(d.merchantId).toBe('mch_1');
    expect(d.payload.data.asset).toBe('qi');
    expect(d.payload.data.token).toBe('qi');
    expect(d.payload.data.orderId).toBe(ORDER_ID);
    expect(d.payload.data.amount).toBe('25000');
    expect(d.payload.data.net).toBe('25000');
    expect(d.payload.data.fee).toBe('0');
    expect(d.payload.data.feeBps).toBe(0);
    expect(d.payload.data.txHash).toBe(TX);
    expect(d.payload.data.qi).toEqual({
      address: ADDRESS,
      qits: '25000',
      receivedQits: '25000',
      txHashes: [TX],
    });

    // Order is settled now — a second sweep must not double-enqueue.
    await indexer.sweep();
    expect(await store.listDeliveries(10)).toHaveLength(1);
  });

  it('records Qi payments to unregistered merchants as skipped', async () => {
    const store = freshStore();
    await store.insertQiOrder(qiOrder());
    const indexer = new QiIndexer(fakeQi(25_000n), store, cfg);
    await indexer.sweep();
    const d = (await store.getDelivery(qiPaymentId(ORDER_ID)))!;
    expect(d.status).toBe('skipped');
    expect(d.merchantId).toBe('unregistered:' + MERCHANT);
    expect(d.url).toBe('');
  });

  it('holds the delivery as skipped when the merchant has no webhook URL yet', async () => {
    const store = freshStore();
    await store.upsertMerchant(merchant({ webhookUrl: '' }));
    await store.insertQiOrder(qiOrder());
    const indexer = new QiIndexer(fakeQi(25_000n), store, cfg);
    await indexer.sweep();
    const d = (await store.getDelivery(qiPaymentId(ORDER_ID)))!;
    expect(d.status).toBe('skipped');
    expect((d.lastError ?? '').toLowerCase()).toContain('webhook url not configured');
  });

  it('marks the link claim settled after a Qi payment on a payment-link order', async () => {
    const store = freshStore();
    await store.upsertMerchant(merchant());
    await store.insertQiOrder(qiOrder());
    // What the qi-claim route persists at reservation time: an orderMeta pointing at the slug
    // plus an unsettled link claim bound to the sentinel payer 'qi'.
    await store.saveOrderMeta({
      orderId: ORDER_ID,
      chainId: cfg.CHAIN_ID,
      merchantAddress: MERCHANT,
      source: 'link',
      slug: 'abc12345',
      createdAt: 1,
    });
    await store.upsertClaim({
      slug: 'abc12345',
      orderId: ORDER_ID,
      payerAddress: 'qi',
      claimedAt: 1,
      settled: false,
    });

    const indexer = new QiIndexer(fakeQi(25_000n), store, cfg);
    await indexer.sweep();

    const q = await store.getQiOrder(ORDER_ID);
    expect(q!.settled).toBe(true);
    const claim = (await store.getLatestClaim('abc12345', 'qi'))!;
    expect(claim.settled).toBe(true);
    // And the webhook still lands.
    expect(await store.getDelivery(qiPaymentId(ORDER_ID))).toBeDefined();
  });
});