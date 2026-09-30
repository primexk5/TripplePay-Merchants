# quai-shopify — Pay with Quai · Shopify connector

Shopify app that turns store orders into privacy-first Pay with Quai payments.

**Flow**

1. `orders/create` fires → connector calls `POST /v1/gateway/orders` (our merchant API key) with
   `reference` = shop order id and the order total + currency.
2. The gateway returns a `checkoutUrl` (`/pay/{gatewayId}` redirects the customer there).
3. Customer pays (Qi by default → zero gas).
4. The gateway delivers `payment.confirmed` to `POST /webhooks/gateway/payment` (signed with
   `x-paywithquai-signature`, our whsec) → connector creates a `sale` transaction on the shop
   order via the Admin API → the order shows as paid in Shopify.

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

Dev-only caveats

- Sessions/pending payments persist to a local JSON file (`STORE_PATH`). Switch to Postgres
  before real traffic.
- OAuth `state` is not persisted; fine for a starter, add a signed/state store before production.
- Delivery, the gateway webhook, and Shopify's webhook must be HTTPS. Use `ngrok`/`cloudflared`
  during local development.
- The merchant must enable `USD` (or the quoted currency) and set a markup in the gateway before
  orders will quote successfully.