import { z } from 'zod';

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
  //   QI_RPC_URL:  a Quai Qi-chain JSON-RPC endpoint, e.g. https://qi-cyprus1.quai.network.
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
  cached = parsed.data;
  return cached;
}
