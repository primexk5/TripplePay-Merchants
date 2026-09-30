"use client";

import { BrowserProvider } from "quais";
import { BrowserProvider as EvmBrowserProvider } from "ethers";
import { backendFetch } from "@/lib/payment";
import {
  ensureNetwork,
  getActiveWallet,
  getWalletChainId,
  chainsSupportedBy,
  type DetectedWallet,
} from "@/lib/wallets";
import { listChains } from "@/lib/chains";

/**
 * Session management for the merchant dashboard.
 *
 * Security model (audit fixes):
 *  - The backend mints a single-use, chain-bound challenge nonce; the signed message
 *    (`tripplepay-login:<address>:<nonce>:<chainId>:<realm>`) cannot be replayed.
 *  - The session token is held ONLY in memory — never in localStorage — so an XSS or a leaked
 *    script can't walk off with a credential that survives a reload.
 *  - The backend also sets an HttpOnly `qmsession` cookie; `backendFetch` sends it with
 *    `credentials: "include"`, so API calls authenticate via the cookie even after a reload
 *    (the in-memory token is just a fallback).
 *  - A non-sensitive `qm.signedin` marker cookie (signed-out value, nothing secret) tells the
 *    Next middleware / SSR which routes need the session.
 */

const TOKEN_MEMORY: { token: string | null } = { token: null };
const ADDRESS_KEY = "tripplepay.address";
const MARKER_COOKIE = "qm.signedin";

export interface AuthMerchant {
  merchantId: string;
  address: string;
  name: string;
  webhookUrl: string;
  active: boolean;
  createdAt: number;
}

export interface LoginResult {
  token: string;
  expiresAt: number;
  merchant: AuthMerchant;
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

/** Session token, available only for the lifetime of the page (never persisted). */
export function getSessionToken(): string | null {
  return TOKEN_MEMORY.token;
}

export function getStoredAddress(): string | null {
  if (!isBrowser()) return null;
  try {
    return localStorage.getItem(ADDRESS_KEY);
  } catch {
    return null;
  }
}

function hasMarkerCookie(): boolean {
  if (!isBrowser()) return false;
  return document.cookie.split("; ").some((c) => c.startsWith(`${MARKER_COOKIE}=1`));
}

function setMarkerCookie(): void {
  if (!isBrowser()) return;
  document.cookie = `${MARKER_COOKIE}=1; path=/; samesite=lax`;
}

function clearMarkerCookie(): void {
  if (!isBrowser()) return;
  document.cookie = `${MARKER_COOKIE}=; path=/; samesite=lax; max-age=0`;
}

export function isLoggedIn(): boolean {
  return TOKEN_MEMORY.token !== null || hasMarkerCookie();
}

/**
 * Signs the login challenge with the active wallet and exchanges it for a session.
 * The message is minted by the backend per request (single-use nonce + chain id + realm bound),
 * so a captured signature can never be replayed.
 *
 * Merchants are chain-free (product rule): the challenge/signature may be bound to ANY chain
 * this deployment currently has enabled, so a merchant can log in once and then create links on
 * any chain. This signs for whichever chain the wallet is CURRENTLY on (if it's one of this
 * deployment's configured chains), falling back to the default chain otherwise — it does not
 * force a network switch just to log in.
 *
 * NEVER initiates a wallet connection: `preConnectedAddress` must come from an explicit
 * user action (WalletSelector / Blip connect button). If it's missing we fail loudly
 * instead of silently firing a connection popup the user didn't ask for.
 *
 * `walletOverride` lets a caller sign in with a wallet that ISN'T (yet) the app's stored active
 * wallet — e.g. the dashboard's "sign in as this account" flow, which must prove a completed
 * signature from the newly-connected wallet BEFORE flipping which wallet the app treats as
 * active. Defaults to the active wallet, so every existing caller keeps behaving exactly as
 * before.
 */
export async function loginWithWallet(
  preConnectedAddress?: string,
  walletOverride?: DetectedWallet,
): Promise<LoginResult> {
  const wallet = walletOverride ?? getActiveWallet();
  if (!wallet) {
    throw new Error("No wallet connected — connect a wallet first.");
  }
  if (!preConnectedAddress) {
    throw new Error("Connect your wallet first, then press Sign in.");
  }

  // Resolve the target chain from what THIS WALLET can actually sign for — never the global
  // default — before any network request. Previously this fell back to getDefaultChain() (Quai)
  // whenever the wallet's current network wasn't a configured chain, which pushed a plain EVM
  // wallet like MetaMask onto Quai (Cyprus-1): a network it has no quai_* support for, leaving it
  // stuck with "unsupported operation". A wallet that can't serve any configured chain fails
  // here with a clear message instead.
  const supportedChains = chainsSupportedBy(wallet, listChains());
  if (supportedChains.length === 0) {
    throw new Error(`${wallet.name} can't sign for any chain this app supports.`);
  }
  const currentHex = await getWalletChainId(wallet.provider);
  const currentChainId = currentHex ? parseInt(currentHex, 16) : NaN;
  // Prefer whatever chain the wallet already reports, but only among chains it can actually
  // reach — otherwise fall back to the first chain it supports, not the app's global default.
  const chain =
    (Number.isFinite(currentChainId)
      ? supportedChains.find((c) => c.chainId === currentChainId)
      : undefined) ?? supportedChains[0]!;

  await ensureNetwork(wallet, chain);
  const address = preConnectedAddress;

  let signer;
  if (chain.kind === "quai") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signer = await new BrowserProvider(wallet.provider as any, "any").getSigner();
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signer = await new EvmBrowserProvider(wallet.provider as any).getSigner();
  }

