/**
 * Registers a pre-agreed orderId on-chain and pays it — for testing a backend-created payment
 * link end to end against a standard EVM chain (see backend/scripts/devMerchantFlow.js, which
 * creates the link and prints the exact orderId/token/amount this script needs).
 *
 * Example:
 *   ORDER_ID=$(node -e "console.log('0x' + require('crypto').randomBytes(32).toString('hex'))")
 *   ORDER_ID=$ORDER_ID AMOUNT=1000000000000000 \
 *     npx hardhat run scripts/evm/payLink.js --network robinhoodTestnet
 *
 * Uses ONE signer (configured for --network in hardhat.config.js) that plays both merchant and
 * payer, matching scripts/evm/payDemo.js. registerOrder() always records msg.sender as the
 * on-chain merchant, so the merchant for this order is simply whichever wallet is configured as
 * the signer — there is no way to register on behalf of a different address without that
 * address's own key.
 *
 * Reads the proxy address from deployments/<network>.json (the "payWithQuai" field, written by
 * scripts/evm/deploy.js) — run that first if it doesn't exist yet.
 *
 * Env:
 *   ORDER_ID  Required. The exact bytes32 orderId to register+pay (e.g. from a backend payment
 *             link's orderPool — see backend/scripts/devMerchantFlow.js's printed summary).
 *   TOKEN     Optional. ERC-20 address, or the native sentinel address(0) (default: native).
 *   AMOUNT    Required. Exact smallest-unit amount, as a decimal integer string.
 *   EXPIRY    Optional. Unix timestamp after which the order can no longer be paid; 0 means
 *             never expires (PayWithQuai.sol:268) — passed straight through. Default: 0.
 */
const hre = require('hardhat');
const { ethers } = hre;
const fs = require('fs');
const path = require('path');

// Quai mainnet (9), Robinhood Chain mainnet (4663), Base mainnet (8453) — same guard as
// scripts/evm/deploy.js. This script only ever targets testnets.
const MAINNET_CHAIN_IDS = [9, 4663, 8453];
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

/**
 * Extracts revert data from however ethers/the provider nested it and decodes it against the
 * PayWithQuai ABI's custom errors when possible, so a revert prints e.g. "OrderNotFound()"
 * instead of a raw stack trace.
 */
function decodeRevert(err, iface) {
  const data = err?.data ?? err?.error?.data ?? err?.info?.error?.data;
  if (typeof data === 'string' && data.startsWith('0x') && data.length >= 10) {
    try {
      const decoded = iface.parseError(data);
      if (decoded) return `${decoded.name}(${decoded.args.map(String).join(', ')})`;
    } catch {
      /* not a recognized custom error — fall through to the generic message below */
    }
  }
  return err?.shortMessage || err?.reason || err?.message || String(err);
}

/** Sends a transaction and waits for it; on revert, prints the decoded error and exits instead
 *  of throwing a raw stack trace. */
async function send(label, networkName, iface, txPromise) {
  try {
    const tx = await txPromise;
    const receipt = await tx.wait();
    console.log(`   ${label}: ${explorerTxLink(networkName, receipt.hash)}`);
    return receipt;
  } catch (err) {
    console.error(`\nReverted during ${label}: ${decodeRevert(err, iface)}`);
    process.exit(1);
  }
}

function printSettlement(receipt, iface, label) {
  for (const log of receipt.logs) {
    let parsed;
    try {
      parsed = iface.parseLog(log);
    } catch {
      continue;
    }
    if (parsed && parsed.name === 'PaymentSettled') {
      console.log(`\nPaymentSettled (${label}):`);
      console.log(`   merchant: ${parsed.args.merchant}`);
      console.log(`   orderId:  ${parsed.args.orderId}`);
      console.log(`   payer:    ${parsed.args.payer}`);
      console.log(`   token:    ${parsed.args.token} (${ZERO} = native)`);
      console.log(`   amount:   ${parsed.args.amount}`);
      console.log(`   fee:      ${parsed.args.fee}`);
      console.log(`   net:      ${parsed.args.net}`);
      console.log(`   nonce:    ${parsed.args.nonce}`);
    }
  }
}

