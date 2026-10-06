import { ethers } from "ethers";
import {
  NETWORKS,
  SAFE_INTROSPECTION_ABI,
} from "../src/config.js";
import {
  readSession,
} from "../server/session.js";

const SAFE_SERVICE_URLS = Object.freeze({
  1: [
    "https://safe-transaction-mainnet.safe.global",
  ],
  10: [
    "https://safe-transaction-optimism.safe.global",
  ],
  56: [
    "https://safe-transaction-bsc.safe.global",
  ],
  480: [
    "https://safe-transaction-worldchain.safe.global",
    "https://safe-transaction-world-chain.safe.global",
  ],
  8453: [
    "https://safe-transaction-base.safe.global",
  ],
});

const GELATO_SPONSORED_CALL_URL =
  process.env.GELATO_RELAY_SPONSORED_CALL_URL ||
  "https://relay.gelato.digital/relays/v2/sponsored-call";

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;
const HEX_PATTERN = /^0x(?:[a-fA-F0-9]{2})*$/;
const SIGNATURE_PATTERN = /^0x[a-fA-F0-9]{130}$/;
const UINT_PATTERN = /^(0|[1-9][0-9]*)$/;

const RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT = 5;
const MAX_RATE_LIMIT = 20;
const MAX_REQUEST_BODY_BYTES = 8_192;
const SAFE_SERVICE_TIMEOUT_MS = 15_000;
const GELATO_TIMEOUT_MS = 20_000;
const RPC_TIMEOUT_MS = 8_000;
const MAX_SAFE_DATA_BYTES = 4_096;

const ZERO_ADDRESS = ethers.ZeroAddress;
const ERC20_TRANSFER_SELECTOR = "0xa9059cbb";

const SAFE_EXEC_INTERFACE = new ethers.Interface([
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)",
]);

const ERC20_TRANSFER_INTERFACE = new ethers.Interface([
  "function transfer(address to,uint256 value) returns (bool)",
]);

const relayRateBuckets =
  globalThis.__rcWalletRelayRateBuckets ??
  new Map();

globalThis.__rcWalletRelayRateBuckets =
  relayRateBuckets;

function timeout(promise, milliseconds, label) {
  let timeoutId;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(
        new Error(`${label}: tiempo de espera agotado`),
      ),
      milliseconds,
    );
  });

  return Promise.race([
    promise,
    timeoutPromise,
  ]).finally(() => {
    clearTimeout(timeoutId);
  });
}

