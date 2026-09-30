import { describe, it, expect, vi } from 'vitest';

const baseEnv = {
  RPC_URL: 'https://rpc.testnet.chain.robinhood.com/rpc',
  CHAIN_ID: '46630',
  PAYWITHQUAI_ADDRESS: '0x0000000000000000000000000000000000000001',
  ADMIN_API_KEY: 'test-admin-key-0123456789abcdef',
};

/**
 * loadConfig() memoizes its parsed result in module-level state (by design — real boot calls it
 * exactly once). That makes it untestable across multiple env variants within one module
 * instance, so each test resets the module registry and re-imports config.ts fresh, giving it
 * its own uncached `loadConfig`.
 */
async function freshLoadConfig() {
  vi.resetModules();
  const mod = await import('../src/config.js');
  return mod.loadConfig;
}

describe('loadConfig — CHAIN_KIND', () => {
  it('defaults to "quai" when unset', async () => {
    const loadConfig = await freshLoadConfig();
    const cfg = loadConfig({ ...baseEnv } as NodeJS.ProcessEnv);
    expect(cfg.CHAIN_KIND).toBe('quai');
  });

  it('boots with CHAIN_KIND=evm when no QI_* variable is set', async () => {
    const loadConfig = await freshLoadConfig();
    const cfg = loadConfig({ ...baseEnv, CHAIN_KIND: 'evm' } as NodeJS.ProcessEnv);
    expect(cfg.CHAIN_KIND).toBe('evm');
  });

  it('refuses to boot with CHAIN_KIND=evm and QI_MNEMONIC set', async () => {
    const loadConfig = await freshLoadConfig();
    expect(() =>
      loadConfig({
        ...baseEnv,
        CHAIN_KIND: 'evm',
        QI_MNEMONIC: 'test test test test test test test test test test test junk',
      } as NodeJS.ProcessEnv),
    ).toThrow(/Qi is Quai-only/i);
  });

  it('refuses to boot with CHAIN_KIND=evm and QI_RPC_URL set', async () => {
    const loadConfig = await freshLoadConfig();
    expect(() =>
      loadConfig({
        ...baseEnv,
        CHAIN_KIND: 'evm',
        QI_RPC_URL: 'https://qi-cyprus1.quai.network',
      } as NodeJS.ProcessEnv),
    ).toThrow(/Qi is Quai-only/i);
  });

  it('refuses to boot with CHAIN_KIND=evm and any other QI_* variable set', async () => {
    const loadConfig = await freshLoadConfig();
    expect(() =>
      loadConfig({ ...baseEnv, CHAIN_KIND: 'evm', QI_DEV_SIMULATE: 'true' } as NodeJS.ProcessEnv),
    ).toThrow(/Qi is Quai-only/i);
  });

  it('does not trip the guard on QI_* variables left unset (only explicitly-set ones count)', async () => {
    const loadConfig = await freshLoadConfig();
    // baseEnv has no QI_* keys at all — QI_QITS_PER_QUAI/QI_POLL_INTERVAL_MS get zod defaults,
    // which must not be mistaken for "the operator set this".
    const cfg = loadConfig({ ...baseEnv, CHAIN_KIND: 'evm' } as NodeJS.ProcessEnv);
    expect(cfg.CHAIN_KIND).toBe('evm');
  });

  it('still allows QI_* variables under CHAIN_KIND=quai (existing behaviour unchanged)', async () => {
    const loadConfig = await freshLoadConfig();
    const cfg = loadConfig({
      ...baseEnv,
      CHAIN_KIND: 'quai',
      QI_MNEMONIC: 'test test test test test test test test test test test junk',
      QI_RPC_URL: 'https://qi-cyprus1.quai.network',
    } as NodeJS.ProcessEnv);
    expect(cfg.QI_MNEMONIC).toBe('test test test test test test test test test test test junk');
  });

  it('still allows QI_* variables when CHAIN_KIND is unset (default "quai")', async () => {
    const loadConfig = await freshLoadConfig();
    const cfg = loadConfig({
      ...baseEnv,
      QI_MNEMONIC: 'test test test test test test test test test test test junk',
      QI_RPC_URL: 'https://qi-cyprus1.quai.network',
    } as NodeJS.ProcessEnv);
    expect(cfg.CHAIN_KIND).toBe('quai');
    expect(cfg.QI_RPC_URL).toBe('https://qi-cyprus1.quai.network');
  });
});
