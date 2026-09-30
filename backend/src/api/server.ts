import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../store/index.js';
import type { ChainClient } from '../chain/types.js';
import type { ChainRegistry } from '../chain/index.js';
import type { QiService } from '../chain/qi.js';
import type { Config } from '../config.js';
import type { Merchant, Session, PaymentLink, WebhookDelivery, QiOrder } from '../types.js';
import { newMerchantId, newWebhookSecret, newSlug } from '../util/ids.js';
import {
  normalizeAddressAnyKind,
  normalizeAddressForKind,
  recoverMessageSignerForKind,
  type ChainAddressKind,
} from '../util/address.js';
import { assertSafeWebhookUrl, UnsafeWebhookUrlError } from '../webhooks/urlGuard.js';
import { rateLimit } from './rateLimit.js';
import { cors } from './cors.js';
import { cursorScope } from '../indexer/indexer.js';
import type { Indexer } from '../indexer/indexer.js';
import { log } from '../logger.js';

const logger = log('api');

/** Public Qi shape for an order — what the checkout needs: the one-time receive address, the
 *  required amount (qits), how much has arrived, and whether settlement has been detected. */
function qiView(order: QiOrder) {
  return {
    address: order.address,
    qits: order.qits.toString(),
    receivedQits: order.receivedQits === undefined ? undefined : order.receivedQits.toString(),
    settled: order.settled,
    txHashes: order.txHashes,
  };
}

/** Native QUAI marker — always allowed regardless of the ACCEPTED_TOKENS allowlist. */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Amount (wei) fabricated for a dev-demo order served under QI_DEV_DEMO_MERCHANT when
 * QI_DEV_SIMULATE is on — 25 QUAI, mirroring the `/checkout/demo` page. Only reachable in
 * non-production configs (loadConfig refuses QI_DEV_SIMULATE with NODE_ENV=production).
 */
const DEV_DEMO_ORDER_AMOUNT = 25_000_000_000_000_000_000n;

/** Fake outpoint tx hash for dev-simulated Qi settlements (zero mainnet funds required). */
const DEV_FAKE_TX_HASH = '0x' + 'de'.repeat(32);

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

/** A chain resolved for the current request: its live client plus the identifying fields every
 *  route needs (id/slug, chainId, kind, name, per-chain token allowlist). In multi-chain mode
 *  (a ChainRegistry was passed to createServer) this comes from the registry; otherwise it's
 *  synthesized once from the legacy single-chain `client`/`cfg`, below. */
interface ResolvedChain {
  client: ChainClient;
  id: string;
  chainId: number;
  kind: ChainAddressKind;
  name: string;
  acceptedTokens?: string[];
}

interface ChainHealthView {
  id: string;
  chainId: number;
  kind: ChainAddressKind;
  name: string;
  contract: string;
  cursor: number | null;
  lastPollAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  healthy: boolean;
}

/**
 * Builds the HTTP API:
 *   GET  /health                          liveness + per-chain indexer health
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
 *   GET  /v1/chains                        (admin) configured chains + health
 * Admin routes require `Authorization: Bearer <ADMIN_API_KEY>`. Self-service routes require a
 * session token issued by POST /v1/auth/login.
 *
 * `registry`/`indexers` are optional and additive: when absent (every existing caller/test that
 * predates multi-chain support), every route behaves exactly as it did against the single
 * `client`/`cfg` chain — see `legacyChain` and `resolveChain()` below. Production (src/index.ts)
 * always passes both.
 */
