import { Pool, type PoolClient } from 'pg';
import { randomBytes } from 'node:crypto';
import type { Store } from './index.js';
import type { Merchant, Session, WebhookDelivery, PaymentLink, LinkClaim, OrderMeta, QiOrder, MerchantApiKey, MerchantApiKeyMeta, MerchantPayoutAddress, PayoutAddressSource, FixedOrderClaimResult } from '../types.js';
import { hashApiKey, apiKeyRef, DEV_API_KEY_PEPPER } from '../util/apikey.js';
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
  /** Keyed-hash pepper for API keys. Optional so existing 2/3-arg call sites keep working;
   *  production always passes cfg.API_KEY_PEPPER (see index.ts). */
  private readonly apiKeyPepper: string;

  /** `defaultChainId`: what a pre-multi-chain row (link/order_meta with a NULL chain_id, or a
   *  delivery whose stored payload predates chainId) is read back as. Optional so existing
   *  `new PostgresStore(url, opts)` call sites keep working unchanged; production always passes
   *  the real default chain's chainId (see index.ts). */
  constructor(
    connectionString: string,
    options: {
      ssl?: boolean;
      maxConnections?: number;
      rejectUnauthorized?: boolean;
      connectTimeoutMillis?: number;
    } = {},
    private readonly defaultChainId: number = 9,
    apiKeyPepper: string = '',
  ) {
    this.apiKeyPepper = apiKeyPepper || DEV_API_KEY_PEPPER;
    // node-postgres does NOT parse `sslmode` from the connection string itself, and Railway
    // requires TLS. Honor an explicit flag, else fall back to whatever sslmode the URL declares.
    const url = new URL(connectionString);
    const sslMode = url.searchParams.get('sslmode');
    const ssl = options.ssl ?? (sslMode !== null && sslMode !== 'disable');
    this.pool = new Pool({
      connectionString,
      max: options.maxConnections ?? 10,
      ssl: ssl ? { rejectUnauthorized: options.rejectUnauthorized ?? false } : undefined,
      // Without this, an unreachable database (Supabase's direct host is IPv6-only, so an
      // IPv4-only host like Render resolves nothing and hangs) leaves the Pool retrying forever
      // and the process never reaches `listen`. Failing fast turns that into a boot error the
      // deploy log actually names, instead of a port-scan timeout with no cause.
      //
      // Generous by default: this bounds ACQUIRING a connection, not the query, and a managed
      // pooler under load (Supabase's PgBouncer handing out backends) can take well over ten
      // seconds. At 10s this surfaced as a spurious "Connection terminated due to connection
      // timeout" in the live store suite while every single query was in fact correct.
      connectionTimeoutMillis: options.connectTimeoutMillis ?? 30_000,
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
      -- Append-only schema evolution: new optional columns are added idempotently so an existing
      -- deployment upgrades in place without a migration tool.
      ALTER TABLE merchants ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{"quaiMarkupBps":0,"fiatCurrencies":["USD","NGN"]}'::jsonb;

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
      ALTER TABLE links ADD COLUMN IF NOT EXISTS gateway_order_id TEXT;
      ALTER TABLE links ADD COLUMN IF NOT EXISTS max_redemptions INTEGER NOT NULL DEFAULT 0;
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
      ALTER TABLE order_meta ADD COLUMN IF NOT EXISTS reference TEXT;
      CREATE INDEX IF NOT EXISTS order_meta_merchant ON order_meta (merchant_address, created_at DESC);

      -- Multi-chain migration (idempotent, safe to run every boot): a nullable chain_id, backfilled
      -- below for any pre-existing rows and indexed for per-chain queries. Never touches any other
      -- column, and never drops/recreates the table — existing data survives unchanged.
      ALTER TABLE links ADD COLUMN IF NOT EXISTS chain_id BIGINT;
      ALTER TABLE order_meta ADD COLUMN IF NOT EXISTS chain_id BIGINT;

      CREATE TABLE IF NOT EXISTS qi_orders (
        order_id         TEXT PRIMARY KEY,
        merchant_address TEXT NOT NULL,
        address          TEXT NOT NULL UNIQUE,
        qits             TEXT NOT NULL,
        received_qits    TEXT NOT NULL DEFAULT '0',
        settled          BOOLEAN NOT NULL DEFAULT false,
        tx_hashes        JSONB NOT NULL DEFAULT '[]',
        created_at       BIGINT NOT NULL,
        settled_at       BIGINT
      );
      -- For the Qi indexer sweep: pending (unsettled) orders, oldest first.
      CREATE INDEX IF NOT EXISTS qi_orders_pending ON qi_orders (settled, created_at);

      -- The legacy plaintext bucket: NULL on every row minted after the hashing migration, so it
      -- is deliberately nullable and carries no primary key. key_hash is the real identity
      -- (see the migration below).
      CREATE TABLE IF NOT EXISTS api_keys (
        key              TEXT,
        merchant_address TEXT NOT NULL,
        label            TEXT NOT NULL,
        created_at       BIGINT NOT NULL,
        last_used_at     BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS api_keys_merchant ON api_keys (merchant_address, created_at DESC);
    `);

    // Per-chain payout destinations. A merchant's IDENTITY address (merchants.address) is the wallet
    // they sign in with; this table is where their money actually lands, one row per chain. That is
    // what lets a single Quai-wallet merchant also take Base payments without a second account.
    //
    // Indexed on (address, chain_id) rather than only by merchant_id because the indexer resolves
    // merchants FROM the on-chain payout address on every settled payment — see
    // getMerchantByPayoutAddress.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS merchant_payout_addresses (
        merchant_id TEXT NOT NULL REFERENCES merchants (merchant_id) ON DELETE CASCADE,
        chain_id    BIGINT NOT NULL,
        address     TEXT NOT NULL,
        source      TEXT NOT NULL DEFAULT 'declared',
        created_at  BIGINT NOT NULL,
        PRIMARY KEY (merchant_id, chain_id)
      );
      CREATE INDEX IF NOT EXISTS merchant_payout_addresses_lookup
        ON merchant_payout_addresses (address, chain_id);
    `);

    // API-key hashing migration. The original table stored the bearer credential in `key` as the
    // primary key. Credentials are now stored only as HMAC-SHA256(pepper, key) in `key_hash`,
    // with a short non-secret `key_ref` so keys can be revoked from a URL without ever putting the
    // secret in one. `key` stays (nullable) as the legacy bucket: the pepper is not available to
    // SQL, so we cannot re-hash existing rows here — instead each row is upgraded in place the
    // first time its owner presents it (see getMerchantByApiKey). Once every row has a key_hash,
    // `key` can be dropped in a later migration.
    //
    // The DROP CONSTRAINT / DROP NOT NULL pair is what makes that documented design actually work:
    // a fresh database created by the DDL above used to keep `key` as NOT NULL PRIMARY KEY, so
    // every insert in createMerchantApiKey — which writes only the hash columns — failed with
    // "null value in column key". That made POST /v1/me/apikeys (how merchants connect their
    // Shopify store) unusable on any freshly provisioned database. The constraint has to go first:
    // Postgres refuses to drop NOT NULL on a column that is still part of a primary key. Both
    // statements are idempotent.
    await this.pool.query(`
      ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_hash TEXT;
      ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_ref  TEXT;
      ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_pkey;
      ALTER TABLE api_keys ALTER COLUMN key DROP NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS api_keys_key_hash ON api_keys (key_hash) WHERE key_hash IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS api_keys_key_ref  ON api_keys (key_ref)  WHERE key_ref  IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS api_keys_key_legacy ON api_keys (key) WHERE key IS NOT NULL;
    `);
    // `key_hash IS NULL` is the legacy marker: it means "this row still holds a plaintext
    // credential in `key`". Nothing else needs a flag column.

    // Backfill + index chain_id (parameterized — can't live in the template literal above).
    // WHERE chain_id IS NULL makes this a no-op on every boot after the first, so re-running it
    // is always safe and never overwrites a chain_id a caller has already set.
    await this.pool.query('UPDATE links SET chain_id = $1 WHERE chain_id IS NULL', [this.defaultChainId]);
    await this.pool.query('UPDATE order_meta SET chain_id = $1 WHERE chain_id IS NULL', [this.defaultChainId]);
    await this.pool.query('CREATE INDEX IF NOT EXISTS links_chain ON links (chain_id)');
    await this.pool.query('CREATE INDEX IF NOT EXISTS order_meta_chain ON order_meta (chain_id)');

    // Ownership moved from the merchant's address to their stable merchant_id, but the indexes
    // left behind still lead with merchant_address — so listLinksForMerchant
    // (`WHERE merchant_id = $1 ORDER BY created_at DESC`) had no usable index and seq-scanned
    // `links` on every dashboard load. `links_merchant` is kept: address-keyed lookups still
    // use it, and dropping an index a live deployment depends on is not this migration's call.
    await this.pool.query(
      'CREATE INDEX IF NOT EXISTS links_merchant_id ON links (merchant_id, created_at DESC)',
    );
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
      `INSERT INTO merchants (address, merchant_id, name, webhook_url, webhook_secret, active, created_at, settings)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (address) DO UPDATE SET
         merchant_id = EXCLUDED.merchant_id,
         name = EXCLUDED.name,
         webhook_url = EXCLUDED.webhook_url,
         webhook_secret = EXCLUDED.webhook_secret,
         active = EXCLUDED.active,
         created_at = EXCLUDED.created_at,
         settings = EXCLUDED.settings`,
      [
        m.address.toLowerCase(),
        m.merchantId,
        m.name,
        m.webhookUrl,
        m.webhookSecret,
        m.active,
        m.createdAt,
        JSON.stringify(m.settings ?? { quaiMarkupBps: 0, fiatCurrencies: ['USD', 'NGN'] }),
      ],
    );
  }

  async getMerchantByAddress(address: string): Promise<Merchant | undefined> {
    const { rows } = await this.pool.query(
      'SELECT * FROM merchants WHERE address = $1',
      [address.toLowerCase()],
    );
    return rows.length ? mapMerchant(rows[0]!) : undefined;
  }

  async getMerchantByPayoutAddress(chainId: number, address: string): Promise<Merchant | undefined> {
    const addr = address.toLowerCase();
    // Configured destination for this exact chain wins.
    const mapped = await this.pool.query(
      `SELECT m.* FROM merchant_payout_addresses p
       JOIN merchants m ON m.merchant_id = p.merchant_id
       WHERE p.chain_id = $1 AND p.address = $2`,
      [chainId, addr],
    );
    if (mapped.rows.length) return mapMerchant(mapped.rows[0]!);
    // Legacy fallback: merchants onboarded before per-chain payouts existed receive at their
    // identity address. Mirrors JsonStore.getMerchantByPayoutAddress exactly.
    const legacy = await this.pool.query(
      'SELECT * FROM merchants WHERE address = $1',
      [addr],
    );
    return legacy.rows.length ? mapMerchant(legacy.rows[0]!) : undefined;
  }

  async listPayoutAddresses(merchantId: string): Promise<MerchantPayoutAddress[]> {
    const { rows } = await this.pool.query(
      `SELECT merchant_id, chain_id, address, source, created_at FROM merchant_payout_addresses
       WHERE merchant_id = $1 ORDER BY chain_id`,
      [merchantId],
    );
    return rows.map((r) => mapPayoutAddress(r));
  }

  async setPayoutAddress(p: {
    merchantId: string;
    chainId: number;
    address: string;
    source: PayoutAddressSource;
    createdAt: number;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO merchant_payout_addresses (merchant_id, chain_id, address, source, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (merchant_id, chain_id)
       DO UPDATE SET address = EXCLUDED.address, source = EXCLUDED.source`,
      [p.merchantId, p.chainId, p.address.toLowerCase(), p.source, p.createdAt],
    );
  }

  async clearPayoutAddress(merchantId: string, chainId: number): Promise<void> {
    await this.pool.query(
      'DELETE FROM merchant_payout_addresses WHERE merchant_id = $1 AND chain_id = $2',
      [merchantId, chainId],
    );
  }

  async getMerchantById(merchantId: string): Promise<Merchant | undefined> {    const { rows } = await this.pool.query('SELECT * FROM merchants WHERE merchant_id = $1', [merchantId]);
    return rows.length ? mapMerchant(rows[0]!) : undefined;
  }

  async listMerchants(): Promise<Merchant[]> {
    const { rows } = await this.pool.query('SELECT * FROM merchants');
    return rows.map(mapMerchant);
  }

  // --- merchant API keys ---

  async createMerchantApiKey(k: {
    key: string;
    merchantAddress: string;
    label: string;
    createdAt: number;
  }): Promise<{ keyRef: string }> {
    const keyHash = hashApiKey(k.key, this.apiKeyPepper);
    const keyRef = apiKeyRef(keyHash);
    await this.pool.query(
      `INSERT INTO api_keys (key_hash, key_ref, merchant_address, label, created_at, last_used_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [keyHash, keyRef, k.merchantAddress.toLowerCase(), k.label, k.createdAt, 0],
    );
    return { keyRef };
  }

  async getMerchantByApiKey(key: string): Promise<Merchant | undefined> {
    const hash = hashApiKey(key, this.apiKeyPepper);

    const hashed = await this.pool.query(
      `SELECT m.* FROM api_keys k JOIN merchants m ON m.address = k.merchant_address
       WHERE k.key_hash = $1`,
      [hash],
    );
    if (hashed.rows.length) {
      // Best-effort last-used stamp; never worth failing a request over.
      await this.pool
        .query('UPDATE api_keys SET last_used_at = $1 WHERE key_hash = $2', [Date.now(), hash])
        .catch(() => undefined);
      return mapMerchant(hashed.rows[0]!);
    }

    // Legacy: a pre-hashing row still holding the plaintext credential. Accept it, then rewrite the
    // row hashed in place so the plaintext column is emptied immediately. The merchant keeps using
    // the same credential, so no re-issue and no downtime. Pinned to ONE client, because a manual
    // BEGIN issued on `pool` could otherwise span two different pooled connections.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `UPDATE api_keys
            SET key = NULL, key_hash = $1, key_ref = $2,
                label = COALESCE(NULLIF(label, ''), '(migrated)')
          WHERE key = $3 AND key_hash IS NULL
        RETURNING merchant_address`,
        [hash, apiKeyRef(hash), key],
      );
      if (!rows.length) {
        await client.query('ROLLBACK');
        return undefined;
      }
      const owner = await client.query('SELECT * FROM merchants WHERE address = $1', [
        rows[0]!.merchant_address as string,
      ]);
      await client.query('COMMIT');
      logger.warn('migrated legacy plaintext API key to hashed form');
      return owner.rows.length ? mapMerchant(owner.rows[0]!) : undefined;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async listMerchantApiKeys(merchantAddress: string): Promise<MerchantApiKeyMeta[]> {
    const { rows } = await this.pool.query(
      `SELECT key_ref, label, created_at, last_used_at FROM api_keys
        WHERE merchant_address = $1 AND key_hash IS NOT NULL
        ORDER BY created_at DESC`,
      [merchantAddress.toLowerCase()],
    );
    return rows.map((r) => ({
      keyRef: r.key_ref as string,
      label: r.label as string,
      createdAt: toNum(r.created_at),
      lastUsedAt: toNum(r.last_used_at),
    }));
  }

  async revokeMerchantApiKeyByRef(keyRef: string): Promise<void> {
    await this.pool.query('DELETE FROM api_keys WHERE key_ref = $1', [keyRef]);
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
    return rows.length ? mapDelivery(rows[0]!, this.defaultChainId) : undefined;
  }

  async getDeliveryByOrder(merchant: string, orderId: string): Promise<WebhookDelivery | undefined> {
    const { rows } = await this.pool.query(
      `SELECT * FROM deliveries
       WHERE order_merchant = $1 AND order_order_id = $2
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [merchant.toLowerCase(), orderId.toLowerCase()],
    );
    return rows.length ? mapDelivery(rows[0]!, this.defaultChainId) : undefined;
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
    return rows.map((r) => mapDelivery(r, this.defaultChainId));
  }

  async listDeliveries(limit: number): Promise<WebhookDelivery[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM deliveries ORDER BY created_at DESC, id LIMIT $1',
      [limit],
    );
    return rows.map((r) => mapDelivery(r, this.defaultChainId));
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
                          amount, amount_display, symbol, expiry_duration_secs, multi_pay, order_pool, created_at, chain_id, gateway_order_id, max_redemptions)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
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
         created_at = EXCLUDED.created_at,
         chain_id = EXCLUDED.chain_id,
         gateway_order_id = EXCLUDED.gateway_order_id,
         max_redemptions = EXCLUDED.max_redemptions`,
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
        link.chainId,
        link.gatewayOrderId ?? null,
        link.maxRedemptions ?? 0,
      ],
    );
  }

  async getLink(slug: string): Promise<PaymentLink | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM links WHERE slug = $1', [slug]);
    return rows.length ? mapLink(rows[0]!, this.defaultChainId) : undefined;
  }

  async listLinksForMerchant(merchantId: string): Promise<PaymentLink[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM links WHERE merchant_id = $1 ORDER BY created_at DESC',
      [merchantId],
    );
    return rows.map((r) => mapLink(r, this.defaultChainId));
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

  /**
   * Mint a fresh orderId for this claim, honouring `maxRedemptions` inside the same transaction
   * that counts existing claims. The `SELECT ... FOR UPDATE` on the link row serializes concurrent
   * claims for one link, so two customers racing for the final redemption cannot both succeed.
   */
  async mintClaimedOrder(
    slug: string,
    payerAddress: string,
    maxRedemptions: number,
  ): Promise<string | undefined> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const linkRows = await client.query('SELECT slug FROM links WHERE slug = $1 FOR UPDATE', [slug]);
      if (!linkRows.rows.length) {
        await client.query('ROLLBACK');
        return undefined;
      }
      if (maxRedemptions > 0) {
        const { rows: countRows } = await client.query(
          'SELECT COUNT(*)::int AS n FROM claims WHERE slug = $1',
          [slug],
        );
        if ((countRows[0]!.n as number) >= maxRedemptions) {
          await client.query('ROLLBACK');
          return undefined;
        }
      }
      const orderId = '0x' + randomBytes(32).toString('hex');
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

  async claimFixedOrder(
    slug: string,
    orderId: string,
    payerAddress: string,
    staleAfterMs: number,
  ): Promise<FixedOrderClaimResult> {
    const client: PoolClient = await this.pool.connect();
    try {
      // Serialize on the link row, exactly like mintClaimedOrder: two wallets racing for the same
      // gateway order id must not both come away believing they own it.
      await client.query('BEGIN');
      const linkRows = await client.query('SELECT slug FROM links WHERE slug = $1 FOR UPDATE', [slug]);
      if (!linkRows.rows.length) {
        await client.query('ROLLBACK');
        return { status: 'taken' };
      }
      const payer = payerAddress.toLowerCase();
      const { rows } = await client.query(
        'SELECT payer_address, claimed_at, settled FROM claims WHERE slug = $1 AND order_id = $2 FOR UPDATE',
        [slug, orderId],
      );
      const existing = rows[0] as
        | { payer_address: string; claimed_at: number; settled: boolean }
        | undefined;
      if (!existing) {
        await client.query(
          `INSERT INTO claims (slug, order_id, payer_address, claimed_at, settled)
           VALUES ($1, $2, $3, $4, false)`,
          [slug, orderId, payer, Date.now()],
        );
        await client.query('COMMIT');
        return { status: 'claimed' };
      }
      if (existing.settled) {
        await client.query('ROLLBACK');
        return { status: 'settled' };
      }
      const age = Date.now() - Number(existing.claimed_at);
      if (existing.payer_address !== payer && age < staleAfterMs) {
        await client.query('ROLLBACK');
        return { status: 'taken' };
      }
      await client.query(
        'UPDATE claims SET payer_address = $1, claimed_at = $2 WHERE slug = $3 AND order_id = $4',
        [payer, Date.now(), slug, orderId],
      );
      await client.query('COMMIT');
      return { status: 'claimed' };
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

  async listClaims(slug: string): Promise<LinkClaim[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM claims WHERE slug = $1 ORDER BY claimed_at ASC, order_id ASC`,
      [slug],
    );
    return rows.map(mapClaim);
  }

  // --- order metadata ---

  async saveOrderMeta(meta: OrderMeta): Promise<void> {
    await this.pool.query(
      `INSERT INTO order_meta (order_id, merchant_address, customer_name, source, slug, reference, created_at, chain_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (order_id) DO UPDATE SET
         customer_name = COALESCE(EXCLUDED.customer_name, order_meta.customer_name),
         source        = EXCLUDED.source,
         slug          = EXCLUDED.slug,
         reference     = COALESCE(EXCLUDED.reference, order_meta.reference),
         chain_id      = EXCLUDED.chain_id`,
      [
        meta.orderId.toLowerCase(),
        meta.merchantAddress.toLowerCase(),
        meta.customerName ?? null,
        meta.source,
        meta.slug ?? null,
        meta.reference ?? null,
        meta.createdAt,
        meta.chainId,
      ],
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
      chainId: r.chain_id === null ? this.defaultChainId : toNum(r.chain_id),
      merchantAddress: r.merchant_address as string,
      customerName: (r.customer_name as string | null) ?? undefined,
      source: r.source as OrderMeta['source'],
      slug: (r.slug as string | null) ?? undefined,
      reference: (r.reference as string | null) ?? undefined,
      createdAt: Number(r.created_at),
    };
  }

  // --- Qi per-order receive addresses ---

  /** The address UNIQUE index is the enforcement point for Qi address reuse (an address handed to
   *  two orders would misattribute payments). A conflicting address raises a unique_violation,
   *  which the caller treats as "derive again"; an existing orderId is a no-op via ON CONFLICT. */
  async insertQiOrder(order: QiOrder): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO qi_orders (order_id, merchant_address, address, qits, received_qits, settled, tx_hashes, created_at, settled_at)
       VALUES ($1, $2, $3, $4, '0', false, '[]'::jsonb, $5, NULL)
       ON CONFLICT (order_id) DO NOTHING`,
      [order.orderId.toLowerCase(), order.merchantAddress.toLowerCase(), order.address, order.qits, order.createdAt],
    );
    return (rowCount ?? 0) === 1;
  }

  async getQiOrder(orderId: string): Promise<QiOrder | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM qi_orders WHERE order_id = $1', [
      orderId.toLowerCase(),
    ]);
    return rows.length ? mapQiOrder(rows[0]!) : undefined;
  }

  async listQiOrders(): Promise<QiOrder[]> {
    const { rows } = await this.pool.query('SELECT * FROM qi_orders');
    return rows.map(mapQiOrder);
  }

  async listQiOrdersByMerchant(merchantAddress: string): Promise<QiOrder[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM qi_orders WHERE merchant_address = $1 ORDER BY created_at DESC',
      [merchantAddress.toLowerCase()],
    );
    return rows.map(mapQiOrder);
  }

  async markQiOrderSettled(orderId: string, receivedQits: string, txHashes: string[]): Promise<QiOrder | undefined> {
    const { rows } = await this.pool.query(
      `UPDATE qi_orders
       SET received_qits = $2, tx_hashes = $3::jsonb, settled = true, settled_at = $4
       WHERE order_id = $1
       RETURNING *`,
      [orderId.toLowerCase(), receivedQits, JSON.stringify(txHashes), Date.now()],
    );
    return rows.length ? mapQiOrder(rows[0]!) : undefined;
  }

  /** Pop an orderId off the pool without binding a payer, reusing the same locked transaction as
   *  {@link claimOrderFromPool} minus the claim-row insert with a real payer. */
  async reserveQiLinkOrder(slug: string): Promise<string | undefined> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT order_pool FROM links WHERE slug = $1 FOR UPDATE', [slug]);
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
        [slug, orderId, 'qi', Date.now()],
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

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// --- row → domain mappers (int8 columns come back as decimal strings from node-postgres) ---

const toNum = (v: unknown): number => Number(v);

function mapPayoutAddress(row: Record<string, unknown>): MerchantPayoutAddress {
  return {
    merchantId: row.merchant_id as string,
    chainId: toNum(row.chain_id),
    address: row.address as string,
    source: row.source as PayoutAddressSource,
    createdAt: toNum(row.created_at),
  };
}

function mapMerchant(row: Record<string, unknown>): Merchant {  return {
    merchantId: row.merchant_id as string,
    address: row.address as string,
    name: row.name as string,
    webhookUrl: row.webhook_url as string,
    webhookSecret: row.webhook_secret as string,
    active: row.active as boolean,
    createdAt: toNum(row.created_at),
    ...(row.settings
      ? {
          settings: {
            quaiMarkupBps:
              ((row.settings as { quaiMarkupBps?: number })?.quaiMarkupBps ?? 0),
            fiatCurrencies:
              ((row.settings as { fiatCurrencies?: string[] })?.fiatCurrencies ?? ['USD', 'NGN']),
          } as Merchant['settings'],
        }
      : {}),
  };
}

function mapDelivery(row: Record<string, unknown>, defaultChainId: number): WebhookDelivery {
  const payload = row.payload as WebhookDelivery['payload'];
  return {
    id: row.id as string,
    // `deliveries` has no chain_id column — the chain lives on the payload, which every writer
    // populates. Fall back to the deployment default only for rows predating multi-chain.
    chainId: payload.data.chainId ?? defaultChainId,
    merchantId: row.merchant_id as string,
    url: row.url as string,
    payload,
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

function mapLink(row: Record<string, unknown>, defaultChainId: number): PaymentLink {
  return {
    slug: row.slug as string,
    chainId: row.chain_id === null ? defaultChainId : toNum(row.chain_id),
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
    maxRedemptions: toNum(row.max_redemptions ?? 0),
    ...((row.gateway_order_id as string | null | undefined)
      ? { gatewayOrderId: row.gateway_order_id as string }
      : {}),
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

function mapQiOrder(row: Record<string, unknown>): QiOrder {
  return {
    orderId: row.order_id as string,
    merchantAddress: row.merchant_address as string,
    address: row.address as string,
    qits: row.qits as string,
    receivedQits: row.received_qits as string,
    settled: row.settled as boolean,
    txHashes: (row.tx_hashes as string[] | null) ?? [],
    createdAt: toNum(row.created_at),
    settledAt: row.settled_at === null ? null : toNum(row.settled_at),
  };
}