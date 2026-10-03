# Pay with Quai — Backend (Relayer + API)

The off-chain half of the **Pay with Quai** checkout system. It watches the `PayWithQuai` proxy on
a Quai zone for `PaymentReceived` events, waits for finality, and delivers **signed webhooks** to
merchants — turning an on-chain settlement into a `payment.confirmed` callback your app can act on.

```
Quai zone                         this backend                         merchant
──────────                        ────────────                         ────────
PaymentReceived  ──poll getLogs──▶  Indexer
(on proxy)                            │  wait CONFIRMATIONS blocks
                                      │  re-check getOrder().settled on-chain
                                      ▼
                                   Store (queue, idempotent by tx:logIndex)
                                      │
                                      ▼
                                   Dispatcher ──POST signed JSON──▶  webhook URL
                                         (HMAC-SHA256, retries w/ backoff)
```

Everything is keyed to the **proxy** address from `contracts/deployments/<network>.json`
(`payWithQuai`), so contract upgrades never require a backend change.

## Components

| Module | Responsibility |
| --- | --- |
| `src/chain/client.ts` | Read-only quais client: block height (zone-scoped), fetch+decode `PaymentReceived`, `isSettled`/`getOrder`. |
| `src/indexer/indexer.ts` | Poll loop `cursor → head − CONFIRMATIONS`; verify settlement; enqueue one webhook per payment; advance the persisted cursor. |
| `src/webhooks/dispatcher.ts` | At-least-once delivery with exponential-backoff+jitter retries; survives restarts. |
| `src/webhooks/signer.ts` | Stripe-style HMAC signing + verification (also used by the dev receiver). |
| `src/store/json.ts` | Dependency-free, atomically-written JSON persistence behind the `Store` interface. |
| `src/api/server.ts` | HTTP API: health, order status, admin merchant onboarding, delivery inspection. |
| `src/chains.ts` | Loads + validates the multi-chain config (`CHAINS_JSON`/`CHAINS_CONFIG_PATH`, or the legacy single-chain fallback). |
| `src/chain/index.ts` | `ChainRegistry` — one live client per enabled chain, looked up by chainId or slug; `createChainClient()` picks QuaiClient vs EvmClient per chain. |

## Quickstart

```bash
cd backend
npm install
cp .env.example .env      # fill in PAYWITHQUAI_ADDRESS + ADMIN_API_KEY (see below)
npm run build && npm start # or: npm run dev  (watch mode)
```

Required env (full list with defaults in `.env.example`):

- `RPC_URL`, `CHAIN_ID` — the Quai zone RPC (must be the **same zone** the proxy was deployed to).
- `PAYWITHQUAI_ADDRESS` — the proxy address from the contracts deployment file.
- `ADMIN_API_KEY` — bearer token for the admin endpoints (generate a long random value).
- `START_BLOCK` — set to the proxy's deploy block to index from launch; otherwise the relayer
  starts from the current head on first boot (and remembers its cursor thereafter).

## Multi-chain

**One backend process serves every configured chain, sharing one database.** A merchant is
chain-free — the same merchant record and payout address work on every chain. A payment link
belongs to exactly one chain, chosen by the merchant at creation; the orders claimed from it
inherit that chain. Qi (Quai's UTXO-ledger checkout) stays feature-gated and Quai-only — it never
applies to an EVM chain.

Configuration lives in JSON, not individual env vars — see `.env.example`'s "Multi-chain
configuration" section and `chains.example.json` for the full three-chain example (Quai mainnet
default, Robinhood Chain testnet enabled, Base Sepolia present-but-disabled). Each entry:

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Short lowercase slug (`"robinhood-testnet"`) used in APIs/logs and as a `?chainId=`/`chainId` value alongside the numeric chainId. |
| `chainId` | yes | The chain's numeric chain id. Must be unique across the whole list. |
| `kind` | yes | `"quai"` (quais SDK, Cyprus-1 zone rules) or `"evm"` (ethers v6, plain EIP-55). `"quai"` requires a recognized Quai chain id (`src/chains.ts#KNOWN_QUAI_CHAIN_IDS`, currently mainnet `9` and Orchard testnet `15000`) — add new Quai networks there, not by guessing. |
| `name` | yes | Human-readable display name. |
| `rpcUrl` | yes | JSON-RPC endpoint for this chain. |
| `contractAddress` | yes | The `PayWithQuai` proxy address on this chain (from `contracts/deployments/<network>.json`). |
| `startBlock` | no | Index from this block on first boot; omit to start from `head - confirmations`. |
| `confirmations` | no (default 12) | See "Tuning confirmations per chain" below. |
| `pollIntervalMs` | no (default 5000) | Indexer poll interval for this chain. |
| `maxBlockRange` | no (default 2000) | Max block span per `getLogs` call (catch-up chunking). |
| `acceptedTokens` | no | This chain's own ERC-20 allowlist for payment links (addresses). Omit for unrestricted — every chain's allowlist is independent. |
| `explorerUrl` | no | Block explorer base URL (informational). |
| `enabled` | no (default true) | `false` disables the chain entirely — no client, no indexer, not resolvable by id/slug/chainId, even explicitly. |
| `default` | no | At most one **enabled** chain may set this `true`. Chain-less requests (no `chainId` on a link/order/login-challenge) resolve to it. If none is marked, the first enabled entry wins. |

