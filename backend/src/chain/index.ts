import type { Config } from '../config.js';
import type { ChainConfig } from '../chains.js';
import type { ChainClient } from './types.js';
import { QuaiClient } from './client.js';
import { EvmClient } from './evmClient.js';
import { log } from '../logger.js';

const logger = log('chain');

/**
 * Builds the read-only client for one configured chain. QuaiClient/EvmClient both take a
 * `Config`-shaped object but only ever read RPC_URL/CHAIN_ID/PAYWITHQUAI_ADDRESS from it (see
 * chain/client.ts and chain/evmClient.ts) — neither file changes for multi-chain support; this
 * function just builds that minimal shim from one ChainConfig entry instead of the global Config.
 */
export function createChainClient(chain: ChainConfig): ChainClient {
  const shim = {
    RPC_URL: chain.rpcUrl,
    CHAIN_ID: chain.chainId,
    PAYWITHQUAI_ADDRESS: chain.contractAddress,
  } as Config;
  const client: ChainClient = chain.kind === 'evm' ? new EvmClient(shim) : new QuaiClient(shim);
  logger.info(
    { chainSlug: chain.id, kind: chain.kind, chainId: chain.chainId, contract: client.address },
    'chain client created',
  );
  return client;
}

/** One chain's client bundled with the config it was built from. */
export interface ChainRegistryEntry {
  config: ChainConfig;
  client: ChainClient;
}

/**
 * Registry of every enabled chain's client, built once at boot. Lookup by chainId (number) or by
 * slug (string), plus the default chain that chain-less legacy requests resolve to.
 *
 * Disabled chains are intentionally excluded — they never get a live client (no RPC connection,
 * no indexer), so they can't be resolved or selected at runtime even by an explicit request.
 */
export class ChainRegistry {
  readonly entries: ChainRegistryEntry[];
  readonly default: ChainRegistryEntry;
  private readonly byChainId = new Map<number, ChainRegistryEntry>();
  private readonly bySlug = new Map<string, ChainRegistryEntry>();

  constructor(chains: ChainConfig[]) {
    const enabled = chains.filter((c) => c.enabled);
    this.entries = enabled.map((config) => ({ config, client: createChainClient(config) }));
    for (const entry of this.entries) {
      this.byChainId.set(entry.config.chainId, entry);
      this.bySlug.set(entry.config.id, entry);
    }
    const marked = this.entries.find((e) => e.config.default);
    const def = marked ?? this.entries[0];
    if (!def) {
      // validateChains() in chains.ts already rejects an empty enabled list before this is ever
      // constructed — this is an invariant check, not a reachable user-facing error.
      throw new Error('ChainRegistry: no enabled chains');
    }
    this.default = def;
    logger.info(
      { chains: this.entries.map((e) => ({ id: e.config.id, chainId: e.config.chainId, kind: e.config.kind })), default: def.config.id },
      'chain registry built',
    );
  }

  getByChainId(chainId: number): ChainRegistryEntry | undefined {
    return this.byChainId.get(chainId);
  }

  getBySlug(slug: string): ChainRegistryEntry | undefined {
    return this.bySlug.get(slug);
  }

  /**
   * Resolves a request-supplied chain identifier — a numeric chainId, a numeric string, or a
   * slug — against the registry. Undefined/empty resolves to the default chain (chain-less
   * legacy behaviour). Returns undefined only for an identifier that doesn't match any ENABLED
   * chain (unknown id, unknown slug, or a disabled chain's id/slug) — the caller turns that into
   * a 400.
   */
  resolve(idOrSlug: string | number | undefined | null): ChainRegistryEntry | undefined {
    if (idOrSlug === undefined || idOrSlug === null || idOrSlug === '') return this.default;
    if (typeof idOrSlug === 'number') return this.getByChainId(idOrSlug);
    const trimmed = idOrSlug.trim();
    if (/^\d+$/.test(trimmed)) return this.getByChainId(Number(trimmed));
    return this.getBySlug(trimmed);
  }
}
