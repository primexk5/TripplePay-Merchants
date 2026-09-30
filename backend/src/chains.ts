import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Config } from './config.js';
import { log } from './logger.js';

const logger = log('chains');

/** Quai network chain ids this deployment recognizes (mainnet, Orchard testnet). A chain
 *  declaring `kind: "quai"` must use one of these — new Quai networks are added here, not
 *  inferred, so a typo'd chainId can never silently masquerade as the wrong kind. */
export const KNOWN_QUAI_CHAIN_IDS: ReadonlySet<number> = new Set([9, 15000]);

const ChainConfigSchema = z.object({
  /** Short, stable slug used in APIs and logs, e.g. "quai", "robinhood-testnet". */
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be a lowercase slug, e.g. "robinhood-testnet"'),
  chainId: z.number().int().positive(),
  kind: z.enum(['quai', 'evm']),
  name: z.string().min(1),
  rpcUrl: z.string().url(),
  contractAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'contractAddress must be a 20-byte hex address'),
  startBlock: z.number().int().nonnegative().optional(),
  confirmations: z.number().int().nonnegative().default(12),
  pollIntervalMs: z.number().int().positive().default(5000),
  maxBlockRange: z.number().int().positive().default(2000),
  /** Optional per-chain ERC-20 allowlist for payment links. Unset/empty = any 20-byte token
   *  address may be used on this chain (mirrors the legacy global ACCEPTED_TOKENS behaviour). */
  acceptedTokens: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)).optional(),
  explorerUrl: z.string().url().optional(),
  enabled: z.boolean().default(true),
  /** Exactly one ENABLED chain may set this true; chain-less legacy requests resolve to it. If
   *  none is marked, the first enabled entry (in file/array order) is the default. */
  default: z.boolean().optional(),
});

export type ChainConfig = z.infer<typeof ChainConfigSchema>;

const ChainsArraySchema = z.array(ChainConfigSchema).min(1, 'at least one chain must be configured');

/**
 * Validates cross-chain invariants that a single ChainConfig's own schema can't express:
 * uniqueness, exactly-one-default, kind/chainId consistency, and the Qi-is-Quai-only rule.
 * Exported separately from {@link loadChains} so tests can exercise each rejection case without
 * touching the filesystem or env.
 */
export function validateChains(chains: ChainConfig[], env: NodeJS.ProcessEnv = process.env): ChainConfig[] {
  const ids = new Set<string>();
  for (const c of chains) {
    if (ids.has(c.id)) throw new Error(`chains config: duplicate chain id "${c.id}"`);
    ids.add(c.id);
  }
  const chainIds = new Set<number>();
  for (const c of chains) {
    if (chainIds.has(c.chainId)) throw new Error(`chains config: duplicate chainId ${c.chainId} (chain "${c.id}")`);
    chainIds.add(c.chainId);
  }
  for (const c of chains) {
    const isKnownQuai = KNOWN_QUAI_CHAIN_IDS.has(c.chainId);
    if (c.kind === 'quai' && !isKnownQuai) {
      throw new Error(
        `chains config: chain "${c.id}" has kind "quai" but chainId ${c.chainId} is not a known Quai ` +
          `network id (${[...KNOWN_QUAI_CHAIN_IDS].join(', ')}) — if this is a new Quai network, add its ` +
          'chain id to KNOWN_QUAI_CHAIN_IDS in src/chains.ts.',
      );
    }
    if (c.kind === 'evm' && isKnownQuai) {
      throw new Error(
        `chains config: chain "${c.id}" has kind "evm" but chainId ${c.chainId} is a Quai network id — ` +
          'Quai chains must use kind "quai".',
      );
    }
  }

  const enabled = chains.filter((c) => c.enabled);
  if (enabled.length === 0) {
    throw new Error('chains config: no enabled chains — at least one chain must have enabled: true');
  }
  const defaults = enabled.filter((c) => c.default);
  if (defaults.length > 1) {
    throw new Error(
      `chains config: multiple enabled chains marked default (${defaults.map((c) => c.id).join(', ')}) — ` +
        'exactly one may be default.',
    );
  }

  // Qi (UTXO-ledger checkout) is Quai-only — reject if any QI_* var is explicitly set (raw env,
  // not zod-defaulted) but no enabled chain can actually run it. This generalizes the CHAIN_KIND
  // guard in config.ts (which only ever saw one implicit chain) to the full chain list —
  // config.ts's own guard still runs first and is unchanged, so the legacy single-chain path's
  // behaviour there is identical to before.
  const hasEnabledQuaiChain = enabled.some((c) => c.kind === 'quai');
  if (!hasEnabledQuaiChain) {
    const qiVarsSet = Object.keys(env).filter((k) => k.startsWith('QI_') && env[k] !== undefined && env[k] !== '');
    if (qiVarsSet.length > 0) {
      throw new Error(
        `chains config: Qi variables (${qiVarsSet.join(', ')}) are set but no enabled chain has kind ` +
          '"quai" — Qi is Quai-only.',
      );
    }
  }

  return chains;
}

/** The chain chain-less legacy requests resolve to: the enabled chain marked `default`, or
 *  (when none is marked) the first enabled chain in list order. */
