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
const HEX_PATTERN = /^0x(?:[a-fA-F0-9]{2})*$/;
const SIGNATURE_PATTERN = /^0x[a-fA-F0-9]{130}$/;
const UINT_PATTERN = /^(0|[1-9][0-9]*)$/;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_SAFE_DATA_HEX_LENGTH = 131_074;
const UPSTREAM_TIMEOUT_MS = 20_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT = 10;
const MAX_RATE_LIMIT = 60;

const proposalRateBuckets =
  globalThis.__rcWalletSafeProposalRateBuckets ?? new Map();

globalThis.__rcWalletSafeProposalRateBuckets = proposalRateBuckets;

function configuredOrigins() {
  return String(process.env.RC_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function requestOriginAllowed(request) {
  const origin = String(request.headers.origin ?? "").trim();

  // Same-origin/server-to-server requests may omit Origin.
  if (!origin) {
    return true;
  }

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
    if (origin === sameOrigin) {
      return true;
    }
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

function json(request, response, status, body) {
  setCors(request, response);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Content-Type-Options", "nosniff");
  return response.status(status).json(body);
}

function clientIp(request) {
  const forwarded = request.headers["x-forwarded-for"];

  if (typeof forwarded === "string") {
    return forwarded.split(",")[0].trim() || "unknown";
  }

  return String(request.headers["x-real-ip"] || "unknown");
}

function configuredRateLimit() {
  const configured = Number.parseInt(
    process.env.RC_SAFE_PROPOSE_MAX_PER_MINUTE ?? "",
    10,
  );

  if (!Number.isInteger(configured) || configured <= 0) {
    return DEFAULT_RATE_LIMIT;
  }

  return Math.min(configured, MAX_RATE_LIMIT);
}

function proposalRateLimit(request, safeAddress, sender) {
  const now = Date.now();
  const limit = configuredRateLimit();
  const key = `${safeAddress.toLowerCase()}:${sender.toLowerCase()}:${clientIp(
    request,
  )}`;

  const previous = proposalRateBuckets.get(key) ?? [];
  const active = previous.filter(
    (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS,
  );

  if (active.length >= limit) {
    const oldest = active[0] ?? now;

    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((RATE_LIMIT_WINDOW_MS - (now - oldest)) / 1000),
      ),
    };
  }

  active.push(now);
  proposalRateBuckets.set(key, active);

  // Opportunistic cleanup so long-running server instances do not grow forever.
  if (proposalRateBuckets.size > 5_000) {
    for (const [bucketKey, timestamps] of proposalRateBuckets.entries()) {
      const fresh = timestamps.filter(
        (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS,
      );

      if (!fresh.length) {
        proposalRateBuckets.delete(bucketKey);
      } else {
        proposalRateBuckets.set(bucketKey, fresh);
      }
    }
  }

  return {
    allowed: true,
    remaining: Math.max(0, limit - active.length),
  };
}

function serviceUrls(chainId) {
  return (SAFE_SERVICE_URLS[Number(chainId)] ?? []).map((url) =>
    url.replace(/\/+$/, ""),
  );
}

function serviceUrl(chainId) {
  return serviceUrls(chainId)[0] ?? null;
}

function validAddress(value) {
  return typeof value === "string" && ADDRESS_PATTERN.test(value);
}

function validHex(value) {
  return (
    typeof value === "string" &&
    value.length <= MAX_SAFE_DATA_HEX_LENGTH &&
    HEX_PATTERN.test(value)
  );
}

function parseUint256String(value) {
  if (typeof value !== "string" || !UINT_PATTERN.test(value)) {
    return null;
  }

  try {
    const parsed = BigInt(value);
    return parsed >= 0n && parsed <= MAX_UINT256 ? parsed : null;
  } catch {
    return null;
  }
}

function validUintString(value) {
  return parseUint256String(value) !== null;
}

function safeApiHeaders() {
  const apiKey =
    process.env.SAFE_API_KEY ||
    process.env.SAFE_GLOBAL_API_KEY ||
    process.env.SAFE_TRANSACTION_SERVICE_API_KEY ||
    "";

  const headers = {
    accept: "application/json",
    "content-type": "application/json",
    "user-agent": "RC-Wallet-External/1.0",
  };

  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

function validateSafeProposal({ chainId, safeAddress, payload }) {
  const normalizedChainId = Number(chainId);

  if (
    !Number.isSafeInteger(normalizedChainId) ||
    normalizedChainId <= 0
  ) {
    return "chainId invalido";
  }

  if (!serviceUrl(normalizedChainId)) {
    return "Red sin Safe Transaction Service configurado";
  }

  if (!validAddress(safeAddress) || safeAddress.toLowerCase() === ZERO_ADDRESS) {
    return "safeAddress invalida";
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "payload invalido";
  }

  if (
    !validAddress(payload.safe) ||
    payload.safe.toLowerCase() !== safeAddress.toLowerCase()
  ) {
    return "payload.safe no coincide con la Safe";
  }

  if (!validAddress(payload.to) || payload.to.toLowerCase() === ZERO_ADDRESS) {
    return "payload.to invalido";
  }

  // Recovery route only needs a normal Safe CALL. Never proxy DELEGATECALL.
  if (payload.operation !== 0) {
    return "payload.operation invalido: RC Wallet solo permite CALL (operation=0)";
  }

  if (!validAddress(payload.sender) || payload.sender.toLowerCase() === ZERO_ADDRESS) {
    return "payload.sender invalido";
  }

  if (!validAddress(payload.gasToken) || !validAddress(payload.refundReceiver)) {
    return "gasToken o refundReceiver invalido";
  }

  for (const field of ["value", "safeTxGas", "baseGas", "gasPrice"]) {
    if (!validUintString(payload[field])) {
      return `${field} invalido`;
    }
  }

  if (!Number.isSafeInteger(payload.nonce) || payload.nonce < 0) {
    return "nonce invalido";
  }

  if (!HASH_PATTERN.test(payload.contractTransactionHash ?? "")) {
    return "contractTransactionHash invalido";
  }

  if (!validHex(payload.data)) {
    return "payload.data invalido o demasiado grande";
  }

  if (!SIGNATURE_PATTERN.test(payload.signature ?? "")) {
    return "firma Safe invalida";
  }

  return null;
}

async function readUpstreamBody(upstream) {
  const text = await upstream.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 800);
  }
}

async function postSafeProposal(chainId, safeAddress, payload) {
  const bases = serviceUrls(chainId);
  let lastFailure = null;

  for (const baseUrl of bases) {
    const url = `${baseUrl}/api/v1/safes/${safeAddress}/multisig-transactions/`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    try {
      const upstream = await fetch(url, {
        method: "POST",
        headers: safeApiHeaders(),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const data = await readUpstreamBody(upstream);

      if (upstream.ok) {
        return {
          ok: true,
          status: upstream.status,
          data,
          url,
        };
      }

      // A client-side rejection is authoritative; retrying another mirror
      // would only duplicate the signed proposal attempt.
      if (upstream.status >= 400 && upstream.status < 500) {
        return {
          ok: false,
          status: upstream.status,
          data,
          url,
        };
      }

      lastFailure = {
        status: upstream.status,
        data,
        url,
      };
    } catch (error) {
      lastFailure = {
        status: 502,
        data:
          error instanceof Error
            ? error.message
            : "Safe Transaction Service no respondio",
        url,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return {
    ok: false,
    status: lastFailure?.status ?? 502,
    data: lastFailure?.data ?? "Safe Transaction Service no respondio",
    url: lastFailure?.url ?? null,
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
    response.setHeader("Cache-Control", "no-store");
    return response.status(204).end();
  }

  if (request.method !== "POST") {
    return json(request, response, 405, {
      error: "Metodo no permitido",
    });
  }

  const body = request.body ?? {};
  const chainId = body.chainId;
  const safeAddress = body.safeAddress;
  const payload = body.payload;

  const validationError = validateSafeProposal({
    chainId,
    safeAddress,
    payload,
  });

  if (validationError) {
    return json(request, response, 400, {
      error: validationError,
    });
  }

  const rateLimit = proposalRateLimit(
    request,
    safeAddress,
    payload.sender,
  );

  if (!rateLimit.allowed) {
    response.setHeader(
      "Retry-After",
      String(rateLimit.retryAfterSeconds),
    );

    return json(request, response, 429, {
      error: "Demasiadas propuestas Safe. Intenta nuevamente mas tarde.",
    });
  }

  const result = await postSafeProposal(
    Number(chainId),
    safeAddress,
    payload,
  );

  if (!result.ok) {
    return json(request, response, result.status, {
      error: "Safe Transaction Service rechazo la propuesta",
      status: result.status,
      detail: result.data,
      url: result.url,
    });
  }

  return json(request, response, result.status, {
    ok: true,
    status: result.status,
    response: result.data,
    url: result.url,
    safety: {
      operation: 0,
      delegateCallAllowed: false,
      originRestricted: true,
      rateLimited: true,
      serverStoresPrivateKeys: false,
    },
  });
}