  const challenge = await backendFetch("/v1/auth/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, chainId: chain.chainId }),
  });
  const challengeBody = (await challenge.json().catch(() => null)) as {
    message?: string;
    error?: string;
  } | null;
  if (!challenge.ok || !challengeBody?.message) {
    throw new Error(challengeBody?.error ?? `challenge failed (${challenge.status})`);
  }

  const signature = await signer.signMessage(challengeBody.message);
  const res = await backendFetch("/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, message: challengeBody.message, signature }),
  });

  let body: { token?: string; expiresAt?: number; merchant?: AuthMerchant; error?: string };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    body = {};
  }
  if (!res.ok) {
    throw new Error(body.error ?? `login failed (${res.status})`);
  }
  if (!body.token || !body.merchant) {
    throw new Error("login response missing token");
  }

  TOKEN_MEMORY.token = body.token;
  setMarkerCookie();
  try {
    localStorage.setItem(ADDRESS_KEY, address);
  } catch {
    // storage unavailable — the address just won't survive a reload
  }
  return { token: body.token, expiresAt: body.expiresAt ?? 0, merchant: body.merchant };
}

export type SessionStatus =
  | { status: "ok"; merchant: AuthMerchant }
  | { status: "expired" }
  | { status: "unreachable" };

/**
 * After a reload the in-memory token is gone, but the HttpOnly session cookie still authenticates
 * the merchant. Re-checks with the backend so the dashboard can tell a live session from an
 * expired/revoked one (401) or a backend that's simply unreachable (network error).
 */
export async function checkSession(): Promise<SessionStatus> {
  if (!hasMarkerCookie()) return { status: "expired" };
  try {
    const res = await backendFetch("/v1/me", { signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      return { status: "ok", merchant: (await res.json()) as AuthMerchant };
    }
    return { status: "expired" };
  } catch {
    // backend unreachable — leave the marker; the dashboard shows its own error
    return { status: "unreachable" };
  }
}

/** Clears the local session and invalidates it server-side (cookie + token). */
export async function logout(): Promise<void> {
  TOKEN_MEMORY.token = null;
  clearMarkerCookie();
  try {
    localStorage.removeItem(ADDRESS_KEY);
  } catch {
    // ignore
  }
  try {
    await backendFetch("/v1/auth/logout", {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // server unreachable — the cookie/token are dead locally anyway
  }
}