export function defaultChain(chains: ChainConfig[]): ChainConfig {
  const enabled = chains.filter((c) => c.enabled);
  const marked = enabled.find((c) => c.default);
  const chain = marked ?? enabled[0];
  if (!chain) throw new Error('chains config: no enabled chains (validateChains should have caught this)');
  return chain;
}

/** Builds the single-element chain list a legacy (pre-multi-chain) deployment implies from its
 *  existing RPC_URL/CHAIN_ID/PAYWITHQUAI_ADDRESS/CHAIN_KIND/... env vars — unchanged shape, so
 *  the resulting cursorScope/behaviour is identical to running this exact code before chains.ts
 *  existed. */
function legacyChainFromConfig(cfg: Config): unknown {
  return {
    id: cfg.CHAIN_KIND === 'evm' ? 'evm' : 'quai',
    chainId: cfg.CHAIN_ID,
    kind: cfg.CHAIN_KIND,
    name: cfg.CHAIN_KIND === 'evm' ? `EVM chain ${cfg.CHAIN_ID}` : 'Quai',
    rpcUrl: cfg.RPC_URL,
    contractAddress: cfg.PAYWITHQUAI_ADDRESS,
    startBlock: cfg.START_BLOCK,
    confirmations: cfg.CONFIRMATIONS,
    pollIntervalMs: cfg.POLL_INTERVAL_MS,
    maxBlockRange: cfg.MAX_BLOCK_RANGE,
    acceptedTokens: cfg.ACCEPTED_TOKENS.length > 0 ? cfg.ACCEPTED_TOKENS : undefined,
    enabled: true,
    default: true,
  };
}

/** Default path checked for a chains config file when neither CHAINS_JSON nor
 *  CHAINS_CONFIG_PATH is set — relative to the process working directory (production behaviour).
 *  Overridable via {@link ChainsLoadOptions.defaultConfigPath} so callers (tests, in particular)
 *  never depend on whichever untracked file happens to exist on disk. */
const DEFAULT_CONFIG_PATH = './chains.json';

export interface ChainsLoadOptions {
  /** Overrides {@link DEFAULT_CONFIG_PATH}. Tests should pass an explicit non-existent path (or a
   *  fresh temp directory) to exercise the legacy fallback deterministically, regardless of
   *  whether a real chains.json happens to sit in the working directory. */
  defaultConfigPath?: string;
}

/** True when none of CHAINS_JSON, CHAINS_CONFIG_PATH, or the default chains.json path is present
 *  — i.e. loadChains() is about to synthesize the legacy single-chain fallback and CHAIN_KIND
 *  still matters. Exported so index.ts can decide whether to print the CHAIN_KIND deprecation
 *  notice without duplicating this precedence check. */
export function isLegacyChainConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: ChainsLoadOptions = {},
): boolean {
  const defaultConfigPath = options.defaultConfigPath ?? DEFAULT_CONFIG_PATH;
  return !env.CHAINS_JSON?.trim() && !env.CHAINS_CONFIG_PATH?.trim() && !existsSync(defaultConfigPath);
}

/**
 * Loads and validates the chain list, in precedence order:
 *   1. CHAINS_JSON (inline JSON string) — highest precedence.
 *   2. CHAINS_CONFIG_PATH, or the default chains.json path if that file exists and neither env
 *      var is set (see {@link ChainsLoadOptions.defaultConfigPath}).
 *   3. Legacy fallback: a single chain synthesized from RPC_URL/CHAIN_ID/PAYWITHQUAI_ADDRESS/
 *      CHAIN_KIND/START_BLOCK/CONFIRMATIONS/POLL_INTERVAL_MS/MAX_BLOCK_RANGE/ACCEPTED_TOKENS —
 *      so a deployment with none of the new config present behaves exactly as it did before
 *      multi-chain support existed.
 */
export function loadChains(
  cfg: Config,
  env: NodeJS.ProcessEnv = process.env,
  options: ChainsLoadOptions = {},
): ChainConfig[] {
  const defaultConfigPath = options.defaultConfigPath ?? DEFAULT_CONFIG_PATH;
  let raw: unknown;
  let mode: string;

  const inlineJson = env.CHAINS_JSON?.trim();
  const configPath = env.CHAINS_CONFIG_PATH?.trim();
  if (inlineJson) {
    mode = 'CHAINS_JSON (inline)';
    raw = JSON.parse(inlineJson);
  } else if (configPath) {
    mode = `CHAINS_CONFIG_PATH (${configPath})`;
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } else if (existsSync(defaultConfigPath)) {
    mode = `CHAINS_CONFIG_PATH (default ${defaultConfigPath})`;
    raw = JSON.parse(readFileSync(defaultConfigPath, 'utf8'));
  } else {
    mode = 'legacy single-chain env vars (RPC_URL/CHAIN_ID/PAYWITHQUAI_ADDRESS/CHAIN_KIND/...)';
    raw = [legacyChainFromConfig(cfg)];
  }

  const parsed = ChainsArraySchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Invalid chains configuration (${mode}):\n${issues}`);
  }

  const chains = validateChains(parsed.data, env);
  const enabledIds = chains.filter((c) => c.enabled).map((c) => c.id);
  logger.info(
    { mode, chains: chains.length, enabled: enabledIds, default: defaultChain(chains).id },
    'chains loaded',
  );
  return chains;
}
