import { getAddress as quaisGetAddress, verifyMessage as quaisVerifyMessage } from 'quais';
import { getAddress as ethersGetAddress, verifyMessage as ethersVerifyMessage } from 'ethers';
import type { Config } from '../config.js';

/**
 * Chain-kind-aware address/signature helpers.
 *
 * quais.getAddress / quais.verifyMessage apply Quai's own zone-aware address rules, which can
 * reject a perfectly valid plain-EVM address or signature from a standard chain (see
 * CHAIN_AUDIT.md §4.4). The *ForKind functions below pick quais vs ethers from an explicit chain
 * kind — the kind of whichever chain is actually relevant to the call (a link's chain, an
 * order's chain, the chain a login challenge/signature is bound to), not a single global
 * setting, since one process now serves many chains at once (chains.ts).
 */
export type ChainAddressKind = 'quai' | 'evm';

/** EIP-55 (kind "evm") or Quai zone-checksum (kind "quai") address normalization for a SPECIFIC
 *  chain kind. Throws on an invalid address, exactly like quais.getAddress / ethers.getAddress. */
export function normalizeAddressForKind(kind: ChainAddressKind, address: string): string {
  return kind === 'evm' ? ethersGetAddress(address) : quaisGetAddress(address);
}

/** Recovers the signer of a personal-message signature, verified under a SPECIFIC chain kind.
 *  Throws on malformed input, exactly like quais.verifyMessage / ethers.verifyMessage. */
export function recoverMessageSignerForKind(kind: ChainAddressKind, message: string, signature: string): string {
  return kind === 'evm' ? ethersVerifyMessage(message, signature) : quaisVerifyMessage(message, signature);
}

/**
 * For a genuinely chain-less context — a merchant payout address, which is valid across every
 * EVM chain plus Quai (product rule: merchants are chain-free, see CHAIN_AUDIT.md and
 * chains.ts) — accepts the address if it validates under EITHER rule set. Tries EIP-55 first
 * (the common case going forward); a mixed-case address checksummed the Quai-zone way would
 * fail EIP-55 validation, so it falls back to quais.getAddress before giving up. Both
 * implementations normalize any valid-length hex string the same way once checksum validation
 * passes (an all-lowercase or all-uppercase input needs no checksum match at all), so which
 * branch actually accepts a given address never changes the resulting bytes — only, sometimes,
 * which of the two equally-valid capitalizations is returned. Throws only if NEITHER accepts it.
 */
export function normalizeAddressAnyKind(address: string): string {
  try {
    return ethersGetAddress(address);
  } catch {
    return quaisGetAddress(address); // throws its own error if this also fails
  }
}

/** Back-compat wrapper kept for the legacy single-chain path: chooses quais vs ethers from a
 *  global CHAIN_KIND-shaped config, exactly as before this file grew chain-aware variants.
 *  Behaviour under CHAIN_KIND=quai (the default, including every config that doesn't set
 *  CHAIN_KIND at all) is byte-for-byte identical to calling quais directly. */
export function normalizeAddress(cfg: Pick<Config, 'CHAIN_KIND'>, address: string): string {
  return normalizeAddressForKind(cfg.CHAIN_KIND === 'evm' ? 'evm' : 'quai', address);
}

/** Back-compat wrapper — see {@link normalizeAddress}. */
export function recoverMessageSigner(cfg: Pick<Config, 'CHAIN_KIND'>, message: string, signature: string): string {
  return recoverMessageSignerForKind(cfg.CHAIN_KIND === 'evm' ? 'evm' : 'quai', message, signature);
}
