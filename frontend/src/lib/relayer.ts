"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { parseError } from "@/lib/utils";
import { formatUnits as formatUnitsQuai } from "quais";
import { formatUnits as formatUnitsEvm } from "ethers";
import { backendFetch } from "@/lib/payment";
import { currencyDecimals, currencySymbol } from "@/lib/currencies";
import { getChainById, getDefaultChain, type ChainInfo, type ChainKind } from "@/lib/chains";
import { getActiveWallet, getWalletChainId, subscribeToWalletChanges } from "@/lib/wallets";
import { getSessionToken, isLoggedIn, logout } from "@/lib/auth";
import { qitsToQi } from "@/lib/qi";

export interface DeliveryData {
  merchant: string;
  orderId: string;
  chainId: number;
  payer: string;
  token: string;
  amount: string;
  feeBps: number;
  fee: string;
  net: string;
  txHash: string;
  blockNumber: number;
  timestamp: number;
  /** Ledger discriminator. Absent on pre-Qi payloads ("quai"/"token"). */
  asset?: "quai" | "token" | "qi";
  /** Present only when asset === "qi". Full UTXO settlement context. */
  qi?: {
    address: string;
    qits: string;
    receivedQits: string;
    txHashes: string[];
  };
}

/** Optional payer context the payment pages report to the backend (absent → null). */
export interface DeliveryMeta {
  payerName: string | null;
  source: "link" | "checkout";
  slug: string | null;
  shopName: string | null;
}

export interface Delivery {
  id: string;
  merchantId: string;
  url: string;
  payload: { type: string; data: DeliveryData };
  status: "pending" | "delivered" | "failed" | "skipped";
  attempts: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  meta?: DeliveryMeta | null;
}

export interface Merchant {
  merchantId: string;
  address: string;
  name: string;
  webhookUrl: string;
  active: boolean;
  createdAt: number;
  /**
   * Where this merchant's money is paid on each chain, as returned by /v1/me.
   *
   * Distinct from `address`, which is the wallet the merchant SIGNS IN with. A link pays out to
   * the payout row for its chain, so a merchant can be one identity across several destinations.
   * Absent on demo/admin responses, which carry no payout map.
   */
  payouts?: PayoutAddress[];
}

export interface PayoutAddress {
  chainId: number;
  /** Null when the backend no longer serves this chain. */
  chainName: string | null;
  chainKind: ChainKind | null;
  address: string;
  /** `declared` = the merchant chose it; `login` = seeded from their sign-in wallet. */
  source: "declared" | "login";
  createdAt: number;
}

