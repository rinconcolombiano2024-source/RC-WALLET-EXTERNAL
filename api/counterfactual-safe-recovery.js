import { ethers } from "ethers";
import {
  NETWORKS,
  SAFE_CLIENT_GATEWAY_URL,
  SAFE_CREATION_SERVICE_URLS,
  SAFE_FACTORY_CANDIDATES,
  SAFE_INTROSPECTION_ABI,
  SAFE_PROXY_FACTORY_ABI,
} from "../src/config.js";
import {
  analyzeCounterfactualSafeRecovery,
  assertNoSecrets,
  predictCounterfactualSafeAddress,
} from "../src/recovery/counterfactual-safe-engine.js";

const SAFE_SENTINEL = "0x0000000000000000000000000000000000000001";
const SAFE_PROXY_CREATION_TOPIC = ethers.id("ProxyCreation(address,address)");
const SAFE_PROXY_CREATION_L2_TOPIC = ethers.id(
  "ProxyCreationL2(address,address,bytes,uint256)",
);
const SAFE_CHAIN_SPECIFIC_PROXY_CREATION_L2_TOPIC = ethers.id(
  "ChainSpecificProxyCreationL2(address,address,bytes,uint256,uint256)",
);
const SAFE_CREATION_EVENT_TOPICS = [
  SAFE_PROXY_CREATION_TOPIC,
  SAFE_PROXY_CREATION_L2_TOPIC,
  SAFE_CHAIN_SPECIFIC_PROXY_CREATION_L2_TOPIC,
];
const SAFE_FALLBACK_HANDLER_STORAGE_SLOT =
  "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5";
const ETHERSCAN_V2_URL = "https://api.etherscan.io/v2/api";
const DEFAULT_LOG_BATCH_SIZE = 250_000;
const DEFAULT_MAX_LOG_BATCHES = 220;
const DEFAULT_RELATED_TX_BLOCK_RADIUS = 25_000;
const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;
const SAFE_SUPPORTED_CREATION_METHODS = new Set([
  "createProxyWithNonce",
  "createProxyWithNonceL2",
  "createProxyWithCallback",
  "createChainSpecificProxyWithNonce",
  "createChainSpecificProxyWithNonceL2",
]);
const factoryInterface = new ethers.Interface(SAFE_PROXY_FACTORY_ABI);

function setCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "content-type");
}

function json(response, status, body) {
  setCors(response);
  response.status(status).json(body);
}

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
  const value = String(address ?? "").trim().toLowerCase();
  if (!ADDRESS_PATTERN.test(value)) {
    throw new Error(`${label} invalida`);
  }
  return ethers.getAddress(value);
}

function normalizeHash(hash, label = "hash") {
  const value = String(hash ?? "").trim();
  if (!HASH_PATTERN.test(value)) {
    throw new Error(`${label} invalido`);
  }
  return value;
}

function normalizeHex(value, label) {
  const normalized = String(value ?? "").trim();
  if (!ethers.isHexString(normalized)) {
    throw new Error(`${label} debe ser hex 0x...`);
  }
  return normalized;
}

function normalizeSaltNonce(value, label = "saltNonce") {
  if (value === null || value === undefined || value === "") {
    throw new Error(`${label} requerido`);
  }
  return BigInt(value).toString();
}

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
  const proxyCreationCode = input.proxyCreationCode ?? null;

  if (!SAFE_SUPPORTED_CREATION_METHODS.has(method)) {
    throw new Error(`Metodo Safe no soportado: ${method}`);
  }

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
  };
}

function networkByChainId(chainId) {
  const network = NETWORKS.find(
    (candidate) => Number(candidate.chainId) === Number(chainId),
  );
  if (!network) {
    throw new Error(`Red no configurada: ${chainId}`);
  }
  return network;
}

async function getProvider(network) {
  const errors = [];
  for (const rpcUrl of network.rpcUrls ?? []) {
    try {
      const provider = new ethers.JsonRpcProvider(
        rpcUrl,
        network.chainId,
        {
          staticNetwork: true,
          batchMaxCount: 1,
        },
      );
      const providerNetwork = await timeout(
        provider.getNetwork(),
        7_000,
        `${network.name} getNetwork`,
      );
      if (Number(providerNetwork.chainId) !== Number(network.chainId)) {
        throw new Error("chainId inesperado");
      }
      await timeout(provider.getBlockNumber(), 7_000, `${network.name} block`);
      return { provider, rpcUrl };
    } catch (error) {
      errors.push({
        rpcUrl,
        error: error instanceof Error ? error.message : "RPC fallido",
      });
    }
  }

  const details = errors.map((item) => `${item.rpcUrl}: ${item.error}`).join("; ");
  throw new Error(`No hay RPC disponible para ${network.name}. ${details}`);
}

function addressFromStorageSlot(value) {
  if (!ethers.isHexString(value, 32)) return ethers.ZeroAddress;
  const address = ethers.getAddress(`0x${value.slice(-40)}`);
  return address === ethers.ZeroAddress ? ethers.ZeroAddress : address;
}

