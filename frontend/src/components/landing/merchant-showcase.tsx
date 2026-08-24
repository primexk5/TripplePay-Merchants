"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { BadgeCheck, Store } from "lucide-react";
import { fetchMerchants, type PublicMerchant } from "@/lib/payment";

/** Deterministic avatar gradient from the merchant name so cards look varied but stable. */
const GRADIENTS = [
  "from-sky-400 to-blue-600",
  "from-violet-400 to-purple-600",
  "from-emerald-400 to-teal-600",
  "from-amber-400 to-orange-600",
  "from-pink-400 to-rose-600",
  "from-cyan-400 to-sky-600",
];

function gradientFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return GRADIENTS[Math.abs(hash) % GRADIENTS.length];
}

function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return words
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

function joinedLabel(ts: number): string {
  try {
    return `Since ${new Date(ts).toLocaleDateString(undefined, { month: "short", year: "numeric" })}`;
  } catch {
    return "";
  }
}

export function MerchantShowcase() {
  const [merchants, setMerchants] = useState<PublicMerchant[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchMerchants()
      .then((m) => !cancelled && setMerchants(m))
      .catch(() => !cancelled && setMerchants([]));
    return () => {
      cancelled = true;
    };
  }, []);

  // Hidden entirely until we have real merchants — an empty "trusted by" strip would be worse
  // than none. (Loading state renders skeletons to avoid layout pop.)
  if (merchants !== null && merchants.length === 0) return null;

  // Repeat the roster until it comfortably overflows any viewport, then double it so the
  // translateX(-50%) marquee loops seamlessly.
  const roster =
    merchants === null ? [] : Array.from({ length: Math.max(2, Math.ceil(10 / merchants.length)) }).flatMap(() => merchants);
  const track = [...roster, ...roster];

  return (
    <section className="border-y border-white/6 bg-white/1.5 py-20">
      <div className="mx-auto mb-12 max-w-7xl px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
        >
          <p className="text-sm font-medium text-sky-400">MERCHANTS ON TRIPPLEPAY</p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            Businesses already settling{" "}
            <span className="text-slate-500">on Quai.</span>
          </h2>
          {merchants !== null && (
            <p className="mt-3 text-sm text-slate-500">
              {merchants.length} merchant{merchants.length === 1 ? "" : "s"} accepting payments right now.
            </p>
          )}
        </motion.div>
      </div>

      {/* Loading skeletons */}
      {merchants === null && (
        <div className="flex justify-center gap-4 overflow-hidden px-6 lg:px-8">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="w-[270px] shrink-0 animate-pulse rounded-2xl border border-white/6 bg-white/2 p-5"
              style={{ animationDelay: `${i * 120}ms` }}
            >
              <div className="h-11 w-11 rounded-full bg-white/8" />
              <div className="mt-4 h-4 w-32 rounded bg-white/8" />
              <div className="mt-2 h-3 w-40 rounded bg-white/5" />
            </div>
          ))}
        </div>
      )}

      {/* Seamless marquee — pauses on hover */}
      {merchants !== null && (
        <div className="marquee-paused group relative overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)]">
          <div className="animate-marquee flex w-max gap-4 px-4">
            {track.map((m, i) => (
              <div
                key={`${m.merchantId}-${i}`}
                aria-hidden={i >= roster.length}
                className="flex w-[270px] shrink-0 items-start gap-4 rounded-2xl border border-white/6 bg-[#0d0d0f] p-5 transition-colors hover:border-sky-400/25"
              >
                <div
                  className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br ${gradientFor(m.name)} text-sm font-bold text-slate-950`}
                >
                  {initialsFor(m.name)}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="truncate font-medium text-white">{m.name}</p>
                    <BadgeCheck className="h-4 w-4 shrink-0 text-sky-400" />
                  </div>
                  <p className="mt-1 text-xs leading-5 text-slate-500">
                    Accepting QUAI & stablecoin payments
                  </p>
                  <p className="mt-1.5 flex items-center gap-1 text-[11px] text-slate-600">
                    <Store className="h-3 w-3" />
                    {joinedLabel(m.createdAt)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
