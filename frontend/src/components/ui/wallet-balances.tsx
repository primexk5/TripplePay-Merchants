"use client";

import { useCallback, useEffect, useState } from "react";
import { BrowserProvider, Contract, parseQuai } from "quais";
import {
  BrowserProvider as EvmBrowserProvider,
  JsonRpcProvider as EvmJsonRpcProvider,
  Contract as EvmContract,
} from "ethers";
import { getActiveWallet } from "@/lib/wallets";
import { getRpcProvider } from "@/lib/payment";
import { listChains, type ChainInfo } from "@/lib/chains";
import { useChainSelector, formatTokenAmount } from "@/lib/relayer";
import { listCurrencies } from "@/lib/currencies";
import { requestAppWalletFunding } from "@/lib/blip";
import { RefreshCw, Wallet as WalletIcon, PlusCircle } from "lucide-react";

// Minimal ERC20 ABI for balance checking
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
];

const evmProviders = new Map<number, EvmJsonRpcProvider>();
function getEvmRpcProvider(chain: ChainInfo): EvmJsonRpcProvider {
  let p = evmProviders.get(chain.chainId);
  if (!p) {
    p = new EvmJsonRpcProvider(chain.rpcUrl);
    evmProviders.set(chain.chainId, p);
  }
  return p;
}

/** Reads a native or ERC-20 balance against the RIGHT chain's own RPC/contract library — kept
 *  as one small typed helper so the two SDKs' distinct Provider/Contract types never need to be
 *  unified into an awkward union at the call site. */
async function readBalance(chain: ChainInfo, address: string, tokenAddress: string | null): Promise<bigint> {
  if (chain.kind === "quai") {
    const provider = getRpcProvider();
    if (!tokenAddress) return provider.getBalance(address);
    return (await new Contract(tokenAddress, ERC20_ABI, provider).balanceOf(address)) as bigint;
  }
  const provider = getEvmRpcProvider(chain);
  if (!tokenAddress) return provider.getBalance(address);
  return (await new EvmContract(tokenAddress, ERC20_ABI, provider).balanceOf(address)) as bigint;
}

