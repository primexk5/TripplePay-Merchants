# TripplePay Multi-Chain Readiness Audit

Read-only audit of the `feat/multichain` branch. Goal: understand what it would take to keep
**Quai (mainnet, chain 9, Cyprus-1)** working exactly as today while adding standard EVM chains,
starting with **Robinhood Chain testnet** (chain ID `46630`, RPC
`https://rpc.testnet.chain.robinhood.com/rpc`) and **Base Sepolia** (chain ID `84532`).

No files were modified. All paths are relative to the repo root.

---

## 1. Overview

TripplePay is a non-custodial merchant checkout system with three packages:

- **`contracts/`** — a Hardhat project holding `PayWithQuai.sol`, a UUPS-upgradeable payment
  router, plus a mock stablecoin and governance/test helpers. Deployed to Quai's Cyprus-1 zone.
- **`backend/`** — a TypeScript relayer + merchant API (Express). It indexes `PaymentReceived`
  events from the contract, verifies settlement on-chain, and delivers signed webhooks to
  merchants. It also runs a separate Qi (UTXO-ledger) settlement path for Quai-native Qi payments.
- **`frontend/`** — a Next.js 16 app: landing page, merchant onboarding/login/dashboard, payment
  links, and the checkout UI that builds and sends the on-chain transactions.

### End-to-end payment flow

```
merchant (dashboard/API)
   │ 1. registerOrder(orderId, token, amount, expiry)      [frontend/src/lib/payment.ts → quais Contract]
   ▼
PayWithQuai.sol (proxy)                                     [contracts/contracts/PayWithQuai.sol]
   │  order stored, keyed by keccak256(merchant, orderId)
   ▼
customer (checkout page)
   │ 2. approve() [ERC-20 only] then payOrder / payOrderNative
   ▼
PayWithQuai.sol
   │  verifies amount == order.amount, splits fee, forwards funds to merchant + feeRecipient
   │  in the SAME transaction, marks order settled, emits PaymentReceived + PaymentSettled
   ▼
backend Indexer (poll loop)                                  [backend/src/indexer/indexer.ts]
   │ 3. getLogs(PaymentReceived) once head - CONFIRMATIONS block passes the event's block
   │ 4. re-reads getOrder(merchant, orderId) on-chain — settlement re-check (2nd finality guard)
   │ 5. looks up the merchant by payout address, builds a WebhookPayload, queues a WebhookDelivery
   ▼
WebhookDispatcher (poll loop)                                 [backend/src/webhooks/dispatcher.ts]
   │ 6. POSTs the payload to merchant.webhookUrl, HMAC-SHA256 signed, retries with backoff
   ▼
merchant server                                                (verifies signature, credits order)
```

In parallel, the checkout page polls `GET /v1/orders/:merchant/:orderId` (RPC-backed) and the
on-chain `isSettled()` view directly, so the customer sees confirmation even before/without a
webhook (`frontend/src/lib/payment.ts:1037` `waitForConfirmation`, `:1248` `waitForOnChainConfirmation`).

Funds are **never custodied** by the contract or the backend — the relayer is purely an observer
(indexer + webhook dispatcher); it holds no keys capable of moving merchant/customer funds. This
non-custodial design is a major asset for multi-chain: the backend and frontend chain layers can
be replicated per-chain without touching the trust model.

---

## 2. Contracts (`contracts/`)

### 2.1 `PayWithQuai.sol` (`contracts/contracts/PayWithQuai.sol`)

A UUPS-upgradeable payment router. **Notably, this contract is plain, standard-EVM Solidity — it
contains no Quai-specific opcodes, precompiles, or SDK calls.** All "Quai-specific" behavior lives
in comments/docs (zone assumptions) and in the off-chain tooling that deploys/talks to it, not in
the bytecode itself.

- **Purpose**: merchants pre-register orders (`registerOrder`/`registerOrderBatch`/
  `registerOrderWithPayer`, lines 211–256), customers settle them (`payOrder` for ERC-20 at
  line 324, `payOrderNative` for native currency at line 351). Funds are forwarded to
  `merchant` and `feeRecipient` in the same transaction — the contract never holds a balance
  during normal operation.
- **Key functions**: `registerOrder`, `registerOrderBatch` (max 50, added in a v2 upgrade —
  see §2.3), `registerOrderWithPayer`, `cancelOrder`, `purgeSettledOrder`, `payOrder`,
  `payOrderNative`, admin: `setTokenAccepted`, `setFeeConfig`, `setPauseGuardian`, `pause`/
  `unpause`, `rescueTokens`, `_authorizeUpgrade`.
- **Events**: `OrderRegistered`, `OrderCancelled`, `OrderPurged`, `PaymentReceived` (the one the
  relayer indexes — line 96), `PaymentSettled` (richer version with fee/net/nonce, line 108),
  `FeePaid`, `FeeConfigUpdated`, `AcceptedTokenUpdated`, `PauseGuardianUpdated`, `TokensRescued`.
- **Roles**:
  - **Owner** (`Ownable2Step`) — can allowlist tokens, set fee (≤ `MAX_FEE_BPS` = 500 = 5%,
    line 32), assign the pause guardian, `rescueTokens`, and authorize upgrades
    (`_authorizeUpgrade`, line 451). In production this should be a `TimelockController` (see §2.4).
  - **Pause guardian** (`_s().pauseGuardian`) — can call `pause()` (line 429) but never
    `unpause()` — a one-way circuit breaker independent of the owner key.
- **Fee logic**: fee is `uint96 feeBps` capped at 500 (5%), **locked into each `Order` at
  registration time** (line 276) — a later `setFeeConfig` only affects orders registered
  afterward. Split is `fee = amount * feeBps / 10_000`, `net = amount - fee` (lines 337–338,
  364–365).
- **Stablecoin allowlist**: `mapping(address => bool) acceptedToken` (in `MainStorage`, line 62).
  `address(0)` (`NATIVE`, line 29) is the sentinel for the chain's native currency. Only the owner
  can flip acceptance (`setTokenAccepted`, line 396).
- **Native vs ERC-20**: two entirely separate entry points — `payOrder` (`SafeERC20.
  safeTransferFrom`, lines 341/344) vs `payOrderNative` (raw `.call{value:}`, `_sendNative`,
  line 383) gated by `o.token == NATIVE`. There is nothing chain-specific about "native
  currency" handling — it's `msg.value`/`.call`, identical semantics on any EVM chain (Robinhood
  Chain and Base Sepolia both use ETH-like native gas tokens under `address(0)`).

### 2.2 Toolchain / config

- **Solidity 0.8.20** pinned everywhere (`pragma solidity 0.8.20;` in every `.sol` file).
- **Hardhat** (`@nomicfoundation/hardhat-toolbox` 5.x) — `contracts/hardhat.config.js`.
  - `evmVersion: 'london'` (line 34) — chosen specifically to avoid `PUSH0` (Shanghai+), which
    Quai's EVM rejects. **Standard EVM chains (Robinhood Chain, Base Sepolia) support PUSH0/
    Shanghai or later**, so this constraint can likely be relaxed for a chain-specific compile
    profile, but there's no harm in leaving it as-is (london bytecode still runs on newer EVMs).
  - `optimizer: { enabled: true, runs: 1000 }` (line 33) — chain-agnostic.
  - `metadata: { bytecodeHash: 'ipfs', useLiteralContent: true }` (line 36) — only needed for
    Quaiscan verification via the IPFS CID mechanism (see §2.5); irrelevant/harmless elsewhere.
  - `networks.cyprus1` (lines 24–28) is the only non-`hardhat` network defined; `defaultNetwork:
    'hardhat'` is what `npx hardhat test` uses (a **standard** in-process EVM, not Quai) — this is
    why the test suite needs no Quai node at all (see §2.6).
  - The `@quai/hardhat-deploy-metadata` plugin is loaded in a `try/catch` (lines 5–9) — already
    designed to degrade gracefully if unavailable, which is convenient for a non-Quai network
    profile.
- **`contracts/contracts/governance/Imports.sol`** — compile-only shim that pulls in OZ's
  `ERC1967Proxy` and `TimelockController` so Hardhat produces local artifacts for the deploy
  script to load by name. No chain assumptions.
