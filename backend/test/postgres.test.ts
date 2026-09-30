import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Merchant, WebhookDelivery, PaymentLink, LinkClaim } from '../src/types.js';
import { PostgresStore } from '../src/store/postgres.js';

/**
 * Behavioral parity suite for {@link PostgresStore} — the same scenarios the JsonStore suite
 * covers, plus concurrency-sensitive ones (CAS, pool claim) that motivated the switch.
 *
 * Skipped unless TEST_DATABASE_URL is set. Run locally with, e.g.:
 *   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/relayer_test npm test
 */
const url = process.env.TEST_DATABASE_URL;
const describePg = url ? describe : describe.skip;

const merchant = (over: Partial<Merchant> = {}): Merchant => ({
  merchantId: 'mch_1',
  address: '0x00000000000000000000000000000000000000a1',
  name: 'Acme',
  webhookUrl: 'https://example.test/webhook',
  webhookSecret: 'whsec_x',
  active: true,
  createdAt: 1,
  ...over,
});

const delivery = (id: string, over: Partial<WebhookDelivery> = {}): WebhookDelivery => ({
  id,
  chainId: 9,
  merchantId: 'mch_1',
  url: 'https://example.test/webhook',
  payload: {
    id,
    type: 'payment.confirmed',
    created: 1,
    data: {
      merchantId: 'mch_1',
      chainId: 9,
      merchant: '0x00000000000000000000000000000000000000A1',
      orderId: '0x' + '11'.repeat(32),
      payer: '0x00000000000000000000000000000000000000B2',
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
});

const link = (over: Partial<PaymentLink> = {}): PaymentLink => ({
  slug: 'abc12345',
  chainId: 9,
  merchantAddress: merchant().address,
  merchantId: 'mch_1',
  merchantName: 'Acme',
  shopName: 'Acme Shop',
  tokenAddress: '0x0000000000000000000000000000000000000000',
  amount: '25000000',
  amountDisplay: '25.0',
  symbol: 'QUAI',
  expiryDurationSecs: 0,
  multiPay: true,
  orderPool: ['0x' + '11'.repeat(32), '0x' + '22'.repeat(32)],
  createdAt: 1,
  ...over,
});

describePg('PostgresStore', () => {
  let store: PostgresStore;

  beforeAll(async () => {
    store = new PostgresStore(url!, { ssl: false });
    await store.init();
  });

  beforeEach(async () => {
    // Unlike the JsonStore suite (fresh temp file per test), tests here share one database —
    // truncate so no test can collide with fixtures left behind by a previous test.
    await store.pool.query(
      `TRUNCATE cursors, merchants, deliveries, sessions, nonces, links, claims CASCADE`,
    );
  });

  afterAll(async () => {
    await store.close();
  });

  it('persists and reads back the cursor, scoped per chain/contract', async () => {
    await store.setCursor('1:0xabc', 100);
    await store.setCursor('2:0xabc', 200);
    await store.setCursor('1:0xabc2', 999);
    expect(await store.getCursor('1:0xabc')).toBe(100);
    expect(await store.getCursor('1:0xabc2')).toBe(999);
    expect(await store.getCursor('2:0xabc')).toBe(200);
    expect(await store.getCursor('9:0xzzz')).toBeUndefined();
  });

  it('looks up merchants by address (case-insensitive) and by id', async () => {
    await store.upsertMerchant(merchant());
    expect((await store.getMerchantByAddress('0x00000000000000000000000000000000000000A1'))?.merchantId).toBe('mch_1');
    expect((await store.getMerchantById('mch_1'))?.name).toBe('Acme');
    expect((await store.listMerchants()).length).toBeGreaterThanOrEqual(1);
  });

  it('inserts a delivery once and refuses duplicates (idempotency)', async () => {
    const d = delivery('0xabc:0');
    expect(await store.insertDeliveryIfAbsent(d)).toBe(true);
    expect(await store.insertDeliveryIfAbsent(d)).toBe(false);
    expect(await store.listDeliveries(10)).toHaveLength(1);
  });

  it('looks up a delivery by (merchant, orderId) case-insensitively', async () => {
    await store.insertDeliveryIfAbsent(delivery('0xabc:1'));
    const found = await store.getDeliveryByOrder(
      '0x00000000000000000000000000000000000000a1',
      '0X' + '11'.repeat(32),
    );
    expect(found?.id).toBe('0xabc:1');
    expect(await store.getDeliveryByOrder('0x00000000000000000000000000000000000000a1', '0x' + '22'.repeat(32))).toBeUndefined();
  });

  it('re-queues skipped deliveries when the merchant is onboarded', async () => {
    const d = delivery('0xabc:2');
    const placeholder = 'unregistered:0x00000000000000000000000000000000000000a1';
    const skipped: WebhookDelivery = {
      ...d,
      merchantId: placeholder,
      url: '',
      status: 'skipped',
      lastError: 'no merchant registered for payout address',
      payload: { ...d.payload, data: { ...d.payload.data, merchantId: placeholder } },
    };
    await store.insertDeliveryIfAbsent(skipped);
    await store.insertDeliveryIfAbsent({
      ...delivery('0xdef:1'),
      merchantId: 'unregistered:0x999',
      status: 'skipped',
      payload: {
        ...delivery('0xdef:1').payload,
        data: { ...delivery('0xdef:1').payload.data, merchant: '0x9999999999999999999999999999999999999999' },
      },
    });

    const count = await store.requeueSkippedForMerchant(merchant());
    expect(count).toBe(1);
    const requeued = (await store.getDelivery('0xabc:2'))!;
    expect(requeued.status).toBe('pending');
    expect(requeued.merchantId).toBe('mch_1');
    expect(requeued.payload.data.merchantId).toBe('mch_1');
    expect(requeued.url).toBe('https://example.test/webhook');
    expect(requeued.lastError).toBeNull();
    expect((await store.getDelivery('0xdef:1'))!.status).toBe('skipped');
  });

  it('returns only due, pending deliveries', async () => {
    await store.insertDeliveryIfAbsent({ ...delivery('a'), nextAttemptAt: 100 });
    await store.insertDeliveryIfAbsent({ ...delivery('b'), nextAttemptAt: 5000 });
    await store.insertDeliveryIfAbsent({ ...delivery('c'), status: 'delivered', nextAttemptAt: 0 });
    const due = await store.getDueDeliveries(1000, 10);
    expect(due.map((d) => d.id)).toEqual(['a']);
  });

  it('stores nonces single-use: consumed once, then gone (login replay protection)', async () => {
    await store.createNonce('nonce-1', '0xabc', Date.now() + 60_000);
    expect(await store.consumeNonce('nonce-1')).toBe('0xabc');
    expect(await store.consumeNonce('nonce-1')).toBeUndefined();
    await store.createNonce('nonce-expired', '0xabc', Date.now() - 1000);
    expect(await store.consumeNonce('nonce-expired')).toBeUndefined();
  });

  it('CAS delivery write applies only when the record still matches the snapshot', async () => {
    await store.insertDeliveryIfAbsent(delivery('0xabc:cas'));
    const snapshot = (await store.getDelivery('0xabc:cas'))!;

    const applied = await store.updateDeliveryIfCurrent(
      { ...snapshot, status: 'delivered', attempts: 1, updatedAt: 2 },
      { attempts: snapshot.attempts, status: snapshot.status, nextAttemptAt: snapshot.nextAttemptAt, updatedAt: snapshot.updatedAt },
    );
    expect(applied).toBe(true);
    expect((await store.getDelivery('0xabc:cas'))!.status).toBe('delivered');

    await store.updateDelivery({ ...(await store.getDelivery('0xabc:cas'))!, attempts: 0, status: 'pending', updatedAt: 99 });
    const rejected = await store.updateDeliveryIfCurrent(
      { ...(await store.getDelivery('0xabc:cas'))!, status: 'delivered', attempts: 1, updatedAt: 100 },
      { attempts: snapshot.attempts, status: snapshot.status, nextAttemptAt: snapshot.nextAttemptAt, updatedAt: snapshot.updatedAt },
    );
    expect(rejected).toBe(false);
  });

  it('caps sessions per merchant at 20, evicting oldest (JsonStore parity)', { timeout: 30_000 }, async () => {
    for (let i = 0; i < 22; i++) {
      await store.createSession({
        token: `tok-${i}`,
        merchantId: 'mch_cap',
        address: '0x00000000000000000000000000000000000000a1',
        createdAt: i,
        expiresAt: Date.now() + 60_000,
      });
    }
    expect(await store.getSession('tok-0')).toBeUndefined(); // oldest evicted
    expect(await store.getSession('tok-1')).toBeUndefined();
    expect(await store.getSession('tok-21')).toBeDefined(); // newest kept
  });

  it('lazily expires sessions and deletes them on logout', async () => {
    await store.createSession({
      token: 'tok-expired',
      merchantId: 'mch_1',
      address: '0x00000000000000000000000000000000000000a1',
      createdAt: 1,
      expiresAt: Date.now() - 1,
    });
    expect(await store.getSession('tok-expired')).toBeUndefined();
    await store.createSession({
      token: 'tok-live',
      merchantId: 'mch_1',
      address: '0x00000000000000000000000000000000000000a1',
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
    });
    await store.deleteSession('tok-live');
    expect(await store.getSession('tok-live')).toBeUndefined();
  });

  it('claims orderIds from a multi-pay pool atomically and tracks settlement', async () => {
    await store.upsertLink(link());
    const first = await store.claimOrderFromPool('abc12345', '0x00000000000000000000000000000000000000b2');
    expect(first).toBe('0x' + '11'.repeat(32));
    const second = await store.claimOrderFromPool('abc12345', '0x00000000000000000000000000000000000000c3');
    expect(second).toBe('0x' + '22'.repeat(32));
    expect(await store.claimOrderFromPool('abc12345', '0x00000000000000000000000000000000000000d4')).toBeUndefined();

    const claim: LinkClaim = {
      slug: 'abc12345',
      orderId: first!,
      payerAddress: '0x00000000000000000000000000000000000000b2',
      claimedAt: Date.now(),
      settled: false,
    };
    await store.upsertClaim(claim);
    await store.settleClaimedOrder('abc12345', first!);
    const latest = await store.getLatestClaim('abc12345', '0x00000000000000000000000000000000000000B2');
    expect(latest?.orderId).toBe(first);
    expect(latest?.settled).toBe(true);
  });

  it('survives a reconnect to the same database (reload semantics)', async () => {
    await store.upsertMerchant(merchant({ address: '0x00000000000000000000000000000000000000e1' }));
    await store.insertDeliveryIfAbsent(delivery('x:0'));

    const s2 = new PostgresStore(url!, { ssl: false });
    await s2.init();
    expect(await s2.getMerchantByAddress('0x00000000000000000000000000000000000000E1')).toBeDefined();
    expect((await s2.getDelivery('x:0'))?.status).toBe('pending');
    expect(
      (await s2.getDeliveryByOrder('0x00000000000000000000000000000000000000a1', '0x' + '11'.repeat(32)))?.id,
    ).toBe('x:0');
    await s2.close();
  });
});