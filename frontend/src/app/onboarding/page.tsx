"use client";

import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  Loader2,
  Smartphone,
  Wallet,
} from "lucide-react";
import { useState } from "react";
import { parseError } from "@/lib/utils";
import { Logo } from "@/components/logo";
import { WalletSelector } from "@/components/ui/wallet-selector";
import { storeWalletId } from "@/lib/wallets";
import { useBlipContext } from "@/lib/blip";
import {
  DEFAULT_WEBHOOK_PATH,
  normalizeWebhookInput,
  webhookUrlPreview,
} from "@/lib/webhook";
import QRCode from "react-qr-code";

function BlipLogo({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={`shrink-0 ${className}`}>
      <circle cx="50" cy="50" r="50" fill="#C1ED00" />
      <path fill="#0F1116" d="m98.3 24.4c0-7.2-6.9-13.9-18.2-13.9-7.1-0.1-15.7 2-19.8 8.6-2.6-1.8-6.3-3.9-12.6-3.9-6.8 0-13.4 2.5-16.8 8.2-3.2-1.9-6.5-3.2-12.1-3.2-8.9 0-16.8 4.4-16.8 11.7v19.9c2.4 9.2 14.2 26 47.5 34.9 3.9 0.9 9.1 1.9 12.6 2.4 7.3 0.7 17.8-1.5 19.7-9.6 0.4-1.8 0-8.5 0.2-8.5 2.6-0.6 7.9-3.7 8.6-9.3v-8.4c3.2-1.3 7.7-4.8 7.7-10.2v-18.7z"/>
      <path fill="#C1ED00" d="m58.4 26.6c-1.3-3.5-6.5-5.1-10.7-5-6.3 0-12.5 2.9-11.1 7 2.5 6.9 11.1 15.4 25.9 18.6 3.7 0.9 7.6 1.4 10.9 1.5 10.1 0 14-7 7.7-10.5-3.3-1.8-5.7-1.6-7.7-2-5.7-0.8-12.7-3.6-15-9.6zm-28.8 4.3c-1.5-2.7-6-4.6-10.8-4.6-6.7 0-12.5 3.2-10.9 7.3 3 8 13.7 20.3 35.6 26.9 4.9 1.6 11.1 2.9 16 3.7 12 2 19.6-3.7 15-8-2.9-2.4-5.9-2.7-7.8-3-13.2-1.6-32.1-8.6-37.1-22.3zm49.3-14.1c-7.8 0-13.7 3.6-13.7 7.4 0 2.9 3.9 7.2 13.2 7.3 8.2 0 14-3.3 14-7.1 0.1-3.2-4-7.4-13.5-7.6z"/>
    </svg>
  );
}

const steps = ["Wallet", "Business", "Complete"];

interface OnboardedMerchant {
  merchantId: string;
  address: string;
  name: string;
  webhookUrl: string;
  webhookSecret: string;
}

