import { z } from 'zod';
import { DEV_API_KEY_PEPPER } from './util/apikey.js';

/**
 * Environment configuration, validated at startup. Any missing/invalid value fails fast with a
 * readable error rather than surfacing as a confusing runtime crash later.
 */
const boolish = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1'));

const EnvSchema = z.object({
  // --- Multi-chain configuration (see src/chains.ts) ---------------------------------------
  // CHAINS_JSON (inline JSON array) or CHAINS_CONFIG_PATH (path to a JSON file, default
  // ./chains.json if present) describe every chain this process serves; see
  // backend/chains.example.json and backend/README.md. When NEITHER is set and no ./chains.json
  // file exists, chains.ts synthesizes a single chain from the legacy vars below (RPC_URL,
  // CHAIN_ID, PAYWITHQUAI_ADDRESS, CHAIN_KIND, START_BLOCK, CONFIRMATIONS, POLL_INTERVAL_MS,
  // MAX_BLOCK_RANGE, ACCEPTED_TOKENS) so an existing single-chain deployment is unaffected.
  CHAINS_JSON: z.string().optional(),
  CHAINS_CONFIG_PATH: z.string().optional(),

  // Selects the chain client for the LEGACY single-chain fallback path above (chains.ts only
  // reads this when neither CHAINS_JSON nor a chains.json file is present).
  // DEPRECATED: prefer CHAINS_JSON/CHAINS_CONFIG_PATH, where each chain declares its own "kind".
  // Kept working indefinitely for existing single-chain deployments — never removed silently.
  // "quai" (default) is the quais-SDK path — Cyprus-1 zone rules, Qi support. "evm" is the
  // ethers v6 path for standard EVM chains (Robinhood Chain testnet, Base Sepolia, ...).
  CHAIN_KIND: z.enum(['quai', 'evm']).default('quai'),

  RPC_URL: z.string().url(),
  CHAIN_ID: z.coerce.number().int().positive(),
  PAYWITHQUAI_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'PAYWITHQUAI_ADDRESS must be a 20-byte hex address'),
  START_BLOCK: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? Number(v) : undefined))
    .pipe(z.number().int().nonnegative().optional()),

  CONFIRMATIONS: z.coerce.number().int().nonnegative().default(12),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  MAX_BLOCK_RANGE: z.coerce.number().int().positive().default(2000),

  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  WEBHOOK_BASE_BACKOFF_MS: z.coerce.number().int().positive().default(5000),
  WEBHOOK_MAX_BACKOFF_MS: z.coerce.number().int().positive().default(3_600_000),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  // SSRF guard escape hatch. When false (default/production) webhook URLs must be https and must
  // not resolve to private/loopback/reserved addresses. Set true only for local development against
  // an http://localhost receiver.
  // SSRF guard escape hatch. When false (default/production) webhook URLs must be https and must
  // not resolve to private/loopback/reserved addresses. Set true only for local development against
  // an http://localhost receiver; loading the config in production with this true is a fatal error.
  WEBHOOK_ALLOW_INSECURE_URLS: boolish(false),

  PORT: z.coerce.number().int().positive().default(8080),
  // Number of reverse proxies in front of the app (0 = none). Only with this set is `req.ip`
  // (used by the rate limiter and login logging) the real client address; set it to the exact
  // hop count of your infrastructure, never blindly 1 if there is no proxy.
  TRUST_PROXY: z.coerce.number().int().nonnegative().default(0),
  // Realm bound into the wallet-login challenge message, alongside CHAIN_ID. A signature captured
  // against one deployment can never be replayed against another deployment that uses a different
  // realm or chain id. Keep it stable per deployment.
  LOGIN_REALM: z.string().min(1).default('tripplepay'),
  // Comma-separated list of allowed browser origins for the HTTP API, or `*` for any origin.
  // Only relevant in local dev — the dashboard runs on a different port than the backend.
  CORS_ORIGINS: z.string().default('*'),
  ADMIN_API_KEY: z.string().min(16, 'ADMIN_API_KEY should be at least 16 chars'),

  // HMAC key used to derive the stored hash of every merchant API key. Merchant keys are bearer
  // credentials, so they are persisted only as HMAC-SHA256(API_KEY_PEPPER, key) — a database dump
  // (or a leaked backup, or a read-only SQL injection) therefore yields nothing an attacker can
  // replay. Without the pepper, offline brute-forcing a stolen api_keys table becomes possible.
  //   generate with:  node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
  // Must be STABLE across restarts and replicas: changing it invalidates every issued key.
  API_KEY_PEPPER: z.string().min(16, 'API_KEY_PEPPER should be at least 16 chars').default(DEV_API_KEY_PEPPER),
  // Optional ERC-20 allowlist for payment links (comma-separated addresses). Native QUAI is
  // always allowed. When unset/empty, any 20-byte token address may be used.
  ACCEPTED_TOKENS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => /^0x[0-9a-f]{40}$/.test(s)),
    ),
  // Rate limit for the single unauthenticated, RPC-backed route (GET /v1/orders/...): max requests
  // per IP per window. Protects the upstream Quai RPC from being used as an amplification target.
  PUBLIC_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  PUBLIC_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),

  // --- Qi payments (UTXO-ledger checkout) ---------------------------------------------
  // The entire Qi surface is feature-gated: unless BOTH QI_MNEMONIC and QI_RPC_URL are set, the
  // backend never derives Qi addresses, order APIs return `qi: null`, and the Qi indexer is idle.
  //   QI_MNEMONIC: the merchant's Qi HD wallet seed phrase (BIP44, m/44'/969'/0'/0/<n>).
  //   QI_RPC_URL:  a JSON-RPC endpoint for the chain Qi addresses live on. Qi derives on
  //                Cyprus-1 (m/44'/969'/0'/0/<n>), so this is the SAME endpoint as the Quai
  //                Cyprus-1 RPC: https://rpc.quai.network/cyprus1. The /cyprus1 path suffix is
  //                required — the bare host answers eth_chainId but fails every eth_call.
  QI_MNEMONIC: z.string().min(1).optional(),
  QI_RPC_URL: z.string().url().optional(),
  // Qi price per 1 QUAI of an order, in qits. 1000 qits = 1 Qi, but the whole rate is tunable so a
  // merchant can discount Qi payments. The checkout amounts are QUAI-denominated; the frontend
  // shows the derived qits amount exactly, and settlement succeeds only once unspent outpoints on
  // the order's receive address sum to >= this value.
  QI_QITS_PER_QUAI: z.coerce.number().int().nonnegative().default(1000),
  // How often the Qi indexer polls pending orders' receive addresses for incoming UTXOs
  // (quai_getOutpointsByAddress). Qi has no contract events to subscribe to.
  QI_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(8000),
  // --- LOCAL-DEV ONLY: demo/test affordances for Qi ------------------------------------------
  // QI_DEV_SIMULATE turns on two DO-NOT-USE-IN-PRODUCTION behaviors:
  //   1. GET /v1/orders/<QI_DEV_DEMO_MERCHANT>/<orderId> synthesizes a not-found on-chain order
  //      (so the checkout page renders without a real PayWithQuai registration), and
  //   2. POST /v1/dev/qi-settle/:orderId forcibly marks a Qi order settled (so the full
  //      settle → paid → webhook-queue lifecycle can be exercised with zero mainnet funds).
  // Both are additionally guarded by ADMIN_API_KEY; loading with NODE_ENV=production is fatal.
  QI_DEV_SIMULATE: boolish(false),
  // Merchant address GET /v1/orders will fabricate orders for when QI_DEV_SIMULATE is on.
  QI_DEV_DEMO_MERCHANT: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'QI_DEV_DEMO_MERCHANT must be a 20-byte hex address')
    .optional(),

  DATABASE_PATH: z.string().default('./data/relayer.db'),
  // When set, the relayer uses PostgreSQL instead of the JSON file (DATABASE_PATH is ignored).
  // Railway exposes this automatically as DATABASE_URL when a Postgres service is attached.
  DATABASE_URL: z.string().optional(),
  // Force TLS for the Postgres connection (Railway requires it). Auto-detected from sslmode in
  // DATABASE_URL when present; set true explicitly if your URL omits it.
  DATABASE_SSL: boolish(false),

  // Supabase's *direct* host (db.<ref>.supabase.co) publishes only an AAAA record, so it is
  // unreachable from any IPv4-only runtime — including Render. Use the IPv4 pooler host
  // (aws-0-<region>.pooler.supabase.com) instead. Prefer the SESSION pooler on :5432 over the
  // transaction pooler on :6543: node-postgres sends parameterized queries over the extended
  // protocol, which PgBouncer in transaction mode does not support.
  //
  // A session-pooler connection occupies one backend for its lifetime, so the pool must stay
  // small: Supabase's free tier allows only a handful of connections per project. Lower this
  // (3-5) whenever DATABASE_URL points at Supabase.
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),

  // How long to wait for a pooled connection before failing. Bounds connection ACQUISITION, not
  // query execution, so it only needs raising when a managed pooler is slow to hand out a
  // backend under burst load.
  DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  // Supabase and Railway both present publicly-trusted certificates for their own hostnames, so
  // `rejectUnauthorized: true` does work against them. It stays off by default because some
  // managed-Postgres proxies present chains node can't verify, and turning this on must be a
  // deliberate, tested step rather than a silent production boot failure.
  DATABASE_SSL_REJECT_UNAUTHORIZED: boolish(false),

  // --- e-commerce gateway (fiat-quoted prefilled orders for shop plugins) ---
  // Live QUAI↔fiat rate feed used by POST /v1/gateway/orders. Points at a CoinGecko-style
  // `simple/price` JSON (ids=quai-network, vs_currencies=usd,ngn). When unset (or on fetch
  // failure) the fixed GATEWAY_FALLBACK_* rates are used; when neither exists the gateway rejects
  // gateway orders with a clear "no rate available" error.
  GATEWAY_RATE_URL: z.string().url().optional(),
  // How long a fetched rate is cached before the next gateway quote re-fetches it.
  GATEWAY_RATE_TTL_MS: z.coerce.number().int().positive().default(60_000),
  GATEWAY_FALLBACK_USD_PER_QUAI: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? Number(v) : undefined))
    .pipe(z.number().positive().optional()),
  GATEWAY_FALLBACK_NGN_PER_QUAI: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? Number(v) : undefined))
    .pipe(z.number().positive().optional()),
  // Default per-merchant markup applied when a merchant hasn't set settings.quaiMarkupBps.
  GATEWAY_MARKUP_BPS_DEFAULT: z.coerce.number().int().min(0).max(10_000).default(0),
  // Public origin of the payment page (e.g. https://pay.example.com). Used to build the
  // checkoutUrl a gateway order returns. When unset the backend derives it from the request
  // (protocol + host) — set it explicitly behind a proxy/NAT so links stay correct.
  PUBLIC_BASE_URL: z.string().url().optional(),

  // --- off-chain order signing (customer pays gas) ---------------------------------------
  // The backend signs EIP-712 order authorizations instead of broadcasting a registration tx, so
  // the merchant never needs a funded wallet to publish a link and the platform spends no gas:
  // the customer's own transaction creates and settles the order. The derived address must be
  // allowlisted on each deployment with setSigner(address, true).
  ORDER_SIGNER_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, 'ORDER_SIGNER_PRIVATE_KEY must be a 32-byte hex private key')
    .optional(),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_PRETTY: boolish(false),
});

