import {
  BrowserProvider,
  Contract,
  Interface,
  JsonRpcProvider,
  formatQuai,
  getAddress,
  id,
  parseQuai,
  type Signer,
} from "quais";
import paywithquaiAbi from "./paywithquai.abi.json";
import {
  ensureQuaiNetwork,
  getActiveWallet,
  QUAI_MAINNET_CHAIN,
  type Eip1193Provider,
} from "./wallets";
import {
  getWalletQuaiBalance,
  requestAppWalletFunding,
} from "./blip";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const PAYWITHQUAI_ADDRESS = process.env.NEXT_PUBLIC_PAYWITHQUAI_ADDRESS!;
// Settlement stablecoin on Quai mainnet — no testnet fallback exists anymore; the address must
// be provided explicitly (see frontend/.env.local.example).
export const MUSDQ_ADDRESS = process.env.NEXT_PUBLIC_MUSDQ_ADDRESS;
export const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL!;

/** PayWithQuai address for payments (Quai mainnet, Cyprus-1). */
export function resolvePayAddress(): string {
  return requireAddress("NEXT_PUBLIC_PAYWITHQUAI_ADDRESS", PAYWITHQUAI_ADDRESS);
}

/** Stablecoin address for payments (Quai mainnet, Cyprus-1). */
export function resolveTokenAddress(): string {
  return requireAddress("NEXT_PUBLIC_MUSDQ_ADDRESS", MUSDQ_ADDRESS);
}

/** Resolve a NEXT_PUBLIC_* contract address with a clear failure instead of the cryptic
 *  "unsupported addressable value (argument="target", value=null)" thrown by `new Contract(...)`
 *  when the env var is unset (NEXT_PUBLIC_ vars are inlined at build time). */
function requireAddress(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `${name} is not set in the frontend environment. NEXT_PUBLIC_* variables are inlined at ` +
        `build time — add it (see frontend/.env.local.example and frontend/src/app/docs/page.tsx) ` +
        `and redeploy.`,
    );
  }
  try {
    return getAddress(value);
  } catch {
    throw new Error(`${name}=${value} is not a valid address`);
  }
}

/**
 * Normalize an RPC base URL to a zone-gateway endpoint (Cyprus-1). The app only ever reads the
 * Cyprus-1 zone (accounts and contracts are all 0x00), so pointing the provider straight at the
 * `/cyprus1` path is safe. This must NOT be done with `usePathing: true`: `quais` alpha.56 then
 * probes `quai_listRunningChains` during init and — when that call fails (CSP-blocked origin,
 * node down, slow gateway) — loops forever inside `_waitGetRunningLocations`, wedging every
 * provider call indefinitely. That is what made the create-link flow spin forever after the
 * wallet signed. With `usePathing: false` init makes no network calls at all.
 */
function zoneRpcUrl(base: string): string {
  try {
    const url = new URL(base);
    if (url.pathname === "" || url.pathname === "/") {
      url.pathname = "/cyprus1";
    }
    return url.toString();
  } catch {
    return base.endsWith("/") ? `${base}cyprus1` : `${base}/cyprus1`;
  }
}

/** One provider reused across polls — avoids re-doing DNS/TLS handshakes on every status check,
 *  which matters a lot on slow or mobile networks. All reads go to the Quai mainnet RPC. */
let rpcProvider: JsonRpcProvider | undefined;
export function getRpcProvider(): JsonRpcProvider {
  if (!rpcProvider) {
    const url = process.env.NEXT_PUBLIC_RPC_URL;
    if (!url) {
      throw new Error("NEXT_PUBLIC_RPC_URL is not set in the frontend environment — add it and redeploy.");
    }
    rpcProvider = new JsonRpcProvider(zoneRpcUrl(url), undefined, { usePathing: false });
  }
  return rpcProvider;
}

const payInterface = new Interface(paywithquaiAbi);

/** Friendly copy for the custom errors the PayWithQuai contract can throw. */
const REVERT_MESSAGES: Record<string, string> = {
  OrderNotFound: "The order was not found on-chain — it may not have been registered for this link yet.",
  OrderAlreadySettled: "This order was already paid.",
  OrderExpired: "This payment link has expired.",
  WrongPayer: "This order is reserved for a different wallet.",
  WrongPaymentPath: "Payment method doesn't match the order's currency (QUAI vs token).",
  IncorrectNativeValue: "The amount sent doesn't match the order amount.",
  NativeTransferFailed: "The network rejected the payout transfer — please try again.",
  TokenNotAccepted: "The token isn't accepted by the payment contract.",
  ZeroAmount: "The order amount must be greater than zero.",
  InvalidExpiry: "The order expiry is invalid.",
  OrderAlreadyExists: "This order was already registered.",
  EnforcedPause: "Payments are temporarily paused — try again in a moment.",
  ReentrancyGuardReentrantCall: "Transaction reentrancy blocked — please try again.",
};

/** Replay the failing payment call at the current block to decode the real revert reason.
 *  Quai RPCs often return empty revert data for a mined failure ("missing revert data"), so we
 *  re-run eth_call to recover and decode the actual error before it reaches the UI. */