- **`contracts/contracts/MockStablecoin.sol`** — 6-decimal open-mint ERC-20 (`mUSDQ`) for
  local/testnet use only; standard OZ `ERC20`, nothing chain-specific.
- **`contracts/contracts/mocks/`** — `PayWithQuaiV2Mock.sol` (upgrade-preserves-storage test
  target, adds `registerOrderBatch` under a **new** ERC-7201 namespace, `newField`), plus
  `ReentrantToken.sol`/`ReentrantReceiver.sol` (attack contracts proving the reentrancy guard) and
  `SelfDestructor.sol` (proves stray force-sent native value is recoverable). All standard EVM,
  no Quai dependency.

### 2.3 UUPS upgrade setup & storage layout

- Proxy pattern: `ERC1967Proxy` (state) in front of `PayWithQuai` (logic), OZ 5.0.2
  `UUPSUpgradeable` + `Initializable` + `Ownable2StepUpgradeable` + `PausableUpgradeable` +
  `ReentrancyGuardUpgradeable`.
- **All mutable state lives in one ERC-7201 namespaced struct**, `MainStorage` (lines 60–67),
  at a fixed slot `MAIN_STORAGE_LOCATION` (line 70–71) computed from `keccak256("paywithquai.main")`.
  This is a real anti-collision mechanism, **independent of which chain the proxy is deployed
  to** — it protects against storage-layout collisions across upgrades, not across chains.
  Nothing here is Quai-specific; a fresh `PayWithQuai` deployment on Robinhood Chain / Base
  Sepolia gets its own proxy, its own storage, and follows the exact same rules.
- **Risk for future changes**: the doc comment at lines 40–43 and the contract README
  (`contracts/README.md:74–82`) both spell out the rule — never remove/reorder `Order` or
  `MainStorage` fields, only append; new features need their own ERC-7201 namespace (as
  `PayWithQuaiV2Mock.sol` demonstrates). This rule is unaffected by multi-chain work — the same
  implementation bytecode can be deployed once per chain, with independent proxies/storage.
- `_authorizeUpgrade` (line 451) is owner-only — combined with `Ownable2Step` and (on mainnet)
  a `TimelockController`, this gives a 48h public warning window before any upgrade lands.

### 2.4 Quai-specific code / assumptions (contracts package)

**None inside `PayWithQuai.sol`, `MockStablecoin.sol`, or the mocks.** All Quai-specific logic is
in the **off-chain tooling**:

- `contracts/scripts/deploy.js`, `upgrade.js`, `payDemo.js`, `allowTokens.js` — all import and use
  the **`quais`** SDK (not `ethers`) to talk to the live network (`require('quais')`).
- `contracts/scripts/generateCyprus1Key.js` — grinds a private key until the derived address
  starts with `0x00` (Cyprus-1 zone prefix); uses `quais.Wallet` and `quais.getZoneForAddress`.
- The contract test suite (`contracts/test/PayWithQuai.test.js`) uses **standard Hardhat
  `ethers`**, not `quais` (`require('hardhat').ethers`, line 2) — because `hardhat test` runs
  against the in-process Hardhat EVM, which is a vanilla EVM, not Quai. This is a strong signal
  the contract itself is already fully portable; only the "talk to a live network" scripts are
  Quai-locked.
- No Qi/UTXO logic appears anywhere in `contracts/` — Qi is handled entirely off-chain in the
  backend (see §4.6); the contract has no UTXO awareness.
- No opcode or precompile usage that is Quai-specific; `evmVersion: london` is a conservative
  compatibility choice, not a requirement imposed by any Quai-only opcode in the source.

### 2.5 Existing tests

- `contracts/test/PayWithQuai.test.js` (912 lines, standard Mocha/Chai via `hardhat-toolbox`).
  Command: `npx hardhat test` (also `npm test` — `contracts/package.json`). Runs entirely on the
  Hardhat in-process EVM — **no live Quai node or funds required**.
- Coverage (by `describe` block): deployment/initialization guards, `registerOrder` (incl. batch
  and payer-restricted variants), `cancelOrder`, `payOrder` (ERC-20) incl. double-fulfillment and
  fee-flooring, `payOrderNative`, order expiry, fee-locked-at-registration (both fee rate and fee
  recipient), `purgeSettledOrder`, `rescueTokens`, pause/unpause + pause guardian semantics,
  `Ownable2Step` two-step transfer, reentrancy (malicious ERC-20 and malicious native receiver),
  `registerOrderWithPayer`, `PaymentSettled` event + per-merchant nonce, and a full **UUPS
  upgradeability** section (double-init guard, direct-init lock via `_disableInitializers`,
  non-owner upgrade rejection, `reinitializer` front-running protection, and a live
  upgrade-preserves-state + still-processes-payments test against `PayWithQuaiV2Mock`).
- This suite is **chain-agnostic by construction** — it would run unmodified against a contract
  deployed for Robinhood Chain / Base Sepolia, since it never touches `quais` or any live RPC.

---

## 3. Deployment (`contracts/scripts/`)

### 3.1 `deploy.js` — step by step

1. Reads `hre.network.config` (`url`, `accounts`, `chainId`) — fails fast if `RPC_URL`/
   `CYPRUS1_PK` are unset (lines 84–86).
2. **Mainnet safety gate** (lines 91–129, see §3.3).
3. Deploys `MockStablecoin` — **skipped when `chainId === 9`** (mainnet); deployed on every other
   chain id (lines 150–157). *(Multi-chain note: this "not mainnet ⇒ deploy mock" branch would
   need to become "not any real mainnet ⇒ deploy mock", or be keyed off an explicit `--testnet`
   flag rather than `chainId !== 9`, once other chains' mainnets enter the picture.)*
4. Deploys the `PayWithQuai` implementation via `deployContract()` (line 160), which reads the
   Hardhat artifact and pushes it through **`quais.ContractFactory`** (line 75) — not Hardhat's
   own `ethers.ContractFactory`.
5. Deploys `ERC1967Proxy(impl, initData)` where `initData` encodes `initialize(feeRecipient,
   feeBps, deployer)` (lines 163–168).
6. Allowlists native currency (`ZERO`) and `mockAddress`/`STABLECOIN_ADDR` if set (lines 174–189).
7. **Reads the fee config back on-chain and hard-fails on mismatch** (lines 194–206) — a real
   safety check, chain-agnostic.
8. If `MULTISIG_ADDR` is set: deploys `TimelockController` and calls `transferOwnership` on the
   proxy (two-step `Ownable2Step` — must be completed by the multisig calling `acceptOwnership`
   through the timelock) (lines 211–236).
9. If `PAUSE_GUARDIAN_ADDR` is set: calls `setPauseGuardian` (lines 240–246).
10. Writes `contracts/deployments/<network>.json` (lines 248–264) — **this directory does not
    currently exist in the repo** (nothing has been deployed/committed yet); it is created at
    deploy time by `fs.mkdirSync(..., { recursive: true })`.

### 3.2 The 0x00 Cyprus-1 address requirement

Handled entirely by **key grinding**, not on-chain enforcement:

- `contracts/scripts/generateCyprus1Key.js` brute-forces a fresh private key (up to 100,000
  tries) until `wallet.address.startsWith('0x00')` (lines 14–18), using `quais.Wallet` and
  reporting the zone via `quais.getZoneForAddress`.
- Nothing in `deploy.js` itself grinds an address — it trusts `CYPRUS1_PK` (from `.env`) to
  already be a Cyprus-1 key; `contracts/.env.example` documents the requirement in prose (lines
  13–16: "The corresponding address must start with 0x00 (Cyprus-1 zone)").
- **For standard EVM chains, this entire mechanism is irrelevant** — Robinhood Chain and Base
  Sepolia addresses have no zone-prefix requirement; any deployer key works. A multi-chain deploy
  script variant should simply skip the Cyprus-1 checks/grinding.

### 3.3 Mainnet safety checks (`deploy.js`, lines 88–129)

Gated on `isMainnet = Number(chainId) === MAINNET_CHAIN_ID` where `MAINNET_CHAIN_ID = 9` (line
31) — **hardcoded to Quai's chain id**. On mainnet the script refuses to proceed unless:

- `MULTISIG_ADDR` is set (lines 92–97) — otherwise ownership would sit with the deployer EOA.
- `PAUSE_GUARDIAN_ADDR` is set (lines 98–103) — otherwise there's no independent circuit breaker.
- `FEE_RECIPIENT` is set and passes a `0x[0-9a-fA-F]{40}` regex (lines 107–119) — otherwise fees
  would silently go to the deployer.
- `TIMELOCK_MIN_DELAY >= 86400` (24h floor) (lines 123–129).
- `FEE_BPS` is a valid integer 0–500 regardless of network (lines 133–136) — this one already
  applies universally, not mainnet-only.

**Multi-chain implication**: this whole block needs to become chain-id-aware (e.g. a config map
of "real, funds-at-risk networks" → required guardrails) rather than a single `=== 9` check, so
that Robinhood Chain **mainnet** and Base **mainnet** (not the testnets targeted now) get the same
protection once/if they're added later. For the testnets in scope now (Robinhood Chain testnet
46630, Base Sepolia 84532), the current logic would treat them as "not mainnet" and skip these
guardrails — which is correct behavior for testnets, but only by accident of the current
single-mainnet-id check.

