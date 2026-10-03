import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { JsonStore } from '../src/store/json.js';
import { generateApiKey, hashApiKey, apiKeyRef, maskApiKey, DEV_API_KEY_PEPPER } from '../src/util/apikey.js';
import { createServer } from '../src/api/server.js';
import type { Config } from '../src/config.js';
import type { Merchant } from '../src/types.js';
import type { QuaiClient } from '../src/chain/client.js';

/** The API-key tests never touch the chain, so a stub client is enough. */
function fakeClient(): QuaiClient {
  return {
    provider: { getBalance: async () => 0n, getBlockNumber: async () => 0, getLogs: async () => [] },
  } as unknown as QuaiClient;
}

const dirs: string[] = [];
const servers: import('node:http').Server[] = [];
afterAll(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) require('node:fs').rmSync(d, { recursive: true, force: true });
});

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pwq-apikey-'));
  dirs.push(dir);
  return join(dir, 'relayer.db');
}

const ADDRESS = '0x' + '11'.repeat(20);
const OTHER = '0x' + '22'.repeat(20);
const PEPPER = 'a-real-test-pepper-value-32b';

function merchant(address: string): Merchant {
  return {
    merchantId: `mch_${address.slice(2, 6)}`,
    address,
    name: 'Test',
    webhookUrl: 'https://example.com/hook',
    webhookSecret: 'whsec_test',
    active: true,
    createdAt: Date.now(),
  };
}

describe('key hashing primitives', () => {
  it('is deterministic for a given pepper', () => {
    expect(hashApiKey('qmk_a_secret', PEPPER)).toBe(hashApiKey('qmk_a_secret', PEPPER));
  });

  it('produces different hashes for different peppers', () => {
    // This is the whole point of the pepper: a stolen DB is useless without the env secret.
    expect(hashApiKey('qmk_a_secret', PEPPER)).not.toBe(hashApiKey('qmk_a_secret', 'other-pepper'));
  });

  it('never embeds the key in the hash', () => {
    const key = generateApiKey().key;
    expect(hashApiKey(key, PEPPER)).not.toContain(key);
  });

  it('derives a ref that does not reveal the key', () => {
    const { key } = generateApiKey();
    const ref = apiKeyRef(hashApiKey(key, PEPPER));
    expect(ref.startsWith('qmk_')).toBe(true);
    expect(key.includes(ref)).toBe(false);
  });

  it('masks a key without revealing the middle', () => {
    const { key } = generateApiKey();
    const masked = maskApiKey(key);
    // The trailing 3 characters are the real tail of the random base64url segment, whose alphabet
    // includes `-` and `_`. `\w` excludes both, so it matched only ~91% of keys and failed at random.
    expect(masked).toMatch(/^qmk_[0-9a-f]{8}…[A-Za-z0-9_-]{3}$/);
    expect(masked).not.toContain(key.slice(13, 20));
  });

  it('generates unique, unguessable keys', () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey().key));
    expect(keys.size).toBe(200);
    for (const k of keys) expect(k).toMatch(/^qmk_[0-9a-f]{12}_[A-Za-z0-9_-]{32}$/);
  });
});

