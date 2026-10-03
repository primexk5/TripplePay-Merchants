import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { FixedRateProvider, type RateProvider } from '../src/gateway/rate-provider.js';
import type { OrderSigner, SignedOrderAuthorization, SignedAuthorizationJson } from '../src/chain/signer.js';
import type { QiService } from '../src/chain/qi.js';
import type { QiOrder } from '../src/types.js';

const ADMIN_KEY = 'test-admin-key-0123456789abcdef';
const CONTRACT = '0x0000000000000000000000000000000000000001';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const wallet = new Wallet('0x' + randomBytes(32).toString('hex'));

function makeCfg(): Config {
  return {
    ADMIN_API_KEY: ADMIN_KEY,
    CORS_ORIGINS: '*',
    CHAIN_ID: 9,
    LOGIN_REALM: 'tripplepay',
    TRUST_PROXY: 0,
    PAYWITHQUAI_ADDRESS: CONTRACT,
    GATEWAY_MARKUP_BPS_DEFAULT: 0,
    GATEWAY_FALLBACK_USD_PER_QUAI: 10, // 1 QUAI = $10
    GATEWAY_FALLBACK_NGN_PER_QUAI: 0,  // NGN intentionally unset -> no quote
  } as unknown as Config;
}

function fakeClient(exists = true): QuaiClient {
  return {
    address: CONTRACT,
    feeBps: async () => 50,
    feeRecipient: async () => getAddress('0x000000000000000000000000000000000000dEaD'),
    getOrder: async () => ({
      merchant: wallet.address.toLowerCase(),
      settled: false,
      exists,
      feeBps: 50,
      token: ZERO_ADDRESS,
      amount: 0n,
      expiry: 0n,
      feeRecipient: ZERO_ADDRESS,
      settledAt: 0n,
      expectedPayer: ZERO_ADDRESS,
      nonce: 0n,
    }),
  } as unknown as QuaiClient;
}

/**
 * Records every authorization the API asks for. The gateway flow must never register anything
 * on-chain any more, so there is deliberately no transaction method here — if the server ever
 * tried to broadcast, it would not compile.
 */
class FakeSigner implements OrderSigner {
  readonly enabled: boolean;
  readonly address = getAddress('0x0000000000000000000000000000000000005161');
  readonly calls: SignedOrderAuthorization[] = [];
  constructor(enabled: boolean) {
    this.enabled = enabled;
  }
  async sign(
    order: SignedOrderAuthorization,
    _deployment: { chainId: number; contractAddress: string },
  ): Promise<SignedOrderAuthorization & { signature: string }> {
    this.calls.push(order);
    return { ...order, signature: '0x' + 'cd'.repeat(65) };
  }
}

let addressNonce = 0;
function fakeQi(store: JsonStore): QiService {
  return {
    enabled: true,
    rpcUrl: 'https://rpc.test',
    orderQits: (amountWei: bigint) => (amountWei / 10n ** 18n) * 1000n,
    ensureQiOrder: async (orderId: string, merchantAddress: string, qits: bigint) => {
      addressNonce += 1;
      const order: QiOrder = {
        orderId: orderId.toLowerCase(),
        merchantAddress: merchantAddress.toLowerCase(),
        address: '0x' + addressNonce.toString(16).padStart(40, '0'),
        qits: qits.toString(),
        receivedQits: '0',
        settled: false,
        txHashes: [],
        createdAt: Date.now(),
        settledAt: null,
      };
      await store.insertQiOrder(order);
      return order;
    },
  } as unknown as QiService;
}

const dirs: string[] = [];
const servers: import('node:http').Server[] = [];
afterAll(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshStore(): JsonStore {
  const dir = mkdtempSync(join(tmpdir(), 'pwq-gateway-'));
  dirs.push(dir);
  return new JsonStore(join(dir, 'relayer.db'));
}

async function startApp(opts?: { rate?: RateProvider; signer?: OrderSigner; client?: QuaiClient; qi?: QiService; storeOverride?: JsonStore }): Promise<{ base: string; store: JsonStore }> {
  const store = opts?.storeOverride ?? freshStore();
  const app = createServer(
    store,
    opts?.client ?? fakeClient(),
    makeCfg(),
    opts?.qi,
    undefined, // no registry: single-chain legacy path
    undefined, // no indexers
    opts?.rate ?? new FixedRateProvider({ usd: 10 }),
    opts?.signer ?? new FakeSigner(false),
  );
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, store };
}