export async function getRevertReason(
  merchant: string,
  orderId: string,
  opts: { value?: bigint; token?: string; from: string },
): Promise<string | null> {
  try {
    const payAddress = resolvePayAddress();
    const token = opts.token;
    const isNative = !token || token.toLowerCase() === ZERO_ADDRESS.toLowerCase();
    const method = isNative ? "payOrderNative" : "payOrder";
    const data = payInterface.encodeFunctionData(method, [merchant, orderId]);
    await getRpcProvider().call({
      to: payAddress,
      from: opts.from,
      data,
      ...(isNative ? { value: opts.value ?? 0n } : {}),
    });
    return null; // the call would succeed now — the revert no longer reproduces
  } catch (err) {
    const e = err as Record<string, unknown>;
    const raw = e.data ?? (e.error as { data?: unknown } | undefined)?.data;
    if (typeof raw === "string" && raw.startsWith("0x")) {
      try {
        const decoded = payInterface.parseError(raw);
        const name = decoded?.name ?? "";
        if (name) {
          return REVERT_MESSAGES[name] ?? `${name} (${raw.slice(0, 10)}…)`;
        }
      } catch {
        // fall through to message extraction
      }
    }
    const reason = typeof e.reason === "string" ? e.reason : "";
    if (reason && reason !== "missing revert data") return reason;
    return null;
  }
}

/** Validate a payment against the on-chain order BEFORE broadcasting, so the wallet popup is
 *  never wasted on a call that will certainly revert. Returns an error message or null. */
export function orderPaymentError(
  order: OnChainOrder | null,
  payerAddress: string,
  amount: bigint,
  isNative: boolean,
): string | null {
  if (!order) return "Order not found on-chain — it may not be registered for this link yet.";
  if (!order.exists) return REVERT_MESSAGES.OrderNotFound;
  if (order.settled) return REVERT_MESSAGES.OrderAlreadySettled;
  if (order.expiry > 0n && BigInt(Math.floor(Date.now() / 1000)) > order.expiry) {
    return REVERT_MESSAGES.OrderExpired;
  }
  const orderIsNative = order.token.toLowerCase() === ZERO_ADDRESS.toLowerCase();
  if (isNative !== orderIsNative) return REVERT_MESSAGES.WrongPaymentPath;
  if (order.amount !== amount) return REVERT_MESSAGES.IncorrectNativeValue;
  if (
    order.expectedPayer !== ZERO_ADDRESS &&
    order.expectedPayer.toLowerCase() !== payerAddress.toLowerCase()
  ) {
    return REVERT_MESSAGES.WrongPayer;
  }
  return null;
}

/** Comma-separated fallback list, e.g. "http://localhost:8080,https://tripplepay.onrender.com".
 *  Each request tries the backends in order and uses the first that is reachable. */
export const BACKEND_URLS = BACKEND_URL.split(",")
  .map((u) => u.trim())
  .filter(Boolean);

/** HTTP statuses that mean the host is up but failing — try the next backend URL. */
const FAILOVER_STATUSES = new Set([502, 503, 504]);

/** Whether a fetch failure is a transient network problem (not an HTTP status or an abort).
 *  Browsers throw these on flaky mobile links (e.g. `net::ERR_NETWORK_CHANGED`). */
function isTransientNetworkError(err: unknown): boolean {
  if (err instanceof DOMException && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return false;
  }
  return (
    err instanceof TypeError ||
    (typeof err === "object" && err !== null && (err as { message?: unknown }).message === "Failed to fetch")
  );
}

/**
 * Fetch against the backend. In a browser context all calls are routed through
 * the Next.js `/api/v1` server-side proxy so they are same-origin — this avoids
 * CORS preflight failures when the frontend runs on localhost:3000 while the
 * backend is on a different origin (e.g. onrender.com). In server-side contexts
 * (Next.js route handlers / server actions) the direct backend URL is used.
 *
 * Transient network errors get one quiet retry; other HTTP errors are returned
 * as-is without retrying.
 *
 * NOTE: this module is imported by client components, so no secret may ever live here.
 */
export async function backendFetch(path: string, init?: RequestInit): Promise<Response> {
  // In the browser, proxy through Next.js to avoid cross-origin CORS failures.
  // `path` always starts with "/v1/..." so strip that prefix for the proxy URL.
  const isBrowser = typeof window !== "undefined";
  if (isBrowser) {
    // /api/v1/<rest> → proxied server-side to the real backend with no CORS issue
    const proxyPath = path.startsWith("/v1/")
      ? `/api${path}`
      : `/api/v1${path.startsWith("/") ? path : `/${path}`}`;
    try {
      return await fetch(proxyPath, { credentials: "include", ...init });
    } catch (err) {
      throw err instanceof Error ? err : new Error("backend unreachable");
    }
  }

  // Server-side: hit the real backend URL directly (no CORS restriction).
  let lastError: unknown;
  let lastResponse: Response | undefined;
  const attempts = 2;
  for (let attempt = 0; attempt < attempts; attempt++) {
    for (const base of BACKEND_URLS) {
      try {
        const res = await fetch(`${base}${path}`, { credentials: "include", ...init });
        if (FAILOVER_STATUSES.has(res.status)) {
          lastResponse = res;
          continue;
        }
        return res;
      } catch (err) {
        lastError = err;
      }
    }
    // One quiet retry only for transient network blips — not for HTTP errors or aborts.
    if (!isTransientNetworkError(lastError)) break;
    await new Promise((r) => setTimeout(r, 600));
  }
  if (lastResponse) return lastResponse;
  throw lastError instanceof Error ? lastError : new Error("backend unreachable");
}

