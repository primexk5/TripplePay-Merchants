const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { anyValue } = require('@nomicfoundation/hardhat-chai-matchers/withArgs');

const oid = (s) => ethers.encodeBytes32String(s);
const usdq = (n) => ethers.parseUnits(String(n), 6); // MockStablecoin has 6 decimals
const NO_EXPIRY = 0;

describe('PayWithQuai', function () {
  const FEE_BPS = 50n; // 0.5%
  const AMOUNT = usdq(25); // 25.00 mUSDQ

  // Deploy the router behind a UUPS proxy, fund a payer, and allowlist both the stablecoin and
  // native QUAI. Mirrors the production deploy path (impl -> ERC1967Proxy(initialize)).
  async function setup(feeBps) {
    const [owner, merchant, payer, feeRecipient, other, signer] = await ethers.getSigners();

    const token = await ethers.deployContract('MockStablecoin');
    await token.mint(payer.address, usdq(1000));

    const pay = await deployProxy([feeRecipient.address, feeBps, owner.address]);
    await pay.setTokenAccepted(await token.getAddress(), true);
    await pay.setTokenAccepted(ethers.ZeroAddress, true); // enable native QUAI

    return { owner, merchant, payer, feeRecipient, other, signer, token, pay };
  }

  // Deploy the PayWithQuai implementation, wrap it in an ERC1967Proxy initialized with `initArgs`,
  // and return a PayWithQuai-typed handle bound to the proxy address.
  async function deployProxy(initArgs) {
    const Impl = await ethers.getContractFactory('PayWithQuai');
    const impl = await Impl.deploy();
    const initData = Impl.interface.encodeFunctionData('initialize', initArgs);
    const proxy = await ethers.deployContract('ERC1967Proxy', [await impl.getAddress(), initData]);
    return Impl.attach(await proxy.getAddress());
  }

  const deployFixture = () => setup(FEE_BPS);
  const deployZeroFeeFixture = () => setup(0n);

  function expectedSplit(amount, feeBps) {
    const fee = (amount * feeBps) / 10000n;
    return { fee, net: amount - fee };
  }

  describe('deployment', function () {
    it('records owner, fee recipient and fee', async function () {
      const { pay, owner, feeRecipient } = await loadFixture(deployFixture);
      expect(await pay.owner()).to.equal(owner.address);
      expect(await pay.feeRecipient()).to.equal(feeRecipient.address);
      expect(await pay.feeBps()).to.equal(FEE_BPS);
    });

    it('rejects a fee above MAX_FEE_BPS', async function () {
      const { pay, feeRecipient, owner } = await loadFixture(deployFixture);
      await expect(
        deployProxy([feeRecipient.address, 501, owner.address]),
      ).to.be.revertedWithCustomError(pay, 'FeeTooHigh');
    });

    it('rejects a zero fee recipient', async function () {
      const { pay, owner } = await loadFixture(deployFixture);
      await expect(
        deployProxy([ethers.ZeroAddress, 0, owner.address]),
      ).to.be.revertedWithCustomError(pay, 'ZeroFeeRecipient');
    });
  });

  describe('registerOrder', function () {
    it('stores the order and emits OrderRegistered', async function () {
      const { pay, merchant, token, feeRecipient } = await loadFixture(deployFixture);
      await expect(pay.connect(merchant).registerOrder(oid('ord_1'), token, AMOUNT, NO_EXPIRY))
        .to.emit(pay, 'OrderRegistered')
        .withArgs(
          merchant.address,
          oid('ord_1'),
          await token.getAddress(),
          AMOUNT,
          NO_EXPIRY,
          FEE_BPS,
          feeRecipient.address,
        );

      const order = await pay.getOrder(merchant.address, oid('ord_1'));
      expect(order.merchant).to.equal(merchant.address);
      expect(order.token).to.equal(await token.getAddress());
      expect(order.amount).to.equal(AMOUNT);
      expect(order.settled).to.equal(false);
      expect(order.exists).to.equal(true);
      expect(order.feeBps).to.equal(FEE_BPS);
    });

    it('reverts on a zero amount', async function () {
      const { pay, merchant, token } = await loadFixture(deployFixture);
      await expect(
        pay.connect(merchant).registerOrder(oid('ord_1'), token, 0, NO_EXPIRY),
      ).to.be.revertedWithCustomError(pay, 'ZeroAmount');
    });

    it('reverts for a token that is not accepted', async function () {
      const { pay, merchant, other } = await loadFixture(deployFixture);
      await expect(
        pay.connect(merchant).registerOrder(oid('ord_1'), other.address, AMOUNT, NO_EXPIRY),
      ).to.be.revertedWithCustomError(pay, 'TokenNotAccepted');
    });

    it('reverts for an expiry in the past', async function () {
      const { pay, merchant, token } = await loadFixture(deployFixture);
      await expect(
        pay.connect(merchant).registerOrder(oid('ord_1'), token, AMOUNT, 1),
      ).to.be.revertedWithCustomError(pay, 'InvalidExpiry');
    });

    it('reverts when the same merchant reuses an order id', async function () {
      const { pay, merchant, token } = await loadFixture(deployFixture);
      await pay.connect(merchant).registerOrder(oid('ord_1'), token, AMOUNT, NO_EXPIRY);
      await expect(
        pay.connect(merchant).registerOrder(oid('ord_1'), token, AMOUNT, NO_EXPIRY),
      ).to.be.revertedWithCustomError(pay, 'OrderAlreadyExists');
    });

    it('lets different merchants use the same order id (keyed by merchant)', async function () {
      const { pay, merchant, other, token } = await loadFixture(deployFixture);
      await pay.connect(merchant).registerOrder(oid('ord_1'), token, AMOUNT, NO_EXPIRY);
      await expect(pay.connect(other).registerOrder(oid('ord_1'), token, AMOUNT, NO_EXPIRY)).to.not.be
        .reverted;
    });

    it('reverts when paused', async function () {
      const { pay, owner, merchant, token } = await loadFixture(deployFixture);
      await pay.connect(owner).pause();
      await expect(
        pay.connect(merchant).registerOrder(oid('ord_1'), token, AMOUNT, NO_EXPIRY),
      ).to.be.revertedWithCustomError(pay, 'EnforcedPause');
    });
  });

  describe('cancelOrder', function () {
    it('lets the merchant cancel an unpaid order', async function () {
      const { pay, merchant, token } = await loadFixture(deployFixture);
      await pay.connect(merchant).registerOrder(oid('ord_1'), token, AMOUNT, NO_EXPIRY);
      await expect(pay.connect(merchant).cancelOrder(oid('ord_1')))
        .to.emit(pay, 'OrderCancelled')
        .withArgs(merchant.address, oid('ord_1'));

      const order = await pay.getOrder(merchant.address, oid('ord_1'));
      expect(order.exists).to.equal(false);
    });

    it('frees the order id for re-registration after cancel', async function () {
      const { pay, merchant, token } = await loadFixture(deployFixture);
      await pay.connect(merchant).registerOrder(oid('ord_1'), token, AMOUNT, NO_EXPIRY);
      await pay.connect(merchant).cancelOrder(oid('ord_1'));
      await expect(pay.connect(merchant).registerOrder(oid('ord_1'), token, usdq(10), NO_EXPIRY)).to.not
        .be.reverted;
    });

    it('reverts cancelling an unknown order (and cannot cancel another merchant order)', async function () {
      const { pay, merchant, other, token } = await loadFixture(deployFixture);
      await pay.connect(merchant).registerOrder(oid('ord_1'), token, AMOUNT, NO_EXPIRY);
      // `other` targets its own (empty) (other, ord_1) key, so it cannot touch merchant's order.
      await expect(pay.connect(other).cancelOrder(oid('ord_1'))).to.be.revertedWithCustomError(
        pay,
        'OrderNotFound',
      );
    });

    it('reverts cancelling a settled order', async function () {
      const { pay, merchant, payer, token } = await loadFixture(deployFixture);
      await pay.connect(merchant).registerOrder(oid('ord_1'), token, AMOUNT, NO_EXPIRY);
      await token.connect(payer).approve(pay, AMOUNT);
      await pay.connect(payer).payOrder(merchant.address, oid('ord_1'));
      await expect(pay.connect(merchant).cancelOrder(oid('ord_1'))).to.be.revertedWithCustomError(
        pay,
        'OrderAlreadySettled',
      );
    });
  });

  describe('payOrder (ERC-20)', function () {
    async function registeredFixture() {
      const base = await deployFixture();
      await base.pay.connect(base.merchant).registerOrder(oid('ord_1'), base.token, AMOUNT, NO_EXPIRY);
      await base.token.connect(base.payer).approve(base.pay, AMOUNT);
      return base;
    }

    it('splits fee and net, marks settled, and emits PaymentReceived', async function () {
      const { pay, merchant, payer, feeRecipient, token } = await loadFixture(registeredFixture);
      const { fee, net } = expectedSplit(AMOUNT, FEE_BPS);

      await expect(pay.connect(payer).payOrder(merchant.address, oid('ord_1')))
        .to.emit(pay, 'PaymentReceived')
        .withArgs(merchant.address, oid('ord_1'), payer.address, await token.getAddress(), AMOUNT, anyValue)
        .and.to.emit(pay, 'FeePaid')
        .withArgs(oid('ord_1'), await token.getAddress(), fee, feeRecipient.address);

      expect(await token.balanceOf(merchant.address)).to.equal(net);
      expect(await token.balanceOf(feeRecipient.address)).to.equal(fee);
      expect(await pay.isSettled(merchant.address, oid('ord_1'))).to.equal(true);
    });

    it('moves exactly the registered amount from the payer', async function () {
      const { pay, merchant, payer, feeRecipient, token } = await loadFixture(registeredFixture);
      const { fee, net } = expectedSplit(AMOUNT, FEE_BPS);
      await expect(
        pay.connect(payer).payOrder(merchant.address, oid('ord_1')),
      ).to.changeTokenBalances(token, [payer, merchant, feeRecipient], [-AMOUNT, net, fee]);
    });

    it('floors the fee in favor of the merchant (non-divisible amounts)', async function () {
      const { pay, merchant, payer, feeRecipient, token } = await loadFixture(deployFixture);
      const odd = 12_345_679n; // 6-decimal amount not divisible by 10_000
      await pay.connect(merchant).registerOrder(oid('ord_odd'), token, odd, NO_EXPIRY);
      await token.connect(payer).approve(pay, odd);

      const fee = (odd * FEE_BPS) / 10_000n; // floor
      await expect(pay.connect(payer).payOrder(merchant.address, oid('ord_odd')))
        .to.changeTokenBalances(token, [payer, merchant, feeRecipient], [-odd, odd - fee, fee]);
    });

    it('reverts for an unknown order', async function () {
      const { pay, merchant, payer } = await loadFixture(registeredFixture);
      await expect(
        pay.connect(payer).payOrder(merchant.address, oid('ord_unknown')),
      ).to.be.revertedWithCustomError(pay, 'OrderNotFound');
    });

    it('reverts if the order is a native-QUAI order', async function () {
      const { pay, merchant, payer } = await loadFixture(deployFixture);
      await pay.connect(merchant).registerOrder(oid('ord_native'), ethers.ZeroAddress, AMOUNT, NO_EXPIRY);
      await expect(
        pay.connect(payer).payOrder(merchant.address, oid('ord_native')),
      ).to.be.revertedWithCustomError(pay, 'WrongPaymentPath');
    });

    it('reverts without sufficient allowance', async function () {
      const { pay, merchant, payer, token } = await loadFixture(deployFixture);
      await pay.connect(merchant).registerOrder(oid('ord_1'), token, AMOUNT, NO_EXPIRY);
      // no approve
      await expect(
        pay.connect(payer).payOrder(merchant.address, oid('ord_1')),
      ).to.be.revertedWithCustomError(token, 'ERC20InsufficientAllowance');
    });

    it('rejects a second payment for the same order (no double fulfillment)', async function () {
      const { pay, merchant, payer, token } = await loadFixture(registeredFixture);
      await pay.connect(payer).payOrder(merchant.address, oid('ord_1'));
      await token.connect(payer).approve(pay, AMOUNT); // even with fresh allowance
      await expect(
        pay.connect(payer).payOrder(merchant.address, oid('ord_1')),
      ).to.be.revertedWithCustomError(pay, 'OrderAlreadySettled');
    });

    it('sends the full amount to the merchant when fee is zero', async function () {
      const { pay, merchant, payer, feeRecipient, token } = await loadFixture(deployZeroFeeFixture);
      await pay.connect(merchant).registerOrder(oid('ord_1'), token, AMOUNT, NO_EXPIRY);
      await token.connect(payer).approve(pay, AMOUNT);

      const tx = pay.connect(payer).payOrder(merchant.address, oid('ord_1'));
      await expect(tx).to.emit(pay, 'PaymentReceived');
      await expect(tx).to.not.emit(pay, 'FeePaid');
      expect(await token.balanceOf(merchant.address)).to.equal(AMOUNT);
      expect(await token.balanceOf(feeRecipient.address)).to.equal(0);
    });

    it('reverts when paused', async function () {
      const { pay, owner, merchant, payer } = await loadFixture(registeredFixture);
      await pay.connect(owner).pause();
      await expect(
        pay.connect(payer).payOrder(merchant.address, oid('ord_1')),
      ).to.be.revertedWithCustomError(pay, 'EnforcedPause');
    });
  });

  describe('payOrderNative', function () {
    async function nativeFixture() {
      const base = await deployFixture();
      await base.pay
        .connect(base.merchant)
        .registerOrder(oid('ord_n'), ethers.ZeroAddress, AMOUNT, NO_EXPIRY);
      return base;
    }

    it('emits PaymentReceived and marks the order settled', async function () {
      const { pay, merchant, payer } = await loadFixture(nativeFixture);

      await expect(pay.connect(payer).payOrderNative(merchant.address, oid('ord_n'), { value: AMOUNT }))
        .to.emit(pay, 'PaymentReceived')
        .withArgs(merchant.address, oid('ord_n'), payer.address, ethers.ZeroAddress, AMOUNT, anyValue);

      expect(await pay.isSettled(merchant.address, oid('ord_n'))).to.equal(true);
    });

    it('moves the correct native balances', async function () {
      const { pay, merchant, payer, feeRecipient } = await loadFixture(nativeFixture);
      const { fee, net } = expectedSplit(AMOUNT, FEE_BPS);
      await expect(
        pay.connect(payer).payOrderNative(merchant.address, oid('ord_n'), { value: AMOUNT }),
      ).to.changeEtherBalances([merchant, feeRecipient], [net, fee]);
    });

    it('reverts if msg.value does not equal the registered amount', async function () {
      const { pay, merchant, payer } = await loadFixture(nativeFixture);
      await expect(
        pay.connect(payer).payOrderNative(merchant.address, oid('ord_n'), { value: AMOUNT - 1n }),
      ).to.be.revertedWithCustomError(pay, 'IncorrectNativeValue');
    });

    it('reverts if the order is an ERC-20 order', async function () {
      const { pay, merchant, payer, token } = await loadFixture(deployFixture);
      await pay.connect(merchant).registerOrder(oid('ord_erc'), token, AMOUNT, NO_EXPIRY);
      await expect(
        pay.connect(payer).payOrderNative(merchant.address, oid('ord_erc'), { value: AMOUNT }),
      ).to.be.revertedWithCustomError(pay, 'WrongPaymentPath');
    });

    it('rejects a second native payment for the same order', async function () {
      const { pay, merchant, payer } = await loadFixture(nativeFixture);
      await pay.connect(payer).payOrderNative(merchant.address, oid('ord_n'), { value: AMOUNT });
      await expect(
        pay.connect(payer).payOrderNative(merchant.address, oid('ord_n'), { value: AMOUNT }),
      ).to.be.revertedWithCustomError(pay, 'OrderAlreadySettled');
    });

    it('reverts on a direct native transfer to the contract', async function () {
      const { pay, payer } = await loadFixture(deployFixture);
      await expect(payer.sendTransaction({ to: await pay.getAddress(), value: 1n })).to.be.revertedWithCustomError(
        pay,
        'ReceiveRejected',
      );
    });
  });

  describe('order expiry', function () {
    it('allows payment before expiry', async function () {
      const { pay, merchant, payer, token } = await loadFixture(deployFixture);
      const expiry = (await time.latest()) + 3600;
      await pay.connect(merchant).registerOrder(oid('ord_exp'), token, AMOUNT, expiry);
      await token.connect(payer).approve(pay, AMOUNT);
      await expect(pay.connect(payer).payOrder(merchant.address, oid('ord_exp'))).to.emit(
        pay,
        'PaymentReceived',
      );
    });

    it('rejects an expiry equal to the current block timestamp', async function () {
      const { pay, merchant, token } = await loadFixture(deployFixture);
      const now = await time.latest();
      await expect(
        pay.connect(merchant).registerOrder(oid('ord_eq'), token, AMOUNT, now),
      ).to.be.revertedWithCustomError(pay, 'InvalidExpiry');
    });

    it('rejects payment after expiry', async function () {
      const { pay, merchant, payer, token } = await loadFixture(deployFixture);
      const expiry = (await time.latest()) + 3600;
      await pay.connect(merchant).registerOrder(oid('ord_exp'), token, AMOUNT, expiry);
      await token.connect(payer).approve(pay, AMOUNT);
      await time.increaseTo(expiry + 1);
      await expect(
        pay.connect(payer).payOrder(merchant.address, oid('ord_exp')),
      ).to.be.revertedWithCustomError(pay, 'OrderExpired');
    });
  });

  describe('fee locked at registration', function () {
    it('honors the fee at registration time, not a later fee change (ERC-20)', async function () {
      const { pay, owner, merchant, payer, feeRecipient, token } = await loadFixture(deployFixture);
      // Registered at 0.5%.
      await pay.connect(merchant).registerOrder(oid('ord_lock'), token, AMOUNT, NO_EXPIRY);
      // Owner bumps the platform fee to the 5% cap before the customer pays.
      await pay.connect(owner).setFeeConfig(500, feeRecipient.address);
      await token.connect(payer).approve(pay, AMOUNT);

      // The merchant still nets the amount minus the *locked* 0.5% — not the new 5%.
      const { fee, net } = expectedSplit(AMOUNT, FEE_BPS);
      await expect(
        pay.connect(payer).payOrder(merchant.address, oid('ord_lock')),
      ).to.changeTokenBalances(token, [payer, merchant, feeRecipient], [-AMOUNT, net, fee]);
    });

    it('honors the fee at registration time for native orders', async function () {
      const { pay, owner, merchant, payer, feeRecipient } = await loadFixture(deployFixture);
      await pay.connect(merchant).registerOrder(oid('ord_lock_n'), ethers.ZeroAddress, AMOUNT, NO_EXPIRY);
      await pay.connect(owner).setFeeConfig(500, feeRecipient.address);

      const { fee, net } = expectedSplit(AMOUNT, FEE_BPS);
      await expect(
        pay.connect(payer).payOrderNative(merchant.address, oid('ord_lock_n'), { value: AMOUNT }),
      ).to.changeEtherBalances([merchant, feeRecipient], [net, fee]);
    });

    it('applies a later fee reduction only to orders registered afterwards', async function () {
      const { pay, owner, merchant, payer, feeRecipient, token } = await loadFixture(deployFixture);
      // Old order keeps 0.5%.
      await pay.connect(merchant).registerOrder(oid('ord_old'), token, AMOUNT, NO_EXPIRY);
      // Owner drops the fee to 0; new order locks in 0.
      await pay.connect(owner).setFeeConfig(0, feeRecipient.address);
      await pay.connect(merchant).registerOrder(oid('ord_new'), token, AMOUNT, NO_EXPIRY);

      expect((await pay.getOrder(merchant.address, oid('ord_old'))).feeBps).to.equal(FEE_BPS);
      expect((await pay.getOrder(merchant.address, oid('ord_new'))).feeBps).to.equal(0n);
    });
  });

  describe('fee recipient locked at registration', function () {
    it('sends ERC-20 fees to the recipient locked at registration, not a later change', async function () {
      const { pay, owner, merchant, payer, feeRecipient, other, token } = await loadFixture(deployFixture);
      await pay.connect(merchant).registerOrder(oid('ord_r'), token, AMOUNT, NO_EXPIRY);
      // Owner redirects the platform fee pool after the order was registered.
      await pay.connect(owner).setFeeConfig(FEE_BPS, other.address);
      await token.connect(payer).approve(pay, AMOUNT);

      const { fee, net } = expectedSplit(AMOUNT, FEE_BPS);
      await expect(pay.connect(payer).payOrder(merchant.address, oid('ord_r')))
        .to.emit(pay, 'FeePaid')
        .withArgs(oid('ord_r'), await token.getAddress(), fee, feeRecipient.address);
      expect(await token.balanceOf(feeRecipient.address)).to.equal(fee); // locked recipient paid
      expect(await token.balanceOf(other.address)).to.equal(0); // new recipient gets nothing
      expect(await token.balanceOf(merchant.address)).to.equal(net);
    });

    it('sends native fees to the recipient locked at registration', async function () {
      const { pay, owner, merchant, payer, feeRecipient, other } = await loadFixture(deployFixture);
      await pay.connect(merchant).registerOrder(oid('ord_rn'), ethers.ZeroAddress, AMOUNT, NO_EXPIRY);
      await pay.connect(owner).setFeeConfig(FEE_BPS, other.address);

      const { fee, net } = expectedSplit(AMOUNT, FEE_BPS);
      await expect(
        pay.connect(payer).payOrderNative(merchant.address, oid('ord_rn'), { value: AMOUNT }),
      ).to.changeEtherBalances([merchant, feeRecipient, other], [net, fee, 0]);
    });
  });

  describe('purgeSettledOrder', function () {
    async function settledFixture() {
      const base = await deployFixture();
      await base.pay
        .connect(base.merchant)
        .registerOrder(oid('ord_p'), ethers.ZeroAddress, AMOUNT, NO_EXPIRY);
      await base.pay.connect(base.payer).payOrderNative(base.merchant.address, oid('ord_p'), { value: AMOUNT });
      return base;
    }

    it('records the settlement time on the order', async function () {
      const { pay, merchant } = await loadFixture(settledFixture);
      const order = await pay.getOrder(merchant.address, oid('ord_p'));
      expect(order.settledAt).to.equal(BigInt(await time.latest()));
    });

    it('blocks purging an unpaid order', async function () {
      const { pay, merchant, token } = await loadFixture(deployFixture);
      await pay.connect(merchant).registerOrder(oid('ord_u'), token, AMOUNT, NO_EXPIRY);
      await expect(
        pay.connect(merchant).purgeSettledOrder(oid('ord_u')),
      ).to.be.revertedWithCustomError(pay, 'OrderNotSettled');
    });

    it('blocks purging within the safety window', async function () {
      const { pay, merchant } = await loadFixture(settledFixture);
      await expect(
        pay.connect(merchant).purgeSettledOrder(oid('ord_p')),
      ).to.be.revertedWithCustomError(pay, 'PurgeDelayNotElapsed');
    });

    it('lets the merchant purge after the delay, freeing the order id for reuse', async function () {
      const { pay, merchant } = await loadFixture(settledFixture);
      const delay = BigInt(await pay.PURGE_DELAY());
      await time.increaseTo(BigInt(await time.latest()) + delay + 1n);

      await expect(pay.connect(merchant).purgeSettledOrder(oid('ord_p')))
        .to.emit(pay, 'OrderPurged')
        .withArgs(merchant.address, oid('ord_p'));

      const order = await pay.getOrder(merchant.address, oid('ord_p'));
      expect(order.exists).to.equal(false);
      await expect(
        pay.connect(merchant).registerOrder(oid('ord_p'), ethers.ZeroAddress, AMOUNT, NO_EXPIRY),
      ).to.not.be.reverted;
    });

    it('cannot purge another merchant order (keyed by msg.sender)', async function () {
      const { pay, merchant, other } = await loadFixture(settledFixture);
      const delay = BigInt(await pay.PURGE_DELAY());
      await time.increaseTo(BigInt(await time.latest()) + delay + 1n);
      await expect(
        pay.connect(other).purgeSettledOrder(oid('ord_p')),
      ).to.be.revertedWithCustomError(pay, 'OrderNotFound');
    });
  });

  describe('rescueTokens', function () {
    it('lets the owner sweep stray ERC-20 sent directly to the contract', async function () {
      const { pay, owner, other, token } = await loadFixture(deployFixture);
      const stray = usdq(7);
      await token.mint(await pay.getAddress(), stray); // funds arrive outside the payment flow

      await expect(pay.connect(owner).rescueTokens(await token.getAddress(), other.address, stray))
        .to.emit(pay, 'TokensRescued')
        .withArgs(await token.getAddress(), other.address, stray);
      expect(await token.balanceOf(other.address)).to.equal(stray);
      expect(await token.balanceOf(await pay.getAddress())).to.equal(0);
    });

    it('lets the owner sweep native QUAI force-sent to the contract', async function () {
      const { pay, owner, other } = await loadFixture(deployFixture);
      const stray = AMOUNT;
      // The router's receive() reverts, so the only way native QUAI can arrive is a forced send
      // (selfdestruct) — exactly the case rescueTokens(NATIVE) exists for.
      const bomber = await ethers.deployContract('SelfDestructor', [], { value: stray });
      await bomber.destroy(await pay.getAddress());
      expect(await ethers.provider.getBalance(await pay.getAddress())).to.equal(stray);

      const before = await ethers.provider.getBalance(other.address);
      await expect(pay.connect(owner).rescueTokens(ethers.ZeroAddress, other.address, stray))
        .to.emit(pay, 'TokensRescued')
        .withArgs(ethers.ZeroAddress, other.address, stray);
      const after = await ethers.provider.getBalance(other.address);
      expect(after - before).to.equal(stray);
      expect(await ethers.provider.getBalance(await pay.getAddress())).to.equal(0);
    });

    it('rejects rescue from a non-owner', async function () {
      const { pay, other, token } = await loadFixture(deployFixture);
      await expect(
        pay.connect(other).rescueTokens(await token.getAddress(), other.address, 1),
      ).to.be.revertedWithCustomError(pay, 'OwnableUnauthorizedAccount');
    });

    it('rejects a zero destination', async function () {
      const { pay, owner, token } = await loadFixture(deployFixture);
      await expect(
        pay.connect(owner).rescueTokens(await token.getAddress(), ethers.ZeroAddress, 1),
      ).to.be.revertedWithCustomError(pay, 'ZeroAddress');
    });
  });

  describe('fee locked at MAX_FEE_BPS', function () {
    it('locks the 5% cap at registration even if the fee is later lowered', async function () {
      const { pay, owner, merchant, payer, feeRecipient, token } = await loadFixture(deployFixture);
      await pay.connect(owner).setFeeConfig(500, feeRecipient.address); // the cap
      await pay.connect(merchant).registerOrder(oid('ord_max'), token, AMOUNT, NO_EXPIRY);
      await pay.connect(owner).setFeeConfig(0, feeRecipient.address); // later lowered...
      await token.connect(payer).approve(pay, AMOUNT);

      // ...but the merchant still pays the 5% locked at registration.
      const { fee, net } = expectedSplit(AMOUNT, 500n);
      await expect(
        pay.connect(payer).payOrder(merchant.address, oid('ord_max')),
      ).to.changeTokenBalances(token, [payer, merchant, feeRecipient], [-AMOUNT, net, fee]);
    });
  });

  describe('admin', function () {
    it('lets the owner update the fee config', async function () {
      const { pay, owner, other } = await loadFixture(deployFixture);
      await expect(pay.connect(owner).setFeeConfig(100, other.address))
        .to.emit(pay, 'FeeConfigUpdated')
        .withArgs(100, other.address);
      expect(await pay.feeBps()).to.equal(100);
      expect(await pay.feeRecipient()).to.equal(other.address);
    });

    it('caps the fee at MAX_FEE_BPS', async function () {
      const { pay, owner, other } = await loadFixture(deployFixture);
      await expect(
        pay.connect(owner).setFeeConfig(501, other.address),
      ).to.be.revertedWithCustomError(pay, 'FeeTooHigh');
    });

    it('rejects a zero fee recipient', async function () {
      const { pay, owner } = await loadFixture(deployFixture);
      await expect(
        pay.connect(owner).setFeeConfig(100, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(pay, 'ZeroFeeRecipient');
    });

    it('rejects fee changes from non-owners', async function () {
      const { pay, other } = await loadFixture(deployFixture);
      await expect(
        pay.connect(other).setFeeConfig(100, other.address),
      ).to.be.revertedWithCustomError(pay, 'OwnableUnauthorizedAccount');
    });

    it('lets the owner manage the accepted-token allowlist', async function () {
      const { pay, owner, other } = await loadFixture(deployFixture);
      expect(await pay.isTokenAccepted(other.address)).to.equal(false);
      await expect(pay.connect(owner).setTokenAccepted(other.address, true))
        .to.emit(pay, 'AcceptedTokenUpdated')
        .withArgs(other.address, true);
      expect(await pay.isTokenAccepted(other.address)).to.equal(true);
    });

    it('rejects allowlist changes from non-owners', async function () {
      const { pay, other } = await loadFixture(deployFixture);
      await expect(
        pay.connect(other).setTokenAccepted(other.address, true),
      ).to.be.revertedWithCustomError(pay, 'OwnableUnauthorizedAccount');
    });

    it('rejects pause from non-owners', async function () {
      const { pay, other } = await loadFixture(deployFixture);
      await expect(pay.connect(other).pause()).to.be.revertedWithCustomError(
        pay,
        'OwnableUnauthorizedAccount',
      );
    });

    it('unpause restores payments', async function () {
      const { pay, owner, merchant, token } = await loadFixture(deployFixture);
      await pay.connect(owner).pause();
      await pay.connect(owner).unpause();
      await expect(pay.connect(merchant).registerOrder(oid('ord_1'), token, AMOUNT, NO_EXPIRY)).to.not
        .be.reverted;
    });
  });

  describe('ownership (Ownable2Step)', function () {
    it('transfers ownership in two steps', async function () {
      const { pay, owner, other } = await loadFixture(deployFixture);
      await pay.connect(owner).transferOwnership(other.address);
      // Ownership does not move until accepted.
      expect(await pay.owner()).to.equal(owner.address);
      expect(await pay.pendingOwner()).to.equal(other.address);

      await pay.connect(other).acceptOwnership();
      expect(await pay.owner()).to.equal(other.address);
    });

    it('rejects acceptance from a non-pending account', async function () {
      const { pay, owner, other } = await loadFixture(deployFixture);
      await pay.connect(owner).transferOwnership(other.address);
      await expect(pay.connect(owner).acceptOwnership()).to.be.revertedWithCustomError(
        pay,
        'OwnableUnauthorizedAccount',
      );
    });
  });

  describe('reentrancy', function () {
    it('blocks re-entry through a malicious ERC-20', async function () {
      const { pay, owner, merchant, payer } = await loadFixture(deployFixture);
      const evil = await ethers.deployContract('ReentrantToken');
      await evil.mint(payer.address, AMOUNT);
      await pay.connect(owner).setTokenAccepted(await evil.getAddress(), true);
      await pay.connect(merchant).registerOrder(oid('ord_re'), evil, AMOUNT, NO_EXPIRY);
      await evil.connect(payer).approve(pay, AMOUNT);
      await evil.arm(await pay.getAddress(), merchant.address, oid('ord_re'));

      await expect(
        pay.connect(payer).payOrder(merchant.address, oid('ord_re')),
      ).to.be.revertedWithCustomError(pay, 'ReentrancyGuardReentrantCall');
    });

    it('blocks re-entry through a malicious native receiver', async function () {
      const { pay, payer } = await loadFixture(deployFixture);
      const evil = await ethers.deployContract('ReentrantReceiver', [await pay.getAddress()]);
      await evil.register(oid('ord_re2'), AMOUNT); // evil contract is the merchant

      // The re-entrant receive() makes the payout call fail -> whole payment reverts, funds safe.
      await expect(
        pay.connect(payer).payOrderNative(await evil.getAddress(), oid('ord_re2'), { value: AMOUNT }),
      ).to.be.revertedWithCustomError(pay, 'NativeTransferFailed');
    });
  });

  describe('registerOrderWithPayer', function () {
    it('stores the expected payer and lets only that payer settle (ERC-20)', async function () {
      const { pay, merchant, payer, other, token } = await loadFixture(deployFixture);
      await pay
        .connect(merchant)
        .registerOrderWithPayer(oid('ord_b'), token, AMOUNT, NO_EXPIRY, payer.address);

      const order = await pay.getOrder(merchant.address, oid('ord_b'));
      expect(order.expectedPayer).to.equal(payer.address);

      // A third party trying to fill the order first is refused — the merchant's sale is safe.
      await token.connect(other).approve(pay, AMOUNT);
      await expect(
        pay.connect(other).payOrder(merchant.address, oid('ord_b')),
      ).to.be.revertedWithCustomError(pay, 'WrongPayer');

      // The intended payer settles normally.
      await token.connect(payer).approve(pay, AMOUNT);
      await expect(pay.connect(payer).payOrder(merchant.address, oid('ord_b'))).to.emit(
        pay,
        'PaymentReceived',
      );
    });

    it('enforces the expected payer for native orders too', async function () {
      const { pay, merchant, payer, other } = await loadFixture(deployFixture);
      await pay
        .connect(merchant)
        .registerOrderWithPayer(oid('ord_bn'), ethers.ZeroAddress, AMOUNT, NO_EXPIRY, payer.address);
      await expect(
        pay.connect(other).payOrderNative(merchant.address, oid('ord_bn'), { value: AMOUNT }),
      ).to.be.revertedWithCustomError(pay, 'WrongPayer');
      await expect(
        pay.connect(payer).payOrderNative(merchant.address, oid('ord_bn'), { value: AMOUNT }),
      ).to.emit(pay, 'PaymentReceived');
    });

    it('expectedPayer = zero behaves like registerOrder (anyone may pay)', async function () {
      const { pay, merchant, payer, token } = await loadFixture(deployFixture);
      await pay
        .connect(merchant)
        .registerOrderWithPayer(oid('ord_open'), token, AMOUNT, NO_EXPIRY, ethers.ZeroAddress);
      await token.connect(payer).approve(pay, AMOUNT);
      await expect(pay.connect(payer).payOrder(merchant.address, oid('ord_open'))).to.emit(
        pay,
        'PaymentReceived',
      );
    });

    it('reverts a re-registration of the same order id (with or without payer)', async function () {
      const { pay, merchant, payer, token } = await loadFixture(deployFixture);
      await pay.connect(merchant).registerOrderWithPayer(oid('ord_x'), token, AMOUNT, NO_EXPIRY, payer.address);
      await expect(
        pay.connect(merchant).registerOrderWithPayer(oid('ord_x'), token, AMOUNT, NO_EXPIRY, payer.address),
      ).to.be.revertedWithCustomError(pay, 'OrderAlreadyExists');
    });
  });

  describe('PaymentSettled + order nonce', function () {
    it('emits PaymentSettled with the exact fee/net split and nonce (ERC-20)', async function () {
      const { pay, merchant, payer, token } = await loadFixture(deployFixture);
      await pay.connect(merchant).registerOrder(oid('ord_s'), token, AMOUNT, NO_EXPIRY);
      await token.connect(payer).approve(pay, AMOUNT);
      const { fee, net } = expectedSplit(AMOUNT, FEE_BPS);

      await expect(pay.connect(payer).payOrder(merchant.address, oid('ord_s')))
        .to.emit(pay, 'PaymentSettled')
        .withArgs(merchant.address, oid('ord_s'), payer.address, await token.getAddress(), AMOUNT, fee, net, 1n, anyValue);
    });

    it('emits PaymentSettled for native payments', async function () {
      const { pay, merchant, payer } = await loadFixture(deployFixture);
      await pay.connect(merchant).registerOrder(oid('ord_sn'), ethers.ZeroAddress, AMOUNT, NO_EXPIRY);
      const { fee, net } = expectedSplit(AMOUNT, FEE_BPS);
      await expect(
        pay.connect(payer).payOrderNative(merchant.address, oid('ord_sn'), { value: AMOUNT }),
      ).to.emit(pay, 'PaymentSettled').withArgs(merchant.address, oid('ord_sn'), payer.address, ethers.ZeroAddress, AMOUNT, fee, net, 1n, anyValue);
    });

    it('assigns per-merchant increasing nonces; reuse of an order id gets a new nonce', async function () {
      const { pay, merchant, other, payer, token } = await loadFixture(deployFixture);
      await pay.connect(merchant).registerOrder(oid('ord_n1'), token, AMOUNT, NO_EXPIRY);
      await pay.connect(other).registerOrder(oid('ord_n1'), token, AMOUNT, NO_EXPIRY);

      // Nonces are per-merchant: each merchant's first order is nonce 1.
      expect((await pay.getOrder(merchant.address, oid('ord_n1'))).nonce).to.equal(1n);
      expect((await pay.getOrder(other.address, oid('ord_n1'))).nonce).to.equal(1n);

      await pay.connect(merchant).registerOrder(oid('ord_n2'), token, AMOUNT, NO_EXPIRY);
      expect((await pay.getOrder(merchant.address, oid('ord_n2'))).nonce).to.equal(2n);

      // Settle + purge + reuse the same order id: the new order carries a distinct nonce, so an
      // off-chain indexer can tell the two settlements apart.
      await token.connect(payer).approve(pay, AMOUNT);
      await pay.connect(payer).payOrder(merchant.address, oid('ord_n2'));
      const delay = BigInt(await pay.PURGE_DELAY());
      await time.increaseTo(BigInt(await time.latest()) + delay + 1n);
      await pay.connect(merchant).purgeSettledOrder(oid('ord_n2'));
      await pay.connect(merchant).registerOrder(oid('ord_n2'), token, AMOUNT, NO_EXPIRY);
      expect((await pay.getOrder(merchant.address, oid('ord_n2'))).nonce).to.equal(3n);
    });
  });

  describe('pause guardian', function () {
    it('lets the owner set the guardian and the guardian pause the router', async function () {
      const { pay, owner, other, merchant, token } = await loadFixture(deployFixture);
      await expect(pay.connect(owner).setPauseGuardian(other.address))
        .to.emit(pay, 'PauseGuardianUpdated')
        .withArgs(other.address);

      await pay.connect(other).pause();
      await expect(
        pay.connect(merchant).registerOrder(oid('ord_g'), token, AMOUNT, NO_EXPIRY),
      ).to.be.revertedWithCustomError(pay, 'EnforcedPause');
    });

    it('the guardian can never unpause (owner only)', async function () {
      const { pay, owner, other, merchant, token } = await loadFixture(deployFixture);
      await pay.connect(owner).setPauseGuardian(other.address);
      await pay.connect(other).pause();
      await expect(pay.connect(other).unpause()).to.be.revertedWithCustomError(
        pay,
        'OwnableUnauthorizedAccount',
      );
      await pay.connect(owner).unpause();
      await expect(pay.connect(merchant).registerOrder(oid('ord_g'), token, AMOUNT, NO_EXPIRY)).to.not
        .be.reverted;
    });

    it('the guardian cannot change fees, tokens or ownership', async function () {
      const { pay, owner, other, feeRecipient } = await loadFixture(deployFixture);
      await pay.connect(owner).setPauseGuardian(other.address);
      await expect(
        pay.connect(other).setFeeConfig(0, feeRecipient.address),
      ).to.be.revertedWithCustomError(pay, 'OwnableUnauthorizedAccount');
      await expect(
        pay.connect(other).setTokenAccepted(other.address, true),
      ).to.be.revertedWithCustomError(pay, 'OwnableUnauthorizedAccount');
      await expect(
        pay.connect(other).transferOwnership(other.address),
      ).to.be.revertedWithCustomError(pay, 'OwnableUnauthorizedAccount');
    });

    it('a non-owner cannot assign the guardian', async function () {
      const { pay, other } = await loadFixture(deployFixture);
      await expect(
        pay.connect(other).setPauseGuardian(other.address),
      ).to.be.revertedWithCustomError(pay, 'OwnableUnauthorizedAccount');
    });

    it('without a guardian, pause stays owner-only', async function () {
      const { pay, other } = await loadFixture(deployFixture);
      await expect(pay.connect(other).pause()).to.be.revertedWithCustomError(
        pay,
        'OwnableUnauthorizedAccount',
      );
    });
  });

  describe('upgradeability (UUPS)', function () {
    it('sets the explicit owner passed to initialize', async function () {
      const { pay, owner } = await loadFixture(deployFixture);
      expect(await pay.owner()).to.equal(owner.address);
    });

    it('cannot be initialized twice', async function () {
      const { pay, owner, feeRecipient } = await loadFixture(deployFixture);
      await expect(
        pay.initialize(feeRecipient.address, 0, owner.address),
      ).to.be.revertedWithCustomError(pay, 'InvalidInitialization');
    });

    it('locks the implementation so it cannot be initialized directly', async function () {
      const { owner, feeRecipient } = await loadFixture(deployFixture);
      const impl = await ethers.deployContract('PayWithQuai');
      await expect(
        impl.initialize(feeRecipient.address, 0, owner.address),
      ).to.be.revertedWithCustomError(impl, 'InvalidInitialization');
    });

    it('rejects an upgrade from a non-owner', async function () {
      const { pay, other } = await loadFixture(deployFixture);
      const v2 = await ethers.deployContract('PayWithQuaiV2Mock');
      await expect(
        pay.connect(other).upgradeToAndCall(await v2.getAddress(), '0x'),
      ).to.be.revertedWithCustomError(pay, 'OwnableUnauthorizedAccount');
    });

    it('V2 re-initializer is owner-only (cannot be front-run by an arbitrary caller)', async function () {
      const { pay, owner, other } = await loadFixture(deployFixture);
      const v2 = await ethers.deployContract('PayWithQuaiV2Mock');
      await pay.connect(owner).upgradeToAndCall(await v2.getAddress(), '0x');
      const upgraded = v2.attach(await pay.getAddress());

      await expect(
        upgraded.connect(other).initializeV2('sneaky'),
      ).to.be.revertedWithCustomError(upgraded, 'OwnableUnauthorizedAccount');
      expect(await upgraded.note()).to.equal('');
    });

    it('lets the owner upgrade, preserving all existing state', async function () {
      const { pay, owner, merchant, payer, feeRecipient, token } = await loadFixture(deployFixture);
      // Establish state under v1: an unpaid order + a settled order.
      await pay.connect(merchant).registerOrder(oid('ord_keep'), token, AMOUNT, NO_EXPIRY);
      await pay.connect(merchant).registerOrder(oid('ord_paid'), token, AMOUNT, NO_EXPIRY);
      await token.connect(payer).approve(pay, AMOUNT);
      await pay.connect(payer).payOrder(merchant.address, oid('ord_paid'));

      // Upgrade to V2 and run its re-initializer in the same tx.
      const v2 = await ethers.deployContract('PayWithQuaiV2Mock');
      const initV2 = v2.interface.encodeFunctionData('initializeV2', ['hello-v2']);
      await pay.connect(owner).upgradeToAndCall(await v2.getAddress(), initV2);

      const upgraded = v2.attach(await pay.getAddress());
      // New logic is live...
      expect(await upgraded.version()).to.equal('v2');
      expect(await upgraded.note()).to.equal('hello-v2');
      // ...and every piece of v1 state survived untouched.
      expect(await upgraded.owner()).to.equal(owner.address);
      expect(await upgraded.feeRecipient()).to.equal(feeRecipient.address);
      expect(await upgraded.feeBps()).to.equal(FEE_BPS);
      expect(await upgraded.isTokenAccepted(await token.getAddress())).to.equal(true);
      expect(await upgraded.isSettled(merchant.address, oid('ord_paid'))).to.equal(true);
      const kept = await upgraded.getOrder(merchant.address, oid('ord_keep'));
      expect(kept.exists).to.equal(true);
      expect(kept.settled).to.equal(false);
      expect(kept.amount).to.equal(AMOUNT);
    });

    it('signed-order module survives the upgrade: pre-existing orders keep paying', async function () {
      const { pay, owner, merchant, payer, feeRecipient, signer, token } = await loadFixture(deployFixture);
      // An order registered under v1 must still settle after the signing module lands — this is
      // the whole backwards-compatibility promise of shipping signed orders as an upgrade.
      await pay.connect(merchant).registerOrder(oid('ord_before'), await token.getAddress(), AMOUNT, NO_EXPIRY);

      const v2 = await ethers.deployContract('PayWithQuaiV2Mock');
      const init = v2.interface.encodeFunctionData('initializeSigningV2', ['PayWithQuai', '1']);
      await pay.connect(owner).upgradeToAndCall(await v2.getAddress(), init);
      const upgraded = v2.attach(await pay.getAddress());

      // Existing pre-registered order is still payable through the legacy path.
      await token.connect(payer).approve(await pay.getAddress(), AMOUNT);
      const { fee, net } = expectedSplit(AMOUNT, FEE_BPS);
      await expect(
        upgraded.connect(payer).payOrder(merchant.address, oid('ord_before')),
      ).to.changeTokenBalances(token, [payer, merchant, feeRecipient], [-AMOUNT, net, fee]);

      // And the new module works on the very same proxy, with signer state written after the upgrade.
      await upgraded.connect(owner).setSigner(signer.address, true);
      const o = {
        merchant: merchant.address,
        orderId: oid('after_upgrade'),
        token: await token.getAddress(),
        amount: AMOUNT,
        expiry: 0n,
        feeBps: Number(FEE_BPS),
        feeRecipient: feeRecipient.address,
        expectedPayer: payer.address,
      };
      const { chainId } = await ethers.provider.getNetwork();
      const sig = await signer.signTypedData(
        {
          name: 'PayWithQuai',
          version: '1',
          chainId,
          verifyingContract: await pay.getAddress(),
        },
        {
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
        },
        o,
      );
      await token.connect(payer).approve(await pay.getAddress(), AMOUNT);
      await expect(upgraded.connect(payer).paySignedOrder(o, sig)).to.changeTokenBalances(
        token,
        [payer, merchant, feeRecipient],
        [-AMOUNT, net, fee],
      );
    });

    it('signed-order domain cannot be initialized twice after the upgrade', async function () {
      const { pay, owner, other } = await loadFixture(deployFixture);
      const v2 = await ethers.deployContract('PayWithQuaiV2Mock');
      const init = v2.interface.encodeFunctionData('initializeSigningV2', ['PayWithQuai', '1']);
      await pay.connect(owner).upgradeToAndCall(await v2.getAddress(), init);
      const upgraded = v2.attach(await pay.getAddress());

      // Already consumed -> nobody can re-initialize the domain, owner included.
      await expect(upgraded.initializeSigning('Hijack', '1')).to.be.revertedWithCustomError(
        upgraded,
        'InvalidInitialization',
      );
      await expect(upgraded.connect(other).initializeSigning('Hijack', '1')).to.be.revertedWithCustomError(
        upgraded,
        'InvalidInitialization',
      );
      // The domain in force is still the original one, so existing signatures remain valid.
      expect(await upgraded.eip712Domain()).to.include('PayWithQuai');
    });

    it('still processes payments after an upgrade', async function () {
      const { pay, owner, merchant, payer, feeRecipient, token } = await loadFixture(deployFixture);
      const v2 = await ethers.deployContract('PayWithQuaiV2Mock');
      await pay.connect(owner).upgradeToAndCall(await v2.getAddress(), '0x');
      const upgraded = v2.attach(await pay.getAddress());

      await upgraded.connect(merchant).registerOrder(oid('ord_after'), token, AMOUNT, NO_EXPIRY);
      await token.connect(payer).approve(upgraded, AMOUNT);
      const { fee, net } = expectedSplit(AMOUNT, FEE_BPS);
      await expect(
        upgraded.connect(payer).payOrder(merchant.address, oid('ord_after')),
      ).to.changeTokenBalances(token, [payer, merchant, feeRecipient], [-AMOUNT, net, fee]);
    });
  });
});
