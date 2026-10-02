// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title  PayWithQuai
/// @notice Non-custodial merchant payment router for the "Pay with Quai" checkout system.
///         Orders are created and settled by the customer in a single transaction: either a
///         pre-registered order via `payOrder`, or an off-chain EIP-712 authorization from a
///         trusted signer consumed by `paySignedOrder`. Funds
///         are forwarded immediately, and orders are marked settled to block double-fulfillment.
/// @dev    UUPS implementation behind an ERC-1967 proxy. State lives in an ERC-7201 namespaced
///         struct (`_s()`); it is append-only across upgrades — never remove or reorder fields.
///         Quai is sharded: payout wallets must be in the same zone as this deployment.
contract PayWithQuai is
    Initializable,
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    EIP712Upgradeable
{
    using SafeERC20 for IERC20;

    /// @notice Sentinel token value: the order is payable in native QUAI.
    address public constant NATIVE = address(0);

    /// @notice Maximum platform fee in basis points (500 = 5%).
    uint96 public constant MAX_FEE_BPS = 500;

    /// @notice Delay before a settled order may be purged, giving the relayer time to index it.
    uint256 public constant PURGE_DELAY = 1 days;

    /// @dev Basis-points denominator (100% = 10_000 bps).
    uint256 private constant BPS_DENOMINATOR = 10_000;

    // merchant(160) + settled(8) + exists(8) + feeBps(16) = 192 bits, packed in one slot.
    // expectedPayer(160) + nonce(64) appended AFTER the packed fields — append-only storage rule:
    // never remove or reorder struct fields; reading old records yields expectedPayer=0 (anyone)
    // and nonce=0.
    struct Order {
        address merchant;     // payout wallet (also the registrar)
        bool settled;         // set on payment — blocks double-fulfillment
        bool exists;          // distinguishes a registered order from an empty slot
        uint16 feeBps;        // fee locked in at registration time
        address token;        // ERC-20 address, or NATIVE for native QUAI
        uint256 amount;       // exact expected amount, in the token's smallest unit
        uint256 expiry;       // unix time after which the order can't be paid; 0 = never
        address feeRecipient; // fee destination, locked in at registration time
        uint256 settledAt;    // unix time the order was paid; 0 while unpaid
        address expectedPayer; // address(0) = anyone may pay; otherwise only this payer (anti-griefing)
        uint64 nonce;         // per-merchant counter; distinguishes order-id reuse after purge
    }

    /// @dev An order that does not exist on-chain yet. Produced off-chain by a trusted signer and
    /// consumed by `paySignedOrder`, which creates and settles it in the customer's one
    /// transaction — so the merchant never has to pre-register (and pay gas for) order slots.
    /// Every field is committed by the signature: the payer cannot lower `amount`, retarget
    /// `merchant`/`feeRecipient`, extend `expiry`, or drop `expectedPayer`.
    struct SignedOrder {
        address merchant;     // payout wallet; funds are forwarded here on settlement
        bytes32 orderId;      // caller-chosen ledger id; unique per merchant while the order exists
        address token;        // ERC-20 address, or NATIVE for native QUAI
        uint256 amount;       // exact amount the payer owes, in the token's smallest unit
        uint256 expiry;       // unix time after which the authorization is void; 0 = never
        uint16 feeBps;        // fee locked in by the signer
        address feeRecipient; // fee destination, locked in by the signer
        address expectedPayer; // address(0) = anyone may pay; otherwise only this payer
    }

    /// @dev keccak256("SignedOrder(address merchant,bytes32 orderId,address token,uint256 amount,"
    ///      "uint256 expiry,uint16 feeBps,address feeRecipient,address expectedPayer)")
    bytes32 private constant SIGNED_ORDER_TYPEHASH =
        0xfbae4a679a7032b61a424ab9ef7f70c17a0d5113f9096d8c5cc5538fbfc55007;

    /// @custom:storage-location erc7201:paywithquai.main
    /// @dev All mutable state. Append-only across upgrades — never remove/reorder.
    struct MainStorage {
        mapping(bytes32 => Order) orders;       // keyed by orderKey(merchant, orderId)
        mapping(address => bool) acceptedToken; // tokens orders may be priced in
        address feeRecipient;                   // receives the platform fee
        uint96 feeBps;                          // current platform fee in bps
        mapping(address => uint64) orderNonces; // per-merchant order nonce counter
        address pauseGuardian;                  // may call pause() but never unpause()
        mapping(address => bool) relayers;      // e-commerce gateway agents (gasless registration)
    }

    // keccak256(abi.encode(uint256(keccak256("paywithquai.main")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant MAIN_STORAGE_LOCATION =
        0xddd96c3fdec0155659045c0e1367ee9451de8b2ed82190eab0e0e4385193f400;

    function _s() private pure returns (MainStorage storage $) {
        assembly {
            $.slot := MAIN_STORAGE_LOCATION
        }
    }

    /// @custom:storage-location erc7201:paywithquai.signing
    /// @dev New state introduced by the signed-order module, kept in its own ERC-7201 namespace so
    ///      an upgrade can never disturb `paywithquai.main` (same pattern the V2 mock documents).
    ///      The EIP-712 domain name/version live in OpenZeppelin's own namespace, separate again.
    struct SigningStorage {
        mapping(address => bool) signers; // may sign SignedOrder authorizations
    }

    // keccak256(abi.encode(uint256(keccak256("paywithquai.signing")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant SIGNING_STORAGE_LOCATION =
        0x910c421bf8c63fedb18cf38a71064519126b56849967a918fadef62aa76ee200;

    function _sig() private pure returns (SigningStorage storage $) {
        assembly {
            $.slot := SIGNING_STORAGE_LOCATION
        }
    }

    event OrderRegistered(
        address indexed merchant,
        bytes32 indexed orderId,
        address token,
        uint256 amount,
        uint256 expiry,
        uint16 feeBps,
        address feeRecipient
    );

    event OrderCancelled(address indexed merchant, bytes32 indexed orderId);

    /// @notice Emitted when a settled order is purged after the safety window; the id is reusable.
    event OrderPurged(address indexed merchant, bytes32 indexed orderId);

    /// @notice Emitted on successful settlement. `token` is address(0) for native QUAI;
    ///         `amount` is the gross figure the payer sent. Kept for backwards compatibility.
    event PaymentReceived(
        address indexed merchant,
        bytes32 indexed orderId,
        address payer,
        address token,
        uint256 amount,
        uint256 timestamp
    );

    /// @notice Rich settlement event emitted alongside PaymentReceived: carries the exact fee and
    ///         net split and the order nonce, so off-chain indexers never have to re-derive the
    ///         fee from registration state, and can tell apart order-id reuse after a purge.
    event PaymentSettled(
        address indexed merchant,
        bytes32 indexed orderId,
        address payer,
        address token,
        uint256 amount,
        uint256 fee,
        uint256 net,
        uint64 nonce,
        uint256 timestamp
    );

    /// @notice Emitted alongside PaymentReceived when a non-zero fee was withheld.
    event FeePaid(bytes32 indexed orderId, address token, uint256 fee, address feeRecipient);

    event FeeConfigUpdated(uint96 feeBps, address feeRecipient);
    event AcceptedTokenUpdated(address indexed token, bool accepted);
    event PauseGuardianUpdated(address indexed guardian);
    event RelayerUpdated(address indexed relayer, bool enabled);
    event SignerUpdated(address indexed signer, bool enabled);

    /// @notice Emitted when the owner sweeps stray funds from the contract.
    event TokensRescued(address indexed token, address indexed to, uint256 amount);

    error OrderAlreadyExists();
    error OrderNotFound();
    error OrderAlreadySettled();
    error OrderNotSettled();
    error OrderExpired();
    error WrongPayer();
    error PurgeDelayNotElapsed();
    error InvalidExpiry();
    error ZeroAmount();
    error TokenNotAccepted();
    error WrongPaymentPath();
    error IncorrectNativeValue();
    error FeeTooHigh();
    error ZeroFeeRecipient();
    error ZeroAddress();
    error NativeTransferFailed();
    error ReceiveRejected();
    error NotRelayer();
    error InvalidSignature();
    error SigningNotInitialized();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @param feeRecipient_ address to receive platform fees (must be non-zero)
    /// @param feeBps_       initial platform fee in basis points (must be <= MAX_FEE_BPS)
    /// @param owner_        initial owner
    function initialize(address feeRecipient_, uint96 feeBps_, address owner_) external initializer {
        __Ownable_init(owner_);
        __Ownable2Step_init();
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();
        _setFeeConfig(feeBps_, feeRecipient_);
    }

    // --------------------------------------------------------------------- //
    //                               Views                                   //
    // --------------------------------------------------------------------- //

    /// @notice Address that receives the platform fee.
    function feeRecipient() external view returns (address) {
        return _s().feeRecipient;
    }

    /// @notice Platform fee in basis points (1 bps = 0.01%).
    function feeBps() external view returns (uint96) {
        return _s().feeBps;
    }

    /// @notice Deterministic storage key binding an order id to its merchant.
    function orderKey(address merchant, bytes32 orderId) public pure returns (bytes32) {
        return keccak256(abi.encode(merchant, orderId));
    }

    /// @notice Returns the full order record for (merchant, orderId).
    function getOrder(address merchant, bytes32 orderId) external view returns (Order memory) {
        return _s().orders[orderKey(merchant, orderId)];
    }

    /// @notice True once an order has been paid.
    function isSettled(address merchant, bytes32 orderId) external view returns (bool) {
        return _s().orders[orderKey(merchant, orderId)].settled;
    }

    /// @notice True if orders may be priced in `token` (address(0) = native QUAI).
    function isTokenAccepted(address token) external view returns (bool) {
        return _s().acceptedToken[token];
    }

    // --------------------------------------------------------------------- //
    //                      Merchant: order lifecycle                        //
    // --------------------------------------------------------------------- //

    /// @notice Merchant pre-registers an order it expects a customer to pay. Any address may pay
    ///         the order — use registerOrderWithPayer to bind it to one specific payer.
    /// @dev    `msg.sender` is recorded as merchant and payout wallet, making the
    ///         (merchant, orderId) key unforgeable by third parties.
    /// @param orderId unique id generated by the merchant backend
    /// @param token   ERC-20 token, or NATIVE for native QUAI; must be accepted
    /// @param amount  exact amount owed, in the token's smallest unit
    /// @param expiry  unix time after which the order can't be paid; 0 = never
    function registerOrder(
        bytes32 orderId,
        address token,
        uint256 amount,
        uint256 expiry
    ) external {
        _registerOrder(orderId, token, amount, expiry, address(0));
    }

    /// @notice Merchant pre-registers multiple orders in a single transaction — all share the same
    ///         token, amount, and expiry. Use this to pre-fund a multi-pay link pool without
    ///         requiring a separate wallet approval for every slot.
    /// @dev    Capped at 50 orderIds to stay well within Quai's block gas limit. Each orderId is
    ///         processed by the same `_registerOrder` as the single-order path, so fee locking,
    ///         duplicate checks, and expiry validation all apply per-order. Reverts if any single
    ///         orderId is already registered (atomically: all-or-nothing per call).
    /// @param orderIds  Array of unique bytes32 order identifiers (max 50).
    /// @param token     ERC-20 token address, or address(0) for native QUAI.
    /// @param amount    Exact amount owed, in the token's smallest unit.
    /// @param expiry    Unix timestamp after which the order cannot be paid; 0 = no expiry.
    function registerOrderBatch(
        bytes32[] calldata orderIds,
        address token,
        uint256 amount,
        uint256 expiry
    ) external {
        require(orderIds.length > 0, "empty batch");
        require(orderIds.length <= 50, "batch too large (max 50)");
        for (uint256 i = 0; i < orderIds.length; i++) {
            _registerOrder(orderIds[i], token, amount, expiry, address(0));
        }
    }

    /// @notice Merchant pre-registers an order payable only by `expectedPayer`.
    /// @dev    Binds the order to one payer (anti-griefing: a third party can no longer settle
    ///         the order first and steal the merchant's sale). `expectedPayer = address(0)` means
    ///         anyone may pay — the same as registerOrder.
    function registerOrderWithPayer(
        bytes32 orderId,
        address token,
        uint256 amount,
        uint256 expiry,
        address expectedPayer
    ) external {
        _registerOrder(orderId, token, amount, expiry, expectedPayer);
    }

    /// @notice Trusted relayer registers an order on a merchant's behalf — the gasless gateway
    ///         flow. Shop checkouts are quoted and prepaid with gas by the platform relayer, so an
    ///         e-commerce merchant never needs QUAI in their payout wallet just to register orders.
    /// @dev    Only addresses in the relayer set (owner-managed) may call this. The
    ///         (merchant, orderId) key stays unforgeable: settlements still forward to `merchant`,
    ///         and a relayer can neither pay out nor settle any order.
    /// @param merchant payout wallet the order belongs to (must be non-zero)
    /// @param orderId  unique id generated by the merchant backend
    /// @param token    ERC-20 token, or NATIVE for native QUAI; must be accepted
    /// @param amount   exact amount owed, in the token's smallest unit
    /// @param expiry   unix time after which the order can't be paid; 0 = never
    function registerOrderFor(
        address merchant,
        bytes32 orderId,
        address token,
        uint256 amount,
        uint256 expiry
    ) external whenNotPaused {
        if (!_s().relayers[msg.sender]) revert NotRelayer();
        if (merchant == address(0)) revert ZeroAddress();
        _registerOrderFor(merchant, orderId, token, amount, expiry, address(0));
    }

    function _registerOrder(
        bytes32 orderId,
        address token,
        uint256 amount,
        uint256 expiry,
        address expectedPayer
    ) private whenNotPaused {
        _registerOrderFor(msg.sender, orderId, token, amount, expiry, expectedPayer);
    }

    /// @dev Shared registration core: merchant- or relayer-authoritative, depending on the caller.
    function _registerOrderFor(
        address merchant,
        bytes32 orderId,
        address token,
        uint256 amount,
        uint256 expiry,
        address expectedPayer
    ) private {
        if (amount == 0) revert ZeroAmount();
        MainStorage storage $ = _s();
        if (!$.acceptedToken[token]) revert TokenNotAccepted();
        if (expiry != 0 && expiry <= block.timestamp) revert InvalidExpiry();

        bytes32 key = orderKey(merchant, orderId);
        if ($.orders[key].exists) revert OrderAlreadyExists();

        // Lock fee rate and recipient at registration. feeBps is always <= MAX_FEE_BPS (500),
        // so the uint96 -> uint16 narrowing cannot truncate; a later setFeeConfig can't
        // retroactively change this order.
        uint16 lockedFeeBps = uint16($.feeBps);
        address lockedFeeRecipient = $.feeRecipient; // guaranteed non-zero by _setFeeConfig
        uint64 nonce = ++$.orderNonces[merchant];

        $.orders[key] = Order({
            merchant: merchant,
            settled: false,
            exists: true,
            feeBps: lockedFeeBps,
            token: token,
            amount: amount,
            expiry: expiry,
            feeRecipient: lockedFeeRecipient,
            settledAt: 0,
            expectedPayer: expectedPayer,
            nonce: nonce
        });
        emit OrderRegistered(merchant, orderId, token, amount, expiry, lockedFeeBps, lockedFeeRecipient);
    }

    /// @notice Merchant cancels its own unpaid order, freeing the order id for reuse.
    /// @dev    Allowed while paused so merchants can always clean up reservations.
    function cancelOrder(bytes32 orderId) external {
        bytes32 key = orderKey(msg.sender, orderId);
        Order storage o = _s().orders[key];
        if (!o.exists) revert OrderNotFound();
        if (o.settled) revert OrderAlreadySettled();
        delete _s().orders[key];
        emit OrderCancelled(msg.sender, orderId);
    }

    /// @notice Merchant frees the storage of a paid order after PURGE_DELAY; the id is reusable.
    function purgeSettledOrder(bytes32 orderId) external {
        bytes32 key = orderKey(msg.sender, orderId);
        Order storage o = _s().orders[key];
        if (!o.exists) revert OrderNotFound();
        if (!o.settled) revert OrderNotSettled();
        if (block.timestamp < o.settledAt + PURGE_DELAY) revert PurgeDelayNotElapsed();
        delete _s().orders[key];
        emit OrderPurged(msg.sender, orderId);
    }

    // --------------------------------------------------------------------- //
    //                    Signed orders (customer-paid gas)                  //
    // --------------------------------------------------------------------- //

    /// @notice Initialize the EIP-712 domain used by `paySignedOrder`.
    /// @dev    Runs once, after the v1 `initialize`. Owner-only, so an arbitrary caller can never
    ///         set the domain on a fresh deployment and front-run the legitimate upgrade.
    ///         Uses reinitializer(3): version 2 is reserved for the V2 upgrade-safety mock, and
    ///         neither version has been consumed on any live deployment.
    function initializeSigning(string calldata name, string calldata version) public reinitializer(3) onlyOwner {
        __EIP712_init(name, version);
    }

    /// @notice Whether the EIP-712 domain has been initialized (i.e. `paySignedOrder` is usable).
    /// @dev    Deployment tooling needs this to stay idempotent: `initializeSigning` is a
    ///         reinitializer and can only ever run once, so an upgrade script must skip it (and
    ///         upgrade with empty calldata) on a deployment where it has already been consumed.
    function signingInitialized() external view returns (bool) {
        return bytes(_EIP712Name()).length != 0;
    }

    /// @notice Whether `signer` may sign SignedOrder authorizations.
    function isSigner(address signer) external view returns (bool) {
        return _sig().signers[signer];
    }

    /// @notice EIP-712 struct hash of a SignedOrder.
    /// @dev    Exposed so signers and tests can reproduce the digest the contract will recover
    ///         without duplicating the ABI encoding.
    function signedOrderHash(SignedOrder calldata o) external pure returns (bytes32) {
        return _signedOrderHash(o);
    }

    /// @notice Full EIP-712 digest a customer wallet must sign for `o` on this chain.
    function signedOrderDigest(SignedOrder calldata o) external view returns (bytes32) {
        return _hashTypedDataV4(_signedOrderHash(o));
    }

    /// @notice Add (enabled=true) or remove (enabled=false) a trusted order signer. Owner only.
    /// @dev    Removing a signer is the kill switch for `paySignedOrder` — it cannot affect orders
    ///         already settled through the signed path, nor the legacy `registerOrder*` paths.
    function setSigner(address signer, bool enabled) external onlyOwner {
        if (signer == address(0)) revert ZeroAddress();
        _sig().signers[signer] = enabled;
        emit SignerUpdated(signer, enabled);
    }

    /// @notice Create and settle an order in one transaction from an off-chain signed authorization.
    /// @dev    The caller supplies no pricing of their own: every commercial term is covered by the
    ///         signature, so the only value the payer chooses is which wallet they send from. Gas is
    ///         paid by the caller, so merchants never pre-register (and pay gas for) order slots.
    ///
    ///         `expectedPayer` committed in the signature is the anti-griefing anchor: a third party
    ///         who sees the authorization in the mempool cannot settle it, so they cannot burn a
    ///         customer's checkout. The domain separator binds chainId and this contract, so an
    ///         authorization for one deployment can never be replayed against another.
    ///
    ///         Native orders require `msg.value == amount`; ERC-20 orders require a prior `approve`.
    function paySignedOrder(SignedOrder calldata o, bytes calldata signature)
        external
        payable
        nonReentrant
        whenNotPaused
    {
        _recoverSigner(o, signature);

        MainStorage storage $ = _s();
        if (!$.acceptedToken[o.token]) revert TokenNotAccepted();
        if (o.amount == 0) revert ZeroAmount();
        if (o.expiry != 0 && o.expiry <= block.timestamp) revert InvalidExpiry();
        if (o.feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        if (o.feeRecipient == address(0)) revert ZeroFeeRecipient();

        bytes32 key = orderKey(o.merchant, o.orderId);
        if ($.orders[key].exists) revert OrderAlreadyExists();
        if (o.expectedPayer != address(0) && o.expectedPayer != msg.sender) revert WrongPayer();

        uint256 amount = o.amount;
        address token = o.token;
        if (token == NATIVE && msg.value != amount) revert IncorrectNativeValue();
        if (token != NATIVE && msg.value != 0) revert IncorrectNativeValue();

        // Effects before interactions: the order exists and is settled before any value moves.
        uint64 nonce = ++$.orderNonces[o.merchant];
        $.orders[key] = Order({
            merchant: o.merchant,
            settled: true,
            exists: true,
            feeBps: o.feeBps,
            token: token,
            amount: amount,
            expiry: o.expiry,
            feeRecipient: o.feeRecipient,
            settledAt: block.timestamp,
            expectedPayer: o.expectedPayer,
            nonce: nonce
        });
        emit OrderRegistered(
            o.merchant, o.orderId, token, amount, o.expiry, o.feeBps, o.feeRecipient
        );

        uint256 fee = (amount * o.feeBps) / BPS_DENOMINATOR;
        uint256 net = amount - fee;

        if (token == NATIVE) {
            if (fee > 0) {
                _sendNative(o.feeRecipient, fee);
                emit FeePaid(o.orderId, NATIVE, fee, o.feeRecipient);
            }
            _sendNative(o.merchant, net);
        } else {
            if (fee > 0) {
                IERC20(token).safeTransferFrom(msg.sender, o.feeRecipient, fee);
                emit FeePaid(o.orderId, token, fee, o.feeRecipient);
            }
            IERC20(token).safeTransferFrom(msg.sender, o.merchant, net);
        }

        emit PaymentReceived(o.merchant, o.orderId, msg.sender, token, amount, block.timestamp);
        emit PaymentSettled(
            o.merchant, o.orderId, msg.sender, token, amount, fee, net, nonce, block.timestamp
        );
    }

    /// @dev Recovers the authorizing signer and enforces that it is currently trusted.
    ///
    ///      Signers must be EOAs: an ERC-1271 contract wallet produces a signature that ecrecover
    ///      cannot attribute to any address, so there is no way to discover which allowlisted
    ///      contract produced it. Supporting multisig signers would require an enumerable registry
    ///      and a per-signer probe on every payment — not worth it for a single platform key.
    ///
    ///      Malformed signatures, wrong signers and tampered order fields all collapse into one
    ///      `InvalidSignature`. That is deliberate on two counts: ecrecover returns a well-formed
    ///      (r, s) pair for *any* digest, so a distinct "not a trusted signer" error would be an
    ///      oracle revealing which addresses may sign; and it is simply the accurate description —
    ///      an order whose fields were altered after signing has an invalid signature.
    function _recoverSigner(SignedOrder calldata o, bytes calldata signature) private view {
        if (bytes(_EIP712Name()).length == 0) revert SigningNotInitialized();
        bytes32 digest = _hashTypedDataV4(_signedOrderHash(o));
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || signer == address(0) || !_sig().signers[signer]) {
            revert InvalidSignature();
        }
    }

    /// @dev keccak256(abi.encode(SIGNED_ORDER_TYPEHASH, ...)). Field order and widths must stay in
    ///      lockstep with the struct declaration and the off-chain signer.
    function _signedOrderHash(SignedOrder calldata o) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                SIGNED_ORDER_TYPEHASH,
                o.merchant,
                o.orderId,
                o.token,
                o.amount,
                o.expiry,
                o.feeBps,
                o.feeRecipient,
                o.expectedPayer
            )
        );
    }

    // --------------------------------------------------------------------- //
    //                          Customer: payment                            //
    // --------------------------------------------------------------------- //

    /// @notice Settle an ERC-20 order. Caller must first approve this contract for `amount`.
    /// @dev    Checks -> effects (mark settled) -> interactions (pull & forward funds).
    function payOrder(address merchant, bytes32 orderId) external nonReentrant whenNotPaused {
        MainStorage storage $ = _s();
        Order storage o = $.orders[orderKey(merchant, orderId)];
        if (!o.exists) revert OrderNotFound();
        if (o.token == NATIVE) revert WrongPaymentPath();
        _requireOpenOrder(o);
        if (o.expectedPayer != address(0) && o.expectedPayer != msg.sender) revert WrongPayer();

        o.settled = true; // effects before interactions
        o.settledAt = block.timestamp;

        uint256 amount = o.amount;
        address token = o.token;
        uint256 fee = (amount * o.feeBps) / BPS_DENOMINATOR;
        uint256 net = amount - fee;

        if (fee > 0) {
            IERC20(token).safeTransferFrom(msg.sender, o.feeRecipient, fee);
            emit FeePaid(orderId, token, fee, o.feeRecipient);
        }
        IERC20(token).safeTransferFrom(msg.sender, o.merchant, net);

        emit PaymentReceived(o.merchant, orderId, msg.sender, token, amount, block.timestamp);
        emit PaymentSettled(o.merchant, orderId, msg.sender, token, amount, fee, net, o.nonce, block.timestamp);
    }

    /// @notice Settle a native-QUAI order. `msg.value` must equal the registered amount exactly.
    function payOrderNative(address merchant, bytes32 orderId) external payable nonReentrant whenNotPaused {
        MainStorage storage $ = _s();
        Order storage o = $.orders[orderKey(merchant, orderId)];
        if (!o.exists) revert OrderNotFound();
        if (o.token != NATIVE) revert WrongPaymentPath();
        _requireOpenOrder(o);
        if (o.expectedPayer != address(0) && o.expectedPayer != msg.sender) revert WrongPayer();
        if (msg.value != o.amount) revert IncorrectNativeValue();

        o.settled = true; // effects before interactions
        o.settledAt = block.timestamp;

        uint256 amount = o.amount;
        uint256 fee = (amount * o.feeBps) / BPS_DENOMINATOR;
        uint256 net = amount - fee;

        if (fee > 0) {
            _sendNative(o.feeRecipient, fee);
            emit FeePaid(orderId, NATIVE, fee, o.feeRecipient);
        }
        _sendNative(o.merchant, net);

        emit PaymentReceived(o.merchant, orderId, msg.sender, NATIVE, amount, block.timestamp);
        emit PaymentSettled(o.merchant, orderId, msg.sender, NATIVE, amount, fee, net, o.nonce, block.timestamp);
    }

    /// @dev Requires the order to be unpaid and unexpired. Pure check, no state change.
    function _requireOpenOrder(Order storage o) private view {
        if (o.settled) revert OrderAlreadySettled();
        if (o.expiry != 0 && block.timestamp > o.expiry) revert OrderExpired();
    }

    function _sendNative(address to, uint256 value) private {
        (bool ok, ) = payable(to).call{value: value}("");
        if (!ok) revert NativeTransferFailed();
    }

    // --------------------------------------------------------------------- //
    //                               Admin                                   //
    // --------------------------------------------------------------------- //

    /// @notice Allow or disallow pricing orders in `token` (address(0) = native QUAI).
    /// @dev    Only allowlist standard, well-behaved ERC-20s: fee-on-transfer or rebasing tokens
    ///         would under-deliver to the merchant. Disabling a token blocks new registrations
    ///         only — existing orders remain payable; use `pause()` to halt settlement.
    function setTokenAccepted(address token, bool accepted) external onlyOwner {
        _s().acceptedToken[token] = accepted;
        emit AcceptedTokenUpdated(token, accepted);
    }

    /// @notice Update the platform fee and recipient. Fee is capped at MAX_FEE_BPS.
    /// @dev    Only affects orders registered after this call. `feeRecipient_` must accept
    ///         native QUAI without reverting, or it would block every native payment.
    function setFeeConfig(uint96 feeBps_, address feeRecipient_) external onlyOwner {
        _setFeeConfig(feeBps_, feeRecipient_);
    }

    /// @notice Sweep funds that reached the contract outside the payment flow.
    /// @dev    `token == NATIVE` (address(0)) sweeps native QUAI; otherwise the ERC-20.
    function rescueTokens(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (token == NATIVE) {
            _sendNative(to, amount);
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
        emit TokensRescued(token, to, amount);
    }

    /// @notice Assign (or clear, with address(0)) the pause guardian — an independent actor that
    ///         can halt payments in an emergency but can never unpause or change any other state.
    /// @dev    A single lost/compromised owner key must not be the only way to stop the router.
    function setPauseGuardian(address guardian) external onlyOwner {
        _s().pauseGuardian = guardian;
        emit PauseGuardianUpdated(guardian);
    }

    /// @notice Add (enabled=true) or remove (enabled=false) a trusted relayer — the address(es)
    ///         allowed to call `registerOrderFor` (the e-commerce gateway). Owner only.
    function setRelayer(address relayer, bool enabled) external onlyOwner {
        if (relayer == address(0)) revert ZeroAddress();
        _s().relayers[relayer] = enabled;
        emit RelayerUpdated(relayer, enabled);
    }

    /// @notice Pause new registrations and payments (circuit breaker). Owner or pause guardian.
    function pause() external {
        if (msg.sender != owner() && msg.sender != _s().pauseGuardian) {
            revert OwnableUnauthorizedAccount(msg.sender);
        }
        _pause();
    }

    /// @notice Resume after a pause. Owner only — the guardian can halt but never restart.
    function unpause() external onlyOwner {
        _unpause();
    }

    function _setFeeConfig(uint96 feeBps_, address feeRecipient_) private {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        if (feeRecipient_ == address(0)) revert ZeroFeeRecipient();
        MainStorage storage $ = _s();
        $.feeBps = feeBps_;
        $.feeRecipient = feeRecipient_;
        emit FeeConfigUpdated(feeBps_, feeRecipient_);
    }

    /// @dev UUPS upgrade authorization, owner-only.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    /// @dev Reject stray native transfers — payments must go through payOrderNative.
    receive() external payable {
        revert ReceiveRejected();
    }
}