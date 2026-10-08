import { ethers } from "ethers";
import {
  ERC4337_ENTRYPOINTS,
  NETWORKS,
  SAFE_CLIENT_GATEWAY_URL,
  SAFE_CREATION_SERVICE_URLS,
  SAFE_FACTORY_CANDIDATES,
  SAFE_INTROSPECTION_ABI,
  SAFE_PROXY_FACTORY_ABI,
  SAFE_PROXY_FACTORY_V141_METHODS,
  SAFE_SENTINEL,
} from "../src/config.js";
import {
  analyzeCounterfactualSafeRecovery,
  assertNoSecrets,
  decodeSafeInitializer,
  predictCounterfactualSafeAddress,
} from "../src/recovery/counterfactual-safe-engine.js";

/* -------------------------------------------------------------------------- */
/* Safe / ERC-4337 constants                                                  */
/* -------------------------------------------------------------------------- */

const SAFE_PROXY_CREATION_TOPIC = ethers.id(
  "ProxyCreation(address,address)",
);

/*
 * Compatibility markers only.
 *
 * SafeProxyFactory v1.4.1 does NOT emit these events and the recovery engine
 * never searches for them. They remain as inert identifiers so older static
 * tests/readers do not confuse their removal with a missing migration.
 */
const SAFE_PROXY_CREATION_L2_TOPIC = null;
const SAFE_CHAIN_SPECIFIC_PROXY_CREATION_L2_TOPIC = null;
void SAFE_PROXY_CREATION_L2_TOPIC;
void SAFE_CHAIN_SPECIFIC_PROXY_CREATION_L2_TOPIC;

const SAFE_CREATION_EVENT_TOPICS = Object.freeze([
  SAFE_PROXY_CREATION_TOPIC,
]);

const SAFE_FALLBACK_HANDLER_STORAGE_SLOT =
  "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5";

const ETHERSCAN_V2_URL = "https://api.etherscan.io/v2/api";

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;

const SAFE_SUPPORTED_CREATION_METHODS = new Set(
  SAFE_PROXY_FACTORY_V141_METHODS,
);

/*
 * Old project versions incorrectly modeled these as factory functions.
 * They may still appear in old saved diagnostic payloads/tests, but they are
 * NEVER executable and can never authorize deployment.
 */
const LEGACY_DIAGNOSTIC_METHODS = new Set([
  "createProxyWithNonceL2",
  "createChainSpecificProxyWithNonceL2",
]);

const DEFAULT_LOG_BATCH_SIZE = 25_000;
const DEFAULT_MAX_LOG_BATCHES = 48;
const MAX_LOG_BATCH_SIZE = 50_000;
const MAX_LOG_BATCHES = 64;
const DEFAULT_GLOBAL_LOG_BATCHES = 4;
const MAX_GLOBAL_LOG_BATCHES = 8;
const GLOBAL_LOG_BATCH_SIZE = 10_000;
const DEFAULT_RELATED_TX_BLOCK_RADIUS = 10_000;
const MAX_RELATED_TX_BLOCK_RADIUS = 50_000;

const RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT = 4;
const MAX_RATE_LIMIT = 12;
const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const MAX_INITIALIZER_BYTES = 64 * 1024;
const MAX_TARGET_CHAIN_IDS = 5;
const MAX_PLANNED_TRANSFERS = 20;
const PROVIDER_TIMEOUT_MS = 8_000;
const FETCH_TIMEOUT_MS = 12_000;
const LOG_TIMEOUT_MS = 12_000;
const TRACE_TIMEOUT_MS = 12_000;
const MAX_TRACE_NODES = 5_000;

const factoryInterface = new ethers.Interface(SAFE_PROXY_FACTORY_ABI);

const entryPointV07Interface = new ethers.Interface([
  "function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops,address beneficiary)",
  "function handleAggregatedOps(((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] userOps,address aggregator,bytes signature)[] opsPerAggregator,address beneficiary)",
]);

const entryPointV06Interface = new ethers.Interface([
  "function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,uint256 callGasLimit,uint256 verificationGasLimit,uint256 preVerificationGas,uint256 maxFeePerGas,uint256 maxPriorityFeePerGas,bytes paymasterAndData,bytes signature)[] ops,address beneficiary)",
  "function handleAggregatedOps(((address sender,uint256 nonce,bytes initCode,bytes callData,uint256 callGasLimit,uint256 verificationGasLimit,uint256 preVerificationGas,uint256 maxFeePerGas,uint256 maxPriorityFeePerGas,bytes paymasterAndData,bytes signature)[] userOps,address aggregator,bytes signature)[] opsPerAggregator,address beneficiary)",
]);

const recoveryRateBuckets =
  globalThis.__rcWalletCounterfactualRecoveryRateBuckets ?? new Map();
globalThis.__rcWalletCounterfactualRecoveryRateBuckets = recoveryRateBuckets;

/* -------------------------------------------------------------------------- */
/* HTTP security                                                              */
/* -------------------------------------------------------------------------- */

function configuredOrigins() {
  return String(process.env.RC_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function requestOriginAllowed(request) {
  const origin = String(request?.headers?.origin ?? "").trim();
  if (!origin) return true;
  if (configuredOrigins().includes(origin)) return true;

  const host = request?.headers?.["x-forwarded-host"] || request?.headers?.host;
  const proto =
    request?.headers?.["x-forwarded-proto"] ||
    (process.env.NODE_ENV === "production" ? "https" : "http");

  if (host && origin === `${proto}://${host}`) return true;

  return (
    process.env.NODE_ENV !== "production" &&
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
  );
}

function setCors(request, response) {
  const origin = String(request?.headers?.origin ?? "").trim();
  if (origin && requestOriginAllowed(request)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Credentials", "true");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "content-type");
}

function setSecurityHeaders(response) {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
}

function json(request, response, status, body) {
  setCors(request, response);
  setSecurityHeaders(response);
  return response.status(status).json(body);
}

function requestBodyTooLarge(request) {
  const contentLength = Number.parseInt(
    String(request?.headers?.["content-length"] ?? ""),
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
      Buffer.byteLength(JSON.stringify(request?.body ?? {}), "utf8") >
      MAX_REQUEST_BODY_BYTES
    );
  } catch {
    return true;
  }
}

function clientIp(request) {
  const forwarded = request?.headers?.["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0]?.trim() || "unknown";
  }
  return request?.headers?.["x-real-ip"] || "unknown";
}

function configuredRateLimit() {
  const parsed = Number.parseInt(
    process.env.RC_RECOVERY_MAX_PER_MINUTE ?? "",
    10,
  );

  if (Number.isInteger(parsed) && parsed > 0) {
    return Math.min(parsed, MAX_RATE_LIMIT);
  }

  return DEFAULT_RATE_LIMIT;
}

function recoveryRateLimit(request) {
  const now = Date.now();
  const limit = configuredRateLimit();
  const key = clientIp(request);
  const previous = recoveryRateBuckets.get(key) ?? [];
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
  recoveryRateBuckets.set(key, active);

  if (recoveryRateBuckets.size > 2_000) {
    for (const [bucketKey, timestamps] of recoveryRateBuckets) {
      const stillActive = timestamps.filter(
        (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS,
      );

      if (!stillActive.length) recoveryRateBuckets.delete(bucketKey);
      else recoveryRateBuckets.set(bucketKey, stillActive);

      if (recoveryRateBuckets.size <= 1_500) break;
    }
  }

  return {
    allowed: true,
    remaining: Math.max(0, limit - active.length),
  };
}

/* -------------------------------------------------------------------------- */
/* Generic normalization                                                      */
/* -------------------------------------------------------------------------- */

function timeout(promise, milliseconds, label) {
  let timeoutId;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`${label}: tiempo agotado`)),
      milliseconds,
    );
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

function normalizeAddress(address, label = "address") {
  const value = String(address ?? "").trim();
  if (!ADDRESS_PATTERN.test(value)) throw new Error(`${label} invalida`);

  // Never lowercase before getAddress: invalid mixed-case EIP-55 must fail.
  try {
    return ethers.getAddress(value);
  } catch {
    throw new Error(`${label} invalida o checksum EIP-55 incorrecto`);
  }
}

function normalizeHash(hash, label = "hash") {
  const value = String(hash ?? "").trim();
  if (!HASH_PATTERN.test(value)) throw new Error(`${label} invalido`);
  return value;
}

function normalizeHex(value, label, maxBytes = MAX_INITIALIZER_BYTES) {
  const normalized = String(value ?? "").trim();

  if (!ethers.isHexString(normalized)) {
    throw new Error(`${label} debe ser hex 0x...`);
  }

  if (ethers.getBytes(normalized).length > maxBytes) {
    throw new Error(`${label} demasiado grande`);
  }

  return normalized;
}

function normalizeSaltNonce(value, label = "saltNonce") {
  if (value === null || value === undefined || value === "") {
    throw new Error(`${label} requerido`);
  }

  let normalized;
  try {
    normalized = BigInt(value);
  } catch {
    throw new Error(`${label} invalido`);
  }

  const maxUint256 = (1n << 256n) - 1n;
  if (normalized < 0n || normalized > maxUint256) {
    throw new Error(`${label} fuera de uint256`);
  }

  return normalized.toString();
}

function normalizeBlockTag(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  if (value === "latest") return "latest";

  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error("bloque invalido");
  }

  return numeric;
}

function normalizePositiveInteger(value, fallback, maximum) {
  const numeric = Number(value ?? fallback);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) return fallback;
  return maximum ? Math.min(numeric, maximum) : numeric;
}

function sameAddress(left, right) {
  try {
    return (
      normalizeAddress(left).toLowerCase() ===
      normalizeAddress(right).toLowerCase()
    );
  } catch {
    return false;
  }
}

function normalizedAddressSet(values) {
  const result = new Set();

  for (const value of Array.isArray(values) ? values : []) {
    try {
      result.add(normalizeAddress(value).toLowerCase());
    } catch {}
  }

  return [...result].sort();
}

