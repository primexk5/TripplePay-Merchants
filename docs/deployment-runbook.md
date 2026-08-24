# Pay with Quai — Deployment & Test-Run Runbook

An operational guide for standing up the Pay with Quai stack on Quai testnet (Orchard) and
running the full payment loop end to end. Written directly from the source code
(`contracts/`, `backend/`), including every environment variable, script, and endpoint.

The stack has two deployable parts:

| Part | Directory | What it is |
|---|---|---|
| Contracts | `contracts/` | Hardhat project. Deploys the `PayWithQuai` UUPS proxy (the payment router) plus a testnet mock stablecoin and optional governance timelock. |
| Backend (relayer) | `backend/` | TypeScript service: indexes `PaymentReceived` events, confirms finality, and delivers signed webhooks to merchants. Also hosts the merchant/admin HTTP API. |

---

## 1. Prerequisites

- Node.js **>= 20** (the backend declares `engines.node >= 20`).
- npm (or your favorite package manager).
- A **Quai testnet wallet** whose address starts with `0x00` (Cyprus-1 zone) funded with
  testnet QUAI for gas (Orchard faucet). The deployer key MUST be in the same zone you deploy
  to — Quai value cannot move across zones.
- Network access to the Orchard RPC (`https://orchard.rpc.quai.network`).
- Google Chrome not needed — this runbook's only tools are npm scripts and `curl`.

All commands below run from the project root `<repo>/contracts` and `<repo>/backend`
respectively.

---

## 2. Phase 1 — Deploy the contracts (testnet)

### 2.1 Install and verify

```bash
cd contracts
npm install
npm run compile      # hardhat compile
npm test             # in-process EVM tests — no network needed, ~40s mocha timeout
```

Expected: compile succeeds (Solidity 0.8.20, london EVM — no `PUSH0`), all
`test/PayWithQuai.test.js` cases pass.

### 2.2 Configure the deployer environment

```bash
cp .env.example .env
```

| Variable | Required | Meaning |
|---|---|---|
| `RPC_URL` | yes | `https://orchard.rpc.quai.network` (default). Mainnet: `https://rpc.quai.network` |
| `CHAIN_ID` | yes | `15000` Orchard testnet (default). Mainnet: `9` |
| `CYPRUS1_PK` | yes | Deployer private key; address must start `0x00` and hold QUAI for gas |
| `FEE_RECIPIENT` | no | Where platform fees go (defaults to deployer). Same zone; must accept native value |
| `FEE_BPS` | no | Platform fee in basis points: `0` = none, `50` = 0.5%, max `500` = 5% |
| `STABLECOIN_ADDR` | no | Real stablecoin to allowlist (mainnet). Testnet auto-allowlists the mock |
| `MULTISIG_ADDR` | no | If set, deploys a `TimelockController` and hands proxy ownership to it (§2.4) |
| `TIMELOCK_MIN_DELAY` | no | Timelock delay, seconds (default `172800` = 48h) |
| `MERCHANT_ADDR` | no | `payDemo.js` only: payout wallet for the demo (defaults to deployer) |

### 2.3 Deploy

```bash
npm run deploy:testnet        # == hardhat run scripts/deploy.js --network cyprus1
```

What the script deploys, in order (`contracts/scripts/deploy.js`):

1. **`MockStablecoin`** (mUSDQ, 6 decimals, open mint faucet) — **testnet only**; skipped when
   `CHAIN_ID == 9` (mainnet).
2. **`PayWithQuai` implementation** — the UUPS logic contract (stateless).
3. **`ERC1967Proxy`** — the stateful proxy, initialized with
   `initialize(feeRecipient, feeBps, deployer)`. **This is the address everything interacts
   with.**
4. The owner then allowlists **native QUAI** (`address(0)`) and the mock stablecoin (plus
   `STABLECOIN_ADDR` if set) via `setTokenAccepted`.
5. On **mainnet**, additionally allowlist the canonical tokens with
   `npx hardhat run scripts/allowTokens.js --network cyprus1` — it enables
   **USDT** (`0x0049F7cbCa3556C2DfaE62Aafa7015F99de1b8f5`) and **WQUAI**
   (`0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB`), skips anything already accepted, and
   verifies each tx. Override the list with `EXTRA_TOKENS=0x…,0x…` or `ONLY_TOKENS=0x…`;
   set `PAYWITHQUAI_ADDR` if deploying from another machine.