async function inspectSafe(provider, safeAddress) {
  const address = normalizeAddress(safeAddress, "smartAccountAddress");
  const code = await timeout(provider.getCode(address), 8_000, "account code");
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
  const [owners, threshold, nonce, version, modules, singletonSlot, fallbackSlot] =
    await Promise.allSettled([
      timeout(safe.getOwners(), 8_000, "Safe owners"),
      timeout(safe.getThreshold(), 8_000, "Safe threshold"),
      timeout(safe.nonce(), 8_000, "Safe nonce"),
      timeout(safe.VERSION(), 8_000, "Safe version"),
      timeout(safe.getModulesPaginated(SAFE_SENTINEL, 50), 8_000, "Safe modules"),
      timeout(provider.getStorage(address, 0n), 8_000, "Safe singleton slot"),
      timeout(
        provider.getStorage(address, SAFE_FALLBACK_HANDLER_STORAGE_SLOT),
        8_000,
        "Safe fallback handler slot",
      ),
    ]);

  if (owners.status === "fulfilled" && threshold.status === "fulfilled") {
    result.detected = true;
    result.owners = owners.value
      .filter((owner) => ethers.isAddress(owner))
      .map((owner) => ethers.getAddress(owner));
    result.threshold = Number(threshold.value);
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

  return result;
}

function explorerApiKey() {
  return (
    process.env.ETHERSCAN_API_KEY ||
    process.env.WORLDSCAN_API_KEY ||
    process.env.WORLD_SCAN_API_KEY ||
    process.env.EXPLORER_API_KEY ||
    ""
  );
}

function normalizeBlockTag(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  if (value === "latest") return "latest";
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0) {
    throw new Error("bloque invalido");
  }
  return numeric;
}

function normalizePositiveInteger(value, fallback, maximum) {
  const numeric = Number(value ?? fallback);
  if (!Number.isInteger(numeric) || numeric <= 0) return fallback;
  return maximum ? Math.min(numeric, maximum) : numeric;
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
  const response = await timeout(
    fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "RC-Wallet-External/1.0",
      },
    }),
    12_000,
    label,
  );
  const text = await response.text();
  let payload = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text.slice(0, 500);
    }
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return payload;
}

