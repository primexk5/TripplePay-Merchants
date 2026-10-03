import { getZoneForAddress } from "quais";
import { getAddress as getAddressEvm } from "ethers";
import { getDefaultChain, type ChainInfo } from "./chains";

export type WalletBrand =
  | "pelagus"
  | "blip"
  | "metamask"
  | "rabby"
  | "coinbase"
  | "brave"
  | "okx"
  | "bitget"
  | "trust"
  | "frame"
  | "generic";

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

export interface DetectedWallet {
  id: string;
  name: string;
  brand: WalletBrand;
  provider: Eip1193Provider;
  /** Data-URI icon the wallet announced itself via EIP-6963 — real artwork supplied by the
   *  wallet, never guessed or hand-drawn here. Undefined for Blip (window.quai is outside
   *  EIP-6963; it keeps its own hardcoded mark), and for a wallet only found by the legacy
   *  window.ethereum fallback scan — including Pelagus when its EIP-6963 announcement isn't
   *  available. WalletMark falls back to an initial letter when there's no icon, and ALSO when
   *  an announced icon fails to actually load (broken/unreachable data URI). */
  icon?: string;
  /** True for a wallet that can sign for Quai — either because it was injected through Quai's
   *  own channel (Blip's window.quai, Pelagus's window.pelagus/window.quai alias), or because it
   *  announced itself via EIP-6963 with an rdns this app recognizes as Quai-native (see
   *  QUAI_NATIVE_BRANDS — Pelagus can be discovered either way, and must be classified the same
   *  regardless). This is a real behavioral signal, not a brand guess: Quai needs its own
   *  `quai_*` RPC methods, which no generic `window.ethereum`/EIP-6963-announced wallet
   *  implements, no matter what compatibility flags or rdns it sets (many EVM wallets — MetaMask
   *  included — set `isMetaMask`-style flags for dApp compat; none of that implies Quai support).
   *  A Quai-native wallet is ALWAYS false for standard EVM chains (see walletSupportsChain) — the
   *  two capabilities are mutually exclusive in every wallet this app can detect today. */
  supportsQuai: boolean;
}

export const QUAI_MAINNET_CHAIN = {
  chainId: "0x9", // 9 — Quai mainnet, Cyprus-1 zone
  chainName: "Quai Network (Mainnet)",
  nativeCurrency: { name: "Quai", symbol: "QUAI", decimals: 18 },
  rpcUrls: [
    process.env.NEXT_PUBLIC_RPC_URL ?? "https://rpc.quai.network/cyprus1",
  ],
  blockExplorerUrls: ["https://explorer.qu.ai"],
};

export type ChainConfig = typeof QUAI_MAINNET_CHAIN;

/** Every wallet operates on Quai mainnet — the app no longer touches any testnet. */

const STORAGE_KEY = "tripplepay:active-wallet";

interface UnknownProvider {
  /** Blip's provider flags (window.quai in its in-app browser). */
  isBlip?: boolean;
  _isSwiftBlip?: boolean;
  /** Pelagus desktop extension. Blip ALSO sets isPelagus:true for compat — so isPelagus
   *  must never be treated as "Blip" or win over the Blip flags. */
  isPelagus?: boolean;
  isMetaMask?: boolean;
  isRabby?: boolean;
  isCoinbaseWallet?: boolean;
  isCoinbaseExtension?: boolean;
  isBraveWallet?: boolean;
  isOkxWallet?: boolean;
  isBitKeep?: boolean;
  isBitgetWallet?: boolean;
  isTrust?: boolean;
  isFrame?: boolean;
  uuid?: string;
}

declare global {
  interface Window {
    pelagus?: Eip1193Provider;
    /** Blip wallet injects window.quai inside its in-app browser (flagged isBlip/_isSwiftBlip).
     *  Pelagus may also expose window.quai for backwards compatibility — without Blip flags. */
    quai?: Eip1193Provider & { isBlip?: boolean; _isSwiftBlip?: boolean };
    ethereum?: Eip1193Provider & { providers?: Eip1193Provider[] };
  }
}

