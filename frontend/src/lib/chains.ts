/**
 * Single source of truth for every chain the frontend can point a wallet/payment at — mirrors
 * the shape of backend/chains.example.json (chainId, kind, name, rpcUrl, contractAddress,
 * explorerUrl) plus a native-currency description the wallet needs for wallet_addEthereumChain.
 *
 * Built-ins cover today's live deployments; NEXT_PUBLIC_CHAINS (inline JSON array, same shape)
 * lets a deployment add/override chains without a code change — entries are merged over the
 * built-ins by chainId (same chainId replaces, new chainId adds).
 */

export type ChainKind = "quai" | "evm";

export interface ChainNativeCurrency {
  name: string;
  symbol: string;
  decimals: number;
}

/**
 * Three distinct states a chain can be in — deliberately not a single boolean. Collapsing
 * "we haven't built this yet" and "this deployment forgot to configure it" into one "not
 * available" flag is exactly what made Quai — a chain this product is LIVE on — show as
 * "coming soon" the moment one developer's local env was missing its contract address. They are
 * different problems for different people (a product-roadmap fact vs. a deployment bug) and must
 * never be presented as the same thing.
 */
export type ChainAvailability = "live" | "not-yet-launched" | "misconfigured";

export interface ChainInfo {
  chainId: number;
  /** Short, stable slug — mirrors backend chains.example.json's `id` field. */
  slug: string;
  /** Plain, merchant-facing name — no zone names, shard ids, or other protocol internals. A
   *  merchant picks a network by this name alone; anything more belongs in a dev-facing surface
   *  (console logs, /docs), never here. */
  name: string;
  kind: ChainKind;
  rpcUrl: string;
  contractAddress: string;
  explorerUrl?: string;
  nativeCurrency: ChainNativeCurrency;
  /** At most one chain should set this — see {@link getDefaultChain}. */
  default?: boolean;
  /** One of three states — see {@link ChainAvailability} and {@link resolveAvailability}. UI
   *  should still LIST a non-"live" chain (never hide it), disabled, with wording appropriate to
   *  WHICH of the other two states it's in. */
  availability: ChainAvailability;
  /** True only for `availability === "live"` — convenience for callers that just need "can this
   *  be used right now" without needing to distinguish why not (e.g. {@link listAvailableChains},
   *  {@link getDefaultChain}). */
  available: boolean;
  /** Set only when `availability === "misconfigured"` — a ready-to-show, merchant-safe summary
   *  ("temporarily unavailable"), never the raw env var name (that goes to the startup
   *  console.error and this string's own operator-facing detail, not the headline UI label). */
  missingConfigHint?: string;
}

/** Raw shape accepted for a chain before its resolved `availability`/`available`/
 *  `missingConfigHint` are computed. */
