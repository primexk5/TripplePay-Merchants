const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { anyValue } = require('@nomicfoundation/hardhat-chai-matchers/withArgs');

const oid = (s) => ethers.encodeBytes32String(s);
const usdq = (n) => ethers.parseUnits(String(n), 6);

const DOMAIN_NAME = 'PayWithQuai';
const DOMAIN_VERSION = '1';

// Field order here MUST match the Solidity struct declaration — ethers derives the type string
// from this object, and a mismatch produces a digest the contract will reject.
const SIGNED_ORDER_TYPES = {
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

describe('PayWithQuai — signed orders (customer pays gas)', function () {
  const FEE_BPS = 50n;
  const AMOUNT = usdq(25);

  async function deployProxy(initArgs) {
    const Impl = await ethers.getContractFactory('PayWithQuai');
    const impl = await Impl.deploy();
    const initData = Impl.interface.encodeFunctionData('initialize', initArgs);
    const proxy = await ethers.deployContract('ERC1967Proxy', [await impl.getAddress(), initData]);
    return Impl.attach(await proxy.getAddress());
  }

  // `signer` is the platform key that authorizes orders off-chain on a merchant's behalf.
  async function setup(signerIsSigner = true) {
    const [owner, merchant, payer, feeRecipient, other, signer, stranger] = await ethers.getSigners();

    const token = await ethers.deployContract('MockStablecoin');
    await token.mint(payer.address, usdq(1000));

    const pay = await deployProxy([feeRecipient.address, FEE_BPS, owner.address]);
    await pay.initializeSigning(DOMAIN_NAME, DOMAIN_VERSION);
    await pay.setTokenAccepted(await token.getAddress(), true);
    await pay.setTokenAccepted(ethers.ZeroAddress, true); // native QUAI
    if (signerIsSigner) await pay.setSigner(signer.address, true);

    return { owner, merchant, payer, feeRecipient, other, signer, stranger, token, pay };
  }

  const deployFixture = () => setup(true);
  const noSignerFixture = () => setup(false);

  // NOTE: `ethers.chainId` is undefined in ethers v6 — the real id must come from the provider. A
  // domain with an undefined chainId silently produces a different digest, and because
  // ECDSA.tryRecover accepts any well-formed (r,s) that failure surfaces as NotSigner rather than
  // InvalidSignature, which is a very confusing thing to debug.
  const domainFor = (verifyingContract, cid) => ({
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId: cid,
    verifyingContract,
  });

  function order(over = {}) {
    return {
      merchant: ethers.ZeroAddress,
      orderId: oid('signed-1'),
      token: ethers.ZeroAddress,
      amount: AMOUNT,
      expiry: 0n,
      feeBps: Number(FEE_BPS),
      feeRecipient: ethers.ZeroAddress,
      expectedPayer: ethers.ZeroAddress,
      ...over,
    };
  }

  const expectedSplit = (amount, feeBps) => {
    const fee = (amount * feeBps) / 10000n;
    return { fee, net: amount - fee };
  };

  // Sign an authorization for `pay` under the correct domain. `overrides.verifyingContract` /
  // `overrides.chainId` mint a deliberately wrong-domain signature for the replay tests.
  async function signedFor(pay, signerWallet, o, overrides = {}) {
    const address = overrides.verifyingContract ?? (await pay.getAddress());
    const cid = overrides.chainId ?? (await ethers.provider.getNetwork()).chainId;
    return signerWallet.signTypedData(domainFor(address, cid), SIGNED_ORDER_TYPES, o);
  }

  describe('initialization', function () {
    it('lets only the owner initialize the EIP-712 domain', async function () {
      // Fresh proxy: nothing is initialized yet, so this exercises the onlyOwner guard specifically
      // (on the fixture proxy the reinitializer guard fires first).
      const { owner, feeRecipient, other } = await loadFixture(deployFixture);
      const fresh = await deployProxy([feeRecipient.address, FEE_BPS, owner.address]);
      await expect(fresh.connect(other).initializeSigning('Hijack', '1')).to.be.revertedWithCustomError(
        fresh,
        'OwnableUnauthorizedAccount',
      );
      await expect(fresh.connect(owner).initializeSigning(DOMAIN_NAME, DOMAIN_VERSION)).to.not.be.reverted;
    });

    it('cannot be initialized twice (reinitializer guard)', async function () {
      const { pay, owner } = await loadFixture(deployFixture);
      await expect(pay.connect(owner).initializeSigning(DOMAIN_NAME, DOMAIN_VERSION)).to.be.revertedWithCustomError(
        pay,
        'InvalidInitialization',
      );
    });

    it('reports signingInitialized() so upgrade tooling can stay idempotent', async function () {
      // Deployment tooling must be able to tell "domain not set yet" (initialize in the upgrade
      // tx) from "already initialized" (upgrade with empty calldata, because a reinitializer can
      // only ever be consumed once).
      const { owner, feeRecipient, other } = await loadFixture(deployFixture);
      const fresh = await deployProxy([feeRecipient.address, FEE_BPS, owner.address]);
      expect(await fresh.signingInitialized()).to.equal(false);
      await fresh.connect(owner).initializeSigning(DOMAIN_NAME, DOMAIN_VERSION);
      expect(await fresh.signingInitialized()).to.equal(true);
      // An initialized deployment stays initialized across another reading / upgrade attempt.
      expect(await fresh.signingInitialized()).to.equal(true);
      // Same on the fixture proxy used by the rest of the suite.
      const { pay } = await loadFixture(deployFixture);
      expect(await pay.signingInitialized()).to.equal(true);
    });

    it('reverts when the domain was never initialized', async function () {
      // Fresh proxy with signing never initialized — the mock account is allowlisted but there is
      // no domain, so the router must refuse rather than sign against an empty domain.
      const [owner, , , feeRecipient, , signer] = await ethers.getSigners();
      const Impl = await ethers.getContractFactory('PayWithQuai');
      const impl = await Impl.deploy();
      const initData = Impl.interface.encodeFunctionData('initialize', [
        feeRecipient.address,
        FEE_BPS,
        owner.address,
      ]);
      const proxy = await ethers.deployContract('ERC1967Proxy', [await impl.getAddress(), initData]);
      const pay = Impl.attach(await proxy.getAddress());
      await pay.setSigner(signer.address, true);

      const o = order({ merchant: owner.address, token: ethers.ZeroAddress });
      const sig = await signer.signTypedData(domainFor(await pay.getAddress()), SIGNED_ORDER_TYPES, o);
      await expect(pay.paySignedOrder(o, sig, { value: AMOUNT })).to.be.revertedWithCustomError(
        pay,
        'SigningNotInitialized',
      );
    });
  });

  describe('setSigner', function () {
    it('is owner-only and rejects the zero address', async function () {
      const { pay, owner, stranger, other } = await loadFixture(noSignerFixture);
      await expect(pay.connect(other).setSigner(stranger.address, true)).to.be.revertedWithCustomError(
        pay,
        'OwnableUnauthorizedAccount',
      );
      await expect(pay.connect(owner).setSigner(ethers.ZeroAddress, true)).to.be.revertedWithCustomError(
        pay,
        'ZeroAddress',
      );
    });

    it('emits SignerUpdated', async function () {
      const { pay, owner, stranger } = await loadFixture(noSignerFixture);
      await expect(pay.connect(owner).setSigner(stranger.address, true))
        .to.emit(pay, 'SignerUpdated')
        .withArgs(stranger.address, true);
      expect(await pay.isSigner(stranger.address)).to.equal(true);
    });
  });

  describe('ERC-20 signed payment', function () {
    it('creates and settles the order in one transaction, forwarding fee and net', async function () {
      const { pay, merchant, payer, feeRecipient, signer, token } = await loadFixture(deployFixture);
      const o = order({
        merchant: merchant.address,
        token: await token.getAddress(),
        feeRecipient: feeRecipient.address,
        expectedPayer: payer.address,
      });
      const sig = await signedFor(pay, signer, o);
      const { fee, net } = expectedSplit(AMOUNT, FEE_BPS);

      await token.connect(payer).approve(await pay.getAddress(), AMOUNT);

      const before = {
        payer: await token.balanceOf(payer.address),
        merchant: await token.balanceOf(merchant.address),
        feeRecipient: await token.balanceOf(feeRecipient.address),
      };

      await expect(pay.connect(payer).paySignedOrder(o, sig))
        .to.emit(pay, 'PaymentReceived')
        .withArgs(merchant.address, o.orderId, payer.address, await token.getAddress(), AMOUNT, anyValue)
        .and.to.emit(pay, 'PaymentSettled')
        .withArgs(merchant.address, o.orderId, payer.address, await token.getAddress(), AMOUNT, fee, net, 1n, anyValue)
        .and.to.emit(pay, 'FeePaid')
        .withArgs(o.orderId, await token.getAddress(), fee, feeRecipient.address);

      expect(await token.balanceOf(payer.address)).to.equal(before.payer - AMOUNT);
      expect(await token.balanceOf(merchant.address)).to.equal(before.merchant + net);
      expect(await token.balanceOf(feeRecipient.address)).to.equal(before.feeRecipient + fee);

      // The order is persisted and immediately settled — replay is impossible.
      const stored = await pay.getOrder(merchant.address, o.orderId);
      expect(stored.exists).to.equal(true);
      expect(stored.settled).to.equal(true);
      expect(stored.amount).to.equal(AMOUNT);
      expect(stored.nonce).to.equal(1n);
      expect(stored.settledAt).to.be.greaterThan(0n);
    });

    it('assigns increasing per-merchant nonces', async function () {
      const { pay, merchant, payer, feeRecipient, signer, token } = await loadFixture(deployFixture);
      for (const n of [1, 2]) {
        const o = order({
          merchant: merchant.address,
          orderId: oid(`signed-n${n}`),
          token: await token.getAddress(),
          feeRecipient: feeRecipient.address,
          expectedPayer: payer.address,
        });
        const sig = await signedFor(pay, signer, o);
        await token.connect(payer).approve(await pay.getAddress(), AMOUNT);
        await pay.connect(payer).paySignedOrder(o, sig);
        expect((await pay.getOrder(merchant.address, o.orderId)).nonce).to.equal(BigInt(n));
      }
    });

    it('rejects a signature from an address that is not an allowlisted signer', async function () {
      const { pay, merchant, payer, feeRecipient, stranger, token } = await loadFixture(deployFixture);
      const o = order({
        merchant: merchant.address,
        token: await token.getAddress(),
        feeRecipient: feeRecipient.address,
      });
      // Correctly-formed signature over the right digest, but from an untrusted key.
      const sig = await signedFor(pay, stranger, o);
      await token.connect(payer).approve(await pay.getAddress(), AMOUNT);
      await expect(pay.connect(payer).paySignedOrder(o, sig)).to.be.revertedWithCustomError(
        pay,
        'InvalidSignature',
      );
    });

    it('rejects a garbage signature', async function () {
      const { pay, merchant, payer, feeRecipient, token } = await loadFixture(deployFixture);
      const o = order({
        merchant: merchant.address,
        token: await token.getAddress(),
        feeRecipient: feeRecipient.address,
      });
      await token.connect(payer).approve(await pay.getAddress(), AMOUNT);
      await expect(
        pay.connect(payer).paySignedOrder(o, '0xdeadbeef'),
      ).to.be.revertedWithCustomError(pay, 'InvalidSignature');
    });

    it('rejects the order when the amount has been tampered with after signing', async function () {
      const { pay, merchant, payer, feeRecipient, signer, token } = await loadFixture(deployFixture);
      const o = order({
        merchant: merchant.address,
        token: await token.getAddress(),
        feeRecipient: feeRecipient.address,
        expectedPayer: payer.address,
      });
      const sig = await signedFor(pay, signer, o);
      // Payer tries to keep the signature but pay a fraction of what was authorized.
      const tampered = { ...o, amount: usdq(1) };
      await token.connect(payer).approve(await pay.getAddress(), usdq(1));
      await expect(pay.connect(payer).paySignedOrder(tampered, sig)).to.be.revertedWithCustomError(
        pay,
        'InvalidSignature',
      );
    });

    it('rejects a re-signed authorization when the merchant is retargeted', async function () {
      const { pay, merchant, other, payer, feeRecipient, signer, token } = await loadFixture(deployFixture);
      const o = order({
        merchant: merchant.address,
        token: await token.getAddress(),
        feeRecipient: feeRecipient.address,
      });
      const sig = await signedFor(pay, signer, o);
      const retargeted = { ...o, merchant: other.address };
      await token.connect(payer).approve(await pay.getAddress(), AMOUNT);
      await expect(pay.connect(payer).paySignedOrder(retargeted, sig)).to.be.revertedWithCustomError(
        pay,
        'InvalidSignature',
      );
    });

    it('rejects replay of the same authorization', async function () {
      const { pay, merchant, payer, feeRecipient, signer, token } = await loadFixture(deployFixture);
      const o = order({
        merchant: merchant.address,
        token: await token.getAddress(),
        feeRecipient: feeRecipient.address,
      });
      const sig = await signedFor(pay, signer, o);
      await token.connect(payer).approve(await pay.getAddress(), AMOUNT * 2n);
      await pay.connect(payer).paySignedOrder(o, sig);
      await expect(pay.connect(payer).paySignedOrder(o, sig)).to.be.revertedWithCustomError(
        pay,
        'OrderAlreadyExists',
      );
    });

    it('rejects settlement from a wallet other than the authorized payer (front-running)', async function () {
      const { pay, merchant, payer, other, feeRecipient, signer, token } = await loadFixture(deployFixture);
      const o = order({
        merchant: merchant.address,
        token: await token.getAddress(),
        feeRecipient: feeRecipient.address,
        expectedPayer: payer.address,
      });
      const sig = await signedFor(pay, signer, o);
      await token.connect(other).approve(await pay.getAddress(), AMOUNT);
      // A third party who sees the authorization in the mempool cannot burn the customer's checkout.
      await expect(pay.connect(other).paySignedOrder(o, sig)).to.be.revertedWithCustomError(pay, 'WrongPayer');
      await token.connect(payer).approve(await pay.getAddress(), AMOUNT);
      await expect(pay.connect(payer).paySignedOrder(o, sig)).to.not.be.reverted;
    });

    it('rejects an expired authorization', async function () {
      const { pay, merchant, payer, feeRecipient, signer, token } = await loadFixture(deployFixture);
      const o = order({
        merchant: merchant.address,
        token: await token.getAddress(),
        feeRecipient: feeRecipient.address,
        expiry: BigInt(await time.latest()) + 60n,
      });
      const sig = await signedFor(pay, signer, o);
      await time.increase(120);
      await token.connect(payer).approve(await pay.getAddress(), AMOUNT);
      await expect(pay.connect(payer).paySignedOrder(o, sig)).to.be.revertedWithCustomError(pay, 'InvalidExpiry');
    });

    it('rejects a token that is not allowlisted', async function () {
      const { pay, merchant, payer, feeRecipient, signer, owner } = await loadFixture(deployFixture);
      const otherToken = await ethers.deployContract('MockStablecoin');
      await otherToken.mint(payer.address, usdq(100));
      await pay.connect(owner).setTokenAccepted(await otherToken.getAddress(), false);

      const o = order({
        merchant: merchant.address,
        token: await otherToken.getAddress(),
        feeRecipient: feeRecipient.address,
      });
      const sig = await signedFor(pay, signer, o);
      await otherToken.connect(payer).approve(await pay.getAddress(), AMOUNT);
      await expect(pay.connect(payer).paySignedOrder(o, sig)).to.be.revertedWithCustomError(pay, 'TokenNotAccepted');
    });

    it('rejects a zero amount, a zero fee recipient and a fee above the cap', async function () {
      const { pay, merchant, payer, feeRecipient, signer, token } = await loadFixture(deployFixture);
      const base = {
        merchant: merchant.address,
        token: await token.getAddress(),
        feeRecipient: feeRecipient.address,
      };
      await token.connect(payer).approve(await pay.getAddress(), usdq(1000));

      const zeroAmount = order({ ...base, amount: 0n });
      await expect(pay.connect(payer).paySignedOrder(zeroAmount, await signedFor(pay, signer, zeroAmount))).to.be
        .revertedWithCustomError(pay, 'ZeroAmount');

      const zeroFeeRecipient = order({ ...base, feeRecipient: ethers.ZeroAddress });
      await expect(
        pay.connect(payer).paySignedOrder(zeroFeeRecipient, await signedFor(pay, signer, zeroFeeRecipient)),
      ).to.be.revertedWithCustomError(pay, 'ZeroFeeRecipient');

      const hugeFee = order({ ...base, feeBps: 501 });
      await expect(pay.connect(payer).paySignedOrder(hugeFee, await signedFor(pay, signer, hugeFee))).to.be
        .revertedWithCustomError(pay, 'FeeTooHigh');
    });

    it('rejects native value sent alongside an ERC-20 order', async function () {
      const { pay, merchant, payer, feeRecipient, signer, token } = await loadFixture(deployFixture);
      const o = order({
        merchant: merchant.address,
        token: await token.getAddress(),
        feeRecipient: feeRecipient.address,
      });
      const sig = await signedFor(pay, signer, o);
      await token.connect(payer).approve(await pay.getAddress(), AMOUNT);
      await expect(
        pay.connect(payer).paySignedOrder(o, sig, { value: 1n }),
      ).to.be.revertedWithCustomError(pay, 'IncorrectNativeValue');
    });

    it('honours a zero platform fee', async function () {
      const { pay, merchant, payer, feeRecipient, signer, token } = await loadFixture(deployFixture);
      const o = order({
        merchant: merchant.address,
        token: await token.getAddress(),
        feeRecipient: feeRecipient.address,
        feeBps: 0,
      });
      const sig = await signedFor(pay, signer, o);
      const merchantBefore = await token.balanceOf(merchant.address);
      const feeBefore = await token.balanceOf(feeRecipient.address);
      await token.connect(payer).approve(await pay.getAddress(), AMOUNT);
      await pay.connect(payer).paySignedOrder(o, sig);
      expect(await token.balanceOf(merchant.address)).to.equal(merchantBefore + AMOUNT);
      expect(await token.balanceOf(feeRecipient.address)).to.equal(feeBefore);
    });
  });

  describe('native signed payment', function () {
    it('forwards fee and net and requires msg.value to equal the authorized amount', async function () {
      const { pay, merchant, payer, feeRecipient, signer } = await loadFixture(deployFixture);
      const o = order({ merchant: merchant.address, feeRecipient: feeRecipient.address });
      const sig = await signedFor(pay, signer, o);
      const { fee, net } = expectedSplit(AMOUNT, FEE_BPS);

      await expect(pay.connect(payer).paySignedOrder(o, sig, { value: AMOUNT }))
        .to.emit(pay, 'PaymentSettled')
        .withArgs(merchant.address, o.orderId, payer.address, ethers.ZeroAddress, AMOUNT, fee, net, 1n, anyValue);

      const merchantBefore = await ethers.provider.getBalance(merchant.address);
      const feeBefore = await ethers.provider.getBalance(feeRecipient.address);
      const o2 = order({
        merchant: merchant.address,
        orderId: oid('native-2'),
        feeRecipient: feeRecipient.address,
      });
      await pay.connect(payer).paySignedOrder(o2, await signedFor(pay, signer, o2), { value: AMOUNT });
      expect(await ethers.provider.getBalance(merchant.address)).to.equal(merchantBefore + net);
      expect(await ethers.provider.getBalance(feeRecipient.address)).to.equal(feeBefore + fee);
    });

    it('rejects underpayment and overpayment', async function () {
      const { pay, merchant, payer, feeRecipient, signer } = await loadFixture(deployFixture);
      const o = order({ merchant: merchant.address, feeRecipient: feeRecipient.address });
      const sig = await signedFor(pay, signer, o);
      await expect(pay.connect(payer).paySignedOrder(o, sig, { value: AMOUNT - 1n })).to.be.revertedWithCustomError(
        pay,
        'IncorrectNativeValue',
      );
      await expect(pay.connect(payer).paySignedOrder(o, sig, { value: AMOUNT + 1n })).to.be.revertedWithCustomError(
        pay,
        'IncorrectNativeValue',
      );
    });

    it('rejects a zero-value send', async function () {
      const { pay, merchant, payer, feeRecipient, signer } = await loadFixture(deployFixture);
      const o = order({ merchant: merchant.address, feeRecipient: feeRecipient.address });
      const sig = await signedFor(pay, signer, o);
      await expect(pay.connect(payer).paySignedOrder(o, sig)).to.be.revertedWithCustomError(pay, 'IncorrectNativeValue');
    });
  });

  describe('domain binding', function () {
    it('rejects a signature minted for a different deployment (verifyingContract)', async function () {
      const { pay, merchant, payer, feeRecipient, signer, token } = await loadFixture(deployFixture);
      // A second, independent router — same chain, same domain name, different address.
      const otherPay = await deployProxy([feeRecipient.address, FEE_BPS, (await ethers.getSigners())[0].address]);
      await otherPay.initializeSigning(DOMAIN_NAME, DOMAIN_VERSION);
      await otherPay.setSigner(signer.address, true);

      const o = order({
        merchant: merchant.address,
        token: await token.getAddress(),
        feeRecipient: feeRecipient.address,
      });
      // Signature is valid for otherPay — it must not work here.
      const sig = await signedFor(otherPay, signer, o);
      await token.connect(payer).approve(await pay.getAddress(), AMOUNT);
      await expect(pay.connect(payer).paySignedOrder(o, sig)).to.be.revertedWithCustomError(pay, 'InvalidSignature');
    });

    it('rejects a signature minted for a different chain id', async function () {
      const { pay, merchant, payer, feeRecipient, signer, token } = await loadFixture(deployFixture);
      const o = order({
        merchant: merchant.address,
        token: await token.getAddress(),
        feeRecipient: feeRecipient.address,
      });
      const sig = await signedFor(pay, signer, o, { chainId: 999999 });
      await token.connect(payer).approve(await pay.getAddress(), AMOUNT);
      await expect(pay.connect(payer).paySignedOrder(o, sig)).to.be.revertedWithCustomError(pay, 'InvalidSignature');
    });

    it('rejects a signature made under a different domain name', async function () {
      const { pay, merchant, payer, feeRecipient, signer, token } = await loadFixture(deployFixture);
      const o = order({
        merchant: merchant.address,
        token: await token.getAddress(),
        feeRecipient: feeRecipient.address,
      });
      const sig = await signer.signTypedData(
        {
          name: 'SomeOtherProtocol',
          version: DOMAIN_VERSION,
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await pay.getAddress(),
        },
        SIGNED_ORDER_TYPES,
        o,
      );
      await token.connect(payer).approve(await pay.getAddress(), AMOUNT);
      await expect(pay.connect(payer).paySignedOrder(o, sig)).to.be.revertedWithCustomError(pay, 'InvalidSignature');
    });
  });

  describe('kill switch', function () {
    it('stops accepting authorizations once the signer is removed, leaving settled orders intact', async function () {
      const { pay, owner, merchant, payer, feeRecipient, signer, token } = await loadFixture(deployFixture);
      const o = order({
        merchant: merchant.address,
        token: await token.getAddress(),
        feeRecipient: feeRecipient.address,
      });
      const sig = await signedFor(pay, signer, o);
      await token.connect(payer).approve(await pay.getAddress(), AMOUNT * 2n);
      await pay.connect(payer).paySignedOrder(o, sig);

      await pay.connect(owner).setSigner(signer.address, false);

      const o2 = order({
        merchant: merchant.address,
        orderId: oid('signed-2'),
        token: await token.getAddress(),
        feeRecipient: feeRecipient.address,
      });
      const sig2 = await signedFor(pay, signer, o2);
      await expect(pay.connect(payer).paySignedOrder(o2, sig2)).to.be.revertedWithCustomError(
        pay,
        'InvalidSignature',
      );

      // The already-settled order is untouched and still queryable.
      expect((await pay.getOrder(merchant.address, o.orderId)).settled).to.equal(true);
    });
  });

  describe('coexistence with legacy registration', function () {
    it('leaves pre-registered orders fully payable', async function () {
      const { pay, merchant, payer, token } = await loadFixture(deployFixture);
      await pay.connect(merchant).registerOrder(oid('legacy'), await token.getAddress(), AMOUNT, 0);
      await token.connect(payer).approve(await pay.getAddress(), AMOUNT);
      await expect(pay.connect(payer).payOrder(merchant.address, oid('legacy'))).to.not.be.reverted;
    });

    it('honours the pause breaker on the signed path', async function () {
      const { pay, owner, merchant, payer, feeRecipient, signer, token } = await loadFixture(deployFixture);
      const o = order({
        merchant: merchant.address,
        token: await token.getAddress(),
        feeRecipient: feeRecipient.address,
      });
      const sig = await signedFor(pay, signer, o);
      await token.connect(payer).approve(await pay.getAddress(), AMOUNT);
      await pay.connect(owner).pause();
      await expect(pay.connect(payer).paySignedOrder(o, sig)).to.be.revertedWithCustomError(pay, 'EnforcedPause');
    });
  });
});
