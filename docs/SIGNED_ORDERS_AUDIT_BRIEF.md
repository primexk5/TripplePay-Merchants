# Signed Orders — Audit Brief

**Scope:** the customer-paid EIP-712 order flow on `feat/gateway-shopify` — contract
(`paySignedOrder` + signing domain), backend signer (`backend/src/chain/signer.ts`) and claim
lifecycle, gateway claim ownership, and the deployment/upgrade tooling.

**Status: this is a self-review, not an independent audit.** No third party has reviewed this code.
It is written to make a third-party review cheap and to record what is *known* to be unproven. Do
not treat it as sign-off for mainnet funds.

---

## 1. What changed

| Area | Change | Surface |
| --- | --- | --- |
| `contracts/contracts/PayWithQuai.sol` | +212/-2. New `paySignedOrder`, EIP-712 domain pinned by `initializeSigning` (a `reinitializer(3)`), signer allowlist `setSigner`/`isSigner`, `signedOrderHash`/`signedOrderDigest`, `signingInitialized`. State lives in a **new** ERC-7201 namespace `erc7201:paywithquai.signing`; `paywithquai.main` is untouched. | `contracts/contracts/PayWithQuai.sol` |
| Backend | `src/chain/relayer.ts` **deleted** (`RELAYER_PRIVATE_KEY` → `ORDER_SIGNER_PRIVATE_KEY`). Order ids are minted per claim off-chain; `mintClaimedOrder` / `claimFixedOrder` added; link expiry and redemption caps now enforced by the API because no on-chain order carries them. | `backend/src/chain/signer.ts`, `backend/src/api/server.ts`, `backend/src/store/*` |
| Frontend | `paySignedOrder` for Quai / Pelagus / Blip / standard EVM, legacy `payOrder` fallback, wallet-free link creation. | `frontend/src/lib/payment.ts`, `frontend/src/lib/evmPayment.ts` |
| Tooling | Deploy + upgrade scripts initialize the domain and allowlist the signer; `upgrade.js` gained a testable preflight (`scripts/lib/signingUpgrade.js`) and `PREFLIGHT=1` mode. | `contracts/scripts/*` |

---

## 2. Trust model

**Trusted:** the owner key (two-step, intended to be a `TimelockController`), every allowlisted
signer, the platform backend's signing key, and the merchant payout wallet (it only ever receives).

**Untrusted:** customers, browsers, link slugs, and anyone who observes a signature in flight.

**The single most important trust decision:** a signature is a *blank cheque for exactly one
purchase*, so every field a customer could be harmed by is inside the digest — amount, token,
merchant (the payout destination), expiry, fee rate **and** fee recipient. The contract never reads
`feeBps`/`feeRecipient` from mutable storage on the signed path, so a later `setFeeConfig` cannot
retroactively change what an issued signature pays, and a signature cannot be edited to redirect
funds or inflate fees.

### Attacker capabilities → controls

| Attacker can… | Control | Verified by |
| --- | --- | --- |
| Read a signature and settle someone else's order | `expectedPayer` bound to the wallet; `WrongPayer` otherwise | `PayWithQuaiSigned` "expectedPayer"; `BackendSignerE2E` "stranger holding the signature" |
| Replay a signature on another deployment of the same code | `verifyingContract` + `chainId` in the domain | `BackendSignerE2E` "different deployment of the same code" |
| Replay a signature after settlement | order is created **already settled**; `OrderAlreadyExists` on any second use | `PayWithQuaiSigned`; `BackendSignerE2E` |
| Sign their own order with someone else's funds | `msg.sender` is the payer; funds are pulled from `msg.sender` | `PayWithQuaiSigned` |
| Change the amount / fee / payout after signing | all fields are in `SIGNED_ORDER_TYPEHASH` | `PayWithQuaiSigned` "tampering with every signed field" |
| Pay less than the amount | settlement uses the signed `o.amount` for the ERC-20 pull, and requires `msg.value == amount` for native | `PayWithQuaiSigned`, `UpgradeRehearsal` native cases |
| Steal a gateway checkout from the customer who is paying it | `claimFixedOrder` takes ownership atomically; a second wallet gets `409` | `gateway.test` "refuses to hand the SAME fixed order id to a second wallet"; `store.test` |
| Claim a link forever by opening checkouts and leaving | stale-claim recycling hands an unsettled claim on after 15 min, re-signed for the new payer | `signedClaims.test`; `store.test` |
| Pay an expired link | backend returns `410`; the authorization carries the link's **absolute** deadline, never `now + window` | `signedClaims.test` expiry cases |
| Use a signature for a long-dead link | same absolute expiry; authorizations with <60s of life are refused rather than signed | `signedClaims.test` |
| Re-entrancy during settlement | `nonReentrant`, effects before interactions | `Reentrant*` mocks in the existing suite |
| Pay while paused | `whenNotPaused` on the signed path | `PayWithQuaiSigned` pause case |
| Keep using the platform after a key compromise | `setSigner(addr, false)` kills authorizations instantly; settled orders untouched | `PayWithQuaiSigned` revoke case |

