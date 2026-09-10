"use client";

import { Check, Coins, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import QRCode from "react-qr-code";
import { isInsideBlipBrowser, isMobileViewport } from "@/lib/blip";
import { formatQits } from "@/lib/qi";

/** Copy to the clipboard with an execCommand fallback (older Blip in-app browser). */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

interface QiPaymentPanelProps {
  /** One-time Qi receive address for this order (the pay-to target). */
  address: string;
  /** Required amount in qits (decimal string, 1000 qits = 1 Qi). */
  qits: string;
  orderId: string;
  settled?: boolean;
}

/**
 * Qi checkout surface: the order's one-time receive address as a QR + exact amount with copy
 * buttons, plus device-aware instructions. Qi wallets (Blip/Pelagus) have no deep link that
 * pre-fills a send amount — the QR encodes the address only and the amount is entered manually —
 * so this panel is the full payment UX, on every surface (checkout page, payment link, and the
 * Blip in-app branch).
 */
export function QiPaymentPanel({ address, qits, orderId, settled = false }: QiPaymentPanelProps) {
  const [copied, setCopied] = useState<"" | "address" | "amount">("");
  const [insideBlip, setInsideBlip] = useState(false);
  const [mobile, setMobile] = useState(false);

  useEffect(() => {
    // Blip's in-app browser can be detected slightly after first paint (same as the checkout
    // page) — defer a beat so the instructions stay accurate on the very first frame.
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      setInsideBlip(isInsideBlipBrowser());
      setMobile(isMobileViewport());
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const copy = async (kind: "address" | "amount") => {
    const text = kind === "address" ? address : formatQits(qits);
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(kind);
      window.setTimeout(() => setCopied(""), 1500);
    }
  };

  const appHint = insideBlip ? "Blip" : mobile ? "Blip" : "Pelagus";

  return (
    <div className="flex flex-col items-center">
      <p className="flex items-center gap-2 text-sm font-medium text-white">
        <Coins size={16} className="text-[#ddff56]" />
        Pay with Qi
      </p>
      <p className="mt-1 text-center text-xs leading-5 text-[#8b93a7]">
        Qi is Quai&apos;s UTXO ledger. Send the exact qits below to this
        order&apos;s one-time address — payment is detected automatically.
      </p>

      <div className="mt-5 rounded-xl border border-white/7 bg-[#171717] px-5 py-4 text-center">
        <p className="text-xs text-[#8b93a7]">Amount to send</p>
        <p className="mt-1 text-2xl font-semibold tracking-tight text-[#ddff56]">
          {formatQits(qits)}
        </p>
      </div>

      <div className="mt-5 rounded-2xl bg-white p-3 shadow-md ring-4 ring-white/10">
        <QRCode value={address} size={168} level="M" fgColor="#0F1116" />
      </div>
      <p className="mt-2 max-w-[220px] text-center text-[10px] leading-4 text-[#4f5868]">
        {insideBlip
          ? "This code holds only the address — Qi wallets don&apos;t encode amounts."
          : "Scan with Blip (Qi tab) or copy the address into Pelagus."}
      </p>

      <div className="mt-4 w-full space-y-2">
        <p className="break-all rounded-xl border border-white/7 bg-[#171717] px-4 py-3 font-mono text-[11px] leading-5 text-white">
          {address}
        </p>
        <button
          onClick={() => void copy("address")}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 py-2.5 text-xs font-medium text-white transition hover:bg-white/5"
        >
          {copied === "address" ? <Check size={13} className="text-emerald-300" /> : <Copy size={13} />}
          {copied === "address" ? "Address copied" : "Copy address"}
        </button>
        <button
          onClick={() => void copy("amount")}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 py-2.5 text-xs font-medium text-white transition hover:bg-white/5"
        >
          {copied === "amount" ? <Check size={13} className="text-emerald-300" /> : <Copy size={13} />}
          {copied === "amount" ? "Amount copied" : "Copy amount"}
        </button>
      </div>

      <ol className="mt-5 w-full space-y-2.5 text-left text-xs leading-5 text-[#8b93a7]">
        <li className="flex gap-2.5">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-[10px] font-semibold text-white">1</span>
          Open <span className="text-white">{appHint}</span> and go to the Qi tab.
        </li>
        <li className="flex gap-2.5">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-[10px] font-semibold text-white">2</span>
          Choose <span className="text-white">Send</span>, paste the address (or scan the code), then
          enter the exact amount above.
        </li>
        <li className="flex gap-2.5">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-[10px] font-semibold text-white">3</span>
          Confirm. This page updates automatically once the network confirms.
        </li>
      </ol>

      <div className="mt-5 w-full rounded-xl border border-white/7 bg-[#171717] px-4 py-3">
        <p className="text-xs text-[#4f5868]">
          order <span className="font-mono text-[#8b93a7]">#{orderId.slice(0, 8)}</span>
          {" · "}address is one-time — reuse across orders would misattribute payments.
        </p>
      </div>

      {settled && (
        <p className="mt-4 flex items-center gap-2 rounded-xl border border-emerald-400/20 bg-emerald-400/10 px-4 py-2.5 text-xs font-medium text-emerald-300">
          <Check size={14} />
          Qi payment received — settling…
        </p>
      )}
    </div>
  );
}