function normalizeCreationPayload(payload, sourceUrl) {
  const data =
    payload?.creation ??
    payload?.data ??
    payload?.results?.[0] ??
    payload?.result?.[0] ??
    payload;
  if (!data || typeof data !== "object") return null;
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

  return {
    sourceUrl,
    transactionHash:
      transactionHash && HASH_PATTERN.test(transactionHash) ? transactionHash : null,
    factory: factory && ethers.isAddress(factory) ? ethers.getAddress(factory) : null,
    singleton:
      singleton && ethers.isAddress(singleton) ? ethers.getAddress(singleton) : null,
    initializer:
      typeof initializer === "string" && ethers.isHexString(initializer)
        ? initializer
        : null,
    saltNonce:
      saltNonce !== null && saltNonce !== undefined
        ? BigInt(saltNonce).toString()
        : null,
    method:
      typeof method === "string" && SAFE_SUPPORTED_CREATION_METHODS.has(method)
        ? method
        : null,
    callback: callback && ethers.isAddress(callback) ? ethers.getAddress(callback) : null,
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
      (baseUrl) => `${baseUrl.replace(/\/+$/, "")}/api/v1/safes/${safeAddress}/creation/`,
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

function parseSafeFactoryTransaction(transaction) {
  if (!transaction?.data || transaction.data === "0x") return null;
  let parsed;

  try {
    parsed = factoryInterface.parseTransaction({
      data: transaction.data,
      value: transaction.value ?? 0n,
    });
  } catch {
    return null;
  }

  if (!parsed) return null;
  if (!SAFE_SUPPORTED_CREATION_METHODS.has(parsed.name)) return null;

  return {
    method: parsed.name,
    singleton: ethers.getAddress(parsed.args[0]),
    initializer: String(parsed.args[1]),
    saltNonce: BigInt(parsed.args[2]).toString(),
    callback:
      parsed.name === "createProxyWithCallback"
        ? ethers.getAddress(parsed.args[3])
        : null,
  };
}

function decodeCreationLog(log, proxy) {
  const topic = log.topics?.[0];
  if (!SAFE_CREATION_EVENT_TOPICS.includes(topic)) return null;

  try {
    let decodedProxy = null;
    let decodedData = [];

    if (log.topics?.[1]) {
      decodedProxy = ethers.getAddress(`0x${log.topics[1].slice(-40)}`);
      if (topic === SAFE_PROXY_CREATION_TOPIC) {
        decodedData =
          log.data && log.data !== "0x"
            ? ethers.AbiCoder.defaultAbiCoder().decode(["address"], log.data)
            : [];
      }
      if (topic === SAFE_PROXY_CREATION_L2_TOPIC) {
        decodedData = ethers.AbiCoder.defaultAbiCoder().decode(
          ["address", "bytes", "uint256"],
          log.data,
        );
      }
      if (topic === SAFE_CHAIN_SPECIFIC_PROXY_CREATION_L2_TOPIC) {
        decodedData = ethers.AbiCoder.defaultAbiCoder().decode(
          ["address", "bytes", "uint256", "uint256"],
          log.data,
        );
      }
    }
    if (!decodedProxy && log.data && log.data !== "0x") {
      if (topic === SAFE_PROXY_CREATION_TOPIC) {
        decodedData = ethers.AbiCoder.defaultAbiCoder().decode(
          ["address", "address"],
          log.data,
        );
      }
      if (topic === SAFE_PROXY_CREATION_L2_TOPIC) {
        decodedData = ethers.AbiCoder.defaultAbiCoder().decode(
          ["address", "address", "bytes", "uint256"],
          log.data,
        );
      }
      if (topic === SAFE_CHAIN_SPECIFIC_PROXY_CREATION_L2_TOPIC) {
        decodedData = ethers.AbiCoder.defaultAbiCoder().decode(
          ["address", "address", "bytes", "uint256", "uint256"],
          log.data,
        );
      }
      decodedProxy = ethers.getAddress(decodedData[0]);
      decodedData = decodedData.slice(1);
    }

    if (
      !decodedProxy ||
      decodedProxy.toLowerCase() !== normalizeAddress(proxy).toLowerCase()
    ) {
      return null;
    }

    if (topic === SAFE_PROXY_CREATION_TOPIC) {
      return {
        proxy: decodedProxy,
        singleton: decodedData[0] ? ethers.getAddress(decodedData[0]) : null,
        initializer: null,
        saltNonce: null,
        method: null,
        eventTopic: "ProxyCreation",
      };
    }
    if (topic === SAFE_PROXY_CREATION_L2_TOPIC) {
      return {
        proxy: decodedProxy,
        singleton: ethers.getAddress(decodedData[0]),
        initializer: String(decodedData[1]),
        saltNonce: BigInt(decodedData[2]).toString(),
        method: "createProxyWithNonceL2",
        eventTopic: "ProxyCreationL2",
      };
    }
    if (topic === SAFE_CHAIN_SPECIFIC_PROXY_CREATION_L2_TOPIC) {
      return {
        proxy: decodedProxy,
        singleton: ethers.getAddress(decodedData[0]),
        initializer: String(decodedData[1]),
        saltNonce: BigInt(decodedData[2]).toString(),
        method: "createChainSpecificProxyWithNonceL2",
        eventTopic: "ChainSpecificProxyCreationL2",
      };
    }
  } catch {
    return null;
  }
  return null;
}

function proxyCreationLogMatches(log, proxy) {
  return Boolean(decodeCreationLog(log, proxy));
}

async function creationFromReceiptLogs({
  provider,
  transactionHash,
  safeAddress,
}) {
  const normalizedSafe = normalizeAddress(safeAddress, "smartAccountAddress");
  const receipt = await timeout(
    provider.getTransactionReceipt(transactionHash),
    8_000,
    "creation transaction receipt",
  );
  if (!receipt?.logs?.length) return null;

  for (const log of receipt.logs) {
    const decoded = decodeCreationLog(log, normalizedSafe);
    if (!decoded) continue;

    if (decoded.initializer && decoded.saltNonce && decoded.method) {
      return {
        sourceUrl: "request.transactionReceipt",
        transactionHash,
        factory: ethers.getAddress(log.address),
        singleton: decoded.singleton,
        initializer: decoded.initializer,
        saltNonce: decoded.saltNonce,
        method: decoded.method,
        eventTopic: decoded.eventTopic,
        blockNumber: log.blockNumber,
      };
    }

    const transaction = await timeout(
      provider.getTransaction(log.transactionHash),
      8_000,
      "receipt creation tx",
    );
    const parsed = parseSafeFactoryTransaction(transaction);
    if (!parsed) continue;

    return {
      sourceUrl: "request.transactionReceipt",
      transactionHash: log.transactionHash,
      factory: ethers.getAddress(log.address),
      ...parsed,
      eventTopic: decoded.eventTopic,
      blockNumber: log.blockNumber,
    };
  }

  return null;
}

async function creationFromTransactionHash({
  provider,
  transactionHash,
  safeAddress,
}) {
  const normalizedHash = normalizeHash(transactionHash, "creationTransactionHash");
  const transaction = await timeout(
    provider.getTransaction(normalizedHash),
    8_000,
    "creation transaction",
  );
  const parsed = parseSafeFactoryTransaction(transaction);

  if (parsed && transaction?.to) {
    return {
      sourceUrl: "request.creationTransactionHash",
      transactionHash: normalizedHash,
      factory: ethers.getAddress(transaction.to),
      ...parsed,
    };
  }

  return creationFromReceiptLogs({
    provider,
    transactionHash: normalizedHash,
    safeAddress,
  });
}

function explorerRows(payload) {
  if (Array.isArray(payload?.result)) return payload.result;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.results)) return payload.results;
  return [];
}

function normalizeExplorerLog(row) {
  const topics = Array.isArray(row?.topics)
    ? row.topics
    : [
        row?.topic0,
        row?.topic1,
        row?.topic2,
        row?.topic3,
      ].filter(Boolean);
  const blockNumber =
    typeof row?.blockNumber === "string"
      ? Number(BigInt(row.blockNumber))
      : Number(row?.blockNumber ?? 0);

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
  };

  if (factoryVersion) base.factoryVersion = factoryVersion;
  if (decoded?.initializer && decoded?.saltNonce && decoded?.method) {
    return {
      ...base,
      singleton: decoded.singleton,
      initializer: decoded.initializer,
      saltNonce: decoded.saltNonce,
      method: decoded.method,
    };
  }

  return base;
}

