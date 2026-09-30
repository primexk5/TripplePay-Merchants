"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BarChart3,
  BookOpen,
  CreditCard,
  LayoutDashboard,
  Link2,
  Loader2,
  LogOut,
  Menu,
  Settings,
  X,
} from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Logo } from "@/components/logo";
import { getStoredAddress, isLoggedIn, logout, checkSession, loginWithWallet, type AuthMerchant } from "@/lib/auth";
import { WalletSelector } from "@/components/ui/wallet-selector";
import { useConnectedChain } from "@/lib/relayer";
import {
  silentActiveWalletAddress,
  storeWalletId,
  subscribeToWalletChanges,
  type DetectedWallet,
} from "@/lib/wallets";
import { parseError } from "@/lib/utils";

function shortAddress(address: string | null): string {
  if (!address) return "Not signed in";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

const navigation = [
  {
    label: "Overview",
    href: "/dashboard",
    icon: LayoutDashboard,
  },
  {
    label: "Payment links",
    href: "/dashboard/links",
    icon: Link2,
  },
  {
    label: "Payments",
    href: "/dashboard/payments",
    icon: CreditCard,
  },
  {
    label: "Analytics",
    href: "/dashboard/analytics",
    icon: BarChart3,
  },
  {
    label: "Settings",
    href: "/dashboard/settings",
    icon: Settings,
  },
];

export function DashboardShell({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);

  // ── Signed-in state (the backend session) — independent of the wallet below. ──────────────
  // The address lives in localStorage. useSyncExternalStore keeps the first paint SSR-identical
  // ("Not signed in" via getServerSnapshot) and only shows the real address after hydration —
  // reading it directly during render would cause a hydration mismatch. It's only a FIRST-PAINT
  // placeholder, though: the authoritative value is sessionMerchant, set below once checkSession
  // actually confirms the session. A merchant with a valid session must never see "Not signed
  // in" just because this browser tab's localStorage cache happens to be empty or stale.
  const storedAddress = useSyncExternalStore(
    () => () => {}, // localStorage isn't reactive — re-read on every render
    () => getStoredAddress(),
    () => null,
  );
  const [sessionMerchant, setSessionMerchant] = useState<AuthMerchant | null>(null);
  const displayAddress = sessionMerchant?.address ?? storedAddress;

  // ── Wallet-connected state — separate, browser-local, needed only for signing. ────────────
  // Read silently (no popup) on mount so the indicator reflects reality without requiring a
  // click first. Losing this must never affect the session above.
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const resolve = () => {
      void silentActiveWalletAddress().then((addr) => {
        if (!cancelled) setWalletAddress(addr);
      });
    };
    resolve();
    const unsubscribe = subscribeToWalletChanges(resolve);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  // Which chain that wallet currently reports — never assume Quai (see useConnectedChain).
  const connectedChain = useConnectedChain();

  // ── Wallet switcher: a wallet connected via the header/sidebar badge that reports a DIFFERENT
  // address than the signed-in session — a different merchant account, not just a different
  // wallet app. WalletSelector already refused to switch silently (see its `expectedAddress`
  // prop); this is where the merchant is asked what to do about it.
  const [mismatch, setMismatch] = useState<{ wallet: DetectedWallet; address: string } | null>(null);
  const [switchingAccount, setSwitchingAccount] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  useEffect(() => {
    if (!mismatch) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMismatch(null);
        setSwitchError(null);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mismatch]);

  // Signs in as the OTHER account with the newly-connected wallet — a completed signature, not
  // just a connection, is what's allowed to change which account/wallet the dashboard treats as
  // active (hard rule: a connection alone must never grant account access). Only on success does
  // the active wallet actually flip, via the existing storeWalletId/subscribeToWalletChanges path
  // — so every other open surface (balances, chain selectors) updates the same way a normal
  // wallet switch already does, and a failed/cancelled signature leaves the current session and
  // active wallet completely untouched.
  const confirmSwitchAccount = async () => {
    if (!mismatch) return;
    setSwitchingAccount(true);
    setSwitchError(null);
    try {
      const result = await loginWithWallet(mismatch.address, mismatch.wallet);
      storeWalletId(mismatch.wallet.id);
      setSessionMerchant(result.merchant);
      setWalletAddress(mismatch.address);
      setMismatch(null);
    } catch (err) {
      setSwitchError(parseError(err));
    } finally {
      setSwitchingAccount(false);
    }
  };
  const cancelSwitchAccount = () => {
    setMismatch(null);
    setSwitchError(null);
  };

  // Re-validate the HttpOnly cookie session after a reload (in-memory token is gone).
  // Expired or revoked sessions (backend 401) are signed out and sent to /login. An unreachable
  // backend leaves whatever we already have alone — a network blip must not look like a logout.
  useEffect(() => {
    if (!isLoggedIn()) {
      router.replace("/login");
      return;
    }
    void checkSession()
      .then((s) => {
        if (s.status === "ok") {
          setSessionMerchant(s.merchant);
        } else if (s.status === "expired") {
          void logout();
          router.replace("/login");
        }
      })
      .finally(() => setSessionReady(true));
  }, [router]);

  const signOut = async () => {
    setSigningOut(true);
    await logout();
    router.replace("/login");
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-white/7 bg-[#0a0a0a] transition-transform duration-200 lg:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-20 items-center justify-between border-b border-white/7 px-6">
          <Link href="/" className="flex items-center gap-3 group">
            <div className="rounded-xl ring-1 ring-white/10 overflow-hidden shadow-lg shrink-0">
              <Logo className="h-9 w-9" />
            </div>

            {/* Wordmark */}
            <div className="flex flex-col leading-none">
              <span className="text-[13px] font-extrabold tracking-widest text-white/90 uppercase">
                Tripple
                <span className="bg-linear-to-r from-sky-400 to-cyan-300 bg-clip-text text-transparent">
                  Pay
                </span>
              </span>
              <span className="mt-0.75 text-[9px] font-semibold tracking-[0.22em] uppercase text-white/35">
                Merchant Portal
              </span>
            </div>
          </Link>
          <button
            onClick={() => setMobileOpen(false)}
            className="text-[#667085] lg:hidden"
            aria-label="Close navigation"
          >
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 px-3 py-6">
          <p className="px-3 pb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#667085]">
            Merchant
          </p>

          <nav className="space-y-1">
            {navigation.map((item) => {
              const Icon = item.icon;
              const active =
                pathname === item.href ||
                (item.href === "/dashboard" && pathname === "/dashboard");

              return (
                <Link
                  key={item.label}
                  href={item.href}
                  onClick={() => setMobileOpen(false)}
                  className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${
                    active
                      ? "bg-white/6 text-white"
                      : "text-[#8b93a7] hover:bg-white/[0.035] hover:text-white"
                  }`}
                >
                  <Icon size={17} />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="border-t border-white/7 p-4">
          <Link
            href="/docs"
            className="mb-3 flex items-center gap-3 px-2 text-sm text-[#8b93a7] hover:text-white"
          >
            <BookOpen size={16} />
            Documentation
          </Link>

          <div className="mb-3 rounded-xl border border-white/6 bg-white/2 p-3">
            <p className="text-xs text-[#667085]">Signed in as</p>
            <p className="mt-1 truncate font-mono text-xs text-white">
              {shortAddress(displayAddress)}
            </p>
          </div>

          {/* Wallet connection is separate from the session above (Problem 1) — clicking either
              this or the header badge opens the same picker and reconnects in place, without
              leaving the dashboard or touching the session. */}
          <div className="mb-4">
            <WalletSelector
              connectedAddress={walletAddress}
              onConnected={setWalletAddress}
              onDisconnect={() => setWalletAddress(null)}
              label="Connect wallet"
              chain="any"
              expectedAddress={displayAddress}
              onAddressMismatch={(wallet, address) => setMismatch({ wallet, address })}
              showChainSwitcher
            />
          </div>

          <Link
            href="/"
            className="mb-3 flex items-center gap-3 px-2 text-sm text-[#8b93a7] hover:text-white"
          >
            <LayoutDashboard size={16} />
            Back to website
          </Link>

          <button
            onClick={() => void signOut()}
            disabled={signingOut}
            className="flex w-full items-center gap-3 rounded-lg px-2 py-1 text-sm text-[#8b93a7] transition hover:text-white disabled:opacity-50"
          >
            {signingOut ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <LogOut size={16} />
            )}
            Log out
          </button>
        </div>
      </aside>

      {mobileOpen && (
        <button
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-label="Close navigation overlay"
        />
      )}

      <div className="lg:pl-64">
        <header className="sticky top-0 z-30 flex h-20 items-center justify-between border-b border-white/7 bg-[#0a0a0a]/95 px-5 backdrop-blur-md lg:px-8">
          <button
            onClick={() => setMobileOpen(true)}
            className="text-[#8b93a7] lg:hidden"
            aria-label="Open navigation"
          >
            <Menu size={22} />
          </button>

          <div className="hidden lg:flex items-center gap-3">
            <div className="flex flex-col leading-none">
              <span className="mt-0.5 text-[8px] font-semibold tracking-[0.24em] uppercase text-white/30">
                Admin Portal
              </span>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-4">
            {/* Clicking this (or the sidebar's wallet row) opens the picker and reconnects in
                place — Problem 1: the wallet indicator must be actionable, not just informational. */}
            <div className="hidden sm:block">
              <WalletSelector
                connectedAddress={walletAddress}
                onConnected={setWalletAddress}
                onDisconnect={() => setWalletAddress(null)}
                label="Connect wallet"
                chain="any"
                compact
                connectedLabel={walletAddress ? `${connectedChain.name} connected` : undefined}
                expectedAddress={displayAddress}
                onAddressMismatch={(wallet, address) => setMismatch({ wallet, address })}
                showChainSwitcher
              />
            </div>

            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#262626] text-xs font-semibold">
              QS
            </div>
          </div>
        </header>

        <main className="min-h-[calc(100vh-5rem)]">
          {sessionReady ? children : (
            <div className="flex min-h-[50vh] items-center justify-center">
              <Loader2 size={24} className="animate-spin text-[#38bdf8]" />
            </div>
          )}
        </main>
      </div>

      {mismatch &&
        createPortal(
          <div
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
            onClick={cancelSwitchAccount}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="account-mismatch-title"
              className="w-full max-w-sm rounded-2xl border border-white/7 bg-[#171717] p-6 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 id="account-mismatch-title" className="text-base font-semibold text-white">
                Different account
              </h3>
              <p className="mt-2 text-sm text-[#8b93a7]">
                {mismatch.wallet.name} is connected to{" "}
                <span className="font-mono text-white">{shortAddress(mismatch.address)}</span>,
                which belongs to a different merchant account than the one you&apos;re signed in
                as ({shortAddress(displayAddress)}). Switching wallets here won&apos;t change who
                you&apos;re signed in as unless you sign in with this account.
              </p>

              {switchError && (
                <p className="mt-3 text-sm text-red-400">{switchError}</p>
              )}

              <div className="mt-4 flex gap-2">
                <button
                  onClick={() => void confirmSwitchAccount()}
                  disabled={switchingAccount}
                  className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-[#38bdf8] px-4 py-2.5 text-sm font-semibold text-[#061018] transition hover:bg-[#67d8ff] disabled:opacity-50"
                >
                  {switchingAccount && <Loader2 size={14} className="animate-spin" />}
                  {switchingAccount ? "Signing in…" : "Sign in as this account"}
                </button>
                <button
                  onClick={cancelSwitchAccount}
                  disabled={switchingAccount}
                  className="flex-1 rounded-xl border border-white/7 px-4 py-2.5 text-sm font-medium text-[#c9d4e0] transition hover:bg-white/5 disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}