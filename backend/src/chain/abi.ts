/**
 * Minimal ABI for the parts of PayWithQuai the relayer touches. Kept local (not imported from the
 * contracts package) so the backend has no build-time dependency on the Hardhat artifacts.
 * Must stay in sync with contracts/contracts/PayWithQuai.sol.
 */
export const PAYWITHQUAI_ABI = [
  'event PaymentReceived(address indexed merchant, bytes32 indexed orderId, address payer, address token, uint256 amount, uint256 timestamp)',
  'event PaymentSettled(address indexed merchant, bytes32 indexed orderId, address payer, address token, uint256 amount, uint256 fee, uint256 net, uint64 nonce, uint256 timestamp)',
  'function isSettled(address merchant, bytes32 orderId) view returns (bool)',
  'function getOrder(address merchant, bytes32 orderId) view returns (tuple(address merchant, bool settled, bool exists, uint16 feeBps, address token, uint256 amount, uint256 expiry, address feeRecipient, uint256 settledAt, address expectedPayer, uint64 nonce))',
  'function feeBps() view returns (uint96)',
  'function feeRecipient() view returns (address)',
  'function registerOrderFor(address merchant, bytes32 orderId, address token, uint256 amount, uint256 expiry) returns (uint64 nonce)',
] as const;