export function createServer(
  store: Store,
  client: ChainClient,
  cfg: Config,
  qiService?: QiService,
  registry?: ChainRegistry,
  indexers?: Map<number, Indexer>,
): Express {
  // The single implied chain when no registry is configured — reproduces the pre-multi-chain
  // behaviour exactly (same id/kind normalization normalizeAddress/recoverMessageSigner used).
  const legacyChain: ResolvedChain = {
    client,
    id: cfg.CHAIN_KIND === 'evm' ? 'evm' : 'quai',
    chainId: cfg.CHAIN_ID,
    kind: cfg.CHAIN_KIND === 'evm' ? 'evm' : 'quai',
    name: cfg.CHAIN_KIND === 'evm' ? `EVM chain ${cfg.CHAIN_ID}` : 'Quai',
    acceptedTokens: cfg.ACCEPTED_TOKENS,
  };

  /** Resolves a request-supplied chain identifier (numeric chainId, numeric string, or slug)
   *  against the configured chains. Undefined/empty resolves to the default chain. Returns
   *  undefined only for an id/slug that matches no enabled chain — the caller turns that into a
   *  400 (or 503 for a link whose chain has since been disabled). */
  function resolveChain(idOrSlug: string | number | undefined | null): ResolvedChain | undefined {
    if (registry) {
      const entry = registry.resolve(idOrSlug ?? undefined);
      if (!entry) return undefined;
      return {
        client: entry.client,
        id: entry.config.id,
        chainId: entry.config.chainId,
        kind: entry.config.kind,
        name: entry.config.name,
        acceptedTokens: entry.config.acceptedTokens,
      };
    }
    // Legacy path: exactly one chain (cfg's own). An explicit id/slug must match it.
    if (
      idOrSlug !== undefined &&
      idOrSlug !== null &&
      idOrSlug !== '' &&
      String(idOrSlug) !== String(legacyChain.chainId) &&
      String(idOrSlug) !== legacyChain.id
    ) {
      return undefined;
    }
    return legacyChain;
  }

  const defaultChain = (): ResolvedChain => (registry ? resolveChain(undefined)! : legacyChain);

  async function computeChainsHealth(): Promise<ChainHealthView[]> {
    const list: ResolvedChain[] = registry
      ? registry.entries.map((e) => ({
          client: e.client,
          id: e.config.id,
          chainId: e.config.chainId,
          kind: e.config.kind,
          name: e.config.name,
          acceptedTokens: e.config.acceptedTokens,
        }))
      : [legacyChain];
    return Promise.all(
      list.map(async (c) => {
        const scope = cursorScope(c.chainId, c.client.address);
        const cursor = (await store.getCursor(scope)) ?? null;
        const h = indexers?.get(c.chainId)?.health() ?? { lastPollAt: null, lastSuccessAt: null, lastError: null };
        return {
          id: c.id,
          chainId: c.chainId,
          kind: c.kind,
          name: c.name,
          contract: c.client.address,
          cursor,
          lastPollAt: h.lastPollAt,
          lastSuccessAt: h.lastSuccessAt,
          lastError: h.lastError,
          healthy: h.lastError === null,
        };
      }),
    );
  }

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
    const chains = await computeChainsHealth();
    const def = defaultChain();
    const scope = cursorScope(def.chainId, def.client.address);
    res.json({
      status: 'ok',
      // Legacy top-level fields (single-chain deployments predate the `chains` array below):
      // always the DEFAULT chain's values, computed via the registry when one is configured, and
      // otherwise byte-identical to the original single-chain computation.
      chainKind: def.kind,
      contract: client.address,
      chainId: def.chainId,
      cursor: (await store.getCursor(scope)) ?? null,
      qi: qiService?.enabled ? { enabled: true, rpc: qiService.rpcUrl } : { enabled: false },
      chains,
      healthy: chains.every((c) => c.healthy),
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
      // Merchants are chain-free (product rule) — accept either address-format convention.
      merchant = normalizeAddressAnyKind(merchantParam);
    } catch {
      return res.status(400).json({ error: 'invalid merchant address' });
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(orderId)) {
      return res.status(400).json({ error: 'orderId must be a 32-byte hex string' });
    }

    const chainParam = typeof req.query.chainId === 'string' ? req.query.chainId : undefined;
    const chain = resolveChain(chainParam);
    if (!chain) {
      return res.status(400).json({ error: `unknown or disabled chainId "${chainParam}"` });
    }

    // DEV ONLY: for the demo merchant under QI_DEV_SIMULATE, synthesize the order rather than
    // calling the chain — an unregistered merchant's getOrder may throw OR return a zeroed
    // `exists:true` struct (observed on Orchard), which would incorrectly yield amount 0. Qi (and
    // this demo) is Quai-only, so this never fires for an EVM-chain lookup.
    const isDevDemo =
      cfg.QI_DEV_SIMULATE &&
      chain.kind === 'quai' &&
      cfg.QI_DEV_DEMO_MERCHANT?.toLowerCase() === merchant.toLowerCase();
    let order: Awaited<ReturnType<ChainClient['getOrder']>>;
    if (isDevDemo) {
      logger.warn({ merchant, orderId }, 'dev demo order synthesized (QI_DEV_SIMULATE)');
      order = {
        exists: true,
        settled: false,
        merchant,
        amount: DEV_DEMO_ORDER_AMOUNT,
        feeBps: 50,
        token: ZERO_ADDRESS,
        feeRecipient: merchant,
        expiry: 0n,
        settledAt: 0n,
        expectedPayer: ZERO_ADDRESS,
        nonce: 0n,
      };
    } else {
      order = await chain.client.getOrder(merchant, orderId);
    }
    if (!order.exists) return res.status(404).json({ error: 'order not found' });

    const delivery = await store.getDeliveryByOrder(merchant, orderId);
    // Qi surface: derive (or load) the order's one-time receive address. Qi is Quai-only, so this
    // stays null for every EVM-chain order, exactly as it does for any order when Qi is disabled.
    // Derivation is lazily triggered by the checkout reading the order — no background job, no
    // wasted addresses.
    let qi: ReturnType<typeof qiView> | null = null;
    if (qiService?.enabled && chain.kind === 'quai') {
      const qits = qiService.orderQits(order.amount);
      let rec = await store.getQiOrder(orderId);
      if (!rec) rec = await qiService.ensureQiOrder(orderId, merchant, qits);
      if (rec) qi = qiView(rec);
    }
    res.json({
      merchant,
      orderId,
      chainId: chain.chainId,
      token: order.token,
      amount: order.amount.toString(),
      feeBps: order.feeBps,
      expiry: order.expiry.toString(),
      settled: order.settled,
      qi,
      webhook: delivery ? { status: delivery.status, attempts: delivery.attempts } : null,
    });
  }));

  // --- order metadata (payer-supplied context, best-effort) ---
  // Payment pages POST this right after on-chain confirmation so the merchant's dashboard can
  // show WHO paid (optional display name) and WHERE the payment came from (payment link vs
  // merchant checkout/API page). Purely informational — settlement is on-chain only.
  const OrderMetaSchema = z.object({
    customerName: z.string().trim().min(1).max(60).optional(),
    slug: z.string().trim().length(8).regex(/^[0-9A-Za-z]+$/).optional(),
  });
  app.post('/v1/orders/:merchant/:orderId/meta', ordersLimiter, asyncHandler(async (req, res) => {
    let merchant: string;
    try {
      merchant = normalizeAddressAnyKind(req.params.merchant ?? '');
    } catch {
      return res.status(400).json({ error: 'invalid merchant address' });
    }
    const orderId = (req.params.orderId ?? '').toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(orderId)) {
      return res.status(400).json({ error: 'orderId must be a 32-byte hex string' });
    }

    const parsed = OrderMetaSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'invalid metadata' });

    // A slug only counts as a "link" source if it actually belongs to this merchant. The chain is
    // carried through from the link when one applies; otherwise this is a direct checkout/API
    // order against the default chain.
    let slug: string | undefined;
    let chainId = defaultChain().chainId;
    if (parsed.data.slug) {
      const link = await store.getLink(parsed.data.slug);
      if (link && link.merchantAddress === merchant.toLowerCase()) {
        slug = link.slug;
        chainId = link.chainId;
      }
    }

    await store.saveOrderMeta({
      orderId,
      chainId,
      merchantAddress: merchant.toLowerCase(),
      customerName: parsed.data.customerName,
      source: slug ? 'link' : 'checkout',
      slug,
      createdAt: Date.now(),
    });
    res.json({ ok: true });
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
  const ChainIdOrSlugSchema = z.union([z.string(), z.number()]).optional();

  const ChallengeSchema = z.object({ address: AddressSchema, chainId: ChainIdOrSlugSchema });
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
      // The merchant's identity is chain-free; the challenge itself still binds to ONE chain
      // (below) so the signature can be verified under that chain's own signing scheme.
      address = normalizeAddressAnyKind(parsed.data.address);
    } catch {
      return res.status(400).json({ error: 'address fails checksum validation' });
    }
    const chain = resolveChain(parsed.data.chainId);
    if (!chain) {
      return res.status(400).json({ error: `unknown or disabled chain "${parsed.data.chainId}"` });
    }
    const nonce = randomBytes(24).toString('hex');
    await store.createNonce(nonce, address.toLowerCase(), Date.now() + LOGIN_WINDOW_MS);
    // Message format is UNCHANGED: tripplepay-login:<address>:<nonce>:<chainId>:<realm>. Only the
    // chainId component now varies per request (any enabled chain, not always one fixed value) —
    // see POST /v1/auth/login for why accepting any of this deployment's configured chains here
    // keeps replay protection intact.
    const message = `tripplepay-login:${address}:${nonce}:${chain.chainId}:${cfg.LOGIN_REALM}`;
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
      address = normalizeAddressAnyKind(parsed.data.address);
    } catch {
      return res.status(400).json({ error: 'address fails checksum validation' });
    }

    // The signed message must be the exact challenge for THIS address, freshly issued by this
    // deployment. Everything else about a failed login answers uniformly 401 — no address
    // enumeration, no replay oracle.
    const match = /^tripplepay-login:(0x[0-9a-fA-F]{40}):([0-9a-fA-F]{16,}):(\d+):([A-Za-z0-9._-]+)$/.exec(message);
    const signedAddress = match?.[1];
    const nonce = match?.[2];
    const chainIdStr = match?.[3];
    const realm = match?.[4];

    // Merchants are chain-free (product rule): a login challenge/signature may be bound to ANY
    // chain this deployment currently has ENABLED — not one fixed chainId — because the same
    // merchant record works across every chain. This does not weaken replay protection: a
    // signature is still only valid for THIS deployment (LOGIN_REALM must match exactly) and only
    // for a chain THIS deployment actually recognizes right now — an unrecognized or since-
    // disabled chainId verifies against nothing, exactly like a wrong LOGIN_REALM does today. The
    // single-use nonce (consumed below) is what actually prevents replay of a captured signature,
    // independent of chain; the chainId/realm binding only prevents a signature captured on a
    // DIFFERENT deployment (or a chain this one doesn't run) from ever being presented as valid.
    const loginChain = match ? resolveChain(chainIdStr) : undefined;
    if (
      !match ||
      !signedAddress ||
      signedAddress.toLowerCase() !== address.toLowerCase() ||
      !loginChain ||
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
    // the merchant claims, verified under the CHALLENGED chain's own signing scheme.
    // recoverMessageSignerForKind throws on malformed input -> caught below -> 401.
    let recovered: string;
    try {
      recovered = recoverMessageSignerForKind(loginChain.kind, message, signature);
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

  // Attaches optional payer context (who paid / link vs checkout) to each delivery for the
  // dashboard. Missing meta (older payments, or the page never reported) → null.
  const decorateDeliveries = async (deliveries: WebhookDelivery[]) =>
    Promise.all(
      deliveries.map(async (d) => {
        const meta = await store.getOrderMeta(d.payload.data.orderId);
        if (!meta) return { ...d, meta: null };
        const link = meta.slug ? await store.getLink(meta.slug) : undefined;
        return {
          ...d,
          meta: {
            payerName: meta.customerName ?? null,
            source: meta.source,
            slug: meta.slug ?? null,
            shopName: link?.shopName ?? null,
          },
        };
      }),
    );

  app.get('/v1/me/deliveries', auth, asyncHandler(async (_req, res) => {
    const session = res.locals.session as Session;
    const deliveries = await store.listDeliveries(100);
    res.json({
      deliveries: await decorateDeliveries(
        deliveries.filter((d) => d.merchantId === session.merchantId),
      ),
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
    /** Which chain this link is denominated on — a chain slug or numeric chainId. Defaults to
     *  the default chain. A link belongs to exactly ONE chain, fixed at creation. */
    chainId: ChainIdOrSlugSchema,
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

    const chain = resolveChain(d.chainId);
    if (!chain) {
      return res.status(400).json({ error: `unknown or disabled chain "${d.chainId}"` });
    }

    // Single-pay links need exactly one orderId in the pool.
    if (!d.multiPay && d.orderPool.length !== 1) {
      return res.status(400).json({ error: 'single-pay link requires exactly one orderId in orderPool' });
    }
    // Multi-pay links need at least one pre-registered order to be useful.
    if (d.multiPay && d.orderPool.length === 0) {
      return res.status(400).json({ error: 'multi-pay link requires at least one pre-registered orderId' });
    }

    // Optional ERC-20 allowlist — this chain's own (ACCEPTED_TOKENS in legacy single-chain mode).
    // Native currency is always permitted.
    const tokenLower = d.tokenAddress.toLowerCase();
    const accepted = parseAcceptedTokens(chain.acceptedTokens);
    if (tokenLower !== ZERO_ADDRESS && accepted.size > 0 && !accepted.has(tokenLower)) {
      return res.status(400).json({ error: `token ${d.tokenAddress} is not in ACCEPTED_TOKENS` });
    }

    const slug = newSlug();
    const link: PaymentLink = {
      slug,
      chainId: chain.chainId,
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
    logger.info(
      { slug, merchantId: merchant.merchantId, chainId: chain.chainId, multiPay: d.multiPay, poolSize: d.orderPool.length },
      'payment link created',
    );
    res.status(201).json(publicLink(link, chain));
  }));

  app.get('/v1/links', auth, asyncHandler(async (req, res) => {
    const session = res.locals.session as Session;
    const merchant = await store.getMerchantById(session.merchantId);
    if (!merchant) return res.status(404).json({ error: 'merchant not found' });
    const links = (await store.listLinksForMerchant(merchant.address)).map((l) => publicLink(l, resolveChain(l.chainId)));
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
    res.json(publicLink(link, resolveChain(link.chainId)));
  }));

  // Public merchant directory (landing-page showcase). Safe fields only — never expose
  // payout addresses, webhook URLs or secrets here. Lives under /public so it can't shadow
  // the admin-only GET /v1/merchants listing below.
  app.get('/v1/merchants/public', linkLimiter, asyncHandler(async (_req, res) => {
    const merchants = (await store.listMerchants())
      .filter((m) => m.active)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, 50)
      .map((m) => ({ merchantId: m.merchantId, name: m.name, createdAt: m.createdAt }));
    res.json({ merchants });
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
    const chain = resolveChain(link.chainId);
    if (!chain) {
      return res.status(503).json({ error: 'this link\'s chain is not currently available' });
    }

    const parsed = ClaimSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid body', issues: parsed.error.issues });
    }
    let payerAddress: string;
    try {
      // The payer's wallet is chain-free too — accept either address-format convention.
      payerAddress = normalizeAddressAnyKind(parsed.data.payerAddress);
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
        chainId: link.chainId,
        merchant: normalizeAddressForKind(chain.kind, link.merchantAddress),
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
      chainId: link.chainId,
      merchant: normalizeAddressForKind(chain.kind, link.merchantAddress),
      token: link.tokenAddress,
      amount: link.amount,
      poolRemaining: link.orderPool.length,
    });
  }));

  // Qi variant of the claim: the payer isn't known until the customer opens their Qi wallet, so
  // this route reserves an orderId up front and returns its freshly-derived receive address. The
  // checkout then shows the address as a QR/copy target and polls /v1/orders/... for settlement.
  // Qi is Quai-only — returns 503 for a link whose chain isn't Quai, in addition to the existing
  // "Qi disabled on this deployment" case.
  // Returns 404 for a missing link, 503 when Qi is disabled/inapplicable or the pool is empty.
  app.post('/v1/links/:slug/qi-claim', linkLimiter, asyncHandler(async (req, res) => {
    const slug = req.params.slug ?? '';
    const link = await store.getLink(slug);
    if (!link) return res.status(404).json({ error: 'link not found' });

    if (!qiService?.enabled) {
      return res.status(503).json({ error: 'Qi payments are not enabled on this deployment' });
    }
    const chain = resolveChain(link.chainId);
    if (!chain || chain.kind !== 'quai') {
      return res.status(503).json({ error: 'Qi payments are only available for links on the Quai chain' });
    }

    // Recycle abandoned Qi reservations too: an earlier qi-claim that never received funds leaves
    // its order bound to the sentinel payer; handing the order back keeps the pool from draining.
    const recycled = await store.reclaimStaleClaim(slug, 'qi', CLAIM_STALE_MS);
    const orderId = recycled ?? (await store.reserveQiLinkOrder(slug));
    if (!orderId) {
      return res.status(503).json({ error: 'no orders available — pool exhausted; ask the merchant to add more' });
    }

    const qits = qiService.orderQits(BigInt(link.amount));
    const rec = await qiService.ensureQiOrder(orderId, link.merchantAddress, qits);
    if (!rec) {
      return res.status(500).json({ error: 'could not allocate a Qi receive address — try again' });
    }
    if (!recycled) {
      logger.info({ slug, orderId }, 'order reserved for Qi payment');
    } else {
      logger.info({ slug, orderId }, 'stale Qi reservation recycled');
    }
    res.json({
      orderId,
      chainId: link.chainId,
      merchant: normalizeAddressForKind(chain.kind, link.merchantAddress),
      amount: link.amount,
      poolRemaining: link.orderPool.length,
      qi: qiView(rec),
    });
  }));

  // --- admin ---
  const admin = express.Router();
  admin.use(requireAdmin(cfg));

  // DEV ONLY: simulate a Qi settlement reaching the required total so the full lifecycle
  // (checkout panel → settled → paid) can be demoed without sending real Cyprus-1 Qi. Refuses to
  // even load in production (config guard), and still requires the admin bearer token here.
  admin.post('/dev/qi-settle/:orderId', asyncHandler(async (req, res) => {
    if (!cfg.QI_DEV_SIMULATE) {
      return res.status(404).json({ error: 'not found' });
    }
    const orderId = (req.params.orderId ?? '').toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(orderId)) {
      return res.status(400).json({ error: 'orderId must be a 32-byte hex string' });
    }
    const rec = await store.getQiOrder(orderId);
    if (!rec) return res.status(404).json({ error: 'no Qi order for this orderId' });
    if (rec.settled) return res.json({ qi: qiView(rec), alreadySettled: true });
    const settled = await store.markQiOrderSettled(
      orderId,
      rec.qits.toString(),
      [...(rec.txHashes ?? []), DEV_FAKE_TX_HASH],
    );
    logger.info({ orderId, qits: rec.qits.toString() }, 'dev-simulated Qi settlement (QI_DEV_SIMULATE)');
    res.json({ qi: settled ? qiView(settled) : null, alreadySettled: false });
  }));

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
      // Merchants are chain-free — accept either address-format convention (see product rules).
      address = normalizeAddressAnyKind(parsed.data.address);
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
      address = normalizeAddressAnyKind(req.params.address ?? '');
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
    res.json({ deliveries: await decorateDeliveries(await store.listDeliveries(100)) });
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

  admin.get('/chains', asyncHandler(async (_req, res) => {
    res.json({ chains: await computeChainsHealth(), default: defaultChain().id });
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

/** Merchant view without the signing secret. Merchants are chain-free (product rule): the same
 *  record is valid across every configured chain, so the payout address is validated/formatted
 *  under whichever address-format rule (EIP-55 or Quai zone-checksum) accepts it — see
 *  normalizeAddressAnyKind. */
function publicMerchant(m: Merchant) {
  return {
    merchantId: m.merchantId,
    address: normalizeAddressAnyKind(m.address),
    name: m.name,
    webhookUrl: m.webhookUrl,
    active: m.active,
    createdAt: m.createdAt,
  };
}

/** Link view — omits the internal orderPool array; pool size only. Includes the link's chain
 *  (a link belongs to exactly one chain, fixed at creation) so a multi-chain dashboard can label
 *  it without a second API call. `chain` is undefined if the link's chain has since been
 *  disabled/removed — the link itself still renders, with `chain: null` and a best-effort
 *  (EIP-55) address format. */
function publicLink(l: PaymentLink, chain: ResolvedChain | undefined) {
  const kind: ChainAddressKind = chain?.kind ?? 'evm';
  return {
    slug: l.slug,
    chainId: l.chainId,
    chain: chain ? { id: chain.id, chainId: chain.chainId, kind: chain.kind, name: chain.name } : null,
    merchantAddress: normalizeAddressForKind(kind, l.merchantAddress),
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