// ── EIP-6963: Multi Injected Provider Discovery ──────────────────────────────────────────────
// The primary discovery path for standard EVM wallets. Each wallet announces itself with its
// OWN name/icon/rdns — no brand flag guessing, no window.ethereum collision. This is a plain
// browser event API (CustomEvent), not a library: https://eips.ethereum.org/EIPS/eip-6963

interface Eip6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string; // data: URI
  rdns: string; // reverse-DNS id, e.g. "io.metamask" — stable across reinstalls, unlike uuid
}

interface Eip6963ProviderDetail {
  info: Eip6963ProviderInfo;
  provider: Eip1193Provider;
}

interface Eip6963AnnounceEvent extends Event {
  detail: Eip6963ProviderDetail;
}

/** Announced providers, keyed by uuid (EIP-6963's own dedup key) — populated by the
 *  `eip6963:announceProvider` listener, never by brand-flag inspection. */
const eip6963Providers = new Map<string, Eip6963ProviderDetail>();

let eip6963Initialized = false;

/** Installs the announcement listener and asks already-loaded wallets to (re-)announce.
 *  Idempotent, and safe to call again later (detectWallets does, to catch a wallet that injects
 *  after this module first loaded) — only the listener installation itself is guarded. */
function initEip6963(): void {
  if (typeof window === "undefined") return;
  if (!eip6963Initialized) {
    eip6963Initialized = true;
    window.addEventListener("eip6963:announceProvider", ((event: Eip6963AnnounceEvent) => {
      const detail = event.detail;
      if (!detail?.info?.uuid || !detail.provider) return;
      eip6963Providers.set(detail.info.uuid, detail);
    }) as EventListener);
  }
  // Re-dispatching is cheap and idempotent — compliant wallets just re-announce themselves,
  // which only refreshes the same Map entry.
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

// Install as early as this module loads in the browser — well before a merchant manually opens
// the wallet picker — so installed extensions have already announced themselves by then.
initEip6963();

/**
 * Brand classification for an EIP-6963-announced wallet, keyed by its rdns (reverse-DNS id).
 * rdns is the signal EIP-6963 itself designed for this: unlike a `window.ethereum` flag like
 * `isMetaMask` (which ANY wallet can set, and is exactly how the Phantom hijack happened), rdns
 * is a stable identifier the wallet's own developer declares once and is expected to keep across
 * reinstalls and versions — the closest thing to a durable identity the spec offers, even though
 * (like a flag) it's still self-declared rather than externally verified.
 *
 * This table does double duty: it also drives which EIP-6963-announced wallets are Quai-native
 * (see QUAI_NATIVE_BRANDS below) — "io.pelaguswallet.wallet" is Pelagus's own real rdns,
 * confirmed by its actual announcement, not a guess. A brand-flag check couldn't have caught this
 * at all: EIP-6963 announcements don't carry the isPelagus-style flags detectWallets reads from
 * window.quai/window.pelagus, so without rdns a Quai-native wallet discovered this way would be
 * silently misclassified as a generic EVM wallet.
 */
const RDNS_BRAND: Record<string, WalletBrand> = {
  "io.pelaguswallet.wallet": "pelagus",
  "io.metamask": "metamask",
  "io.rabby": "rabby",
  "com.coinbase.wallet": "coinbase",
  "com.brave.wallet": "brave",
  "com.okex.wallet": "okx",
  "com.bitget.web3": "bitget",
  "com.trustwallet.app": "trust",
  "io.frame": "frame",
};

/** Brands that are Quai-native regardless of which discovery path found them. Used to set
 *  DetectedWallet.supportsQuai for an EIP-6963-announced wallet (EIP-6963 itself is EVM-only by
 *  spec, but a wallet using it to announce itself can still BE a Quai-native wallet — Pelagus's
 *  real-world announcement is exactly that case). "blip" is listed for the same reason even
 *  though Blip doesn't currently announce via EIP-6963 (see detectWallets) — if it starts to,
 *  this needs no further change once its rdns is added above. */
const QUAI_NATIVE_BRANDS: ReadonlySet<WalletBrand> = new Set(["pelagus", "blip"]);

function identify(
  provider: Eip1193Provider,
  fromPelagusSlot: boolean,
): { name: string; brand: WalletBrand } {
  const p = provider as UnknownProvider;
  // Blip first — its provider sets isPelagus:true for Pelagus compatibility, so
  // the Blip flags must always win over isPelagus.
  if (p.isBlip || p._isSwiftBlip) return { name: "Blip Wallet", brand: "blip" };
  // Pelagus — either the window.pelagus slot, or a Pelagus provider exposed on
  // window.quai for backwards compatibility (no Blip flags).
  if (fromPelagusSlot || p.isPelagus) return { name: "Pelagus", brand: "pelagus" };
  if (p.isRabby) return { name: "Rabby", brand: "rabby" };
  if (p.isCoinbaseWallet || p.isCoinbaseExtension)
    return { name: "Coinbase Wallet", brand: "coinbase" };
  if (p.isBraveWallet) return { name: "Brave Wallet", brand: "brave" };
  if (p.isOkxWallet) return { name: "OKX Wallet", brand: "okx" };
  if (p.isBitKeep || p.isBitgetWallet)
    return { name: "Bitget Wallet", brand: "bitget" };
  if (p.isTrust) return { name: "Trust Wallet", brand: "trust" };
  if (p.isFrame) return { name: "Frame", brand: "frame" };
  if (p.isMetaMask) return { name: "MetaMask", brand: "metamask" };
  return { name: "Browser wallet", brand: "generic" };
}

/** Human-readable id fragment for a provider — used only to build DetectedWallet.id (for React
 *  keys and localStorage persistence across reloads), NEVER for deduplication (see detectWallets:
 *  a wallet's window.ethereum.providers[] entry can be the exact same object as window.ethereum
 *  itself, and this heuristic — .uuid if present, else the constructor name — isn't guaranteed to
 *  agree with itself across call sites the way true object identity is). */
function providerId(provider: Eip1193Provider): string {
  const uuid = (provider as UnknownProvider).uuid;
  if (uuid) return uuid;
  const name = (provider as { constructor?: { name?: string } }).constructor?.name;
  return name ?? "provider";
}

export function detectWallets(): DetectedWallet[] {
  if (typeof window === "undefined") return [];
  // Catches a wallet extension that injects/announces after this module first loaded.
  initEip6963();

  // Dedup by the ACTUAL object reference — a multi-injector's window.ethereum.providers[] can
  // contain window.ethereum itself (observed with a single-wallet MetaMask install), and a
  // hijacker (observed: Phantom) can advertise isMetaMask: true on window.ethereum while being a
  // completely different provider, so reference identity is the only thing trustworthy WITHIN
  // one discovery path.
  const seenProviders = new Set<Eip1193Provider>();
  // Brands already found via a HIGHER-PRIORITY path (EIP-6963, processed first below) — a
  // lower-priority path (Quai's own channels, then the legacy window.ethereum scan) skips a
  // brand already covered this way. This is needed BECAUSE reference-identity dedup alone can't
  // catch it: the same real-world wallet (observed: Pelagus, Rabby) can hand back genuinely
  // DIFFERENT provider objects to its EIP-6963 announcement than to window.pelagus/
  // window.ethereum, so seenProviders never collides for them. "generic" is deliberately
  // excluded — multiple distinct, unrecognized wallets must never be collapsed into one just
  // because neither could be named.
  const seenBrands = new Set<WalletBrand>();
  const wallets: DetectedWallet[] = [];

  const push = (
    provider: Eip1193Provider | undefined,
    fromPelagusSlot: boolean,
    quaiCapable: boolean,
  ) => {
    if (!provider) return;
    if (seenProviders.has(provider)) return;
    const { name, brand } = identify(provider, fromPelagusSlot);
    if (brand !== "generic" && seenBrands.has(brand)) return;
    seenProviders.add(provider);
    if (brand !== "generic") seenBrands.add(brand);
    wallets.push({
      id: `${brand}:${providerId(provider)}`,
      name,
      brand,
      provider,
      supportsQuai: quaiCapable,
    });
  };

  // ── EIP-6963 FIRST: the preferred discovery path whenever a wallet supports it — it carries
  // the wallet's own announced name/icon, which no other path can offer, so it should win when a
  // wallet is found both ways. Keyed by uuid, classified by rdns (never a window.ethereum brand
  // flag — see RDNS_BRAND's own note on why that's the trustworthy signal here). ──
  for (const { info, provider } of eip6963Providers.values()) {
    if (seenProviders.has(provider)) continue;
    seenProviders.add(provider);
    const brand = RDNS_BRAND[info.rdns] ?? "generic";
    if (brand !== "generic") seenBrands.add(brand);
    wallets.push({
      id: `eip6963:${info.uuid}`,
      name: info.name,
      brand,
      provider,
      icon: info.icon,
      supportsQuai: QUAI_NATIVE_BRANDS.has(brand),
    });
  }

  // ── Quai's own injection channels — entirely outside EIP-6963, which is EVM-only. Skips a
  // brand EIP-6963 already found (e.g. Pelagus announcing both ways) so it isn't listed twice. ──
  // Blip wallet injects window.quai (flagged isBlip/_isSwiftBlip) — detect it first.
  // Pelagus may expose window.quai too (backwards compat) — without Blip flags it
  // falls through to identify(), which maps isPelagus → brand "pelagus". Both are genuinely
  // Quai-capable: this IS Quai's own injection channel, not a brand guess.
  if (window.quai) {
    const p = window.quai;
    if (p.isBlip || p._isSwiftBlip) {
      if (!seenBrands.has("blip")) {
        seenProviders.add(window.quai);
        seenBrands.add("blip");
        wallets.push({
          id: "blip:quai",
          name: "Blip Wallet",
          brand: "blip",
          provider: window.quai,
          supportsQuai: true,
        });
      }
      // Blip aliases the same provider into window.pelagus / window.ethereum —
      // dedupe those slots so Blip isn't listed twice (as Pelagus / generic).
      for (const alias of [window.pelagus, window.ethereum]) {
        if (alias) seenProviders.add(alias);
      }
    } else {
      push(window.quai, false, true);
    }
  }

  // Pelagus has first-class slot — also genuinely Quai-capable (Quai's own official wallet).
  push(window.pelagus, true, true);

  // ── Legacy window.ethereum scan — STRICT fallback for a wallet that doesn't support EIP-6963.
  // Anything already discovered above (EIP-6963 or Quai channels) is skipped, whether by provider
  // identity or by brand, so a wallet found more than one way never appears twice. ──
  push(window.ethereum, false, false);
  const multi = window.ethereum?.providers ?? [];
  for (const provider of multi) push(provider, false, false);

  return wallets;
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

export function getStoredWalletId(): string | null {
  if (!isBrowser()) return null;
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Notified whenever the active wallet selection changes (connect, disconnect, or the stale-id
 *  cleanup in getActiveWallet) — so any UI derived from "which wallet/chain is connected" can
 *  update itself without a manual refresh, even when the change happened in a DIFFERENT
 *  component (e.g. reconnecting via the header badge updates a page's own chain-scoped figures
 *  below it). Same-tab only, by design — this isn't a replacement for the cross-tab `storage`
 *  event, just same-tab reactivity localStorage alone doesn't provide. */
const walletChangeListeners = new Set<() => void>();

export function subscribeToWalletChanges(listener: () => void): () => void {
  walletChangeListeners.add(listener);
  return () => walletChangeListeners.delete(listener);
}

function notifyWalletChanged(): void {
  for (const listener of walletChangeListeners) listener();
}

export function storeWalletId(id: string | null): void {
  if (!isBrowser()) return;
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage unavailable — ignore
  }
  notifyWalletChanged();
}

export function getActiveWallet(): DetectedWallet | null {
  const stored = getStoredWalletId();
  if (!stored) return null;
  const wallets = detectWallets();
  const found = wallets.find((w) => w.id === stored);
  if (found) return found;
  // Stored id matches no currently detected wallet — most commonly a leftover from before
  // EIP-6963 discovery (old ids were `${brand}:${providerId}`; EIP-6963 wallets now use
  // `eip6963:${uuid}`). Only clear it once we've actually detected SOME wallets, so a call made
  // before extensions have finished announcing themselves doesn't wrongly wipe a still-valid
  // selection — this is a one-time format-migration cleanup, not a recurring race to optimize
  // for. Clearing (rather than leaving it to silently mismatch forever) is what turns "wallet
  // looks connected but isn't" into a normal, reconnectable "not connected" state.
  if (wallets.length > 0) {
    storeWalletId(null);
  }
  return null;
}

/** Reads the connected account from `wallet` WITHOUT prompting (no popup) — tries the universal
 *  EIP-1193 method first (works whether or not the wallet is Quai-native), falling back to the
 *  Quai-specific one only if that fails. Null if nothing is connected/unlockable. Shared by every
 *  "is a wallet already connected, and to what address" check (dashboard shell, links page) so
 *  there's one place that knows the right method order, not several copies that could drift. */
export async function silentAccountAddress(wallet: DetectedWallet): Promise<string | null> {
  for (const method of ["eth_accounts", "quai_accounts"]) {
    try {
      const accounts = (await wallet.provider.request({ method })) as string[];
      if (accounts?.length) return accounts[0];
    } catch {
      /* try the next method */
    }
  }
  return null;
}

/** {@link silentAccountAddress} for whichever wallet is currently active, or null if none is. */
export async function silentActiveWalletAddress(): Promise<string | null> {
  const wallet = getActiveWallet();
  if (!wallet) return null;
  return silentAccountAddress(wallet);
}

/** Canonical hex chain id (`0x9`, not `0x09` / `9` / number) for reliable compares. */
export function normalizeChainId(id: unknown): string | null {
  if (id == null || id === "") return null;
  if (typeof id === "number" && Number.isFinite(id)) {
    return `0x${Math.trunc(id).toString(16)}`;
  }
  const s = String(id).trim().toLowerCase();
  if (/^[0-9]+$/.test(s)) return `0x${parseInt(s, 10).toString(16)}`;
  if (s.startsWith("0x")) {
    const n = parseInt(s, 16);
    if (Number.isNaN(n)) return null;
    return `0x${n.toString(16)}`;
  }
  return null;
}

/** Asks the wallet for its current chain id (normalized hex). */
export async function getWalletChainId(
  provider: Eip1193Provider,
): Promise<string | null> {
  try {
    let chainId = await provider.request({ method: "quai_chainId" }).catch(() => null);
    if (!chainId) {
      chainId = await provider.request({ method: "eth_chainId" }).catch(() => null);
    }
    return normalizeChainId(chainId);
  } catch {
    return null;
  }
}

/** Builds the EIP-3326/3085 `ChainConfig` shape `ensureNetwork` needs from a table entry
 *  (frontend/src/lib/chains.ts) — the per-chain equivalent of the old hardcoded
 *  QUAI_MAINNET_CHAIN constant. */
export function toWalletChainConfig(chain: ChainInfo): ChainConfig {
  return {
    chainId: `0x${chain.chainId.toString(16)}`,
    chainName: chain.name,
    nativeCurrency: chain.nativeCurrency,
    rpcUrls: [chain.rpcUrl],
    blockExplorerUrls: chain.explorerUrl ? [chain.explorerUrl] : [],
  };
}

/**
 * Puts the wallet on the target chain.
 * Flow: read the current chain id first (cheap — Blip answers `quai_chainId` with no network
 * round-trip) and only escalate to EIP-3326 RPCs when it actually differs from the target:
 *   1. `wallet_switchEthereumChain` — verified by re-reading the id afterwards, because
 *      wallets may resolve the promise without switching or reject with non-standard codes.
 *   2. `wallet_addEthereumChain` — some wallets reject unknown chains with codes other than
 *      4902, so the add is attempted regardless of the switch's error.
 *
 * `opts.quaiNative` marks Pelagus ONLY: its extension opens on the Assets tab with no switch
 * UI and the request never settles, so for that brand we skip all checks entirely and trust
 * the wallet (it is Quai-only and cannot sit on any other chain). Blip is NOT quai-native
 * here: its documented provider implements both EIP-3326 methods (firing `chainChanged`) and
 * reports chain 0x9 instantly, so it goes through the full verify → switch → add path.
 */
async function ensureNetworkConfig(
  provider: Eip1193Provider,
  target: ChainConfig,
  opts?: { quaiNative?: boolean; walletName?: string },
): Promise<"ok" | "unsupported"> {
  const walletLabel = opts?.walletName ?? "Wallet";
  const targetId = normalizeChainId(target.chainId);
  if (!targetId) return "unsupported";

  // ── Pelagus ─────────────────────────────────────────────────────────────
  // Quai-only extension; calling EIP-3326 on it hangs the request (see above).
  // Historically it also reported non-EVM chain ids (e.g. 9000), producing false
  // "wrong network" errors even on mainnet — so we never gate on its reported id.
  if (opts?.quaiNative) return "ok";

  // Fast path: already on the target chain — no popups, no writes.
  const before = await getWalletChainId(provider);
  if (before === targetId) return "ok";

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: target.chainId }],
    });
    const after = await getWalletChainId(provider);
    if (after && after === targetId) return "ok";
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code === 4001) {
      throw new Error(
        opts?.walletName
          ? `${walletLabel} declined switching to ${target.chainName} — approve the network switch to continue.`
          : "Network switch declined.",
      );
    }
  }

  // Switch failed or didn't take effect — try adding the chain.
  try {
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [target],
    });
    const after = await getWalletChainId(provider);
    if (after && after === targetId) return "ok";
  } catch {
    // fall through — wallet can't reach the target chain
  }
  return "unsupported";
}

