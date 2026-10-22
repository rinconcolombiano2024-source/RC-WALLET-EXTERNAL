/**
 * Read-only public on-chain history, separate from this browser's local
 * operation log. Explorer records are UNTRUSTED: link only validated hashes,
 * never create transaction authority or initiate spending from these hints.
 */
import { formatUnits } from "ethers";
import { BLOCKSCOUT_INDEXERS } from "./token-discovery.js";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const UINT_RE = /^(?:0|[1-9][0-9]{0,77})$/;
const MAX_RESULTS = 25;

function sameAddress(a, b) {
  return typeof a === "string" && typeof b === "string" &&
    ADDRESS_RE.test(a) && ADDRESS_RE.test(b) &&
    a.toLowerCase() === b.toLowerCase();
}

function addressOf(field) {
  return typeof field === "string" ? field : field?.hash ?? "";
}

function formattedAmount(value, decimals) {
  if (typeof value !== "string" || !UINT_RE.test(value)) return null;
  const precision = Number(decimals);
  if (!Number.isSafeInteger(precision) || precision < 0 || precision > 36) return null;
  try {
    const amount = formatUnits(BigInt(value), precision);
    const [whole, decimal = ""] = amount.split(".");
    const clipped = decimal.slice(0, 8).replace(/0+$/, "");
    return clipped ? `${whole}.${clipped}` : whole;
  } catch {
    return null;
  }
}

function safeDate(value) {
  if (typeof value !== "string" || value.length > 50) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0
    ? new Date(parsed).toISOString() : null;
}

function directionFor(from, to, owner) {
  const sent = sameAddress(from, owner);
  const received = sameAddress(to, owner);
  if (!sent && !received) return null;
  if (sent && received) return "self";
  return sent ? "out" : "in";
}

function toRecord(item, chainId, owner, nativeSymbol, type, position) {
  const hash = item?.tx_hash ?? item?.hash;
  if (typeof hash !== "string" || !HASH_RE.test(hash)) return null;
  const from = addressOf(item?.from);
  const to = addressOf(item?.to);
  const direction = directionFor(from, to, owner);
  if (!direction) return null;
  const isToken = type === "token";
  const token = item?.token;
  if (isToken && (token?.type !== "ERC-20" || !ADDRESS_RE.test(token?.address_hash ?? ""))) {
    return null;
  }
  const atomicValue = isToken
    ? String(item?.total?.value ?? item?.value ?? "")
    : String(item?.value ?? "");
  const decimals = isToken ? token?.decimals : 18;
  const amount = formattedAmount(atomicValue, decimals);
  if (amount === null) return null;
  const rawSymbol = isToken ? token?.symbol : nativeSymbol;
  const symbol = typeof rawSymbol === "string"
    ? rawSymbol.replace(/[<>]/g, "").slice(0, 24)
    : "TOKEN";
  const timestamp = safeDate(item?.timestamp);
  if (!timestamp) return null;
  const status = String(item?.status || "").toLowerCase();
  const transferId = [
    chainId, type, hash.toLowerCase(),
    isToken ? token.address_hash.toLowerCase() : "native",
    String(item?.log_index ?? item?.index ?? position),
  ].join(":");
  return {
    id: transferId, chainId, hash,
    direction, type, symbol, amount, from, to,
    timestamp, status: status === "error" ? "failed" : status === "pending" ? "pending" : "observed",
    contract: isToken ? token.address_hash : null,
  };
}

/**
 * GET /api/v2/addresses/{address}/transactions
 * GET /api/v2/addresses/{address}/token-transfers?type=ERC-20
 *
 * Only the latest returned page is displayed. No history is fabricated when
 * the provider fails or is not configured for a network.
 */
export async function fetchIndexedHistory(
  { chainId, address, nativeSymbol = "ETH" },
  { fetchImpl = globalThis.fetch, timeoutMs = 7_000 } = {},
) {
  const source = BLOCKSCOUT_INDEXERS[Number(chainId)];
  if (!source) return { status: "unsupported", records: [], reason: "Esta red no tiene historial indexado configurado" };
  if (!ADDRESS_RE.test(address ?? "")) return { status: "unavailable", records: [], reason: "Direccion invalida" };
  if (typeof fetchImpl !== "function") return { status: "unavailable", records: [], reason: "Consulta HTTP no disponible" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const root = `${source}/api/v2/addresses/${address}`;
    const paths = ["transactions", "token-transfers?type=ERC-20"];
    const queries = await Promise.allSettled(paths.map(async path => {
      const response = await fetchImpl(`${root}/${path}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Indexador no disponible");
      const body = await response.json();
      if (!Array.isArray(body?.items)) throw new Error("Respuesta de historial invalida");
      return body.items.slice(0, 50);
    }));
    const records = [];
    for (let i = 0; i < queries.length; i++) {
      const query = queries[i];
      if (query.status !== "fulfilled") continue;
      for (let index = 0; index < query.value.length; index++) {
        const item = query.value[index];
        const record = toRecord(
          item, Number(chainId), address, nativeSymbol,
          i === 0 ? "native" : "token", index,
        );
        if (record) records.push(record);
      }
    }
    const good = queries.filter(x => x.status === "fulfilled").length;
    if (!good) return { status: "unavailable", records: [], reason: "No respondieron los indexadores de transacciones" };
    const deduplicated = [...new Map(records.map(x => [x.id, x])).values()]
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
      .slice(0, MAX_RESULTS);
    return {
      status: good === 2 ? "indexed" : "partial",
      records: deduplicated,
      reason: good === 2 ? null : "Fallo alguna consulta; historial incompleto",
    };
  } catch {
    return { status: "unavailable", records: [], reason: "No fue posible consultar el historial" };
  } finally {
    clearTimeout(timer);
  }
}
