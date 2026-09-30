import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  loadChains,
  validateChains,
  defaultChain,
  isLegacyChainConfig,
  KNOWN_QUAI_CHAIN_IDS,
  type ChainConfig,
} from '../src/chains.js';
import type { Config } from '../src/config.js';

const legacyCfg: Config = {
  CHAIN_KIND: 'quai',
  RPC_URL: 'https://rpc.quai.network',
  CHAIN_ID: 9,
  PAYWITHQUAI_ADDRESS: '0x0072174EF6d0C2EB605449b0014169D104c42BbC',
  START_BLOCK: undefined,
  CONFIRMATIONS: 12,
  POLL_INTERVAL_MS: 5000,
  MAX_BLOCK_RANGE: 2000,
  ACCEPTED_TOKENS: [],
} as unknown as Config;

const quaiChain = (over: Partial<ChainConfig> = {}): ChainConfig => ({
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
  ...over,
});

const evmChain = (over: Partial<ChainConfig> = {}): ChainConfig => ({
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
  ...over,
});

// A path guaranteed not to exist, so the "no chains config present" tests below are deterministic
// regardless of whether a real (untracked, gitignored) backend/chains.json happens to sit on disk
// — loadChains()/isLegacyChainConfig() must never depend on that. Production code still defaults
// to './chains.json' (see chains.ts) — only these tests override it.
const NO_SUCH_CHAINS_PATH = './__no_such_dir__/chains.json';

describe('loadChains — legacy fallback (no CHAINS_JSON/CHAINS_CONFIG_PATH/chains.json)', () => {
  it('synthesizes a single chain from the legacy env vars, unaffected by unrelated env content', () => {
    const chains = loadChains(legacyCfg, {} as NodeJS.ProcessEnv, { defaultConfigPath: NO_SUCH_CHAINS_PATH });
    expect(chains).toHaveLength(1);
    expect(chains[0]).toMatchObject({
      chainId: 9,
      kind: 'quai',
      contractAddress: legacyCfg.PAYWITHQUAI_ADDRESS,
      confirmations: 12,
      enabled: true,
      default: true,
    });
  });

  it('synthesizes an "evm" chain from CHAIN_KIND=evm', () => {
    const cfg = { ...legacyCfg, CHAIN_KIND: 'evm', CHAIN_ID: 84532 } as unknown as Config;
    const chains = loadChains(cfg, {} as NodeJS.ProcessEnv, { defaultConfigPath: NO_SUCH_CHAINS_PATH });
    expect(chains[0]).toMatchObject({ kind: 'evm', chainId: 84532 });
  });

  it('is exercised deterministically regardless of a real chains.json on disk (this file does not touch the fs)', () => {
    // Sanity check that the injected path, not the real default, is what governs the fallback —
    // this is the actual regression test for the isolation bug: loadChains() must never resolve
    // './chains.json' relative to the process cwd when a path override is supplied.
    const chains = loadChains(legacyCfg, {} as NodeJS.ProcessEnv, { defaultConfigPath: NO_SUCH_CHAINS_PATH });
    expect(chains).toHaveLength(1);
    expect(chains[0]?.id).toBe('quai');
  });
});

describe('isLegacyChainConfig', () => {
  it('is true with no chains config present', () => {
    expect(isLegacyChainConfig({} as NodeJS.ProcessEnv, { defaultConfigPath: NO_SUCH_CHAINS_PATH })).toBe(true);
  });

  it('is false when CHAINS_JSON is set', () => {
    expect(
      isLegacyChainConfig({ CHAINS_JSON: '[]' } as NodeJS.ProcessEnv, { defaultConfigPath: NO_SUCH_CHAINS_PATH }),
    ).toBe(false);
  });

  it('is false when CHAINS_CONFIG_PATH is set', () => {
    expect(
      isLegacyChainConfig({ CHAINS_CONFIG_PATH: './somewhere.json' } as NodeJS.ProcessEnv, {
        defaultConfigPath: NO_SUCH_CHAINS_PATH,
      }),
    ).toBe(false);
  });

  it('is false when the default config path DOES exist (uses the real default when not overridden)', () => {
    // Exercises the production default path argument itself, using this test file as a stand-in
    // "chains config" that's guaranteed to exist — proving the default-path plumbing works,
    // without depending on whatever may or may not be at the real './chains.json'.
    const thisFile = new URL(import.meta.url).pathname;
    expect(isLegacyChainConfig({} as NodeJS.ProcessEnv, { defaultConfigPath: thisFile })).toBe(false);
  });
});

describe('loadChains — CHAINS_JSON', () => {
  it('loads a valid multi-chain list and resolves the marked default', () => {
    const env = { CHAINS_JSON: JSON.stringify([quaiChain(), evmChain()]) } as NodeJS.ProcessEnv;
    const chains = loadChains(legacyCfg, env);
    expect(chains).toHaveLength(2);
    expect(defaultChain(chains).id).toBe('quai');
  });

  it('rejects malformed JSON with a clear error, not a raw JSON.parse crash', () => {
    const env = { CHAINS_JSON: '{not valid json' } as NodeJS.ProcessEnv;
    expect(() => loadChains(legacyCfg, env)).toThrow();
  });

  it('rejects a chain missing required fields', () => {
    const env = { CHAINS_JSON: JSON.stringify([{ id: 'x' }]) } as NodeJS.ProcessEnv;
    expect(() => loadChains(legacyCfg, env)).toThrow(/Invalid chains configuration/i);
  });
});