### 3.4 Where addresses are saved

`contracts/deployments/<network>.json`, written by `deploy.js` (and `chainId`/`payWithQuaiImpl`
updated in place by `upgrade.js`, lines 117–118). Format (documented in `README.md:152–164` for
the existing `cyprus1` deployment):

```json
{
  "network": "cyprus1",
  "chainId": 9,
  "payWithQuai": "0x0072174EF6d0C2EB605449b0014169D104c42BbC",
  "payWithQuaiImpl": "0x002dB0fBCA5a3DC1336e5D00ABCbCd9daac9cFF6",
  "timelock": "0x005271b466765176a8a79b3f9A621c40abA1bffC",
  "mockStablecoin": null,
  "feeRecipient": "0x000E25274329cCa64Cf76b87Edd6A1f158952582",
  "feeBps": "30",
  "deployer": "0x000E25274329cCa64Cf76b87Edd6A1f158952582"
}
```

The filename is keyed by **Hardhat network name** (`hre.network.name`), not chain id — so adding
`robinhoodTestnet` / `baseSepolia` networks to `hardhat.config.js` would naturally produce
`deployments/robinhoodTestnet.json` / `deployments/baseSepolia.json` without changing `deploy.js`
at all (besides the mainnet-gate concern in §3.3). **No `deployments/` files exist in the repo
today** — every consumer (`backend/.env`, `frontend/.env.local`) currently gets its contract
address from environment variables, not by reading this JSON directly at runtime; only the deploy
scripts themselves read/write it.

### 3.5 What a standard EVM deploy script needs to do differently

1. **Use `ethers` (already a `hardhat-toolbox` dependency) instead of `quais`** for the
   `ContractFactory`/`Contract`/`Wallet`/`JsonRpcProvider` calls — `quais.getAddress`,
   `quais.getZoneForAddress`, and the `quais.ContractFactory`'s extra IPFS-CID argument are all
   Quai-only APIs with no equivalent on Robinhood Chain / Base Sepolia. This is the single biggest
   code change in `deploy.js`/`upgrade.js`/`payDemo.js`/`allowTokens.js`.
2. **Drop `pushMetadata()` / IPFS CID handling** (`deploy.js` lines 35–51, `upgrade.js` lines
   41–52) — that machinery exists solely for Quaiscan source verification; a standard chain would
   use its own verification flow (e.g. Etherscan-compatible `hardhat-verify` for Base, whatever
   Robinhood Chain's explorer expects) or skip verification for testnets.
3. **Drop the Cyprus-1 key-grinding requirement** — any funded EOA works as deployer.
4. **Add `networks.robinhoodTestnet` / `networks.baseSepolia`** entries to `hardhat.config.js`
   (`url`, `accounts`, `chainId: 46630` / `84532`) alongside the existing `cyprus1` entry — this
   part is pure Hardhat config, chain-agnostic already.
5. **Generalize the mainnet-only guard rails** (§3.3) so they key off a chain-id allowlist/map
   rather than the single Quai mainnet id, or accept that the guard only ever applied to Quai and
   add an equivalent (or explicitly skip it) for new networks.
6. Everything else — the `MockStablecoin` skip-on-mainnet logic, fee/timelock/pause-guardian
   flags, `registerOrder`/`payOrder` calls in `payDemo.js`, and the on-chain fee-verification
   check — carries over unchanged once the SDK call sites are swapped.

---

## 4. Backend relayer (`backend/`)

### 4.1 Framework, entry point, structure

- **Express** (v4) HTTP API + two poll-loop background services, all TypeScript, single Node
  process. Entry point: `backend/src/index.ts`.
- Folder structure:
  - `src/api/` — `server.ts` (Express app + all routes, 910 lines), `cors.ts`, `rateLimit.ts`.
  - `src/chain/` — `client.ts` (`QuaiClient`, EVM/Quai read layer), `abi.ts` (minimal ABI),
    `qi.ts` (`QiService`, Qi/UTXO layer).
  - `src/indexer/` — `indexer.ts` (`Indexer`, EVM event indexer), `qi-indexer.ts` (`QiIndexer`).
  - `src/store/` — `index.ts` (`Store` interface), `json.ts` (file-backed impl), `postgres.ts`
    (Postgres impl).
  - `src/webhooks/` — `dispatcher.ts`, `signer.ts` (HMAC), `httpPost.ts`, `backoff.ts`,
    `urlGuard.ts` (SSRF guard).
  - `src/config.ts` (Zod-validated env), `src/types.ts` (shared domain types), `src/logger.ts`,
    `src/util/`.
- **`backend/src/index.ts`** wires everything: loads config once (`loadConfig()`), picks the
  store, constructs one `QuaiClient`, one `Indexer`, one `QiService`, one `QiIndexer`, builds the
  Express app, and starts all loops (lines 36–60). **This is a single-chain, single-contract
  process by construction** — every dependency is built from one global `Config`.

### 4.2 Database layer

- `Store` interface (`src/store/index.ts`) is the persistence boundary; two implementations:
  - **`JsonStore`** (`src/store/json.ts`, 444 lines) — dependency-free, atomically-written JSON
    file (`DATABASE_PATH`, default `./data/relayer.db`). Single-process only.
  - **`PostgresStore`** (`src/store/postgres.ts`, 746 lines) — used when `DATABASE_URL` is set
    (Railway auto-provides this). Schema created idempotently in `init()` (lines 40–140+):
    `cursors`, `merchants`, `deliveries`, `sessions`, `nonces`, `links`, `claims`, `order_meta`,
    `qi_orders`. **No table has a `chain_id` column.** The only chain-scoping mechanism anywhere
    is the `cursors.scope` text key (see §4.3).
- Models (`src/types.ts`): `Merchant`, `Session`, `PaymentLink`, `LinkClaim`, `OrderMeta`,
  `QiOrder`, `WebhookDelivery`, `PaymentEvent`. **None of these carry a chain id or chain name
  field.** A `Merchant` is keyed purely by on-chain address (line 31); a `PaymentLink` prices in a
  `tokenAddress` with no accompanying chain (line 81); a `QiOrder` is inherently Quai-only.

### 4.3 Chain layer

- **Library**: exclusively **`quais`** (`"quais": "1.0.0-alpha.56"` in `backend/package.json`).
  No `ethers`/`viem` dependency exists in the backend at all.
- **`QuaiClient`** (`src/chain/client.ts`) is constructed once from the global `Config` (`RPC_URL`,
  `PAYWITHQUAI_ADDRESS`) in `src/index.ts:43`. Quai-specific behavior baked into this class:
  - `getZoneForAddress(this.address)` derives the Quai **zone** from the contract address prefix,
    then `toShard(zone)` and a hand-rolled `nodeLocation` array (lines 60–71) — used both for
    `provider.getBlockNumber(this.shard)` (a **Quai-only provider method signature** — standard
    `ethers`/`viem` providers take no shard argument) and for a `nodeLocation` field injected into
    every `getLogs` filter (line 91) — **`nodeLocation` is not part of the standard `eth_getLogs`
    filter shape**; a standard EVM RPC would reject or ignore it.
  - Throws at construction if the address "is not a valid Quai zone address" (lines 62–64) — i.e.
    **a standard EVM contract address that doesn't happen to encode a valid Quai zone prefix would
    fail `QuaiClient` construction outright.** This is the sharpest incompatibility in the whole
    backend: `getZoneForAddress`/`getAddress` from `quais` implement Quai's zone-aware checksum
    rules, not plain EIP-55 — this needs verifying against the installed `quais` version before
    relying on it, but the zone derivation at lines 61–71 has no fallback path for a non-Quai
    address, so at minimum the class cannot be reused unmodified for Robinhood Chain / Base
    Sepolia contracts.
  - `getPaymentEvents` (lines 85–109) — decodes logs via `Interface.parseLog`, standard-shape
    logic once the `nodeLocation`/shard bits are removed.
- **RPC/chain id config**: `RPC_URL` and `CHAIN_ID` are single scalar env vars (`config.ts:14–15`)
  — one RPC endpoint and one chain id per running backend process, globally.
- **Event indexer** (`src/indexer/indexer.ts`, `Indexer` class):
  - Polling loop (`POLL_INTERVAL_MS`, default 5000ms) — `tick()` at line 79.
  - Confirmations: `safeHead = head - CONFIRMATIONS` (line 85, default `CONFIRMATIONS=12`) —
    only blocks at/below this line are processed; this is a config value, not chain-specific code,
    but the **right default differs sharply per chain** (see §7 Risks — L2 finality).
  - Block ranges: chunked to `MAX_BLOCK_RANGE` (default 2000) per `getLogs` call (line 89).
  - `START_BLOCK`: optional env var; if unset, indexing starts from `head - CONFIRMATIONS` on
    first boot (`initCursor`, lines 66–77) — i.e. **history before boot is never backfilled**
    unless `START_BLOCK` is set to the contract's deployment block.
  - **Chain scoping**: `cursorScope(chainId, contractAddress)` (`indexer.ts:16–18`) produces a
    `"${chainId}:${address}"` string used as the cursor's store key — this is the **only** piece
    of the whole indexer/store stack that is chain-id-aware, and it already supports multiple
    scopes coexisting in one store. **However, nothing currently constructs more than one
    `Indexer`/`QuaiClient` pair** — `index.ts` builds exactly one of each from the single global
    `Config`, so today this scoping mechanism is unused multi-chain headroom, not a working
    multi-chain feature.

### 4.4 Wallet login

- `POST /v1/auth/challenge` (`src/api/server.ts:241`) mints a single-use nonce and builds the
  message: **``tripplepay-login:${address}:${nonce}:${cfg.CHAIN_ID}:${cfg.LOGIN_REALM}``**
  (line 254) — binds the challenge to the process's single `CHAIN_ID` and `LOGIN_REALM` (env,
  default `'tripplepay'`, `config.ts:49`).
