import type { ConnectorStore } from './index.js';
import { FileStore } from './file.js';
import { PostgresConnectorStore } from './postgres.js';
import { log } from '../logger.js';
import type { Config } from '../config.js';

/**
 * Picks the store implementation. `DATABASE_URL` selects Postgres; otherwise the single-process JSON
 * file store is used, which is right for local development and a single instance.
 */
export async function createStore(cfg: Config): Promise<ConnectorStore> {
  if (cfg.DATABASE_URL) {
    const pg = new PostgresConnectorStore(cfg.DATABASE_URL, { ssl: cfg.DATABASE_SSL });
    await pg.init();
    log('store').info('using PostgreSQL store');
    return pg;
  }
  log('store').warn('using the single-process JSON file store — set DATABASE_URL for a real deployment');
  return new FileStore(cfg.STORE_PATH);
}

export { FileStore, PostgresConnectorStore };
