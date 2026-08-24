"use client";

import Link from "next/link";
import Image from "next/image";
import { useState } from "react";
import { motion } from "framer-motion";
import { Logo } from "@/components/logo";
import { MerchantShowcase } from "@/components/landing/merchant-showcase";
import {
  ArrowRight,
  Check,
  CheckCircle,
  ChevronRight,
  CircleDollarSign,
  Clock,
  Code2,
  Copy,
  ExternalLink,
  Globe,
  Hash,
  Link as LinkIcon,
  Menu,
  MessageCircle,
  Package,
  QrCode,
  Send,
  ShieldCheck,
  ShoppingBag,
  ShoppingCart,
  Smartphone,
  Store,
  Tag,
  TrendingUp,
  Unlock,
  Users,
  Wallet,
  X,
  Zap,
} from "lucide-react";

const capabilities = [
  {
    icon: Zap,
    title: "Fast settlement",
    description: "Payments settle on Quai without unnecessary waiting.",
  },
  {
    icon: CircleDollarSign,
    title: "Stablecoin native",
    description: "Accept stablecoin payments with a familiar checkout flow.",
  },
  {
    icon: ShieldCheck,
    title: "Non-custodial",
    description:
      "Your payments stay in your control from checkout to settlement.",
  },
];

const steps = [
  {
    number: "01",
    title: "Create your checkout",
    description:
      "Set up your payment experience and give customers a simple way to pay.",
  },
  {
    number: "02",
    title: "Customer pays",
    description:
      "Customers connect their wallet, review the amount and confirm the payment.",
  },
  {
    number: "03",
    title: "Settle on Quai",
    description:
      "The payment is confirmed and the merchant receives the settlement.",
  },
];