async function main() {
  const networkName = hre.network.name;

  const orderId = process.env.ORDER_ID;
  if (!orderId || !/^0x[0-9a-fA-F]{64}$/.test(orderId)) {
    throw new Error(`ORDER_ID must be a 32-byte hex string (0x + 64 hex chars); got "${orderId}"`);
  }
  const token = (process.env.TOKEN || '').trim() || ZERO;
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) {
    throw new Error(`TOKEN="${token}" is not a valid 20-byte hex address.`);
  }
  const amountRaw = process.env.AMOUNT;
  if (!amountRaw || !/^\d+$/.test(amountRaw)) {
    throw new Error(`AMOUNT is required and must be a decimal integer string (smallest unit); got "${amountRaw}"`);
  }
  const amount = BigInt(amountRaw);
  const expiryRaw = process.env.EXPIRY;
  if (expiryRaw !== undefined && !/^\d+$/.test(expiryRaw)) {
    throw new Error(`EXPIRY must be a non-negative integer (unix timestamp; 0 = never); got "${expiryRaw}"`);
  }
  const expiry = expiryRaw !== undefined ? BigInt(expiryRaw) : 0n; // 0 = never expires (PayWithQuai.sol:268)

  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    throw new Error(`No signer configured for network "${networkName}". Set the deployer key in contracts/.env.`);
  }
  const signer = signers[0];
  const merchant = signer.address; // registerOrder always records msg.sender as the merchant

  const deployFile = path.join(__dirname, '..', '..', 'deployments', `${networkName}.json`);
  if (!fs.existsSync(deployFile)) {
    throw new Error(`No deployment found at ${deployFile}. Run scripts/evm/deploy.js first.`);
  }
  const dep = JSON.parse(fs.readFileSync(deployFile, 'utf8'));
  if (!dep.payWithQuai) {
    throw new Error(`${deployFile} has no "payWithQuai" (proxy) address.`);
  }

  // --- [1] network / signer / balance, mainnet guard ---------------------------------------
  console.log('[1] Network / signer');
  const { chainId } = await ethers.provider.getNetwork();
  const chainIdNum = Number(chainId);
  console.log(`   network:  ${networkName}`);
  console.log(`   chainId:  ${chainIdNum}`);
  console.log(`   signer:   ${signer.address}  ${explorerAddressLink(networkName, signer.address)}`);
  const balance = await ethers.provider.getBalance(signer.address);
  console.log(`   balance:  ${ethers.formatEther(balance)} ETH`);
  if (balance === 0n) {
    throw new Error(`Signer ${signer.address} has zero balance on ${networkName} — fund it from a faucet first.`);
  }
  if (MAINNET_CHAIN_IDS.includes(chainIdNum)) {
    throw new Error(
      `Refusing to run against chainId ${chainIdNum} (${networkName}) — EVM mainnet is disabled from ` +
        'scripts/evm/payLink.js, exactly as scripts/evm/deploy.js refuses to deploy there.',
    );
  }

  const PayWithQuai = await ethers.getContractFactory('PayWithQuai', signer);
  const pay = new ethers.Contract(dep.payWithQuai, PayWithQuai.interface, signer);
  console.log(`   contract: ${dep.payWithQuai}  ${explorerAddressLink(networkName, dep.payWithQuai)}`);

  // --- [2] read the order first --------------------------------------------------------------
  console.log('\n[2] Reading the order on-chain');
  let order = await pay.getOrder(merchant, orderId);
  if (order.exists) {
    console.log(`   order already exists (nonce ${order.nonce}) — skipping registration.`);
    if (order.settled) {
      console.log(`   order is already settled (settledAt ${order.settledAt}) — nothing left to do.`);
      return;
    }
    if (order.token.toLowerCase() !== token.toLowerCase() || order.amount !== amount) {
      console.warn(
        '   warning: the EXISTING on-chain order does not match the TOKEN/AMOUNT given here ' +
          `(on-chain: token=${order.token} amount=${order.amount}; given: token=${token} amount=${amount}) — ` +
          'paying the order as it was actually registered.',
      );
    }
  } else {
    console.log('   order does not exist yet.');

    // --- [3] register it, with the EXACT orderId given -------------------------------------
    console.log(`\n[3] Registering orderId=${orderId}`);
    await send(
      'registerOrder',
      networkName,
      pay.interface,
      pay.registerOrder(orderId, token, amount, expiry),
    );
    order = await pay.getOrder(merchant, orderId);
  }

  // --- [4] pay it ----------------------------------------------------------------------------
  // payOrder/payOrderNative don't take token/amount arguments — they use whatever is in storage,
  // so paying against `order` (not the raw TOKEN/AMOUNT env vars) is correct either way.
  const payToken = order.token;
  const payAmount = order.amount;
  const isNative = payToken.toLowerCase() === ZERO.toLowerCase();
  console.log(`\n[4] Paying the order (${isNative ? 'native' : 'ERC-20'})`);
  let payReceipt;
  if (isNative) {
    payReceipt = await send(
      'payOrderNative',
      networkName,
      pay.interface,
      pay.payOrderNative(merchant, orderId, { value: payAmount }),
    );
  } else {
    const erc20 = new ethers.Contract(
      payToken,
      ['function approve(address spender, uint256 amount) returns (bool)'],
      signer,
    );
    await send('approve', networkName, pay.interface, erc20.approve(dep.payWithQuai, payAmount));
    payReceipt = await send('payOrder', networkName, pay.interface, pay.payOrder(merchant, orderId));
  }
  printSettlement(payReceipt, pay.interface, isNative ? 'native' : 'ERC-20');

  // --- [5] read the order back ---------------------------------------------------------------
  console.log('\n[5] Reading the order back');
  const finalOrder = await pay.getOrder(merchant, orderId);
  console.log(`   settled: ${finalOrder.settled}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
