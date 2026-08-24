import { Pool, type PoolClient } from 'pg';
import type { Store } from './index.js';
import type { Merchant, Session, WebhookDelivery, PaymentLink, LinkClaim, OrderMeta } from '../types.js';
import { log } from '../logger.js';

const logger = log('store:postgres');

/**
 * {@link Store} backed by PostgreSQL (hosted Postgres, e.g. Railway).
 *
 * Unlike the JSON file store this is safe for multiple relayer instances behind a load balancer:
 * every mutation is an atomic SQL statement (or short transaction), and the indexer cursor,
 * delivery queue and session/nonce tables are all shared.
 *
 * Schema is created idempotently at construction (`CREATE TABLE IF NOT EXISTS`); no external
 * migration tool required.
 *
 * NOTE: timestamps/block numbers are stored as `BIGINT` (int8). node-postgres returns int8 as
 * decimal strings, so reads convert with Number() — safe because every value here is a JS
 * millisecond timestamp or block number, far below 2^53.
 */
export class PostgresStore implements Store {
  readonly pool: Pool;

  constructor(connectionString: string, options: { ssl?: boolean } = {}) {
    // node-postgres does NOT parse `sslmode` from the connection string itself, and Railway
    // requires TLS. Honor an explicit flag, else fall back to whatever sslmode the URL declares.
    const url = new URL(connectionString);
    const sslMode = url.searchParams.get('sslmode');
    const ssl = options.ssl ?? (sslMode !== null && sslMode !== 'disable');
    this.pool = new Pool({
      connectionString,
      max: 10,
      ssl: ssl ? { rejectUnauthorized: false } : undefined,
    });
  }

