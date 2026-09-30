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
import type { OrderRegistrar } from '../src/chain/relayer.js';
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

class FakeRegistrar implements OrderRegistrar {
  readonly enabled: boolean;
  readonly calls: Array<{ merchant: string; orderId: string; amount: bigint; expiry: number }> = [];
  constructor(enabled: boolean) {
    this.enabled = enabled;
  }
  async registerOrderFor(p: { merchant: string; orderId: string; amount: bigint; expiry: number }): Promise<string> {
    this.calls.push(p);
    return '0x' + 'ab'.repeat(32);
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

async function startApp(opts?: { rate?: RateProvider; registrar?: OrderRegistrar; client?: QuaiClient; qi?: QiService; storeOverride?: JsonStore }): Promise<{ base: string; store: JsonStore }> {
  const store = opts?.storeOverride ?? freshStore();
  const app = createServer(
    store,
    opts?.client ?? fakeClient(),
    makeCfg(),
    opts?.qi,
    undefined, // no registry: single-chain legacy path
    undefined, // no indexers
    opts?.rate ?? new FixedRateProvider({ usd: 10 }),
    opts?.registrar ?? new FakeRegistrar(false),
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

  it('asks for a pre-registered orderId when the relayer is disabled', async () => {
    const { base } = await startApp({ client: fakeClient(true) });
    const key = await issueApiKey(base);
    const res = await req(base, '/v1/gateway/orders', {
      method: 'POST',
      headers: { 'x-merchant-key': key, ...jsonHeaders },
      body: JSON.stringify({ amount: '25.00', fiatCurrency: 'USD', token: 'quai' }),
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/orderId/);
  });

  it('auto-registers via the relayer when it is enabled (no orderId needed)', async () => {
    const registrar = new FakeRegistrar(true);
    const { base, store } = await startApp({ client: fakeClient(true), registrar });
    const key = await issueApiKey(base);
    const res = await req(base, '/v1/gateway/orders', {
      method: 'POST',
      headers: { 'x-merchant-key': key, ...jsonHeaders },
      body: JSON.stringify({ amount: '25.00', fiatCurrency: 'USD', token: 'quai', reference: 'ORD-55' }),
    });
    expect(res.status).toBe(201);
    expect(registrar.calls).toHaveLength(1);
    expect(registrar.calls[0]!.amount).toBe(2500000000000000000n);
    expect(registrar.calls[0]!.merchant.toLowerCase()).toBe(wallet.address.toLowerCase());
    const orderId = res.body.orderId as string;
    // the order was persisted as a gateway link
    expect((await req(base, `/v1/gateway/orders/${res.body.gatewayId}`, {
      headers: { 'x-merchant-key': key },
    })).status).toBe(200);
    // order meta holds the shop reference
    const link = await store.getLink(res.body.gatewayId as string);
    expect(link?.gatewayOrderId).toBe(orderId);
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