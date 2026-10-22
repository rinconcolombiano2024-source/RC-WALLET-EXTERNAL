/**
 * Public-address-only BEP-20 discovery for BNB Chain.
 *
 * A Binplorer record is a discovery hint, NOT a spendable balance or a
 * statement of ownership. The browser independently checks every contract
 * and calls balanceOf() using an RPC endpoint before displaying an asset.
 *
 * The optional BINPLORER_API_KEY is exclusively read server-side. Binplorer's
 * shared freekey is a rate-limited fallback and is NEVER marked exhaustive.
 */
const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const REQUEST_LIMIT = 10;
const WINDOW_MS = 60_000;
const MAX_RESPONSE_BYTES = 750_000;
const MAX_CONTRACTS = 120;
const buckets = new Map();

export function parseBinplorerTokenHints(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.tokens)) {
    throw new Error("El proveedor no devolvio una lista de tokens");
  }
  const seen = new Set();
  let total = 0;
  const items = [];
  for (const entry of value.tokens) {
    const metadata = entry?.tokenInfo;
    const contract = metadata?.address;
    if (typeof contract !== "string" || !ADDRESS_PATTERN.test(contract)) continue;
    if (/^0x0{40}$/i.test(contract)) continue;
    const key = contract.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Balance supplied by this API is NOT trusted, and is deliberately
    // excluded. A trusted RPC balanceOf() check follows in the client.
    total++;
    if (items.length >= MAX_CONTRACTS) continue;
    const symbol = typeof metadata?.symbol === "string"
      ? metadata.symbol.replace(/[<>]/g, "").replaceAll("/", "").replace(/[\x00-\x1f]/g, "").trim().slice(0, 30)
      : "";
    items.push({
      token: {
        type: "ERC-20",
        address_hash: contract,
        symbol: symbol || "BEP20",
      },
    });
  }
  return { items, truncated: total > items.length };
}

function requestAllowed(request) {
  const origin = String(request.headers?.origin ?? "").trim();
  if (!origin) return true;
  const allowed = String(process.env.RC_ALLOWED_ORIGINS ?? "")
    .split(",").map((x) => x.trim()).filter(Boolean);
  if (allowed.includes(origin)) return true;
  const host = String(request.headers?.["x-forwarded-host"] || request.headers?.host || "");
  const proto = String(request.headers?.["x-forwarded-proto"] || "https");
  if (host && origin === `${proto}://${host}`) return true;
  return process.env.NODE_ENV !== "production" &&
    /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin);
}

function send(response, status, body) {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("X-Content-Type-Options", "nosniff");
  return response.status(status).json(body);
}

function allowRate(request) {
  const forwarded = String(request.headers?.["x-forwarded-for"] || request.headers?.["x-real-ip"] || "unknown");
  const key = forwarded.split(",")[0].trim().slice(0, 64);
  const now = Date.now();
  const recent = (buckets.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= REQUEST_LIMIT) return false;
  recent.push(now);
  buckets.set(key, recent);
  if (buckets.size > 1000) {
    for (const [ip, times] of buckets) {
      if (!times.some((t) => now - t < WINDOW_MS)) buckets.delete(ip);
    }
  }
  return true;
}

export default async function handler(request, response) {
  if (!requestAllowed(request)) {
    return send(response, 403, { error: "Origin no autorizado" });
  }
  if (request.method !== "GET") {
    return send(response, 405, { error: "Solo se permite GET" });
  }
  const rawAddress = request.query?.address;
  const rawChainId = request.query?.chainId;
  if (
    typeof rawAddress !== "string" ||
    !ADDRESS_PATTERN.test(rawAddress) ||
    String(rawChainId) !== "56"
  ) {
    return send(response, 400, { error: "Direccion o red invalida" });
  }
  if (!allowRate(request)) {
    response.setHeader("Retry-After", "60");
    return send(response, 429, { error: "Limite de consultas de tokens alcanzado" });
  }

  const apiKey = process.env.BINPLORER_API_KEY || "freekey";
  const sharedKey = apiKey === "freekey";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const url = new URL(`https://api.binplorer.com/getAddressInfo/${rawAddress}`);
    url.searchParams.set("apiKey", apiKey);
    url.searchParams.set("showETHTotals", "false");
    const upstream = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!upstream.ok) throw new Error("Error del indexador");
    const contentLength = Number(upstream.headers?.get?.("content-length") ?? "0");
    if (contentLength > MAX_RESPONSE_BYTES) throw new Error("Respuesta muy grande");
    const text = await upstream.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error("Respuesta muy grande");
    const parsed = parseBinplorerTokenHints(JSON.parse(text));
    return send(response, 200, {
      status: sharedKey || parsed.truncated ? "partial" : "indexed",
      reason: parsed.truncated
        ? "El listado de contratos supera el limite de consulta"
        : sharedKey
          ? "Binplorer freekey: consulta compartida limitada; no es un inventario exhaustivo"
          : null,
      items: parsed.items,
      source: "Binplorer",
    });
  } catch (error) {
    return send(response, 502, {
      error: error?.name === "AbortError"
        ? "Timeout del indexador BNB"
        : "No se pudo consultar el indexador BNB",
    });
  } finally {
    clearTimeout(timer);
  }
}