/**
 * Build a BrowserProvider with an **explicit** network so quais never tries to
 * auto-detect the network from eth_chainId. Injected Quai wallets report their chain
 * id in ways that quais alpha.56 can't always resolve, which surfaces as the cryptic
 * "unsupported addressable value" error during getSigner(). Passing "any" short-circuits
 * that detection path entirely — safe because every wallet here is already verified to be
 * on Quai mainnet via ensureQuaiNetwork() before signing, and we re-check separately.
 */
function makeBrowserProvider(eip1193: Eip1193Provider): BrowserProvider {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new BrowserProvider(eip1193 as any, "any");
}

// ── Blip app-wallet payment path ─────────────────────────────────────────────
// Inside Blip's browser the connected account is a per-origin APP WALLET (not the user's
// main vault) and it is often empty. Two adjustments make payments work there:
//
// 1. FUNDING — before sending value, read the app wallet's balance (documented
//    `quai_getBalance`) and, when short, ask Blip to top it up from the main vault via
//    `blip_requestAppWalletFunding`. Native top-ups within the user's per-app limit are
//    silent; larger ones show Blip's approval sheet.
//
// 2. RAW SENDS — quais's signer.sendTransaction() first hits `quai_blockNumber`,
//    `quai_getTransactionCount` and `quai_estimateGas` on the INJECTED provider; those
//    methods are not part of Blip's documented bridge surface and can fail before the
//    approval popup ever appears. So inside Blip we skip the quais signer entirely and
//    POST `{from, to, value, data}` straight through the documented `quai_sendTransaction`
//    (exactly what Blip's own quickstart does) — Blip fills gas/nonce internally.

/** Extra native QUAI requested on top of the order amount so gas can't kill the send. */
const BLIP_GAS_CUSHION_WEI = parseQuai("0.1");

/**
 * Canonical hex quantity for bridge-bound tx fields. quais's forked toBeHex() pads odd-length
 * values to full bytes ("0x0de0b6b3a7640000" for 1 QUAI) — and go-quai rejects exactly that
 * with -32602 "hex number with leading zero digits", killing the payment inside Blip before
 * the approval sheet. Minimal hex ("0xde0b6b3a7640000") is what the node requires.
 */
function hexQty(n: bigint): string {
  return n === 0n ? "0x0" : `0x${n.toString(16)}`;
}

/** Thrown when the app wallet still can't cover a payment — the UI offers a fund-and-retry. */
export class BlipNeedsFundsError extends Error {
  readonly needsFunding = true;
  constructor(message: string) {
    super(message);
    this.name = "BlipNeedsFundsError";
  }
}

/** App-wallet balance read from OUR OWN RPC — chain truth, independent of Blip's bridge
 *  accounting (a stale/wrong bridge read used to make us skip top-ups entirely). */
async function rpcNativeBalance(address: string): Promise<bigint | null> {
  try {
    return await new JsonRpcProvider(QUAI_MAINNET_CHAIN.rpcUrls[0]).getBalance(address);
  } catch {
    return null;
  }
}

/** Best-available balance: chain RPC first, wallet bridge as fallback. */
async function appWalletBalance(
  provider: Eip1193Provider,
  address: string,
): Promise<bigint | null> {
  return (await rpcNativeBalance(address)) ?? (await getWalletQuaiBalance(provider, address));
}

/** The origin's connected app-wallet address via silent `quai_accounts` (no prompt). */
async function blipConnectedAddress(provider: Eip1193Provider): Promise<string> {
  const accounts = (await provider.request({ method: "quai_accounts" })) as string[];
  if (!accounts?.length) {
    throw new Error("Connect your Blip wallet first, then try again.");
  }
  return accounts[0];
}

/**
 * Makes sure the app wallet can cover `requiredWei` (+ gas cushion) before we send.
 *
 * The old version trusted the wallet bridge for the balance and skipped top-up whenever that
 * read failed (null → skip) — which let payments reach Blip's own send-time gate and die with
 * its native "insufficient funds to complete" sheet. Now:
 *   1. balance comes from our own RPC (bridge only as fallback);
 *   2. an UNKNOWN balance triggers a top-up attempt instead of skipping it;
 *   3. after a funding request we poll the chain until the internal main→app transfer lands,
 *      because `blip_requestAppWalletFunding` can resolve while the transfer is still in-flight.
 */
async function ensureBlipNativeFunding(
  provider: Eip1193Provider,
  address: string,
  requiredWei: bigint,
): Promise<void> {
  const needed = requiredWei + BLIP_GAS_CUSHION_WEI;
  const balance = await appWalletBalance(provider, address);
  if (balance != null && balance >= needed) return;

  const shortfall = balance != null ? needed - balance : needed;
  let requested = false;
  try {
    await requestAppWalletFunding(provider, {
      chainId: QUAI_MAINNET_CHAIN.chainId,
      reason: "payment",
      continueLabel: "Continue payment",
      assets: [
        {
          type: "native",
          symbol: "QUAI",
          decimals: 18,
          amountWei: hexQty(shortfall),
          purpose: "payment",
        },
      ],
    });
    requested = true;
  } catch (err) {
    if ((err as { code?: number })?.code === 4001) {
      throw new Error("Top-up declined — fund this site's app wallet in Blip, then retry.");
    }
    // Funding unavailable/failed (older builds, feature off): verify below before sending.
  }

  if (!requested) {
    const fresh = await appWalletBalance(provider, address);
    if (fresh == null || fresh < requiredWei) {
      throw new BlipNeedsFundsError(
        "Blip couldn't top up this site's app wallet automatically. Fund it from your main vault in Blip, then retry.",
      );
    }
    return;
  }

  // Funding transfer may still be in-flight — poll until it confirms (or give up clearly).
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2_000));
    const fresh = await appWalletBalance(provider, address);
    if (fresh != null && fresh >= requiredWei) return;
  }
  throw new BlipNeedsFundsError(
    "The top-up hasn't landed yet — this site's app wallet is still short of QUAI. Wait a moment or fund it manually in Blip, then retry.",
  );
}