function sameAddressSet(left, right) {
  const a = normalizedAddressSet(left);
  const b = normalizedAddressSet(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function pushUnique(array, value) {
  if (value && !array.includes(value)) array.push(value);
}

function methodSupported(method) {
  return typeof method === "string" && SAFE_SUPPORTED_CREATION_METHODS.has(method);
}

function methodAcceptedForLegacyDiagnostic(method) {
  return (
    methodSupported(method) ||
    (typeof method === "string" && LEGACY_DIAGNOSTIC_METHODS.has(method))
  );
}

function knownFactory(address) {
  return SAFE_FACTORY_CANDIDATES.some((candidate) =>
    sameAddress(candidate.factory, address),
  );
}

/* -------------------------------------------------------------------------- */
/* Public helpers                                                             */
/* -------------------------------------------------------------------------- */

export function summarizeMovementPlan(analysis = {}) {
  const deployment = analysis.deployment ?? {};
  const safeActions = Array.isArray(deployment.safeActions)
    ? deployment.safeActions
    : [];
  const deployTransaction = deployment.deployTransaction ?? null;
  const canDeploy = Boolean(analysis.recoveryPossible && deployTransaction);
  const tokenActions = safeActions.filter((action) => action?.data !== "0x");
  const nativeActions = safeActions.filter((action) => action?.data === "0x");

  return {
    canDeploy,
    canMoveTokens: Boolean(canDeploy && safeActions.length > 0),
    deployTransaction,
    safeActions,
    tokenActions,
    nativeActions,
    actionCount: safeActions.length,
    tokenActionCount: tokenActions.length,
    nativeActionCount: nativeActions.length,
    blockers: analysis.blockers ?? [],
    warnings: analysis.warnings ?? [],
    mainnetBroadcastPrepared: Boolean(deployment.mainnetBroadcastPrepared),
    forkSimulationRequired: deployment.forkSimulationRequired !== false,
    manualApprovalRequired: deployment.manualApprovalRequired !== false,
  };
}

export function normalizeManualSourceDeploymentInput(input = {}) {
  assertNoSecrets(input);

  const factory =
    input.factory ??
    input.factoryAddress ??
    input.safeProxyFactory ??
    input.proxyFactory;

  const singleton =
    input.singleton ??
    input.masterCopy ??
    input.master_copy ??
    input.implementation;

  const initializer =
    input.initializer ?? input.setupData ?? input.setup_data ?? input.initData;

  const saltNonce = input.saltNonce ?? input.salt_nonce ?? input.salt;

  const method =
    input.deploymentMethod ??
    input.method ??
    input.creationMethod ??
    "createProxyWithNonce";

  const callback =
    input.callback ?? input.callbackAddress ?? input.callback_address ?? null;

  const proxyCreationCode =
    input.proxyCreationCode ?? input.sourceProxyCreationCode ?? null;

  if (!methodAcceptedForLegacyDiagnostic(method)) {
    throw new Error(`Metodo Safe no soportado: ${method}`);
  }

  const legacyUnsupportedMethod = LEGACY_DIAGNOSTIC_METHODS.has(method);

  return {
    sourceUrl: "request.sourceDeployment",
    transactionHash:
      input.transactionHash && HASH_PATTERN.test(input.transactionHash)
        ? input.transactionHash
        : null,
    factory: normalizeAddress(factory, "sourceDeployment.factory"),
    singleton: normalizeAddress(singleton, "sourceDeployment.singleton"),
    initializer: normalizeHex(initializer, "sourceDeployment.initializer"),
    saltNonce: normalizeSaltNonce(saltNonce, "sourceDeployment.saltNonce"),
    method,
    callback: callback
      ? normalizeAddress(callback, "sourceDeployment.callback")
      : null,
    proxyCreationCode: proxyCreationCode
      ? normalizeHex(proxyCreationCode, "sourceDeployment.proxyCreationCode")
      : null,
    diagnosticOnly: true,
    legacyUnsupportedMethod,
    receiptVerified: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Networks / providers                                                       */
/* -------------------------------------------------------------------------- */

function networkByChainId(chainId) {
  const numeric = Number(chainId);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    throw new Error(`chainId invalido: ${chainId}`);
  }

  const network = NETWORKS.find(
    (candidate) => Number(candidate.chainId) === numeric,
  );

  if (!network) throw new Error(`Red no configurada: ${chainId}`);
  return network;
}

async function getProvider(network) {
  const errors = [];

  for (const rpcUrl of network.rpcUrls ?? []) {
    let provider;

    try {
      provider = new ethers.JsonRpcProvider(rpcUrl, network.chainId, {
        staticNetwork: true,
        batchMaxCount: 1,
      });

      const [providerNetwork, latestBlock] = await Promise.all([
        timeout(
          provider.getNetwork(),
          PROVIDER_TIMEOUT_MS,
          `${network.name} getNetwork`,
        ),
        timeout(
          provider.getBlockNumber(),
          PROVIDER_TIMEOUT_MS,
          `${network.name} block`,
        ),
      ]);

      if (Number(providerNetwork.chainId) !== Number(network.chainId)) {
        throw new Error("chainId inesperado");
      }

      if (!Number.isSafeInteger(latestBlock) || latestBlock < 0) {
        throw new Error("latest block invalido");
      }

      return { provider, rpcUrl };
    } catch (error) {
      try {
        provider?.destroy?.();
      } catch {}

      errors.push(
        `${rpcUrl}: ${error instanceof Error ? error.message : "RPC fallido"}`,
      );
    }
  }

  throw new Error(
    `No hay RPC disponible para ${network.name}. ${errors.join("; ")}`,
  );
}

function addressFromStorageSlot(value) {
  if (!ethers.isHexString(value, 32)) return ethers.ZeroAddress;
  const address = ethers.getAddress(`0x${value.slice(-40)}`);
  return address === ethers.ZeroAddress ? ethers.ZeroAddress : address;
}

/* -------------------------------------------------------------------------- */
/* Source Safe inspection                                                     */
/* -------------------------------------------------------------------------- */

async function inspectSafe(provider, safeAddress) {
  const address = normalizeAddress(safeAddress, "smartAccountAddress");
  const code = await timeout(
    provider.getCode(address),
    PROVIDER_TIMEOUT_MS,
    "account code",
  );

  const hasCode = Boolean(code && code !== "0x");

  const result = {
    detected: false,
    address,
    hasCode,
    codeHash: hasCode ? ethers.keccak256(code) : null,
    owners: [],
    threshold: null,
    nonce: null,
    modules: [],
    modulesReadable: false,
    singleton: null,
    fallbackHandler: null,
    version: null,
    errors: [],
  };

  if (!hasCode) {
    result.errors.push("No hay contrato en la red fuente");
    return result;
  }

  const safe = new ethers.Contract(address, SAFE_INTROSPECTION_ABI, provider);

  const results = await Promise.allSettled([
    timeout(safe.getOwners(), PROVIDER_TIMEOUT_MS, "Safe owners"),
    timeout(safe.getThreshold(), PROVIDER_TIMEOUT_MS, "Safe threshold"),
    timeout(safe.nonce(), PROVIDER_TIMEOUT_MS, "Safe nonce"),
    timeout(safe.VERSION(), PROVIDER_TIMEOUT_MS, "Safe version"),
    timeout(
      safe.getModulesPaginated(SAFE_SENTINEL, 50),
      PROVIDER_TIMEOUT_MS,
      "Safe modules",
    ),
    timeout(
      provider.getStorage(address, 0n),
      PROVIDER_TIMEOUT_MS,
      "Safe singleton slot",
    ),
    timeout(
      provider.getStorage(address, SAFE_FALLBACK_HANDLER_STORAGE_SLOT),
      PROVIDER_TIMEOUT_MS,
      "Safe fallback handler slot",
    ),
  ]);

  const [owners, threshold, nonce, version, modules, singletonSlot, fallbackSlot] =
    results;

  if (owners.status === "fulfilled" && threshold.status === "fulfilled") {
    const normalizedOwners = Array.from(owners.value ?? [])
      .filter((owner) => ethers.isAddress(owner))
      .map((owner) => ethers.getAddress(owner));

    const normalizedThreshold = Number(threshold.value);

    if (
      normalizedOwners.length > 0 &&
      Number.isSafeInteger(normalizedThreshold) &&
      normalizedThreshold > 0 &&
      normalizedThreshold <= normalizedOwners.length
    ) {
      result.owners = normalizedOwners;
      result.threshold = normalizedThreshold;
      result.detected = true;
    } else {
      result.errors.push("Owners/threshold Safe invalidos");
    }
  } else {
    result.errors.push("El contrato no expone owners/threshold Safe");
  }

  if (nonce.status === "fulfilled") result.nonce = nonce.value.toString();
  if (version.status === "fulfilled") result.version = String(version.value);

  if (modules.status === "fulfilled") {
    const page = Array.isArray(modules.value?.[0]) ? modules.value[0] : [];
    result.modules = page
      .filter((module) => ethers.isAddress(module))
      .map((module) => ethers.getAddress(module));
    result.modulesReadable = true;
  }

  if (singletonSlot.status === "fulfilled") {
    result.singleton = addressFromStorageSlot(singletonSlot.value);
  }

  if (fallbackSlot.status === "fulfilled") {
    result.fallbackHandler = addressFromStorageSlot(fallbackSlot.value);
  }

  if (
    result.detected &&
    (!result.singleton || result.singleton === ethers.ZeroAddress)
  ) {
    result.detected = false;
    result.errors.push("No se pudo verificar singleton de la Safe fuente");
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/* HTTP / explorer helpers                                                    */
/* -------------------------------------------------------------------------- */

function explorerApiKey() {
  return (
    process.env.ETHERSCAN_API_KEY ||
    process.env.WORLDSCAN_API_KEY ||
    process.env.WORLD_SCAN_API_KEY ||
    process.env.EXPLORER_API_KEY ||
    ""
  );
}

function etherscanApiUrl(chainId, params) {
  const apiKey = explorerApiKey();
  if (!apiKey) return null;

  const url = new URL(ETHERSCAN_V2_URL);
  url.searchParams.set("chainid", String(chainId));

  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  url.searchParams.set("apikey", apiKey);
  return url.toString();
}

async function fetchJson(url, label) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "RC-Wallet-External/RecoveryEngine",
      },
      signal: controller.signal,
    });

    const text = await response.text();
    let payload = null;

    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text.slice(0, 800);
      }
    }

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    return payload;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${label}: tiempo agotado`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function normalizeCreationPayload(payload, sourceUrl) {
  const data =
    payload?.creation ??
    payload?.data ??
    payload?.results?.[0] ??
    payload?.result?.[0] ??
    payload;

  if (!data || typeof data !== "object" || Array.isArray(data)) return null;

  const transactionHash =
    data.transactionHash ??
    data.transaction_hash ??
    data.txHash ??
    data.tx_hash ??
    data.hash ??
    data.creationTxHash ??
    data.transaction?.txHash ??
    data.transaction?.hash ??
    null;

  const factory =
    data.factoryAddress ??
    data.factory_address ??
    data.factory ??
    data.createdBy ??
    data.contractCreator ??
    data.contract_creator ??
    null;

  const singleton =
    data.masterCopy ??
    data.master_copy ??
    data.singleton ??
    data.implementation ??
    null;

  const initializer =
    data.setupData ?? data.setup_data ?? data.initializer ?? data.initData ?? null;

  const saltNonce = data.saltNonce ?? data.salt_nonce ?? data.salt ?? null;

  const method =
    data.method ??
    data.creationMethod ??
    data.creation_method ??
    data.factoryMethod ??
    data.factory_method ??
    null;

  const callback =
    data.callback ?? data.callbackAddress ?? data.callback_address ?? null;

  if (!transactionHash && !factory && !singleton && !initializer) return null;

  let normalizedSalt = null;
  if (saltNonce !== null && saltNonce !== undefined && saltNonce !== "") {
    try {
      normalizedSalt = normalizeSaltNonce(saltNonce);
    } catch {
      normalizedSalt = null;
    }
  }

  return {
    sourceUrl,
    transactionHash:
      transactionHash && HASH_PATTERN.test(transactionHash)
        ? transactionHash
        : null,
    factory:
      factory && ethers.isAddress(factory) ? ethers.getAddress(factory) : null,
    singleton:
      singleton && ethers.isAddress(singleton)
        ? ethers.getAddress(singleton)
        : null,
    initializer:
      typeof initializer === "string" && ethers.isHexString(initializer)
        ? initializer
        : null,
    saltNonce: normalizedSalt,
    method: methodAcceptedForLegacyDiagnostic(method) ? method : null,
    callback:
      callback && ethers.isAddress(callback) ? ethers.getAddress(callback) : null,
    raw: data,
  };
}

function etherscanContractCreationUrl(chainId, safeAddress) {
  return etherscanApiUrl(chainId, {
    module: "contract",
    action: "getcontractcreation",
    contractaddresses: safeAddress,
  });
}

async function readCreationFromServices(chainId, safeAddress) {
  const urls = [
    ...(SAFE_CREATION_SERVICE_URLS[Number(chainId)] ?? []).map(
      (baseUrl) =>
        `${baseUrl.replace(/\/+$/, "")}/api/v1/safes/${safeAddress}/creation/`,
    ),
    `${SAFE_CLIENT_GATEWAY_URL}/v1/chains/${chainId}/safes/${safeAddress}/creation`,
    `${SAFE_CLIENT_GATEWAY_URL}/v1/chains/${chainId}/safes/${safeAddress}`,
    etherscanContractCreationUrl(chainId, safeAddress),
  ].filter(Boolean);

  const errors = [];

  for (const url of urls) {
    try {
      const payload = await fetchJson(url, "Safe creation lookup");
      const normalized = normalizeCreationPayload(payload, url);
      if (normalized) return { creation: normalized, errors };
      errors.push({ url, error: "respuesta sin datos de creacion" });
    } catch (error) {
      errors.push({
        url,
        error: error instanceof Error ? error.message : "consulta fallida",
      });
    }
  }

  return { creation: null, errors };
}

/* -------------------------------------------------------------------------- */
/* SafeProxyFactory calldata                                                  */
/* -------------------------------------------------------------------------- */

function parseSafeFactoryCalldata(data) {
  if (!data || data === "0x") return null;

  let parsed;
  try {
    parsed = factoryInterface.parseTransaction({ data });
  } catch {
    return null;
  }

  if (!parsed) return null;
  if (!methodSupported(parsed.name)) return null;

  return {
    method: parsed.name,
    singleton: normalizeAddress(parsed.args[0], "singleton"),
    initializer: normalizeHex(String(parsed.args[1]), "initializer"),
    saltNonce: normalizeSaltNonce(parsed.args[2], "saltNonce"),
    callback:
      parsed.name === "createProxyWithCallback"
        ? normalizeAddress(parsed.args[3], "callback")
        : null,
  };
}

function parseDirectSafeFactoryTransaction(transaction) {
  if (!transaction?.to || !transaction?.data || transaction.data === "0x") {
    return null;
  }

  if (transaction.value !== undefined && BigInt(transaction.value) !== 0n) {
    return null;
  }

  const parsed = parseSafeFactoryCalldata(transaction.data);
  if (!parsed) return null;

  return {
    factory: normalizeAddress(transaction.to, "factory"),
    ...parsed,
    transport: "direct-safe-proxy-factory",
  };
}

/* -------------------------------------------------------------------------- */
/* ERC-4337 transaction decoding                                              */
/* -------------------------------------------------------------------------- */

function entryPointDescriptor(address) {
  if (!address || !ethers.isAddress(address)) return null;

  return (
    ERC4337_ENTRYPOINTS.find((entry) => sameAddress(entry.address, address)) ??
    null
  );
}

function entryPointInterfaceForVersion(version) {
  if (version === "v0.7") return entryPointV07Interface;
  if (version === "v0.6") return entryPointV06Interface;
  return null;
}

function parseFactoryInitCode(initCode) {
  const normalized = normalizeHex(initCode, "userOp.initCode");
  const bytes = ethers.getBytes(normalized);

  // factory(20 bytes) || factoryCalldata
  if (bytes.length < 24) return null;

  const factory = ethers.getAddress(ethers.hexlify(bytes.slice(0, 20)));
  const factoryData = ethers.hexlify(bytes.slice(20));
  const parsed = parseSafeFactoryCalldata(factoryData);
  if (!parsed) return null;

  return {
    factory,
    factoryData,
    ...parsed,
  };
}

function flattenEntryPointOperations(parsed) {
  if (!parsed) return [];

  if (parsed.name === "handleOps") {
    return Array.from(parsed.args?.[0] ?? []);
  }

  if (parsed.name === "handleAggregatedOps") {
    return Array.from(parsed.args?.[0] ?? []).flatMap((group) =>
      Array.from(group?.userOps ?? group?.[0] ?? []),
    );
  }

  return [];
}

function parseEntryPointTransaction(transaction, safeAddress) {
  if (!transaction?.to || !transaction?.data || transaction.data === "0x") {
    return null;
  }

  const descriptor = entryPointDescriptor(transaction.to);
  if (!descriptor) return null;

  const entryPointInterface = entryPointInterfaceForVersion(descriptor.version);
  if (!entryPointInterface) return null;

  let parsed;
  try {
    parsed = entryPointInterface.parseTransaction({
      data: transaction.data,
      value: transaction.value ?? 0n,
    });
  } catch {
    return null;
  }

  if (!parsed) return null;
  if (parsed.name !== "handleOps" && parsed.name !== "handleAggregatedOps") {
    return null;
  }

  const expectedSafe = normalizeAddress(safeAddress, "smartAccountAddress");

  for (const operation of flattenEntryPointOperations(parsed)) {
    const sender = operation?.sender ?? operation?.[0] ?? null;
    const initCode = operation?.initCode ?? operation?.[2] ?? "0x";

    if (!sender || !ethers.isAddress(sender) || !sameAddress(sender, expectedSafe)) {
      continue;
    }

    if (!initCode || initCode === "0x") continue;

    let factoryCreation;
    try {
      factoryCreation = parseFactoryInitCode(initCode);
    } catch {
      continue;
    }

    if (!factoryCreation) continue;

    return {
      ...factoryCreation,
      sender: expectedSafe,
      entryPoint: normalizeAddress(transaction.to, "entryPoint"),
      entryPointVersion: descriptor.version,
      entryPointMethod: parsed.name,
      transport: "erc-4337-entrypoint",
      userOpInitCode: normalizeHex(initCode, "userOp.initCode"),
    };
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Limited debug_traceTransaction fallback                                    */
/* -------------------------------------------------------------------------- */

function traceNodeInput(node) {
  return node?.input ?? node?.data ?? "0x";
}

function traceNodeTo(node) {
  return node?.to ?? node?.action?.to ?? null;
}

function traceNodeCalls(node) {
  if (Array.isArray(node?.calls)) return node.calls;
  if (Array.isArray(node?.children)) return node.children;
  return [];
}

function findSafeFactoryCallInTrace(trace) {
  if (!trace || typeof trace !== "object") return null;

  const stack = [trace];
  let visited = 0;

  while (stack.length && visited < MAX_TRACE_NODES) {
    const node = stack.pop();
    visited += 1;

    const to = traceNodeTo(node);
    const input = traceNodeInput(node);

    if (to && ethers.isAddress(to) && knownFactory(to) && input && input !== "0x") {
      const parsed = parseSafeFactoryCalldata(input);
      if (parsed) {
        return {
          factory: normalizeAddress(to, "trace.factory"),
          ...parsed,
          transport: "debug-trace-safe-proxy-factory",
        };
      }
    }

    for (const child of traceNodeCalls(node)) stack.push(child);
  }

  return null;
}

async function parseCreationFromTrace(provider, transactionHash) {
  try {
    const trace = await timeout(
      provider.send("debug_traceTransaction", [
        transactionHash,
        { tracer: "callTracer", timeout: "8s" },
      ]),
      TRACE_TIMEOUT_MS,
      "debug_traceTransaction",
    );

    return findSafeFactoryCallInTrace(trace);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* ProxyCreation receipt proof                                                */
/* -------------------------------------------------------------------------- */

function decodeCreationLog(log, proxy) {
  if (log?.topics?.[0] !== SAFE_PROXY_CREATION_TOPIC) return null;

  try {
    const expectedProxy = normalizeAddress(proxy, "smartAccountAddress");
    if (!log.topics?.[1]) return null;

    const decodedProxy = ethers.getAddress(`0x${log.topics[1].slice(-40)}`);
    if (!sameAddress(decodedProxy, expectedProxy)) return null;
    if (!log.data || log.data === "0x") return null;

    const [singleton] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["address"],
      log.data,
    );

    return {
      proxy: decodedProxy,
      singleton: normalizeAddress(singleton, "ProxyCreation.singleton"),
      eventTopic: "ProxyCreation",
    };
  } catch {
    return null;
  }
}

function proxyCreationLogMatches(log, proxy) {
  return Boolean(decodeCreationLog(log, proxy));
}

async function creationFromReceiptLogs({
  provider,
  transactionHash,
  safeAddress,
}) {
  const normalizedHash = normalizeHash(
    transactionHash,
    "creationTransactionHash",
  );
  const normalizedSafe = normalizeAddress(
    safeAddress,
    "smartAccountAddress",
  );

  const [transaction, receipt] = await Promise.all([
    timeout(
      provider.getTransaction(normalizedHash),
      PROVIDER_TIMEOUT_MS,
      "creation transaction",
    ),
    timeout(
      provider.getTransactionReceipt(normalizedHash),
      PROVIDER_TIMEOUT_MS,
      "creation transaction receipt",
    ),
  ]);

  if (!transaction || !receipt || Number(receipt.status) !== 1) return null;

  let parsed = parseDirectSafeFactoryTransaction(transaction);
  if (!parsed) parsed = parseEntryPointTransaction(transaction, normalizedSafe);
  if (!parsed) parsed = await parseCreationFromTrace(provider, normalizedHash);
  if (!parsed || !methodSupported(parsed.method)) return null;

  const factory = normalizeAddress(parsed.factory, "factory");
  if (!knownFactory(factory)) return null;

  for (const log of receipt.logs ?? []) {
    if (!sameAddress(log.address, factory)) continue;

    const decoded = decodeCreationLog(log, normalizedSafe);
    if (!decoded) continue;
    if (!sameAddress(decoded.singleton, parsed.singleton)) continue;

    return {
      sourceUrl:
        parsed.transport === "erc-4337-entrypoint"
          ? "request.entryPointReceipt"
          : parsed.transport === "debug-trace-safe-proxy-factory"
            ? "request.tracedReceipt"
            : "request.transactionReceipt",
      transactionHash: normalizedHash,
      factory,
      method: parsed.method,
      singleton: parsed.singleton,
      initializer: parsed.initializer,
      saltNonce: parsed.saltNonce,
      callback: parsed.callback ?? null,
      transport: parsed.transport,
      entryPoint: parsed.entryPoint ?? null,
      entryPointVersion: parsed.entryPointVersion ?? null,
      entryPointMethod: parsed.entryPointMethod ?? null,
      eventTopic: decoded.eventTopic,
      blockNumber: Number(log.blockNumber ?? receipt.blockNumber),
      receiptVerified: true,
      diagnosticOnly: false,
    };
  }

  return null;
}

async function creationFromTransactionHash({ provider, transactionHash, safeAddress }) {
  return creationFromReceiptLogs({
    provider,
    transactionHash: normalizeHash(transactionHash, "creationTransactionHash"),
    safeAddress,
  });
}

/* -------------------------------------------------------------------------- */
/* Explorer fallbacks                                                         */
/* -------------------------------------------------------------------------- */

function explorerRows(payload) {
  if (Array.isArray(payload?.result)) return payload.result;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.results)) return payload.results;
  return [];
}

function normalizeExplorerLog(row) {
  const topics = Array.isArray(row?.topics)
    ? row.topics
    : [row?.topic0, row?.topic1, row?.topic2, row?.topic3].filter(Boolean);

  let blockNumber = 0;
  try {
    blockNumber =
      typeof row?.blockNumber === "string"
        ? Number(BigInt(row.blockNumber))
        : Number(row?.blockNumber ?? 0);
  } catch {}

  return {
    address: row?.address,
    topics,
    data: row?.data ?? "0x",
    transactionHash: row?.transactionHash ?? row?.hash ?? null,
    blockNumber,
  };
}

function creationFromMatchedLog({
  log,
  factory,
  decoded,
  sourceUrl,
  factoryVersion = null,
}) {
  const base = {
    sourceUrl,
    transactionHash: log.transactionHash,
    factory: normalizeAddress(factory ?? log.address, "factory"),
    singleton: decoded?.singleton ?? null,
    eventTopic: decoded?.eventTopic ?? null,
    blockNumber: log.blockNumber,
    receiptVerified: false,
    diagnosticOnly: true,
  };

  if (factoryVersion) base.factoryVersion = factoryVersion;
  return base;
}

async function readCreationFromExplorerGlobalLogs({
  chainId,
  safeAddress,
  sourceProvider,
  fromBlock = 0,
  toBlock = "latest",
}) {
  const normalizedSafe = normalizeAddress(safeAddress, "smartAccountAddress");
  const checked = [];

  const url = etherscanApiUrl(chainId, {
    module: "logs",
    action: "getLogs",
    fromBlock,
    toBlock,
    topic0: SAFE_PROXY_CREATION_TOPIC,
    topic1: ethers.zeroPadValue(normalizedSafe, 32),
    topic0_1_opr: "and",
  });

  if (!url) return { creation: null, checked };

  try {
    const payload = await fetchJson(url, "Explorer global Safe creation logs");
    const logs = explorerRows(payload).map(normalizeExplorerLog);

    checked.push({
      source: "explorer-global-logs",
      eventTopic: SAFE_PROXY_CREATION_TOPIC,
      fromBlock,
      toBlock,
      logs: logs.length,
    });

    for (const log of logs) {
      if (!proxyCreationLogMatches(log, normalizedSafe)) continue;

      if (log.transactionHash && sourceProvider) {
        const verified = await creationFromTransactionHash({
          provider: sourceProvider,
          transactionHash: log.transactionHash,
          safeAddress: normalizedSafe,
        }).catch(() => null);

        if (verified) return { creation: verified, checked };
      }

      const decoded = decodeCreationLog(log, normalizedSafe);
      return {
        creation: creationFromMatchedLog({
          log,
          factory: log.address,
          decoded,
          sourceUrl: "explorer-global-proxy-creation-logs",
        }),
        checked,
      };
    }
  } catch (error) {
    checked.push({
      source: "explorer-global-logs",
      eventTopic: SAFE_PROXY_CREATION_TOPIC,
      error:
        error instanceof Error ? error.message : "explorer global log failed",
    });
  }

  return { creation: null, checked };
}

async function readCreationFromExplorerLogs({
  chainId,
  safeAddress,
  sourceProvider,
  fromBlock = 0,
  toBlock = "latest",
}) {
  const normalizedSafe = normalizeAddress(safeAddress, "smartAccountAddress");
  const checked = [];

  for (const candidate of SAFE_FACTORY_CANDIDATES) {
    const factory = normalizeAddress(candidate.factory, "factory");

    const url = etherscanApiUrl(chainId, {
      module: "logs",
      action: "getLogs",
      fromBlock,
      toBlock,
      address: factory,
      topic0: SAFE_PROXY_CREATION_TOPIC,
      topic1: ethers.zeroPadValue(normalizedSafe, 32),
      topic0_1_opr: "and",
    });

    if (!url) return { creation: null, checked };

    try {
      const payload = await fetchJson(url, "Explorer Safe creation logs");
      const logs = explorerRows(payload).map(normalizeExplorerLog);

      checked.push({
        source: "explorer-logs",
        factory,
        version: candidate.version,
        eventTopic: SAFE_PROXY_CREATION_TOPIC,
        fromBlock,
        toBlock,
        logs: logs.length,
      });

      for (const log of logs) {
        if (!proxyCreationLogMatches(log, normalizedSafe)) continue;

        if (log.transactionHash && sourceProvider) {
          const verified = await creationFromTransactionHash({
            provider: sourceProvider,
            transactionHash: log.transactionHash,
            safeAddress: normalizedSafe,
          }).catch(() => null);

          if (verified) return { creation: verified, checked };
        }

        const decoded = decodeCreationLog(log, normalizedSafe);
        return {
          creation: creationFromMatchedLog({
            log,
            factory,
            decoded,
            sourceUrl: "explorer-proxy-creation-logs",
            factoryVersion: candidate.version,
          }),
          checked,
        };
      }
    } catch (error) {
      checked.push({
        source: "explorer-logs",
        factory,
        version: candidate.version,
        eventTopic: SAFE_PROXY_CREATION_TOPIC,
        error: error instanceof Error ? error.message : "explorer log failed",
      });
    }
  }

  return { creation: null, checked };
}

async function readCreationFromExplorerInternalTransactions({
  chainId,
  safeAddress,
}) {
  const normalizedSafe = normalizeAddress(safeAddress, "smartAccountAddress");
  const checked = [];

  const url = etherscanApiUrl(chainId, {
    module: "account",
    action: "txlistinternal",
    address: normalizedSafe,
    startblock: 0,
    endblock: 99_999_999,
    sort: "asc",
  });

  if (!url) return { creation: null, checked };

  try {
    const payload = await fetchJson(url, "Explorer internal creation txs");
    const rows = explorerRows(payload);
    checked.push({ source: "explorer-internal-transactions", rows: rows.length });

    const match = rows.find((row) => {
      const contractAddress = row.contractAddress ?? row.contract_address;
      return (
        contractAddress &&
        ethers.isAddress(contractAddress) &&
        sameAddress(contractAddress, normalizedSafe) &&
        HASH_PATTERN.test(row.hash ?? "")
      );
    });

    return {
      creation: match
        ? {
            sourceUrl: "explorer-internal-transactions",
            transactionHash: match.hash,
          }
        : null,
      checked,
    };
  } catch (error) {
    checked.push({
      source: "explorer-internal-transactions",
      error:
        error instanceof Error ? error.message : "internal tx lookup failed",
    });
    return { creation: null, checked };
  }
}

async function readCreationFromExplorerNormalTransactions({
  chainId,
  safeAddress,
}) {
  const normalizedSafe = normalizeAddress(safeAddress, "smartAccountAddress");
  const checked = [];

  const url = etherscanApiUrl(chainId, {
    module: "account",
    action: "txlist",
    address: normalizedSafe,
    startblock: 0,
    endblock: 99_999_999,
    sort: "asc",
  });

  if (!url) return { creation: null, checked };

  try {
    const payload = await fetchJson(url, "Explorer normal creation txs");
    const rows = explorerRows(payload);
    checked.push({ source: "explorer-normal-transactions", rows: rows.length });

    const match = rows.find((row) => HASH_PATTERN.test(row.hash ?? ""));

    return {
      creation: match
        ? {
            sourceUrl: "explorer-normal-transactions",
            transactionHash: match.hash,
          }
        : null,
      checked,
    };
  } catch (error) {
    checked.push({
      source: "explorer-normal-transactions",
      error: error instanceof Error ? error.message : "normal tx lookup failed",
    });
    return { creation: null, checked };
  }
}

async function readCreationFromExplorer({
  chainId,
  safeAddress,
  sourceProvider,
  fromBlock = 0,
  toBlock = "latest",
  includeGlobalFactorySearch = false,
}) {
  const checked = [];

  const logResult = await readCreationFromExplorerLogs({
    chainId,
    safeAddress,
    sourceProvider,
    fromBlock,
    toBlock,
  });
  checked.push(...logResult.checked);
  if (logResult.creation?.receiptVerified) {
    return { creation: logResult.creation, checked };
  }

  let diagnosticCandidate = logResult.creation ?? null;

  if (includeGlobalFactorySearch) {
    const globalResult = await readCreationFromExplorerGlobalLogs({
      chainId,
      safeAddress,
      sourceProvider,
      fromBlock,
      toBlock,
    });
    checked.push(...globalResult.checked);

    if (globalResult.creation?.receiptVerified) {
      return { creation: globalResult.creation, checked };
    }

    diagnosticCandidate = diagnosticCandidate ?? globalResult.creation;
  }

  const internalResult = await readCreationFromExplorerInternalTransactions({
    chainId,
    safeAddress,
  });
  checked.push(...internalResult.checked);

  if (internalResult.creation?.transactionHash) {
    const verified = await creationFromTransactionHash({
      provider: sourceProvider,
      transactionHash: internalResult.creation.transactionHash,
      safeAddress,
    }).catch(() => null);
    if (verified) return { creation: verified, checked };
  }

  const normalResult = await readCreationFromExplorerNormalTransactions({
    chainId,
    safeAddress,
  });
  checked.push(...normalResult.checked);

  if (normalResult.creation?.transactionHash) {
    const verified = await creationFromTransactionHash({
      provider: sourceProvider,
      transactionHash: normalResult.creation.transactionHash,
      safeAddress,
    }).catch(() => null);
    if (verified) return { creation: verified, checked };
  }

  return { creation: diagnosticCandidate, checked };
}

/* -------------------------------------------------------------------------- */
/* Bounded RPC creation-log search                                            */
/* -------------------------------------------------------------------------- */

async function searchCreationLogs({
  provider,
  safeAddress,
  fromBlock = 0,
  toBlock = "latest",
  maxLogBatches = DEFAULT_MAX_LOG_BATCHES,
  logBatchSize = DEFAULT_LOG_BATCH_SIZE,
  includeUnindexedLogs = false,
}) {
  // ProxyCreation.proxy is indexed. Retained only for API compatibility.
  void includeUnindexedLogs;

  const latestBlock = await timeout(
    provider.getBlockNumber(),
    PROVIDER_TIMEOUT_MS,
    "latest block",
  );

  const stopBlock = normalizeBlockTag(fromBlock, 0);
  const normalizedToBlock = normalizeBlockTag(toBlock, latestBlock);
  const startBlock =
    normalizedToBlock === "latest"
      ? latestBlock
      : Math.min(Number(normalizedToBlock), latestBlock);

  const normalizedMaxBatches = normalizePositiveInteger(
    maxLogBatches,
    DEFAULT_MAX_LOG_BATCHES,
    MAX_LOG_BATCHES,
  );
  const normalizedLogBatchSize = normalizePositiveInteger(
    logBatchSize,
    DEFAULT_LOG_BATCH_SIZE,
    MAX_LOG_BATCH_SIZE,
  );

  const checked = [];
  const normalizedSafe = normalizeAddress(safeAddress, "smartAccountAddress");
  let nextScan = null;

  for (const candidate of SAFE_FACTORY_CANDIDATES) {
    const factory = normalizeAddress(candidate.factory, "factory");
    const code = await timeout(
      provider.getCode(factory),
      PROVIDER_TIMEOUT_MS,
      "candidate factory code",
    );

    if (!code || code === "0x") {
      checked.push({ factory, version: candidate.version, skipped: "no-code" });
      continue;
    }

    let batches = 0;

    for (
      let rangeToBlock = startBlock;
      rangeToBlock >= Number(stopBlock) && batches < normalizedMaxBatches;
      rangeToBlock -= normalizedLogBatchSize
    ) {
      const rangeFromBlock = Math.max(
        Number(stopBlock),
        rangeToBlock - normalizedLogBatchSize + 1,
      );
      nextScan = rangeFromBlock > Number(stopBlock) ? rangeFromBlock - 1 : null;
      batches += 1;

      try {
        const logs = await timeout(
          provider.getLogs({
            address: factory,
            topics: [
              SAFE_PROXY_CREATION_TOPIC,
              ethers.zeroPadValue(normalizedSafe, 32),
            ],
            fromBlock: rangeFromBlock,
            toBlock: rangeToBlock,
          }),
          LOG_TIMEOUT_MS,
          "ProxyCreation indexed logs",
        );

        checked.push({
          factory,
          version: candidate.version,
          fromBlock: rangeFromBlock,
          toBlock: rangeToBlock,
          eventTopic: SAFE_PROXY_CREATION_TOPIC,
          indexed: true,
          logs: logs.length,
        });

        for (const log of logs) {
          if (!proxyCreationLogMatches(log, normalizedSafe)) continue;

          const verified = await creationFromTransactionHash({
            provider,
            transactionHash: log.transactionHash,
            safeAddress: normalizedSafe,
          });

          if (verified) {
            return {
              creation: {
                ...verified,
                sourceUrl: "rpc-proxy-creation-logs",
                factoryVersion: candidate.version,
              },
              checked,
              nextScan,
            };
          }
        }
      } catch (error) {
        checked.push({
          factory,
          version: candidate.version,
          fromBlock: rangeFromBlock,
          toBlock: rangeToBlock,
          eventTopic: SAFE_PROXY_CREATION_TOPIC,
          indexed: true,
          error: error instanceof Error ? error.message : "log query failed",
        });
      }
    }
  }

  return { creation: null, checked, nextScan };
}

async function searchGlobalProxyCreationLogs({
  provider,
  safeAddress,
  fromBlock = 0,
  toBlock = "latest",
  maxLogBatches = DEFAULT_GLOBAL_LOG_BATCHES,
  logBatchSize = GLOBAL_LOG_BATCH_SIZE,
}) {
  const latestBlock = await timeout(
    provider.getBlockNumber(),
    PROVIDER_TIMEOUT_MS,
    "latest block",
  );

  const stopBlock = normalizeBlockTag(fromBlock, 0);
  const normalizedToBlock = normalizeBlockTag(toBlock, latestBlock);
  const startBlock =
    normalizedToBlock === "latest"
      ? latestBlock
      : Math.min(Number(normalizedToBlock), latestBlock);

  const normalizedMaxBatches = normalizePositiveInteger(
    maxLogBatches,
    DEFAULT_GLOBAL_LOG_BATCHES,
    MAX_GLOBAL_LOG_BATCHES,
  );
  const normalizedLogBatchSize = normalizePositiveInteger(
    logBatchSize,
    GLOBAL_LOG_BATCH_SIZE,
    GLOBAL_LOG_BATCH_SIZE,
  );

  const checked = [];
  const normalizedSafe = normalizeAddress(safeAddress, "smartAccountAddress");
  let nextScan = null;
  let batches = 0;

  for (
    let rangeToBlock = startBlock;
    rangeToBlock >= Number(stopBlock) && batches < normalizedMaxBatches;
    rangeToBlock -= normalizedLogBatchSize
  ) {
    const rangeFromBlock = Math.max(
      Number(stopBlock),
      rangeToBlock - normalizedLogBatchSize + 1,
    );
    nextScan = rangeFromBlock > Number(stopBlock) ? rangeFromBlock - 1 : null;
    batches += 1;

    try {
      const logs = await timeout(
        provider.getLogs({
          topics: [
            SAFE_PROXY_CREATION_TOPIC,
            ethers.zeroPadValue(normalizedSafe, 32),
          ],
          fromBlock: rangeFromBlock,
          toBlock: rangeToBlock,
        }),
        LOG_TIMEOUT_MS,
        "Global ProxyCreation indexed logs",
      );

      checked.push({
        source: "global-proxy-creation-logs",
        fromBlock: rangeFromBlock,
        toBlock: rangeToBlock,
        eventTopic: SAFE_PROXY_CREATION_TOPIC,
        logs: logs.length,
      });

      for (const log of logs) {
        if (!proxyCreationLogMatches(log, normalizedSafe)) continue;

        const verified = await creationFromTransactionHash({
          provider,
          transactionHash: log.transactionHash,
          safeAddress: normalizedSafe,
        });

        if (verified) {
          return {
            creation: {
              ...verified,
              sourceUrl: "rpc-global-proxy-creation-logs",
            },
            checked,
            nextScan,
          };
        }
      }
    } catch (error) {
      checked.push({
        source: "global-proxy-creation-logs",
        fromBlock: rangeFromBlock,
        toBlock: rangeToBlock,
        eventTopic: SAFE_PROXY_CREATION_TOPIC,
        error: error instanceof Error ? error.message : "global log failed",
      });
    }
  }

  return { creation: null, checked, nextScan };
}

async function searchCreationAroundTransaction({
  provider,
  safeAddress,
  transactionHash,
  blockRadius = DEFAULT_RELATED_TX_BLOCK_RADIUS,
  includeUnindexedLogs = false,
}) {
  if (!transactionHash) return { creation: null, checked: [] };

  const normalizedHash = normalizeHash(
    transactionHash,
    "relatedTransactionHash",
  );

  const direct = await creationFromTransactionHash({
    provider,
    transactionHash: normalizedHash,
    safeAddress,
  });

  if (direct) {
    return {
      creation: direct,
      checked: [
        {
          source: "related-transaction-direct-proof",
          transactionHash: normalizedHash,
        },
      ],
    };
  }

  const receipt = await timeout(
    provider.getTransactionReceipt(normalizedHash),
    PROVIDER_TIMEOUT_MS,
    "related transaction receipt",
  );

  if (!receipt?.blockNumber) {
    return {
      creation: null,
      checked: [{ source: "related-transaction-block", error: "sin recibo" }],
    };
  }

  const latestBlock = await timeout(
    provider.getBlockNumber(),
    PROVIDER_TIMEOUT_MS,
    "latest block",
  );

  const radius = normalizePositiveInteger(
    blockRadius,
    DEFAULT_RELATED_TX_BLOCK_RADIUS,
    MAX_RELATED_TX_BLOCK_RADIUS,
  );

  const scanFrom = Math.max(0, Number(receipt.blockNumber) - radius);
  const scanTo = Math.min(latestBlock, Number(receipt.blockNumber) + radius);

  const result = await searchCreationLogs({
    provider,
    safeAddress,
    fromBlock: scanFrom,
    toBlock: scanTo,
    maxLogBatches: Math.max(
      1,
      Math.min(
        MAX_LOG_BATCHES,
        Math.ceil((scanTo - scanFrom + 1) / DEFAULT_LOG_BATCH_SIZE),
      ),
    ),
    logBatchSize: DEFAULT_LOG_BATCH_SIZE,
    includeUnindexedLogs,
  });

  return {
    creation: result.creation,
    checked: [
      {
        source: "related-transaction-block-window",
        transactionHash: normalizedHash,
        blockNumber: Number(receipt.blockNumber),
        fromBlock: scanFrom,
        toBlock: scanTo,
      },
      ...result.checked,
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* Source creation discovery                                                  */
/* -------------------------------------------------------------------------- */

async function hydrateCreation({ sourceProvider, safeAddress, creation }) {
  if (!creation) return null;

  if (creation.transactionHash) {
    const verified = await creationFromTransactionHash({
      provider: sourceProvider,
      transactionHash: creation.transactionHash,
      safeAddress,
    }).catch(() => null);

    if (verified) {
      return {
        ...creation,
        ...verified,
        sourceUrl: verified.sourceUrl ?? creation.sourceUrl,
        serviceSourceUrl: creation.sourceUrl ?? null,
        receiptVerified: true,
        diagnosticOnly: false,
      };
    }
  }

  if (
    creation.factory &&
    creation.singleton &&
    creation.initializer &&
    creation.saltNonce !== null &&
    creation.saltNonce !== undefined &&
    creation.method
  ) {
    return {
      ...creation,
      receiptVerified: false,
      diagnosticOnly: true,
    };
  }

  return null;
}

async function discoverSourceCreation({
  sourceProvider,
  sourceChainId,
  safeAddress,
  manualSourceDeployment,
  creationTransactionHash,
  maxLogBatches,
  logBatchSize,
  fromBlock,
  toBlock,
  relatedBlockRadius,
  includeUnindexedLogs,
  includeGlobalFactorySearch,
}) {
  const evidence = {
    manualSourceDeployment: manualSourceDeployment ? "provided" : null,
    creationServices: [],
    explorerSearch: [],
    relatedTransactionBlockSearch: [],
    logSearch: [],
    globalLogSearch: [],
    creationTransactionHash: creationTransactionHash ?? null,
    creationTransactionHashLookup: null,
    nextScan: null,
    globalSearchEnabled: Boolean(includeGlobalFactorySearch),
    supportsEntryPointV07: true,
    supportsEntryPointV06: true,
    supportsDebugTraceFallback: true,
  };

  let creation = null;
  let diagnosticCandidate = null;

  if (creationTransactionHash) {
    creation = await creationFromTransactionHash({
      provider: sourceProvider,
      transactionHash: creationTransactionHash,
      safeAddress,
    });

    evidence.creationTransactionHashLookup = creation
      ? "receipt-verified"
      : "transaction did not prove Safe creation";
  }

  if (!creation) {
    const serviceResult = await readCreationFromServices(
      sourceChainId,
      safeAddress,
    );
    evidence.creationServices = serviceResult.errors;

    const hydrated = await hydrateCreation({
      sourceProvider,
      safeAddress,
      creation: serviceResult.creation,
    });

    if (hydrated?.receiptVerified) creation = hydrated;
    else diagnosticCandidate = diagnosticCandidate ?? hydrated;
  }

  if (!creation) {
    const explorerResult = await readCreationFromExplorer({
      chainId: sourceChainId,
      safeAddress,
      sourceProvider,
      fromBlock,
      toBlock,
      includeGlobalFactorySearch: false,
    });
    evidence.explorerSearch = explorerResult.checked;

    const hydrated = await hydrateCreation({
      sourceProvider,
      safeAddress,
      creation: explorerResult.creation,
    });

    if (hydrated?.receiptVerified) creation = hydrated;
    else diagnosticCandidate = diagnosticCandidate ?? hydrated;
  }

  if (!creation) {
    const logResult = await searchCreationLogs({
      provider: sourceProvider,
      safeAddress,
      fromBlock,
      toBlock,
      maxLogBatches,
      logBatchSize,
      includeUnindexedLogs,
    });
    evidence.logSearch = logResult.checked;
    evidence.nextScan = logResult.nextScan;
    if (logResult.creation) creation = logResult.creation;
  }

  if (!creation && includeGlobalFactorySearch) {
    const globalResult = await searchGlobalProxyCreationLogs({
      provider: sourceProvider,
      safeAddress,
      fromBlock,
      toBlock,
      maxLogBatches: Math.min(
        normalizePositiveInteger(
          maxLogBatches,
          DEFAULT_GLOBAL_LOG_BATCHES,
          MAX_GLOBAL_LOG_BATCHES,
        ),
        MAX_GLOBAL_LOG_BATCHES,
      ),
      logBatchSize: GLOBAL_LOG_BATCH_SIZE,
    });
    evidence.globalLogSearch = globalResult.checked;
    evidence.nextScan = globalResult.nextScan ?? evidence.nextScan;
    if (globalResult.creation) creation = globalResult.creation;
  }

  if (!creation && creationTransactionHash) {
    const nearbyResult = await searchCreationAroundTransaction({
      provider: sourceProvider,
      safeAddress,
      transactionHash: creationTransactionHash,
      blockRadius: relatedBlockRadius,
      includeUnindexedLogs,
    });
    evidence.relatedTransactionBlockSearch = nearbyResult.checked;
    if (nearbyResult.creation) creation = nearbyResult.creation;
  }

  if (!creation && manualSourceDeployment) {
    const manual = normalizeManualSourceDeploymentInput(manualSourceDeployment);
    evidence.manualSourceDeployment = "diagnostic-only";
    diagnosticCandidate = diagnosticCandidate ?? manual;
  }

  return {
    creation: creation ?? diagnosticCandidate,
    evidence,
  };
}

/* -------------------------------------------------------------------------- */
/* Independent source/target contract proof                                   */
/* -------------------------------------------------------------------------- */

async function readContractCodeState(provider, address, label) {
  const normalizedAddress = normalizeAddress(address, label);
  const code = await timeout(
    provider.getCode(normalizedAddress),
    PROVIDER_TIMEOUT_MS,
    `${label} code`,
  );
  const hasCode = Boolean(code && code !== "0x");

  return {
    address: normalizedAddress,
    hasCode,
    codeHash: hasCode ? ethers.keccak256(code) : null,
    code,
  };
}

async function readFactoryProxyCreationCode(provider, factoryAddress, label) {
  const codeState = await readContractCodeState(provider, factoryAddress, label);

  if (!codeState.hasCode) {
    return {
      ...codeState,
      proxyCreationCode: null,
      proxyCreationCodeHash: null,
    };
  }

  const factory = new ethers.Contract(
    codeState.address,
    SAFE_PROXY_FACTORY_ABI,
    provider,
  );

  const proxyCreationCode = normalizeHex(
    await timeout(
      factory.proxyCreationCode(),
      PROVIDER_TIMEOUT_MS,
      `${label} proxyCreationCode`,
    ),
    `${label}.proxyCreationCode`,
  );

  return {
    ...codeState,
    proxyCreationCode,
    proxyCreationCodeHash: ethers.keccak256(proxyCreationCode),
  };
}

async function readDependencyCode(provider, addresses) {
  const unique = [];

  for (const rawAddress of addresses ?? []) {
    if (!rawAddress) continue;
    const address = normalizeAddress(rawAddress);
    if (address === ethers.ZeroAddress) continue;
    if (!unique.some((existing) => sameAddress(existing, address))) {
      unique.push(address);
    }
  }

  const rows = await Promise.all(
    unique.map(async (address) => {
      const state = await readContractCodeState(
        provider,
        address,
        `dependency ${address}`,
      );
      return [address, { hasCode: state.hasCode, codeHash: state.codeHash }];
    }),
  );

  return Object.fromEntries(rows);
}

function validateInitializerAgainstSource({ initializer, sourceSafeState }) {
  const blockers = [];
  const warnings = [];

  let decoded;
  try {
    decoded = decodeSafeInitializer(initializer);
  } catch (error) {
    blockers.push(
      `Safe initializer decode failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    return { valid: false, decoded: null, blockers, warnings };
  }

  if (!decoded?.decoded) {
    blockers.push(
      decoded?.reason ?? "Initializer is not recognized as Safe.setup()",
    );
    return { valid: false, decoded, blockers, warnings };
  }

  if (!sameAddressSet(decoded.owners, sourceSafeState.owners)) {
    blockers.push("initializer owners do not match the current source Safe owners");
  }

  if (BigInt(decoded.threshold) !== BigInt(sourceSafeState.threshold)) {
    blockers.push(
      "initializer threshold does not match the current source Safe threshold",
    );
  }

  if (
    sourceSafeState.fallbackHandler &&
    sourceSafeState.fallbackHandler !== ethers.ZeroAddress &&
    !sameAddress(decoded.fallbackHandler, sourceSafeState.fallbackHandler)
  ) {
    blockers.push(
      "initializer fallbackHandler does not match source Safe fallbackHandler",
    );
  }

  if (BigInt(decoded.payment) !== 0n) {
    blockers.push(
      "initializer payment is non-zero; automatic prefunded deployment is blocked",
    );
  }

  if (decoded.setupTo === ethers.ZeroAddress && decoded.setupData !== "0x") {
    blockers.push("initializer setupTo is zero but setupData is non-empty");
  }

  if (
    decoded.setupTo !== ethers.ZeroAddress &&
    decoded.setupData !== "0x" &&
    !decoded.moduleSetup?.recognized
  ) {
    blockers.push(
      "initializer delegatecall is not recognized as SafeModuleSetup.enableModules",
    );
  }

  if (decoded.moduleSetup?.recognized && sourceSafeState.modulesReadable) {
    const liveModules = normalizedAddressSet(sourceSafeState.modules);

    for (const module of decoded.moduleSetup.modules) {
      if (!liveModules.includes(normalizeAddress(module).toLowerCase())) {
        blockers.push(
          `initializer module ${module} is not enabled in the source Safe`,
        );
      }
    }
  } else if (decoded.moduleSetup?.recognized) {
    warnings.push(
      "Source Safe modules could not be read; module membership cannot be independently compared.",
    );
  }

  return {
    valid: blockers.length === 0,
    decoded,
    blockers,
    warnings,
  };
}