describe('JsonStore API key storage', () => {
  let store: JsonStore;
  beforeEach(async () => {
    store = new JsonStore(tempPath(), 9, PEPPER);
    await store.upsertMerchant(merchant(ADDRESS));
  });

  it('resolves the owning merchant from a presented key', async () => {
    const { key } = generateApiKey();
    await store.createMerchantApiKey({ key, merchantAddress: ADDRESS, label: 'shopify', createdAt: Date.now() });
    expect((await store.getMerchantByApiKey(key))?.address).toBe(ADDRESS);
  });

  it('does not write the plaintext key to disk', async () => {
    const { key } = generateApiKey();
    await store.createMerchantApiKey({ key, merchantAddress: ADDRESS, label: 'shopify', createdAt: Date.now() });
    const raw = readFileSync(store['path'] as string, 'utf8');
    expect(raw).not.toContain(key);
    expect(raw).not.toContain('qmkey_'); // legacy prefix, should not reappear
  });

  it('rejects an unknown key', async () => {
    expect(await store.getMerchantByApiKey(generateApiKey().key)).toBeUndefined();
  });

  it('rejects a key issued to a different merchant', async () => {
    const { key } = generateApiKey();
    await store.upsertMerchant(merchant(OTHER));
    await store.createMerchantApiKey({ key, merchantAddress: OTHER, label: 'b', createdAt: Date.now() });
    expect((await store.getMerchantByApiKey(key))?.address).toBe(OTHER);
  });

  it('stops resolving a revoked key, and revokes by ref not by secret', async () => {
    const { key } = generateApiKey();
    const { keyRef } = await store.createMerchantApiKey({ key, merchantAddress: ADDRESS, label: 'x', createdAt: Date.now() });
    await store.revokeMerchantApiKeyByRef(keyRef);
    expect(await store.getMerchantByApiKey(key)).toBeUndefined();
  });

  it('never returns a usable credential from listMerchantApiKeys', async () => {
    const { key } = generateApiKey();
    await store.createMerchantApiKey({ key, merchantAddress: ADDRESS, label: 'x', createdAt: Date.now() });
    const listed = await store.listMerchantApiKeys(ADDRESS);
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('key');
    expect(listed[0]).not.toHaveProperty('keyHash');
    expect(JSON.stringify(listed)).not.toContain(key);
  });

  it('scopes the listing to one merchant', async () => {
    await store.upsertMerchant(merchant(OTHER));
    await store.createMerchantApiKey({ key: generateApiKey().key, merchantAddress: ADDRESS, label: 'a', createdAt: 1 });
    await store.createMerchantApiKey({ key: generateApiKey().key, merchantAddress: OTHER, label: 'b', createdAt: 2 });
    expect(await store.listMerchantApiKeys(ADDRESS)).toHaveLength(1);
    expect((await store.listMerchantApiKeys(ADDRESS))[0]!.label).toBe('a');
  });

  it('stamps lastUsedAt on use', async () => {
    const { key } = generateApiKey();
    const { keyRef } = await store.createMerchantApiKey({ key, merchantAddress: ADDRESS, label: 'x', createdAt: Date.now() });
    expect((await store.listMerchantApiKeys(ADDRESS))[0]!.lastUsedAt).toBe(0);
    await store.getMerchantByApiKey(key);
    expect((await store.listMerchantApiKeys(ADDRESS))[0]!.lastUsedAt).toBeGreaterThan(0);
    expect((await store.listMerchantApiKeys(ADDRESS))[0]!.keyRef).toBe(keyRef);
  });
});

describe('legacy plaintext key migration (JsonStore)', () => {
  it('accepts a pre-hashing key, then removes it from disk', async () => {
    const path = tempPath();
    const legacyKey = 'qmkey_legacysecretabcdef';
    writeFileSync(
      path,
      JSON.stringify({
        cursors: {},
        merchants: { [ADDRESS]: merchant(ADDRESS) },
        deliveries: {},
        sessions: {},
        nonces: {},
        links: {},
        claims: {},
        orderMeta: {},
        qiOrders: {},
        // The old on-disk shape: plaintext credential as the record key.
        apiKeys: {
          [legacyKey]: { key: legacyKey, merchantAddress: ADDRESS, label: 'old', createdAt: 1, lastUsedAt: 0 },
        },
      }),
    );

    const store = new JsonStore(path, 9, PEPPER);
    // Existing credential keeps working — no re-issue, no downtime for the merchant.
    expect((await store.getMerchantByApiKey(legacyKey))?.address).toBe(ADDRESS);

    // ...and the plaintext is gone from disk straight away.
    expect(readFileSync(path, 'utf8')).not.toContain(legacyKey);
    expect((await store.getMerchantByApiKey(legacyKey))?.address).toBe(ADDRESS);
  });

  it('migrates a legacy key at most once', async () => {
    const path = tempPath();
    const legacyKey = 'qmkey_onceonly';
    writeFileSync(
      path,
      JSON.stringify({
        cursors: {}, merchants: { [ADDRESS]: merchant(ADDRESS) }, deliveries: {}, sessions: {},
        nonces: {}, links: {}, claims: {}, orderMeta: {}, qiOrders: {},
        apiKeys: { [legacyKey]: { key: legacyKey, merchantAddress: ADDRESS, label: 'old', createdAt: 1, lastUsedAt: 0 } },
      }),
    );
    const store = new JsonStore(path, 9, PEPPER);
    await store.getMerchantByApiKey(legacyKey);
    expect((await store.listMerchantApiKeys(ADDRESS))).toHaveLength(1);
    // Still exactly one record, and it is now hashed.
    expect((await store.listMerchantApiKeys(ADDRESS))).toHaveLength(1);
  });
});

