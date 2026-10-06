const SAFE_SERVICE_URLS = Object.freeze({
  1: ["https://safe-transaction-mainnet.safe.global"],
  10: ["https://safe-transaction-optimism.safe.global"],
  56: ["https://safe-transaction-bsc.safe.global"],
  480: [
    "https://safe-transaction-worldchain.safe.global",
    "https://safe-transaction-world-chain.safe.global",
  ],
  8453: ["https://safe-transaction-base.safe.global"],
});

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;
const UINT_PATTERN = /^(0|[1-9][0-9]*)$/;

const RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT = 30;
const MAX_RATE_LIMIT = 120;
const MAX_REQUEST_BODY_BYTES = 8_192;
const UPSTREAM_TIMEOUT_MS = 15_000;

const lookupRateBuckets =
  globalThis.__rcWalletSafeLookupRateBuckets ?? new Map();

globalThis.__rcWalletSafeLookupRateBuckets = lookupRateBuckets;

function configuredOrigins() {
  return String(process.env.RC_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function requestOriginAllowed(request) {
  const origin = String(request.headers?.origin ?? "").trim();

  if (!origin) return true;

  if (configuredOrigins().includes(origin)) {
    return true;
  }

  const forwardedHost =
    request.headers?.["x-forwarded-host"] || request.headers?.host;
  const forwardedProto =
    request.headers?.["x-forwarded-proto"] ||
    (process.env.NODE_ENV === "production" ? "https" : "http");

  if (forwardedHost) {
    const sameOrigin = `${forwardedProto}://${forwardedHost}`;
    if (origin === sameOrigin) return true;
  }

  if (
    process.env.NODE_ENV !== "production" &&
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
  ) {
    return true;
  }

  return false;
}

function setCors(request, response) {
  const origin = String(request.headers?.origin ?? "").trim();

  if (origin && requestOriginAllowed(request)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }

  response.setHeader("Access-Control-Allow-Credentials", "true");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "content-type");
}

function json(request, response, status, body) {
  setCors(request, response);
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Content-Type-Options", "nosniff");
  return response.status(status).json(body);
}

function serviceUrls(chainId) {
  return (SAFE_SERVICE_URLS[Number(chainId)] ?? []).map((url) =>
    String(url).replace(/\/+$/, ""),
  );
}

function safeApiHeaders() {
  const apiKey =
    process.env.SAFE_API_KEY ||
    process.env.SAFE_GLOBAL_API_KEY ||
    process.env.SAFE_TRANSACTION_SERVICE_API_KEY ||
    "";

  const headers = {
    accept: "application/json",
    "user-agent": "RC-Wallet-External/1.0",
  };

  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

function clientIp(request) {
  const forwarded = request.headers?.["x-forwarded-for"];

  if (typeof forwarded === "string") {
    return forwarded.split(",")[0]?.trim() || "unknown";
  }

  return request.headers?.["x-real-ip"] || "unknown";
}

function configuredRateLimit() {
  const parsed = Number.parseInt(
    process.env.RC_SAFE_LOOKUP_MAX_PER_MINUTE ?? "",
    10,
  );

  if (Number.isInteger(parsed) && parsed > 0) {
    return Math.min(parsed, MAX_RATE_LIMIT);
  }

  return DEFAULT_RATE_LIMIT;
}

function applyRateLimit(request) {
  const now = Date.now();
  const limit = configuredRateLimit();
  const key = clientIp(request);

  const previous = lookupRateBuckets.get(key) ?? [];
  const active = previous.filter(
    (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS,
  );

  if (active.length >= limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil(
          (RATE_LIMIT_WINDOW_MS - (now - (active[0] ?? now))) / 1000,
        ),
      ),
    };
  }

  active.push(now);
  lookupRateBuckets.set(key, active);

  if (lookupRateBuckets.size > 2_000) {
    for (const [bucketKey, timestamps] of lookupRateBuckets) {
      const stillActive = timestamps.filter(
        (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS,
      );

      if (!stillActive.length) {
        lookupRateBuckets.delete(bucketKey);
      } else {
        lookupRateBuckets.set(bucketKey, stillActive);
      }

      if (lookupRateBuckets.size <= 1_500) break;
    }
  }

  return {
    allowed: true,
    remaining: Math.max(0, limit - active.length),
  };
}

function requestBodyTooLarge(request) {
  const contentLength = Number.parseInt(
    String(request.headers?.["content-length"] ?? ""),
    10,
  );

  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_REQUEST_BODY_BYTES
  ) {
    return true;
  }

  try {
    return (
      Buffer.byteLength(JSON.stringify(request.body ?? {}), "utf8") >
      MAX_REQUEST_BODY_BYTES
    );
  } catch {
    return true;
  }
}

function validateLookupRequest({ chainId, safeTxHash }) {
  const numericChainId = Number(chainId);

  if (!Number.isSafeInteger(numericChainId) || numericChainId <= 0) {
    return "chainId invalido";
  }

  if (!serviceUrls(numericChainId).length) {
    return "Red sin Safe Transaction Service configurado";
  }

  if (
    typeof safeTxHash !== "string" ||
    !HASH_PATTERN.test(safeTxHash)
  ) {
    return "safeTxHash invalido";
  }

  return null;
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 800);
  }
}

