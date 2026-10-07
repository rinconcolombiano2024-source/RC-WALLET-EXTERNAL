export const WORLD_CHAIN_ID = 480;
export const ETHEREUM_CHAIN_ID = 1;

/* -------------------------------------------------------------------------- */
/* Recovery safety                                                            */
/* -------------------------------------------------------------------------- */

export const SAFE_SENTINEL =
  "0x0000000000000000000000000000000000000001";

export const ADMIN_FEE_WALLET =
  "0x0BbBd8EBa77dB629721CcdFa0C57a9ee107fdB85";

export const RECOVERY_FEE_BPS = 0n;
export const BPS_DENOMINATOR = 10_000n;

/*
 * IMPORTANT:
 *
 * RC Wallet External must NEVER assume that an exported World private key
 * directly corresponds to the World smart-account address.
 *
 * The exported EOA may instead be an OWNER of the World Safe.
 *
 * Recovery flow:
 *
 * owner EOA
 *   -> source World Safe ownership verification
 *   -> exact source deployment reconstruction
 *   -> source CREATE2 proof
 *   -> target CREATE2 proof
 *   -> target dependency verification
 *   -> fork simulation
 *   -> explicit user signature
 *   -> deployment
 *   -> post-deployment invariants
 *   -> asset recovery
 */

/* -------------------------------------------------------------------------- */
/* RC.PL                                                                      */
/* -------------------------------------------------------------------------- */

export const RCPL_TOKEN_ADDRESS =
  "0xb9DEe79d682f9dA8B95761036f2763cdE25bD3e8";

export const RCPL_TARGET_PRICE_KEY =
  "rc_wallet_rcpl_target_price_v1";

export const RCPL_STAKING_CONTRACT = "";
export const RCPL_POOL_MANAGER_CONTRACT = "";

/* -------------------------------------------------------------------------- */
/* Permit2                                                                    */
/* -------------------------------------------------------------------------- */

export const PERMIT2_ADDRESS =
  "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/* -------------------------------------------------------------------------- */
/* Safe v1.4.1 canonical contracts                                            */
/* -------------------------------------------------------------------------- */

/*
 * These are canonical Safe v1.4.1 EVM addresses.
 *
 * They are catalog values only.
 *
 * Recovery code MUST independently verify that bytecode actually exists
 * at these addresses on BOTH source and target networks before deployment.
 */

export const SAFE_V141 = Object.freeze({
  version: "1.4.1",

  proxyFactory:
    "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",

  safeSingleton:
    "0x41675C099F32341bf84BFc5382aF534df5C7461a",

  safeL2Singleton:
    "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",

  compatibilityFallbackHandler:
    "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99",
});

/*
 * CRITICAL:
 *
 * SafeProxyFactory v1.4.1 exposes these deterministic deployment methods.
 *
 * Do NOT add guessed/non-existent "L2 factory methods".
 *
 * SafeL2 refers to the Safe singleton implementation, not to a different
 * createProxyWithNonceL2() method on SafeProxyFactory.
 */

export const SAFE_PROXY_FACTORY_V141_METHODS = Object.freeze([
  "createProxyWithNonce",
  "createChainSpecificProxyWithNonce",
  "createProxyWithCallback",
]);

/* -------------------------------------------------------------------------- */
/* ERC-4337                                                                   */
/* -------------------------------------------------------------------------- */

export const ERC4337_ENTRYPOINTS = Object.freeze([
  {
    version: "v0.7",
    address:
      "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
    label: "EntryPoint ERC-4337 v0.7",
  },
  {
    version: "v0.6",
    address:
      "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789",
    label: "EntryPoint ERC-4337 v0.6",
  },
]);

/*
 * Safe4337Module v0.3.0.
 *
 * IMPORTANT:
 * These addresses help us recognize an initializer.
 * They MUST NOT be used to invent/reconstruct an initializer by assumption.
 *
 * The real initializer must come from verifiable on-chain creation evidence.
 */

