# TripplePay || Marchants — Non-custodial crypto payments for Quai

Accept payments on the Quai network with a plain wallet — no accounts, no KYC, no custody. Customers can pay using any Quai-compatible browser extension (like Pelagus) or via mobile using **Blip**, the premier self-custody wallet for Quai (available on iOS & Android). 

**Supported assets** (Cyprus-1): native **QUAI**, plus ERC-20 payments in **USDT** (`0x0049F7cbCa3556C2DfaE62Aafa7015F99de1b8f5`, 6 dec) and **WQUAI** (`0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB`, 18 dec) — canonical addresses are built into the frontend registry (`frontend/src/lib/currencies.ts`); mUSDQ serves as the testnet mock. Tokens must be allowlisted by the contract owner (`contracts/scripts/allowTokens.js`; USDT and WQUAI are enabled on mainnet), and the backend can mirror the list via `ACCEPTED_TOKENS`.

A customer pays your checkout page, the `PayWithQuai` contract routes the funds straight to your wallet in the same transaction, and the relayer confirms it with a signed webhook your backend can verify.

```
customer                               PayWithQuai (on-chain)               your server
────────                               ──────────────────────               ──────────
checkout page ── payOrderNative ──────▶ verify amount
                                        split fee ─▶ feeRecipient
                                        forward rest ─▶ merchant wallet
                                        emit PaymentReceived
                                                   │
                                                   ▼
                                        relayer (indexer)
                                          wait CONFIRMATIONS
                                          re-check settlement
                                                   │
                                                   ▼
                                        signed POST ──────────────▶ webhook URL
                                        (HMAC-SHA256, retries)        (verify + credit order)
```

Funds never rest in the contract — every payment is routed through and out in one transaction. The relayer only observes; it can never touch funds.

## Repository layout

| Directory | What it is |
| --- | --- |
| [`contracts/`](contracts/) | Hardhat project: `PayWithQuai` UUPS-upgradeable router, governance timelock, mocks and test suite. |
| [`backend/`](backend/) | TypeScript relayer + API: indexer (poll `getLogs`, confirmations, settlement re-check), at-least-once webhook dispatcher with backoff, merchant API with wallet-signature sessions. Persistence is a JSON file by default; set `DATABASE_URL` to use PostgreSQL (required on Railway / for multiple instances). |
| [`frontend/`](frontend/) | Next.js app: landing page, merchant onboarding, login, dashboard (payments, analytics, settings), checkout demo, docs. |
| [`docs/`](docs/) | Runbooks, integration guides, pitch deck and UI spec. |

## Quick start

### 1. Contracts (one-time, optional for local dev)

```bash
cd contracts
npm install
npx hardhat test          # unit + upgrade tests
npm run deploy            # deploys PayWithQuai proxy on Cyprus-1 (network from contracts/.env)
```

The deployment writes `contracts/deployments/<network>.json` — the relayer keys off the `payWithQuai` proxy address.

### 2. Backend (relayer + API)

```bash
cd backend
npm install
cp .env.example .env      # fill in RPC_URL, PAYWITHQUAI_ADDRESS, ADMIN_API_KEY
npm run dev               # http://localhost:8080
npm test                  # vitest suite
```

- `PAYWITHQUAI_ADDRESS` must be the proxy from `contracts/deployments/cyprus1.json`.
- `ADMIN_API_KEY` is the bearer token for onboarding/demo admin routes — generate a long random value.
- Storage: leave `DATABASE_URL` unset to use the dependency-free JSON file store (single process).
  To use PostgreSQL, set `DATABASE_URL` (and `DATABASE_SSL=true` if your URL omits `sslmode`) —
  the schema is created automatically on boot. Railway sets `DATABASE_URL` for you when a
  Postgres service is attached; `railway.json` at the repo root configures the build/deploy.
- Local testing against an `http://localhost` webhook receiver requires `WEBHOOK_ALLOW_INSECURE_URLS=true` (SSRF guard is on by default; production URLs must be HTTPS and resolve to public IPs).
- A throwaway webhook receiver is included: `npm run webhook-receiver`.

### 3. Frontend

```bash
cd frontend
pnpm install
cp .env.local.example .env.local   # backend URLs (comma-separated), admin key, contract addresses
pnpm dev                            # http://localhost:3001
```

The frontend builds the checkout, wraps order registration/payment in `src/lib/payment.ts`, and ships a `/checkout/demo` flow plus an interactive `/docs` page.

## Merchant flow

