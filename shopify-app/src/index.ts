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
    res.redirect(buildInstallUrl(shop, cfg.SHOPIFY_API_KEY, cfg.SHOPIFY_SCOPES, redirectUri, state));
  });

  app.get('/auth/callback', asyncHandler(async (req, res) => {
    const query = req.query as Record<string, string>;
    if (!verifyOAuthCallback(query, cfg.SHOPIFY_API_SECRET)) {
      return res.status(401).send('OAuth verification failed');
    }
    const shop = String(query['shop'] ?? '').toLowerCase();
    if (!isShopDomain(shop)) return res.status(400).send('invalid shop domain');
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

    const created = await gateway.createOrder({
      amount: order.total_price,
      fiatCurrency: order.currency ?? cfg.GATEWAY_FIAT_CURRENCY,
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
      fiatCurrency: order.currency ?? cfg.GATEWAY_FIAT_CURRENCY,
      status: 'awaiting',
      createdAt: Date.now(),
    });
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
    await admin.markOrderPaid(pending.orderId, payload.data.token ?? 'quai');
    store.markPaid(pending.gatewayId);
    logger.info({ shop: pending.shop, orderId: pending.orderId, gatewayId: pending.gatewayId }, 'shop order marked paid by gateway');
    res.status(204).end();
  }));

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