export const SAFE_4337_V030 = Object.freeze({
  version: "0.3.0",

  entryPointVersion: "v0.7",

  entryPoint:
    "0x0000000071727De22E5E9d8BAf0edAc6f37da032",

  moduleSetup:
    "0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47",

  module:
    "0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226",
});

/* -------------------------------------------------------------------------- */
/* Safe factories                                                             */
/* -------------------------------------------------------------------------- */

export const SAFE_FACTORY_CANDIDATES = Object.freeze([
  {
    version: "1.4.1",
    factory: SAFE_V141.proxyFactory,
  },
  {
    version: "1.3.0",
    factory:
      "0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2",
  },
  {
    version: "1.1.1",
    factory:
      "0x12302fE9c02ff50939BaAaaf415fc226C078613C",
  },
]);

/* -------------------------------------------------------------------------- */
/* Safe services                                                              */
/* -------------------------------------------------------------------------- */

export const SAFE_CREATION_SERVICE_URLS = Object.freeze({
  1: [
    "https://safe-transaction-mainnet.safe.global",
  ],

  10: [
    "https://safe-transaction-optimism.safe.global",
  ],

  56: [
    "https://safe-transaction-bsc.safe.global",
  ],

  480: [
    "https://safe-transaction-worldchain.safe.global",
    "https://safe-transaction-world-chain.safe.global",
  ],

  8453: [
    "https://safe-transaction-base.safe.global",
  ],
});

export const SAFE_CLIENT_GATEWAY_URL =
  "https://safe-client.safe.global";

/* -------------------------------------------------------------------------- */
/* Recovery routes                                                            */
/* -------------------------------------------------------------------------- */

export const RECOVERY_ROUTE_CATALOG = Object.freeze([
  {
    id: "world-minikit",
    name: "World App MiniKit",
    requirement:
      "World Chain, sesión World App válida y allowlist en Developer Portal",
  },

  {
    id: "external-signer",
    name: "Wallet externa EIP-1193 / WalletConnect",
    requirement:
      "La EOA conectada debe ser la cuenta que contiene directamente los fondos o un owner verificado del Safe que contiene los fondos",
  },

  {
    id: "safe-multichain",
    name: "Safe / contrato espejo determinístico",
    requirement:
      "Factory, singleton, initializer, saltNonce, owners, threshold, CREATE2 y dependencias deben verificarse con evidencia on-chain",
  },

  {
    id: "safe-relay",
    name: "Safe Relay / Gelato",
    requirement:
      "Safe transaction con firmas suficientes, sesión autorizada y relay configurado",
  },

  {
    id: "erc-1271",
    name: "Firma de contrato EIP-1271",
    requirement:
      "El contrato debe validar firmas mediante isValidSignature",
  },

  {
    id: "erc-4337",
    name: "ERC-4337 UserOperation",
    requirement:
      "EntryPoint, módulo, owner y configuración real del smart account deben verificarse",
  },

  {
    id: "bridge",
    name: "Bridge / salida",
    requirement:
      "Solo después de recuperar control efectivo del activo en la red origen",
  },
]);

/* -------------------------------------------------------------------------- */
/* World Chain bridges                                                        */
/* -------------------------------------------------------------------------- */

export const WORLD_CHAIN_BRIDGES = Object.freeze([
  {
    name: "Alchemy Bridge",
    url: "https://worldchain-mainnet.bridge.alchemy.com",
    type: "native",
    note:
      "Bridge nativo de World Chain para depositar y retirar activos.",
  },

  {
    name: "Superbridge",
    url: "https://superbridge.app/world-chain",
    type: "native",
    note:
      "Interfaz Superchain para ETH y ERC20 entre Ethereum y World Chain.",
  },

  {
    name: "Across",
    url: "https://app.across.to",
    type: "third-party",
    note:
      "Ruta externa entre redes compatibles. No sustituye la recuperación de un Safe no desplegado.",
  },

  {
    name: "Brid.gg",
    url: "https://brid.gg",
    type: "third-party",
    note:
      "Bridge para Ethereum y OP Chains.",
  },

  {
    name: "Synapse",
    url: "https://synapseprotocol.com",
    type: "third-party",
    note:
      "Bridge externo para redes compatibles.",
  },

  {
    name: "Thirdweb Universal Bridge",
    url: "https://portal.thirdweb.com/connect/pay",
    type: "third-party",
    note:
      "Ruta universal para redes compatibles.",
  },
]);