function configuredOrigins() {
  return String(
    process.env.RC_ALLOWED_ORIGINS ?? "",
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function requestOriginAllowed(request) {
  const origin = String(
    request.headers?.origin ?? "",
  ).trim();

  if (!origin) {
    return true;
  }

  if (
    configuredOrigins().includes(origin)
  ) {
    return true;
  }

  const forwardedHost =
    request.headers?.["x-forwarded-host"] ||
    request.headers?.host;

  const forwardedProto =
    request.headers?.["x-forwarded-proto"] ||
    (
      process.env.NODE_ENV === "production"
        ? "https"
        : "http"
    );

  if (forwardedHost) {
    const sameOrigin =
      `${forwardedProto}://${forwardedHost}`;

    if (origin === sameOrigin) {
      return true;
    }
  }

  if (
    process.env.NODE_ENV !== "production" &&
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(
      origin,
    )
  ) {
    return true;
  }

  return false;
}

function setCors(request, response) {
  const origin = String(
    request.headers?.origin ?? "",
  ).trim();

  if (
    origin &&
    requestOriginAllowed(request)
  ) {
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

function json(
  request,
  response,
  status,
  body,
) {
  setCors(request, response);

  response.setHeader(
    "Cache-Control",
    "no-store, max-age=0",
  );
  response.setHeader(
    "Pragma",
    "no-cache",
  );
  response.setHeader(
    "X-Content-Type-Options",
    "nosniff",
  );

  return response
    .status(status)
    .json(body);
}

function clientIp(request) {
  const forwarded =
    request.headers?.["x-forwarded-for"];

  if (
    typeof forwarded === "string"
  ) {
    return (
      forwarded
        .split(",")[0]
        ?.trim() ||
      "unknown"
    );
  }

  return (
    request.headers?.["x-real-ip"] ||
    "unknown"
  );
}

function configuredRateLimit() {
  const parsed =
    Number.parseInt(
      process.env
        .RC_RELAY_MAX_PER_MINUTE ??
        "",
      10,
    );

  if (
    Number.isInteger(parsed) &&
    parsed > 0
  ) {
    return Math.min(
      parsed,
      MAX_RATE_LIMIT,
    );
  }

  return DEFAULT_RATE_LIMIT;
}

function relayRateLimit(
  request,
  session,
) {
  const now = Date.now();
  const limit =
    configuredRateLimit();

  const key =
    `${session.address}:${clientIp(request)}`;

  const previous =
    relayRateBuckets.get(key) ??
    [];

  const active =
    previous.filter(
      (timestamp) =>
        now - timestamp <
        RATE_LIMIT_WINDOW_MS,
    );

  if (
    active.length >= limit
  ) {
    return {
      allowed: false,
      retryAfterSeconds:
        Math.max(
          1,
          Math.ceil(
            (
              RATE_LIMIT_WINDOW_MS -
              (
                now -
                (
                  active[0] ??
                  now
                )
              )
            ) / 1000,
          ),
        ),
    };
  }

  active.push(now);
  relayRateBuckets.set(
    key,
    active,
  );

  if (
    relayRateBuckets.size > 2_000
  ) {
    for (
      const [
        bucketKey,
        timestamps,
      ] of relayRateBuckets
    ) {
      const stillActive =
        timestamps.filter(
          (timestamp) =>
            now - timestamp <
            RATE_LIMIT_WINDOW_MS,
        );

      if (!stillActive.length) {
        relayRateBuckets.delete(
          bucketKey,
        );
      } else {
        relayRateBuckets.set(
          bucketKey,
          stillActive,
        );
      }

      if (
        relayRateBuckets.size <=
        1_500
      ) {
        break;
      }
    }
  }

  return {
    allowed: true,
    remaining:
      Math.max(
        0,
        limit -
          active.length,
      ),
  };
}

function requestBodyTooLarge(
  request,
) {
  const contentLength =
    Number.parseInt(
      String(
        request.headers?.[
          "content-length"
        ] ?? "",
      ),
      10,
    );

  if (
    Number.isFinite(
      contentLength,
    ) &&
    contentLength >
      MAX_REQUEST_BODY_BYTES
  ) {
    return true;
  }

  try {
    return (
      Buffer.byteLength(
        JSON.stringify(
          request.body ?? {},
        ),
        "utf8",
      ) >
      MAX_REQUEST_BODY_BYTES
    );
  } catch {
    return true;
  }
}

function serviceUrls(chainId) {
  return (
    SAFE_SERVICE_URLS[
      Number(chainId)
    ] ?? []
  ).map((url) =>
    String(url).replace(
      /\/+$/,
      "",
    ),
  );
}

function networkByChainId(
  chainId,
) {
  return (
    NETWORKS.find(
      (network) =>
        Number(
          network.chainId,
        ) ===
        Number(chainId),
    ) ?? null
  );
}

function validAddress(value) {
  return (
    typeof value === "string" &&
    ADDRESS_PATTERN.test(value)
  );
}

function requireAddress(
  value,
  field,
) {
  if (!validAddress(value)) {
    throw new Error(
      `${field} invalida`,
    );
  }

  return ethers.getAddress(
    value,
  );
}

function requireNonZeroAddress(
  value,
  field,
) {
  const address =
    requireAddress(
      value,
      field,
    );

  if (
    address === ZERO_ADDRESS
  ) {
    throw new Error(
      `${field} no puede ser address(0)`,
    );
  }

  return address;
}

function requireUint(
  value,
  field,
) {
  const normalized =
    String(value ?? "");

  if (
    !UINT_PATTERN.test(
      normalized,
    )
  ) {
    throw new Error(
      `${field} invalido`,
    );
  }

  const bigint =
    BigInt(normalized);

  const maxUint256 =
    (1n << 256n) - 1n;

  if (
    bigint < 0n ||
    bigint > maxUint256
  ) {
    throw new Error(
      `${field} fuera de uint256`,
    );
  }

  return bigint;
}

function requireHex(
  value,
  field,
) {
  const normalized =
    value || "0x";

  if (
    typeof normalized !==
      "string" ||
    !HEX_PATTERN.test(
      normalized,
    )
  ) {
    throw new Error(
      `${field} invalida`,
    );
  }

  if (
    ethers.getBytes(
      normalized,
    ).length >
    MAX_SAFE_DATA_BYTES
  ) {
    throw new Error(
      `${field} demasiado grande`,
    );
  }

  return normalized;
}

function requireOperation(value) {
  const operation =
    Number(value ?? 0);

  if (operation !== 0) {
    throw new Error(
      "RC Wallet Relay solo permite Safe CALL (operation=0). DELEGATECALL esta bloqueado.",
    );
  }

  return operation;
}

function normalizeSafeServiceTransaction(
  transaction,
) {
  if (
    !transaction ||
    typeof transaction !==
      "object" ||
    Array.isArray(transaction)
  ) {
    throw new Error(
      "Safe Transaction Service devolvio una transaccion invalida",
    );
  }

  return {
    safe:
      requireNonZeroAddress(
        transaction.safe,
        "safe",
      ),

    to:
      requireNonZeroAddress(
        transaction.to,
        "to",
      ),

    value:
      requireUint(
        transaction.value,
        "value",
      ),

    data:
      requireHex(
        transaction.data,
        "data",
      ),

    operation:
      requireOperation(
        transaction.operation,
      ),

    safeTxGas:
      requireUint(
        transaction.safeTxGas ??
          transaction.safe_tx_gas ??
          "0",
        "safeTxGas",
      ),

    baseGas:
      requireUint(
        transaction.baseGas ??
          transaction.base_gas ??
          "0",
        "baseGas",
      ),

    gasPrice:
      requireUint(
        transaction.gasPrice ??
          transaction.gas_price ??
          "0",
        "gasPrice",
      ),

    gasToken:
      requireAddress(
        transaction.gasToken ??
          transaction.gas_token ??
          ZERO_ADDRESS,
        "gasToken",
      ),

    refundReceiver:
      requireAddress(
        transaction.refundReceiver ??
          transaction.refund_receiver ??
          ZERO_ADDRESS,
        "refundReceiver",
      ),

    nonce:
      requireUint(
        transaction.nonce,
        "nonce",
      ),
  };
}

function classifyRecoveryCall(
  safeTx,
) {
  if (
    safeTx.data === "0x"
  ) {
    if (
      safeTx.value <= 0n
    ) {
      throw new Error(
        "Relay nativo bloqueado: el valor debe ser mayor que cero",
      );
    }

    if (
      safeTx.to ===
      safeTx.safe
    ) {
      throw new Error(
        "Relay nativo bloqueado: el destino no puede ser la misma Safe",
      );
    }

    return {
      kind:
        "native-transfer",
      recipient:
        safeTx.to,
      amount:
        safeTx.value.toString(),
      token:
        null,
    };
  }

  if (
    safeTx.value !== 0n
  ) {
    throw new Error(
      "Relay ERC20 bloqueado: value debe ser cero",
    );
  }

  if (
    !safeTx.data
      .toLowerCase()
      .startsWith(
        ERC20_TRANSFER_SELECTOR,
      )
  ) {
    throw new Error(
      "RC Wallet Relay solo patrocina transferencias nativas o ERC20.transfer(address,uint256)",
    );
  }

  let decoded;

  try {
    decoded =
      ERC20_TRANSFER_INTERFACE
        .decodeFunctionData(
          "transfer",
          safeTx.data,
        );
  } catch {
    throw new Error(
      "No se pudo decodificar ERC20.transfer",
    );
  }

  const recipient =
    requireNonZeroAddress(
      decoded[0],
      "recipient",
    );

  const amount =
    BigInt(decoded[1]);

  if (amount <= 0n) {
    throw new Error(
      "Relay ERC20 bloqueado: el monto debe ser mayor que cero",
    );
  }

  if (
    recipient === safeTx.safe
  ) {
    throw new Error(
      "Relay ERC20 bloqueado: el destinatario no puede ser la misma Safe",
    );
  }

  return {
    kind:
      "erc20-transfer",
    token:
      safeTx.to,
    recipient,
    amount:
      amount.toString(),
  };
}

function safeApiHeaders() {
  const apiKey =
    process.env.SAFE_API_KEY ||
    process.env.SAFE_GLOBAL_API_KEY ||
    process.env
      .SAFE_TRANSACTION_SERVICE_API_KEY ||
    "";

  const headers = {
    accept:
      "application/json",
    "user-agent":
      "RC-Wallet-External/1.0",
  };

  if (apiKey) {
    headers.authorization =
      `Bearer ${apiKey}`;
  }

  return headers;
}

function gelatoApiKey() {
  return (
    process.env
      .GELATO_RELAY_API_KEY ||
    process.env
      .GELATO_SPONSOR_API_KEY ||
    process.env
      .GELATO_1BALANCE_API_KEY ||
    ""
  );
}

function gelatoHeaders(
  apiKey,
) {
  return {
    accept:
      "application/json",
    "content-type":
      "application/json",
    authorization:
      `Bearer ${apiKey}`,
    "user-agent":
      "RC-Wallet-External/1.0",
  };
}

function validateRelayRequest({
  chainId,
  safeTxHash,
}) {
  const numericChainId =
    Number(chainId);

  if (
    !Number.isSafeInteger(
      numericChainId,
    ) ||
    numericChainId <= 0
  ) {
    return "chainId invalido";
  }

  if (
    !networkByChainId(
      numericChainId,
    )
  ) {
    return "Red no configurada en RC Wallet";
  }

  if (
    !serviceUrls(
      numericChainId,
    ).length
  ) {
    return "Red sin Safe Transaction Service configurado";
  }

  if (
    typeof safeTxHash !==
      "string" ||
    !HASH_PATTERN.test(
      safeTxHash,
    )
  ) {
    return "safeTxHash invalido";
  }

  if (!gelatoApiKey()) {
    return "Relay no configurado: agrega GELATO_RELAY_API_KEY en Vercel";
  }

  return null;
}

async function readJsonResponse(
  upstream,
) {
  const text =
    await upstream.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(
      text,
    );
  } catch {
    return text.slice(
      0,
      800,
    );
  }
}

async function fetchSafeTransaction({
  baseUrl,
  safeTxHash,
}) {
  const url =
    `${baseUrl}/api/v1/multisig-transactions/${safeTxHash}/`;

  const controller =
    new AbortController();

  const timeoutId =
    setTimeout(
      () =>
        controller.abort(),
      SAFE_SERVICE_TIMEOUT_MS,
    );

  try {
    const upstream =
      await fetch(
        url,
        {
          headers:
            safeApiHeaders(),
          signal:
            controller.signal,
        },
      );

    const data =
      await readJsonResponse(
        upstream,
      );

    return {
      upstream,
      data,
      url,
    };
  } finally {
    clearTimeout(
      timeoutId,
    );
  }
}

async function readSafeTransaction(
  chainId,
  safeTxHash,
) {
  const endpoints =
    serviceUrls(chainId);

  const failures = [];
  let sawNotFound = false;

  for (
    const baseUrl of
    endpoints
  ) {
    try {
      const result =
        await fetchSafeTransaction({
          baseUrl,
          safeTxHash,
        });

      if (
        result.upstream.ok
      ) {
        const transaction =
          result.data?.response ??
          result.data;

        if (
          !transaction ||
          typeof transaction !==
            "object" ||
          Array.isArray(
            transaction,
          )
        ) {
          throw new Error(
            "Safe Transaction Service devolvio una respuesta invalida",
          );
        }

        const returnedHash =
          transaction.safeTxHash ??
          transaction.safe_tx_hash ??
          transaction.contractTransactionHash ??
          transaction.contract_transaction_hash ??
          null;

        if (
          returnedHash !== null &&
          (
            typeof returnedHash !==
              "string" ||
            !HASH_PATTERN.test(
              returnedHash,
            ) ||
            returnedHash
              .toLowerCase() !==
              safeTxHash
                .toLowerCase()
          )
        ) {
          throw new Error(
            "Safe Transaction Service devolvio un safeTxHash distinto",
          );
        }

        return {
          transaction,
          url:
            result.url,
          status:
            result.upstream
              .status,
        };
      }

      if (
        result.upstream.status ===
        404
      ) {
        sawNotFound = true;
        failures.push({
          url: result.url,
          status: 404,
          detail:
            result.data,
        });
        continue;
      }

      if (
        result.upstream.status >=
        500
      ) {
        failures.push({
          url: result.url,
          status:
            result.upstream
              .status,
          detail:
            result.data,
        });
        continue;
      }

      const error =
        new Error(
          "Safe Transaction Service rechazo la consulta",
        );

      error.status =
        result.upstream.status;
      error.detail =
        result.data;
      error.url =
        result.url;

      throw error;
    } catch (error) {
      if (
        error?.status &&
        error.status < 500 &&
        error.status !== 404
      ) {
        throw error;
      }

      failures.push({
        url:
          `${baseUrl}/api/v1/multisig-transactions/${safeTxHash}/`,
        status:
          error?.status ??
          null,
        detail:
          error instanceof Error
            ? error.message
            : "Safe Transaction Service no respondio",
      });
    }
  }

  const error =
    new Error(
      sawNotFound
        ? "Safe Transaction Service no encontro la transaccion"
        : "No se pudo contactar Safe Transaction Service",
    );

  error.status =
    sawNotFound
      ? 404
      : 502;

  error.detail =
    failures;

  throw error;
}

async function getProvider(
  network,
) {
  const errors = [];

  for (
    const rpcUrl of
    network.rpcUrls ?? []
  ) {
    let provider;

    try {
      provider =
        new ethers.JsonRpcProvider(
          rpcUrl,
          network.chainId,
          {
            staticNetwork:
              true,
            batchMaxCount:
              1,
          },
        );

      const [
        providerNetwork,
        latestBlock,
      ] =
        await Promise.all([
          timeout(
            provider.getNetwork(),
            RPC_TIMEOUT_MS,
            `${network.name} network`,
          ),
          timeout(
            provider.getBlockNumber(),
            RPC_TIMEOUT_MS,
            `${network.name} block`,
          ),
        ]);

      if (
        Number(
          providerNetwork.chainId,
        ) !==
        Number(
          network.chainId,
        )
      ) {
        throw new Error(
          "RPC devolvio chainId distinta",
        );
      }

      if (
        !Number.isInteger(
          latestBlock,
        ) ||
        latestBlock < 0
      ) {
        throw new Error(
          "RPC devolvio bloque invalido",
        );
      }

      return provider;
    } catch (error) {
      try {
        provider?.destroy?.();
      } catch {
        // Ignore provider cleanup failure.
      }

      errors.push(
        `${rpcUrl}: ${
          error instanceof Error
            ? error.message
            : "RPC fallido"
        }`,
      );
    }
  }

  throw new Error(
    `No hay RPC utilizable para ${network.name}. ${errors.join(" | ")}`,
  );
}

function normalizeLiveOwners(
  owners,
) {
  if (
    !Array.isArray(owners)
  ) {
    throw new Error(
      "Safe owners invalidos",
    );
  }

  const normalized =
    owners.map((owner) =>
      requireNonZeroAddress(
        owner,
        "Safe owner",
      ),
    );

  if (!normalized.length) {
    throw new Error(
      "Safe sin owners",
    );
  }

  return normalized;
}

function recoverConfirmationSigner(
  safeTxHash,
  signature,
) {
  if (
    typeof signature !==
      "string" ||
    !SIGNATURE_PATTERN.test(
      signature,
    )
  ) {
    throw new Error(
      "Firma Safe EOA invalida",
    );
  }

  const bytes =
    ethers.getBytes(
      signature,
    );

  const r =
    ethers.hexlify(
      bytes.slice(
        0,
        32,
      ),
    );

  const s =
    ethers.hexlify(
      bytes.slice(
        32,
        64,
      ),
    );

  const rawV =
    Number(
      bytes[64],
    );

  if (
    rawV === 27 ||
    rawV === 28
  ) {
    return ethers.recoverAddress(
      safeTxHash,
      {
        r,
        s,
        v: rawV,
      },
    );
  }

  if (
    rawV === 31 ||
    rawV === 32
  ) {
    const ethSignedHash =
      ethers.hashMessage(
        ethers.getBytes(
          safeTxHash,
        ),
      );

    return ethers.recoverAddress(
      ethSignedHash,
      {
        r,
        s,
        v:
          rawV - 4,
      },
    );
  }

  throw new Error(
    `Tipo de firma Safe no permitido por Relay (v=${rawV})`,
  );
}

function buildVerifiedExecutionSignatures({
  transaction,
  safeTxHash,
  liveOwners,
  liveThreshold,
}) {
  const confirmations =
    Array.isArray(
      transaction.confirmations,
    )
      ? transaction.confirmations
      : [];

  const liveOwnerMap =
    new Map(
      liveOwners.map(
        (owner) => [
          owner.toLowerCase(),
          owner,
        ],
      ),
    );

  const signaturesByOwner =
    new Map();

  for (
    const confirmation of
    confirmations
  ) {
    const claimedOwnerRaw =
      confirmation?.owner ??
      confirmation?.sender ??
      null;

    const signature =
      confirmation?.signature ??
      null;

    if (
      !validAddress(
        claimedOwnerRaw,
      ) ||
      typeof signature !==
        "string" ||
      !SIGNATURE_PATTERN.test(
        signature,
      )
    ) {
      continue;
    }

    const claimedOwner =
      ethers.getAddress(
        claimedOwnerRaw,
      );

    if (
      !liveOwnerMap.has(
        claimedOwner.toLowerCase(),
      )
    ) {
      continue;
    }

    let recovered;

    try {
      recovered =
        recoverConfirmationSigner(
          safeTxHash,
          signature,
        );
    } catch {
      continue;
    }

    if (
      recovered.toLowerCase() !==
      claimedOwner.toLowerCase()
    ) {
      continue;
    }

    if (
      !signaturesByOwner.has(
        claimedOwner.toLowerCase(),
      )
    ) {
      signaturesByOwner.set(
        claimedOwner.toLowerCase(),
        {
          owner:
            claimedOwner,
          signature,
        },
      );
    }
  }

  if (
    signaturesByOwner.size <
    liveThreshold
  ) {
    throw new Error(
      `Safe Tx sin firmas EOA verificadas suficientes (${signaturesByOwner.size}/${liveThreshold}).`,
    );
  }

  const sorted =
    [
      ...signaturesByOwner
        .values(),
    ].sort(
      (left, right) => {
        const a =
          BigInt(
            left.owner,
          );
        const b =
          BigInt(
            right.owner,
          );

        return (
          a < b
            ? -1
            : a > b
              ? 1
              : 0
        );
      },
    );

  return {
    owners:
      sorted.map(
        (item) =>
          item.owner,
      ),

    signatures:
      `0x${sorted
        .map(
          (item) =>
            item.signature.slice(
              2,
            ),
        )
        .join("")}`,

    confirmationsRequired:
      liveThreshold,
  };
}

async function verifySafeTransactionOnChain({
  provider,
  safeTx,
  transaction,
  safeTxHash,
}) {
  const safeCode =
    await timeout(
      provider.getCode(
        safeTx.safe,
      ),
      RPC_TIMEOUT_MS,
      "Safe code",
    );

  if (
    !safeCode ||
    safeCode === "0x"
  ) {
    throw new Error(
      "La Safe no esta desplegada en esta red",
    );
  }

  const safeContract =
    new ethers.Contract(
      safeTx.safe,
      SAFE_INTROSPECTION_ABI,
      provider,
    );

  const [
    ownersRaw,
    thresholdRaw,
    liveNonceRaw,
    liveSafeTxHash,
  ] =
    await Promise.all([
      timeout(
        safeContract.getOwners(),
        RPC_TIMEOUT_MS,
        "Safe owners",
      ),
      timeout(
        safeContract.getThreshold(),
        RPC_TIMEOUT_MS,
        "Safe threshold",
      ),
      timeout(
        safeContract.nonce(),
        RPC_TIMEOUT_MS,
        "Safe nonce",
      ),
      timeout(
        safeContract.getTransactionHash(
          safeTx.to,
          safeTx.value,
          safeTx.data,
          safeTx.operation,
          safeTx.safeTxGas,
          safeTx.baseGas,
          safeTx.gasPrice,
          safeTx.gasToken,
          safeTx.refundReceiver,
          safeTx.nonce,
        ),
        RPC_TIMEOUT_MS,
        "Safe transaction hash",
      ),
    ]);

  const owners =
    normalizeLiveOwners(
      ownersRaw,
    );

  const threshold =
    Number(
      thresholdRaw,
    );

  if (
    !Number.isSafeInteger(
      threshold,
    ) ||
    threshold <= 0 ||
    threshold >
      owners.length
  ) {
    throw new Error(
      "Threshold Safe invalido",
    );
  }

  const liveNonce =
    BigInt(
      liveNonceRaw,
    );

  if (
    liveNonce !==
    safeTx.nonce
  ) {
    const error =
      new Error(
        `Nonce Safe no ejecutable ahora: servicio=${safeTx.nonce.toString()} on-chain=${liveNonce.toString()}`,
      );

    error.status = 409;
    throw error;
  }

  if (
    String(
      liveSafeTxHash,
    ).toLowerCase() !==
    safeTxHash.toLowerCase()
  ) {
    throw new Error(
      "El safeTxHash recalculado on-chain NO coincide con la transaccion solicitada",
    );
  }

  const serviceRequired =
    Number(
      transaction
        .confirmationsRequired ??
        transaction
          .confirmations_required ??
        threshold,
    );

  if (
    Number.isFinite(
      serviceRequired,
    ) &&
    serviceRequired > 0 &&
    serviceRequired !==
      threshold
  ) {
    throw new Error(
      `Threshold inconsistente: servicio=${serviceRequired} on-chain=${threshold}`,
    );
  }

  const executionSignatures =
    buildVerifiedExecutionSignatures({
      transaction,
      safeTxHash,
      liveOwners:
        owners,
      liveThreshold:
        threshold,
    });

  const call =
    classifyRecoveryCall(
      safeTx,
    );

  if (
    call.kind ===
    "erc20-transfer"
  ) {
    const tokenCode =
      await timeout(
        provider.getCode(
          call.token,
        ),
        RPC_TIMEOUT_MS,
        "ERC20 code",
      );

    if (
      !tokenCode ||
      tokenCode === "0x"
    ) {
      throw new Error(
        "La direccion token no contiene contrato en la red destino",
      );
    }
  }

  return {
    owners,
    threshold,
    liveNonce,
    liveSafeTxHash,
    executionSignatures,
    call,
  };
}

async function simulateSafeExecution({
  provider,
  safeTx,
  signatures,
}) {
  const execData =
    SAFE_EXEC_INTERFACE
      .encodeFunctionData(
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
          signatures,
        ],
      );

  const rawResult =
    await timeout(
      provider.call({
        to:
          safeTx.safe,
        data:
          execData,
      }),
      RPC_TIMEOUT_MS,
      "Safe execTransaction simulation",
    );

  let success;

  try {
    [success] =
      SAFE_EXEC_INTERFACE
        .decodeFunctionResult(
          "execTransaction",
          rawResult,
        );
  } catch {
    throw new Error(
      "No se pudo decodificar la simulacion de Safe",
    );
  }

  if (!success) {
    throw new Error(
      "La simulacion Safe devuelve false. Relay bloqueado antes de gastar patrocinio.",
    );
  }

  return {
    success: true,
    execData,
  };
}

async function submitGelato({
  chainId,
  target,
  data,
}) {
  const relayRequest = {
    chainId:
      Number(chainId),
    target,
    data,
  };

  const controller =
    new AbortController();

  const timeoutId =
    setTimeout(
      () =>
        controller.abort(),
      GELATO_TIMEOUT_MS,
    );

  try {
    const upstream =
      await fetch(
        GELATO_SPONSORED_CALL_URL,
        {
          method:
            "POST",

          headers:
            gelatoHeaders(
              gelatoApiKey(),
            ),

          body:
            JSON.stringify(
              relayRequest,
            ),

          signal:
            controller.signal,
        },
      );

    const relayResponse =
      await readJsonResponse(
        upstream,
      );

    if (!upstream.ok) {
      const error =
        new Error(
          "Gelato Relay rechazo la ejecucion patrocinada",
        );

      error.status =
        upstream.status;
      error.detail =
        relayResponse;
      error.url =
        GELATO_SPONSORED_CALL_URL;

      throw error;
    }

    const taskId =
      relayResponse?.taskId ??
      relayResponse?.task_id ??
      null;

    if (
      typeof taskId !==
        "string" ||
      !taskId.trim()
    ) {
      const error =
        new Error(
          "Gelato Relay respondio sin taskId verificable",
        );

      error.status = 502;
      error.detail =
        relayResponse;

      throw error;
    }

    return {
      taskId,
      status:
        upstream.status,
      response:
        relayResponse,
      request:
        relayRequest,
    };
  } finally {
    clearTimeout(
      timeoutId,
    );
  }
}

export default async function handler(
  request,
  response,
) {
  if (
    !requestOriginAllowed(
      request,
    )
  ) {
    return response
      .status(403)
      .json({
        error:
          "Origin no autorizado",
      });
  }

  setCors(
    request,
    response,
  );

  if (
    request.method ===
    "OPTIONS"
  ) {
    return response
      .status(204)
      .end();
  }

  if (
    request.method !==
    "POST"
  ) {
    return json(
      request,
      response,
      405,
      {
        error:
          "Metodo no permitido",
      },
    );
  }

  if (
    requestBodyTooLarge(
      request,
    )
  ) {
    return json(
      request,
      response,
      413,
      {
        error:
          "Solicitud demasiado grande",
      },
    );
  }

  let session;

  try {
    session =
      readSession(
        request,
      );
  } catch {
    return json(
      request,
      response,
      503,
      {
        error:
          "La seguridad de sesion del servidor no esta configurada correctamente.",
      },
    );
  }

  if (!session) {
    return json(
      request,
      response,
      401,
      {
        error:
          "Sesion World invalida o expirada. Inicia sesion nuevamente.",
      },
    );
  }

  const rateLimit =
    relayRateLimit(
      request,
      session,
    );

  if (
    !rateLimit.allowed
  ) {
    response.setHeader(
      "Retry-After",
      String(
        rateLimit.retryAfterSeconds,
      ),
    );

    return json(
      request,
      response,
      429,
      {
        error:
          "Demasiadas solicitudes de Relay. Intenta nuevamente mas tarde.",
      },
    );
  }

  const body =
    request.body ?? {};

  const chainId =
    body.chainId;

  const safeTxHash =
    body.safeTxHash;

  const validationError =
    validateRelayRequest({
      chainId,
      safeTxHash,
    });

  if (validationError) {
    return json(
      request,
      response,
      400,
      {
        error:
          validationError,
      },
    );
  }

  const network =
    networkByChainId(
      chainId,
    );

  let provider;

  try {
    const safeLookup =
      await readSafeTransaction(
        Number(chainId),
        safeTxHash,
      );

    const transaction =
      safeLookup.transaction;

    if (
      transaction
        .isExecuted ||
      transaction
        .is_executed
    ) {
      return json(
        request,
        response,
        409,
        {
          error:
            "Esta Safe Tx ya aparece como ejecutada",
          safeTxHash,
        },
      );
    }

    const safeTx =
      normalizeSafeServiceTransaction(
        transaction,
      );

    /*
     * Patrocinio RC Wallet:
     * la sesion World autoriza exactamente la Safe
     * que recibe el patrocinio.
     *
     * Si el usuario solo tiene el owner EOA externo,
     * puede ejecutar por la ruta de pagador de gas
     * externo; el Relay no relaja esta barrera.
     */
    if (
      safeTx.safe
        .toLowerCase() !==
      String(
        session.address,
      ).toLowerCase()
    ) {
      return json(
        request,
        response,
        403,
        {
          error:
            "La Safe de la transaccion no coincide con la cuenta World autenticada.",
        },
      );
    }

    provider =
      await getProvider(
        network,
      );

    const verified =
      await verifySafeTransactionOnChain({
        provider,
        safeTx,
        transaction,
        safeTxHash,
      });

    const simulation =
      await simulateSafeExecution({
        provider,
        safeTx,
        signatures:
          verified
            .executionSignatures
            .signatures,
      });

    const relay =
      await submitGelato({
        chainId:
          Number(chainId),
        target:
          safeTx.safe,
        data:
          simulation.execData,
      });

    return json(
      request,
      response,
      200,
      {
        ok: true,

        route:
          "safe-service-gelato-relay",

        safeTxHash,

        chainId:
          Number(chainId),

        safe:
          safeTx.safe,

        taskId:
          relay.taskId,

        transfer: {
          kind:
            verified.call.kind,

          token:
            verified.call.token,

          recipient:
            verified.call.recipient,

          amount:
            verified.call.amount,
        },

        signaturesUsed:
          verified
            .executionSignatures
            .owners,

        confirmationsRequired:
          verified.threshold,

        security: {
          sessionMatchesSafe:
            true,

          operation:
            0,

          delegateCallBlocked:
            true,

          recoveryCallRestricted:
            true,

          safeTxHashVerifiedOnChain:
            true,

          liveNonceVerified:
            true,

          ownersVerifiedOnChain:
            true,

          thresholdVerifiedOnChain:
            true,

          signaturesVerified:
            true,

          simulationPassed:
            true,
        },

        relay: {
          url:
            GELATO_SPONSORED_CALL_URL,

          status:
            relay.status,

          response:
            relay.response,
        },
      },
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "No se pudo ejecutar por Relay";

    return json(
      request,
      response,
      error?.status ??
        502,
      {
        error:
          message,

        detail:
          error?.detail ??
          null,

        url:
          error?.url ??
          null,

        route:
          "safe-service-gelato-relay",
      },
    );
  } finally {
    try {
      provider?.destroy?.();
    } catch {
      // Ignore cleanup errors.
    }
  }
}