  /** Create the schema if it doesn't exist yet. Idempotent — safe on every boot. */
  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS cursors (
        scope        TEXT PRIMARY KEY,
        block_number BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS merchants (
        address       TEXT PRIMARY KEY,
        merchant_id   TEXT NOT NULL UNIQUE,
        name          TEXT NOT NULL,
        webhook_url   TEXT NOT NULL,
        webhook_secret TEXT NOT NULL,
        active        BOOLEAN NOT NULL,
        created_at    BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS deliveries (
        id              TEXT PRIMARY KEY,
        merchant_id     TEXT NOT NULL,
        url             TEXT NOT NULL,
        payload         JSONB NOT NULL,
        status          TEXT NOT NULL,
        attempts        INTEGER NOT NULL,
        next_attempt_at BIGINT NOT NULL,
        last_error      TEXT,
        created_at      BIGINT NOT NULL,
        updated_at      BIGINT NOT NULL,
        order_merchant  TEXT NOT NULL,
        order_order_id  TEXT NOT NULL
      );
      -- NOT unique: an orderId becomes reusable after a purge, so a (merchant, orderId) pair can
      -- legitimately appear in multiple deliveries, disambiguated by the payload's order nonce.
      -- getDeliveryByOrder() resolves ties to the latest delivery, matching JsonStore semantics.
      DROP INDEX IF EXISTS deliveries_order_key;
      CREATE INDEX IF NOT EXISTS deliveries_order_key ON deliveries (order_merchant, order_order_id);
      CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries (status, next_attempt_at);

      CREATE TABLE IF NOT EXISTS sessions (
        token       TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL,
        address     TEXT NOT NULL,
        created_at  BIGINT NOT NULL,
        expires_at  BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_merchant ON sessions (merchant_id, created_at);

      CREATE TABLE IF NOT EXISTS nonces (
        nonce      TEXT PRIMARY KEY,
        address    TEXT NOT NULL,
        expires_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS links (
        slug                 TEXT PRIMARY KEY,
        merchant_address     TEXT NOT NULL,
        merchant_id          TEXT NOT NULL,
        merchant_name        TEXT NOT NULL,
        shop_name            TEXT NOT NULL,
        token_address        TEXT NOT NULL,
        amount               TEXT NOT NULL,
        amount_display       TEXT NOT NULL,
        symbol               TEXT NOT NULL,
        expiry_duration_secs INTEGER NOT NULL,
        multi_pay            BOOLEAN NOT NULL,
        order_pool           JSONB NOT NULL,
        created_at           BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS links_merchant ON links (merchant_address, created_at DESC);

      CREATE TABLE IF NOT EXISTS claims (
        slug          TEXT NOT NULL,
        order_id      TEXT NOT NULL,
        payer_address TEXT NOT NULL,
        claimed_at    BIGINT NOT NULL,
        settled       BOOLEAN NOT NULL,
        PRIMARY KEY (slug, order_id)
      );
      CREATE INDEX IF NOT EXISTS claims_payer ON claims (slug, payer_address, claimed_at DESC);

      CREATE TABLE IF NOT EXISTS order_meta (
        order_id         TEXT PRIMARY KEY,
        merchant_address TEXT NOT NULL,
        customer_name    TEXT,
        source           TEXT NOT NULL,
        slug             TEXT,
        created_at       BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS order_meta_merchant ON order_meta (merchant_address, created_at DESC);
    `);
  }

  // --- indexer cursor ---

  async getCursor(scope: string): Promise<number | undefined> {
    const { rows } = await this.pool.query('SELECT block_number FROM cursors WHERE scope = $1', [scope]);
    return rows.length ? Number(rows[0]!.block_number) : undefined;
  }

  async setCursor(scope: string, blockNumber: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO cursors (scope, block_number) VALUES ($1, $2)
       ON CONFLICT (scope) DO UPDATE SET block_number = EXCLUDED.block_number`,
      [scope, blockNumber],
    );
  }

  // --- merchants ---

  async upsertMerchant(m: Merchant): Promise<void> {
    await this.pool.query(
      `INSERT INTO merchants (address, merchant_id, name, webhook_url, webhook_secret, active, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (address) DO UPDATE SET
         merchant_id = EXCLUDED.merchant_id,
         name = EXCLUDED.name,
         webhook_url = EXCLUDED.webhook_url,
         webhook_secret = EXCLUDED.webhook_secret,
         active = EXCLUDED.active,
         created_at = EXCLUDED.created_at`,
      [m.address.toLowerCase(), m.merchantId, m.name, m.webhookUrl, m.webhookSecret, m.active, m.createdAt],
    );
  }

  async getMerchantByAddress(address: string): Promise<Merchant | undefined> {
    const { rows } = await this.pool.query(
      'SELECT * FROM merchants WHERE address = $1',
      [address.toLowerCase()],
    );
    return rows.length ? mapMerchant(rows[0]!) : undefined;
  }

  async getMerchantById(merchantId: string): Promise<Merchant | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM merchants WHERE merchant_id = $1', [merchantId]);
    return rows.length ? mapMerchant(rows[0]!) : undefined;
  }

  async listMerchants(): Promise<Merchant[]> {
    const { rows } = await this.pool.query('SELECT * FROM merchants');
    return rows.map(mapMerchant);
  }

  // --- webhook deliveries ---

  async insertDeliveryIfAbsent(d: WebhookDelivery): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO deliveries (id, merchant_id, url, payload, status, attempts, next_attempt_at, last_error, created_at, updated_at, order_merchant, order_order_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (id) DO NOTHING`,
      [
        d.id,
        d.merchantId,
        d.url,
        JSON.stringify(d.payload),
        d.status,
        d.attempts,
        d.nextAttemptAt,
        d.lastError,
        d.createdAt,
        d.updatedAt,
        d.payload.data.merchant.toLowerCase(),
        d.payload.data.orderId.toLowerCase(),
      ],
    );
    return (rowCount ?? 0) === 1;
  }

  async getDelivery(id: string): Promise<WebhookDelivery | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM deliveries WHERE id = $1', [id]);
    return rows.length ? mapDelivery(rows[0]!) : undefined;
  }

  async getDeliveryByOrder(merchant: string, orderId: string): Promise<WebhookDelivery | undefined> {
    const { rows } = await this.pool.query(
      `SELECT * FROM deliveries
       WHERE order_merchant = $1 AND order_order_id = $2
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [merchant.toLowerCase(), orderId.toLowerCase()],
    );
    return rows.length ? mapDelivery(rows[0]!) : undefined;
  }

  async updateDelivery(d: WebhookDelivery): Promise<void> {
    await this.pool.query(
      `UPDATE deliveries SET
         merchant_id = $2, url = $3, payload = $4, status = $5, attempts = $6,
         next_attempt_at = $7, last_error = $8, updated_at = $9,
         order_merchant = $10, order_order_id = $11
       WHERE id = $1`,
      [
        d.id,
        d.merchantId,
        d.url,
        JSON.stringify(d.payload),
        d.status,
        d.attempts,
        d.nextAttemptAt,
        d.lastError,
        d.updatedAt,
        d.payload.data.merchant.toLowerCase(),
        d.payload.data.orderId.toLowerCase(),
      ],
    );
  }

  /** CAS write: the UPDATE's WHERE clause is the guard — it only matches when the stored row
   *  still equals the snapshot the caller started from, so a concurrent admin retry / requeue /
   *  sweep that touched the row breaks the condition and the write is discarded (rowCount 0). */
  async updateDeliveryIfCurrent(
    d: WebhookDelivery,
    guard: Pick<WebhookDelivery, 'attempts' | 'status' | 'nextAttemptAt' | 'updatedAt'>,
  ): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE deliveries SET
         merchant_id = $2, url = $3, payload = $4, status = $5, attempts = $6,
         next_attempt_at = $7, last_error = $8, updated_at = $9,
         order_merchant = $10, order_order_id = $11
       WHERE id = $1
         AND attempts = $12 AND status = $13 AND next_attempt_at = $14 AND updated_at = $15`,
      [
        d.id,
        d.merchantId,
        d.url,
        JSON.stringify(d.payload),
        d.status,
        d.attempts,
        d.nextAttemptAt,
        d.lastError,
        d.updatedAt,
        d.payload.data.merchant.toLowerCase(),
        d.payload.data.orderId.toLowerCase(),
        guard.attempts,
        guard.status,
        guard.nextAttemptAt,
        guard.updatedAt,
      ],
    );
    return (rowCount ?? 0) === 1;
  }

  /** Re-queue skipped payments for a freshly onboarded address. The nested payload merchantId is
   *  rebuilt from the placeholder in the same statement (jsonb_set), matching JsonStore semantics. */
  async requeueSkippedForMerchant(m: Merchant): Promise<number> {
    const now = Date.now();
    const { rowCount } = await this.pool.query(
      `UPDATE deliveries SET
         merchant_id = $2,
         url = $3,
         status = 'pending',
         attempts = 0,
         next_attempt_at = $4,
         last_error = NULL,
         updated_at = $4,
         payload = jsonb_set(payload, '{data,merchantId}', to_jsonb($2::text), false)
       WHERE status = 'skipped'
         AND order_merchant = $1`,
      [m.address.toLowerCase(), m.merchantId, m.webhookUrl, now],
    );
    if ((rowCount ?? 0) > 0) {
      logger.info(
        { merchantId: m.merchantId, address: m.address.toLowerCase(), requeued: rowCount },
        're-queued skipped payments',
      );
    }
    return rowCount ?? 0;
  }

  async getDueDeliveries(now: number, limit: number): Promise<WebhookDelivery[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM deliveries
       WHERE status = 'pending' AND next_attempt_at <= $1
       ORDER BY next_attempt_at, id
       LIMIT $2`,
      [now, limit],
    );
    return rows.map(mapDelivery);
  }