/* -------------------------------------------------------------------------- */
/* Networks                                                                   */
/* -------------------------------------------------------------------------- */

export const NETWORKS = Object.freeze([
  {
    name: "World Chain",
    chainId: 480,
    chainHex: "0x1e0",
    symbol: "ETH",

    rpcUrls: [
      "https://worldchain-mainnet.gateway.tenderly.co",
      "https://worldchain.drpc.org",
      "https://worldchain-mainnet.g.alchemy.com/public",
    ],

    explorer:
      "https://worldscan.org",

    writableWithMiniKit: true,
  },

  {
    name: "Ethereum",
    chainId: 1,
    chainHex: "0x1",
    symbol: "ETH",

    rpcUrls: [
      "https://ethereum-rpc.publicnode.com",
      "https://cloudflare-eth.com",
    ],

    explorer:
      "https://etherscan.io",

    writableWithMiniKit: false,
  },

  {
    name: "Optimism",
    chainId: 10,
    chainHex: "0xa",
    symbol: "ETH",

    rpcUrls: [
      "https://mainnet.optimism.io",
      "https://optimism-rpc.publicnode.com",
    ],

    explorer:
      "https://optimistic.etherscan.io",

    writableWithMiniKit: false,
  },

  {
    name: "Base",
    chainId: 8453,
    chainHex: "0x2105",
    symbol: "ETH",

    rpcUrls: [
      "https://mainnet.base.org",
      "https://base-rpc.publicnode.com",
    ],

    explorer:
      "https://basescan.org",

    writableWithMiniKit: false,
  },

  {
    name: "BNB Chain",
    chainId: 56,
    chainHex: "0x38",
    symbol: "BNB",

    rpcUrls: [
      "https://bsc-dataseed.bnbchain.org",
      "https://bsc-rpc.publicnode.com",
    ],

    explorer:
      "https://bscscan.com",

    writableWithMiniKit: false,
  },

  {
    name: "World Chain Sepolia",
    chainId: 4801,
    chainHex: "0x12c1",
    symbol: "ETH",

    rpcUrls: [
      "https://worldchain-sepolia.g.alchemy.com/public",
    ],

    explorer:
      "https://sepolia.worldscan.org",

    writableWithMiniKit: false,
    testnet: true,
  },
]);

/* -------------------------------------------------------------------------- */
/* Tokens                                                                     */
/* -------------------------------------------------------------------------- */

