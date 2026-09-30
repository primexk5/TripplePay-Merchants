import { describe, it, expect } from 'vitest';
import { ChainRegistry, createChainClient } from '../src/chain/index.js';
import type { ChainConfig } from '../src/chains.js';

// Real (but never-dialed) client construction only reads/validates the address — see
// chain/client.ts and chain/evmClient.ts — so building a registry from these configs makes no
// network call.
const quaiChain: ChainConfig = {
  id: 'quai',
  chainId: 9,
  kind: 'quai',
  name: 'Quai',
  rpcUrl: 'https://rpc.quai.network/cyprus1',
  contractAddress: '0x0072174EF6d0C2EB605449b0014169D104c42BbC',
  confirmations: 12,
  pollIntervalMs: 5000,
  maxBlockRange: 2000,
  enabled: true,
  default: true,
};

const evmChain: ChainConfig = {
  id: 'robinhood-testnet',
  chainId: 46630,
  kind: 'evm',
  name: 'Robinhood Chain testnet',
  rpcUrl: 'https://rpc.testnet.chain.robinhood.com/rpc',
  contractAddress: '0xe2C0d033102B7ad963deC4b44B5e1e94bca1385f',
  confirmations: 20,
  pollIntervalMs: 5000,
  maxBlockRange: 2000,
  enabled: true,
};

const disabledChain: ChainConfig = {
  id: 'base-sepolia',
  chainId: 84532,
  kind: 'evm',
  name: 'Base Sepolia',
  rpcUrl: 'https://sepolia.base.org',
  contractAddress: '0x00000000000000000000000000000000000dE1',
  confirmations: 10,
  pollIntervalMs: 5000,
  maxBlockRange: 2000,
  enabled: false,
};

describe('ChainRegistry', () => {
  it('builds one client per ENABLED chain only', () => {
    const registry = new ChainRegistry([quaiChain, evmChain, disabledChain]);
    expect(registry.entries).toHaveLength(2);
    expect(registry.getBySlug('base-sepolia')).toBeUndefined();
    expect(registry.getByChainId(84532)).toBeUndefined();
  });

  it('resolves by chainId (number and numeric string) and by slug', () => {
    const registry = new ChainRegistry([quaiChain, evmChain]);
    expect(registry.resolve(46630)?.config.id).toBe('robinhood-testnet');
    expect(registry.resolve('46630')?.config.id).toBe('robinhood-testnet');
    expect(registry.resolve('robinhood-testnet')?.config.id).toBe('robinhood-testnet');
    expect(registry.resolve('  46630  ')?.config.id).toBe('robinhood-testnet'); // trims whitespace
  });

  it('resolves undefined/null/empty to the default chain', () => {
    const registry = new ChainRegistry([quaiChain, evmChain]);
    expect(registry.resolve(undefined)?.config.id).toBe('quai');
    expect(registry.resolve(null)?.config.id).toBe('quai');
    expect(registry.resolve('')?.config.id).toBe('quai');
    expect(registry.default.config.id).toBe('quai');
  });

  it('falls back to the first entry as default when none is marked', () => {
    const registry = new ChainRegistry([{ ...quaiChain, default: undefined }, evmChain]);
    expect(registry.default.config.id).toBe('quai');
  });

  it('returns undefined for an unknown or disabled id/slug/chainId', () => {
    const registry = new ChainRegistry([quaiChain, evmChain, disabledChain]);
    expect(registry.resolve('base-sepolia')).toBeUndefined();
    expect(registry.resolve(84532)).toBeUndefined();
    expect(registry.resolve('nonexistent')).toBeUndefined();
    expect(registry.resolve(999999)).toBeUndefined();
  });

  it('each entry exposes the client bound to its own contract address', () => {
    const registry = new ChainRegistry([quaiChain, evmChain]);
    expect(registry.getByChainId(9)?.client.address.toLowerCase()).toBe(quaiChain.contractAddress.toLowerCase());
    expect(registry.getByChainId(46630)?.client.address.toLowerCase()).toBe(evmChain.contractAddress.toLowerCase());
  });
});

describe('createChainClient', () => {
  it('builds a QuaiClient for kind "quai" and an EvmClient for kind "evm" with no live RPC call', () => {
    expect(() => createChainClient(quaiChain)).not.toThrow();
    expect(() => createChainClient(evmChain)).not.toThrow();
    expect(createChainClient(evmChain).address.toLowerCase()).toBe(evmChain.contractAddress.toLowerCase());
  });

  it('rejects a malformed contract address at construction for either kind', () => {
    expect(() => createChainClient({ ...quaiChain, contractAddress: '0x123' })).toThrow();
    expect(() => createChainClient({ ...evmChain, contractAddress: '0x123' })).toThrow();
  });
});
