import { ethers } from "ethers";

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
const SIGNATURE_PATTERN = /^0x[a-fA-F0-9]{130}$/;

const REQUEST_TIMEOUT_MS = 20_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT = 12;
const MAX_RATE_LIMIT = 60;
const MAX_BODY_BYTES = 8_192;

const confirmationRateBuckets =
  globalThis.__rcWalletSafeConfirmRateBuckets ?? new Map();

globalThis.__rcWalletSafeConfirmRateBuckets = confirmationRateBuckets;

function clientIp(request) {
  const forwarded = request.headers["x-forwarded-for"];

  if (typeof forwarded === "string") {
    return forwarded.split(",")[0].trim();
  }

  return String(request.headers["x-real-ip"] ?? "unknown").trim();
}

function configuredOrigins() {
  return String(process.env.RC_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function requestOriginAllowed(request) {
  const origin = String(request.headers.origin ?? "").trim();

  // Same-origin server calls commonly omit Origin.
  if (!origin) return true;

  if (configuredOrigins().includes(origin)) {
    return true;
  }

  const forwardedHost =
    request.headers["x-forwarded-host"] || request.headers.host;
  const forwardedProto =
    request.headers["x-forwarded-proto"] ||
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
  const origin = String(request.headers.origin ?? "").trim();

  if (origin && requestOriginAllowed(request)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }

  response.setHeader("Access-Control-Allow-Credentials", "true");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "content-type");
}

function applySecurityHeaders(response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function json(request, response, status, body) {
  setCors(request, response);
  applySecurityHeaders(response);
  return response.status(status).json(body);
}

function serviceUrls(chainId) {
  return (SAFE_SERVICE_URLS[Number(chainId)] ?? []).map((url) =>
    url.replace(/\/+$/, ""),
  );
}

function validAddress(value) {
  return typeof value === "string" && ADDRESS_PATTERN.test(value);
}

function normalizeHash(value) {
  const hash = String(value ?? "").trim();
  if (!HASH_PATTERN.test(hash)) {
    throw new Error("safeTxHash invalido");
  }
  return `0x${hash.slice(2).toLowerCase()}`;
}

function normalizeSignature(value) {
  const signature = String(value ?? "").trim();

  if (!SIGNATURE_PATTERN.test(signature)) {
    throw new Error("firma Safe invalida");
  }

  let normalized;

  try {
    normalized = ethers.Signature.from(signature).serialized;
  } catch {
    throw new Error("firma Safe ECDSA invalida");
  }

  if (!SIGNATURE_PATTERN.test(normalized)) {
    throw new Error("firma Safe ECDSA invalida");
  }

  return normalized;
}

function recoverSigner(safeTxHash, signature) {
  try {
    return ethers.getAddress(
      ethers.recoverAddress(safeTxHash, signature),
    );
  } catch {
    throw new Error("No se pudo recuperar el firmante de la firma Safe");
  }
}

function safeApiHeaders({ jsonBody = false } = {}) {
  const apiKey =
    process.env.SAFE_API_KEY ||
    process.env.SAFE_GLOBAL_API_KEY ||
    process.env.SAFE_TRANSACTION_SERVICE_API_KEY ||
    "";

  const headers = {
    accept: "application/json",
    "user-agent": "RC-Wallet-External/1.0",
  };

  if (jsonBody) {
    headers["content-type"] = "application/json";
  }

  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

function configuredRateLimit() {
  const configured = Number.parseInt(
    process.env.RC_SAFE_CONFIRM_MAX_PER_MINUTE ?? "",
    10,
  );

  if (Number.isInteger(configured) && configured > 0) {
    return Math.min(configured, MAX_RATE_LIMIT);
  }

  return DEFAULT_RATE_LIMIT;
}

function confirmationRateLimit({ request, chainId, safeTxHash, signer }) {
  const now = Date.now();
  const limit = configuredRateLimit();
  const key = `${chainId}:${safeTxHash}:${signer.toLowerCase()}:${clientIp(request)}`;
  const previous = confirmationRateBuckets.get(key) ?? [];
  const active = previous.filter(
    (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS,
  );

  if (active.length >= limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil(
          (RATE_LIMIT_WINDOW_MS - (now - active[0])) / 1000,
        ),
      ),
    };
  }

  active.push(now);
  confirmationRateBuckets.set(key, active);

  // Cheap opportunistic cleanup for long-lived server instances.
  if (confirmationRateBuckets.size > 5_000) {
    for (const [bucketKey, timestamps] of confirmationRateBuckets.entries()) {
      const live = timestamps.filter(
        (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS,
      );

      if (live.length) {
        confirmationRateBuckets.set(bucketKey, live);
      } else {
        confirmationRateBuckets.delete(bucketKey);
      }
    }
  }

  return {
    allowed: true,
    remaining: Math.max(0, limit - active.length),
  };
}

function approximateBodyBytes(body) {
  try {
    return Buffer.byteLength(JSON.stringify(body ?? {}), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function validateRequestShape({ chainId, safeTxHash, signature }) {
  const numericChainId = Number(chainId);

  if (
    !Number.isSafeInteger(numericChainId) ||
    numericChainId <= 0
  ) {
    return "chainId invalido";
  }

  if (!serviceUrls(numericChainId).length) {
    return "Red sin Safe Transaction Service configurado";
  }

  if (!HASH_PATTERN.test(String(safeTxHash ?? "").trim())) {
    return "safeTxHash invalido";
  }

  if (!SIGNATURE_PATTERN.test(String(signature ?? "").trim())) {
    return "firma Safe invalida";
  }

  return null;
}

async function readJsonResponse(upstream) {
  const text = await upstream.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 800);
  }
}

async function fetchWithTimeout(url, options, label) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    const message =
      error?.name === "AbortError"
        ? `${label}: tiempo de espera agotado`
        : error instanceof Error
          ? error.message
          : `${label}: fallo de red`;

    const wrapped = new Error(message);
    wrapped.cause = error;
    throw wrapped;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readSafeTransaction(chainId, safeTxHash) {
  const urls = serviceUrls(chainId);
  const failures = [];

  for (const baseUrl of urls) {
    const url = `${baseUrl}/api/v1/multisig-transactions/${safeTxHash}/`;

    try {
      const upstream = await fetchWithTimeout(
        url,
        {
          method: "GET",
          headers: safeApiHeaders(),
        },
        "Safe Transaction Service lookup",
      );

      const data = await readJsonResponse(upstream);

      if (upstream.ok) {
        return {
          baseUrl,
          url,
          status: upstream.status,
          data,
        };
      }

      failures.push({
        url,
        status: upstream.status,
        detail: data,
      });

      // 4xx generally means the transaction/request is invalid. 404 can
      // still differ between World Chain aliases, so try the next endpoint.
      if (
        upstream.status >= 400 &&
        upstream.status < 500 &&
        upstream.status !== 404 &&
        upstream.status !== 429
      ) {
        break;
      }
    } catch (error) {
      failures.push({
        url,
        status: null,
        detail: error instanceof Error ? error.message : "fallo de red",
      });
    }
  }

  const error = new Error(
    "Safe Transaction Service no encontro una Safe Tx verificable",
  );
  error.status = failures.some((item) => item.status === 404) ? 404 : 502;
  error.detail = failures;
  throw error;
}

function normalizeSafeTransaction(transaction, expectedSafeTxHash) {
  if (!transaction || typeof transaction !== "object") {
    throw new Error("Safe Transaction Service devolvio una transaccion invalida");
  }

  const reportedHash =
    transaction.safeTxHash ??
    transaction.safe_tx_hash ??
    null;

  if (reportedHash) {
    const normalizedReportedHash = normalizeHash(reportedHash);

    if (normalizedReportedHash !== expectedSafeTxHash) {
      throw new Error(
        "La Safe Tx recibida no coincide con el safeTxHash solicitado",
      );
    }
  }

  const safe = transaction.safe;
  const to = transaction.to;

  if (!validAddress(safe)) {
    throw new Error("La Safe Tx contiene una direccion Safe invalida");
  }

  if (!validAddress(to)) {
    throw new Error("La Safe Tx contiene un destino invalido");
  }

  const operation = Number(transaction.operation ?? 0);

  if (operation !== 0) {
    throw new Error(
      "RC Wallet solo confirma Safe CALL (operation=0); DELEGATECALL esta bloqueado",
    );
  }

  const isExecuted = Boolean(
    transaction.isExecuted ?? transaction.is_executed,
  );

  const confirmations = Array.isArray(transaction.confirmations)
    ? transaction.confirmations
    : [];

  return {
    safe: ethers.getAddress(safe),
    to: ethers.getAddress(to),
    operation,
    isExecuted,
    confirmations,
    raw: transaction,
  };
}

function confirmationAlreadyExists(confirmations, signer) {
  return confirmations.some((confirmation) => {
    const owner = confirmation?.owner ?? confirmation?.sender;

    if (!validAddress(owner)) return false;

    try {
      return ethers.getAddress(owner) === signer;
    } catch {
      return false;
    }
  });
}

async function postConfirmation({ baseUrl, safeTxHash, signature }) {
  const url = `${baseUrl}/api/v1/multisig-transactions/${safeTxHash}/confirmations/`;

  const upstream = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: safeApiHeaders({ jsonBody: true }),
      body: JSON.stringify({ signature }),
    },
    "Safe Transaction Service confirmation",
  );

  const data = await readJsonResponse(upstream);

  return {
    url,
    status: upstream.status,
    ok: upstream.ok,
    data,
  };
}

export default async function handler(request, response) {
  if (!requestOriginAllowed(request)) {
    applySecurityHeaders(response);
    return response.status(403).json({
      error: "Origin no autorizado",
    });
  }

  setCors(request, response);
  applySecurityHeaders(response);

  if (request.method === "OPTIONS") {
    return response.status(204).end();
  }

  if (request.method !== "POST") {
    return json(request, response, 405, {
      error: "Metodo no permitido",
    });
  }

  if (approximateBodyBytes(request.body) > MAX_BODY_BYTES) {
    return json(request, response, 413, {
      error: "Solicitud demasiado grande",
    });
  }

  const body = request.body ?? {};
  const chainId = Number(body.chainId);
  const rawSafeTxHash = body.safeTxHash;
  const rawSignature = body.signature;

  const validationError = validateRequestShape({
    chainId,
    safeTxHash: rawSafeTxHash,
    signature: rawSignature,
  });

  if (validationError) {
    return json(request, response, 400, {
      error: validationError,
    });
  }

  let safeTxHash;
  let signature;
  let signer;

  try {
    safeTxHash = normalizeHash(rawSafeTxHash);
    signature = normalizeSignature(rawSignature);
    signer = recoverSigner(safeTxHash, signature);
  } catch (error) {
    return json(request, response, 400, {
      error: error instanceof Error ? error.message : "Firma Safe invalida",
    });
  }

  const rateLimit = confirmationRateLimit({
    request,
    chainId,
    safeTxHash,
    signer,
  });

  if (!rateLimit.allowed) {
    response.setHeader(
      "Retry-After",
      String(rateLimit.retryAfterSeconds),
    );

    return json(request, response, 429, {
      error: "Demasiadas confirmaciones Safe. Intenta nuevamente mas tarde.",
    });
  }

  try {
    const lookup = await readSafeTransaction(chainId, safeTxHash);
    const transaction = normalizeSafeTransaction(
      lookup.data?.response ?? lookup.data,
      safeTxHash,
    );

    if (transaction.isExecuted) {
      return json(request, response, 409, {
        error: "Esta Safe Tx ya aparece como ejecutada",
        safeTxHash,
        safe: transaction.safe,
      });
    }

    if (confirmationAlreadyExists(transaction.confirmations, signer)) {
      return json(request, response, 200, {
        ok: true,
        alreadyConfirmed: true,
        route: "safe-service-confirmation",
        chainId,
        safeTxHash,
        safe: transaction.safe,
        signer,
        source: {
          lookupUrl: lookup.url,
          service: lookup.baseUrl,
        },
      });
    }

    const confirmation = await postConfirmation({
      baseUrl: lookup.baseUrl,
      safeTxHash,
      signature,
    });

    if (!confirmation.ok) {
      return json(request, response, confirmation.status, {
        error: "Safe Transaction Service rechazo la confirmacion",
        status: confirmation.status,
        detail: confirmation.data,
        url: confirmation.url,
        safeTxHash,
        safe: transaction.safe,
        signer,
      });
    }

    return json(request, response, 200, {
      ok: true,
      alreadyConfirmed: false,
      route: "safe-service-confirmation",
      chainId,
      safeTxHash,
      safe: transaction.safe,
      to: transaction.to,
      operation: transaction.operation,
      signer,
      confirmation: confirmation.data,
      source: {
        lookupUrl: lookup.url,
        confirmationUrl: confirmation.url,
        service: lookup.baseUrl,
      },
    });
  } catch (error) {
    return json(request, response, error?.status ?? 502, {
      error:
        error instanceof Error
          ? error.message
          : "No se pudo confirmar la Safe Tx",
      detail: error?.detail ?? null,
      safeTxHash,
      signer,
    });
  }
}
