import { getZoneForAddress, getAddress as quaisGetAddress } from 'quais';
import { normalizeAddressForKind, type ChainAddressKind } from '../util/address.js';
import type { Merchant, MerchantPayoutAddress, PayoutAddressSource } from '../types.js';
import type { Store } from '../store/index.js';

/** The minimum a chain must expose to be able to answer "can this address receive here?".
 *  Structural, so both a configured ChainConfig and the API layer's ResolvedChain (which
 *  deliberately carries only what requests need) satisfy it. */
export interface PayoutChainRef {
  chainId: number;
  /** Disabled chains never get a client or an indexer, so they are never offered as a payout
   *  destination. Optional so the API's ResolvedChain (always enabled) still satisfies this. */
  enabled?: boolean;
  kind: ChainAddressKind;
  name: string;
  /** Quai only: the zone this chain serves. Undefined means "unknown", not "any" — see below. */
  zone?: string;
}

/**
 * Where a merchant's money lands on each chain.
 *
 * A merchant's IDENTITY address (merchants.address) is the single wallet they sign in and register
 * with. That is not necessarily where they get paid: one identity can take Quai payments at a
 * Quai-zone address and Robinhood/Base payments at an EVM address. This module owns the two
 * decisions that follow from that split:
 *
 *   1. validatePayoutAddress — is `address` actually receivable on `chain`?
 *   2. resolveSettlementAddress — for a link on `chain`, whose address gets paid?
 *
 * ## What "valid on this chain" means, precisely
 *
 * The two address families are NOT cleanly distinguishable. Both are 20-byte hex, and the only
 * structural difference is that a Quai address encodes its zone in the prefix byte. `ethers.getAddress`
 * happily accepts a Quai-checksummed address (`0x002dB0...`) because it is a valid EVM address — and
 * it genuinely IS receivable on Base or Robinhood. Meanwhile a lowercase address carries no checksum
 * at all, so both libraries normalize it to the same bytes.
 *
 * So validation is per-chain-kind, and the two directions are deliberately asymmetric:
 *
 *   - **Quai chain** — HARD requirements. The address must be a valid Quai zone address AND its zone
 *     must be the one this chain serves. Getting the zone wrong is unrecoverable: a Cyprus-2 address
 *     on a Cyprus-1 link is simply not an account on that network, so the funds land nowhere. This is
 *     the check that actually protects the merchant.
 *   - **EVM chain** — a plain valid 20-byte address is sufficient, whatever its checksum flavor. A
 *     merchant may deliberately point a Base link at the same bytes they use on Quai. Forcing that
 *     to be rejected would be inventing a restriction the chain does not have.
 *
 * Note what is deliberately NOT here: the chain-free rule that {@link normalizeAddressAnyKind}
 * encodes. That rule was correct while identity and payout were the same address, but it answers the
 * wrong question now — it never tells us whether an address is receivable on ONE specific chain.
 */

/** Quai address prefix byte -> zone name. Cyprus-1..3 are the only zones a Quai network address can
 *  carry; `getZoneForAddress` returns null for any other prefix. */
const ZONE_BYTES: Record<string, string> = {
  '0x00': 'cyprus1',
  '0x01': 'cyprus2',
  '0x02': 'cyprus3',
};

export class InvalidPayoutAddressError extends Error {}

/**
 * The zone an address belongs to, or undefined when it is not a valid Quai zone address.
 * Exported for tests and for error messages that want to name the expected zone.
 */
export function quaiZoneOf(address: string): string | undefined {
  let zone: string | null;
  try {
    zone = getZoneForAddress(address);
  } catch {
    return undefined;
  }
  if (!zone) return undefined;
  return ZONE_BYTES[zone.slice(0, 4).toLowerCase()];
}

/**
 * Validate that `address` can receive funds on `chain`, returning its normalized form.
 *
 * Throws {@link InvalidPayoutAddressError} with a message written to be shown to a merchant.
 */
export function validatePayoutAddress(chain: PayoutChainRef, address: string): string {
  if (chain.kind === 'evm') {
    // Any valid 20-byte address is receivable here — including one checksummed the Quai way.
    try {
      return normalizeAddressForKind('evm' as ChainAddressKind, address);
    } catch {
      throw new InvalidPayoutAddressError(`${address} is not a valid ${chain.name} address`);
    }
  }

  // Quai: the check that matters is zone CONSISTENCY. A Cyprus-2 address on a Cyprus-1 link is not
  // an account on that network at all, so the payment can never settle — that is unrecoverable and
  // we can detect it here, which is the whole point of validating per chain.
  //
  // An address with NO zone claim (getZoneForAddress returns null — an ordinary 20-byte EVM
  // address, which is what a key derived outside a configured Quai network produces) is accepted.
  // We cannot prove it is wrong: whether the Quai runtime honours it is a property of the network,
  // not something this layer can decide, and the contract rejects it at settlement if not. Refusing
  // to create the link would block a merchant over something only the chain can adjudicate.
  const zone = quaiZoneOf(address);
  const expected = chain.zone;
  if (zone && expected && zone.toLowerCase() !== expected.toLowerCase()) {
    throw new InvalidPayoutAddressError(
      `${address} is a ${zone.toUpperCase()} address but ${chain.name} is ${expected.toUpperCase()}`,
    );
  }
  // Normalization is cosmetic here — every payout address is stored lowercased and the contract
  // validates it at settlement. Try both checksum schemes so a well-formed address comes back in
  // canonical form, and fall back to the input rather than failing: a mixed-case address whose
  // checksum matches neither scheme is a cosmetic problem, not a fund-safety one, and the zone
  // consistency check above is what actually protects the payment.
  try {
    return normalizeAddressForKind('quai' as ChainAddressKind, address);
  } catch {
    try {
      return normalizeAddressForKind('evm' as ChainAddressKind, address);
    } catch {
      return address.trim();
    }
  }
}

