/**
 * ethers v6 mirror of payment.ts's on-chain operations, for standard EVM chains (Robinhood Chain
 * testnet, Base Sepolia, ...). Quai keeps using payment.ts's quais-based path unchanged — see
 * that file's dispatch layer, which picks this module when a chain's `kind` is "evm".
 *
 * Deliberately NOT a generalization of payment.ts: every workaround in that file (hex-padding,
 * the dual-provider receipt poll, Blip's raw-send path, ...) exists for `quais` alpha bugs or
 * Blip's bridge quirks that don't apply here. ethers v6 talking to a standard EVM node needs
 * none of that, so this file is a much smaller, ordinary ethers.js implementation.
 *
 * Every exported function takes a ChainInfo (frontend/src/lib/chains.ts) as its first argument —
 * this module has no notion of a "current" chain the way payment.ts implicitly means Quai.
 */
import { BrowserProvider, Contract, Interface, JsonRpcProvider, type Signer } from "ethers";
import paywithquaiAbi from "./paywithquai.abi.json";
import { ensureNetwork, getActiveWallet } from "./wallets";
import type { ChainInfo } from "./chains";
import type { OnChainOrder } from "./payment";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const payInterface = new Interface(paywithquaiAbi);

/** Friendly copy for the custom errors the PayWithQuai contract can throw — kept in sync with
 *  (but duplicated from) payment.ts's own REVERT_MESSAGES. Not imported from payment.ts: that
 *  file dispatches INTO this module, so importing a value back would create a circular import
 *  between the two chain-specific modules. */
const REVERT_MESSAGES: Record<string, string> = {
  OrderNotFound: "The order was not found on-chain — it may not have been registered for this link yet.",
  OrderAlreadySettled: "This order was already paid.",
  OrderExpired: "This payment link has expired.",
  WrongPayer: "This order is reserved for a different wallet.",
  WrongPaymentPath: "Payment method doesn't match the order's currency.",
  IncorrectNativeValue: "The amount sent doesn't match the order amount.",
  NativeTransferFailed: "The network rejected the payout transfer — please try again.",
  TokenNotAccepted: "The token isn't accepted by the payment contract.",
  ZeroAmount: "The order amount must be greater than zero.",
  InvalidExpiry: "The order expiry is invalid.",
  OrderAlreadyExists: "This order was already registered.",
  EnforcedPause: "Payments are temporarily paused — try again in a moment.",
  ReentrancyGuardReentrantCall: "Transaction reentrancy blocked — please try again.",
};

const rpcProviders = new Map<number, JsonRpcProvider>();

function getRpcProvider(chain: ChainInfo): JsonRpcProvider {
  let provider = rpcProviders.get(chain.chainId);
  if (!provider) {
    provider = new JsonRpcProvider(chain.rpcUrl);
    rpcProviders.set(chain.chainId, provider);
  }
  return provider;
}

function getContract(chain: ChainInfo, signerOrProvider: Signer | JsonRpcProvider): Contract {
  return new Contract(chain.contractAddress, paywithquaiAbi, signerOrProvider);
}

async function getSigner(chain: ChainInfo): Promise<Signer> {
  const wallet = getActiveWallet();
  if (!wallet) {
    throw new Error("No wallet connected — connect a wallet first.");
  }
  // ensureNetwork refuses a wallet/chain pair that can't work (e.g. the active wallet being
  // Quai-only Blip/Pelagus while paying on an EVM chain) before any network request, and throws
  // a specific, named error otherwise.
  await ensureNetwork(wallet, chain);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new BrowserProvider(wallet.provider as any).getSigner();
}

/** Orders are keyed by msg.sender on-chain — the connected wallet must match `merchant`. */
async function assertMerchantSigner(signer: Signer, merchant: string): Promise<void> {
  const connected = (await signer.getAddress()).toLowerCase();
  if (connected !== merchant.toLowerCase()) {
    throw new Error(`Connected wallet (${connected}) does not match the merchant address (${merchant}).`);
  }
}

/** Plain ethers.js confirmation wait — no dual-provider polling or manual timeout race is
 *  needed here (those exist in payment.ts specifically to route around `quais` alpha bugs and a
 *  cross-shard block-parsing crash that don't apply to a standard EVM node). */
async function waitForTxReceipt(chain: ChainInfo, hash: string, timeoutMs = 180_000): Promise<string> {
  const provider = getRpcProvider(chain);
  let receipt;
  try {
    receipt = await provider.waitForTransaction(hash, 1, timeoutMs);
  } catch {
    receipt = null;
  }
  if (!receipt) {
    throw new Error(
      `Your transaction was submitted (${hash}) but hasn't confirmed yet. It may still be ` +
        `processing — check the explorer or your wallet before retrying.`,
    );
  }
  if (receipt.status === 0) {
    throw new Error("Transaction failed/reverted on-chain.");
  }
  return receipt.hash;
}