/** Session bearer token when available in memory; the HttpOnly cookie covers the rest. */
function adminHeaders(): Record<string, string> {
  const token = getSessionToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** /api/admin/* hits the Next.js proxy (same-origin); /v1/* hits the Express relayer. */
function relayerFetch(path: string, init?: RequestInit): Promise<Response> {
  if (path.startsWith("/api/")) {
    return fetch(path, { credentials: "include", ...init });
  }
  return backendFetch(path, init);
}

/** Error carrying the HTTP status so callers can react to 401 (expired session) specially. */
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function adminGet<T>(path: string): Promise<T> {
  const res = await relayerFetch(path, {
    headers: adminHeaders(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new HttpError(res.status, `backend error ${res.status}`);
  return (await res.json()) as T;
}

/** PUT/DELETE for the self-service payout endpoints, which have no admin proxy equivalent. */
export async function adminWrite<T>(path: string, method: "PUT" | "DELETE", body?: unknown): Promise<T> {
  const res = await relayerFetch(path, {
    method,
    headers: {
      ...adminHeaders(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new HttpError(res.status, detail?.error ?? `backend error ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function adminPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await relayerFetch(path, {
    method: "PATCH",
    headers: {
      ...adminHeaders(),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new HttpError(res.status, detail?.error ?? `backend error ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Live deliveries + merchants from the relayer backend, auto-refreshing.
 *  Logged-in merchants see only their own data (via /v1/me, cookie/token-authenticated).
 *  Without a session the demo falls back to the server-side admin proxy (the ADMIN_API_KEY
 *  never touches the browser). */
export function useRelayerData(intervalMs = 8000) {
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const refresh = useCallback(async () => {
    try {
      if (isLoggedIn()) {
        const [me, d] = await Promise.all([
          adminGet<Merchant>("/v1/me"),
          adminGet<{ deliveries: Delivery[] }>("/v1/me/deliveries"),
        ]);
        setDeliveries(d.deliveries);
        setMerchants([me]);
      } else {
        // Demo mode: proxied server-side with the admin key (see app/api/admin/[...path]/route.ts).
        const [d, m] = await Promise.all([
          adminGet<{ deliveries: Delivery[] }>("/api/admin/deliveries"),
          adminGet<{ merchants: Merchant[] }>("/api/admin/merchants"),
        ]);
        setDeliveries(d.deliveries);
        setMerchants(m.merchants);
      }
      setError(null);
    } catch (err) {
      // Session expired/revoked while the dashboard is open — sign out and go to /login.
      if (err instanceof HttpError && err.status === 401) {
        void logout();
        router.replace("/login");
        return;
      }
      // Transient network blips (ERR_NETWORK_CHANGED, Wi-Fi↔mobile) are expected on phones —
      // keep the last data and only surface an error when there's nothing to show yet.
      if (deliveries.length === 0 && merchants.length === 0) {
        setError(parseError(err));
      }
    } finally {
      setLoading(false);
    }
  }, [router, deliveries.length, merchants.length]);

  useEffect(() => {
    const timer = setInterval(() => void refresh(), intervalMs);
    const initial = setTimeout(() => void refresh(), 0);
    return () => {
      clearInterval(timer);
      clearTimeout(initial);
    };
  }, [refresh, intervalMs]);

  return { deliveries, merchants, loading, error, refresh };
}

/**
 * The chain the connected wallet currently reports — resolved via the existing
 * getWalletChainId/getChainById primitives (never a parallel detection path). Falls back to the
 * default chain if no wallet is connected yet, or if its reported chain isn't one this app
 * configures. Every dashboard surface that needs to scope its figures/copy to "whichever chain
 * the merchant is actually connected to" (instead of assuming Quai) shares this one hook.
 */
export function useConnectedChain(): ChainInfo {
  const [chain, setChain] = useState<ChainInfo>(getDefaultChain());
  useEffect(() => {
    let cancelled = false;
    const resolve = () => {
      const wallet = getActiveWallet();
      if (!wallet) {
        if (!cancelled) setChain(getDefaultChain());
        return;
      }
      void (async () => {
        const hex = await getWalletChainId(wallet.provider);
        const numeric = hex ? parseInt(hex, 16) : NaN;
        const resolved = Number.isFinite(numeric) ? getChainById(numeric) : undefined;
        // Only ever resolve to a LIVE chain — a wallet reporting a chain we configure but that
        // isn't actually usable right now (not-yet-launched / misconfigured) must fall back to
        // the default exactly like an unrecognized chain would, never hand callers something
        // they can't act on.
        if (!cancelled) setChain(resolved?.available ? resolved : getDefaultChain());
      })();
    };
    resolve();
    // Reconnecting via a DIFFERENT component (e.g. the header badge) must update this page's
    // figures without a manual refresh — see wallets.ts's subscribeToWalletChanges.
    const unsubscribe = subscribeToWalletChanges(resolve);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return chain;
}

/**
 * State for a chain-SELECTOR (Wallet Balances' tabs, the payment-link Chain picker): seeded from
 * the connected wallet's own chain (useConnectedChain) rather than always opening on the
 * configured default, so a merchant connected elsewhere doesn't have to notice and switch on
 * every visit. Once the merchant picks a chain explicitly through the returned setter, that
 * choice sticks — a later wallet-driven update (reconnect, account change) reseeds the default,
 * it never overrides an explicit pick already made.
 */
export function useChainSelector(): [ChainInfo, (chain: ChainInfo) => void] {
  const connectedChain = useConnectedChain();
  const [chain, setChainState] = useState<ChainInfo>(connectedChain);
  const [manuallySelected, setManuallySelected] = useState(false);
  // Adjusting state when connectedChain changes, computed during render rather than in an effect
  // (React's own recommended pattern for this — see "Adjusting state when a prop changes" in the
  // React docs) — avoids the extra render an effect-based sync would cost, and this lint rule
  // requires it.
  const [prevConnectedChain, setPrevConnectedChain] = useState(connectedChain);
  if (connectedChain !== prevConnectedChain) {
    setPrevConnectedChain(connectedChain);
    if (!manuallySelected) setChainState(connectedChain);
  }
  const setChain = useCallback((c: ChainInfo) => {
    setManuallySelected(true);
    setChainState(c);
  }, []);
  return [chain, setChain];
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Converts a raw amount to a display string that is accurate AND readable at both ends of the
 * scale — the single formatter every token/native amount on the dashboard goes through, so one
 * card can never disagree with another. A fixed low decimal count (2, as wallet-balances.tsx used
 * to truncate to) silently rounds a real small balance down to "0.00", which reads as "my money
 * is gone" for something like 0.0098 ETH; showing the FULL raw precision everywhere instead makes
 * ordinary larger amounts unreadable (many chains use 18 decimals). Split the difference:
 *   - A genuinely zero amount (every fractional digit, if any, is 0) returns the bare "0" —
 *     visibly distinct from any non-zero amount, which always shows at least one significant digit.
 *   - An amount with a non-zero whole part is capped at 6 fractional places (trailing zeros
 *     trimmed) — losing precision past that is an ordinary, standard readability tradeoff once the
 *     whole part alone already establishes the amount isn't zero or dust.
 *   - An amount under 1 shows enough digits PAST its first significant fractional digit that it
 *     reads as what it actually is, however small — never collapsed to a misleadingly round
 *     number the way a fixed decimal cap would.
 */
export function formatTokenAmount(value: bigint, decimals: number, kind: ChainKind): string {
  const full = kind === "quai" ? formatUnitsQuai(value, decimals) : formatUnitsEvm(value, decimals);
  const [whole, fracRaw = ""] = full.split(".");

  if (whole !== "0") {
    const frac = fracRaw.slice(0, 6).replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : whole;
  }

  const firstSignificant = fracRaw.search(/[1-9]/);
  if (firstSignificant === -1) return "0";
  const precision = Math.max(firstSignificant + 4, 6);
  const frac = fracRaw.slice(0, precision).replace(/0+$/, "");
  return `0.${frac}`;
}

/** Shared low-level formatter both formatDeliveryAmount and summarizeVolume build on — one place
 *  that knows "native uses the chain's own nativeCurrency; anything else goes through the
 *  chain-indexed currencies registry", so the two never drift apart. */
function formatChainAmount(net: string | bigint, token: string, chain: ChainInfo): string {
  const t = token.toLowerCase();
  // Qi settles with the "qi" token sentinel and qits amounts (1000 qits = 1 Qi). It is a
  // Quai-only UTXO rail, so it has no entry in any chain's ERC-20 registry and must be
  // handled before the currency lookups below (which would otherwise label it as some token).
  if (t === "qi") {
    return chain.kind === "quai" ? `${qitsToQi(String(net))} Qi` : `${String(net)} qi`;
  }
  if (t === ZERO_ADDRESS) {
    const formatted = formatTokenAmount(BigInt(net), chain.nativeCurrency.decimals, chain.kind);
    return `${formatted} ${chain.nativeCurrency.symbol}`;
  }
  const decimals = currencyDecimals(token, chain.chainId);
  const formatted = formatTokenAmount(BigInt(net), decimals, chain.kind);
  return `${formatted} ${currencySymbol(token, chain.chainId)}`;
}

/** Exact-decimal amount formatting — Number() division loses precision on big values.
 *  `chainId` is the delivery's own chain (from its webhook payload) — pass it so the right
 *  chain's native symbol/decimals and ERC-20 registry are used instead of always assuming Quai. */
export function formatDeliveryAmount(net: string, token: string, chainId?: number): string {
  const chain = (chainId !== undefined ? getChainById(chainId) : undefined) ?? getDefaultChain();
  return formatChainAmount(net, token, chain);
}

/**
 * Aggregates a set of deliveries' net amounts per token, for ONE chain, and formats each total
 * via THAT chain's own currency registry (native first) — e.g. "1.5 ETH + 40.0 mUSD" for
 * Robinhood Chain testnet, never "QUAI" for a chain that isn't Quai. Deliveries for other chains
 * are ignored internally, so callers don't have to pre-filter (dashboard overview and analytics
 * both also filter separately for their OTHER chain-scoped stats — this is just a safety net for
 * the volume figure specifically). Empty input (or a chain with zero deliveries) returns the
 * chain's native currency at zero, so the UI always has something sensible to show.
 */
export function summarizeVolume(deliveries: Delivery[], chain: ChainInfo): string {
  const totals = new Map<string, bigint>();
  for (const d of deliveries) {
    if (d.payload.data.chainId !== chain.chainId) continue;
    const token = d.payload.data.token.toLowerCase();
    totals.set(token, (totals.get(token) ?? 0n) + BigInt(d.payload.data.net));
  }
  const parts: string[] = [];
  const nativeTotal = totals.get(ZERO_ADDRESS) ?? 0n;
  if (nativeTotal > 0n || totals.size === 0) {
    parts.push(formatChainAmount(nativeTotal, ZERO_ADDRESS, chain));
  }
  for (const [token, amount] of totals) {
    if (token === ZERO_ADDRESS || amount === 0n) continue;
    parts.push(formatChainAmount(amount, token, chain));
  }
  return parts.join(" + ");
}

export function formatTimestamp(msOrSec: number): string {
  const ms = msOrSec > 1e12 ? msOrSec : msOrSec * 1000;
  return new Date(ms).toLocaleString();
}

/** Explorer link for a delivery's OWN chain — never a hardcoded quaiscan.io. A delivery list
 *  spans every configured chain, so each row must resolve its own link rather than the page
 *  assuming one explorer for all of them. Null when the chain is unrecognized or has no
 *  configured explorer (caller should omit the link rather than render a dead one). */
export function deliveryExplorerUrl(chainId: number, txHash: string): string | null {
  const chain = getChainById(chainId);
  if (!chain?.explorerUrl) return null;
  return `${chain.explorerUrl}/tx/${txHash}`;
}
/** One Qi order as seen by the merchant on /v1/me/qi (see qiReconView in the backend). */
export interface QiReconOrder {
  orderId: string;
  address: string;
  qits: string;
  receivedQits: string;
  settled: boolean;
  txHashes: string[];
  createdAt: number;
  settledAt: number | null;
  webhook: { status: string; attempts: number } | null;
  meta: {
    source: "link" | "checkout" | null;
    slug: string | null;
    shopName: string | null;
  };
}

export interface QiRecon {
  orders: QiReconOrder[];
  summary: {
    total: number;
    settled: number;
    pending: number;
    qitsRequired: string;
    qitsReceived: string;
  };
}

/** Qi settlement reconciliation for the signed-in merchant. Requires /v1/me/qi (no demo/admin route),
 *  so it only polls when a merchant session is active and the merchant's backend has Qi enabled. */
export function useQiRecon(intervalMs = 15000) {
  const [recon, setRecon] = useState<QiRecon | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      if (!isLoggedIn()) {
        setRecon(null);
        setError(null);
        setLoading(false);
        return;
      }
      const r = await adminGet<QiRecon>("/v1/me/qi");
      setRecon(r);
      setError(null);
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) {
        setError("Qi sync requires a logged-in merchant session.");
      } else {
        setError(parseError(err));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setInterval(() => void refresh(), intervalMs);
    const initial = setTimeout(() => void refresh(), 0);
    return () => {
      clearInterval(timer);
      clearTimeout(initial);
    };
  }, [refresh, intervalMs]);

  return { recon, loading, error, refresh };
}
