import { Wallet } from 'quais';
import type { Config } from '../config.js';
import { log } from '../logger.js';

const logger = log('chain:signer');

/**
 * EIP-712 domain of the signed-order module on contracts/contracts/PayWithQuai.sol.
 *
 * The name and version MUST match what `initializeSigning(name, version)` was called with on the
 * deployed contract — they are part of the digest, so a mismatch makes every signature silently
 * unusable. The chainId and verifyingContract are supplied per sign() call because the same
 * signer legitimately signs on different chain deployments.
 */
export const SIGNING_DOMAIN_NAME = 'PayWithQuai';
export const SIGNING_DOMAIN_VERSION = '1';

/**
 * Field order MUST match the `SignedOrder` struct declaration in PayWithQuai.sol, since ethers
 * derives the struct type string from this array. A field added, removed or reordered on-chain
 * without updating this produces a different digest and every signature is rejected.
 */
export const SIGNED_ORDER_TYPES: Record<string, { name: string; type: string }[]> = {
  SignedOrder: [
    { name: 'merchant', type: 'address' },
    { name: 'orderId', type: 'bytes32' },
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
    { name: 'feeBps', type: 'uint16' },
    { name: 'feeRecipient', type: 'address' },
    { name: 'expectedPayer', type: 'address' },
  ],
};

/** The authorization the customer wallet will submit to `paySignedOrder`. */
export interface SignedOrderAuthorization {
  merchant: string;
  orderId: string;
  token: string;
  amount: bigint;
  /** Unix seconds; 0 means never expires. */
  expiry: number;
  feeBps: number;
  feeRecipient: string;
  /** Zero address means any wallet may settle. */
  expectedPayer: string;
}

export interface SignedAuthorization extends SignedOrderAuthorization {
  signature: string;
}

/**
 * Wire form of an authorization. `amount` becomes a decimal string because the claim response is
 * JSON and JSON has no bigint — the frontend parses it back to a bigint for the transaction.
 */
export type SignedAuthorizationJson = Omit<SignedAuthorization, 'amount'> & { amount: string };

export function serializeAuthorization(auth: SignedAuthorization): SignedAuthorizationJson {
  return { ...auth, amount: auth.amount.toString() };
}

/**
 * Signs order authorizations off-chain so the CUSTOMER can be the only party who pays gas.
 *
 * This replaces RelayerRegistrar, which broadcast `registerOrderFor` itself and therefore made the
 * platform pay gas on every gateway checkout. Nothing signed that flow in production (RELAYER_
 * PRIVATE_KEY was never configured), so there is no key or state to migrate — the merchant simply
 * stops needing a funded wallet to publish a link.
 *
 * Security notes:
 *  - The signer is a hot key: whoever holds it can authorize orders for ANY merchant. It must
 *    therefore only ever be used to sign a payout address the caller has already authenticated as
 *    that merchant (see assertMerchantOwnsPayout in api/server.ts).
 *  - `expectedPayer` is part of the signature, which is what stops a third party who observes an
 *    authorization in the mempool from settling it and burning the customer's checkout.
 *  - Authorization never touches the chain, so a signing failure costs nothing and cannot leave a
 *    half-registered order behind.
 */
export interface OrderSigner {
  readonly enabled: boolean;
  /** Address of the signing key. Must be allowlisted on-chain with `setSigner(address, true)`. */
  readonly address: string;
  /** EIP-712 signature for `order` on the given deployment. Rejects when disabled. */
  sign(
    order: SignedOrderAuthorization,
    deployment: { chainId: number; contractAddress: string },
  ): Promise<SignedAuthorization>;
}

export class Eip712OrderSigner implements OrderSigner {
  readonly enabled: boolean;
  readonly address: string;
  private readonly wallet: Wallet;

  constructor(cfg: Config) {
    const key = cfg.ORDER_SIGNER_PRIVATE_KEY;
    if (!key) {
      throw new Error('OrderSigner requires ORDER_SIGNER_PRIVATE_KEY');
    }
    this.wallet = new Wallet(key);
    this.address = this.wallet.address;
    this.enabled = true;
    logger.info(
      { address: this.address, domain: `${SIGNING_DOMAIN_NAME}/${SIGNING_DOMAIN_VERSION}` },
      'order signer enabled — customers settle signed orders and pay their own gas',
    );
  }

  async sign(
    order: SignedOrderAuthorization,
    deployment: { chainId: number; contractAddress: string },
  ): Promise<SignedAuthorization> {
    const domain = {
      name: SIGNING_DOMAIN_NAME,
      version: SIGNING_DOMAIN_VERSION,
      chainId: deployment.chainId,
      verifyingContract: deployment.contractAddress,
    };
    const signature = await this.wallet.signTypedData(domain, SIGNED_ORDER_TYPES, {
      ...order,
      amount: order.amount.toString(),
    });
    logger.info(
      {
        merchant: order.merchant,
        orderId: order.orderId,
        chainId: deployment.chainId,
        amount: order.amount.toString(),
      },
      'signed order authorization',
    );
    return { ...order, signature };
  }
}

/** Disabled signer used when ORDER_SIGNER_PRIVATE_KEY is unset. Every call throws. */
export class DisabledOrderSigner implements OrderSigner {
  readonly enabled = false;
  readonly address = '';

  async sign(): Promise<SignedAuthorization> {
    throw new Error('OrderSigner is disabled — set ORDER_SIGNER_PRIVATE_KEY');
  }
}

export function createOrderSigner(cfg: Config): OrderSigner {
  return cfg.ORDER_SIGNER_PRIVATE_KEY ? new Eip712OrderSigner(cfg) : new DisabledOrderSigner();
}