- `POST /v1/auth/login` (line 258) re-derives the same regex-parsed message shape (line 275),
  checks `chainId !== String(cfg.CHAIN_ID)` and `realm !== cfg.LOGIN_REALM` (lines 284–285) —
  **rejects any signature not bound to this exact deployment's chain id/realm.** This is a
  deliberate anti-replay design (documented in `README.md:84` and inline comments at
  `server.ts:217–219`): a signature captured on one deployment can't be replayed on another with a
  different `CHAIN_ID`/`LOGIN_REALM`.
- Signature verification uses **`verifyMessage` from `quais`** (line 3, called at line 300) —
  standard personal-message signing (EIP-191-style); this is very likely wire-compatible with
  `ethers.verifyMessage` since Quai wallets sign EVM-standard personal messages, but should be
  spot-checked once `quais`/`ethers` are both available, since the backend has no `ethers`
  dependency today.
- `getAddress` from `quais` (line 3) is used throughout `server.ts` for checksum validation of
  addresses in requests (merchant address, payer address, link merchant address) — same caveat as
  §4.3: if `quais.getAddress` enforces Quai zone-prefix rules, standard addresses from Robinhood
  Chain / Base Sepolia users could be rejected by these checks.
- **Multi-chain implication**: since `CHAIN_ID` is a single global config value, a merchant who
  registered on Quai and a merchant who registers on Base Sepolia would currently get **the same**
  challenge message shape but bound to whatever `CHAIN_ID` this one process happens to run with —
  there is no per-merchant or per-request chain selection anywhere in the auth flow.

### 4.5 Orders/payment links and chain association

**Nowhere.** Confirmed by direct inspection of every relevant type and Postgres table:

- `Merchant` (`types.ts:29`) — no chain field.
- `PaymentLink` (`types.ts:75`) — `tokenAddress` only, no chain field.
- `QiOrder` (`types.ts:110`) — inherently Quai-only (see §4.6).
- `OrderMeta` (`types.ts:127`) — no chain field.
- Postgres schema (`store/postgres.ts:40–140`) — no `chain_id` column on `merchants`, `links`,
  `claims`, `order_meta`, `qi_orders`, or `deliveries`.
- The **only** chain-aware storage key in the entire backend is the indexer cursor's `scope`
  string (§4.3). A merchant's on-chain payout address is assumed unique and chain-independent —
  i.e. the same `0xabc...` address is implicitly assumed to mean "this merchant" regardless of
  which chain a payment arrived on, which becomes ambiguous the moment two chains are both live
  (a customer could in principle pay a lookalike/reused address on the wrong chain and it would
  resolve to the same merchant record).

### 4.6 Token allowlist and native-currency assumptions

- `ACCEPTED_TOKENS` (`config.ts:56–64`) — a single comma-separated address list, parsed once at
  boot, with no chain dimension; used in `POST /v1/links` (`server.ts:449–453`) to validate a
  merchant's chosen `tokenAddress` for a new payment link. **The same allowlist would apply
  regardless of which chain a link's order is eventually registered on** — there is no way today
  to say "this token address is valid on Base Sepolia but not on Quai."
