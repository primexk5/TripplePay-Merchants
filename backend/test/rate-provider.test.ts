import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CachedRateProvider, FixedRateProvider, createRateProvider } from '../src/gateway/rate-provider.js';
import type { Config } from '../src/config.js';

describe('FixedRateProvider', () => {
  it('returns configured currencies (lowercased) and skips absent ones', async () => {
    const p = new FixedRateProvider({ usd: 10, ngn: 0 });
    expect(await p.getRates(['USD', 'EUR'])).toEqual({ usd: 10 });
  });
});

describe('CachedRateProvider', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function feed(payload: Record<string, number>): Response {
    return { ok: true, status: 200, json: async () => ({ 'quai-network': payload }) } as unknown as Response;
  }

  it('reads live prices, caches them, and falls back to fixed rates for missing currencies', async () => {
    const fetchMock = vi.mocked(fetch)
      .mockResolvedValueOnce(feed({ usd: 10, ngn: 15000 }))
      .mockResolvedValueOnce(feed({ usd: 99 }));
    const p = new CachedRateProvider(
      'https://rates.test/simple/price',
      60_000,
      new FixedRateProvider({ usd: 7 }),
    );

    const first = await p.getRates(['USD', 'NGN']);
    expect(first).toEqual({ usd: 10, ngn: 15000 });

    // Within TTL the cache serves WITHOUT hitting the network again.
    const second = await p.getRates(['NGN']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.ngn).toBe(15000);

    // A currency the feed never reported (even outside cache layer) resolves via the fixed
    // fallback provider.
    expect(await p.getRates(['EUR'])).toEqual({});
  });

  it('falls back to fixed rates when the live fetch fails', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network down'));
    const p = new CachedRateProvider('https://rates.test/simple/price', 60_000, new FixedRateProvider({ usd: 7 }));
    const rates = await p.getRates(['USD']);
    expect(rates).toEqual({ usd: 7 });
  });

  it('retries the live feed after the TTL when the previous fetch failed', async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(feed({ usd: 10 }));
    const p = new CachedRateProvider('https://rates.test/simple/price', 0, new FixedRateProvider({ usd: 7 }));
    expect(await p.getRates(['USD'])).toEqual({ usd: 7 }); // first: fallback
    expect(await p.getRates(['USD'])).toEqual({ usd: 10 }); // ttl 0 -> refetch
  });
});

describe('createRateProvider', () => {
  it('returns the fixed provider alone when no live URL is configured', async () => {
    const p = createRateProvider({
      GATEWAY_FALLBACK_USD_PER_QUAI: 12,
      GATEWAY_RATE_URL: undefined,
    } as unknown as Config);
    expect(p).toBeInstanceOf(FixedRateProvider);
    expect(await p.getRates(['USD'])).toEqual({ usd: 12 });
  });

  it('wraps fixed rates when a live URL is configured', async () => {
    const p = createRateProvider({
      GATEWAY_RATE_URL: 'https://rates.test/simple/price',
      GATEWAY_FALLBACK_NGN_PER_QUAI: 15000,
    } as unknown as Config);
    expect(p).toBeInstanceOf(CachedRateProvider);
  });
});