async function readCreationFromExplorerGlobalLogs({
  chainId,
  safeAddress,
  fromBlock = 0,
  toBlock = "latest",
}) {
  const normalizedSafe = normalizeAddress(safeAddress, "smartAccountAddress");
  const checked = [];

  for (const eventTopic of SAFE_CREATION_EVENT_TOPICS) {
    const url = etherscanApiUrl(chainId, {
      module: "logs",
      action: "getLogs",
      fromBlock,
      toBlock,
      topic0: eventTopic,
      topic1: ethers.zeroPadValue(normalizedSafe, 32),
      topic0_1_opr: "and",
    });
    if (!url) return { creation: null, checked };

    try {
      const payload = await fetchJson(url, "Explorer global Safe creation logs");
      const logs = explorerRows(payload).map(normalizeExplorerLog);
      checked.push({
        source: "explorer-global-logs",
        eventTopic,
        fromBlock,
        toBlock,
        logs: logs.length,
      });

      const match = logs.find((log) =>
        proxyCreationLogMatches(log, normalizedSafe),
      );
      if (!match) continue;

      const decoded = decodeCreationLog(match, normalizedSafe);
      return {
        creation: creationFromMatchedLog({
          log: match,
          factory: match.address,
          decoded,
          sourceUrl: "explorer-global-proxy-creation-logs",
        }),
        checked,
      };
    } catch (error) {
      checked.push({
        source: "explorer-global-logs",
        eventTopic,
        error: error instanceof Error ? error.message : "explorer global log failed",
      });
    }
  }

  return { creation: null, checked };
}

async function readCreationFromExplorerLogs({
  chainId,
  safeAddress,
  fromBlock = 0,
  toBlock = "latest",
}) {
  const normalizedSafe = normalizeAddress(safeAddress, "smartAccountAddress");
  const checked = [];

  for (const candidate of SAFE_FACTORY_CANDIDATES) {
    const factory = normalizeAddress(candidate.factory, "factory");
    for (const eventTopic of SAFE_CREATION_EVENT_TOPICS) {
      const url = etherscanApiUrl(chainId, {
        module: "logs",
        action: "getLogs",
        fromBlock,
        toBlock,
        address: factory,
        topic0: eventTopic,
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
          eventTopic,
          fromBlock,
          toBlock,
          logs: logs.length,
        });

        const match = logs.find((log) =>
          proxyCreationLogMatches(log, normalizedSafe),
        );
        if (!match) continue;

        const decoded = decodeCreationLog(match, normalizedSafe);
        return {
          creation: creationFromMatchedLog({
            log: match,
            factory,
            decoded,
            sourceUrl: "explorer-proxy-creation-logs",
            factoryVersion: candidate.version,
          }),
          checked,
        };
      } catch (error) {
        checked.push({
          source: "explorer-logs",
          factory,
          version: candidate.version,
          eventTopic,
          error: error instanceof Error ? error.message : "explorer log failed",
        });
      }
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
    endblock: 99999999,
    sort: "asc",
  });
  if (!url) return { creation: null, checked };

  try {
    const payload = await fetchJson(url, "Explorer internal creation txs");
    const rows = explorerRows(payload);
    checked.push({
      source: "explorer-internal-transactions",
      rows: rows.length,
    });
    const match = rows.find((row) => {
      const contractAddress = row.contractAddress ?? row.contract_address;
      return (
        contractAddress &&
        ethers.isAddress(contractAddress) &&
        ethers.getAddress(contractAddress).toLowerCase() ===
          normalizedSafe.toLowerCase() &&
        HASH_PATTERN.test(row.hash ?? "")
      );
    });

    if (!match) return { creation: null, checked };

    return {
      creation: {
        sourceUrl: "explorer-internal-transactions",
        transactionHash: match.hash,
        factory:
          match.from && ethers.isAddress(match.from)
            ? ethers.getAddress(match.from)
            : null,
      },
      checked,
    };
  } catch (error) {
    checked.push({
      source: "explorer-internal-transactions",
      error: error instanceof Error ? error.message : "internal tx lookup failed",
    });
  }

  return { creation: null, checked };
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
    endblock: 99999999,
    sort: "asc",
  });
  if (!url) return { creation: null, checked };

  try {
    const payload = await fetchJson(url, "Explorer normal creation txs");
    const rows = explorerRows(payload);
    checked.push({
      source: "explorer-normal-transactions",
      rows: rows.length,
    });
    const match = rows.find((row) => {
      const contractAddress = row.contractAddress ?? row.contract_address;
      const to = row.to;
      return (
        HASH_PATTERN.test(row.hash ?? "") &&
        ((contractAddress &&
          ethers.isAddress(contractAddress) &&
          ethers.getAddress(contractAddress).toLowerCase() ===
            normalizedSafe.toLowerCase()) ||
          !to)
      );
    });

    if (!match) return { creation: null, checked };

    return {
      creation: {
        sourceUrl: "explorer-normal-transactions",
        transactionHash: match.hash,
        factory:
          match.from && ethers.isAddress(match.from)
            ? ethers.getAddress(match.from)
            : null,
      },
      checked,
    };
  } catch (error) {
    checked.push({
      source: "explorer-normal-transactions",
      error: error instanceof Error ? error.message : "normal tx lookup failed",
    });
  }

  return { creation: null, checked };
}

