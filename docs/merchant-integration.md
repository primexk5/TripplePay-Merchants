# Pay with Quai — Merchant Integration

Accept crypto payments on Quai in 3 steps. Funds go straight to your wallet (the contract
holds nothing), and you get a signed webhook when a payment confirms.

```
1. You register an order on-chain   →   2. Customer pays it   →   3. We POST you a webhook
```

---

## Before you start

Your platform operator gives you three things at onboarding (which you can complete securely via browser extensions or natively using **Blip Pay** on mobile):

| You receive | What it's for |
|---|---|
| `PAYWITHQUAI_ADDRESS` | The contract address you register orders on |
| `webhookSecret` | Secret key to verify webhooks are really from us (**shown once — store it safely**) |
| `merchantId` | Your platform id, e.g. `mch_ab12...` |

**Platform fee: 0.3%** (30 bps), deducted at settlement — you receive `net = amount − fee`.
The fee is locked at registration, so a change of fee can never retroactively hit a live order.

Two rules that matter:

- **Same zone.** Quai is sharded. Your payout wallet, your customers, and the contract must
  all be in the **same zone** (the contract address prefix tells you which, e.g. `0x00…` =
  Cyprus-1). Value can't move between zones.
- **Amounts are in the token's smallest unit**, as strings/bigint — never floats. For a
  6-decimal stablecoin, `$25.00` = `25000000`. QUAI is `token = address(0)` (18 decimals).

### Already deployed (Cyprus-1, Orchard testnet) — no deployment needed

| What | Address / value |
|---|---|
| `PAYWITHQUAI_ADDRESS` | `0x00707FB75afede47F3cE44A357fb2fb29C14734e` |
| Mock stablecoin (`mUSDQ`, 6 decimals) | `0x003fafB5126a5296c6edC7C23De55daf2E84B503` |
| RPC | `https://orchard.rpc.quai.network` (use `usePathing: true`) |
| chainId / zone | `15000` / Cyprus-1 |

### Quai mainnet (chain 9, Cyprus-1)

| Asset | Address | Decimals | Notes |
|---|---|---|---|
| QUAI (native) | `address(0)` | 18 | Native gas asset — always accepted |
| USDT (Tether USD) | `0x0049F7cbCa3556C2DfaE62Aafa7015F99de1b8f5` | 6 | Canonical mainnet token |
| WQUAI (Wrapped Quai) | `0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB` | 18 | ERC-20 form of QUAI |
| mUSDQ (mock) | `0x003fafB5126a5296c6edC7C23De55daf2E84B503` | 6 | Testnet faucet only |

ERC-20 orders revert with `TokenNotAccepted` unless the contract owner has allowlisted the
token (`npx hardhat run scripts/allowTokens.js --network cyprus1` — USDT and WQUAI are
already enabled on mainnet). The backend can optionally mirror this list via
`ACCEPTED_TOKENS` to guard payment-link creation.

Use the **`quais` package** (`npm install quais`) — Quai's ethers fork. It ships
`usePathing` (zone-aware RPC), `formatQuai`/`parseQuai`, and the wallet types the
checkout examples below rely on. All examples in this guide import from `quais`.

---

## Zero-code: payment links

If you don't want to run any backend code, use the merchant dashboard:

1. **Dashboard → Payment links → Connect payout wallet** (the wallet that will receive the funds).
2. Pick the asset (**QUAI**, **mUSDQ**, **USDT** or **WQUAI**), enter the amount, optionally
   restrict the link to one customer (`expected payer`) and set an expiry.
3. **Create** — your wallet signs the on-chain order registration, and you get a link:
   `https://<platform>/pay/<slug>`.
4. Share the link. The customer opens it, optionally leaves a display name (shown on your
   dashboard as **"Paid by …"**, together with whether the payment came from a link or your
   checkout page), and pays with any Quai wallet or **Blip Pay**. The platform fee (0.3%) is
   split off at settlement automatically. No website or webhook required — every payment is
   verified on-chain and lands directly in your wallet.

The link is a real on-chain order — the same contract, fee and webhook flow as the API below,
just registered through the dashboard UI instead of your backend.

---

## Step 1 — Register the order (from your backend)

Register every expected payment before the customer pays. Broadcast **from your payout
wallet** — that wallet becomes both your merchant identity and where the money lands.

```ts
import { Contract, Wallet, JsonRpcProvider, id } from 'quais';   // NOT ethers

const provider = new JsonRpcProvider('https://orchard.rpc.quai.network', undefined, { usePathing: true });
const wallet   = new Wallet(BACKEND_PRIVATE_KEY, provider);   // your payout wallet
const pay      = new Contract(PAYWITHQUAI_ADDRESS, PAYWITHQUAI_ABI, wallet);

// Cryptographically random order id — Math.random()/timestamps are predictable, and a
// guessed id is a DoS vector on the order-lookup API.
const bytes = crypto.getRandomValues(new Uint8Array(24));
const orderId = id('ord_web_' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(''));

const amount  = 25000000n;                                      // $25.00, smallest unit

// registerOrder(orderId, token, amount, expiry)   expiry 0 = never expires
// NOTE: msg.sender becomes the merchant — this payout wallet is the address customers pay to.
const tx = await pay.registerOrder(orderId, TOKEN_ADDRESS, amount, 0n);
await tx.wait();
```