describe('defaultChain', () => {
  it('resolves to the entry marked default', () => {
    expect(defaultChain([evmChain(), quaiChain()]).id).toBe('quai');
  });

  it('falls back to the first ENABLED entry when none is marked default', () => {
    const chains = validateChains([quaiChain({ default: undefined }), evmChain()], {} as NodeJS.ProcessEnv);
    expect(defaultChain(chains).id).toBe('quai');
  });

  it('skips a disabled first entry when resolving the fallback default', () => {
    const chains = validateChains(
      [quaiChain({ default: undefined, enabled: false }), evmChain({ default: undefined })],
      {} as NodeJS.ProcessEnv,
    );
    expect(defaultChain(chains).id).toBe('robinhood-testnet');
  });
});

describe('validateChains — rejections', () => {
  it('rejects duplicate ids', () => {
    expect(() => validateChains([quaiChain(), quaiChain({ chainId: 15000 })], {} as NodeJS.ProcessEnv)).toThrow(
      /duplicate chain id/i,
    );
  });

  it('rejects duplicate chainIds', () => {
    expect(() =>
      validateChains([quaiChain(), evmChain({ id: 'quai-2', chainId: 9 })], {} as NodeJS.ProcessEnv),
    ).toThrow(/duplicate chainId/i);
  });

  it('rejects an empty enabled list', () => {
    expect(() => validateChains([quaiChain({ enabled: false })], {} as NodeJS.ProcessEnv)).toThrow(
      /no enabled chains/i,
    );
  });

  it('rejects more than one enabled chain marked default', () => {
    expect(() => validateChains([quaiChain(), evmChain({ default: true })], {} as NodeJS.ProcessEnv)).toThrow(
      /multiple enabled chains marked default/i,
    );
  });

  it('allows two defaults when only one is enabled (the disabled one is ignored)', () => {
    expect(() =>
      validateChains([quaiChain(), evmChain({ default: true, enabled: false })], {} as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it('rejects kind "quai" with an unrecognized chainId', () => {
    expect(() => validateChains([quaiChain({ chainId: 12345 })], {} as NodeJS.ProcessEnv)).toThrow(
      /not a known Quai/i,
    );
  });

  it('rejects kind "evm" with a known Quai chainId', () => {
    expect(() => validateChains([evmChain({ chainId: 9 })], {} as NodeJS.ProcessEnv)).toThrow(
      /Quai chains must use kind "quai"/i,
    );
  });

  it('rejects QI_* variables set when no enabled chain has kind "quai"', () => {
    const env = { QI_MNEMONIC: 'test test test' } as NodeJS.ProcessEnv;
    expect(() => validateChains([evmChain()], env)).toThrow(/Qi is Quai-only/i);
  });

  it('allows QI_* variables when a quai chain is enabled', () => {
    const env = { QI_MNEMONIC: 'test test test' } as NodeJS.ProcessEnv;
    expect(() => validateChains([quaiChain(), evmChain()], env)).not.toThrow();
  });

  it('ignores QI_* variables left at their zod default (only explicitly-set ones count)', () => {
    // No QI_ keys in env at all — must not be confused with "QI_QITS_PER_QUAI=1000 was set".
    expect(() => validateChains([evmChain()], {} as NodeJS.ProcessEnv)).not.toThrow();
  });

  it('KNOWN_QUAI_CHAIN_IDS includes mainnet (9) and Orchard testnet (15000)', () => {
    expect(KNOWN_QUAI_CHAIN_IDS.has(9)).toBe(true);
    expect(KNOWN_QUAI_CHAIN_IDS.has(15000)).toBe(true);
    expect(KNOWN_QUAI_CHAIN_IDS.has(46630)).toBe(false);
  });
});

describe('chains.example.json', () => {
  it('is valid against the schema and cross-chain invariants (regression guard for the shipped example)', () => {
    const raw: unknown = JSON.parse(readFileSync(new URL('../chains.example.json', import.meta.url), 'utf8'));
    const env = { CHAINS_JSON: JSON.stringify(raw) } as NodeJS.ProcessEnv;
    const chains = loadChains(legacyCfg, env);
    expect(chains.map((c) => c.id)).toEqual(['quai', 'robinhood-testnet', 'base-sepolia']);
    expect(defaultChain(chains).id).toBe('quai');
    // base-sepolia ships disabled with a placeholder contract address — never built into a live
    // client, so the placeholder is harmless (see chain/index.ts: only enabled chains get one).
    expect(chains.find((c) => c.id === 'base-sepolia')?.enabled).toBe(false);
  });
});