async function readCreationFromExplorer({
  chainId,
  safeAddress,
  sourceProvider,
  fromBlock = 0,
  toBlock = "latest",
}) {
  const checked = [];
  const logResult = await readCreationFromExplorerLogs({
    chainId,
    safeAddress,
    fromBlock,
    toBlock,
  });
  checked.push(...logResult.checked);
  if (logResult.creation) return { creation: logResult.creation, checked };

  const globalLogResult = await readCreationFromExplorerGlobalLogs({
    chainId,
    safeAddress,
    fromBlock,
    toBlock,
  });
  checked.push(...globalLogResult.checked);
  if (globalLogResult.creation) {
    return { creation: globalLogResult.creation, checked };
  }

  const internalResult = await readCreationFromExplorerInternalTransactions({
    chainId,
    safeAddress,
  });
  checked.push(...internalResult.checked);
  if (internalResult.creation?.transactionHash) {
    const creation = await creationFromTransactionHash({
      provider: sourceProvider,
      transactionHash: internalResult.creation.transactionHash,
      safeAddress,
    });
    return {
      creation: creation ?? internalResult.creation,
      checked,
    };
  }

  const normalResult = await readCreationFromExplorerNormalTransactions({
    chainId,
    safeAddress,
  });
  checked.push(...normalResult.checked);
  if (normalResult.creation?.transactionHash) {
    const creation = await creationFromTransactionHash({
      provider: sourceProvider,
      transactionHash: normalResult.creation.transactionHash,
      safeAddress,
    });
    return {
      creation: creation ?? normalResult.creation,
      checked,
    };
  }

  return { creation: null, checked };
}

async function searchCreationAroundTransaction({
  provider,
  safeAddress,
  transactionHash,
  blockRadius = DEFAULT_RELATED_TX_BLOCK_RADIUS,
  includeUnindexedLogs = false,
}) {
  if (!transactionHash) return { creation: null, checked: [] };
  const normalizedHash = normalizeHash(transactionHash, "relatedTransactionHash");
  const receipt = await timeout(
    provider.getTransactionReceipt(normalizedHash),
    8_000,
    "related transaction receipt",
  );
  if (!receipt?.blockNumber) {
    return {
      creation: null,
      checked: [{ source: "related-transaction-block", error: "sin recibo" }],
    };
  }

  const latestBlock = await timeout(provider.getBlockNumber(), 8_000, "latest block");
  const radius = normalizePositiveInteger(
    blockRadius,
    DEFAULT_RELATED_TX_BLOCK_RADIUS,
    500_000,
  );
  const fromBlock = Math.max(0, Number(receipt.blockNumber) - radius);
  const toBlock = Math.min(latestBlock, Number(receipt.blockNumber) + radius);
  const batches = Math.ceil((toBlock - fromBlock + 1) / 5_000);
  const result = await searchCreationLogs({
    provider,
    safeAddress,
    fromBlock,
    toBlock,
    maxLogBatches: batches,
    logBatchSize: 5_000,
    includeUnindexedLogs,
  });

  return {
    creation: result.creation,
    checked: [
      {
        source: "related-transaction-block-window",
        transactionHash: normalizedHash,
        blockNumber: Number(receipt.blockNumber),
        fromBlock,
        toBlock,
      },
      ...result.checked,
    ],
  };
}

