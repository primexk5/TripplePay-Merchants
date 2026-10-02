import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { signSessionToken, verifySessionToken } from '../src/shopify.js';
import { createApp } from '../src/index.js';
import { loadConfig, type Config } from '../src/config.js';

const SECRET = 'test-api-secret';
const API_KEY = 'key';
const SHOP = 'victim.myshopify.com';
const servers: Array<{ close: () => void }> = [];
const realFetch = globalThis.fetch;

function config(over: Partial<NodeJS.ProcessEnv> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), 'pwq-session-'));
  return loadConfig({
    NODE_ENV: 'test',
    SHOPIFY_API_KEY: API_KEY,
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

/** A token exactly as App Bridge would mint it for this shop's admin. */
function goodToken(over: Record<string, unknown> = {}, shop = SHOP, secret = SECRET, apiKey = API_KEY): string {
  const now = Math.floor(Date.now() / 1000);
  return signSessionToken(
    {
      iss: apiKey,
      dest: `https://${shop}`,
      aud: apiKey,
      sub: 'abc-123',
      sid: 'session-id',
      iat: now,
      nbf: now,
      exp: now + 60,
      ...over,
    },
    secret,
  );
}

describe('verifySessionToken', () => {
  it('accepts a well-formed token for the same shop', () => {
    expect(verifySessionToken(goodToken(), SHOP, API_KEY, SECRET)).toBe(true);
  });

  it('rejects a token minted for a different shop', () => {
    // The attack: an admin of the attacker's own store replays their valid token at the victim.
    const attackerToken = goodToken({}, 'attacker-store.myshopify.com');
    expect(verifySessionToken(attackerToken, SHOP, API_KEY, SECRET)).toBe(false);
  });

  it('rejects a token signed with the wrong secret', () => {
    expect(verifySessionToken(goodToken({}, SHOP, 'not-the-secret'), SHOP, API_KEY, SECRET)).toBe(false);
  });

  it('rejects a token whose payload was edited after signing', () => {
    const token = goodToken();
    const [h, , s] = token.split('.') as [string, string, string];
    const forged = Buffer.from(
      JSON.stringify({ iss: API_KEY, dest: `https://${SHOP}`, aud: API_KEY, exp: Math.floor(Date.now() / 1000) + 600 }),
    ).toString('base64url');
    expect(verifySessionToken(`${h}.${forged}.${s}`, SHOP, API_KEY, SECRET)).toBe(false);
  });

  it('rejects alg:none (signature stripped)', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signSessionToken({ iss: API_KEY, dest: `https://${SHOP}`, aud: API_KEY, exp: now + 60 }, '', {
      alg: 'none',
      typ: 'JWT',
    });
    expect(verifySessionToken(token, SHOP, API_KEY, SECRET)).toBe(false);
  });

  it('rejects an expired token', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(verifySessionToken(goodToken({ exp: now - 3600, iat: now - 3660, nbf: now - 3660 }), SHOP, API_KEY, SECRET)).toBe(
      false,
    );
  });

  it('rejects a token that is not valid yet', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(verifySessionToken(goodToken({ nbf: now + 3600 }), SHOP, API_KEY, SECRET)).toBe(false);
  });

  it('rejects a token issued for a different app (iss/aud mismatch)', () => {
    expect(verifySessionToken(goodToken({ iss: 'other-app', aud: 'other-app' }), SHOP, API_KEY, SECRET)).toBe(false);
  });

  it('tolerates small clock skew', () => {
    const now = Math.floor(Date.now() / 1000);
    // 30s past expiry — inside the 60s skew window a browser clock can produce.
    expect(verifySessionToken(goodToken({ exp: now - 30 }), SHOP, API_KEY, SECRET)).toBe(true);
  });

  it.each([
    ['undefined', undefined],
    ['empty string', ''],
    ['non-string', 12345],
    ['two segments', 'aaa.bbb'],
    ['garbage', 'not-a-jwt'],
    ['bad base64 payload', 'eyJhbGciOiJIUzI1NiJ9.!!!.sig'],
  ])('rejects %s without throwing', (_label, token) => {
    expect(verifySessionToken(token, SHOP, API_KEY, SECRET)).toBe(false);
  });
});

describe('/settings requires a session token', () => {
  let base: string;
  let cfg: Config;

  beforeEach(async () => {
    cfg = config();
    const app = createApp(cfg);
    const server = app.listen(0);
    servers.push(server);
    await new Promise<void>((r) => server.once('listening', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  afterAll(() => {
    for (const s of servers) s.close();
  });

  const form = (body: Record<string, string>) => ({
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });

  it('rejects a credential write with no session token, even for an installed shop', async () => {
    // Install the app first so the ONLY thing that can reject this is the missing token.
    globalThis.fetch = (async (input: unknown, init?: unknown) => {
      const url = typeof input === 'string' ? input : String(input);
      if (/admin\/oauth\/access_token$/.test(url)) {
        return new Response(JSON.stringify({ access_token: 'shpat_x' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return realFetch(input as string, init as RequestInit);
    }) as typeof fetch;

    const auth = await fetch(`${base}/auth?shop=${SHOP}`, { redirect: 'manual' });
    const state = new URL(auth.headers.get('location') ?? 'http://x/').searchParams.get('state') as string;
    const cb = new URLSearchParams({ code: 'c', shop: SHOP, timestamp: '1', state });
    cb.set(
      'hmac',
      (await import('node:crypto')).createHmac('sha256', SECRET)
        .update([...cb.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&'))
        .digest('hex'),
    );
    expect((await fetch(`${base}/auth/callback?${cb}`)).status).toBe(200);

    const res = await fetch(
      `${base}/settings`,
      form({ shop: SHOP, merchantKey: 'qmkey_attacker', webhookSecret: 'whsec_attacker' }),
    );
    expect(res.status).toBe(401);

    // Nothing was stored.
    const clear = await fetch(`${base}/settings/clear`, form({ shop: SHOP }));
    expect(clear.status).toBe(401);
  });

  it('rejects a token minted for another shop', async () => {
    const res = await fetch(
      `${base}/settings`,
      form({
        shop: SHOP,
        merchantKey: 'qmkey_attacker',
        webhookSecret: 'whsec_attacker',
        sessionToken: goodToken({}, 'attacker-store.myshopify.com'),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('serves a settings page that loads App Bridge and carries a session token field', async () => {
    const res = await fetch(`${base}/settings?shop=${SHOP}`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('app-bridge.js');
    expect(html).toContain('getSessionToken');
    expect(html).toContain('name="sessionToken"');
  });
});
