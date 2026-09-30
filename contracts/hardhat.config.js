require('@nomicfoundation/hardhat-toolbox');
// Quai plugin: adds hre.deployMetadata (IPFS push for Quaiscan verification).
// Only needed by the deploy script — guarded so `compile`/`test` never break if it is
// absent or fails to load in a given environment.
try {
  require('@quai/hardhat-deploy-metadata');
} catch (_) {
  /* deploy-metadata plugin not installed; deploy script will warn if used */
}

const dotenv = require('dotenv');
dotenv.config();

const RPC_URL = process.env.RPC_URL || 'https://orchard.rpc.quai.network';
const CHAIN_ID = Number(process.env.CHAIN_ID || 15000); // Orchard testnet default (mainnet = 9)
const CYPRUS1_PK = process.env.CYPRUS1_PK;

// Standard EVM testnets (parallel ethers-based toolchain — see scripts/evm/). Deployer key is
// shared across these networks; both RPC URLs fall back to public endpoints when unset so
// `npx hardhat compile`/`test` never require a .env file.
const EVM_DEPLOYER_PK = process.env.EVM_DEPLOYER_PK;
const ROBINHOOD_TESTNET_RPC_URL =
  process.env.ROBINHOOD_TESTNET_RPC_URL || 'https://rpc.testnet.chain.robinhood.com/rpc';
const BASE_SEPOLIA_RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';

/** @type {import('hardhat/config').HardhatUserConfig} */
module.exports = {
  // Tests run on the in-process EVM; deploys target Quai's cyprus1 zone (or a standard EVM
  // testnet via scripts/evm/).
  defaultNetwork: 'hardhat',
  networks: {
    hardhat: {},
    cyprus1: {
      url: RPC_URL,
      accounts: CYPRUS1_PK ? [CYPRUS1_PK] : [],
      chainId: CHAIN_ID,
    },
    robinhoodTestnet: {
      url: ROBINHOOD_TESTNET_RPC_URL,
      accounts: EVM_DEPLOYER_PK ? [EVM_DEPLOYER_PK] : [],
      chainId: 46630,
    },
    baseSepolia: {
      url: BASE_SEPOLIA_RPC_URL,
      accounts: EVM_DEPLOYER_PK ? [EVM_DEPLOYER_PK] : [],
      chainId: 84532,
    },
  },
  solidity: {
    version: '0.8.20', // Quai EVM supports Solidity up to 0.8.20
    settings: {
      optimizer: { enabled: true, runs: 1000 },
      evmVersion: 'london', // avoids PUSH0 (Shanghai+) which Quai's london-based EVM rejects
      // Required so Quaiscan can verify source from the IPFS-embedded metadata.
      metadata: { bytecodeHash: 'ipfs', useLiteralContent: true },
    },
  },
  paths: {
    sources: './contracts',
    tests: './test',
    cache: './cache',
    artifacts: './artifacts',
  },
  mocha: { timeout: 40000 },
};