6. Optionally set **`ACCEPTED_TOKENS`** on the backend (comma-separated ERC-20 addresses) to
   restrict payment-link creation to the same list — unset means unrestricted; native QUAI is
   always allowed.

The script writes `deployments/<network>.json` (e.g. `deployments/cyprus1.json`):

```json
{
  "network":         "cyprus1",
  "chainId":         15000,
  "payWithQuai":     "0x...",    // <-- PROXY: use THIS address for relayer + all integrations
  "payWithQuaiImpl": "0x...",
  "timelock":        null,
  "mockStablecoin":  "0x...",
  "feeRecipient":    "0x...",
  "feeBps":          "0",
  "deployer":        "0x..."
}
```

### 2.4 (Production) Governance hand-off

Only when `MULTISIG_ADDR` is set: the script deploys the timelock and calls
`transferOwnership(timelock)`. Because the contract is `Ownable2Step`, the timelock must call
`acceptOwnership()` to finish — the script prints the exact target/data to schedule through
the multisig. Until then the deployer EOA remains owner. On testnet, leave `MULTISIG_ADDR`
unset for fast iteration.

---

## 3. Phase 2 — Run the backend relayer

### 3.1 Install and verify

```bash
cd backend
npm install
npm run typecheck      # tsc --noEmit
npm test               # vitest: api, indexer, dispatcher, signer, store, backoff, urlGuard
```

### 3.2 Configure

```bash
cp .env.example .env
```

| Variable | Default | Meaning |
|---|---|---|
| `RPC_URL` | — (required) | Quai zone RPC — **must be the same zone as the deployed proxy** (Orchard, `https://orchard.rpc.quai.network`) |
| `CHAIN_ID` | — (required) | Must match `deployments/<network>.json` `chainId` (`15000` testnet) |
| `PAYWITHQUAI_ADDRESS` | — (required) | The **proxy** address from the deployment record (`payWithQuai` field) |
| `START_BLOCK` | empty | Block to start indexing from. **Set to the proxy's deployment block** to capture history from launch; empty starts from `head - CONFIRMATIONS` on first boot |
| `CONFIRMATIONS` | `12` | Blocks before a `PaymentReceived` is treated as final (reorg protection) |
| `POLL_INTERVAL_MS` | `5000` | Indexer poll interval |
| `MAX_BLOCK_RANGE` | `2000` | Max blocks per `getLogs` call (chunking) |
| `WEBHOOK_MAX_ATTEMPTS` | `10` | Delivery attempts before permanent `failed` |
| `WEBHOOK_BASE_BACKOFF_MS` | `5000` | Exponential backoff base |
| `WEBHOOK_MAX_BACKOFF_MS` | `3600000` | Backoff cap (1h) |
| `WEBHOOK_TIMEOUT_MS` | `10000` | Per-delivery POST timeout |
| `WEBHOOK_ALLOW_INSECURE_URLS` | `false` | Set `true` **only** for local dev (`http://localhost` webhook targets) |
| `PORT` | `8080` | HTTP API port |
| `ADMIN_API_KEY` | — (required, ≥ 16 chars) | Bearer token for admin endpoints; generate a long random value |
| `PUBLIC_RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window for the public orders route |
| `PUBLIC_RATE_LIMIT_MAX` | `60` | Max requests per IP per window (429 + `Retry-After` on excess) |
| `DATABASE_PATH` | `./data/relayer.db` | JSON state file (cursors, merchants, deliveries). **Secrets are stored plaintext here** — restrict access (file is created `0600`, dir `0700`) |
| `LOG_LEVEL` | `info` | `trace | debug | info | warn | error` |
| `LOG_PRETTY` | `false` | Human-readable logs for local dev |

### 3.3 Run

```bash
npm run dev          # tsx watch — hot reload, for development
# or production build:
npm run build        # tsc → dist/
npm start            # node dist/index.js
```

On boot you should see: `starting Pay with Quai relayer` with the chain id, contract address
and confirmations, the store loading, and `HTTP API listening` on the port.

### 3.4 Health check

```bash
curl http://localhost:8080/health
```

```json
{
  "status": "ok",
  "contract": "0x...",
  "chainId": 15000,
  "cursor": 1234567
}
```

- `cursor` is the last fully-indexed block — it must **advance** over time (check again after
  a few polls).
- Missing `cursor` right after first boot is fine if `START_BLOCK` was empty; the indexer
  seeds it to `head - CONFIRMATIONS`.

---

## 4. Phase 3 — Run the end-to-end test loop

Goal: register an order, pay it, and watch the relayer deliver a **signed** webhook.

### 4.1 Start the dev webhook receiver (stands in for a merchant server)

```bash
cd backend
WEBHOOK_SECRET=whsec_test_1234567890 PORT=9000 npm run webhook-receiver
```

`src/dev/webhookReceiver.ts` verifies the `X-PayWithQuai-Signature` header against the secret
and prints every payload on `POST /webhook`.

### 4.2 Onboard the demo merchant (admin API)

With `WEBHOOK_ALLOW_INSECURE_URLS=true` in the relayer `.env` (local dev), register the
merchant payout address:

```bash
curl -X POST http://localhost:8080/v1/merchants \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "address":    "0x00...your merchant payout wallet...",
        "name":       "Demo Shop",
        "webhookUrl": "http://localhost:9000/webhook"
      }'