/** Thin compat wrapper — old callers passing the raw EIP-3326 `ChainConfig` shape (as built by
 *  the old hardcoded QUAI_MAINNET_CHAIN) keep working unchanged, including the exact error
 *  message ("Network switch declined.") since they never pass `walletName`. New chain-aware call
 *  sites should use {@link ensureNetwork} instead, which takes a DetectedWallet + table entry
 *  directly and names both in its errors. */
export async function ensureQuaiNetwork(
  provider: Eip1193Provider,
  target: ChainConfig = QUAI_MAINNET_CHAIN,
  opts?: { quaiNative?: boolean },
): Promise<"ok" | "unsupported"> {
  return ensureNetworkConfig(provider, target, opts);
}

/**
 * Puts a wallet on the given chain, or throws a specific, actionable error naming both the
 * wallet and the chain — never a bare "unsupported operation". Two things are checked BEFORE any
 * network request is made, making the invalid combinations impossible by construction rather
 * than relying on every call site to remember a conditional:
 *   1. The chain has enough config to be reachable at all (rpcUrl + contractAddress).
 *   2. `walletSupportsChain(wallet, chain)` — a Quai-only wallet (Blip/Pelagus) is NEVER asked
 *      to switch/add an EVM chain, and a generic EVM wallet is NEVER asked to switch/add Quai.
 *      Attempting either leaves the wallet stuck on a network it can't actually use (Quai isn't
 *      plain EVM-compatible; standard wallets have no `quai_*` support to fall back on) — this is
 *      exactly the bug this check exists to prevent, not just handle after the fact.
 * Only once both hold does this call down to the low-level EIP-3326 switch/add flow.
 */
