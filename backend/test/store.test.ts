import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { rmSync, mkdtempSync, writeFileSync, statSync } from 'node:fs';
import { JsonStore } from '../src/store/json.js';
import type { Merchant, WebhookDelivery } from '../src/types.js';

const dirs: string[] = [];
function freshStore(): JsonStore {
  const dir = mkdtempSync(join(tmpdir(), 'pwq-store-'));
  dirs.push(dir);
  return new JsonStore(join(dir, 'relayer.db'));
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

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

const delivery = (id: string): WebhookDelivery => ({
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
});

describe('JsonStore', () => {
  it('persists and reads back the cursor', async () => {
    const s = freshStore();
    expect(await s.getCursor('scope')).toBeUndefined();
    s.setCursor('scope', 1234);
    expect(await s.getCursor('scope')).toBe(1234);
  });

  it('keeps cursors scoped independently (chain/contract isolation)', async () => {
    const s = freshStore();
    s.setCursor('1:0xabc', 100);
    s.setCursor('1:0xabc2', 999); // same chain, different contract
    s.setCursor('2:0xabc', 200); // same contract, different chain
    expect(await s.getCursor('1:0xabc')).toBe(100);
    expect(await s.getCursor('1:0xabc2')).toBe(999);
    expect(await s.getCursor('2:0xabc')).toBe(200);
  });

  it('migrates a legacy un-scoped cursor file and ignores it for fresh scopes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pwq-store-'));
    dirs.push(dir);
    const path = join(dir, 'relayer.db');
    writeFileSync(path, JSON.stringify({ cursor: 77, merchants: {}, deliveries: {} }));
    const s = new JsonStore(path);
    expect(await s.getCursor('legacy')).toBe(77); // preserved, but...
    expect(await s.getCursor('9:0x00a1')).toBeUndefined(); // ...the current scope starts fresh
  });

  it('looks up merchants by address (case-insensitive) and by id', async () => {
    const s = freshStore();
    s.upsertMerchant(merchant());
    expect((await s.getMerchantByAddress('0x00000000000000000000000000000000000000A1'))?.merchantId).toBe('mch_1');
    expect((await s.getMerchantById('mch_1'))?.name).toBe('Acme');
  });

  it('inserts a delivery once and refuses duplicates (idempotency)', async () => {
    const s = freshStore();
    const d = delivery('0xabc:0');
    expect(await s.insertDeliveryIfAbsent(d)).toBe(true);
    expect(await s.insertDeliveryIfAbsent(d)).toBe(false);
    expect(await s.listDeliveries(10)).toHaveLength(1);
  });

  it('looks up a delivery by (merchant, orderId) case-insensitively', async () => {
    const s = freshStore();
    s.insertDeliveryIfAbsent(delivery('0xabc:0'));
    const found = await s.getDeliveryByOrder(
      '0x00000000000000000000000000000000000000a1', // lowercase merchant
      '0X' + '11'.repeat(32), // uppercase orderId
    );
    expect(found?.id).toBe('0xabc:0');
    expect(await s.getDeliveryByOrder('0x00000000000000000000000000000000000000a1', '0x' + '22'.repeat(32))).toBeUndefined();
  });

  it('re-queues skipped deliveries when the merchant is onboarded', async () => {
    const s = freshStore();
    const d = delivery('0xabc:0');
    const placeholder = 'unregistered:0x00000000000000000000000000000000000000a1';
    const skipped: WebhookDelivery = {
      ...d,
      merchantId: placeholder,
      url: '',
      status: 'skipped',
      attempts: 0,
      lastError: 'no merchant registered for payout address',
      // Mirror what the indexer actually persists: the nested payload id is the placeholder too,
      // not the final merchantId. Requeue must rewrite it (regression guard).
      payload: { ...d.payload, data: { ...d.payload.data, merchantId: placeholder } },
    };
    s.insertDeliveryIfAbsent(skipped);
    // An unrelated skipped delivery (different payout address) must not be touched.
    s.insertDeliveryIfAbsent({
      ...delivery('0xdef:1'),
      merchantId: 'unregistered:0x999',
      status: 'skipped',
      payload: {
        ...delivery('0xdef:1').payload,
        data: { ...delivery('0xdef:1').payload.data, merchant: '0x9999999999999999999999999999999999999999' },
      },
    });

    const count = await s.requeueSkippedForMerchant(merchant());
    expect(count).toBe(1);
    const requeued = (await s.getDelivery('0xabc:0'))!;
    expect(requeued.status).toBe('pending');
    expect(requeued.merchantId).toBe('mch_1');
    expect(requeued.payload.data.merchantId).toBe('mch_1'); // nested id rebuilt, not left stale
    expect(requeued.url).toBe('https://example.test/webhook');
    expect(requeued.lastError).toBeNull();
    expect((await s.getDelivery('0xdef:1'))!.status).toBe('skipped');
  });

  it('returns only due, pending deliveries', async () => {
    const s = freshStore();
    s.insertDeliveryIfAbsent({ ...delivery('a'), nextAttemptAt: 100 });
    s.insertDeliveryIfAbsent({ ...delivery('b'), nextAttemptAt: 5000 });
    s.insertDeliveryIfAbsent({ ...delivery('c'), status: 'delivered', nextAttemptAt: 0 });
    const due = await s.getDueDeliveries(1000, 10);
    expect(due.map((d) => d.id)).toEqual(['a']);
  });

  it('stores nonces single-use: consumed once, then gone (login replay protection)', async () => {
    const s = freshStore();
    s.createNonce('nonce-1', '0xabc', Date.now() + 60_000);
    expect(await s.consumeNonce('nonce-1')).toBe('0xabc');
    expect(await s.consumeNonce('nonce-1')).toBeUndefined(); // second use refused
  });

  it('refuses to consume an expired nonce (swept from storage)', async () => {
    const s = freshStore();
    s.createNonce('nonce-1', '0xabc', Date.now() - 1000);
    expect(await s.consumeNonce('nonce-1')).toBeUndefined();
    expect(await s.consumeNonce('nonce-1')).toBeUndefined();
  });

  it('CAS delivery write applies only when the record still matches the snapshot', async () => {
    const s = freshStore();
    s.insertDeliveryIfAbsent(delivery('0xabc:0'));
    const snapshot = (await s.getDelivery('0xabc:0'))!;

    // No concurrent mutation: the guarded write lands.
    const applied = await s.updateDeliveryIfCurrent(
      { ...snapshot, status: 'delivered', attempts: 1, updatedAt: 2 },
      { attempts: snapshot.attempts, status: snapshot.status, nextAttemptAt: snapshot.nextAttemptAt, updatedAt: snapshot.updatedAt },
    );
    expect(applied).toBe(true);
    expect((await s.getDelivery('0xabc:0'))!.status).toBe('delivered');

    // Now simulate a concurrent retry: the record changed (updatedAt bumped, attempts reset) while
    // a stale in-flight attempt still holds its old snapshot — the guarded write must be refused.
    await s.updateDelivery({ ...(await s.getDelivery('0xabc:0'))!, attempts: 0, status: 'pending', updatedAt: 99 });
    const stale = (await s.getDelivery('0xabc:0'))!;
    const rejected = await s.updateDeliveryIfCurrent(
      { ...stale, status: 'delivered', attempts: 1, updatedAt: 100 },
      { attempts: snapshot.attempts, status: snapshot.status, nextAttemptAt: snapshot.nextAttemptAt, updatedAt: snapshot.updatedAt },
    );
    expect(rejected).toBe(false);
    expect((await s.getDelivery('0xabc:0'))!.status).toBe('pending');
    expect((await s.getDelivery('0xabc:0'))!.attempts).toBe(0);
  });

  it('writes the store owner-only (0600) in a dir with no group/other access', async () => {
    if (process.platform === 'win32') return; // POSIX permission bits only
    const dir = mkdtempSync(join(tmpdir(), 'pwq-store-'));
    dirs.push(dir);
    const path = join(dir, 'nested', 'relayer.db'); // also exercises recursive mkdir
    const s = new JsonStore(path);
    s.setCursor('9:0x00a1', 1); // triggers a flush -> file created + chmod
    expect(statSync(path).mode & 0o777).toBe(0o600); // secrets file: owner rw only
    expect(statSync(dirname(path)).mode & 0o077).toBe(0); // dir: no group/other bits
  });

  it('survives a reload from disk', async () => {    const dir = mkdtempSync(join(tmpdir(), 'pwq-store-'));
    dirs.push(dir);
    const path = join(dir, 'relayer.db');
    const s1 = new JsonStore(path);
    s1.setCursor('9:0x00a1', 77);
    s1.upsertMerchant(merchant());
    s1.insertDeliveryIfAbsent(delivery('x:0'));
    await s1.close();

    const s2 = new JsonStore(path);
    expect(await s2.getCursor('9:0x00a1')).toBe(77);
    expect((await s2.getMerchantById('mch_1'))?.name).toBe('Acme');
    expect((await s2.getDelivery('x:0'))?.status).toBe('pending');
    // the (merchant, orderId) index is rebuilt from disk too
    expect((await s2.getDeliveryByOrder('0x00000000000000000000000000000000000000a1', '0x' + '11'.repeat(32)))?.id).toBe('x:0');
  });
});
