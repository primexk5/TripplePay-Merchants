import { createHmac, timingSafeEqual } from 'node:crypto';
import { log } from './logger.js';

export const SHOPIFY_API_VERSION = '2024-10';
const logger = log('shopify');

export function isShopDomain(host: string): boolean {
  return /^[a-z0-9-]+\.myshopify\.(com|io|test)$/i.test(host) || /^localhost:\d+$/i.test(host);
}

export function buildInstallUrl(shop: string, apiKey: string, scopes: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: apiKey,
    scope: scopes,
    redirect_uri: redirectUri,
    state,
  });
  return `https://${shop}/admin/oauth/authorize?${params.toString()}`;
}

export function verifyOAuthCallback(query: Record<string, string>, secret: string): boolean {
  const { code, shop, timestamp, state } = query;
  const hmac = query['hmac'];
  if (!code || !shop || !timestamp || !hmac || !state) return false;
  const message = Object.entries(query)
    .filter(([k]) => k !== 'hmac')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const expected = createHmac('sha256', secret).update(message).digest('hex');
  if (!/^[0-9a-fA-F]{64}$/.test(hmac)) return false;
  const received = Buffer.from(hmac, 'hex');
  const want = Buffer.from(expected, 'hex');
  return received.length === want.length && timingSafeEqual(received, want);
}

export async function exchangeCodeForToken(shop: string, code: string, apiKey: string, secret: string): Promise<string> {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: apiKey, client_secret: secret, code }),
  });
  if (!res.ok) {
    throw new Error(`token exchange failed: ${res.status}`);
  }
  const body = (await res.json()) as { access_token?: string; scope?: string };
  if (!body.access_token) throw new Error('token exchange returned no access_token');
  logger.info({ shop }, 'OAuth token exchanged');
  return body.access_token;
}

export function verifyShopifyWebhook(rawBody: string, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  if (!/^[0-9a-fA-F]{64}$/.test(header)) return false;
  const received = Buffer.from(header, 'hex');
  const want = Buffer.from(expected, 'hex');
  return received.length === want.length && timingSafeEqual(received, want);
}

const b64u = (input: Buffer | string): string => Buffer.from(input).toString('base64url');
const fromB64u = (input: string): Buffer => Buffer.from(input, 'base64url');

/** Clock skew tolerated when checking a session token's nbf/exp, in seconds. */
const SESSION_TOKEN_SKEW_SEC = 60;

/**
 * Verify a Shopify **session token** — the JWT App Bridge mints for every embedded-app request,
 * signed with the app's client secret.
 *
 * Why this exists: `/settings` writes (and clears) the gateway credentials that decide which
 * merchant account a shop's orders bill to. The install-session check alone only proves the app is
 * installed on that shop — not that the caller is that shop's admin. Since shop domains are public
 * and the app URL is public, anyone could POST to it and repoint a real store's payments at an
 * account they control. A session token is the only thing that ties the request to an authenticated
 * admin of that specific shop.
 *
 * Checks, all of which must pass: HS256 signature (constant-time), `dest` host === the shop being
 * modified, `iss`/`aud` === the app API key, and `exp`/`nbf` within skew. Returns false rather than
 * throwing on anything malformed — callers treat false as "reject the request".
 */
export function verifySessionToken(
  token: unknown,
  shop: string,
  apiKey: string,
  secret: string,
  nowMs: number = Date.now(),
): boolean {
  if (typeof token !== 'string' || !token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(fromB64u(headerB64).toString('utf8')) as { alg?: string };
  } catch {
    return false;
  }
  // Pinning alg is what stops an attacker swapping in "alg": "none" and shipping an unsigned token.
  if (header.alg !== 'HS256') return false;

  const want = createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest();
  let received: Buffer;
  try {
    received = fromB64u(sigB64);
  } catch {
    return false;
  }
  if (received.length !== want.length || !timingSafeEqual(received, want)) return false;

  let claims: { dest?: string; iss?: string; aud?: string | string[]; exp?: number; nbf?: number };
  try {
    claims = JSON.parse(fromB64u(payloadB64).toString('utf8')) as typeof claims;
  } catch {
    return false;
  }

  // dest is the admin origin the token was minted for, e.g. https://my-store.myshopify.com.
  // Compare hosts only: the scheme is Shopify's, not ours to assert.
  let destHost = '';
  try {
    destHost = new URL(String(claims.dest ?? '')).host.toLowerCase();
  } catch {
    return false;
  }
  if (destHost !== shop.toLowerCase()) return false;

  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== apiKey || !aud.includes(apiKey)) return false;

  const nowSec = Math.floor(nowMs / 1000);
  if (typeof claims.exp === 'number' && nowSec > claims.exp + SESSION_TOKEN_SKEW_SEC) return false;
  if (typeof claims.nbf === 'number' && nowSec + SESSION_TOKEN_SKEW_SEC < claims.nbf) return false;
  return true;
}

