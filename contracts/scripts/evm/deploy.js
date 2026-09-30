/**
 * Deploy the "Pay with Quai" stack to a standard EVM testnet using hre.ethers (ethers v6).
 *
 *   npx hardhat run scripts/evm/deploy.js --network robinhoodTestnet
 *   npx hardhat run scripts/evm/deploy.js --network baseSepolia
 *
 * This is the standard-EVM counterpart to scripts/deploy.js (which targets Quai's Cyprus-1
 * zone via the quais SDK). The Quai script and its guardrails are untouched — this script is a
 * parallel toolchain, not a replacement.
 *
 * What it deploys:
 *   1. MockStablecoin        (always — this script refuses to run against a mainnet chain id)
 *   2. PayWithQuai (impl)     the UUPS implementation (logic, no state)
 *   3. ERC1967Proxy           the proxy that holds all state and is what everyone interacts with
 *   4. TimelockController     (optional — only if MULTISIG_ADDR is set) the upgrade-governance owner
 *
 * Ownership model (identical to scripts/deploy.js):
 *   - initialize() sets the owner to the DEPLOYER so this script can allowlist assets.
 *   - If MULTISIG_ADDR is set, the script deploys a Timelock (proposer/executor = the multisig)
 *     and calls transferOwnership(timelock). Because the router uses Ownable2Step, ownership does
 *     NOT move until the Timelock calls acceptOwnership() — schedule that from the multisig to
 *     finish the hand-off (the script prints the exact steps).
 *
 * Requires contracts/.env (see .env.example): EVM_DEPLOYER_PK, and either
 * ROBINHOOD_TESTNET_RPC_URL or BASE_SEPOLIA_RPC_URL (both have public defaults in
 * hardhat.config.js), and optionally FEE_RECIPIENT / FEE_BPS / STABLECOIN_ADDR / MULTISIG_ADDR /
 * TIMELOCK_MIN_DELAY / PAUSE_GUARDIAN_ADDR.
 * Writes the resulting addresses to deployments/<network>.json.
 *
 * SAFETY: refuses to run against any chain id in MAINNET_CHAIN_IDS — this script only ever
 * targets testnets until the team explicitly reviews an EVM mainnet deploy path.
 */
const hre = require('hardhat');
const { ethers } = hre;
const fs = require('fs');
const path = require('path');

// Quai mainnet (9), Robinhood Chain mainnet (4663), Base mainnet (8453). Any of these refuses
// to deploy from this script — mainnet deploys are out of scope until the team reviews them.
const MAINNET_CHAIN_IDS = [9, 4663, 8453];
const DEFAULT_TIMELOCK_MIN_DELAY = 172800; // 48h — same default as scripts/deploy.js
const ZERO = '0x0000000000000000000000000000000000000000';

const EXPLORERS = {
  robinhoodTestnet: 'https://explorer.testnet.chain.robinhood.com',
  baseSepolia: 'https://sepolia.basescan.org',
};

function explorerAddressLink(networkName, address) {
  const base = EXPLORERS[networkName];
  return base ? `${base}/address/${address}` : address;
}

function explorerTxLink(networkName, hash) {
  const base = EXPLORERS[networkName];
  return base ? `${base}/tx/${hash}` : hash;
}

