import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { rmSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { createApp, SIGNATURE_HEADER } from '../src/index.js';
import { loadConfig, type Config } from '../src/config.js';
import { FileStore } from '../src/store/file.js';
import { CredentialResolver } from '../src/store/credentials.js';
import { sealSecret, openSecret, deriveKey } from '../src/crypto.js';
import { verifyGatewayWebhook } from '../src/gateway.js';

const dirs: string[] = [];
const servers: Array<{ close: () => void }> = [];
afterAll(() => {
  for (const s of servers) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'pwq-multi-'));
  dirs.push(d);
  return d;
}

const ENC_KEY = randomBytes(32).toString('base64');

function config(over: Partial<NodeJS.ProcessEnv> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    SHOPIFY_API_KEY: 'key',
    SHOPIFY_API_SECRET: 'secret',
    SHOPIFY_APP_URL: 'https://app.example.com',
    GATEWAY_BASE_URL: 'https://gateway.example.com',
    CONNECTOR_ENCRYPTION_KEY: ENC_KEY,
    STORE_PATH: tempDir(),
    LOG_PRETTY: 'false',
    ...over,
  } as NodeJS.ProcessEnv);
}

describe('credential sealing', () => {
  const master = deriveKey(ENC_KEY);

  it('round-trips a secret', () => {
    expect(openSecret(sealSecret('qmkey_abc', master), master)).toBe('qmkey_abc');
  });

  it('produces different ciphertext each time (random IV)', () => {
    expect(sealSecret('same', master)).not.toBe(sealSecret('same', master));
  });

  it('fails to open under a different key', () => {
    expect(openSecret(sealSecret('qmkey_abc', master), deriveKey('a-different-key'))).toBeUndefined();
  });

  it('detects tampering rather than decrypting to garbage', () => {
    const sealed = sealSecret('qmkey_abc', master).split('.');
    sealed[3] = Buffer.from('tampered-payload').toString('base64url');
    expect(openSecret(sealed.join('.'), master)).toBeUndefined();
  });

  it('returns undefined for missing or malformed values', () => {
    expect(openSecret(undefined, master)).toBeUndefined();
    expect(openSecret('', master)).toBeUndefined();
    expect(openSecret('not-a-sealed-value', master)).toBeUndefined();
    expect(openSecret('v1.a.b', master)).toBeUndefined();
  });

  it('accepts both hex and base64 256-bit keys', () => {
    const raw = randomBytes(32);
    expect(openSecret(sealSecret('x', deriveKey(raw.toString('hex'))), deriveKey(raw.toString('hex')))).toBe('x');
    expect(openSecret(sealSecret('x', deriveKey(raw.toString('base64url'))), deriveKey(raw.toString('base64url')))).toBe('x');
  });

  it('stretches an arbitrary passphrase to a usable key', () => {
    const k = deriveKey('correct horse battery staple');
    expect(k).toHaveLength(32);
    expect(deriveKey('correct horse battery staple')).toEqual(k);
  });
});

