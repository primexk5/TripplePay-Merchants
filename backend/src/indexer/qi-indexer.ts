import type { Config } from '../config.js';
import type { QiService } from '../chain/qi.js';
import type { Store } from '../store/index.js';
import type { QiOrder, WebhookDelivery, WebhookPayload } from '../types.js';
import { log } from '../logger.js';

const logger = log('qi-indexer');

/** Delivery/event id prefix for Qi settlements — Qi has no (txHash, logIndex) to key on, so the
 *  per-order receive address (`QiOrder` is unique per orderId) is the stable idempotency key. */
export function qiPaymentId(orderId: string): string {
  return `qi:${orderId.toLowerCase()}`;
}

/** Placeholder merchant id for Qi payments to addresses we don't have registered yet. */
function unknownMerchantId(address: string): string {
  return `unregistered:${address.toLowerCase()}`;
}

/**
 * Watches per-order Qi receive addresses for incoming UTXOs, marks orders settled, and turns each
 * settlement into exactly one queued `payment.confirmed` webhook delivery.
 *
 * Qi has no contract to subscribe to — value arrives as UTXOs on an address — so this is a
 * poller: every QI_POLL_INTERVAL_MS it lists persisted, unsettled orders and queries each
 * address's unspent outpoints (`quai_getOutpointsByAddress`). Once the unspent value meets or
 * exceeds the order's required qits, the order flips to settled and the settlement is routed into
 * the same webhook pipeline the on-chain indexer uses (payload shape identical to that indexer's,
 * with Qi-specific context under `data.qi`), so merchants receive a signed, at-least-once
 * `payment.confirmed` webhook and the payment surfaces in the merchant dashboard. Delivery
 * enqueue is idempotent on the `qi:<orderId>` id; link-type Qi orders also have their claim row
 * marked settled so a paid order can never be recycled to another customer. Deliberately a no-op
 * when Qi is disabled.
 */
export class QiIndexer {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly qi: QiService,
    private readonly store: Store,
    private readonly cfg: Config,
    /** The Quai chain these Qi settlements belong to. Qi is a Quai-only UTXO rail, so every
     *  payload this indexer emits carries that one chainId — there is no per-order chain to
     *  infer, and `blockNumber`/EVM fields are reported as the Qi ledger's own defaults. */
    private readonly chainId: number = cfg.CHAIN_ID,
    private readonly now: () => number = () => Date.now(),
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

