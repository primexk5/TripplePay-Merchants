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
import type { WebhookDelivery } from '../src/types.js';

const ADMIN_KEY = 'test-admin-key-0123456789abcdef';
const CONTRACT = '0x0000000000000000000000000000000000000001';

const cfg = {
  ADMIN_API_KEY: ADMIN_KEY,
  CORS_ORIGINS: '*',
  CHAIN_ID: 9,
  LOGIN_REALM: 'tripplepay',
  TRUST_PROXY: 0,
  PAYWITHQUAI_ADDRESS: CONTRACT,
} as unknown as Config;

// quais' alpha API has no Wallet.createRandom — construct from a fresh random key.
const wallet = new Wallet('0x' + randomBytes(32).toString('hex'));
const merchantAddress = wallet.address;

function freshRandomWallet(): Wallet {
  return new Wallet('0x' + randomBytes(32).toString('hex'));
}

function fakeClient(): QuaiClient {
  return { address: CONTRACT } as unknown as QuaiClient;
}

const dirs: string[] = [];
function freshStore(): JsonStore {
  const dir = mkdtempSync(join(tmpdir(), 'pwq-auth-'));
  dirs.push(dir);
  return new JsonStore(join(dir, 'relayer.db'));
}

const servers: import('node:http').Server[] = [];
async function startApp(): Promise<{ base: string; store: JsonStore }> {
  const store = freshStore();
  const app = createServer(store, fakeClient(), cfg);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, store };
}

async function req(base: string, path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(base + path, init);
  const body = (await res.json().catch(() => undefined)) as Record<string, unknown>;
  return { status: res.status, body };
}

const auth = (key: string) => ({ authorization: `Bearer ${key}` });
const jsonHeaders = { 'content-type': 'application/json' };

/** Fetch a fresh challenge for `w.address` and sign it — the real client flow. */
async function signLogin(
  base: string,
  w: Wallet,
): Promise<{ address: string; message: string; signature: string }> {
  const challenge = await fetch(`${base}/v1/auth/challenge`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ address: w.address }),
  });
  const body = (await challenge.json()) as { message?: string; nonce?: string };
  if (challenge.status !== 200 || !body.message) {
    throw new Error(`challenge failed: ${challenge.status}`);
  }
  return {
    address: w.address,
    message: body.message,
    signature: await w.signMessage(body.message),
  };
}

/** Onboard the test wallet as a merchant (admin route), returning the webhook secret. */
async function onboardMerchant(base: string, address = merchantAddress): Promise<void> {
  const res = await fetch(`${base}/v1/merchants`, {
    method: 'POST',
    headers: { ...auth(ADMIN_KEY), ...jsonHeaders },
    body: JSON.stringify({ address, name: 'Acme', webhookUrl: 'https://example.test/webhook' }),
  });
  expect(res.status).toBe(201);
}

async function seedDelivery(store: JsonStore, merchantId: string, over: Partial<WebhookDelivery> = {}): Promise<WebhookDelivery> {
  const d: WebhookDelivery = {
    id: '0x' + 'cd'.repeat(32) + ':0',
    chainId: 9,
    merchantId,
    url: 'https://example.test/webhook',
    payload: {
      id: '0x' + 'cd'.repeat(32) + ':0',
      type: 'payment.confirmed',
      created: 1,
      data: {
        merchantId,
        chainId: 9,
        merchant: merchantAddress,
        orderId: '0x' + '22'.repeat(32),
        payer: '0x00000000000000000000000000000000000000b2',
        token: '0x0000000000000000000000000000000000000000',
        amount: '25000000',
        feeBps: 50,
        fee: '125000',
        net: '24875000',
        txHash: '0x' + 'cd'.repeat(32),
        blockNumber: 10,
        timestamp: 1,
        nonce: 1,
      },
    },
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
  await store.insertDeliveryIfAbsent(d);
  return d;
}

/** A delivery for a different merchant, with distinct ids so it can't collide with the default. */
async function otherMerchantDelivery(store: JsonStore): Promise<WebhookDelivery> {
  return await seedDelivery(store, 'mch_other', {
    id: '0x' + 'ef'.repeat(32) + ':0',
    chainId: 9,
    payload: {
      id: '0x' + 'ef'.repeat(32) + ':0',
      type: 'payment.confirmed',
      created: 1,
      data: {
        merchantId: 'mch_other',
        chainId: 9,
        merchant: '0x00000000000000000000000000000000000000d4',
        orderId: '0x' + '33'.repeat(32),
        payer: '0x00000000000000000000000000000000000000b2',
        token: '0x0000000000000000000000000000000000000000',
        amount: '1000000',
        feeBps: 50,
        fee: '5000',
        net: '995000',
        txHash: '0x' + 'ef'.repeat(32),
        blockNumber: 10,
        timestamp: 1,
        nonce: 1,
      },
    },
  });
}

describe('POST /v1/auth/login', () => {
  let base: string;
  beforeAll(async () => {
    ({ base } = await startApp());
    await onboardMerchant(base);
  });

  afterAll(() => {
    for (const s of servers) s.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('issues a session token for a valid wallet signature', async () => {
    const { message, signature, address } = await signLogin(base, wallet);
    const res = await req(base, '/v1/auth/login', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ address, message, signature }),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ merchant: { name: 'Acme' } });
    expect(typeof res.body.token).toBe('string');
    expect((res.body.token as string).length).toBeGreaterThanOrEqual(32);
    expect((res.body.expiresAt as number)).toBeGreaterThan(Date.now());
  });

  it('sets an HttpOnly session cookie alongside the bearer token', async () => {
    const { message, signature, address } = await signLogin(base, wallet);
    const res = await fetch(`${base}/v1/auth/login`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ address, message, signature }),
    });
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/qmsession=[0-9a-f]+/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Max-Age=/);
  });

  it('rejects a signature from a different wallet', async () => {
    const other = freshRandomWallet();
    // Challenge issued for the MERCHANT address, signed by a different wallet.
    const { message } = await signLogin(base, wallet);
    const signature = await other.signMessage(message);
    const res = await req(base, '/v1/auth/login', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ address: merchantAddress, message, signature }),
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid credentials/i);
  });

  it('rejects a message not addressed to the claimed wallet', async () => {
    const other = freshRandomWallet();
    const { message, signature } = await signLogin(base, other);
    const res = await req(base, '/v1/auth/login', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ address: merchantAddress, message, signature }),
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid credentials/i);
  });

  it('rejects a replayed login — the nonce is single-use', async () => {
    const { message, signature, address } = await signLogin(base, wallet);
    const first = await req(base, '/v1/auth/login', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ address, message, signature }),
    });
    expect(first.status).toBe(200);
    const replay = await req(base, '/v1/auth/login', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ address, message, signature }),
    });
    expect(replay.status).toBe(401);
    expect(replay.body.error).toMatch(/invalid credentials/i);
  });

  it('rejects a challenge bound to a different chain id or realm', async () => {
    const { message, signature, address } = await signLogin(base, wallet);
    const forged = message.replace(/:9:tripplepay$/, ':15000:tripplepay');
    const res = await req(base, '/v1/auth/login', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ address, message: forged, signature: await wallet.signMessage(forged) }),
    });
    expect(res.status).toBe(401);
  });

  it('answers uniformly 401 for unregistered addresses (no enumeration)', async () => {
    const stranger = freshRandomWallet();
    const { message, signature } = await signLogin(base, stranger);
    const res = await req(base, '/v1/auth/login', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ address: stranger.address, message, signature }),
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid credentials/i);
  });

  it('rejects malformed bodies and garbage signatures', async () => {
    const badSig = await req(base, '/v1/auth/login', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ address: 'not-an-address', message: 'x', signature: 'y' }),
    });
    expect(badSig.status).toBe(400);

    const garbage = await req(base, '/v1/auth/login', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ address: merchantAddress, message: 'garbage', signature: '0xdeadbeef' }),
    });
    expect(garbage.status).toBe(401);
  });
});

