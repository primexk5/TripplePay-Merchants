// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {PayWithQuai} from "../PayWithQuai.sol";

/// @title  PayWithQuaiV2Mock
/// @notice TEST-ONLY upgrade target. Proves a UUPS upgrade preserves all existing storage
///         (orders, fee config, accepted tokens, ownership) while adding new behaviour and new
///         state. It appends a field to a NEW ERC-7201 namespace — never touching `paywithquai.main`
///         — which is the pattern real future modules should follow.
contract PayWithQuaiV2Mock is PayWithQuai {
    /// @custom:storage-location erc7201:paywithquai.v2mock
    struct V2Storage {
        string note;
    }

    // keccak256(abi.encode(uint256(keccak256("paywithquai.v2mock")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant V2_STORAGE_LOCATION =
        0x9b22f611f1a9667f836fc27cbaa541aefd075266954c76cb1bb2e17c3f729a00;

    function _v2() private pure returns (V2Storage storage $) {
        assembly {
            $.slot := V2_STORAGE_LOCATION
        }
    }

    /// @notice New view added by the upgrade — its presence proves the new logic is live.
    function version() external pure returns (string memory) {
        return "v2";
    }

    /// @notice Re-initializer for state introduced by V2. `reinitializer(2)` runs at most once,
    ///         and only after the v1 `initialize` (version 1) has already run. Owner-only, so an
    ///         arbitrary caller can never trigger V2 initialization on a fresh deployment and
    ///         front-run the legit upgrade.
    function initializeV2(string calldata note_) external reinitializer(2) onlyOwner {
        _v2().note = note_;
    }

    function note() external view returns (string memory) {
        return _v2().note;
    }

    // --- signed-order module, mirroring what the real upgrade ships -----------------------

    /// @notice The real signed-order module initializes its EIP-712 domain at reinitializer(3).
    ///         Exposed here so the upgrade-safety tests can drive the exact same path, including
    ///         the guarantee that the domain cannot be initialized twice or by a non-owner.
    ///         No `reinitializer` modifier here: it is enforced by the inner `initializeSigning`,
    ///         and stacking two would make the inner call revert on the version bump.
    function initializeSigningV2(string calldata name, string calldata version) external onlyOwner {
        initializeSigning(name, version);
    }
}