---

## 3. Invariants the implementation must hold

1. **No authorization outlives its link.** `expiry` is the link deadline; a link with no window
   (`0`) yields a non-expiring authorization.
2. **An authorization is spent the moment it settles.** Creation and settlement are one transaction;
   there is no window in which an order exists unpaid by a signed order.
3. **The contract never holds funds.** Both paths forward everything out in the same transaction.
4. **The fee paid is the fee signed.** Stored `feeBps`/`feeRecipient` come from the signature.
5. **A fixed gateway order id has exactly one owner at a time**, and never one after settlement.
6. **A legacy pre-registered order is untouched by the upgrade** and stays payable both ways.
7. **The upgrade is idempotent**: `initializeSigning` is consumed at most once, ever.

Invariants 6 and 7 are the ones most likely to break silently in the future, which is why
`test/UpgradeRehearsal.test.js` exists and why `scripts/lib/signingUpgrade.js` was split out of the
script to be testable at all.

---

## 4. What the rehearsal changed

The upgrade path was rehearsed against a proxy whose implementation is the **pre-signed-era router**
(`contracts/mocks/LegacyPayWithQuaiMock.sol` — same ERC-7201 struct, same `orderKey` derivation, no
signing functions, no fallback). Three real defects surfaced:

1. **The upgrade script could not upgrade a live proxy.** It read `proxy.signingInitialized()`
   *before* upgrading; on a pre-signed proxy that call reverts, and the script treated the revert as
   fatal — aborting the very upgrade that fixes it. Fixed by `readSigningInitialized()`, which reads
   a missing function as "not initialized" while still surfacing genuine transport failures, and
   which now *fails loudly* if the post-upgrade read says false.
2. **`isSigner()` had the same problem**, so a signer could never be re-allowlisted on a
   pre-signed proxy. `readSignerAllowlisted()` returns `null` ("unknown — just call `setSigner`")
   instead of guessing.
3. **A storage/encoding mismatch makes every pre-existing order vanish.** The rehearsal's own mock
   first derived `orderKey` with `abi.encodePacked` instead of `abi.encode`; the post-upgrade read of
   a pre-registered order returned `exists: false`. Nothing in the existing tests would have caught
   that class of bug, because they all start from a freshly deployed proxy. The mock now documents
   the requirement.

`PREFLIGHT=1 npx hardhat run scripts/upgrade.js --network <net>` performs all of these reads and
broadcasts nothing.

---

## 5. Residual risks (accepted, or to fix before mainnet)

