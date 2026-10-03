import { sealSecret, openSecret, deriveKey } from '../crypto.js';
import type { ConnectorStore, StoreCredentials } from './index.js';
import type { Config } from '../config.js';
import { GatewayClient } from '../gateway.js';
import { log } from '../logger.js';

/**
 * Resolves the gateway credentials a given shop should use.
 *
 * A store that has saved its own credentials gets its own `GatewayClient`, so its orders bill to its
 * own merchant account and its inbound webhooks are signed with its own secret. A store that has not
 * yet saved any falls back to the legacy env-wide pair, which keeps an existing single-store
 * deployment working through the migration — at the cost of every such store sharing one merchant.
 *
 * Credentials are decrypted here and used immediately; they are never logged and never cached
 * between requests.
 */
export class CredentialResolver {
  private readonly masterKey: Buffer;
  private readonly warnedFallback = new Set<string>();

  constructor(
    private readonly store: ConnectorStore,
    private readonly cfg: Config,
  ) {
    this.masterKey = deriveKey(cfg.CONNECTOR_ENCRYPTION_KEY ?? 'dev-insecure-connector-key');
  }

  /** The stored pair for a shop, decrypted. Falls back to the legacy env pair when unset. */
  async resolve(shop: string): Promise<StoreCredentials | undefined> {
    const settings = await this.store.getSettings(shop);
    if (settings) {
      const merchantKey = openSecret(settings.merchantKeyCipher, this.masterKey);
      const webhookSecret = openSecret(settings.webhookSecretCipher, this.masterKey);
      if (merchantKey && webhookSecret) return { merchantKey, webhookSecret };
      // Reached when CONNECTOR_ENCRYPTION_KEY changed or the row was tampered with. Fail loudly
      // rather than silently falling back to the shared key — that would quietly start billing this
      // store's orders to someone else's merchant account.
      log('app').error(
        { shop, configuredAt: settings.configuredAt },
        'stored credentials could not be decrypted — re-save them on the settings page',
      );
      return undefined;
    }

    if (this.cfg.GATEWAY_MERCHANT_KEY && this.cfg.GATEWAY_WEBHOOK_SECRET) {
      if (!this.warnedFallback.has(shop)) {
        this.warnedFallback.add(shop);
        log('app').warn(
          { shop },
          'store has no credentials of its own; falling back to the shared GATEWAY_MERCHANT_KEY — ' +
            'its orders bill to the same merchant as every other unconfigured store. ' +
            'Set its own credentials to fix this.',
        );
      }
      return { merchantKey: this.cfg.GATEWAY_MERCHANT_KEY, webhookSecret: this.cfg.GATEWAY_WEBHOOK_SECRET };
    }
    return undefined;
  }

  /** A gateway client bound to this shop's credentials. */
  async client(shop: string): Promise<GatewayClient | undefined> {
    const creds = await this.resolve(shop);
    if (!creds) return undefined;
    return new GatewayClient(this.cfg.GATEWAY_BASE_URL, creds.merchantKey);
  }

  /** Seals a plaintext pair for storage, so the settings route never touches crypto directly. */
  seal(merchantKey: string, webhookSecret: string): { merchantKeyCipher: string; webhookSecretCipher: string } {
    return {
      merchantKeyCipher: sealSecret(merchantKey, this.masterKey),
      webhookSecretCipher: sealSecret(webhookSecret, this.masterKey),
    };
  }
}