async function deploymentFromCreation({
  sourceProvider,
  targetProvider,
  sourceChainId,
  targetChainId,
  safeAddress,
  sourceSafeState,
  creation,
}) {
  const expectedSafe = normalizeAddress(safeAddress, "smartAccountAddress");
  if (!creation) return null;

  let authoritative = creation;

  if (creation.transactionHash) {
    const verified = await creationFromTransactionHash({
      provider: sourceProvider,
      transactionHash: creation.transactionHash,
      safeAddress: expectedSafe,
    });

    if (verified) {
      authoritative = {
        ...creation,
        ...verified,
        receiptVerified: true,
        diagnosticOnly: false,
      };
    }
  }

  if (
    !authoritative?.factory ||
    !authoritative?.singleton ||
    !authoritative?.initializer ||
    authoritative?.saltNonce === null ||
    authoritative?.saltNonce === undefined ||
    !authoritative?.method
  ) {
    return null;
  }

  if (!methodSupported(authoritative.method)) {
    throw new Error(
      `Metodo Safe no soportado por SafeProxyFactory v1.4.1: ${authoritative.method}`,
    );
  }

  const factory = normalizeAddress(authoritative.factory, "factory");
  if (!knownFactory(factory)) {
    throw new Error(
      "Source creation factory is not in the audited Safe factory catalog",
    );
  }

  const singleton = normalizeAddress(authoritative.singleton, "singleton");
  const initializer = normalizeHex(authoritative.initializer, "initializer");
  const saltNonce = normalizeSaltNonce(authoritative.saltNonce, "saltNonce");
  const callback = authoritative.callback
    ? normalizeAddress(authoritative.callback, "callback")
    : null;

  if (authoritative.method === "createProxyWithCallback" && !callback) {
    throw new Error("createProxyWithCallback requires verified callback");
  }

  const [sourceFactory, targetFactory, sourceSingleton, targetSingleton] =
    await Promise.all([
      readFactoryProxyCreationCode(sourceProvider, factory, "source factory"),
      readFactoryProxyCreationCode(targetProvider, factory, "target factory"),
      readContractCodeState(sourceProvider, singleton, "source singleton"),
      readContractCodeState(targetProvider, singleton, "target singleton"),
    ]);

  if (!sourceFactory.hasCode || !sourceFactory.proxyCreationCode) {
    throw new Error("Source Safe factory has no usable code/proxyCreationCode");
  }

  if (!sourceSingleton.hasCode) {
    throw new Error("Source Safe singleton has no code");
  }

  let manualProxyCreationCodeMatches = null;
  if (authoritative.proxyCreationCode) {
    const supplied = normalizeHex(
      authoritative.proxyCreationCode,
      "sourceDeployment.proxyCreationCode",
    );
    manualProxyCreationCodeMatches =
      ethers.keccak256(supplied) === sourceFactory.proxyCreationCodeHash;

    if (!manualProxyCreationCodeMatches) {
      throw new Error(
        "Supplied proxyCreationCode does not match source factory proxyCreationCode()",
      );
    }
  }

  const sourceProxyCreationCode = sourceFactory.proxyCreationCode;
  const targetProxyCreationCode = targetFactory.proxyCreationCode;

  const proxyCreationCodeMatches =
    Boolean(targetProxyCreationCode) &&
    sourceFactory.proxyCreationCodeHash === targetFactory.proxyCreationCodeHash;

  const factoryRuntimeCodeMatches =
    Boolean(sourceFactory.codeHash && targetFactory.codeHash) &&
    sourceFactory.codeHash === targetFactory.codeHash;

  const singletonRuntimeCodeMatches =
    Boolean(sourceSingleton.codeHash && targetSingleton.codeHash) &&
    sourceSingleton.codeHash === targetSingleton.codeHash;

  const sourceSingletonMatchesSafe =
    Boolean(sourceSafeState?.singleton) &&
    sameAddress(sourceSafeState.singleton, singleton);

  const initializerValidation = validateInitializerAgainstSource({
    initializer,
    sourceSafeState,
  });

  const sourcePrediction = predictCounterfactualSafeAddress({
    expectedAddress: expectedSafe,
    factory,
    proxyCreationCode: sourceProxyCreationCode,
    singleton,
    initializer,
    saltNonce,
    deploymentMethod: authoritative.method,
    callback,
    chainId: sourceChainId,
  });

  const targetPrediction = targetProxyCreationCode
    ? predictCounterfactualSafeAddress({
        expectedAddress: expectedSafe,
        factory,
        proxyCreationCode: targetProxyCreationCode,
        singleton,
        initializer,
        saltNonce,
        deploymentMethod: authoritative.method,
        callback,
        chainId: targetChainId,
      })
    : null;

  const dependencyAddresses = [
    initializerValidation.decoded?.setupTo,
    initializerValidation.decoded?.fallbackHandler,
    ...(initializerValidation.decoded?.moduleSetup?.modules ?? []),
  ];

  const targetDependencyCode = await readDependencyCode(
    targetProvider,
    dependencyAddresses,
  );

  const targetDependenciesHaveCode = dependencyAddresses
    .filter(Boolean)
    .map((address) => normalizeAddress(address))
    .filter((address) => address !== ethers.ZeroAddress)
    .every((address) => targetDependencyCode[address]?.hasCode === true);

  return {
    factory,
    singleton,
    initializer,
    saltNonce,
    deploymentMethod: authoritative.method,
    method: authoritative.method,
    callback,

    // Engine compatibility proxyCreationCode must remain source-derived.
    proxyCreationCode: sourceProxyCreationCode,
    sourceProxyCreationCode,
    targetProxyCreationCode,
    sourceProxyCreationCodeHash: sourceFactory.proxyCreationCodeHash,
    targetProxyCreationCodeHash: targetFactory.proxyCreationCodeHash,
    proxyCreationCodeMatches,

    sourceFactoryHasCode: sourceFactory.hasCode,
    targetFactoryHasCode: targetFactory.hasCode,
    sourceFactoryCodeHash: sourceFactory.codeHash,
    targetFactoryCodeHash: targetFactory.codeHash,
    factoryRuntimeCodeMatches,

    sourceSingletonHasCode: sourceSingleton.hasCode,
    targetSingletonHasCode: targetSingleton.hasCode,
    sourceSingletonCodeHash: sourceSingleton.codeHash,
    targetSingletonCodeHash: targetSingleton.codeHash,
    singletonRuntimeCodeMatches,

    sourceSingletonMatchesSafe,
    initializerValidation,
    targetDependencyCode,
    targetDependenciesHaveCode,

    sourcePrediction,
    targetPrediction,

    sourceTransactionHash: authoritative.transactionHash ?? null,
    sourceUrl: authoritative.sourceUrl ?? null,
    receiptVerified: authoritative.receiptVerified === true,
    diagnosticOnly: authoritative.receiptVerified !== true,
    transport: authoritative.transport ?? null,
    entryPoint: authoritative.entryPoint ?? null,
    entryPointVersion: authoritative.entryPointVersion ?? null,
    entryPointMethod: authoritative.entryPointMethod ?? null,
    manualProxyCreationCodeMatches,
    sourceChainId: Number(sourceChainId),
    targetChainId: Number(targetChainId),
  };
}