/** Explicit user-invoked top-up (Fund & retry button). No-ops outside Blip. */
export async function requestBlipAppWalletTopUp(requiredWei: bigint): Promise<void> {
  const wallet = getActiveWallet();
  if (!wallet || wallet.brand !== "blip") return;
  const address = await blipConnectedAddress(wallet.provider);
  await ensureBlipNativeFunding(wallet.provider, address, requiredWei);
}

/**
 * Gas estimate + nonce resolved through OUR OWN RPC. Blip's browser fills these itself when
 * missing — and its internal prep path is broken: it forwards a non-canonical (leading-zero-
 * padded) `value` to `quai_createAccessList`, which go-quai rejects with -32602 before any
 * approval sheet appears. Supplying explicit gas/nonce lets Blip skip straight to signing.
 */
async function estimateGasViaRpc(tx: {
  from?: string;
  to: string;
  value?: string;
  data?: string;
}): Promise<string | null> {
  try {
    const provider = getRpcProvider();
    const args = [{ from: tx.from, to: tx.to, value: tx.value, data: tx.data }];
    for (const method of ["quai_estimateGas", "eth_estimateGas"]) {
      try {
        const hex = (await provider.send(method, args)) as string;
        if (typeof hex === "string" && hex.startsWith("0x")) return hex;
      } catch {
        /* try next method */
      }
    }
  } catch {
    /* RPC unavailable */
  }
  return null;
}

async function nextNonceViaRpc(from: string): Promise<string | null> {
  try {
    const provider = getRpcProvider();
    for (const method of ["quai_getTransactionCount", "eth_getTransactionCount"]) {
      try {
        const hex = (await provider.send(method, [from, "pending"])) as string;
        if (typeof hex === "string" && hex.startsWith("0x")) return hex;
      } catch {
        /* try next method */
      }
    }
  } catch {
    /* RPC unavailable */
  }
  return null;
}

/** Sends a tx through the bridge and maps the common rejection codes to friendly copy.
 *  Always attaches explicit gas/nonce (see estimateGasViaRpc) so Blip signs directly. */