describe('per-store credential resolution', () => {
  let store: FileStore;
  let resolver: CredentialResolver;

  beforeEach(() => {
    store = new FileStore(tempDir());
    resolver = new CredentialResolver(store, config());
  });

  async function configure(shop: string, merchantKey: string, webhookSecret: string) {
    await store.putSettings({ shop, ...resolver.seal(merchantKey, webhookSecret), configuredAt: Date.now() });
  }

  it('returns each store its own credentials', async () => {
    await configure('a.myshopify.com', 'qmkey_A', 'whsec_A');
    await configure('b.myshopify.com', 'qmkey_B', 'whsec_B');
    expect((await resolver.resolve('a.myshopify.com'))?.merchantKey).toBe('qmkey_A');
    expect((await resolver.resolve('b.myshopify.com'))?.merchantKey).toBe('qmkey_B');
  });

  it('is case-insensitive about the shop domain', async () => {
    await configure('a.myshopify.com', 'qmkey_A', 'whsec_A');
    expect((await resolver.resolve('A.MyShopify.COM'))?.merchantKey).toBe('qmkey_A');
  });

  it('does not return one store’s credentials for another', async () => {
    await configure('a.myshopify.com', 'qmkey_A', 'whsec_A');
    expect(await resolver.resolve('b.myshopify.com')).toBeUndefined();
  });

  it('never writes the plaintext credential to disk', async () => {
    // A dedicated store, so we know exactly which directory to inspect (config() allocates its own).
    const dir = tempDir();
    const ownStore = new FileStore(dir);
    await ownStore.putSettings({ shop: 'a.myshopify.com', ...resolver.seal('qmkey_SECRET_VALUE', 'whsec_SECRET_VALUE'), configuredAt: Date.now() });
    const onDisk = readFileSync(join(dir, 'store.json'), 'utf8');
    expect(onDisk).not.toContain('qmkey_SECRET_VALUE');
    expect(onDisk).not.toContain('whsec_SECRET_VALUE');
    expect(onDisk).toContain('v1.'); // the sealed envelope is there
  });

  it('fails closed when the encryption key changes, rather than using the shared key', async () => {
    await configure('a.myshopify.com', 'qmkey_A', 'whsec_A');
    // Same store, connector restarted with a different CONNECTOR_ENCRYPTION_KEY.
    const afterRotation = new CredentialResolver(store, config({ CONNECTOR_ENCRYPTION_KEY: randomBytes(32).toString('base64') }));
    expect(await afterRotation.resolve('a.myshopify.com')).toBeUndefined();
  });

  it('falls back to the legacy shared pair when a store has none', async () => {
    const legacy = new CredentialResolver(store, config({ GATEWAY_MERCHANT_KEY: 'shared', GATEWAY_WEBHOOK_SECRET: 'whsec_shared' }));
    expect(await legacy.resolve('unconfigured.myshopify.com')).toEqual({ merchantKey: 'shared', webhookSecret: 'whsec_shared' });
  });

  it('prefers stored credentials over the shared pair', async () => {
    const legacy = new CredentialResolver(store, config({ GATEWAY_MERCHANT_KEY: 'shared', GATEWAY_WEBHOOK_SECRET: 'whsec_shared' }));
    await configure('a.myshopify.com', 'qmkey_OWN', 'whsec_OWN');
    expect((await legacy.resolve('a.myshopify.com'))?.merchantKey).toBe('qmkey_OWN');
  });

  it('resolves nothing when there are neither stored nor shared credentials', async () => {
    expect(await resolver.resolve('a.myshopify.com')).toBeUndefined();
  });

  it('gives each store a distinct gateway client bound to its own key', async () => {
    await configure('a.myshopify.com', 'qmkey_A', 'whsec_A');
    await configure('b.myshopify.com', 'qmkey_B', 'whsec_B');
    const a = await resolver.client('a.myshopify.com');
    const b = await resolver.client('b.myshopify.com');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
    expect(await resolver.client('c.myshopify.com')).toBeUndefined();
  });

  it('forgets credentials on clear', async () => {
    await configure('a.myshopify.com', 'qmkey_A', 'whsec_A');
    await store.clearSettings('a.myshopify.com');
    expect(await store.getSettings('a.myshopify.com')).toBeUndefined();
    expect(await resolver.resolve('a.myshopify.com')).toBeUndefined();
  });
});