### Adding a chain

1. Deploy `PayWithQuai` to the new chain (`contracts/`) and note the proxy address + deploy block.
2. Add an entry to your `chains.json` (or `CHAINS_JSON`) with a unique `id`/`chainId`, the right
   `kind`, `rpcUrl`, `contractAddress`, and `startBlock` set to the deploy block.
3. Pick `confirmations` for it (see below).
4. Restart the backend. `GET /health` and the admin `GET /v1/chains` will list it once the
   registry picks it up; a fresh chain seeds its indexer cursor from `startBlock` (or current head
   if omitted) on first boot, same as any other chain.
5. To retire a chain without losing its history, set `"enabled": false` rather than deleting the
   entry — its links/orders/deliveries stay in the database and still resolve for reads, but no
   new client/indexer is built for it and it can no longer be selected for new links/logins.

### Tuning confirmations per chain

There is no single safe default across chains — `CONFIRMATIONS` trades off "how long until a
customer's payment shows as confirmed" against "risk of confirming a payment that a reorg later
undoes." Quai's default of 12 is tuned for Quai's own Cyprus-1 zone and is **not** a safe number
to copy onto an unrelated chain:

- **L1s / established networks**: use the chain's own documented finality guidance if it has one.
- **L2s / rollups / newer testnets**: reorg depth is often less battle-tested or less
  well-documented than a mature L1's. Start conservative (e.g. `chains.example.json` uses `20` for
  Robinhood Chain testnet — higher than Quai's `12` — as a starting point, not a measured value)
  and tighten it once you've observed the chain's actual reorg behavior, or once the chain
  publishes a documented finality/challenge period.
- A higher `confirmations` only delays *when* a payment is confirmed — it never causes a payment
  to be missed (the indexer's cursor and the on-chain settlement re-check are unaffected).

### Existing-database migration behavior

Upgrading an existing single-chain deployment to this multi-chain code is **non-destructive** and
requires no manual migration step:

- **PostgreSQL**: `init()` (already run on every boot) adds a nullable `chain_id` column to
  `links` and `order_meta` with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, backfills any existing
  `NULL` rows to the default chain's chainId, and indexes the column — all idempotent (safe to run
  on every boot, including ones that already migrated) and it never touches any other column or
  drops/recreates a table. `deliveries` gets no new column at all: its `chainId` is carried inside
  the already-JSONB `payload` and derived from there on read (falling back to the default chain
  for a delivery whose payload predates this field).
- **JSON file store**: no schema to migrate — a link/order-meta/delivery record loaded from disk
  with no `chainId` is backfilled to the default chain's chainId **in memory** the moment the
  store loads; the file on disk is rewritten with the filled-in value the next time that record is
  written (e.g. any right after startup), same as any other update.