```

`201` returns the **`webhookSecret` exactly once** — export it to the receiver
(`WEBHOOK_SECRET=...`) and restart it. The payout address can be the deployer key used in
Phase 1 (that's what `payDemo.js` assumes).

Other admin endpoints available for the test run:

```bash
curl -H "Authorization: Bearer $ADMIN_API_KEY" http://localhost:8080/v1/merchants          # list
curl -X PATCH -H "Authorization: Bearer $ADMIN_API_KEY" -H "Content-Type: application/json" \
     -d '{"active":true}' http://localhost:8080/v1/merchants/0x00...                        # update
curl -H "Authorization: Bearer $ADMIN_API_KEY" http://localhost:8080/v1/deliveries          # delivery log
```

### 4.3 Run the payment demo (ERC-20 path)

```bash
cd contracts
npm run demo:testnet        # == hardhat run scripts/payDemo.js --network cyprus1
```

`scripts/payDemo.js` does the full loop:

1. Mints `25.00` mUSDQ to the payer (mock faucet).
2. Registers an order on-chain: `orderId = keccak256("ord_demo_<timestamp>")`,
   `token = mockStablecoin`, `amount = 25_000000` (6 decimals), `expiry = 0`.
3. Approves the proxy for the amount.
4. Calls `payOrder(merchant, orderId)` and prints the `PaymentReceived` event
   (merchant, orderId, payer, token, amount, timestamp).
5. Confirms `isSettled == true`.

### 4.4 Watch the relayer deliver the webhook

Within a few seconds (poll interval 5s, plus 12 confirmations on a fast testnet):

1. The **indexer** logs `payment confirmed — webhook queued` with the delivery id
   (`<txHash>:<logIndex>`), then `indexed block range`.
2. The **dispatcher** POSTs to `http://localhost:9000/webhook` with headers
   `X-PayWithQuai-Signature: t=<unix>,v1=<hmac>`, `X-PayWithQuai-Event: payment.confirmed`,
   `X-PayWithQuai-Delivery: <id>`.
3. The **receiver** prints `✅ payment.confirmed (<id>)` and the payload:
   `merchantId`, `merchant`, `orderId`, `payer`, `token`, `amount`, `feeBps`, `fee`, `net`,
   `txHash`, `blockNumber`, `timestamp` (amounts are decimal strings in the smallest unit).
4. The dispatcher logs `webhook delivered` — the delivery is now `delivered`.

### 4.5 Verify status endpoints

```bash
curl "http://localhost:8080/v1/orders/0x00...merchant.../0x...orderId..."
```

```json
{
  "merchant": "0x00...",
  "orderId": "0x...",
  "token": "0x...",
  "amount": "25000000",
  "feeBps": 0,
  "expiry": "0",
  "settled": true,
  "webhook": { "status": "delivered", "attempts": 1 }
}
```

`/v1/deliveries` shows the delivery history (last 100). A failed delivery can be re-queued
with `POST /v1/deliveries/:id/retry`.

### 4.6 Optional: native QUAI path

`payDemo.js` covers ERC-20 only. To test the native path, register an order with
`token = 0x0000000000000000000000000000000000000000` and have the payer call
`payOrderNative(merchant, orderId)` with `msg.value` **exactly** equal to the registered
amount (anything else reverts `IncorrectNativeValue`). The relayer treats `token ==
address(0)` as native QUAI and reports it identically in the webhook.

### 4.7 Optional: unregistered-address catch-up

