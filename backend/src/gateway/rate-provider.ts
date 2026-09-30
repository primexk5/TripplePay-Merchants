import type { Config } from '../config.js';
import { log } from '../logger.js';

const logger = log('gateway:rate');

/**
 * Fiat ↦ QUAI pricing for the e-commerce gateway.
 *
 * `getRates` returns fiat-per-QUAI for the requested currency codes (USD, NGN, …). Implementations
 * may be live (a price feed) or fixed (admin-set). Gateway code treats a missing currency as "no
 * quote". Rates are intentionally READ-ONLY here — the value a shop pays is computed and rounded
 * UP (merchant never underpaid) at order-creation time from whatever this returns.
 */
export interface RateProvider {
  /** fiat-per-QUAI for each requested currency; entries for currencies with no price are absent. */
  getRates(currencies: string[]): Promise<Record<string, number>>;
}

/** Fixed-rate provider — used when no live feed is configured or the feed is unreachable. */
export class FixedRateProvider implements RateProvider {
  constructor(private readonly rates: Record<string, number>) {}

  async getRates(currencies: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const c of currencies) {
      const v = this.rates[c.toLowerCase()];
      if (v !== undefined && v > 0) out[c.toLowerCase()] = v;
    }
    return out;
  }
}

/** CoinGecko-style live feed (`simple/price`), cached for `ttlMs`, falling back to `fallback`. */
export class CachedRateProvider implements RateProvider {
  private cache: { at: number; rates: Record<string, number> } | null = null;

  constructor(
    private readonly url: string,
    private readonly ttlMs: number,
    private readonly fallback: RateProvider,
  ) {}

  async getRates(currencies: string[]): Promise<Record<string, number>> {
    const now = Date.now();
    const fresh = this.cache && now - this.cache.at < this.ttlMs;
    if (!fresh) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5_000);
        const res = await fetch(this.url, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`rate feed responded ${res.status}`);
        const json = (await res.json()) as Record<string, unknown> & {
          'quai-network'?: Record<string, number>;
        };
        const prices = json['quai-network'] ?? {};
        const rates: Record<string, number> = {};
        for (const [cur, v] of Object.entries(prices)) {
          if (typeof v === 'number' && v > 0) rates[cur.toLowerCase()] = v;
        }
        this.cache = { at: Date.now(), rates };
        logger.info({ rates, currencies: Object.keys(rates) }, 'fetched live QUAI price');
      } catch (err) {
        logger.warn({ err }, 'live QUAI rate fetch failed — using fallback rates');
      }
    }
    // Serve from cache when present, else fall through to the fallback provider for any currency
    // the (re)fetch didn't populate.
    const cached = this.cache?.rates ?? {};
    return this.fallback.getRates(currencies).then((fixed) => {
      const out: Record<string, number> = {};
      for (const c of currencies) {
        const v = cached[c.toLowerCase()] ?? fixed[c.toLowerCase()];
        if (v !== undefined) out[c.toLowerCase()] = v;
      }
      return out;
    });
  }
}

/** Build the deployment's provider. With a live URL configured it layers the cache over the fixed
 *  rates; without one (or without any fallback) the fixed provider just returns what's configured. */
export function createRateProvider(cfg: Config): RateProvider {
  const fallbackRates: Record<string, number> = {};
  if (cfg.GATEWAY_FALLBACK_USD_PER_QUAI !== undefined) fallbackRates.usd = cfg.GATEWAY_FALLBACK_USD_PER_QUAI;
  if (cfg.GATEWAY_FALLBACK_NGN_PER_QUAI !== undefined) fallbackRates.ngn = cfg.GATEWAY_FALLBACK_NGN_PER_QUAI;
  const fixed = new FixedRateProvider(fallbackRates);
  if (cfg.GATEWAY_RATE_URL) {
    return new CachedRateProvider(cfg.GATEWAY_RATE_URL, cfg.GATEWAY_RATE_TTL_MS, fixed);
  }
  return fixed;
}