describe('settings route', () => {
  async function listen(cfg: Config, store: FileStore) {
    const app = createApp(cfg, { store });
    const server = app.listen(0);
    servers.push(server);
    await new Promise<void>((r) => server.once('listening', () => r()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const form = (fields: Record<string, string>) => ({
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });

  it('refuses credentials for a store that never installed the app', async () => {
    const store = new FileStore(tempDir());
    const base = await listen(config(), store);
    const res = await fetch(`${base}/settings`, form({ shop: 'ghost.myshopify.com', merchantKey: 'qmkey_A', webhookSecret: 'whsec_A' }));
    expect(res.status).toBe(403);
    expect(await store.getSettings('ghost.myshopify.com')).toBeUndefined();
  });

  it('rejects a non-Shopify shop domain', async () => {
    const store = new FileStore(tempDir());
    const base = await listen(config(), store);
    const res = await fetch(`${base}/settings`, form({ shop: 'evil.example.com', merchantKey: 'k', webhookSecret: 's' }));
    expect(res.status).toBe(400);
  });

  it('requires both credentials', async () => {
    const store = new FileStore(tempDir());
    await store.setSession({ shop: 'a.myshopify.com', accessToken: 't', installedAt: 1, scopes: 'read_orders' });
    const base = await listen(config(), store);
    const res = await fetch(`${base}/settings`, form({ shop: 'a.myshopify.com', merchantKey: 'qmkey_A' }));
    expect(res.status).toBe(400);
  });

  it('saves credentials for an installed store, sealed', async () => {
    const store = new FileStore(tempDir());
    await store.setSession({ shop: 'a.myshopify.com', accessToken: 't', installedAt: 1, scopes: 'read_orders' });
    const cfg = config();
    const base = await listen(cfg, store);

    const res = await fetch(`${base}/settings`, form({ shop: 'a.myshopify.com', merchantKey: 'qmkey_A', webhookSecret: 'whsec_A' }));
    expect(res.status).toBe(200);

    const stored = await store.getSettings('a.myshopify.com');
    expect(stored?.merchantKeyCipher).toBeTruthy();
    expect(stored?.merchantKeyCipher).not.toContain('qmkey_A');
    // ...and the resolver reads back what was written.
    const resolved = await new CredentialResolver(store, cfg).resolve('a.myshopify.com');
    expect(resolved).toEqual({ merchantKey: 'qmkey_A', webhookSecret: 'whsec_A' });
  });

  it('does not leak the secret back in the response', async () => {
    const store = new FileStore(tempDir());
    await store.setSession({ shop: 'a.myshopify.com', accessToken: 't', installedAt: 1, scopes: 'read_orders' });
    const base = await listen(config(), store);
    const res = await fetch(`${base}/settings`, form({ shop: 'a.myshopify.com', merchantKey: 'qmkey_A', webhookSecret: 'whsec_A' }));
    const body = await res.text();
    expect(body).not.toContain('qmkey_A');
    expect(body).not.toContain('whsec_A');
  });

  it('overwrites credentials on re-save', async () => {
    const store = new FileStore(tempDir());
    await store.setSession({ shop: 'a.myshopify.com', accessToken: 't', installedAt: 1, scopes: 'read_orders' });
    const base = await listen(config(), store);
    await fetch(`${base}/settings`, form({ shop: 'a.myshopify.com', merchantKey: 'qmkey_OLD', webhookSecret: 'whsec_OLD' }));
    await fetch(`${base}/settings`, form({ shop: 'a.myshopify.com', merchantKey: 'qmkey_NEW', webhookSecret: 'whsec_NEW' }));
    expect((await new CredentialResolver(store, config()).resolve('a.myshopify.com'))?.merchantKey).toBe('qmkey_NEW');
  });
});

describe('gateway webhook verification is per-store', () => {
  const SECRET_A = 'whsec_A';
  const SECRET_B = 'whsec_B';

  function sign(secret: string, body: string, nowSec = Math.floor(Date.now() / 1000)): string {
    const sig = createHmac('sha256', secret).update(`${nowSec}.${body}`).digest('hex');
    return `t=${nowSec},v1=${sig}`;
  }

  const bodyFor = (orderId: number) =>
    JSON.stringify({ id: 'p1', type: 'payment.confirmed', created: Date.now(), data: { reference: String(orderId), token: 'qi', amount: '1' } });

  async function setup() {
    const store = new FileStore(tempDir());
    const cfg = config();
    const resolver = new CredentialResolver(store, cfg);
    await store.putSettings({ shop: 'a.myshopify.com', ...resolver.seal('qmkey_A', SECRET_A), configuredAt: Date.now() });
    await store.putSettings({ shop: 'b.myshopify.com', ...resolver.seal('qmkey_B', SECRET_B), configuredAt: Date.now() });
    const server = createApp(cfg, { store }).listen(0);
    servers.push(server);
    await new Promise<void>((r) => server.once('listening', () => r()));
    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, store };
  }

  /** Seed a pending payment directly; the gateway itself is not involved in this test. */
  async function seed(store: FileStore, gatewayId: string, shop: string, orderId: number) {
    await store.upsertPending({
      gatewayId, shop, orderId, checkoutUrl: 'https://pay.example/x', amount: '1', fiatCurrency: 'USD',
      asset: 'qi', status: 'awaiting', createdAt: Date.now(), expiresAt: Date.now() + 60_000,
    });
  }

  it('accepts a payload signed with the owning store’s secret', async () => {
    const { base, store } = await setup();
    await seed(store, 'g-a', 'a.myshopify.com', 101);
    const body = bodyFor(101);
    const res = await fetch(`${base}/webhooks/gateway/payment`, {
      method: 'POST', headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: sign(SECRET_A, body) }, body,
    });
    expect(res.status).toBe(204);
  });

  it('rejects store A’s secret on store B’s payment', async () => {
    const { base, store } = await setup();
    await seed(store, 'g-b', 'b.myshopify.com', 202);
    const body = bodyFor(202);
    const res = await fetch(`${base}/webhooks/gateway/payment`, {
      method: 'POST', headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: sign(SECRET_A, body) }, body,
    });
    expect(res.status).toBe(401);
    // And crucially the order was NOT marked paid.
    expect((await store.getPending('g-b'))?.status).toBe('awaiting');
  });

  it('rejects an unsigned/forged payload and leaves the order alone', async () => {
    const { base, store } = await setup();
    await seed(store, 'g-a', 'a.myshopify.com', 101);
    const body = bodyFor(101);
    const res = await fetch(`${base}/webhooks/gateway/payment`, {
      method: 'POST', headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: sign('whsec_WRONG', body) }, body,
    });
    expect(res.status).toBe(401);
    expect((await store.getPending('g-a'))?.status).toBe('awaiting');
  });

  it('refuses a body it cannot parse instead of throwing', async () => {
    const { base } = await setup();
    const res = await fetch(`${base}/webhooks/gateway/payment`, {
      method: 'POST', headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: sign(SECRET_A, 'not json') },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('refuses outright when no secret exists to verify against', async () => {
    // No per-store settings and no shared secret in the environment.
    const store = new FileStore(tempDir());
    const cfg = config();
    const server = createApp(cfg, { store }).listen(0);
    servers.push(server);
    await new Promise<void>((r) => server.once('listening', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const body = bodyFor(101);
    const res = await fetch(`${base}/webhooks/gateway/payment`, {
      method: 'POST', headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: sign('anything', body) }, body,
    });
    expect(res.status).toBe(401);
  });

  it('the verification helper still rejects a tampered body', () => {
    expect(verifyGatewayWebhook(SECRET_A, sign(SECRET_A, 'x'), 'tampered', Math.floor(Date.now() / 1000))).toBe(false);
  });
});
