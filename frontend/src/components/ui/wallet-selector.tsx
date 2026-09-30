"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { parseError } from "@/lib/utils";
import { Check, Loader2, RefreshCw, Wallet, X } from "lucide-react";
import {
  connectWallet,
  detectWallets,
  ensureNetwork,
  getActiveWallet,
  storeWalletId,
  walletSupportsChain,
  chainsSupportedBy,
  type DetectedWallet,
  type WalletBrand,
} from "@/lib/wallets";
import { getDefaultChain, listAvailableChains, listChains, type ChainInfo } from "@/lib/chains";
import { useConnectedChain } from "@/lib/relayer";

/** What to tell a merchant when a wallet is blocked by a chain that isn't live right now — never
 *  exposes the raw env var name from `missingConfigHint` to a merchant-facing picker, unlike the
 *  console diagnostic `chains.ts` already logs for whoever runs this deployment. */
function chainUnavailableReason(c: ChainInfo): string {
  return c.availability === "misconfigured"
    ? `${c.name} is temporarily unavailable — contact support.`
    : `${c.name} isn't launched yet — coming soon.`;
}

/** What to tell a merchant when a LIVE chain simply isn't one the connected wallet can reach —
 *  not an error, just the same capability split used throughout (see walletSupportsChain). */
function chainIncompatibleWithWalletReason(c: ChainInfo): string {
  return c.kind === "quai" ? "Not Quai-compatible — install Pelagus or Blip" : "Not compatible with this wallet";
}

const brandStyles: Record<WalletBrand, { bg: string; text: string }> = {
  pelagus: { bg: "bg-[#38bdf8]", text: "text-[#061018]" },
  blip: { bg: "bg-[#C1ED00]", text: "text-[#0F1116]" },
  metamask: { bg: "bg-orange-500", text: "text-[#061018]" },
  rabby: { bg: "bg-violet-500", text: "text-[#061018]" },
  coinbase: { bg: "bg-blue-500", text: "text-[#061018]" },
  brave: { bg: "bg-orange-600", text: "text-[#061018]" },
  okx: { bg: "bg-slate-800", text: "text-[#061018]" },
  bitget: { bg: "bg-sky-600", text: "text-[#061018]" },
  trust: { bg: "bg-blue-700", text: "text-[#061018]" },
  frame: { bg: "bg-white/6", text: "text-white" },
  generic: { bg: "bg-slate-200", text: "text-[#061018]" },
};

const brandInitials: Record<WalletBrand, string> = {
  pelagus: "P",
  blip: "B",
  metamask: "M",
  rabby: "R",
  coinbase: "C",
  brave: "B",
  okx: "O",
  bitget: "B",
  trust: "T",
  frame: "F",
  generic: "W",
};

