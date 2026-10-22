/**
 * Best-effort ERC-20 contract discovery via public Blockscout explorers.
 *
 * Explorer results are UNTRUSTED discovery hints, never proof of funds or
 * authority. src/blockchain.js queries each discovered contract via RPC for
 * bytecode, balanceOf, decimals and symbol before showing a balance.
 *
 * A failed/unsupported/partial indexer must be distinguished from "zero funds".
 * No private key, signature, or transaction is sent to explorers.
 */
export const BLOCKSCOUT_INDEXERS = Object.freeze({
  480: "https://worldchain-mainnet.explorer.alchemy.com",
  1: "https://eth.blockscout.com",
  10: "https://optimism.blockscout.com",
  8453: "https://base.blockscout.com",
  137: "https://polygon.blockscout.com",
  42161: "https://arbitrum.blockscout.com",
});

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const DEFAULT_MAX_TOKENS = 80;

export function parseIndexedErc20Definitions(payload, chainId, maxTokens = DEFAULT_MAX_TOKENS) {
  if (!Array.isArray(payload)) {
    throw new Error("Respuesta inesperada del indexador");
  }

  const limit = Math.max(1, Math.min(200, Math.trunc(Number(maxTokens) || DEFAULT_MAX_TOKENS)));
  const seen = new Set();
  const definitions = [];
  let eligible = 0;

  for (const item of payload) {
    const token = item?.token;
    const tokenType = token?.type ?? item?.token_type;
    if (tokenType !== "ERC-20") continue;

    const address = token?.address_hash ?? token?.address ?? item?.token_address;
    if (typeof address !== "string" || !ADDRESS_PATTERN.test(address)) continue;
    if (/^0x0{40}$/i.test(address)) continue;
    const lower = address.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    eligible += 1;

    if (definitions.length >= limit) continue;
    const symbol = typeof token?.symbol === "string"
      ? token.symbol.trim().slice(0, 30)
      : "";
    definitions.push({
      symbol: symbol || "ERC20",
      indexedToken: true,
      addresses: { [chainId]: address },
    });
  }

  return { definitions, truncated: eligible > definitions.length };
}

export async function discoverIndexedErc20Tokens(
  network,
  address,
  { fetchImpl = globalThis.fetch, timeoutMs = 6_000, maxTokens = DEFAULT_MAX_TOKENS } = {},
) {
  const chainId = Number(network?.chainId);
  const baseUrl = BLOCKSCOUT_INDEXERS[chainId];
  const isBnbChain = chainId === 56;
  if (!baseUrl && !isBnbChain) {
    return { status: "unsupported", definitions: [], reason: "Sin indexador ERC-20 configurado" };
  }
  if (typeof address !== "string" || !ADDRESS_PATTERN.test(address)) {
    return { status: "unavailable", definitions: [], reason: "Direccion EVM invalida" };
  }
  if (typeof fetchImpl !== "function") {
    return { status: "unavailable", definitions: [], reason: "Fetch no disponible" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = isBnbChain
      ? `/api/token-discovery?chainId=56&address=${encodeURIComponent(address)}`
      : `${baseUrl}/api/v2/addresses/${address}/token-balances`;
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Indexer HTTP ${response.status}`);
    const upstream = await response.json();
    if (isBnbChain && !["partial", "indexed"].includes(upstream?.status)) {
      throw new Error("Indexer BNB no valido");
    }
    const parsed = parseIndexedErc20Definitions(
      isBnbChain ? upstream.items : upstream, network.chainId, maxTokens
    );
    const incomplete = parsed.truncated || (isBnbChain && upstream.status === "partial");
    return {
      status: incomplete ? "partial" : "indexed",
      definitions: parsed.definitions,
      reason: parsed.truncated
        ? "Limite de contratos alcanzado: escaneo parcial"
        : incomplete
          ? "Descubrimiento BNB limitado; cada balance se verifica directamente por RPC"
          : null,
    };
  } catch (error) {
    return {
      status: "unavailable",
      definitions: [],
      reason: error?.name === "AbortError" ? "Indexer sin respuesta" : "Indexer no disponible",
    };
  } finally {
    clearTimeout(timer);
  }
}
