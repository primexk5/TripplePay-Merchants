import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdtempSync } from 'node:fs';
import { JsonStore } from '../src/store/json.js';
import { WebhookDispatcher, type PostFn } from '../src/webhooks/dispatcher.js';
import type { Config } from '../src/config.js';
import type { Merchant, WebhookDelivery } from '../src/types.js';

const dirs: string[] = [];
function freshStore(): JsonStore {
  const dir = mkdtempSync(join(tmpdir(), 'pwq-disp-'));
  dirs.push(dir);
  return new JsonStore(join(dir, 'relayer.db'));
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const cfg = {
  WEBHOOK_MAX_ATTEMPTS: 3,
  WEBHOOK_BASE_BACKOFF_MS: 1000,
  WEBHOOK_MAX_BACKOFF_MS: 60_000,
  WEBHOOK_TIMEOUT_MS: 1000,
  // These tests exercise the delivery state machine against a mocked transport, not the SSRF
  // guard — allow insecure URLs so the injected post() is the only thing consulted. The guard
  // has its own tests (private-IP reject) and the transport-level tests in httpPost.test.ts.
  WEBHOOK_ALLOW_INSECURE_URLS: true,
} as unknown as Config;

/** Transport double: records what the dispatcher would have POSTed and returns a canned result. */
function mockPost(
  handler: (opts: { url: string; headers: Record<string, string>; body: string }) =>
    | { ok: boolean; status: number; error?: string | null }
    | Promise<{ ok: boolean; status: number; error?: string | null }>,
): { post: PostFn; calls: { url: string; headers: Record<string, string>; body: string }[] } {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const post: PostFn = async (opts) => {
    const { url, headers, body } = opts;
    calls.push({ url, headers, body });
    const r = await handler({ url, headers, body });
    return { ok: r.ok, status: r.status, error: r.error ?? null };
  };
  return { post, calls };
}

const merchant: Merchant = {
  merchantId: 'mch_1',
  address: '0x00000000000000000000000000000000000000a1',
  name: 'Acme',
  webhookUrl: 'https://example.test/webhook',
  webhookSecret: 'whsec_x',
  active: true,
  createdAt: 1,
};

function delivery(): WebhookDelivery {
  return {
    id: '0xabc:0',
    chainId: 9,
    merchantId: 'mch_1',
    url: 'https://example.test/webhook',
    payload: {
      id: '0xabc:0',
      type: 'payment.confirmed',
      created: 1,
      data: {
        merchantId: 'mch_1',
        chainId: 9,
        merchant: '0x00000000000000000000000000000000000000A1',
        orderId: '0x' + '11'.repeat(32),
        payer: '0x00000000000000000000000000000000000000B2',
        token: '0x0000000000000000000000000000000000000000',
        amount: '25000000',
        feeBps: 50,
        fee: '125000',
        net: '24875000',
        txHash: '0x' + 'ab'.repeat(32),
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
  };
}

describe('WebhookDispatcher.attempt', () => {
  it('marks delivered on a 2xx and signs the request', async () => {
    const store = freshStore();
    await store.upsertMerchant(merchant);
    await store.insertDeliveryIfAbsent(delivery());

    const { post, calls } = mockPost(({ headers }) => {
      expect(typeof headers['x-paywithquai-signature']).toBe('string');
      return { ok: true, status: 200 };
    });

    const d = new WebhookDispatcher(store, cfg, () => 1_700_000_000_000, post);
    await d.attempt((await store.getDelivery('0xabc:0'))!);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers['x-paywithquai-signature']).toBeTruthy();
    expect((await store.getDelivery('0xabc:0'))!.status).toBe('delivered');
    expect((await store.getDelivery('0xabc:0'))!.attempts).toBe(1);
  });

  it('keeps pending and schedules a retry on a 5xx', async () => {
    const store = freshStore();
    await store.upsertMerchant(merchant);
    await store.insertDeliveryIfAbsent(delivery());
    const { post } = mockPost(() => ({ ok: false, status: 500, error: 'HTTP 500' }));

    const now = 1_700_000_000_000;
    const d = new WebhookDispatcher(store, cfg, () => now, post);
    await d.attempt((await store.getDelivery('0xabc:0'))!);

    const after = (await store.getDelivery('0xabc:0'))!;
    expect(after.status).toBe('pending');
    expect(after.attempts).toBe(1);
    expect(after.lastError).toBe('HTTP 500');
    expect(after.nextAttemptAt).toBeGreaterThanOrEqual(now); // scheduled into the future
  });

  it('marks failed after exhausting max attempts', async () => {
    const store = freshStore();
    await store.upsertMerchant(merchant);
    await store.insertDeliveryIfAbsent({ ...delivery(), attempts: cfg.WEBHOOK_MAX_ATTEMPTS - 1 });
    const { post } = mockPost(() => ({ ok: false, status: 500, error: 'HTTP 500' }));

    const d = new WebhookDispatcher(store, cfg, () => 1_700_000_000_000, post);
    await d.attempt((await store.getDelivery('0xabc:0'))!);

    expect((await store.getDelivery('0xabc:0'))!.status).toBe('failed');
    expect((await store.getDelivery('0xabc:0'))!.attempts).toBe(cfg.WEBHOOK_MAX_ATTEMPTS);
  });

  it('holds deliveries for a deactivated merchant without burning attempts', async () => {
    const store = freshStore();
    await store.upsertMerchant({ ...merchant, active: false });
    await store.insertDeliveryIfAbsent(delivery());
    const { post, calls } = mockPost(() => ({ ok: true, status: 200 }));

    const d = new WebhookDispatcher(store, cfg, () => 1_700_000_000_000, post);
    await d.attempt((await store.getDelivery('0xabc:0'))!);

    expect(calls).toHaveLength(0);
    const held = (await store.getDelivery('0xabc:0'))!;
    expect(held.status).toBe('pending'); // resumes if the merchant is re-activated
    expect(held.attempts).toBe(0);
  });

  it('permanently fails a delivery whose merchant row disappeared', async () => {
    const store = freshStore();
    await store.insertDeliveryIfAbsent(delivery()); // no merchant row at all
    const { post, calls } = mockPost(() => ({ ok: true, status: 200 }));

    const d = new WebhookDispatcher(store, cfg, () => 1_700_000_000_000, post);
    await d.attempt((await store.getDelivery('0xabc:0'))!);

    const after = (await store.getDelivery('0xabc:0'))!;
    expect(calls).toHaveLength(0);
    expect(after.status).toBe('failed');
    expect(after.attempts).toBe(0);
    expect(after.lastError).toBe('merchant no longer registered');
  });

  it('refuses to deliver to a private-IP target and never dials (SSRF guard)', async () => {
    const store = freshStore();
    await store.upsertMerchant({ ...merchant, webhookUrl: 'https://127.0.0.1/webhook' });
    await store.insertDeliveryIfAbsent({ ...delivery(), url: 'https://127.0.0.1/webhook' });

    // Guard active (allowInsecure false) — the transport rejects the literal before any socket.
    const strictCfg = { ...cfg, WEBHOOK_ALLOW_INSECURE_URLS: false } as unknown as Config;
    const d = new WebhookDispatcher(store, strictCfg, () => 1_700_000_000_000); // real httpPost
    await d.attempt((await store.getDelivery('0xabc:0'))!);

    const after = (await store.getDelivery('0xabc:0'))!;
    expect(after.status).toBe('pending'); // retried, not permanently failed (attempts < max)
    expect(after.attempts).toBe(1);
    expect(after.lastError).toMatch(/private\/reserved IP/);
  });

  it('treats a 3xx as a failed delivery (redirects never followed)', async () => {
    const store = freshStore();
    await store.upsertMerchant(merchant);
    await store.insertDeliveryIfAbsent(delivery());
    const { post } = mockPost(() => ({ ok: false, status: 302, error: 'unexpected redirect (not followed)' }));

    const d = new WebhookDispatcher(store, cfg, () => 1_700_000_000_000, post);
    await d.attempt((await store.getDelivery('0xabc:0'))!);

    const after = (await store.getDelivery('0xabc:0'))!;
    expect(after.status).toBe('pending');
    expect(after.attempts).toBe(1);
    expect(after.lastError).toMatch(/redirect/);
  });

  it('discards a stale write when the delivery was retried concurrently (CAS)', async () => {
    const store = freshStore();
    await store.upsertMerchant(merchant);
    await store.insertDeliveryIfAbsent(delivery());

    let release: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { post } = mockPost(async () => {
      await gate; // hold the attempt in flight
      return { ok: true, status: 200 };
    });

    const d = new WebhookDispatcher(store, cfg, () => 1_700_000_000_000, post);
    const attempt = d.attempt((await store.getDelivery('0xabc:0'))!);

    // While the attempt is dialing, an admin retry resets the delivery (attempts 0, pending).
    const nowMs = Date.now();
    const fresh = (await store.getDelivery('0xabc:0'))!;
    await store.updateDelivery({
      ...fresh,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: nowMs,
      lastError: null,
      updatedAt: nowMs,
    });
    release!();
    await attempt;

    // The in-flight attempt's stale write (attempts 1) must NOT clobber the retry's reset.
    const after = (await store.getDelivery('0xabc:0'))!;
    expect(after.attempts).toBe(0);
    expect(after.status).toBe('pending');
  });

  it('delivers a due batch concurrently — one slow endpoint does not stall the rest', async () => {
    const store = freshStore();
    await store.upsertMerchant(merchant);
    // ids ordered oldest-first: the two slow ones would block the fast one if delivery were serial.
    await store.insertDeliveryIfAbsent({ ...delivery(), id: 'slow:0' });
    await store.insertDeliveryIfAbsent({ ...delivery(), id: 'slow:1' });
    await store.insertDeliveryIfAbsent({ ...delivery(), id: 'fast:2' });

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const SLOW_MS = 300;
    const { post } = mockPost(({ headers }) => {
      if (headers['x-paywithquai-delivery']?.startsWith('slow:')) return sleep(SLOW_MS).then(() => ({ ok: true, status: 200 }));
      return { ok: true, status: 200 };
    });

    const started = Date.now();
    const d = new WebhookDispatcher(store, cfg, () => 1_700_000_000_000, post);
    await (d as unknown as { tick(): Promise<void> }).tick();
    const elapsed = Date.now() - started;

    // Serial would take >= 2 × SLOW_MS; parallel takes ~SLOW_MS. Give CI generous slack.
    expect(elapsed).toBeLessThan(SLOW_MS * 1.5);
    expect(await Promise.all(['slow:0', 'slow:1', 'fast:2'].map(async (id) => (await store.getDelivery(id))!.status))).toEqual([
      'delivered',
      'delivered',
      'delivered',
    ]);
  });
});
