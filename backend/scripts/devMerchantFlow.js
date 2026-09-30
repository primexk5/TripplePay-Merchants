#!/usr/bin/env node
/**
 * Dev merchant flow — exercises the full merchant journey (onboard, wallet-signature login,
 * create a per-chain payment link, read it back) against a RUNNING backend, with no frontend
 * involved. Built to test per-link chain selection (POST /v1/links' `chainId` field) end to end.
 *
 * This script never calls a live RPC and never signs an on-chain transaction — it only talks to
 * the backend's own HTTP API, plus local (offline) private-key -> address derivation and
 * EIP-191 personal-message signing via ethers. See the printed "Next steps" at the end for how
 * to actually register/claim/pay the link it creates.
 *
 * Usage (all values below are placeholders):
 *   BACKEND_URL=http://localhost:8095 \
 *   ADMIN_API_KEY=<your backend ADMIN_API_KEY> \
 *   MERCHANT_PK=0x<merchant private key> \
 *   CHAIN_ID=46630 \
 *   TOKEN_ADDRESS=0x0000000000000000000000000000000000000000 \
 *   AMOUNT=1000000000000000 \
 *   WEBHOOK_URL=http://localhost:4000/webhook \
 *   node backend/scripts/devMerchantFlow.js
 *
 * Env vars:
 *   BACKEND_URL     Base URL of the running backend (default http://localhost:8095).
 *   ADMIN_API_KEY   Required. The backend's admin bearer token (onboarding, GET /v1/chains).
 *   MERCHANT_PK     Required. The merchant's private key — used ONLY to derive its address and
 *                   sign the login challenge, locally. Never logged or written anywhere.
 *   CHAIN_ID        Required. Numeric chainId the link should be created on (must be one of this
 *                   backend's configured+enabled chains — see backend/chains.example.json).
 *   TOKEN_ADDRESS   Optional. ERC-20 address, or the native sentinel (default: native, address(0)).
 *   AMOUNT          Optional. Smallest-unit decimal string (default: 1000000000000000 — a small
 *                   native amount, e.g. 0.001 ETH-equivalent on an 18-decimal chain).
 *   WEBHOOK_URL     Optional. Where the merchant's webhook is registered to (default
 *                   http://localhost:4000/webhook — see scripts/devWebhookReceiver.js). Requires
 *                   WEBHOOK_ALLOW_INSECURE_URLS=true on the backend for a plain-http localhost URL.
 *   FRONTEND_URL    Optional. Only used to print the conventional /pay/<slug> checkout URL in the
 *                   summary (default http://localhost:3001, the frontend's documented dev port) —
 *                   this script never contacts it.
 */
import { Wallet, ZeroAddress, formatEther, hexlify, randomBytes } from 'ethers';

// --- config ------------------------------------------------------------------------------------

function requireEnv(name) {
  const v = process.env[name];
  if (!v) fail(`Set ${name} in the environment (see the usage comment at the top of this file).`);
  return v;
}

function fail(message) {
  console.error(`\n❌ ${message}`);
  process.exit(1);
}