export async function ensureNetwork(wallet: DetectedWallet, chain: ChainInfo): Promise<void> {
  if (!chain.rpcUrl || !chain.contractAddress) {
    throw new Error(`${chain.name} is not fully configured on this site — contact the merchant.`);
  }
  if (!walletSupportsChain(wallet, chain)) {
    throw new Error(
      `${wallet.name} can't sign for ${chain.name} — connect a wallet that supports this chain instead.`,
    );
  }
  const quaiNative = wallet.brand === "pelagus" && chain.kind === "quai";
  const result = await ensureNetworkConfig(wallet.provider, toWalletChainConfig(chain), {
    quaiNative,
    walletName: wallet.name,
  });
  if (result === "unsupported") {
    throw new Error(
      `${wallet.name} couldn't switch to ${chain.name} — switch to it manually in ${wallet.name} and retry.`,
    );
  }
}

/** Requests accounts from `wallet` for the given target chain's kind, distinguishing a genuine
 *  user rejection (thrown immediately, named) from "this method doesn't exist" (falls through to
 *  the next method, same as before). Shared by {@link connectWallet}. */
async function requestAccounts(wallet: DetectedWallet, chain: ChainInfo): Promise<string[]> {
  const tryMethod = async (method: string): Promise<string[] | null> => {
    try {
      return (await wallet.provider.request({ method })) as string[];
    } catch (err) {
      const code = (err as { code?: number })?.code;
      if (code === 4001) {
        throw new Error(
          `Connection to ${wallet.name} was declined — approve the connection request in ${wallet.name} to continue.`,
        );
      }
      return null; // method not supported / other error — let the caller try the next one
    }
  };

  if (chain.kind === "quai") {
    return (await tryMethod("quai_requestAccounts")) ?? (await tryMethod("eth_requestAccounts")) ?? [];
  }
  return (await tryMethod("eth_requestAccounts")) ?? [];
}