function WalletMark({ wallet }: { wallet: DetectedWallet }) {
  const { brand, icon } = wallet;
  // Per-instance: whether THIS wallet's announced icon failed to actually load (broken/
  // unreachable data URI) — falls back to the initial letter below rather than a broken image.
  const [iconFailed, setIconFailed] = useState(false);
  // Blip uses its own logo SVG — outside EIP-6963 (Quai's injection channel), so it never has
  // an announced icon to prefer instead.
  if (brand === "blip") {
    return (
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#C1ED00]">
        <svg viewBox="0 0 100 100" className="h-6 w-6">
          <path fill="#0F1116" d="m98.3 24.4c0-7.2-6.9-13.9-18.2-13.9-7.1-0.1-15.7 2-19.8 8.6-2.6-1.8-6.3-3.9-12.6-3.9-6.8 0-13.4 2.5-16.8 8.2-3.2-1.9-6.5-3.2-12.1-3.2-8.9 0-16.8 4.4-16.8 11.7v19.9c2.4 9.2 14.2 26 47.5 34.9 3.9 0.9 9.1 1.9 12.6 2.4 7.3 0.7 17.8-1.5 19.7-9.6 0.4-1.8 0-8.5 0.2-8.5 2.6-0.6 7.9-3.7 8.6-9.3v-8.4c3.2-1.3 7.7-4.8 7.7-10.2v-18.7z"/>
          <path fill="#C1ED00" d="m58.4 26.6c-1.3-3.5-6.5-5.1-10.7-5-6.3 0-12.5 2.9-11.1 7 2.5 6.9 11.1 15.4 25.9 18.6 3.7 0.9 7.6 1.4 10.9 1.5 10.1 0 14-7 7.7-10.5-3.3-1.8-5.7-1.6-7.7-2-5.7-0.8-12.7-3.6-15-9.6zm-28.8 4.3c-1.5-2.7-6-4.6-10.8-4.6-6.7 0-12.5 3.2-10.9 7.3 3 8 13.7 20.3 35.6 26.9 4.9 1.6 11.1 2.9 16 3.7 12 2 19.6-3.7 15-8-2.9-2.4-5.9-2.7-7.8-3-13.2-1.6-32.1-8.6-37.1-22.3zm49.3-14.1c-7.8 0-13.7 3.6-13.7 7.4 0 2.9 3.9 7.2 13.2 7.3 8.2 0 14-3.3 14-7.1 0.1-3.2-4-7.4-13.5-7.6z"/>
        </svg>
      </span>
    );
  }
  // Real artwork the wallet announced itself via EIP-6963 — never reconstructed or guessed here.
  if (icon && !iconFailed) {
    return (
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/5 overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element -- data: URI, not a static asset */}
        <img
          src={icon}
          alt=""
          className="h-7 w-7 object-contain"
          onError={() => setIconFailed(true)}
        />
      </span>
    );
  }
  // No announced icon (a wallet only found via the legacy window.ethereum fallback scan), or one
  // that failed to load — fall back to an initial letter.
  const style = brandStyles[brand];
  return (
    <span
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-sm font-bold ${style.bg} ${style.text}`}
    >
      {brandInitials[brand]}
    </span>
  );
}

type WalletSelectorProps = {
  connectedAddress: string | null;
  onConnected: (address: string) => void;
  onDisconnect?: () => void;
  label?: string;
  /** Which chain to connect/switch to. Defaults to the default chain (Quai today) — every
   *  existing caller that omits this keeps behaving exactly as before.
   *  Pass `"any"` for a chain-free flow (e.g. merchant login): every wallet that can sign for
   *  AT LEAST ONE configured chain is listed, labeled with which chain(s) it supports, and no
   *  network switch is attempted on connect — the caller (e.g. loginWithWallet) resolves and
   *  switches to whichever chain it actually needs afterwards. */
  chain?: ChainInfo | "any";
  /** Smaller pill-style trigger button, for tight spaces like a page header — same picker modal
   *  and logic, just a different trigger. Default (false) keeps the full-width block button every
   *  existing caller already gets. */
  compact?: boolean;
  /** Overrides the compact trigger's "connected" text (default: chain name, or "Wallet" for
   *  `chain="any"`) — e.g. showing the wallet's ACTUAL current chain even when connecting via
   *  the chain-free "any" flow. */
  connectedLabel?: string;
  /** The address this picker should treat as "the signed-in account", if any (e.g. the
   *  dashboard's merchant session address). When set, connecting a wallet that reports a
   *  DIFFERENT address is never silently accepted as a switch — `onAddressMismatch` fires
   *  instead of `onConnected`, and the caller decides what happens next (this component never
   *  changes which wallet is active in that case). Omit for flows with no identity to protect
   *  (login, checkout, onboarding) — every existing caller keeps behaving exactly as before. */
  expectedAddress?: string | null;
  /** Fires instead of `onConnected` when a connected wallet's address doesn't match
   *  `expectedAddress`. The wallet is NOT stored as active and the session is untouched — purely
   *  informational, so the caller can offer "sign in as that account" or "cancel". */
  onAddressMismatch?: (wallet: DetectedWallet, address: string) => void;
  /** Adds a "Network" section to the SAME panel, below the wallet list: the current chain plus
   *  every other configured chain, switchable via the wallet's own network-switch prompt
   *  (ensureNetwork) — no separate control, no page reload. Opt-in (default false) so every
   *  existing caller that only wants a wallet picker (login, checkout, a payment link's chain-
   *  scoped connect button, ...) keeps behaving exactly as before; only a caller that already
   *  shows the connected chain next to this trigger (the dashboard header/sidebar badge) should
   *  set it, since the trigger's OWN label is what makes this discoverable to begin with. */
  showChainSwitcher?: boolean;
};

export function WalletSelector({
  connectedAddress,
  onConnected,
  onDisconnect,
  label = "Connect wallet",
  chain = getDefaultChain(),
  compact = false,
  connectedLabel,
  expectedAddress,
  onAddressMismatch,
  showChainSwitcher = false,
}: WalletSelectorProps) {
  const [open, setOpen] = useState(false);
  // Shared busy lock across BOTH the wallet list and the network list below — connecting a
  // wallet and switching a network are mutually exclusive actions on the same trigger, so one
  // string tells every row (wallet or chain) whether IT is the one in flight (`wallet.id`, or
  // `chain:<chainId>`) and disables the rest.
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wallets = detectWallets();
  const active = getActiveWallet();
  // Only chains actually usable right now — the chain-free flow must never tell a merchant a
  // wallet "signs for" a chain that isn't available yet (e.g. Base Sepolia pre-deployment).
  const configuredChains = listAvailableChains();
  // The FULL table, including not-yet-launched/misconfigured chains — used to explain WHY a
  // wallet looks incompatible (see blockedByChain below) and, when showChainSwitcher is on, as
  // the Network section's own list (a not-live chain still needs to be SHOWN, just disabled).
  const allChains = listChains();
  // The chain the active wallet is actually on right now — falls back to the default chain when
  // nothing's connected or its reported chain isn't one this app configures (see
  // useConnectedChain). Only meaningful (and only rendered) when showChainSwitcher is on.
  const currentChain = useConnectedChain();

  const switchChain = async (c: ChainInfo) => {
    if (!active) return;
    setBusy(`chain:${c.chainId}`);
    setError(null);
    try {
      await ensureNetwork(active, c);
      // The wallet itself hasn't changed, only which network it's on — re-announce the SAME id so
      // every useConnectedChain/useChainSelector subscriber (balances, the links chain picker,
      // this trigger's own label) re-resolves, exactly like a wallet switch already does.
      storeWalletId(active.id);
      setOpen(false);
    } catch (err) {
      setError(parseError(err));
    } finally {
      setBusy(null);
    }
  };

  // Whichever trigger button is currently rendered (connected vs. not-connected state — see the
  // two early returns below) — both attach this same ref, so focus always has somewhere to
  // return to when the popup closes, regardless of which one opened it.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  // Focus management + Escape-to-close for the popup, as a proper dialog: move focus into it on
  // open, trap Tab/Shift+Tab within it while open, and return focus to the trigger on close —
  // whether that close came from Escape, the backdrop, the explicit close button, or a
  // successful connect.
  useEffect(() => {
    if (!open) return;
    // Captured now, not read from the ref inside the cleanup below — by the time that cleanup
    // runs (e.g. after a successful connect swaps which trigger button is rendered), the ref may
    // already point at a different DOM node.
    const trigger = triggerRef.current;
    const focusableSelector =
      'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    const getFocusable = () =>
      Array.from(popupRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? []);
    // Move focus into the popup as soon as it's in the DOM.
    getFocusable()[0]?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        return;
      }
      if (e.key !== "Tab") return;
      const nodes = getFocusable();
      if (nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      trigger?.focus();
    };
  }, [open]);

  const connect = async (wallet: DetectedWallet) => {
    setBusy(wallet.id);
    setError(null);
    try {
      if (chain === "any") {
        // Chain-free: connect and validate the address against whichever configured chain this
        // wallet actually supports — no target network to switch to yet (the caller resolves
        // and switches to one afterwards, e.g. loginWithWallet signing for the wallet's current
        // chain).
        const supportedChains = chainsSupportedBy(wallet, configuredChains);
        const validationChain = supportedChains[0];
        if (!validationChain) {
          throw new Error(`${wallet.name} can't sign for any chain this app supports.`);
        }
        const address = await connectWallet(wallet, validationChain);
        // A connected wallet reporting a DIFFERENT address than the signed-in session is a
        // different merchant account — never switch the active wallet for that silently; hand it
        // to the caller to ask the merchant what they want instead.
        if (expectedAddress && address.toLowerCase() !== expectedAddress.toLowerCase()) {
          setOpen(false);
          onAddressMismatch?.(wallet, address);
          return;
        }
        storeWalletId(wallet.id);
        setOpen(false);
        onConnected(address);
        return;
      }

      // Only Pelagus connects before any network check — its EIP-3326 requests hang, so it
      // gets a verify-free pass. Every other wallet is put on the target chain first (Blip's
      // documented provider supports switch/add and answers quai_chainId instantly, even
      // before accounts are connected). ensureNetwork itself refuses a wallet/chain pair that
      // can't work (e.g. a generic EVM wallet asked to switch to Quai) before any RPC call —
      // this ordering is just about avoiding Pelagus's hang, not about safety.
      const quaiNative = wallet.brand === "pelagus" && chain.kind === "quai";
      let address: string;
      if (quaiNative) {
        address = await connectWallet(wallet, chain);
        await ensureNetwork(wallet, chain);
      } else {
        await ensureNetwork(wallet, chain);
        address = await connectWallet(wallet, chain);
      }

      if (expectedAddress && address.toLowerCase() !== expectedAddress.toLowerCase()) {
        setOpen(false);
        onAddressMismatch?.(wallet, address);
        return;
      }

      storeWalletId(wallet.id);
      setOpen(false);
      onConnected(address);
    } catch (err) {
      setError(parseError(err));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!open) return;
    const provider = active?.provider;
    if (!provider?.on) return;
    const onAccountsChanged = () => {
      if (!connectedAddress) return;
      provider
        .request({ method: "eth_accounts" })
        .then((accounts) => {
          const list = accounts as string[];
          if (!list?.length) {
            onDisconnect?.();
          } else if (list[0] !== connectedAddress) {
            onConnected(list[0]);
          }
        })
        .catch(() => undefined);
    };
    provider.on("accountsChanged", onAccountsChanged);
    return () => provider.removeListener?.("accountsChanged", onAccountsChanged);
  }, [open, active, connectedAddress, onConnected, onDisconnect]);

  // Both states share ONE trigger ref and ONE popup below — the popup used to live only in this
  // function's "not connected" return branch, so the "connected" branch's button called
  // setOpen(true) into a state nothing downstream of it ever read: clicking the connected badge
  // set `open`, but that branch `return`ed before reaching the portal that would have rendered
  // anything for it. Merging into one return, with the popup shared by both states, is the fix.
  return (
    <>
      {connectedAddress ? (
        <button
          ref={triggerRef}
          onClick={() => setOpen(true)}
          className={
            compact
              ? "inline-flex items-center gap-1.5 rounded-full border border-emerald-400/15 bg-emerald-400/6 px-3 py-1.5 text-xs text-emerald-300 transition hover:bg-emerald-400/10"
              : "inline-flex w-full items-center justify-center gap-2 rounded-xl border border-white/7 bg-[#171717] px-4 py-2.5 text-sm font-medium text-[#c9d4e0] transition hover:bg-white/5"
          }
          title="Switch wallet"
        >
          {compact ? (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              {connectedLabel ?? `${chain === "any" ? "Wallet" : chain.name} connected`}
            </>
          ) : (
            <>
              <Wallet size={15} className="text-[#38bdf8]" />
              <span className="max-w-56 truncate font-mono text-xs">
                {connectedAddress}
              </span>
              <RefreshCw size={13} className="text-[#4f5868]" />
            </>
          )}
        </button>
      ) : (
        <button
          ref={triggerRef}
          onClick={() => setOpen(true)}
          className={
            compact
              ? "inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/4 px-3 py-1.5 text-xs text-[#8b93a7] transition hover:bg-white/8"
              : "inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#38bdf8] px-5 py-2.5 text-sm font-semibold text-[#061018] transition hover:bg-[#67d8ff]"
          }
        >
          {compact ? (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-white/20" />
              {label}
            </>
          ) : (
            <>
              <Wallet size={15} />
              {label}
            </>
          )}
        </button>
      )}

      {open &&
        createPortal(
          // Rendered into document.body via a portal — an ancestor anywhere in this component's
          // normal tree (e.g. the dashboard header's backdrop-blur) can establish a new
          // containing block for `position: fixed` descendants, which silently repositions this
          // overlay relative to that ancestor's box instead of the viewport. A portal sidesteps
          // that entirely rather than chasing it with z-index/offset patches.
          <div
            className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center"
            onClick={() => setOpen(false)}
          >
            <div
              ref={popupRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="wallet-selector-title"
              // max-h + overflow-y-auto: if the wallet list is taller than the available
              // viewport height, IT scrolls internally rather than being clipped top or bottom.
              className="flex max-h-[85vh] w-full max-w-md flex-col overflow-y-auto rounded-2xl border border-white/7 bg-[#171717] p-6 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
            <div className="flex items-start justify-between">
              <div>
                <h3 id="wallet-selector-title" className="text-lg font-semibold text-white">
                  {showChainSwitcher ? "Wallet & network" : "Connect a wallet"}
                </h3>
                <p className="mt-1 text-sm text-[#8b93a7]">
                  {showChainSwitcher
                    ? "Which wallet you're using, and which network it's on."
                    : chain === "any"
                      ? configuredChains.length > 0
                        ? `Connect any wallet that can sign for ${configuredChains.map((c) => c.name).join(" or ")}.`
                        : "No chain is currently available in this deployment — contact support."
                      : chain.kind === "quai"
                        ? "Only Blip, Pelagus and MetaMask can sign for Quai."
                        : `Any browser wallet except Blip can sign for ${chain.name}.`}
                </p>
              </div>

              <button
                onClick={() => setOpen(false)}
                aria-label="Close wallet picker"
                className="rounded-lg p-1.5 text-[#4f5868] transition hover:bg-white/8 hover:text-[#c9d4e0]"
              >
                <X size={18} />
              </button>
            </div>

            {showChainSwitcher && (
              <p className="mb-2 mt-5 text-[10px] font-semibold uppercase tracking-wider text-[#4f5868]">
                Wallet
              </p>
            )}
            <div className={showChainSwitcher ? "space-y-2" : "mt-5 space-y-2"}>
              {wallets.length === 0 && (
                <div className="rounded-xl border border-white/7 bg-[#171717] p-4 text-sm text-[#8b93a7]">
                  No wallet extension detected. Install{" "}
                  <a
                    href="https://chromewebstore.google.com/detail/pelagus/nhccebmfjcbhghphpclcfdkkekheegop"
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-[#38bdf8] hover:underline"
                  >
                    Pelagus
                  </a>{" "}
                  (Quai&apos;s official wallet) or MetaMask, then reload.
                </div>
              )}

              {wallets.map((wallet) => {
                const supportedChains = chain === "any" ? chainsSupportedBy(wallet, configuredChains) : undefined;
                const supported = chain === "any" ? supportedChains!.length > 0 : walletSupportsChain(wallet, chain);
                // A wallet that looks "incompatible" may really just be blocked by a chain that
                // isn't live right now (not-yet-launched, or this deployment's own misconfiguration)
                // rather than an actual capability mismatch — e.g. Pelagus (Quai-only) reporting
                // "not compatible" purely because Quai's contract address is unset here. Check
                // against the FULL chain table, not just the live ones, so we can name the real
                // problem instead of blaming the wallet for it.
                const blockedByChain = !supported
                  ? (chain === "any" ? allChains : [chain]).find(
                      (c) => c.availability !== "live" && walletSupportsChain(wallet, c),
                    )
                  : undefined;
                const chainNotCompatibleTitle = blockedByChain
                  ? chainUnavailableReason(blockedByChain)
                  : chain === "any"
                    ? "Not compatible with any configured chain"
                    : `Not compatible with ${chain.name}`;
                return (
                <button
                  key={wallet.id}
                  onClick={() => void connect(wallet)}
                  disabled={busy !== null || !supported}
                  title={supported ? undefined : chainNotCompatibleTitle}
                  className="flex w-full items-center gap-3 rounded-xl border border-white/7 bg-[#171717] p-3 text-left transition hover:border-[#38bdf8]/15 hover:bg-[#38bdf8]/6/60 disabled:opacity-60 disabled:hover:border-white/7 disabled:hover:bg-[#171717]"
                >
                  <WalletMark wallet={wallet} />

                  <span className="flex-1">
                    <span className="block text-sm font-medium text-white">
                      {wallet.name}
                    </span>
                    <span className="block text-xs text-[#8b93a7]">
                      {chain === "any"
                        ? supported
                          ? wallet.id === active?.id
                            ? "Previously connected"
                            : `Signs for ${supportedChains!.map((c) => c.name).join(", ")}`
                          : blockedByChain
                            ? chainUnavailableReason(blockedByChain)
                            : "Not compatible with any configured chain"
                        : supported
                          ? wallet.id === active?.id
                            ? "Previously connected"
                            : `${chain.name} ready`
                          : blockedByChain
                            ? chainUnavailableReason(blockedByChain)
                            : chain.kind === "quai"
                              ? "Not Quai-compatible — install Pelagus or Blip"
                              : "Not compatible with this chain"}
                    </span>
                  </span>

                  {busy === wallet.id ? (
                    <Loader2 size={16} className="animate-spin text-[#38bdf8]" />
                  ) : wallet.id === active?.id ? (
                    <Check size={16} className="text-emerald-400" />
                  ) : null}
                </button>
                );
              })}
            </div>

            {showChainSwitcher && active && (
              <>
                <p className="mb-2 mt-5 text-[10px] font-semibold uppercase tracking-wider text-[#4f5868]">
                  Network
                </p>
                <div className="space-y-2">
                  {allChains.map((c) => {
                    const isCurrent = currentChain.chainId === c.chainId;
                    const walletOk = walletSupportsChain(active, c);
                    const selectable = c.available && walletOk && !isCurrent;
                    // Two different reasons a chain can't be picked — never conflated: the chain
                    // itself isn't usable right now (not-yet-launched / misconfigured), or it IS
                    // live but this particular wallet can't reach it (e.g. Quai while on
                    // MetaMask). Both are calm, plain-language explanations, never an error.
                    const reason = !c.available
                      ? chainUnavailableReason(c)
                      : !walletOk
                        ? chainIncompatibleWithWalletReason(c)
                        : undefined;
                    const chainBusyKey = `chain:${c.chainId}`;
                    return (
                      <button
                        key={c.chainId}
                        onClick={() => void switchChain(c)}
                        disabled={busy !== null || !selectable}
                        title={isCurrent ? "Current network" : reason}
                        className="flex w-full items-center gap-3 rounded-xl border border-white/7 bg-[#171717] p-3 text-left transition hover:border-[#38bdf8]/15 hover:bg-[#38bdf8]/6/60 disabled:opacity-60 disabled:hover:border-white/7 disabled:hover:bg-[#171717]"
                      >
                        <span className="flex-1">
                          <span className="block text-sm font-medium text-white">
                            {c.name}
                            {!c.available && (
                              <span className="ml-1.5 text-[10px] uppercase tracking-wider text-[#4f5868]">
                                {c.availability === "misconfigured" ? "Unavailable" : "Soon"}
                              </span>
                            )}
                          </span>
                          <span className="block text-xs text-[#8b93a7]">
                            {isCurrent ? "Current network" : (reason ?? "Switch network")}
                          </span>
                        </span>

                        {busy === chainBusyKey ? (
                          <Loader2 size={16} className="animate-spin text-[#38bdf8]" />
                        ) : isCurrent ? (
                          <Check size={16} className="text-emerald-400" />
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {error && (
              <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
                {error}
              </div>
            )}

            <p className="mt-5 text-center text-xs text-[#4f5868]">
              The dApp never touches your keys — transactions are signed in
              your wallet.
            </p>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}