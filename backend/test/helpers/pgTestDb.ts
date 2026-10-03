import pg from 'pg';

/**
 * Gives a live-Postgres suite its own schema inside the shared test database.
 *
 * Both live suites ({@link ../postgres.test}, {@link ../storeMigration.test}) point at the same
 * TEST_DATABASE_URL, and `postgres.test.ts` TRUNCATEs every table in `beforeEach`. Vitest runs
 * test FILES in parallel by default, so on a shared database they destroy each other's fixtures:
 * setting TEST_DATABASE_URL and running `npm test` failed 14 tests that pass individually.
 *
 * Serializing them (`--no-file-parallelism`) would work but slows the whole suite, and the fast
 * JSON tests are the bulk of it. Routing each suite through a private schema keeps them isolated
 * AND parallel. PostgresStore issues unqualified DDL and DML, so a `search_path` pointed at that
 * schema is all it takes — and unlike a second database it needs no CREATE DATABASE privilege,
 * which managed Postgres (Supabase's PgBouncer pooler included) often withholds.
 *
 * Verified through the Supabase pooler: `options=-c search_path=...` is honored, and a table
 * created there does not appear in `public`.
 */

/** A remote database is not localhost: DDL batches and multi-statement fixtures each cost a
 *  round-trip, so the 5s default expires even though every assertion passes. Only live-DB suites
 *  are affected — these timeouts sit on describes that skip entirely without TEST_DATABASE_URL. */
export const REMOTE_DB_TIMEOUT_MS = 60_000;

/**
 * Returns TEST_DATABASE_URL rewritten to use a private schema, creating it if needed.
 * Returns undefined when TEST_DATABASE_URL is unset, so callers keep their skip behavior.
 */
export async function isolatedTestDb(name: string): Promise<string | undefined> {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) return undefined;
  const separator = base.includes('?') ? '&' : '?';
  const url =
    base + separator + 'options=' + encodeURIComponent(`-c search_path=${name},public`);
  const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 15_000 });
  try {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${name}`);
  } finally {
    await pool.end();
  }
  return url;
}

/** Drops a schema created by {@link isolatedTestDb}. Best-effort: never fails a suite. */
export async function dropTestSchema(name: string, url?: string): Promise<void> {
  if (!url) return;
  const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 15_000 });
  try {
    await pool.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
  } catch {
    // A leftover schema is harmless; failing the suite over cleanup would be worse.
  } finally {
    await pool.end();
  }
}
