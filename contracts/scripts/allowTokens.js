/**
 * Allowlist ERC-20 tokens on the deployed PayWithQuai proxy.
 *
 *   npx hardhat run scripts/allowTokens.js --network cyprus1
 *
 * Sends setTokenAccepted(token, true) for each target token, skipping ones already accepted,
 * and verifies acceptance after each tx. Reads the proxy address from deployments/<network>.json
 * (override with PAYWITHQUAI_ADDR env).
 *
 * Token selection:
 *   - Default: canonical Quai mainnet USDT + WQUAI (addresses verified on-chain via
 *     docs.qu.ai/learn/bridge-to-quai and symbol()/decimals() reads).
 *   - Extra/override: EXTRA_TOKENS=0xabc,0xdef appends more; ONLY_TOKENS=0xabc replaces the list.
 *
 * Ownership: if the contract's owner() is not this signer (e.g. ownership was handed to the
 * upgrade Timelock), every call would revert — the script detects that case up front and
 * explains the timelock path instead of firing doomed transactions.
 *
 * Requires contracts/.env: RPC_URL, CYPRUS1_PK (the wallet must own or control the proxy).
 */
const hre = require('hardhat');
const quais = require('quais');
const fs = require('fs');
const path = require('path');

// Canonical Cyprus-1 mainnet tokens (see frontend/src/lib/currencies.ts — keep in sync).
const CANONICAL_TOKENS = [
  { label: 'USDT', address: '0x0049F7cbCa3556C2DfaE62Aafa7015F99de1b8f5' }, // Tether USD, 6 dec
  { label: 'WQUAI', address: '0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB' }, // Wrapped Quai, 18 dec
];

async function withRetry(fn, label, tries = 5) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.warn(`⚠️  ${label} failed (attempt ${i}/${tries}): ${err.message?.slice(0, 140)}`);
      await new Promise((r) => setTimeout(r, i * 3000));
    }
  }
  throw lastErr;
}

function resolveTokens() {
  const valid = (a) => /^0x[0-9a-fA-F]{40}$/.test(a);
  if (process.env.ONLY_TOKENS) {
    const list = process.env.ONLY_TOKENS.split(',').map((s) => s.trim()).filter(valid);
    if (list.length === 0) throw new Error('ONLY_TOKENS contained no valid addresses');
    return list.map((address) => ({ label: address.slice(0, 10) + '…', address }));
  }
  const list = [...CANONICAL_TOKENS];
  for (const raw of (process.env.EXTRA_TOKENS || '').split(',')) {
    const a = raw.trim();
    if (!a) continue;
    if (!valid(a)) throw new Error(`EXTRA_TOKENS entry "${a}" is not a valid address`);
    if (!list.some((t) => t.address.toLowerCase() === a.toLowerCase())) {
      list.push({ label: a.slice(0, 10) + '…', address: a });
    }
  }
  return list;
}

async function main() {
  const { url, accounts, chainId } = hre.network.config;
  if (!url || !accounts || accounts.length === 0) {
    throw new Error('Set RPC_URL and CYPRUS1_PK in contracts/.env first.');
  }

  // Proxy address: deployments/<network>.json, or PAYWITHQUAI_ADDR override.
  let proxy = process.env.PAYWITHQUAI_ADDR;
  if (!proxy) {
    const depFile = path.join(__dirname, '..', 'deployments', `${hre.network.name}.json`);
    const dep = JSON.parse(fs.readFileSync(depFile, 'utf8'));
    proxy = dep.payWithQuai;
  }

  const provider = new quais.JsonRpcProvider(url, undefined, { usePathing: true });
  const wallet = new quais.Wallet(accounts[0], provider);
  console.log(`Network: ${hre.network.name} (chainId ${chainId})`);
  console.log(`Signer:  ${wallet.address}`);
  console.log(`Proxy:   ${proxy}\n`);

  const abi = [
    'function setTokenAccepted(address token, bool accepted)',
    'function isTokenAccepted(address token) view returns (bool)',
    'function owner() view returns (address)',
  ];
  const pay = new quais.Contract(proxy, abi, wallet);

  // Ownership sanity check before spending gas on doomed calls.
  try {
    const owner = await withRetry(() => pay.owner(), 'owner()');
    if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
      throw new Error(
        `Proxy owner is ${owner}, not this signer (${wallet.address}). If ownership lives in the ` +
          `upgrade Timelock, schedule both setTokenAccepted calls through the timelock instead ` +
          `(propose from the multisig, wait out the delay, execute).`,
      );
    }
  } catch (err) {
    if (/owner is|not this signer/.test(err.message)) throw err;
    console.warn('⚠️  Could not read owner() — continuing anyway.\n');
  }

  let changed = 0;
  for (const { label, address } of resolveTokens()) {
    const already = await withRetry(() => pay.isTokenAccepted(address), `isTokenAccepted(${label})`);
    if (already) {
      console.log(`✓ ${label} ${address} — already accepted, skipping`);
      continue;
    }
    process.stdout.write(`→ allowing ${label} ${address} … `);
    const tx = await withRetry(() => pay.setTokenAccepted(address, true), `setTokenAccepted(${label})`);
    await withRetry(() => tx.wait(), `wait(${label})`);
    const confirmed = await withRetry(() => pay.isTokenAccepted(address), `verify(${label})`);
    if (!confirmed) throw new Error(`${label}: tx mined but isTokenAccepted still false`);
    console.log(`done (tx ${tx.hash})`);
    changed++;
  }
  console.log(`\n${changed === 0 ? 'Nothing to do —' : `Allowed ${changed} token(s).`} Merchants can now price links in them.`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