export function WalletBalances() {
  const chains = listChains();
  const [chain, setChain] = useChainSelector();
  const currencies = listCurrencies(chain.chainId);
  // Balances keyed by lowercase currency address ("native" for QUAI); null = read failed.
  const [balances, setBalances] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(true);
  // Genuine failures only (RPC unreachable, etc.) — styled red. A wallet simply not supporting
  // the selected chain (BUG 2's UX half) is not a failure; that goes through `notice` instead.
  const [error, setError] = useState<string | null>(null);
  // Calm, plain-language explanation of an ordinary non-error state — no wallet connected yet, or
  // the connected wallet doesn't support the selected chain. Rendered in normal text colour, never
  // red: nothing has actually gone wrong.
  const [notice, setNotice] = useState<string | null>(null);
  const isBlip = getActiveWallet()?.brand === "blip";
  const [topUpAmount, setTopUpAmount] = useState("10");
  const [topUpBusy, setTopUpBusy] = useState(false);
  const [topUpError, setTopUpError] = useState<string | null>(null);

  // loading starts true so the skeleton shows on first render without a setState
  const fetchBalances = useCallback(async (opts?: { silent?: boolean }) => {
    // Manual refresh (button click / post-top-up) always re-enters the loading state so the
    // button shows a spinner and disables while in flight. The mount-time auto-load passes
    // silent so it never re-flashes the skeleton the page already shows.
    if (!opts?.silent) setLoading(true);
    setError(null);
    setNotice(null);
    // Forget any previously-shown balances so a failed refresh can't masquerade as success.
    setBalances({});

    // Yield to the event loop so state updates inside this function happen asynchronously
    // relative to the useEffect that calls it (react-hooks compiler lint requires it).
    await Promise.resolve();

    const wallet = getActiveWallet();
    if (!wallet) {
      // Not connecting yet is an ordinary state, not a failure.
      setNotice("Connect a wallet to see your balances.");
      setLoading(false);
      return;
    }

    // A quai_* RPC call must never be sent to a wallet that doesn't support Quai — guarded HERE,
    // at the point of the call, rather than trusting the selected tab to already be correct (the
    // tab is freely switchable independently of which wallet is connected). This is also not a
    // failure: the merchant's wallet is working fine, it just isn't a Quai wallet.
    if (chain.kind === "quai" && !wallet.supportsQuai) {
      setNotice(
        `Quai balances need a Quai-compatible wallet, such as Pelagus or Blip. ${wallet.name} doesn't support Quai — your payment links on other chains are unaffected.`,
      );
      setLoading(false);
      return;
    }

    try {
      // Resolve the account from the wallet. This DOES depend on chain kind — quais'
      // BrowserProvider issues a quai_accounts-style call, which a plain EVM wallet (MetaMask,
      // Rabby, ...) has no support for and throws "unsupported operation" on. Route by the
      // SELECTED chain's kind — safe now that the supportsQuai guard above has already ruled out
      // a quai_* call reaching a wallet that can't answer it.
      const accounts =
        chain.kind === "quai"
          ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await new BrowserProvider(wallet.provider as any, "any").listAccounts()
          : // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await new EvmBrowserProvider(wallet.provider as any).listAccounts();
      if (!accounts.length) throw new Error("Wallet locked");
      const address = accounts[0].address;

      // Read balances through the SELECTED chain's own canonical RPC — the wallet's injected
      // provider can sit on a different node/shard, where eth_call returns no data and balance
      // reads fail with "missing revert data".
      // Native currency + every configured ERC-20 for this chain, read in parallel; one failing
      // token read must never hide the others.
      const entries: Array<[string, Promise<string | null>]> = [
        [
          "native",
          readBalance(chain, address, null)
            .then((b) => formatTokenAmount(b, chain.nativeCurrency.decimals, chain.kind))
            .catch(() => null),
        ],
        ...listCurrencies(chain.chainId)
          .filter((c) => c.address !== "0x0000000000000000000000000000000000000000")
          .map(
            (c) =>
              [
                c.address.toLowerCase(),
                readBalance(chain, address, c.address)
                  .then((b) => formatTokenAmount(b, c.decimals, chain.kind))
                  .catch(() => null),
              ] as [string, Promise<string | null>],
          ),
      ];
      const results = await Promise.all(entries.map(async ([key, p]) => [key, await p] as const));
      setBalances(Object.fromEntries(results));
    } catch (err) {
      console.error("Error fetching balances:", err);
      setError("Failed to load balances");
    } finally {
      setLoading(false);
    }
  }, [chain]);

  // Auto-load on mount AND whenever the selected chain changes (silent — the skeleton is
  // already showing while loading=true); manual refreshes go through the button or the Blip
  // top-up flow.
  useEffect(() => {
    // fetchBalances only touches state after its `await Promise.resolve()` yield, but the
    // compiler lint still flags the call itself — same guard the previous implementation used.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchBalances({ silent: true });
  }, [fetchBalances]);

  /** Moves funds from the Blip main vault into this site's app wallet via Blip's funding
   *  sheet — the only way added QUAI becomes usable here, since Blip never exposes the main
   *  vault address to dApps. */
  const topUpAppWallet = async () => {
    const wallet = getActiveWallet();
    if (!wallet || wallet.brand !== "blip") return;
    let amountWei: bigint;
    try {
      amountWei = parseQuai(topUpAmount || "0");
    } catch {
      setTopUpError("Enter a valid QUAI amount.");
      return;
    }
    if (amountWei <= 0n) {
      setTopUpError("Enter an amount greater than zero.");
      return;
    }
    setTopUpBusy(true);
    setTopUpError(null);
    try {
      await requestAppWalletFunding(wallet.provider, {
        chainId: `0x${chain.chainId.toString(16)}`,
        reason: "manual top-up",
        continueLabel: "Add funds",
        assets: [
          // Canonical minimal hex — quais's toBeHex() pads odd-length values with a leading
          // zero, which go-quai rejects (-32602) when Blip forwards the funding request.
          { type: "native", symbol: "QUAI", decimals: 18, amountWei: amountWei === 0n ? "0x0" : `0x${amountWei.toString(16)}`, purpose: "topup" },
        ],
      });
      await fetchBalances();
    } catch (err) {
      const code = (err as { code?: number })?.code;
      setTopUpError(
        code === 4001
          ? "Top-up declined in Blip."
          : String((err as Error)?.message ?? "Top-up failed — try again."),
      );
    } finally {
      setTopUpBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-white/7 bg-[#171717] p-5">
      <div className="mb-4 flex items-center justify-between border-b border-white/7 pb-4">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#38bdf8]/10 text-[#38bdf8]">
            <WalletIcon size={16} />
          </div>
          <div>
            <h2 className="text-sm font-semibold">Wallet Balances</h2>
            <p className="text-xs text-[#8b93a7]">Your current {chain.name} holdings</p>
          </div>
        </div>
        <button
          onClick={() => void fetchBalances()}
          disabled={loading}
          className="rounded-lg border border-white/7 p-2 text-[#8b93a7] transition hover:bg-white/4 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          title={loading ? "Refreshing…" : "Refresh balances"}
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {chains.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {chains.map((c) => (
            <button
              key={c.chainId}
              onClick={() => c.available && setChain(c)}
              disabled={!c.available}
              title={
                c.available
                  ? undefined
                  : c.availability === "misconfigured"
                    ? `${c.name} is temporarily unavailable — contact support.`
                    : `${c.name} is coming soon`
              }
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                !c.available
                  ? "cursor-not-allowed border-white/7 text-[#4f5868]"
                  : chain.chainId === c.chainId
                    ? "border-[#38bdf8] bg-[#38bdf8]/10 text-[#38bdf8]"
                    : "border-white/7 text-[#8b93a7] hover:text-white"
              }`}
            >
              {c.name}
              {!c.available && (
                <span className="ml-1 text-[10px] uppercase text-[#4f5868]">
                  {c.availability === "misconfigured" ? "Unavailable" : "Soon"}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {error ? (
        <p className="text-sm text-red-400">{error}</p>
      ) : notice ? (
        <p className="text-sm text-[#8b93a7]">{notice}</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {currencies.map((c) => {
            const key = c.address === "0x0000000000000000000000000000000000000000" ? "native" : c.address.toLowerCase();
            const value = balances[key];
            return (
              <div key={key} className="rounded-xl border border-white/4 bg-[#0a0a0a] p-4">
                <p className="text-xs text-[#8b93a7]">
                  {key === "native" && isBlip && chain.kind === "quai"
                    ? `Native ${chain.nativeCurrency.symbol} · app wallet`
                    : c.symbol}
                </p>
                <p className={`mt-1 font-mono text-xl ${key === "native" ? "text-white" : "text-[#34d399]"}`}>
                  {loading ? "..." : value ?? "—"}
                </p>
              </div>
            );
          })}
        </div>
      )}

      {isBlip && chain.kind === "quai" && (
        <div className="mt-4 rounded-xl border border-white/7 bg-[#0a0a0a] p-4">
          <p className="text-xs leading-5 text-[#8b93a7]">
            You&apos;re connected with Blip, so this card shows your{" "}
            <span className="text-white">app wallet for this site</span> — a separate wallet
            from your Blip main vault. Payments and payouts use it. Funds you add to Blip land
            in the main vault first; move them over here to use them.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <div className="flex flex-1 items-center rounded-lg border border-white/10 bg-white/4 px-3">
              <input
                value={topUpAmount}
                onChange={(e) => setTopUpAmount(e.target.value)}
                inputMode="decimal"
                placeholder="10"
                disabled={topUpBusy}
                className="w-full bg-transparent py-2 text-sm text-white outline-none"
              />
              <span className="text-xs text-[#8b93a7]">QUAI</span>
            </div>
            <button
              onClick={() => void topUpAppWallet()}
              disabled={topUpBusy}
              className="flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-[#38bdf8] px-3 py-2 text-xs font-medium text-[#0b0f19] transition hover:brightness-110 disabled:opacity-50"
            >
              <PlusCircle size={14} className={topUpBusy ? "animate-pulse" : ""} />
              {topUpBusy ? "Opening Blip…" : "Top up"}
            </button>
          </div>
          {topUpError && <p className="mt-2 text-xs text-red-400">{topUpError}</p>}
        </div>
      )}
    </div>
  );
}