/** Whether `address` is receivable on `chain`, without throwing. */
export function isValidPayoutAddress(chain: PayoutChainRef, address: string): boolean {
  try {
    validatePayoutAddress(chain, address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Which chains a merchant's identity address is automatically used as the payout for.
 *
 * Validation is permissive (a Quai address is a valid EVM address), but AUTO-SEEDING is not. We
 * only seed a chain when the address FAMILY matches the chain:
 *   - a Quai login (recognisable by its zone prefix) seeds only Quai chains whose zone it fits;
 *   - an EVM login seeds only EVM chains.
 *
 * The asymmetry is deliberate. Silently paying a Pelagus merchant's Quai address on Base would
 * technically settle, but Pelagus cannot show or sweep those funds — the money would sit in an
 * address the merchant's own wallet does not display, with no error anywhere. Declaring that
 * address on purpose is fine and allowed; inferring it is not.
 *
 * Never overwrites anything — see {@link seedIdentityPayoutAddresses}.
 */
export function seedableChainsFor<T extends PayoutChainRef>(chains: T[], identityAddress: string): T[] {
  const familyIsQuai = quaiZoneOf(identityAddress) !== undefined;
  return chains.filter(
    (c) =>
      c.enabled !== false &&
      (familyIsQuai ? c.kind === 'quai' : c.kind === 'evm') &&
      isValidPayoutAddress(c, identityAddress),
  );
}

/**
 * Record which chains a merchant can receive on at their identity address, without clobbering
 * anything they configured by hand. Idempotent, and safe to call on every read.
 *
 * Only writes MISSING rows, so a merchant who deliberately set a different address for a chain keeps
 * it — including after their identity address changes.
 */
export async function seedIdentityPayoutAddresses(
  store: Pick<Store, 'listPayoutAddresses' | 'setPayoutAddress'>,
  merchant: Merchant,
  chains: PayoutChainRef[],
  now: number,
): Promise<void> {
  const existing = new Set((await store.listPayoutAddresses(merchant.merchantId)).map((r) => r.chainId));
  for (const chain of seedableChainsFor(chains, merchant.address)) {
    if (existing.has(chain.chainId)) continue;
    try {
      await store.setPayoutAddress({
        merchantId: merchant.merchantId,
        chainId: chain.chainId,
        address: validatePayoutAddress(chain, merchant.address),
        source: 'login',
        createdAt: now,
      });
    } catch {
      // Cannot serve this chain — leave it unconfigured so the resolver reports it as such.
    }
  }
}

/**
 * Resolve the address a payment on `chain` should pay out to.
 *
 * Two distinct merchants are handled here, and conflating them is the whole bug this guards:
 *
 *   - LEGACY (no payout rows at all): a merchant who onboarded before per-chain payouts existed.
 *     They have exactly one chain and their identity address IS that chain's destination. Fall
 *     back to it on every chain, so nothing they already published stops working.
 *
 *   - MULTICHAIN (has at least one payout row): the map is now authoritative. If this chain has
 *     no row, we do NOT silently fall back to the identity address — the merchant has told us
 *     where their money goes per chain, and guessing here is how a link ends up paying an address
 *     the merchant never nominated for that chain. Return nothing and let the caller refuse.
 *
 * A row that exists but is invalid for its own chain falls back to the identity address: the row
 * is unusable, but the merchant still needs *some* valid destination rather than a hard stop.
 */
export function resolveSettlementAddress(
  merchant: Merchant,
  chain: PayoutChainRef,
  configured: MerchantPayoutAddress[],
): string | undefined {
  const row = configured.find((r) => r.chainId === chain.chainId);
  if (row) {
    try {
      return validatePayoutAddress(chain, row.address);
    } catch {
      return fallbackToIdentity(merchant, chain);
    }
  }
  // No row for this chain. Only a merchant with no map at all gets the identity fallback.
  if (configured.length > 0) return undefined;
  return fallbackToIdentity(merchant, chain);
}

function fallbackToIdentity(merchant: Merchant, chain: PayoutChainRef): string | undefined {
  try {
    return validatePayoutAddress(chain, merchant.address);
  } catch {
    return undefined;
  }
}

/** Re-exported so callers validating a merchant's declared Quai address can report its zone. */
export { quaisGetAddress };