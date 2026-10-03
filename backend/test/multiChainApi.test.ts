import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Wallet as QuaisWallet } from 'quais';
import { Wallet as EthersWallet } from 'ethers';
import { createServer } from '../src/api/server.js';
import { JsonStore } from '../src/store/json.js';
import { ChainRegistry } from '../src/chain/index.js';
import type { Config } from '../src/config.js';
import type { ChainConfig } from '../src/chains.js';

const ADMIN_KEY = 'test-admin-key-0123456789abcdef';

const quaiChain: ChainConfig = {
  id: 'quai',
  chainId: 9,
  kind: 'quai',
  name: 'Quai',
  rpcUrl: 'https://rpc.quai.network/cyprus1',
  contractAddress: '0x0072174EF6d0C2EB605449b0014169D104c42BbC',
  confirmations: 12,
  pollIntervalMs: 5000,
  maxBlockRange: 2000,
  enabled: true,
  default: true,
  acceptedTokens: ['0x0049f7cbca3556c2dfae62aafa7015f99de1b8f5'], // USDT only on this chain
};

const evmChain: ChainConfig = {
  id: 'robinhood-testnet',
  chainId: 46630,
  kind: 'evm',
  name: 'Robinhood Chain testnet',
  rpcUrl: 'https://rpc.testnet.chain.robinhood.com/rpc',
  contractAddress: '0xe2C0d033102B7ad963deC4b44B5e1e94bca1385f',
  confirmations: 20,
  pollIntervalMs: 5000,
  maxBlockRange: 2000,
  enabled: true,
  // no acceptedTokens — unrestricted on this chain
};

const cfg = {
  ADMIN_API_KEY: ADMIN_KEY,
  CORS_ORIGINS: '*',
  CHAIN_ID: 9,
  CHAIN_KIND: 'quai',
  LOGIN_REALM: 'tripplepay',
  TRUST_PROXY: 0,
  PAYWITHQUAI_ADDRESS: quaiChain.contractAddress,
  ACCEPTED_TOKENS: [],
} as unknown as Config;

const registry = new ChainRegistry([quaiChain, evmChain]);

