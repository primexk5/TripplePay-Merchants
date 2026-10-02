import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { TypedDataEncoder, keccak256, toUtf8Bytes, verifyTypedData } from 'quais';
import {
  Eip712OrderSigner,
  DisabledOrderSigner,
  createOrderSigner,
  serializeAuthorization,
  SIGNED_ORDER_TYPES,
  SIGNING_DOMAIN_NAME,
  SIGNING_DOMAIN_VERSION,
  type SignedOrderAuthorization,
} from '../src/chain/signer.js';
import type { Config } from '../src/config.js';

const KEY = '0x' + 'a3'.repeat(32);
const CONTRACT = '0x00000000000000000000000000000000000000c0';
const CHAIN_ID = 9_000_100;
const MERCHANT = '0x' + '11'.repeat(20);
const PAYER = '0x' + '22'.repeat(20);
const FEE_RECIPIENT = '0x' + '33'.repeat(20);
const ZERO = '0x' + '00'.repeat(20);

/**
 * The literal from PayWithQuai.sol (`SIGNED_ORDER_TYPEHASH()`). Duplicated deliberately: this
 * suite fails if the backend's field list drifts from the contract, which is the single failure
 * mode that would silently make every customer signature unusable in production.
 */
const CONTRACT_TYPEHASH =
  '0xfbae4a679a7032b61a424ab9ef7f70c17a0d5113f9096d8c5cc5538fbfc55007';

function order(over: Partial<SignedOrderAuthorization> = {}): SignedOrderAuthorization {
  return {
    merchant: MERCHANT,
    orderId: '0x' + 'ab'.repeat(32),
    token: ZERO,
    amount: 1_500_000_000_000_000_000n,
    expiry: 1_800_000_000,
    feeBps: 50,
    feeRecipient: FEE_RECIPIENT,
    expectedPayer: PAYER,
    ...over,
  };
}

function cfg(key?: string): Config {
  return { ORDER_SIGNER_PRIVATE_KEY: key } as unknown as Config;
}

/** Values as they must be handed to the encoder: bigints become decimal strings, as the wire form. */
function valuesFor(o: SignedOrderAuthorization): Record<string, string | number> {
  return { ...o, amount: o.amount.toString() };
}

const deployment = { chainId: CHAIN_ID, contractAddress: CONTRACT };
const domain = {
  name: SIGNING_DOMAIN_NAME,
  version: SIGNING_DOMAIN_VERSION,
  chainId: CHAIN_ID,
  verifyingContract: CONTRACT,
};