/* Named compatibility wrapper retained for architecture/tests. */
async function buildSourceDeployment({
  sourceProvider,
  targetProvider,
  sourceChainId,
  targetChainId,
  safeAddress,
  sourceSafeState,
  manualSourceDeployment,
  creationTransactionHash,
  maxLogBatches,
  logBatchSize,
  fromBlock,
  toBlock,
  relatedBlockRadius,
  includeUnindexedLogs,
  includeGlobalFactorySearch,
}) {
  const discovery = await discoverSourceCreation({
    sourceProvider,
    sourceChainId,
    safeAddress,
    manualSourceDeployment,
    creationTransactionHash,
    maxLogBatches,
    logBatchSize,
    fromBlock,
    toBlock,
    relatedBlockRadius,
    includeUnindexedLogs,
    includeGlobalFactorySearch,
  });

  return {
    sourceDeployment: discovery.creation
      ? await deploymentFromCreation({
          sourceProvider,
          targetProvider,
          sourceChainId,
          targetChainId,
          safeAddress,
          sourceSafeState,
          creation: discovery.creation,
        })
      : null,
    evidence: discovery.evidence,
  };
}
void buildSourceDeployment;

/* -------------------------------------------------------------------------- */
/* Provenance gate                                                            */
/* -------------------------------------------------------------------------- */