// Same underlying private key, wrapped by each SDK — same address (bytes), used to prove the
// SAME merchant record works across a Quai-kind and an EVM-kind chain (product rule: merchants
// are chain-free). Address derivation (keccak256 of the pubkey) is identical between quais and
// ethers; only checksum CAPITALIZATION can differ, and both accept either capitalization back.
const pk = '0x' + randomBytes(32).toString('hex');
const quaisWallet = new QuaisWallet(pk);
const ethersWallet = new EthersWallet(pk);

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshStore(): JsonStore {
  const dir = mkdtempSync(join(tmpdir(), 'pwq-multichain-'));
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

async function req(base: string, path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(base + path, init);
  const body = (await res.json().catch(() => undefined)) as Record<string, unknown>;
  return { status: res.status, body };
}

const jsonHeaders = { 'content-type': 'application/json' };

async function onboard(base: string, address: string): Promise<void> {
  const res = await fetch(`${base}/v1/merchants`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN_KEY}`, ...jsonHeaders },
    body: JSON.stringify({ address, name: 'Acme', webhookUrl: 'https://example.test/webhook' }),
  });
  expect(res.status).toBe(201);
}

/**
 * Declare a Quai payout for the merchant.
 *
 * `quaisWallet` here is derived from a bare key with no zone prefix, so it is NOT a valid Cyprus-1
 * destination and login deliberately refuses to seed it onto the Quai chain. These tests are about
 * chain selection and allowlists rather than payouts, so they nominate an explicit Quai payout to
 * put the Quai chain in a payable state — which is what a real Quai merchant's Pelagus wallet
 * would supply.
 */
const CYPRUS1_PAYOUT = '0x002dB0fBCA5a3DC1336e5D00ABCbCd9daac9cFF6';

async function declareQuaiPayout(base: string, token: string): Promise<void> {
  const res = await req(base, '/v1/me/payouts/9', {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, ...jsonHeaders },
    body: JSON.stringify({ address: CYPRUS1_PAYOUT }),
  });
  expect(res.status).toBe(200);
}

async function loginAs(
  base: string,
  wallet: QuaisWallet | EthersWallet,
  chainId?: string | number,
): Promise<string> {
  const challenge = await req(base, '/v1/auth/challenge', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ address: wallet.address, ...(chainId !== undefined ? { chainId } : {}) }),
  });
  if (challenge.status !== 200) throw new Error(`challenge failed: ${challenge.status} ${JSON.stringify(challenge.body)}`);
  const signature = await wallet.signMessage(challenge.body.message as string);
  const res = await req(base, '/v1/auth/login', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ address: wallet.address, message: challenge.body.message, signature }),
  });
  if (res.status !== 200 || typeof res.body.token !== 'string') {
    throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token as string;
}

function createLinkBody(over: Record<string, unknown> = {}) {
  return {
    shopName: 'Test Shop',
    tokenAddress: '0x0000000000000000000000000000000000000000',
    amount: '25000000',
    amountDisplay: '25',
    symbol: 'TST',
    expiryDurationSecs: 0,
    multiPay: false,
    orderPool: ['0x' + 'b1'.repeat(32)],
    ...over,
  };
}

describe('POST /v1/links — multi-chain', () => {
  it('creates a link on the default chain when chainId is omitted', async () => {
    const base = await startApp();
    await onboard(base, quaisWallet.address);
    const token = await loginAs(base, quaisWallet);
    await declareQuaiPayout(base, token);

    const res = await req(base, '/v1/links', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, ...jsonHeaders },
      body: JSON.stringify(createLinkBody()),
    });
    expect(res.status).toBe(201);
    expect(res.body.chainId).toBe(9);
    expect((res.body.merchantAddress as string).toLowerCase()).toBe(CYPRUS1_PAYOUT.toLowerCase());
    expect((res.body.chain as Record<string, unknown>).id).toBe('quai');
  });

  it('creates a link on an explicitly-chosen chain, by slug or by numeric chainId', async () => {
    const base = await startApp();
    await onboard(base, quaisWallet.address);
    const token = await loginAs(base, quaisWallet);

    const bySlug = await req(base, '/v1/links', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, ...jsonHeaders },
      body: JSON.stringify(createLinkBody({ chainId: 'robinhood-testnet', orderPool: ['0x' + 'b2'.repeat(32)] })),
    });
    expect(bySlug.status).toBe(201);
    expect(bySlug.body.chainId).toBe(46630);

    const byNumber = await req(base, '/v1/links', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, ...jsonHeaders },
      body: JSON.stringify(createLinkBody({ chainId: 46630, orderPool: ['0x' + 'b3'.repeat(32)] })),
    });
    expect(byNumber.status).toBe(201);
    expect(byNumber.body.chainId).toBe(46630);
  });

  it('rejects an unknown chain with 400', async () => {
    const base = await startApp();
    await onboard(base, quaisWallet.address);
    const token = await loginAs(base, quaisWallet);

    const res = await req(base, '/v1/links', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, ...jsonHeaders },
      body: JSON.stringify(createLinkBody({ chainId: 'nonexistent-chain' })),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a disabled/unconfigured chain the same way as an unknown one', async () => {
    const base = await startApp();
    await onboard(base, quaisWallet.address);
    const token = await loginAs(base, quaisWallet);

    const res = await req(base, '/v1/links', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, ...jsonHeaders },
      body: JSON.stringify(createLinkBody({ chainId: 84532 })), // never enabled in this registry
    });
    expect(res.status).toBe(400);
  });

  it("enforces each chain's OWN token allowlist independently", async () => {
    const base = await startApp();
    await onboard(base, quaisWallet.address);
    const token = await loginAs(base, quaisWallet);
    await declareQuaiPayout(base, token);

    // The robinhood-testnet chain has no allowlist configured — any token is accepted there.
    const onEvm = await req(base, '/v1/links', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, ...jsonHeaders },
      body: JSON.stringify(
        createLinkBody({ chainId: 'robinhood-testnet', tokenAddress: '0x' + 'ee'.repeat(20), orderPool: ['0x' + 'b4'.repeat(32)] }),
      ),
    });
    expect(onEvm.status).toBe(201);

    // The quai chain's allowlist only has USDT — the same arbitrary token is rejected there.
    const onQuai = await req(base, '/v1/links', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, ...jsonHeaders },
      body: JSON.stringify(createLinkBody({ tokenAddress: '0x' + 'ee'.repeat(20), orderPool: ['0x' + 'b5'.repeat(32)] })),
    });
    expect(onQuai.status).toBe(400);
    expect(String(onQuai.body.error)).toContain('ACCEPTED_TOKENS');

    // USDT itself is still accepted on quai.
    const usdtOnQuai = await req(base, '/v1/links', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, ...jsonHeaders },
      body: JSON.stringify(
        createLinkBody({ tokenAddress: '0x0049f7cbca3556c2dfae62aafa7015f99de1b8f5', orderPool: ['0x' + 'b6'.repeat(32)] }),
      ),
    });
    expect(usdtOnQuai.status).toBe(201);
  });
});

describe('GET /v1/links/:slug — multi-chain', () => {
  it('reports the correct chain for a link created on a non-default chain', async () => {
    const base = await startApp();
    await onboard(base, quaisWallet.address);
    const token = await loginAs(base, quaisWallet);
    const created = await req(base, '/v1/links', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, ...jsonHeaders },
      body: JSON.stringify(createLinkBody({ chainId: 'robinhood-testnet', orderPool: ['0x' + 'b7'.repeat(32)] })),
    });
    const slug = created.body.slug as string;

    const res = await req(base, `/v1/links/${slug}`);
    expect(res.status).toBe(200);
    expect(res.body.chainId).toBe(46630);
    expect((res.body.chain as Record<string, unknown>).kind).toBe('evm');
  });
});

describe('GET /v1/orders — multi-chain', () => {
  it('rejects an unknown chainId query param with 400', async () => {
    const base = await startApp();
    const res = await req(base, `/v1/orders/${quaisWallet.address}/${'0x' + '11'.repeat(32)}?chainId=nonexistent`);
    expect(res.status).toBe(400);
  });
});

describe('GET /health and GET /v1/chains — multi-chain', () => {
  it('/health reports every configured chain, plus backward-compatible top-level fields', async () => {
    const base = await startApp();
    const res = await req(base, '/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    const chains = res.body.chains as Array<Record<string, unknown>>;
    expect(chains.map((c) => c.id).sort()).toEqual(['quai', 'robinhood-testnet']);
    expect(res.body.chainId).toBe(9); // legacy top-level field — the DEFAULT chain
    expect(res.body.chainKind).toBe('quai');
    expect(typeof res.body.healthy).toBe('boolean');
  });

  it('admin GET /v1/chains lists the same chains and requires auth', async () => {
    const base = await startApp();
    expect((await req(base, '/v1/chains')).status).toBe(401);
    const res = await req(base, '/v1/chains', { headers: { authorization: `Bearer ${ADMIN_KEY}` } });
    expect(res.status).toBe(200);
    expect((res.body.chains as unknown[]).length).toBe(2);
    expect(res.body.default).toBe('quai');
  });
});

describe('auth — chain-free merchants across configured chains', () => {
  it('accepts logins for the SAME merchant on both a Quai-kind and an EVM-kind chain', async () => {
    const base = await startApp();
    await onboard(base, quaisWallet.address); // stored lowercased — same record for both wallets below

    // Signed for the default (Quai) chain via the quais-wrapped key.
    const t1 = await loginAs(base, quaisWallet);
    expect(typeof t1).toBe('string');

    // Signed for the EVM chain via the ethers-wrapped SAME key — same merchant, different chain
    // and signing scheme.
    const t2 = await loginAs(base, ethersWallet, 'robinhood-testnet');
    expect(typeof t2).toBe('string');
  });

  it('challenge binds the resolved chainId into the message, unchanged format', async () => {
    const base = await startApp();
    const res = await req(base, '/v1/auth/challenge', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ address: quaisWallet.address, chainId: 'robinhood-testnet' }),
    });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(
      new RegExp(`^tripplepay-login:${quaisWallet.address}:[0-9a-f]{16,}:46630:tripplepay$`),
    );
  });

  it('rejects a challenge request for an unconfigured chain', async () => {
    const base = await startApp();
    const res = await req(base, '/v1/auth/challenge', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ address: quaisWallet.address, chainId: 999999 }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a login signature forged to claim a chainId this deployment never configured', async () => {
    const base = await startApp();
    await onboard(base, quaisWallet.address);
    const challenge = await req(base, '/v1/auth/challenge', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ address: quaisWallet.address }),
    });
    const forged = (challenge.body.message as string).replace(/:9:tripplepay$/, ':999999:tripplepay');
    const signature = await quaisWallet.signMessage(forged);
    const res = await req(base, '/v1/auth/login', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ address: quaisWallet.address, message: forged, signature }),
    });
    expect(res.status).toBe(401);
  });
});
