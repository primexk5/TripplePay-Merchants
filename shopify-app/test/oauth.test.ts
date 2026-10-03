import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/index.js';
import { loadConfig, type Config } from '../src/config.js';

const SECRET = 'test-api-secret';
const servers: Array<{ close: () => void }> = [];
const realFetch = globalThis.fetch;

function config(over: Partial<NodeJS.ProcessEnv> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), 'pwq-oauth-'));
  return loadConfig({
    NODE_ENV: 'test',
    SHOPIFY_API_KEY: 'key',
    SHOPIFY_API_SECRET: SECRET,
    SHOPIFY_APP_URL: 'https://app.example.com',
    GATEWAY_BASE_URL: 'https://gateway.example.com',
    GATEWAY_MERCHANT_KEY: 'qmkey_test',
    GATEWAY_WEBHOOK_SECRET: 'whsec_test',
    STORE_PATH: dir,
    LOG_PRETTY: 'false',
    ...over,
  } as NodeJS.ProcessEnv);
}

/** Shopify signs the sorted query string (minus `hmac`) with the app secret. */
function signedCallback(params: Record<string, string>): string {
  const message = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const hmac = createHmac('sha256', SECRET).update(message).digest('hex');
  return `/auth/callback?${new URLSearchParams({ ...params, hmac }).toString()}`;
}

/** Intercepts only Shopify's token exchange so the install can complete offline. Everything else
 *  (notably requests to our own test server) falls through to the real fetch. */
function stubShopifyToken(token = 'shpat_test') {
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    const url = typeof input === 'string' ? input : ((input as { url?: string })?.url ?? String(input));
    if (/^https:\/\/[^/]+\/admin\/oauth\/access_token$/.test(url)) {
      return new Response(JSON.stringify({ access_token: token, scope: 'read_orders,write_orders' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return realFetch(input as string, init as RequestInit);
  }) as typeof fetch;
}

async function listen(app: ReturnType<typeof createApp>) {
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** Reads back the `state` the connector minted and handed to Shopify. */
async function issueState(base: string, shop = 'demo.myshopify.com'): Promise<string> {
  const res = await fetch(`${base}/auth?shop=${shop}`, { redirect: 'manual' });
  const state = new URL(res.headers.get('location') ?? 'http://x/').searchParams.get('state');
  expect(state).toBeTruthy();
  return state as string;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  for (const s of servers) s.close();
});

describe('OAuth install CSRF protection', () => {
  let base: string;
  beforeEach(async () => {
    base = await listen(createApp(config()));
  });

  it('completes a legitimate install', async () => {
    stubShopifyToken();
    const state = await issueState(base);
    const res = await fetch(`${base}${signedCallback({ code: 'c', shop: 'demo.myshopify.com', state, timestamp: '1' })}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/Installed/);
  });

  it('rejects a callback whose state was never issued', async () => {
    stubShopifyToken();
    const res = await fetch(`${base}${signedCallback({ code: 'c', shop: 'demo.myshopify.com', state: 'forged', timestamp: '1' })}`);
    expect(res.status).toBe(401);
  });

  it('rejects a replayed state after a successful install', async () => {
    stubShopifyToken();
    const state = await issueState(base);
    const path = signedCallback({ code: 'c', shop: 'demo.myshopify.com', state, timestamp: '1' });

    const first = await fetch(`${base}${path}`);
    expect(first.status).toBe(200);

    // A leaked callback URL must not be able to mint a second token.
    const second = await fetch(`${base}${path}`);
    expect(second.status).toBe(401);
    expect(await second.text()).toMatch(/state invalid or already used/i);
  });

  it('rejects a state issued for a different shop', async () => {
    stubShopifyToken();
    const state = await issueState(base, 'demo.myshopify.com');
    const res = await fetch(
      `${base}${signedCallback({ code: 'c', shop: 'attacker.myshopify.com', state, timestamp: '1' })}`,
    );
    expect(res.status).toBe(401);
  });

  it('rejects an install whose callback arrives after the ttl', async () => {
    stubShopifyToken();
    const fastBase = await listen(createApp(config({ OAUTH_STATE_TTL_MS: '1' })));
    const state = await issueState(fastBase);
    await new Promise((r) => setTimeout(r, 20));
    const res = await fetch(`${fastBase}${signedCallback({ code: 'c', shop: 'demo.myshopify.com', state, timestamp: '1' })}`);
    expect(res.status).toBe(401);
    expect(await res.text()).toMatch(/expired/i);
  });

  it('rejects a bad signature without consuming the state', async () => {
    stubShopifyToken();
    const state = await issueState(base);
    const bad = await fetch(
      `${base}/auth/callback?${new URLSearchParams({
        code: 'c',
        shop: 'demo.myshopify.com',
        state,
        timestamp: '1',
        hmac: 'f'.repeat(64),
      })}`,
    );
    expect(bad.status).toBe(401);

    // The state survived the rejected attempt, so the real callback still works.
    const good = await fetch(`${base}${signedCallback({ code: 'c', shop: 'demo.myshopify.com', state, timestamp: '1' })}`);
    expect(good.status).toBe(200);
  });

  it('refuses an install for a non-Shopify shop domain', async () => {
    const res = await fetch(`${base}/auth?shop=evil.example.com`, { redirect: 'manual' });
    expect(res.status).toBe(400);
  });
});
