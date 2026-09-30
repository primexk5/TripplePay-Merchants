/**
 * End-to-end smoke test against a live standard-EVM testnet: mint the mock stablecoin, register
 * an order, approve, pay, and read back the PaymentSettled event — then repeat with a native
 * payment. Standard-EVM counterpart to scripts/payDemo.js (which uses the quais SDK for Quai).
 *
 *   npx hardhat run scripts/evm/payDemo.js --network robinhoodTestnet
 *   npx hardhat run scripts/evm/payDemo.js --network baseSepolia
 *
 * Run scripts/evm/deploy.js first; this reads addresses from deployments/<network>.json.
 *
 * Uses a single key (EVM_DEPLOYER_PK) that plays both merchant and payer, so it works with one
 * funded wallet — matching scripts/payDemo.js. registerOrder() always records msg.sender as the
 * order's merchant (the contract has no separate merchant argument), so MERCHANT_ADDR — if set —
 * must equal the deployer address; this script fails loudly rather than silently registering
 * orders nobody can look up.
 */
const hre = require('hardhat');
const { ethers } = hre;
const fs = require('fs');
const path = require('path');

const ZERO = '0x0000000000000000000000000000000000000000';

const EXPLORERS = {
  robinhoodTestnet: 'https://explorer.testnet.chain.robinhood.com',
  baseSepolia: 'https://sepolia.basescan.org',
};

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
        'contracts/.env first.',
    );
  }
  const wallet = signers[0];

  const deployFile = path.join(__dirname, '..', '..', 'deployments', `${networkName}.json`);
  if (!fs.existsSync(deployFile)) {
    throw new Error(`No deployment found at ${deployFile}. Run scripts/evm/deploy.js first.`);
  }
  const dep = JSON.parse(fs.readFileSync(deployFile, 'utf8'));
  if (!dep.mockStablecoin) {
    throw new Error('This demo needs the MockStablecoin — deployment record has none.');
  }

  // registerOrder() has no merchant argument — it always records msg.sender as the merchant. A
  // MERCHANT_ADDR that doesn't match the signer would register the order under `wallet.address`
  // while every subsequent lookup used `merchantAddr` — silently never finding it. Fail loudly.
  const merchantAddr = (process.env.MERCHANT_ADDR || '').trim() || wallet.address;
  if (merchantAddr.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(
      `MERCHANT_ADDR=${merchantAddr} does not match the deployer/signer ${wallet.address}. ` +
        'This demo signs registerOrder as the deployer, which always becomes the on-chain ' +
        'merchant (msg.sender) — set MERCHANT_ADDR to the deployer address or leave it unset.',
    );
  }

  const { chainId } = await ethers.provider.getNetwork();
  console.log(`Network: ${networkName} (chainId ${Number(chainId)})`);
  console.log(`Wallet (merchant + payer): ${wallet.address}`);

  const token = new ethers.Contract(
    dep.mockStablecoin,
    (await ethers.getContractFactory('MockStablecoin')).interface,
    wallet,
  );
  const payInterface = (await ethers.getContractFactory('PayWithQuai')).interface;
  const pay = new ethers.Contract(dep.payWithQuai, payInterface, wallet);

  function printSettlement(receipt, label) {
    for (const log of receipt.logs) {
      let parsed;
      try {
        parsed = pay.interface.parseLog(log);
      } catch {
        continue;
      }
      if (parsed && parsed.name === 'PaymentSettled') {
        console.log(`\n✅ PaymentSettled (${label}):`);
        console.log(`   merchant:  ${parsed.args.merchant}`);
        console.log(`   orderId:   ${parsed.args.orderId}`);
        console.log(`   payer:     ${parsed.args.payer}`);
        console.log(`   token:     ${parsed.args.token} (0x0..0 = native)`);
        console.log(`   amount:    ${parsed.args.amount}`);
        console.log(`   fee:       ${parsed.args.fee}`);
        console.log(`   net:       ${parsed.args.net}`);
        console.log(`   nonce:     ${parsed.args.nonce}`);
      }
    }
  }

  // --- ERC-20 flow ---------------------------------------------------------------------------
  const amount = ethers.parseUnits('25', 6); // 25.00 mock stablecoin (6 decimals)
  const orderId = ethers.id(`ord_evm_demo_${Date.now()}`); // bytes32

  console.log('\n1) Minting 25 mock stablecoin to the payer...');
  await (await token.mint(wallet.address, amount)).wait();

  console.log('2) Merchant registers the order on-chain...');
  const registerTx = await pay.registerOrder(orderId, dep.mockStablecoin, amount, 0); // 0 = no expiry
  await registerTx.wait();
  console.log(`   tx: ${explorerTxLink(networkName, registerTx.hash)}`);

  console.log('3) Payer approves the router...');
  const approveTx = await token.approve(dep.payWithQuai, amount);
  await approveTx.wait();
  console.log(`   tx: ${explorerTxLink(networkName, approveTx.hash)}`);

  console.log('4) Payer settles the order...');
  const payTx = await pay.payOrder(merchantAddr, orderId);
  const payReceipt = await payTx.wait();
  console.log(`   tx: ${explorerTxLink(networkName, payReceipt.hash)}`);
  printSettlement(payReceipt, 'ERC-20');

  const order = await pay.getOrder(merchantAddr, orderId);
  console.log(`\nOrder settled on-chain: ${order.settled}`);
  console.log('The relayer would now POST a "payment.confirmed" webhook to the merchant.');

  // --- Native flow -----------------------------------------------------------------------------
  console.log('\n--- Native round ---');
  const nativeAmount = ethers.parseEther('0.0001'); // tiny amount — testnet gas token
  const nativeOrderId = ethers.id(`ord_evm_native_${Date.now()}`);

  console.log('1) Merchant registers a native order...');
  const registerNativeTx = await pay.registerOrder(nativeOrderId, ZERO, nativeAmount, 0);
  await registerNativeTx.wait();
  console.log(`   tx: ${explorerTxLink(networkName, registerNativeTx.hash)}`);

  console.log('2) Payer settles it with payOrderNative...');
  const nativeTx = await pay.payOrderNative(merchantAddr, nativeOrderId, { value: nativeAmount });
  const nativeReceipt = await nativeTx.wait();
  console.log(`   tx: ${explorerTxLink(networkName, nativeReceipt.hash)}`);
  printSettlement(nativeReceipt, 'native');

  const nativeOrder = await pay.getOrder(merchantAddr, nativeOrderId);
  console.log(`\nNative order settled on-chain: ${nativeOrder.settled}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
