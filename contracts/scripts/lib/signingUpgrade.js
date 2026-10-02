/**
 * Signing-upgrade decision logic, kept separate from `upgrade.js` so it can be unit-tested
 * against a real pre-signed-era proxy instead of only being exercised on a live network.
 *
 * The subtle part this exists for: on a deployment that has never been upgraded to the signed
 * implementation, the proxy delegates `signingInitialized()` to an implementation that has no
 * such function and no fallback — the call reverts. That is the NORMAL case before the first
 * upgrade, not a failure, and treating it as an error aborts the upgrade that would fix it.
 */

/** MUST match the backend's SIGNING_DOMAIN_* and the contract's initializeSigning arguments. */
const SIGNING_DOMAIN_NAME = 'PayWithQuai';
const SIGNING_DOMAIN_VERSION = '1';

/** EIP-1967 implementation slot, used to confirm the proxy really points at the new code. */
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

/**
 * Substrings that mark a failure as transport-level (the RPC never answered). Only these are
 * worth retrying, and only these may NOT be interpreted as "the function said no".
 */
const TRANSPORT_HINTS = [
  'could not detect network',
  'econnrefused',
  'econnreset',
  'etimedout',
  'socket hang up',
  'fetch failed',
  'network error',
  'bad response',
  'rate limit',
  'timeout',
  'load failed',
];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Distinguishes "the node/transport failed" from "the contract rejected or lacks the call".
 *
 * Revert-shaped messages that MUST NOT be treated as transport errors: "execution reverted",
 * "missing revert data", "function selector was not recognized", "without a reason".
 */
function isTransportError(err) {
  const message = String((err && (err.message || err.reason)) || err || '').toLowerCase();
  return TRANSPORT_HINTS.some((hint) => message.includes(hint));
}

/**
 * True when the EIP-712 domain is live on the given proxy/contract handle.
 *
 * Returns false — rather than throwing — when the call is answered with a revert or with no
 * matching function: that is what a pre-signed-era proxy does, and it means "not initialized".
 * Transport failures are retried, then rethrown, because those say nothing about chain state.
 *
 * @param {{ signingInitialized: () => Promise<bigint | boolean> }} reader
 */
async function readSigningInitialized(reader, opts = {}) {
  const tries = opts.tries ?? 5;
  const onRetry = opts.onRetry;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return (await reader.signingInitialized()).toString() === 'true';
    } catch (err) {
      if (!isTransportError(err)) {
        return false;
      }
      if (attempt === tries) throw err;
      if (onRetry) onRetry(attempt, tries, err);
      await delay(2000 * attempt);
    }
  }
  return false;
}

/**
 * Calldata for `upgradeToAndCall`: initialize the signing domain when it isn't live yet, and pass
 * EMPTY calldata when it already is.
 *
 * `initializeSigning` is a reinitializer and can only be consumed once, so re-running the upgrade
 * with the initializer again reverts the whole upgrade and would leave the proxy stuck on the old
 * implementation.
 *
 * @param {{ encodeFunctionData: (sig: string, args: unknown[]) => string }} iface
 */
function buildInitData(iface, alreadyInitialized) {
  if (alreadyInitialized) return '0x';
  return iface.encodeFunctionData('initializeSigning', [SIGNING_DOMAIN_NAME, SIGNING_DOMAIN_VERSION]);
}

/**
 * True/false when the allowlist state is knowable, null when it can't be read (a pre-signed-era
 * implementation has no `isSigner`). null means "just call setSigner" — writing the same value is
 * a no-op, and skipping the call because we couldn't read would silently skip a real change.
 */
async function readSignerAllowlisted(reader, address) {
  try {
    return (await reader.isSigner(address)).toString() === 'true';
  } catch (err) {
    if (isTransportError(err)) throw err;
    return null;
  }
}

module.exports = {
  IMPL_SLOT,
  SIGNING_DOMAIN_NAME,
  SIGNING_DOMAIN_VERSION,
  buildInitData,
  isTransportError,
  readSignerAllowlisted,
  readSigningInitialized,
};
