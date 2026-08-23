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
  Wallet,
} from "lucide-react";
import { useEffect, useState, useRef } from "react";
import { toPng } from "html-to-image";
import { Receipt } from "@/components/ui/receipt";
import QRCode from "react-qr-code";
import { formatQuai, formatUnits, getAddress } from "quais";
import { Logo } from "@/components/logo";
import { WalletSelector } from "@/components/ui/wallet-selector";
import {
  ZERO_ADDRESS,
  fetchOrderStatus,
  getOrderOnChain,
  payOrder,
  payOrderNative,
  requestBlipAppWalletTopUp,
  waitForOnChainConfirmation,
  type OnChainOrder,
} from "@/lib/payment";
import {
  blipBrowserLink,
  blipDeepLink,
  checkoutPageUrl,
  isInsideBlipBrowser,
  isMobileViewport,
} from "@/lib/blip";
import {
  connectWallet,
  detectWallets,
  getActiveWallet,
  storeWalletId,
} from "@/lib/wallets";
import { parseError, rawErrorText } from "@/lib/utils";

type Params = Promise<{ merchant: string; orderId: string }>;

type Stage =
  | { name: "loading" }
  | { name: "notfound" }
  | { name: "expired" }
  | { name: "settled" }
  | { name: "ready" }
  | { name: "paying"; step: string }
  | { name: "awaiting"; status: string }
  | { name: "done"; txHash: string; net: string; symbol: string }
  | { name: "error"; message: string };

function isExpired(expiry: bigint): boolean {
  return expiry > 0n && Math.floor(Date.now() / 1000) > Number(expiry);
}

