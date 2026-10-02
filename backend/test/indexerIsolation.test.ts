import { describe, it, expect, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdtempSync } from 'node:fs';
import { JsonStore } from '../src/store/json.js';
import { Indexer, cursorScope } from '../src/indexer/indexer.js';
import type { ChainClient } from '../src/chain/types.js';
import type { Config } from '../src/config.js';

const dirs: string[] = [];
function freshStore(): JsonStore {
  const dir = mkdtempSync(join(tmpdir(), 'pwq-idx-iso-'));
  dirs.push(dir);
  return new JsonStore(join(dir, 'relayer.db'));
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function cfgFor(chainId: number, contract: string): Config {
  return {
    CHAIN_ID: chainId,
    PAYWITHQUAI_ADDRESS: contract,
    START_BLOCK: undefined,
    CONFIRMATIONS: 0,
    POLL_INTERVAL_MS: 1000,
    MAX_BLOCK_RANGE: 2000,
  } as unknown as Config;
}

/** Reach the private tick()/initCursor() and the public health(), mirroring the `withPrivates`
 *  pattern already used against Indexer in test/indexer.test.ts. */
function withPrivates(i: Indexer): {
  tick(): Promise<void>;
  initCursor(): Promise<void>;
  health(): { lastPollAt: number | null; lastSuccessAt: number | null; lastError: string | null };
} {
  return i as unknown as {
    tick(): Promise<void>;
    initCursor(): Promise<void>;
    health(): { lastPollAt: number | null; lastSuccessAt: number | null; lastError: string | null };
  };
}

const FAILING_CONTRACT = '0x0000000000000000000000000000000000000002';
const HEALTHY_CONTRACT = '0x0000000000000000000000000000000000000003';

function failingClient(): ChainClient {
  return {
    address: FAILING_CONTRACT,
    getBlockNumber: vi.fn(async () => {
      throw new Error('RPC unreachable for this chain');
    }),
    getPaymentEvents: vi.fn(async () => []),
    getOrder: vi.fn(async () => {
      throw new Error('unreachable');
    }),
    feeBps: vi.fn(async () => 50),
    feeRecipient: vi.fn(async () => '0x0000000000000000000000000000000000000009'),
  };
}

function healthyClient(head: number): ChainClient {
  return {
    address: HEALTHY_CONTRACT,
    getBlockNumber: vi.fn(async () => head),
    getPaymentEvents: vi.fn(async () => []),
    getOrder: vi.fn(async () => {
      throw new Error('not used in this test');
    }),
    feeBps: vi.fn(async () => 50),
    feeRecipient: vi.fn(async () => '0x0000000000000000000000000000000000000009'),
  };
}

describe('Indexer isolation (multi-chain: one Indexer instance per chain)', () => {
  it("one chain's client throwing on every call does not stop another chain's indexer from advancing", async () => {
    const store = freshStore();
    const failing = withPrivates(new Indexer(failingClient(), store, cfgFor(1001, FAILING_CONTRACT), () => 0));
    const healthy = withPrivates(new Indexer(healthyClient(100), store, cfgFor(1002, HEALTHY_CONTRACT), () => 0));

    // Interleave ticks exactly as index.ts's independent setInterval loops would — nothing shared,
    // nothing awaited across the two chains' Indexer instances.
    await failing.tick();
    await healthy.tick();
    await failing.tick();
    await healthy.tick();
    await failing.tick();

    expect(failing.health().lastError).toBeTruthy();
    expect(healthy.health().lastError).toBeNull();
    expect(healthy.health().lastSuccessAt).not.toBeNull();

    // The healthy chain's cursor genuinely advanced (to head, since CONFIRMATIONS=0) — proof its
    // ticks are unaffected by the failing chain ever having thrown, not just that both instances
    // exist independently.
    expect(await store.getCursor(cursorScope(1002, HEALTHY_CONTRACT))).toBe(100);
    // The failing chain never advanced past its (never-seeded) cursor.
    expect(await store.getCursor(cursorScope(1001, FAILING_CONTRACT))).toBeUndefined();
  });

  it('a client that never resolves times out rather than blocking that chain forever', async () => {
    vi.useFakeTimers();
    try {
      const store = freshStore();
      const hangingClient: ChainClient = {
        address: '0x0000000000000000000000000000000000000004',
        getBlockNumber: vi.fn(() => new Promise<number>(() => {})), // never settles
        getPaymentEvents: vi.fn(async () => []),
        getOrder: vi.fn(async () => {
          throw new Error('not used');
        }),
        feeBps: vi.fn(async () => 50),
        feeRecipient: vi.fn(async () => '0x0000000000000000000000000000000000000009'),
      };
      const indexer = withPrivates(
        new Indexer(hangingClient, store, cfgFor(1003, '0x0000000000000000000000000000000000000004'), () => 0),
      );

      const assertion = expect(indexer.initCursor()).rejects.toThrow(/timed out/i);
      // The indexer's per-call RPC timeout is 30s — advance fake time past it deterministically
      // instead of waiting in real time.
      await vi.advanceTimersByTimeAsync(30_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