  async listDeliveries(limit: number): Promise<WebhookDelivery[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM deliveries ORDER BY created_at DESC, id LIMIT $1',
      [limit],
    );
    return rows.map(mapDelivery);
  }

  // --- auth sessions ---

  async createSession(s: Session): Promise<void> {
    // Cap live sessions per merchant at 20 (JsonStore parity): evict the oldest beyond the cap
    // so a brute-forced/replayed login can't mint unbounded sessions. The new row replaces any
    // existing one with the same token. One data-modifying CTE keeps this a single round-trip.
    await this.pool.query(
      `WITH evicted AS (
         DELETE FROM sessions s
         USING (SELECT token FROM sessions WHERE merchant_id = $1 ORDER BY created_at DESC OFFSET 19) old
         WHERE s.token = old.token
         RETURNING s.token
       )
       INSERT INTO sessions (token, merchant_id, address, created_at, expires_at)
       VALUES ($2, $1, $3, $4, $5)
       ON CONFLICT (token) DO UPDATE SET
         merchant_id = EXCLUDED.merchant_id,
         address = EXCLUDED.address,
         created_at = EXCLUDED.created_at,
         expires_at = EXCLUDED.expires_at`,
      [s.merchantId, s.token, s.address, s.createdAt, s.expiresAt],
    );
  }

  async getSession(token: string): Promise<Session | undefined> {
    // Lazy expiry: delete past-expiry rows first so a stale token can never read back as valid.
    await this.pool.query('DELETE FROM sessions WHERE token = $1 AND expires_at <= $2', [
      token,
      Date.now(),
    ]);
    const { rows } = await this.pool.query('SELECT * FROM sessions WHERE token = $1', [token]);
    return rows.length ? mapSession(rows[0]!) : undefined;
  }

  async deleteSession(token: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE token = $1', [token]);
  }

  // --- login challenges ---

  async createNonce(nonce: string, address: string, expiresAt: number): Promise<void> {
    // Opportunistic sweep so expired nonces can't accumulate unboundedly (JsonStore parity).
    await this.pool.query('DELETE FROM nonces WHERE expires_at <= $1', [Date.now()]);
    await this.pool.query('INSERT INTO nonces (nonce, address, expires_at) VALUES ($1, $2, $3)', [
      nonce,
      address,
      expiresAt,
    ]);
  }

  /** Single-use by construction: the DELETE atomically removes the row and returns it; a replayed
   *  login finds nothing on the second call, and expired nonces return nothing. */
  async consumeNonce(nonce: string): Promise<string | undefined> {
    const { rows } = await this.pool.query(
      'DELETE FROM nonces WHERE nonce = $1 RETURNING address, expires_at',
      [nonce],
    );
    if (!rows.length) return undefined;
    if (Number(rows[0]!.expires_at) <= Date.now()) return undefined;
    return rows[0]!.address as string;
  }

  // --- payment links ---

  async upsertLink(link: PaymentLink): Promise<void> {
    await this.pool.query(
      `INSERT INTO links (slug, merchant_address, merchant_id, merchant_name, shop_name, token_address,
                          amount, amount_display, symbol, expiry_duration_secs, multi_pay, order_pool, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (slug) DO UPDATE SET
         merchant_address = EXCLUDED.merchant_address,
         merchant_id = EXCLUDED.merchant_id,
         merchant_name = EXCLUDED.merchant_name,
         shop_name = EXCLUDED.shop_name,
         token_address = EXCLUDED.token_address,
         amount = EXCLUDED.amount,
         amount_display = EXCLUDED.amount_display,
         symbol = EXCLUDED.symbol,
         expiry_duration_secs = EXCLUDED.expiry_duration_secs,
         multi_pay = EXCLUDED.multi_pay,
         order_pool = EXCLUDED.order_pool,
         created_at = EXCLUDED.created_at`,
      [
        link.slug,
        link.merchantAddress,
        link.merchantId,
        link.merchantName,
        link.shopName,
        link.tokenAddress,
        link.amount,
        link.amountDisplay,
        link.symbol,
        link.expiryDurationSecs,
        link.multiPay,
        JSON.stringify(link.orderPool),
        link.createdAt,
      ],
    );
  }

  async getLink(slug: string): Promise<PaymentLink | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM links WHERE slug = $1', [slug]);
    return rows.length ? mapLink(rows[0]!) : undefined;
  }

  async listLinksForMerchant(merchantAddress: string): Promise<PaymentLink[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM links WHERE merchant_address = $1 ORDER BY created_at DESC',
      [merchantAddress.toLowerCase()],
    );
    return rows.map(mapLink);
  }

  /** Pop an orderId off the pool atomically: the row is locked (FOR UPDATE) so two concurrent
   *  customers can never claim the same orderId; the claim row is inserted in the same transaction. */
  async claimOrderFromPool(slug: string, payerAddress: string): Promise<string | undefined> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        'SELECT order_pool FROM links WHERE slug = $1 FOR UPDATE',
        [slug],
      );
      if (!rows.length) {
        await client.query('ROLLBACK');
        return undefined;
      }
      const pool: string[] = (rows[0]!.order_pool as string[]) ?? [];
      const orderId = pool.shift();
      if (!orderId) {
        await client.query('ROLLBACK');
        return undefined;
      }
      await client.query('UPDATE links SET order_pool = $1 WHERE slug = $2', [
        JSON.stringify(pool),
        slug,
      ]);
      await client.query(
        `INSERT INTO claims (slug, order_id, payer_address, claimed_at, settled)
         VALUES ($1, $2, $3, $4, false)
         ON CONFLICT (slug, order_id) DO NOTHING`,
        [slug, orderId, payerAddress.toLowerCase(), Date.now()],
      );
      await client.query('COMMIT');
      return orderId;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async reclaimStaleClaim(slug: string, payerAddress: string, olderThanMs: number): Promise<string | undefined> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const cutoff = Date.now() - olderThanMs;
      const { rows } = await client.query(
        `SELECT order_id FROM claims
         WHERE slug = $1 AND settled = false AND claimed_at < $2
         ORDER BY claimed_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [slug, cutoff],
      );
      if (!rows.length) {
        await client.query('ROLLBACK');
        return undefined;
      }
      const orderId = rows[0]!.order_id as string;
      await client.query(
        'UPDATE claims SET payer_address = $1, claimed_at = $2 WHERE slug = $3 AND order_id = $4',
        [payerAddress.toLowerCase(), Date.now(), slug, orderId],
      );
      await client.query('COMMIT');
      return orderId;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async settleClaimedOrder(slug: string, orderId: string): Promise<void> {
    await this.pool.query('UPDATE claims SET settled = true WHERE slug = $1 AND order_id = $2', [
      slug,
      orderId.toLowerCase(),
    ]);
  }

  async upsertClaim(claim: LinkClaim): Promise<void> {
    await this.pool.query(
      `INSERT INTO claims (slug, order_id, payer_address, claimed_at, settled)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (slug, order_id) DO UPDATE SET
         payer_address = EXCLUDED.payer_address,
         claimed_at = EXCLUDED.claimed_at,
         settled = EXCLUDED.settled`,
      [claim.slug, claim.orderId.toLowerCase(), claim.payerAddress.toLowerCase(), claim.claimedAt, claim.settled],
    );
  }

  async getLatestClaim(slug: string, payerAddress: string): Promise<LinkClaim | undefined> {
    const { rows } = await this.pool.query(
      `SELECT * FROM claims
       WHERE slug = $1 AND payer_address = $2
       ORDER BY claimed_at DESC, order_id DESC
       LIMIT 1`,
      [slug, payerAddress.toLowerCase()],
    );
    return rows.length ? mapClaim(rows[0]!) : undefined;
  }

  // --- order metadata ---

  async saveOrderMeta(meta: OrderMeta): Promise<void> {
    await this.pool.query(
      `INSERT INTO order_meta (order_id, merchant_address, customer_name, source, slug, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (order_id) DO UPDATE SET
         customer_name = COALESCE(EXCLUDED.customer_name, order_meta.customer_name),
         source        = EXCLUDED.source,
         slug          = EXCLUDED.slug`,
      [meta.orderId.toLowerCase(), meta.merchantAddress.toLowerCase(), meta.customerName ?? null, meta.source, meta.slug ?? null, meta.createdAt],
    );
  }

  async getOrderMeta(orderId: string): Promise<OrderMeta | undefined> {
    const { rows } = await this.pool.query(
      `SELECT * FROM order_meta WHERE order_id = $1 LIMIT 1`,
      [orderId.toLowerCase()],
    );
    if (!rows.length) return undefined;
    const r = rows[0]!;
    return {
      orderId: r.order_id as string,
      merchantAddress: r.merchant_address as string,
      customerName: (r.customer_name as string | null) ?? undefined,
      source: r.source as OrderMeta['source'],
      slug: (r.slug as string | null) ?? undefined,
      createdAt: Number(r.created_at),
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// --- row → domain mappers (int8 columns come back as decimal strings from node-postgres) ---

const toNum = (v: unknown): number => Number(v);

function mapMerchant(row: Record<string, unknown>): Merchant {
  return {
    merchantId: row.merchant_id as string,
    address: row.address as string,
    name: row.name as string,
    webhookUrl: row.webhook_url as string,
    webhookSecret: row.webhook_secret as string,
    active: row.active as boolean,
    createdAt: toNum(row.created_at),
  };
}

function mapDelivery(row: Record<string, unknown>): WebhookDelivery {
  return {
    id: row.id as string,
    merchantId: row.merchant_id as string,
    url: row.url as string,
    payload: row.payload as WebhookDelivery['payload'],
    status: row.status as WebhookDelivery['status'],
    attempts: toNum(row.attempts),
    nextAttemptAt: toNum(row.next_attempt_at),
    lastError: (row.last_error as string | null) ?? null,
    createdAt: toNum(row.created_at),
    updatedAt: toNum(row.updated_at),
  };
}

function mapSession(row: Record<string, unknown>): Session {
  return {
    token: row.token as string,
    merchantId: row.merchant_id as string,
    address: row.address as string,
    createdAt: toNum(row.created_at),
    expiresAt: toNum(row.expires_at),
  };
}

function mapLink(row: Record<string, unknown>): PaymentLink {
  return {
    slug: row.slug as string,
    merchantAddress: row.merchant_address as string,
    merchantId: row.merchant_id as string,
    merchantName: row.merchant_name as string,
    shopName: row.shop_name as string,
    tokenAddress: row.token_address as string,
    amount: row.amount as string,
    amountDisplay: row.amount_display as string,
    symbol: row.symbol as string,
    expiryDurationSecs: toNum(row.expiry_duration_secs),
    multiPay: row.multi_pay as boolean,
    orderPool: (row.order_pool as string[]) ?? [],
    createdAt: toNum(row.created_at),
  };
}

function mapClaim(row: Record<string, unknown>): LinkClaim {
  return {
    slug: row.slug as string,
    orderId: row.order_id as string,
    payerAddress: row.payer_address as string,
    claimedAt: toNum(row.claimed_at),
    settled: row.settled as boolean,
  };
}