/**
 * Connects to the chosen wallet and returns the active address.
 *
 * The account-request method and address validation both branch on the TARGET chain's kind —
 * never the wallet's brand:
 *   - Quai: `quai_requestAccounts` (falling back to `eth_requestAccounts` for a Quai-native
 *     wallet that happens not to implement it), then the Cyprus-1 zone check. Unchanged from
 *     before.
 *   - EVM: `eth_requestAccounts` ONLY — a generic EVM wallet has no `quai_*` methods, and even
 *     attempting one first used to surface a spurious "method does not exist" RPC error in the
 *     console before falling back. Validated with standard EIP-55 checksum, not a Quai zone (the
 *     old unconditional zone check rejected every valid Robinhood Chain/Base Sepolia account).
 *
 * Defaults to the default chain (Quai today) so every existing caller that doesn't pass one
 * keeps behaving exactly as before.
 */
export async function connectWallet(
  wallet: DetectedWallet,
  chain: ChainInfo = getDefaultChain(),
): Promise<string> {
  const accounts = await requestAccounts(wallet, chain);
  if (!accounts?.length) {
    throw new Error(`${wallet.name} returned no accounts — unlock it and make sure an account is selected.`);
  }
  const address = accounts[0];
  if (chain.kind === "quai") {
    const zone = getZoneForAddress(address);
    if (zone !== "0x00") {
      // console-only detail for whoever's debugging this — the merchant just needs to know
      // which account to pick, not what a "zone" is.
      console.warn(`Account ${address} is in zone ${zone}, not Quai's Cyprus-1 (0x00…).`);
      throw new Error(
        `This account isn't compatible with Quai — switch to a different account in ${wallet.name}.`,
      );
    }
  } else {
    try {
      getAddressEvm(address);
    } catch {
      throw new Error(`${wallet.name} returned an invalid account address.`);
    }
  }
  return address;
}

