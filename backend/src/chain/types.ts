import type { OnChainOrder } from './client.js';
import type { PaymentEvent } from '../types.js';

/**
 * Chain-agnostic surface the rest of the backend depends on — derived from exactly what
 * indexer.ts and api/server.ts call on QuaiClient today (address, getBlockNumber,
 * getPaymentEvents, getOrder). Both QuaiClient (quais SDK, Quai zones) and EvmClient (ethers v6,
 * standard EVM chains) implement this, so the indexer and the HTTP API never need to branch on
 * which chain kind is running — see createChainClient() in chain/index.ts.
 *
 * One process serves exactly one chain (CHAIN_KIND selects the client at boot) — there is no
 * per-request chain selection.
 */
export interface ChainClient {
  /** Checksummed PayWithQuai contract address this client reads. */
  readonly address: string;

  /** Current block height. */
  getBlockNumber(): Promise<number>;

  /**
   * Decoded `PaymentReceived` events in the inclusive block range [fromBlock, toBlock], sorted by
   * (blockNumber, logIndex) so downstream processing is deterministic.
   */
  getPaymentEvents(fromBlock: number, toBlock: number): Promise<PaymentEvent[]>;

  /** Full on-chain order record (includes settlement state) for (merchant, orderId). */
  getOrder(merchant: string, orderId: string): Promise<OnChainOrder>;
}