const BACKEND_URL = (process.env.BACKEND_URL ?? 'http://localhost:8095').replace(/\/$/, '');
const FRONTEND_URL = (process.env.FRONTEND_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const ADMIN_API_KEY = requireEnv('ADMIN_API_KEY');
const MERCHANT_PK = requireEnv('MERCHANT_PK');
const CHAIN_ID_RAW = requireEnv('CHAIN_ID');
const CHAIN_ID = Number(CHAIN_ID_RAW);
const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS ?? ZeroAddress;
const AMOUNT = process.env.AMOUNT ?? '1000000000000000'; // 0.001 native, assuming 18 decimals
const WEBHOOK_URL = process.env.WEBHOOK_URL ?? 'http://localhost:4000/webhook';

if (!Number.isInteger(CHAIN_ID) || CHAIN_ID <= 0) {
  fail(`CHAIN_ID must be a positive integer, got "${CHAIN_ID_RAW}"`);
}

let merchantWallet;
try {
  merchantWallet = new Wallet(MERCHANT_PK);
} catch (err) {
  fail(`MERCHANT_PK is not a valid private key: ${err.message}`);
}

// --- tiny HTTP helper ----------------------------------------------------------------------------

/** POST/GET against the backend. `auth`, if given, is sent as `Authorization: Bearer <auth>` —
 *  works for both the admin bearer token and a session token (server.ts's requireSession()
 *  accepts a bearer token OR the HttpOnly cookie the browser would use; this script has no
 *  cookie jar, so it always uses the bearer form). */
async function req(method, path, { auth, body } = {}) {
  const headers = {};
  if (auth) headers.authorization = `Bearer ${auth}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, ok: res.ok, body: json };
}

/** Prints the status + body of a failed response (instead of a bare stack trace) and exits. */
function requireOk(res, context) {
  if (!res.ok) {
    console.error(`\n❌ ${context} failed: HTTP ${res.status}`);
    console.dir(res.body, { depth: null });
    process.exit(1);
  }
  return res.body;
}

function step(n, label) {
  console.log(`\n[${n}] ${label}`);
}

// --- the flow ------------------------------------------------------------------------------------

async function main() {
  console.log('=== TripplePay dev merchant flow ===');

  step(1, 'Config loaded from env');
  console.log(`  BACKEND_URL:   ${BACKEND_URL}`);
  console.log(`  CHAIN_ID:      ${CHAIN_ID}`);
  console.log(`  TOKEN_ADDRESS: ${TOKEN_ADDRESS}`);
  console.log(`  AMOUNT:        ${AMOUNT}`);
  console.log(`  WEBHOOK_URL:   ${WEBHOOK_URL}`);
  console.log('  ADMIN_API_KEY: (set, not printed)');
  console.log('  MERCHANT_PK:   (set, not printed)');

  step(2, 'Deriving merchant address from MERCHANT_PK (offline — no RPC)');
  const merchantAddress = merchantWallet.address;
  console.log(`  merchant address: ${merchantAddress}`);

  step(3, 'Checking backend health and confirming CHAIN_ID is configured + enabled');
  const health = requireOk(await req('GET', '/health'), 'GET /health');
  console.log(`  GET /health -> status=${health.status} healthy=${health.healthy} default chainId=${health.chainId}`);

  const chainsBody = requireOk(await req('GET', '/v1/chains', { auth: ADMIN_API_KEY }), 'GET /v1/chains (admin)');
  const chains = chainsBody.chains ?? [];
  const targetChain = chains.find((c) => c.chainId === CHAIN_ID);
  if (!targetChain) {
    fail(
      `CHAIN_ID=${CHAIN_ID} is not among this backend's configured+enabled chains: ` +
        (chains.length ? chains.map((c) => `"${c.id}" (chainId ${c.chainId})`).join(', ') : '(none configured)'),
    );
  }
  console.log(
    `  found chain: id="${targetChain.id}" kind=${targetChain.kind} name="${targetChain.name}" ` +
      `contract=${targetChain.contract} healthy=${targetChain.healthy}`,
  );
  if (!targetChain.healthy) {
    console.warn(`  ⚠️  chain "${targetChain.id}" currently reports unhealthy (lastError: ${targetChain.lastError}) — continuing anyway.`);
  }

  step(4, 'Onboarding the merchant (admin route)');
  const onboardRes = await req('POST', '/v1/merchants', {
    auth: ADMIN_API_KEY,
    body: { address: merchantAddress, name: `Dev merchant ${merchantAddress.slice(0, 8)}`, webhookUrl: WEBHOOK_URL },
  });
  let webhookSecret = null;
  let onboardedNow = false;
  if (onboardRes.status === 409) {
    console.log('  merchant already exists — continuing (its webhook secret is only shown at creation, not re-shown here).');
  } else {
    const onboarded = requireOk(onboardRes, 'POST /v1/merchants');
    webhookSecret = onboarded.webhookSecret;
    onboardedNow = true;
    console.log(`  onboarded: merchantId=${onboarded.merchantId}`);
  }

  step(5, 'Logging in (wallet-signature challenge, bound to CHAIN_ID)');
  const challenge = requireOk(
    await req('POST', '/v1/auth/challenge', { body: { address: merchantAddress, chainId: CHAIN_ID } }),
    'POST /v1/auth/challenge',
  );
  console.log(`  challenge message: ${challenge.message}`);
  const signature = await merchantWallet.signMessage(challenge.message);
  const login = requireOk(
    await req('POST', '/v1/auth/login', { body: { address: merchantAddress, message: challenge.message, signature } }),
    'POST /v1/auth/login',
  );
  // login also sets an HttpOnly session cookie for browsers; this script has no cookie jar, so
  // every authenticated call below uses the bearer token from the response body instead —
  // requireSession() in server.ts accepts either.
  const sessionToken = login.token;
  console.log(`  logged in: merchantId=${login.merchant.merchantId}, session expires ${new Date(login.expiresAt).toISOString()}`);

  step(6, `Creating a payment link on chainId=${CHAIN_ID}`);
  // Single-pay links (multiPay: false, the default) require EXACTLY one pre-chosen orderId in
  // orderPool — the merchant is expected to register this exact id on-chain separately (see the
  // "Next steps" printed below; POST /v1/links itself makes no on-chain call).
  const orderId = hexlify(randomBytes(32));
  const isNative = TOKEN_ADDRESS.toLowerCase() === ZeroAddress.toLowerCase();
  // Decimals for an arbitrary ERC-20 aren't known without an RPC call (disallowed here), so
  // amountDisplay is only a real conversion for the native case; for a custom token it's just the
  // raw smallest-unit value, clearly informational.
  const amountDisplay = isNative ? formatEther(AMOUNT) : AMOUNT;
  const symbol = isNative ? 'NATIVE' : 'TOKEN';
  const link = requireOk(
    await req('POST', '/v1/links', {
      auth: sessionToken,
      body: {
        shopName: 'Dev flow shop',
        tokenAddress: TOKEN_ADDRESS,
        amount: AMOUNT,
        amountDisplay,
        symbol,
        multiPay: false,
        orderPool: [orderId],
        chainId: CHAIN_ID,
      },
    }),
    'POST /v1/links',
  );
  console.log(`  created link: slug=${link.slug} chainId=${link.chainId}`);

  step(7, 'Reading the link back and verifying its chain — the main thing this script tests');
  const readBack = requireOk(await req('GET', `/v1/links/${link.slug}`), `GET /v1/links/${link.slug}`);
  if (readBack.chainId !== CHAIN_ID) {
    fail(
      `Chain mismatch! Created the link with chainId=${CHAIN_ID} but GET /v1/links/${link.slug} ` +
        `read it back with chainId=${readBack.chainId}. Per-link chain selection is NOT sticking correctly.`,
    );
  }
  console.log(`  ✅ chain matches: chainId=${readBack.chainId} (${readBack.chain?.name ?? 'unknown'}, kind=${readBack.chain?.kind ?? '?'})`);

  // step 8: summary --------------------------------------------------------------------------
  const payUrl = `${FRONTEND_URL}/pay/${link.slug}`;
  console.log('\n=== Summary ===');
  console.log(`Merchant address:   ${merchantAddress}`);
  console.log(`Merchant id:        ${login.merchant.merchantId}`);
  console.log(`Webhook secret:     ${onboardedNow ? webhookSecret : '(not shown — merchant already existed)'}`);
  console.log(`Link slug:          ${link.slug}`);
  console.log(`Pay URL (frontend): ${payUrl}   [conventional /pay/<slug> route — frontend not contacted by this script]`);
  console.log(`Link API URL:       ${BACKEND_URL}/v1/links/${link.slug}`);
  console.log(`Chain:              ${readBack.chainId} — ${readBack.chain?.name ?? targetChain.name} (kind=${readBack.chain?.kind ?? targetChain.kind})`);
  console.log(`Contract:           ${targetChain.contract}`);
  console.log(`Token:              ${TOKEN_ADDRESS}${isNative ? ' (native)' : ''}`);
  console.log(`Amount:             ${AMOUNT}  (display: ${amountDisplay})`);
  console.log(`Pre-registered orderId (in the link's pool): ${orderId}`);

  console.log('\nNext steps to claim and pay this link:');
  console.log('  1) The merchant must register this EXACT orderId on-chain FIRST, from their own');
  console.log('     wallet (this script never calls a live RPC) — payment reverts otherwise:');
  console.log(`       PayWithQuai(${targetChain.contract}).registerOrder(`);
  console.log(`         "${orderId}", "${TOKEN_ADDRESS}", ${AMOUNT}, 0 /* no expiry */)`);
  console.log(`       // signed by ${merchantAddress}, on chain ${CHAIN_ID}`);
  console.log('  2) A customer claims the link (binds it to their wallet, off-chain only):');
  console.log(`       curl -sX POST ${BACKEND_URL}/v1/links/${link.slug}/claim \\`);
  console.log('         -H "Content-Type: application/json" \\');
  console.log('         -d \'{"payerAddress":"0xCUSTOMER_ADDRESS_HERE"}\'');
  console.log('     -> returns { orderId, chainId, merchant, token, amount, poolRemaining }');
  console.log('  3) That SAME customer wallet then pays on-chain, using the orderId claim returned:');
  if (isNative) {
    console.log(`       PayWithQuai(${targetChain.contract}).payOrderNative(merchant, orderId, { value: amount })`);
  } else {
    console.log(`       token.approve(${targetChain.contract}, amount);`);
    console.log(`       PayWithQuai(${targetChain.contract}).payOrder(merchant, orderId)`);
  }
  console.log('  4) Once mined and past this chain\'s CONFIRMATIONS, the indexer delivers a signed');
  console.log(`     payment.confirmed webhook to ${WEBHOOK_URL} — run scripts/devWebhookReceiver.js to see it.`);
}

main().catch((err) => {
  console.error(`\n❌ unexpected error: ${err?.message ?? err}`);
  process.exit(1);
});
