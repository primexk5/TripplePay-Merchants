const { expect } = require('chai');
const { ethers } = require('hardhat');
const { randomBytes } = require('node:crypto');
const { anyValue } = require('@nomicfoundation/hardhat-chai-matchers/withArgs');

/**
 * End-to-end rehearsal of the real money path, with NO mocks anywhere in the loop:
 *
 *   backend/src/chain/signer.ts  ->  real EIP-712 signature
 *      -> real PayWithQuai behind a real ERC1967Proxy (initialized exactly as deploy.js does)
 *      -> customer's real transaction, real ERC-20 transfer, real fee split
 *
 * Every other suite signs with a hand-built ethers domain or asserts digests in isolation. This one
 * exists to prove the production signer module and the deployed contract agree — if the backend's
 * type list, field order, or domain ever drifts from the contract, this is what catches it.
 *
 * Requires the backend to be built (`npm --prefix ../../backend run build`), because the signer
 * under test is the shipped module rather than a transcription of it.
 */
// The backend logger is configured at import time; keep the rehearsal's output readable.
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';
const backendSigner = require('../../backend/dist/chain/signer.js');

const usdq = (n) => ethers.parseUnits(String(n), 6);
const oid = () => ethers.hexlify(randomBytes(32));

const FEE_BPS = 50n;
const AMOUNT = usdq(25);

// A throwaway platform key. Never reused, never funded, generated per run.
const PLATFORM_SIGNER_KEY = '0x' + randomBytes(32).toString('hex');

