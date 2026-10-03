import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Wallet as QuaisWallet } from 'quais';
import { Wallet as EthersWallet } from 'ethers';
import {
  validatePayoutAddress,
  isValidPayoutAddress,
  quaiZoneOf,
  seedableChainsFor,
  resolveSettlementAddress,
  InvalidPayoutAddressError,
} from '../src/settlement/payout.js';
import type { ChainConfig } from '../src/chains.js';
import type { Merchant, MerchantPayoutAddress } from '../src/types.js';

const chain = (over: Partial<ChainConfig> = {}): ChainConfig =>
  ({
    id: 'quai',
    chainId: 9,
    kind: 'quai',
    zone: 'cyprus1',
    name: 'Quai (Cyprus-1)',
    rpcUrl: 'https://rpc.quai.network/cyprus1',
    contractAddress: '0x0072174EF6d0C2EB605449b0014169D104c42BbC',
    confirmations: 12,
    pollIntervalMs: 5000,
    maxBlockRange: 2000,
    enabled: true,
    ...over,
  }) as ChainConfig;

const baseSepolia = chain({
  id: 'base-sepolia',
  chainId: 84532,
  kind: 'evm',
  zone: undefined,
  name: 'Base Sepolia (testnet)',
  rpcUrl: 'https://sepolia.base.org',
  contractAddress: '0x0000000000000000000000000000000000000000',
});

const robinhood = chain({
  id: 'robinhood-testnet',
  chainId: 46630,
  kind: 'evm',
  zone: undefined,
  name: 'Robinhood Chain (testnet)',
  rpcUrl: 'https://rpc.testnet.chain.robinhood.com/rpc',
  contractAddress: '0x0000000000000000000000000000000000000000',
});

// A real Cyprus-1 zone address (prefix 0x00) and a real Cyprus-2 one (prefix 0x01).
const quaiCyprus1 = '0x002dB0fBCA5a3DC1336e5D00ABCbCd9daac9cFF6';
const quaiCyprus2 = '0x012dB0fBCA5a3DC1336e5D00ABCbCd9daac9cFF6';

const merchant = (over: Partial<Merchant> = {}): Merchant => ({
  merchantId: 'mch_1',
  address: quaiCyprus1.toLowerCase(),
  name: 'Acme',
  webhookUrl: 'https://example.test/webhook',
  webhookSecret: 'whsec_x',
  active: true,
  createdAt: 1,
  ...over,
});

describe('quaiZoneOf', () => {
  it('reads the zone byte out of a Quai address', () => {
    expect(quaiZoneOf(quaiCyprus1)).toBe('cyprus1');
    expect(quaiZoneOf(quaiCyprus2)).toBe('cyprus2');
  });

  it('returns undefined for an address with no valid Quai zone prefix', () => {
    // 0x03 and above are not Quai zones.
    expect(quaiZoneOf('0x032dB0fBCA5a3DC1336e5D00ABCbCd9daac9cFF6')).toBeUndefined();
  });
});

