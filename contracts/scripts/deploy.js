/**
 * Deploy the "Pay with Quai" stack to a Quai zone using the quais SDK.
 *
 *   npx hardhat run scripts/deploy.js --network cyprus1
 *
 * What it deploys:
 *   1. MockStablecoin        (testnet only — never on mainnet)
 *   2. PayWithQuai (impl)     the UUPS implementation (logic, no state)
 *   3. ERC1967Proxy           the proxy that holds all state and is what everyone interacts with
 *   4. TimelockController     (optional — only if MULTISIG_ADDR is set) the upgrade-governance owner
 *
 * Ownership model:
 *   - initialize() sets the owner to the DEPLOYER so this script can allowlist assets.
 *   - If MULTISIG_ADDR is set, the script deploys a Timelock (proposer/executor = the multisig)
 *     and calls transferOwnership(timelock). Because the router uses Ownable2Step, ownership does
 *     NOT move until the Timelock calls acceptOwnership() — schedule that from the multisig to
 *     finish the hand-off (the script prints the exact steps).
 *
 * Requires contracts/.env (see .env.example): RPC_URL, CHAIN_ID, CYPRUS1_PK, and optionally
 * FEE_RECIPIENT / FEE_BPS / STABLECOIN_ADDR / MULTISIG_ADDR / TIMELOCK_MIN_DELAY.
 * Writes the resulting addresses to deployments/<network>.json.
 *
 * Note: the Hardhat console/ethers cannot talk to Quai, so deployment goes through the quais SDK.
 * The ContractFactory takes a 4th arg — an IPFS metadata CID — which Quaiscan uses to verify source.
 */
const hre = require('hardhat');
const quais = require('quais');
const fs = require('fs');
const path = require('path');

const MAINNET_CHAIN_ID = 9;
const DEFAULT_TIMELOCK_MIN_DELAY = 172800; // 48h — production-safe default; users get a warning window
const ZERO = '0x0000000000000000000000000000000000000000';

async function pushMetadata(contractName) {
  if (!hre.deployMetadata || typeof hre.deployMetadata.pushMetadataToIPFS !== 'function') {
    console.warn(
      `⚠️  @quai/hardhat-deploy-metadata not available — deploying ${contractName} without an ` +
        `IPFS CID. The contract will work but cannot be source-verified on Quaiscan.`,
    );
    return undefined;
  }
  try {
    return await hre.deployMetadata.pushMetadataToIPFS(contractName);
  } catch (err) {
    // quais' ContractFactory rejects an empty CID; fall back to a syntactically valid
    // placeholder so the deploy proceeds (source verification will simply be unavailable).
    console.warn(`⚠️  IPFS push failed for ${contractName} (${err.message}) — using placeholder CID.`);
    return 'Qm' + '0'.repeat(44);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The public Orchard RPC is flaky (dropped calls / -32000 with an empty message).
// Retry each step a few times before giving up.
async function withRetry(fn, label, tries = 5) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.warn(`⚠️  ${label} failed (attempt ${i}/${tries}): ${err.message?.slice(0, 120) || err}`);
      if (i < tries) await sleep(2000 * i);
    }
  }
  throw lastErr;
}

async function deployContract(name, args, wallet) {
  return withRetry(async () => {
    const artifact = await hre.artifacts.readArtifact(name);
    const ipfsHash = await pushMetadata(name);
    const factory = new quais.ContractFactory(artifact.abi, artifact.bytecode, wallet, ipfsHash);
    const contract = await factory.deploy(...args);
    await contract.waitForDeployment();
    return { contract, address: await contract.getAddress() };
  }, `deploy ${name}`);
}

