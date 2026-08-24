import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { getAddress, verifyMessage } from 'quais';
import { z } from 'zod';
import type { Store } from '../store/index.js';
import type { QuaiClient } from '../chain/client.js';
import type { Config } from '../config.js';
import type { Merchant, Session, PaymentLink } from '../types.js';
import { newMerchantId, newWebhookSecret, newSlug } from '../util/ids.js';
import { assertSafeWebhookUrl, UnsafeWebhookUrlError } from '../webhooks/urlGuard.js';
import { rateLimit } from './rateLimit.js';
import { cors } from './cors.js';
import { cursorScope } from '../indexer/indexer.js';
import { log } from '../logger.js';

const logger = log('api');

/** Native QUAI marker — always allowed regardless of the ACCEPTED_TOKENS allowlist. */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Normalize ACCEPTED_TOKENS into a clean lowercase set. Handles both the parsed array
 *  (loadConfig) and a raw comma-separated string, so the route never trusts its input shape.
 *  Malformed entries are dropped rather than failing startup. */
function parseAcceptedTokens(value: unknown): Set<string> {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(',');
  return new Set(
    raw
      .map((s) => String(s).trim().toLowerCase())
      .filter((s) => /^0x[0-9a-f]{40}$/.test(s)),
  );
}

/**
 * Builds the HTTP API:
 *   GET  /health                          liveness + indexer cursor
 *   GET  /v1/orders/:merchant/:orderId    order + settlement status (on-chain + local)
 *   POST /v1/auth/login                   wallet-signature login -> bearer session token
 *   POST /v1/auth/logout                  invalidate the session token
 *   GET  /v1/me                           (session) the logged-in merchant's profile
 *   PATCH /v1/me                          (session) update own name/webhookUrl
 *   GET  /v1/me/deliveries                (session) own webhook deliveries
 *   GET  /v1/merchants                     (admin) list merchants
 *   POST /v1/merchants                     (admin) onboard a merchant -> returns webhook secret ONCE
 *   PATCH /v1/merchants/:address           (admin) update name/webhookUrl/active without rotating secret
 *   GET  /v1/deliveries                    (admin) recent webhook deliveries (debugging)
 *   POST /v1/deliveries/:id/retry          (admin) re-queue a failed/skipped delivery
 * Admin routes require `Authorization: Bearer <ADMIN_API_KEY>`. Self-service routes require a
 * session token issued by POST /v1/auth/login.
 */