| # | Risk | Severity | Status |
| --- | --- | --- | --- |
| R1 | **No independent audit.** All evidence here is self-generated. | High | Open — blocker for mainnet |
| R2 | **Single platform signer is a liveness dependency.** `setSigner(addr, false)` with no replacement stops every customer payment instantly. | Medium | Accepted; add a second signer before mainnet, and alert on allowlist changes |
| R3 | **Signer key custody.** `ORDER_SIGNER_PRIVATE_KEY` needs no gas, so it can live on a machine with no funds — but it can mint authorizations for any amount on any link. | High | Key management is out of scope of this diff; must be decided before mainnet |
| R4 | **Fee truncation.** `fee = amount * feeBps / 10_000` rounds down; tiny payments pay ~no fee. Pre-existing. | Low | Accepted |
| R5 | **Non-fee-on-transfer tokens.** The contract measures the *requested* amount, so a fee-on-transfer token delivers less than the event reports. Mitigated by the owner-controlled token allowlist. | Medium | Pre-existing; allowlist policy is the control |
| R6 | **Stale-claim window (15 min).** An abandoned checkout can be taken by another wallet and settled; the first wallet's authorization is bound to them and simply becomes unusable. | Low | Accepted — the alternative is a permanent lock |
| R7 | **Reorgs.** A signed settlement can be reorged out; the indexer waits N confirmations before `payment.confirmed`. | Medium | Pre-existing; confirmations policy |
| R8 | **Backend is the only expiry/cap enforcer** for signed orders. A bypassed API can mint authorizations past a link's intent (never past the signed deadline). | Low | Accepted; the contract cannot know about links |
| R9 | **Postgres claim paths are untested here** (`claimFixedOrder`, `mintClaimedOrder` — the `FOR UPDATE` serialization). `docker` is installed but its daemon is not running in this environment, so the suite still skips. | Medium | Open — `docker compose up -d db && TEST_DATABASE_URL=… npm test` in `backend/` |
| R10 | ~~Quai mainnet RPC unreachable~~ **RESOLVED 2026-10-02.** It answers at `https://rpc.quai.network/cyprus1`; the bare host `https://rpc.quai.network` is the trap — it returns `eth_chainId` but every `eth_call`/`eth_getCode` comes back empty, so it looks alive right up until it silently fails. Both live chains were then read directly and recorded in `contracts/deployments/*.json` under `verified`. | — | Closed |
| R11 | ~~Mainnet may be timelock-owned~~ **RESOLVED, and the answer is worse than assumed.** The live proxy's `owner()` is `0x000E25274329cCa64Cf76b87Edd6A1f158952582` — an **EOA with no code on-chain**. A `TimelockController` is deployed at `0x005271b4…ffC` with `getMinDelay() = 172800`, but the proxy was never handed to it and the owner EOA does not hold `PROPOSER_ROLE` on it. | — | Closed — see R12 |
| R12 | **Mainnet upgrade authority is a single hot EOA with no timelock.** `owner()` on the live Cyprus-1 proxy is a plain EOA; the timelock that was deployed for this purpose is unwired (no `acceptOwnership()`, owner lacks `PROPOSER_ROLE`). Consequences: (a) one key compromise rewrites live payment code, (b) there is no 48h delay between proposing and executing an upgrade, (c) there is no multisig requirement. Separately, **the mainnet owner key is present in `contracts/.env` as `CYPRUS1_PK` on a developer machine** — i.e. production upgrade authority is on a laptop, not in a vault or HSM. | **High** | **Open — hand ownership to the timelock, move the key off the dev machine, and put `PROPOSER_ROLE` on a multisig before the signed-order upgrade lands.** Until then treat any `npm run upgrade --network cyprus1` as an unaudited, undelayed production change |

---

## 6. Deployment checklist

Nothing in this diff has been broadcast. Live chain state was read read-only on 2026-10-02 (Quai
mainnet + Robinhood testnet); both proxies still run the pre-signed-order implementation. Before
mainnet:

- [ ] Independent audit of `PayWithQuai.sol` + `signer.ts` complete (R1).
- [x] `PREFLIGHT=1` run against Quai mainnet — owner, impl slot and signing state confirmed
      read-only; `signingInitialized()` reverts, so signed orders are **not** live on mainnet yet.
- [x] Robinhood testnet deployment read back live and recorded in
      `contracts/deployments/robinhoodTestnet.json`.
- [ ] Hand the mainnet proxy to the timelock (`acceptOwnership()`), give a multisig `PROPOSER_ROLE`,
      and move the owner key off the developer machine (R12).
- [ ] Re-run `PREFLIGHT=1` **after** ownership moves: `caller is owner` will flip to `false` and the
      upgrade becomes a timelock proposal → wait `TIMELOCK_MIN_DELAY` → execute → verify.
- [ ] `ORDER_SIGNER_ADDRESS` decided, derived from the key held in the backend, and allowlisted with
      `setSigner(addr, true)` — verified on-chain afterwards.
- [ ] A second signer allowlisted as a fallback (R2), with alerting on `setSigner` events.
- [ ] Backend `ORDER_SIGNER_PRIVATE_KEY` stored in a secret manager; `.env` never committed.
- [ ] Backend pointed at the new proxy with the matching `PAYWITHQUAI_ADDRESS`/`CHAIN_ID`, then
      `POST /v1/links/:slug/claim` returns an `authorization` on a test link.
- [ ] Legacy links verified payable end-to-end after the upgrade (a pre-registered order settled via
      `payOrder` on the upgraded proxy — exactly what `UpgradeRehearsal` asserts locally).
- [ ] Postgres suite run against a real database (R9).
- [ ] Indexer restarted with a `START_BLOCK` at or before the upgrade block, so signed settlements
      are indexed.
