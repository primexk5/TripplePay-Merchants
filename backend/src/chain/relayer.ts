import { Contract, JsonRpcProvider, Wallet } from 'quais';
import { PAYWITHQUAI_ABI } from './abi.js';
import type { Config } from '../config.js';
import { log } from '../logger.js';

const logger = log('chain:relayer');

/**
 * Order registration on a merchant's behalf.
 *
 * Guild-order pricing needs a pre-registered on-chain order per shop checkout. Registering requires
 * QUAI for tx gas in the *merchant's* payout wallet — which is exactly the moat this relayer
 * removes: the backend signs `registerOrderFor` with its own key and pays the gas, so an e-commerce
 * merchant ships a payment gateway integration without ever touching gas. The registered order's
 * `amount`/`token` are the merchant's own payout values, and verification still runs through the
 * same read-only `getOrder` surface.
 *
 * Requires a PayWithQuai upgrade exposing `registerOrderFor(address merchant, bytes32 orderId,
 * address token, uint256 amount, uint256 expiry)`. When RELAYER_PRIVATE_KEY is unset, the registrar
 * is disabled and the gateway falls back to merchant-side registration (existing behaviour).
 */
export interface OrderRegistrar {
  readonly enabled: boolean;
  /** Register an order for a merchant; resolves to the on-chain tx hash. Rejects when disabled. */
  registerOrderFor(p: {
    merchant: string;
    orderId: string;
    token: string;
    amount: bigint;
    expiry: number; // unix seconds
  }): Promise<string>;
}

export class RelayerRegistrar implements OrderRegistrar {
  readonly enabled: boolean;
  private readonly wallet?: Wallet;
  private readonly contract?: Contract;

  constructor(cfg: Config) {
    const key = cfg.RELAYER_PRIVATE_KEY;
    if (!key) {
      this.enabled = false;
      return;
    }
    this.enabled = true;
    const provider = new JsonRpcProvider(cfg.RPC_URL, undefined, { usePathing: true });
    this.wallet = new Wallet(key).connect(provider);
    // Quai's node location is derived from the contract address; connecting directly (without the
    // two-hop sharding used by the read client) is fine here because registration is a plain
    // zone-local send on the contract's own shard.
    this.contract = new Contract(cfg.PAYWITHQUAI_ADDRESS, PAYWITHQUAI_ABI, this.wallet);
    logger.info({ address: this.wallet.address }, 'relayer enabled — auto-registering gateway orders');
  }

  async registerOrderFor(p: {
    merchant: string;
    orderId: string;
    token: string;
    amount: bigint;
    expiry: number;
  }): Promise<string> {
    if (!this.contract) throw new Error('OrderRegistrar is disabled');
    try {
      const tx = await this.contract.registerOrderFor!(
        p.merchant,
        p.orderId,
        p.token,
        p.amount,
        p.expiry,
      );
      logger.info(
        { merchant: p.merchant, orderId: p.orderId, amount: p.amount.toString(), tx: tx.hash },
        'registered gateway order on-chain via relayer',
      );
      return tx.hash as string;
    } catch (err) {
      logger.error({ err, merchant: p.merchant, orderId: p.orderId }, 'relayer registration failed');
      throw err;
    }
  }
}

export function createOrderRegistrar(cfg: Config): OrderRegistrar {
  return new RelayerRegistrar(cfg);
}