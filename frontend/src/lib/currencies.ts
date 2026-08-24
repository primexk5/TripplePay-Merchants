import { getAddress } from "quais";

/** Local copy — importing from ./payment would create a module-init cycle
 *  (payment.ts also imports this registry). */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Single source of truth for every currency a merchant can price a link in.
 *
 * Token entries are compiled in from canonical mainnet addresses (verified on-chain via
 * symbol()/decimals() reads) so no merchant configuration is required:
 *   - USDT  0x0049F7cbCa3556C2DfaE62Aafa7015F99de1b8f5  (Tether USD, 6)  — docs.qu.ai/learn/bridge-to-quai
 *   - WQUAI 0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB  (Wrapped Quai, 18)
 * mUSDQ (the platform's own stablecoin) still comes from NEXT_PUBLIC_MUSDQ_ADDRESS because
 * it is deployment-specific.
 */

/** Canonical Quai mainnet (Cyprus-1) token addresses — override only for testing. */
export const USDT_ADDRESS =
  process.env.NEXT_PUBLIC_USDT_ADDRESS ?? "0x0049F7cbCa3556C2DfaE62Aafa7015F99de1b8f5";
export const WQUAI_ADDRESS =
  process.env.NEXT_PUBLIC_WQUAI_ADDRESS ?? "0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB";

/** Platform settlement stablecoin — deployment-specific, still env-required. */
export const MUSDQ_ADDRESS = process.env.NEXT_PUBLIC_MUSDQ_ADDRESS;

export interface CurrencyInfo {
  /** ZERO_ADDRESS for native QUAI. */
  address: string;
  symbol: string;
  decimals: number;
  label: string;
}

export const NATIVE_CURRENCY: CurrencyInfo = {
  address: ZERO_ADDRESS,
  symbol: "QUAI",
  decimals: 18,
  label: "Quai (native)",
};

function buildCurrencies(): CurrencyInfo[] {
  const list: CurrencyInfo[] = [NATIVE_CURRENCY];
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

const CURRENCIES = buildCurrencies();

/** Every configured currency, native first. */
export function listCurrencies(): CurrencyInfo[] {
  return CURRENCIES;
}

/** Lookup by token address (case-insensitive); null for native QUAI's ZERO_ADDRESS callers
 *  should treat that separately, and null for unknown tokens. */
export function findCurrency(address: string): CurrencyInfo | null {
  const needle = address?.toLowerCase();
  return CURRENCIES.find((c) => c.address.toLowerCase() === needle) ?? null;
}

/** Decimals for an ERC-20 we know about; falls back to 6 (the historical assumption) for
 *  unknown tokens so legacy flows keep working until the registry learns them. */
export function currencyDecimals(address: string): number {
  return findCurrency(address)?.decimals ?? 6;
}

export function currencySymbol(address: string): string {
  return findCurrency(address)?.symbol ?? "TOKEN";
}
