import type { Config } from '../config.js';
import type { QiService } from '../chain/qi.js';
import type { Store } from '../store/index.js';
import { log } from '../logger.js';

const logger = log('qi-indexer');

/**
 * Watches per-order Qi receive addresses for incoming UTXOs and marks orders settled.
 *
 * Qi has no contract to subscribe to — value arrives as UTXOs on an address — so this is a
 * poller: every QI_POLL_INTERVAL_MS it lists persisted, unsettled orders and queries each
 * address's unspent outpoints (`quai_getOutpointsByAddress`). Once the unspent value meets or
 * exceeds the order's required qits, the order flips to settled; the frontend polls the order
 * status and the checkout confirms. Deliberately a no-op when Qi is disabled.
 */
export class QiIndexer {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly qi: QiService,
    private readonly store: Store,
    private readonly cfg: Config,
  ) {}

  async start(): Promise<void> {
    if (!this.qi.enabled) return;
    logger.info(
      { rpc: this.qi.rpcUrl, intervalMs: this.cfg.QI_POLL_INTERVAL_MS },
      'qi indexer started',
    );
    await this.sweep(); // settle anything that arrived while the service was down
    this.timer = setInterval(() => void this.sweep(), this.cfg.QI_POLL_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async sweep(): Promise<void> {
    try {
      const orders = await this.store.listQiOrders();
      for (const order of orders) {
        if (order.settled) continue;
        try {
          const balance = await this.qi.checkBalance(order.address);
          if (balance.receivedQits >= BigInt(order.qits)) {
            await this.store.markQiOrderSettled(order.orderId, balance.receivedQits.toString(), balance.txHashes);
            logger.info(
              { orderId: order.orderId, address: order.address, qits: order.qits },
              'qi order settled',
            );
          }
        } catch (err) {
          logger.error(
            { err, orderId: order.orderId, address: order.address },
            'qi balance check failed (will retry next sweep)',
          );
        }
      }
    } catch (err) {
      logger.error({ err }, 'qi sweep failed');
    }
  }
}