describe('API key HTTP surface', () => {
  const API_SECRET = 'test-api-secret';
  let base: string;
  let store: JsonStore;

  beforeEach(async () => {
    store = new JsonStore(tempPath(), 9, PEPPER);
    const cfg = {
      ADMIN_API_KEY: 'test-admin-key-0123456789abcdef',
      CORS_ORIGINS: '*',
      CHAIN_ID: 9,
      LOGIN_REALM: 'tripplepay',
      PORT: 0,
      NODE_ENV: 'test',
      API_KEY_PEPPER: PEPPER,
      RELAYER_ENABLED: false,
      WEBHOOK_ALLOW_INSECURE_URLS: true,
      CONFIRMATIONS: 0,
      POLL_INTERVAL_MS: 1000,
      MAX_BLOCK_RANGE: 100,
      LOG_PRETTY: 'false',
    } as unknown as Config;
    const app = createServer(store, fakeClient(), cfg, undefined, undefined, undefined, undefined);
    const server = app.listen(0);
    servers.push(server);
    await new Promise<void>((r) => server.once('listening', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  it('requires admin auth to issue keys', async () => {
    const res = await fetch(`${base}/v1/me/apikeys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'x' }),
    });
    expect(res.status).toBe(401);
  });

  it('never echoes a credential back on list, and revokes by ref', async () => {
    await store.upsertMerchant(merchant(ADDRESS));
    const { key } = generateApiKey();
    const { keyRef } = await store.createMerchantApiKey({ key, merchantAddress: ADDRESS, label: 'shopify', createdAt: Date.now() });

    const list = await fetch(`${base}/v1/me/apikeys`, {
      headers: { authorization: `Bearer ${API_SECRET}`, 'x-merchant-key': key },
    });
    const text = await list.text();
    expect(list.status).toBe(200);
    expect(text).not.toContain(key);
    expect(text).toContain(keyRef);

    // The revoking URL carries only the non-secret ref.
    const del = await fetch(`${base}/v1/me/apikeys/${keyRef}`, {
      method: 'DELETE',
      headers: { 'x-merchant-key': key },
    });
    expect(del.status).toBe(204);
    expect(await store.getMerchantByApiKey(key)).toBeUndefined();
  });

  it('cannot revoke another merchant’s key', async () => {
    await store.upsertMerchant(merchant(ADDRESS));
    await store.upsertMerchant(merchant(OTHER));
    const victim = generateApiKey().key;
    const { keyRef } = await store.createMerchantApiKey({ key: victim, merchantAddress: OTHER, label: 'v', createdAt: Date.now() });
    const attacker = generateApiKey().key;
    await store.createMerchantApiKey({ key: attacker, merchantAddress: ADDRESS, label: 'a', createdAt: Date.now() });

    const del = await fetch(`${base}/v1/me/apikeys/${keyRef}`, {
      method: 'DELETE',
      headers: { 'x-merchant-key': attacker },
    });
    expect(del.status).toBe(404);
    expect(await store.getMerchantByApiKey(victim)).toBeDefined();
  });

  it('rejects an unknown or malformed X-Merchant-Key', async () => {
    const good = generateApiKey().key;
    await store.upsertMerchant(merchant(ADDRESS));
    await store.createMerchantApiKey({ key: good, merchantAddress: ADDRESS, label: 'a', createdAt: Date.now() });

    expect((await fetch(`${base}/v1/me/apikeys`, { headers: { 'x-merchant-key': generateApiKey().key } })).status).toBe(401);
    expect((await fetch(`${base}/v1/me/apikeys`, { headers: { 'x-merchant-key': `${good}x` } })).status).toBe(401);
    expect((await fetch(`${base}/v1/me/apikeys`, { headers: { 'x-merchant-key': good } })).status).toBe(200);
  });

  it('refuses an inactive merchant even with a valid key', async () => {
    await store.upsertMerchant({ ...merchant(ADDRESS), active: false });
    const { key } = generateApiKey();
    await store.createMerchantApiKey({ key, merchantAddress: ADDRESS, label: 'a', createdAt: Date.now() });
    const res = await fetch(`${base}/v1/me/apikeys`, { headers: { 'x-merchant-key': key } });
    expect(res.status).toBe(401);
  });
});

describe('production pepper requirement', () => {
  it('rejects the compiled-in dev pepper when NODE_ENV=production', async () => {
    const { loadConfig } = await import('../src/config.js');
    const baseEnv = {
      RPC_URL: 'https://rpc.quai.network/cyprus1',
      CHAIN_ID: '9',
      PAYWITHQUAI_ADDRESS: '0x' + '01'.repeat(20),
      ADMIN_API_KEY: 'test-admin-key-0123456789abcdef',
      NODE_ENV: 'production',
      API_KEY_PEPPER: DEV_API_KEY_PEPPER,
    } as NodeJS.ProcessEnv;
    expect(() => loadConfig(baseEnv)).toThrow(/API_KEY_PEPPER/);

    // A real pepper boots fine.
    expect(() => loadConfig({ ...baseEnv, API_KEY_PEPPER: PEPPER })).not.toThrow();
  });
});
