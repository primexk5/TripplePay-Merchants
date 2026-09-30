import { getAddress } from "quais";
import { getAddress as getAddressEvm } from "ethers";
import { getChainById } from "./chains";

/** Local copy — importing from ./payment would create a module-init cycle
 *  (payment.ts also imports this registry). */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Quai mainnet's chainId — the default for every lookup below that omits one, so every
 *  pre-multichain caller (none of which pass a chainId) keeps behaving exactly as before. */
const QUAI_CHAIN_ID = 9;
const ROBINHOOD_TESTNET_CHAIN_ID = 46630;

/**
 * Per-chain currency registry — every currency a merchant can price a link in, indexed by
 * chainId. Token entries are compiled in from canonical/verified addresses so no merchant
 * configuration is required:
 *   Quai mainnet:
 *     USDT  0x0049F7cbCa3556C2DfaE62Aafa7015F99de1b8f5  (Tether USD, 6)  — docs.qu.ai/learn/bridge-to-quai
 *     WQUAI 0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB  (Wrapped Quai, 18)
 *   Robinhood Chain testnet:
 *     mock stablecoin — contracts/contracts/MockStablecoin.sol, decimals() overridden to 6
 *     (verified against the contract source, not guessed).
 * mUSDQ (the platform's own Quai stablecoin) still comes from NEXT_PUBLIC_MUSDQ_ADDRESS because
 * it is deployment-specific.
 */

/** Canonical Quai mainnet (Cyprus-1) token addresses — override only for testing. */
export const USDT_ADDRESS =
  process.env.NEXT_PUBLIC_USDT_ADDRESS ?? "0x0049F7cbCa3556C2DfaE62Aafa7015F99de1b8f5";
export const WQUAI_ADDRESS =
  process.env.NEXT_PUBLIC_WQUAI_ADDRESS ?? "0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB";

/** Platform settlement stablecoin on Quai — deployment-specific, still env-required. */
export const MUSDQ_ADDRESS = process.env.NEXT_PUBLIC_MUSDQ_ADDRESS;

/** Robinhood Chain testnet's mock stablecoin (contracts/deployments/robinhoodTestnet.json's
 *  `mockStablecoin`), 6 decimals — see MockStablecoin.sol. */
export const ROBINHOOD_TESTNET_STABLECOIN_ADDRESS =
  process.env.NEXT_PUBLIC_ROBINHOOD_TESTNET_STABLECOIN_ADDRESS ?? "0xb34b57F6e78200a4D403544e4c23D7d2D5f7D66C";

export interface CurrencyInfo {
  /** ZERO_ADDRESS for the chain's native currency. */
  address: string;
  symbol: string;
  decimals: number;
  label: string;
}

/** Kept for backward compatibility — every pre-multichain caller imports this directly
 *  (e.g. dashboard/links/page.tsx's default token). Always equals listCurrencies()'s native
 *  entry for Quai mainnet. */
export const NATIVE_CURRENCY: CurrencyInfo = {
  address: ZERO_ADDRESS,
  symbol: "QUAI",
  decimals: 18,
  label: "Quai (native)",
};

function nativeCurrencyFor(chainId: number): CurrencyInfo {
  if (chainId === QUAI_CHAIN_ID) return NATIVE_CURRENCY;
  const chain = getChainById(chainId);
  const nc = chain?.nativeCurrency ?? { name: "Native", symbol: "NATIVE", decimals: 18 };
  return { address: ZERO_ADDRESS, symbol: nc.symbol, decimals: nc.decimals, label: `${nc.name} (native)` };
}

function buildQuaiErc20s(): CurrencyInfo[] {
  const list: CurrencyInfo[] = [];
  const add = (raw: string | undefined, symbol: string, decimals: number, label: string) => {
    if (!raw) return;
    try {
      list.push({ address: getAddress(raw), symbol, decimals, label });
    } catch {
      /* malformed env value — skip rather than break the app */
    }
  };
  add(process.env.NEXT_PUBLIC_MUSDQ_ADDRESS, "mUSDQ", 6, "mUSDQ (stablecoin)");
  add(USDT_ADDRESS, "USDT", 6, "Tether USD");
  add(WQUAI_ADDRESS, "WQUAI", 18, "Wrapped Quai");
  return list;
}

function buildRobinhoodTestnetErc20s(): CurrencyInfo[] {
  try {
    return [
      {
        address: getAddressEvm(ROBINHOOD_TESTNET_STABLECOIN_ADDRESS),
        symbol: "mUSD",
        decimals: 6,
        label: "Mock USD (testnet)",
      },
    ];
  } catch {
    /* malformed env override — skip rather than break the app */
    return [];
  }
}

/** ERC-20s (excluding native) per chainId. A chain with no entry here still gets its native
 *  currency via {@link nativeCurrencyFor} — this map only needs to grow when a chain has known
 *  ERC-20s to offer. */
const ERC20S_BY_CHAIN: Record<number, CurrencyInfo[]> = {
  [QUAI_CHAIN_ID]: buildQuaiErc20s(),
  [ROBINHOOD_TESTNET_CHAIN_ID]: buildRobinhoodTestnetErc20s(),
};

/** Every configured currency for a chain, native first. Omit chainId for Quai mainnet — every
 *  pre-multichain caller keeps working unchanged. */
export function listCurrencies(chainId: number = QUAI_CHAIN_ID): CurrencyInfo[] {
  return [nativeCurrencyFor(chainId), ...(ERC20S_BY_CHAIN[chainId] ?? [])];
}

/** Lookup by token address (case-insensitive) on a given chain; null for an unknown token.
 *  Omit chainId for Quai mainnet (unchanged behaviour). */
export function findCurrency(address: string, chainId: number = QUAI_CHAIN_ID): CurrencyInfo | null {
  const needle = address?.toLowerCase();
  return listCurrencies(chainId).find((c) => c.address.toLowerCase() === needle) ?? null;
}

/** Decimals for a currency we know about on this chain; falls back to 6 (the historical
 *  assumption) for unknown tokens so legacy flows keep working until the registry learns them.
 *  Wrong decimals mean wrong amounts — always derived from the contract/registry above, never
 *  guessed per call site. */
export function currencyDecimals(address: string, chainId: number = QUAI_CHAIN_ID): number {
  return findCurrency(address, chainId)?.decimals ?? 6;
}

export function currencySymbol(address: string, chainId: number = QUAI_CHAIN_ID): string {
  return findCurrency(address, chainId)?.symbol ?? "TOKEN";
}
