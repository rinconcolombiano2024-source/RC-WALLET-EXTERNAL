import { ethers } from "ethers";
import {
  readSession,
} from "../server/session.js";
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

const GELATO_SPONSORED_CALL_URL =
  process.env.GELATO_RELAY_SPONSORED_CALL_URL ||
  "https://relay.gelato.digital/relays/v2/sponsored-call";

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;
const HEX_PATTERN = /^0x(?:[a-fA-F0-9]{2})*$/;
const SIGNATURE_PATTERN = /^0x[a-fA-F0-9]{130}$/;
const UINT_PATTERN = /^(0|[1-9][0-9]*)$/;

const SAFE_EXEC_INTERFACE = new ethers.Interface([
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)",
]);

function configuredOrigins() {
  return String(process.env.RC_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function requestOriginAllowed(request) {
  const origin = String(request.headers.origin ?? "").trim();

  // Peticiones same-origin sin Origin pueden pasar.
  if (!origin) {
    return true;
  }

  const allowed = configuredOrigins();

  if (allowed.includes(origin)) {
    return true;
  }

  const forwardedHost =
    request.headers["x-forwarded-host"] ||
    request.headers.host;

  const forwardedProto =
    request.headers["x-forwarded-proto"] ||
    (process.env.NODE_ENV === "production"
      ? "https"
      : "http");

  if (forwardedHost) {
    const sameOrigin =
      `${forwardedProto}://${forwardedHost}`;

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
    response.setHeader(
      "Access-Control-Allow-Origin",
      origin,
    );

    response.setHeader(
      "Vary",
      "Origin",
    );
  }

  response.setHeader(
    "Access-Control-Allow-Credentials",
    "true",
  );

  response.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS",
  );

  response.setHeader(
    "Access-Control-Allow-Headers",
    "content-type",
  );
}

function json(request, response, status, body) {
  setCors(request, response);

  response.setHeader(
    "Cache-Control",
    "no-store",
  );

  return response.status(status).json(body);
}

function serviceUrl(chainId) {
  return SAFE_SERVICE_URLS[Number(chainId)]?.[0]?.replace(/\/+$/, "") ?? null;
}

function validAddress(value) {
  return typeof value === "string" && ADDRESS_PATTERN.test(value);
}

function validHex(value) {
  return typeof value === "string" && HEX_PATTERN.test(value);
}

function validUintString(value) {
  return typeof value === "string" && UINT_PATTERN.test(value);
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

function gelatoApiKey() {
  return (
    process.env.GELATO_RELAY_API_KEY ||
    process.env.GELATO_SPONSOR_API_KEY ||
    process.env.GELATO_1BALANCE_API_KEY ||
    ""
  );
}

function gelatoHeaders(apiKey) {
  return {
    accept: "application/json",
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
    "user-agent": "RC-Wallet-External/1.0",
  };
}

function validateRelayRequest({ chainId, safeTxHash }) {
  if (!Number.isInteger(Number(chainId))) {
    return "chainId invalido";
  }
  if (!serviceUrl(chainId)) {
    return "Red sin Safe Transaction Service configurado";
  }
  if (!HASH_PATTERN.test(safeTxHash ?? "")) {
    return "safeTxHash invalido";
  }
  if (!gelatoApiKey()) {
    return "Relay no configurado: agrega GELATO_RELAY_API_KEY en Vercel";
  }
  return null;
}

function requireAddress(value, field) {
  if (!validAddress(value)) {
    throw new Error(`${field} invalida`);
  }
  return ethers.getAddress(value);
}

function requireUint(value, field) {
  const normalized = String(value ?? "");
  if (!validUintString(normalized)) {
    throw new Error(`${field} invalido`);
  }
  return normalized;
}

function requireHex(value, field) {
  const normalized = value || "0x";
  if (!validHex(normalized)) {
    throw new Error(`${field} invalida`);
  }
  return normalized;
}

function requireOperation(value) {
  const operation = Number(value ?? 0);
  if (operation !== 0 && operation !== 1) {
    throw new Error("operation invalida");
  }
  return operation;
}

function normalizeSafeServiceTransaction(transaction) {
  return {
    safe: requireAddress(transaction.safe, "safe"),
    to: requireAddress(transaction.to, "to"),
    value: requireUint(transaction.value, "value"),
    data: requireHex(transaction.data, "data"),
    operation: requireOperation(transaction.operation),
    safeTxGas: requireUint(
      transaction.safeTxGas ?? transaction.safe_tx_gas,
      "safeTxGas",
    ),
    baseGas: requireUint(transaction.baseGas ?? transaction.base_gas, "baseGas"),
    gasPrice: requireUint(
      transaction.gasPrice ?? transaction.gas_price,
      "gasPrice",
    ),
    gasToken: requireAddress(
      transaction.gasToken ?? transaction.gas_token ?? ethers.ZeroAddress,
      "gasToken",
    ),
    refundReceiver: requireAddress(
      transaction.refundReceiver ??
        transaction.refund_receiver ??
        ethers.ZeroAddress,
      "refundReceiver",
    ),
    nonce: requireUint(transaction.nonce, "nonce"),
  };
}

function buildSafeExecutionSignatures(transaction) {
  const confirmations = Array.isArray(transaction.confirmations)
    ? transaction.confirmations
    : [];
  const confirmationsRequired = Number(
    transaction.confirmationsRequired ??
      transaction.confirmations_required ??
      transaction.threshold ??
      0,
  );
  const signaturesByOwner = new Map();

  for (const confirmation of confirmations) {
    const owner = confirmation.owner ?? confirmation.sender;
    const signature = confirmation.signature;
    if (!validAddress(owner) || !SIGNATURE_PATTERN.test(signature ?? "")) {
      continue;
    }
    const normalizedOwner = ethers.getAddress(owner);
    if (!signaturesByOwner.has(normalizedOwner)) {
      signaturesByOwner.set(normalizedOwner, signature);
    }
  }

  if (
    confirmationsRequired <= 0 ||
    signaturesByOwner.size < confirmationsRequired
  ) {
    throw new Error(
      `Safe Tx sin firmas suficientes (${signaturesByOwner.size}/${confirmationsRequired}).`,
    );
  }

  const sorted = [...signaturesByOwner.entries()].sort(([left], [right]) =>
    BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0,
  );

  return {
    owners: sorted.map(([owner]) => owner),
    signatures: `0x${sorted.map(([, signature]) => signature.slice(2)).join("")}`,
    confirmationsRequired,
  };
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

async function readSafeTransaction(chainId, safeTxHash) {
  const baseUrl = serviceUrl(chainId);
  const url = `${baseUrl}/api/v1/multisig-transactions/${safeTxHash}/`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20_000);

  try {
    const upstream = await fetch(url, {
      headers: safeApiHeaders(),
      signal: controller.signal,
    });
    const data = await readJsonResponse(upstream);

    if (!upstream.ok) {
      const error = new Error("Safe Transaction Service no encontro la transaccion");
      error.status = upstream.status;
      error.detail = data;
      error.url = url;
      throw error;
    }

    return { data, url, status: upstream.status };
  } finally {
    clearTimeout(timeoutId);
  }
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

  let session;

  try {
    session = readSession(request);
  } catch {
    return json(request, response, 503, {
      error:
        "La seguridad de sesión del servidor no está configurada correctamente.",
    });
  }

  if (!session) {
    return json(request, response, 401, {
      error:
        "Sesión World inválida o expirada. Inicia sesión nuevamente.",
    });
  }

  const rateLimit = relayRateLimit(request, session);

  if (!rateLimit.allowed) {
    response.setHeader(
      "Retry-After",
      String(rateLimit.retryAfterSeconds),
    );

    return json(request, response, 429, {
      error:
        "Demasiadas solicitudes de Relay. Intenta nuevamente más tarde.",
    });
  }

  const body = request.body ?? {};
  const chainId = body.chainId;
  const safeTxHash = body.safeTxHash;

  const validationError = validateRelayRequest({
    chainId,
    safeTxHash,
  });

  if (validationError) {
    return json(request, response, 400, {
      error: validationError,
    });
  }

  try {
    const safeLookup = await readSafeTransaction(
      chainId,
      safeTxHash,
    );

    const transaction =
      safeLookup.data?.response ??
      safeLookup.data;

    if (
      !transaction ||
      typeof transaction !== "object"
    ) {
      return json(request, response, 502, {
        error:
          "Safe Transaction Service devolvio una respuesta invalida",
        source: safeLookup,
      });
    }

    if (
      transaction.isExecuted ||
      transaction.is_executed
    ) {
      return json(request, response, 409, {
        error:
          "Esta Safe Tx ya aparece como ejecutada",
        safeTxHash,
      });
    }

    const safeTx =
      normalizeSafeServiceTransaction(
        transaction,
      );

    /*
     * P0 SECURITY:
     * La Safe que intenta utilizar nuestro patrocinio
     * debe coincidir exactamente con la wallet
     * autenticada mediante World SIWE.
     */
    if (
      safeTx.safe.toLowerCase() !==
      session.address.toLowerCase()
    ) {
      return json(request, response, 403, {
        error:
          "La Safe de la transacción no coincide con la cuenta World autenticada.",
      });
    }

    const executionSignatures =
      buildSafeExecutionSignatures(
        transaction,
      );

    const execData =
      SAFE_EXEC_INTERFACE.encodeFunctionData(
        "execTransaction",
        [
          safeTx.to,
          safeTx.value,
          safeTx.data,
          safeTx.operation,
          safeTx.safeTxGas,
          safeTx.baseGas,
          safeTx.gasPrice,
          safeTx.gasToken,
          safeTx.refundReceiver,
          executionSignatures.signatures,
        ],
      );

    const relayRequest = {
      chainId: Number(chainId),
      target: safeTx.safe,
      data: execData,
    };

    const controller =
      new AbortController();

    const timeoutId = setTimeout(
      () => controller.abort(),
      20_000,
    );

    try {
      const upstream = await fetch(
        GELATO_SPONSORED_CALL_URL,
        {
          method: "POST",
          headers: gelatoHeaders(
            gelatoApiKey(),
          ),
          body: JSON.stringify(
            relayRequest,
          ),
          signal: controller.signal,
        },
      );

      const relayResponse =
        await readJsonResponse(upstream);

      if (!upstream.ok) {
        return json(
          request,
          response,
          upstream.status,
          {
            error:
              "Gelato Relay rechazo la ejecucion patrocinada",
            status: upstream.status,
            detail: relayResponse,
            route:
              "safe-service-gelato-relay",
          },
        );
      }

      return json(
        request,
        response,
        200,
        {
          ok: true,
          route:
            "safe-service-gelato-relay",
          safeTxHash,
          chainId: Number(chainId),
          safe: safeTx.safe,
          taskId:
            relayResponse?.taskId ??
            relayResponse?.task_id ??
            null,

          signaturesUsed:
            executionSignatures.owners,

          confirmationsRequired:
            executionSignatures.confirmationsRequired,

          relay: {
            url:
              GELATO_SPONSORED_CALL_URL,
            status: upstream.status,
            response: relayResponse,
          },
        },
      );
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "No se pudo ejecutar por Relay";

    return json(
      request,
      response,
      error.status ?? 502,
      {
        error: message,
        detail:
          error.detail ?? null,
        url:
          error.url ?? null,
        route:
          "safe-service-gelato-relay",
      },
    );
  }
}
}
