import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Wallet, getAddress } from 'quais';
import { createServer } from '../src/api/server.js';
import { JsonStore } from '../src/store/json.js';
import type { Config } from '../src/config.js';
import type { QuaiClient } from '../src/chain/client.js';
import {
  SIGNED_ORDER_TYPES,
  SIGNING_DOMAIN_NAME,
  SIGNING_DOMAIN_VERSION,
  type OrderSigner,
  type SignedOrderAuthorization,
  type SignedAuthorizationJson,
} from '../src/chain/signer.js';

const ADMIN_KEY = 'test-admin-key-0123456789abcdef';
const CONTRACT = '0x0000000000000000000000000000000000000001';
const FEE_RECIPIENT = getAddress('0x000000000000000000000000000000000000dEaD');
const FEE_BPS = 75;
const USDT = '0x0049f7cbca3556c2dfae62aafa7015f99de1b8f5';
const CHAIN_ID = 9;
const SIGNER_KEY = '0x' + 'd4'.repeat(32);

const merchant = new Wallet('0x' + randomBytes(32).toString('hex'));

/** A fresh customer wallet, so every case is a different payer with no shared claim history. */
function randomPayer(): Wallet {
  return new Wallet('0x' + randomBytes(32).toString('hex'));
}

function makeCfg(signerKey: string | undefined = SIGNER_KEY): Config {
  return {
    ADMIN_API_KEY: ADMIN_KEY,
    CORS_ORIGINS: '*',
    CHAIN_ID,
    LOGIN_REALM: 'tripplepay',
    TRUST_PROXY: 0,
    PAYWITHQUAI_ADDRESS: CONTRACT,
    ORDER_SIGNER_PRIVATE_KEY: signerKey,
  } as unknown as Config;
}

function fakeClient(): QuaiClient {
  return {
    address: CONTRACT,
    feeBps: async () => FEE_BPS,
    feeRecipient: async () => FEE_RECIPIENT,
  } as unknown as QuaiClient;
}

/**
 * Records what the API asked to be authorized and signs it with the real key, so the digests
 * under test are the ones the contract will see — not a stand-in.
 */
class RecordingSigner implements OrderSigner {
  readonly enabled: boolean;
  readonly address: string;
  readonly calls: SignedOrderAuthorization[] = [];
  private readonly wallet: Wallet;

  constructor(enabled: boolean) {
    this.enabled = enabled;
    this.address = new Wallet(SIGNER_KEY).address;
    this.wallet = new Wallet(SIGNER_KEY);
  }

  async sign(
    order: SignedOrderAuthorization,
    deployment: { chainId: number; contractAddress: string },
  ): Promise<SignedOrderAuthorization & { signature: string }> {
    this.calls.push(order);
    return {
      ...order,
      signature: await this.wallet.signTypedData(
        {
          name: SIGNING_DOMAIN_NAME,
          version: SIGNING_DOMAIN_VERSION,
          chainId: deployment.chainId,
          verifyingContract: deployment.contractAddress,
        },
        SIGNED_ORDER_TYPES,
        { ...order, amount: order.amount.toString() },
      ),
    };
  }
}

const dirs: string[] = [];
const servers: import('node:http').Server[] = [];
afterAll(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Harness {
  base: string;
  store: JsonStore;
  signer: RecordingSigner;
}

async function startApp(opts?: { signerEnabled?: boolean }): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'pwq-claim-'));
  dirs.push(dir);
  const store = new JsonStore(join(dir, 'relayer.db'));
  const signer = new RecordingSigner(opts?.signerEnabled !== false);
  const cfg = makeCfg(opts?.signerEnabled === false ? undefined : SIGNER_KEY);
  const app = createServer(store, fakeClient(), cfg, undefined, undefined, undefined, undefined, signer);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, store, signer };
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

