"use client";

import Link from "next/link";
import {
  ArrowLeft,
  Check,
  Download,
  Loader2,
  LockKeyhole,
  ShieldCheck,
  Smartphone,
  Wallet,
} from "lucide-react";
import { useState, useRef } from "react";
import { toPng } from "html-to-image";
import { Receipt } from "@/components/ui/receipt";
import { Logo } from "@/components/logo";
import QRCode from "react-qr-code";

// Blip deep-link: opens the Blip mobile wallet (iOS & Android) directly to a pre-filled payment screen.
// Format confirmed from blippay.me in-app browser integration docs.
// Replace DEMO_MERCHANT_ADDRESS with your real merchant address in production.
const DEMO_MERCHANT_ADDRESS = "0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7";
function blipDeepLink(amount: string, label: string) {
  return `blip://pay?to=${DEMO_MERCHANT_ADDRESS}&amount=${amount}&label=${encodeURIComponent(label)}`;
}
import {
  newOrderId,
} from "@/lib/payment";
import { parseError } from "@/lib/utils";

const AMOUNT_QUAI = "25.0";

type Stage =
  | { name: "start" }
  | { name: "connect" }
  | { name: "ready"; merchant: string }
  | { name: "signing"; step: string }
  | { name: "awaiting"; merchant: string; orderId: string; webhook: string | null }
  | { name: "done"; merchant: string; orderId: string; txHash: string }
  | { name: "error"; message: string };

