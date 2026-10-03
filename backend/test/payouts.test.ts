/**
 * Tests for the payout-map API:
 *   GET    /v1/me/payouts
 *   PUT    /v1/me/payouts/:chainId
 *   DELETE /v1/me/payouts/:chainId
 *
 * Also tests that GET /v1/me now includes a `payouts` array, and that
 * seedIdentityPayoutAddresses runs at POST /v1/auth/login.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Wallet as EthersWallet } from 'ethers';
import { createServer } from '../src/api/server.js';
import { JsonStore } from '../src/store/json.js';
import { ChainRegistry } from '../src/chain/index.js';
import type { Config } from '../src/config.js';
import type { ChainConfig } from '../src/chains.js';

const ADMIN_KEY = 'test-admin-key-payouts-0123456789ab';

// Two EVM chains — identity address is valid on both, so login seeds both.
const evmChain1: ChainConfig = {
  id: 'evm-test-1',
  chainId: 46630,
  kind: 'evm',
  name: 'EVM Test Chain 1',
  rpcUrl: 'https://rpc.testnet.chain.robinhood.com/rpc',
  contractAddress: '0xe2C0d033102B7ad963deC4b44B5e1e94bca1385f',
  confirmations: 20,
  pollIntervalMs: 5000,
  maxBlockRange: 2000,
  enabled: true,
  default: true,
};

const evmChain2: ChainConfig = {
  id: 'evm-test-2',
  chainId: 84532,
  kind: 'evm',
  name: 'EVM Test Chain 2',
  rpcUrl: 'https://sepolia.base.org',
  contractAddress: '0xaBcd000000000000000000000000000000000001',
  confirmations: 12,
  pollIntervalMs: 5000,
  maxBlockRange: 2000,
  enabled: true,
};

// A Quai chain. The merchant in this file logs in with an EVM wallet, so nothing seeds this
// chain — which is exactly how a merchant ends up with an unconfigured chain.
const quaiChain: ChainConfig = {
  id: 'quai-test-1',
  chainId: 9,
  kind: 'quai',
  name: 'Quai Test Chain',
  zone: 'cyprus1',
  rpcUrl: 'https://rpc.testnet.quai.network',
  contractAddress: '0x00112233445566778899aabbccddeeff00112233',
  confirmations: 5,
  pollIntervalMs: 5000,
  maxBlockRange: 2000,
  enabled: true,
};

const cfg = {
  ADMIN_API_KEY: ADMIN_KEY,
  CORS_ORIGINS: '*',
  CHAIN_ID: 46630,
  CHAIN_KIND: 'evm',
  LOGIN_REALM: 'tripplepay',
  TRUST_PROXY: 0,
  PAYWITHQUAI_ADDRESS: evmChain1.contractAddress,
  ACCEPTED_TOKENS: [],
} as unknown as Config;

const registry = new ChainRegistry([evmChain1, evmChain2, quaiChain]);

const pk = '0x' + randomBytes(32).toString('hex');
const wallet = new EthersWallet(pk);

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshStore(): JsonStore {
  const dir = mkdtempSync(join(tmpdir(), 'pwq-payouts-'));
  dirs.push(dir);
  return new JsonStore(join(dir, 'relayer.db'), registry.default.config.chainId);
}

async function startApp(): Promise<string> {
  const app = createServer(freshStore(), registry.default.client, cfg, undefined, registry);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function req(
  base: string,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(base + path, init);
  const body = (await res.json().catch(() => undefined)) as Record<string, unknown>;
  return { status: res.status, body };
}

const jsonHeaders = { 'content-type': 'application/json' };

async function onboard(base: string, address: string): Promise<void> {
  const res = await fetch(`${base}/v1/merchants`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN_KEY}`, ...jsonHeaders },
    body: JSON.stringify({ address, name: 'Test Merchant', webhookUrl: 'https://example.test/wh' }),
  });
  expect(res.status).toBe(201);
}

async function loginAs(base: string): Promise<string> {
  const challenge = await req(base, '/v1/auth/challenge', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ address: wallet.address }),
  });
  expect(challenge.status).toBe(200);
  const sig = await wallet.signMessage(challenge.body.message as string);
  const res = await req(base, '/v1/auth/login', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ address: wallet.address, message: challenge.body.message, signature: sig }),
  });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

// ---------------------------------------------------------------------------
// GET /v1/me — payouts field is now part of the profile response
// ---------------------------------------------------------------------------

describe('GET /v1/me — payouts field', () => {
  it('includes payout rows seeded at login', async () => {
    const base = await startApp();
    await onboard(base, wallet.address);
    const token = await loginAs(base);
    const res = await req(base, '/v1/me', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const payouts = res.body.payouts as Array<Record<string, unknown>>;
    expect(Array.isArray(payouts)).toBe(true);
    // Both EVM chains are seeded because the wallet is an EVM wallet.
    expect(payouts.length).toBe(2);
    expect(payouts.every((p) => p.source === 'login')).toBe(true);
    expect(payouts.every((p) => (p.address as string).toLowerCase() === wallet.address.toLowerCase())).toBe(true);
  });

  it('enriches rows with chain name and kind', async () => {
    const base = await startApp();
    await onboard(base, wallet.address);
    const token = await loginAs(base);
    const res = await req(base, '/v1/me', { headers: { authorization: `Bearer ${token}` } });
    const payouts = res.body.payouts as Array<Record<string, unknown>>;
    expect(payouts.some((p) => p.chainName === 'EVM Test Chain 1')).toBe(true);
    expect(payouts.some((p) => p.chainName === 'EVM Test Chain 2')).toBe(true);
    expect(payouts.every((p) => p.chainKind === 'evm')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/auth/login — seeds identity payout addresses
// ---------------------------------------------------------------------------

describe('POST /v1/auth/login — identity payout seeding', () => {
  it('seeds the identity address for all matching chains on first login', async () => {
    const base = await startApp();
    await onboard(base, wallet.address);
    const token = await loginAs(base);
    const res = await req(base, '/v1/me/payouts', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const payouts = res.body.payouts as Array<Record<string, unknown>>;
    expect(payouts.length).toBe(2);
    expect(payouts.every((p) => p.source === 'login')).toBe(true);
  });

  it('does not overwrite a manually-declared address on re-login', async () => {
    const base = await startApp();
    await onboard(base, wallet.address);
    const token = await loginAs(base); // first login — seeds identity

    // Declare a different address for chain 1.
    const altAddr = new EthersWallet('0x' + randomBytes(32).toString('hex')).address;
    const setRes = await req(base, `/v1/me/payouts/${evmChain1.chainId}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, ...jsonHeaders },
      body: JSON.stringify({ address: altAddr }),
    });
    expect(setRes.status).toBe(200);

    // Second login — seed must not clobber the declared row.
    const token2 = await loginAs(base);
    const res = await req(base, '/v1/me/payouts', {
      headers: { authorization: `Bearer ${token2}` },
    });
    const payouts = res.body.payouts as Array<Record<string, unknown>>;
    const chain1 = payouts.find((p) => p.chainId === evmChain1.chainId);
    expect((chain1?.address as string).toLowerCase()).toBe(altAddr.toLowerCase());
    expect(chain1?.source).toBe('declared');
  });
});

// ---------------------------------------------------------------------------
// GET /v1/me/payouts
// ---------------------------------------------------------------------------

describe('GET /v1/me/payouts', () => {
  it('requires auth', async () => {
    const base = await startApp();
    const res = await req(base, '/v1/me/payouts');
    expect(res.status).toBe(401);
  });

  it('lists seeded payouts after login', async () => {
    const base = await startApp();
    await onboard(base, wallet.address);
    const token = await loginAs(base);
    const res = await req(base, '/v1/me/payouts', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.payouts)).toBe(true);
    expect((res.body.payouts as unknown[]).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// PUT /v1/me/payouts/:chainId
// ---------------------------------------------------------------------------

describe('PUT /v1/me/payouts/:chainId', () => {
  it('requires auth', async () => {
    const base = await startApp();
    const res = await req(base, `/v1/me/payouts/${evmChain1.chainId}`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ address: wallet.address }),
    });
    expect(res.status).toBe(401);
  });

  it('sets a valid EVM address for an EVM chain', async () => {
    const base = await startApp();
    await onboard(base, wallet.address);
    const token = await loginAs(base);

    const newAddr = new EthersWallet('0x' + randomBytes(32).toString('hex')).address;
    const res = await req(base, `/v1/me/payouts/${evmChain1.chainId}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, ...jsonHeaders },
      body: JSON.stringify({ address: newAddr }),
    });
    expect(res.status).toBe(200);
    expect((res.body.address as string).toLowerCase()).toBe(newAddr.toLowerCase());
    expect(res.body.source).toBe('declared');
    expect(res.body.chainId).toBe(evmChain1.chainId);
  });

  it('accepts the chain by slug as well as by numeric chainId', async () => {
    const base = await startApp();
    await onboard(base, wallet.address);
    const token = await loginAs(base);

    const res = await req(base, `/v1/me/payouts/${evmChain1.id}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, ...jsonHeaders },
      body: JSON.stringify({ address: wallet.address }),
    });
    expect(res.status).toBe(200);
    expect(res.body.chainId).toBe(evmChain1.chainId);
  });

  it('rejects a malformed address with 400', async () => {
    const base = await startApp();
    await onboard(base, wallet.address);
    const token = await loginAs(base);

    const res = await req(base, `/v1/me/payouts/${evmChain1.chainId}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, ...jsonHeaders },
      body: JSON.stringify({ address: 'not-a-valid-address' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a missing address field with 400', async () => {
    const base = await startApp();
    await onboard(base, wallet.address);
    const token = await loginAs(base);

    const res = await req(base, `/v1/me/payouts/${evmChain1.chainId}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, ...jsonHeaders },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown chain with 400', async () => {
    const base = await startApp();
    await onboard(base, wallet.address);
    const token = await loginAs(base);

    const res = await req(base, '/v1/me/payouts/99999', {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, ...jsonHeaders },
      body: JSON.stringify({ address: wallet.address }),
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('unknown');
  });

  it('persists the new address and surfaces it in a subsequent GET', async () => {
    const base = await startApp();
    await onboard(base, wallet.address);
    const token = await loginAs(base);

    const newAddr = new EthersWallet('0x' + randomBytes(32).toString('hex')).address;
    await req(base, `/v1/me/payouts/${evmChain2.chainId}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, ...jsonHeaders },
      body: JSON.stringify({ address: newAddr }),
    });

    const list = await req(base, '/v1/me/payouts', {
      headers: { authorization: `Bearer ${token}` },
    });
    const row = (list.body.payouts as Array<Record<string, unknown>>).find(
      (p) => p.chainId === evmChain2.chainId,
    );
    expect((row?.address as string).toLowerCase()).toBe(newAddr.toLowerCase());
    expect(row?.source).toBe('declared');
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/me/payouts/:chainId
// ---------------------------------------------------------------------------

describe('DELETE /v1/me/payouts/:chainId', () => {
  it('requires auth', async () => {
    const base = await startApp();
    const res = await fetch(`${base}/v1/me/payouts/${evmChain1.chainId}`, { method: 'DELETE' });
    expect(res.status).toBe(401);
  });

  it('clears a configured address and removes the row from the list', async () => {
    const base = await startApp();
    await onboard(base, wallet.address);
    const token = await loginAs(base);

    // Verify seeded rows exist.
    const before = await req(base, '/v1/me/payouts', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect((before.body.payouts as unknown[]).length).toBe(2);

    // Clear chain 1.
    const del = await fetch(`${base}/v1/me/payouts/${evmChain1.chainId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.status).toBe(204);

    const after = await req(base, '/v1/me/payouts', {
      headers: { authorization: `Bearer ${token}` },
    });
    const afterRows = after.body.payouts as Array<Record<string, unknown>>;
    expect(afterRows.some((p) => p.chainId === evmChain1.chainId)).toBe(false);
    // Chain 2 row must survive.
    expect(afterRows.some((p) => p.chainId === evmChain2.chainId)).toBe(true);
  });

  it('returns 204 even when no row exists (idempotent)', async () => {
    const base = await startApp();
    await onboard(base, wallet.address);
    const token = await loginAs(base);

    // Clear twice.
    await fetch(`${base}/v1/me/payouts/${evmChain1.chainId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    const second = await fetch(`${base}/v1/me/payouts/${evmChain1.chainId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(second.status).toBe(204);
  });

  it('rejects an unknown chain with 400', async () => {
    const base = await startApp();
    await onboard(base, wallet.address);
    const token = await loginAs(base);

    const res = await fetch(`${base}/v1/me/payouts/99999`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as { error?: string };
    expect(res.status).toBe(400);
    expect(String(body.error)).toContain('unknown');
  });
});

// ---------------------------------------------------------------------------
// The payout map only earns its keep if link creation actually settles to it. These cover the
// consumption path, and specifically the three places where "does this merchant own this?"
// must be answered by merchantId and never by comparing a payout address to an identity address.
// ---------------------------------------------------------------------------

describe('POST /v1/links settles to the per-chain payout address', () => {
  const USDT = '0x0049f7cbca3556c2dfae62aafa7015f99de1b8f5';

  /** Onboard + login, then declare `payout` for `chain`. Returns the session token. */
  async function merchantWithPayout(base: string, chain: ChainConfig, payout: string): Promise<string> {
    await onboard(base, wallet.address);
    const token = await loginAs(base);
    const put = await req(base, `/v1/me/payouts/${chain.chainId}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, ...jsonHeaders },
      body: JSON.stringify({ address: payout }),
    });
    expect(put.status).toBe(200);
    return token;
  }

  function linkBody(chainId: number, over: Record<string, unknown> = {}): string {
    return JSON.stringify({
      tokenAddress: USDT,
      amount: '100',
      amountDisplay: '1',
      symbol: 'USDT',
      chainId,
      // No order signer in this harness, so a link needs a pre-registered pool to be payable.
      orderPool: ['0x' + '11'.repeat(32)],
      ...over,
    });
  }

  it('sends the order to the declared payout, not to the login identity', async () => {
    const base = await startApp();
    const payout = new EthersWallet('0x' + randomBytes(32).toString('hex')).address;
    const token = await merchantWithPayout(base, evmChain1, payout);

    const created = await req(base, '/v1/links', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, ...jsonHeaders },
      body: linkBody(evmChain1.chainId),
    });

    expect(created.status).toBe(201);
    expect((created.body.merchantAddress as string).toLowerCase()).toBe(payout.toLowerCase());
    expect((created.body.merchantAddress as string).toLowerCase()).not.toBe(wallet.address.toLowerCase());
  });

  it('blocks a link whose chain has no payout address configured', async () => {
    const base = await startApp();
    await onboard(base, wallet.address);
    const token = await loginAs(base);

    const created = await req(base, '/v1/links', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, ...jsonHeaders },
      body: linkBody(quaiChain.chainId),
    });

    expect(created.status).toBe(400);
    expect(created.body.code).toBe('payout_address_required');
    expect(created.body.chainId).toBe(quaiChain.chainId);
  });

  it('lists the link under GET /v1/links even though its payout differs from the identity', async () => {
    const base = await startApp();
    const payout = new EthersWallet('0x' + randomBytes(32).toString('hex')).address;
    const token = await merchantWithPayout(base, evmChain1, payout);

    const created = await req(base, '/v1/links', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, ...jsonHeaders },
      body: linkBody(evmChain1.chainId),
    });
    expect(created.status).toBe(201);

    // Ownership is resolved by merchantId. Matching on the payout address would hide this link —
    // the merchant would create it successfully and then never see it in their own dashboard.
    const listed = await req(base, '/v1/links', { headers: { authorization: `Bearer ${token}` } });
    expect(listed.status).toBe(200);
    const links = listed.body.links as Array<{ slug: string; merchantAddress: string }>;
    expect(links.map((l) => l.slug)).toContain(created.body.slug);
    expect(links[0]?.merchantAddress.toLowerCase()).toBe(payout.toLowerCase());
  });

  it('attributes a slug-sourced order to the merchant when payout differs from identity', async () => {
    const base = await startApp();
    const payout = new EthersWallet('0x' + randomBytes(32).toString('hex')).address;
    const token = await merchantWithPayout(base, evmChain1, payout);

    const created = await req(base, '/v1/links', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, ...jsonHeaders },
      body: linkBody(evmChain1.chainId),
    });
    expect(created.status).toBe(201);

    const orderId = '0x' + '22'.repeat(32);
    const meta = await req(base, `/v1/orders/${wallet.address}/${orderId}/meta`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ slug: created.body.slug, customerName: 'Buyer' }),
    });

    expect(meta.status).toBe(200);
    expect(meta.body.ok).toBe(true);
  });

  it('keeps each chain pointed at its own payout', async () => {
    const base = await startApp();
    const payout1 = new EthersWallet('0x' + randomBytes(32).toString('hex')).address;
    const payout2 = new EthersWallet('0x' + randomBytes(32).toString('hex')).address;
    await onboard(base, wallet.address);
    const token = await loginAs(base);

    for (const [chain, addr] of [[evmChain1, payout1], [evmChain2, payout2]] as const) {
      const put = await req(base, `/v1/me/payouts/${chain.chainId}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, ...jsonHeaders },
        body: JSON.stringify({ address: addr }),
      });
      expect(put.status).toBe(200);
    }

    const link1 = await req(base, '/v1/links', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, ...jsonHeaders },
      body: linkBody(evmChain1.chainId),
    });
    const link2 = await req(base, '/v1/links', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, ...jsonHeaders },
      body: linkBody(evmChain2.chainId),
    });

    expect(link1.status).toBe(201);
    expect(link2.status).toBe(201);
    expect((link1.body.merchantAddress as string).toLowerCase()).toBe(payout1.toLowerCase());
    expect((link2.body.merchantAddress as string).toLowerCase()).toBe(payout2.toLowerCase());
  });
});
