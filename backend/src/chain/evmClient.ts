import { Contract, Interface, JsonRpcProvider, getAddress, type Log } from 'ethers';
import { PAYWITHQUAI_ABI } from './abi.js';
import type { ChainClient } from './types.js';
import type { OnChainOrder } from './client.js';
import type { Config } from '../config.js';
import { NATIVE_TOKEN, type PaymentEvent } from '../types.js';
import { log } from '../logger.js';

const logger = log('chain');

/**
 * Read-only client for the PayWithQuai proxy on a standard EVM chain, using ethers v6. Standard-
 * EVM counterpart to QuaiClient (chain/client.ts): same PayWithQuai ABI, same PaymentEvent
 * decoding, same OnChainOrder shape — but plain EIP-55 address validation only (no Quai
 * zone/shard concepts) and a plain `eth_getLogs` filter (no `nodeLocation` field).
 *
 * The provider is constructed with cfg.CHAIN_ID as its expected network. ethers verifies the
 * RPC's actual chain id against this on first use and throws on a mismatch, so a misconfigured
 * RPC_URL/CHAIN_ID pair fails fast (on first call) instead of silently indexing the wrong chain.
 */
export class EvmClient implements ChainClient {
  readonly address: string;
  private readonly provider: JsonRpcProvider;
  private readonly iface: Interface;
  private readonly contract: Contract;
  private readonly topic0: string;

  constructor(cfg: Config) {
    this.provider = new JsonRpcProvider(cfg.RPC_URL, cfg.CHAIN_ID);
    this.address = getAddress(cfg.PAYWITHQUAI_ADDRESS);
    this.iface = new Interface(PAYWITHQUAI_ABI);
    this.contract = new Contract(this.address, PAYWITHQUAI_ABI, this.provider);
    this.topic0 = this.iface.getEvent('PaymentReceived')!.topicHash;
  }

  async getBlockNumber(): Promise<number> {
    return this.provider.getBlockNumber();
  }

  /**
   * Fetch and decode all `PaymentReceived` events in the inclusive block range [fromBlock, toBlock].
   * Returns them sorted by (blockNumber, logIndex) so downstream processing is deterministic.
   */
  async getPaymentEvents(fromBlock: number, toBlock: number): Promise<PaymentEvent[]> {
    const filter = {
      address: this.address,
      topics: [this.topic0],
      fromBlock,
      toBlock,
    };
    const logs = (await this.provider.getLogs(filter)) as Log[];
    return this.decodeEvents(logs);
  }

  private decodeEvents(logs: Log[]): PaymentEvent[] {
    const events: PaymentEvent[] = [];
    for (const l of logs) {
      const parsed = this.iface.parseLog({ topics: [...l.topics], data: l.data });
      if (!parsed || parsed.name !== 'PaymentReceived') continue;
      const a = parsed.args;
      events.push({
        merchant: getAddress(a.merchant as string),
        orderId: a.orderId as string,
        payer: getAddress(a.payer as string),
        token: normalizeToken(a.token as string),
        amount: a.amount as bigint,
        eventTimestamp: Number(a.timestamp as bigint),
        blockNumber: l.blockNumber,
        txHash: l.transactionHash,
        logIndex: l.index,
      });
    }
    events.sort((x, y) => x.blockNumber - y.blockNumber || x.logIndex - y.logIndex);
    logger.debug({ count: events.length }, 'fetched payment events');
    return events;
  }

  async getOrder(merchant: string, orderId: string): Promise<OnChainOrder> {
    const o = await this.contract.getOrder!(merchant, orderId);
    return {
      merchant: getAddress(o.merchant as string),
      settled: o.settled as boolean,
      exists: o.exists as boolean,
      feeBps: Number(o.feeBps as bigint),
      token: normalizeToken(o.token as string),
      amount: o.amount as bigint,
      expiry: o.expiry as bigint,
      feeRecipient: getAddress(o.feeRecipient as string),
      settledAt: o.settledAt as bigint,
      expectedPayer: getAddress(o.expectedPayer as string),
      nonce: o.nonce as bigint,
    };
  }
}

/** Canonicalize the zero address to our NATIVE sentinel; checksum everything else. Mirrors
 *  chain/client.ts's normalizeToken (kept local — that one is private to QuaiClient's module,
 *  and the two clients use different checksum implementations, quais vs ethers). */
function normalizeToken(token: string): string {
  const addr = getAddress(token);
  return addr === getAddress(NATIVE_TOKEN) ? NATIVE_TOKEN : addr;
}