/** Mint a session token. Only used by tests and by the embedded settings page's own test path. */
export function signSessionToken(
  claims: Record<string, unknown>,
  secret: string,
  header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' },
): string {
  const h = b64u(JSON.stringify(header));
  const p = b64u(JSON.stringify(claims));
  const sig = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  return `${h}.${p}.${sig.toString('base64url')}`;
}

export class AdminApi {
  constructor(
    private readonly shop: string,
    private readonly accessToken: string,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T | undefined> {
    const res = await fetch(`https://${this.shop}/admin/api/${SHOPIFY_API_VERSION}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-shopify-access-token': this.accessToken,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`shopify admin ${method} ${path} failed: ${res.status} ${text.slice(0, 200)}`);
    }
    if (res.status === 204) return undefined;
    return (await res.json()) as T;
  }

  async getOrder(orderId: number): Promise<OrderInfo | undefined> {
    const res = await this.request<{ order: ShopifyOrder }>('GET', `/orders/${orderId}.json`);
    return res ? toOrderInfo(res.order) : undefined;
  }

  async markOrderPaid(orderId: number, source = 'quai'): Promise<void> {
    await this.request('POST', `/orders/${orderId}/transactions.json`, {
      transaction: { kind: 'sale', status: 'success', source },
    });
    logger.info({ shop: this.shop, orderId }, 'order marked paid via transaction');
  }

  /**
   * Writes the payment details onto the order as `quai.*` metafields. This is what actually gets
   * the payment link in front of the customer: a theme snippet reads
   * `order.metafields.quai.payment_url.value` and renders it (see snippets/pay-with-quai.liquid).
   *
   * Without this the only record of the checkout URL is the connector's log, so a store has no way
   * to tell a customer where to pay.
   */
  async setOrderPaymentFields(
    orderId: number,
    fields: {
      paymentUrl: string;
      gatewayId: string;
      quotedAmount: string;
      fiatCurrency: string;
      asset: string;
      expiresAt: number;
    },
  ): Promise<void> {
    const meta = [
      { namespace: 'quai', key: 'payment_url', type: 'url', value: fields.paymentUrl },
      { namespace: 'quai', key: 'gateway_id', type: 'single_line_text_field', value: fields.gatewayId },
      { namespace: 'quai', key: 'quoted_amount', type: 'single_line_text_field', value: fields.quotedAmount },
      { namespace: 'quai', key: 'payment_asset', type: 'single_line_text_field', value: fields.asset },
      { namespace: 'quai', key: 'fiat_currency', type: 'single_line_text_field', value: fields.fiatCurrency },
      { namespace: 'quai', key: 'expires_at', type: 'date_time', value: new Date(fields.expiresAt).toISOString() },
    ];
    await this.request('POST', `/orders/${orderId}/metafields.json`, { metafields: meta });
    logger.info({ shop: this.shop, orderId, gatewayId: fields.gatewayId }, 'payment metafields written');
  }

  /** Clears the payment_url metafield once the order is settled or the quote lapses, so a theme
   *  snippet stops showing a button for a payment that can no longer complete. */
  async clearOrderPaymentUrl(orderId: number): Promise<void> {
    try {
      await this.request('DELETE', `/orders/${orderId}/metafields/quai/payment_url.json`);
    } catch (err) {
      // Already gone, or the order has no such metafield — nothing to clear.
      logger.debug?.({ shop: this.shop, orderId, err }, 'payment_url metafield already absent');
    }
  }
}

export interface OrderInfo {
  id: number;
  name: string;
  totalPrice: string;
  currency: string;
}

export interface ShopifyOrder {
  id: number;
  name: string;
  total_price: string;
  currency: string;
}

function toOrderInfo(order: ShopifyOrder): OrderInfo {
  return { id: order.id, name: order.name, totalPrice: order.total_price, currency: order.currency };
}