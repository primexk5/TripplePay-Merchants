/**
 * Allowlist settlement assets on a deployed PayWithQuai proxy on a standard EVM testnet.
 *
 *   npx hardhat run scripts/evm/allowTokens.js --network robinhoodTestnet
 *
 * The ethers-v6 counterpart of ../allowTokens.js (which is Quai-only and uses the quais SDK).
 * Sends setTokenAccepted(token, true) for each target asset, skipping ones already accepted, and
 * verifies acceptance after every tx. Reads the proxy from deployments/<network>.json (override
 * with PAYWITHQUAI_ADDR).
 *
 * WHY THERE IS NO DEFAULT TOKEN LIST HERE (unlike the Quai script):
 *   Quai mainnet has a canonical, documented USDT + WQUAI that the script hardcodes. Standard EVM
 *   chains have no equivalent — each chain/rollup lists its own tokens, and a hardcoded address
 *   from one chain is meaningless (or dangerous) on another. So this script NEVER guesses an
 *   address: you name the assets, and it reads symbol()/decimals() back on-chain to prove each
 *   address is really the token you think it is before allowlisting it.
 *
 * Token selection:
 *   - Native currency (address(0)) is always included — the contract gates it through the same
 *     acceptedToken mapping, so a fresh proxy cannot take native payments until it is allowed.
 *     Set NO_NATIVE=1 to skip it.
 *   - STABLECOIN_ADDR — one stablecoin address (convenience; the same var deploy.js uses).
 *   - EXTRA_TOKENS      — comma-separated ERC-20 addresses to add.
 *   - ONLY_TOKENS       — comma-separated addresses that REPLACE the above (native still added
 *                         unless NO_NATIVE=1).
 *
 * Ownership: if the proxy's owner() is not this signer (e.g. ownership already moved to the
 * upgrade Timelock), every call would revert — this detects that up front and prints the timelock
 * path instead of firing doomed transactions.
 *
 * Requires contracts/.env: EVM_DEPLOYER_PK (must own or control the proxy) for the target network.
 */
const hre = require('hardhat');
const { ethers } = hre;
const fs = require('fs');
const path = require('path');

// Same guard rail as scripts/evm/deploy.js — Quai mainnet (9), Robinhood Chain mainnet (4663),
// Base mainnet (8453). This script only ever targets testnets.
const MAINNET_CHAIN_IDS = [9, 4663, 8453];
const NATIVE = '0x0000000000000000000000000000000000000000';

const EXPLORERS = {
  robinhoodTestnet: 'https://explorer.testnet.chain.robinhood.com',
  baseSepolia: 'https://sepolia.basescan.org',
};

const ABI = [
  'function setTokenAccepted(address token, bool accepted)',
  'function isTokenAccepted(address token) view returns (bool)',
  'function owner() view returns (address)',
];

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

function explorerLink(networkName, address) {
  const base = EXPLORERS[networkName];
  return base ? `${base}/address/${address}` : address;
}

async function withRetry(fn, label, tries = 5) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.warn(`⚠️  ${label} failed (attempt ${i}/${tries}): ${err.message?.slice(0, 140)}`);
      await new Promise((r) => setTimeout(r, i * 2000));
    }
  }
  throw lastErr;
}

function isAddress(a) {
  return /^0x[0-9a-fA-F]{40}$/.test(a);
}