type ChainInfoInput = Omit<ChainInfo, "availability" | "available" | "missingConfigHint"> & {
  /** Declares whether THIS PRODUCT supports this chain at all — a roadmap fact, independent of
   *  whether an address happens to be configured in any given deployment. Defaults to true (the
   *  common case: a real, supported chain). Set `false` only for a chain we intend to support but
   *  haven't deployed anywhere yet (Base Sepolia today) — see {@link resolveAvailability} for how
   *  this interacts with `contractAddress` to produce one of the three states. Note that once a
   *  REAL address is set (deploying the contract), the chain becomes live regardless of this flag
   *  — so "deploy + set the address" is still all it takes to flip a chain on, no code change. */
  launched?: boolean;
  /** Which env var supplies this chain's address — named in the startup console.error and in
   *  `missingConfigHint`'s detail, so an operator knows exactly what to set. */
  addressEnvVar?: string;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function isPlaceholderAddress(addr: string): boolean {
  return !addr || addr.toLowerCase() === ZERO_ADDRESS;
}

/**
 * Resolves one of the three states — deploying a contract and setting its address is ALWAYS
 * enough to reach "live" by itself, regardless of `launched`, so that step alone (no code change)
 * is what moves a chain out of "not yet launched". Only in the NO-address case does `launched`
 * matter, to distinguish an intentional product state from a deployment mistake:
 *
 *   1. LIVE — a real (non-placeholder) contract address is configured.
 *   2. NOT YET LAUNCHED — no address, and this chain is explicitly declared `launched: false`.
 *      Expected, intentional — Base Sepolia today.
 *   3. MISCONFIGURED — no address, but this chain IS declared launched (the default). This
 *      deployment is missing something it needs — an operator error, surfaced loudly via
 *      console.error at startup (see logMisconfiguredChains) and missingConfigHint, never
 *      silently folded into "coming soon".
 */
function resolveAvailability(input: ChainInfoInput): ChainInfo {
  const { launched = true, addressEnvVar, ...chain } = input;
  if (!isPlaceholderAddress(chain.contractAddress)) {
    return { ...chain, availability: "live", available: true };
  }
  if (!launched) {
    return { ...chain, availability: "not-yet-launched", available: false };
  }
  return {
    ...chain,
    availability: "misconfigured",
    available: false,
    missingConfigHint: `${chain.name} is temporarily unavailable — its contract address${
      addressEnvVar ? ` (${addressEnvVar})` : ""
    } isn't configured for this deployment.`,
  };
}

/** Logs a loud, specific startup error for every chain this deployment declares launched but
 *  can't actually use — an operator error that must never be discoverable only by noticing a
 *  chain is greyed out in the UI. */
function logMisconfiguredChains(chains: ChainInfo[]): void {
  for (const c of chains) {
    if (c.availability !== "misconfigured") continue;
    console.error(
      `[chains] ${c.name} (chainId ${c.chainId}) is declared as a supported, launched chain, ` +
        `but this deployment has no contract address configured for it. ${c.missingConfigHint ?? ""} ` +
        "It will show as unavailable in the UI until this is fixed — this is a deployment " +
        "configuration fault, not expected product behavior.",
    );
  }
}

// launched omitted — defaults to true: Quai is this product's live, fully-supported chain. A
// missing address here (e.g. a developer's local env) is a MISCONFIGURATION, not a "coming soon"
// product state — see resolveAvailability. No hardcoded fallback address is given deliberately:
// papering over a missing NEXT_PUBLIC_PAYWITHQUAI_ADDRESS with a baked-in default would silence
// exactly the diagnostic this model exists to surface.
//
// A deployment that serves Quai mainnet configures it the single-chain way the backend also
// reads: CHAIN_ID=9 plus NEXT_PUBLIC_PAYWITHQUAI_ADDRESS / NEXT_PUBLIC_RPC_URL. Requiring the
// dedicated NEXT_PUBLIC_QUAI_MAINNET_* vars instead makes such a deployment report mainnet as
// "not yet launched", drop it from the chain picker and from `getDefaultChain()`, and strand the
// login button — all while the backend is happily serving mainnet. So fall back to the legacy
// vars, but ONLY when NEXT_PUBLIC_CHAIN_ID names mainnet: a testnet deployment sets that same
// legacy var to its *testnet* contract, and reading it as a mainnet address is precisely the
// conflation the dedicated vars exist to prevent.
const quaiMainnetAddress =
  process.env.NEXT_PUBLIC_QUAI_MAINNET_PAYWITHQUAI_ADDRESS ??
  (Number(process.env.NEXT_PUBLIC_CHAIN_ID) === 9 ? process.env.NEXT_PUBLIC_PAYWITHQUAI_ADDRESS : undefined);
const quaiMainnetRpcUrl =
  process.env.NEXT_PUBLIC_QUAI_MAINNET_RPC_URL ??
  (Number(process.env.NEXT_PUBLIC_CHAIN_ID) === 9 ? process.env.NEXT_PUBLIC_RPC_URL : undefined);
const quaiMainnetAddressEnvVar = process.env.NEXT_PUBLIC_QUAI_MAINNET_PAYWITHQUAI_ADDRESS
  ? "NEXT_PUBLIC_QUAI_MAINNET_PAYWITHQUAI_ADDRESS"
  : "NEXT_PUBLIC_PAYWITHQUAI_ADDRESS";

const QUAI_MAINNET: ChainInfoInput = {
  chainId: 9,
  slug: "quai",
  name: "Quai (mainnet)",
  kind: "quai",
  rpcUrl: quaiMainnetRpcUrl ?? "https://rpc.quai.network/cyprus1",
  contractAddress: quaiMainnetAddress ?? "",
  addressEnvVar: quaiMainnetAddressEnvVar,
  explorerUrl: "https://quaiscan.io",
  nativeCurrency: { name: "Quai", symbol: "QUAI", decimals: 18 },
  // When no mainnet address is configured this is intentionally "not yet launched" for this
  // deployment (testnet setup), not a misconfiguration — suppress the startup console.error.
  launched: !!quaiMainnetAddress && quaiMainnetAddress !== "undefined" && quaiMainnetAddress !== "false",
};

// Native-currency assumption: Robinhood Chain testnet's RPC/explorer are standard EVM tooling
// (Etherscan-family explorer), which implies an ETH-denominated gas token — no canonical
// name/symbol for it is published anywhere in this repo as of writing. Verify with the team
// before this chain goes past testnet; override via NEXT_PUBLIC_CHAINS if it's wrong.
// launched omitted (defaults true) — this chain has a hardcoded real fallback address below, so
// it's always live regardless; the env var only needs to be set to OVERRIDE it.
const ROBINHOOD_TESTNET: ChainInfoInput = {
  chainId: 46630,
  slug: "robinhood-testnet",
  name: "Robinhood Chain (testnet)",
  kind: "evm",
  rpcUrl: process.env.NEXT_PUBLIC_ROBINHOOD_TESTNET_RPC_URL ?? "https://rpc.testnet.chain.robinhood.com/rpc",
  contractAddress:
    process.env.NEXT_PUBLIC_ROBINHOOD_TESTNET_PAYWITHQUAI_ADDRESS ?? "0xe2C0d033102B7ad963deC4b44B5e1e94bca1385f",
  addressEnvVar: "NEXT_PUBLIC_ROBINHOOD_TESTNET_PAYWITHQUAI_ADDRESS",
  explorerUrl: "https://explorer.testnet.chain.robinhood.com",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
};

// launched: false — a roadmap fact: no PayWithQuai contract has been deployed to Base Sepolia
// ANYWHERE yet, so the zero-address placeholder here is expected, not an error. Once a contract
// IS deployed and NEXT_PUBLIC_BASE_SEPOLIA_PAYWITHQUAI_ADDRESS is set to the real address, this
// chain becomes live automatically (resolveAvailability checks the address first) — this
// `launched: false` line can stay exactly as-is; no code change is needed to flip it on.
const BASE_SEPOLIA: ChainInfoInput = {
  chainId: 84532,
  slug: "base-sepolia",
  name: "Base Sepolia (testnet)",
  kind: "evm",
  rpcUrl: process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
  contractAddress: process.env.NEXT_PUBLIC_BASE_SEPOLIA_PAYWITHQUAI_ADDRESS ?? ZERO_ADDRESS,
  addressEnvVar: "NEXT_PUBLIC_BASE_SEPOLIA_PAYWITHQUAI_ADDRESS",
  explorerUrl: "https://sepolia.basescan.org",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  launched: false,
};

const BUILT_IN_CHAINS: ChainInfoInput[] = [QUAI_MAINNET, ROBINHOOD_TESTNET, BASE_SEPOLIA];

function isChainInfoInput(v: unknown): v is ChainInfoInput {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.chainId === "number" &&
    typeof c.slug === "string" &&
    typeof c.name === "string" &&
    (c.kind === "quai" || c.kind === "evm") &&
    typeof c.rpcUrl === "string" &&
    typeof c.contractAddress === "string"
  );
}