function provenanceBlockersForDeployment(sourceDeployment) {
  const blockers = [];
  const warnings = [];

  if (!sourceDeployment) {
    return {
      blockers: ["source deployment was not recovered"],
      warnings,
    };
  }

  if (sourceDeployment.receiptVerified !== true) {
    blockers.push("source creation transaction/receipt proof is not verified");
  }

  if (sourceDeployment.sourcePrediction?.matches !== true) {
    blockers.push(
      "source CREATE2 prediction does not reproduce the existing Safe",
    );
  }

  if (sourceDeployment.targetPrediction?.matches !== true) {
    blockers.push(
      "target CREATE2 prediction does not reproduce the address containing the funds",
    );
  }

  if (sourceDeployment.targetFactoryHasCode !== true) {
    blockers.push("target Safe factory has no code");
  }

  if (sourceDeployment.targetSingletonHasCode !== true) {
    blockers.push("target Safe singleton has no code");
  }

  if (sourceDeployment.proxyCreationCodeMatches !== true) {
    blockers.push(
      "source and target factory proxyCreationCode differ or could not be verified",
    );
  }

  if (sourceDeployment.factoryRuntimeCodeMatches !== true) {
    blockers.push(
      "source and target Safe factory runtime bytecode hashes do not match",
    );
  }

  if (sourceDeployment.singletonRuntimeCodeMatches !== true) {
    blockers.push(
      "source and target Safe singleton runtime bytecode hashes do not match",
    );
  }

  if (sourceDeployment.sourceSingletonMatchesSafe !== true) {
    blockers.push(
      "deployment singleton does not match the singleton used by the source Safe",
    );
  }

  if (sourceDeployment.initializerValidation?.valid !== true) {
    for (const blocker of sourceDeployment.initializerValidation?.blockers ?? [
      "Safe initializer was not validated",
    ]) {
      pushUnique(blockers, blocker);
    }
  }

  for (const warning of sourceDeployment.initializerValidation?.warnings ?? []) {
    pushUnique(warnings, warning);
  }

  if (sourceDeployment.targetDependenciesHaveCode !== true) {
    blockers.push(
      "one or more Safe initializer dependencies have no code on the target chain",
    );
  }

  if (sourceDeployment.diagnosticOnly) {
    blockers.push(
      "manual/unverified deployment parameters are diagnostic-only and cannot authorize mainnet recovery",
    );
  }

  return { blockers, warnings };
}

