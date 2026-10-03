/**
 * Upgrade the PayWithQuai UUPS proxy to the new implementation.
 *
 *   npx hardhat run scripts/upgrade.js --network cyprus1
 *
 * What it does:
 *   1. Deploys a fresh PayWithQuai implementation contract.
 *   2. Calls upgradeToAndCall(newImpl, initData) on the proxy. `initData` initializes the EIP-712
 *      domain (`initializeSigning("PayWithQuai", "1")`) in the SAME transaction when the proxy has
 *      not been initialized yet — so customers can pay signed orders the moment the upgrade lands,
 *      with no window in which paySignedOrder is live but unusable.
 *   3. Optional: allowlists ORDER_SIGNER_ADDRESS via setSigner(address, true) when that env var is
 *      set. Skipped (with a loud warning) when unset, because paySignedOrder rejects every
 *      authorization until a signer is allowlisted.
 *   4. Verifies the signing state on-chain (domain initialized + signer allowlisted) and that the
 *      EIP-1967 implementation slot points at the new implementation.
 *   5. Writes updated payWithQuaiImpl to deployments/<network>.json.
 *
 * Requires:
 *   - contracts/.env with RPC_URL, CHAIN_ID, CYPRUS1_PK set to the OWNER wallet.
 *   - deployments/<network>.json present (written by deploy.js).
 *   - The CYPRUS1_PK account must be the current proxy owner.
 *
 * PREFLIGHT=1 runs every read and every check, prints exactly what it would send, and broadcasts
 * nothing. Use it on a network you have not upgraded before — in particular it reports the proxy's
 * real owner, because if ownership sits with a TimelockController this script cannot upgrade at all
 * and the change has to be scheduled through the timelock instead.
 *
 * This script is safe to re-run. `initializeSigning` is a reinitializer and can only be consumed
 * ONCE, so on a deployment where it has already run the script upgrades with empty calldata
 * instead of reverting. That state is detected with `signingInitialized()`, which a pre-signed-era
 * proxy does not implement — the read is treated as "not initialized", never as a fatal error.
 */
const hre = require('hardhat');
const quais = require('quais');
const fs = require('fs');
const path = require('path');
const {
  IMPL_SLOT,
  SIGNING_DOMAIN_NAME,
  SIGNING_DOMAIN_VERSION,
  buildInitData,
  readSignerAllowlisted,
  readSigningInitialized,
} = require('./lib/signingUpgrade');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function pushMetadata(contractName) {
  if (!hre.deployMetadata || typeof hre.deployMetadata.pushMetadataToIPFS !== 'function') {
    console.warn(`⚠️  @quai/hardhat-deploy-metadata not available — deploying without IPFS CID.`);
    return undefined;
  }
  try {
    return await hre.deployMetadata.pushMetadataToIPFS(contractName);
  } catch (err) {
    console.warn(`⚠️  IPFS push failed (${err.message}) — using placeholder CID.`);
    return 'Qm' + '0'.repeat(44);
  }
}