export default function OnboardingPage() {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [address, setAddress] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [merchant, setMerchant] = useState<OnboardedMerchant | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [walletTab, setWalletTab] = useState<"blip" | "wallet">("blip");
  const [blipConnecting, setBlipConnecting] = useState(false);

  const { insideBlip, isMobile, blipLink, blipDeep } = useBlipContext();

  const complete = async () => {
    if (!address) return;
    if (!name.trim()) {
      setError("Enter a business name — it shows on your checkout page.");
      return;
    }
    // Webhook is OPTIONAL here — merchants can add or change it later in Settings.
    // A bare domain ("myshop.com") is completed to the default receiver path.
    let url = "";
    const rawWebhook = webhookUrl.trim();
    if (rawWebhook) {
      try {
        url = normalizeWebhookInput(rawWebhook);
      } catch (err) {
        setError(parseError(err));
        return;
      }
    }
    setRegistering(true);
    setError(null);
    try {
      // Server-only proxy: the ADMIN_API_KEY lives in process.env on the Next server and is
      // injected there (see app/api/admin/[...path]/route.ts) — it never enters this bundle.
      const res = await fetch("/api/admin/merchants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          url ? { address, name, webhookUrl: url } : { address, name },
        ),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(detail?.error ?? `registration failed (${res.status})`);
      }
      setMerchant((await res.json()) as OnboardedMerchant);
      setStep(2);
    } catch (err) {
      setError(parseError(err));
    } finally {
      setRegistering(false);
    }
  };

  const copySecret = async () => {
    if (!merchant) return;
    try {
      await navigator.clipboard.writeText(merchant.webhookSecret);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard unavailable — ignore
    }
  };

  const connectBlip = async () => {
    if (!window.quai) return;
    setBlipConnecting(true);
    setError(null);
    try {
      const accounts = (await window.quai.request({
        method: "quai_requestAccounts",
      })) as string[];
      if (!accounts?.length) throw new Error("Blip returned no accounts — unlock it first.");
      storeWalletId("blip:quai");
      setError(null);
      setAddress(accounts[0]);
    } catch (err) {
      setError(parseError(err));
    } finally {
      setBlipConnecting(false);
    }
  };



  return (
    <main className="min-h-screen bg-[#171717] px-5 py-8 text-white">
      <div className="mx-auto max-w-2xl">
        <header className="flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <Logo />
            <span className="text-sm font-semibold tracking-tight">
              TripplePay ||<span className="text-[#38bdf8]">Merchants</span>
            </span>
          </Link>

          <p className="text-sm text-[#38bdf8]">Merchant onboarding</p>
        </header>

        <div className="mx-auto mt-10 flex max-w-md items-center">
          {steps.map((label, index) => (
            <div key={label} className="flex flex-1 items-center last:flex-none">
              <div className="flex items-center gap-2">
                <div
                  className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ${
                    index < step
                      ? "bg-[#38bdf8] text-[#061018]"
                      : index === step
                        ? "border border-[#38bdf8]/40 text-white"
                        : "border border-white/7 text-[#8b93a7]"
                  }`}
                >
                  {index < step ? <Check size={13} /> : index + 1}
                </div>
                <span className="hidden text-xs text-[#8b93a7] sm:block">
                  {label}
                </span>
              </div>

              {index < steps.length - 1 && (
                <div className="mx-3 h-px flex-1 bg-[#171717]/4" />
              )}
            </div>
          ))}
        </div>

        <div className="mt-10 rounded-2xl border border-white/7 bg-[#171717] p-6 sm:p-8">
          {step === 0 && (
            <>
              <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-[#38bdf8]/15 bg-[#38bdf8]/6 text-[#38bdf8]">
                <Wallet size={21} />
              </div>

              <h2 className="mt-5 text-xl font-semibold">Connect your settlement wallet</h2>
              <p className="mt-1 text-sm leading-6 text-[#8b93a7]">
                This address can receive payments on every chain you create links on — merchants are chain-free.
              </p>

              {address ? (
                /* ── Wallet already connected ── */
                <div className="mt-6 rounded-xl border border-emerald-400/15 bg-emerald-400/6 px-4 py-3">
                  <p className="text-xs text-[#8b93a7]">Connected</p>
                  <p className="mt-1 break-all font-mono text-xs text-emerald-300">{address}</p>
                  {insideBlip && (
                    <p className="mt-2 text-xs leading-5 text-[#C1ED00]">
                      This is your Blip app wallet for this site — payouts settle here.
                    </p>
                  )}
                </div>
              ) : insideBlip ? (
                /* ── INSIDE Blip browser: one-tap connect ── */
                <div className="mt-6">
                  <div className="mb-4 flex items-center gap-3 rounded-2xl border border-[#C1ED00]/20 bg-[#C1ED00]/5 px-4 py-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#C1ED00]">
                      <BlipLogo className="h-5 w-5" />
                    </span>
                    <p className="text-sm text-[#C1ED00]">You&apos;re inside Blip — connect in one tap.</p>
                  </div>
                  <button
                    onClick={() => void connectBlip()}
                    disabled={blipConnecting}
                    className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#C1ED00] text-sm font-semibold text-[#0F1116] transition hover:bg-[#d4ff00] disabled:opacity-60"
                  >
                    {blipConnecting ? <Loader2 size={15} className="animate-spin" /> : <BlipLogo className="h-4 w-4" />}
                    {blipConnecting ? "Connecting…" : "Connect with Blip"}
                  </button>
                </div>
              ) : (
                /* ── OUTSIDE Blip: tab switcher — Blip Pay always shown first ── */
                <div className="mt-6 overflow-hidden rounded-2xl border border-white/7">
                  {/* Tab bar */}
                  <div className="flex border-b border-white/7">
                    <button
                      onClick={() => setWalletTab("blip")}
                      className={`flex flex-1 items-center justify-center gap-2 py-2.5 text-sm font-medium transition ${
                        walletTab === "blip" ? "border-b-2 border-[#C1ED00] text-white" : "text-[#8b93a7] hover:text-white"
                      }`}
                    >
                      <BlipLogo />
                      Blip Pay
                    </button>
                    <button
                      onClick={() => setWalletTab("wallet")}
                      className={`flex flex-1 items-center justify-center gap-2 py-2.5 text-sm font-medium transition ${
                        walletTab === "wallet" ? "border-b-2 border-[#38bdf8] text-white" : "text-[#8b93a7] hover:text-white"
                      }`}
                    >
                      <Wallet size={14} />
                      Browser Wallet
                    </button>
                  </div>

                  {/* ── Blip Pay tab — hero card always visible on ANY browser ── */}
                  {walletTab === "blip" && (
                    <div className="p-5">
                      {/* Hero card */}
                      <div className="rounded-2xl border border-[#C1ED00]/15 bg-[#C1ED00]/4 p-5">
                        <div className="flex items-center gap-3">
                          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#C1ED00]">
                            <BlipLogo className="h-5 w-5" />
                          </span>
                          <div>
                            <p className="text-sm font-semibold text-white">Onboard via Blip Pay</p>
                            <p className="text-xs text-[#8b93a7]">Self-custody mobile wallet for Quai</p>
                          </div>
                        </div>

                        <p className="mt-3 text-sm leading-6 text-[#8b93a7]">
                          Open this onboarding page inside the{" "}
                          <strong className="text-[#C1ED00]">Blip app</strong>{" "}
                          — your wallet connects in one tap and you can fill in your details right there.
                        </p>

                        {/* Mobile: deep-link buttons */}
                        {isMobile ? (
                          <div className="mt-4 space-y-2">
                            <a
                              href={blipDeep}
                              className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#C1ED00] py-2.5 text-sm font-semibold text-[#0F1116] transition hover:bg-[#d4ff00]"
                            >
                              <Smartphone size={15} />
                              Open in Blip app
                            </a>
                            <a
                              href={blipLink}
                              className="flex w-full items-center justify-center gap-2 rounded-xl border border-[#C1ED00]/25 bg-[#C1ED00]/5 py-2.5 text-sm font-medium text-[#C1ED00] transition hover:border-[#C1ED00]/50"
                            >
                              <ExternalLink size={13} />
                              Use Blip web link
                            </a>
                          </div>
                        ) : (
                          /* Desktop: QR code + web-link button */
                          <div className="mt-4 flex flex-col items-center gap-4 sm:flex-row sm:items-start">
                            <div className="shrink-0 rounded-2xl bg-white p-3 shadow-md ring-4 ring-[#C1ED00]/20">
                              <QRCode value={blipDeep} size={120} level="M" fgColor="#0F1116" />
                            </div>
                            <div className="flex flex-1 flex-col gap-3 text-center sm:text-left">
                              <div>
                                <p className="text-sm font-medium text-white">Scan with your phone</p>
                                <p className="mt-1 text-xs text-[#8b93a7]">
                                  Opens this page inside Blip — wallet connects in one tap.
                                </p>
                              </div>
                              <a
                                href={blipLink}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#C1ED00]/25 bg-[#C1ED00]/5 py-2.5 text-sm font-medium text-[#C1ED00] transition hover:border-[#C1ED00]/50 sm:justify-start sm:px-4"
                              >
                                <ExternalLink size={13} />
                                Open Blip web link
                              </a>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Numbered steps guide */}
                      <div className="mt-4 space-y-2">
                        {[
                          "Open this page inside the Blip app",
                          'Tap "Connect with Blip" — wallet linked instantly',
                          "Fill in your business details and complete onboarding",
                        ].map((s, i) => (
                          <div key={s} className="flex items-start gap-3">
                            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#C1ED00]/10 text-[10px] font-bold text-[#C1ED00]">
                              {i + 1}
                            </span>
                            <p className="text-xs leading-5 text-[#8b93a7]">{s}</p>
                          </div>
                        ))}
                      </div>

                      <p className="mt-4 text-center text-xs text-[#4f5868]">
                        Don&apos;t have Blip?{" "}
                        <a href="https://blippay.me" target="_blank" rel="noreferrer" className="text-[#C1ED00] hover:underline">
                          Download Blip (iOS &amp; Android)
                        </a>
                      </p>
                    </div>
                  )}

                  {/* ── Browser Wallet tab ── */}
                  {walletTab === "wallet" && (
                    <div className="p-5">
                      <WalletSelector
                        connectedAddress={null}
                        onConnected={(addr) => {
                          setError(null);
                          setAddress(addr);
                        }}
                        label="Connect settlement wallet"
                        chain="any"
                        addressOnly
                      />
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {step === 1 && (
            <>
              <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-[#38bdf8]/15 bg-[#38bdf8]/6 text-[#38bdf8]">
                <Wallet size={21} />
              </div>

              <h2 className="mt-5 text-xl font-semibold">
                Tell us about your business
              </h2>
              <p className="mt-1 text-sm leading-6 text-[#8b93a7]">
                Used on the checkout and in the merchant dashboard.
              </p>

              <div className="mt-7 space-y-5">
                <div>
                  <label className="mb-2 block text-sm text-[#8b93a7]">
                    Business name
                  </label>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="TripplePay || Merchants"
                    name="qm-merchant-name"
                    autoComplete="off"
                    className="h-11 w-full rounded-xl border border-white/7 bg-[#171717] px-3 text-white outline-none placeholder:text-[#4f5868] focus:border-[#38bdf8]/40"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-sm text-[#8b93a7]">
                    Webhook domain{" "}
                    <span className="text-[#4f5868]">(optional)</span>
                  </label>
                  <div className="flex h-11 items-center overflow-hidden rounded-xl border border-white/7 bg-[#171717] focus-within:border-[#38bdf8]/40">
                    <span className="hidden border-r border-white/7 px-3 font-mono text-xs text-[#4f5868] sm:block">
                      https://
                    </span>
                    <input
                      value={webhookUrl}
                      onChange={(e) => setWebhookUrl(e.target.value)}
                      placeholder="yourdomain.com"
                      name="qm-webhook-domain"
                      autoComplete="off"
                      inputMode="url"
                      className="h-full w-full bg-transparent px-3 text-white outline-none placeholder:text-[#4f5868]"
                    />
                  </div>
                  <span className="mt-2 block text-xs text-[#4f5868]">
                    {webhookUrl.trim() ? (
                      webhookUrlPreview(webhookUrl) ? (
                        <>
                          We&apos;ll POST signed <code>payment.confirmed</code>{" "}
                          events to{" "}
                          <span className="break-all text-[#8b93a7]">
                            {webhookUrlPreview(webhookUrl)}
                          </span>
                        </>
                      ) : (
                        <>Enter a domain like myshop.com — we complete the rest.</>
                      )
                    ) : (
                      <>
                        Just your domain — we deliver to{" "}
                        <code>https://yourdomain{DEFAULT_WEBHOOK_PATH}</code>.
                        You can add or change this anytime in Settings.
                      </>
                    )}
                  </span>
                </div>
              </div>
            </>
          )}

          {step === 2 && merchant && (
            <div className="py-2 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-400/10 text-emerald-300">
                <Check size={24} />
              </div>

              <h2 className="mt-5 text-xl font-semibold">You&apos;re ready.</h2>
              <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-[#8b93a7]">
                {merchant.name} is registered and ready to accept payments.
                {merchant.webhookUrl ? (
                  <>
                    {" "}You&apos;ll receive <code>payment.confirmed</code> webhooks at{" "}
                    <span className="break-all text-[#8b93a7]">
                      {merchant.webhookUrl}
                    </span>
                    .
                  </>
                ) : (
                  <>
                    {" "}Add your webhook URL anytime in{" "}
                    <Link href="/dashboard/settings" className="text-[#38bdf8] hover:underline">
                      Settings
                    </Link>{" "}
                    to get notified when payments settle.
                  </>
                )}
              </p>

              <div className="mx-auto mt-6 max-w-md rounded-2xl border border-white/7 bg-[#171717] p-4 text-left">
                <p className="text-xs text-[#8b93a7]">Merchant ID</p>
                <p className="mt-1 break-all font-mono text-xs text-white">
                  {merchant.merchantId}
                </p>

                <p className="mt-4 text-xs text-[#8b93a7]">
                  Webhook secret (shown once — store it)
                </p>
                <div className="mt-1 flex items-center gap-2">
                  <p className="flex-1 break-all font-mono text-xs text-[#e0a95e]">
                    {merchant.webhookSecret}
                  </p>
                  <button
                    onClick={copySecret}
                    className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-white/7 px-2 py-1 text-xs text-[#8b93a7] hover:text-white"
                  >
                    <Copy size={12} />
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>

              <Link
                href="/login"
                className="mt-7 inline-flex items-center gap-2 rounded-xl bg-[#38bdf8] px-5 py-3 text-sm font-semibold text-[#061018] transition hover:bg-[#67d8ff]"
              >
                Log in to dashboard
                <ArrowRight size={15} />
              </Link>
            </div>
          )}

          {error && (
            <div className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
              {error}
            </div>
          )}

          {step < 2 && (
            <div className="mt-8 flex w-full">
              {step === 0 ? (
                <div className="flex w-full justify-end">
                  <button
                    onClick={() => {
                      if (!address) {
                        setError("Connect a wallet to continue — it receives your payouts.");
                        return;
                      }
                      setError(null);
                      setStep(1);
                    }}
                    disabled={!address}
                    className="inline-flex w-full sm:w-auto justify-center items-center gap-2 rounded-xl bg-[#38bdf8] px-5 py-2.5 text-sm font-semibold text-[#061018] hover:bg-[#67d8ff] disabled:opacity-60"
                  >
                    Continue
                    <ArrowRight size={15} />
                  </button>
                </div>
              ) : (
                <div className="flex w-full flex-col-reverse sm:flex-row items-center justify-between gap-6 sm:gap-4">
                  <button
                    onClick={() => setStep(0)}
                    className="inline-flex w-full sm:w-auto justify-center items-center gap-2 rounded-xl border border-white/10 px-5 py-2.5 text-sm font-semibold text-white hover:bg-white/5"
                  >
                    <ArrowLeft size={15} />
                    Previous
                  </button>
                  <div className="flex w-full flex-col sm:flex-row items-center gap-4 sm:justify-end">
                    <label className="flex items-center gap-2 cursor-pointer text-sm text-[#8b93a7]">
                      <input 
                        type="checkbox" 
                        checked={agreed} 
                        onChange={(e) => setAgreed(e.target.checked)} 
                        className="rounded border-white/10 bg-[#171717] accent-[#38bdf8]"
                      />
                      I acknowledge and accept the <Link href="/terms" className="text-[#38bdf8] hover:underline" target="_blank">Terms</Link>
                    </label>
                    <button
                      onClick={complete}
                      disabled={!address || registering || !agreed}
                      className="inline-flex w-full sm:w-auto justify-center items-center gap-2 rounded-xl bg-[#38bdf8] px-5 py-2.5 text-sm font-semibold text-[#061018] hover:bg-[#67d8ff] disabled:opacity-60"
                    >
                      {registering ? (
                        <Loader2 size={15} className="animate-spin" />
                      ) : (
                        <Check size={15} />
                      )}
                      {registering ? "Registering…" : "Complete"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <p className="mt-5 text-center text-xs text-[#4f5868]">
          Already onboarded?{" "}
          <Link href="/login" className="text-[#38bdf8] hover:underline">
            Sign in to your dashboard
          </Link>
        </p>
      </div>
    </main>
  );
}