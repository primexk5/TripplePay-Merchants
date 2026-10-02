import { describe, it, expect, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdtempSync } from 'node:fs';
import { JsonStore } from '../src/store/json.js';
import { Indexer, cursorScope } from '../src/indexer/indexer.js';
import type { QuaiClient } from '../src/chain/client.js';
import type { PaymentEvent } from '../src/types.js';
import type { Config } from '../src/config.js';

const dirs: string[] = [];
function freshStore(): JsonStore {
  const dir = mkdtempSync(join(tmpdir(), 'pwq-idx-'));
  dirs.push(dir);
  return new JsonStore(join(dir, 'relayer.db'));
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ADDR = '0x00000000000000000000000000000000000000a1';
const SCOPE = cursorScope(9, '0x0000000000000000000000000000000000000001');

const cfg = {
  CHAIN_ID: 9,
  PAYWITHQUAI_ADDRESS: '0x0000000000000000000000000000000000000001',
  START_BLOCK: undefined,
  CONFIRMATIONS: 12,
  POLL_INTERVAL_MS: 1000,
  MAX_BLOCK_RANGE: 2000,
} as unknown as Config;

const event = (blockNumber: number, txHash = '0x' + 'ab'.repeat(32)): PaymentEvent => ({
  merchant: '0x00000000000000000000000000000000000000A1',
  orderId: '0x' + '11'.repeat(32),
  payer: '0x00000000000000000000000000000000000000B2',
  token: '0x0000000000000000000000000000000000000000',
  amount: 25_000_000n,
  eventTimestamp: 1,
  blockNumber,
  txHash,
  logIndex: 0,
});

type OrderOver = Partial<{ settled: boolean; exists: boolean; feeBps: number; amount: bigint }>;
const onChainOrder = (over: OrderOver = {}) => ({
  merchant: '0x00000000000000000000000000000000000000A1',
  settled: true,
  exists: true,
  feeBps: 50,
  token: '0x0000000000000000000000000000000000000000',
  amount: 25_000_000n,
  expiry: 0n,
  feeRecipient: '0x00000000000000000000000000000000000000c3',
  settledAt: 0n,
  ...over,
});

function fakeClient(opts: { head?: number; events?: PaymentEvent[]; settled?: boolean; exists?: boolean } = {}) {
  return {
    getBlockNumber: vi.fn(async () => opts.head ?? 100),
    getPaymentEvents: vi.fn(async (from: number, to: number) =>
      (opts.events ?? []).filter((e) => e.blockNumber >= from && e.blockNumber <= to),
    ),
    getOrder: vi.fn(async () => onChainOrder({ settled: opts.settled ?? true, exists: opts.exists ?? true })),
  } as unknown as QuaiClient;
}

/** Cast a private method to keep the production API surface unchanged while driving it in tests. */
function withPrivates(i: Indexer): {
  initCursor(): Promise<void>;
  tick(): Promise<void>;
  processEvent(e: PaymentEvent): Promise<void>;
} {
  return i as unknown as {
    initCursor(): Promise<void>;
    tick(): Promise<void>;
    processEvent(e: PaymentEvent): Promise<void>;
  };
}

describe('Indexer', () => {
  it('seeds the cursor from START_BLOCK - 1 under the (chain, contract) scope', async () => {
    const store = freshStore();
    const client = fakeClient();
    const indexer = withPrivates(new Indexer(client, store, { ...cfg, START_BLOCK: 500 }, () => 0));
    await indexer.initCursor();
    expect(client.getBlockNumber).not.toHaveBeenCalled();
    expect(await store.getCursor(SCOPE)).toBe(499);
  });

  it('without START_BLOCK seeds from head - CONFIRMATIONS', async () => {
    const store = freshStore();
    const indexer = withPrivates(new Indexer(fakeClient({ head: 1000 }), store, cfg, () => 0));
    await indexer.initCursor();
    expect(await store.getCursor(SCOPE)).toBe(988);
  });

  it('leaves an existing cursor untouched (store survives restarts)', async () => {
    const store = freshStore();
    await store.setCursor(SCOPE, 12345);
    const indexer = withPrivates(new Indexer(fakeClient(), store, cfg, () => 0));
    await indexer.initCursor();
    expect(await store.getCursor(SCOPE)).toBe(12345);
  });

  it('treats a store file reused from another deployment as empty (no silently skipped events)', async () => {
    const store = freshStore();
    await store.setCursor(cursorScope(9, '0x00000000000000000000000000000000000000FF'), 12345);
    const indexer = withPrivates(new Indexer(fakeClient({ head: 1000 }), store, cfg, () => 0));
    await indexer.initCursor();
    expect(await store.getCursor(SCOPE)).toBe(988); // fresh scope starts from head
    expect(await store.getCursor(cursorScope(9, '0x00000000000000000000000000000000000000FF'))).toBe(12345);
  });

  it('does not advance past the finality boundary (head - CONFIRMATIONS)', async () => {
    const store = freshStore();
    await store.setCursor(SCOPE, 90);
    const client = fakeClient({ head: 100, events: [event(99)] }); // head - 12 = 88 < cursor
    const indexer = withPrivates(new Indexer(client, store, cfg, () => 0));
    await indexer.tick();
    expect(client.getPaymentEvents).not.toHaveBeenCalled();
    expect(await store.getCursor(SCOPE)).toBe(90);
  });

  it('advances the cursor in MAX_BLOCK_RANGE chunks while catching up', async () => {
    const store = freshStore();
    const client = fakeClient({ head: 20_000, events: [event(55)] });
    const indexer = withPrivates(new Indexer(client, store, { ...cfg, MAX_BLOCK_RANGE: 50, CONFIRMATIONS: 0 }, () => 0));
    await indexer.tick();
    expect(client.getPaymentEvents).toHaveBeenCalledWith(1, 50);
    expect(await store.getCursor(SCOPE)).toBe(50); // paused mid-catch-up: resumes next tick
    await indexer.tick();
    expect(client.getPaymentEvents).toHaveBeenCalledWith(51, 100);
  });

  it('queues exactly one webhook delivery for a confirmed payment (idempotent)', async () => {
    const store = freshStore();
    await store.upsertMerchant({
      merchantId: 'mch_1',
      address: ADDR,
      name: 'Acme',
      webhookUrl: 'https://example.test/webhook',
      webhookSecret: 'whsec_x',
      active: true,
      createdAt: 1,
    });
    const client = fakeClient({ events: [event(5)] });
    const indexer = withPrivates(new Indexer(client, store, cfg, () => 1_700_000_000_000));
    await indexer.processEvent(event(5));
    expect(await store.listDeliveries(10)).toHaveLength(1);
    const d = (await store.getDelivery('0x' + 'ab'.repeat(32) + ':0'))!;
    expect(d.status).toBe('pending');
    expect(d.merchantId).toBe('mch_1');
    expect(d.payload.data.amount).toBe('25000000'); // gross
    // fee = 25_000_000 * 50 / 10000 = 125_000; net = gross - fee
    expect(d.payload.data.feeBps).toBe(50);
    expect(d.payload.data.fee).toBe('125000');
    expect(d.payload.data.net).toBe('24875000');

    // Re-processing the same block (post-restart replay) must not double-queue.
    await indexer.processEvent(event(5));
    expect(await store.listDeliveries(10)).toHaveLength(1);
  });

  it('drops events that are not settled on-chain (reorg guard #2)', async () => {
    const store = freshStore();
    const client = fakeClient({ events: [event(5)], settled: false });
    const indexer = withPrivates(new Indexer(client, store, cfg, () => 0));
    await indexer.processEvent(event(5));
    expect(await store.listDeliveries(10)).toHaveLength(0);
    expect(client.getOrder).toHaveBeenCalledTimes(1);
  });

  it('records payments to unregistered merchants as skipped, keyed by address', async () => {
    const store = freshStore();
    const indexer = withPrivates(new Indexer(fakeClient({ events: [event(5)] }), store, cfg, () => 0));
    await indexer.processEvent(event(5));
    const d = (await store.getDelivery('0x' + 'ab'.repeat(32) + ':0'))!;
    expect(d.status).toBe('skipped');
    expect(d.merchantId).toBe('unregistered:' + ADDR);
    expect(d.url).toBe('');
  });

  // The regression this whole lookup exists to prevent. A merchant's identity address (the wallet
  // they log in with) and the address their money lands on are different things once per-chain
  // payouts exist. The indexer only ever sees the payout address off the event, so resolving it
  // with getMerchantByAddress would miss here — and the failure is SILENT: the payment is still
  // recorded, just as `skipped` against `unregistered:<payout>`, so the merchant never gets their
  // webhook and nothing anywhere reports an error.
  it('delivers a webhook when the payout address differs from the identity address', async () => {
    const store = freshStore();
    await store.upsertMerchant({
      merchantId: 'mch_payout',
      address: '0x00000000000000000000000000000000000000d1', // identity (login) address
      name: 'Acme',
      webhookUrl: 'https://example.test/webhook',
      webhookSecret: 'whsec_x',
      active: true,
      createdAt: 1,
    });
    // Money lands here instead — a different address, same merchant.
    await store.setPayoutAddress({
      merchantId: 'mch_payout',
      chainId: 9,
      address: '0x00000000000000000000000000000000000000A1',
      source: 'declared',
      createdAt: 2,
    });

    const indexer = withPrivates(new Indexer(fakeClient({ events: [event(5)] }), store, cfg, () => 0));
    await indexer.processEvent(event(5));

    const d = (await store.getDelivery('0x' + 'ab'.repeat(32) + ':0'))!;
    expect(d.merchantId).toBe('mch_payout');
    expect(d.status).not.toBe('skipped');
    expect(d.url).toBe('https://example.test/webhook');
  });

  it('does not resolve a payout address on the wrong chain', async () => {
    const store = freshStore();
    await store.upsertMerchant({
      merchantId: 'mch_payout',
      address: '0x00000000000000000000000000000000000000d1',
      name: 'Acme',
      webhookUrl: 'https://example.test/webhook',
      webhookSecret: 'whsec_x',
      active: true,
      createdAt: 1,
    });
    // Configured for chain 46630 only. This indexer watches chain 9.
    await store.setPayoutAddress({
      merchantId: 'mch_payout',
      chainId: 46630,
      address: '0x00000000000000000000000000000000000000A1',
      source: 'declared',
      createdAt: 2,
    });

    const indexer = withPrivates(new Indexer(fakeClient({ events: [event(5)] }), store, cfg, () => 0));
    await indexer.processEvent(event(5));

    const d = (await store.getDelivery('0x' + 'ab'.repeat(32) + ':0'))!;
    expect(d.merchantId).toBe('unregistered:' + ADDR);
    expect(d.status).toBe('skipped');
  });
});