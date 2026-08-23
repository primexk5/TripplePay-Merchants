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
import { Logo } from "@/components/logo";
import { getStoredAddress, isLoggedIn, logout, checkSession } from "@/lib/auth";

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
  // The address lives in localStorage. useSyncExternalStore keeps the first paint SSR-identical
  // ("Not signed in" via getServerSnapshot) and only shows the real address after hydration —
  // reading it directly during render would cause a hydration mismatch.
  const storedAddress = useSyncExternalStore(
    () => () => {}, // localStorage isn't reactive — re-read on every render
    () => getStoredAddress(),
    () => null,
  );

  // Re-validate the HttpOnly cookie session after a reload (in-memory token is gone).
  // Expired or revoked sessions (backend 401) are signed out and sent to /login.
  useEffect(() => {
    if (!isLoggedIn()) {
      router.replace("/login");
      return;
    }
    void checkSession()
      .then((s) => {
        if (s.status === "expired") {
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
          <Link href="/" className="flex items-center gap-3">
            <Logo className="h-9 w-9" />

            <div>
              <p className="text-sm font-bold tracking-tight">Tripple</p>
              <p className="-mt-1 text-sm font-bold text-[#38bdf8]">Pay</p>
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

          <div className="mb-4 rounded-xl border border-white/6 bg-white/2 p-3">
            <p className="text-xs text-[#667085]">Signed in as</p>
            <p className="mt-1 truncate font-mono text-xs text-white">
              {shortAddress(storedAddress)}
            </p>
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

          <div className="hidden lg:block">
            <p className="text-sm text-[#667085]">Merchant portal</p>
            <p className="text-sm font-medium text-white">TripplePay || Merchants</p>
          </div>

          <div className="ml-auto flex items-center gap-4">
            <div className="hidden items-center gap-2 rounded-full border border-emerald-400/15 bg-emerald-400/6 px-3 py-1.5 text-xs text-emerald-300 sm:flex">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Quai network connected
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
    </div>
  );
}