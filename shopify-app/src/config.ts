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
  GATEWAY_MERCHANT_KEY: z.string().min(1),
  GATEWAY_WEBHOOK_SECRET: z.string().min(1),
  GATEWAY_FIAT_CURRENCY: z.string().min(2).max(4).default('USD'),
  /** How long an issued OAuth `state` stays valid before the install is rejected as stale. */
  OAUTH_STATE_TTL_MS: z.coerce.number().int().positive().default(600_000),
  /** How often to sweep lapsed gateway quotes into `expired`. */
  EXPIRY_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
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
  GATEWAY_MERCHANT_KEY: string;
  GATEWAY_WEBHOOK_SECRET: string;
  GATEWAY_FIAT_CURRENCY: string;
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
  return parsed.data as Config;
}