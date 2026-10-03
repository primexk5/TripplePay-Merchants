import { Pool } from 'pg';
import type { ConnectorStore, ShopSession, PendingPayment, OAuthState, StoreSettings } from './index.js';

/**
 * Postgres-backed connector store. This is what a multi-instance deployment needs: the JSON file
 * store cannot be shared between processes, and losing a Shopify `accessToken` on restart would take
 * every store offline until each merchant reinstalled.
 *
 * Schema is created idempotently at construction, so there is no separate migration step.
 */
export class PostgresConnectorStore implements ConnectorStore {
  /** Exposed so operational code (and tests) can inspect schema/counts directly. */
  readonly pool: Pool;

  constructor(connectionString: string, options: { ssl?: boolean } = {}) {
    // node-postgres does not read `sslmode` from the connection string itself; hosted providers
    // generally require TLS, so honour an explicit flag and otherwise trust what the URL declares.
    let ssl = options.ssl;
    try {
      const url = new URL(connectionString);
      const sslMode = url.searchParams.get('sslmode');
      ssl = ssl ?? (sslMode !== null && sslMode !== 'disable');
    } catch {
      /* not a URL (e.g. unix socket) — leave the flag as given */
    }
    this.pool = new Pool({
      connectionString,
      max: 10,
      ssl: ssl ? { rejectUnauthorized: false } : undefined,
    });
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS shop_sessions (
        shop         TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        installed_at BIGINT NOT NULL,
        scopes       TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oauth_states (
        state      TEXT PRIMARY KEY,
        shop       TEXT NOT NULL,
        created_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS oauth_states_created ON oauth_states (created_at);

      CREATE TABLE IF NOT EXISTS pending_payments (
        gateway_id    TEXT PRIMARY KEY,
        shop          TEXT NOT NULL,
        order_id      BIGINT NOT NULL,
        checkout_url  TEXT NOT NULL,
        amount        TEXT NOT NULL,
        fiat_currency TEXT NOT NULL,
        asset         TEXT NOT NULL DEFAULT 'qi',
        status        TEXT NOT NULL,
        created_at    BIGINT NOT NULL,
        expires_at    BIGINT NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS pending_payments_order ON pending_payments (order_id);
      CREATE INDEX IF NOT EXISTS pending_payments_shop_order ON pending_payments (shop, order_id);
      -- Drives the expiry sweep: only still-awaiting rows are ever scanned.
      CREATE INDEX IF NOT EXISTS pending_payments_awaiting ON pending_payments (expires_at) WHERE status = 'awaiting';

      -- Per-store gateway credentials, stored SEALED (AES-256-GCM under the connector's
      -- encryption key). The connector is the only component that can read them.
      CREATE TABLE IF NOT EXISTS shop_settings (
        shop                 TEXT PRIMARY KEY,
        merchant_key_cipher  TEXT NOT NULL,
        webhook_secret_cipher TEXT NOT NULL,
        configured_at        BIGINT NOT NULL
      );
    `);

    // Older deployments predate `asset`/`expires_at` on pending payments. A record with expires_at
    // 0 would be swept to `expired` immediately, which is the safe direction (the link is treated as
    // dead rather than as eternally payable), so backfilling 0 is deliberate.
    await this.pool.query('ALTER TABLE pending_payments ADD COLUMN IF NOT EXISTS asset TEXT NOT NULL DEFAULT \'qi\'');
    await this.pool.query('ALTER TABLE pending_payments ADD COLUMN IF NOT EXISTS expires_at BIGINT NOT NULL DEFAULT 0');
  }

  private static mapSession(r: Record<string, unknown>): ShopSession {
    return {
      shop: r.shop as string,
      accessToken: r.access_token as string,
      installedAt: Number(r.installed_at),
      scopes: r.scopes as string,
    };
  }

  private static mapPending(r: Record<string, unknown>): PendingPayment {
    return {
      gatewayId: r.gateway_id as string,
      shop: r.shop as string,
      orderId: Number(r.order_id),
      checkoutUrl: r.checkout_url as string,
      amount: r.amount as string,
      fiatCurrency: r.fiat_currency as string,
      asset: (r.asset as string) ?? 'qi',
      status: r.status as PendingPayment['status'],
      createdAt: Number(r.created_at),
      expiresAt: Number(r.expires_at ?? 0),
    };
  }

  async getSession(shop: string): Promise<ShopSession | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM shop_sessions WHERE shop = $1', [shop.toLowerCase()]);
    return rows[0] ? PostgresConnectorStore.mapSession(rows[0]) : undefined;
  }

  async setSession(session: ShopSession): Promise<void> {
    await this.pool.query(
      `INSERT INTO shop_sessions (shop, access_token, installed_at, scopes)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (shop) DO UPDATE
         SET access_token = EXCLUDED.access_token,
             installed_at = EXCLUDED.installed_at,
             scopes = EXCLUDED.scopes`,
      [session.shop.toLowerCase(), session.accessToken, session.installedAt, session.scopes],
    );
  }

  async removeSession(shop: string): Promise<void> {
    await this.pool.query('DELETE FROM shop_sessions WHERE shop = $1', [shop.toLowerCase()]);
  }

  async putState(state: OAuthState): Promise<void> {
    await this.pool.query(
      `INSERT INTO oauth_states (state, shop, created_at) VALUES ($1, $2, $3)
       ON CONFLICT (state) DO NOTHING`,
      [state.state, state.shop.toLowerCase(), state.createdAt],
    );
  }

  /**
   * Atomic single-use consume: `DELETE ... RETURNING` is one statement, so two concurrent callbacks
   * carrying the same state cannot both win. A plain SELECT-then-DELETE would let both through.
   */
  async consumeState(state: string, shop: string): Promise<OAuthState | undefined> {
    const { rows } = await this.pool.query(
      `DELETE FROM oauth_states
        WHERE state = $1 AND shop = $2
        RETURNING state, shop, created_at`,
      [state, shop.toLowerCase()],
    );
    if (!rows[0]) return undefined;
    return {
      state: rows[0].state as string,
      shop: rows[0].shop as string,
      createdAt: Number(rows[0].created_at),
    };
  }

  async pruneStates(maxAgeMs: number): Promise<number> {
    const { rowCount } = await this.pool.query('DELETE FROM oauth_states WHERE created_at < $1', [
      Date.now() - maxAgeMs,
    ]);
    return rowCount ?? 0;
  }

  async getPending(gatewayId: string): Promise<PendingPayment | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM pending_payments WHERE gateway_id = $1', [gatewayId]);
    return rows[0] ? PostgresConnectorStore.mapPending(rows[0]) : undefined;
  }

  async getPendingForOrder(orderId: number): Promise<PendingPayment | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM pending_payments WHERE order_id = $1 LIMIT 1', [orderId]);
    return rows[0] ? PostgresConnectorStore.mapPending(rows[0]) : undefined;
  }

  async getPendingForShopOrder(shop: string, orderId: number): Promise<PendingPayment | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM pending_payments WHERE shop = $1 AND order_id = $2 LIMIT 1', [
      shop.toLowerCase(),
      orderId,
    ]);
    return rows[0] ? PostgresConnectorStore.mapPending(rows[0]) : undefined;
  }

  async upsertPending(p: PendingPayment): Promise<void> {
    await this.pool.query(
      `INSERT INTO pending_payments
         (gateway_id, shop, order_id, checkout_url, amount, fiat_currency, asset, status, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (gateway_id) DO UPDATE SET
         checkout_url = EXCLUDED.checkout_url,
         amount = EXCLUDED.amount,
         fiat_currency = EXCLUDED.fiat_currency,
         asset = EXCLUDED.asset,
         status = EXCLUDED.status,
         expires_at = EXCLUDED.expires_at`,
      [p.gatewayId, p.shop.toLowerCase(), p.orderId, p.checkoutUrl, p.amount, p.fiatCurrency, p.asset, p.status, p.createdAt, p.expiresAt],
    );
  }

  async markPaid(gatewayId: string): Promise<PendingPayment | undefined> {
    const { rows } = await this.pool.query(
      `UPDATE pending_payments SET status = 'paid' WHERE gateway_id = $1 RETURNING *`,
      [gatewayId],
    );
    return rows[0] ? PostgresConnectorStore.mapPending(rows[0]) : undefined;
  }

  /**
   * Flips lapsed quotes in one statement. Scoped to `status = 'awaiting'` so a payment that already
   * settled is never walked backwards, and so the partial index on awaiting rows is usable.
   */
  async sweepExpired(): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE pending_payments SET status = 'expired'
        WHERE status = 'awaiting' AND expires_at > 0 AND expires_at <= $1`,
      [Date.now()],
    );
    return rowCount ?? 0;
  }

  async isLive(gatewayId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM pending_payments
        WHERE gateway_id = $1 AND status = 'awaiting' AND expires_at > $2`,
      [gatewayId, Date.now()],
    );
    return rows.length > 0;
  }

  async getSettings(shop: string): Promise<StoreSettings | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM shop_settings WHERE shop = $1', [shop.toLowerCase()]);
    if (!rows[0]) return undefined;
    return {
      shop: rows[0].shop as string,
      merchantKeyCipher: rows[0].merchant_key_cipher as string,
      webhookSecretCipher: rows[0].webhook_secret_cipher as string,
      configuredAt: Number(rows[0].configured_at),
    };
  }

  async putSettings(settings: StoreSettings): Promise<void> {
    await this.pool.query(
      `INSERT INTO shop_settings (shop, merchant_key_cipher, webhook_secret_cipher, configured_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (shop) DO UPDATE SET
         merchant_key_cipher = EXCLUDED.merchant_key_cipher,
         webhook_secret_cipher = EXCLUDED.webhook_secret_cipher,
         configured_at = EXCLUDED.configured_at`,
      [settings.shop.toLowerCase(), settings.merchantKeyCipher, settings.webhookSecretCipher, settings.configuredAt],
    );
  }

  async clearSettings(shop: string): Promise<void> {
    await this.pool.query('DELETE FROM shop_settings WHERE shop = $1', [shop.toLowerCase()]);
  }
}
