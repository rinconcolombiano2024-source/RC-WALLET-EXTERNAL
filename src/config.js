export const STORAGE_KEYS = Object.freeze({
  vault: "rc_wallet_external_encrypted_vault_v1",
  customTokens: "rc_wallet_external_custom_tokens_v1",
});

export const WORLD_CHAIN_ID = 480;
export const SAFE_SENTINEL = "0x0000000000000000000000000000000000000001";

export const NETWORKS = Object.freeze([
  {
    name: "Ethereum",
    shortName: "ETH",
    chainId: 1,
    chainHex: "0x1",
    symbol: "ETH",
    rpcUrls: ["https://ethereum-rpc.publicnode.com", "https://cloudflare-eth.com"],
    explorer: "https://etherscan.io",
    dex: "uniswap",
  },
  {
    name: "World Chain",
    shortName: "World",
    chainId: 480,
    chainHex: "0x1e0",
    symbol: "ETH",
    rpcUrls: ["https://worldchain-mainnet.g.alchemy.com/public"],
    explorer: "https://worldscan.org",
    dex: "uniswap",
  },
  {
    name: "Base",
    shortName: "Base",
    chainId: 8453,
    chainHex: "0x2105",
    symbol: "ETH",
    rpcUrls: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
    explorer: "https://basescan.org",
    dex: "uniswap",
  },
  {
    name: "Optimism",
    shortName: "OP",
    chainId: 10,
    chainHex: "0xa",
    symbol: "ETH",
    rpcUrls: ["https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com"],
    explorer: "https://optimistic.etherscan.io",
    dex: "uniswap",
  },
  {
    name: "BNB Chain",
    shortName: "BNB",
    chainId: 56,
    chainHex: "0x38",
    symbol: "BNB",
    rpcUrls: ["https://bsc-dataseed.bnbchain.org", "https://bsc-rpc.publicnode.com"],
    explorer: "https://bscscan.com",
    dex: "pancake",
  },
  {
    name: "Polygon",
    shortName: "Polygon",
    chainId: 137,
    chainHex: "0x89",
    symbol: "POL",
    rpcUrls: ["https://polygon-bor-rpc.publicnode.com", "https://polygon-rpc.com"],
    explorer: "https://polygonscan.com",
    dex: "uniswap",
  },
]);

export const TOKENS = Object.freeze([
  {
    symbol: "WLD",
    decimals: 18,
    addresses: {
      1: "0x163f8C2467924be0ae7B5347228CABF260318753",
      10: "0xdC6fF44d5d932CBD77b52E5612Ba0529DC6226F1",
      480: "0x2cFc85d8E48F8EAB294be644d9E25C3030863003",
    },
  },
  {
    symbol: "USDC",
    decimals: 6,
    addresses: {
      1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      10: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
      480: "0x79A02482A880bCE3F13e09Da970dC34db4CD24d1",
      8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      137: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
    },
  },
  {
    symbol: "USDT",
    decimals: 6,
    addresses: {
      1: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      10: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
      56: "0x55d398326f99059fF775485246999027B3197955",
      137: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    },
  },
  {
    symbol: "WETH",
    decimals: 18,
    addresses: {
      1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      10: "0x4200000000000000000000000000000000000006",
      480: "0x4200000000000000000000000000000000000006",
      8453: "0x4200000000000000000000000000000000000006",
      137: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
    },
  },
  {
    symbol: "WBTC",
    decimals: 8,
    addresses: {
      1: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      480: "0x03C7054bcb39f7b2e5B2c7AcB37583e32D70Cfa3",
      137: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
    },
  },
  {
    symbol: "RC.PL",
    decimals: 18,
    projectToken: true,
    addresses: {
      480: "0xb9DEe79d682f9dA8B95761036f2763cdE25bD3e8",
    },
  },
  {
    symbol: "GOLD",
    decimals: 18,
    addresses: {
      480: "0x25aC3DB36BDCE12B9E4340FFb62B8dC1c0B5EF91",
    },
  },
  {
    symbol: "SUSHI",
    decimals: 18,
    addresses: {
      480: "0x6A1CD7b1981FDEEB8f8702b36c4b225389658E29",
    },
  },
  {
    symbol: "MADS",
    decimals: 18,
    addresses: {
      480: "0x39FcEFD22c3407e3E4CDCD60831631FF6A1CD7b1",
    },
  },
  {
    symbol: "RCOL",
    decimals: 18,
    addresses: {
      480: "0x78BCEFD3407e3E4CDCD60831631FF6A1CD7b25aC",
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

export const EXTERNAL_PROVIDERS = Object.freeze({
  onramp: "https://global.transak.com",
  offramp: "https://global.transak.com",
  bridge: "https://app.across.to",
  universal: "https://portal.thirdweb.com/connect/pay",
});