export default function Home() {
  return (
    <main className="min-h-screen bg-[#0a0a0a] text-white">
      <Navbar />

      <div className="overflow-hidden">

      {/* Hero */}
      <section className="relative">
        <div className="grid-background pointer-events-none absolute inset-0 h-180" />

        <div className="relative mx-auto flex max-w-7xl flex-col items-center text-center gap-16 px-6 pb-24 pt-20 lg:px-8 lg:pb-32 lg:pt-28">
          <div className="flex flex-col items-center">
            <motion.div
              initial={{ opacity: 0, y: 20, filter: "blur(4px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              transition={{ type: "spring", stiffness: 90, damping: 20, mass: 0.5 }}
              className="relative mb-7 inline-flex items-center justify-center overflow-hidden rounded-full p-px"
            >
              <div className="absolute inset-[-1000%] animate-[spin_3s_linear_infinite] bg-[conic-gradient(from_90deg_at_50%_50%,transparent_0%,transparent_50%,#38bdf8_100%)]" />
              <div className="relative inline-flex items-center gap-2 rounded-full bg-[#0a0a0a] px-3.5 py-2 text-sm text-sky-200">
                <div className="absolute inset-0 rounded-full bg-sky-400/6" />
                <span className="relative z-10 flex items-center gap-2">
                  Built for the Quai ecosystem
                  <ChevronRight className="h-3.5 w-3.5 text-sky-400" />
                </span>
              </div>
            </motion.div>

            <motion.h1
              initial={{ opacity: 0, y: 30, filter: "blur(8px)", scale: 0.98 }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)", scale: 1 }}
              transition={{ type: "spring", stiffness: 80, damping: 20, delay: 0.1 }}
              className="max-w-4xl text-5xl font-semibold leading-[1.02] tracking-[-0.045em] text-white sm:text-6xl lg:text-7xl"
            >
              Payments built for
              <span className="block text-sky-400">
                the speed of Quai.
              </span>
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 80, damping: 20, delay: 0.2 }}
              className="mt-7 max-w-xl text-lg leading-8 text-slate-400 mx-auto"
            >
              Accept payments through a simple, non-custodial checkout. Give customers a familiar payment experience using browser extensions or seamlessly on mobile with Blip Pay.
            </motion.p>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 80, damping: 20, delay: 0.3 }}
              className="mt-9 flex flex-col justify-center gap-3 sm:flex-row"
            >
              <Link
                href="/onboarding"
                className="group inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-sky-400 px-5 font-medium text-slate-950 transition hover:bg-sky-300"
              >
                Start accepting payments
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Link>

              <Link
                href="/checkout/demo"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/4 px-5 font-medium text-white transition hover:border-white/20 hover:bg-white/7"
              >
                Try the checkout
              </Link>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 80, damping: 20, delay: 0.4 }}
              className="mt-10 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 text-sm text-slate-500"
            >
              <span className="flex items-center gap-2">
                <Check className="h-4 w-4 text-emerald-400" />
                Non-custodial
              </span>

              <span className="flex items-center gap-2">
                <Check className="h-4 w-4 text-emerald-400" />
                Stablecoin ready
              </span>

              <span className="flex items-center gap-2">
                <Check className="h-4 w-4 text-emerald-400" />
                Quai native
              </span>
            </motion.div>
          </div>

          {/* Dashboard Image */}
          <motion.div
            initial={{ opacity: 0, y: 40, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ type: "spring", stiffness: 70, damping: 20, delay: 0.4, mass: 1 }}
            className="relative mx-auto w-full max-w-5xl rounded-3xl border border-white/8 bg-gray-800 p-2 shadow-2xl"
          >
            <div className="overflow-hidden rounded-[18px] border border-white/4">
              <Image 
                src="/image.png" 
                alt="Dashboard Screenshot" 
                width={1200} 
                height={675} 
                className="w-full h-auto"
                priority
              />
            </div>
          </motion.div>
        </div>
      </section>

      {/* Capabilities */}
      <section className="relative border-y border-white/6 bg-white/1.5">
        <div className="mx-auto grid max-w-7xl gap-px px-6 sm:grid-cols-3 lg:px-8">
          {capabilities.map((item, index) => {
            const Icon = item.icon;

            return (
              <motion.div
                key={item.title}
                initial={{ opacity: 0, y: 15 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: index * 0.08 }}
                className="px-1 py-8 sm:px-8 sm:py-10"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-sky-400/10 bg-sky-400/6 text-sky-400">
                  <Icon className="h-5 w-5" />
                </div>

                <h3 className="mt-5 text-base font-medium text-white">
                  {item.title}
                </h3>

                <p className="mt-2 max-w-sm text-sm leading-6 text-slate-500">
                  {item.description}
                </p>
              </motion.div>
            );
          })}
        </div>
      </section>

      {/* Merchant showcase */}
      <MerchantShowcase />

      {/* Blip Wallet Integration Spotlight */}
      <section className="mx-auto max-w-7xl px-6 py-20 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="relative overflow-hidden rounded-3xl border border-[#C1ED00]/15 bg-[#C1ED00]/3 p-8 sm:p-12"
        >
          {/* Lime glow */}
          <div className="pointer-events-none absolute -right-32 -top-32 h-64 w-64 rounded-full bg-[#C1ED00]/10 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-16 -left-16 h-48 w-48 rounded-full bg-[#C1ED00]/6 blur-3xl" />

          <div className="relative grid gap-10 lg:grid-cols-2 lg:items-center">
            <div>
              {/* Blip logo + badge */}
              <div className="mb-6 flex items-center gap-3">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#C1ED00]">
                  <svg viewBox="0 0 100 100" className="h-7 w-7">
                    <path fill="#0F1116" d="m98.3 24.4c0-7.2-6.9-13.9-18.2-13.9-7.1-0.1-15.7 2-19.8 8.6-2.6-1.8-6.3-3.9-12.6-3.9-6.8 0-13.4 2.5-16.8 8.2-3.2-1.9-6.5-3.2-12.1-3.2-8.9 0-16.8 4.4-16.8 11.7v19.9c2.4 9.2 14.2 26 47.5 34.9 3.9 0.9 9.1 1.9 12.6 2.4 7.3 0.7 17.8-1.5 19.7-9.6 0.4-1.8 0-8.5 0.2-8.5 2.6-0.6 7.9-3.7 8.6-9.3v-8.4c3.2-1.3 7.7-4.8 7.7-10.2v-18.7z"/>
                    <path fill="#C1ED00" d="m58.4 26.6c-1.3-3.5-6.5-5.1-10.7-5-6.3 0-12.5 2.9-11.1 7 2.5 6.9 11.1 15.4 25.9 18.6 3.7 0.9 7.6 1.4 10.9 1.5 10.1 0 14-7 7.7-10.5-3.3-1.8-5.7-1.6-7.7-2-5.7-0.8-12.7-3.6-15-9.6zm-28.8 4.3c-1.5-2.7-6-4.6-10.8-4.6-6.7 0-12.5 3.2-10.9 7.3 3 8 13.7 20.3 35.6 26.9 4.9 1.6 11.1 2.9 16 3.7 12 2 19.6-3.7 15-8-2.9-2.4-5.9-2.7-7.8-3-13.2-1.6-32.1-8.6-37.1-22.3zm49.3-14.1c-7.8 0-13.7 3.6-13.7 7.4 0 2.9 3.9 7.2 13.2 7.3 8.2 0 14-3.3 14-7.1 0.1-3.2-4-7.4-13.5-7.6z"/>
                  </svg>
                </span>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-widest text-[#C1ED00]">Blip Integration</p>
                  <p className="text-sm text-slate-400">Self-custody mobile wallet for Quai (iOS & Android)</p>
                </div>
              </div>

              <h2 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                Your customers pay{" "}
                <span className="text-[#C1ED00]">from their phone.</span>
              </h2>

              <p className="mt-4 max-w-lg leading-7 text-slate-500">
                TripplePay || Marchants integrates natively with <strong className="text-slate-300">Blip</strong> — the premier self-custody mobile wallet for Quai (iOS & Android). Customers scan a QR code or tap a link, and the Blip app opens with the payment pre-filled. One tap to confirm.
              </p>

              <ul className="mt-6 space-y-3">
                {[
                  "QR code checkout automatically opens Blip",
                  "Deep-link pre-fills amount + merchant address",
                  "Detected automatically in Blip's in-app browser",
                  "No app switching — payment done in seconds",
                ].map((feat) => (
                  <li key={feat} className="flex items-start gap-3 text-sm text-slate-400">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#C1ED00]/15 text-[#C1ED00]">
                      <Check className="h-3 w-3" />
                    </span>
                    {feat}
                  </li>
                ))}
              </ul>

              <div className="mt-8 flex flex-wrap gap-3">
                <Link
                  href="/checkout/demo"
                  className="inline-flex items-center gap-2 rounded-xl bg-[#C1ED00] px-5 py-2.5 text-sm font-semibold text-[#0F1116] transition hover:bg-[#d4ff00]"
                >
                  See it in the checkout demo
                  <ChevronRight className="h-4 w-4" />
                </Link>
                <a
                  href="https://blippay.me"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 rounded-xl border border-[#C1ED00]/20 bg-[#C1ED00]/5 px-5 py-2.5 text-sm font-medium text-[#C1ED00] transition hover:border-[#C1ED00]/40"
                >
                  Get Blip
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>
            </div>

            {/* Visual: how the Blip flow works */}
            <div className="mx-auto w-full max-w-sm space-y-3">
              {[
                { step: "01", title: "Customer sees checkout", desc: "QR code or 'Open in Blip' button on payment page", icon: QrCode },
                { step: "02", title: "Blip opens automatically", desc: "Deep-link pre-fills merchant address and amount", icon: Smartphone },
                { step: "03", title: "One tap to confirm", desc: "Quai settles on-chain instantly, merchant is notified", icon: Check },
              ].map(({ step, title, desc, icon: Icon }) => (
                <div key={step} className="flex items-start gap-4 rounded-2xl border border-white/7 bg-[#0a0a0a] p-4">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#C1ED00]/10 text-[#C1ED00]">
                    <Icon className="h-4 w-4" />
                  </span>
                  <div>
                    <p className="text-xs font-medium text-[#C1ED00]">{step}</p>
                    <p className="text-sm font-medium text-white">{title}</p>
                    <p className="text-xs text-slate-500">{desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </motion.div>
      </section>

      {/* How it works */}
      <section
        id="how-it-works"
        className="mx-auto max-w-7xl px-6 py-24 lg:px-8 lg:py-32"
      >
        <div className="max-w-2xl">
          <p className="text-sm font-medium text-sky-400">HOW IT WORKS</p>

          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            From checkout to settlement,
            <span className="text-slate-500">
              {" "}
              without the complexity.
            </span>
          </h2>
        </div>

        <div className="mt-16 grid gap-8 md:grid-cols-3">
          {steps.map((step, index) => (
            <motion.div
              key={step.number}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: index * 0.1 }}
              className="group relative"
            >
              {index < steps.length - 1 && (
                <div className="absolute left-[calc(100%+1rem)] top-5 hidden h-px w-8 bg-white/10 md:block" />
              )}

              <div className="text-sm font-medium text-sky-400">
                {step.number}
              </div>

              <h3 className="mt-6 text-xl font-medium text-white">
                {step.title}
              </h3>

              <p className="mt-3 max-w-sm text-sm leading-7 text-slate-500">
                {step.description}
              </p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* Developer / QR section */}
      <section
        id="developers"
        className="mx-auto max-w-7xl px-6 pb-24 lg:px-8 lg:pb-32"
      >
        <div className="relative overflow-hidden rounded-[28px] border border-white/7 bg-white/2 p-8 sm:p-12">
          <div className="relative grid gap-12 lg:grid-cols-[1fr_auto] lg:items-center">
            <div>
              <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-sky-400/20 bg-sky-400/10 text-sky-400">
                <QrCode className="h-5 w-5" />
              </div>

              <h2 className="mt-6 max-w-2xl text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                A checkout your customers already understand.
              </h2>

              <p className="mt-4 max-w-xl leading-7 text-slate-500">
                Connect a wallet, review the payment, confirm and settle.
                Merchants can also generate QR-based payment requests and shareable
                <strong className="text-slate-300"> Payment Links </strong>
                for physical or mobile commerce. Share a simple link via email, SMS, or social media to get paid instantly.
              </p>

              <div className="mt-7 flex flex-wrap gap-3">
                <div className="flex items-center gap-2 rounded-lg border border-white/7 bg-black/20 px-3 py-2 text-xs text-slate-400">
                  <Code2 className="h-3.5 w-3.5 text-sky-400" />
                  Simple integration
                </div>

                <div className="flex items-center gap-2 rounded-lg border border-white/7 bg-black/20 px-3 py-2 text-xs text-slate-400">
                  <QrCode className="h-3.5 w-3.5 text-sky-400" />
                  QR payments
                </div>

                <div className="flex items-center gap-2 rounded-lg border border-sky-400/20 bg-sky-400/10 px-3 py-2 text-xs font-medium text-sky-400">
                  <LinkIcon className="h-3.5 w-3.5 text-sky-400" />
                  Payment Links
                </div>
              </div>
            </div>

            <div className="mx-auto w-full max-w-xs">
              <div className="rounded-2xl border border-white/10 bg-[#0a0a0a] p-4 shadow-2xl">
                <div className="rounded-xl border border-white/6 bg-white/2 p-5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-500">
                      Payment request
                    </span>

                    <Copy className="h-3.5 w-3.5 text-slate-600" />
                  </div>

                  <div className="mt-5 flex aspect-square items-center justify-center rounded-xl bg-white p-5">
                    <div className="grid h-full w-full grid-cols-7 gap-1 opacity-90">
                      {Array.from({ length: 49 }).map((_, index) => (
                        <div
                          key={index}
                          className={`rounded-xs ${
                            [
                              0, 1, 2, 4, 5, 6, 7, 9, 10, 12, 14, 15, 16, 18,
                              20, 22, 24, 25, 26, 28, 30, 32, 34, 36, 37, 39,
                              40, 42, 44, 45, 47, 48,
                            ].includes(index)
                              ? "bg-slate-950"
                              : "bg-white"
                          }`}
                        />
                      ))}
                    </div>
                  </div>

                  <div className="mt-4 text-center">
                    <p className="text-sm font-medium text-white">
                      25.00 QUAI
                    </p>

                    <p className="mt-1 text-xs text-slate-600">
                      Scan to pay
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Problems Section */}
      <section id="problems" className="mx-auto max-w-7xl px-6 py-24 lg:px-8 lg:py-32">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="mb-16"
        >
          <p className="text-sm font-medium text-sky-400 mb-4">THE PROBLEM</p>
          <h2 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">
            Payments in Africa are{" "}
            <span className="text-slate-400">broken.</span>
          </h2>
          <p className="mt-5 max-w-2xl text-lg leading-8 text-slate-400">
            Merchants across Nigeria and Africa face the same walls every day — walls that slow down commerce, drain profits, and lock out entire markets.
          </p>
        </motion.div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[
            {
              icon: Clock,
              title: "Slow Payment Settlement",
              desc: "Paystack, Flutterwave, NowPayments — settlements take 24–72 hours. You've made the sale but you can't access your money.",
              tag: "T+1 to T+3 days",
            },
            {
              icon: ShieldCheck,
              title: "KYC Hassle",
              desc: "Endless document uploads, BVN checks, CAC verifications, and weeks of waiting just to start accepting payments.",
              tag: "Weeks of waiting",
            },
            {
              icon: Globe,
              title: "Cross-Border Friction",
              desc: "Sending or receiving money across borders? Expect blocked cards, FX markups, correspondent bank fees, and failed transfers.",
              tag: "Hidden fees",
            },
            {
              icon: CircleDollarSign,
              title: "High Transaction Fees",
              desc: "1.5–2% per transaction plus fixed charges — it adds up fast and eats directly into every merchant's margins.",
              tag: "Up to 2% per tx",
            },
            {
              icon: Wallet,
              title: "Custodial Platforms",
              desc: "Your funds are held by a third party. Account freezes, withdrawal limits, and arbitrary holds are a constant risk.",
              tag: "Not your keys",
            },
            {
              icon: Store,
              title: "Difficult Merchant Onboarding",
              desc: "Complex integrations, developer requirements, website mandates — most small merchants and social sellers never make it through.",
              tag: "Excludes millions",
            },
          ].map((item, i) => {
            const Icon = item.icon;
            return (
              <motion.div
                key={item.title}
                initial={{ opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4, delay: i * 0.07 }}
                className="group rounded-2xl border border-white/6 bg-white/2 p-6 hover:border-white/10 hover:bg-white/3 transition-all duration-300"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/8 bg-white/4 text-slate-300">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="mt-5 font-semibold text-white">{item.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-500">{item.desc}</p>
                <span className="mt-4 inline-flex items-center rounded-full border border-white/8 bg-white/4 px-2.5 py-0.5 text-xs font-medium text-slate-400">
                  {item.tag}
                </span>
              </motion.div>
            );
          })}
        </div>
      </section>

      {/* Solutions Section */}
      <section id="solution" className="border-y border-white/6">
        <div className="mx-auto max-w-7xl px-6 py-24 lg:px-8 lg:py-32">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
            className="mb-16"
          >
            <p className="text-sm font-medium text-sky-400 mb-4">THE SOLUTION</p>
            <h2 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">
              Everything payments{" "}
              <span className="text-slate-400">should be.</span>
            </h2>
            <p className="mt-5 max-w-2xl text-lg leading-8 text-slate-400">
              TripplePay || Merchants rebuilds payments from scratch — on-chain, borderless, and built for every merchant, everywhere.
            </p>
          </motion.div>

          <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
            {/* Left: Before */}
            <motion.div
              initial={{ opacity: 0, x: -24 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
              className="rounded-2xl border border-white/6 bg-white/2 p-8"
            >
              <p className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-6">Before — Traditional Rails</p>
              <div className="space-y-4">
                {[
                  "Settlement takes 1–3 business days",
                  "2% transaction fees eat into margins",
                  "KYC + compliance locks out merchants",
                  "Custodial — your funds, their control",
                  "Cross-border is expensive & unreliable",
                  "Need a website + developer to get started",
                ].map((item) => (
                  <div key={item} className="flex items-center gap-3">
                    <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-white/8 bg-white/4">
                      <X className="h-3 w-3 text-slate-500" />
                    </div>
                    <span className="text-sm text-slate-500 line-through">{item}</span>
                  </div>
                ))}
              </div>
            </motion.div>

            {/* Right: After */}
            <motion.div
              initial={{ opacity: 0, x: 24 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: 0.1 }}
              className="rounded-2xl border border-sky-400/15 bg-sky-400/3 p-8"
            >
              <p className="text-xs font-semibold uppercase tracking-widest text-sky-400 mb-6">After — TripplePay || Marchants</p>
              <div className="space-y-4">
                {[
                  { label: "Lightning-fast settlement — seconds, not days", highlight: false },
                  { label: "Ultra-low fees — fractions of a cent on Quai", highlight: false },
                  { label: "No KYC — start accepting payments immediately", highlight: true },
                  { label: "Non-custodial — your wallet, your funds, always", highlight: false },
                  { label: "Borderless — accept from anyone, anywhere", highlight: false },
                  { label: "Free to all — no website or developer required", highlight: true },
                ].map((item) => (
                  <div key={item.label} className="flex items-center gap-3">
                    <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-sky-400/20 bg-sky-400/10">
                      <Check className="h-3 w-3 text-sky-400" />
                    </div>
                    <span className={`text-sm ${item.highlight ? "text-white font-medium" : "text-slate-300"}`}>
                      {item.label}
                    </span>
                  </div>
                ))}
              </div>

              <div className="mt-8">
                <Link
                  href="/onboarding"
                  className="group inline-flex items-center gap-2 rounded-xl bg-sky-400 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-sky-300"
                >
                  Get started free
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </Link>
              </div>
            </motion.div>
          </div>
        </div>
      </section>

      {/* Social Commerce Section */}
      <section id="social-commerce" className="mx-auto max-w-7xl px-6 py-24 lg:px-8 lg:py-32">
        <div className="grid gap-16 lg:grid-cols-2 lg:items-center">
          {/* Left copy */}
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
          >
            <p className="text-sm font-medium text-sky-400 mb-4">SOCIAL COMMERCE</p>
            <h2 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">
              Not just merchants with websites.{" "}
              <span className="text-slate-400">Every seller, everywhere.</span>
            </h2>
            <p className="mt-5 max-w-xl leading-7 text-slate-400">
              We&apos;re not only building for developers or businesses with checkout pages. We&apos;re building for the <strong className="text-white">millions of sellers on social media and local markets</strong> who deserve a real payment solution.
            </p>

            <div className="mt-8 space-y-3">
              {[
                {
                  icon: ShoppingCart,
                  platform: "Facebook Marketplace",
                  desc: "Share a payment link in your listing. Buyers pay directly — no back-and-forth, no bank transfer drama.",
                },
                {
                  icon: MessageCircle,
                  platform: "WhatsApp & Telegram",
                  desc: "Send a payment link in chat. Your customer taps and pays in seconds. You see the confirmation instantly.",
                },
                {
                  icon: Hash,
                  platform: "Twitter / X & Instagram",
                  desc: "Drop your payment link in your bio or DMs. Turn followers into paying customers without a single line of code.",
                },
                {
                  icon: Store,
                  platform: "Local Vendors & Market Traders",
                  desc: "Physical market? No problem. Share a link or QR code. Get paid on the spot — no POS terminal needed.",
                },
              ].map((item, i) => {
                const Icon = item.icon;
                return (
                  <motion.div
                    key={item.platform}
                    initial={{ opacity: 0, x: -16 }}
                    whileInView={{ opacity: 1, x: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.4, delay: i * 0.08 }}
                    className="flex items-start gap-4 rounded-2xl border border-white/6 bg-white/2 p-4 hover:border-white/10 transition-all"
                  >
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/8 bg-white/4 text-slate-300">
                      <Icon className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="font-medium text-white">{item.platform}</p>
                      <p className="mt-1 text-sm leading-6 text-slate-500">{item.desc}</p>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </motion.div>

          {/* Right: Payment link demo card */}
          <motion.div
            initial={{ opacity: 0, y: 32, scale: 0.97 }}
            whileInView={{ opacity: 1, y: 0, scale: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.55, delay: 0.15 }}
            className="mx-auto w-full max-w-sm"
          >
            <div className="rounded-2xl border border-white/8 bg-[#0d0d0f] overflow-hidden">
              {/* Chat header */}
              <div className="flex items-center gap-2 border-b border-white/6 bg-white/2 px-4 py-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-full border border-white/8 bg-white/6">
                  <MessageCircle className="h-4 w-4 text-slate-300" />
                </div>
                <div>
                  <p className="text-xs font-semibold text-white">Chat — Amaka&apos;s Store</p>
                  <p className="text-[10px] text-slate-500">Payment link request</p>
                </div>
              </div>

              {/* Chat messages */}
              <div className="px-4 py-4 space-y-3">
                <div className="ml-auto max-w-[80%] rounded-2xl rounded-br-sm border border-white/6 bg-white/4 p-3">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Tag className="h-3 w-3 text-slate-400" />
                    <p className="text-[10px] text-slate-400">Ankara Dress — Order #142</p>
                  </div>
                  <p className="text-xs text-slate-200">Here&apos;s your payment link. Tap to pay securely.</p>
                </div>

                <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm border border-sky-400/20 bg-sky-400/5 p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <LinkIcon className="h-3 w-3 text-sky-400" />
                    <p className="text-[10px] font-medium text-sky-400">tripplepay.com/pay/ord-142</p>
                  </div>
                  <div className="rounded-lg border border-white/6 bg-[#0a0a0a] p-3">
                    <p className="text-[10px] text-slate-500 mb-1">Payment Request</p>
                    <p className="text-sm font-bold text-white">25.00 QUAI</p>
                    <p className="text-[10px] text-slate-500 mt-0.5">Ankara Wrap Dress — Order #142</p>
                    <div className="mt-2 rounded-md bg-sky-400 py-1.5 text-center">
                      <p className="text-[10px] font-semibold text-slate-950">Pay Now with Quai</p>
                    </div>
                  </div>
                </div>

                <div className="max-w-[65%] rounded-2xl rounded-bl-sm border border-white/6 bg-white/3 p-3">
                  <div className="flex items-center gap-1.5">
                    <CheckCircle className="h-3 w-3 text-slate-400" />
                    <p className="text-xs text-slate-300">Payment confirmed. Order dispatched.</p>
                  </div>
                </div>
              </div>

              {/* Footer */}
              <div className="border-t border-white/6 px-4 py-4">
                <p className="text-[10px] font-medium text-slate-500 mb-3 uppercase tracking-wider">Why payment links work</p>
                <div className="space-y-2">
                  {[
                    { icon: Check, label: "Every order tracked automatically — no mix-ups" },
                    { icon: Zap, label: "Instant on-chain confirmation, no chasing" },
                    { icon: Package, label: "Orders tagged and organised, not random transfers" },
                    { icon: Unlock, label: "No app install or signup needed for buyers" },
                  ].map(({ icon: Icon, label }) => (
                    <div key={label} className="flex items-center gap-2">
                      <Icon className="h-3.5 w-3.5 shrink-0 text-sky-400" />
                      <p className="text-xs text-slate-500">{label}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Future / Roadmap Section */}
      <section id="roadmap" className="border-t border-white/6">
        <div className="mx-auto max-w-7xl px-6 py-24 lg:px-8 lg:py-32">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
            className="mb-16"
          >
            <p className="text-sm font-medium text-sky-400 mb-4">WHAT&apos;S COMING</p>
            <h2 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">
              The future of{" "}
              <span className="text-slate-400">TripplePay || Marchants.</span>
            </h2>
            <p className="mt-5 max-w-2xl text-lg leading-8 text-slate-400">
              We&apos;re just getting started. Here&apos;s where we&apos;re taking this — from social commerce to global infrastructure.
            </p>
          </motion.div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              {
                icon: ShoppingBag,
                title: "Shopify Integration",
                desc: "One-click plugin for Shopify stores. Any Shopify merchant goes live with Quai payments in minutes — no developer needed.",
                status: "Coming Soon",
              },
              {
                icon: TrendingUp,
                title: "Direct Off-Ramp to Bank",
                desc: "Convert your Quai earnings directly to your personal or business bank account. Seamless fiat exit, no middlemen.",
                status: "Coming Soon",
              },
              {
                icon: Smartphone,
                title: "Mobile SDK",
                desc: "Native iOS and Android SDKs so developers can embed TripplePay || Marchants checkout into any mobile app with a few lines of code.",
                status: "Planned",
              },
              {
                icon: Users,
                title: "Merchant Analytics",
                desc: "Deep insights into your payment volume, top customers, order tracking, and revenue trends — all in one dashboard.",
                status: "In Progress",
              },
              {
                icon: Send,
                title: "Subscriptions & Recurring Payments",
                desc: "Set up subscription plans, recurring billing, and auto-pay for your customers. Built for SaaS, memberships, and services.",
                status: "Planned",
              },
              {
                icon: Code2,
                title: "WooCommerce Plugin",
                desc: "A native WooCommerce extension so any WordPress store can accept Quai payments with a single plugin install.",
                status: "Planned",
              },
            ].map((item, i) => {
              const Icon = item.icon;
              const isActive = item.status === "In Progress";
              return (
                <motion.div
                  key={item.title}
                  initial={{ opacity: 0, y: 24 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.4, delay: i * 0.07 }}
                  className="group rounded-2xl border border-white/6 bg-white/2 p-6 hover:border-white/10 hover:bg-white/3 transition-all duration-300"
                >
                  <div className="flex items-start justify-between mb-5">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/8 bg-white/4 text-slate-300">
                      <Icon className="h-5 w-5" />
                    </div>
                    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                      isActive
                        ? "border-sky-400/20 bg-sky-400/8 text-sky-400"
                        : "border-white/8 bg-white/4 text-slate-500"
                    }`}>
                      {item.status}
                    </span>
                  </div>
                  <h3 className="font-semibold text-white">{item.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-slate-500">{item.desc}</p>
                </motion.div>
              );
            })}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="relative border-t border-white/6">
        <div className="relative mx-auto max-w-4xl px-6 py-24 text-center lg:py-32">
          <p className="text-sm font-medium text-sky-400">READY TO BUILD?</p>

          <h2 className="mt-4 text-4xl font-semibold tracking-[-0.03em] text-white sm:text-5xl">
            Start accepting payments on Quai.
          </h2>

          <p className="mx-auto mt-5 max-w-xl leading-7 text-slate-500">
            Give your customers a simple way to pay and give your business a
            settlement experience built for the next generation of commerce.
          </p>

          <Link
            href="/onboarding"
            className="group mt-8 inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-sky-400 px-6 font-medium text-slate-950 transition hover:bg-sky-300"
          >
            Get started
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </div>
      </section>

      <Footer />
      </div>
    </main>
  );
}

function Navbar() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-white/5 bg-[#0a0a0a]/80 backdrop-blur-xl">
      <nav className="mx-auto flex h-18 max-w-7xl items-center justify-between px-6 lg:px-8">
        <Link href="/" className="flex items-center gap-2.5">
          <Logo />
          <span className="text-sm font-semibold tracking-tight text-white">
            TRIPPLEPAY ||<span className="text-sky-400">MERCHANTS</span>
          </span>
        </Link>

        <div className="hidden items-center gap-8 md:flex">
          <a href="#how-it-works" className="text-sm text-slate-500 transition hover:text-white">How it works</a>
          <Link href="/checkout/demo" className="text-sm text-slate-500 transition hover:text-white">Checkout Demo</Link>
          <a href="#problems" className="text-sm text-slate-500 transition hover:text-white">Why Us</a>
          <a href="#developers" className="text-sm text-slate-500 transition hover:text-white">Developers</a>
          <Link href="/docs" className="text-sm text-slate-500 transition hover:text-white">Docs</Link>
          <Link href="/terms" className="text-sm text-slate-500 transition hover:text-white">Terms</Link>
        </div>

        <div className="hidden items-center gap-3 md:flex">
          <Link href="/login" className="rounded-lg px-3 py-2 text-sm text-slate-400 transition hover:text-white">Merchant login</Link>
          <Link href="/onboarding" className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-slate-200">Get started</Link>
        </div>

        <button
          type="button"
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          aria-label="Open menu"
          className="rounded-lg border border-white/10 p-2 text-slate-300 md:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>
      </nav>

      {mobileMenuOpen && (
        <div className="absolute left-0 top-18 w-full border-b border-white/5 bg-[#0a0a0a] shadow-xl md:hidden">
          <div className="flex flex-col gap-4 p-6">
            <a href="#how-it-works" onClick={() => setMobileMenuOpen(false)} className="text-sm text-slate-400 hover:text-white">How it works</a>
            <Link href="/checkout/demo" onClick={() => setMobileMenuOpen(false)} className="text-sm text-slate-400 hover:text-white">Checkout Demo</Link>
            <a href="#problems" onClick={() => setMobileMenuOpen(false)} className="text-sm text-slate-400 hover:text-white">Why Us</a>
            <a href="#developers" onClick={() => setMobileMenuOpen(false)} className="text-sm text-slate-400 hover:text-white">Developers</a>
            <Link href="/docs" onClick={() => setMobileMenuOpen(false)} className="text-sm text-slate-400 hover:text-white">Docs</Link>
            <Link href="/terms" onClick={() => setMobileMenuOpen(false)} className="text-sm text-slate-400 hover:text-white">Terms</Link>
            
            <div className="my-2 h-px bg-white/5" />
            
            <Link href="/login" onClick={() => setMobileMenuOpen(false)} className="text-sm text-slate-400 hover:text-white">Merchant login</Link>
            <Link href="/onboarding" onClick={() => setMobileMenuOpen(false)} className="text-sm font-medium text-sky-400 hover:text-sky-300">Get started</Link>
          </div>
        </div>
      )}
    </header>
  );
}

function Footer() {
  return (
    <footer className="border-t border-white/6">
      <div className="mx-auto flex max-w-7xl flex-col gap-5 px-6 py-8 sm:flex-row sm:items-center sm:justify-between lg:px-8">
        <div className="flex items-center gap-2.5">
          <Logo />

          <span className="text-sm font-medium text-slate-400">
            TripplePay || Marchants
          </span>
        </div>

        <div className="flex items-center gap-5 text-xs text-slate-600">
          <Link href="/docs" className="transition hover:text-slate-400">
            Docs
          </Link>
          <span>•</span>
          <Link href="/terms" className="transition hover:text-slate-400">
            Terms of Service
          </Link>
          <span>•</span>
          <span>Built on Quai Network</span>
          <span>•</span>
          <span>MVP Demo</span>
        </div>
      </div>
    </footer>
  );
}