async function searchCreationLogs({
  provider,
  safeAddress,
  fromBlock = 0,
  toBlock = "latest",
  maxLogBatches = DEFAULT_MAX_LOG_BATCHES,
  logBatchSize = DEFAULT_LOG_BATCH_SIZE,
  includeUnindexedLogs = false,
}) {
  const latestBlock = await timeout(provider.getBlockNumber(), 8_000, "latest block");
  const stopBlock = normalizeBlockTag(fromBlock, 0);
  const startBlock =
    normalizeBlockTag(toBlock, latestBlock) === "latest"
      ? latestBlock
      : Math.min(Number(normalizeBlockTag(toBlock, latestBlock)), latestBlock);
  const normalizedMaxBatches = normalizePositiveInteger(
    maxLogBatches,
    DEFAULT_MAX_LOG_BATCHES,
    2_000,
  );
  const normalizedLogBatchSize = normalizePositiveInteger(
    logBatchSize,
    DEFAULT_LOG_BATCH_SIZE,
    10_000_000,
  );
  const checked = [];
  const normalizedSafe = normalizeAddress(safeAddress, "smartAccountAddress");
  let nextScan = null;

  for (const candidate of SAFE_FACTORY_CANDIDATES) {
    const factory = normalizeAddress(candidate.factory, "factory");
    const code = await timeout(
      provider.getCode(factory),
      8_000,
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
      const indexedModes = includeUnindexedLogs ? [true, false] : [true];
      const logQueries = [];
      for (const eventTopic of SAFE_CREATION_EVENT_TOPICS) {
        for (const indexed of indexedModes) {
          logQueries.push({
            eventTopic,
            indexed,
            promise: timeout(
              provider.getLogs({
                address: factory,
                topics: indexed
                  ? [eventTopic, ethers.zeroPadValue(normalizedSafe, 32)]
                  : [eventTopic],
                fromBlock: rangeFromBlock,
                toBlock: rangeToBlock,
              }),
              12_000,
              indexed ? "ProxyCreation indexed logs" : "ProxyCreation logs",
            ),
          });
        }
      }

      const queryResults = await Promise.allSettled(
        logQueries.map((query) => query.promise),
      );
      for (let index = 0; index < logQueries.length; index += 1) {
        const { eventTopic, indexed } = logQueries[index];
        const queryResult = queryResults[index];
        if (queryResult.status === "rejected") {
          const error = queryResult.reason;
          checked.push({
            factory,
            version: candidate.version,
            fromBlock: rangeFromBlock,
            toBlock: rangeToBlock,
            eventTopic,
            indexed,
            error: error instanceof Error ? error.message : "log query failed",
          });
          continue;
        }

        const logs = queryResult.value;
          checked.push({
            factory,
            version: candidate.version,
            fromBlock: rangeFromBlock,
            toBlock: rangeToBlock,
            eventTopic,
            indexed,
            logs: logs.length,
          });

          const match = logs.find((log) =>
            proxyCreationLogMatches(log, normalizedSafe),
          );
          if (!match) continue;

          const decoded = decodeCreationLog(match, normalizedSafe);
          if (decoded?.initializer && decoded?.saltNonce && decoded?.method) {
            return {
              creation: {
                sourceUrl: "rpc-proxy-creation-logs",
                transactionHash: match.transactionHash,
                factory,
                singleton: decoded.singleton,
                initializer: decoded.initializer,
                saltNonce: decoded.saltNonce,
                method: decoded.method,
                eventTopic: decoded.eventTopic,
                factoryVersion: candidate.version,
                blockNumber: match.blockNumber,
              },
              checked,
            };
          }

          const transaction = await timeout(
            provider.getTransaction(match.transactionHash),
            8_000,
            "creation tx",
          );
          const parsed = parseSafeFactoryTransaction(transaction);
          if (!parsed) continue;

          return {
            creation: {
              sourceUrl: "rpc-proxy-creation-logs",
              transactionHash: match.transactionHash,
              factory,
              ...parsed,
              eventTopic: decoded?.eventTopic ?? null,
              factoryVersion: candidate.version,
            blockNumber: match.blockNumber,
          },
          checked,
        };
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
  maxLogBatches = DEFAULT_MAX_LOG_BATCHES,
  logBatchSize = DEFAULT_LOG_BATCH_SIZE,
}) {
  const latestBlock = await timeout(provider.getBlockNumber(), 8_000, "latest block");
  const stopBlock = normalizeBlockTag(fromBlock, 0);
  const startBlock =
    normalizeBlockTag(toBlock, latestBlock) === "latest"
      ? latestBlock
      : Math.min(Number(normalizeBlockTag(toBlock, latestBlock)), latestBlock);
  const normalizedMaxBatches = normalizePositiveInteger(
    maxLogBatches,
    DEFAULT_MAX_LOG_BATCHES,
    2_000,
  );
  const normalizedLogBatchSize = normalizePositiveInteger(
    logBatchSize,
    DEFAULT_LOG_BATCH_SIZE,
    10_000_000,
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

    const logQueries = SAFE_CREATION_EVENT_TOPICS.map((eventTopic) => ({
      eventTopic,
      promise: timeout(
        provider.getLogs({
          topics: [eventTopic, ethers.zeroPadValue(normalizedSafe, 32)],
          fromBlock: rangeFromBlock,
          toBlock: rangeToBlock,
        }),
        12_000,
        "Global ProxyCreation indexed logs",
      ),
    }));
    const queryResults = await Promise.allSettled(
      logQueries.map((query) => query.promise),
    );

    for (let index = 0; index < logQueries.length; index += 1) {
      const { eventTopic } = logQueries[index];
      const queryResult = queryResults[index];
      if (queryResult.status === "rejected") {
        const error = queryResult.reason;
        checked.push({
          source: "global-proxy-creation-logs",
          fromBlock: rangeFromBlock,
          toBlock: rangeToBlock,
          eventTopic,
          error: error instanceof Error ? error.message : "global log failed",
        });
        continue;
      }

      const logs = queryResult.value;
      checked.push({
        source: "global-proxy-creation-logs",
        fromBlock: rangeFromBlock,
        toBlock: rangeToBlock,
        eventTopic,
        logs: logs.length,
      });

      const match = logs.find((log) =>
        proxyCreationLogMatches(log, normalizedSafe),
      );
      if (!match) continue;

      const factory = ethers.getAddress(match.address);
      const decoded = decodeCreationLog(match, normalizedSafe);
      if (decoded?.initializer && decoded?.saltNonce && decoded?.method) {
        return {
          creation: {
            sourceUrl: "rpc-global-proxy-creation-logs",
            transactionHash: match.transactionHash,
            factory,
            singleton: decoded.singleton,
            initializer: decoded.initializer,
            saltNonce: decoded.saltNonce,
            method: decoded.method,
            eventTopic: decoded.eventTopic,
            blockNumber: match.blockNumber,
          },
          checked,
          nextScan,
        };
      }

      const transaction = await timeout(
        provider.getTransaction(match.transactionHash),
        8_000,
        "global creation tx",
      );
      const parsed = parseSafeFactoryTransaction(transaction);
      if (!parsed) {
        return {
          creation: {
            sourceUrl: "rpc-global-proxy-creation-logs",
            transactionHash: match.transactionHash,
            factory,
            singleton: decoded?.singleton ?? null,
            eventTopic: decoded?.eventTopic ?? null,
            blockNumber: match.blockNumber,
          },
          checked,
          nextScan,
        };
      }

      return {
        creation: {
          sourceUrl: "rpc-global-proxy-creation-logs",
          transactionHash: match.transactionHash,
          factory,
          ...parsed,
          eventTopic: decoded?.eventTopic ?? null,
          blockNumber: match.blockNumber,
        },
        checked,
        nextScan,
      };
    }
  }

  return { creation: null, checked, nextScan };
}

async function deploymentFromCreation({
  sourceProvider,
  targetProvider,
  targetChainId,
  creation,
}) {
  let parsed = null;
  let factory = creation?.factory ?? creation?.factoryAddress ?? null;

  if (creation?.transactionHash) {
    const transaction = await timeout(
      sourceProvider.getTransaction(creation.transactionHash),
      8_000,
      "creation transaction",
    );
    parsed = parseSafeFactoryTransaction(transaction);
    if (!factory && transaction?.to) factory = ethers.getAddress(transaction.to);
  }
  if (!parsed && creation?.singleton && creation?.initializer && creation?.saltNonce) {
    parsed = {
      method: creation.method ?? "createProxyWithNonce",
      singleton: creation.singleton,
      initializer: creation.initializer,
      saltNonce: creation.saltNonce,
      callback: creation.callback ?? null,
    };
  }
  if (!factory || !parsed) return null;

  const normalizedFactory = normalizeAddress(factory, "factory");
  const normalizedSingleton = normalizeAddress(parsed.singleton, "singleton");
  const targetFactoryCode = await timeout(
    targetProvider.getCode(normalizedFactory),
    8_000,
    "target factory code",
  );
  const targetSingletonCode = await timeout(
    targetProvider.getCode(normalizedSingleton),
    8_000,
    "target singleton code",
  );
  let proxyCreationCode = creation?.proxyCreationCode ?? null;
  if (!proxyCreationCode) {
    const factoryProvider =
      targetFactoryCode && targetFactoryCode !== "0x"
        ? targetProvider
        : sourceProvider;
    const factoryContract = new ethers.Contract(
      normalizedFactory,
      SAFE_PROXY_FACTORY_ABI,
      factoryProvider,
    );
    proxyCreationCode = await timeout(
      factoryContract.proxyCreationCode(),
      8_000,
      "proxyCreationCode",
    );
  }

  return {
    factory: normalizedFactory,
    singleton: normalizedSingleton,
    initializer: parsed.initializer,
    saltNonce: parsed.saltNonce,
    deploymentMethod: parsed.method,
    callback: parsed.callback ?? null,
    proxyCreationCode,
    sourceTransactionHash: creation.transactionHash ?? null,
    sourceUrl: creation.sourceUrl ?? null,
    targetChainId: Number(targetChainId),
    targetFactoryHasCode: Boolean(targetFactoryCode && targetFactoryCode !== "0x"),
    targetSingletonHasCode: Boolean(
      targetSingletonCode && targetSingletonCode !== "0x",
    ),
  };
}

async function buildSourceDeployment({
  sourceProvider,
  targetProvider,
  sourceChainId,
  targetChainId,
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
  };
  let creation = null;

  if (manualSourceDeployment) {
    creation = normalizeManualSourceDeploymentInput(manualSourceDeployment);
    evidence.manualSourceDeployment = "accepted";
  }
  if (!creation && creationTransactionHash) {
    creation = await creationFromTransactionHash({
      provider: sourceProvider,
      transactionHash: creationTransactionHash,
      safeAddress,
    });
    evidence.creationTransactionHashLookup = creation
      ? "matched"
      : "transaction did not expose Safe creation data";
  }
  if (!creation) {
    const serviceResult = await readCreationFromServices(sourceChainId, safeAddress);
    creation = serviceResult.creation;
    evidence.creationServices = serviceResult.errors;
  }
  if (!creation) {
    const explorerResult = await readCreationFromExplorer({
      chainId: sourceChainId,
      safeAddress,
      sourceProvider,
      fromBlock: normalizeBlockTag(fromBlock, 0),
      toBlock: normalizeBlockTag(toBlock, "latest"),
    });
    creation = explorerResult.creation;
    evidence.explorerSearch = explorerResult.checked;
  }
  if (!creation && creationTransactionHash) {
    const nearbyResult = await searchCreationAroundTransaction({
      provider: sourceProvider,
      safeAddress,
      transactionHash: creationTransactionHash,
      blockRadius: relatedBlockRadius,
      includeUnindexedLogs,
    });
    creation = nearbyResult.creation;
    evidence.relatedTransactionBlockSearch = nearbyResult.checked;
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
    creation = logResult.creation;
    evidence.logSearch = logResult.checked;
    evidence.nextScan = logResult.nextScan;
  }
  if (!creation && includeGlobalFactorySearch) {
    const globalLogResult = await searchGlobalProxyCreationLogs({
      provider: sourceProvider,
      safeAddress,
      fromBlock,
      toBlock,
      maxLogBatches,
      logBatchSize,
    });
    creation = globalLogResult.creation;
    evidence.globalLogSearch = globalLogResult.checked;
    evidence.nextScan = globalLogResult.nextScan ?? evidence.nextScan;
  }
  if (!creation) return { sourceDeployment: null, evidence };

  const sourceDeployment = await deploymentFromCreation({
    sourceProvider,
    targetProvider,
    targetChainId,
    creation,
  });

  return { sourceDeployment, evidence };
}

async function analyzeTarget({
  sourceChainId,
  targetChainId,
  sourceProvider,
  targetNetwork,
  smartAccountAddress,
  connectedOwnerAddress,
  sourceSafeState,
  sourceDeployment,
  evidence,
  plannedTransfers,
}) {
  const { provider: targetProvider, rpcUrl } = await getProvider(targetNetwork);
  const targetCode = await timeout(
    targetProvider.getCode(smartAccountAddress),
    8_000,
    "target account code",
  );
  const targetDeploymentStatus = {
    hasCode: Boolean(targetCode && targetCode !== "0x"),
    codeHash: targetCode && targetCode !== "0x" ? ethers.keccak256(targetCode) : null,
    factoryHasCode: sourceDeployment?.targetFactoryHasCode ?? null,
    singletonHasCode: sourceDeployment?.targetSingletonHasCode ?? null,
  };
  const analysis = analyzeCounterfactualSafeRecovery({
    sourceChainId,
    targetChainId,
    smartAccountAddress,
    connectedOwnerAddress,
    sourceDeployment,
    targetDeploymentStatus,
    sourceSafeState,
    plannedTransfers,
  });
  let sourcePrediction = null;
  if (sourceDeployment) {
    try {
      sourcePrediction = predictCounterfactualSafeAddress({
        expectedAddress: smartAccountAddress,
        factory: sourceDeployment.factory,
        proxyCreationCode: sourceDeployment.proxyCreationCode,
        singleton: sourceDeployment.singleton,
        initializer: sourceDeployment.initializer,
        saltNonce: sourceDeployment.saltNonce,
        deploymentMethod: sourceDeployment.deploymentMethod,
        callback: sourceDeployment.callback,
        chainId: sourceChainId,
      });
    } catch (error) {
      sourcePrediction = {
        error: error instanceof Error ? error.message : "source prediction failed",
      };
    }
  }

  return {
    targetChainId: Number(targetChainId),
    targetNetwork: targetNetwork.name,
    targetRpcUsed: rpcUrl,
    sourcePrediction,
    targetDeploymentStatus,
    sourceDeployment,
    analysis,
    movementPlan: summarizeMovementPlan(analysis),
    evidence,
  };
}

function parseTargetChainIds(body) {
  const values = Array.isArray(body.targetChainIds)
    ? body.targetChainIds
    : body.targetChainId
      ? [body.targetChainId]
      : [];
  if (!values.length) {
    throw new Error("Debes indicar targetChainId o targetChainIds");
  }
  return [...new Set(values.map((value) => Number(value)))];
}

export default async function handler(request, response) {
  setCors(response);

  if (request.method === "OPTIONS") {
    return response.status(204).end();
  }
  if (request.method !== "POST") {
    return json(response, 405, { error: "Metodo no permitido" });
  }

  try {
    const body = request.body ?? {};
    assertNoSecrets(body);

    const sourceChainId = Number(body.sourceChainId);
    const targetChainIds = parseTargetChainIds(body);
    const smartAccountAddress = normalizeAddress(
      body.smartAccountAddress,
      "smartAccountAddress",
    );
    const connectedOwnerAddress = body.connectedOwnerAddress
      ? normalizeAddress(body.connectedOwnerAddress, "connectedOwnerAddress")
      : null;
    const sourceNetwork = networkByChainId(sourceChainId);
    const { provider: sourceProvider, rpcUrl: sourceRpcUsed } =
      await getProvider(sourceNetwork);
    const sourceSafeState = await inspectSafe(sourceProvider, smartAccountAddress);

    const targets = [];
    for (const targetChainId of targetChainIds) {
      const targetNetwork = networkByChainId(targetChainId);
      const { provider: targetProvider } = await getProvider(targetNetwork);
      const { sourceDeployment, evidence } = await buildSourceDeployment({
        sourceProvider,
        targetProvider,
        sourceChainId,
        targetChainId,
        safeAddress: smartAccountAddress,
        manualSourceDeployment: body.sourceDeployment ?? null,
        creationTransactionHash:
          body.creationTransactionHash ?? body.relatedTransactionHash ?? null,
        maxLogBatches: body.maxLogBatches ?? DEFAULT_MAX_LOG_BATCHES,
        logBatchSize: body.logBatchSize ?? DEFAULT_LOG_BATCH_SIZE,
        fromBlock: body.fromBlock ?? 0,
        toBlock: body.scanCursor ?? body.toBlock ?? "latest",
        relatedBlockRadius:
          body.relatedBlockRadius ?? DEFAULT_RELATED_TX_BLOCK_RADIUS,
        includeUnindexedLogs: Boolean(body.includeUnindexedLogs),
        includeGlobalFactorySearch: body.includeGlobalFactorySearch !== false,
      });
      targets.push(
        await analyzeTarget({
          sourceChainId,
          targetChainId,
          sourceProvider,
          targetNetwork,
          smartAccountAddress,
          connectedOwnerAddress,
          sourceSafeState,
          sourceDeployment,
          evidence,
          plannedTransfers: Array.isArray(body.plannedTransfers)
            ? body.plannedTransfers
            : [],
        }),
      );
    }

    return json(response, 200, {
      ok: true,
      route: "counterfactual-safe-recovery",
      mode: "read-predict-prepare-only",
      sourceChainId,
      sourceNetwork: sourceNetwork.name,
      sourceRpcUsed,
      smartAccountAddress,
      connectedOwnerAddress,
      sourceSafeState,
      targets,
      safety: {
        noPrivateKeys: true,
        noMainnetBroadcast: true,
        deployOnlyIfPredictedAddressMatches: true,
        humanApprovalRequired: true,
      },
    });
  } catch (error) {
    return json(response, 400, {
      ok: false,
      route: "counterfactual-safe-recovery",
      error: error instanceof Error ? error.message : "No se pudo analizar recovery",
    });
  }
}
