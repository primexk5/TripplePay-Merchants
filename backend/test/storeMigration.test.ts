import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { JsonStore } from '../src/store/json.js';
import { PostgresStore } from '../src/store/postgres.js';
import type { PaymentLink } from '../src/types.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const DEFAULT_CHAIN_ID = 9;

function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pwq-migrate-'));
  dirs.push(dir);
  return join(dir, 'relayer.db');
}

const emptyShape = { cursors: {}, merchants: {}, deliveries: {}, sessions: {}, nonces: {}, claims: {}, qiOrders: {} };

describe('JsonStore — multi-chain migration (existing data must survive unchanged)', () => {
  it('reads a pre-existing link with no chainId back as the default chain', async () => {
    const path = tmpPath();
    // Shaped exactly like a file written before chainId existed — no `chainId` key at all.
    const legacyLink = {
      slug: 'abc12345',
      merchantAddress: '0x00000000000000000000000000000000000000a1',
      merchantId: 'mch_1',
      merchantName: 'Acme',
      shopName: '',
      tokenAddress: '0x0000000000000000000000000000000000000000',
      amount: '25000000',
      amountDisplay: '25.0',
      symbol: 'QUAI',
      expiryDurationSecs: 0,
      multiPay: false,
      orderPool: [],
      createdAt: 1,
    };
    writeFileSync(path, JSON.stringify({ ...emptyShape, links: { abc12345: legacyLink }, orderMeta: {} }));

    const store = new JsonStore(path, DEFAULT_CHAIN_ID);
    const link = await store.getLink('abc12345');
    expect(link?.chainId).toBe(DEFAULT_CHAIN_ID);
    // Every other field survives untouched.
    expect(link).toMatchObject({
      slug: 'abc12345',
      merchantAddress: legacyLink.merchantAddress,
      amount: '25000000',
      createdAt: 1,
    });
  });

  it('listLinksForMerchant also backfills chainId for every returned record', async () => {
    const path = tmpPath();
    const legacyLink = {
      slug: 'def45678',
      merchantAddress: '0x00000000000000000000000000000000000000a1',
      merchantId: 'mch_1',
      merchantName: 'Acme',
      shopName: '',
      tokenAddress: '0x0000000000000000000000000000000000000000',
      amount: '1',
      amountDisplay: '1',
      symbol: 'QUAI',
      expiryDurationSecs: 0,
      multiPay: false,
      orderPool: [],
      createdAt: 1,
    };
    writeFileSync(path, JSON.stringify({ ...emptyShape, links: { def45678: legacyLink }, orderMeta: {} }));
    const store = new JsonStore(path, DEFAULT_CHAIN_ID);
    const links = await store.listLinksForMerchant(legacyLink.merchantId);
    expect(links).toHaveLength(1);
    expect(links[0]?.chainId).toBe(DEFAULT_CHAIN_ID);
  });

  it('a genuinely-present chainId always wins over the default', async () => {
    const path = tmpPath();
    const link: PaymentLink = {
      slug: 'xyz98765',
      chainId: 46630,
      merchantAddress: '0x00000000000000000000000000000000000000a1',
      merchantId: 'mch_1',
      merchantName: 'Acme',
      shopName: '',
      tokenAddress: '0x0000000000000000000000000000000000000000',
      amount: '1',
      amountDisplay: '1',
      symbol: 'ETH',
      expiryDurationSecs: 0,
      multiPay: false,
      orderPool: [],
      createdAt: 1,
    };
    writeFileSync(path, JSON.stringify({ ...emptyShape, links: { xyz98765: link }, orderMeta: {} }));
    const store = new JsonStore(path, DEFAULT_CHAIN_ID);
    const got = await store.getLink('xyz98765');
    expect(got?.chainId).toBe(46630); // NOT the default (9)
  });

  it('reads a pre-existing order-meta record with no chainId back as the default chain', async () => {
    const path = tmpPath();
    const orderId = '0x' + '11'.repeat(32);
    const legacyMeta = {
      orderId,
      merchantAddress: '0x00000000000000000000000000000000000000a1',
      source: 'checkout',
      createdAt: 1,
    };
    writeFileSync(path, JSON.stringify({ ...emptyShape, links: {}, orderMeta: { [orderId]: legacyMeta } }));
    const store = new JsonStore(path, DEFAULT_CHAIN_ID);
    const meta = await store.getOrderMeta(orderId);
    expect(meta?.chainId).toBe(DEFAULT_CHAIN_ID);
  });

  it('defaults to chainId 9 when constructed with no explicit default (every pre-Phase-3a call site)', async () => {
    const path = tmpPath();
    const legacyLink = {
      slug: 's1',
      merchantAddress: '0x00000000000000000000000000000000000000a1',
      merchantId: 'mch_1',
      merchantName: 'A',
      shopName: '',
      tokenAddress: '0x0000000000000000000000000000000000000000',
      amount: '1',
      amountDisplay: '1',
      symbol: 'X',
      expiryDurationSecs: 0,
      multiPay: false,
      orderPool: [],
      createdAt: 1,
    };
    writeFileSync(path, JSON.stringify({ ...emptyShape, links: { s1: legacyLink }, orderMeta: {} }));
    const store = new JsonStore(path); // no 2nd arg — mirrors every existing `new JsonStore(path)` call
    const link = await store.getLink('s1');
    expect(link?.chainId).toBe(9);
  });

  it('does not mutate any other field of a migrated record on disk (round-trips untouched)', async () => {
    const path = tmpPath();
    const legacyLink = {
      slug: 'g1',
      merchantAddress: '0x00000000000000000000000000000000000000a1',
      merchantId: 'mch_1',
      merchantName: 'Acme',
      shopName: 'Corner Store',
      tokenAddress: '0x0049f7cbca3556c2dfae62aafa7015f99de1b8f5',
      amount: '5000000',
      amountDisplay: '5.0',
      symbol: 'USDT',
      expiryDurationSecs: 3600,
      multiPay: true,
      orderPool: ['0x' + '22'.repeat(32)],
      createdAt: 12345,
    };
    writeFileSync(path, JSON.stringify({ ...emptyShape, links: { g1: legacyLink }, orderMeta: {} }));
    const store = new JsonStore(path, DEFAULT_CHAIN_ID);
    const link = await store.getLink('g1');
    expect(link).toEqual({ ...legacyLink, chainId: DEFAULT_CHAIN_ID });
  });
});