1. **Onboard** (`/onboarding`) — name, webhook URL, and the wallet that will receive payouts. **Blip Pay** is supported natively: scan the QR code to open the Blip app (iOS & Android), or tap if on mobile.
2. **Log in** (`/login`) — connect the registered wallet (via extension or **Blip Pay**) and sign a single-use challenge (`tripplepay-login:<address>:<nonce>:<chainId>:<realm>`) returned by `/v1/auth/challenge`. The relayer consumes the nonce (no replay), binds the session to the chain and realm, and sets an HttpOnly session cookie. The admin API key stays server-side (frontend calls go through `/api/admin/...`).
3. **Dashboard** — see your payments (`/v1/me`, `/v1/me/deliveries`), balances across all
   supported assets, and edit your webhook URL. Payments made through links or checkout pages
   report the payer's optional display name and their origin (payment link vs checkout), so
   the payment history shows **who paid and for what** — expand any row for full details.
   The platform fee is 0.3%, deducted at settlement.
4. **Receive webhooks** (optional) — the relayer POSTs signed `payment.confirmed` events;
   verify with the secret. Webhook-less merchants (payment-link sellers without a website)
   still see every payment as confirmed on-chain in the dashboard.
5. **Share payment links** — build fixed or open-amount links in any supported asset from the
   dashboard; customers pay via browser wallet or Blip Pay QR.

## Blip Pay Integration

TripplePay || Marchants features native integration with **Blip Pay** across the entire merchant and customer lifecycle.

**For Customers (Mobile Payments):**
For physical or mobile-first commerce, the checkout can display a deep-link QR code.
- Scanning the QR automatically opens the Blip app (iOS & Android).
- The merchant address and payment amount are pre-filled using the `blip://pay` URI scheme.
- Users can confirm the transaction in a single tap on their phone.

**For Merchants (Auth & Dashboard):**
- Merchants can onboard and register their payout wallet directly via Blip.
- Login is handled via EIP-1193 signature validation — scanning the login QR opens Blip, allows a connection via the `blip://open` intent, and auto-detects `window.quai` inside the Blip in-app browser.

## API

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | — | Liveness |
| `GET /v1/orders/:merchant/:orderId` | public, rate-limited | Order status (RPC-backed) |
| `POST /v1/auth/login` | wallet signature | Create a session |
| `POST /v1/auth/logout` | session | Destroy the session |
| `GET /v1/me` · `PATCH /v1/me` | session | Read/update own merchant profile |
| `GET /v1/me/deliveries` | session | Payment history (enriched with payer name / link-vs-checkout origin) |
| `POST /v1/orders/:merchant/:orderId/meta` | public, rate-limited | Payer context reported by payment pages (best-effort) |
| `GET /v1/merchants/public` | public, rate-limited | Merchant directory for the landing-page showcase |
| `GET /v1/merchants` · `POST /v1/merchants` · `PATCH /v1/merchants/:address` | admin (`ADMIN_API_KEY`) | Onboarding & merchant management |
| `GET /v1/deliveries` · `POST /v1/deliveries/:id/retry` | admin | Delivery monitoring & retries |

## Webhook delivery

Webhooks are **optional** — merchants without a receiver URL simply rely on on-chain
confirmation (the dashboard shows every settlement as Confirmed regardless).

When a payment reaches finality (default 12 confirmations, with a second on-chain settlement check), the relayer queues exactly one webhook per `tx:logIndex` (idempotent) and delivers it at-least-once with exponential backoff + jitter until success or `WEBHOOK_MAX_ATTEMPTS`.

```http
POST /your/webhook
X-PayWithQuai-Signature: t=<unixSeconds>,v1=<hmacSha256(secret, `${t}.${rawBody}`)>
Content-Type: application/json

{ "type": "payment.confirmed", "id": "<deliveryId>", ... order details, tx hash, amount ... }
```

Verify the signature over the **raw body** (constant-time), tolerate a few seconds of clock skew, and respond `2xx` to acknowledge. See `backend/src/webhooks/signer.ts`.

## Security model

- **Non-custodial**: funds go customer → merchant in one transaction; fee is locked at order registration.
- **Order integrity**: orders are keyed by `(merchant, orderId)` and only the merchant can register/cancel their own — no front-running, no double-settle.
- **Signed webhooks**: HMAC-SHA256 with a per-merchant secret and timestamp binding; replay window is bounded.
- **SSRF guard**: webhook URLs are re-checked before every delivery (no private/loopback, no redirects, HTTPS required in production).
- **Session auth**: message signing with a 5-minute replay window; secrets never leave the wallet.

## Testnet deployment (Cyprus-1)

```json
{
  "payWithQuai": "0x0078cd401e3CF4bE9Bc3b104783c611e35F11816",
  "mockStablecoin": "0x0068f42D5Bd511363f52a1ade1ecD41B4bdD8F8e"
}
```

Chain ID `15000` · RPC `https://orchard.rpc.quai.network`.

## Documentation

The full runbook, integration guides and UI spec live in [`docs/`](docs/) (markdown + rendered PDFs). An interactive copy is served at `/docs` in the frontend.

## Community

- WhatsApp community: <https://chat.whatsapp.com/CNBs1pYBBJ96Kw4wgHgzl1>
- X (Twitter): [@Tripplepay_M](https://x.com/Tripplepay_M)