export function createServer(store: Store, client: QuaiClient, cfg: Config): Express {
  const app = express();
  app.disable('x-powered-by');
  // `req.ip` (rate-limiter keys, login logging) is only the real client address when the hop
  // count of reverse proxies in front of the app is configured. Never set this blindly.
  if (cfg.TRUST_PROXY > 0) app.set('trust proxy', cfg.TRUST_PROXY);
  app.use(cors(cfg.CORS_ORIGINS));
  app.use(express.json({ limit: '256kb' }));
  // Baseline hardening: the API is JSON-only; a shared/misconfigured cache must never serve
  // admin or merchant data to other tenants, and no page may embed it.
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/health', asyncHandler(async (_req, res) => {
    const scope = cursorScope(cfg.CHAIN_ID, cfg.PAYWITHQUAI_ADDRESS);
    res.json({
      status: 'ok',
      contract: client.address,
      chainId: cfg.CHAIN_ID,
      cursor: (await store.getCursor(scope)) ?? null,
    });
  }));

  // The only unauthenticated route that performs an upstream RPC call — rate-limit per IP so it
  // can't be used to amplify traffic against the Quai node.
  const ordersLimiter = rateLimit({
    windowMs: cfg.PUBLIC_RATE_LIMIT_WINDOW_MS ?? 60_000,
    max: cfg.PUBLIC_RATE_LIMIT_MAX ?? 60,
  });

  app.get('/v1/orders/:merchant/:orderId', ordersLimiter, asyncHandler(async (req, res) => {
    const merchantParam = req.params.merchant ?? '';
    const orderId = req.params.orderId ?? '';
    let merchant: string;
    try {
      merchant = getAddress(merchantParam);
    } catch {
      return res.status(400).json({ error: 'invalid merchant address' });
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(orderId)) {
      return res.status(400).json({ error: 'orderId must be a 32-byte hex string' });
    }

    const order = await client.getOrder(merchant, orderId);
    if (!order.exists) return res.status(404).json({ error: 'order not found' });

    const delivery = await store.getDeliveryByOrder(merchant, orderId);
    res.json({
      merchant,
      orderId,
      token: order.token,
      amount: order.amount.toString(),
      feeBps: order.feeBps,
      expiry: order.expiry.toString(),
      settled: order.settled,
      webhook: delivery ? { status: delivery.status, attempts: delivery.attempts } : null,
    });
  }));

  // --- merchant auth (wallet-signature login) ---
  // Two-step login: the client first asks for a challenge (POST /v1/auth/challenge), which issues
  // a single-use nonce bound to the address, chain id and realm, and signs the returned message.
  // The login only accepts signatures over an unconsumed, unexpired nonce — a captured signature
  // can never be replayed, and a signature harvested on another deployment (different CHAIN_ID or
  // LOGIN_REALM) verifies against nothing.
  const LOGIN_WINDOW_MS = 300_000; // nonce lifetime; also the effective signature replay window
  // Session lifetime: 24h. Sessions are opaque random tokens persisted in the store.
  const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
  // SameSite/secure for the session cookie: cross-site deployments need None+Secure (HTTPS);
  // local dev (localhost:3001 -> localhost:8080 is same-site) works with Lax over plain HTTP.
  const COOKIE_SECURE = process.env.NODE_ENV === 'production';
  const COOKIE_SAME_SITE = COOKIE_SECURE ? 'None' : 'Lax';

  const AddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'address must be a 20-byte hex address');

  const ChallengeSchema = z.object({ address: AddressSchema });
  const LoginSchema = z.object({
    address: AddressSchema,
    message: z.string(),
    signature: z.string(),
  });

  // Both unauthenticated auth endpoints are rate-limited per IP: login also runs an EC recovery
  // (CPU) and mints store writes, so an unthrottled endpoint is a cheap DoS and oracle vector.
  const authLimiter = rateLimit({ windowMs: LOGIN_WINDOW_MS, max: 20 });

  app.post('/v1/auth/challenge', authLimiter, asyncHandler(async (req, res) => {
    const parsed = ChallengeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid body', issues: parsed.error.issues });
    }
    let address: string;
    try {
      address = getAddress(parsed.data.address);
    } catch {
      return res.status(400).json({ error: 'address fails checksum validation' });
    }
    const nonce = randomBytes(24).toString('hex');
    await store.createNonce(nonce, address.toLowerCase(), Date.now() + LOGIN_WINDOW_MS);
    const message = `tripplepay-login:${address}:${nonce}:${cfg.CHAIN_ID}:${cfg.LOGIN_REALM}`;
    res.json({ nonce, message, expiresAt: Date.now() + LOGIN_WINDOW_MS });
  }));

  app.post('/v1/auth/login', authLimiter, asyncHandler(async (req, res) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid body', issues: parsed.error.issues });
    }
    const { message, signature } = parsed.data;

    let address: string;
    try {
      address = getAddress(parsed.data.address);
    } catch {
      return res.status(400).json({ error: 'address fails checksum validation' });
    }

    // The signed message must be the exact challenge for THIS address, freshly issued by this
    // deployment. Everything else about a failed login answers uniformly 401 — no address
    // enumeration, no replay oracle.
    const match = /^tripplepay-login:(0x[0-9a-fA-F]{40}):([0-9a-fA-F]{16,}):(\d+):([A-Za-z0-9._-]+)$/.exec(message);
    const signedAddress = match?.[1];
    const nonce = match?.[2];
    const chainId = match?.[3];
    const realm = match?.[4];
    if (
      !match ||
      !signedAddress ||
      signedAddress.toLowerCase() !== address.toLowerCase() ||
      chainId !== String(cfg.CHAIN_ID) ||
      realm !== cfg.LOGIN_REALM
    ) {
      return res.status(401).json({ error: 'invalid credentials' });
    }

    // Single-use: consuming the nonce makes any replay of this signature fail from here on.
    const bound = nonce ? await store.consumeNonce(nonce) : undefined;
    if (bound !== address.toLowerCase()) {
      return res.status(401).json({ error: 'invalid credentials' });
    }

    // The signature proves ownership of the wallet: the recovered signer must equal the address
    // the merchant claims. verifyMessage throws on malformed input -> 400, not a 500.
    let recovered: string;
    try {
      recovered = verifyMessage(message, signature);
    } catch {
      return res.status(401).json({ error: 'invalid credentials' });
    }
    if (recovered.toLowerCase() !== address.toLowerCase()) {
      return res.status(401).json({ error: 'invalid credentials' });
    }

    const merchant = await store.getMerchantByAddress(address);
    if (!merchant || !merchant.active) {
      return res.status(401).json({ error: 'invalid credentials' });
    }

    const now = Date.now();
    const token = randomBytes(32).toString('hex');
    await store.createSession({
      token,
      merchantId: merchant.merchantId,
      address: merchant.address,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    });
    // HttpOnly session cookie for browsers (the bearer token in the body remains for API clients).
    res.setHeader(
      'Set-Cookie',
      sessionCookie('qmsession', token, SESSION_TTL_MS, COOKIE_SECURE, COOKIE_SAME_SITE),
    );
    logger.info({ merchantId: merchant.merchantId, address }, 'merchant logged in');
    res.json({ token, expiresAt: now + SESSION_TTL_MS, merchant: publicMerchant(merchant) });
  }));

  // Session-protected self-service routes. requireSession is applied per-route (NOT as a blanket
  // router middleware) so requests to the admin routes below still reach their own auth check.
  const auth = requireSession(store);

  app.post('/v1/auth/logout', auth, asyncHandler(async (req, res) => {
    const token = bearerToken(req) || cookieToken(req);
    if (token) await store.deleteSession(token);
    // Clear the browser cookie regardless of whether a bearer was used.
    res.setHeader('Set-Cookie', sessionCookie('qmsession', '', 0, COOKIE_SECURE, COOKIE_SAME_SITE));
    res.sendStatus(204);
  }));

  app.get('/v1/me', auth, asyncHandler(async (req, res) => {
    const session = res.locals.session as Session;
    const merchant = await store.getMerchantById(session.merchantId);
    if (!merchant) return res.status(404).json({ error: 'merchant not found' });
    res.json(publicMerchant(merchant));
  }));

  app.patch('/v1/me', auth, asyncHandler(async (req, res) => {
    const session = res.locals.session as Session;
    const merchant = await store.getMerchantById(session.merchantId);
    if (!merchant) return res.status(404).json({ error: 'merchant not found' });

    const parsed = PatchMerchantSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid body', issues: parsed.error.issues });
    }
    // SSRF guard: same policy as onboarding / admin PATCH.
    if (parsed.data.webhookUrl !== undefined) {
      try {
        assertSafeWebhookUrl(parsed.data.webhookUrl, cfg.WEBHOOK_ALLOW_INSECURE_URLS);
      } catch (e) {
        if (e instanceof UnsafeWebhookUrlError) return res.status(400).json({ error: e.message });
        throw e;
      }
    }
    const { name, webhookUrl } = parsed.data;
    const updated: Merchant = {
      ...merchant,
      name: name ?? merchant.name,
      webhookUrl: webhookUrl ?? merchant.webhookUrl,
    };
await store.upsertMerchant(updated);
    // First webhook URL configured by the merchant themselves — catch up on payments that
    // settled while it was empty (recorded as skipped).
    if (!merchant.webhookUrl && updated.webhookUrl) {
      const requeued = await store.requeueSkippedForMerchant(updated);
      if (requeued > 0) logger.info({ merchantId: updated.merchantId, requeued }, 'webhook configured — re-queued skipped payments');
    }
    logger.info({ merchantId: updated.merchantId }, 'merchant profile updated');
    res.json(publicMerchant(updated));
  }));

  app.get('/v1/me/deliveries', auth, asyncHandler(async (_req, res) => {
    const session = res.locals.session as Session;
    const deliveries = await store.listDeliveries(100);
    res.json({
      deliveries: deliveries.filter((d) => d.merchantId === session.merchantId),
    });
  }));

  // --- payment links (short URLs + multi-pay order pool) ---

  const CreateLinkSchema = z.object({
    shopName: z.string().max(200).optional().default(''),
    tokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    amount: z.string().regex(/^\d+$/, 'amount must be a decimal integer string (smallest unit)'),
    amountDisplay: z.string().max(30),
    symbol: z.string().max(10),
    expiryDurationSecs: z.number().int().min(0).default(0),
    multiPay: z.boolean().default(false),
    /** Pre-registered orderIds sent by the merchant after signing them on-chain. */
    orderPool: z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/)).default([]),
  });

  app.post('/v1/links', auth, asyncHandler(async (req, res) => {
    const session = res.locals.session as Session;
    const merchant = await store.getMerchantById(session.merchantId);
    if (!merchant) return res.status(404).json({ error: 'merchant not found' });

    const parsed = CreateLinkSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid body', issues: parsed.error.issues });
    }
    const d = parsed.data;

    // Single-pay links need exactly one orderId in the pool.
    if (!d.multiPay && d.orderPool.length !== 1) {
      return res.status(400).json({ error: 'single-pay link requires exactly one orderId in orderPool' });
    }
    // Multi-pay links need at least one pre-registered order to be useful.
    if (d.multiPay && d.orderPool.length === 0) {
      return res.status(400).json({ error: 'multi-pay link requires at least one pre-registered orderId' });
    }

    // Optional ERC-20 allowlist (ACCEPTED_TOKENS). Native QUAI is always permitted.
    const tokenLower = d.tokenAddress.toLowerCase();
    const accepted = parseAcceptedTokens(cfg.ACCEPTED_TOKENS);
    if (tokenLower !== ZERO_ADDRESS && accepted.size > 0 && !accepted.has(tokenLower)) {
      return res.status(400).json({ error: `token ${d.tokenAddress} is not in ACCEPTED_TOKENS` });
    }

    const slug = newSlug();
    const link: PaymentLink = {
      slug,
      merchantAddress: merchant.address,
      merchantId: merchant.merchantId,
      merchantName: merchant.name,
      shopName: d.shopName ?? '',
      tokenAddress: d.tokenAddress,
      amount: d.amount,
      amountDisplay: d.amountDisplay,
      symbol: d.symbol,
      expiryDurationSecs: d.expiryDurationSecs,
      multiPay: d.multiPay,
      orderPool: d.orderPool,
      createdAt: Date.now(),
    };
    await store.upsertLink(link);
    logger.info({ slug, merchantId: merchant.merchantId, multiPay: d.multiPay, poolSize: d.orderPool.length }, 'payment link created');
    res.status(201).json(publicLink(link));
  }));

  app.get('/v1/links', auth, asyncHandler(async (req, res) => {
    const session = res.locals.session as Session;
    const merchant = await store.getMerchantById(session.merchantId);
    if (!merchant) return res.status(404).json({ error: 'merchant not found' });
    const links = (await store.listLinksForMerchant(merchant.address)).map(publicLink);
    res.json({ links });
  }));

  // Public — the checkout page (including mobile browsers) needs this without auth.
  const linkLimiter = rateLimit({
    windowMs: cfg.PUBLIC_RATE_LIMIT_WINDOW_MS ?? 60_000,
    max: cfg.PUBLIC_RATE_LIMIT_MAX ?? 60,
  });

  app.get('/v1/links/:slug', linkLimiter, asyncHandler(async (req, res) => {
    const slug = req.params.slug ?? '';
    const link = await store.getLink(slug);
    if (!link) return res.status(404).json({ error: 'link not found' });
    res.json(publicLink(link));
  }));

  const ClaimSchema = z.object({
    payerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'payerAddress must be a 20-byte hex address'),
  });

  const DOUBLE_PAY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
  // An unsettled claim older than this is considered abandoned and its orderId is handed back
  // out — otherwise abandoned checkouts permanently drain the pool until it reads "fully booked".
  const CLAIM_STALE_MS = 15 * 60 * 1000; // 15 minutes

  app.post('/v1/links/:slug/claim', linkLimiter, asyncHandler(async (req, res) => {
    const slug = req.params.slug ?? '';
    const link = await store.getLink(slug);
    if (!link) return res.status(404).json({ error: 'link not found' });

    const parsed = ClaimSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid body', issues: parsed.error.issues });
    }
    let payerAddress: string;
    try {
      payerAddress = getAddress(parsed.data.payerAddress);
    } catch {
      return res.status(400).json({ error: 'payerAddress fails checksum validation' });
    }

    // 5-min double-pay guard: same wallet cannot claim again until previous claim expires.
    const latest = await store.getLatestClaim(slug, payerAddress);
    if (latest && !latest.settled) {
      const elapsed = Date.now() - latest.claimedAt;
      if (elapsed < DOUBLE_PAY_WINDOW_MS) {
        const retryAfterSecs = Math.ceil((DOUBLE_PAY_WINDOW_MS - elapsed) / 1000);
        res.setHeader('Retry-After', String(retryAfterSecs));
        return res.status(429).json({
          error: 'already claimed — wait before paying again',
          retryAfterSecs,
          orderId: latest.orderId, // let them reuse their already-claimed orderId
        });
      }
    }

    // Recycle abandoned checkouts first: an unsettled claim older than CLAIM_STALE_MS is
    // reassigned to this payer instead of consuming a fresh pool slot. The orderId stays valid
    // on-chain (link orders have no payer binding), so reuse is safe.
    const recycled = await store.reclaimStaleClaim(slug, payerAddress, CLAIM_STALE_MS);
    if (recycled) {
      logger.info({ slug, payerAddress, orderId: recycled }, 'stale claim recycled');
      return res.json({
        orderId: recycled,
        merchant: getAddress(link.merchantAddress),
        token: link.tokenAddress,
        amount: link.amount,
        poolRemaining: link.orderPool.length,
      });
    }

    const orderId = await store.claimOrderFromPool(slug, payerAddress);
    if (!orderId) {
      return res.status(503).json({ error: 'no orders available — pool exhausted; ask the merchant to add more' });
    }
    logger.info({ slug, payerAddress, orderId }, 'order claimed from pool');
    res.json({
      orderId,
      merchant: getAddress(link.merchantAddress),
      token: link.tokenAddress,
      amount: link.amount,
      poolRemaining: link.orderPool.length,
    });
  }));

  // --- admin ---
  const admin = express.Router();
  admin.use(requireAdmin(cfg));

  admin.get('/merchants', asyncHandler(async (_req, res) => {
    res.json({ merchants: (await store.listMerchants()).map(publicMerchant) });
  }));

  const OnboardSchema = z.object({
    address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'address must be a 20-byte hex address'),
    name: z.string().min(1).max(200),
    // Webhooks are optional at onboarding — merchants can add the URL later (Settings →
    // PATCH). Payments that settle while the URL is empty are recorded as skipped and
    // re-queued automatically once a URL is configured.
    webhookUrl: z.string().url().optional(),
  });

  admin.post('/merchants', asyncHandler(async (req, res) => {
    const parsed = OnboardSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid body', issues: parsed.error.issues });
    }
    // SSRF guard: reject non-https / internal webhook targets up front (see webhooks/urlGuard).
    if (parsed.data.webhookUrl !== undefined) {
      try {
        assertSafeWebhookUrl(parsed.data.webhookUrl, cfg.WEBHOOK_ALLOW_INSECURE_URLS);
      } catch (e) {
        if (e instanceof UnsafeWebhookUrlError) return res.status(400).json({ error: e.message });
        throw e;
      }
    }
    let address: string;
    try {
      address = getAddress(parsed.data.address);
    } catch {
      // Mixed-case input passes the regex but fails checksum validation — a client error, not
      // a server fault (must not bubble into the 500 handler).
      return res.status(400).json({ error: 'address fails checksum validation' });
    }
    const existing = await store.getMerchantByAddress(address);
    if (existing) {
      // Onboarding must not silently rotate the merchant's webhook secret — that would break its
      // signature verification with no warning. Profile updates go through PATCH.
      return res.status(409).json({ error: 'merchant already exists — use PATCH /v1/merchants/:address to update it' });
    }
    const merchant: Merchant = {
      merchantId: newMerchantId(),
      address: address.toLowerCase(),
      name: parsed.data.name,
      webhookUrl: parsed.data.webhookUrl ?? '',
      webhookSecret: newWebhookSecret(), // shown exactly once — the merchant must store it
      active: true,
      createdAt: Date.now(),
    };
    await store.upsertMerchant(merchant);
    // Payments that arrived before this address was registered were recorded as `skipped`, not
    // lost — re-queue them now so the merchant catches up on anything it missed.
    const requeued = await store.requeueSkippedForMerchant(merchant);
    logger.info({ merchantId: merchant.merchantId, address, requeued }, 'merchant onboarded');
    // The secret is returned exactly once — the merchant must store it to verify signatures.
    res.status(201).json({ ...publicMerchant(merchant), webhookSecret: merchant.webhookSecret });
  }));

  const PatchMerchantSchema = z
    .object({
      name: z.string().min(1).max(200).optional(),
      webhookUrl: z.string().url().optional(),
      active: z.boolean().optional(),
    })
    .refine((v) => v.name !== undefined || v.webhookUrl !== undefined || v.active !== undefined, {
      message: 'at least one of name, webhookUrl or active is required',
    });

  admin.patch('/merchants/:address', asyncHandler(async (req, res) => {
    let address: string;
    try {
      address = getAddress(req.params.address ?? '');
    } catch {
      return res.status(400).json({ error: 'invalid merchant address' });
    }
    const existing = await store.getMerchantByAddress(address);
    if (!existing) return res.status(404).json({ error: 'merchant not found' });

    const parsed = PatchMerchantSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid body', issues: parsed.error.issues });
    }
    // SSRF guard: if the webhook URL is being changed, hold it to the same policy as onboarding.
    if (parsed.data.webhookUrl !== undefined) {
      try {
        assertSafeWebhookUrl(parsed.data.webhookUrl, cfg.WEBHOOK_ALLOW_INSECURE_URLS);
      } catch (e) {
        if (e instanceof UnsafeWebhookUrlError) return res.status(400).json({ error: e.message });
        throw e;
      }
    }
    // Deliberately NOT rotating the webhook secret here — PATCH updates profile fields (name /
    // url / active); rotating would break the merchant's signature verification out of the blue.
    const { name, webhookUrl, active } = parsed.data;
    const updated: Merchant = {
      ...existing,
      name: name ?? existing.name,
      webhookUrl: webhookUrl ?? existing.webhookUrl,
      active: active ?? existing.active,
    };
await store.upsertMerchant(updated);
    // First time a webhook URL is configured: re-queue payments that settled while it was
    // empty (recorded as skipped) so the merchant catches up on anything it missed.
    if (!existing.webhookUrl && updated.webhookUrl) {
      const requeued = await store.requeueSkippedForMerchant(updated);
      if (requeued > 0) logger.info({ merchantId: updated.merchantId, requeued }, 'webhook configured — re-queued skipped payments');
    }
    logger.info({ merchantId: updated.merchantId, address, active: updated.active }, 'merchant updated');
    res.json(publicMerchant(updated));
  }));

  admin.get('/deliveries', asyncHandler(async (_req, res) => {
    res.json({ deliveries: await store.listDeliveries(100) });
  }));

  admin.post('/deliveries/:id/retry', asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    const d = await store.getDelivery(id);
    if (!d) return res.status(404).json({ error: 'delivery not found' });
    if (d.status === 'delivered') {
      return res.status(409).json({ error: 'delivery already delivered' });
    }
    if (d.status === 'skipped') {
      // A skipped delivery has no merchant URL to retry — re-queueing it would only make the
      // dispatcher permanently fail it. Onboarding the payout address re-queues it properly.
      return res.status(409).json({ error: 'delivery was skipped (merchant not registered) — onboard the payout address to re-queue it' });
    }
    const nowMs = Date.now();
    await store.updateDelivery({
      ...d,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: nowMs,
      lastError: null,
      updatedAt: nowMs,
    });
    logger.info({ id, previous: d.status }, 'delivery re-queued for retry');
    res.json({ id, previously: d.status, status: 'pending', attempts: 0 });
  }));

  app.use('/v1', admin);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as { status?: number; type?: string };
    // Malformed JSON bodies surface as body-parser 4xx errors — a client fault, not a 500.
    if (e.type === 'entity.parse.failed' || (typeof e.status === 'number' && e.status >= 400 && e.status < 500)) {
      return res.status(e.status ?? 400).json({ error: 'invalid request body' });
    }
    logger.error({ err }, 'unhandled API error');
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

