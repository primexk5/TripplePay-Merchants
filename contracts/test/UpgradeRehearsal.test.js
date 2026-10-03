const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { anyValue } = require('@nomicfoundation/hardhat-chai-matchers/withArgs');

// The real deployment tooling, not a copy of its logic: `upgrade.js` requires `./lib/signingUpgrade`
// for the two decisions that are easy to get wrong (is the domain live? does the upgrade need
// initializer calldata?), and this suite drives those functions against a proxy whose current
// implementation is the PRE-signed-era router.
const {
  IMPL_SLOT,
  SIGNING_DOMAIN_NAME,
  SIGNING_DOMAIN_VERSION,
  buildInitData,
  isTransportError,
  readSignerAllowlisted,
  readSigningInitialized,
} = require('../scripts/lib/signingUpgrade');

const oid = (s) => ethers.encodeBytes32String(s);
const usdq = (n) => ethers.parseUnits(String(n), 6);

const FEE_BPS = 50n;
const AMOUNT = usdq(25);

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

describe('upgrade rehearsal — live-shaped proxy → signed implementation', function () {
  /**
   * Stages the situation `scripts/upgrade.js` will actually meet in production: a proxy that has
   * been running the pre-signed router, holding real merchant state — a registered order, a
   * settled order, the fee config and the token allowlist — and no signing domain at all.
   */
  async function stageLiveProxy() {
    const [owner, merchant, payer, feeRecipient, stranger, platformSigner] =
      await ethers.getSigners();

    const token = await ethers.deployContract('MockStablecoin');
    await token.mint(payer.address, usdq(1000));
    await token.mint(stranger.address, usdq(1000));

    // The implementation that is actually live today: no signingInitialized/isSigner/initializeSigning.
    const Legacy = await ethers.getContractFactory('LegacyPayWithQuaiMock');
    const legacyImpl = await Legacy.deploy();
    const legacyInit = Legacy.interface.encodeFunctionData('initialize', [
      feeRecipient.address,
      FEE_BPS,
      owner.address,
    ]);
    const proxy = await ethers.deployContract('ERC1967Proxy', [
      await legacyImpl.getAddress(),
      legacyInit,
    ]);
    const legacy = Legacy.attach(await proxy.getAddress());

    await legacy.setTokenAccepted(await token.getAddress(), true);
    await legacy.setTokenAccepted(ethers.ZeroAddress, true);

    // Pre-existing merchant business that must survive the upgrade untouched.
    await legacy.connect(merchant).registerOrder(oid('pending-order'), await token.getAddress(), AMOUNT, 0);
    await legacy.connect(merchant).registerOrder(oid('settled-order'), await token.getAddress(), AMOUNT, 0);
    await legacy.markSettledForTest(merchant.address, oid('settled-order'));

    return {
      owner,
      merchant,
      payer,
      stranger,
      feeRecipient,
      platformSigner,
      token,
      proxy,
      legacy,
      proxyAddress: await proxy.getAddress(),
      legacyImplAddress: await legacyImpl.getAddress(),
    };
  }

  async function signOrder(signerWallet, pay, { merchant, orderId, token, amount, payer }) {
    const domain = {
      name: SIGNING_DOMAIN_NAME,
      version: SIGNING_DOMAIN_VERSION,
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await pay.getAddress(),
    };
    const order = {
      merchant,
      orderId,
      token,
      amount,
      expiry: 0n,
      feeBps: FEE_BPS,
      feeRecipient: await pay.feeRecipient(),
      expectedPayer: payer,
    };
    const signature = await signerWallet.signTypedData(domain, SIGNED_ORDER_TYPES, {
      ...order,
      amount: order.amount.toString(),
    });
    return { order, signature };
  }

  it('reads signingInitialized() off a proxy that has never had it, without throwing', async function () {
    const { legacy, proxyAddress } = await loadFixture(stageLiveProxy);

    // The literal failure mode this guards: the old implementation has no such function and no
    // fallback, so the call reverts. Treating that as an error aborted the upgrade that fixes it.
    // (It isn't even in the legacy ABI — `legacy.signingInitialized` is undefined — so this has to
    // go over the wire as a raw call to reproduce what the upgrade script does.)
    const selector = ethers.id('signingInitialized()').slice(0, 10);
    let reverted = false;
    try {
      await ethers.provider.call({ to: proxyAddress, data: selector });
    } catch {
      reverted = true; // "function selector was not recognized and there's no fallback function"
    }
    expect(reverted, 'pre-signed proxy must not answer signingInitialized()').to.equal(true);

    // The tooling's reader must translate that revert into "not initialized" — not an exception.
    expect(await readSigningInitialized(legacy)).to.equal(false);
    expect(await readSignerAllowlisted(legacy, proxyAddress)).to.equal(null);
  });

  it('still surfaces genuine transport failures instead of misreading them as "not initialized"', function () {
    // A node that is down says nothing about chain state, so it must not be swallowed as a
    // "no" — that would push the script into reinitializing an already-initialized proxy.
    expect(isTransportError(new Error('could not detect network (event="noNetwork", code=ENOTFOUND)'))).to.equal(true);
    expect(isTransportError(new Error('timeout'))).to.equal(true);
    expect(isTransportError(new Error('could not detect network (code=ENOTFOUND)'))).to.equal(true);
    // Reverts are answers, not transport problems.
    expect(isTransportError(new Error('missing revert data in call exception'))).to.equal(false);
    expect(isTransportError(new Error('function selector was not recognized'))).to.equal(false);
    expect(isTransportError(new Error('execution reverted'))).to.equal(false);
  });

  it('upgrades a live proxy, initializing signing in the same transaction', async function () {
    const { owner, merchant, payer, token, proxyAddress, legacy } = await loadFixture(stageLiveProxy);

    const alreadyInitialized = await readSigningInitialized(legacy);
    const Impl = await ethers.getContractFactory('PayWithQuai');
    const newImpl = await Impl.deploy();
    const initData = buildInitData(Impl.interface, alreadyInitialized);
    expect(initData).to.not.equal('0x');

    const pay = Impl.attach(proxyAddress);
    await pay.connect(owner).upgradeToAndCall(await newImpl.getAddress(), initData);

    // Domain is live immediately: there is no window where paySignedOrder exists but reverts.
    expect(await readSigningInitialized(pay)).to.equal(true);
    const domain = await pay.eip712Domain();
    expect(domain.name).to.equal(SIGNING_DOMAIN_NAME);
    expect(domain.version).to.equal(SIGNING_DOMAIN_VERSION);

    // The EIP-1967 slot points at the new code.
    const raw = await ethers.provider.getStorage(proxyAddress, IMPL_SLOT);
    expect('0x' + raw.slice(-40).toLowerCase()).to.equal((await newImpl.getAddress()).toLowerCase());
  });

  it('preserves live merchant state across the upgrade', async function () {
    const { owner, proxyAddress, token, merchant, payer } = await loadFixture(stageLiveProxy);
    const Impl = await ethers.getContractFactory('PayWithQuai');
    const pay = Impl.attach(proxyAddress);
    await pay.upgradeToAndCall(
      await (await Impl.deploy()).getAddress(),
      buildInitData(Impl.interface, await readSigningInitialized(await Impl.attach(proxyAddress))),
    );

    // Fee config, allowlist and ownership were written by the OLD implementation.
    expect(await pay.feeBps()).to.equal(FEE_BPS);
    expect(await pay.isTokenAccepted(await token.getAddress())).to.equal(true);
    expect(await pay.isTokenAccepted(ethers.ZeroAddress)).to.equal(true);
    expect(await pay.owner()).to.equal(owner.address);

    // The pending legacy order survived byte-for-byte...
    const pending = await pay.getOrder(merchant.address, oid('pending-order'));
    expect(pending.exists).to.equal(true);
    expect(pending.merchant.toLowerCase()).to.equal(merchant.address.toLowerCase());
    expect(pending.amount).to.equal(AMOUNT);
    expect(pending.feeBps).to.equal(Number(FEE_BPS));
    expect(pending.token.toLowerCase()).to.equal((await token.getAddress()).toLowerCase());
    expect(pending.settled).to.equal(false);

    // ...and the settled one is still settled, so it cannot be paid twice after the upgrade.
    expect((await pay.getOrder(merchant.address, oid('settled-order'))).settled).to.equal(true);
    expect(await pay.isSettled(merchant.address, oid('settled-order'))).to.equal(true);

    // A legacy pre-registered order is still payable through the legacy path, post-upgrade.
    await token.connect(payer).approve(proxyAddress, AMOUNT);
    await expect(pay.connect(payer).payOrder(merchant.address, oid('pending-order')))
      .to.emit(pay, 'PaymentReceived')
      .withArgs(
        merchant.address,
        oid('pending-order'),
        payer.address,
        await token.getAddress(),
        AMOUNT,
        anyValue,
      );
    expect(await pay.isSettled(merchant.address, oid('pending-order'))).to.equal(true);
  });

  it('is safe to re-run: the second pass upgrades with empty calldata', async function () {
    const { owner, proxyAddress } = await loadFixture(stageLiveProxy);
    const Impl = await ethers.getContractFactory('PayWithQuai');
    const pay = Impl.attach(proxyAddress);
    const firstImpl = await (await Impl.deploy()).getAddress();
    await pay.connect(owner).upgradeToAndCall(firstImpl, buildInitData(Impl.interface, false));
    expect(await readSigningInitialized(pay)).to.equal(true);

    // Second run: the reader now answers true, so the reinitializer must NOT be passed again —
    // `initializeSigning` is a reinitializer(3) and re-running it reverts the entire upgrade,
    // which would leave the proxy pinned to the old implementation.
    const secondInitData = buildInitData(Impl.interface, await readSigningInitialized(pay));
    expect(secondInitData).to.equal('0x');

    const secondImpl = await (await Impl.deploy()).getAddress();
    await expect(pay.connect(owner).upgradeToAndCall(secondImpl, secondInitData)).to.not.be.reverted;
    expect(await readSigningInitialized(pay)).to.equal(true);
    const raw = await ethers.provider.getStorage(proxyAddress, IMPL_SLOT);
    expect('0x' + raw.slice(-40).toLowerCase()).to.equal(secondImpl.toLowerCase());
  });

  it('refuses to let the reinitializer be consumed twice, so a wrong decision cannot hide', async function () {
    const { owner, proxyAddress } = await loadFixture(stageLiveProxy);
    const Impl = await ethers.getContractFactory('PayWithQuai');
    const pay = Impl.attach(proxyAddress);
    const implAddress = await (await Impl.deploy()).getAddress();
    await pay.connect(owner).upgradeToAndCall(implAddress, buildInitData(Impl.interface, false));

    // Proof the empty-calldata branch above is load-bearing, not defensive boilerplate.
    await expect(pay.connect(owner).upgradeToAndCall(implAddress, buildInitData(Impl.interface, false)))
      .to.be.reverted;
  });

  it('serves customer-paid orders immediately after the upgrade, with no signer yet', async function () {
    const { owner, merchant, payer, token, proxyAddress, platformSigner } =
      await loadFixture(stageLiveProxy);
    const Impl = await ethers.getContractFactory('PayWithQuai');
    const pay = Impl.attach(proxyAddress);
    await pay.connect(owner).upgradeToAndCall(
      await (await Impl.deploy()).getAddress(),
      buildInitData(Impl.interface, false),
    );
    await pay.connect(owner).setTokenAccepted(await token.getAddress(), true);

    const orderId = oid('customer-paid-1');
    const { order, signature } = await signOrder(platformSigner, pay, {
      merchant: merchant.address,
      orderId,
      token: await token.getAddress(),
      amount: AMOUNT,
      payer: payer.address,
    });

    // With no signer allowlisted, nothing is payable — the loud, correct failure the upgrade
    // script warns about, rather than a silent misconfiguration.
    await expect(pay.connect(payer).paySignedOrder(order, signature)).to.be.revertedWithCustomError(
      pay,
      'InvalidSignature',
    );

    await pay.connect(owner).setSigner(platformSigner.address, true);
    expect(await readSignerAllowlisted(pay, platformSigner.address)).to.equal(true);
    // And the re-run of the upgrade script is a no-op for the allowlist.
    expect(await readSignerAllowlisted(pay, platformSigner.address)).to.equal(true);

    await token.connect(payer).approve(proxyAddress, AMOUNT);
    await expect(pay.connect(payer).paySignedOrder(order, signature))
      .to.emit(pay, 'PaymentReceived')
      .withArgs(
        merchant.address,
        orderId,
        payer.address,
        await token.getAddress(),
        AMOUNT,
        anyValue,
      );
    expect(await pay.isSettled(merchant.address, orderId)).to.equal(true);
  });

  it('settles a signed NATIVE order created after the upgrade', async function () {
    const { owner, merchant, payer, proxyAddress, platformSigner } =
      await loadFixture(stageLiveProxy);
    const Impl = await ethers.getContractFactory('PayWithQuai');
    const pay = Impl.attach(proxyAddress);
    await pay.connect(owner).upgradeToAndCall(
      await (await Impl.deploy()).getAddress(),
      buildInitData(Impl.interface, false),
    );
    await pay.connect(owner).setTokenAccepted(ethers.ZeroAddress, true);
    await pay.connect(owner).setSigner(platformSigner.address, true);

    const orderId = oid('native-1');
    const amount = ethers.parseEther('1');
    const { order, signature } = await signOrder(platformSigner, pay, {
      merchant: merchant.address,
      orderId,
      token: ethers.ZeroAddress,
      amount,
      payer: payer.address,
    });
    const before = await ethers.provider.getBalance(merchant.address);
    await pay.connect(payer).paySignedOrder(order, signature, { value: amount });
    const after = await ethers.provider.getBalance(merchant.address);
    // 1 native minus the 50 bps platform fee.
    expect(after - before).to.equal(amount - (amount * FEE_BPS) / 10000n);
    expect(await pay.isSettled(merchant.address, orderId)).to.equal(true);
  });
});
