// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

/// @title  LegacyPayWithQuaiMock
/// @notice TEST-ONLY stand-in for the implementation that is actually live on-chain today: it is
///         the PRE-signed-era router, so it has no `signingInitialized()`, no `isSigner()` and no
///         `initializeSigning()` — and no fallback function either, which is what makes the
///         upgrade tooling's preflight read revert instead of answering.
///
///         This is not a hand-written stub pretending to be old: `MainStorage` and `Order` are
///         copied field-for-field from the pre-signed `PayWithQuai.sol`, so orders written here
///         land on exactly the storage slots the real implementation reads. That is what makes the
///         upgrade rehearsal meaningful — a genuine upgrade test, not a mock of one.
///
///         Only the surface needed to stage a live-looking deployment is implemented (register,
///         read, settle). Legacy orders registered against this mock must still be readable AND
///         payable after the proxy is upgraded to the real PayWithQuai.
contract LegacyPayWithQuaiMock is
    Initializable,
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable
{
    address public constant NATIVE = address(0);
    uint96 public constant MAX_FEE_BPS = 500;
    uint256 private constant BPS_DENOMINATOR = 10_000;

    struct Order {
        address merchant;
        bool settled;
        bool exists;
        uint16 feeBps;
        address token;
        uint256 amount;
        uint256 expiry;
        address feeRecipient;
        uint256 settledAt;
        address expectedPayer;
        uint64 nonce;
    }

    /// @custom:storage-location erc7201:paywithquai.main
    struct MainStorage {
        mapping(bytes32 => Order) orders;
        mapping(address => bool) acceptedToken;
        address feeRecipient;
        uint96 feeBps;
        mapping(address => uint64) orderNonces;
        address pauseGuardian;
        mapping(address => bool) relayers;
    }

    // keccak256(abi.encode(uint256(keccak256("paywithquai.main")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant MAIN_STORAGE_LOCATION =
        0xddd96c3fdec0155659045c0e1367ee9451de8b2ed82190eab0e0e4385193f400;

    function _s() private pure returns (MainStorage storage $) {
        assembly {
            $.slot := MAIN_STORAGE_LOCATION
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

    event PaymentReceived(
        address indexed merchant,
        bytes32 indexed orderId,
        address payer,
        address token,
        uint256 amount,
        uint256 timestamp
    );

    error OrderAlreadyExists();
    error OrderAlreadySettled();
    error ZeroAmount();
    error FeeTooHigh();
    error ZeroFeeRecipient();
    error ZeroAddress();
    error TokenNotAccepted();
    error OrderNotFound();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address feeRecipient_, uint96 feeBps_, address owner_) external initializer {
        __Ownable_init(owner_);
        __Ownable2Step_init();
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();
        _setFeeConfig(feeBps_, feeRecipient_);
    }

    function feeRecipient() external view returns (address) {
        return _s().feeRecipient;
    }

    function feeBps() external view returns (uint96) {
        return _s().feeBps;
    }

    function isTokenAccepted(address token) external view returns (bool) {
        return _s().acceptedToken[token];
    }

    function setTokenAccepted(address token, bool accepted) external onlyOwner {
        _s().acceptedToken[token] = accepted;
    }

    /// @dev MUST stay byte-identical to the real router's key derivation. The rehearsal writes
    ///      orders through this function and reads them back through the upgraded implementation,
    ///      so a divergence here shows up as "every pre-existing order vanished" — which is
    ///      exactly the class of upgrade bug this suite exists to catch.
    function orderKey(address merchant, bytes32 orderId) public pure returns (bytes32) {
        return keccak256(abi.encode(merchant, orderId));
    }

    function registerOrder(
        bytes32 orderId,
        address token,
        uint256 amount,
        uint256 expiry
    ) external returns (bool) {
        return _registerOrder(orderId, token, amount, expiry, address(0));
    }

    function registerOrderWithPayer(
        bytes32 orderId,
        address token,
        uint256 amount,
        uint256 expiry,
        address payer
    ) external returns (bool) {
        return _registerOrder(orderId, token, amount, expiry, payer);
    }

    function _registerOrder(
        bytes32 orderId,
        address token,
        uint256 amount,
        uint256 expiry,
        address expectedPayer
    ) private returns (bool) {
        if (amount == 0) revert ZeroAmount();
        MainStorage storage $ = _s();
        if (!$.acceptedToken[token]) revert TokenNotAccepted();
        bytes32 key = orderKey(msg.sender, orderId);
        if ($.orders[key].exists) revert OrderAlreadyExists();
        uint64 nonce = ++$.orderNonces[msg.sender];
        $.orders[key] = Order({
            merchant: msg.sender,
            settled: false,
            exists: true,
            feeBps: uint16($.feeBps),
            token: token,
            amount: amount,
            expiry: expiry,
            feeRecipient: $.feeRecipient,
            settledAt: 0,
            expectedPayer: expectedPayer,
            nonce: nonce
        });
        emit OrderRegistered(msg.sender, orderId, token, amount, expiry, uint16($.feeBps), $.feeRecipient);
        return true;
    }

    function getOrder(address merchant, bytes32 orderId) external view returns (Order memory) {
        return _s().orders[orderKey(merchant, orderId)];
    }

    function isSettled(address merchant, bytes32 orderId) external view returns (bool) {
        return _s().orders[orderKey(merchant, orderId)].settled;
    }

    /// @dev Marks an order settled WITHOUT moving funds. The rehearsal only needs the settled flag
    ///      to exist on-chain; the real ERC-20/native transfer paths are covered by the signed suite.
    function markSettledForTest(address merchant, bytes32 orderId) external onlyOwner {
        MainStorage storage $ = _s();
        Order storage o = $.orders[orderKey(merchant, orderId)];
        if (!o.exists) revert OrderNotFound();
        if (o.settled) revert OrderAlreadySettled();
        o.settled = true;
        o.settledAt = block.timestamp;
        emit PaymentReceived(merchant, orderId, msg.sender, o.token, o.amount, block.timestamp);
    }

    function _setFeeConfig(uint96 feeBps_, address feeRecipient_) private {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        if (feeRecipient_ == address(0)) revert ZeroFeeRecipient();
        MainStorage storage $ = _s();
        $.feeBps = feeBps_;
        $.feeRecipient = feeRecipient_;
    }

    function _authorizeUpgrade(address) internal override {}
}