/** Replay the failing payment call at the current block to decode the real revert reason. */
export async function getRevertReason(
  chain: ChainInfo,
  merchant: string,
  orderId: string,
  opts: { value?: bigint; token?: string; from: string },
): Promise<string | null> {
  try {
    const token = opts.token;
    const isNative = !token || token.toLowerCase() === ZERO_ADDRESS.toLowerCase();
    const method = isNative ? "payOrderNative" : "payOrder";
    const data = payInterface.encodeFunctionData(method, [merchant, orderId]);
    await getRpcProvider(chain).call({
      to: chain.contractAddress,
      from: opts.from,
      data,
      ...(isNative ? { value: opts.value ?? 0n } : {}),
    });
    return null; // the call would succeed now — the revert no longer reproduces
  } catch (err) {
    const e = err as Record<string, unknown>;
    const raw =
      e.data ??
      (e.error as { data?: unknown } | undefined)?.data ??
      (e.info as { error?: { data?: unknown } } | undefined)?.error?.data;
    if (typeof raw === "string" && raw.startsWith("0x")) {
      try {
        const decoded = payInterface.parseError(raw);
        const name = decoded?.name ?? "";
        if (name) return REVERT_MESSAGES[name] ?? `${name} (${raw.slice(0, 10)}…)`;
      } catch {
        // fall through to message extraction
      }
    }
    const reason = typeof e.reason === "string" ? e.reason : "";
    if (reason && reason !== "missing revert data") return reason;
    return null;
  }
}

async function registerOnChain(
  chain: ChainInfo,
  merchant: string,
  method: "registerOrder" | "registerOrderBatch" | "registerOrderWithPayer",
  args: unknown[],
): Promise<string> {
  const signer = await getSigner(chain);
  await assertMerchantSigner(signer, merchant);
  const contract = getContract(chain, signer);
  const tx = await contract[method](...(args as never[]));
  return waitForTxReceipt(chain, tx.hash);
}

/** Merchant registers an order on-chain. Returns the tx hash. */
export async function registerOrder(
  chain: ChainInfo,
  merchant: string,
  orderId: string,
  token: string,
  amount: bigint,
  expiry: bigint = 0n,
): Promise<string> {
  return registerOnChain(chain, merchant, "registerOrder", [orderId, token, amount, expiry]);
}

export async function registerOrderBatch(
  chain: ChainInfo,
  merchant: string,
  orderIds: string[],
  token: string,
  amount: bigint,
  expiry: bigint = 0n,
): Promise<string> {
  return registerOnChain(chain, merchant, "registerOrderBatch", [orderIds, token, amount, expiry]);
}

export async function registerOrderWithPayer(
  chain: ChainInfo,
  merchant: string,
  orderId: string,
  token: string,
  amount: bigint,
  expiry: bigint,
  expectedPayer: string,
): Promise<string> {
  return registerOnChain(chain, merchant, "registerOrderWithPayer", [orderId, token, amount, expiry, expectedPayer]);
}

/** Customer settles an ERC-20 order (approve + payOrder). Returns the tx hash. */
export async function payOrder(
  chain: ChainInfo,
  merchant: string,
  orderId: string,
  token: string,
  amount: bigint,
): Promise<string> {
  const signer = await getSigner(chain);
  const contract = getContract(chain, signer);
  try {
    const erc20 = new Contract(
      token,
      ["function approve(address spender, uint256 amount) returns (bool)"],
      signer,
    );
    const approveTx = await erc20.approve(chain.contractAddress, amount);
    await waitForTxReceipt(chain, approveTx.hash);
    const tx = await contract.payOrder(merchant, orderId);
    return waitForTxReceipt(chain, tx.hash);
  } catch (err) {
    const reason = await getRevertReason(chain, merchant, orderId, {
      token,
      value: amount,
      from: await signer.getAddress(),
    }).catch(() => null);
    if (reason) throw new Error(reason);
    throw err;
  }
}

/** Customer settles a native-currency order. Returns the tx hash. */
export async function payOrderNative(
  chain: ChainInfo,
  merchant: string,
  orderId: string,
  amount: bigint,
): Promise<string> {
  const signer = await getSigner(chain);
  const contract = getContract(chain, signer);
  try {
    const tx = await contract.payOrderNative(merchant, orderId, { value: amount });
    return waitForTxReceipt(chain, tx.hash);
  } catch (err) {
    const reason = await getRevertReason(chain, merchant, orderId, {
      value: amount,
      from: await signer.getAddress(),
    }).catch(() => null);
    if (reason) throw new Error(reason);
    throw err;
  }
}

/** Raw order read from the contract — same shape as payment.ts's OnChainOrder. */
export async function getOrderOnChain(chain: ChainInfo, merchant: string, orderId: string): Promise<OnChainOrder> {
  const contract = getContract(chain, getRpcProvider(chain));
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

/** On-chain fallback when the backend is unreachable. */
export async function isSettledOnChain(chain: ChainInfo, merchant: string, orderId: string): Promise<boolean> {
  const contract = getContract(chain, getRpcProvider(chain));
  return (await contract.isSettled(merchant, orderId)) as boolean;
}

/** Whether the contract's ERC-20 allowlist accepts this token — used to validate a link's
 *  currency before any wallet popup (see payment.ts's linkPaymentProblem). */
export async function isTokenAccepted(chain: ChainInfo, token: string): Promise<boolean> {
  const contract = getContract(chain, getRpcProvider(chain));
  return (await contract.isTokenAccepted(token)) as boolean;
}
