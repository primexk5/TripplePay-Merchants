import express, { type Request, type Response, type NextFunction } from 'express';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { createStore } from './store/factory.js';
import { FileStore } from './store/file.js';
import { CredentialResolver } from './store/credentials.js';
import type { ConnectorStore } from './store/index.js';
import { AdminApi, buildInstallUrl, exchangeCodeForToken, isShopDomain, verifyOAuthCallback, verifySessionToken, verifyShopifyWebhook, type ShopifyOrder } from './shopify.js';
import { verifyGatewayWebhook, type PaymentWebhook } from './gateway.js';
import { log } from './logger.js';

export const SIGNATURE_HEADER = 'x-paywithquai-signature';

export interface AppDeps {
  /** Injected by tests; production builds one from the config. */
  store?: ConnectorStore;
}

export function createApp(cfg: ReturnType<typeof loadConfig>, deps: AppDeps = {}) {
  const logger = log('app');
  const store = deps.store ?? new FileStore(cfg.STORE_PATH);
  const creds = new CredentialResolver(store, cfg);

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
       </form>
       <p><a href="/settings">Connect your Pay with Quai account</a></p>`,
    );
  });

  // --- per-store gateway credentials -------------------------------------------------------
  //
  // Without this, every store on the connector bills to the one GATEWAY_MERCHANT_KEY in the
  // environment. The merchant pastes the API key and webhook secret issued to them by the backend
  // (POST /v1/me/apikeys), and they are sealed with AES-256-GCM before they touch storage.
  //
  // AUTH: both writes below require a Shopify session token whose `dest` is the shop being changed.
  // The install-session check alone is NOT enough — it only proves the app is installed on that
  // shop, and shop domains are public, so anyone who learned the app URL could otherwise repoint a
  // real store's orders at a merchant account they control.

  app.get('/settings', (_req, res) => {
    // App Bridge is what can mint a session token; it only runs inside the Shopify admin iframe.
    res.type('html').send(
      `<!doctype html><html><head><meta charset="utf-8"><title>Connect your Pay with Quai account</title>
       <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script></head>
       <body>
       <h1>Connect your Pay with Quai account</h1>
       <p>Issue an API key from your Pay with Quai dashboard (<code>POST /v1/me/apikeys</code>) and
          paste it below. It is shown only once, and is stored encrypted.</p>
       <form id="f" method="post" action="/settings">
         <input type="hidden" name="sessionToken" id="st">
         <label>Store domain <input name="shop" id="shop" placeholder="my-store.myshopify.com" required></label>
         <label>Merchant API key <input name="merchantKey" type="password" required></label>
         <label>Webhook secret <input name="webhookSecret" type="password" required></label>
         <button type="submit">Save</button>
       </form>
       <p id="msg"></p>
       <script>
         // The shop domain travels in the admin origin; App Bridge hands us the session token that
         // proves the caller is an authenticated admin of exactly that shop.
         document.getElementById('shop').value = new URLSearchParams(location.search).get('shop') || '';
         (async () => {
           const msg = document.getElementById('msg');
           try {
             const token = await window.shopify.getSessionToken();
             document.getElementById('st').value = token;
           } catch (e) {
             msg.textContent = 'Open this page from your Shopify admin — a session token is required.';
           }
           document.getElementById('f').addEventListener('submit', (e) => {
             if (!document.getElementById('st').value) {
               e.preventDefault();
               msg.textContent = 'Open this page from your Shopify admin — a session token is required.';
             }
           });
         })();
       </script>
       </body></html>`,
    );
  });

  app.post('/settings', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
    const body = req.body as Record<string, string>;
    const shop = String(body.shop ?? '').trim().toLowerCase();
    const merchantKey = String(body.merchantKey ?? '').trim();
    const webhookSecret = String(body.webhookSecret ?? '').trim();
    if (!isShopDomain(shop)) return res.status(400).send('invalid shop domain');
    if (!merchantKey || !webhookSecret) return res.status(400).send('both credentials are required');

    // The caller must be an authenticated admin of THIS shop.
    if (!verifySessionToken(body.sessionToken, shop, cfg.SHOPIFY_API_KEY, cfg.SHOPIFY_API_SECRET)) {
      logger.warn({ shop }, 'settings write rejected — missing or invalid session token');
      return res.status(401).send('invalid or missing Shopify session token — open this page from your Shopify admin');
    }

    // Refuse credentials for a store that has not installed the app. Otherwise anyone who can reach
    // this endpoint could bind an arbitrary shop's orders to a merchant account they control.
    const session = await store.getSession(shop);
    if (!session) {
      logger.warn({ shop }, 'credentials submitted for a store that has not installed the app');
      return res.status(403).send('install the app on this store before saving credentials');
    }

    const sealed = creds.seal(merchantKey, webhookSecret);
    await store.putSettings({ shop, ...sealed, configuredAt: Date.now() });
    logger.info({ shop }, 'store gateway credentials saved');
    res.type('html').send('<h1>Saved</h1><p>Orders from this store will bill to your own Pay with Quai account.</p>');
  }));

  app.post('/settings/clear', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
    const shop = String((req.body as Record<string, string>).shop ?? '').trim().toLowerCase();
    if (!isShopDomain(shop)) return res.status(400).send('invalid shop domain');
    if (!verifySessionToken((req.body as Record<string, string>).sessionToken, shop, cfg.SHOPIFY_API_KEY, cfg.SHOPIFY_API_SECRET)) {
      logger.warn({ shop }, 'settings clear rejected — missing or invalid session token');
      return res.status(401).send('invalid or missing Shopify session token — open this page from your Shopify admin');
    }
    const session = await store.getSession(shop);
    if (!session) return res.status(403).send('install the app on this store first');
    await store.clearSettings(shop);
    logger.info({ shop }, 'store gateway credentials cleared — falling back to the shared key');
    res.type('html').send('<h1>Cleared</h1><p>This store now uses the connector-wide credentials.</p>');
  }));

  app.get('/auth', asyncHandler(async (req, res) => {
    const shop = String(req.query.shop ?? '').toLowerCase();
    if (!isShopDomain(shop)) return res.status(400).send('invalid shop domain');
    const state = randomBytes(16).toString('hex');
    // Persist the state so /auth/callback can prove this install round-tripped through us. Without
    // this the callback only checks that `state` was *present*, leaving the install open to CSRF.
    // Awaited deliberately: redirecting to Shopify before the write lands would hand out a state the
    // callback cannot find, failing the install for no reason the merchant could act on.
    try {
      await store.putState({ state, shop, createdAt: Date.now() });
    } catch (err) {
      logger.error({ err, shop }, 'could not persist OAuth state — refusing to start an install we cannot verify');
      return res.status(500).send('could not start the install, please retry');
    }
    res.redirect(buildInstallUrl(shop, cfg.SHOPIFY_API_KEY, cfg.SHOPIFY_SCOPES, redirectUri, state));
  }));

  app.get('/auth/callback', asyncHandler(async (req, res) => {
    const query = req.query as Record<string, string>;
    if (!verifyOAuthCallback(query, cfg.SHOPIFY_API_SECRET)) {
      return res.status(401).send('OAuth verification failed');
    }
    const shop = String(query['shop'] ?? '').toLowerCase();
    if (!isShopDomain(shop)) return res.status(400).send('invalid shop domain');

    // Single-use, shop-bound, time-boxed. Consumed BEFORE the token exchange so a replayed callback
    // URL cannot mint a second token even if the first exchange failed.
    const issued = await store.consumeState(String(query['state'] ?? ''), shop);
    if (!issued) {
      logger.warn({ shop }, 'OAuth state unknown, already used, or issued for another shop');
      return res.status(401).send('OAuth state invalid or already used — restart the install');
    }
    if (Date.now() - issued.createdAt > cfg.OAUTH_STATE_TTL_MS) {
      logger.warn({ shop, ageMs: Date.now() - issued.createdAt }, 'OAuth install expired before callback');
      return res.status(401).send('OAuth install expired — restart the install');
    }

    const accessToken = await exchangeCodeForToken(shop, query['code'] as string, cfg.SHOPIFY_API_KEY, cfg.SHOPIFY_API_SECRET);
    await store.setSession({ shop, accessToken, installedAt: Date.now(), scopes: cfg.SHOPIFY_SCOPES });
    res.type('html').send(`<h1>Installed</h1><p>Pay with Quai is connected to ${shop}.</p>`);
  }));

  app.post('/webhooks/shopify/orders/create', asyncHandler(async (req, res) => {
    const raw = (req as Request & { body: Buffer | string }).body;
    const rawBody = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : '';
    if (!verifyShopifyWebhook(rawBody, req.header('x-shopify-hmac-sha256'), cfg.SHOPIFY_API_SECRET)) {
      return res.status(401).json({ error: 'invalid signature' });
    }
    const shop = String(req.header('x-shopify-shop-domain') ?? '').toLowerCase();
    const session = await store.getSession(shop);
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
    const existing = await store.getPendingForShopOrder(shop, order.id);
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

    const gateway = await creds.client(shop);
    if (!gateway) {
      logger.error({ shop, orderId: order.id }, 'no gateway credentials for this store — skipping order');
      return res.status(200).json({ received: false, reason: 'no gateway credentials configured' });
    }
    const created = await gateway.createOrder({
      amount: order.total_price,
      fiatCurrency,
      reference: String(order.id),
      token: 'qi',
      expiresInSecs: 1800,
    });
    await store.upsertPending({
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
    const pending = await store.getPending(req.params.gatewayId as string);
    if (!pending) return res.status(404).send('payment not found');
    res.redirect(pending.checkoutUrl);
  }));

  app.post('/webhooks/gateway/payment', asyncHandler(async (req, res) => {
    const raw = (req as Request & { body: Buffer | string }).body;
    const rawBody = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : '';

    // Each store has its own webhook secret, and the incoming payload does not say which one to use.
    // So we resolve the owning store from the (unverified) reference purely to *select* which secret
    // to check against, then verify before touching anything. Selecting a key is not acting on the
    // payload: a forged body can only ever cause us to compute an HMAC that fails. Falling back to
    // the shared env secret covers an unconfigured store and any pre-existing deployment.
    const payload = parseWebhook(rawBody);
    if (!payload) return res.status(400).json({ error: 'malformed body' });
    const orderId = Number(payload.data?.reference);
    const pending = Number.isFinite(orderId) ? await store.getPendingForOrder(orderId) : undefined;

    let secret: string | undefined;
    if (pending) secret = (await creds.resolve(pending.shop))?.webhookSecret;
    secret ??= cfg.GATEWAY_WEBHOOK_SECRET;

    // No secret means there is nothing to verify against — refuse rather than trust the payload.
    if (!secret || !verifyGatewayWebhook(secret, req.header(SIGNATURE_HEADER), rawBody, Math.floor(Date.now() / 1000))) {
      return res.status(401).json({ error: 'invalid signature' });
    }

    if (payload.type !== 'payment.confirmed' || !payload.data?.reference) return res.status(204).end();
    if (!pending) return res.status(204).end();
    if (pending.status === 'paid') return res.status(204).end();

    const session = await store.getSession(pending.shop);
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
    await store.markPaid(pending.gatewayId);
    // Drop the pay button now that the order is settled.
    await admin.clearOrderPaymentUrl(pending.orderId).catch(() => undefined);
    logger.info({ shop: pending.shop, orderId, gatewayId: pending.gatewayId, late }, 'shop order marked paid by gateway');
    res.status(204).end();
  }));

  // Reconcile lapsed quotes. Without this a payment link that timed out stayed `awaiting` forever
  // and its button kept rendering on the order, inviting a customer to click a dead link. Runs on
  // an unref'd interval so it never holds the process open on shutdown.
  const sweeper = setInterval(() => {
    void (async () => {
    try {
      const pruned = await store.pruneStates(cfg.OAUTH_STATE_TTL_MS);
      if (pruned) logger.debug?.({ pruned }, 'pruned stale OAuth states');
      const expired = await store.sweepExpired();
      if (expired) logger.info({ expired }, 'gateway quotes expired since last sweep');
    } catch (err) {
      logger.error({ err }, 'expiry sweep failed');
    }
    })();
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

/** A malformed body must not throw its way into the 500 handler — and must never be parsed
 *  before signature verification in any handler that depends on the exact bytes. */
function parseWebhook(rawBody: string): PaymentWebhook | undefined {
  try {
    const parsed = JSON.parse(rawBody) as PaymentWebhook;
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
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