function parseExtraChains(): ChainInfoInput[] {
  const raw = process.env.NEXT_PUBLIC_CHAINS?.trim();
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isChainInfoInput);
  } catch {
    console.warn("NEXT_PUBLIC_CHAINS is not valid JSON — ignoring it.");
    return [];
  }
}

function buildChains(): ChainInfo[] {
  const byChainId = new Map<number, ChainInfoInput>();
  for (const c of BUILT_IN_CHAINS) byChainId.set(c.chainId, c);
  for (const c of parseExtraChains()) byChainId.set(c.chainId, c);
  return [...byChainId.values()].map(resolveAvailability);
}

const CHAINS = buildChains();
// Loud by design — a misconfigured chain must be obvious to whoever starts this app, not just
// discoverable by a merchant noticing something is greyed out.
logMisconfiguredChains(CHAINS);

/** Every configured chain, including any not "live" (see ChainInfo.availability) — chain PICKER
 *  UIs should use this and render non-live entries disabled, never hide them: a merchant should
 *  see Base Sepolia listed as "coming soon" and Quai (if misconfigured) listed as temporarily
 *  unavailable, never have either just vanish. */
export function listChains(): ChainInfo[] {
  return CHAINS;
}

/** Only `availability === "live"` chains — for contexts that offer/claim a capability rather
 *  than render a picker (e.g. "which chains can this wallet sign for", login's chain-free path).
 *  Listing a non-live chain there would promise something a merchant can't actually do right now,
 *  for whatever reason. */
export function listAvailableChains(): ChainInfo[] {
  return CHAINS.filter((c) => c.available);
}

export function getChainById(chainId: number): ChainInfo | undefined {
  return CHAINS.find((c) => c.chainId === chainId);
}

export function getChainBySlug(slug: string): ChainInfo | undefined {
  return CHAINS.find((c) => c.slug === slug);
}

/**
 * The chain a chain-less context resolves to.
 *
 * NEXT_PUBLIC_CHAIN_ID was declared in .env.local.example but never read by any code (see
 * CHAIN_AUDIT.md §5.3/§7.3 — flagged as a likely-dead var). It's wired up here as a SELECTOR
 * into this table (which already-configured chain is the default), not as a second definition of
 * a chain's own parameters — so it can never drift out of sync with that chain's rpcUrl/
 * contractAddress the way a duplicate NEXT_PUBLIC_RPC_URL-style override could. If it's unset, or
 * set to a chainId this table doesn't have, the chain explicitly marked `default` (or the first
 * configured chain) is used — so every existing Quai-only deployment keeps working with zero
 * config changes. Never resolves to an unavailable chain (e.g. Base Sepolia before its contract
 * is deployed) — a default that can't actually be used would just move Problem 4 somewhere else.
 */
export function getDefaultChain(): ChainInfo {
  const envChainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID);
  if (Number.isFinite(envChainId) && envChainId > 0) {
    const match = getChainById(envChainId);
    if (match?.available) return match;
  }
  const marked = CHAINS.find((c) => c.default && c.available);
  if (marked) return marked;
  return CHAINS.find((c) => c.available) ?? CHAINS[0]!;
}
