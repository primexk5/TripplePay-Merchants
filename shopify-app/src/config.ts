import { z } from 'zod';

const boolish = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1'));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3002),
  SHOPIFY_API_KEY: z.string().min(1),
  SHOPIFY_API_SECRET: z.string().min(1),
  SHOPIFY_APP_URL: z.string().url(),
  SHOPIFY_SCOPES: z.string().default('read_orders,write_orders'),
  GATEWAY_BASE_URL: z.string().url(),
  /** Legacy shared credentials. Optional: stores that have saved their own credentials (see
   *  StoreSettings) bill to their own merchant account instead. Kept as a fallback so an existing
   *  single-store deployment keeps working through the per-store migration — but every store on one
   *  shared key means every store's orders bill to the same merchant, which is not multi-tenant.
   *  Logged as a deprecation warning at boot when unset and no store has its own credentials. */
  GATEWAY_MERCHANT_KEY: z.string().min(1).optional(),
  GATEWAY_WEBHOOK_SECRET: z.string().min(1).optional(),
  GATEWAY_FIAT_CURRENCY: z.string().min(2).max(4).default('USD'),
  /** How long an issued OAuth `state` stays valid before the install is rejected as stale. */
  OAUTH_STATE_TTL_MS: z.coerce.number().int().positive().default(600_000),
  /** How often to sweep lapsed gateway quotes into `expired`. */
  EXPIRY_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  /** Postgres connection string. Set this for a real deployment: without it the connector uses a
   *  single-process JSON file whose Shopify access tokens are lost on restart. */
  DATABASE_URL: z.string().optional(),
  DATABASE_SSL: boolish(false),
  /** AES-256-GCM key protecting per-store gateway credentials at rest. Required when
   *  NODE_ENV=production. Generate with:
   *  node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   *  Losing it means every stored store credential must be re-entered. */
  CONNECTOR_ENCRYPTION_KEY: z.string().min(16).optional(),
  STORE_PATH: z.string().default('./data'),
  ALLOW_INSECURE_SHOP_HOST: boolish(false),
  LOG_PRETTY: boolish(false),
});

export interface Config {
  NODE_ENV: 'development' | 'production' | 'test';
  PORT: number;
  SHOPIFY_API_KEY: string;
  SHOPIFY_API_SECRET: string;
  SHOPIFY_APP_URL: string;
  SHOPIFY_SCOPES: string;
  GATEWAY_BASE_URL: string;
  GATEWAY_MERCHANT_KEY?: string;
  GATEWAY_WEBHOOK_SECRET?: string;
  GATEWAY_FIAT_CURRENCY: string;
  DATABASE_URL?: string;
  DATABASE_SSL: boolean;
  CONNECTOR_ENCRYPTION_KEY?: string;
  OAUTH_STATE_TTL_MS: number;
  EXPIRY_SWEEP_INTERVAL_MS: number;
  STORE_PATH: string;
  ALLOW_INSECURE_SHOP_HOST: boolean;
  LOG_PRETTY: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`invalid configuration: ${parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`);
  }
  if (env.NODE_ENV === 'production' && !parsed.data.CONNECTOR_ENCRYPTION_KEY) {
    throw new Error(
      'CONNECTOR_ENCRYPTION_KEY is required when NODE_ENV=production. Each store\'s gateway ' +
        'credentials are sealed with AES-256-GCM under this key; without it the connector would ' +
        'have to store bearer credentials that can move a merchant\'s funds in the clear. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"',
    );
  }
  return parsed.data as Config;
}