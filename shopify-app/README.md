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
3. Point `GATEWAY_BASE_URL` at the Pay with Quai backend and `GATEWAY_MERCHANT_KEY` /
   `GATEWAY_WEBHOOK_SECRET` at the merchant's credentials.
4. `npm run dev` → open `/` → enter a dev store domain → **Install**.
5. Trigger `orders/create` (create + pay-with-draft a test order) and watch the connector create a
   gateway order, then mark it paid after the Qi/QUAI payment settles.
6. Add the theme snippet (above) to your theme so the payment button appears on the order.

Dev-only caveats

- Sessions/pending payments persist to a local JSON file (`STORE_PATH`). Switch to Postgres
  before real traffic.
- `orders/create` is idempotent — Shopify retries that webhook, and a retry reuses the existing
  gateway order instead of quoting the customer twice.
- OAuth `state` is issued, stored, and verified on the callback (single-use, shop-bound, and
  time-boxed by `OAUTH_STATE_TTL_MS`), so the install round-trip is CSRF-protected. The store is
  still a JSON file, so states do not survive a restart — an install interrupted by a deploy just
  needs to be restarted.
- Delivery, the gateway webhook, and Shopify's webhook must be HTTPS. Use `ngrok`/`cloudflared`
  during local development.
- The merchant must enable `USD` (or the quoted currency) and set a markup in the gateway before
  orders will quote successfully.