export const TOKENS = Object.freeze([
  {
    symbol: "RC.PL",
    expectedDecimals: 18,
    projectToken: true,

    addresses: {
      480: RCPL_TOKEN_ADDRESS,
    },
  },

  {
    symbol: "WLD",
    expectedDecimals: 18,

    addresses: {
      480:
        "0x2cFc85d8E48F8EAB294be644d9E25C3030863003",

      10:
        "0xdC6fF44d5d932Cbd77B52E5612Ba0529DC6226F1",

      1:
        "0x163f8C2467924be0ae7B5347228CABF260318753",
    },
  },

  {
    symbol: "USDC",
    expectedDecimals: 6,

    addresses: {
      480:
        "0x79A02482A880bCE3F13e09Da970dC34db4CD24d1",

      10:
        "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",

      8453:
        "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",

      1:
        "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",

      4801:
        "0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88",
    },
  },

  {
    symbol: "USDT",
    expectedDecimals: 6,

    addresses: {
      10:
        "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",

      1:
        "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    },
  },

  {
    symbol: "WBTC",
    expectedDecimals: 8,

    addresses: {
      480:
        "0x03C7054BCB39f7b2e5B2c7AcB37583e32D70Cfa3",
    },
  },

  {
    symbol: "WETH",
    expectedDecimals: 18,

    addresses: {
      480:
        "0x4200000000000000000000000000000000000006",
    },
  },

  {
    symbol: "GOLD",
    expectedDecimals: 18,

    addresses: {
      480:
        "0x25aC3DB36bDCE12b9E4340ffb62B8DC1c0b5EF91",
    },
  },

  {
    symbol: "SUSHI",
    expectedDecimals: 18,

    addresses: {
      480:
        "0x6A1cD7B1981FdEEb8f8702B36C4b225389658E29",
    },
  },

  {
    symbol: "MADS",
    expectedDecimals: 18,

    addresses: {
      480:
        "0x39fCEFD22C3407E3e4CdCD60831631Ff6A1cD7B1",
    },
  },

  {
    symbol: "RCOL",
    expectedDecimals: 18,

    addresses: {
      480:
        "0x78BCefd3407E3e4cdCD60831631Ff6A1CD7b25aC",
    },
  },

  {
    symbol: "CUSTOM",
    expectedDecimals: 18,

    addresses: {
      480:
        "0xfEA3A03B06c31F863f62789d80C2b335904a9c05",
    },
  },

  {
    symbol: "CUSTOM2",
    expectedDecimals: 18,

    addresses: {
      480:
        "0xb15e3ce3588b1B8887Cf3F4bA9FC680432478Cfe",
    },
  },
]);

/* -------------------------------------------------------------------------- */
/* ERC20 ABI                                                                  */
/* -------------------------------------------------------------------------- */

export const ERC20_ABI = Object.freeze([
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function transfer(address to, uint256 value) returns (bool)",
]);

/* -------------------------------------------------------------------------- */
/* Safe ABI                                                                   */
/* -------------------------------------------------------------------------- */

export const SAFE_INTROSPECTION_ABI = Object.freeze([
  "function VERSION() view returns (string)",

  "function getOwners() view returns (address[])",

  "function getThreshold() view returns (uint256)",

  "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)",

  "function nonce() view returns (uint256)",

  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",

  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)",
]);

/* -------------------------------------------------------------------------- */
/* SafeProxyFactory v1.4.1 ABI                                                */
/* -------------------------------------------------------------------------- */

/*
 * VERIFIED AGAINST:
 *
 * SafeProxyFactory.sol v1.4.1
 *
 * IMPORTANT:
 *
 * There is NO:
 *   createProxyWithNonceL2(...)
 *
 * and NO:
 *   createChainSpecificProxyWithNonceL2(...)
 *
 * in SafeProxyFactory v1.4.1.
 *
 * SafeL2 is the singleton implementation used by the proxy.
 * It is not a separate ProxyFactory deployment function.
 */

export const SAFE_PROXY_FACTORY_ABI = Object.freeze([
  "function proxyCreationCode() view returns (bytes)",

  "function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",

  "function createChainSpecificProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",

  "function createProxyWithCallback(address _singleton, bytes initializer, uint256 saltNonce, address callback) returns (address proxy)",

  "function getChainId() view returns (uint256)",

  "event ProxyCreation(address indexed proxy, address singleton)",
]);

/* -------------------------------------------------------------------------- */
/* SafeModuleSetup ABI                                                        */
/* -------------------------------------------------------------------------- */

export const SAFE_MODULE_SETUP_ABI = Object.freeze([
  "function enableModules(address[] modules)",
]);

/* -------------------------------------------------------------------------- */
/* ERC-1271 ABI                                                               */
/* -------------------------------------------------------------------------- */

export const ERC1271_ABI = Object.freeze([
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);