async function onboard(base: string): Promise<void> {
  const res = await fetch(`${base}/v1/merchants`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN_KEY}`, ...jsonHeaders },
    body: JSON.stringify({
      address: merchant.address,
      name: 'Acme',
      webhookUrl: 'https://example.test/webhook',
    }),
  });
  expect(res.status).toBe(201);
}

async function login(base: string): Promise<string> {
  const challenge = await req(base, '/v1/auth/challenge', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ address: merchant.address }),
  });
  const signature = await merchant.signMessage(challenge.body.message as string);
  const res = await req(base, '/v1/auth/login', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ address: merchant.address, message: challenge.body.message, signature }),
  });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

/** Publishes a link with no on-chain pool — the merchant never registers anything. */
async function createLink(
  base: string,
  over?: {
    multiPay?: boolean;
    maxRedemptions?: number;
    orderPool?: string[];
    tokenAddress?: string;
    expiryDurationSecs?: number;
  },
): Promise<string> {
  const token = await login(base);
  const res = await req(base, '/v1/links', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, ...jsonHeaders },
    body: JSON.stringify({
      shopName: 'Test Shop',
      tokenAddress: over?.tokenAddress ?? USDT,
      amount: '25000000',
      amountDisplay: '25',
      symbol: 'USDT',
      expiryDurationSecs: over?.expiryDurationSecs ?? 0,
      multiPay: over?.multiPay ?? false,
      maxRedemptions: over?.maxRedemptions ?? 1,
      orderPool: over?.orderPool ?? [],
    }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.slug as string;
}

function claim(base: string, slug: string, payer: Wallet) {
  return req(base, `/v1/links/${slug}/claim`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ payerAddress: payer.address }),
  });
}

describe('signed claim: lazy order creation, customer-paid gas', () => {
  it('mints an order per claim and authorizes it to that payer', async () => {
    const { base, signer } = await startApp();
    await onboard(base);
    const slug = await createLink(base);
    const payer = randomPayer();

    const res = await claim(base, slug, payer);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.amount).toBe('25000000');
    expect(res.body.token).toBe(USDT);
    expect(res.body.merchant).toBe(merchant.address);

    const auth = res.body.authorization as SignedAuthorizationJson;
    expect(auth.orderId).toBe(res.body.orderId);
    expect(auth.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(signer.calls).toHaveLength(1);
    // Addresses are compared case-insensitively: EIP-712 hashes them as 20-byte values, so the
    // store's canonical lowercase form digests identically to the checksummed one.
    expect(auth.amount).toBe('25000000');
    expect(auth.feeBps).toBe(FEE_BPS);
    expect(auth.token.toLowerCase()).toBe(USDT);
    expect(auth.feeRecipient.toLowerCase()).toBe(FEE_RECIPIENT.toLowerCase());
    expect(auth.merchant.toLowerCase()).toBe(merchant.address.toLowerCase());
    expect(auth.expectedPayer.toLowerCase()).toBe(payer.address.toLowerCase());
    expect(BigInt(auth.amount)).toBe(25_000_000n);
    // Nothing needs to exist on-chain before this point: the authorization IS the permission, and
    // the customer's own transaction will create and settle the order. No link is non-expiring.
    expect(auth.expiry).toBe(0);
  });

  it('never mints the same orderId twice', async () => {
    const { base } = await startApp();
    await onboard(base);
    const slug = await createLink(base, { multiPay: true, maxRedemptions: 5 });
    const ids = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const res = await claim(base, slug, randomPayer());
      expect(res.status).toBe(200);
      ids.add(res.body.orderId as string);
    }
    expect(ids.size).toBe(5);
    for (const id of ids) expect(id).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('caps a multi-pay link at maxRedemptions and reports exhaustion', async () => {
    const { base, store } = await startApp();
    await onboard(base);
    const slug = await createLink(base, { multiPay: true, maxRedemptions: 2 });

    for (let i = 0; i < 2; i += 1) {
      const res = await claim(base, slug, randomPayer());
      expect(res.status).toBe(200);
    }
    const third = await claim(base, slug, randomPayer());
    expect(third.status).toBe(503);
    expect(String(third.body.error)).toMatch(/no remaining payments/i);
    expect((await store.listClaims(slug)) ?? []).toHaveLength(2);
  });

  it('treats maxRedemptions 0 as unlimited', async () => {
    const { base } = await startApp();
    await onboard(base);
    const slug = await createLink(base, { multiPay: true, maxRedemptions: 0 });
    for (let i = 0; i < 12; i += 1) {
      const res = await claim(base, slug, randomPayer());
      expect(res.status).toBe(200);
    }
  });

  it('serves a single-pay link exactly once', async () => {
    const { base } = await startApp();
    await onboard(base);
    const slug = await createLink(base, { multiPay: false, maxRedemptions: 1 });

    expect((await claim(base, slug, randomPayer())).status).toBe(200);
    expect((await claim(base, slug, randomPayer())).status).toBe(503);
  });

  it('expires the authorization at the link deadline, not at claim time + window', async () => {
    const { base, store } = await startApp();
    await onboard(base);
    const slug = await createLink(base, { expiryDurationSecs: 900 });
    const link = await store.getLink(slug);
    const before = Math.floor(Date.now() / 1000);

    const res = await claim(base, slug, randomPayer());
    const auth = res.body.authorization as SignedAuthorizationJson;
    // Exactly the link's own deadline: an authorization must never outlive the window the
    // merchant advertised, or the link would stay payable indefinitely.
    expect(auth.expiry).toBe(Math.floor((link?.createdAt ?? 0) / 1000) + 900);
    expect(auth.expiry).toBeGreaterThan(before);
  });

  it('refuses to authorize payment on an expired link', async () => {
    const { base, store, signer } = await startApp();
    await onboard(base);
    const slug = await createLink(base, { expiryDurationSecs: 60 });

    // Age the link past its window. This is the regression guard: with lazily created orders the
    // backend is the only thing that knows the link is dead, so without this check it would keep
    // minting perfectly valid authorizations for a dead link forever.
    const link = await store.getLink(slug);
    link!.createdAt = Date.now() - 10 * 60 * 1000;
    await store.upsertLink(link!);

    const res = await claim(base, slug, randomPayer());
    expect(res.status).toBe(410);
    expect(String(res.body.error)).toMatch(/expired/i);
    expect(signer.calls).toHaveLength(0);
  });

  it('refuses to sign an authorization too short-lived to be usable', async () => {
    const { base, store, signer } = await startApp();
    await onboard(base);
    const slug = await createLink(base, { expiryDurationSecs: 900 });
    const link = await store.getLink(slug);
    // 30 seconds of life left — signing now would hand the customer an authorization that
    // expires before they finish their wallet prompt.
    link!.createdAt = Date.now() - (900 - 30) * 1000;
    await store.upsertLink(link!);

    const res = await claim(base, slug, randomPayer());
    expect(res.status).toBe(410);
    expect(signer.calls).toHaveLength(0);
  });

  it('never expires a link the merchant created without a window', async () => {
    const { base } = await startApp();
    await onboard(base);
    const slug = await createLink(base, { expiryDurationSecs: 0 });
    const res = await claim(base, slug, randomPayer());
    expect(res.status).toBe(200);
    expect((res.body.authorization as SignedAuthorizationJson).expiry).toBe(0);
  });

  it('binds a retry to the same order and re-authorizes it for the same wallet', async () => {
    const { base, signer } = await startApp();
    await onboard(base);
    const slug = await createLink(base, { multiPay: true, maxRedemptions: 3 });
    const payer = randomPayer();

    const first = await claim(base, slug, payer);
    expect(first.status).toBe(200);
    const orderId = first.body.orderId;

    const retry = await claim(base, slug, payer);
    expect(retry.status).toBe(429);
    expect(retry.body.orderId).toBe(orderId);
    expect(Number(retry.body.retryAfterSecs)).toBeGreaterThan(0);
    const auth = retry.body.authorization as SignedAuthorizationJson;
    expect(auth.orderId).toBe(orderId);
    expect(auth.expectedPayer.toLowerCase()).toBe(payer.address.toLowerCase());
    expect(signer.calls).toHaveLength(2);
  });

  it('re-signs a stale claim for the wallet that actually shows up', async () => {
    const { base, store, signer } = await startApp();
    await onboard(base);
    const slug = await createLink(base, { multiPay: true, maxRedemptions: 1 });
    const first = randomPayer();

    const abandoned = await claim(base, slug, first);
    expect(abandoned.status).toBe(200);
    const orderId = abandoned.body.orderId as string;

    // Age the abandoned claim past the 15-minute stale window and re-persist it.
    const hourAgo = Date.now() - 60 * 60 * 1000;
    for (const c of (await store.listClaims(slug)) ?? []) c.claimedAt = hourAgo;
    await store.upsertClaim({
      slug,
      orderId,
      payerAddress: first.address.toLowerCase(),
      claimedAt: hourAgo,
      settled: false,
    });

    const second = randomPayer();
    const res = await claim(base, slug, second);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.orderId).toBe(orderId);
    const auth = res.body.authorization as SignedAuthorizationJson;
    expect(auth.expectedPayer.toLowerCase()).toBe(second.address.toLowerCase());
    expect(signer.calls.at(-1)!.expectedPayer.toLowerCase()).toBe(second.address.toLowerCase());
    // Recycling must not consume a second redemption — the cap counts orders, not attempts.
    expect((await store.listClaims(slug)) ?? []).toHaveLength(1);
  });

  it('drains a legacy pre-registered pool before minting anything', async () => {
    const { base, signer } = await startApp();
    await onboard(base);
    const legacyOrder = '0x' + 'b1'.repeat(32);
    const slug = await createLink(base, { multiPay: true, maxRedemptions: 3, orderPool: [legacyOrder] });

    const res = await claim(base, slug, randomPayer());
    expect(res.status).toBe(200);
    // The merchant already paid gas for this id — it must be used before a new one is minted.
    expect(res.body.orderId).toBe(legacyOrder);
    expect(signer.calls).toHaveLength(1);
    expect(signer.calls[0]!.orderId).toBe(legacyOrder);

    const next = await claim(base, slug, randomPayer());
    expect(next.status).toBe(200);
    expect(next.body.orderId).not.toBe(legacyOrder);
    expect(next.body.orderId).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('still serves legacy links when no signer is configured', async () => {
    const { base, signer } = await startApp({ signerEnabled: false });
    await onboard(base);
    const legacyOrder = '0x' + 'c2'.repeat(32);
    const slug = await createLink(base, { orderPool: [legacyOrder] });

    const res = await claim(base, slug, randomPayer());
    expect(res.status).toBe(200);
    expect(res.body.orderId).toBe(legacyOrder);
    expect(res.body.authorization).toBeUndefined();
    expect(signer.calls).toHaveLength(0);
  });

  it('refuses to create a pool-less link when no signer is configured', async () => {
    const { base } = await startApp({ signerEnabled: false });
    await onboard(base);
    const token = await login(base);
    const res = await req(base, '/v1/links', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, ...jsonHeaders },
      body: JSON.stringify({
        shopName: 'No Pool',
        tokenAddress: USDT,
        amount: '1',
        amountDisplay: '1',
        symbol: 'USDT',
        multiPay: false,
        orderPool: [],
      }),
    });
    expect(res.status).toBe(503);
  });

  it('rejects a malformed payer address before signing anything', async () => {
    const { base, signer } = await startApp();
    await onboard(base);
    const slug = await createLink(base);
    const res = await req(base, `/v1/links/${slug}/claim`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ payerAddress: '0x1234' }),
    });
    expect(res.status).toBe(400);
    expect(signer.calls).toHaveLength(0);
  });

  it('rejects a claim against an unknown link', async () => {
    const { base, signer } = await startApp();
    const res = await claim(base, 'does-not-exist', randomPayer());
    expect(res.status).toBe(404);
    expect(signer.calls).toHaveLength(0);
  });
});
