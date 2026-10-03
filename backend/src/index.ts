import 'dotenv/config';
import type { Server } from 'node:http';
import { loadConfig, type Config } from './config.js';
import { loadChains, isLegacyChainConfig } from './chains.js';
import { logger, log } from './logger.js';
import { JsonStore } from './store/json.js';
import { PostgresStore } from './store/postgres.js';
import type { Store } from './store/index.js';
import { ChainRegistry } from './chain/index.js';
import { QiService } from './chain/qi.js';
import { Indexer } from './indexer/indexer.js';
import { QiIndexer } from './indexer/qi-indexer.js';
import { WebhookDispatcher } from './webhooks/dispatcher.js';
import { createServer } from './api/server.js';

const boot = log('main');

async function main(): Promise<void> {
  const cfg = loadConfig();
  const chains = loadChains(cfg);
  const registry = new ChainRegistry(chains);

  boot.info(
    {
      chains: registry.entries.map((e) => ({ id: e.config.id, chainId: e.config.chainId, kind: e.config.kind })),
      default: registry.default.config.id,
      env: process.env.NODE_ENV ?? 'development',
    },
    'starting Pay with Quai relayer',
  );
  if (isLegacyChainConfig()) {
    boot.warn(
      'CHAIN_KIND is deprecated — configure chains via CHAINS_JSON / CHAINS_CONFIG_PATH (see ' +
        'backend/chains.example.json and backend/README.md). It keeps working indefinitely for ' +
        'this legacy single-chain deployment and will not be removed without notice.',
    );
  }
  if (cfg.WEBHOOK_ALLOW_INSECURE_URLS) {
    boot.warn(
      'WEBHOOK_ALLOW_INSECURE_URLS=true — SSRF guard DISABLED (https requirement and private-address blocking skipped). Intended for local dev only; will not boot with NODE_ENV=production.',
    );
  }

  // Postgres (DATABASE_URL) when available — required for HA / multiple instances (Railway);
  // otherwise fall back to the single-process JSON file store. Either way, a pre-multi-chain
  // record with no chainId of its own reads back as the DEFAULT chain (chains.ts) — never a
  // hardcoded guess.
  const store: Store = cfg.DATABASE_URL
    ? (() => {
        const pg = new PostgresStore(
          cfg.DATABASE_URL,
          {
            ssl: cfg.DATABASE_SSL,
            maxConnections: cfg.DATABASE_POOL_MAX,
            rejectUnauthorized: cfg.DATABASE_SSL_REJECT_UNAUTHORIZED,
            connectTimeoutMillis: cfg.DATABASE_CONNECT_TIMEOUT_MS,
          },
          registry.default.config.chainId,
          cfg.API_KEY_PEPPER,
        );
        boot.info('using PostgreSQL store');
        return pg;
      })()
    : new JsonStore(cfg.DATABASE_PATH, registry.default.config.chainId, cfg.API_KEY_PEPPER);

  const dispatcher = new WebhookDispatcher(store, cfg);

  // One Indexer per ENABLED chain, fully isolated: each gets its own Config-shim (so its
  // cursorScope/CONFIRMATIONS/POLL_INTERVAL_MS/MAX_BLOCK_RANGE/START_BLOCK are that chain's own —
  // see chain/index.ts's createChainClient for why a shim rather than changing Indexer/
  // QuaiClient/EvmClient), its own setInterval loop, and its own try/catch. A stuck or erroring
  // chain never blocks or is blocked by any other: there is no shared await across chains, and
  // indexer.ts bounds every RPC call with a per-call timeout so a truly hung provider can't leave
  // one chain's indexer stuck forever either.
  const indexers = new Map<number, Indexer>();
  for (const entry of registry.entries) {
    const chain = entry.config;
    const indexerCfg: Config = {
      ...cfg,
      CHAIN_ID: chain.chainId,
      PAYWITHQUAI_ADDRESS: chain.contractAddress,
      START_BLOCK: chain.startBlock,
      CONFIRMATIONS: chain.confirmations,
      POLL_INTERVAL_MS: chain.pollIntervalMs,
      MAX_BLOCK_RANGE: chain.maxBlockRange,
    };
    indexers.set(chain.chainId, new Indexer(entry.client, store, indexerCfg));
  }

  // Qi settlement (UTXO-ledger checkout) is Quai-only, and stays feature-gated exactly as before
  // (QI_MNEMONIC + QI_RPC_URL). Always constructed: chains.ts's validateChains already refuses to
  // boot if any QI_* var is set while no enabled chain has kind "quai", so by the time we reach
  // here either a Quai chain exists, or no QI_* vars are set and qi.enabled is simply false —
  // QiIndexer.start() is itself already a no-op when qi.enabled is false, so there is nothing
  // chain-specific to gate here.
  const qi = new QiService(cfg, store);
  // Qi settles on the default (Quai) chain — pass its chainId so Qi payloads/deliveries are
  // labeled the same way the on-chain indexers label theirs.
  const qiIndexer = new QiIndexer(qi, store, cfg, registry.default.config.chainId);

  const app = createServer(store, registry.default.client, cfg, qi, registry, indexers);
  const server: Server = app.listen(cfg.PORT, () => boot.info({ port: cfg.PORT }, 'HTTP API listening'));

  if (store instanceof PostgresStore) await store.init();
  // Seed the Qi wallet with already-persisted receive addresses BEFORE any fresh derivation —
  // the in-memory BIP44 counter resets on restart and would otherwise re-derive old addresses.
  await qi.init();
  dispatcher.start();
  for (const indexer of indexers.values()) await indexer.start();
  await qiIndexer.start();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    boot.info({ signal }, 'shutting down');
    await Promise.all([...indexers.values()].map((i) => i.stop()));
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
