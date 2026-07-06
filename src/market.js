const DEXSCREENER_CHAINS = Object.freeze({
  1: "ethereum",
  10: "optimism",
  56: "bsc",
  480: "worldchain",
  8453: "base",
  4801: "worldchain",
});

const WRAPPED_NATIVE = Object.freeze({
  1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  10: "0x4200000000000000000000000000000000000006",
  56: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  480: "0x4200000000000000000000000000000000000006",
  8453: "0x4200000000000000000000000000000000000006",
});

const DEFAULT_QUOTE_TOKEN = Object.freeze({
  1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  10: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  56: "0x55d398326f99059fF775485246999027B3197955",
  480: "0x79A02482A880bCE3F13e09Da970dC34db4CD24d1",
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
});

const UNISWAP_CHAINS = Object.freeze({
  1: "mainnet",
  10: "optimism",
  480: "worldchain",
  8453: "base",
});

function marketTokenAddress(asset) {
  return asset?.isNative
    ? WRAPPED_NATIVE[asset.chainId]
    : asset?.address;
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function chooseBestPair(pairs, tokenAddress) {
  const normalizedToken = tokenAddress.toLowerCase();
  return [...pairs].sort((left, right) => {
    const leftContains =
      left?.baseToken?.address?.toLowerCase() === normalizedToken ||
      left?.quoteToken?.address?.toLowerCase() === normalizedToken;
    const rightContains =
      right?.baseToken?.address?.toLowerCase() === normalizedToken ||
      right?.quoteToken?.address?.toLowerCase() === normalizedToken;

    if (leftContains !== rightContains) return rightContains ? 1 : -1;
    return (
      asNumber(right?.liquidity?.usd) - asNumber(left?.liquidity?.usd)
    );
  })[0];
}

function chartUrl(pairUrl) {
  const url = new URL(pairUrl);
  url.searchParams.set("embed", "1");
  url.searchParams.set("theme", "dark");
  url.searchParams.set("trades", "0");
  url.searchParams.set("info", "0");
  url.searchParams.set("chartTheme", "dark");
  return url.toString();
}

export async function loadMarket(asset, signal) {
  const chain = DEXSCREENER_CHAINS[asset?.chainId];
  const tokenAddress = marketTokenAddress(asset);
  if (!chain || !tokenAddress) return null;

  const response = await fetch(
    `https://api.dexscreener.com/token-pairs/v1/${chain}/${tokenAddress}`,
    {
      signal,
      headers: { Accept: "application/json" },
    },
  );

  if (!response.ok) {
    throw new Error(`DexScreener respondió ${response.status}`);
  }

  const pairs = await response.json();
  if (!Array.isArray(pairs) || pairs.length === 0) return null;

  const pair = chooseBestPair(pairs, tokenAddress);
  if (!pair?.url || !pair?.pairAddress) return null;

  const tokenIsBase =
    pair.baseToken?.address?.toLowerCase() === tokenAddress.toLowerCase();
  const selectedToken = tokenIsBase ? pair.baseToken : pair.quoteToken;
  const quoteToken = tokenIsBase ? pair.quoteToken : pair.baseToken;

  return {
    pairAddress: pair.pairAddress,
    pairUrl: pair.url,
    chartUrl: chartUrl(pair.url),
    dexId: pair.dexId ?? "DEX",
    selectedToken,
    quoteToken,
    priceUsd: pair.priceUsd ?? null,
    priceNative: pair.priceNative ?? null,
    liquidityUsd: asNumber(pair.liquidity?.usd),
    volume24h: asNumber(pair.volume?.h24),
    marketCap: asNumber(pair.marketCap),
    fdv: asNumber(pair.fdv),
    change24h: asNumber(pair.priceChange?.h24),
    buys24h: asNumber(pair.txns?.h24?.buys),
    sells24h: asNumber(pair.txns?.h24?.sells),
    updatedAt: Date.now(),
  };
}

function uniswapUrl(asset, inputCurrency, outputCurrency) {
  const chain = UNISWAP_CHAINS[asset.chainId];
  if (!chain) return null;

  const url = new URL("https://app.uniswap.org/swap");
  url.searchParams.set("chain", chain);
  if (inputCurrency) url.searchParams.set("inputCurrency", inputCurrency);
  if (outputCurrency) url.searchParams.set("outputCurrency", outputCurrency);
  return url.toString();
}

function pancakeUrl(inputCurrency, outputCurrency) {
  const url = new URL("https://pancakeswap.finance/swap");
  url.searchParams.set("chain", "bsc");
  if (inputCurrency) url.searchParams.set("inputCurrency", inputCurrency);
  if (outputCurrency) url.searchParams.set("outputCurrency", outputCurrency);
  return url.toString();
}

export function getTradeUrl(action, asset, market) {
  if (!asset) return null;

  const selectedAddress =
    market?.selectedToken?.address ?? marketTokenAddress(asset);
  const quoteAddress =
    market?.quoteToken?.address ?? DEFAULT_QUOTE_TOKEN[asset.chainId];
  if (!selectedAddress || !quoteAddress) return market?.pairUrl ?? null;

  const buying = action === "buy";
  const inputCurrency = buying ? quoteAddress : selectedAddress;
  const outputCurrency = buying ? selectedAddress : quoteAddress;

  if (
    asset.chainId === 56 ||
    String(market.dexId).toLowerCase().includes("pancake")
  ) {
    return pancakeUrl(inputCurrency, outputCurrency);
  }

  return (
    uniswapUrl(asset, inputCurrency, outputCurrency) ??
    market?.pairUrl ??
    null
  );
}

export function formatUsd(value, maximumFractionDigits = 2) {
  const number = asNumber(value);
  if (!number) return "—";
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits,
  }).format(number);
}

export function formatCompactUsd(value) {
  const number = asNumber(value);
  if (!number) return "—";
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(number);
}
