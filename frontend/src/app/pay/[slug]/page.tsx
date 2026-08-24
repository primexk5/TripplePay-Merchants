"use client";

import Link from "next/link";
import {
  ArrowLeft,
  Check,
  Clock,
  Download,
  Loader2,
  LockKeyhole,
  ShieldCheck,
  Smartphone,
  Users,
  Wallet,
} from "lucide-react";
import { useEffect, useState, useRef, useCallback } from "react";
import { toPng } from "html-to-image";
import { Receipt } from "@/components/ui/receipt";
import QRCode from "react-qr-code";
import { formatQuai, formatUnits } from "quais";
import { Logo } from "@/components/logo";
import { WalletSelector } from "@/components/ui/wallet-selector";
import {
  ZERO_ADDRESS,
  getOrderOnChain,
  orderPaymentError,
  payOrder,
  payOrderNative,
  requestBlipAppWalletTopUp,
  waitForOnChainConfirmation,
  fetchLink,
  claimOrderFromLink,
  linkPaymentProblem,
  type LinkInfo,
} from "@/lib/payment";
import { currencyDecimals } from "@/lib/currencies";
import {
  blipBrowserLink,
  blipDeepLink,
  isInsideBlipBrowser,
  isMobileViewport,
} from "@/lib/blip";
import {
  connectWallet,
  detectWallets,
  ensureQuaiNetwork,
  getActiveWallet,
  storeWalletId,
  QUAI_MAINNET_CHAIN,
} from "@/lib/wallets";
import { parseError, rawErrorText } from "@/lib/utils";

type Params = Promise<{ slug: string }>;

type Stage =
  | { name: "loading" }
  | { name: "notfound" }
  | { name: "ready" }
  | { name: "claiming" }
  | { name: "paying"; step: string }
  | { name: "awaiting"; status: string }
  | { name: "done"; txHash: string; net: string; symbol: string }
  | { name: "error"; message: string };

function formatAmount(link: LinkInfo, amount: bigint): string {
  const isNative = link.tokenAddress.toLowerCase() === ZERO_ADDRESS.toLowerCase();
  return isNative ? formatQuai(amount) : formatUnits(amount, currencyDecimals(link.tokenAddress));
}

/** Returns the current page URL (empty string during SSR). */
function currentPageUrl(): string {
  return typeof window !== "undefined" ? window.location.href : "";
}