function hardenAnalysis(analysis, sourceDeployment) {
  const provenance = provenanceBlockersForDeployment(sourceDeployment);
  const blockers = [...(analysis.blockers ?? [])];
  const warnings = [...(analysis.warnings ?? [])];

  for (const blocker of provenance.blockers) pushUnique(blockers, blocker);
  for (const warning of provenance.warnings) pushUnique(warnings, warning);

  const recoveryPossible =
    Boolean(analysis.recoveryPossible) && blockers.length === 0;

  return {
    ...analysis,
    recoveryPossible,
    blockers,
    warnings,
    deployment: {
      ...(analysis.deployment ?? {}),
      deployTransaction: recoveryPossible
        ? analysis.deployment?.deployTransaction ?? null
        : null,
      receiptVerified: sourceDeployment?.receiptVerified === true,
      mainnetBroadcastPrepared: false,
      forkSimulationRequired: true,
      manualApprovalRequired: true,
      sourceProxyCreationCodeHash:
        sourceDeployment?.sourceProxyCreationCodeHash ?? null,
      targetProxyCreationCodeHash:
        sourceDeployment?.targetProxyCreationCodeHash ?? null,
      proxyCreationCodeMatches:
        sourceDeployment?.proxyCreationCodeMatches ?? false,
      factoryRuntimeCodeMatches:
        sourceDeployment?.factoryRuntimeCodeMatches ?? false,
      singletonRuntimeCodeMatches:
        sourceDeployment?.singletonRuntimeCodeMatches ?? false,
      targetDependenciesHaveCode:
        sourceDeployment?.targetDependenciesHaveCode ?? false,
      sourceCreationTransport: sourceDeployment?.transport ?? null,
      entryPointVersion: sourceDeployment?.entryPointVersion ?? null,
    },
  };
}