async function blipSend(
  provider: Eip1193Provider,
  tx: { from: string; to: string; value?: string; data?: string },
): Promise<string> {
  const gas = (await estimateGasViaRpc(tx)) ?? hexQty(BigInt(tx.data ? 300_000 : 21_000));
  const nonce = await nextNonceViaRpc(tx.from);
  try {
    const hash = (await provider.request({
      method: "quai_sendTransaction",
      params: [{ ...tx, gas, ...(nonce ? { nonce } : {}) }],
    })) as string;
    if (typeof hash !== "string" || !hash.startsWith("0x")) {
      throw new Error("Blip returned no transaction hash.");
    }
    return hash;
  } catch (err) {
    const code = (err as { code?: number })?.code;
    const rawMessage = String((err as { message?: unknown })?.message ?? "");
    const message = err instanceof Error ? err.message : rawMessage;
    if (code === 4001) throw new Error("Payment declined in Blip.");
    if (/insufficient/i.test(message) || code === -32010) {
      // Blip's own send-time balance gate — give the UI something actionable.
      throw new BlipNeedsFundsError(
        "Blip couldn't complete the payment — this site's app wallet doesn't have enough QUAI. Fund it and retry.",
      );
    }
    if (/createAccessList|leading zero|-32602/i.test(message)) {
      throw new Error(
        "The wallet rejected this payment while preparing it (node refused the transaction arguments). Please try again — if it keeps failing, update the Blip app.",
      );
    }
    if (err instanceof Error) throw err;
    // Bridges sometimes reject with plain objects — don't lose their payload.
    throw new Error(
      rawMessage ||
        `Blip rejected the transaction (${safeStringify(err).slice(0, 200)})`,
    );
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

async function getSigner(): Promise<Signer> {
  const wallet = getActiveWallet();
  if (!wallet) {
    throw new Error("No wallet connected — connect a wallet first.");
  }
  return makeBrowserProvider(wallet.provider).getSigner();
}

/** Puts the connected wallet on Quai mainnet (chain 9) and returns a signer.
 *  Without this, a wallet on its default chain broadcasts into a mempool the app never sees,
 *  and the registration would hang forever waiting for a receipt. */
async function getSignerOnNetwork(): Promise<Signer> {
  const wallet = getActiveWallet();
  if (!wallet) {
    throw new Error("No wallet connected — connect a wallet first.");
  }
  const chain = QUAI_MAINNET_CHAIN;
  // Only Pelagus skips network checks (its EIP-3326 requests hang). Blip goes through the
  // full verify → switch → add path — its documented provider supports both methods.
  const quaiNative = wallet.brand === "pelagus";
  const net = await ensureQuaiNetwork(wallet.provider, chain, { quaiNative });
  if (net === "unsupported") {
    throw new Error(
      `${wallet.name} couldn't switch to ${chain.chainName} (chain ${parseInt(chain.chainId, 16)}) — ` +
        `switch networks in your wallet and retry.`,
    );
  }
  return makeBrowserProvider(wallet.provider).getSigner();
}

/**
 * Wait for a transaction receipt by polling BOTH the app's canonical RPC and the wallet's own
 * provider. The wallet broadcasts through ITS node, which may be a different gateway than the
 * app's RPC (Pelagus routes to its configured node) — a tx can live in the wallet's mempool
 * while the app's public gateway has never heard of it. So the wallet's provider is polled too:
 * it is the only node guaranteed to have seen the broadcast.
 *
 * (We bypass `provider.waitForTransaction` entirely because `quais` alpha.56 has a bug where
 * parsing blocks with cross-shard txs throws "Invalid shard", which randomly crashes the
 * built-in block-polling waiter on any Quai network.)
 *
 * Each poll is raced against a hard timeout (`withTimeout`). `quais` alpha.56 has no per-request
 * timeout and its provider init can wedge forever (see getRpcProvider), so a single stuck RPC
 * round-trip must never be able to stall this loop past the deadline.
 */
async function waitForTxReceipt(hash: string, timeoutMs = 180_000): Promise<string> {
  const provider = getRpcProvider();
  // The wallet's provider — the node the tx was actually broadcast to. Built once, reused.
  let walletProvider: BrowserProvider | null = null;
  const wallet = getActiveWallet();
  if (wallet) {
    walletProvider = makeBrowserProvider(wallet.provider);
  }
  const interval = 4_000;
  // An individual RPC call gets 10s — plenty for a healthy node, short enough that a hung
  // connection (DNS/TLS/init wedge) advances the loop instead of freezing the UI forever.
  const pollTimeoutMs = 10_000;

  return new Promise<string>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    const tick = async () => {
      if (Date.now() > deadline) {
        reject(
          new Error(
            `Your transaction was submitted (${hash}) but hasn't confirmed yet. ` +
              `It may still be processing — check the explorer or your wallet before retrying.`,
          )
        );
        return;
      }

      // Query the app RPC and the wallet's node in parallel; a flaky or divergent node must
      // never gate the other.
      const [appReceipt, walletReceipt] = await Promise.allSettled([
        withTimeout(provider.getTransactionReceipt(hash), pollTimeoutMs),
        walletProvider
          ? withTimeout(walletProvider.getTransactionReceipt(hash), pollTimeoutMs)
          : Promise.resolve(null),
      ]);

      for (const settled of [appReceipt, walletReceipt]) {
        if (settled.status !== "fulfilled" || !settled.value) continue;
        const receipt = settled.value;
        if (receipt.blockNumber != null) {
          if (receipt.status === 0) {
            reject(new Error("Transaction failed/reverted on-chain."));
            return;
          }
          resolve(receipt.hash ?? hash);
          return;
        }
      }

      if (appReceipt.status === "rejected") {
        // RPC hiccup or poll timeout — log and keep polling until the deadline
        console.warn("Polling receipt failed (will retry):", appReceipt.reason);
      }
      if (walletReceipt.status === "rejected") {
        // The wallet's bridge can reject lookups while the tx is still pending — keep polling
        console.warn("Wallet receipt poll failed (will retry):", walletReceipt.reason);
      }
      setTimeout(() => void tick(), interval);
    };

    void tick();
  });
}

/** Race a possibly-never-settling promise against a timeout so a wedged RPC call (the `quais`
 *  alpha.56 init bug, a hanging connection, etc.) can't stall the receipt poll forever. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`RPC call timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function getContract(signer?: Signer): Contract {
  return new Contract(
    resolvePayAddress(),
    paywithquaiAbi,
    signer,
  );
}

/** Orders are keyed by msg.sender on-chain — the connected wallet must match `merchant`. */
async function assertMerchantSigner(signer: Signer, merchant: string): Promise<void> {
  const connected = (await signer.getAddress()).toLowerCase();
  if (connected !== merchant.toLowerCase()) {
    throw new Error(
      `Connected wallet (${connected}) does not match the merchant address (${merchant}).`,
    );
  }
}

/** Merchant registers an order on-chain. Returns the tx receipt. */
export async function registerOrder(
  merchant: string,
  orderId: string,
  token: string,
  amount: bigint,
  expiry = 0n,
): Promise<string> {
  const signer = await getSignerOnNetwork();
  await assertMerchantSigner(signer, merchant);
  const tx = await getContract(signer).registerOrder(orderId, token, amount, expiry);
  return waitForTxReceipt(tx.hash);
}

export async function registerOrderBatch(
  merchant: string,
  orderIds: string[],
  token: string,
  amount: bigint,
  expiry = 0n,
): Promise<string> {
  const signer = await getSignerOnNetwork();
  await assertMerchantSigner(signer, merchant);
  const tx = await getContract(signer).registerOrderBatch(orderIds, token, amount, expiry);
  return waitForTxReceipt(tx.hash);
}