describe('backend signer -> contract (end-to-end rehearsal)', function () {
  /** Mirrors contracts/scripts/deploy.js: impl -> proxy(initialize) -> allowlist assets -> signing. */
  async function deployLikeProduction() {
    const [owner, merchant, payer, feeRecipient, stranger] = await ethers.getSigners();

    const token = await ethers.deployContract('MockStablecoin');
    await token.mint(payer.address, usdq(1000));

    const Impl = await ethers.getContractFactory('PayWithQuai');
    const impl = await Impl.deploy();
    const initData = Impl.interface.encodeFunctionData('initialize', [
      feeRecipient.address,
      FEE_BPS,
      owner.address,
    ]);
    const proxy = await ethers.deployContract('ERC1967Proxy', [await impl.getAddress(), initData]);
    const pay = Impl.attach(await proxy.getAddress());

    await pay.setTokenAccepted(await token.getAddress(), true);
    await pay.setTokenAccepted(ethers.ZeroAddress, true);

    // deploy.js also calls initializeSigning and (when ORDER_SIGNER_ADDRESS is set) setSigner.
    await pay.initializeSigning(
      backendSigner.SIGNING_DOMAIN_NAME,
      backendSigner.SIGNING_DOMAIN_VERSION,
    );

    const signer = backendSigner.createOrderSigner({
      ORDER_SIGNER_PRIVATE_KEY: PLATFORM_SIGNER_KEY,
    });
    expect(signer.enabled).to.equal(true);
    await pay.setSigner(signer.address, true);
    expect(await pay.isSigner(signer.address)).to.equal(true);

    return { owner, merchant, payer, stranger, feeRecipient, token, pay, signer };
  }

  async function authorize(signer, pay, { merchant, token, amount, payer, orderId = oid() }) {
    const network = await ethers.provider.getNetwork();
    const auth = await signer.sign(
      {
        merchant,
        orderId,
        token,
        amount,
        // 30 minutes, like a real link's window.
        expiry: BigInt(Math.floor(Date.now() / 1000) + 1800),
        feeBps: await pay.feeBps(),
        feeRecipient: await pay.feeRecipient(),
        expectedPayer: payer,
      },
      { chainId: Number(network.chainId), contractAddress: await pay.getAddress() },
    );
    return { ...auth, amount: auth.amount.toString() };
  }

  it('settles an ERC-20 order signed by the production backend signer', async function () {
    const { merchant, payer, feeRecipient, token, pay, signer } = await deployLikeProduction();
    const auth = await authorize(signer, pay, {
      merchant: merchant.address,
      token: await token.getAddress(),
      amount: AMOUNT,
      payer: payer.address,
    });

    // What the API hands the browser: JSON-safe (amount as a decimal string) and typed for the ABI.
    const wire = backendSigner.serializeAuthorization(auth);
    expect(typeof wire.amount).to.equal('string');
    expect(wire.signature).to.match(/^0x[0-9a-f]{130}$/);

    const order = {
      merchant: wire.merchant,
      orderId: wire.orderId,
      token: wire.token,
      amount: wire.amount, // the browser passes the string straight into the tuple
      expiry: wire.expiry,
      feeBps: wire.feeBps,
      feeRecipient: wire.feeRecipient,
      expectedPayer: wire.expectedPayer,
    };

    const fee = (AMOUNT * FEE_BPS) / 10000n;
    const before = {
      payer: await token.balanceOf(payer.address),
      merchant: await token.balanceOf(merchant.address),
      fee: await token.balanceOf(feeRecipient.address),
    };

    await token.connect(payer).approve(await pay.getAddress(), AMOUNT);
    await expect(pay.connect(payer).paySignedOrder(order, wire.signature))
      .to.emit(pay, 'PaymentReceived')
      .withArgs(merchant.address, wire.orderId, payer.address, await token.getAddress(), AMOUNT, anyValue)
      .and.to.emit(pay, 'PaymentSettled')
      .withArgs(merchant.address, wire.orderId, payer.address, await token.getAddress(), AMOUNT, fee, AMOUNT - fee, 1n, anyValue)
      .and.to.emit(pay, 'FeePaid')
      .withArgs(wire.orderId, await token.getAddress(), fee, feeRecipient.address);

    expect(await token.balanceOf(payer.address)).to.equal(before.payer - AMOUNT);
    expect(await token.balanceOf(merchant.address)).to.equal(before.merchant + (AMOUNT - fee));
    expect(await token.balanceOf(feeRecipient.address)).to.equal(before.fee + fee);

    // Created and settled by one transaction: nothing about this order existed before it.
    const stored = await pay.getOrder(merchant.address, wire.orderId);
    expect(stored.exists).to.equal(true);
    expect(stored.settled).to.equal(true);
    expect(stored.amount).to.equal(AMOUNT);
    expect(stored.expectedPayer.toLowerCase()).to.equal(payer.address.toLowerCase());
    // The order must now be unpayable, even by the payer who just used it.
    await expect(
      pay.connect(payer).paySignedOrder(order, wire.signature),
    ).to.be.revertedWithCustomError(pay, 'OrderAlreadyExists');
  });

  it('settles a native order signed by the production backend signer', async function () {
    const { merchant, payer, token, pay, signer } = await deployLikeProduction();
    const amount = ethers.parseEther('2');
    const auth = await authorize(signer, pay, {
      merchant: merchant.address,
      token: ethers.ZeroAddress,
      amount,
      payer: payer.address,
    });
    const wire = backendSigner.serializeAuthorization(auth);

    const before = await ethers.provider.getBalance(merchant.address);
    await pay.connect(payer).paySignedOrder(
      {
        merchant: wire.merchant,
        orderId: wire.orderId,
        token: wire.token,
        amount: wire.amount,
        expiry: wire.expiry,
        feeBps: wire.feeBps,
        feeRecipient: wire.feeRecipient,
        expectedPayer: wire.expectedPayer,
      },
      wire.signature,
      { value: amount },
    );
    expect((await ethers.provider.getBalance(merchant.address)) - before).to.equal(
      amount - (amount * FEE_BPS) / 10000n,
    );
    expect((await pay.getOrder(merchant.address, wire.orderId)).settled).to.equal(true);
  });

  it('honours expectedPayer: a stranger holding the signature cannot spend it', async function () {
    const { merchant, payer, stranger, token, pay, signer } = await deployLikeProduction();
    const auth = await authorize(signer, pay, {
      merchant: merchant.address,
      token: await token.getAddress(),
      amount: AMOUNT,
      payer: payer.address,
    });

    await token.connect(stranger).approve(await pay.getAddress(), AMOUNT);
    await expect(
      pay.connect(stranger).paySignedOrder(
        {
          merchant: auth.merchant,
          orderId: auth.orderId,
          token: auth.token,
          amount: auth.amount.toString(),
          expiry: auth.expiry,
          feeBps: auth.feeBps,
          feeRecipient: auth.feeRecipient,
          expectedPayer: auth.expectedPayer,
        },
        auth.signature,
      ),
    ).to.be.revertedWithCustomError(pay, 'WrongPayer');

    // The legitimate payer is unaffected — the failed attempt created nothing.
    expect((await pay.getOrder(merchant.address, auth.orderId)).exists).to.equal(false);
    await token.connect(payer).approve(await pay.getAddress(), AMOUNT);
    await pay
      .connect(payer)
      .paySignedOrder(
        {
          merchant: auth.merchant,
          orderId: auth.orderId,
          token: auth.token,
          amount: auth.amount.toString(),
          expiry: auth.expiry,
          feeBps: auth.feeBps,
          feeRecipient: auth.feeRecipient,
          expectedPayer: auth.expectedPayer,
        },
        auth.signature,
      );
    expect((await pay.getOrder(merchant.address, auth.orderId)).settled).to.equal(true);
  });

  it('rejects a signature made against a different deployment of the same code', async function () {
    const { merchant, payer, token, pay, signer } = await deployLikeProduction();
    const auth = await authorize(signer, pay, {
      merchant: merchant.address,
      token: await token.getAddress(),
      amount: AMOUNT,
      payer: payer.address,
    });
    const wire = backendSigner.serializeAuthorization(auth);

    // A second, identical-looking deployment: the signature is bound to the first proxy, so it
    // must not be replayable here. This is the cross-deployment replay defence.
    const Impl = await ethers.getContractFactory('PayWithQuai');
    const impl2 = await Impl.deploy();
    const other = Impl.attach(
      await (
        await ethers.deployContract('ERC1967Proxy', [
          await impl2.getAddress(),
          Impl.interface.encodeFunctionData('initialize', [
            merchant.address,
            FEE_BPS,
            (await ethers.getSigners())[0].address,
          ]),
        ])
      ).getAddress(),
    );
    await other.setTokenAccepted(await token.getAddress(), true);
    await other.initializeSigning(
      backendSigner.SIGNING_DOMAIN_NAME,
      backendSigner.SIGNING_DOMAIN_VERSION,
    );
    await other.setSigner(signer.address, true);

    await token.connect(payer).approve(await other.getAddress(), AMOUNT);
    await expect(
      other.connect(payer).paySignedOrder(
        {
          merchant: wire.merchant,
          orderId: wire.orderId,
          token: wire.token,
          amount: wire.amount,
          expiry: wire.expiry,
          feeBps: wire.feeBps,
          feeRecipient: wire.feeRecipient,
          expectedPayer: wire.expectedPayer,
        },
        wire.signature,
      ),
    ).to.be.revertedWithCustomError(other, 'InvalidSignature');
  });

  it('refuses everything when the platform signer key is not configured', async function () {
    const disabled = backendSigner.createOrderSigner({ ORDER_SIGNER_PRIVATE_KEY: undefined });
    expect(disabled.enabled).to.equal(false);
    let threw = false;
    try {
      await disabled.sign();
    } catch (err) {
      threw = /ORDER_SIGNER_PRIVATE_KEY/.test(String(err.message));
    }
    // The API answers 503 rather than issuing an authorization that cannot settle.
    expect(threw).to.equal(true);
  });
});
