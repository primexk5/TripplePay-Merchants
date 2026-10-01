# quai-shopify — Pay with Quai · Shopify connector

Shopify app that turns store orders into privacy-first Pay with Quai payments.

**Flow**

1. `orders/create` fires → connector calls `POST /v1/gateway/orders` (our merchant API key) with
   `reference` = shop order id and the order total + currency.
2. The gateway returns a `checkoutUrl` (`/pay/{gatewayId}` redirects the customer there).
3. The connector writes that link onto the order as the `quai.payment_url` metafield — **this is
   what puts the link in front of the customer**, via the theme snippet (below).
4. Customer pays (Qi by default → zero gas).
5. The gateway delivers `payment.confirmed` to `POST /webhooks/gateway/payment` (signed with
    `x-paywithquai-signature`, our whsec) → connector creates a `sale` transaction on the shop
    order via the Admin API → the order shows as paid in Shopify, and the `quai.payment_url`
    metafield is deleted so the button disappears.

## Showing the payment link to the customer

The connector writes these metafields onto the order:

| Metafield | Purpose |
|---|---|
| `quai.payment_url` | the checkout link (the button) |
| `quai.quoted_amount` | crypto amount quoted at order creation |
| `quai.payment_asset` | `qi` or the chain's native symbol |
| `quai.fiat_currency` | currency the order was priced in |
| `quai.expires_at` | when the quote lapses |

Render them with the bundled snippet — **Online Store → Theme code editor → Snippets → Add a new
snippet**, paste `snippets/pay-with-quai.liquid` into it, then drop this anywhere the customer
needs to pay (the order status page is the usual spot):

```liquid
{% render 'pay-with-quai' %}
```

The snippet renders nothing unless there is a live link *and* the order is still unpaid, so it is
safe to leave in a layout permanently — no conditional logic needed on your side. It also hides
itself once the financial status is `paid`/`refunded`, so a leftover metafield can't show a dead
button.

> The quoted amount is a snapshot taken when the order was created, not a live price. If a quote
> expires, have the customer ask the store to re-issue the link.


**Get started**

1. `npm install`, then `cp .env.example .env` and fill it in.
2. Shopify Partner account → **Apps → Create app** (public or custom). Copy `API key` and `API
   secret` into `.env`. Under app settings, set the OAuth redirect URL to
   `https://<SHOPIFY_APP_URL>/auth/callback`, add the `read_orders, write_orders` scopes, and
   subscribe to the **`orders/create`** webhook with the subscription URL
   `https://<SHOPIFY_APP_URL>/webhooks/shopify/orders/create` (API version 2024-10).
3. Point `GATEWAY_BASE_URL` at the Pay with Quai backend. For a real deployment also set
   `DATABASE_URL` and `CONNECTOR_ENCRYPTION_KEY` (see [Configuration](#configuration)).
4. `npm run dev` → open `/` → enter a dev store domain → **Install**.
4b. Open `/settings`, enter that store's own dev store domain, and paste its Pay with Quai
    credentials (see below).
5. Trigger `orders/create` (create + pay-with-draft a test order) and watch the connector create a
   gateway order, then mark it paid after the Qi/QUAI payment settles.
6. Add the theme snippet (above) to your theme so the payment button appears on the order.

## Per-store credentials

Without per-store credentials the connector falls back to a single `GATEWAY_MERCHANT_KEY` shared by
every store — which means every store's orders bill to the *same* merchant account. That is
single-tenant, and is kept only so an existing deployment keeps working through the migration.

To run multiple stores, each merchant issues their own key from the Pay with Quai backend
(`POST /v1/me/apikeys`, returned exactly once) and enters it, along with their webhook secret, at
**`/settings`**. From then on:

- `orders/create` from that shop creates gateway orders signed with that store's key, so funds land
  in that merchant's own account.
- inbound `payment.confirmed` webhooks for that shop are verified against that store's secret.

The pair is sealed with **AES-256-GCM** under `CONNECTOR_ENCRYPTION_KEY` before it touches storage,
and is decrypted only for the duration of one request. A stolen `shop_settings` table therefore
yields ciphertext, not usable credentials.

Credentials can only be saved for a store that has actually installed the app — otherwise anyone who
could reach `/settings` could point an arbitrary shop's orders at a merchant account they control.

### Gateway webhook verification

Each store has its own webhook secret, and an incoming payload does not say which one to use. The
connector resolves the owning store from the (unverified) `reference` **only to select which secret
to check against**, then verifies before mutating anything. Selecting a key is not acting on the
payload: a forged body can at worst cause an HMAC that fails. If no secret can be resolved the
request is refused rather than trusted.

## Configuration

| Variable | Required | Notes |
|---|---|---|
| `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` | yes | Partner Dashboard → app credentials |
| `SHOPIFY_APP_URL` | yes | must match the app's OAuth redirect URL |
| `GATEWAY_BASE_URL` | yes | the Pay with Quai backend |
| `DATABASE_URL` | **production** | without it the connector uses a JSON file and loses access tokens on restart |
| `CONNECTOR_ENCRYPTION_KEY` | **production** | AES-256-GCM key for stored store credentials; stable across restarts |
| `GATEWAY_MERCHANT_KEY` / `GATEWAY_WEBHOOK_SECRET` | no | legacy shared fallback, single-tenant only |
| `OAUTH_STATE_TTL_MS` | no | OAuth state lifetime (default 10m) |
| `EXPIRY_SWEEP_INTERVAL_MS` | no | how often lapsed quotes are reconciled (default 30s) |
| `STORE_PATH` | no | JSON-file location when `DATABASE_URL` is unset |

`NODE_ENV=production` refuses to boot without `CONNECTOR_ENCRYPTION_KEY`, because the fallback key
is a constant compiled into the source.

## Tests

```bash
npm test                                    # unit + HTTP, no database needed
TEST_DATABASE_URL=postgres://…  npm test     # also runs the Postgres parity suite
```

## Dev-only caveats
- `orders/create` is idempotent — Shopify retries that webhook, and a retry reuses the existing
  gateway order instead of quoting the customer twice.
- OAuth `state` is issued, stored, and verified on the callback (single-use, shop-bound, and
  time-boxed by `OAUTH_STATE_TTL_MS`), so the install round-trip is CSRF-protected. On the JSON-file
  store, states do not survive a restart — an install interrupted by a deploy just needs restarting.
- Delivery, the gateway webhook, and Shopify's webhook must be HTTPS. Use `ngrok`/`cloudflared`
  during local development.
- The merchant must enable `USD` (or the quoted currency) and set a markup in the gateway before
  orders will quote successfully.