const url = process.env.TEST_DATABASE_URL;
const describePg = url ? describe : describe.skip;

describePg('PostgresStore — multi-chain migration', () => {
  it('reads a pre-existing link/order_meta row with NULL chain_id back as the default chain', async () => {
    const store = new PostgresStore(url!, { ssl: false }, 46630);
    await store.init(); // idempotent — safe even if another test file already ran it
    await store.pool.query('DELETE FROM links WHERE slug = $1', ['migrate01']);
    await store.pool.query('DELETE FROM order_meta WHERE order_id = $1', ['0x' + 'aa'.repeat(32)]);
    try {
      // Insert a row the way it would have looked BEFORE chain_id existed: explicit NULL.
      await store.pool.query(
        `INSERT INTO links (slug, merchant_address, merchant_id, merchant_name, shop_name, token_address,
                            amount, amount_display, symbol, expiry_duration_secs, multi_pay, order_pool, created_at, chain_id)
         VALUES ($1, $2, 'mch_1', 'Acme', '', '0x0000000000000000000000000000000000000000', '1', '1', 'X', 0, false, '[]', 1, NULL)`,
        ['migrate01', '0x00000000000000000000000000000000000000a1'],
      );
      const link = await store.getLink('migrate01');
      expect(link?.chainId).toBe(46630);

      await store.pool.query(
        `INSERT INTO order_meta (order_id, merchant_address, source, created_at, chain_id)
         VALUES ($1, $2, 'checkout', 1, NULL)`,
        ['0x' + 'aa'.repeat(32), '0x00000000000000000000000000000000000000a1'],
      );
      const meta = await store.getOrderMeta('0x' + 'aa'.repeat(32));
      expect(meta?.chainId).toBe(46630);
    } finally {
      await store.pool.query('DELETE FROM links WHERE slug = $1', ['migrate01']);
      await store.pool.query('DELETE FROM order_meta WHERE order_id = $1', ['0x' + 'aa'.repeat(32)]);
      await store.close();
    }
  });
});