- **Merchants are untouched** either way — they never had (and still don't have) a `chainId` at
  all, since a merchant is chain-free by design (see "Multi-chain" above).
- **Indexer cursors are untouched** — `cursorScope(chainId, contractAddress)` already existed
  before multi-chain support and its format hasn't changed, so a legacy deployment's existing
  cursor is picked up by its chain's indexer exactly as before, with no gap and no re-scan.
- **Merchant API keys are upgraded in place.** Keys used to be stored as plaintext bearer secrets
  and are now stored only as `HMAC-SHA256(API_KEY_PEPPER, key)`. Existing keys keep working with no
  re-issue and no downtime: Postgres gets `key_hash`/`key_ref` columns via
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, and the first request that presents a still-plaintext
  key rewrites that row hashed in place (emptying `key`) before the request is authorized. The JSON
  store does the same thing in memory on load. A key that is never presented again is never
  migrated — revoke it with `DELETE /v1/me/apikeys/:keyRef` instead.

## API

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | — | Liveness + per-chain indexer health/cursor for every configured chain (plus legacy top-level fields for the default chain). |
| `GET /v1/orders/:merchant/:orderId` | — | On-chain order + settlement status, plus local webhook status. Optional `?chainId=` (slug or numeric), defaults to the default chain. |
| `GET /v1/merchants` | admin | List onboarded merchants (no secrets). |
| `POST /v1/merchants` | admin | Onboard/update a merchant; returns the webhook secret **once**. |
| `PATCH /v1/merchants/:address` | admin | Update `name` / `webhookUrl` / `active` **without** rotating the secret. |
| `GET /v1/deliveries` | admin | Recent webhook deliveries (debugging). |
| `POST /v1/deliveries/:id/retry` | admin | Re-queue a `failed`/`skipped` delivery as `pending` (manual reconciliation). |
| `GET /v1/chains` | admin | Every configured (enabled) chain and its health — same shape as `GET /health`'s `chains` array. |

Admin calls need `Authorization: Bearer $ADMIN_API_KEY`.

Onboard a merchant (maps an on-chain payout address → your `merchantId` + webhook URL):

```bash
curl -sX POST localhost:8080/v1/merchants \
  -H "authorization: Bearer $ADMIN_API_KEY" -H 'content-type: application/json' \
  -d '{"address":"0x00..payout","name":"Acme","webhookUrl":"https://acme.test/quai/webhook"}'
# → { "merchantId":"mch_...", "webhookSecret":"whsec_...", ... }   # store the secret!
```

Onboarding an address that received payments *before* it was registered automatically re-queues
those `skipped` payments as `pending` — nothing is lost.

## The webhook

On a confirmed payment the relayer POSTs this body to the merchant's `webhookUrl`:

```json
{
  "id": "0x<txHash>:<logIndex>",
  "type": "payment.confirmed",
  "created": 1786480000,
  "data": {
    "merchantId": "mch_ab12...",
    "merchant": "0x00…",
    "orderId": "0x…(bytes32)",
    "payer": "0x00…",
    "token": "0x0000000000000000000000000000000000000000",
    "amount": "25000000",
    "feeBps": 30,
    "fee": "75000",
    "net": "24925000",
    "txHash": "0x…",
    "blockNumber": 12345,
    "timestamp": 1786479990,
    "nonce": 1
  }
}
```

- `id` is the idempotency key — one per `(txHash, logIndex)`. Deduplicate on it; deliveries are
  at-least-once.
- `token` is `0x0…0` for native QUAI, else the ERC-20 address. `amount` is the **gross**
  smallest-unit value (decimal string); `fee` is the platform fee withheld
  (`floor(amount × feeBps / 10000)`, using the `feeBps` locked when the order was registered) and
  `net = amount − fee` is what the merchant actually received. Reconcile against `net`, not `amount`.

### Verifying the signature

Every request carries `X-PayWithQuai-Signature: t=<unix>,v1=<hmacHex>`, an HMAC-SHA256 over
`${t}.${rawBody}` using your `webhookSecret`. **Verify over the raw bytes**, before JSON parsing:

```ts
import { verifySignature } from './webhooks/signer.js';
const ok = verifySignature(secret, req.header('x-paywithquai-signature'), rawBody, Math.floor(Date.now() / 1000));
```

The check is constant-time and rejects timestamps older than 5 minutes (replay protection).

## Reliability model

- **Finality:** only blocks `≤ head − CONFIRMATIONS` are processed, and each event is re-verified
  against the on-chain order (`getOrder().settled`) — a shallow reorg can never trigger a false
  "paid". That same read yields the fee rate locked at registration, so the webhook's
  `fee`/`net` figures match the on-chain split without an extra RPC call.
- **Idempotency:** payments are keyed by `(txHash, logIndex)`; re-processing a block is a no-op.
- **Durability:** the block cursor and every delivery live in the store, so a restart resumes
  exactly where it left off and re-attempts pending webhooks. The cursor is keyed by
  `chainId:contractAddress`, so reusing a stale store file for a different deployment never
  silently skips events (the indexer simply re-scans).
- **Retries:** non-2xx / timeout → exponential backoff with jitter, up to `WEBHOOK_MAX_ATTEMPTS`,
  then marked `failed`. Batches are delivered concurrently so one slow merchant endpoint never
  stalls everyone else. Deactivated merchants (`PATCH .../merchants/:address` with
  `"active":false`) have their deliveries held (not failed, no attempts spent) and they resume
  automatically on re-activation.
- Payments to an address with **no registered merchant** are recorded as `skipped` (not lost) —
  onboarding that address re-queues them, and `POST /v1/deliveries/:id/retry` manually re-queues
  any `failed` delivery after the operator has fixed the cause.

## Local end-to-end

1. Deploy the contracts to a Quai zone and run the on-chain demo (`contracts/`):
   `npm run deploy` then `npm run demo` (network comes from `contracts/.env`).
2. Point this backend at the same zone + proxy address in `.env`, set `START_BLOCK` to the deploy
   block, and `npm run dev`.
3. Run the sample merchant endpoint and onboard a merchant pointing at it:
   ```bash
   WEBHOOK_SECRET=whsec_... PORT=9000 npm run webhook-receiver
   ```
   Because the receiver is on `http://localhost`, set `WEBHOOK_ALLOW_INSECURE_URLS=true` in the
   relayer's `.env` for local dev — otherwise the SSRF guard rejects the non-https/loopback URL.
   Trigger a payment (or re-run the demo) → the receiver prints the verified `payment.confirmed`.

> A full on-chain e2e requires a real Quai RPC (testnet/mainnet or a local Quai node) — quais uses
> Quai's sharded RPC (`usePathing`, zone-scoped calls), which a vanilla Hardhat EVM node does not
> speak. The pure logic (signing, backoff, store, dispatcher) is covered by `npm test`.

## Tests

```bash
npm run typecheck   # tsc --noEmit over src + test
npm test            # vitest: signer, backoff, store idempotency, dispatcher delivery/retry/fail
```

## Production notes

- **Storage:** the JSON store is right for a single relayer process. For HA or high volume,
  implement the `Store` interface (`src/store/index.ts`) over SQLite/Postgres — nothing else changes.
- **Secrets:** `ADMIN_API_KEY` and per-merchant `webhookSecret`s are sensitive. Onboarding returns
  a secret once; store it encrypted. Re-onboarding the same address **rotates** the secret. The
  store file (`DATABASE_PATH`) holds webhook secrets in plaintext and is written `0600` inside a
  `0700` directory — keep it off shared/backed-up paths. Merchant API keys are the exception: they
  are stored hashed, never in plaintext (see below).
- **Merchant API keys are hashed at rest.** A merchant API key is a bearer credential that can
  create gateway orders and move funds, so it is persisted only as
  `HMAC-SHA256(API_KEY_PEPPER, key)`; the plaintext exists only in the `POST /v1/me/apikeys`
  response and in the merchant's own environment. Consequences worth knowing:
  - `API_KEY_PEPPER` is **required** when `NODE_ENV=production` — boot fails without it, because the
    fallback pepper is a constant compiled into the source and would make a database leak
    replayable. Generate with
    `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
  - The pepper must be **stable across restarts and replicas**. Rotating it invalidates every key
    already issued; treat it like the signing key it effectively is.
  - `GET /v1/me/apikeys` returns metadata only (`keyRef`, `label`, timestamps) — listing keys never
    echoes a usable credential.
  - `DELETE /v1/me/apikeys/:keyRef` revokes by the short non-secret `keyRef` rather than the key, so
    a credential never has to appear in a URL (and therefore never lands in access logs, proxy logs
    or browser history). The `keyRef` is a truncated prefix of the stored hash.
  - Why a keyed hash and not bcrypt/argon2: authentication needs an indexed equality lookup ("which
    merchant owns this key?"), and password hashes are deliberately non-deterministic, which would
    force a scan-and-verify over the whole table. These keys are 144 bits of `randomBytes`, not
    guessable passwords, so a fast HMAC is the correct primitive; the pepper is what removes the
    offline-brute-force risk that a stolen table would otherwise carry.
- **Webhook URL safety (SSRF):** merchant webhook URLs must be `https` and must not resolve to a
  private/loopback/link-local/reserved address. This is enforced at onboarding **and** re-checked by
  DNS immediately before every delivery (blocking DNS-rebinding), and 3xx redirects are never
  followed. Set `WEBHOOK_ALLOW_INSECURE_URLS=true` **only** for local development.
- **Public endpoint:** `GET /v1/orders/:merchant/:orderId` is unauthenticated and hits the Quai RPC,
  so it is rate-limited per client IP (`PUBLIC_RATE_LIMIT_MAX` requests per
  `PUBLIC_RATE_LIMIT_WINDOW_MS`, default 60/min → `429` with `Retry-After`). Front it with a proxy
  and set `trust proxy` if you terminate TLS upstream.
- **Zone (Quai chains only):** each Quai-kind chain entry derives its own zone from its
  `contractAddress`; a router deployed to more than one Quai zone needs a separate `chains.json`
  entry per zone (still served by this same one process — see "Multi-chain" above).
