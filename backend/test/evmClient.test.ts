import { describe, it, expect } from 'vitest';
import { Interface, getAddress } from 'ethers';
import { EvmClient } from '../src/chain/evmClient.js';
import { PAYWITHQUAI_ABI } from '../src/chain/abi.js';
import { NATIVE_TOKEN, type PaymentEvent } from '../src/types.js';
import type { Config } from '../src/config.js';

// Never dialed — these tests only exercise log decoding (a pure function of the log payload),
// so no RPC call happens and no live network is needed.
const RPC_URL = 'http://127.0.0.1:8645';
const CONTRACT = '0x0000000000000000000000000000000000000001';
const MERCHANT = '0x00000000000000000000000000000000000000a1';
const PAYER = '0x00000000000000000000000000000000000000b2';
const TOKEN = '0x0049f7cbca3556c2dfae62aafa7015f99de1b8f5';
const ORDER_ID = '0x' + '11'.repeat(32);
const TX_HASH = '0x' + 'ab'.repeat(32);

const cfg = { RPC_URL, CHAIN_ID: 46630, PAYWITHQUAI_ADDRESS: CONTRACT } as unknown as Config;

/** Cast to reach the private decoder, mirroring the `withPrivates` pattern used against
 *  Indexer in test/indexer.test.ts — keeps the production API surface unchanged. */
function withPrivates(c: EvmClient): { decodeEvents(logs: unknown[]): PaymentEvent[] } {
  return c as unknown as { decodeEvents(logs: unknown[]): PaymentEvent[] };
}

const iface = new Interface(PAYWITHQUAI_ABI);

/** A fixture `Log`-shaped object for a PaymentReceived event, encoded the same way a real node
 *  would return it (topics + data), so decodeEvents exercises real ABI decoding, not a fake. */
function fixtureLog(over: { blockNumber?: number; index?: number; token?: string } = {}) {
  const { data, topics } = iface.encodeEventLog('PaymentReceived', [
    MERCHANT,
    ORDER_ID,
    PAYER,
    over.token ?? NATIVE_TOKEN,
    25_000_000n,
    1_700_000_000n,
  ]);
  return {
    topics: [...topics],
    data,
    blockNumber: over.blockNumber ?? 100,
    transactionHash: TX_HASH,
    index: over.index ?? 0,
  };
}

describe('EvmClient', () => {
  it('decodes a PaymentReceived log into the same PaymentEvent shape QuaiClient produces', () => {
    const client = new EvmClient(cfg);
    const events = withPrivates(client).decodeEvents([fixtureLog()]);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      merchant: getAddress(MERCHANT),
      orderId: ORDER_ID,
      payer: getAddress(PAYER),
      token: NATIVE_TOKEN, // address(0) normalized to the native sentinel
      amount: 25_000_000n,
      eventTimestamp: 1_700_000_000,
      blockNumber: 100,
      txHash: TX_HASH,
      logIndex: 0,
    });
  });

  it('checksums a non-native ERC-20 token address rather than normalizing it', () => {
    const client = new EvmClient(cfg);
    const events = withPrivates(client).decodeEvents([fixtureLog({ token: TOKEN })]);
    expect(events[0]?.token).toBe(getAddress(TOKEN));
  });

  it('sorts decoded events by (blockNumber, logIndex)', () => {
    const client = new EvmClient(cfg);
    const events = withPrivates(client).decodeEvents([
      fixtureLog({ blockNumber: 5, index: 1 }),
      fixtureLog({ blockNumber: 5, index: 0 }),
      fixtureLog({ blockNumber: 3, index: 9 }),
    ]);
    expect(events.map((e) => [e.blockNumber, e.logIndex])).toEqual([
      [3, 9],
      [5, 0],
      [5, 1],
    ]);
  });

  it('ignores logs that are not PaymentReceived (e.g. PaymentSettled)', () => {
    const client = new EvmClient(cfg);
    const { data, topics } = iface.encodeEventLog('PaymentSettled', [
      MERCHANT,
      ORDER_ID,
      PAYER,
      NATIVE_TOKEN,
      25_000_000n,
      125_000n,
      24_875_000n,
      1n,
      1_700_000_000n,
    ]);
    const settledLog = { topics: [...topics], data, blockNumber: 1, transactionHash: TX_HASH, index: 0 };
    expect(withPrivates(client).decodeEvents([settledLog])).toHaveLength(0);
  });

  it('accepts a standard EIP-55 address that would fail Quai\'s zone check (no 0x00 prefix)', () => {
    // The real Robinhood Chain testnet deployment (contracts/deployments/robinhoodTestnet.json) —
    // QuaiClient would throw "not a valid Quai zone address" constructing against this address;
    // EvmClient must accept it with plain EIP-55 validation only.
    const robinhoodProxy = '0xe2C0d033102B7ad963deC4b44B5e1e94bca1385f';
    const client = new EvmClient({ ...cfg, PAYWITHQUAI_ADDRESS: robinhoodProxy } as Config);
    expect(client.address).toBe(getAddress(robinhoodProxy));
  });

  it('rejects a malformed contract address at construction, same as QuaiClient', () => {
    expect(() => new EvmClient({ ...cfg, PAYWITHQUAI_ADDRESS: '0x123' } as Config)).toThrow();
  });
});