  async sweep(): Promise<void> {
    try {
      const orders = await this.store.listQiOrders();
      for (const order of orders) {
        // Self-heal: settled orders are never balance-checked again, so if a crash happened
        // between markQiOrderSettled and the delivery/claim enqueue the follow-up would otherwise
        // be lost forever (there is no on-chain log to re-read). afterSettlement is fully
        // idempotent — the delivery id is deterministic per orderId, a settled claim is a no-op —
        // so re-running it here is safe and closes the at-least-once gap.
        if (order.settled) {
          try {
            await this.afterSettlement(order);
          } catch (err) {
            logger.error(
              { err, orderId: order.orderId },
              'qi settled-order follow-up failed (will retry next sweep)',
            );
          }
          continue;
        }
        try {
          const balance = await this.qi.checkBalance(order.address);
          if (balance.receivedQits >= BigInt(order.qits)) {
            const settled = await this.store.markQiOrderSettled(
              order.orderId,
              balance.receivedQits.toString(),
              balance.txHashes,
            );
            if (settled) {
              logger.info(
                { orderId: settled.orderId, address: settled.address, qits: settled.qits },
                'qi order settled',
              );
              await this.afterSettlement(settled);
            }
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

  /** Post-settlement pipeline: mark the link claim settled (if any) and enqueue exactly one
   *  webhook delivery. Every step is best-effort + idempotent — a failure here must never roll
   *  back the settlement itself, and the sweep calls this again on the next poll (settled orders
   *  are re-reconciled) until the delivery exists. */
  private async afterSettlement(order: QiOrder): Promise<void> {
    try {
      await this.settleLinkClaim(order);
      await this.enqueueDelivery(order);
    } catch (err) {
      logger.error(
        { err, orderId: order.orderId },
        'qi settlement follow-up (claim/webhook) failed — will not retry automatically',
      );
    }
  }

  /** A Qi order reserved off a payment link is tracked as a claim whose payer is the sentinel
   *  'qi' (see reserveQiLinkOrder). The claimed orderId must be marked settled post-payment so a
   *  stale-claim recycle can never hand an ALREADY-PAID orderId to another customer. The claim's
   *  slug is recovered from the order's saved metadata (written at reservation time). */
  private async settleLinkClaim(order: QiOrder): Promise<void> {
    const meta = await this.store.getOrderMeta(order.orderId);
    if (!meta?.slug) return;
    await this.store.settleClaimedOrder(meta.slug, order.orderId);
    logger.info({ slug: meta.slug, orderId: order.orderId }, 'qi link claim marked settled');
  }

  /** Build and persist the delivery exactly like the on-chain indexer: one idempotent enqueue per
   *  settlement; skipped (held for later) when the merchant isn't registered or has no webhook
   *  URL yet, pending otherwise. */
  private async enqueueDelivery(order: QiOrder): Promise<void> {
    const id = qiPaymentId(order.orderId);
    if (await this.store.getDelivery(id)) return; // idempotent: never double-deliver

    const merchant = await this.store.getMerchantByAddress(order.merchantAddress);
    const meta = await this.store.getOrderMeta(order.orderId); // gateway links carry data.reference
    const nowMs = this.now();
    const payload = this.buildPayload(id, order, merchant?.merchantId ?? unknownMerchantId(order.merchantAddress), meta?.reference);
    const base = {
      id,
      merchantId: payload.data.merchantId,
      url: '',
      chainId: this.chainId,
      payload,
      attempts: 0,
      nextAttemptAt: nowMs,
      lastError: null as string | null,
      createdAt: nowMs,
      updatedAt: nowMs,
    };

    if (!merchant) {
      const skipped: WebhookDelivery = {
        ...base,
        status: 'skipped',
        lastError: 'no merchant registered for payout address',
      };
      await this.store.insertDeliveryIfAbsent(skipped);
      logger.warn({ id, merchant: order.merchantAddress }, 'qi payment for unregistered merchant — webhook skipped');
      return;
    }

    if (!merchant.webhookUrl) {
      const pendingUrl: WebhookDelivery = {
        ...base,
        merchantId: merchant.merchantId,
        status: 'skipped',
        lastError: 'webhook URL not configured yet',
      };
      await this.store.insertDeliveryIfAbsent(pendingUrl);
      logger.warn({ id, merchantId: merchant.merchantId }, 'qi payment confirmed but merchant webhook URL is not configured — delivery skipped');
      return;
    }

    const delivery: WebhookDelivery = {
      ...base,
      merchantId: merchant.merchantId,
      url: merchant.webhookUrl,
      status: 'pending',
    };
    const inserted = await this.store.insertDeliveryIfAbsent(delivery);
    if (inserted) {
      logger.info({ id, merchantId: merchant.merchantId, orderId: order.orderId }, 'qi payment confirmed — webhook queued');
    }
  }

  private buildPayload(id: string, order: QiOrder, merchantId: string, reference?: string): WebhookPayload {
    return {
      id,
      type: 'payment.confirmed',
      created: Math.floor(this.now() / 1000),
      data: {
        merchantId,
        chainId: this.chainId,
        merchant: order.merchantAddress,
        orderId: order.orderId,
        // Qi has no sender identity, EVM token or fee split — carry the ledger defaults and put
        // the full settlement detail in `qi` for consumers that understand the UTXO path.
        payer: '',
        token: 'qi',
        amount: order.receivedQits,
        feeBps: 0,
        fee: '0',
        net: order.receivedQits,
        txHash: order.txHashes[0] ?? '',
        blockNumber: 0,
        timestamp: order.settledAt ?? Math.floor(this.now()),
        nonce: 0,
        asset: 'qi',
        qi: {
          address: order.address,
          qits: order.qits,
          receivedQits: order.receivedQits,
          txHashes: order.txHashes,
        },
        ...(reference !== undefined ? { reference } : {}),
      },
    };
  }
}