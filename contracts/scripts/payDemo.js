/**
 * End-to-end smoke test against a live Quai zone: mint mUSDQ, register an order, approve,
 * pay, and read back the PaymentReceived event — the full §3.1 checkout loop (steps 4–5).
 *
 *   npx hardhat run scripts/payDemo.js --network cyprus1
 *
 * Run scripts/deploy.js first; this reads addresses from deployments/<network>.json.
 * Uses a single key that plays both merchant and payer, so it works with one funded wallet.
 */
const hre = require('hardhat');
const quais = require('quais');
const fs = require('fs');
const path = require('path');

async function loadContract(name, address, wallet) {
  const artifact = await hre.artifacts.readArtifact(name);
  return new quais.Contract(address, artifact.abi, wallet);
}

async function main() {
  const { url, accounts, chainId } = hre.network.config;
  if (!url || !accounts || accounts.length === 0) {
    throw new Error('Set RPC_URL and CYPRUS1_PK in contracts/.env first.');
  }

  const deployFile = path.join(__dirname, '..', 'deployments', `${hre.network.name}.json`);
  if (!fs.existsSync(deployFile)) {
    throw new Error(`No deployment found at ${deployFile}. Run scripts/deploy.js first.`);
  }
  const dep = JSON.parse(fs.readFileSync(deployFile, 'utf8'));
  if (!dep.mockStablecoin) {
    throw new Error('This demo needs the MockStablecoin (testnet). Not available on mainnet.');
  }

  const provider = new quais.JsonRpcProvider(url, undefined, { usePathing: true });
  const wallet = new quais.Wallet(accounts[0], provider);
  console.log(`Network: ${hre.network.name} (chainId ${chainId})`);
  console.log(`Wallet (merchant + payer): ${wallet.address}`);

  const token = await loadContract('MockStablecoin', dep.mockStablecoin, wallet);
  const pay = await loadContract('PayWithQuai', dep.payWithQuai, wallet);

  const amount = quais.parseUnits('25', 6); // 25.00 mUSDQ
  const orderId = quais.id(`ord_demo_${Date.now()}`); // bytes32
  const ZERO = '0x0000000000000000000000000000000000000000';

  console.log('\n1) Minting 25 mUSDQ to the payer...');
  await (await token.mint(wallet.address, amount)).wait();

  console.log('2) Merchant registers the order on-chain...');
  await (await pay.registerOrder(orderId, dep.mockStablecoin, amount, 0)).wait(); // 0 = no expiry

  console.log('3) Payer approves the router...');
  await (await token.approve(dep.payWithQuai, amount)).wait();

  console.log('4) Payer settles the order...');
  const tx = await pay.payOrder(wallet.address, orderId);
  const receipt = await tx.wait();
  console.log(`   tx: ${receipt.hash}`);

  // Parse the PaymentReceived event the backend indexer picks up.
  for (const log of receipt.logs) {
    let parsed;
    try {
      parsed = pay.interface.parseLog(log);
    } catch (_) {
      continue;
    }
    if (parsed && parsed.name === 'PaymentReceived') {
      console.log('\n✅ PaymentReceived:');
      console.log(`   merchant:  ${parsed.args.merchant}`);
      console.log(`   orderId:   ${parsed.args.orderId}`);
      console.log(`   payer:     ${parsed.args.payer}`);
      console.log(`   token:     ${parsed.args.token} (0x0..0 = native QUAI)`);
      console.log(`   amount:    ${quais.formatUnits(parsed.args.amount, 6)} mUSDQ`);
      console.log(`   timestamp: ${parsed.args.timestamp}`);
    }
  }

  const settled = await pay.isSettled(wallet.address, orderId);
  console.log(`\nOrder settled on-chain: ${settled}`);
  console.log('The backend indexer would now POST a "payment.confirmed" webhook to the merchant.');

  // --- Native QUAI round: same loop, settlement in QUAI via msg.value ---
  console.log('\n--- Native QUAI round ---');
  const nativeAmount = quais.parseQuai('0.05'); // 0.05 QUAI
  const nativeOrderId = quais.id(`ord_native_${Date.now()}`);

  console.log('1) Merchant registers a native order...');
  await (await pay.registerOrder(nativeOrderId, ZERO, nativeAmount, 0)).wait();

  console.log('2) Payer settles it with payOrderNative...');
  const nativeTx = await pay.payOrderNative(wallet.address, nativeOrderId, {
    value: nativeAmount,
  });
  const nativeReceipt = await nativeTx.wait();
  console.log(`   tx: ${nativeReceipt.hash}`);

  for (const log of nativeReceipt.logs) {
    let parsed;
    try {
      parsed = pay.interface.parseLog(log);
    } catch (_) {
      continue;
    }
    if (parsed && parsed.name === 'PaymentReceived') {
      console.log('\n✅ PaymentReceived (native):');
      console.log(`   merchant:  ${parsed.args.merchant}`);
      console.log(`   orderId:   ${parsed.args.orderId}`);
      console.log(`   payer:     ${parsed.args.payer}`);
      console.log(`   token:     ${parsed.args.token} (0x0..0 = native QUAI)`);
      console.log(`   amount:    ${quais.formatQuai(parsed.args.amount)} QUAI`);
    }
  }

  const nativeSettled = await pay.isSettled(wallet.address, nativeOrderId);
  console.log(`\nNative order settled on-chain: ${nativeSettled}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
