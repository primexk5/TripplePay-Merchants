import express, { type Request, type Response, type NextFunction } from 'express';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { FileStore } from './store.js';
import { AdminApi, buildInstallUrl, exchangeCodeForToken, isShopDomain, verifyOAuthCallback, verifyShopifyWebhook, type ShopifyOrder } from './shopify.js';
import { GatewayClient, verifyGatewayWebhook, type PaymentWebhook } from './gateway.js';
import { log } from './logger.js';

export const SIGNATURE_HEADER = 'x-paywithquai-signature';

export function createApp(cfg: ReturnType<typeof loadConfig>) {
  const logger = log('app');
  const store = new FileStore(cfg.STORE_PATH);
  const gateway = new GatewayClient(cfg.GATEWAY_BASE_URL, cfg.GATEWAY_MERCHANT_KEY);

  const app = express();
  app.disable('x-powered-by');

  // Raw body capture where verification depends on the exact bytes received.
  app.use('/webhooks', express.raw({ type: () => true, limit: '1mb' }));
  app.use(express.json({ limit: '256kb' }));

  const redirectUri = `${cfg.SHOPIFY_APP_URL.replace(/\/+$/, '')}/auth/callback`;

  app.get('/', (_req, res) => {
    res.type('html').send(
      `<h1>Pay with Quai · Shopify</h1>
       <form method="get" action="/auth">
         <label>Store domain <input name="shop" placeholder="my-store.myshopify.com" required></label>
         <button type="submit">Install</button>
       </form>`,
    );
  });

  app.get('/auth', (req, res) => {
    const shop = String(req.query.shop ?? '').toLowerCase();
    if (!isShopDomain(shop)) return res.status(400).send('invalid shop domain');
    const state = randomBytes(16).toString('hex');
    // Persist the state so /auth/callback can prove this install round-tripped through us. Without
    // this the callback only checks that `state` was *present*, leaving the install open to CSRF.
    store.putState({ state, shop, createdAt: Date.now() });
    res.redirect(buildInstallUrl(shop, cfg.SHOPIFY_API_KEY, cfg.SHOPIFY_SCOPES, redirectUri, state));
  });

  app.get('/auth/callback', asyncHandler(async (req, res) => {
    const query = req.query as Record<string, string>;
    if (!verifyOAuthCallback(query, cfg.SHOPIFY_API_SECRET)) {
      return res.status(401).send('OAuth verification failed');
    }
    const shop = String(query['shop'] ?? '').toLowerCase();
    if (!isShopDomain(shop)) return res.status(400).send('invalid shop domain');

    // Single-use, shop-bound, time-boxed. Consumed BEFORE the token exchange so a replayed callback
    // URL cannot mint a second token even if the first exchange failed.
    const issued = store.consumeState(String(query['state'] ?? ''), shop);
    if (!issued) {
      logger.warn({ shop }, 'OAuth state unknown, already used, or issued for another shop');
      return res.status(401).send('OAuth state invalid or already used — restart the install');
    }
    if (Date.now() - issued.createdAt > cfg.OAUTH_STATE_TTL_MS) {
      logger.warn({ shop, ageMs: Date.now() - issued.createdAt }, 'OAuth install expired before callback');
      return res.status(401).send('OAuth install expired — restart the install');
    }

    const accessToken = await exchangeCodeForToken(shop, query['code'] as string, cfg.SHOPIFY_API_KEY, cfg.SHOPIFY_API_SECRET);
    store.setSession({ shop, accessToken, installedAt: Date.now(), scopes: cfg.SHOPIFY_SCOPES });
    res.type('html').send(`<h1>Installed</h1><p>Pay with Quai is connected to ${shop}.</p>`);
  }));

  app.post('/webhooks/shopify/orders/create', asyncHandler(async (req, res) => {
    const raw = (req as Request & { body: Buffer | string }).body;
    const rawBody = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : '';
    if (!verifyShopifyWebhook(rawBody, req.header('x-shopify-hmac-sha256'), cfg.SHOPIFY_API_SECRET)) {
      return res.status(401).json({ error: 'invalid signature' });
    }
    const shop = String(req.header('x-shopify-shop-domain') ?? '').toLowerCase();
    const session = store.getSession(shop);
    if (!session) return res.status(200).end();
    const order = (JSON.parse(rawBody) as { order?: ShopifyOrder }).order;
    if (!order) return res.status(200).end();
    if (!order.total_price || Number(order.total_price) <= 0) return res.status(200).end();

    const fiatCurrency = order.currency ?? cfg.GATEWAY_FIAT_CURRENCY;
    const admin = new AdminApi(session.shop, session.accessToken);

    // Idempotency. Shopify retries orders/create whenever it doesn't get a fast 2xx, and every
    // retry would otherwise mint another gateway order for the same shop order — double-quoting and
    // double-charging the customer. Reuse the existing gateway order instead. (Re-writing the
    // metafields below is itself idempotent, so a retry also repairs a failed first attempt.)
    const existing = store.getPendingForShopOrder(shop, order.id);
    if (existing && existing.status !== 'expired') {
      logger.info({ shop, orderId: order.id, gatewayId: existing.gatewayId, status: existing.status }, 'orders/create retry — reusing gateway order');
      try {
        await admin.setOrderPaymentFields(order.id, {
          paymentUrl: existing.checkoutUrl,
          gatewayId: existing.gatewayId,
          quotedAmount: existing.amount,
          fiatCurrency: existing.fiatCurrency,
          asset: existing.asset,
          expiresAt: existing.expiresAt,
        });
      } catch (err) {
        logger.error({ err, shop, orderId: order.id }, 'failed to refresh payment metafields on retry');
      }
      return res.json({ received: true, gatewayId: existing.gatewayId, duplicate: true });
    }

    const created = await gateway.createOrder({
      amount: order.total_price,
      fiatCurrency,
      reference: String(order.id),
      token: 'qi',
      expiresInSecs: 1800,
    });
    store.upsertPending({
      gatewayId: created.gatewayId,
      shop,
      orderId: order.id,
      checkoutUrl: created.checkoutUrl,
      amount: created.quote.quaiDisplay,
      fiatCurrency,
      asset: created.token,
      status: 'awaiting',
      createdAt: Date.now(),
      // Trust the gateway's own expiry rather than re-deriving it from expiresInSecs.
      expiresAt: created.expiresAt,
    });

    // Publish the payment link onto the order so a theme snippet can render it for the customer.
    // A failure here must NOT fail the webhook: doing so would make Shopify retry, and the retry
    // guard above would then reuse this gateway order — but the merchant would get a noisy retry
    // for a link that already exists. The pending record above is the source of truth either way.
    try {
      await admin.setOrderPaymentFields(order.id, {
        paymentUrl: created.checkoutUrl,
        gatewayId: created.gatewayId,
        quotedAmount: created.quote.quaiDisplay,
        fiatCurrency,
        asset: created.token,
        expiresAt: created.expiresAt,
      });
    } catch (err) {
      logger.error(
        { err, shop, orderId: order.id, gatewayId: created.gatewayId },
        'could not write payment metafields — add the snippet and check the connector log for this checkoutUrl',
      );
    }

    logger.info({ shop, orderId: order.id, gatewayId: created.gatewayId, checkoutUrl: created.checkoutUrl }, 'gateway order created for shop order');
    res.json({ received: true, gatewayId: created.gatewayId });
  }));

  app.get('/pay/:gatewayId', asyncHandler(async (req, res) => {
    const pending = store.getPending(req.params.gatewayId as string);
    if (!pending) return res.status(404).send('payment not found');
    res.redirect(pending.checkoutUrl);
  }));

  app.post('/webhooks/gateway/payment', asyncHandler(async (req, res) => {
    const raw = (req as Request & { body: Buffer | string }).body;
    const rawBody = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : '';
    if (!verifyGatewayWebhook(cfg.GATEWAY_WEBHOOK_SECRET, req.header(SIGNATURE_HEADER), rawBody, Math.floor(Date.now() / 1000))) {
      return res.status(401).json({ error: 'invalid signature' });
    }
const payload = JSON.parse(rawBody) as PaymentWebhook;
    if (payload.type !== 'payment.confirmed' || !payload.data.reference) return res.status(204).end();
    const orderId = Number(payload.data.reference);
    const pending = store.getPendingForOrder(orderId);
    if (!pending) return res.status(204).end();
    if (pending.status === 'paid') return res.status(204).end();

    const session = store.getSession(pending.shop);
    if (!session) return res.status(204).end();
    const admin = new AdminApi(session.shop, session.accessToken);

    // Funds already landed on-chain, so the order is marked paid either way — the merchant should
    // never be left short just because our quote bookkeeping lapsed. A payment arriving after the
    // quote expired is not expected (the router enforces expiry), so log it loudly if it happens.
    const late = pending.status === 'expired' || pending.expiresAt <= Date.now();
    if (late) {
      logger.warn(
        { shop: pending.shop, orderId, gatewayId: pending.gatewayId, expiredAt: pending.expiresAt },
        'payment confirmed after the gateway quote expired — marking order paid anyway (funds received)',
      );
    }

    await admin.markOrderPaid(pending.orderId, payload.data.token ?? 'quai');
    store.markPaid(pending.gatewayId);
    // Drop the pay button now that the order is settled.
    await admin.clearOrderPaymentUrl(pending.orderId).catch(() => undefined);
    logger.info({ shop: pending.shop, orderId, gatewayId: pending.gatewayId, late }, 'shop order marked paid by gateway');
    res.status(204).end();
  }));

  // Reconcile lapsed quotes. Without this a payment link that timed out stayed `awaiting` forever
  // and its button kept rendering on the order, inviting a customer to click a dead link. Runs on
  // an unref'd interval so it never holds the process open on shutdown.
  const sweeper = setInterval(() => {
    try {
      const pruned = store.pruneStates(cfg.OAUTH_STATE_TTL_MS);
      if (pruned) logger.debug?.({ pruned }, 'pruned stale OAuth states');
      const expired = store.sweepExpired();
      if (expired) logger.info({ expired }, 'gateway quotes expired since last sweep');
    } catch (err) {
      logger.error({ err }, 'expiry sweep failed');
    }
  }, cfg.EXPIRY_SWEEP_INTERVAL_MS);
  sweeper.unref();


  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as { status?: number; message?: string };
    logger.error({ err }, 'unhandled connector error');
    const status = typeof e?.status === 'number' && e.status >= 400 && e.status < 500 ? e.status : 500;
    res.status(status).json({ error: e?.message ?? 'internal error' });
  });

  return app;
}

function asyncHandler(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = loadConfig();
  const app = createApp(cfg);
  app.listen(cfg.PORT, () => log('app').info({ port: cfg.PORT }, 'quai-shopify connector listening'));
}