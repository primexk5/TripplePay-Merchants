"use client";

import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  CreditCard,
  DollarSign,
  Plus,
  TrendingUp,
} from "lucide-react";
import { formatQuai, formatUnits } from "quais";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { StatusBadge } from "@/components/ui/status-badge";
import { StatCard } from "@/components/ui/stat-card";
import { WalletBalances } from "@/components/ui/wallet-balances";
import { formatDeliveryAmount, useRelayerData } from "@/lib/relayer";
import { MUSDQ_ADDRESS, currencyDecimals, currencySymbol } from "@/lib/currencies";

const QUAI_SCAN = "https://quaiscan.io/tx/";

export default function DashboardPage() {
  const { deliveries, merchants, loading, error } = useRelayerData();

  const delivered = deliveries.filter((d) => d.status === "delivered");
  const ZERO = 0n;
  // Webhook state is a notification detail, not payment status — every row here already
  // represents a CONFIRMED on-chain settlement (the indexer only records settled payments).
  // Only merchants that actually configured a receiver URL see webhook delivery info.
  const usesWebhook = merchants.some((m) => m.webhookUrl);
  // Every delivery record corresponds to a payment settled on-chain (payment.confirmed), so the
  // totals count all of them regardless of webhook delivery outcome.
  const totalQuaiWei = deliveries.reduce(
    (sum, d) => sum + (d.payload.data.token === "0x0000000000000000000000000000000000000000" ? BigInt(d.payload.data.net) : ZERO),
    ZERO,
  );
  const totalTokenUnits = deliveries.reduce(
    (sum, d) => sum + (d.payload.data.token !== "0x0000000000000000000000000000000000000000" ? BigInt(d.payload.data.net) : ZERO),
    ZERO,
  );
  const successRate =
    deliveries.length > 0
      ? Math.round((delivered.length / deliveries.length) * 1000) / 10
      : 0;
  const pending = deliveries.filter((d) => d.status === "pending").length;

  // Exact-decimal sums: formatQuai/formatUnits do the 10^n scaling without Number() precision loss.
  const totalDisplay = `${formatQuai(totalQuaiWei)} QUAI${
    totalTokenUnits > ZERO
      ? ` + ${formatUnits(totalTokenUnits, currencyDecimals(MUSDQ_ADDRESS ?? ""))} ${currencySymbol(MUSDQ_ADDRESS ?? "")}`
      : ""
  }`;

  return (
    <DashboardShell>
      <div className="mx-auto max-w-3xl px-5 py-8 lg:py-10">
        <div className="mb-8 flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
          <div>
            <p className="mb-2 text-sm text-[#38bdf8]">
              {merchants[0]?.name ?? "Merchant overview"}
            </p>
            <h1 className="text-3xl font-semibold tracking-tight">
              Merchant overview
            </h1>
            <p className="mt-2 text-sm text-[#8b93a7]">
              Live from the PayWithQuai relayer on Quai mainnet.
            </p>
          </div>

          <Link
            href="/dashboard/links"
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#38bdf8] px-4 py-2.5 text-sm font-semibold text-[#061018] transition hover:bg-[#67d8ff]"
          >
            <Plus size={16} />
            Create payment link
          </Link>
        </div>

        {error && (
          <div className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
            Relayer unreachable: {error}
          </div>
        )}

        {loading && (
          <p className="mb-6 text-sm text-[#8b93a7]">Loading live data…</p>
        )}

        <div className="space-y-4">
          <StatCard
            label="Total received"
            value={totalDisplay}
            description={`${delivered.length} confirmed payment(s)`}
            icon={DollarSign}
          />

          <StatCard
            label="Transactions"
            value={String(deliveries.length)}
            description={`${pending} pending in queue`}
            icon={CreditCard}
          />

          <StatCard
            label="Webhook success rate"
            value={`${successRate}%`}
            description="Delivered / total settlements"
            icon={TrendingUp}
          />

          <StatCard
            label="Network"
            value="Quai Mainnet"
            description="Cyprus-1 · chain 9"
            icon={ArrowUpRight}
          />
        </div>

        <div className="mt-8">
          <WalletBalances />
        </div>

        <div className="mt-8 space-y-6">
          <section className="overflow-hidden rounded-2xl border border-white/7 bg-[#171717]">
            <div className="flex items-center justify-between border-b border-white/7 px-5 py-5">
              <div>
                <h2 className="font-semibold">Recent payments</h2>
                <p className="mt-1 text-xs text-[#8b93a7]">
                  Confirmed settlements via the relayer
                </p>
              </div>

              <Link
                href="/dashboard/payments"
                className="flex items-center gap-1 text-xs font-medium text-[#38bdf8]"
              >
                View all
                <ArrowRight size={13} />
              </Link>
            </div>

            {deliveries.length === 0 ? (
              <div className="px-5 py-14 text-center text-sm text-[#8b93a7]">
                No payments yet — create a payment link from the dashboard or
                try the checkout demo.
              </div>
            ) : (
              <div className="divide-y divide-white/6">
                {deliveries.slice(0, 5).map((d) => (
                  <div
                    key={d.id}
                    className="flex items-center justify-between gap-4 px-5 py-4"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {formatDeliveryAmount(d.payload.data.net, d.payload.data.token)}
                      </p>
                      <p className="mt-0.5 truncate font-mono text-xs text-[#8b93a7]">
                        {d.payload.data.orderId.slice(0, 18)}…
                      </p>
                    </div>

                    <div className="flex shrink-0 items-center gap-3">
                      <div className="flex flex-col items-end gap-1">
                        <StatusBadge status="confirmed" />
                        {usesWebhook && (
                          <span
                            className={`text-[11px] ${
                              d.status === "delivered"
                                ? "text-[#4f5868]"
                                : d.status === "failed"
                                  ? "text-red-400"
                                  : "text-amber-400"
                            }`}
                          >
                            webhook {d.status}
                          </span>
                        )}
                      </div>
                      <a
                        href={`${QUAI_SCAN}${d.payload.data.txHash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[#8b93a7] transition hover:text-[#38bdf8]"
                        title="View on Quaiscan"
                      >
                        <ArrowUpRight size={14} />
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {usesWebhook ? (
            <section className="rounded-2xl border border-white/7 bg-[#171717] p-5">
              <h2 className="font-semibold">Webhook delivery</h2>
              <p className="mt-1 text-xs text-[#8b93a7]">
                Notification status to your endpoint — payments themselves are
                already confirmed on-chain.
              </p>

              <div className="mt-6 space-y-4">
              {(
                [
                  ["delivered", delivered.length, "text-emerald-300"],
                  ["pending", pending, "text-amber-400"],
                  [
                    "failed",
                    deliveries.filter((d) => d.status === "failed").length,
                    "text-red-400",
                  ],
                ] as const
              ).map(([label, count, color]) => (
                <div key={label}>
                  <div className="mb-1.5 flex items-center justify-between text-xs">
                    <span className="capitalize text-[#8b93a7]">{label}</span>
                    <span className={`font-mono ${color}`}>{count}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-[#171717]/4">
                    <div
                      className={`h-full rounded-full ${color} ${
                        deliveries.length === 0 ? "w-0" : ""
                      }`}
                      style={{
                        width: `${
                          deliveries.length === 0
                            ? 0
                            : (count / deliveries.length) * 100
                        }%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </section>
          ) : (
            <section className="rounded-2xl border border-white/7 bg-[#171717] p-5">
              <h2 className="font-semibold">Direct settlement</h2>
              <p className="mt-1 text-xs leading-5 text-[#8b93a7]">
                Payments settle straight to your wallet on Quai — verified
                on-chain, no website or receiver URL needed. Add a webhook in
                Settings only if you want automated notifications.
              </p>
            </section>
          )}
        </div>
      </div>
    </DashboardShell>
  );
}