/** Merchant registers an order that only `expectedPayer` may settle (anti-front-running for
 *  prepaid/invoice flows). Zero address = anyone may pay (same as registerOrder). */
export async function registerOrderWithPayer(
  merchant: string,
  orderId: string,
  token: string,
  amount: bigint,
  expiry: bigint,
  expectedPayer: string,
): Promise<string> {
  const signer = await getSignerOnNetwork();
  await assertMerchantSigner(signer, merchant);
  const tx = await getContract(signer).registerOrderWithPayer(
    orderId,
    token,
    amount,
    expiry,
    expectedPayer,
  );
  return waitForTxReceipt(tx.hash);
}

/** Customer settles an ERC-20 order (approve + payOrder). Returns the tx receipt. */
export async function payOrder(
  merchant: string,
  orderId: string,
  token: string,
  amount: bigint,
): Promise<string> {
  const wallet = getActiveWallet();
  if (!wallet) {
    throw new Error("No wallet connected — connect a wallet first.");
  }
  if (wallet.brand === "blip") {
    return payOrderViaBlip(wallet.provider, merchant, orderId, token, amount);
  }

  // Pelagus / extension path — unchanged.
  const signer = await getSigner();
  const payAddress = resolvePayAddress();
  const contract = getContract(signer);
  try {
    const approveTx = await new Contract(token, [
      "function approve(address spender, uint256 amount) returns (bool)",
    ], signer).approve(payAddress, amount);
    await waitForTxReceipt(approveTx.hash);
    const tx = await contract.payOrder(merchant, orderId);
    return waitForTxReceipt(tx.hash);
  } catch (err) {
    const reason = await getRevertReason(merchant, orderId, {
      token,
      value: amount,
      from: await signer.getAddress(),
    }).catch(() => null);
    if (reason) throw new Error(reason);
    throw err;
  }
}

/**
 * Token payment inside the Blip browser: raw `quai_sendTransaction` for BOTH the approve
 * and the settle call (see the Blip block above for why), with an app-wallet funding
 * request when either the token balance or the gas cushion is short.
 */
async function payOrderViaBlip(
  provider: Eip1193Provider,
  merchant: string,
  orderId: string,
  token: string,
  amount: bigint,
): Promise<string> {
  const payAddress = resolvePayAddress();
  // Cheap guard: single instant quai_chainId read when already on mainnet.
  const net = await ensureQuaiNetwork(provider, QUAI_MAINNET_CHAIN);
  if (net === "unsupported") {
    throw new Error("Blip couldn't switch to Quai mainnet (chain 9) — switch networks and retry.");
  }
  const from = await blipConnectedAddress(provider);

  // Check the token balance via OUR OWN RPC (no bridge involvement) so a hopeless
  // payment fails before any popup. If short, ask Blip to fund the token + gas.
  try {
    const erc20 = new Contract(
      token,
      ["function balanceOf(address) view returns (uint256)"],
      getRpcProvider(),
    );
    const bal = (await erc20.balanceOf(from)) as bigint;
    if (bal < amount) {
      await requestAppWalletFunding(provider, {
        chainId: QUAI_MAINNET_CHAIN.chainId,
        reason: "payment",
        continueLabel: "Continue payment",
        assets: [
          {
            type: "erc20",
            token,
            decimals: 6,
            amount: hexQty(amount - bal),
            purpose: "payment",
          },
          {
            type: "native",
            symbol: "QUAI",
            decimals: 18,
            amountWei: hexQty(BLIP_GAS_CUSHION_WEI),
            purpose: "gas",
          },
        ],
      });
    }
  } catch (err) {
    if (err instanceof Error && err.name === "BlipFundingError") {
      // Token top-up failed — without those tokens the payOrder call can only revert.
      const code = (err as { code?: number }).code;
      throw new BlipNeedsFundsError(
        code === 4001
          ? "Top-up declined — this site's app wallet needs more tokens to pay. Fund it in Blip and retry."
          : "Couldn't top up this site's app wallet with tokens. Make sure your main vault holds enough, then retry.",
      );
    }
    // Balance check itself failed (RPC hiccup) — proceed; the send surfaces real errors.
  }

  await ensureBlipNativeFunding(provider, from, 0n); // keep gas covered even if tokens were fine

  const approveInterface = new Interface([
    "function approve(address spender, uint256 amount) returns (bool)",
  ]);
  const approveHash = await blipSend(provider, {
    from,
    to: token,
    data: approveInterface.encodeFunctionData("approve", [payAddress, amount]),
  });
  await waitForTxReceipt(approveHash);

  return blipSend(provider, {
    from,
    to: payAddress,
    data: payInterface.encodeFunctionData("payOrder", [merchant, orderId]),
  });
}

/** Customer settles a native QUAI order. Returns the tx receipt. */
export async function payOrderNative(
  merchant: string,
  orderId: string,
  amount: bigint | string,
): Promise<string> {
  const wallet = getActiveWallet();
  if (!wallet) {
    throw new Error("No wallet connected — connect a wallet first.");
  }
  const value = typeof amount === "bigint" ? amount : parseQuai(amount);
  if (wallet.brand === "blip") {
    return payOrderNativeViaBlip(wallet.provider, merchant, orderId, value);
  }

  // Pelagus / extension path — unchanged.
  const signer = await getSigner();
  try {
    const tx = await getContract(signer).payOrderNative(merchant, orderId, {
      value,
    });
    return waitForTxReceipt(tx.hash);
  } catch (err) {
    const reason = await getRevertReason(merchant, orderId, {
      value,
      from: await signer.getAddress(),
    }).catch(() => null);
    if (reason) throw new Error(reason);
    throw err;
  }
}

