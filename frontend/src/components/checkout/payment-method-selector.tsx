import React, { useState, useRef, useEffect } from "react";
import { Smartphone, Wallet, Coins, ChevronDown } from "lucide-react";

interface PaymentMethodSelectorProps {
  payTab: "blip" | "wallet" | "qi";
  setPayTab: (tab: "blip" | "wallet" | "qi") => void;
  showQiComingSoon?: boolean;
}

export function PaymentMethodSelector({ payTab, setPayTab, showQiComingSoon }: PaymentMethodSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const getLabel = (val: string) => {
    if (val === "blip") return "Pay with Blip";
    if (val === "wallet") return "Browser Wallet";
    return "";
  };

  const getIcon = (val: string) => {
    if (val === "blip") return <Smartphone size={15} />;
    if (val === "wallet") return <Wallet size={15} />;
    return null;
  };

  return (
    <div className="relative w-full" ref={ref}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center justify-between gap-2 border-b border-white/7 bg-[#171717] px-4 py-4 text-sm font-medium text-white transition hover:bg-white/5"
      >
        <div className="flex items-center gap-2">
          {getIcon(payTab)}
          {getLabel(payTab)}
        </div>
        <ChevronDown size={15} className={`transition-transform ${isOpen ? "rotate-180" : ""}`} />
      </button>

      {isOpen && (
        <div className="absolute left-0 right-0 top-full z-10 overflow-hidden rounded-b-xl border border-t-0 border-white/7 bg-[#171717] shadow-lg">
          <button
            onClick={() => {
              setPayTab("blip");
              setIsOpen(false);
            }}
            className={`flex w-full items-center gap-2 px-4 py-3 text-sm font-medium transition ${
              payTab === "blip" ? "bg-white/10 text-white" : "text-[#8b93a7] hover:bg-white/5 hover:text-white"
            }`}
          >
            <Smartphone size={15} />
            Pay with Blip
          </button>
          
          <button
            onClick={() => {
              setPayTab("wallet");
              setIsOpen(false);
            }}
            className={`flex w-full items-center gap-2 px-4 py-3 text-sm font-medium transition ${
              payTab === "wallet" ? "bg-white/10 text-white" : "text-[#8b93a7] hover:bg-white/5 hover:text-white"
            }`}
          >
            <Wallet size={15} />
            Browser Wallet
          </button>
          
          {showQiComingSoon && (
            <button
              disabled
              className="flex w-full items-center gap-2 px-4 py-3 text-sm font-medium text-[#4f5868] opacity-50 cursor-not-allowed select-none border-t border-white/7"
            >
              <Coins size={15} />
              Pay with Qi
              <span className="ml-auto text-[10px] uppercase tracking-wider text-[#8b93a7]">
                Coming soon
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