/** Merchant view without the signing secret. */
function publicMerchant(m: Merchant) {
  return {
    merchantId: m.merchantId,
    address: getAddress(m.address),
    name: m.name,
    webhookUrl: m.webhookUrl,
    active: m.active,
    createdAt: m.createdAt,
  };
}

/** Link view — omits the internal orderPool array; pool size only. */
function publicLink(l: PaymentLink) {
  return {
    slug: l.slug,
    merchantAddress: getAddress(l.merchantAddress),
    merchantId: l.merchantId,
    merchantName: l.merchantName,
    shopName: l.shopName,
    tokenAddress: l.tokenAddress,
    amount: l.amount,
    amountDisplay: l.amountDisplay,
    symbol: l.symbol,
    expiryDurationSecs: l.expiryDurationSecs,
    multiPay: l.multiPay,
    poolSize: l.orderPool.length,
    createdAt: l.createdAt,
  };
}

function requireAdmin(cfg: Config) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const given = Buffer.from(token, 'utf8');
    const expected = Buffer.from(cfg.ADMIN_API_KEY, 'utf8');
    // Constant-time comparison — never plain `!==` on a bearer secret.
    const ok = given.length === expected.length && timingSafeEqual(given, expected);
    if (!ok) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  };
}

/** Extract a raw bearer token from the Authorization header, if present. */
function bearerToken(req: Request): string {
  const header = req.header('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

/** Extract the `qmsession` cookie value (HttpOnly session cookie set at login), if present. */
function cookieToken(req: Request): string | undefined {
  const header = req.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === 'qmsession') {
      const value = part.slice(idx + 1).trim();
      return value ? decodeURIComponent(value) : undefined;
    }
  }
  return undefined;
}

/** Set-Cookie value for the session cookie; `maxAgeMs` 0 expires it immediately. */
function sessionCookie(name: string, value: string, maxAgeMs: number, secure: boolean, sameSite: string): string {
  const parts = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${sameSite}`,
  ];
  if (value === '') {
    parts.push('Max-Age=0');
  } else if (maxAgeMs > 0) {
    parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  }
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** Require a valid session token (bearer header or HttpOnly cookie); on success the session is
 *  exposed via res.locals.session. */
function requireSession(store: Store) {
  return (req: Request, res: Response, next: NextFunction) => {
    // NOTE: `||` is load-bearing — bearerToken returns '' (not null) without a header, and `??`
    // would short-circuit to '' and never read the HttpOnly cookie, breaking cookie-only clients.
    const token = bearerToken(req) || cookieToken(req) || '';
    // getSession lazily expires tokens on access, so a stale token fails here naturally.
    void store
      .getSession(token)
      .then((session) => {
        if (!session) {
          return res.status(401).json({ error: 'unauthorized — log in again' });
        }
        res.locals.session = session;
        next();
      })
      .catch(next);
  };
}

function asyncHandler(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}
