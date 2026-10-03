"use client";

import {
  AlertCircle,
  Check,
  Copy,
  ExternalLink,
  Link2,
  Loader2,
  Plus,
  Users,
  Wallet,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import { parseError } from "@/lib/utils";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { checkSession } from "@/lib/auth";
import {
  ZERO_ADDRESS,
  createPaymentLink,
  fetchMyLinks,
  type LinkInfo,
} from "@/lib/payment";
import { listCurrencies, findCurrency, NATIVE_CURRENCY } from "@/lib/currencies";
import { listChains, type ChainInfo } from "@/lib/chains";
import { useChainSelector } from "@/lib/relayer";

/** Exact decimal-string → smallest-unit conversion (no float math). */
function toUnits(decimal: string, decimals: number): bigint {
  const [whole, frac = ""] = decimal.trim().split(".");
  const padded = `${whole}${frac.padEnd(decimals, "0").slice(0, decimals)}`;
  const value = BigInt(padded === "" ? "0" : padded);
  return value;
}

function shortUrl(slug: string): string {
  if (typeof window !== "undefined") {
    return `${window.location.origin}/pay/${slug}`;
  }
  return `/pay/${slug}`;
}

type ExpiryResult = { ok: true; expiryDurationSecs: number } | { ok: false };

/**
 * The checkout window, in seconds, sent to the backend.
 *
 * There is no longer an on-chain `expiry` to keep in sync: orders are created lazily, so the
 * backend stamps each authorization with this window at claim time. A blank field means the link
 * never expires.
 */
function computeExpiry(expiryHoursInput: string): ExpiryResult {
  if (expiryHoursInput.trim() === "") return { ok: true, expiryDurationSecs: 0 };
  const hours = Number(expiryHoursInput);
  if (!Number.isFinite(hours) || hours <= 0) return { ok: false };
  return { ok: true, expiryDurationSecs: Math.round(hours * 3600) };
}

/** How many customers a multi-pay link serves. 0 = unlimited. This is a backend counter, not a
 *  pre-registered pool: there is no on-chain order to run out. */
const MAX_REDEMPTION_OPTIONS = [0, 5, 10, 25, 50, 100];

export default function LinksPage() {
  // The wallet the merchant signed in with — the ONLY payout destination, fixed at sign-in.
  const [merchantAddress, setMerchantAddress] = useState<string | null>(null);
  // Which chain this link will be created on — a link belongs to exactly one chain, chosen here.
  const CHAINS = listChains();
  const [chain, setChain] = useChainSelector();
  const [token, setToken] = useState<string>(NATIVE_CURRENCY.address); // registry currency address
  const CURRENCIES = listCurrencies(chain.chainId);
  const selected = findCurrency(token, chain.chainId) ?? CURRENCIES[0]!;
  const symbol = selected.symbol;

  // Switching chains invalidates the selected token (addresses aren't valid across chains) —
  // reset to the new chain's native currency whenever the chain changes, whether from an explicit
  // pick (selectChain below) or the connected-wallet default seeded by useChainSelector. Adjusted
  // during render (React's recommended pattern for "state derived from a changed value"), not in
  // an effect — the lint rule requires it.
  const [prevChainId, setPrevChainId] = useState(chain.chainId);
  if (chain.chainId !== prevChainId) {
    setPrevChainId(chain.chainId);
    setToken(ZERO_ADDRESS);
  }

  const selectChain = (c: ChainInfo) => {
    setChain(c);
  };
  const [amount, setAmount] = useState("");
  const [shopName, setShopName] = useState("");
  const [expiryHours, setExpiryHours] = useState("");
  const [multiPay, setMultiPay] = useState(false);
  const [maxRedemptions, setMaxRedemptions] = useState(0);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [links, setLinks] = useState<LinkInfo[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [loadingLinks, setLoadingLinks] = useState(false);

  // Restore the payout wallet from the session and the connected wallet from the extension.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoadingLinks(true);
      const session = await checkSession();
      if (cancelled) return;
      if (session.status === "ok") {
        setMerchantAddress(session.merchant.address);
        try {
          const myLinks = await fetchMyLinks();
          if (!cancelled) setLinks(myLinks);
        } catch {
          // Not critical — just show empty
        }
      } else if (session.status === "expired") {
        setError("Session expired — sign in with your wallet again.");
      } else {
        setError("Payment service unreachable — reload in a moment.");
      }
      if (!cancelled) setLoadingLinks(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const create = async () => {
    const payout = merchantAddress;
    if (!payout) {
      setError("Sign in with your wallet to create payment links.");
      return;
    }
    // The payout address is the wallet the merchant signed in with, and the backend only ever
    // signs authorizations paying out to it. Nothing else here needs a wallet: no order is
    // registered on-chain, so there is no transaction to sign and no gas to spend.
    let units: bigint;
    try {
      units = toUnits(amount, selected.decimals);
    } catch {
      setError("Enter a valid amount, e.g. 25.0");
      return;
    }
    if (units <= 0n) {
      setError("Amount must be greater than zero.");
      return;
    }

    setBusy(true);
    setError(null);
    setLink(null);

    // Registry currencies carry their canonical mainnet address; native uses ZERO_ADDRESS.
    const onChainToken: string = selected.address;

    const expiryResult = computeExpiry(expiryHours);
    if (!expiryResult.ok) {
      setError("Expiry must be a positive number of hours.");
      setBusy(false);
      return;
    }
    const { expiryDurationSecs } = expiryResult;

    try {
      const created = await createPaymentLink({
        shopName: shopName.trim(),
        tokenAddress: onChainToken,
        amount: units.toString(),
        amountDisplay: amount,
        symbol,
        expiryDurationSecs,
        multiPay,
        maxRedemptions: multiPay ? maxRedemptions : 1,
        orderPool: [],
        chainId: chain.chainId,
      });

      setLink(shortUrl(created.slug));

      // Refresh links list
      try {
        const myLinks = await fetchMyLinks();
        setLinks(myLinks);
      } catch {
        // best-effort
      }

      setAmount("");
      setShopName("");
      setExpiryHours("");
    } catch (err) {
      setError(parseError(err) || "Failed to create payment link.");
    } finally {
      setBusy(false);
    }
  };

  const copy = async (url: string) => {
    await navigator.clipboard.writeText(url);
    setCopied(url);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <DashboardShell>
      <div className="mx-auto max-w-3xl px-5 py-8 lg:py-10">
        <div className="mb-8">
          <p className="mb-2 text-sm text-[#38bdf8]">Payments</p>
          <h1 className="text-3xl font-semibold tracking-tight">
            Payment links
          </h1>
          <p className="mt-2 text-sm text-[#8b93a7]">
            Create a short link your customers can open on any browser or
            phone. Single-pay links settle once; multi-pay links let many
            customers pay independently.
          </p>
        </div>

        <div className="space-y-6">
          <section className="relative overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-b from-[#121212] to-[#0a0a0a] p-1 shadow-2xl">
            <div className="rounded-[22px] bg-[#171717] p-6 sm:p-8">
            {merchantAddress ? (
              <div className="space-y-8">
                {/* Sleek Payout Wallet Header */}
                <div className="flex items-center justify-between rounded-xl bg-white/[0.03] px-4 py-3 border border-white/[0.05]">
                  <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#38bdf8]/10">
                      <Wallet size={16} className="text-[#38bdf8]" />
                    </div>
                    <div>
                      <p className="text-xs text-[#8b93a7]">Settling to connected wallet</p>
                      <p className="font-mono text-sm text-white">
                        {merchantAddress.slice(0, 6)}...{merchantAddress.slice(-4)}
                      </p>
                    </div>
                  </div>
                  <div className="hidden sm:block text-right">
                    <p className="text-xs text-[#8b93a7]">Platform fee: <span className="text-white">0.3%</span></p>
                  </div>
                </div>

                  {/* Chain Selection */}
                  <div>
                    <p className="mb-3 text-sm font-medium text-[#c9d4e0]">Select Network</p>
                    <div className="flex flex-wrap gap-2">
                      {CHAINS.map((c) => (
                        <button
                          key={c.chainId}
                          onClick={() => c.available && selectChain(c)}
                          disabled={!c.available}
                          title={
                            c.available
                              ? undefined
                              : c.availability === "misconfigured"
                                ? `${c.name} is temporarily unavailable — contact support.`
                                : `${c.name} is coming soon`
                          }
                          className={`relative flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-all ${
                            !c.available
                              ? "cursor-not-allowed border border-transparent bg-white/5 text-[#4f5868]"
                              : chain.chainId === c.chainId
                                ? "border border-[#38bdf8]/50 bg-[#38bdf8]/10 text-[#38bdf8] shadow-[0_0_15px_rgba(56,189,248,0.15)]"
                                : "border border-white/10 bg-transparent text-[#8b93a7] hover:border-white/20 hover:text-white"
                          }`}
                        >
                          {c.name}
                          {!c.available && (
                            <span className="text-[10px] uppercase tracking-wider opacity-60">
                              {c.availability === "misconfigured" ? "Unavailable" : "Soon"}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid gap-6 sm:grid-cols-2">
                    {/* Amount & Asset Combined */}
                    <div className="sm:col-span-2">
                      <p className="mb-2 text-sm font-medium text-[#c9d4e0]">Amount</p>
                      <div className="relative flex items-center overflow-hidden rounded-xl border border-white/10 bg-[#0a0a0a] transition-colors focus-within:border-[#38bdf8]/50">
                        <input
                          type="text"
                          inputMode="decimal"
                          value={amount}
                          onChange={(e) => setAmount(e.target.value)}
                          placeholder="0.00"
                          className="h-14 flex-1 bg-transparent px-4 font-mono text-lg text-white outline-none placeholder:text-[#4f5868]"
                        />
                        <div className="h-8 w-[1px] bg-white/10" />
                        <select
                          value={token}
                          onChange={(e) => setToken(e.target.value)}
                          className="h-14 cursor-pointer appearance-none bg-transparent px-5 py-2 pr-10 font-medium text-white outline-none focus:bg-[#121212]"
                          style={{
                            backgroundImage: `url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238b93a7' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e")`,
                            backgroundRepeat: 'no-repeat',
                            backgroundPosition: 'right 1rem center',
                            backgroundSize: '1em',
                          }}
                        >
                          {CURRENCIES.map((c) => (
                            <option key={c.address} value={c.address} className="bg-[#171717]">
                              {c.symbol}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    {/* Shop name */}
                    <div>
                      <p className="mb-2 text-sm font-medium text-[#c9d4e0]">
                        Shop / Display name <span className="text-[#4f5868]">(optional)</span>
                      </p>
                      <input
                        type="text"
                        value={shopName}
                        onChange={(e) => setShopName(e.target.value)}
                        placeholder="e.g. Alice's Coffee Shop"
                        maxLength={200}
                        className="h-12 w-full rounded-xl border border-white/10 bg-[#0a0a0a] px-4 text-sm text-white outline-none transition-colors placeholder:text-[#4f5868] focus:border-[#38bdf8]/50"
                      />
                    </div>

                    {/* Expiry */}
                    <div>
                      <p className="mb-2 text-sm font-medium text-[#c9d4e0]">
                        Expiry <span className="text-[#4f5868]">(optional)</span>
                      </p>
                      <select
                        value={expiryHours}
                        onChange={(e) => setExpiryHours(e.target.value)}
                        className="h-12 w-full cursor-pointer appearance-none rounded-xl border border-white/10 bg-[#0a0a0a] px-4 text-sm text-white outline-none transition-colors focus:border-[#38bdf8]/50"
                        style={{
                          backgroundImage: `url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238b93a7' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e")`,
                          backgroundRepeat: 'no-repeat',
                          backgroundPosition: 'right 1rem center',
                          backgroundSize: '1em',
                        }}
                      >
                        <option value="">never expires</option>
                        <option value="0.25">15 mins</option>
                        <option value="0.5">30 mins</option>
                        <option value="1">1 hour</option>
                        <option value="2">2 hours</option>
                        <option value="6">6 hours</option>
                        <option value="12">12 hours</option>
                        <option value="24">24 hours</option>
                        <option value="48">48 hours</option>
                      </select>
                    </div>
                  </div>

                {/* Multi-pay toggle */}
                <div className="rounded-2xl border border-white/10 bg-[#0a0a0a] p-5">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-4">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#38bdf8]/10 text-[#38bdf8]">
                        <Users size={18} />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-white">Multi-pay Link</p>
                        <p className="text-xs text-[#8b93a7] mt-0.5">
                          Allow many customers to pay using this single link.
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => setMultiPay((v) => !v)}
                      className={`relative flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full transition-colors ${
                        multiPay ? "bg-[#38bdf8]" : "bg-white/10"
                      }`}
                    >
                      <span
                        className={`absolute left-1 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                          multiPay ? "translate-x-5" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>

                  {multiPay && (
                    <div className="mt-4 border-t border-white/7 pt-4">
                      <p className="mb-2 text-sm text-[#8b93a7]">
                        Customer limit — how many customers can pay this link
                      </p>
                      <div className="flex gap-2 flex-wrap">
                        {MAX_REDEMPTION_OPTIONS.map((n) => (
                          <button
                            key={n}
                            onClick={() => setMaxRedemptions(n)}
                            className={`rounded-lg border px-4 py-2 text-sm font-medium transition ${
                              maxRedemptions === n
                                ? "border-[#38bdf8] bg-[#38bdf8]/10 text-[#38bdf8]"
                                : "border-white/7 text-[#8b93a7] hover:text-white"
                            }`}
                          >
                            {n === 0 ? "Unlimited" : n}
                          </button>
                        ))}
                      </div>
                      <div className="mt-3 flex items-start gap-2 rounded-lg border border-[#38bdf8]/20 bg-[#38bdf8]/6 px-3 py-2.5">
                        <AlertCircle
                          size={13}
                          className="mt-0.5 shrink-0 text-[#38bdf8]"
                        />
                        <p className="text-xs text-[#38bdf8]">
                          {maxRedemptions === 0 ? (
                            <>
                              This link stays open indefinitely. Each
                              customer&apos;s payment creates its own order in
                              their transaction.
                            </>
                          ) : (
                            <>
                              This link serves up to{" "}
                              <strong>{maxRedemptions}</strong>{" "}
                              {maxRedemptions === 1 ? "customer" : "customers"}
                              , then stops. Publish another link to keep
                              selling.
                            </>
                          )}
                        </p>
                      </div>
                    </div>
                  )}
                </div>

                {error && (
                  <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
                    {error}
                  </p>
                )}

                <button
                  onClick={() => void create()}
                  disabled={busy || !amount}
                  className="group relative inline-flex w-full items-center justify-center gap-2 overflow-hidden rounded-xl bg-[#38bdf8] px-5 py-4 text-sm font-semibold text-[#061018] transition-all hover:bg-[#67d8ff] disabled:opacity-50 disabled:hover:bg-[#38bdf8]"
                >
                  <div className="absolute inset-0 flex h-full w-full justify-center [transform:skew(-12deg)_translateX(-100%)] group-hover:duration-1000 group-hover:[transform:skew(-12deg)_translateX(100%)]">
                    <div className="relative h-full w-8 bg-white/20" />
                  </div>
                  {busy ? (
                    <Loader2 size={18} className="animate-spin" />
                  ) : (
                    <Plus size={18} />
                  )}
                  {busy
                    ? "Generating Link…"
                    : `Create Link`}
                </button>

                {link && (
                  <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/6 p-4">
                    <div className="mb-2 flex items-center gap-2">
                      <Zap size={13} className="text-emerald-300" />
                      <p className="text-xs text-emerald-300">
                        Short link created — share with{" "}
                        {multiPay ? "your customers" : "your customer"}:
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <code className="min-w-0 flex-1 break-all font-mono text-xs text-white">
                        {link}
                      </code>
                      <button
                        onClick={() => void copy(link)}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[#38bdf8] px-3 py-2 text-xs font-semibold text-[#061018] transition hover:bg-[#67d8ff]"
                      >
                        {copied === link ? (
                          <Check size={13} />
                        ) : (
                          <Copy size={13} />
                        )}
                        {copied === link ? "Copied" : "Copy"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-white/5">
                  <Wallet size={24} className="text-[#8b93a7]" />
                </div>
                <p className="text-sm text-[#8b93a7]">
                  {loadingLinks
                    ? "Loading your payout wallet…"
                    : error ?? "Sign in with your wallet to create payment links."}
                </p>
              </div>
            )}
            </div>
          </section>

          {/* Existing links */}
          {merchantAddress && (
            <section className="rounded-[22px] border border-white/10 bg-[#121212] p-6 sm:p-8">
              <div className="flex items-center justify-between border-b border-white/5 pb-4">
                <div>
                  <h2 className="text-lg font-semibold text-white">Payment Links</h2>
                  <p className="text-xs text-[#8b93a7] mt-1">
                    Your active and past payment links
                  </p>
                </div>
                {loadingLinks && (
                  <Loader2
                    size={15}
                    className="animate-spin text-[#8b93a7]"
                  />
                )}
              </div>

              {!loadingLinks && links.length === 0 && (
                <p className="mt-4 text-sm text-[#4f5868]">
                  No links yet — create one above.
                </p>
              )}

              {links.length > 0 && (
                <div className="mt-4 divide-y divide-white/6">
                  {links.map((l) => {
                    const url = shortUrl(l.slug);
                    return (
                      <div
                        key={l.slug}
                        className="flex items-center justify-between gap-3 py-3"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="truncate text-sm font-medium">
                              {l.amountDisplay} {l.symbol}
                            </p>
                            {l.chain && (
                              <span className="inline-flex items-center rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-[#8b93a7]">
                                {l.chain.name}
                              </span>
                            )}
                            {l.multiPay && (
                              <span className="inline-flex items-center gap-1 rounded-full border border-[#38bdf8]/20 bg-[#38bdf8]/8 px-2 py-0.5 text-[10px] text-[#38bdf8]">
                                <Users size={9} />
                                Multi-pay
                              </span>
                            )}
                          </div>
                          {l.shopName && (
                            <p className="mt-0.5 truncate text-xs text-[#8b93a7]">
                              {l.shopName}
                            </p>
                          )}
                          <p className="mt-0.5 truncate font-mono text-xs text-[#4f5868]">
                            /pay/{l.slug} ·{" "}
                            {new Date(l.createdAt).toLocaleString()}
                            {l.multiPay &&
                              (l.maxRedemptions
                                ? ` · up to ${l.maxRedemptions} customers`
                                : " · unlimited customers")}
                            {l.multiPay &&
                              l.poolSize !== undefined &&
                              l.poolSize > 0 &&
                              ` · ${l.poolSize} legacy slot${l.poolSize !== 1 ? "s" : ""} left`}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <button
                            onClick={() => void copy(url)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-white/7 px-3 py-2 text-xs font-medium text-[#c9d4e0] transition hover:bg-white/6"
                          >
                            {copied === url ? (
                              <Check size={13} />
                            ) : (
                              <Copy size={13} />
                            )}
                            {copied === url ? "Copied" : "Copy"}
                          </button>
                          <a
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1.5 rounded-lg border border-white/7 px-3 py-2 text-xs font-medium text-[#c9d4e0] transition hover:bg-white/6"
                          >
                            <ExternalLink size={13} />
                            Open
                          </a>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}
        </div>

        <p className="mt-6 flex items-center gap-2 text-xs text-[#4f5868]">
          <Link2 size={13} />
          Tip: for checkout pages you build yourself, use the integration guide
          in the docs — these links are the zero-code option.
        </p>
      </div>
    </DashboardShell>
  );
}