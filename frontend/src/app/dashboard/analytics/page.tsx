"use client";

import {
  BarChart3,
  CheckCircle2,
  Clock3,
  Download,
  TrendingUp,
  Wallet2,
  XCircle,
} from "lucide-react";
import { formatQuai, formatUnits } from "quais";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { useRelayerData, type Delivery } from "@/lib/relayer";
import { MUSDQ_ADDRESS, currencyDecimals, currencySymbol } from "@/lib/currencies";

interface DailyPoint {
  day: string;
  volume: bigint;
  count: number;
}

function computeStats(deliveries: Delivery[]) {
  const delivered = deliveries.filter((d) => d.status === "delivered");
  const ZERO = 0n;
  // Exact-decimal sums — Number() would lose precision on big values.
  const totalQuai = delivered.reduce((sum, d) => {
    return (
      sum +
      (d.payload.data.token ===
      "0x0000000000000000000000000000000000000000"
        ? BigInt(d.payload.data.net)
        : ZERO)
    );
  }, ZERO);
  const totalToken = delivered.reduce((sum, d) => {
    return (
      sum +
      (d.payload.data.token !==
      "0x0000000000000000000000000000000000000000"
        ? BigInt(d.payload.data.net)
        : ZERO)
    );
  }, ZERO);

  const byStatus = {
    delivered: delivered.length,
    pending: deliveries.filter((d) => d.status === "pending").length,
    failed: deliveries.filter((d) => d.status === "failed").length,
  };

  const successRate =
    deliveries.length > 0
      ? Math.round((delivered.length / deliveries.length) * 1000) / 10
      : 0;

  const delays = delivered.map(
    (d) => d.createdAt - d.payload.data.timestamp * 1000,
  );
  const avgDelay =
    delays.length > 0
      ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length)
      : 0;

  const dailyMap = new Map<string, DailyPoint>();
  for (const d of delivered) {
    const day = new Date(d.payload.data.timestamp * 1000)
      .toISOString()
      .slice(0, 10);
    const entry = dailyMap.get(day) ?? { day, volume: 0n, count: 0 };
    entry.volume += BigInt(d.payload.data.net);
    entry.count += 1;
    dailyMap.set(day, entry);
  }
  const daily = [...dailyMap.values()].sort((a, b) =>
    a.day.localeCompare(b.day),
  );

  return { totalQuai, totalToken, byStatus, successRate, avgDelay, daily };
}

function formatDelay(ms: number): string {
  if (ms < 1000) return "<1s";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function MetricCard({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-2xl border border-white/7 bg-[#171717] p-5">
      <div className="mb-5 flex items-center justify-between">
        <p className="text-sm text-[#8b93a7]">{label}</p>
        <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#38bdf8]/15 bg-[#38bdf8]/6 text-[#38bdf8]">
          {icon}
        </div>
      </div>
      <p className="text-2xl font-semibold tracking-tight">{value}</p>
      <p className="mt-1 text-xs text-[#8b93a7]">{detail}</p>
    </div>
  );
}

export default function AnalyticsPage() {
  const { deliveries, loading, error } = useRelayerData();
  const stats = computeStats(deliveries);
  const maxDaily = stats.daily.reduce(
    (m, p) => (p.volume > m ? p.volume : m),
    1n,
  );

  return (
    <DashboardShell>
      <div className="mx-auto max-w-3xl px-5 py-8 lg:py-10">
        <div className="mb-8 flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
          <div>
            <p className="mb-2 text-sm text-[#38bdf8]">Analytics</p>
            <h1 className="text-3xl font-semibold tracking-tight">
              Analytics
            </h1>
            <p className="mt-2 text-sm text-[#8b93a7]">
              Live metrics from the relayer on Quai mainnet.
            </p>
          </div>

          <button
            disabled
            className="inline-flex w-fit items-center gap-2 rounded-lg border border-white/7 px-4 py-2.5 text-sm font-medium text-[#8b93a7] opacity-60"
            title="CSV export is a demo placeholder"
          >
            <Download size={16} />
            Export report
          </button>
        </div>

        {error && (
          <div className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
            Relayer unreachable: {error}
          </div>
        )}

        {loading && (
          <p className="mb-6 text-sm text-[#8b93a7]">Loading live data…</p>
        )}

        {/* KPI cards */}
        <section className="space-y-4">
          <MetricCard
            icon={<Wallet2 size={18} />}
            label="Total volume"
            value={`${formatQuai(stats.totalQuai)} QUAI`}
            detail={`${stats.totalToken > 0n ? `+ ${formatUnits(stats.totalToken, currencyDecimals(MUSDQ_ADDRESS ?? ""))} ${currencySymbol(MUSDQ_ADDRESS ?? "")} · ` : ""}confirmed volume`}
          />
          <MetricCard
            icon={<BarChart3 size={18} />}
            label="Transactions"
            value={String(deliveries.length)}
            detail="Total webhooks recorded"
          />
          <MetricCard
            icon={<TrendingUp size={18} />}
            label="Success rate"
            value={`${stats.successRate}%`}
            detail="Delivered / total"
          />
          <MetricCard
            icon={<Clock3 size={18} />}
            label="Avg settlement time"
            value={formatDelay(stats.avgDelay)}
            detail="Webhook queue → delivery"
          />
        </section>

        <section className="mt-6 space-y-6">
          {/* Daily volume */}
          <div className="rounded-2xl border border-white/7 bg-[#171717] p-5">
            <div className="mb-6 flex items-center justify-between">
              <div>
                <h2 className="font-semibold">Daily volume</h2>
                <p className="mt-1 text-xs text-[#8b93a7]">Last 14 days</p>
              </div>
            </div>

            {stats.daily.length === 0 ? (
              <p className="py-10 text-center text-sm text-[#8b93a7]">
                No confirmed payments yet.
              </p>
            ) : (
              <div className="space-y-3">
                {stats.daily
                  .slice(-14)
                  .map((point) => (
                    <div key={point.day} className="flex items-center gap-3">
                      <span className="w-20 shrink-0 font-mono text-[11px] text-[#8b93a7]">
                        {point.day.slice(5)}
                      </span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-[#171717]/4">
                        <div
                          className="h-full rounded-full bg-[#38bdf8]"
                          style={{
                            width: `${Math.max(3, Number((point.volume * 100n) / maxDaily))}%`,
                          }}
                        />
                      </div>
                      <span className="w-16 shrink-0 text-right font-mono text-[11px] text-[#8b93a7]">
                        {formatQuai(point.volume)}
                      </span>
                    </div>
                  ))}
              </div>
            )}
          </div>

          {/* Status breakdown */}
          <div className="rounded-2xl border border-white/7 bg-[#171717] p-5">
            <div className="mb-6">
              <h2 className="font-semibold">Delivery status</h2>
              <p className="mt-1 text-xs text-[#8b93a7]">All time</p>
            </div>

            <div className="space-y-5">
              {(
                [
                  [
                    "Delivered",
                    stats.byStatus.delivered,
                    CheckCircle2,
                    "text-emerald-300",
                  ],
                  [
                    "Pending",
                    stats.byStatus.pending,
                    Clock3,
                    "text-amber-400",
                  ],
                  ["Failed", stats.byStatus.failed, XCircle, "text-red-400"],
                ] as const
              ).map(([label, count, Icon, color]) => (
                <div key={label} className="flex items-center gap-4">
                  <Icon size={16} className={color} />
                  <span className="flex-1 text-sm text-[#8b93a7]">
                    {label}
                  </span>
                  <span className="font-mono text-sm text-white">{count}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </DashboardShell>
  );
}