/**
 * Native payment inside the Blip browser: top up the per-origin app wallet when it can't
 * cover the amount (+ gas cushion), then send through the documented bridge method.
 */
async function payOrderNativeViaBlip(
  provider: Eip1193Provider,
  merchant: string,
  orderId: string,
  value: bigint,
): Promise<string> {
  // Cheap guard: when already on mainnet this is a single instant quai_chainId read;
  // otherwise Blip is asked to switch/add (documented supported) before we send value.
  const net = await ensureQuaiNetwork(provider, QUAI_MAINNET_CHAIN);
  if (net === "unsupported") {
    throw new Error("Blip couldn't switch to Quai mainnet (chain 9) — switch networks and retry.");
  }
  const from = await blipConnectedAddress(provider);
  await ensureBlipNativeFunding(provider, from, value);

  return blipSend(provider, {
    from,
    to: resolvePayAddress(),
    value: hexQty(value),
    data: payInterface.encodeFunctionData("payOrderNative", [merchant, orderId]),
  });
}

/** Cryptographically random order id — Math.random()/timestamps are predictable, and the id is
 *  bound to a real on-chain order (a guessed id is also a DoS vector on the order-lookup API). */
export function newOrderId(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return id(`ord_web_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`);
}

export interface OrderStatus {
  merchant: string;
  orderId: string;
  token: string;
  amount: string;
  feeBps: number;
  expiry: string;
  settled: boolean;
  webhook: { status: string; attempts: number } | null;
}

/** Settlement status from the relayer backend (final source of truth). */
export async function fetchOrderStatus(
  merchant: string,
  orderId: string,
  timeoutMs = 10_000,
): Promise<OrderStatus | null> {
  const res = await backendFetch(
    `/v1/orders/${merchant}/${orderId}`,
    { signal: AbortSignal.timeout(timeoutMs) },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`backend error ${res.status}`);
  return (await res.json()) as OrderStatus;
}

/** On-chain fallback when the backend is unreachable. */
export async function isSettledOnChain(
  merchant: string,
  orderId: string,
): Promise<boolean> {
  const contract = new Contract(
    resolvePayAddress(),
    paywithquaiAbi,
    getRpcProvider(),
  );
  return (await contract.isSettled(merchant, orderId)) as boolean;
}

export interface OnChainOrder {
  merchant: string;
  settled: boolean;
  exists: boolean;
  feeBps: number;
  token: string;
  amount: bigint;
  expiry: bigint;
  feeRecipient: string;
  settledAt: bigint;
  expectedPayer: string;
  nonce: bigint;
}

/** Raw order read from the contract (authoritative display + expectedPayer). */
export async function getOrderOnChain(
  merchant: string,
  orderId: string,
): Promise<OnChainOrder | null> {
  const contract = new Contract(
    resolvePayAddress(),
    paywithquaiAbi,
    getRpcProvider(),
  );
  const o = (await contract.getOrder(merchant, orderId)) as Record<string, unknown>;
  return {
    merchant,
    settled: Boolean(o.settled),
    exists: Boolean(o.exists),
    feeBps: Number(o.feeBps as bigint),
    token: o.token as string,
    amount: o.amount as bigint,
    expiry: o.expiry as bigint,
    feeRecipient: o.feeRecipient as string,
    settledAt: o.settledAt as bigint,
    expectedPayer: o.expectedPayer as string,
    nonce: o.nonce as bigint,
  };
}

export interface ConfirmationResult {
  backend: boolean;
  settledOnChain: boolean;
  webhookDelivered: boolean;
}

/** Poll until the relayer confirms the webhook. On-chain settlement alone is not treated as
 *  complete — merchants should fulfill on the signed webhook, not just a chain read. */
export async function waitForConfirmation(
  merchant: string,
  orderId: string,
  onProgress?: (webhookStatus: string | null) => void,
  maxSeconds = 120,
): Promise<ConfirmationResult> {
  const deadline = Date.now() + maxSeconds * 1000;
  let backendOk = false;
  let settledOnChain = false;
  while (Date.now() < deadline) {
    // Check backend and chain in parallel — a slow backend must never gate the chain read.
    const [order, settledChain] = await Promise.all([
      fetchOrderStatus(merchant, orderId, 4_000).catch(() => null),
      settledOnChain
        ? Promise.resolve(true)
        : isSettledOnChain(merchant, orderId).catch(() => false),
    ]);
    if (order) {
      onProgress?.(order.webhook?.status ?? null);
      if (order.settled && order.webhook?.status === "delivered") {
        return { backend: true, settledOnChain: true, webhookDelivered: true };
      }
      backendOk = true;
      if (order.settled) settledOnChain = true;
    }
    if (settledChain) settledOnChain = true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!settledOnChain) {
    settledOnChain = await isSettledOnChain(merchant, orderId).catch(() => false);
  }
  return { backend: backendOk, settledOnChain, webhookDelivered: false };
}

export { formatQuai, parseQuai };

