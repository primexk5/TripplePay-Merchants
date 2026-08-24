import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Wallet } from 'quais';
import { createServer } from '../src/api/server.js';
import { JsonStore } from '../src/store/json.js';
import type { Config } from '../src/config.js';
import type { QuaiClient } from '../src/chain/client.js';

const ADMIN_KEY = 'test-admin-key-0123456789abcdef';
const CONTRACT = '0x0000000000000000000000000000000000000001';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const USDT = '0x0049f7cbca3556c2dfae62aafa7015f99de1b8f5'; // canonical mainnet USDT (lowercase)
const ROGUE = '0x' + 'ee'.repeat(20);

function makeCfg(acceptedTokens?: string): Config {
  return {
    ADMIN_API_KEY: ADMIN_KEY,
    CORS_ORIGINS: '*',
    CHAIN_ID: 9,
    LOGIN_REALM: 'tripplepay',
    TRUST_PROXY: 0,
    PAYWITHQUAI_ADDRESS: CONTRACT,
    ...(acceptedTokens !== undefined ? { ACCEPTED_TOKENS: acceptedTokens } : {}),
  } as unknown as Config;
}

const wallet = new Wallet('0x' + randomBytes(32).toString('hex'));

function fakeClient(): QuaiClient {
  return { address: CONTRACT } as unknown as QuaiClient;
}

const dirs: string[] = [];
const servers: import('node:http').Server[] = [];
afterAll(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshStore(): JsonStore {
  const dir = mkdtempSync(join(tmpdir(), 'pwq-links-'));
  dirs.push(dir);
  return new JsonStore(join(dir, 'relayer.db'));
}

async function startApp(cfg: Config): Promise<string> {
  const app = createServer(freshStore(), fakeClient(), cfg);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function req(base: string, path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(base + path, init);
  const body = (await res.json().catch(() => undefined)) as Record<string, unknown>;
  return { status: res.status, body };
}

const jsonHeaders = { 'content-type': 'application/json' };

/** Full real-client flow: challenge → sign → login → bearer token. */
async function login(base: string): Promise<string> {
  const challenge = await req(base, '/v1/auth/challenge', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ address: wallet.address }),
  });
  if (challenge.status !== 200 || !challenge.body.message) {
    throw new Error(`challenge failed: ${challenge.status}`);
  }
  const signature = await wallet.signMessage(challenge.body.message as string);
  const res = await req(base, '/v1/auth/login', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ address: wallet.address, message: challenge.body.message, signature }),
  });
  if (res.status !== 200 || typeof res.body.token !== 'string') {
    throw new Error(`login failed: ${res.status}`);
  }
  return res.body.token as string;
}

/** Onboard the test wallet as a merchant via the admin route. */
async function onboard(base: string): Promise<void> {
  const res = await fetch(`${base}/v1/merchants`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN_KEY}`, ...jsonHeaders },
    body: JSON.stringify({ address: wallet.address, name: 'Acme', webhookUrl: 'https://example.test/webhook' }),
  });
  expect(res.status).toBe(201);
}

function createLinkBody(tokenAddress: string, orderId: string) {
  return {
    shopName: 'Test Shop',
    tokenAddress,
    amount: '25000000',
    amountDisplay: '25',
    symbol: 'TST',
    expiryDurationSecs: 0,
    multiPay: false,
    orderPool: [orderId],
  };
}

describe('POST /v1/links ACCEPTED_TOKENS allowlist', () => {
  it('accepts an allowlisted token and native QUAI', async () => {
    const base = await startApp(makeCfg(`${USDT},${ROGUE}`));
    await onboard(base);
    const token = await login(base);

    const usdt = await req(base, '/v1/links', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, ...jsonHeaders },
      body: JSON.stringify(createLinkBody('0x' + USDT.slice(2).toUpperCase(), '0x' + 'a1'.repeat(32))),
    });
    expect(usdt.status).toBe(201);

    const native = await req(base, '/v1/links', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, ...jsonHeaders },
      body: JSON.stringify(createLinkBody(ZERO_ADDRESS, '0x' + 'a2'.repeat(32))),
    });
    expect(native.status).toBe(201);
  });

  it('rejects a non-allowlisted token with a clear error', async () => {
    const base = await startApp(makeCfg(USDT));
    await onboard(base);
    const token = await login(base);

    const res = await req(base, '/v1/links', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, ...jsonHeaders },
      body: JSON.stringify(createLinkBody(ROGUE, '0x' + 'a3'.repeat(32))),
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('ACCEPTED_TOKENS');
  });

  it('allows any token when no allowlist is configured', async () => {
    const base = await startApp(makeCfg());
    await onboard(base);
    const token = await login(base);

    const res = await req(base, '/v1/links', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, ...jsonHeaders },
      body: JSON.stringify(createLinkBody(ROGUE, '0x' + 'a4'.repeat(32))),
    });
    expect(res.status).toBe(201);
  });

  it('ignores malformed entries in the allowlist instead of failing startup', async () => {
    const base = await startApp(makeCfg('not-an-address,,'));
    await onboard(base);
    const token = await login(base);

    // Allowlist parsed down to [] ⇒ unrestricted.
    const res = await req(base, '/v1/links', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, ...jsonHeaders },
      body: JSON.stringify(createLinkBody(ROGUE, '0x' + 'a5'.repeat(32))),
    });
    expect(res.status).toBe(201);
  });
});
