"use client";

import { ArrowUpRight, Search } from "lucide-react";
import { useState } from "react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  formatDeliveryAmount,
  formatTimestamp,
  useRelayerData,
} from "@/lib/relayer";

const QUAI_SCAN = "https://quaiscan.io/tx/";
const STATUSES = ["all", "delivered", "pending", "failed"] as const;
type StatusFilter = (typeof STATUSES)[number];

export default function PaymentsPage() {
  const { deliveries, merchants, loading, error } = useRelayerData();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  // Webhook delivery info is only meaningful for merchants with a receiver URL; link-only
  // sellers (no website) see pure on-chain confirmation instead.
  const usesWebhook = merchants.some((m) => m.webhookUrl);

  const filtered = deliveries.filter((d) => {
    if (status !== "all" && d.status !== status) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      d.payload.data.orderId.toLowerCase().includes(q) ||
      d.payload.data.txHash.toLowerCase().includes(q) ||
      d.payload.data.payer.toLowerCase().includes(q)
    );
  });

  return (
    <DashboardShell>
      <div className="mx-auto max-w-3xl px-5 py-8 lg:py-10">
        <div className="mb-8">
          <p className="mb-2 text-sm text-[#38bdf8]">Payments</p>
          <h1 className="text-3xl font-semibold tracking-tight">
            Payment history
          </h1>
          <p className="mt-2 text-sm text-[#8b93a7]">
            {usesWebhook
              ? "Every row is a confirmed on-chain settlement. The status filter tracks webhook delivery to your endpoint."
              : "Every row is a settlement confirmed on Quai — funds are already in your wallet."}
          </p>
        </div>

        {error && (
          <div className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
            Relayer unreachable: {error}
          </div>
        )}

        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative sm:w-80">
            <Search
              size={15}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#8b93a7]"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search order, tx, payer…"
              className="h-10 w-full rounded-xl border border-white/7 bg-[#171717] pl-9 pr-3 text-sm text-white outline-none placeholder:text-[#4f5868] focus:border-[#38bdf8]/40"
            />
          </div>

          {usesWebhook && (
            <div className="flex items-center gap-2">
              {STATUSES.map((s) => (
                <button
                  key={s}
                  onClick={() => setStatus(s)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium capitalize transition ${
                    status === s
                      ? "bg-[#38bdf8] text-[#061018]"
                      : "border border-white/7 text-[#8b93a7] hover:bg-white/5"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>

        {loading ? (
          <p className="text-sm text-[#8b93a7]">Loading…</p>
        ) : filtered.length === 0 ? (
          <div className="rounded-2xl border border-white/7 bg-[#171717] px-5 py-14 text-center text-sm text-[#8b93a7]">
            No payments match your filters.
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-white/7 bg-[#171717]">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-white/7 bg-[#171717]">
                    <th className="px-5 py-3 font-medium text-[#8b93a7]">
                      Amount
                    </th>
                    <th className="px-5 py-3 font-medium text-[#8b93a7]">
                      Order
                    </th>
                    <th className="px-5 py-3 font-medium text-[#8b93a7]">
                      Payer
                    </th>
                    <th className="px-5 py-3 font-medium text-[#8b93a7]">
                      Created
                    </th>
                    <th className="px-5 py-3 font-medium text-[#8b93a7]">
                      Status
                    </th>
                    <th className="px-5 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/6">
                  {filtered.map((d) => (
                    <tr key={d.id} className="hover:bg-white/5">
                      <td className="px-5 py-3.5 font-medium">
                        {formatDeliveryAmount(
                          d.payload.data.net,
                          d.payload.data.token,
                        )}
                      </td>
                      <td className="px-5 py-3.5 font-mono text-xs text-[#8b93a7]">
                        {d.payload.data.orderId.slice(0, 14)}…
                      </td>
                      <td className="px-5 py-3.5 font-mono text-xs text-[#8b93a7]">
                        {d.payload.data.payer.slice(0, 10)}…
                      </td>
                      <td className="px-5 py-3.5 text-xs text-[#8b93a7]">
                        {formatTimestamp(d.createdAt)}
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex flex-col items-start gap-1">
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
                              {d.status === "failed" ? ` · ${d.attempts} attempts` : ""}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        <a
                          href={`${QUAI_SCAN}${d.payload.data.txHash}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-[#38bdf8] hover:text-[#67d8ff]"
                        >
                          View
                          <ArrowUpRight size={12} />
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </DashboardShell>
  );
}