export type Config = z.infer<typeof EnvSchema>;

let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  // The dev default keeps `npm run dev` and the test-suite working with a zero-config .env, but it
  // is a constant in the source, so production must supply a real one.
  if (env.NODE_ENV === 'production' && parsed.data.API_KEY_PEPPER === DEV_API_KEY_PEPPER) {
    throw new Error(
      'API_KEY_PEPPER is required when NODE_ENV=production. Merchant API keys are stored as ' +
        'HMAC-SHA256(pepper, key) so that a database leak cannot be replayed; without a real ' +
        'pepper the API-key hashing silently falls back to a constant compiled into the source. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))" ' +
        'and keep it stable across restarts and replicas.',
    );
  }
  if (parsed.data.WEBHOOK_ALLOW_INSECURE_URLS && env.NODE_ENV === 'production') {
    throw new Error(
      'WEBHOOK_ALLOW_INSECURE_URLS=true is not allowed with NODE_ENV=production — ' +
        'it disables the SSRF guard (https requirement + private-address blocking).',
    );
  }
  if (parsed.data.QI_DEV_SIMULATE && env.NODE_ENV === 'production') {
    throw new Error(
      'QI_DEV_SIMULATE=true is not allowed with NODE_ENV=production — it fabricates checkout ' +
        'orders and lets anyone with the admin key mark Qi orders settled without payment.',
    );
  }
  // Qi (UTXO-ledger checkout) is Quai-only — it has no meaning on a standard EVM chain. Checked
  // against the raw env (not parsed.data) so a QI_* var left at its zod default doesn't trip
  // this — only a value the operator actually set does.
  if (parsed.data.CHAIN_KIND === 'evm') {
    const qiVarsSet = Object.keys(env).filter(
      (k) => k.startsWith('QI_') && env[k] !== undefined && env[k] !== '',
    );
    if (qiVarsSet.length > 0) {
      throw new Error(
        `CHAIN_KIND=evm cannot be combined with Qi variables (${qiVarsSet.join(', ')}) — Qi is ` +
          'Quai-only. Remove them from this deployment\'s env, or run it with CHAIN_KIND=quai (or unset).',
      );
    }
  }
  cached = parsed.data;
  return cached;
}