- `token`: an allowlisted ERC-20 address, or `address(0)` for native QUAI.
- The platform fee is locked into the order automatically here — you don't pass it.
- Orders are keyed by `orderKey(merchant, orderId)` — a wallet can only see the orders
  it registered, and customers pass that wallet address as `merchant` when paying.
- **Expect a specific payer** (prepaid / invoice payments): use
  `registerOrderWithPayer(orderId, token, amount, expiry, customerAddress)` — only that
  wallet can settle the order, so nobody can front-run the payment. `address(0)` = anyone may pay.

ABI for the functions you need:

```ts
const PAYWITHQUAI_ABI = [
  // Register — merchant backend, broadcast from the payout wallet
  "function registerOrder(bytes32 orderId, address token, uint256 amount, uint256 expiry)",
  "function registerOrderWithPayer(bytes32 orderId, address token, uint256 amount, uint256 expiry, address payer)",
  // Pay — customer wallet
  "function payOrder(address merchant, bytes32 orderId)",
  "function payOrderNative(address merchant, bytes32 orderId) payable",
  // Read — anyone; display a checkout and verify settlement
  "function getOrder(address merchant, bytes32 orderId) view returns (address merchant, bool settled, bool exists, uint16 feeBps, address token, uint256 amount, uint256 expiry, address feeRecipient, uint256 settledAt, address expectedPayer, uint64 nonce)",
  "function isSettled(address merchant, bytes32 orderId) view returns (bool)",
  // Manage — merchant wallet
  "function cancelOrder(bytes32 orderId)",
  "function purgeSettledOrder(bytes32 orderId)",
];
```

---

## Step 2 — Customer pays

Point the customer at any checkout you own. Payment is always a single contract call.

**ERC-20** — approve, then pay:

```ts
await token.approve(PAYWITHQUAI_ADDRESS, amount);   // customer approves exact amount
await pay.payOrder(MERCHANT_ADDRESS, orderId);       // customer pays
```

**Native QUAI** — send exact value:

```ts
await pay.payOrderNative(MERCHANT_ADDRESS, orderId, { value: amount });
```

The contract splits off the fee, forwards the rest to your wallet, and marks the order
settled — all in one transaction. A second payment reverts, so double-fulfillment is
impossible.

---

## Mobile payments with Blip

TripplePay || Marchants natively supports **Blip Pay** for mobile checkouts. Instead of a standard wallet popup, you can present a QR code or deep link that opens the Blip app (iOS & Android) directly.

Encode your checkout page URL in a QR code, or deep-link mobile users into Blip's in-app browser:

```ts
const checkoutUrl = `${ORIGIN}/checkout/${merchant}/${orderId}`;

// QR — works on any phone (Blip in-app browser or Pelagus / MetaMask in Safari/Chrome)
<QRCode value={checkoutUrl} size={160} />

// Mobile — open checkout inside the Blip app (iOS & Android)
const blipLink = `https://blippay.me/browser?url=${encodeURIComponent(checkoutUrl)}`;
```

> **Do NOT use `blip://pay` for registered orders.** `blip://pay?to=…&amount=…` sends QUAI
> directly to an address and skips PayWithQuai — no order settlement, no webhook. Always
> route customers through your checkout URL instead.

When a user browses your checkout from within the Blip in-app browser, `window.quai` is
injected automatically. Detect it to make payment one tap:

```ts
// window.quai (Blip) / window.pelagus (Pelagus) / window.ethereum (MetaMask, chainId 15000)
const provider = new BrowserProvider(window.quai ?? window.pelagus ?? window.ethereum);
const accounts = await provider.send('quai_requestAccounts', []);   // EIP-1193
```

## Reading an order on-chain (checkout page)

Build the checkout URL as `/checkout/<merchant>/<orderId>` and render the order **from the
contract** — never trust a client-side cart total:

```ts
const provider = new JsonRpcProvider(RPC_URL, undefined, { usePathing: true });
const pay      = new Contract(PAYWITHQUAI_ADDRESS, PAYWITHQUAI_ABI, provider);

const order = await pay.getOrder(MERCHANT_ADDRESS, orderId);
// { merchant, settled, exists, feeBps, token, amount, expiry,
//   feeRecipient, settledAt, expectedPayer, nonce }

if (!order.exists)  return 'order not found';
if (order.settled)  return 'already paid';
if (order.expiry > 0n && Date.now() / 1000 > Number(order.expiry)) return 'expired';

const net = order.amount - (order.amount * BigInt(order.feeBps)) / 10000n;
// display: amount due · includes (feeBps/100)% platform fee · merchant receives net
// expectedPayer != address(0) → only that wallet may pay (reverts with WrongPayer)
```