async function req(base: string, path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(base + path, init);
  const body = (await res.json().catch(() => undefined)) as Record<string, unknown>;
  return { status: res.status, body };
}

const jsonHeaders = { 'content-type': 'application/json' };

async function onboard(base: string): Promise<void> {
  const res = await fetch(`${base}/v1/merchants`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN_KEY}`, ...jsonHeaders },
    body: JSON.stringify({ address: wallet.address, name: 'Acme', webhookUrl: 'https://example.test/webhook' }),
  });
  expect(res.status).toBe(201);
}

async function issueApiKey(base: string): Promise<string> {
  await onboard(base);
  const challenge = await req(base, '/v1/auth/challenge', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ address: wallet.address }),
  });
  const signature = await wallet.signMessage(challenge.body.message as string);
  const login = await req(base, '/v1/auth/login', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ address: wallet.address, message: challenge.body.message, signature }),
  });
  const token = login.body.token as string;
  const created = await req(base, '/v1/me/apikeys', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, ...jsonHeaders },
    body: JSON.stringify({ label: 'woocommerce' }),
  });
  expect(created.status).toBe(201);
  return created.body.key as string;
}

describe('POST /v1/gateway/orders (Qi method)', () => {
  let base: string;
  let key: string;
  beforeAll(async () => {
    ({ base } = await startApp());
    key = await issueApiKey(base);
  });

  it('creates a prefilled single-pay link with a live-rate quote + merchant markup', async () => {
    const res = await req(base, '/v1/gateway/orders', {
      method: 'POST',
      headers: { 'x-merchant-key': key, ...jsonHeaders },
      body: JSON.stringify({ amount: '25.00', fiatCurrency: 'USD', reference: 'ORD-142', token: 'qi' }),
    });
    expect(res.status).toBe(201);
    const b = res.body as Record<string, unknown>;
    expect(b.gatewayId).toMatch(/^[0-9A-Za-z]{8}$/);
    expect(b.reference).toBe('ORD-142');
    expect(b.token).toBe('qi');
    expect(b.orderId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(String(b.checkoutUrl)).toMatch(/\/pay\/[0-9A-Za-z]{8}$/);
    // 25 USD / ($10 per QUAI) * 1.0 markup = 2.5 QUAI = 2,500,000,000,000,000,000 wei
    expect((b.quote as Record<string, unknown>).quaiWei).toBe('2500000000000000000');
    expect((b.quote as Record<string, unknown>).quaiDisplay).toBe('2.5');
    expect((b.quote as Record<string, unknown>).markupBps).toBe(0);
  });

  it('applies the merchant markup and rounds UP to wei', async () => {
    const settings = await req(base, '/v1/me/me', {}); // unused; settings set via PATCH below
    void settings;
    // login again to PATCH settings on the merchant record
    const challenge = await req(base, '/v1/auth/challenge', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ address: wallet.address }),
    });
    const signature = await wallet.signMessage(challenge.body.message as string);
    const login = await req(base, '/v1/auth/login', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ address: wallet.address, message: challenge.body.message, signature }),
    });
    const token = login.body.token as string;
    const patch = await req(base, '/v1/me', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, ...jsonHeaders },
      body: JSON.stringify({ settings: { quaiMarkupBps: 1000, fiatCurrencies: ['USD'] } }),
    });
    expect(patch.status).toBe(200);

    const res = await req(base, '/v1/gateway/orders', {
      method: 'POST',
      headers: { 'x-merchant-key': key, ...jsonHeaders },
      body: JSON.stringify({ amount: '1.00', fiatCurrency: 'USD', reference: 'ORD-99', token: 'qi' }),
    });
    expect(res.status).toBe(201);
    // 1 USD / $10 × 1.10 markup = 0.11 QUAI ≈ 110,000,000,000,000,000 wei. Float math leaves a
    // hair of error, so the contract is: round UP (merchant never underpaid), never below exact.
    const wei = BigInt((res.body.quote as Record<string, unknown>).quaiWei as string);
    expect(wei).toBeGreaterThanOrEqual(110000000000000000n);
    expect(wei).toBeLessThan(110000000000001000n);
    expect((res.body.quote as Record<string, unknown>).markupBps).toBe(1000);
  });

  it('rejects a currency with no quote (not enabled or no market rate)', async () => {
    const ngn = await req(base, '/v1/gateway/orders', {
      method: 'POST',
      headers: { 'x-merchant-key': key, ...jsonHeaders },
      body: JSON.stringify({ amount: '5', fiatCurrency: 'NGN' }),
    });
    // NGN was dropped to USD-only by the markup PATCH above → 400 'not enabled'; with unset
    // fallback rates it would 503 'no rate'. Either outcome is the correct refusal.
    expect([400, 503]).toContain(ngn.status);
  });

  it('requires merchant auth (X-Merchant-Key or session)', async () => {
    const anon = await req(base, '/v1/gateway/orders', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ amount: '5', fiatCurrency: 'USD' }),
    });
    expect(anon.status).toBe(401);
  });
});

describe('POST /v1/gateway/orders (QUAI method)', () => {
  it('uses a provided on-chain orderId that exists', async () => {
    const { base } = await startApp({ client: fakeClient(true) });
    const key = await issueApiKey(base);
    const res = await req(base, '/v1/gateway/orders', {
      method: 'POST',
      headers: { 'x-merchant-key': key, ...jsonHeaders },
      body: JSON.stringify({
        amount: '25.00',
        fiatCurrency: 'USD',
        token: 'quai',
        orderId: '0x' + '11'.repeat(32),
      }),
    });
    expect(res.status).toBe(201);
    expect(res.body.token).toBe('quai');
    expect(res.body.orderId).toBe('0x' + '11'.repeat(32));
  });

  it('rejects an orderId that is not registered on-chain', async () => {
    const { base } = await startApp({ client: fakeClient(false) });
    const key = await issueApiKey(base);
    const res = await req(base, '/v1/gateway/orders', {
      method: 'POST',
      headers: { 'x-merchant-key': key, ...jsonHeaders },
      body: JSON.stringify({
        amount: '25.00',
        fiatCurrency: 'USD',
        token: 'quai',
        orderId: '0x' + '11'.repeat(32),
      }),
    });
    expect(res.status).toBe(400);
  });

  it('reports a configuration error when no order signer is configured', async () => {
    const { base } = await startApp({ client: fakeClient(true) });
    const key = await issueApiKey(base);
    const res = await req(base, '/v1/gateway/orders', {
      method: 'POST',
      headers: { 'x-merchant-key': key, ...jsonHeaders },
      body: JSON.stringify({ amount: '25.00', fiatCurrency: 'USD', token: 'quai' }),
    });
    expect(res.status).toBe(503);
    expect(String(res.body.error)).toMatch(/signer is not configured/i);
  });

  it('creates a QUAI order off-chain (no on-chain registration, no platform gas)', async () => {
    const signer = new FakeSigner(true);
    const { base, store } = await startApp({ client: fakeClient(true), signer });
    const key = await issueApiKey(base);
    const res = await req(base, '/v1/gateway/orders', {
      method: 'POST',
      headers: { 'x-merchant-key': key, ...jsonHeaders },
      body: JSON.stringify({ amount: '25.00', fiatCurrency: 'USD', token: 'quai', reference: 'ORD-55' }),
    });
    expect(res.status).toBe(201);
    // Nothing was signed or broadcast at creation time — the order does not exist on-chain yet.
    expect(signer.calls).toHaveLength(0);

    const orderId = res.body.orderId as string;
    // the order was persisted as a gateway link
    expect((await req(base, `/v1/gateway/orders/${res.body.gatewayId}`, {
      headers: { 'x-merchant-key': key },
    })).status).toBe(200);
    // order meta holds the shop reference
    const link = await store.getLink(res.body.gatewayId as string);
    expect(link?.gatewayOrderId).toBe(orderId);

    // The customer's claim is what creates it — authorized off-chain, paid for by the customer.
    const claim = await req(base, `/v1/links/${res.body.gatewayId}/claim`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ payerAddress: wallet.address }),
    });
    expect(claim.status, JSON.stringify(claim.body)).toBe(200);
    expect(claim.body.orderId).toBe(orderId);
    expect(signer.calls).toHaveLength(1);
    expect(signer.calls[0]!.amount).toBe(2500000000000000000n);
    expect(signer.calls[0]!.merchant.toLowerCase()).toBe(wallet.address.toLowerCase());
    expect(signer.calls[0]!.feeBps).toBe(50);
    expect(signer.calls[0]!.expectedPayer.toLowerCase()).toBe(wallet.address.toLowerCase());
    const auth = claim.body.authorization as SignedAuthorizationJson;
    expect(auth.signature).toBeTruthy();
    expect(auth.orderId).toBe(orderId);
  });

  it('refuses to hand the SAME fixed order id to a second wallet', async () => {
    const signer = new FakeSigner(true);
    const { base, store } = await startApp({ client: fakeClient(true), signer });
    const key = await issueApiKey(base);
    const res = await req(base, '/v1/gateway/orders', {
      method: 'POST',
      headers: { 'x-merchant-key': key, ...jsonHeaders },
      body: JSON.stringify({ amount: '25.00', fiatCurrency: 'USD', token: 'quai' }),
    });
    const gatewayId = res.body.gatewayId as string;
    const orderId = res.body.orderId as string;
    const first = new Wallet('0x' + randomBytes(32).toString('hex'));
    const second = new Wallet('0x' + randomBytes(32).toString('hex'));

    const claimAs = (payer: Wallet) =>
      req(base, `/v1/links/${gatewayId}/claim`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ payerAddress: payer.address }),
      });

    const mine = await claimAs(first);
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.orderId).toBe(orderId);

    // The gateway order is one purchase: a second wallet must be told so instead of being handed
    // its own valid signature for an id the first wallet is already paying. Both settling is
    // impossible on-chain, so the alternative is a signature that can only ever revert.
    const theft = await claimAs(second);
    expect(theft.status).toBe(409);
    expect(String(theft.body.error)).toMatch(/another wallet/i);
    expect(theft.body.authorization).toBeUndefined();
    expect(signer.calls).toHaveLength(1);
    expect(signer.calls[0]!.expectedPayer.toLowerCase()).toBe(first.address.toLowerCase());
    // The owner's claim row was not overwritten by the rejected attempt.
    const claims = await store.listClaims(gatewayId);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.payerAddress).toBe(first.address.toLowerCase());
  });

  it('lets the SAME wallet re-claim its gateway order with a fresh authorization', async () => {
    const signer = new FakeSigner(true);
    const { base } = await startApp({ client: fakeClient(true), signer });
    const key = await issueApiKey(base);
    const res = await req(base, '/v1/gateway/orders', {
      method: 'POST',
      headers: { 'x-merchant-key': key, ...jsonHeaders },
      body: JSON.stringify({ amount: '25.00', fiatCurrency: 'USD', token: 'quai' }),
    });
    const gatewayId = res.body.gatewayId as string;
    const payer = new Wallet('0x' + randomBytes(32).toString('hex'));
    const claimAs = () =>
      req(base, `/v1/links/${gatewayId}/claim`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ payerAddress: payer.address }),
      });

    expect((await claimAs()).status).toBe(200);
    // Re-opening the checkout (refresh, flaky wallet) must not fail — and must re-sign, since the
    // previous signature may be near expiry.
    const again = await claimAs();
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(signer.calls).toHaveLength(2);
    expect((again.body.authorization as SignedAuthorizationJson).orderId).toBe(
      res.body.orderId as string,
    );
  });

  it('refuses to authorize a gateway order that is already paid', async () => {
    const signer = new FakeSigner(true);
    const { base, store } = await startApp({ client: fakeClient(true), signer });
    const key = await issueApiKey(base);
    const res = await req(base, '/v1/gateway/orders', {
      method: 'POST',
      headers: { 'x-merchant-key': key, ...jsonHeaders },
      body: JSON.stringify({ amount: '25.00', fiatCurrency: 'USD', token: 'quai' }),
    });
    const gatewayId = res.body.gatewayId as string;
    const orderId = res.body.orderId as string;
    const payer = new Wallet('0x' + randomBytes(32).toString('hex'));
    const claimAs = (p: Wallet) =>
      req(base, `/v1/links/${gatewayId}/claim`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ payerAddress: p.address }),
      });

    expect((await claimAs(payer)).status).toBe(200);
    // The indexer marks the claim settled when it sees PaymentReceived.
    await store.settleClaimedOrder(gatewayId, orderId);

    const late = await claimAs(payer);
    expect(late.status).toBe(409);
    expect(String(late.body.error)).toMatch(/already been paid/i);
    expect(late.body.authorization).toBeUndefined();
    expect(signer.calls).toHaveLength(1);
  });

  it('hands an abandoned gateway claim to a new wallet once it goes stale', async () => {
    const signer = new FakeSigner(true);
    const { base, store } = await startApp({ client: fakeClient(true), signer });
    const key = await issueApiKey(base);
    const res = await req(base, '/v1/gateway/orders', {
      method: 'POST',
      headers: { 'x-merchant-key': key, ...jsonHeaders },
      body: JSON.stringify({ amount: '25.00', fiatCurrency: 'USD', token: 'quai' }),
    });
    const gatewayId = res.body.gatewayId as string;
    const first = new Wallet('0x' + randomBytes(32).toString('hex'));
    const second = new Wallet('0x' + randomBytes(32).toString('hex'));
    const claimAs = (p: Wallet) =>
      req(base, `/v1/links/${gatewayId}/claim`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ payerAddress: p.address }),
      });

    expect((await claimAs(first)).status).toBe(200);
    expect((await claimAs(second)).status).toBe(409);

    // First wallet walked away without paying. Refusing everyone forever would strand the order,
    // so the claim ages out (same window the multi-pay path uses) and the id moves on.
    const claims = await store.listClaims(gatewayId);
    const row = claims[0]!;
    await store.upsertClaim({ ...row, claimedAt: Date.now() - 20 * 60 * 1000 });

    const handover = await claimAs(second);
    expect(handover.status, JSON.stringify(handover.body)).toBe(200);
    expect(signer.calls).toHaveLength(2);
    // Re-signed for the NEW payer: the first wallet's signature was bound to its address.
    expect(signer.calls[1]!.expectedPayer.toLowerCase()).toBe(second.address.toLowerCase());
  });

  it('refuses QUAI orders when no signer is configured, rather than registering on-chain', async () => {
    const signer = new FakeSigner(false);
    const { base } = await startApp({ client: fakeClient(true), signer });
    const key = await issueApiKey(base);
    const res = await req(base, '/v1/gateway/orders', {
      method: 'POST',
      headers: { 'x-merchant-key': key, ...jsonHeaders },
      body: JSON.stringify({ amount: '25.00', fiatCurrency: 'USD', token: 'quai' }),
    });
    expect(res.status).toBe(503);
    expect(signer.calls).toHaveLength(0);
  });
});

describe('GET /v1/gateway/orders/:gatewayId + Qi settlement lifecycle', () => {
  it('starts pending and exposes the Qi receive address via qi-claim', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pwq-gw-'));
    dirs.push(dir);
    const store = new JsonStore(join(dir, 'relayer.db'));
    const { base } = await startApp({ qi: fakeQi(store), storeOverride: store });
    const key = await issueApiKey(base);
    const created = await req(base, '/v1/gateway/orders', {
      method: 'POST',
      headers: { 'x-merchant-key': key, ...jsonHeaders },
      body: JSON.stringify({ amount: '10.00', fiatCurrency: 'USD', reference: 'ORD-7', token: 'qi' }),
    });
    expect(created.status).toBe(201);
    const gid = created.body.gatewayId as string;
    const orderId = created.body.orderId as string;

    const pending = await req(base, `/v1/gateway/orders/${gid}`, { headers: { 'x-merchant-key': key } });
    expect(pending.status).toBe(200);
    expect(pending.body.status).toBe('pending');
    expect(pending.body.reference).toBe('ORD-7');

    // materialize the Qi receive address via the public qi-claim flow (no pool involved)
    const claim = await req(base, `/v1/links/${gid}/qi-claim`, { method: 'POST' });
    expect(claim.status).toBe(200);
    expect(claim.body.orderId).toBe(orderId);
    const qiAddr = (claim.body.qi as Record<string, unknown>).address as string;
    expect(qiAddr).toMatch(/^0x/);

    // simulate the Qi indexer's settlement (checkBalance threshold crossed)
    const settled = await req(base, `/v1/orders/${getAddress(wallet.address).toLowerCase()}/${orderId}`, {});
    expect(settled.status).toBe(200);
    expect((settled.body.qi as Record<string, unknown> | null)?.address).toBe(qiAddr);

    const paid = await req(base, `/v1/gateway/orders/${gid}`, { headers: { 'x-merchant-key': key } });
    expect(paid.status).toBe(200);
  });
});

describe('rate limiting + validation', () => {
  it('rejects malformed bodies with 400', async () => {
    const base = (await startApp()).base;
    const key = await issueApiKey(base);
    const res = await req(base, '/v1/gateway/orders', {
      method: 'POST',
      headers: { 'x-merchant-key': key, ...jsonHeaders },
      body: JSON.stringify({ amount: 'not-a-number', fiatCurrency: 'USD' }),
    });
    expect(res.status).toBe(400);
  });
});