- `ZERO_ADDRESS` / `NATIVE_TOKEN` (`server.ts:32`, `types.ts:9`) is used as the sentinel for
  "native currency" — this convention (mirroring the contract's `NATIVE = address(0)`) is already
  chain-agnostic and needs no change; "native QUAI" vs "native ETH on Base Sepolia" are both just
  `address(0)` to this code.
- The frontend's `currencies.ts` registry (see §5.3) is the actual source of symbols/decimals,
  and it is 100% Quai-mainnet-hardcoded.

### 4.7 Qi checkout (stays Quai-only)

Qi is Quai's separate UTXO ledger (no smart contracts, no EVM). Entirely feature-gated behind
`QI_MNEMONIC` + `QI_RPC_URL` (`config.ts:70–97`); when either is unset, `QiService.enabled` is
`false` and every Qi code path becomes a documented no-op. Files touched:

- `src/chain/qi.ts` — `QiService`: derives one-time BIP44 receive addresses
  (`m/44'/969'/0'/0/<n>`, Cyprus-1 only — `Zone.Cyprus1` hardcoded at lines 73/96) from a
  `quais.QiHDWallet`, and checks balances via `quai_getOutpointsByAddress` — **all Quai-only SDK
  surface with no standard-EVM equivalent** (UTXO ledgers don't exist on Robinhood Chain/Base).
- `src/indexer/qi-indexer.ts` — `QiIndexer`: polls persisted, unsettled `QiOrder`s and marks them
  settled once enough qits have arrived.
- `types.ts:QiOrder` (line 110) — Qi-specific record shape.
- `server.ts` — `qiView()` (line 21), the `qi` field on `GET /v1/orders/:merchant/:orderId`
  (lines 152–158), `/v1/dev/qi-settle/:orderId` (dev-only), and the `/v1/links/:slug/qi-claim`
  route (referenced by frontend `reserveQiOnLink`, not shown above but present in `server.ts`).
- **This package correctly needs zero multi-chain work** — per the task's own framing, Qi stays
  Quai-only. The only thing to watch is that new EVM-chain code paths must not assume every order
  has (or could have) a `qi` field; the existing `qiService?.enabled` guards already handle this
  correctly and are a good pattern to keep.

### 4.8 Every place that assumes a single chain (backend summary)

| Location | Assumption |
| --- | --- |
| `src/config.ts:14–18` | One `RPC_URL`, one `CHAIN_ID`, one `PAYWITHQUAI_ADDRESS` for the whole process |
| `src/index.ts:43–51` | Exactly one `QuaiClient`, one `Indexer` constructed at boot |
| `src/chain/client.ts:56–75` | Constructor derives a single Quai zone/shard from the one configured contract address; throws if that fails |
| `src/api/server.ts:92,96,254,284` | `/health` and the auth challenge/login both report/require the one global `cfg.CHAIN_ID` |
| `src/types.ts` (all interfaces) | No `chainId` field on `Merchant`, `PaymentLink`, `QiOrder`, `OrderMeta`, `WebhookDelivery` |
| `store/postgres.ts` schema | No `chain_id` column anywhere |
| `config.ts:56` `ACCEPTED_TOKENS` | One global token allowlist, no per-chain scoping |
| `indexer/indexer.ts:16` `cursorScope` | Chain-aware in *shape* (scope key includes chainId) but only ever instantiated once |

---

## 5. Frontend (`frontend/`)

### 5.1 Framework / structure

- **Next.js 16.3.0** (App Router), **React 19.2.8**, TypeScript. Dev server on port 3001 per
  `README.md:76`.
- Routing (`src/app/`): `/` (landing), `/onboarding`, `/login`, `/dashboard` (+ `/analytics`,
  `/links`, `/payments`, `/settings`), `/checkout/[merchant]/[orderId]`, `/checkout/demo`,
  `/pay/[slug]` (payment links), `/docs`, `/terms`.
- Two server-side API proxy routes: `src/app/api/admin/[...path]/route.ts` and
  `src/app/api/v1/[...path]/route.ts`.
- `src/lib/` holds all chain/wallet/payment logic (see below); `src/components/checkout/` and
  `src/components/ui/` hold the checkout/dashboard UI.
- No client-side data-fetching library (no React Query/SWR) — components call `src/lib/payment.ts`
  / `src/lib/relayer.ts` functions directly inside `useEffect`/handlers and manage their own state.

### 5.2 Chain layer

- **Library**: exclusively **`quais` `^1.0.0-alpha.56`** (`frontend/package.json`). No `ethers`,
  `viem`, or `wagmi` dependency exists. Every file that talks to the chain imports directly from
  `"quais"`.
- **Wallet connection** (`src/lib/wallets.ts`): detects injected EIP-1193 providers
  (`window.quai`, `window.pelagus`, `window.ethereum` + `window.ethereum.providers[]`) and
  classifies them by brand — Blip, Pelagus, MetaMask, Rabby, Coinbase, Brave, OKX, Bitget, Trust,
  Frame, or generic (lines 3–14, 80–102). Only Blip/Pelagus/MetaMask are flagged
  `supportsQuai: true` (`QUAI_CAPABLE_BRANDS`, lines 105–109) — **this allowlist has nothing to do
  with EVM-compatibility in general; it specifically tracks which wallets can be steered onto the
  Quai network.** For Robinhood Chain / Base Sepolia, essentially every injected EVM wallet
  (MetaMask, Rabby, Coinbase, Brave, OKX, Bitget, Trust, Frame) would be a valid choice — the
  current allowlist would need to become chain-aware ("does this wallet support chain X") rather
  than a single Quai-only gate.
  - `connectWallet()` (line 301) calls `quai_requestAccounts` falling back to
    `eth_requestAccounts`, then hard-validates `getZoneForAddress(address) !== "0x00"` and throws
    (lines 318–323) — **this unconditionally rejects any account not in Quai's Cyprus-1 zone**,
    which would incorrectly reject every valid Robinhood Chain / Base Sepolia account. This is a
    concrete, must-fix blocker, not just a config value.
  - `ensureQuaiNetwork()` (line 252) and `QUAI_MAINNET_CHAIN` (line 34, hardcoded `chainId: "0x9"`,
    RPC from `NEXT_PUBLIC_RPC_URL`, explorer `quaiscan.io`) drive `wallet_switchEthereumChain`/
    `wallet_addEthereumChain` — the EIP-3326 mechanics here are standard and portable; only the
    target `ChainConfig` (chain id 9, Quai RPC/explorer) is Quai-specific. `ChainConfig` is
    already a plain object type (line 44), so parameterizing this function per target chain is
    mechanical.
- **Transaction building/sending** (`src/lib/payment.ts`, 1267 lines) — by far the largest and
  most Quai-coupled file in the repo:
  - `getRpcProvider()` (line 84) builds one module-level `quais.JsonRpcProvider` pointed at
    `NEXT_PUBLIC_RPC_URL`, normalized to a `/cyprus1` zone-gateway path (`zoneRpcUrl`, line 69) —
    **hardcoded to exactly one chain's RPC for the life of the page load.**
  - `getContract()` (line 634), `registerOnChain()` (line 698), `payOrder()` (line 722),
    `payOrderNative()` (line 844), `getOrderOnChain()` (line 1004), `isSettledOnChain()`
    (line 977) all resolve `resolvePayAddress()` from a single `NEXT_PUBLIC_PAYWITHQUAI_ADDRESS`
    (line 26/33–35) and build `quais.Contract`/`quais.BrowserProvider` instances directly — no
    chain parameter anywhere in these signatures.
  - **Blip-specific transaction path** (lines 268–841, roughly 40% of the file): raw
    `quai_sendTransaction` calls, app-wallet funding (`blip_requestAppWalletFunding`), gas/nonce
    estimation via `quai_estimateGas`/`quai_getTransactionCount` with `eth_*` fallbacks, and
    numerous documented workarounds for `quais` alpha bugs (e.g. `hexQty()` at line 293 works
    around a `quais` hex-padding bug that go-quai's node rejects; `waitForTxReceipt` at line 549
    bypasses `quais`' built-in receipt waiter because of a "Invalid shard" parsing bug). **This
    entire code path is Quai/Blip-only** — Robinhood Chain / Base Sepolia users would use
    Pelagus-equivalent standard flows (MetaMask/Rabby/etc. via a standard `ethers`/`viem` signer),
    not this path.
  - `waitForTxReceipt` (line 549) explicitly documents bypassing `quais`' `waitForTransaction`
    due to a cross-shard-tx parsing bug — again a Quai-only workaround with no bearing on other
    chains, but also not a pattern that needs to be replicated for them.
- **Order status reads**: `fetchOrderStatus()` (line 935) calls the backend
  (`GET /v1/orders/:merchant/:orderId`); `isSettledOnChain()` (line 977) and `getOrderOnChain()`
  (line 1004) read the contract directly via `getRpcProvider()`. Both paths are single-chain by
  construction (one provider, one contract address).
- **`src/lib/relayer.ts`** — imports `formatQuai, formatUnits` from `quais` (line 6); formats
  on-chain amounts for display; treats `"0x000...0000"` as the native-token sentinel (line 165) —
  chain-agnostic in intent, Quai-coupled only through the `quais` formatting import (trivially
  swappable for `ethers`/`viem` equivalents).
- **`src/lib/blip.ts`** (219 lines) — Blip wallet bridge helpers (`requestAppWalletFunding`,
  `getWalletQuaiBalance`); inherently Quai/Blip-specific and stays that way — Blip is a Quai-only
  wallet.
- **`src/lib/qi.ts`** — pure math helpers (qits↔Qi formatting); no chain SDK import; stays
  Quai-only by nature of what it formats, requires no change.
- **`src/components/ui/wallet-balances.tsx`** — imports `BrowserProvider, Contract, formatUnits,
  parseQuai` from `quais` (line 4); iterates `listCurrencies()` from `currencies.ts` to fetch
  per-token balances (line 75 skips native, keys by `"native"` vs lowercased address at line 176)
  — same single-chain/single-registry coupling as `payment.ts`.
- **`src/components/ui/wallet-selector.tsx`** — no direct `quais` chain calls found (grep showed
  no `Zone`/`getZoneForAddress`/`0x00` matches); it consumes `detectWallets()`/`supportsQuai` from
  `wallets.ts`, so its chain-awareness is inherited from that module.

### 5.3 Every place tokens/ABIs/contract addresses/chain IDs/RPC URLs are referenced

| File | What it holds |
| --- | --- |
| `src/lib/currencies.ts` | **The** currency registry — `NATIVE_CURRENCY` (QUAI), `USDT_ADDRESS`/`WQUAI_ADDRESS` (canonical Quai mainnet addresses, hardcoded as defaults, lines 19–22), `MUSDQ_ADDRESS` (env), `listCurrencies()`/`findCurrency()`/`currencyDecimals()`/`currencySymbol()`. **Single flat list, no chain dimension** — this is the primary file that needs to become chain-parameterized. |
| `src/lib/payment.ts` | `PAYWITHQUAI_ADDRESS`, `MUSDQ_ADDRESS`, `BACKEND_URL`/`BACKEND_URLS` (env-derived), `resolvePayAddress()`/`resolveTokenAddress()`, `getRpcProvider()` (single `NEXT_PUBLIC_RPC_URL`), imports `frontend/src/lib/paywithquai.abi.json` |
| `src/lib/wallets.ts` | `QUAI_MAINNET_CHAIN` (chain id `0x9`, RPC, explorer), `ChainConfig` type, `QUAI_CAPABLE_BRANDS` |
| `src/lib/paywithquai.abi.json` | The full contract ABI — chain-agnostic (same contract bytecode/ABI would be deployed to each EVM chain) |
| `src/lib/auth.ts` | Uses `QUAI_MAINNET_CHAIN` for `ensureQuaiNetwork()` before login-challenge signing |
| `src/components/ui/wallet-balances.tsx` | Reads `listCurrencies()`, builds `quais.Contract` per token, native-balance via `quais` |
| `src/components/ui/wallet-selector.tsx` | Consumes `supportsQuai` flags from `wallets.ts` |
| `frontend/.env.local.example` | `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_CHAIN_ID` (declared but **not actually read** by any `.ts` file I found — `CHAIN_ID` isn't referenced in `wallets.ts`/`payment.ts`; only `QUAI_MAINNET_CHAIN.chainId` is hardcoded as `"0x9"` inline — worth flagging to the team as a likely-dead env var today), `NEXT_PUBLIC_PAYWITHQUAI_ADDRESS`, `NEXT_PUBLIC_MUSDQ_ADDRESS`, `NEXT_PUBLIC_USDT_ADDRESS`/`NEXT_PUBLIC_WQUAI_ADDRESS` (overrides), `NEXT_PUBLIC_BACKEND_URL`, `ADMIN_API_KEY` |
| `src/app/docs/page.tsx` | Referenced by `payment.ts:49` as documenting the required `NEXT_PUBLIC_*` vars (not independently audited line-by-line here, but is where merchant-facing env-var docs live) |

### 5.4 Payment method dropdown & checkout tabs

- **`src/components/checkout/payment-method-selector.tsx`** — a simple dropdown with exactly two
  live options, **hardcoded**: `"blip"` ("Pay with Blip") and `"wallet"` ("Browser Wallet")
  (lines 24–34, 51–75), plus an optional disabled `"qi"` entry gated by a `showQiComingSoon` prop
  (lines 77–88). The `PaymentMethodSelectorProps.payTab` type is a **literal union**
  `"blip" | "wallet" | "qi"` (line 5) — there is no concept of "which chain is this wallet on" or
  "is Qi even relevant on this order" beyond the boolean `showQiComingSoon` flag.
- **`src/app/checkout/[merchant]/[orderId]/page.tsx`** — owns the `payTab` state
  (`useState<"blip" | "wallet" | "qi">("wallet")`, line 98) and renders the selector with
  `showQiComingSoon` hardcoded `true` (line 606), then conditionally renders the Blip panel
  (line 608), the wallet panel (line 659), or the Qi panel (line 700) based on `payTab`. **There
  is no chain-selection UI at all** — the page assumes every order is a Quai order end-to-end.
- Decision logic today is entirely static (which of `blip`/`wallet`/`qi` to *show*, not which
  *chain*); adding EVM chains means this component (and the `page.tsx` that owns `payTab`) needs a
  new axis — "which chain is this order/link denominated on" — that determines which wallets/
  panels are even offered (Blip and Qi are Quai-only; a Robinhood Chain/Base Sepolia order would
  only ever show a generic "Browser Wallet" panel, but pointed at a different chain/provider).

### 5.5 Server-side admin proxy (`src/app/api/admin/[...path]/route.ts`)

- Forwards any `/api/admin/*` request to the backend's `/v1/*` admin routes, injecting
  `Authorization: Bearer ${ADMIN_API_KEY}` server-side (lines 16–43) — `ADMIN_API_KEY` never
  reaches the browser bundle (not `NEXT_PUBLIC_*`).
- Iterates `BACKEND_URLS` (comma-separated `NEXT_PUBLIC_BACKEND_URL`, lines 11–14) for failover,
  identical pattern to `backendFetch()` in `payment.ts`.
- **No chain awareness at all** — it's a dumb reverse proxy to whichever single backend the
  frontend is configured to talk to. If multi-chain support means running **separate backend
  processes per chain** (see §7), this proxy (and its `/api/v1/[...path]/route.ts` sibling) would
  need either a chain-id path/query parameter to pick the right backend, or the backend itself
  would need to become multi-chain-aware internally (see §7 open question).

### 5.6 Every place that assumes a single chain / Quai-specific address formats (frontend summary)

| Location | Assumption |
| --- | --- |
| `src/lib/wallets.ts:318–323` `connectWallet()` | **Hard-rejects** any wallet account not in Quai's `0x00` zone — would incorrectly block valid Robinhood Chain/Base Sepolia accounts |
| `src/lib/wallets.ts:34–44` `QUAI_MAINNET_CHAIN` | The only `ChainConfig` in the codebase; nothing parameterizes it per network |
| `src/lib/wallets.ts:105–109` `QUAI_CAPABLE_BRANDS` | Wallet-capability allowlist conflates "can this wallet reach Quai" with wallet identity; needs to become per-chain |
| `src/lib/payment.ts:26,29,84–93` | Single `PAYWITHQUAI_ADDRESS`, single `MUSDQ_ADDRESS`, single memoized `rpcProvider` for the process/page lifetime |
| `src/lib/payment.ts:268–841` | ~570 lines of Blip-only transaction plumbing with no non-Quai equivalent needed, but also no gate keeping it from being invoked on a non-Quai order today beyond the UI's `payTab` state |
| `src/lib/currencies.ts` | Flat currency list with Quai-mainnet addresses baked in as defaults |
| `src/components/checkout/payment-method-selector.tsx` + checkout `page.tsx` | No chain dimension in the tab/method decision at all |
| `frontend/.env.local.example` | One `NEXT_PUBLIC_RPC_URL`/`NEXT_PUBLIC_PAYWITHQUAI_ADDRESS`/`NEXT_PUBLIC_MUSDQ_ADDRESS` triple for the whole deployment |

---

## 6. Config and deployment

### 6.1 Environment variables by package

**`contracts/.env.example`**: `RPC_URL`, `CHAIN_ID`, `CYPRUS1_PK` (deployer key, must be Cyprus-1),
`FEE_RECIPIENT`, `FEE_BPS`, `STABLECOIN_ADDR`, `MULTISIG_ADDR`, `TIMELOCK_MIN_DELAY`,
`PAUSE_GUARDIAN_ADDR`, `MERCHANT_ADDR` (payDemo.js only).

**`backend/.env.example`**: `RPC_URL`, `CHAIN_ID`, `PAYWITHQUAI_ADDRESS`, `START_BLOCK`,
`CONFIRMATIONS`, `POLL_INTERVAL_MS`, `MAX_BLOCK_RANGE`, `WEBHOOK_MAX_ATTEMPTS`,
`WEBHOOK_BASE_BACKOFF_MS`, `WEBHOOK_MAX_BACKOFF_MS`, `WEBHOOK_TIMEOUT_MS`,
`WEBHOOK_ALLOW_INSECURE_URLS`, `PORT`, `TRUST_PROXY`, `LOGIN_REALM`, `CORS_ORIGINS`,
`ADMIN_API_KEY`, `ACCEPTED_TOKENS`, `PUBLIC_RATE_LIMIT_WINDOW_MS`, `PUBLIC_RATE_LIMIT_MAX`,
`QI_MNEMONIC`, `QI_RPC_URL`, `QI_QITS_PER_QUAI`, `QI_POLL_INTERVAL_MS`, `QI_DEV_SIMULATE`,
`QI_DEV_DEMO_MERCHANT`, `DATABASE_PATH`, `DATABASE_URL`, `DATABASE_SSL`, `LOG_LEVEL`,
`LOG_PRETTY`. All validated by a single Zod schema in `backend/src/config.ts` — every non-Qi
value is a scalar, one-per-process.

**`frontend/.env.local.example`**: `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_CHAIN_ID` (declared, appears
unread — see §5.3), `NEXT_PUBLIC_PAYWITHQUAI_ADDRESS`, `NEXT_PUBLIC_MUSDQ_ADDRESS`,
`NEXT_PUBLIC_USDT_ADDRESS`/`NEXT_PUBLIC_WQUAI_ADDRESS` (optional overrides),
`NEXT_PUBLIC_BACKEND_URL` (comma-separated failover list), `ADMIN_API_KEY` (server-only).

### 6.2 `railway.json` and Vercel

- **`railway.json`** (repo root, 14 lines) — Nixpacks build (`npm run build`), start
  (`npm start`), health check `/health` (60s timeout), restart on failure (max 10 retries), no
  sleep. This configures **one Railway service** — presumably the backend, given `/health` matches
  `backend/src/api/server.ts:91`. Nothing chain-specific here; it just runs whatever `npm start`
  the deployed service defines against whatever env vars Railway injects (including
  auto-provisioned `DATABASE_URL` for Postgres, per `README.md:65–66`).
- **Vercel**: not configured in-repo (no `vercel.json`); `frontend/README.md` and the root
  `README.md` don't describe a specific Vercel setup beyond `pnpm dev`/env vars — presumably
  configured directly in the Vercel dashboard with the `NEXT_PUBLIC_*`/`ADMIN_API_KEY` vars from
  §6.1. Not independently verifiable from the repo alone.
- **Implication for multi-chain**: if each chain gets its own backend deployment (simplest
  isolation strategy — see §7), each would need its own Railway service (or the same service
  re-parameterized per environment) and its own `DATABASE_URL`/`RPC_URL`/`CHAIN_ID`/
  `PAYWITHQUAI_ADDRESS` set. The frontend would then need `NEXT_PUBLIC_BACKEND_URL` to become
  chain-aware (today it's a flat failover list of URLs assumed to be the *same* chain's backend
  replicas, not different chains).

---

## 7. Assessment

### 7.1 Changes needed, by package

**`contracts/` — mostly Easy**

| Change | Difficulty |
| --- | --- |
| Add `networks.robinhoodTestnet` (46630) / `networks.baseSepolia` (84532) to `hardhat.config.js` | **Easy** — pure Hardhat config |
| Swap `quais` → `ethers` in `deploy.js`/`upgrade.js`/`payDemo.js`/`allowTokens.js` (`ContractFactory`, `Contract`, `Wallet`, `JsonRpcProvider`) | **Medium** — mechanical but touches every script; `ethers` is already a `hardhat-toolbox` transitive dependency so no new install is needed for compile/test, only for these scripts |
| Drop Cyprus-1 key-grinding / zone checks for non-Quai networks | **Easy** — just skip `generateCyprus1Key.js` and the zone-derived logic for these networks |
| Drop/guard the IPFS-CID (`pushMetadata`) Quaiscan-verification path for non-Quai networks | **Easy** — already wrapped in try/catch; make it conditional on network |
| Generalize the mainnet-only guard-rail check (`chainId === 9`) to a chain-id-aware policy | **Medium** — needs a small design decision (map of "protected" chain ids), not just a rename |
| The contract itself (`PayWithQuai.sol`) | **No change needed** — already portable, already tested on a vanilla EVM |
| Verification tooling (Etherscan-compatible for Base; whatever Robinhood Chain's explorer needs) | **Medium** — new, chain-specific tooling, but standard Hardhat plugins likely cover it (`hardhat-verify`) |

**`backend/` — the largest lift, mostly Hard**

| Change | Difficulty |
| --- | --- |
| Add a standard-EVM chain client (`ethers`/`viem`-based) alongside `QuaiClient`, behind a common interface (`getBlockNumber`, `getPaymentEvents`, `isSettled`, `getOrder`) | **Hard** — `QuaiClient` isn't behind an interface today; introducing one is a real refactor, not additive |
| Support N configured chains instead of one global `RPC_URL`/`CHAIN_ID`/`PAYWITHQUAI_ADDRESS` (config schema, `index.ts` wiring, N `Indexer`s) | **Hard** — touches `config.ts`, `index.ts`, and every route/handler that currently reads `cfg.CHAIN_ID`/`cfg.PAYWITHQUAI_ADDRESS` directly |
| Add `chainId` to `Merchant`, `PaymentLink`, `OrderMeta`, `WebhookDelivery` and the Postgres schema (+ `JsonStore` mirror) | **Hard** — a real schema migration across two store backends, plus every route that keys by address alone must add chain disambiguation |
| Make the login-challenge message support multiple valid chain ids for one deployment (or require one backend deployment per chain) | **Medium–Hard** — depends on the architectural choice (see Open Questions) |
| Per-chain `ACCEPTED_TOKENS` allowlist | **Medium** — schema + route logic change, contained |
| Per-chain `CONFIRMATIONS`/`POLL_INTERVAL_MS`/`MAX_BLOCK_RANGE` tuning (L2s finalize differently — see Risks) | **Easy** once multi-chain config exists — just more scalar knobs, per chain |
| `cursorScope()` and the `Store` interface's cursor methods | **No change needed** — already chain-id-shaped, just needs to actually be called with >1 scope |
| Qi service/indexer | **No change needed** — stays Quai-only, already fully feature-gated |
| `quais.getAddress`/`verifyMessage` zone-checksum compatibility with plain EVM addresses | **Medium** — needs verification once `quais`/`ethers` coexist; likely requires swapping these specific calls to `ethers` equivalents for the new-chain code path regardless |

**`frontend/` — large, but more mechanical than the backend**

| Change | Difficulty |
| --- | --- |
| Remove the hard `getZoneForAddress(...) !== "0x00"` rejection in `connectWallet()` | **Easy** — but must be replaced with real per-chain validation, not just deleted |
| Turn `currencies.ts` into a per-chain registry (chain id → currency list) | **Medium** — the shape (`CurrencyInfo[]`) is already reasonable; the change is indexing it by chain |
| Turn `QUAI_MAINNET_CHAIN`/`ChainConfig` into a table of supported chains (Quai, Robinhood testnet, Base Sepolia) and thread a "current chain" through `wallets.ts`/`payment.ts` | **Hard** — `payment.ts` in particular has no chain parameter anywhere; every exported function implicitly assumes Quai mainnet |
| Add `ethers`/`viem` for the non-Quai chain paths (contract calls, provider, signer) — `quais` stays for Quai only | **Hard** — this is effectively building a second, parallel chain-interaction layer and choosing which one to invoke based on order/link chain id |
| Widen `QUAI_CAPABLE_BRANDS` logic into a general "wallet supports chain X" capability model | **Medium** |
| Add a chain-selection dimension to the checkout UI (`payment-method-selector.tsx`, checkout `page.tsx`, `pay/[slug]/page.tsx`) — which wallets/panels to offer depends on the order/link's chain | **Medium–Hard** — the components are already cleanly separated (`payTab` state, discrete panels), so this is additive rather than a rewrite, but needs real design work for "Qi/Blip only show for Quai orders" |
| `wallet-balances.tsx` — read balances against the correct chain's provider/currency list | **Medium** — depends on the currencies/chain-table refactor above being done first |
| Admin/v1 API proxies (`route.ts` files) | **Easy–Medium** — depends entirely on whether the backend ends up as one multi-chain service or N per-chain services (see Open Questions) |

### 7.2 Recommended order of work

1. **Contracts first, and cheaply**: stand up `robinhoodTestnet`/`baseSepolia` Hardhat networks,
   swap the deploy scripts to `ethers`, and get a real `PayWithQuai` proxy deployed to both
   testnets. This is low-risk (the contract needs no changes) and unblocks everything downstream
   with real addresses to build against.
2. **Decide the backend architecture question before writing backend code** (see Open Questions
   §7.4 — one multi-chain process vs. one process per chain). This decision determines whether
   the "Hard" backend items in §7.1 are a big refactor or a deployment/ops exercise.
3. **Backend: add the standard-EVM chain client behind a common interface**, wire it up for one
   new chain (Base Sepolia is likely the easier target — more mature tooling/RPC stability than a
   brand-new L2 testnet), and get the indexer/webhook path working end-to-end for it before
   touching schema.
4. **Backend: schema + config changes** (`chainId` on merchants/links/etc., per-chain env config)
   — do this once the single-new-chain path above is proven, so the schema shape is informed by
   real usage rather than guessed upfront.
5. **Frontend: chain-table + currencies refactor**, then wire `payment.ts`'s non-Blip/non-Qi path
   through `ethers`/`viem` for the new chain, gated behind the existing `payTab`/checkout
   component structure (which already separates concerns reasonably well).
6. **Frontend: checkout UI chain-selection** — once a single non-Quai chain works end-to-end,
   extend the UI to show/hide Blip and Qi appropriately and let a merchant's payment link declare
   which chain it's denominated on.
7. **Second EVM chain (Robinhood Chain testnet) and any remaining polish** — by this point the
   abstraction should mostly be "add a row to the chain table," which is the goal of doing the
   harder architectural work on one chain first.

### 7.3 Risks

- **Upgradeable storage**: low risk *for multi-chain specifically* — each chain gets its own
  proxy/implementation pair with independent storage, so the ERC-7201 append-only discipline
  (§2.3) doesn't interact with multi-chain work at all. The real risk here is unchanged from
  today: a future upgrade that violates the append-only rule breaks the *existing* Quai
  deployment, regardless of how many other chains exist.
- **Reorg / confirmation differences on L2s**: `CONFIRMATIONS` (default 12, tuned for Quai) is a
  single global value today. Base Sepolia (an OP-Stack L2 testnet) and Robinhood Chain testnet
  likely have very different practical finality characteristics than Quai's Cyprus-1 zone — a
  naive "same `CONFIRMATIONS` for every chain" config would either wait far too long (bad UX) or
  far too little (false "paid" on a reorg) once multiple chains are live. This must become a
  per-chain tunable, not a shared constant.
  - Second finality guard: the indexer already re-checks `getOrder(...).settled` on-chain before
    queuing a webhook — this pattern should carry over unchanged to new chains and is a real
    mitigant.
- **Cross-chain signature replay**: the wallet-login challenge already binds `CHAIN_ID` +
  `LOGIN_REALM` into the signed message (§4.4) — this is good anti-replay design *if* each
  deployment keeps a distinct, correct `CHAIN_ID`. The risk surfaces specifically if a single
  backend process is made to serve multiple chains (§7.4 open question) without also making the
  challenge message bind to *which* chain the merchant is registered/acting on — a signature
  produced for "merchant on Base Sepolia" must not be replayable as "merchant on Robinhood Chain"
  even if the same EOA happens to control both.
- **Address collision across chains**: because `Merchant`/`PaymentLink` are keyed purely by
  on-chain address with no chain dimension (§4.5), the same address active on two different chains
  would collide in the current schema. This is not a signature-replay risk (addresses aren't
  secret) but a data-model risk: onboarding the same wallet address on two chains would need to
  either merge into one merchant record (probably wrong — different webhook needs per chain) or
  requires the chain-id-on-every-row schema change flagged in §7.1 before any address can safely
  be used on more than one chain.
- **Token decimals**: already handled reasonably — `CurrencyInfo.decimals` (frontend) and
  `feeBps`/`amount` as raw on-chain integers (backend/contract) are decimal-agnostic by design.
  The risk is purely in *populating* a correct per-chain currency table (e.g. Base Sepolia's
  canonical USDC — if any — has its own address/decimals, unrelated to Quai's USDT/WQUAI
  addresses) — an easy mistake (wrong decimals) with real financial consequences (under/over
  charging), but a data-entry risk, not an architectural one.
- **`quais.getAddress`/`getZoneForAddress` zone-checksum behavior on non-Quai addresses**: flagged
  in §4.3/§5.6 as needing hands-on verification (not something inferable by reading source alone
  without the installed package) — if these functions reject or mis-checksum a plain EVM address
  that doesn't encode a valid Quai zone, every code path that calls them (which is most of the
  backend's request validation and most of the frontend's `payment.ts`) needs the non-Quai code
  path routed through `ethers`/`viem` equivalents instead, not just a "try/catch and fall
  through."
- **Fee-on-transfer / rebasing tokens**: already called out in `contracts/README.md:156–159` as an
  existing risk mitigated only by the allowlist — this becomes *more* important with multiple
  chains, since a merchant might allowlist a token on Base Sepolia without the same scrutiny given
  to the current Quai mainnet allowlist (`allowTokens.js`'s canonical, hand-verified list).
- **Dead/likely-unused `NEXT_PUBLIC_CHAIN_ID`** (§5.3): worth resolving (either wire it up or
  remove it) before it becomes a second, drifting source of truth once real chain switching is
  built.

### 7.4 Open questions for the team lead

1. **One backend process serving multiple chains, or one backend deployment per chain?** This is
   the single decision that most determines the size of the backend refactor. A per-chain
   deployment (separate Railway service, separate `DATABASE_URL`/`RPC_URL`/`CHAIN_ID`/
   `PAYWITHQUAI_ADDRESS`, reusing today's single-chain code almost unchanged) is far cheaper to
   ship than making one process multi-chain-aware, at the cost of merchants needing separate
   onboarding/webhook-secret/session state per chain (and the frontend needing to know which
   backend to talk to for which chain).
2. **Should a merchant's account be shared across chains, or is a merchant address effectively
   scoped to one chain?** Determines whether `Merchant` needs a `chainId` column (one merchant row
   per chain) or a `chainId` *list* (one merchant, many payout addresses/chains) — very different
   schema and login-flow implications (§7.3 cross-chain signature-replay risk).
3. **Do payment links/orders declare a single fixed chain, or can a customer choose which chain to
   pay from for the same link?** Determines a lot of the checkout UI work in §7.1/§5.4 — "one
   chain per link" is much simpler than "any accepted chain per link."
4. **Is Robinhood Chain testnet's RPC (`https://rpc.testnet.chain.robinhood.com/rpc`) stable/
     documented enough to build the indexer's confirmation/reorg assumptions against yet**, or
   should Base Sepolia be the first non-Quai chain shipped (more mature infra, well-documented
   finality characteristics) with Robinhood Chain following once its testnet matures?
5. **What's the target verification/explorer story per chain** (Quaiscan is bespoke; Base Sepolia
   likely wants Etherscan-compatible verification; Robinhood Chain's explorer tooling is
   unknown to me) — affects the `pushMetadata`/IPFS-CID replacement work in §3.5.
6. **Should `quais` be dropped from the frontend/backend entirely in favor of `ethers`/`viem` for
   everything (including Quai), or does Quai's `quais`-specific behavior (zones, Qi, Blip bridge
   quirks) mean it must stay a permanent parallel dependency alongside a standard-EVM library?**
   The audit found no evidence `ethers`/`viem` could fully replace `quais` for Quai's own zone/Qi
   features, but confirming this (and picking the standard-EVM library) is a prerequisite for
   scoping the backend/frontend work precisely.
