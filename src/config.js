export const WORLD_CHAIN_ID = 480;

export const ADMIN_FEE_WALLET = "0x0BbBd8EBa77dB629721CcdFa0C57a9ee107fdB85";
export const RECOVERY_FEE_BPS = 0n;
export const BPS_DENOMINATOR = 10_000n;

export const RCPL_TOKEN_ADDRESS = "0xb9DEe79d682f9dA8B95761036f2763cdE25bD3e8";
export const RCPL_TARGET_PRICE_KEY = "rc_wallet_rcpl_target_price_v1";
export const RCPL_STAKING_CONTRACT = "";
export const RCPL_POOL_MANAGER_CONTRACT = "";

export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

export const ERC4337_ENTRYPOINTS = Object.freeze([
  {
    version: "v0.6",
    address: "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789",
    label: "EntryPoint ERC-4337 v0.6",
  },
]);

export const RECOVERY_ROUTE_CATALOG = Object.freeze([
  {
    id: "world-minikit",
    name: "World App MiniKit",
    requirement: "World Chain, sesión World App válida y allowlist en Developer Portal",
  },
  {
    id: "external-signer",
    name: "Wallet externa EIP-1193 / WalletConnect",
    requirement: "La wallet debe firmar exactamente desde la misma dirección donde están los fondos",
  },
  {
    id: "safe-multichain",
    name: "Safe / contrato espejo determinístico",
    requirement: "Owners, threshold, factory, singleton, initializer y salt verificables",
  },
  {
    id: "erc-1271",
    name: "Firma de contrato EIP-1271",
    requirement: "El contrato debe validar firmas mediante isValidSignature",
  },
  {
    id: "erc-4337",
    name: "ERC-4337 UserOperation",
    requirement: "EntryPoint, bundler, módulo compatible y firma válida de owners",
  },
  {
    id: "bridge",
    name: "Bridge / salida a exchange",
    requirement: "Firma válida en la red origen y gas suficiente",
  },
]);

export const WORLD_CHAIN_BRIDGES = Object.freeze([
  {
    name: "Alchemy Bridge",
    url: "https://worldchain-mainnet.bridge.alchemy.com",
    type: "native",
    note: "Bridge nativo de World Chain para depositar y retirar activos.",
  },
  {
    name: "Superbridge",
    url: "https://superbridge.app/world-chain",
    type: "native",
    note: "Interfaz Superchain para ETH y ERC20 entre Ethereum y World Chain.",
  },
  {
    name: "Across",
    url: "https://app.across.to",
    type: "third-party",
    note: "Proveedor recomendado por World para rutas WLD entre World Chain y otras redes.",
  },
  {
    name: "Brid.gg",
    url: "https://brid.gg",
    type: "third-party",
    note: "Bridge para Ethereum y OP Chains, incluyendo World Chain.",
  },
  {
    name: "Synapse",
    url: "https://synapseprotocol.com",
    type: "third-party",
    note: "Bridge externo para transferencias entre redes compatibles.",
  },
  {
    name: "Thirdweb Universal Bridge",
    url: "https://portal.thirdweb.com/connect/pay",
    type: "third-party",
    note: "Ruta universal para onramp, swap y bridge en redes EVM compatibles.",
  },
]);

export const NETWORKS = Object.freeze([
  {
    name: "World Chain",
    chainId: 480,
    chainHex: "0x1e0",
    symbol: "ETH",
    rpcUrls: [
      "https://worldchain-mainnet.g.alchemy.com/public",
    ],
    explorer: "https://worldscan.org",
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
    explorer: "https://etherscan.io",
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
    explorer: "https://optimistic.etherscan.io",
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
    explorer: "https://basescan.org",
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
    explorer: "https://bscscan.com",
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
    explorer: "https://sepolia.worldscan.org",
    writableWithMiniKit: false,
    testnet: true,
  },
]);

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
      480: "0x2cFc85d8E48F8EAB294be644d9E25C3030863003",
      10: "0xdC6fF44d5d932Cbd77B52E5612Ba0529DC6226F1",
      1: "0x163f8C2467924be0ae7B5347228CABF260318753",
    },
  },
  {
    symbol: "USDC",
    expectedDecimals: 6,
    addresses: {
      480: "0x79A02482A880bCE3F13e09Da970dC34db4CD24d1",
      10: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
      8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      4801: "0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88",
    },
  },
  {
    symbol: "USDT",
    expectedDecimals: 6,
    addresses: {
      10: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
      1: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    },
  },
  {
    symbol: "WBTC",
    expectedDecimals: 8,
    addresses: {
      480: "0x03C7054BCB39f7b2e5B2c7AcB37583e32D70Cfa3",
    },
  },
  {
    symbol: "WETH",
    expectedDecimals: 18,
    addresses: {
      480: "0x4200000000000000000000000000000000000006",
    },
  },
  {
    symbol: "GOLD",
    expectedDecimals: 18,
    addresses: {
      480: "0x25aC3DB36bDCE12b9E4340ffb62B8DC1c0b5EF91",
    },
  },
  {
    symbol: "SUSHI",
    expectedDecimals: 18,
    addresses: {
      480: "0x6A1cD7B1981FdEEb8f8702B36C4b225389658E29",
    },
  },
  {
    symbol: "MADS",
    expectedDecimals: 18,
    addresses: {
      480: "0x39fCEFD22C3407E3e4CdCD60831631Ff6A1cD7B1",
    },
  },
  {
    symbol: "RCOL",
    expectedDecimals: 18,
    addresses: {
      480: "0x78BCefd3407E3e4cdCD60831631Ff6A1CD7b25aC",
    },
  },
  {
    symbol: "CUSTOM",
    expectedDecimals: 18,
    addresses: {
      480: "0xfEA3A03B06c31F863f62789d80C2b335904a9c05",
    },
  },
  {
    symbol: "CUSTOM2",
    expectedDecimals: 18,
    addresses: {
      480: "0xb15e3ce3588b1B8887Cf3F4bA9FC680432478Cfe",
    },
  },
]);

export const ERC20_ABI = Object.freeze([
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function transfer(address to, uint256 value) returns (bool)",
]);

export const SAFE_INTROSPECTION_ABI = Object.freeze([
  "function VERSION() view returns (string)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)",
]);

export const ERC1271_ABI = Object.freeze([
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);