async function main() {
  const { url, accounts, chainId } = hre.network.config;
  if (!url || !accounts || accounts.length === 0) {
    throw new Error('Set RPC_URL and CYPRUS1_PK in contracts/.env before deploying.');
  }

  // Mainnet guard rails: a single deployer EOA must never be the router owner, the upgrade
  // timelock must have a sane floor, and the circuit breaker needs an independent guardian.
  // Fail hard BEFORE any transaction instead of deploying a footgun.
  const isMainnet = Number(chainId) === MAINNET_CHAIN_ID;
  if (isMainnet && !process.env.MULTISIG_ADDR) {
    throw new Error(
      'Refusing to deploy to mainnet without MULTISIG_ADDR: ownership would stay with the deployer ' +
        'EOA. Set MULTISIG_ADDR before deploying.',
    );
  }
  if (isMainnet && !process.env.PAUSE_GUARDIAN_ADDR) {
    throw new Error(
      'Refusing to deploy to mainnet without PAUSE_GUARDIAN_ADDR — the circuit breaker needs an ' +
        'independent actor that can halt payments.',
    );
  }
  // Platform fees are real money on mainnet: never silently default FEE_RECIPIENT to the
  // deployer EOA. The destination must be an explicitly chosen, funded, Cyprus-1 (0x00…)
  // address that accepts native value — ideally a cold wallet or a Safe, not a hot deploy key.
  let feeRecipient;
  if (isMainnet) {
    const raw = (process.env.FEE_RECIPIENT || '').trim();
    if (!raw) {
      throw new Error(
        'Refusing to deploy to mainnet without FEE_RECIPIENT — platform fees would silently go ' +
          'to the deployer EOA. Set FEE_RECIPIENT to the treasury address that should collect fees.',
      );
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
      throw new Error(`FEE_RECIPIENT="${raw}" is not a valid 20-byte hex address.`);
    }
    feeRecipient = raw;
  } else {
    feeRecipient = process.env.FEE_RECIPIENT || wallet.address;
  }
  const timelockMinDelay = Number(process.env.TIMELOCK_MIN_DELAY || DEFAULT_TIMELOCK_MIN_DELAY);
  if (isMainnet && timelockMinDelay < 86400) {
    throw new Error(
      `Refusing to deploy to mainnet with TIMELOCK_MIN_DELAY=${timelockMinDelay}s — the upgrade ` +
        'timelock must be at least 86400s (24h) on mainnet.',
    );
  }

  // Platform fee: 0.3% (30 bps) is the standard rate, locked at order registration and split to
  // FEE_RECIPIENT on every settlement. Override with FEE_BPS (max 500 = 5%).
  const feeBps = process.env.FEE_BPS || '30';
  if (!/^\d+$/.test(feeBps) || Number(feeBps) > 500) {
    throw new Error(`Invalid FEE_BPS="${feeBps}" — must be an integer basis-point value 0–500 (max 5%).`);
  }

  const provider = new quais.JsonRpcProvider(url, undefined, { usePathing: true });
  const wallet = new quais.Wallet(accounts[0], provider);
  console.log(`Network:  ${hre.network.name} (chainId ${chainId})`);
  console.log(`Deployer: ${wallet.address}`);
  if (isMainnet && feeRecipient.toLowerCase() === wallet.address.toLowerCase()) {
    console.warn(
      '⚠️  FEE_RECIPIENT is the deployer EOA. On mainnet prefer a dedicated treasury / Safe so ' +
        'fees are not commingled with the hot deployment key.',
    );
  }

  // 1) MockStablecoin — testnet convenience; never deploy the open-mint faucet to mainnet.
  let mockAddress;
  if (chainId !== MAINNET_CHAIN_ID) {
    const mock = await deployContract('MockStablecoin', [], wallet);
    mockAddress = mock.address;
    console.log(`MockStablecoin:     ${mockAddress}`);
  } else {
    console.log('Skipping MockStablecoin on mainnet — use a real stablecoin address.');
  }

  // 2) PayWithQuai implementation (logic only — never holds state).
  const impl = await deployContract('PayWithQuai', [], wallet);
  console.log(`PayWithQuai (impl): ${impl.address}`);

  // 3) ERC1967Proxy, initialized with owner = deployer so we can allowlist assets below.
  const implArtifact = await hre.artifacts.readArtifact('PayWithQuai');
  const iface = new quais.Interface(implArtifact.abi);
  const initData = iface.encodeFunctionData('initialize', [feeRecipient, feeBps, wallet.address]);
  const proxy = await deployContract('ERC1967Proxy', [impl.address, initData], wallet);
  console.log(`PayWithQuai (proxy):${proxy.address}   <-- interact with THIS address`);

  // Bind the implementation ABI to the proxy address for all further calls.
  const pay = new quais.Contract(proxy.address, implArtifact.abi, wallet);

  // Customer-paid signed orders: initialize the EIP-712 domain and allowlist the platform signer
  // BEFORE the ownership hand-off below, so the new owner never has to make a follow-up tx.
  const SIGNING_DOMAIN_NAME = 'PayWithQuai';
  const SIGNING_DOMAIN_VERSION = '1';
  await withRetry(async () => {
    await (await pay.initializeSigning(SIGNING_DOMAIN_NAME, SIGNING_DOMAIN_VERSION)).wait();
    console.log(`Signing domain:     ${SIGNING_DOMAIN_NAME} v${SIGNING_DOMAIN_VERSION}`);
  }, 'initializeSigning');

  const orderSigner = (process.env.ORDER_SIGNER_ADDRESS || '').trim();
  if (orderSigner) {
    if (!quais.isAddress(orderSigner)) {
      throw new Error(`ORDER_SIGNER_ADDRESS="${orderSigner}" is not a valid address.`);
    }
    await withRetry(async () => {
      await (await pay.setSigner(orderSigner, true)).wait();
      console.log(`Order signer:       ${orderSigner} (allowlisted)`);
    }, 'setSigner');
  } else {
    console.warn(
      '\n⚠️  ORDER_SIGNER_ADDRESS not set — no signer is allowlisted, so paySignedOrder will reject ' +
        'every customer payment until the owner runs setSigner(<platformSigner>, true).\n' +
        '    Legacy payOrder / payOrderNative still work.',
    );
  }

  // Allowlist the settlement assets merchants may price orders in.
  await withRetry(async () => {
    await (await pay.setTokenAccepted(ZERO, true)).wait();
    console.log('Accepted asset: native QUAI');
  }, 'allowlist native QUAI');
  if (mockAddress) {
    await withRetry(async () => {
      await (await pay.setTokenAccepted(mockAddress, true)).wait();
      console.log(`Accepted asset: ${mockAddress} (mUSDQ)`);
    }, 'allowlist mUSDQ');
  }
  if (process.env.STABLECOIN_ADDR) {
    await withRetry(async () => {
      await (await pay.setTokenAccepted(process.env.STABLECOIN_ADDR, true)).wait();
      console.log(`Accepted asset: ${process.env.STABLECOIN_ADDR} (STABLECOIN_ADDR)`);
    }, 'allowlist STABLECOIN_ADDR');
  }

  // --- Fee routing verification: read the fee config back from the proxy and fail hard if it
  // does not match what was requested. A wrong immutable-at-init fee destination is not
  // discoverable until fees have already accrued, so verify NOW, on the chain.
  const [onChainFeeRecipient, onChainFeeBps] = await Promise.all([
    pay.feeRecipient(),
    pay.feeBps(),
  ]);
  if (
    String(onChainFeeRecipient).toLowerCase() !== feeRecipient.toLowerCase() ||
    Number(onChainFeeBps) !== Number(feeBps)
  ) {
    throw new Error(
      `Fee config mismatch! Requested recipient=${feeRecipient} bps=${feeBps} but the proxy has ` +
        `recipient=${onChainFeeRecipient} bps=${Number(onChainFeeBps)}. DO NOT USE this deployment.`,
    );
  }
  console.log(`\nFee routing verified on-chain:`);
  console.log(`  FEE_RECIPIENT → ${onChainFeeRecipient} (all platform fees land here)`);
  console.log(`  FEE_BPS       → ${Number(onChainFeeBps)} (${Number(onChainFeeBps) / 100}% of every settlement)`);

  // Signed-order state must match what the backend signs against, or every customer payment is
  // rejected with InvalidSignature. Fail the deploy rather than ship a broken checkout.
  if (!(await pay.signingInitialized())) {
    throw new Error('signingInitialized() is false — the EIP-712 domain was not set up.');
  }
  const domain = await pay.eip712Domain();
  if (domain.name !== SIGNING_DOMAIN_NAME || domain.version !== SIGNING_DOMAIN_VERSION) {
    throw new Error(
      `EIP-712 domain mismatch: got ${domain.name}/${domain.version}, expected ` +
        `${SIGNING_DOMAIN_NAME}/${SIGNING_DOMAIN_VERSION}. DO NOT USE this deployment.`,
    );
  }
  if (orderSigner && !(await pay.isSigner(orderSigner))) {
    throw new Error(`Signer ${orderSigner} is not allowlisted after setSigner. DO NOT USE this deployment.`);
  }
  console.log('\nSigned orders verified on-chain:');
  console.log(`  domain  → ${domain.name} v${domain.version}`);
  console.log(`  signer  → ${orderSigner || '(none — customer-paid orders disabled)'}`);

  // 4) Governance: hand upgrade authority to a Timelock owned by the multisig (if configured).
  let timelockAddress = null;
  if (process.env.MULTISIG_ADDR) {
    const multisig = process.env.MULTISIG_ADDR;
    // proposers = [multisig], executors = [multisig], admin = address(0) (self-administered).
    const timelock = await deployContract(
      'TimelockController',
      [String(timelockMinDelay), [multisig], [multisig], ZERO],
      wallet,
    );
    timelockAddress = timelock.address;
    console.log(`TimelockController: ${timelockAddress} (minDelay ${timelockMinDelay}s, gov=${multisig})`);

    await withRetry(async () => {
      await (await pay.transferOwnership(timelockAddress)).wait();
    }, 'transferOwnership');
    console.log(`\nOwnership transfer STARTED: pendingOwner = ${timelockAddress}`);
    console.log('Ownable2Step means the Timelock must accept before it becomes owner. From the');
    console.log('multisig, schedule + execute this call through the Timelock to finish the hand-off:');
    console.log(`  target = ${proxy.address}`);
    console.log(`  data   = ${iface.encodeFunctionData('acceptOwnership', [])}  // acceptOwnership()`);
    console.log('Until then, the deployer remains owner.');
  } else {
    console.log('\n⚠️  No MULTISIG_ADDR set — owner remains the deployer EOA (fine for testnet).');
    console.log('   For mainnet, set MULTISIG_ADDR to deploy a Timelock and hand off ownership.');
  }

  // Pause guardian: an independent actor that can halt payments in an emergency but can never
  // unpause or change any other state. Required on mainnet (checked up front), optional on testnet.
  if (process.env.PAUSE_GUARDIAN_ADDR) {
    const guardian = process.env.PAUSE_GUARDIAN_ADDR;
    await withRetry(async () => {
      await (await pay.setPauseGuardian(guardian)).wait();
    }, 'setPauseGuardian');
    console.log(`PauseGuardian:       ${guardian} (can pause(), never unpause())`);
  }

  const outDir = path.join(__dirname, '..', 'deployments');
  fs.mkdirSync(outDir, { recursive: true });
  const record = {
    network: hre.network.name,
    chainId,
    payWithQuai: proxy.address, // the address the backend indexer + checkout SDK use
    payWithQuaiImpl: impl.address,
    timelock: timelockAddress,
    mockStablecoin: mockAddress ?? null,
    feeRecipient,
    feeBps: String(feeBps),
    signingDomain: { name: SIGNING_DOMAIN_NAME, version: SIGNING_DOMAIN_VERSION },
    orderSigner: orderSigner || null,
    deployer: wallet.address,
  };
  const outFile = path.join(outDir, `${hre.network.name}.json`);
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
  console.log(`\nWrote ${path.relative(process.cwd(), outFile)}`);
  console.log('The backend indexer and checkout SDK read PayWithQuai (proxy) from this file.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