export default function PayPage({ params }: { params: Params }) {
  const [stage, setStage] = useState<Stage>({ name: "loading" });
  const [slug, setSlug] = useState("");
  const [link, setLink] = useState<LinkInfo | null>(null);
  const [connected, setConnected] = useState<string | null>(null);
  const [insideBlip, setInsideBlip] = useState(false);
  const [payTab, setPayTab] = useState<"blip" | "wallet">("wallet");
  const [blipConnecting, setBlipConnecting] = useState(false);
  const [needsFund, setNeedsFund] = useState(false);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState("");
  const receiptRef = useRef<HTMLDivElement>(null);
  const [downloading, setDownloading] = useState(false);
  const [claimedOrderId, setClaimedOrderId] = useState<string | null>(null);
  const [claimedMerchant, setClaimedMerchant] = useState<string | null>(null);
  const pageUrl = currentPageUrl();

  // Detect the Blip in-app browser (read-only — never requests accounts)
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      setInsideBlip(isInsideBlipBrowser());
    })();
    return () => { cancelled = true; };
  }, []);

  // Blip's in-app browser can inject window.quai a moment after first paint — keep polling for
  // a few seconds so the "Pay with Blip" panel appears instead of the "Open in Blip" loop.
  useEffect(() => {
    if (insideBlip || connected || stage.name !== "ready") return;
    let attempts = 0;
    const timer = setInterval(() => {
      if (++attempts > 10) {
        clearInterval(timer);
        return;
      }
      if (isInsideBlipBrowser()) {
        clearInterval(timer);
        setInsideBlip(true);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [insideBlip, connected, stage.name]);

  const connectBlip = useCallback(async (): Promise<void> => {
    const blip = detectWallets().find((w) => w.brand === "blip");
    if (!blip) {
      throw new Error("Blip wallet not detected — reopen this page inside the Blip app.");
    }
    // Blip's provider implements EIP-3326 (verify → switch → add) per its docs.
    const net = await ensureQuaiNetwork(blip.provider, QUAI_MAINNET_CHAIN);
    if (net === "unsupported") {
      throw new Error(
        "Blip couldn't switch to Quai mainnet (chain 9) — switch networks in Blip and retry.",
      );
    }
    const addr = await connectWallet(blip);
    storeWalletId(blip.id);
    setConnected(addr);
  }, []);

  // Load link metadata
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { slug: s } = await params;
      if (cancelled) return;
      setSlug(s);
      try {
        const info = await fetchLink(s);
        if (cancelled) return;
        if (!info) {
          setStage({ name: "notfound" });
          return;
        }
        setLink(info);
        setStage({ name: "ready" });
      } catch {
        if (!cancelled) setStage({ name: "error", message: "Could not load this payment link. Try again." });
      }
    })();
    return () => { cancelled = true; };
  }, [params]);

  const downloadReceipt = async () => {
    if (!receiptRef.current) return;
    try {
      setDownloading(true);
      const dataUrl = await toPng(receiptRef.current, { cacheBust: true });
      const a = document.createElement("a");
      a.download = `receipt-${slug}.png`;
      a.href = dataUrl;
      a.click();
    } catch (err) {
      console.error(err);
    } finally {
      setDownloading(false);
    }
  };

  const isNative = (l: LinkInfo) =>
    l.tokenAddress.toLowerCase() === ZERO_ADDRESS.toLowerCase();

  const symbol = (l: LinkInfo) => l.symbol;

  const connectAndPay = useCallback(async () => {
    if (!link) return;
    setNeedsFund(false);
    const wallet = getActiveWallet();
    if (!wallet) {
      setStage({ name: "error", message: "No wallet connected — pick a wallet above." });
      return;
    }
    if (!connected) {
      setStage({ name: "error", message: "No wallet connected — pick a wallet above." });
      return;
    }

    const activeWallet = getActiveWallet();
    let phase = "prepare";
    try {
      // Ensure the wallet is on the app's network before anything else — a wallet on a
      // different node/shard would sign a tx the chain silently rejects ("missing revert data").
      phase = "network";
      const wallet = getActiveWallet();
      if (wallet) {
        const chain = QUAI_MAINNET_CHAIN;
        // Only Pelagus skips network checks (its EIP-3326 requests hang). Blip goes through
        // the full verify → switch → add path — its documented provider supports both methods.
        const quaiNative = wallet.brand === "pelagus";
        const net = await ensureQuaiNetwork(wallet.provider, chain, { quaiNative });
        if (net === "unsupported") {
          throw new Error(
            `${wallet.name} couldn't switch to ${chain.chainName} (chain ${parseInt(chain.chainId, 16)}) — switch networks in your wallet and retry.`,
          );
        }
      }

      // Step 1: Claim an orderId from the pool
      phase = "claim";
      setStage({ name: "claiming" });
      const linkProblem = await linkPaymentProblem(link);
      if (linkProblem) throw new Error(linkProblem);
      const claim = await claimOrderFromLink(slug, connected);
      const orderId = claim.orderId;
      const merchant = claim.merchant;
      setClaimedOrderId(orderId);
      setClaimedMerchant(merchant);

      // Step 2: Sanity-check the order on-chain BEFORE the wallet popup, so a call that would
      // certainly revert never wastes the customer's approval.
      setStage({ name: "paying", step: "Checking order…" });
      const amount = BigInt(link.amount);
      const onChainOrder = await getOrderOnChain(merchant, orderId);
      const precheckError = orderPaymentError(
        onChainOrder,
        connected,
        amount,
        isNative(link),
      );
      if (precheckError) throw new Error(precheckError);

      // Step 3: Pay the order — one wallet popup
      phase = "send";
      setStage({ name: "paying", step: "Awaiting wallet approval…" });
      const hash = isNative(link)
        ? await payOrderNative(merchant, orderId, amount)
        : await payOrder(merchant, orderId, link.tokenAddress, amount);


      // Step 4: Wait for on-chain confirmation (instant — no webhook wait)
      phase = "confirm";
      setStage({ name: "awaiting", status: "Waiting for block confirmation…" });
      const settled = await waitForOnChainConfirmation(
        merchant,
        orderId,
        (status) => setStage({ name: "awaiting", status }),
      );
      if (!settled) {
        throw new Error("Payment was not confirmed on-chain — check your wallet and try again.");
      }
      setStage({
        name: "done",
        txHash: hash,
        net: formatAmount(link, amount),
        symbol: symbol(link),
      });
    } catch (err: unknown) {
      setNeedsFund((err as { needsFunding?: boolean })?.needsFunding === true);
      setErrorDetail(
        `phase: ${phase} | wallet: ${activeWallet?.brand ?? "?"} | currency: ${link && isNative(link) ? "native" : "token"} | ` +
          rawErrorText(err),
      );
      setStage({ name: "error", message: parseError(err) });
    }
  }, [link, slug, connected]);

  // Blip app wallets are often empty — when a payment fails for lack of funds, let the user
  // pull QUAI from their main vault (Blip's funding sheet) and retry in one tap.
  const fundAppWalletAndRetry = useCallback(async () => {
    if (!link) return;
    try {
      await requestBlipAppWalletTopUp(BigInt(link.amount));
    } catch {
      // Still short — fall through to the retry, which re-checks and reports clearly.
    }
    void connectAndPay();
  }, [link, connectAndPay]);

  // ── Done screen ──────────────────────────────────────────────────────────
  if (stage.name === "done" && link) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#171717] px-5 text-white">
        <div className="w-full max-w-md text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-emerald-400/20 bg-emerald-400/10 text-emerald-300">
            <Check size={28} />
          </div>
          <p className="mt-6 text-sm text-emerald-300">Payment confirmed</p>
          <h1 className="mt-2 text-3xl font-semibold">
            {stage.net} {stage.symbol} sent
          </h1>
          {customerName && (
            <p className="mt-1 text-sm text-[#8b93a7]">
              Receipt for <span className="text-white">{customerName}</span>
            </p>
          )}
          <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-[#8b93a7]">
            Your payment settled on-chain.{" "}
            {link.shopName || link.merchantName} will be notified automatically.
          </p>
          <div className="mt-6 space-y-2 rounded-2xl border border-white/7 bg-[#171717] p-4 text-left font-mono text-xs text-[#8b93a7]">
            <p className="break-all">
              tx: <span className="text-white">{stage.txHash}</span>
            </p>
            <p className="break-all">
              order:{" "}
              <span className="text-white">
                {claimedOrderId?.slice(0, 20)}…
              </span>
            </p>
          </div>
          <div className="mt-5 flex flex-col items-center gap-3">
            <button
              onClick={downloadReceipt}
              disabled={downloading}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-white/10 px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/20 disabled:opacity-50"
            >
              {downloading ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Download size={16} />
              )}
              {downloading ? "Generating receipt…" : "Download Receipt"}
            </button>
            <Link
              href="/"
              className="inline-flex w-full items-center justify-center gap-2 text-sm text-[#8b93a7] py-2 transition hover:text-white"
            >
              <ArrowLeft size={15} />
              Return to TripplePay || Marchants
            </Link>
          </div>
          {/* Hidden receipt for download */}
          <div className="absolute left-[-9999px] top-0 opacity-0 pointer-events-none">
            <Receipt
              ref={receiptRef}
              amount={stage.net}
              symbol={stage.symbol}
              merchantAddress={claimedMerchant ?? link.merchantAddress}
              orderId={claimedOrderId ?? ""}
              txHash={stage.txHash}
              date={new Date().toLocaleDateString("en-US", {
                year: "numeric",
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
              customerName={customerName || undefined}
              merchantName={link.merchantName}
              shopName={link.shopName || undefined}
              merchantId={link.merchantId}
            />
          </div>
        </div>
      </main>
    );
  }

  // ── Loading / not found ───────────────────────────────────────────────────
  return (
    <main className="min-h-screen bg-[#171717] px-5 py-10 text-white">
      <div className="mx-auto max-w-lg">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-[#8b93a7] hover:text-white"
        >
          <ArrowLeft size={15} />
          TripplePay || Marchants
        </Link>

        <div className="mt-10 rounded-3xl border border-white/7 bg-[#171717] p-6 sm:p-8">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              {link ? (
                <>
                  <p className="text-sm font-semibold">
                    {link.shopName || link.merchantName || "Secure checkout"}
                  </p>
                  <p className="mt-1 text-xs text-[#8b93a7]">
                    {link.shopName && link.merchantName
                      ? `by ${link.merchantName}`
                      : "Pay with Quai — non-custodial"}
                  </p>
                  {link.multiPay && (
                    <span className="mt-1 inline-flex items-center gap-1 rounded-full border border-[#38bdf8]/20 bg-[#38bdf8]/8 px-2 py-0.5 text-[10px] text-[#38bdf8]">
                      <Users size={9} />
                      Multi-pay link
                    </span>
                  )}
                </>
              ) : (
                <>
                  <p className="text-sm font-semibold">Secure checkout</p>
                  <p className="mt-1 text-xs text-[#8b93a7]">
                    Pay with Quai — non-custodial
                  </p>
                </>
              )}
            </div>
            <Logo className="h-10 w-10" />
          </div>

          <div className="my-7 h-px bg-white/7" />

          {/* Loading */}
          {stage.name === "loading" && (
            <div className="flex flex-col items-center gap-3 py-12 text-sm text-[#8b93a7]">
              <Loader2 size={18} className="animate-spin text-[#38bdf8]" />
              Loading payment link…
            </div>
          )}

          {/* Not found */}
          {stage.name === "notfound" && (
            <div className="py-10 text-center">
              <p className="text-sm font-medium text-white">Link not found</p>
              <p className="mx-auto mt-2 max-w-sm text-xs leading-5 text-[#8b93a7]">
                This payment link doesn&apos;t exist or has been removed. Ask
                the merchant for a fresh link.
              </p>
            </div>
          )}

          {/* Ready / Claiming / Paying / Awaiting */}
          {["ready", "claiming", "paying", "awaiting"].includes(stage.name) &&
            link && (
              <>
                {/* Amount */}
                <div className="text-center">
                  <p className="text-sm text-[#8b93a7]">Total to pay</p>
                  <p className="mt-2 text-5xl font-semibold tracking-tight">
                    {link.amountDisplay}
                  </p>
                  <p className="mt-1 text-sm text-[#38bdf8]">{symbol(link)}</p>
                  {link.expiryDurationSecs > 0 && (
                    <p className="mt-1 flex items-center justify-center gap-1.5 text-xs text-[#8b93a7]">
                      <Clock size={12} />
                      order expires{" "}
                      {Math.round(link.expiryDurationSecs / 60)} min after you
                      click Pay
                    </p>
                  )}
                </div>

                {/* Merchant info */}
                <div className="mt-5 rounded-xl border border-white/7 bg-[#171717] px-4 py-3">
                  <p className="text-xs text-[#8b93a7]">Pay to merchant</p>
                  <p className="mt-1 break-all font-mono text-xs text-white">
                    {link.merchantAddress}
                  </p>
                  {link.poolSize <= 3 && link.multiPay && (
                    <p className="mt-1 text-xs text-amber-300">
                      ⚠ Only {link.poolSize} payment slot
                      {link.poolSize !== 1 ? "s" : ""} remaining
                    </p>
                  )}
                </div>

                <div className="mt-8 rounded-2xl border border-white/7 bg-[#171717] p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">Quai Network</p>
                      <p className="mt-1 text-xs text-[#8b93a7]">
                        Settlement network
                      </p>
                    </div>
                    <Check size={17} className="text-emerald-300" />
                  </div>
                </div>

                {stage.name === "ready" && (
                  <>
                    {insideBlip ? (
                      /* Blip in-app browser */
                      <div className="mt-6 rounded-2xl border border-[#C1ED00]/25 bg-[#171717] p-6">
                        <p className="text-center text-sm font-medium text-white">
                          Pay with Blip
                        </p>
                        <div className="mt-5 space-y-3">
                          {connected ? (
                            <>
                              <div className="rounded-xl border border-white/7 bg-[#171717] px-4 py-3 text-center">
                                <p className="text-xs text-[#8b93a7]">
                                  Paying as
                                </p>
                                <p className="mt-1 break-all font-mono text-xs text-white">
                                  {connected}
                                </p>
                              </div>
                              {/* Customer name */}
                              <div>
                                <p className="mb-2 text-sm text-[#8b93a7]">
                                  Your name (optional — appears on receipt)
                                </p>
                                <input
                                  type="text"
                                  value={customerName}
                                  onChange={(e) =>
                                    setCustomerName(e.target.value)
                                  }
                                  placeholder="e.g. Alice"
                                  maxLength={60}
                                  className="h-10 w-full rounded-xl border border-white/7 bg-[#171717] px-3 text-sm text-white outline-none transition placeholder:text-[#4f5868] focus:border-[#C1ED00]/40"
                                />
                              </div>
                              <button
                                onClick={() => void connectAndPay()}
                                className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#C1ED00] py-3.5 text-sm font-semibold text-[#0F1116] transition hover:bg-[#d4ff00]"
                              >
                                <Smartphone size={15} />
                                Pay {link.amountDisplay} {symbol(link)}
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => {
                                setBlipConnecting(true);
                                connectBlip()
                                  .catch((err) =>
                                    setStage({
                                      name: "error",
                                      message: parseError(err),
                                    }),
                                  )
                                  .finally(() => setBlipConnecting(false));
                              }}
                              disabled={blipConnecting}
                              className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#C1ED00] py-3.5 text-sm font-semibold text-[#0F1116] transition hover:bg-[#d4ff00] disabled:opacity-60"
                            >
                              {blipConnecting ? (
                                <Loader2 size={15} className="animate-spin" />
                              ) : (
                                <Smartphone size={15} />
                              )}
                              {blipConnecting
                                ? "Connecting…"
                                : "Connect Blip wallet"}
                            </button>
                          )}
                        </div>
                      </div>
                    ) : (
                      <>
                        {/* QR code */}
                        {pageUrl && (
                          <div className="mt-6 flex flex-col items-center rounded-2xl border border-white/7 bg-[#171717] p-6">
                            <div className="rounded-2xl bg-white p-3 shadow-md ring-4 ring-white/10">
                              <QRCode
                                value={pageUrl}
                                size={160}
                                level="M"
                                fgColor="#0F1116"
                              />
                            </div>
                            <p className="mt-4 text-sm font-medium text-white">
                              Scan to pay on mobile
                            </p>
                            <p className="mt-2 max-w-xs text-center text-xs leading-5 text-[#8b93a7]">
                              Opens this checkout on your phone — pay with Blip
                              or any browser wallet.
                            </p>
                          </div>
                        )}

                        {/* Wallet tabs */}
                        <div className="mt-6 overflow-hidden rounded-2xl border border-white/7 bg-[#171717]">
                          <div className="flex border-b border-white/7">
                            <button
                              onClick={() => setPayTab("blip")}
                              className={`flex flex-1 items-center justify-center gap-2 py-3 text-sm font-medium transition ${
                                payTab === "blip"
                                  ? "border-b-2 border-[#C1ED00] text-white"
                                  : "text-[#8b93a7] hover:text-white"
                              }`}
                            >
                              <Smartphone size={15} />
                              Pay with Blip
                            </button>
                            <button
                              onClick={() => setPayTab("wallet")}
                              className={`flex flex-1 items-center justify-center gap-2 py-3 text-sm font-medium transition ${
                                payTab === "wallet"
                                  ? "border-b-2 border-[#38bdf8] text-white"
                                  : "text-[#8b93a7] hover:text-white"
                              }`}
                            >
                              <Wallet size={15} />
                              Browser Wallet
                            </button>
                          </div>

                          {payTab === "blip" &&
                            pageUrl && (
                              <div className="flex flex-col items-center p-6">
                                <p className="mb-5 text-center text-xs leading-5 text-[#8b93a7]">
                                  Opens this checkout inside the Blip app — your
                                  wallet connects automatically.
                                </p>
                                <a
                                  href={
                                    isMobileViewport()
                                      ? blipDeepLink(pageUrl)
                                      : blipBrowserLink(pageUrl)
                                  }
                                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#C1ED00] py-3 text-sm font-semibold text-[#0F1116] transition hover:bg-[#d4ff00]"
                                >
                                  <Smartphone size={15} />
                                  Open in Blip app
                                </a>
                                <p className="mt-3 text-center text-xs text-[#4f5868]">
                                  {isMobileViewport() ? (
                                    <>
                                      Not opening?{" "}
                                      <a
                                        href={blipBrowserLink(pageUrl)}
                                        className="text-[#C1ED00] hover:underline"
                                      >
                                        Use the web link
                                      </a>
                                    </>
                                  ) : (
                                    <>
                                      Scan the QR above with your phone to pay
                                      in Blip.
                                    </>
                                  )}
                                </p>
                                <p className="mt-3 text-center text-xs text-[#4f5868]">
                                  Don&apos;t have Blip?{" "}
                                  <a
                                    href="https://blippay.me"
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-[#C1ED00] hover:underline"
                                  >
                                    Download Blip (iOS &amp; Android)
                                  </a>
                                </p>
                              </div>
                            )}

                          {payTab === "wallet" && (
                            <div className="p-6">
                              <div className="space-y-3">
                                {/* Customer name — captured before paying so it
                                    lands on the receipt. */}
                                <div>
                                  <p className="mb-2 text-sm text-[#8b93a7]">
                                    Your name (optional — appears on receipt)
                                  </p>
                                  <input
                                    type="text"
                                    value={customerName}
                                    onChange={(e) =>
                                      setCustomerName(e.target.value)
                                    }
                                    placeholder="e.g. Alice"
                                    maxLength={60}
                                    className="h-10 w-full rounded-xl border border-white/7 bg-[#171717] px-3 text-sm text-white outline-none transition placeholder:text-[#4f5868] focus:border-[#38bdf8]/40"
                                  />
                                </div>
                                {connected ? (
                                  <>
                                    <div className="rounded-xl border border-white/7 bg-[#171717] px-4 py-3 text-center">
                                      <p className="text-xs text-[#8b93a7]">
                                        Paying as
                                      </p>
                                      <p className="mt-1 break-all font-mono text-xs text-white">
                                        {connected}
                                      </p>
                                    </div>
                                    <button
                                      onClick={() => void connectAndPay()}
                                      className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#38bdf8] py-3.5 text-sm font-semibold text-[#061018] transition hover:bg-[#67d8ff]"
                                    >
                                      Pay {link.amountDisplay} {symbol(link)}
                                    </button>
                                  </>
                                ) : (
                                  <WalletSelector
                                    connectedAddress={null}
                                    onConnected={setConnected}
                                    label="Connect wallet to pay"
                                  />
                                )}
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Security badges */}
                        <div className="mt-5 flex items-center justify-center gap-5 text-xs text-[#8b93a7]">
                          <span className="flex items-center gap-1.5">
                            <LockKeyhole size={13} />
                            Secure
                          </span>
                          <span className="flex items-center gap-1.5">
                            <ShieldCheck size={13} />
                            Non-custodial
                          </span>
                        </div>
                      </>
                    )}
                  </>
                )}

                {/* Claiming state */}
                {stage.name === "claiming" && (
                  <div className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-white/7 bg-[#171717] py-3.5 text-sm text-[#8b93a7]">
                    <Loader2
                      size={16}
                      className="animate-spin text-[#38bdf8]"
                    />
                    Reserving your payment slot…
                  </div>
                )}

                {stage.name === "paying" && (
                  <div className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-white/7 bg-[#171717] py-3.5 text-sm text-[#8b93a7]">
                    <Loader2
                      size={16}
                      className="animate-spin text-[#38bdf8]"
                    />
                    {stage.step}
                  </div>
                )}

                {stage.name === "awaiting" && (
                  <div className="mt-4 flex w-full flex-col items-center gap-2 rounded-xl border border-white/7 bg-[#171717] py-3.5 text-sm text-[#8b93a7]">
                    <Loader2
                      size={16}
                      className="animate-spin text-[#38bdf8]"
                    />
                    Payment sent — waiting for on-chain confirmation…
                    <span className="text-xs">{stage.status}</span>
                  </div>
                )}
              </>
            )}

          {/* Error */}
          {stage.name === "error" && (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
              {stage.message}
              {needsFund && (
                <button
                  onClick={() => void fundAppWalletAndRetry()}
                  className="mt-2 block w-full rounded-lg bg-[#0b0f19] px-3 py-2 text-xs font-medium text-white"
                >
                  Fund app wallet &amp; retry
                </button>
              )}
              {errorDetail && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-[#8b93a7]">Error details</summary>
                  <div className="mt-1 flex items-start gap-2">
                    <pre className="max-h-32 flex-1 overflow-auto whitespace-pre-wrap break-all rounded bg-white/60 p-2 font-mono text-[10px] leading-4 text-red-500">
                      {errorDetail}
                    </pre>
                    <button
                      onClick={() =>
                        void navigator.clipboard
                          .writeText(errorDetail)
                          .catch(() => undefined)
                      }
                      className="rounded border border-red-200 px-2 py-1 text-[10px] hover:bg-red-100"
                    >
                      Copy
                    </button>
                  </div>
                </details>
              )}
              <button
                onClick={() => setStage({ name: "ready" })}
                className="mt-2 block text-xs text-[#38bdf8] hover:underline"
              >
                Try again
              </button>
            </div>
          )}
        </div>

        <p className="mt-5 text-center text-xs text-[#4f5868]">
          Checkout powered by TripplePay || Marchants — payment goes directly to the
          merchant&apos;s wallet.
        </p>
      </div>
    </main>
  );
}
