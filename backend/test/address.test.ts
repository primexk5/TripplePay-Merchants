import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Wallet as QuaisWallet, getAddress as quaisGetAddress } from 'quais';
import { Wallet as EthersWallet, getAddress as ethersGetAddress } from 'ethers';
import { normalizeAddress, recoverMessageSigner } from '../src/util/address.js';
import type { Config } from '../src/config.js';

const quaiCfg = { CHAIN_KIND: 'quai' } as unknown as Config;
const evmCfg = { CHAIN_KIND: 'evm' } as unknown as Config;
// A config that never sets CHAIN_KIND at all — every existing test fixture in this repo builds
// its fake Config this way, so behaviour here must match the 'quai' path exactly.
const unsetCfg = {} as unknown as Config;

// quais' alpha API has no Wallet.createRandom — construct from a fresh random key (same
// workaround already used in test/auth.test.ts and test/links.test.ts).
function freshQuaisWallet(): QuaisWallet {
  return new QuaisWallet('0x' + randomBytes(32).toString('hex'));
}

describe('normalizeAddress', () => {
  it('checksums a valid address like quais.getAddress under CHAIN_KIND=quai', () => {
    const addr = '0x00000000000000000000000000000000000000a1';
    expect(normalizeAddress(quaiCfg, addr)).toBe(quaisGetAddress(addr));
  });

  it('checksums a valid address like quais.getAddress when CHAIN_KIND is unset (default)', () => {
    const addr = '0x00000000000000000000000000000000000000a1';
    expect(normalizeAddress(unsetCfg, addr)).toBe(quaisGetAddress(addr));
  });

  it('checksums a valid address like ethers.getAddress under CHAIN_KIND=evm', () => {
    // No 0x00 zone prefix — a plain standard-EVM address.
    const addr = '0xe2C0d033102B7ad963deC4b44B5e1e94bca1385f';
    expect(normalizeAddress(evmCfg, addr)).toBe(ethersGetAddress(addr));
  });

  it('throws on a malformed address under both chain kinds', () => {
    expect(() => normalizeAddress(quaiCfg, '0x123')).toThrow();
    expect(() => normalizeAddress(evmCfg, '0x123')).toThrow();
  });
});

describe('recoverMessageSigner', () => {
  it('recovers the same signer as quais.verifyMessage under CHAIN_KIND=quai', async () => {
    const wallet = freshQuaisWallet();
    const message = 'tripplepay-login:test-message';
    const signature = await wallet.signMessage(message);
    expect(recoverMessageSigner(quaiCfg, message, signature)).toBe(wallet.address);
  });

  it('recovers the same signer as quais.verifyMessage when CHAIN_KIND is unset (default)', async () => {
    const wallet = freshQuaisWallet();
    const message = 'tripplepay-login:test-message';
    const signature = await wallet.signMessage(message);
    expect(recoverMessageSigner(unsetCfg, message, signature)).toBe(wallet.address);
  });

  it('recovers the same signer as ethers.verifyMessage under CHAIN_KIND=evm', async () => {
    const wallet = EthersWallet.createRandom();
    const message = 'tripplepay-login:test-message';
    const signature = await wallet.signMessage(message);
    expect(recoverMessageSigner(evmCfg, message, signature)).toBe(wallet.address);
  });

  it('throws on a garbage signature under both chain kinds', () => {
    expect(() => recoverMessageSigner(quaiCfg, 'x', '0xdeadbeef')).toThrow();
    expect(() => recoverMessageSigner(evmCfg, 'x', '0xdeadbeef')).toThrow();
  });
});