/** Capability check: can this wallet reach the given chain? Driven entirely by
 *  DetectedWallet.supportsQuai — a real signal set at detection time from which injection
 *  channel the wallet came through (Quai's window.quai/window.pelagus vs. the generic
 *  window.ethereum), not a brand-name guess. Quai chains need a Quai-native wallet (Blip/
 *  Pelagus); standard EVM chains need a generic EIP-1193 wallet, which by construction excludes
 *  every Quai-native one (Pelagus can't reach arbitrary EVM chains any more than Blip can — see
 *  DetectedWallet.supportsQuai's own note on why these two capabilities never overlap). */
export function walletSupportsChain(wallet: DetectedWallet, chain: ChainInfo): boolean {
  if (chain.kind === "quai") return wallet.supportsQuai;
  return !wallet.supportsQuai;
}

/** Every chain (from the given list, preserving its order) this wallet can sign for — built by
 *  checking {@link walletSupportsChain} per chain, so a merchant-login-style picker can list a
 *  wallet if it supports ANY configured chain without duplicating the per-chain capability rule
 *  above. Empty when the wallet can't reach any of them. */
export function chainsSupportedBy(wallet: DetectedWallet, chains: ChainInfo[]): ChainInfo[] {
  return chains.filter((c) => walletSupportsChain(wallet, c));
}