export default function CheckoutDemoPage() {
  const [stage, setStage] = useState<Stage>({ name: "start" });
  const [payTab, setPayTab] = useState<"blip" | "wallet">("blip");
  const [isConnectingWallet, setIsConnectingWallet] = useState(false);
  const receiptRef = useRef<HTMLDivElement>(null);
  const [downloading, setDownloading] = useState(false);

  const downloadReceipt = async (orderId: string) => {
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

  const pay = async () => {
    if (stage.name !== "ready") return;
    const merchant = stage.merchant;
    const orderId = newOrderId();
    try {
      setStage({ name: "signing", step: "Awaiting wallet approval…" });
      
      // Simulate waiting for wallet popup
      await new Promise((resolve) => setTimeout(resolve, 1500));
      
      setStage({ name: "signing", step: "Processing payment on Quai Network…" });
      
      // Simulate network processing
      await new Promise((resolve) => setTimeout(resolve, 2000));
      
      setStage({
        name: "awaiting",
        merchant,
        orderId,
        webhook: null,
      });
      
      // Simulate relayer confirmation
      await new Promise((resolve) => setTimeout(resolve, 2500));
      
      setStage({
        name: "awaiting",
        merchant,
        orderId,
        webhook: "received",
      });
      
      await new Promise((resolve) => setTimeout(resolve, 1000));
      
      setStage({
        name: "done",
        merchant,
        orderId,
        txHash: "0x" + Array(64).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join(""),
      });
    } catch (err: unknown) {
      setStage({ name: "error", message: parseError(err) });
    }
  };

  if (stage.name === "done") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#171717] px-5 text-white">
        <div className="w-full max-w-md text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-emerald-400/20 bg-emerald-400/10 text-emerald-300">
            <Check size={28} />
          </div>

          <p className="mt-6 text-sm text-emerald-300">
            Payment confirmed (simulated)
          </p>
          <h1 className="mt-2 text-3xl font-semibold">
            {AMOUNT_QUAI} QUAI received
          </h1>
          <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-[#8b93a7]">
            In a real checkout, the merchant would now receive a signed{" "}
            <code>payment.confirmed</code> webhook from the relayer. This demo
            stops at the simulated confirmation — no transaction exists.
          </p>

          <div className="mt-6 space-y-2 rounded-2xl border border-white/7 bg-[#171717] p-4 text-left font-mono text-xs text-[#8b93a7]">
            <p className="break-all">
              tx: <span className="text-white">{stage.txHash}</span>
            </p>
            <p className="break-all">
              order:{" "}
              <span className="text-white">{stage.orderId.slice(0, 20)}…</span>
            </p>
          </div>

          <div className="mt-5 flex flex-col items-center gap-3">
            <button
              onClick={() => downloadReceipt(stage.orderId)}
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
              Return to TripplePay || Merchants
            </Link>
          </div>
          <div className="absolute left-[-9999px] top-0 opacity-0 pointer-events-none">
            <Receipt
              ref={receiptRef}
              amount="25.0"
              symbol="QUAI"
              merchantAddress={stage.merchant}
              orderId={stage.orderId}
              txHash={stage.txHash}
              date={new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
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
          TripplePay || Merchants
        </Link>

        <div className="mt-10 rounded-3xl border border-white/7 bg-[#171717] p-6 sm:p-8">
          <div className="mb-6 rounded-xl border border-[#C1ED00]/25 bg-[#C1ED00]/6 px-4 py-3">
            <p className="text-xs font-medium text-[#C1ED00]">
              Simulation — no real payment is made. The wallet connect and
              confirmation steps below are mocked for the demo.
            </p>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold">Quai Store</p>
              <p className="mt-1 text-xs text-[#8b93a7]">Secure checkout</p>
            </div>

            <Logo className="h-10 w-10" />
          </div>

          <div className="my-7 h-px bg-[#171717]/4" />

          <div className="text-center">
            <p className="text-sm text-[#8b93a7]">Total to pay</p>
            <p className="mt-2 text-5xl font-semibold tracking-tight">
              {AMOUNT_QUAI}
            </p>
            <p className="mt-1 text-sm text-[#38bdf8]">QUAI</p>
            <p className="mt-2 text-xs text-[#8b93a7]">
              ≈ $20.00 USD · Quai mainnet
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

          {stage.name === "start" && (
            <div className="mt-6 flex flex-col items-center">
              <button
                onClick={() => setStage({ name: "connect" })}
                className="flex w-full items-center justify-center rounded-xl bg-[#C1ED00] py-3.5 text-sm font-semibold text-[#0F1116] transition hover:bg-[#d4ff00]"
              >
                Check out your order with TripplePay || Merchants
              </button>
            </div>
          )}

          {stage.name === "connect" && (
            <div className="mt-6 overflow-hidden rounded-2xl border border-white/7 bg-[#171717]">
              {/* Tab switcher */}
              <div className="flex overflow-x-auto hide-scrollbar border-b border-white/7">
                <button
                  onClick={() => setPayTab("blip")}
                  className={`flex min-w-[140px] flex-1 shrink-0 whitespace-nowrap items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition ${
                    payTab === "blip"
                      ? "border-b-2 border-[#C1ED00] text-white"
                      : "text-[#8b93a7] hover:text-white"
                  }`}
                >
                  <svg viewBox="0 0 100 100" className="h-4 w-4 shrink-0">
                    <circle cx="50" cy="50" r="50" fill="#C1ED00"/>
                    <path fill="#0F1116" d="m98.3 24.4c0-7.2-6.9-13.9-18.2-13.9-7.1-0.1-15.7 2-19.8 8.6-2.6-1.8-6.3-3.9-12.6-3.9-6.8 0-13.4 2.5-16.8 8.2-3.2-1.9-6.5-3.2-12.1-3.2-8.9 0-16.8 4.4-16.8 11.7v19.9c2.4 9.2 14.2 26 47.5 34.9 3.9 0.9 9.1 1.9 12.6 2.4 7.3 0.7 17.8-1.5 19.7-9.6 0.4-1.8 0-8.5 0.2-8.5 2.6-0.6 7.9-3.7 8.6-9.3v-8.4c3.2-1.3 7.7-4.8 7.7-10.2v-18.7z"/>
                    <path fill="#C1ED00" d="m58.4 26.6c-1.3-3.5-6.5-5.1-10.7-5-6.3 0-12.5 2.9-11.1 7 2.5 6.9 11.1 15.4 25.9 18.6 3.7 0.9 7.6 1.4 10.9 1.5 10.1 0 14-7 7.7-10.5-3.3-1.8-5.7-1.6-7.7-2-5.7-0.8-12.7-3.6-15-9.6zm-28.8 4.3c-1.5-2.7-6-4.6-10.8-4.6-6.7 0-12.5 3.2-10.9 7.3 3 8 13.7 20.3 35.6 26.9 4.9 1.6 11.1 2.9 16 3.7 12 2 19.6-3.7 15-8-2.9-2.4-5.9-2.7-7.8-3-13.2-1.6-32.1-8.6-37.1-22.3zm49.3-14.1c-7.8 0-13.7 3.6-13.7 7.4 0 2.9 3.9 7.2 13.2 7.3 8.2 0 14-3.3 14-7.1 0.1-3.2-4-7.4-13.5-7.6z"/>
                  </svg>
                  Pay with Blip
                </button>
                <button
                  onClick={() => setPayTab("wallet")}
                  className={`flex min-w-[140px] flex-1 shrink-0 whitespace-nowrap items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition ${
                    payTab === "wallet"
                      ? "border-b-2 border-[#38bdf8] text-white"
                      : "text-[#8b93a7] hover:text-white"
                  }`}
                >
                  <Wallet size={15} />
                  Browser Wallet
                </button>
              </div>

              {/* Blip tab */}
              {payTab === "blip" && (
                <div className="flex flex-col items-center p-6">
                  {/* QR encodes a Blip deep-link so scanning auto-opens the Blip app (iOS & Android) */}
                  <div className="mb-4 rounded-2xl bg-white p-3 shadow-md ring-4 ring-[#C1ED00]/20">
                    <QRCode
                      value={blipDeepLink(AMOUNT_QUAI, "Quai Store")}
                      size={160}
                      level="M"
                      fgColor="#0F1116"
                    />
                  </div>

                  <p className="mb-1 text-sm font-medium text-white">
                    Scan with Blip
                  </p>
                  <p className="mb-5 text-center text-xs text-[#8b93a7]">
                    Open the Blip app → tap <span className="font-medium text-white">Scan</span> → payment pre-fills automatically.
                  </p>

                  {/* "Open in Blip" deep-link — works when viewing on mobile */}
                  <a
                    href={blipDeepLink(AMOUNT_QUAI, "Quai Store")}
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#C1ED00] py-3 text-sm font-semibold text-[#0F1116] transition hover:bg-[#d4ff00]"
                  >
                    <Smartphone size={15} />
                    Open in Blip app
                  </a>

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

              {/* Browser wallet tab (Mocked for demo) */}
              {payTab === "wallet" && (
                <div className="p-6">
                  <p className="mb-4 text-center text-xs text-[#8b93a7]">
                    Connect any Quai-compatible browser extension.
                  </p>
                  
                  <button
                    onClick={() => {
                      setIsConnectingWallet(true);
                      setTimeout(() => {
                        setIsConnectingWallet(false);
                        setStage({ name: "ready", merchant: "0xDEM0a9C84E0d7005b8D95b8D70188b69324Demo" });
                      }, 1000);
                    }}
                    disabled={isConnectingWallet}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#38bdf8] px-5 py-2.5 text-sm font-semibold text-[#061018] transition hover:bg-[#67d8ff] disabled:opacity-60"
                  >
                    {isConnectingWallet ? (
                      <Loader2 size={15} className="animate-spin" />
                    ) : (
                      <Wallet size={15} />
                    )}
                    Connect wallet to pay
                  </button>
                  
                  <p className="mt-5 text-center text-xs text-[#4f5868]">
                    (This is a demo. No real wallet connection required.)
                  </p>
                </div>
              )}
            </div>
          )}

          {stage.name === "ready" && (
            <>
              <div className="mt-4 rounded-xl border border-white/7 bg-[#171717] px-4 py-3">
                <p className="text-xs text-[#8b93a7]">
                  Connected (merchant + payer)
                </p>
                <p className="mt-1 break-all font-mono text-xs text-white">
                  {stage.merchant}
                </p>
              </div>

              <div className="mt-3">
                <button
                  disabled
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-white/7 bg-[#171717] px-4 py-2.5 text-sm font-medium text-[#c9d4e0]"
                >
                  <Wallet size={15} className="text-[#38bdf8]" />
                  <span className="max-w-56 truncate font-mono text-xs">
                    {stage.merchant}
                  </span>
                </button>
              </div>

              <button
                onClick={pay}
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-[#38bdf8] py-3.5 text-sm font-semibold text-[#061018] transition hover:bg-[#67d8ff]"
              >
                Pay {AMOUNT_QUAI} QUAI
                <ArrowLeft size={15} className="rotate-180" />
              </button>
            </>
          )}

          {stage.name === "signing" && (
            <div className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-white/7 bg-[#171717] py-3.5 text-sm text-[#8b93a7]">
              <Loader2 size={16} className="animate-spin text-[#38bdf8]" />
              {stage.step}
            </div>
          )}

          {stage.name === "awaiting" && (
            <div className="mt-4 flex w-full flex-col items-center gap-2 rounded-xl border border-white/7 bg-[#171717] py-3.5 text-sm text-[#8b93a7]">
              <Loader2 size={16} className="animate-spin text-[#38bdf8]" />
              Payment sent — waiting for relayer confirmation…
              <span className="text-xs">
                {stage.webhook
                  ? `webhook status: ${stage.webhook}`
                  : "waiting for the relayer to pick up PaymentReceived"}
              </span>
            </div>
          )}

          {stage.name === "error" && (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
              {stage.message}
              <button
                onClick={() => setStage({ name: "connect" })}
                className="mt-2 block text-xs text-[#38bdf8] hover:underline"
              >
                Try again
              </button>
            </div>
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
        </div>

        <p className="mt-5 text-center text-xs text-[#4f5868]">
          End-to-end simulation of the PayWithQuai checkout flow — the steps a
          real merchant checkout would run (register order → wallet approval →
          relayer confirmation) are mocked here; no funds move.
        </p>
      </div>
    </main>
  );
}