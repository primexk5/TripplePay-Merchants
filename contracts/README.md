# Pay with Quai — Smart Contracts

The on-chain component of the **Pay with Quai** merchant checkout system (docs 4). A
non-custodial payment router. Orders can be created two ways, and both end the same way — the
customer settles in one transaction, the contract verifies the amount, withholds an optional
platform fee, forwards funds to the merchant, and emits a `PaymentReceived` event for the
off-chain backend indexer:

- **Signed / customer-paid (current).** The customer's own transaction creates *and* settles the
  order: an allowlisted signer authorizes the order off-chain with EIP-712 and the customer
  submits `paySignedOrder(order, signature)`. Nobody spends gas to open a checkout, and the
  merchant wallet only needs to be able to *receive*.
- **Legacy.** The merchant registers an order up front (`registerOrder` / `registerOrderBatch` /
  `registerOrderWithPayer`) and the customer settles it with `payOrder` / `payOrderNative`.
  Fully supported — nothing already shipped breaks — but no longer needed.

Funds never rest in the contract — every payment is routed through and out in the same
transaction, keeping the attack surface minimal.

## Contracts

| Contract | Purpose |
| --- | --- |
| `PayWithQuai.sol` | UUPS-upgradeable payment router: `paySignedOrder` (customer-paid, EIP-712 authorized) plus the legacy `registerOrder` / `cancelOrder` / `payOrder` / `payOrderNative` lifecycle, signer allowlist (`setSigner`, `initializeSigning`), token allowlist + fee + pause admin, `rescueTokens` sweep, two-step ownership, owner-gated upgrades. |
| `governance/Imports.sol` | Compile-only: pulls OZ `ERC1967Proxy` (the proxy that fronts the router) and `TimelockController` (the upgrade-governance owner) into local artifacts for the deploy script. |
| `MockStablecoin.sol` | 6-decimal test ERC-20 (`mUSDQ`) with an open `mint` faucet — testing/testnet only. |
| `mocks/Reentrant*.sol` | Test-only attackers proving the reentrancy guard holds. |
| `mocks/PayWithQuaiV2Mock.sol` | Test-only upgrade target proving a UUPS upgrade preserves all storage. |