export interface LinkInfo {
  slug: string;
  merchantAddress: string;
  merchantId: string;
  merchantName: string;
  shopName: string;
  tokenAddress: string;
  amount: string;
  amountDisplay: string;
  symbol: string;
  expiryDurationSecs: number;
  multiPay: boolean;
  poolSize: number;
  createdAt: number;
}

/** Fetch a short link's metadata (publicly accessible — no auth needed). */
export async function fetchLink(slug: string): Promise<LinkInfo | null> {
  const res = await backendFetch(`/v1/links/${slug}`, { signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`backend error ${res.status}`);
  return (await res.json()) as LinkInfo;
}

/**
 * Validate a payment link's currency BEFORE any wallet popup or order claim. Native QUAI links
 * pass instantly; token links must carry a well-formed address AND be accepted by the contract.
 * Without this, a misconfigured link crashes deep inside ethers with a cryptic
 * "unsupported addressable value" after the customer has already connected their wallet.
 * Returns an error message for the customer, or null when the link is payable.
 */
export async function linkPaymentProblem(link: LinkInfo): Promise<string | null> {
  const token = (link.tokenAddress ?? "").trim();
  if (token.toLowerCase() === ZERO_ADDRESS.toLowerCase()) return null;
  let addr: string;
  try {
    addr = getAddress(token);
  } catch {
    return "This payment link's currency is misconfigured — please ask the merchant to recreate the link.";
  }
  try {
    const contract = new Contract(resolvePayAddress(), paywithquaiAbi, getRpcProvider());
    const accepted = (await contract.isTokenAccepted(addr)) as boolean;
    if (!accepted) {
      return "This link pays in a token that isn't accepted by the payment contract yet — please ask the merchant to update it.";
    }
  } catch {
    // RPC hiccup — don't block the payment on a failed read; payOrder surfaces real errors.
  }
  return null;
}

export interface ClaimResult {
  orderId: string;
  merchant: string;
  token: string;
  amount: string;
  poolRemaining: number;
  /** Set when the server returned 429 — the retryAfterSecs until they can claim again. */
  retryAfterSecs?: number;
}

/**
 * Claim an orderId from a short link's pool.
 * - On success: returns the claimed orderId.
 * - On 429 (same wallet within 5 mins): returns the existing orderId from the response so the
 *   customer can still complete payment on their already-claimed order.
 * - On 503 (pool exhausted): throws with a user-friendly message.
 */
export async function claimOrderFromLink(slug: string, payerAddress: string): Promise<ClaimResult> {
  const res = await backendFetch(`/v1/links/${slug}/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payerAddress }),
    signal: AbortSignal.timeout(15_000),
  });
  // Body may not be JSON when an intermediary answers (sleeping free-tier backend, proxy
  // failover) — never let res.json() throw a raw SyntaxError at the customer.
  const text = await res.text().catch(() => "");
  let body: (ClaimResult & { error?: string; retryAfterSecs?: number }) | null = null;
  try {
    body = JSON.parse(text) as ClaimResult & { error?: string; retryAfterSecs?: number };
  } catch {
    body = null;
  }
  if (res.status === 503) {
    throw new Error('Payment link is fully booked — the merchant needs to add more order slots. Please try again later.');
  }
  if (res.status === 404 || res.status === 502 || res.status === 504 || !body) {
    throw new Error('The payment service is waking up — please tap Pay again in a few seconds.');
  }
  if (res.status === 429) {
    // Return the already-claimed orderId so they can continue their payment
    if (!body.orderId) throw new Error('You already used this link recently. Please wait a few minutes before trying again.');
    return { ...body, retryAfterSecs: body.retryAfterSecs };
  }
  if (!res.ok) throw new Error(body.error ?? `backend error ${res.status}`);
  return body;
}

/** Create a short link in the backend (requires merchant session cookie). */
export async function createPaymentLink(payload: {
  shopName?: string;
  tokenAddress: string;
  amount: string;
  amountDisplay: string;
  symbol: string;
  expiryDurationSecs: number;
  multiPay: boolean;
  orderPool: string[];
}): Promise<LinkInfo> {
  const res = await backendFetch('/v1/links', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `backend error ${res.status}`);
  }
  return (await res.json()) as LinkInfo;
}

/** Fetch all links for the currently-authenticated merchant. */
export async function fetchMyLinks(): Promise<LinkInfo[]> {
  const res = await backendFetch('/v1/links', { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`backend error ${res.status}`);
  const body = (await res.json()) as { links: LinkInfo[] };
  return body.links;
}

/**
 * Poll until the order is confirmed ON-CHAIN only — does NOT wait for the webhook.
 * Shows the success screen immediately after the tx settles.
 */
export async function waitForOnChainConfirmation(
  merchant: string,
  orderId: string,
  onProgress?: (status: string) => void,
  maxSeconds = 90,
): Promise<boolean> {
  const deadline = Date.now() + maxSeconds * 1000;
  onProgress?.('Waiting for block confirmation…');
  while (Date.now() < deadline) {
    // Chain + backend in parallel; backend gets a short timeout so a slow or sleeping relayer
    // never delays the fast on-chain confirmation.
    const [settledChain, order] = await Promise.all([
      isSettledOnChain(merchant, orderId).catch(() => false),
      fetchOrderStatus(merchant, orderId, 4_000).catch(() => null),
    ]);
    if (settledChain || order?.settled) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}