---

## Step 3 — Receive & verify the webhook

When the payment is final, we POST one webhook to your endpoint:

```json
{
  "id":   "0xabc...:3",
  "type": "payment.confirmed",
  "created": 1738340000,
  "data": {
    "merchantId": "mch_ab12...",
    "merchant":   "0x00...",       // on-chain payout address
    "orderId":    "0x...",
    "payer":      "0x...",
    "token":      "0x0000000000000000000000000000000000000000",
    "amount":     "25000000",   // gross the payer sent
    "feeBps":     30,          // platform fee rate locked at registration (0.3%)
    "fee":        "75000",      // platform fee = floor(amount × feeBps / 10000)
    "net":        "24925000",   // what you actually received
    "txHash":     "0x...",
    "blockNumber": 1234567,
    "timestamp":  1738340000,  // on-chain settlement time
    "nonce":      1            // per-merchant order nonce; bumps when an order id is reused after a purge
  }
}
```

**Always verify the signature** before trusting a webhook, then credit `net` to the order.

```ts
import express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';

const app = express();
// IMPORTANT: hash the raw body — not parsed-then-restringified JSON.
app.post('/webhooks/paywithquai', express.raw({ type: 'application/json' }), (req, res) => {
  const header = req.header('X-PayWithQuai-Signature') ?? '';        // "t=...,v1=..."
  const raw    = req.body.toString('utf8');
  const { t, v1 } = Object.fromEntries(header.split(',').map((p) => p.split('=')));

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(t)) > 300) return res.sendStatus(400);   // reject stale (>5 min)

  const expected = createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${raw}`).digest();
  const received = Buffer.from(v1, 'hex');
  const ok = received.length === expected.length && timingSafeEqual(received, expected);
  if (!ok) return res.sendStatus(401);

  const { data } = JSON.parse(raw);
  // Idempotent: if you've already fulfilled this orderId/txHash, just ack and return.
  fulfillOrder(data.orderId, data.net);

  res.sendStatus(200);   // 2xx within 10s = success. Anything else is retried.
});
```

Your endpoint must be **https**, publicly reachable, respond **2xx within 10s**, and be
**idempotent** — the same payment can arrive more than once.

---

## Quick reference

**Check an order's status yourself** (fallback if you miss a webhook):

```
GET /v1/orders/0x<merchant>/0x<orderId>
→ { merchant, orderId, token, amount, feeBps, expiry, settled,
    webhook: { status: "pending" | "delivered" | "failed", attempts } | null }
```

Or read the chain directly — `getOrder(merchant, orderId)` / `isSettled(merchant, orderId)`.
`settled == true` is the final word on payment. For fulfillment, wait until
`settled && webhook.status === "delivered"` (poll the API above, ~120s max) — the signed
webhook is the receipt of record; a chain read alone is not treated as complete.

**Common reverts to surface to customers:**

| Revert | Meaning |
|---|---|
| `OrderAlreadySettled` | already paid |
| `OrderExpired` | past the expiry timestamp |
| `IncorrectNativeValue` | `msg.value` ≠ the order amount (native path) |
| `WrongPaymentPath` | used the ERC-20 call on a native order, or vice-versa |
| `OrderNotFound` | no such order for that merchant |
| `WrongPayer` | order was registered with `registerOrderWithPayer` and you're not the expected payer |
| `OrderAlreadyExists` | this orderId is already registered — use a fresh random id |
| `TokenNotAccepted` | token isn't allowlisted on the contract |
| `ZeroAmount` | order amount was zero |

**Managing orders** (all from your payout wallet):

- `cancelOrder(orderId)` — cancel an unpaid order and free the id.
- `purgeSettledOrder(orderId)` — reclaim storage 1 day after settlement.
- Use a fresh `orderId` per payment; reusing ids makes status lookups ambiguous.

---

## Testing on testnet

The contract is **already deployed** on Cyprus-1 (Orchard testnet) — no deployment needed:

- PayWithQuai proxy: `0x00707FB75afede47F3cE44A357fb2fb29C14734e`
- Mock stablecoin: `0x003fafB5126a5296c6edC7C23De55daf2E84B503`

To deploy your own copy or run the demo:

```bash
cd contracts
npm run deploy:testnet   # deploys contract + mock stablecoin
npm run demo:testnet     # mints, registers, approves, pays
```

Run a relayer locally against the same RPC. For local endpoints only, set
`WEBHOOK_ALLOW_INSECURE_URLS=true` to allow `http://localhost` webhook targets
(`npm run webhook-receiver` in `backend/` is a throwaway receiver for testing).