The router is deployed as a **UUPS proxy**: an `ERC1967Proxy` holds all state and delegates logic
to a `PayWithQuai` implementation. Everyone (merchants, customers, the backend indexer) interacts with the
**proxy address**; the implementation can be swapped later to add features without migrating state.
See [Upgradeability & governance](#upgradeability--governance).

### Payment flow — signed (current)

```
owner.initializeSigning('PayWithQuai', '1')            // once, at deploy: pins the EIP-712 domain
owner.setTokenAccepted(token, true)                    // once, per settlement asset (address(0) = native QUAI)
owner.setSigner(platformSigner, true)                  // once, per trusted signer (off-chain EIP-712 only)
backend.signOrder({ merchant, orderId, token, amount, expiry,
                    feeBps, feeRecipient, expectedPayer })   // NO transaction, NO gas
customer.approve(PayWithQuai, amount)                  // ERC-20 only
customer.paySignedOrder(order, signature)              // native: { value: amount }
        └─► verify signer ─► recover signer ─► check domain/chainId ─► check payer + expiry
        └─► CREATE order ─► split fee ─► pay merchant ─► mark settled ─► emit PaymentReceived
```

The order does not exist until the customer pays for it. `expectedPayer` binds one authorization
to one wallet, so a leaked or front-run signature can't be settled by anyone else; leave it at
`address(0)` only if you deliberately accept "first come, first served" orders. `feeBps` and
`feeRecipient` are part of what the merchant signs (the backend reads them from-chain at signing
time), so a later `setFeeConfig` can never change what an already-issued signature pays, and a
settlement that disagrees with the signature reverts rather than paying the wrong party. A
settled order can never be paid twice (`OrderAlreadySettled`). Removing a signer from the
allowlist stops future authorizations instantly; orders already settled are untouched.

### Payment flow — legacy (still supported)

```
owner.setTokenAccepted(token, true)                    // once, per settlement asset (address(0) = native QUAI)
merchant.registerOrder(orderId, token, amount, expiry) // once, per order (expiry 0 = never); locks in the current fee
customer.approve(PayWithQuai, amount)                  // ERC-20 only
customer.payOrder(merchant, orderId)                   // or payOrderNative{value: amount}(merchant, orderId)
        └─► verify amount ─► split fee ─► pay merchant ─► mark settled ─► emit PaymentReceived
```

Orders are keyed by `(merchant, orderId)`, and only the merchant can register (or cancel) its
own orders, so a third party cannot front-run or hijack an order id. A settled order can never
be paid twice (`OrderAlreadySettled`); an unpaid order can be `cancelOrder`ed to free its id, or
left to lapse if it was given an `expiry`. The platform fee is **locked at registration** — a
later `setFeeConfig` only affects orders registered after it, so a merchant's net proceeds are
fixed the moment they register. Anyone may *submit* the payment (the `payer` need not be the
buyer you expect); settlement is validated by amount + order state, not by payer identity —
use `registerOrderWithPayer` (or the signed path's `expectedPayer`) when that isn't good enough.

### The event the backend indexer listens for (docs §4.3)

```solidity
event PaymentReceived(
    address indexed merchant,
    bytes32 indexed orderId,
    address payer,
    address token,       // settlement asset (address(0) = native QUAI)
    uint256 amount,      // gross amount the payer sent; merchant nets amount - fee
    uint256 timestamp
);
```

`merchant` and `orderId` are indexed so the indexer can filter efficiently per merchant. `token`
is included so the indexer can act on the event without a follow-up read. The string `merchantId`
from the webhook payload (§5.2) is an off-chain mapping from this address.

> **Wait for finality before confirming.** `PaymentReceived` can be emitted in a block that later
> reorgs. The indexer should wait for N confirmations (and optionally re-check `isSettled` on-chain)
> before POSTing `payment.confirmed` to the merchant — otherwise a reorg produces a false "paid".

## Upgradeability & governance

The router is a **UUPS (ERC-1967) upgradeable** contract. Two addresses matter:

- **Proxy** — holds all state, never changes. This is the address in `deployments/<network>.json`
  (`payWithQuai`) that merchants, customers, and the backend indexer use.
- **Implementation** — the logic. Swappable via `upgradeToAndCall`, gated by `_authorizeUpgrade`
  (owner-only). Recorded as `payWithQuaiImpl`.

**Storage safety.** All mutable state lives in an ERC-7201 *namespaced* struct (`paywithquai.main`),
and each base module (Ownable2Step, Pausable, ReentrancyGuard) uses its own namespaced slot. This is
what makes upgrades safe. The rules for any future version:

- **Never remove or reorder** fields in `MainStorage` — only **append** new ones.
- New modules (escrow, refunds, subscriptions…) should declare their **own** ERC-7201 namespace,
  exactly like `mocks/PayWithQuaiV2Mock.sol` does — then they can never collide with existing state.
- Use a `reinitializer(n)` for any state a new version introduces (see `initializeV2`).

**Governance.** The owner can pause, set the fee (≤ 5%), manage the allowlist, and **upgrade the
logic** — so in production the owner must not be a hot EOA. Set `MULTISIG_ADDR` and the deploy script
deploys an OZ `TimelockController` (proposer/executor = your multisig, e.g. a Gnosis Safe) and
transfers ownership to it. An upgrade then flows: multisig **schedules** `upgradeToAndCall` on the
proxy through the Timelock → waits `TIMELOCK_MIN_DELAY` (default 48h) → **executes**. The delay is a
public warning window: anyone watching can exit before a pending upgrade lands.

> Because the router uses `Ownable2Step`, transferring ownership to the Timelock is a two-step
> hand-off — the Timelock must `acceptOwnership()`. The deploy script prints the exact call to
> schedule from the multisig to complete it.

## Quickstart

```bash
cd contracts
npm install
npx hardhat compile
npx hardhat test        # full suite on the in-process EVM — no node or funds needed
```

## Deploy to Quai mainnet

```bash
cp .env.example .env
# Fill in: RPC_URL=https://rpc.quai.network, CHAIN_ID=9, CYPRUS1_PK (funded hot key),
# FEE_RECIPIENT (treasury), STABLECOIN_ADDR, MULTISIG_ADDR, PAUSE_GUARDIAN_ADDR.
npm run deploy   # deploys impl + proxy (+ Timelock; MockStablecoin is skipped on mainnet)
```

The script refuses to deploy on mainnet (chain 9) unless `MULTISIG_ADDR`, `PAUSE_GUARDIAN_ADDR`
and `FEE_RECIPIENT` are all set, and verifies the fee routing on-chain after initialization.

- Solidity **0.8.20**, `evmVersion: london` (Quai EVM supports ≤ 0.8.20). OpenZeppelin is pinned to
  **5.0.2** — the last line whose proxy/UUPS files still allow the `0.8.20` pragma (5.1+ requires
  ≥ 0.8.22 / PUSH0). **Do not bump OZ** without re-checking this, or the build breaks on Quai.
- The deploy script deploys the implementation, an `ERC1967Proxy` (initialized with the deployer as
  owner so it can allowlist assets), then allowlists native QUAI + the stablecoin and initializes
  the EIP-712 signing domain. Everyone interacts with the **proxy** address written to
  `deployments/<network>.json`.
- Set `ORDER_SIGNER_ADDRESS` to also allowlist a signing key (`setSigner(addr, true)`) in the same
  run. It's optional at deploy time so the chain can come up first, but **a fresh deployment with
  no allowlisted signer cannot serve any customer-paid order** — do the `setSigner` before pointing
  the backend at it. The backend signs with the matching `ORDER_SIGNER_PRIVATE_KEY`; that key never
  needs gas, only the address allowlisting does.
- Upgrading an existing proxy: `scripts/upgrade.js` runs `initializeSigning` as part of the same
  `upgradeToAndCall` when the domain isn't initialized yet, and replays an already-configured signer
  when it is — so it's safe to re-run. On a proxy that has never had the signed implementation,
  `signingInitialized()` does not exist yet and reverts; the script reads that as "not initialized"
  rather than as an error.
- **Rehearse the upgrade without broadcasting:** `PREFLIGHT=1 npx hardhat run scripts/upgrade.js
  --network <net>` performs every read and prints exactly what it would send, then stops. It also
  reports the proxy's *actual* owner, which is the first thing to check: if ownership sits with a
  `TimelockController` (how mainnet is configured), this script cannot upgrade at all and the
  change must be scheduled through the timelock instead. It also compares the live EIP-712 domain
  against what the backend signs for, so a mismatch is caught before any transaction.
- The upgrade path is rehearsed in CI, not just on paper: `contracts/test/UpgradeRehearsal.test.js`
  stages a proxy whose implementation is the pre-signed-era router (no signing functions, identical
  storage) and proves the preflight read, the in-transaction `initializeSigning`, storage
  preservation for orders registered before the upgrade, the safe re-run, and a customer-paid
  settlement immediately after. `contracts/test/BackendSignerE2E.test.js` closes the loop by signing
  with the **shipped** backend signer module and settling against a real deployment.
- Set `MULTISIG_ADDR` to also deploy a `TimelockController` and hand off ownership (see
  [Upgradeability & governance](#upgradeability--governance)). On mainnet, set `STABLECOIN_ADDR` to
  a real stablecoin (or call `setTokenAccepted` later).
- Deploys use the **quais** SDK (Hardhat's ethers cannot talk to Quai). The `ContractFactory`
  takes an IPFS metadata CID (via `@quai/hardhat-deploy-metadata`) so Quaiscan can verify source.
- Networks: mainnet (`CHAIN_ID=9`, `https://rpc.quai.network`), Orchard testnet
  (`CHAIN_ID=15000`, `https://orchard.rpc.quai.network`) if you need it again.

## Standard EVM chains (testnet)

Alongside the Quai deployment above, `scripts/evm/` is a parallel toolchain — same contracts, same
initializer/governance model, but using `hre.ethers` (ethers v6) instead of the `quais` SDK, for
standard EVM testnets. The Quai scripts and networks are untouched by this.

```bash
cp .env.example .env
# Fill in EVM_DEPLOYER_PK (a fresh testnet-only key — any address format works, no Cyprus-1
# zone requirement) and fund it from a faucet:
#   Robinhood Chain testnet: https://faucet.testnet.chain.robinhood.com
#   Base Sepolia:            use any public Base Sepolia ETH faucet
npm run deploy:robinhood-testnet   # or: npm run deploy:base-sepolia
npm run demo:robinhood-testnet     # or: npm run demo:base-sepolia
```

- `deploy:robinhood-testnet` / `deploy:base-sepolia` deploy `MockStablecoin` + the `PayWithQuai`
  implementation + `ERC1967Proxy` (+ `TimelockController` if `MULTISIG_ADDR` is set), allowlist
  native currency and the mock stablecoin, initialize the signing domain (and allowlist
  `ORDER_SIGNER_ADDRESS` when set), verify the fee config + signing state on-chain, and write
  `deployments/<network>.json` — same format as the Quai deployment file above, plus
  `deployBlock` (the proxy's deployment block, for the backend's future `START_BLOCK`) and
  `explorer` (the network's block-explorer base URL).
- `demo:robinhood-testnet` / `demo:base-sepolia` run the same end-to-end checkout loop as
  `npm run demo` (mint, register, approve, pay, both ERC-20 and native), reading addresses from
  `deployments/<network>.json`.
- `allow:robinhood-testnet` / `allow:base-sepolia` allowlist settlement assets on an **already
  deployed** proxy, without redeploying it. Name the assets with `EXTRA_TOKENS` (or
  `STABLECOIN_ADDR`; `ONLY_TOKENS` replaces the list, `NO_NATIVE=1` skips native currency):

  ```bash
  EXTRA_TOKENS=0x<token> npm run allow:robinhood-testnet
  ```

  Unlike the Quai script, this one has **no hardcoded token list**: every standard EVM chain lists
  its own tokens, and an address from one chain is meaningless on another, so nothing is guessed.
  It reads `symbol()`/`decimals()` back on-chain for every address and refuses to send anything if
  one isn't a readable ERC-20 — so a typo fails before a transaction is broadcast. Take the
  addresses from that chain's block explorer, and note that a token has to exist on-chain on the
  chain you're deploying to (a bridged or native-tokenized asset is not the same contract as its
  Ethereum/Quai counterpart).

  Assets can also be allowlisted during deploy via `EXTRA_TOKENS` in `scripts/evm/deploy.js`;
  prefer the script above for anything added after the initial deploy, since it verifies symbols.
- These scripts refuse to run against a mainnet chain id (Quai `9`, Robinhood Chain `4663`, Base
  `8453`) — EVM mainnet deploys are disabled until the team reviews them.
- `FEE_RECIPIENT`, `FEE_BPS`, `STABLECOIN_ADDR`, `MULTISIG_ADDR`, `TIMELOCK_MIN_DELAY`,
  `PAUSE_GUARDIAN_ADDR` and `MERCHANT_ADDR` are shared with the Quai script's `.env` variables —
  see `.env.example` for the standard-EVM-specific notes on each.

## Notes & roadmap

- **Quai is sharded — keep everyone in one zone.** Value moves within a single zone, so the
  contract, the merchant payout wallet, and `feeRecipient` must all live in the same zone as the
  deployment (e.g. all Cyprus-1, address prefix `0x00`). A plain transfer cannot pay an address in
  another zone. Enforce this in the backend before registering an order.
- **The fee is locked at registration.** The customer pays the registered `amount`; the merchant
  nets `amount − fee` using the fee that was in effect *when the order was registered*. A later
  `setFeeConfig` only changes orders registered afterwards. `PaymentReceived.amount` is the gross
  figure.
- **`feeRecipient` must be transfer-safe.** On the native path the fee is sent via a plain `.call`,
  so a `feeRecipient` that reverts on receiving value would block every native payment. Keep it an
  EOA or a known payable-safe contract.
- **Stray funds are recoverable.** The router never holds funds during normal operation, but a
  stray ERC-20 `transfer` (or QUAI force-sent via `selfdestruct`) can land on it. The owner can
  `rescueTokens(token, to, amount)` to recover them (`token = address(0)` sweeps native QUAI).
- **Move ownership to a timelock+multisig.** The owner can pause payments, set the fee (≤ 5%), and
  **upgrade the logic**; don't leave a hot EOA as owner in production. Set `MULTISIG_ADDR` at deploy
  to wire the Timelock (see [Upgradeability & governance](#upgradeability--governance)). Ownership
  transfer is two-step (`Ownable2Step`).
- **Payout wallet** currently equals the registering wallet. A v2 upgrade can add a merchant
  registry (its own ERC-7201 namespace) separating a hot "controller" key from a cold payout
  address — no redeploy or state migration needed.
- **Escrow / refunds / split payments / subscriptions** are the doc's stretch (v2) features. With
  UUPS these ship as future upgrades/modules on the same proxy — this router is the v1 core.
- Native orders require an **exact** `msg.value` — correct for a fixed on-chain price. Any
  fiat→token slippage is resolved off-chain at quote time, before the amount is registered.
- Assumes standard (non-fee-on-transfer, non-rebasing) ERC-20 stablecoins. With a fee-on-transfer
  token the merchant would receive less than `amount − fee` while the event still reports the gross
  `amount`, so the indexer would confirm an under-delivered payment. **The token allowlist is the
  mitigation** — only allowlist vetted, well-behaved tokens.