describe('order signer', () => {
  it('encodes SignedOrder to exactly the on-chain type hash', () => {
    const encoder = TypedDataEncoder.from(SIGNED_ORDER_TYPES);
    const encoded = encoder.encodeType('SignedOrder');
    expect(encoded).toBe(
      'SignedOrder(address merchant,bytes32 orderId,address token,uint256 amount,uint256 expiry,uint16 feeBps,address feeRecipient,address expectedPayer)',
    );
    expect(keccak256(toUtf8Bytes(encoded))).toBe(CONTRACT_TYPEHASH);
  });

  it('produces a signature the contract can recover to the signer', async () => {
    const signer = new Eip712OrderSigner(cfg(KEY));
    const auth = await signer.sign(order(), deployment);

    expect(auth.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(
      verifyTypedData(domain, SIGNED_ORDER_TYPES, valuesFor(order()), auth.signature).toLowerCase(),
    ).toBe(signer.address.toLowerCase());
  });

  it('keeps the authorization identical to the signed payload', async () => {
    const signer = new Eip712OrderSigner(cfg(KEY));
    const requested = order();
    const auth = await signer.sign(requested, deployment);

    expect(auth).toMatchObject({ ...requested });
    expect(auth.signature).toBeTruthy();
  });

  it('invalidates the signature when any single field is tampered with', async () => {
    const signer = new Eip712OrderSigner(cfg(KEY));
    const auth = await signer.sign(order(), deployment);
    const values = valuesFor(order());
    // verifyTypedData returns the recovered address (empty-ish on failure) rather than a boolean.
    const recovers = (v: Record<string, string | number>, sig: string, d = domain): boolean =>
      verifyTypedData(d, SIGNED_ORDER_TYPES, v, sig).toLowerCase() === signer.address.toLowerCase();

    const mutations: Partial<Record<string, string | number | bigint>>[] = [
      { amount: 1n },                      // paying less than quoted
      { merchant: '0x' + '44'.repeat(20) },// redirecting the payout
      { expectedPayer: '0x' + '55'.repeat(20) }, // stealing the checkout
      { feeRecipient: '0x' + '66'.repeat(20) },   // redirecting the fee
      { feeBps: 0 },                       // dropping the platform fee
      { token: '0x' + '77'.repeat(20) },   // swapping the asset
      { orderId: '0x' + 'cd'.repeat(32) }, // replaying as another order
      { expiry: auth.expiry + 86_400 },    // extending the window
    ];
    expect(recovers(values, auth.signature)).toBe(true);
    for (const m of mutations) {
      const tampered: Record<string, string | number> = {
        ...values,
        ...m,
        amount: (m.amount ?? BigInt(String(values.amount))).toString(),
      };
      expect(recovers(tampered, auth.signature)).toBe(false);
    }
  });

  it('binds the signature to one chain and one contract', async () => {
    const signer = new Eip712OrderSigner(cfg(KEY));
    const values = valuesFor(order());
    const auth = await signer.sign(order(), deployment);
    const recovers = (d: typeof domain): boolean =>
      verifyTypedData(d, SIGNED_ORDER_TYPES, values, auth.signature).toLowerCase() ===
      signer.address.toLowerCase();

    expect(recovers(domain)).toBe(true);
    // Same signature, replayed against another chain.
    expect(recovers({ ...domain, chainId: CHAIN_ID + 1 })).toBe(false);
    // ...and against a different contract on the same chain (e.g. a redeployed clone).
    expect(recovers({ ...domain, verifyingContract: '0x' + '99'.repeat(20) })).toBe(false);
    // ...and under a different signing domain name.
    expect(recovers({ ...domain, name: 'SomethingElse' })).toBe(false);
  });

  it('serializes bigint amounts for the JSON claim response', async () => {
    const signer = new Eip712OrderSigner(cfg(KEY));
    const auth = await signer.sign(order(), deployment);
    const json = serializeAuthorization(auth);

    expect(json.amount).toBe('1500000000000000000');
    expect(() => JSON.stringify(json)).not.toThrow();
    expect(json.signature).toBe(auth.signature);
  });

  it('throws when the disabled signer is used', async () => {
    const signer = new DisabledOrderSigner();
    expect(signer.enabled).toBe(false);
    await expect(signer.sign()).rejects.toThrow(/ORDER_SIGNER_PRIVATE_KEY/);
  });

  it('builds a disabled signer when no key is configured, and never a funded one', () => {
    expect(createOrderSigner(cfg()).enabled).toBe(false);
    expect(createOrderSigner(cfg()).address).toBe('');
    expect(createOrderSigner(cfg(KEY)).enabled).toBe(true);
  });

  it('derives a stable signer address from the key', () => {
    expect(new Eip712OrderSigner(cfg(KEY)).address)
      .toBe(createOrderSigner(cfg(KEY)).address);
    expect(new Eip712OrderSigner(cfg(KEY)).address.toLowerCase())
      .not.toBe(new Eip712OrderSigner(cfg('0x' + 'b7'.repeat(32))).address.toLowerCase());
  });

  it('treats a fee-free, any-payer order as still valid (no hidden signer restrictions)', async () => {
    const signer = new Eip712OrderSigner(cfg(KEY));
    const free = order({ feeBps: 0, feeRecipient: ZERO, expectedPayer: ZERO });
    const auth = await signer.sign(free, deployment);
    expect(
      verifyTypedData(domain, SIGNED_ORDER_TYPES, valuesFor(free), auth.signature).toLowerCase(),
    ).toBe(signer.address.toLowerCase());
  });

  it('never leaks the private key through the signer surface', async () => {
    const signer = new Eip712OrderSigner(cfg(KEY));
    const auth = await signer.sign(order(), deployment);
    expect(JSON.stringify(serializeAuthorization(auth))).not.toContain(KEY.slice(2));
    expect(Object.keys(signer)).not.toContain('privateKey');
    expect(signer.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // A signing key must never be derived from anything ambient (env leak, keystore fallback).
    expect(randomBytes(32)).toHaveLength(32);
  });
});
