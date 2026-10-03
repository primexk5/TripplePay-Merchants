"use client";

import { ArrowUpRight, ChevronDown, Coins, Search } from "lucide-react";
import { Fragment, useState } from "react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { StatusBadge } from "@/components/ui/status-badge";
import { isLoggedIn } from "@/lib/auth";
import {
  formatDeliveryAmount,
  formatTimestamp,
  deliveryExplorerUrl,
  useRelayerData,
  useQiRecon,
} from "@/lib/relayer";
import { qitsToQi } from "@/lib/qi";

const STATUSES = ["all", "delivered", "pending", "failed"] as const;
type StatusFilter = (typeof STATUSES)[number];

export default function PaymentsPage() {
  const { deliveries, merchants, loading, error } = useRelayerData();
  const qiRecon = useQiRecon();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Webhook delivery info is only meaningful for merchants with a receiver URL; link-only
  // sellers (no website) see pure on-chain confirmation instead.
  const usesWebhook = merchants.some((m) => m.webhookUrl);
  // /v1/me/qi is merchant-scoped (no demo/admin route), so the Qi ledger only means anything
  // when there's a real merchant session behind the page.
  const merchantMode = isLoggedIn();

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
              ? "Every row is a confirmed on-chain or Qi settlement. The status filter tracks webhook delivery to your endpoint."
              : "Every row is a settlement confirmed on-chain — funds are already in your wallet."}
          </p>
        </div>

        {error && (
          <div className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
            Relayer unreachable: {error}
          </div>
        )}


        {merchantMode && qiRecon.recon && qiRecon.recon.summary.total > 0 && (
          <div className="mb-6 rounded-2xl border border-white/7 bg-[#171717] p-5">
            <div className="flex items-center gap-2 text-sm font-medium text-white">
              <Coins size={16} className="text-[#ddff56]" />
              Qi (UTXO) ledger
            </div>
            <p className="mt-1 text-xs text-[#8b93a7]">
              Quai&apos;s UTXO settlements — customers send Qi to one-time receive
              addresses per order.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-xs sm:grid-cols-4">
              <div>
                <p className="text-[#8b93a7]">Total Qi orders</p>
                <p className="mt-0.5 text-lg font-semibold text-white">
                  {qiRecon.recon.summary.total}
                </p>
              </div>
              <div>
                <p className="text-[#8b93a7]">Settled</p>
                <p className="mt-0.5 text-lg font-semibold text-emerald-300">
                  {qiRecon.recon.summary.settled}
                </p>
              </div>
              <div>
                <p className="text-[#8b93a7]">Pending</p>
                <p className="mt-0.5 text-lg font-semibold text-amber-300">
                  {qiRecon.recon.summary.pending}
                </p>
              </div>
              <div>
                <p className="text-[#8b93a7]">Accrued (payable)</p>
                <p className="mt-0.5 text-lg font-semibold text-[#ddff56]">
                  {qitsToQi(qiRecon.recon.summary.qitsReceived)} Qi
                </p>
              </div>
            </div>
            {qiRecon.recon.orders.length > 0 && (
              <div className="mt-4 space-y-2 overflow-y-auto max-h-40 text-xs">
                {qiRecon.recon.orders.map((o) => (
                  <div key={o.orderId} className="flex items-center justify-between rounded-lg border border-white/7 bg-[#0F1116] px-3 py-2">
                    <div className="flex items-center gap-3">
                      <StatusBadge status={o.settled ? "confirmed" : "pending"} />
                      <div>
                        <p className="font-mono text-[11px] text-[#8b93a7]">
                          {o.orderId.slice(0, 14)}…
                        </p>
                        <p className="mt-0.5 font-mono text-[10px] text-[#4f5868] break-all">
                          {o.address}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="font-medium text-white">
                        {qitsToQi(o.settled ? o.receivedQits : o.qits)} Qi
                      </p>
                      <p className="mt-0.5 text-[11px] text-[#8b93a7]">
                        {o.settled ? "settled" : "awaiting"}
                        {o.meta.shopName ? ` · ${o.meta.shopName}` : ""}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
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
                  {filtered.map((d) => {
                    const meta = d.meta ?? null;
                    const expanded = expandedId === d.id;
                    const explorerUrl = deliveryExplorerUrl(d.payload.data.chainId, d.payload.data.txHash);
                    return (
                      <Fragment key={d.id}>
                        <tr
                          onClick={() => setExpandedId(expanded ? null : d.id)}
                          className={`cursor-pointer transition hover:bg-white/5 ${expanded ? "bg-white/5" : ""}`}
                        >
                          <td className="px-5 py-3.5 font-medium">
                            {formatDeliveryAmount(
                              d.payload.data.net,
                              d.payload.data.token,
                              d.payload.data.chainId,
                            )}
                          </td>
                          <td className="px-5 py-3.5 font-mono text-xs text-[#8b93a7]">
                            {meta?.payerName ? (
                              <span className="font-sans text-sm text-white">
                                {meta.payerName}
                                {meta.shopName ? (
                                  <span className="ml-1.5 text-[11px] text-[#8b93a7]">
                                    · for {meta.shopName}
                                  </span>
                                ) : null}
                              </span>
                            ) : (
                              `${d.payload.data.orderId.slice(0, 14)}…`
                            )}
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
                        <div className="flex items-center justify-end gap-3">
                          {explorerUrl && (
                            <a
                              href={explorerUrl}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex items-center gap-1 text-xs text-[#38bdf8] hover:text-[#67d8ff]"
                            >
                              View
                              <ArrowUpRight size={12} />
                            </a>
                          )}
                          <ChevronDown
                            size={15}
                            className={`text-[#8b93a7] transition-transform ${expanded ? "rotate-180" : ""}`}
                          />
                        </div>
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="bg-[#101010]">
                        <td colSpan={6} className="px-5 py-4">
                          <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-xs sm:grid-cols-4">
                            <div>
                              <p className="text-[#8b93a7]">Paid by</p>
                              <p className="mt-0.5 text-sm text-white">
                                {meta?.payerName ?? "Anonymous"}
                              </p>
                            </div>
                            <div>
                              <p className="text-[#8b93a7]">Source</p>
                              <p className="mt-0.5">
                                {meta?.source === "link" ? (
                                  <span className="rounded-md border border-emerald-400/25 bg-emerald-400/10 px-1.5 py-0.5 font-medium text-emerald-300">
                                    Payment link{meta?.shopName ? ` · ${meta.shopName}` : ""}
                                  </span>
                                ) : meta?.source === "checkout" ? (
                                  <span className="rounded-md border border-sky-400/25 bg-sky-400/10 px-1.5 py-0.5 font-medium text-sky-300">
                                    Checkout / API
                                  </span>
                                ) : (
                                  <span className="rounded-md border border-white/10 px-1.5 py-0.5 font-medium text-[#8b93a7]">
                                    On-chain only
                                  </span>
                                )}
                              </p>
                            </div>
                            <div>
                              <p className="text-[#8b93a7]">Payer wallet</p>
                              <p className="mt-0.5 break-all font-mono text-[11px] text-white">
                                {d.payload.data.payer}
                              </p>
                            </div>
                            <div>
                              <p className="text-[#8b93a7]">Order ID</p>
                              <p className="mt-0.5 break-all font-mono text-[11px] text-white">
                                {d.payload.data.orderId}
                              </p>
                            </div>
                            <div>
                              <p className="text-[#8b93a7]">Gross amount</p>
                              <p className="mt-0.5 font-mono text-white">
                                {formatDeliveryAmount(d.payload.data.amount, d.payload.data.token, d.payload.data.chainId)}
                              </p>
                            </div>
                            <div>
                              <p className="text-[#8b93a7]">Platform fee ({(d.payload.data.feeBps / 100).toFixed(2)}%)</p>
                              <p className="mt-0.5 font-mono text-white">
                                {formatDeliveryAmount(d.payload.data.fee, d.payload.data.token, d.payload.data.chainId)}
                              </p>
                            </div>
                            <div>
                              <p className="text-[#8b93a7]">You received</p>
                              <p className="mt-0.5 font-mono font-medium text-emerald-300">
                                {formatDeliveryAmount(d.payload.data.net, d.payload.data.token, d.payload.data.chainId)}
                              </p>
                            </div>
                            <div>
                              <p className="text-[#8b93a7]">
                                {d.payload.data.token === "qi" ? "UTXO tx hashes" : "Tx hash"}
                              </p>
                              {d.payload.data.token === "qi" ? (
                                (d.payload.data.qi?.txHashes ?? []).length === 0 ? (
                                  <p className="mt-0.5 font-mono text-[11px] text-[#8b93a7]">none yet</p>
                                ) : (
                                  <div className="mt-0.5 space-y-1">
                                    {d.payload.data.qi!.txHashes.slice(0, 3).map((h, i) => {
                                      const hUrl = deliveryExplorerUrl(d.payload.data.chainId, h);
                                      return hUrl ? (
                                        <a
                                          key={i}
                                          href={hUrl}
                                          target="_blank"
                                          rel="noreferrer"
                                          onClick={(e) => e.stopPropagation()}
                                          className="block truncate font-mono text-[11px] text-[#38bdf8] hover:text-[#67d8ff]"
                                        >
                                          {h}
                                        </a>
                                      ) : (
                                        <p key={i} className="truncate font-mono text-[11px] text-[#ddff56]">
                                          {h}
                                        </p>
                                      );
                                    })}
                                    {d.payload.data.qi!.txHashes.length > 3 && (
                                      <p className="text-[10px] text-[#4f5868]">
                                        +{d.payload.data.qi!.txHashes.length - 3} more
                                      </p>
                                    )}
                                  </div>
                                )
                              ) : explorerUrl ? (
                                <a
                                  href={explorerUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  className="mt-0.5 block truncate font-mono text-[11px] text-[#38bdf8] hover:text-[#67d8ff]"
                                >
                                  {d.payload.data.txHash}
                                </a>
                              ) : (
                                <p className="mt-0.5 block truncate font-mono text-[11px] text-white">
                                  {d.payload.data.txHash}
                                </p>
                              )}
                            </div>
                            {d.payload.data.token === "qi" && d.payload.data.qi && (
                              <div>
                                <p className="text-[#8b93a7]">Qi settlement</p>
                                <p className="mt-0.5 font-mono text-[11px] text-white">
                                  received{" "}
                                  <span className="font-medium text-[#ddff56]">
                                    {qitsToQi(d.payload.data.qi.receivedQits)} Qi
                                  </span>{" "}
                                  of {qitsToQi(d.payload.data.qi.qits)} Qi required
                                </p>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </DashboardShell>
  );
}