async function main() {
  const { url, accounts, chainId } = hre.network.config;
  if (!url || !accounts || accounts.length === 0) {
    throw new Error('Set RPC_URL and CYPRUS1_PK in contracts/.env before upgrading.');
  }

  const provider = new quais.JsonRpcProvider(url, undefined, { usePathing: true });
  const wallet = new quais.Wallet(accounts[0], provider);
  const preflight = process.env.PREFLIGHT === '1';
  console.log(`Network:  ${hre.network.name} (chainId ${chainId})`);
  console.log(`Upgrader: ${wallet.address}`);
  if (preflight) console.log('Mode:     PREFLIGHT — reads only, nothing will be broadcast');

  // Load the existing deployment record.
  const deployFile = path.join(__dirname, '..', 'deployments', `${hre.network.name}.json`);
  if (!fs.existsSync(deployFile)) {
    throw new Error(`No deployment found at ${deployFile}. Run deploy.js first.`);
  }
  const deployment = JSON.parse(fs.readFileSync(deployFile, 'utf8'));
  const proxyAddress = deployment.payWithQuai;
  console.log(`Proxy:    ${proxyAddress}`);
  console.log(`Old impl: ${deployment.payWithQuaiImpl}`);

  // 0) Preflight: is this account even allowed to upgrade? If the proxy is owned by a
  //    TimelockController (which is how mainnet is set up) the answer is no, and no amount of
  //    retrying will change that — the change has to be scheduled through the timelock.
  if (preflight) {
    const Probe = new quais.Contract(proxyAddress, ['function owner() view returns (address)'], provider);
    const ownerAddress = await withRetry(async () => await Probe.owner(), 'read owner');
    const signerAddress = process.env.ORDER_SIGNER_ADDRESS;
    const initialized = await readSigningInitialized(
      new quais.Contract(proxyAddress, ['function signingInitialized() view returns (bool)'], provider),
    );
    let domain = null;
    if (initialized) {
      const Domain = new quais.Contract(
        proxyAddress,
        [
          'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
        ],
        provider,
      );
      const d = await Domain.eip712Domain();
      domain = { name: d.name, version: d.version, chainId: Number(d.chainId) };
    }
    let allowlisted = null;
    if (signerAddress && quais.isAddress(signerAddress)) {
      allowlisted = await readSignerAllowlisted(
        new quais.Contract(proxyAddress, ['function isSigner(address) view returns (bool)'], provider),
        signerAddress,
      );
    }
    const raw = await provider.getStorage(proxyAddress, IMPL_SLOT);
    console.log('\n── preflight ──────────────────────────────────────────────');
    console.log(`proxy owner          : ${ownerAddress}`);
    console.log(`caller is owner      : ${ownerAddress.toLowerCase() === wallet.address.toLowerCase()}`);
    console.log(`EIP-1967 impl slot   : 0x${raw.slice(-40).toLowerCase()}`);
    console.log(`record says impl     : ${deployment.payWithQuaiImpl}`);
    console.log(`signing domain live  : ${initialized}${domain ? ` (${domain.name} v${domain.version}, chainId ${domain.chainId})` : ''}`);
    console.log(`ORDER_SIGNER_ADDRESS : ${signerAddress || '(unset — no signer would be allowlisted)'}`);
    console.log(`signer allowlisted   : ${allowlisted === null ? '(unknown)' : allowlisted}`);
    console.log('─ would send ──────────────────────────────────────────────');
    console.log('1. deploy new PayWithQuai implementation');
    console.log(`2. upgradeToAndCall(newImpl, ${initialized ? '0x  // domain already live' : 'initializeSigning(...)'})`);
    console.log(`3. ${signerAddress ? (allowlisted === true ? 'setSigner — already allowlisted, no-op' : `setSigner(${signerAddress}, true)`) : 'nothing (no signer configured)'}`);
    console.log('4. verify signing state + impl slot; write deployments/<network>.json');
    console.log('───────────────────────────────────────────────────────────');
    if (ownerAddress.toLowerCase() !== wallet.address.toLowerCase()) {
      console.log(
        '\n⚠️  This account is NOT the proxy owner. upgradeToAndCall would revert with\n' +
          '    "Ownable: caller is not the owner". If that owner is a TimelockController, the\n' +
          '    upgrade must be scheduled there (propose → wait for the delay → execute); this\n' +
          '    script only helps the proposers rehearse the calldata.',
      );
    }
    if (!signerAddress) {
      console.log('\n⚠️  ORDER_SIGNER_ADDRESS unset — after the upgrade, no signed order could be paid.');
    }
    if (initialized && domain && domain.name !== SIGNING_DOMAIN_NAME) {
      console.log(
        `\n✗  Live domain is "${domain.name}" but the backend signs for "${SIGNING_DOMAIN_NAME}".\n` +
          '    Every authorization would be rejected — do not proceed until this is reconciled.',
      );
    }
    console.log('\nPreflight only — nothing was broadcast.');
    return;
  }

  // 1) Deploy the new implementation.
  console.log('\n[1/4] Deploying new PayWithQuai implementation…');
  const artifact = await hre.artifacts.readArtifact('PayWithQuai');
  const ipfsHash = await pushMetadata('PayWithQuai');
  const factory = new quais.ContractFactory(artifact.abi, artifact.bytecode, wallet, ipfsHash);

  const newImpl = await withRetry(async () => {
    const contract = await factory.deploy();
    await contract.waitForDeployment();
    return contract;
  }, 'deploy new impl');
  const newImplAddress = await newImpl.getAddress();
  console.log(`New impl: ${newImplAddress}`);

  // 2) Call upgradeToAndCall on the proxy (owner-only), initializing the EIP-712 domain in the
  //    same transaction when it hasn't been consumed yet.
  const proxy = new quais.Contract(proxyAddress, artifact.abi, wallet);

  // A proxy that has never seen the signed implementation has NO signingInitialized() — the call
  // delegates to an implementation without it and reverts. readSigningInitialized() reads that as
  // "not initialized" (retrying only genuine transport failures), which is exactly the state this
  // step needs to detect.
  const alreadyInitialized = await readSigningInitialized(proxy, {
    onRetry: (attempt, tries, err) =>
      console.warn(`⚠️  read signingInitialized failed (attempt ${attempt}/${tries}): ${err.message?.slice(0, 120) || err}`),
  });
  console.log(
    alreadyInitialized
      ? `   signingInitialized() answered true — domain already live.`
      : `   signingInitialized() unavailable or false — the upgrade will initialize the domain.`,
  );
  // Reinitializer(3) can only run once: re-running the upgrade against an already-initialized
  // proxy must pass empty calldata or the whole upgrade reverts and the contract is stuck on the
  // old implementation.
  const iface = new quais.Interface(artifact.abi);
  const initData = buildInitData(iface, alreadyInitialized);
  console.log(
    `\n[2/4] Upgrading proxy to new implementation ` +
      `(${alreadyInitialized ? 'domain already initialized — no reinit' : 'initializing signing domain'})…`,
  );

  await withRetry(async () => {
    const tx = await proxy.upgradeToAndCall(newImplAddress, initData);
    const receipt = await tx.wait();
    console.log(`✓ upgradeToAndCall confirmed in tx ${receipt.hash}`);
  }, 'upgradeToAndCall');

  // 3) Allowlist the platform order signer, when one is configured. Without this every customer
  //    authorization is rejected, so this is called out loudly rather than silently skipped.
  const signerAddress = process.env.ORDER_SIGNER_ADDRESS;
  if (!signerAddress) {
    console.warn(
      '\n⚠️  ORDER_SIGNER_ADDRESS not set — the contract is upgraded but NO signer is allowlisted, so\n' +
        '    paySignedOrder will reject every customer payment until the owner runs:\n' +
        '      setSigner(<platformSignerAddress>, true)\n' +
        '    Legacy payOrder / payOrderNative are unaffected.',
    );
  } else if (!quais.isAddress(signerAddress)) {
    throw new Error(`ORDER_SIGNER_ADDRESS is not a valid address: ${signerAddress}`);
  } else if ((await readSignerAllowlisted(proxy, signerAddress)) === true) {
    console.log(`✓ Signer ${signerAddress} already allowlisted — nothing to do.`);
  } else {
    await withRetry(async () => {
      const tx = await proxy.setSigner(signerAddress, true);
      const receipt = await tx.wait();
      console.log(`✓ setSigner(${signerAddress}, true) confirmed in tx ${receipt.hash}`);
    }, 'setSigner');
  }

  // 4) Smoke-test: signed-order entry points are present, the domain is live, and the signer is
  //    allowlisted. These are static/cheap checks — no real payment is broadcast.
  console.log('\n[3/4] Verifying signed-order state…');
  for (const fn of ['registerOrderBatch', 'paySignedOrder', 'initializeSigning', 'setSigner', 'isSigner']) {
    if (!artifact.abi.some((f) => f.type === 'function' && f.name === fn)) {
      throw new Error(`${fn} not found in ABI — something went wrong.`);
    }
  }
  console.log('✓ registerOrderBatch + paySignedOrder present in ABI.');

  // Post-upgrade this read MUST succeed: the new implementation is live, so a false here means the
  // upgrade didn't take (wrong owner, wrong proxy, reverted tx) and must not be papered over.
  const signingReady = await readSigningInitialized(proxy, {
    onRetry: (attempt, tries, err) =>
      console.warn(`⚠️  read signingInitialized failed (attempt ${attempt}/${tries}): ${err.message?.slice(0, 120) || err}`),
  });
  if (!signingReady) {
    throw new Error(
      'signingInitialized() is false after upgrade — paySignedOrder would revert. Check that ' +
        'upgradeToAndCall targeted the right proxy and that the transaction did not revert.',
    );
  }
  const domain = await proxy.eip712Domain();
  if (
    domain.name !== SIGNING_DOMAIN_NAME ||
    domain.version !== SIGNING_DOMAIN_VERSION
  ) {
    throw new Error(
      `EIP-712 domain mismatch: got ${domain.name}/${domain.version}, ` +
        `expected ${SIGNING_DOMAIN_NAME}/${SIGNING_DOMAIN_VERSION}. Backend signatures would all be rejected.`,
    );
  }
  console.log(`✓ EIP-712 domain live: ${domain.name} v${domain.version}`);
  if (signerAddress) {
    const allowlisted = await readSignerAllowlisted(proxy, signerAddress);
    if (allowlisted !== true) throw new Error(`Signer ${signerAddress} is not allowlisted after setSigner.`);
    console.log(`✓ Signer allowlisted: ${signerAddress}`);
  }

  // Read the current implementation slot (EIP-1967) to confirm the proxy points to the new impl.
  const raw = await provider.getStorage(proxyAddress, IMPL_SLOT);
  const currentImpl = '0x' + raw.slice(-40);
  const match = currentImpl.toLowerCase() === newImplAddress.toLowerCase();
  console.log(`✓ EIP-1967 impl slot: ${currentImpl} ${match ? '(matches ✓)' : '(MISMATCH ✗)'}`);
  if (!match) throw new Error('Implementation slot mismatch after upgrade!');

  // 5) Update the deployment record.
  deployment.payWithQuaiImpl = newImplAddress;
  deployment.signingDomain = { name: SIGNING_DOMAIN_NAME, version: SIGNING_DOMAIN_VERSION };
  if (signerAddress) deployment.orderSigner = signerAddress;
  fs.writeFileSync(deployFile, JSON.stringify(deployment, null, 2));
  console.log(`\n✓ Updated ${path.relative(process.cwd(), deployFile)}`);
  console.log('\n🎉 Upgrade complete. Customers now create and settle orders in one transaction');
  console.log('   of their own (paySignedOrder) — merchants and the platform pay no gas.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