export default function CheckoutPage({ params }: { params: Params }) {
  const [stage, setStage] = useState<Stage>({ name: "loading" });
  const [merchant, setMerchant] = useState("");
  const [orderId, setOrderId] = useState("");
  const [customerName, setCustomerName] = useState("");
  const receiptRef = useRef<HTMLDivElement>(null);
  const [downloading, setDownloading] = useState(false);

  const downloadReceipt = async () => {
    if (!receiptRef.current) return;
    try {
      setDownloading(true);
      const dataUrl = await toPng(receiptRef.current, { cacheBust: true });
      const link = document.createElement("a");
      link.download = `receipt-${orderId.slice(0, 8)}.png`;
      link.href = dataUrl;
      link.click();
    } catch (err) {
      console.error(err);
    } finally {
      setDownloading(false);
    }
  };
  const [order, setOrder] = useState<OnChainOrder | null>(null);
  const [payTab, setPayTab] = useState<"blip" | "wallet">("wallet");
  const [connected, setConnected] = useState<string | null>(null);
  const [needsFund, setNeedsFund] = useState(false);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [blipConnecting, setBlipConnecting] = useState(false);
  const [insideBlip, setInsideBlip] = useState(false);
  const [checkoutUrl, setCheckoutUrl] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      setInsideBlip(isInsideBlipBrowser());
      if (merchant && orderId) {
        setCheckoutUrl(checkoutPageUrl(merchant, orderId));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [merchant, orderId]);

  // Blip's in-app browser can inject window.quai a moment after first paint — keep
  // polling so the "Pay with Blip" panel appears instead of the "Open in Blip" loop.
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

  /** Connects the Blip wallet — only ever called from an explicit user click. */
  const connectBlip = async () => {
    const blip = detectWallets().find((w) => w.brand === "blip");
    if (!blip) return;
    setBlipConnecting(true);
    try {
      const addr = await connectWallet(blip);
      storeWalletId(blip.id);
      setConnected(addr);
    } catch {
      // user declined or wallet locked — they can tap Connect again
    } finally {
      setBlipConnecting(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { merchant: m, orderId: id } = await params;
      if (cancelled) return;
      setMerchant(m);
      setOrderId(id);
      try {
        let o = await getOrderOnChain(m, id);
        if (!o?.exists) {
          const status = await fetchOrderStatus(m, id);
          if (!status) {
            setStage({ name: "notfound" });
            return;
          }
          o = {
            merchant: m,
            settled: status.settled,
            exists: true,
            feeBps: status.feeBps,
            token: status.token,
            amount: BigInt(status.amount),
            expiry: BigInt(status.expiry),
            feeRecipient: ZERO_ADDRESS,
            settledAt: 0n,
            expectedPayer: ZERO_ADDRESS,
            nonce: 0n,
          };
        }
        if (!o) {
          setStage({ name: "notfound" });
          return;
        }
        setOrder(o);
        if (!o.exists) {
          setStage({ name: "notfound" });
        } else if (o.settled) {
          setStage({ name: "settled" });
        } else if (isExpired(o.expiry)) {
          setStage({ name: "expired" });
        } else {
          setStage({ name: "ready" });
        }
      } catch {
        setStage({ name: "error", message: "Could not load this order — try again." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params]);

  const isNative = (o: OnChainOrder) =>
    o.token.toLowerCase() === ZERO_ADDRESS.toLowerCase();

  const symbol = (o: OnChainOrder) => (isNative(o) ? "QUAI" : "mUSDQ");

  const formatAmount = (o: OnChainOrder, amount: bigint) =>
    isNative(o) ? formatQuai(amount) : formatUnits(amount, 6);

  const netAmount = (o: OnChainOrder) =>
    o.amount - (o.amount * BigInt(o.feeBps)) / 10000n;

  const payerAllowed = (o: OnChainOrder) => {
    if (o.expectedPayer === ZERO_ADDRESS) return true;
    return (
      connected !== null &&
      o.expectedPayer.toLowerCase() === connected.toLowerCase()
    );
  };

  const connectAndPay = async () => {
    if (!order) return;
    setNeedsFund(false);
    const wallet = getActiveWallet();
    if (!wallet) {
      setStage({
        name: "error",
        message: "No wallet connected — pick a wallet above.",
      });
      return;
    }
    if (!payerAllowed(order)) {
      setStage({
        name: "error",
        message: `This order is reserved for ${order.expectedPayer} — your wallet cannot settle it.`,
      });
      return;
    }
    // Token orders must carry a well-formed address — a malformed one would otherwise die
    // deep inside the wallet's own tx-building stack with a cryptic null-target error.
    if (!isNative(order)) {
      try {
        getAddress(order.token);
      } catch {
        setStage({
          name: "error",
          message: "This order's currency is misconfigured (invalid token address) — please contact the merchant.",
        });
        return;
      }
    }
    let phase = "prepare";
    try {
      setStage({ name: "paying", step: "Awaiting wallet approval…" });
      phase = "send";
      const txHash = isNative(order)
        ? await payOrderNative(order.merchant, orderId, order.amount)
        : await payOrder(order.merchant, orderId, order.token, order.amount);
      phase = "confirm";
      setStage({ name: "awaiting", status: "Waiting for block confirmation…" });
      const settled = await waitForOnChainConfirmation(
        order.merchant,
        orderId,
        (status) => setStage({ name: "awaiting", status }),
      );
      if (!settled) {
        throw new Error("Payment was not confirmed on-chain — check your wallet and try again.");
      }
      setStage({
        name: "done",
        txHash,
        net: formatAmount(order, netAmount(order)),
        symbol: symbol(order),
      });
    } catch (err: unknown) {
      setNeedsFund((err as { needsFunding?: boolean })?.needsFunding === true);
      setErrorDetail(
        `phase: ${phase} | wallet: ${wallet?.brand ?? "?"} | currency: ${isNative(order) ? "native" : "token"} | ` +
          rawErrorText(err),
      );
      setStage({
        name: "error",
        message: parseError(err),
      });
    }
  };

  // Blip app wallets are often empty — when a payment fails for lack of funds, let the user
  // pull QUAI from their main vault (Blip's funding sheet) and retry in one tap.
  const fundAppWalletAndRetry = async () => {
    if (!order) return;
    try {
      await requestBlipAppWalletTopUp(order.amount);
    } catch {
      // Still short — fall through to the retry, which re-checks and reports clearly.
    }
    void connectAndPay();
  };

  if (stage.name === "done") {
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
          <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-[#8b93a7]">
            Your payment settled on-chain. The merchant will be notified automatically.
          </p>
          <div className="mt-6 space-y-2 rounded-2xl border border-white/7 bg-[#171717] p-4 text-left font-mono text-xs text-[#8b93a7]">
            <p className="break-all">
              tx: <span className="text-white">{stage.txHash}</span>
            </p>
            <p className="break-all">
              order: <span className="text-white">{orderId.slice(0, 20)}…</span>
            </p>
          </div>
          <div className="mt-5 flex flex-col items-center gap-3">
            <button
              onClick={downloadReceipt}
              disabled={downloading}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-white/10 px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/20 disabled:opacity-50"
            >
              {downloading ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
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
          <div className="absolute left-[-9999px] top-0 opacity-0 pointer-events-none">
            <Receipt
              ref={receiptRef}
              amount={stage.net}
              symbol={stage.symbol}
              merchantAddress={merchant}
              orderId={orderId}
              txHash={stage.txHash}
              date={new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              customerName={customerName || undefined}
            />
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#171717] px-5 py-10 text-white">
      <div className="mx-auto max-w-lg">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-[#8b93a7] hover:text-[#061018]"
        >
          <ArrowLeft size={15} />
          TripplePay || Marchants
        </Link>

        <div className="mt-10 rounded-3xl border border-white/7 bg-[#171717] p-6 sm:p-8">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold">Secure checkout</p>
              <p className="mt-1 text-xs text-[#8b93a7]">
                Pay with Quai — non-custodial
              </p>
            </div>
            <Logo className="h-10 w-10" />
          </div>

          <div className="my-7 h-px bg-[#171717]/4" />

          {stage.name === "loading" && (
            <div className="flex flex-col items-center gap-3 py-12 text-sm text-[#8b93a7]">
              <Loader2 size={18} className="animate-spin text-[#38bdf8]" />
              Loading order…
            </div>
          )}

          {stage.name === "notfound" && (
            <div className="py-10 text-center">
              <p className="text-sm font-medium text-white">Order not found</p>
              <p className="mx-auto mt-2 max-w-sm text-xs leading-5 text-[#8b93a7]">
                No order matches this link — it may not have been registered
                yet, or the address is wrong. Ask the merchant for a fresh
                payment link.
              </p>
            </div>
          )}

          {stage.name === "expired" && (
            <div className="py-10 text-center">
              <p className="text-sm font-medium text-white">Order expired</p>
              <p className="mx-auto mt-2 max-w-sm text-xs leading-5 text-[#8b93a7]">
                This payment link has passed its expiry. Ask the merchant to
                issue a new one.
              </p>
            </div>
          )}

          {stage.name === "settled" && (
            <div className="py-10 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-emerald-400/20 bg-emerald-400/10 text-emerald-300">
                <Check size={24} />
              </div>
              <p className="mt-4 text-sm font-medium text-white">Already paid</p>
              <p className="mx-auto mt-2 max-w-sm text-xs leading-5 text-[#8b93a7]">
                This order was settled. The merchant has been notified via
                webhook.
              </p>
            </div>
          )}

          {["ready", "paying", "awaiting"].includes(stage.name) && order && (
            <>
              <div className="text-center">
                <p className="text-sm text-[#8b93a7]">Total to pay</p>
                <p className="mt-2 text-5xl font-semibold tracking-tight">
                  {formatAmount(order, order.amount)}
                </p>
                <p className="mt-1 text-sm text-[#38bdf8]">{symbol(order)}</p>
                {order.feeBps > 0 && (
                  <p className="mt-2 text-xs text-[#8b93a7]">
                    includes {(order.feeBps / 100).toFixed(1)}% platform fee ·
                    merchant receives{" "}
                    <span className="text-white">
                      {formatAmount(order, netAmount(order))} {symbol(order)}
                    </span>
                  </p>
                )}
                {order.expiry > 0n && (
                  <p className="mt-1 flex items-center justify-center gap-1.5 text-xs text-[#8b93a7]">
                    <Clock size={12} />
                    expires{" "}
                    {new Date(Number(order.expiry) * 1000).toLocaleString()}
                  </p>
                )}
              </div>

              <div className="mt-5 rounded-xl border border-white/7 bg-[#171717] px-4 py-3">
                <p className="text-xs text-[#8b93a7]">Pay to merchant</p>
                <p className="mt-1 break-all font-mono text-xs text-white">
                  {order.merchant}
                </p>
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
                    <div className="mt-6 rounded-2xl border border-[#C1ED00]/25 bg-[#171717] p-6">
                      <p className="text-center text-sm font-medium text-white">
                        Pay with Blip
                      </p>
                      <p className="mt-2 text-center text-xs leading-5 text-[#8b93a7]">
                        Confirm in Blip to settle this order on PayWithQuai —
                        the merchant gets the same webhook as a browser wallet
                        payment.
                      </p>
                      <div className="mt-5 space-y-3">
                        {connected ? (
                          <>
                            <div className="rounded-xl border border-white/7 bg-[#171717] px-4 py-3 text-center">
                              <p className="text-xs text-[#8b93a7]">Paying as</p>
                              <p className="mt-1 break-all font-mono text-xs text-white">
                                {connected}
                              </p>
                            </div>
                            {!payerAllowed(order) && (
                              <p className="rounded-xl border border-amber-400/20 bg-amber-400/6 px-4 py-3 text-center text-xs text-amber-300">
                                This order is reserved for another wallet —
                                you can&apos;t settle it.
                              </p>
                            )}
                            <button
                              onClick={() => void connectAndPay()}
                              disabled={!payerAllowed(order)}
                              className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#C1ED00] py-3.5 text-sm font-semibold text-[#0F1116] transition hover:bg-[#d4ff00] disabled:opacity-50"
                            >
                              <Smartphone size={15} />
                              Pay {formatAmount(order, order.amount)}{" "}
                              {symbol(order)}
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => void connectBlip()}
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
                      {checkoutUrl && (
                        <div className="mt-6 flex flex-col items-center rounded-2xl border border-white/7 bg-[#171717] p-6">
                          <div className="rounded-2xl bg-white p-3 shadow-md ring-4 ring-white/10">
                            <QRCode
                              value={checkoutUrl}
                              size={160}
                              level="M"
                              fgColor="#0F1116"
                            />
                          </div>
                          <p className="mt-4 text-sm font-medium text-white">
                            Scan to pay
                          </p>
                          <p className="mt-2 max-w-xs text-center text-xs leading-5 text-[#8b93a7]">
                            Opens this checkout on your phone — pay with Blip
                            (in-app browser) or any browser wallet (Pelagus,
                            MetaMask).
                          </p>
                        </div>
                      )}

                      <div className="mt-6 overflow-hidden rounded-2xl border border-white/7 bg-[#171717]">
                        <div className="flex border-b border-white/7">
                          {isNative(order) && (
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
                          )}
                          <button
                            onClick={() => setPayTab("wallet")}
                            className={`flex flex-1 items-center justify-center gap-2 py-3 text-sm font-medium transition ${
                              payTab === "wallet" || !isNative(order)
                                ? "border-b-2 border-[#38bdf8] text-white"
                                : "text-[#8b93a7] hover:text-white"
                            }`}
                          >
                            <Wallet size={15} />
                            Browser Wallet
                          </button>
                        </div>

                        {payTab === "blip" && isNative(order) && checkoutUrl && (
                          <div className="flex flex-col items-center p-6">
                            <p className="mb-5 text-center text-xs leading-5 text-[#8b93a7]">
                              Opens this checkout inside the Blip app. Tap Pay
                              there to settle the order on-chain — the merchant
                              dashboard updates via webhook, same as wallet
                              connect.
                            </p>
                            <a
                              href={
                                isMobileViewport()
                                  ? blipDeepLink(checkoutUrl)
                                  : blipBrowserLink(checkoutUrl)
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
                                    href={blipBrowserLink(checkoutUrl)}
                                    className="text-[#C1ED00] hover:underline"
                                  >
                                    Use the web link
                                  </a>
                                </>
                              ) : (
                                <>
                                  Scan the QR above with your phone to pay in
                                  Blip.
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
                                Download Blip (iOS & Android)
                              </a>
                            </p>
                          </div>
                        )}

                        {payTab === "wallet" && (
                          <div className="p-6">
                            <p className="mb-4 text-center text-xs text-[#8b93a7]">
                              Connect any Quai-compatible browser wallet
                              (Pelagus, Blip in-app browser, or MetaMask).
                            </p>
                            {connected ? (
                              <div className="space-y-3">
                                <div className="rounded-xl border border-white/7 bg-[#171717] px-4 py-3 text-center">
                                  <p className="text-xs text-[#8b93a7]">
                                    Paying as
                                  </p>
                                  <p className="mt-1 break-all font-mono text-xs text-white">
                                    {connected}
                                  </p>
                                </div>
                                {!payerAllowed(order) && (
                                  <p className="rounded-xl border border-amber-400/20 bg-amber-400/6 px-4 py-3 text-center text-xs text-amber-300">
                                    This order is reserved for another wallet —
                                    you can&apos;t settle it.
                                  </p>
                                )}
                                <button
                                  onClick={() => void connectAndPay()}
                                  disabled={!payerAllowed(order)}
                                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#38bdf8] py-3.5 text-sm font-semibold text-[#061018] transition hover:bg-[#67d8ff] disabled:opacity-50"
                                >
                                  Pay {formatAmount(order, order.amount)}{" "}
                                  {symbol(order)}
                                </button>
                              </div>
                            ) : (
                              <WalletSelector
                                connectedAddress={null}
                                onConnected={setConnected}
                                label="Connect wallet to pay"
                              />
                            )}
                          </div>
                        )}
                      </div>
                    </>
                  )}

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

                  {/* Optional customer name — stored client-side only, shown on receipt */}
                  <div className="mt-5">
                    <p className="mb-2 text-sm text-[#8b93a7]">Your name (optional — appears on receipt)</p>
                    <input
                      type="text"
                      value={customerName}
                      onChange={(e) => setCustomerName(e.target.value)}
                      placeholder="e.g. Alice"
                      maxLength={60}
                      className="h-10 w-full rounded-xl border border-white/7 bg-[#171717] px-3 text-sm text-white outline-none transition placeholder:text-[#4f5868] focus:border-[#38bdf8]/40"
                    />
                  </div>
                </>
              )}

              {stage.name === "paying" && (
                <div className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-white/7 bg-[#171717] py-3.5 text-sm text-[#8b93a7]">
                  <Loader2 size={16} className="animate-spin text-[#38bdf8]" />
                  {stage.step}
                </div>
              )}

              {stage.name === "awaiting" && (
                <div className="mt-4 flex w-full flex-col items-center gap-2 rounded-xl border border-white/7 bg-[#171717] py-3.5 text-sm text-[#8b93a7]">
                  <Loader2 size={16} className="animate-spin text-[#38bdf8]" />
                  Payment sent — waiting for on-chain confirmation…
                  <span className="text-xs">{stage.status}</span>
                </div>
              )}
            </>
          )}

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
                onClick={() => {
                  setStage({ name: "loading" });
                  void (async () => {
                    try {
                      const o = await getOrderOnChain(merchant, orderId);
                      setOrder(o);
                      setStage({ name: "ready" });
                    } catch {
                      setStage({ name: "error", message: "Could not load this order." });
                    }
                  })();
                }}
                className="mt-2 block text-xs text-[#38bdf8] hover:underline"
              >
                Try again
              </button>
            </div>
          )}
        </div>

        <p className="mt-5 text-center text-xs text-[#4f5868]">
          Checkout powered by PayWithQuai — the merchant registered this order
          on-chain; your payment goes directly to their wallet.
        </p>
      </div>
    </main>
  );
}
