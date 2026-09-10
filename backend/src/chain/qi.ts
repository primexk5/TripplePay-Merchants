import { JsonRpcProvider, QiHDWallet, Zone, denominations } from 'quais';
import type { Config } from '../config.js';
import type { Store } from '../store/index.js';
import type { QiOrder } from '../types.js';
import { log } from '../logger.js';

const logger = log('qi');

/** The Qi ledger's native subunit: 1000 qits = 1 Qi. */
export const QITS_PER_QI = 1000n;

export interface QiBalanceCheck {
  /** Sum of the values of all unspent outpoints on the address, in qits. */
  receivedQits: bigint;
  /** Lowercased tx hashes of the outpoints counted (informational for the UI). */
  txHashes: string[];
}

/**
 * Qi settlement service. Qi is a UTXO ledger with no memo/data field and — unlike the EVM side —
 * no contract/`PayWithQuai` settlement. To attribute a payment to an order, every order gets its
 * own one-time receive address derived from the merchant's Qi HD wallet (BIP44
 * `m/44'/969'/0'/0/<n>`, Cyprus-1), and settlement is detected by watching that address's unspent
 * outpoints via `quai_getOutpointsByAddress`.
 *
 * FEATURE-GATING: the entire Qi surface is off unless the deployment sets both `QI_MNEMONIC` and
 * `QI_RPC_URL` (see config.ts). When disabled, `enabled` is false, no address is ever derived,
 * and the HTTP API returns `qi: null`.
 *
 * ADDRESS UNIQUENESS: each `getNextAddressSync` call advances a BIP44 index by exactly one, and
 * the same mnemonic+path+index derives the same address — verified — but that internal counter
 * resets on restart. `init()` therefore fast-forwards the wallet past every already-persisted
 * order address (deterministic: N orders → next derivation is index N). Cross-instance safety
 * still relies on the store's unique `address` constraint: on a collision the insert returns false
 * and we re-derive once, so concurrent relayer instances can never hand out the same address.
 */
export class QiService {
  readonly enabled: boolean;
  readonly rpcUrl: string | null;
  private readonly wallet: QiHDWallet | null;
  private readonly provider: JsonRpcProvider | null;
  private readonly qitsPerQuai: bigint;
  private readonly store: Store;

  constructor(cfg: Config, store: Store) {
    this.store = store;
    this.qitsPerQuai = BigInt(cfg.QI_QITS_PER_QUAI);
    this.rpcUrl = cfg.QI_RPC_URL ?? null;
    const mnemonic = cfg.QI_MNEMONIC;
    this.enabled = Boolean(mnemonic && this.rpcUrl);
    if (!this.enabled) {
      logger.warn(
        { hasMnemonic: Boolean(mnemonic), hasRpc: Boolean(this.rpcUrl) },
        'Qi payments disabled — set QI_MNEMONIC and QI_RPC_URL to enable per-order Qi checkout',
      );
      this.wallet = null;
      this.provider = null;
      return;
    }
    this.wallet = QiHDWallet.fromPhrase(mnemonic!);
    this.provider = new JsonRpcProvider(this.rpcUrl!);
    this.wallet.connect(this.provider);
  }

  /** Fast-forward the wallet's receive-address pointer past every persisted order address so
   *  fresh derivations stay unique across restarts. Must run after the store schema exists
   *  (PostgresStore.init). */
  async init(): Promise<void> {
    const w = this.wallet;
    if (!this.enabled || !w) return;
    const orders = await this.store.listQiOrders();
    for (let i = 0; i < orders.length; i++) {
      w.getNextAddressSync(0, Zone.Cyprus1); // advance pointer; result discarded
    }
    logger.info(
      { advanced: orders.length },
      `qi wallet pointer advanced past ${orders.length} existing receive addresses (fresh derivations stay unique)`,
    );
  }

  /** Derive the Qi amount (qits) a given on-chain order amount (wei) should be priced at.
   *  Qi checkout is priced off the merchant's configured QI_QITS_PER_QUAI rate. */
  orderQits(amountWei: bigint): bigint {
    return (amountWei / 10n ** 18n) * this.qitsPerQuai;
  }

  /** Load or create the Qi receive record for an order. Returns undefined when Qi is disabled or,
   *  after retrying fresh derivations, the store could not be written. Callers expose
   *  `qi: null` in that case so the checkout falls back to the on-chain surface gracefully. */
  async ensureQiOrder(orderId: string, merchantAddress: string, qits: bigint): Promise<QiOrder | undefined> {
    const existing = await this.store.getQiOrder(orderId);
    if (existing) return existing;
    const w = this.wallet;
    if (!this.enabled || !w || qits < 0n) return undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      const info = w.getNextAddressSync(0, Zone.Cyprus1);
      const order: QiOrder = {
        orderId: orderId.toLowerCase(),
        merchantAddress: merchantAddress.toLowerCase(),
        address: info.address,
        qits: qits.toString(),
        receivedQits: '0',
        settled: false,
        txHashes: [],
        createdAt: Date.now(),
        settledAt: null,
      };
      if (await this.store.insertQiOrder(order)) return order;
      logger.warn({ orderId: order.orderId }, 'qi address collision — deriving a fresh address');
    }
    logger.error({ orderId: orderId.toLowerCase() }, 'could not allocate a qi receive address after retries');
    return undefined;
  }

  /** Current unspent value on a per-order receive address, in qits. Requires Qi enabled. */
  async checkBalance(address: string): Promise<QiBalanceCheck> {
    const provider = this.provider;
    if (!provider) return { receivedQits: 0n, txHashes: [] };
    const outpoints = await provider.getOutpointsByAddress(address);
    let receivedQits = 0n;
    const hashes = new Set<string>();
    for (const op of outpoints) {
      // `op.denomination` indexes the SDK's `denominations` array, whose values are already in
      // qits (denominations[6] = 1000n = 1 Qi). Index out of range is impossible client-side.
      const value = denominations[op.denomination];
      if (value === undefined) {
        logger.warn({ denomination: op.denomination }, 'unexpected qi outpoint denomination — ignored');
        continue;
      }
      receivedQits += value;
      if (op.txhash) hashes.add(op.txhash.toLowerCase());
    }
    return { receivedQits, txHashes: [...hashes] };
  }
}