describe('validatePayoutAddress', () => {
  it('accepts and EIP-55 normalizes a plain EVM address on an EVM chain', () => {
    const w = new EthersWallet('0x' + randomBytes(32).toString('hex')).address;
    const out = validatePayoutAddress(baseSepolia, w);
    expect(out).toBe(w);
    expect(out).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('rejects a malformed EVM address', () => {
    expect(() => validatePayoutAddress(baseSepolia, '0x1234')).toThrow(InvalidPayoutAddressError);
  });

  it('accepts a Cyprus-1 address on the Cyprus-1 chain', () => {
    expect(validatePayoutAddress(chain(), quaiCyprus1)).toBeTruthy();
  });

  it('rejects a Cyprus-2 address on the Cyprus-1 chain, naming both zones', () => {
    let msg = '';
    try {
      validatePayoutAddress(chain(), quaiCyprus2);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('CYPRUS2');
    expect(msg).toContain('CYPRUS1');
  });

  it('accepts an address that carries no zone claim — only the chain can adjudicate that', () => {
    // A key derived outside a configured Quai network yields an ordinary 20-byte address. We
    // cannot prove it is unusable, and the contract rejects it at settlement if it is.
    expect(validatePayoutAddress(chain(), '0x' + 'ab'.repeat(20))).toBeTruthy();
  });

  it('accepts a Quai-checksummed address on an EVM chain — it really is receivable there', () => {
    // Asymmetry worth stating explicitly: the reverse direction is NOT an error. A Quai address is
    // a valid 20-byte EVM address, so a merchant may point a Base link at those same bytes.
    expect(validatePayoutAddress(baseSepolia, quaiCyprus1)).toBeTruthy();
  });

  it('still accepts any valid Quai zone when the chain declares no zone', () => {
    // A Quai chain configured without `zone` cannot prove a match, so it accepts rather than
    // rejecting every payout outright.
    const zonedless = chain({ zone: undefined });
    expect(validatePayoutAddress(zonedless, quaiCyprus2)).toBeTruthy();
  });
});

describe('isValidPayoutAddress', () => {
  it('mirrors validatePayoutAddress without throwing', () => {
    expect(isValidPayoutAddress(chain(), quaiCyprus1)).toBe(true);
    expect(isValidPayoutAddress(chain(), quaiCyprus2)).toBe(false);
    expect(isValidPayoutAddress(baseSepolia, quaiCyprus1)).toBe(true);
  });
});

describe('seedableChainsFor', () => {
  const chains = [chain(), baseSepolia, robinhood, chain({ id: 'x', chainId: 10, zone: 'cyprus2', enabled: false })];

  it('seeds only Quai chains for a Quai identity address', () => {
    const out = seedableChainsFor(chains, quaiCyprus1.toLowerCase()).map((c) => c.id);
    expect(out).toEqual(['quai']);
  });

  it('skips disabled chains', () => {
    const evm = new EthersWallet('0x' + randomBytes(32).toString('hex')).address.toLowerCase();
    expect(seedableChainsFor(chains, evm).map((c) => c.id)).not.toContain('x');
  });

  it('excludes a Quai chain in a different zone', () => {
    // The Cyprus-2 chain is disabled here; enable it and a Cyprus-1 identity still must not match.
    const c2 = chain({ id: 'cyprus2-chain', chainId: 10, zone: 'cyprus2' });
    const out = seedableChainsFor([c2], quaiCyprus1.toLowerCase());
    expect(out).toHaveLength(0);
  });

  it('seeds EVM chains for an EVM identity address', () => {
    const evm = new EthersWallet('0x' + randomBytes(32).toString('hex')).address.toLowerCase();
    const out = seedableChainsFor(chains, evm).map((c) => c.id);
    expect(out).toContain('base-sepolia');
    expect(out).toContain('robinhood-testnet');
  });
});

describe('resolveSettlementAddress', () => {
  const row = (over: Partial<MerchantPayoutAddress> = {}): MerchantPayoutAddress => ({
    merchantId: 'mch_1',
    chainId: 9,
    address: quaiCyprus1.toLowerCase(),
    source: 'declared',
    createdAt: 2,
    ...over,
  });

  it('prefers the configured destination for that chain', () => {
    const evm = new EthersWallet('0x' + randomBytes(32).toString('hex')).address;
    const out = resolveSettlementAddress(merchant(), baseSepolia, [row({ chainId: 84532, address: evm })]);
    expect(out).toBe(evm);
  });

  it('falls back to the identity address when no row exists for the chain', () => {
    // The legacy path: merchants that never configured a payout address must keep working.
    expect(resolveSettlementAddress(merchant(), chain(), [])).toBeTruthy();
  });

  it('lets a Quai identity address settle on a plain EVM chain — those bytes are receivable', () => {
    // The one cross-family direction that is genuinely fine: an EVM chain imposes no zone rule.
    expect(resolveSettlementAddress(merchant(), baseSepolia, [])).toBeTruthy();
  });

  it('returns undefined when nothing valid exists for the chain', () => {
    // A Quai chain the merchant cannot receive on at all: identity address is the wrong zone and
    // there is no configured row.
    const cyp2 = chain({ id: 'cyprus2-chain', chainId: 10, zone: 'cyprus2' });
    expect(resolveSettlementAddress(merchant(), cyp2, [])).toBeUndefined();
  });

  it('falls back to the identity address when a configured row is invalid for its own chain', () => {
    // Better than reporting failure: a wrong row still leaves a usable destination behind.
    expect(resolveSettlementAddress(merchant(), chain(), [row({ chainId: 9, address: '0x' + 'ab'.repeat(20) })])).toBeTruthy();
  });

  it('refuses a chain the merchant has not configured once they have a map', () => {
    // A row for another chain must not be borrowed, and neither must the identity address: the
    // merchant nominated destinations per chain, so an unnamed chain is a question, not a guess.
    const evm = new EthersWallet('0x' + randomBytes(32).toString('hex')).address;
    expect(resolveSettlementAddress(merchant(), baseSepolia, [row({ chainId: 46630, address: evm })])).toBeUndefined();
  });

  it('lets an EVM identity address settle on any EVM chain', () => {
    const evm = new EthersWallet('0x' + randomBytes(32).toString('hex')).address;
    const m = merchant({ address: evm.toLowerCase() });
    expect(resolveSettlementAddress(m, baseSepolia, [])).toBe(evm);
    expect(resolveSettlementAddress(m, robinhood, [])).toBe(evm);
  });

  it('keeps a Quai payout on Quai while the same identity also takes Base payments', () => {
    // The end-to-end point of the split: one identity, two explicitly declared destinations,
    // neither borrowed from the other chain.
    const evm = new EthersWallet('0x' + randomBytes(32).toString('hex')).address;
    const m = merchant();
    const configured = [
      row({ chainId: chain().chainId, address: quaiCyprus1, source: 'declared' }),
      row({ chainId: 84532, address: evm, source: 'declared' }),
    ];
    expect(resolveSettlementAddress(m, chain(), configured)).toBeTruthy(); // Quai -> its own payout
    expect(resolveSettlementAddress(m, baseSepolia, configured)).toBe(evm); // Base -> its own payout
  });
});

describe('payout addresses vs a live Quai wallet', () => {
  it('round-trips a real Cyprus-1 address through validation and resolution', () => {
    expect(quaiZoneOf(quaiCyprus1)).toBe('cyprus1');
    expect(validatePayoutAddress(chain(), quaiCyprus1)).toBeTruthy();
    expect(resolveSettlementAddress(merchant({ address: quaiCyprus1.toLowerCase() }), chain(), [])).toBeTruthy();
  });

  it('treats a zoneless derived address as EVM-family and never seeds it onto Quai', () => {
    // A key handed to Quai's Wallet outside a configured network derives an ordinary 20-byte
    // address with no zone prefix. It is usable as an EVM payout, and — crucially for the seeding
    // rule — it is NOT treated as a Quai identity, so it is never auto-propagated to a Quai link
    // where the merchant's Pelagus wallet would not show the funds.
    const w = new QuaisWallet('0x' + randomBytes(32).toString('hex'));
    expect(quaiZoneOf(w.address)).toBeUndefined();
    expect(isValidPayoutAddress(baseSepolia, w.address)).toBe(true);
    expect(seedableChainsFor([chain(), baseSepolia], w.address.toLowerCase()).map((c) => c.id)).toEqual(['base-sepolia']);
  });
});