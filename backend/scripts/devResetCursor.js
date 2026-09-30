#!/usr/bin/env node
/**
 * Dev helper: resets ONE chain's indexer cursor to (current head - N) blocks.
 *
 * Robinhood Chain testnet (and other fast-block EVM testnets) produce blocks fast enough that a
 * backend paused for even a few hours can fall millions of blocks behind — replaying that whole
 * range on restart is slow and pointless for local testing. Hand-editing the store file while the
 * backend is running doesn't work either: it holds its own in-memory/pooled state and will
 * silently overwrite a manual edit on its next write. This script edits the store directly, and
 * refuses to run if the backend looks like it's still up.
 *
 * Usage:
 *   CHAIN_ID=46630 node backend/scripts/devResetCursor.js
 *   CHAIN_ID=46630 BLOCKS_BEHIND=5000 node backend/scripts/devResetCursor.js
 *
 * Env vars:
 *   CHAIN_ID            Required. Numeric chainId of the chain to reset — must be one of this
 *                        backend's configured chains (see backend/chains.example.json, or the
 *                        legacy RPC_URL/CHAIN_ID/PAYWITHQUAI_ADDRESS/CHAIN_KIND vars).
 *   BLOCKS_BEHIND        Optional. How far behind the current head to set the cursor (default
 *                        2000, matching MAX_BLOCK_RANGE's usual default).
 *   CHAINS_JSON          Optional. Same meaning as the backend's own var (inline JSON chain array).
 *   CHAINS_CONFIG_PATH   Optional. Same meaning as the backend's own var (path to a chains.json).
 *                        If neither is set, ./chains.json is used when present (same precedence
 *                        as backend/src/chains.ts), else the legacy single-chain env vars.
 *   DATABASE_PATH        Optional. JSON store path (default ./data/relayer.db, same as the
 *                        backend). Ignored when DATABASE_URL is set.
 *   DATABASE_URL         Optional. Postgres connection string — when set, Postgres is used
 *                        instead of the JSON store (same precedence as the backend).
 *   DATABASE_SSL         Optional ("true"/"false"). Force TLS for the Postgres connection.
 *   PORT / HEALTH_URL     Optional. Where to probe for a running backend before touching the
 *                        store (default http://localhost:${PORT ?? 8080}/health).
 *
 * This script performs exactly one read-only RPC call (current block number) against the chain's
 * own RPC, plus local file/DB reads and writes. It never touches contracts/ or frontend/, never
 * starts the backend, and never runs git.
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, renameSync } from 'node:fs';
import { JsonRpcProvider as EvmJsonRpcProvider } from 'ethers';
import { JsonRpcProvider as QuaiJsonRpcProvider, getZoneForAddress, toShard } from 'quais';
import { Pool } from 'pg';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name}.`);
    process.exit(1);
  }
  return v;
}

const CHAIN_ID = Number(requireEnv('CHAIN_ID'));
if (!Number.isInteger(CHAIN_ID) || CHAIN_ID <= 0) {
  console.error(`CHAIN_ID must be a positive integer; got "${process.env.CHAIN_ID}"`);
  process.exit(1);
}
const BLOCKS_BEHIND = Number(process.env.BLOCKS_BEHIND ?? '2000');
if (!Number.isInteger(BLOCKS_BEHIND) || BLOCKS_BEHIND < 0) {
  console.error(`BLOCKS_BEHIND must be a non-negative integer; got "${process.env.BLOCKS_BEHIND}"`);
  process.exit(1);
}

const PORT = process.env.PORT ?? '8080';
const HEALTH_URL = process.env.HEALTH_URL ?? `http://localhost:${PORT}/health`;

// --- [1] refuse to run while the backend is up ----------------------------------------------
async function backendIsRunning() {
  try {
    // Any HTTP response at all (even a 4xx/5xx) means something is listening on that port —
    // that's enough reason not to touch the store underneath it.
    await fetch(HEALTH_URL, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

if (await backendIsRunning()) {
  console.error(
    `[1] The backend appears to be running (got a response from ${HEALTH_URL}).\n` +
      '    Stop it first — editing the store while the backend has it open will be silently ' +
      'overwritten on its next write.',
  );
  process.exit(1);
}
console.log(`[1] No response from ${HEALTH_URL} — backend is not running, safe to proceed.`);

// --- [2] resolve the chain config (mirrors backend/src/chains.ts's own precedence) -----------
function legacyChainFromEnv() {
  const kind = process.env.CHAIN_KIND === 'evm' ? 'evm' : 'quai';
  return {
    id: kind === 'evm' ? 'evm' : 'quai',
    chainId: CHAIN_ID,
    kind,
    name: kind === 'evm' ? `EVM chain ${CHAIN_ID}` : 'Quai',
    rpcUrl: process.env.RPC_URL,
    contractAddress: process.env.PAYWITHQUAI_ADDRESS,
  };
}

function loadChains() {
  const inline = process.env.CHAINS_JSON?.trim();
  const path = process.env.CHAINS_CONFIG_PATH?.trim();
  if (inline) return JSON.parse(inline);
  if (path) return JSON.parse(readFileSync(path, 'utf8'));
  if (existsSync('./chains.json')) return JSON.parse(readFileSync('./chains.json', 'utf8'));
  return [legacyChainFromEnv()];
}

const chains = loadChains();
const chain = chains.find((c) => Number(c.chainId) === CHAIN_ID);
if (!chain) {
  console.error(
    `[2] No configured chain has chainId ${CHAIN_ID}. Configured: ` +
      `${chains.map((c) => c.chainId).join(', ') || '(none)'}`,
  );
  process.exit(1);
}
if (!chain.rpcUrl || !chain.contractAddress) {
  console.error(
    `[2] Chain ${CHAIN_ID} is missing rpcUrl/contractAddress — check chains.json, ` +
      'or RPC_URL/PAYWITHQUAI_ADDRESS for the legacy single-chain path.',
  );
  process.exit(1);
}
console.log(
  `[2] Chain resolved: ${chain.name ?? chain.id ?? CHAIN_ID} ` +
    `(kind=${chain.kind}, contract=${chain.contractAddress})`,
);

// --- [3] current head block, read-only ---------------------------------------------------------
async function currentHead(c) {
  if (c.kind === 'quai') {
    const zone = getZoneForAddress(c.contractAddress);
    if (!zone) throw new Error(`contractAddress ${c.contractAddress} is not a valid Quai zone address`);
    const shard = toShard(zone);
    const provider = new QuaiJsonRpcProvider(c.rpcUrl, undefined, { usePathing: true });
    return provider.getBlockNumber(shard);
  }
  const provider = new EvmJsonRpcProvider(c.rpcUrl);
  return provider.getBlockNumber();
}

const head = await currentHead(chain);
const newCursor = Math.max(0, head - BLOCKS_BEHIND);
console.log(`[3] Current head: ${head}. New cursor: ${newCursor} (head - ${BLOCKS_BEHIND}).`);

// --- [4]/[5] scope key (mirrors backend/src/indexer/indexer.ts's cursorScope()), backup + write ---
const scope = `${chain.chainId}:${chain.contractAddress.toLowerCase()}`;
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

if (process.env.DATABASE_URL) {
  const url = new URL(process.env.DATABASE_URL);
  const sslMode = url.searchParams.get('sslmode');
  const ssl = process.env.DATABASE_SSL === 'true' || (sslMode !== null && sslMode !== 'disable');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
  });
  try {
    const { rows } = await pool.query('SELECT block_number FROM cursors WHERE scope = $1', [scope]);
    const oldCursor = rows.length ? Number(rows[0].block_number) : null;

    // No single "store file" to copy for Postgres — back up the current row's value to a local
    // timestamped JSON file instead, so it can be restored with a manual UPDATE if needed.
    const backupPath = `./devResetCursor-backup-${scope.replace(/[:/]/g, '_')}-${timestamp}.json`;
    writeFileSync(backupPath, JSON.stringify({ scope, oldCursor, backedUpAt: new Date().toISOString() }, null, 2));
    console.log(`[4] Backed up the current cursor row to ${backupPath}`);

    await pool.query(
      `INSERT INTO cursors (scope, block_number) VALUES ($1, $2)
       ON CONFLICT (scope) DO UPDATE SET block_number = EXCLUDED.block_number`,
      [scope, newCursor],
    );
    console.log(`[5] Postgres cursor updated — scope=${scope} old=${oldCursor ?? '(none)'} new=${newCursor}`);
  } finally {
    await pool.end();
  }
} else {
  const dbPath = process.env.DATABASE_PATH ?? './data/relayer.db';
  if (!existsSync(dbPath)) {
    console.error(`[4] No JSON store found at ${dbPath} — nothing to reset (the backend creates it on first run).`);
    process.exit(1);
  }
  const backupPath = `${dbPath}.bak-${timestamp}`;
  copyFileSync(dbPath, backupPath);
  console.log(`[4] Backed up ${dbPath} to ${backupPath}`);

  const data = JSON.parse(readFileSync(dbPath, 'utf8'));
  data.cursors ??= {};
  const oldCursor = data.cursors[scope] ?? null;
  data.cursors[scope] = newCursor;

  // Atomic write, same pattern as backend/src/store/json.ts: temp file + rename.
  const tmpPath = `${dbPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  renameSync(tmpPath, dbPath);
  console.log(`[5] JSON store cursor updated — scope=${scope} old=${oldCursor ?? '(none)'} new=${newCursor}`);
}
