"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Loader2,
  LogIn,
  ShieldCheck,
  Smartphone,
  Wallet,
} from "lucide-react";
import { useEffect, useState } from "react";
import { parseError } from "@/lib/utils";
import { Logo } from "@/components/logo";
import { WalletSelector } from "@/components/ui/wallet-selector";
import { isLoggedIn, loginWithWallet } from "@/lib/auth";
import { storeWalletId } from "@/lib/wallets";
import { useBlipContext } from "@/lib/blip";
import QRCode from "react-qr-code";

function BlipLogo() {
  return (
    <svg viewBox="0 0 100 100" className="h-4 w-4 shrink-0">
      <circle cx="50" cy="50" r="50" fill="#C1ED00" />
      <path fill="#0F1116" d="m98.3 24.4c0-7.2-6.9-13.9-18.2-13.9-7.1-0.1-15.7 2-19.8 8.6-2.6-1.8-6.3-3.9-12.6-3.9-6.8 0-13.4 2.5-16.8 8.2-3.2-1.9-6.5-3.2-12.1-3.2-8.9 0-16.8 4.4-16.8 11.7v19.9c2.4 9.2 14.2 26 47.5 34.9 3.9 0.9 9.1 1.9 12.6 2.4 7.3 0.7 17.8-1.5 19.7-9.6 0.4-1.8 0-8.5 0.2-8.5 2.6-0.6 7.9-3.7 8.6-9.3v-8.4c3.2-1.3 7.7-4.8 7.7-10.2v-18.7z"/>
      <path fill="#C1ED00" d="m58.4 26.6c-1.3-3.5-6.5-5.1-10.7-5-6.3 0-12.5 2.9-11.1 7 2.5 6.9 11.1 15.4 25.9 18.6 3.7 0.9 7.6 1.4 10.9 1.5 10.1 0 14-7 7.7-10.5-3.3-1.8-5.7-1.6-7.7-2-5.7-0.8-12.7-3.6-15-9.6zm-28.8 4.3c-1.5-2.7-6-4.6-10.8-4.6-6.7 0-12.5 3.2-10.9 7.3 3 8 13.7 20.3 35.6 26.9 4.9 1.6 11.1 2.9 16 3.7 12 2 19.6-3.7 15-8-2.9-2.4-5.9-2.7-7.8-3-13.2-1.6-32.1-8.6-37.1-22.3zm49.3-14.1c-7.8 0-13.7 3.6-13.7 7.4 0 2.9 3.9 7.2 13.2 7.3 8.2 0 14-3.3 14-7.1 0.1-3.2-4-7.4-13.5-7.6z"/>
    </svg>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const [address, setAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [onboardHint, setOnboardHint] = useState(false);
  const [tab, setTab] = useState<"blip" | "wallet">("blip");
  const [blipConnecting, setBlipConnecting] = useState(false);

  const { insideBlip, isMobile, blipLink, blipDeep } = useBlipContext();

  useEffect(() => {
    if (isLoggedIn()) router.replace("/dashboard");
  }, [router]);

  const signIn = async () => {
    setBusy(true);
    setError(null);
    setOnboardHint(false);
    try {
      await loginWithWallet(address ?? undefined);
      router.replace("/dashboard");
    } catch (err) {
      const msg = parseError(err);
      setError(msg);
      if (/no merchant registered/i.test(msg)) setOnboardHint(true);
    } finally {
      setBusy(false);
    }
  };

  /** Connect via window.quai (Blip in-app browser) */
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
      setAddress(accounts[0]);
    } catch (err) {
      setError(parseError(err));
    } finally {
      setBlipConnecting(false);
    }
  };



  return (
    <main className="min-h-screen bg-[#171717] px-5 py-8 text-white">
      <div className="mx-auto max-w-md">
        <header className="flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <Logo />
            <span className="text-sm font-semibold tracking-tight">
              TripplePay ||<span className="text-[#38bdf8]">Merchant</span>
            </span>
          </Link>
          <Link href="/" className="inline-flex items-center gap-2 text-sm text-[#8b93a7] transition hover:text-white">
            <ArrowLeft size={15} />
            Back to site
          </Link>
        </header>

        <div className="mt-12 overflow-hidden rounded-3xl border border-white/7 bg-[#0d0d0d]">
          {/* Header */}
          <div className="px-6 pt-6 sm:px-8 sm:pt-8">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-[#38bdf8]/20 bg-[#38bdf8]/8 text-[#38bdf8]">
              <LogIn size={20} />
            </div>
            <h1 className="mt-5 text-2xl font-semibold tracking-tight">Merchant login</h1>
            <p className="mt-2 text-sm leading-6 text-[#8b93a7]">
              Sign in with the wallet registered as your payout address. Signing a message proves ownership — no password needed.
            </p>
          </div>

          {/* ── Inside Blip browser: single connect button ── */}
          {insideBlip ? (
            <div className="px-6 pb-6 pt-5 sm:px-8 sm:pb-8">
              <div className="flex items-center gap-3 rounded-2xl border border-[#C1ED00]/20 bg-[#C1ED00]/5 px-4 py-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[#C1ED00]">
                  <BlipLogo />
                </span>
                <p className="text-sm text-[#C1ED00]">Blip browser detected — connect in one tap.</p>
              </div>
              {!address ? (
                <button
                  onClick={() => void connectBlip()}
                  disabled={blipConnecting}
                  className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#C1ED00] font-semibold text-[#0F1116] transition hover:bg-[#d4ff00] disabled:opacity-60"
                >
                  {blipConnecting ? <Loader2 size={17} className="animate-spin" /> : <Wallet size={17} />}
                  {blipConnecting ? "Connecting…" : "Connect with Blip"}
                </button>
              ) : (
                <div className="mt-4 rounded-xl border border-[#C1ED00]/20 bg-[#C1ED00]/5 px-4 py-3">
                  <p className="text-xs text-[#8b93a7]">Connected via Blip</p>
                  <p className="mt-1 break-all font-mono text-xs text-[#C1ED00]">{address}</p>
                  <p className="mt-2 text-xs leading-5 text-[#8b93a7]">
                    This is your Blip app wallet for this site — sign in with the
                    wallet you registered as your payout address.
                  </p>
                </div>
              )}
            </div>
          ) : (
            /* ── Desktop / other browsers: tab switcher ── */
            <div className="mt-6 border-t border-white/7">
              <div className="flex border-b border-white/7">
                <button
                  onClick={() => setTab("blip")}
                  className={`flex flex-1 items-center justify-center gap-2 py-3 text-sm font-medium transition ${tab === "blip" ? "border-b-2 border-[#C1ED00] text-white" : "text-[#8b93a7] hover:text-white"}`}
                >
                  <BlipLogo />
                  Blip
                </button>
                <button
                  onClick={() => setTab("wallet")}
                  className={`flex flex-1 items-center justify-center gap-2 py-3 text-sm font-medium transition ${tab === "wallet" ? "border-b-2 border-[#38bdf8] text-white" : "text-[#8b93a7] hover:text-white"}`}
                >
                  <Wallet size={15} />
                  Browser Wallet
                </button>
              </div>

              {tab === "blip" && (
                <div className="flex flex-col items-center px-6 py-6 sm:px-8">
                  {isMobile ? (
                    <>
                      <p className="mb-4 text-center text-sm text-[#8b93a7]">
                        Opens this page inside the Blip app — your wallet connects automatically.
                      </p>
                      <a href={blipDeep} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#C1ED00] py-3 text-sm font-semibold text-[#0F1116] transition hover:bg-[#d4ff00]">
                        <Smartphone size={15} />
                        Open in Blip
                      </a>
                      <p className="mt-3 text-center text-xs text-[#4f5868]">
                        Not opening?{" "}
                        <a href={blipLink} className="text-[#C1ED00] hover:underline">
                          Use the web link
                        </a>
                      </p>
                    </>
                  ) : (
                    <>
                      <div className="mb-4 rounded-2xl bg-white p-3 shadow-md ring-4 ring-[#C1ED00]/20">
                        <QRCode value={blipDeep} size={148} level="M" fgColor="#0F1116" />
                      </div>
                      <p className="mb-1 text-sm font-medium text-white">Scan with Blip</p>
                      <p className="mb-5 text-center text-xs text-[#8b93a7]">
                        Opens this page inside the Blip app on your phone — connect in one tap.
                      </p>
                      <a href={blipLink} className="flex w-full items-center justify-center gap-2 rounded-xl border border-[#C1ED00]/25 bg-[#C1ED00]/5 py-2.5 text-sm font-medium text-[#C1ED00] transition hover:border-[#C1ED00]/50">
                        <Smartphone size={14} />
                        Open in Blip app
                      </a>
                    </>
                  )}
                  <p className="mt-4 text-center text-xs text-[#4f5868]">
                    Don&apos;t have Blip?{" "}
                    <a href="https://blippay.me" target="_blank" rel="noreferrer" className="text-[#C1ED00] hover:underline">Download Blip (iOS & Android)</a>
                  </p>
                </div>
              )}

              {tab === "wallet" && (
                <div className="px-6 py-6 sm:px-8">
                  <WalletSelector connectedAddress={address} onConnected={setAddress} label="Connect wallet" chain="any" />
                </div>
              )}
            </div>
          )}

          {/* Connected address (browser wallet tab) */}
          {address && tab === "wallet" && !insideBlip && (
            <div className="mx-6 rounded-xl border border-white/7 bg-[#0a0a0a] px-4 py-3 sm:mx-8">
              <p className="text-xs text-[#8b93a7]">Signing in as</p>
              <p className="mt-1 break-all font-mono text-xs text-white">{address}</p>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="mx-6 mt-3 rounded-xl border border-red-300/30 bg-red-900/20 px-4 py-3 text-sm text-red-400 sm:mx-8">
              {error}
              {onboardHint && (
                <Link href="/onboarding" className="mt-2 block font-medium text-[#38bdf8] hover:underline">
                  Complete merchant onboarding →
                </Link>
              )}
            </div>
          )}

          {/* Sign-in CTA — only shown once a wallet is connected */}
          {address && (
            <div className="px-6 pb-6 pt-4 sm:px-8 sm:pb-8">
              <button
                onClick={() => void signIn()}
                disabled={busy}
                className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#38bdf8] font-semibold text-[#061018] transition hover:bg-[#67d8ff] disabled:opacity-50"
              >
                {busy ? (
                  <><Loader2 size={17} className="animate-spin" />Signing message…</>
                ) : (
                  <>Sign in<ArrowRight size={17} /></>
                )}
              </button>
              <p className="mt-5 flex items-center justify-center gap-1.5 text-xs text-[#4f5868]">
                <ShieldCheck size={13} />
                Your signature is never stored — only the session token is kept.
              </p>
            </div>
          )}
        </div>

        <p className="mt-5 text-center text-xs text-[#4f5868]">
          New here?{" "}
          <Link href="/onboarding" className="text-[#38bdf8] hover:underline">Create a merchant account</Link>
        </p>
      </div>
    </main>
  );
}