async function analyzeTarget({
  sourceChainId,
  targetChainId,
  targetProvider,
  targetRpcUsed,
  targetNetwork,
  smartAccountAddress,
  connectedOwnerAddress,
  sourceSafeState,
  sourceDeployment,
  evidence,
  plannedTransfers,
}) {
  const targetCode = await timeout(
    targetProvider.getCode(smartAccountAddress),
    PROVIDER_TIMEOUT_MS,
    "target account code",
  );

  const targetDeploymentStatus = {
    hasCode: Boolean(targetCode && targetCode !== "0x"),
    codeHash:
      targetCode && targetCode !== "0x" ? ethers.keccak256(targetCode) : null,
    factoryHasCode: sourceDeployment?.targetFactoryHasCode ?? null,
    singletonHasCode: sourceDeployment?.targetSingletonHasCode ?? null,
  };

  const baseAnalysis = analyzeCounterfactualSafeRecovery({
    sourceChainId,
    targetChainId,
    smartAccountAddress,
    connectedOwnerAddress,
    sourceDeployment,
    targetDeploymentStatus,
    sourceSafeState,
    plannedTransfers,
  });

  const analysis = hardenAnalysis(baseAnalysis, sourceDeployment);
  const sourcePrediction = sourceDeployment?.sourcePrediction ?? null;
  const targetPrediction = sourceDeployment?.targetPrediction ?? null;

  return {
    targetChainId: Number(targetChainId),
    targetNetwork: targetNetwork.name,
    targetRpcUsed,
    sourcePrediction,
    targetPrediction,
    targetDeploymentStatus,
    sourceDeployment,
    analysis,
    movementPlan: summarizeMovementPlan(analysis),
    evidence: {
      ...evidence,
      provenance: {
        sourceTransactionHash: sourceDeployment?.sourceTransactionHash ?? null,
        receiptVerified: sourceDeployment?.receiptVerified ?? false,
        transport: sourceDeployment?.transport ?? null,
        entryPoint: sourceDeployment?.entryPoint ?? null,
        entryPointVersion: sourceDeployment?.entryPointVersion ?? null,
        sourceProxyCreationCodeHash:
          sourceDeployment?.sourceProxyCreationCodeHash ?? null,
        targetProxyCreationCodeHash:
          sourceDeployment?.targetProxyCreationCodeHash ?? null,
        proxyCreationCodeMatches:
          sourceDeployment?.proxyCreationCodeMatches ?? null,
        sourceFactoryCodeHash: sourceDeployment?.sourceFactoryCodeHash ?? null,
        targetFactoryCodeHash: sourceDeployment?.targetFactoryCodeHash ?? null,
        factoryRuntimeCodeMatches:
          sourceDeployment?.factoryRuntimeCodeMatches ?? null,
        sourceSingletonCodeHash:
          sourceDeployment?.sourceSingletonCodeHash ?? null,
        targetSingletonCodeHash:
          sourceDeployment?.targetSingletonCodeHash ?? null,
        singletonRuntimeCodeMatches:
          sourceDeployment?.singletonRuntimeCodeMatches ?? null,
        sourceSingletonMatchesSafe:
          sourceDeployment?.sourceSingletonMatchesSafe ?? null,
        targetDependenciesHaveCode:
          sourceDeployment?.targetDependenciesHaveCode ?? null,
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Request parsing                                                            */
/* -------------------------------------------------------------------------- */

function parseTargetChainIds(body) {
  const values = Array.isArray(body.targetChainIds)
    ? body.targetChainIds
    : body.targetChainId !== undefined &&
        body.targetChainId !== null &&
        body.targetChainId !== ""
      ? [body.targetChainId]
      : [];

  if (!values.length) {
    throw new Error("Debes indicar targetChainId o targetChainIds");
  }

  const normalized = [
    ...new Set(
      values.map((value) => {
        const numeric = Number(value);
        if (!Number.isSafeInteger(numeric) || numeric <= 0) {
          throw new Error(`targetChainId invalido: ${value}`);
        }
        networkByChainId(numeric);
        return numeric;
      }),
    ),
  ];

  if (normalized.length > MAX_TARGET_CHAIN_IDS) {
    throw new Error(
      `Demasiadas redes destino. Maximo ${MAX_TARGET_CHAIN_IDS} por solicitud.`,
    );
  }

  return normalized;
}

function normalizePlannedTransfers(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error("plannedTransfers debe ser array");
  }
  if (value.length > MAX_PLANNED_TRANSFERS) {
    throw new Error(
      `plannedTransfers excede el maximo de ${MAX_PLANNED_TRANSFERS} acciones`,
    );
  }

  assertNoSecrets(value);
  return value;
}

/* -------------------------------------------------------------------------- */
/* Handler                                                                    */
/* -------------------------------------------------------------------------- */

export default async function handler(request, response) {
  if (!requestOriginAllowed(request)) {
    return response.status(403).json({
      ok: false,
      route: "counterfactual-safe-recovery",
      error: "Origin no autorizado",
    });
  }

  setCors(request, response);
  setSecurityHeaders(response);

  if (request.method === "OPTIONS") {
    return response.status(204).end();
  }

  if (request.method !== "POST") {
    return json(request, response, 405, { error: "Metodo no permitido" });
  }

  if (requestBodyTooLarge(request)) {
    return json(request, response, 413, {
      ok: false,
      route: "counterfactual-safe-recovery",
      error: "Solicitud demasiado grande",
    });
  }

  const rateLimit = recoveryRateLimit(request);
  if (!rateLimit.allowed) {
    response.setHeader("Retry-After", String(rateLimit.retryAfterSeconds));
    return json(request, response, 429, {
      ok: false,
      route: "counterfactual-safe-recovery",
      error: "Demasiadas solicitudes de recovery. Intenta nuevamente mas tarde.",
    });
  }

  let sourceProvider = null;

  try {
    const body = request.body ?? {};
    assertNoSecrets(body);

    const sourceChainId = Number(body.sourceChainId);
    if (!Number.isSafeInteger(sourceChainId) || sourceChainId <= 0) {
      throw new Error("sourceChainId invalido");
    }

    const targetChainIds = parseTargetChainIds(body);
    if (targetChainIds.some((chainId) => chainId === sourceChainId)) {
      throw new Error("La red destino debe ser distinta de la red fuente");
    }

    const smartAccountAddress = normalizeAddress(
      body.smartAccountAddress,
      "smartAccountAddress",
    );

    const connectedOwnerAddress = body.connectedOwnerAddress
      ? normalizeAddress(body.connectedOwnerAddress, "connectedOwnerAddress")
      : null;

    const plannedTransfers = normalizePlannedTransfers(body.plannedTransfers);

    const sourceNetwork = networkByChainId(sourceChainId);
    const sourceProviderResult = await getProvider(sourceNetwork);
    sourceProvider = sourceProviderResult.provider;
    const sourceRpcUsed = sourceProviderResult.rpcUrl;

    const sourceSafeState = await inspectSafe(
      sourceProvider,
      smartAccountAddress,
    );

    const includeUnindexedLogs = body.includeUnindexedLogs === true;
    const includeGlobalFactorySearch = body.includeGlobalFactorySearch === true;

    const maxLogBatches = normalizePositiveInteger(
      body.maxLogBatches,
      DEFAULT_MAX_LOG_BATCHES,
      MAX_LOG_BATCHES,
    );

    const logBatchSize = normalizePositiveInteger(
      body.logBatchSize,
      DEFAULT_LOG_BATCH_SIZE,
      MAX_LOG_BATCH_SIZE,
    );

    const fromBlock = normalizeBlockTag(body.fromBlock, 0);
    const toBlock = normalizeBlockTag(body.scanCursor ?? body.toBlock, "latest");

    const relatedBlockRadius = normalizePositiveInteger(
      body.relatedBlockRadius,
      DEFAULT_RELATED_TX_BLOCK_RADIUS,
      MAX_RELATED_TX_BLOCK_RADIUS,
    );

    const creationTransactionHash =
      body.creationTransactionHash ?? body.relatedTransactionHash ?? null;

    if (creationTransactionHash) {
      normalizeHash(creationTransactionHash, "creationTransactionHash");
    }

    const discovery = await discoverSourceCreation({
      sourceProvider,
      sourceChainId,
      safeAddress: smartAccountAddress,
      manualSourceDeployment: body.sourceDeployment ?? null,
      creationTransactionHash,
      maxLogBatches,
      logBatchSize,
      fromBlock,
      toBlock,
      relatedBlockRadius,
      includeUnindexedLogs,
      includeGlobalFactorySearch,
    });

    const targets = [];

    for (const targetChainId of targetChainIds) {
      const targetNetwork = networkByChainId(targetChainId);
      let targetProvider = null;

      try {
        const targetProviderResult = await getProvider(targetNetwork);
        targetProvider = targetProviderResult.provider;

        const sourceDeployment = discovery.creation
          ? await deploymentFromCreation({
              sourceProvider,
              targetProvider,
              sourceChainId,
              targetChainId,
              safeAddress: smartAccountAddress,
              sourceSafeState,
              creation: discovery.creation,
            })
          : null;

        targets.push(
          await analyzeTarget({
            sourceChainId,
            targetChainId,
            targetProvider,
            targetRpcUsed: targetProviderResult.rpcUrl,
            targetNetwork,
            smartAccountAddress,
            connectedOwnerAddress,
            sourceSafeState,
            sourceDeployment,
            evidence: discovery.evidence,
            plannedTransfers,
          }),
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Target recovery analysis failed";

        targets.push({
          targetChainId: Number(targetChainId),
          targetNetwork: targetNetwork.name,
          analysis: {
            recoveryPossible: false,
            blockers: [message],
            warnings: [],
          },
          movementPlan: {
            canDeploy: false,
            canMoveTokens: false,
            deployTransaction: null,
            safeActions: [],
            tokenActions: [],
            nativeActions: [],
            actionCount: 0,
            tokenActionCount: 0,
            nativeActionCount: 0,
            blockers: [message],
            warnings: [],
            mainnetBroadcastPrepared: false,
            forkSimulationRequired: true,
            manualApprovalRequired: true,
          },
          evidence: discovery.evidence,
        });
      } finally {
        try {
          targetProvider?.destroy?.();
        } catch {}
      }
    }

    return json(request, response, 200, {
      ok: true,
      route: "counterfactual-safe-recovery",
      mode: "read-predict-prepare-only",
      sourceChainId,
      sourceNetwork: sourceNetwork.name,
      sourceRpcUsed,
      smartAccountAddress,
      connectedOwnerAddress,
      sourceSafeState,
      sourceCreation: {
        found: Boolean(discovery.creation),
        sourceUrl: discovery.creation?.sourceUrl ?? null,
        transactionHash: discovery.creation?.transactionHash ?? null,
        receiptVerified: discovery.creation?.receiptVerified === true,
        diagnosticOnly: discovery.creation?.diagnosticOnly === true,
        transport: discovery.creation?.transport ?? null,
        entryPoint: discovery.creation?.entryPoint ?? null,
        entryPointVersion: discovery.creation?.entryPointVersion ?? null,
        method: discovery.creation?.method ?? null,
        factory: discovery.creation?.factory ?? null,
        singleton: discovery.creation?.singleton ?? null,
        saltNonce: discovery.creation?.saltNonce ?? null,
      },
      targets,
      safety: {
        noPrivateKeys: true,
        noMainnetBroadcast: true,
        deployOnlyIfPredictedAddressMatches: true,
        verifiedCreationReceiptRequired: true,
        supportsDirectFactoryCreation: true,
        supportsEntryPointV07Creation: true,
        supportsEntryPointV06Creation: true,
        supportsDebugTraceFallback: true,
        sourceAndTargetProxyCreationCodeCompared: true,
        factoryRuntimeCodeCompared: true,
        singletonRuntimeCodeCompared: true,
        sourceSafeSingletonVerified: true,
        initializerSemanticsVerified: true,
        targetInitializerDependenciesVerified: true,
        globalFactorySearchDefault: false,
        boundedLogSearch: true,
        forkSimulationRequired: true,
        humanApprovalRequired: true,
      },
    });
  } catch (error) {
    return json(request, response, 400, {
      ok: false,
      route: "counterfactual-safe-recovery",
      error:
        error instanceof Error ? error.message : "No se pudo analizar recovery",
    });
  } finally {
    try {
      sourceProvider?.destroy?.();
    } catch {}
  }
}