function parseList(raw) {
  return (raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Builds the deduplicated asset list, preserving order and keeping the first label seen. */
function resolveAssets() {
  const out = [];
  const add = (address, label) => {
    if (!isAddress(address)) throw new Error(`"${address}" is not a valid 20-byte address`);
    const key = address.toLowerCase();
    if (!out.some((a) => a.address.toLowerCase() === key)) out.push({ address, label });
    else if (label) out.find((a) => a.address.toLowerCase() === key).label = label;
  };

  if (process.env.NO_NATIVE !== '1') add(NATIVE, 'native currency');

  if (process.env.ONLY_TOKENS?.trim()) {
    const list = parseList(process.env.ONLY_TOKENS);
    if (list.length === 0) throw new Error('ONLY_TOKENS contained no valid addresses');
    for (const a of list) add(a, a.slice(0, 10) + '…');
  } else {
    if (process.env.STABLECOIN_ADDR?.trim()) {
      add(process.env.STABLECOIN_ADDR.trim(), 'stablecoin');
    }
    for (const a of parseList(process.env.EXTRA_TOKENS)) add(a, a.slice(0, 10) + '…');
  }

  if (out.every((a) => a.address.toLowerCase() === NATIVE)) {
    throw new Error(
      'No ERC-20 assets to allowlist. Standard EVM chains have no canonical token list, so this ' +
        'script will not guess one — set STABLECOIN_ADDR, EXTRA_TOKENS or ONLY_TOKENS to the ' +
        "actual token addresses for this chain (e.g. from the chain's block explorer).",
    );
  }
  return out;
}

/** Reads symbol()/decimals() so the operator sees what they are about to allowlist, and so a typo'd
 *  or non-contract address fails loudly BEFORE any transaction is sent. */
async function describeAsset(provider, address) {
  if (address.toLowerCase() === NATIVE) return 'native currency';
  const token = new ethers.Contract(address, ERC20_ABI, provider);
  const [symbol, decimals] = await Promise.all([
    token.symbol().catch(() => null),
    token.decimals().then(Number).catch(() => null),
  ]);
  if (!symbol) return '⚠️  no symbol() — not a standard ERC-20?';
  return decimals === null ? `${symbol} (decimals unknown)` : `${symbol} (${decimals} dec)`;
}

async function main() {
  const { url, accounts, chainId } = hre.network.config;
  if (!url || !accounts || accounts.length === 0) {
    throw new Error(
      `Set EVM_DEPLOYER_PK in contracts/.env before allowlisting on "${hre.network.name}".`,
    );
  }

  const signers = await ethers.getSigners();
  const signer = signers[0];
  const { chainId: onChainId } = await ethers.provider.getNetwork();
  if (MAINNET_CHAIN_IDS.includes(Number(onChainId))) {
    throw new Error(
      `Refusing to run against chainId ${Number(onChainId)} (${hre.network.name}) — mainnet ` +
        'allowlisting is disabled until team review. Only testnets are allowed from this script.',
    );
  }

  // Parse the asset list first — it's pure config work, so a missing/mistyped token env var fails
  // immediately rather than after an RPC round trip.
  const assets = resolveAssets();

  let proxy = process.env.PAYWITHQUAI_ADDR?.trim();
  if (!proxy) {
    const depFile = path.join(__dirname, '..', '..', 'deployments', `${hre.network.name}.json`);
    if (!fs.existsSync(depFile)) {
      throw new Error(
        `No deployment found at ${depFile}. Run scripts/evm/deploy.js for this network first, or ` +
          'set PAYWITHQUAI_ADDR.',
      );
    }
    proxy = JSON.parse(fs.readFileSync(depFile, 'utf8')).payWithQuai;
  }
  if (!isAddress(proxy)) throw new Error(`PAYWITHQUAI_ADDR "${proxy}" is not a valid address.`);

  console.log(`Network: ${hre.network.name} (chainId ${chainId})`);
  console.log(`Signer:  ${signer.address}`);
  console.log(`Proxy:   ${proxy}\n`);

  const pay = new ethers.Contract(proxy, ABI, signer);

  // Ownership sanity check before spending gas on doomed calls.
  const owner = await withRetry(() => pay.owner(), 'owner()');
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      `Proxy owner is ${owner}, not this signer (${signer.address}). If ownership lives in the ` +
        'upgrade Timelock, schedule setTokenAccepted through the timelock instead (propose from ' +
        'the multisig, wait out the delay, execute).',
    );
  }

  console.log('Assets to allowlist:');
  for (const a of assets) {
    a.onChain = await describeAsset(ethers.provider, a.address);
    console.log(`  ${a.onChain.padEnd(34)} ${a.address}`);
  }
  if (assets.some((a) => a.onChain.startsWith('⚠️'))) {
    throw new Error(
      'At least one address is not a readable ERC-20 (see the ⚠️ rows above). Fix the addresses ' +
        'before allowlisting anything — nothing has been sent.',
    );
  }
  console.log('');

  let changed = 0;
  for (const { address, onChain } of assets) {
    if (await withRetry(() => pay.isTokenAccepted(address), `isTokenAccepted(${onChain})`)) {
      console.log(`✓ ${onChain} — already accepted, skipping`);
      continue;
    }
    process.stdout.write(`→ allowing ${onChain} ${address} … `);
    const tx = await withRetry(() => pay.setTokenAccepted(address, true), `setTokenAccepted(${onChain})`);
    await withRetry(() => tx.wait(), `wait(${onChain})`);
    if (!(await withRetry(() => pay.isTokenAccepted(address), `verify(${onChain})`))) {
      throw new Error(`${onChain}: tx mined but isTokenAccepted still false`);
    }
    console.log(`done (tx ${tx.hash})`);
    console.log(`  ${explorerLink(hre.network.name, address)}`);
    changed++;
  }

  console.log(
    `\n${changed === 0 ? 'Nothing to do —' : `Allowed ${changed} asset(s).`} Merchants can now ` +
      'price payment links in them.',
  );
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