function validateUintLike(value, field) {
  if (value === null || value === undefined) return;

  if (!UINT_PATTERN.test(String(value))) {
    throw new Error(`${field} invalido en Safe Transaction Service`);
  }
}

function validateAddressLike(value, field, { required = true } = {}) {
  if (value === null || value === undefined || value === "") {
    if (required) {
      throw new Error(`${field} ausente en Safe Transaction Service`);
    }
    return;
  }

  if (typeof value !== "string" || !ADDRESS_PATTERN.test(value)) {
    throw new Error(`${field} invalida en Safe Transaction Service`);
  }
}

function normalizeUpstreamTransaction(payload, requestedSafeTxHash) {
  const transaction = payload?.response ?? payload;

  if (
    !transaction ||
    typeof transaction !== "object" ||
    Array.isArray(transaction)
  ) {
    throw new Error(
      "Safe Transaction Service devolvio una transaccion invalida",
    );
  }

  const returnedHash =
    transaction.safeTxHash ??
    transaction.safe_tx_hash ??
    transaction.contractTransactionHash ??
    transaction.contract_transaction_hash ??
    null;

  if (returnedHash !== null) {
    if (
      typeof returnedHash !== "string" ||
      !HASH_PATTERN.test(returnedHash)
    ) {
      throw new Error(
        "Safe Transaction Service devolvio un hash invalido",
      );
    }

    if (
      returnedHash.toLowerCase() !== requestedSafeTxHash.toLowerCase()
    ) {
      throw new Error(
        "Safe Transaction Service devolvio una transaccion distinta al safeTxHash solicitado",
      );
    }
  }

  validateAddressLike(transaction.safe, "safe");
  validateAddressLike(transaction.to, "to");

  validateAddressLike(
    transaction.gasToken ?? transaction.gas_token,
    "gasToken",
    { required: false },
  );
  validateAddressLike(
    transaction.refundReceiver ?? transaction.refund_receiver,
    "refundReceiver",
    { required: false },
  );

  validateUintLike(transaction.value, "value");
  validateUintLike(transaction.nonce, "nonce");
  validateUintLike(
    transaction.safeTxGas ?? transaction.safe_tx_gas,
    "safeTxGas",
  );
  validateUintLike(
    transaction.baseGas ?? transaction.base_gas,
    "baseGas",
  );
  validateUintLike(
    transaction.gasPrice ?? transaction.gas_price,
    "gasPrice",
  );

  const operation = Number(transaction.operation);

  if (!Number.isInteger(operation)) {
    throw new Error(
      "Safe Transaction Service no devolvio operation valida",
    );
  }

  if (operation !== 0) {
    throw new Error(
      "RC Wallet Recovery solo permite Safe CALL (operation=0). DELEGATECALL esta bloqueado.",
    );
  }

  const data = transaction.data ?? "0x";

  if (
    typeof data !== "string" ||
    !/^0x(?:[a-fA-F0-9]{2})*$/.test(data)
  ) {
    throw new Error(
      "Safe Transaction Service devolvio data invalida",
    );
  }

  if (Array.isArray(transaction.confirmations)) {
    for (const confirmation of transaction.confirmations) {
      const owner =
        confirmation?.owner ??
        confirmation?.sender ??
        null;

      if (owner !== null) {
        validateAddressLike(owner, "confirmation.owner");
      }

      const signature = confirmation?.signature ?? null;

      if (
        signature !== null &&
        (
          typeof signature !== "string" ||
          !/^0x[a-fA-F0-9]+$/.test(signature)
        )
      ) {
        throw new Error(
          "Safe Transaction Service devolvio una confirmacion con firma invalida",
        );
      }
    }
  }

  return transaction;
}