Pay an order with a merchant address that is **not** onboarded yet: the relayer records the
delivery as `skipped` (`no merchant registered for payout address`). Onboard that address
(§4.2) and the skipped delivery is automatically re-queued and delivered — a payment made
before registration is never lost.

---

## 5. Verification checklist

| # | Check | How |
|---|---|---|
| 1 | Contracts compile & unit tests pass | `npm test` in `contracts/` |
| 2 | Backend typecheck & unit tests pass | `npm run typecheck && npm test` in `backend/` |
| 3 | Deployment record written | `contracts/deployments/cyprus1.json` exists with a `payWithQuai` address |
| 4 | Relayer healthy | `GET /health` → `status: ok`, correct `contract`/`chainId`, cursor advancing |
| 5 | Merchant onboarded | `POST /v1/merchants` → 201 with `webhookSecret` |
| 6 | Order paid on-chain | `payDemo` prints `PaymentReceived` + `Order settled on-chain: true` |
| 7 | Webhook signed & delivered | Receiver logs `✅ payment.confirmed`; dispatcher logs `webhook delivered` |
| 8 | Status API reflects payment | `GET /v1/orders/...` → `settled: true`, `webhook.status: delivered` |
| 9 | Signature rejects tampering | Receiver returns `400 invalid signature` for a modified secret/body |

---

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Deploy fails with insufficient funds | Deployer not funded in Cyprus-1 | Fund the `0x00...` deployer from the Orchard faucet |
| `PAYWITHQUAI_ADDRESS ... is not a valid Quai zone address` | Address not in the zone matching the RPC | Use the proxy address from `deployments/<network>.json` on the same zone |
| Relayer finds no old payments | `START_BLOCK` empty → cursor seeded at `head - CONFIRMATIONS` | Set `START_BLOCK` to the proxy deployment block and restart (fresh `DATABASE_PATH`) |
| Webhook never delivered | Webhook URL blocked by SSRF guard / not https | Set `WEBHOOK_ALLOW_INSECURE_URLS=true` only in local dev; use public https in prod |
| Onboarding `400` | Address fails checksum or URL invalid/unsafe | Checksummed address; public https URL |
| Onboarding `409` | Address already registered | Use `PATCH /v1/merchants/:address`; the secret is never rotated |
| Delivery stuck `pending` with growing `attempts` | Endpoint not 2xx in 10s, or 3xx redirect | Return 2xx fast; never redirect; check `/v1/deliveries` `lastError` |
| Delivery `failed` | `WEBHOOK_MAX_ATTEMPTS` exhausted | `POST /v1/deliveries/:id/retry` after fixing the endpoint |
| `429 too many requests` | Public orders route rate limit (60/min/IP) | Slow down polling; add cache |
| `unhandledRejection — exiting` | Async path failed (process exits by design) | Read the log line; process manager restarts cleanly |
| `OrderAlreadySettled` at demo | The demo order id collided | Fresh timestamp in `ord_demo_<ts>` makes this unlikely; unique order ids are the rule |
| MockStablecoin missing | Ran on mainnet (`CHAIN_ID=9`) | Deploy skips the mock on mainnet; use `STABLECOIN_ADDR` |

---

## 7. Production deployment notes

- **Mainnet**: `RPC_URL=https://rpc.quai.network`, `CHAIN_ID=9`. `MockStablecoin` is **not**
  deployed — set `STABLECOIN_ADDR` to the real stablecoin to allowlist it. Never deploy the
  open-mint faucet to mainnet.
- **Governance**: set `MULTISIG_ADDR` (Gnosis Safe) so upgrades go through the timelock;
  complete the `acceptOwnership()` hand-off (§2.4).
- **Indexing**: set `START_BLOCK` to the proxy's deployment block on the very first relayer
  boot, so no payment history is missed.
- **Webhooks**: production webhook URLs must be https and publicly reachable; keep
  `WEBHOOK_ALLOW_INSECURE_URLS=false` (the default).
- **Secrets**: `ADMIN_API_KEY` ≥ 16 random chars; protect `DATABASE_PATH` (plaintext webhook
  secrets inside — created `0600`).
- **Process supervision**: the relayer exits intentionally on unhandled errors — run it under
  systemd/PM2/containers with auto-restart.
- **Frontend**: `frontend/` is currently the default Next.js scaffold (no checkout UI is
  implemented yet); merchants bring their own checkout calling `registerOrder`/`payOrder`
  (see the Merchant Integration Guide in this folder).