describe('session-protected routes', () => {
  let base: string;
  let store: JsonStore;
  let token: string;

  beforeAll(async () => {
    ({ base, store } = await startApp());
    await onboardMerchant(base);
    const { message, signature, address } = await signLogin(base, wallet);
    const res = await req(base, '/v1/auth/login', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ address, message, signature }),
    });
    expect(res.status).toBe(200);
    token = res.body.token as string;
  });

  afterAll(() => {
    for (const s of servers) s.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('returns 401 without a token and with a garbage token', async () => {
    const none = await req(base, '/v1/me');
    expect(none.status).toBe(401);

    const garbage = await req(base, '/v1/me', { headers: auth('deadbeef') });
    expect(garbage.status).toBe(401);
  });

  it('GET /v1/me returns the logged-in merchant profile (no secret)', async () => {
    const res = await req(base, '/v1/me', { headers: auth(token) });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Acme', address: merchantAddress, active: true });
    expect(res.body).not.toHaveProperty('webhookSecret');
  });

  it('accepts the HttpOnly cookie WITHOUT a bearer token (browser flow)', async () => {
    // The browser sends only the cookie; bearerToken() returns '' (not null) without an
    // Authorization header, so `??` here would short-circuit and never read the cookie.
    const { message, signature, address } = await signLogin(base, wallet);
    const login = await fetch(`${base}/v1/auth/login`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ address, message, signature }),
    });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(cookie).toMatch(/^qmsession=/);

    const res = await req(base, '/v1/me', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Acme', address: merchantAddress });
  });

  it('PATCH /v1/me updates name and webhookUrl without rotating the secret', async () => {
    const before = await req(base, '/v1/me', { headers: auth(token) });
    const secretBefore = (await store.getMerchantById((before.body.merchantId as string) ?? ''))?.webhookSecret;

    const res = await req(base, '/v1/me', {
      method: 'PATCH',
      headers: { ...auth(token), ...jsonHeaders },
      body: JSON.stringify({ name: 'Acme 2', webhookUrl: 'https://hooks.example.test/v2' }),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Acme 2', webhookUrl: 'https://hooks.example.test/v2' });

    const merchant = await store.getMerchantByAddress(merchantAddress);
    expect(merchant?.webhookSecret).toBe(secretBefore);
  });

  it('GET /v1/me/deliveries returns only deliveries for this merchant', async () => {
    const merchantId = (await store.getMerchantByAddress(merchantAddress))!.merchantId;
    await seedDelivery(store, merchantId);
    await otherMerchantDelivery(store);

    const res = await req(base, '/v1/me/deliveries', { headers: auth(token) });
    expect(res.status).toBe(200);
    const deliveries = res.body.deliveries as { merchantId: string }[];
    expect(deliveries.length).toBeGreaterThan(0);
    expect(deliveries.every((d) => d.merchantId === merchantId)).toBe(true);
  });

  it('logout invalidates the token', async () => {
    const logout = await req(base, '/v1/auth/logout', { method: 'POST', headers: auth(token) });
    expect(logout.status).toBe(204);

    const after = await req(base, '/v1/me', { headers: auth(token) });
    expect(after.status).toBe(401);
  });
});