async function fetchFromSafeService({ baseUrl, safeTxHash }) {
  const url =
    `${baseUrl}/api/v1/multisig-transactions/${safeTxHash}/`;

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    UPSTREAM_TIMEOUT_MS,
  );

  try {
    const upstream = await fetch(url, {
      method: "GET",
      headers: safeApiHeaders(),
      signal: controller.signal,
    });

    const data = await readJsonResponse(upstream);

    return {
      upstream,
      data,
      url,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function lookupSafeTransaction({ chainId, safeTxHash }) {
  const endpoints = serviceUrls(chainId);
  const failures = [];
  let sawNotFound = false;

  for (const baseUrl of endpoints) {
    try {
      const result = await fetchFromSafeService({
        baseUrl,
        safeTxHash,
      });

      if (result.upstream.ok) {
        const transaction = normalizeUpstreamTransaction(
          result.data,
          safeTxHash,
        );

        return {
          ok: true,
          status: result.upstream.status,
          response: transaction,
          url: result.url,
        };
      }

      if (result.upstream.status === 404) {
        sawNotFound = true;
        failures.push({
          url: result.url,
          status: 404,
          detail: result.data,
        });
        continue;
      }

      if (result.upstream.status >= 500) {
        failures.push({
          url: result.url,
          status: result.upstream.status,
          detail: result.data,
        });
        continue;
      }

      return {
        ok: false,
        status: result.upstream.status,
        error: "Safe Transaction Service rechazo la consulta",
        detail: result.data,
        url: result.url,
      };
    } catch (error) {
      failures.push({
        url:
          `${baseUrl}/api/v1/multisig-transactions/${safeTxHash}/`,
        status: null,
        detail:
          error instanceof Error
            ? error.message
            : "Safe Transaction Service no respondio",
      });
    }
  }

  if (sawNotFound) {
    return {
      ok: false,
      status: 404,
      error: "Safe Transaction Service no encontro la transaccion",
      failures,
    };
  }

  return {
    ok: false,
    status: 502,
    error: "No se pudo contactar Safe Transaction Service",
    failures,
  };
}

export default async function handler(request, response) {
  if (!requestOriginAllowed(request)) {
    return response.status(403).json({
      error: "Origin no autorizado",
    });
  }

  setCors(request, response);

  if (request.method === "OPTIONS") {
    return response.status(204).end();
  }

  if (request.method !== "POST") {
    return json(request, response, 405, {
      error: "Metodo no permitido",
    });
  }

  if (requestBodyTooLarge(request)) {
    return json(request, response, 413, {
      error: "Solicitud demasiado grande",
    });
  }

  const rateLimit = applyRateLimit(request);

  if (!rateLimit.allowed) {
    response.setHeader(
      "Retry-After",
      String(rateLimit.retryAfterSeconds),
    );

    return json(request, response, 429, {
      error:
        "Demasiadas consultas Safe. Intenta nuevamente mas tarde.",
    });
  }

  const body = request.body ?? {};
  const chainId = body.chainId;
  const safeTxHash = body.safeTxHash;

  const validationError = validateLookupRequest({
    chainId,
    safeTxHash,
  });

  if (validationError) {
    return json(request, response, 400, {
      error: validationError,
    });
  }

  const result = await lookupSafeTransaction({
    chainId: Number(chainId),
    safeTxHash,
  });

  if (!result.ok) {
    return json(
      request,
      response,
      result.status ?? 502,
      {
        error: result.error,
        detail: result.detail ?? null,
        url: result.url ?? null,
        failures: result.failures ?? null,
      },
    );
  }

  return json(request, response, 200, {
    ok: true,
    status: result.status,
    response: result.response,
    url: result.url,
    security: {
      operation: 0,
      delegateCallBlocked: true,
      hashVerified: true,
    },
  });
}