async function main() {
  const networkName = hre.network.name;
  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    throw new Error(
      `No deployer account configured for network "${networkName}". Set EVM_DEPLOYER_PK in ` +
        'contracts/.env before deploying (see .env.example).',
    );
  }
  const deployer = signers[0];
  const { chainId } = await ethers.provider.getNetwork();
  const chainIdNum = Number(chainId);

  console.log(`Deployer: ${deployer.address}`);
  console.log(`Network:  ${networkName}`);
  console.log(`ChainId:  ${chainIdNum}`);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance:  ${ethers.formatEther(balance)} ETH`);
  if (balance === 0n) {
    throw new Error(
      `Deployer ${deployer.address} has zero balance on ${networkName} — fund it from a faucet ` +
        'before deploying (see contracts/README.md).',
    );
  }

  // Mainnet guard rail: this script only ever targets testnets. Fail hard BEFORE any transaction.
  if (MAINNET_CHAIN_IDS.includes(chainIdNum)) {
    throw new Error(
      `Refusing to deploy to chainId ${chainIdNum} (${networkName}) — EVM mainnet deploys are ` +
        'disabled until team review. Only testnets are allowed from scripts/evm/deploy.js.',
    );
  }

  // FEE_RECIPIENT defaults to the deployer on testnets (this script never targets mainnet, so
  // there is no "must be an explicit treasury address" requirement here — see scripts/deploy.js
  // for that mainnet-only enforcement).
  const feeRecipient = (process.env.FEE_RECIPIENT || '').trim() || deployer.address;
  if (!/^0x[0-9a-fA-F]{40}$/.test(feeRecipient)) {
    throw new Error(`FEE_RECIPIENT="${feeRecipient}" is not a valid 20-byte hex address.`);
  }

  // Platform fee: 0.3% (30 bps) default, locked at order registration. Override with FEE_BPS
  // (max 500 = 5%), shared with the Quai script's convention.
  const feeBpsRaw = process.env.FEE_BPS || '30';
  if (!/^\d+$/.test(feeBpsRaw) || Number(feeBpsRaw) > 500) {
    throw new Error(`Invalid FEE_BPS="${feeBpsRaw}" — must be an integer basis-point value 0-500 (max 5%).`);
  }
  const feeBps = Number(feeBpsRaw);

  const timelockMinDelay = Number(process.env.TIMELOCK_MIN_DELAY || DEFAULT_TIMELOCK_MIN_DELAY);

  // 1) MockStablecoin — always deployed: this script has already refused to run on a mainnet
  // chain id above, so every network it can reach here is a testnet.
  const MockStablecoin = await ethers.getContractFactory('MockStablecoin', deployer);
  const mock = await MockStablecoin.deploy();
  await mock.waitForDeployment();
  const mockAddress = await mock.getAddress();
  console.log(`MockStablecoin:     ${mockAddress}`);
  console.log(`  ${explorerAddressLink(networkName, mockAddress)}`);

  // 2) PayWithQuai implementation (logic only — never holds state).
  const PayWithQuai = await ethers.getContractFactory('PayWithQuai', deployer);
  const impl = await PayWithQuai.deploy();
  await impl.waitForDeployment();
  const implAddress = await impl.getAddress();
  console.log(`PayWithQuai (impl): ${implAddress}`);
  console.log(`  ${explorerAddressLink(networkName, implAddress)}`);

  // 3) ERC1967Proxy, initialized with owner = deployer so we can allowlist assets below.
  const initData = PayWithQuai.interface.encodeFunctionData('initialize', [
    feeRecipient,
    feeBps,
    deployer.address,
  ]);
  const ERC1967Proxy = await ethers.getContractFactory('ERC1967Proxy', deployer);
  const proxyContract = await ERC1967Proxy.deploy(implAddress, initData);
  const deployTx = proxyContract.deploymentTransaction();
  const proxyReceipt = await deployTx.wait();
  const proxyAddress = await proxyContract.getAddress();
  console.log(`PayWithQuai (proxy):${proxyAddress}   <-- interact with THIS address`);
  console.log(`  ${explorerAddressLink(networkName, proxyAddress)}`);

  // Bind the implementation ABI to the proxy address for all further calls.
  const pay = new ethers.Contract(proxyAddress, PayWithQuai.interface, deployer);

  // Allowlist the settlement assets merchants may price orders in.
  const acceptNativeTx = await pay.setTokenAccepted(ZERO, true);
  await acceptNativeTx.wait();
  console.log('Accepted asset: native currency (address(0))');

  const acceptMockTx = await pay.setTokenAccepted(mockAddress, true);
  await acceptMockTx.wait();
  console.log(`Accepted asset: ${mockAddress} (mock stablecoin)`);

  if (process.env.STABLECOIN_ADDR) {
    const acceptStableTx = await pay.setTokenAccepted(process.env.STABLECOIN_ADDR, true);
    await acceptStableTx.wait();
    console.log(`Accepted asset: ${process.env.STABLECOIN_ADDR} (STABLECOIN_ADDR)`);
  }

  // --- Fee routing verification: read the fee config back from the proxy and fail hard if it
  // does not match what was requested (mirrors scripts/deploy.js).
  const [onChainFeeRecipient, onChainFeeBps] = await Promise.all([
    pay.feeRecipient(),
    pay.feeBps(),
  ]);
  if (
    String(onChainFeeRecipient).toLowerCase() !== feeRecipient.toLowerCase() ||
    Number(onChainFeeBps) !== feeBps
  ) {
    throw new Error(
      `Fee config mismatch! Requested recipient=${feeRecipient} bps=${feeBps} but the proxy has ` +
        `recipient=${onChainFeeRecipient} bps=${Number(onChainFeeBps)}. DO NOT USE this deployment.`,
    );
  }
  console.log('\nFee routing verified on-chain:');
  console.log(`  FEE_RECIPIENT → ${onChainFeeRecipient}`);
  console.log(`  FEE_BPS       → ${Number(onChainFeeBps)} (${Number(onChainFeeBps) / 100}%)`);

  // 4) Governance: hand upgrade authority to a Timelock owned by the multisig (if configured).
  let timelockAddress = null;
  if (process.env.MULTISIG_ADDR) {
    const multisig = process.env.MULTISIG_ADDR;
    // proposers = [multisig], executors = [multisig], admin = address(0) (self-administered).
    const TimelockController = await ethers.getContractFactory('TimelockController', deployer);
    const timelock = await TimelockController.deploy(timelockMinDelay, [multisig], [multisig], ZERO);
    await timelock.waitForDeployment();
    timelockAddress = await timelock.getAddress();
    console.log(`TimelockController: ${timelockAddress} (minDelay ${timelockMinDelay}s, gov=${multisig})`);
    console.log(`  ${explorerAddressLink(networkName, timelockAddress)}`);

    const transferTx = await pay.transferOwnership(timelockAddress);
    await transferTx.wait();
    console.log(`\nOwnership transfer STARTED: pendingOwner = ${timelockAddress}`);
    console.log('Ownable2Step means the Timelock must accept before it becomes owner. From the');
    console.log('multisig, schedule + execute this call through the Timelock to finish the hand-off:');
    console.log(`  target = ${proxyAddress}`);
    console.log(
      `  data   = ${PayWithQuai.interface.encodeFunctionData('acceptOwnership', [])}  // acceptOwnership()`,
    );
    console.log('Until then, the deployer remains owner.');
  } else {
    console.log('\n⚠️  No MULTISIG_ADDR set — owner remains the deployer EOA (fine for testnet).');
  }

  // Pause guardian: an independent actor that can halt payments in an emergency but can never
  // unpause or change any other state. Optional here (this script never targets mainnet).
  if (process.env.PAUSE_GUARDIAN_ADDR) {
    const guardian = process.env.PAUSE_GUARDIAN_ADDR;
    const guardianTx = await pay.setPauseGuardian(guardian);
    await guardianTx.wait();
    console.log(`PauseGuardian:       ${guardian} (can pause(), never unpause())`);
  }

  const outDir = path.join(__dirname, '..', '..', 'deployments');
  fs.mkdirSync(outDir, { recursive: true });
  const record = {
    network: networkName,
    chainId: chainIdNum,
    payWithQuai: proxyAddress, // the address the relayer + checkout SDK use
    payWithQuaiImpl: implAddress,
    timelock: timelockAddress,
    mockStablecoin: mockAddress,
    feeRecipient,
    feeBps: String(feeBps),
    deployer: deployer.address,
    deployBlock: proxyReceipt.blockNumber, // used later as the backend's START_BLOCK
    explorer: EXPLORERS[networkName] || null,
  };
  const outFile = path.join(outDir, `${networkName}.json`);
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
  console.log(`\nWrote ${path.relative(process.cwd(), outFile)}`);
  console.log(`Proxy deployment tx: ${explorerTxLink(networkName, proxyReceipt.hash)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
