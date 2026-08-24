"use client";

import { useEffect, useState } from "react";
import { BrowserProvider, Contract, getAddress, parseQuai } from "quais";
import { getActiveWallet, QUAI_MAINNET_CHAIN } from "@/lib/wallets";
import { getRpcProvider, MUSDQ_ADDRESS } from "@/lib/payment";
import { currencySymbol } from "@/lib/currencies";
import { requestAppWalletFunding } from "@/lib/blip";
import { RefreshCw, Wallet as WalletIcon, PlusCircle } from "lucide-react";

// Minimal ERC20 ABI for balance checking
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
];

function chainLabel(): string {
  return "Quai mainnet holdings";
}

/** Resolves the configured stablecoin address once — null when unset or malformed, in which
 *  case the token row is shown as "not configured" instead of failing the whole widget. */
const tokenAddress: string | null = (() => {
  if (!MUSDQ_ADDRESS) return null;
  try {
    return getAddress(MUSDQ_ADDRESS);
  } catch {
    return null;
  }
})();

export function WalletBalances() {
  const [quaiBalance, setQuaiBalance] = useState<string | null>(null);
  const [musdqBalance, setMusdqBalance] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isBlip = getActiveWallet()?.brand === "blip";
  const [topUpAmount, setTopUpAmount] = useState("10");
  const [topUpBusy, setTopUpBusy] = useState(false);
  const [topUpError, setTopUpError] = useState<string | null>(null);

  // loading starts true so the skeleton shows on first render without a setState
  const fetchBalances = async () => {
    // Yield to the event loop so state updates inside this function happen asynchronously
    // relative to the useEffect that calls it. This fixes the cascading render lint error.
    await Promise.resolve();

    const wallet = getActiveWallet();
    if (!wallet) {
      setError("No wallet connected");
      setLoading(false);
      return;
    }

    setError(null);
    try {
      // Resolve the account from the wallet (no network read), then read balances through the
      // app's canonical RPC — the network the relayer + contracts actually run on. The wallet's
      // injected provider can sit on a different node/shard, where eth_call returns no data and
      // balance reads fail with "missing revert data".
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const accounts = await new BrowserProvider(wallet.provider as any, "any").listAccounts();
      if (!accounts.length) throw new Error("Wallet locked");
      const address = accounts[0].address;

      const provider = getRpcProvider();

      // Fetch Native QUAI — keep it independent so a failing token read doesn't hide it.
      try {
        const balance = await provider.getBalance(address);
        setQuaiBalance((Number(balance) / 1e18).toFixed(2));
      } catch (err) {
        console.error("Error fetching QUAI balance:", err);
        setQuaiBalance(null);
      }

      // Fetch the stablecoin (6 decimals) only when its address is actually configured —
      // a missing/bad address must never take down the QUAI row with it.
      if (!tokenAddress) {
        setMusdqBalance(null);
        return;
      }
      try {
        const tokenContract = new Contract(tokenAddress, ERC20_ABI, provider);
        const tokenBalance = await tokenContract.balanceOf(address);
        setMusdqBalance((Number(tokenBalance) / 1e6).toFixed(2));
      } catch (err) {
        console.error("Error fetching token balance:", err);
        setMusdqBalance(null);
      }
    } catch (err) {
      console.error("Error fetching balances:", err);
      setError("Failed to load balances");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchBalances();
  }, []);

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
        chainId: QUAI_MAINNET_CHAIN.chainId,
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
            <p className="text-xs text-[#8b93a7]">Your current {chainLabel()}</p>
          </div>
        </div>
        <button
          onClick={fetchBalances}
          disabled={loading}
          className="rounded-lg border border-white/7 p-2 text-[#8b93a7] transition hover:bg-white/4 hover:text-white disabled:opacity-50"
          title="Refresh balances"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {error ? (
        <p className="text-sm text-red-400">{error}</p>
      ) : (
        <div className={`grid gap-4 ${tokenAddress ? "sm:grid-cols-2" : ""}`}>
          <div className="rounded-xl border border-white/4 bg-[#0a0a0a] p-4">
            <p className="text-xs text-[#8b93a7]">
              {isBlip ? "Native QUAI · app wallet" : "Native QUAI"}
            </p>
            <p className="mt-1 font-mono text-xl text-white">
              {loading ? "..." : quaiBalance ?? "—"}
            </p>
          </div>
          {tokenAddress && (
            <div className="rounded-xl border border-white/4 bg-[#0a0a0a] p-4">
              <p className="text-xs text-[#8b93a7]">
                {currencySymbol(tokenAddress)} (Stablecoin)
              </p>
              <p className="mt-1 font-mono text-xl text-[#34d399]">
                {loading ? "..." : musdqBalance ?? "—"}
              </p>
            </div>
          )}
        </div>
      )}

      {isBlip && (
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
