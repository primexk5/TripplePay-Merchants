import {
  Contract,
  Interface,
  JsonRpcProvider,
  getAddress,
  getZoneForAddress,
  toShard,
  type Log,
  type Shard,
} from 'quais';
import { PAYWITHQUAI_ABI } from './abi.js';
import type { ChainClient } from './types.js';
import type { Config } from '../config.js';
import { NATIVE_TOKEN, type PaymentEvent } from '../types.js';
import { log } from '../logger.js';
import { sleep } from '../util/sleep.js';

const logger = log('chain');

/** Retry budget for a single getLogs call. The public Quai RPCs are flaky under load and
 *  occasionally return empty -32000 errors for otherwise valid queries; a short backoff retry
 *  rides through those hiccups instead of stalling the whole indexer tick (which would retry the
 *  same range on the next poll anyway, but noisily). */
const GET_LOGS_RETRIES = 3;
const GET_LOGS_BACKOFF_MS = 500;

/** Shape of the on-chain order record returned by getOrder(). */
export interface OnChainOrder {
  merchant: string;
  settled: boolean;
  exists: boolean;
  feeBps: number;
  token: string;
  amount: bigint;
  expiry: bigint;
  feeRecipient: string;
  settledAt: bigint;
  expectedPayer: string;
  nonce: bigint;
}

/**
 * Read-only client for the PayWithQuai proxy on a Quai zone. Uses the quais SDK (Hardhat's ethers
 * cannot talk to Quai). Log queries go through `provider.getLogs` with an explicit topic filter,
 * which is robust across quais alpha versions and reorg-safe when the caller bounds the range to
 * `head - confirmations`.
 */
export class QuaiClient implements ChainClient {
  readonly address: string;
  private readonly provider: JsonRpcProvider;
  private readonly iface: Interface;
  private readonly contract: Contract;
  private readonly topic0: string;
  private readonly shard: Shard;
  private readonly nodeLocation: number[];

  constructor(cfg: Config) {
    this.provider = new JsonRpcProvider(cfg.RPC_URL, undefined, { usePathing: true });
    this.address = getAddress(cfg.PAYWITHQUAI_ADDRESS);
    // Quai is sharded and provider block queries are zone-scoped. Derive the zone from the
    // contract address (its prefix encodes the zone, e.g. 0x00... = Cyprus-1).
    const zone = getZoneForAddress(this.address);
    if (!zone) {
      throw new Error(`PAYWITHQUAI_ADDRESS ${this.address} is not a valid Quai zone address`);
    }
    this.shard = toShard(zone);
    // Zone -> node location ([0,0] for Cyprus-1): the SDK derives this from the filter's
    // nodeLocation, and (in alpha) getLogs never fills it from the address alone.
    this.nodeLocation = zone
      .slice(2)
      .split('')
      .map(Number) as number[];
    this.iface = new Interface(PAYWITHQUAI_ABI);
    this.contract = new Contract(this.address, PAYWITHQUAI_ABI, this.provider);
    this.topic0 = this.iface.getEvent('PaymentReceived')!.topicHash;
  }

  async getBlockNumber(): Promise<number> {
    return this.provider.getBlockNumber(this.shard);
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
      nodeLocation: this.nodeLocation,
    };

    let lastError: unknown;
    for (let attempt = 1; attempt <= GET_LOGS_RETRIES; attempt++) {
      try {
        const logs = (await this.provider.getLogs(filter)) as Log[];
        return this.decodeEvents(logs);
      } catch (err) {
        lastError = err;
        if (attempt < GET_LOGS_RETRIES) {
          const delay = GET_LOGS_BACKOFF_MS * 2 ** (attempt - 1);
          logger.warn({ fromBlock, toBlock, attempt, delayMs: delay }, 'getLogs failed — retrying');
          await sleep(delay);
        }
      }
    }
    throw lastError;
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

  /** On-chain settlement flag — the source of truth the relayer re-checks before confirming. */
  async isSettled(merchant: string, orderId: string): Promise<boolean> {
    return this.contract.isSettled!(merchant, orderId) as Promise<boolean>;
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

/** Canonicalize the zero address to our NATIVE sentinel; checksum everything else. */
function normalizeToken(token: string): string {
  const addr = getAddress(token);
  return addr === getAddress(NATIVE_TOKEN) ? NATIVE_TOKEN : addr;
}
