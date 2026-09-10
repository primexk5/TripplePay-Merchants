import 'dotenv/config';
import type { Server } from 'node:http';
import { loadConfig } from './config.js';
import { logger, log } from './logger.js';
import { JsonStore } from './store/json.js';
import { PostgresStore } from './store/postgres.js';
import type { Store } from './store/index.js';
import { QuaiClient } from './chain/client.js';
import { QiService } from './chain/qi.js';
import { Indexer } from './indexer/indexer.js';
import { QiIndexer } from './indexer/qi-indexer.js';
import { WebhookDispatcher } from './webhooks/dispatcher.js';
import { createServer } from './api/server.js';

const boot = log('main');

async function main(): Promise<void> {
  const cfg = loadConfig();
  boot.info(
    {
      chainId: cfg.CHAIN_ID,
      contract: cfg.PAYWITHQUAI_ADDRESS,
      confirmations: cfg.CONFIRMATIONS,
      env: process.env.NODE_ENV ?? 'development',
    },
    'starting Pay with Quai relayer',
  );
  if (cfg.WEBHOOK_ALLOW_INSECURE_URLS) {
    boot.warn(
      'WEBHOOK_ALLOW_INSECURE_URLS=true — SSRF guard DISABLED (https requirement and private-address blocking skipped). Intended for local dev only; will not boot with NODE_ENV=production.',
    );
  }

  // Postgres (DATABASE_URL) when available — required for HA / multiple instances (Railway);
  // otherwise fall back to the single-process JSON file store.
  const store: Store = cfg.DATABASE_URL
    ? (() => {
        const pg = new PostgresStore(cfg.DATABASE_URL, { ssl: cfg.DATABASE_SSL });
        boot.info('using PostgreSQL store');
        return pg;
      })()
    : new JsonStore(cfg.DATABASE_PATH);
  const client = new QuaiClient(cfg);
  const dispatcher = new WebhookDispatcher(store, cfg);
  const indexer = new Indexer(client, store, cfg);
  // Qi settlement (UTXO-ledger checkout). Feature-gated by QI_MNEMONIC + QI_RPC_URL; when either
  // is absent the service stays disabled and the API reports `qi: {enabled:false}`.
  const qi = new QiService(cfg, store);
  const qiIndexer = new QiIndexer(qi, store, cfg);

  const app = createServer(store, client, cfg, qi);
  const server: Server = app.listen(cfg.PORT, () => boot.info({ port: cfg.PORT }, 'HTTP API listening'));

  if (store instanceof PostgresStore) await store.init();
  // Seed the Qi wallet with already-persisted receive addresses BEFORE any fresh derivation —
  // the in-memory BIP44 counter resets on restart and would otherwise re-derive old addresses.
  await qi.init();
  dispatcher.start();
  await indexer.start();
  await qiIndexer.start();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    boot.info({ signal }, 'shutting down');
    await indexer.stop();
    await qiIndexer.stop();
    await dispatcher.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
    boot.info('shutdown complete');
    process.exit(0);
  };

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => void shutdown(sig));
  }
  process.on('unhandledRejection', (reason) => {
    // A rejected promise that nobody handled means an async path is in an unknown state (a queued
    // webhook may have silently not been sent). Log it and exit so the process manager restarts
    // into a known state instead of limping on.
    logger().fatal({ reason }, 'unhandledRejection — exiting');
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    logger().fatal({ err }, 'uncaughtException — exiting');
    process.exit(1);
  });
}

main().catch((err) => {
  logger().fatal({ err }, 'failed to start');
  process.exit(1);
});
