import { ethers } from "ethers";
import {
  ERC1271_ABI,
  ERC20_ABI,
  ERC4337_ENTRYPOINTS,
  NETWORKS,
  SAFE_CLIENT_GATEWAY_URL,
  SAFE_CREATION_SERVICE_URLS,
  SAFE_FACTORY_CANDIDATES,
  SAFE_INTROSPECTION_ABI,
  SAFE_PROXY_FACTORY_ABI,
  TOKENS,
  WORLD_CHAIN_ID,
} from "./config.js";

const providerCache = new Map();
const ERC1271_MAGIC_VALUE = "0x1626ba7e";
const SAFE_SENTINEL = "0x0000000000000000000000000000000000000001";
const ERC20_INTERFACE = new ethers.Interface(ERC20_ABI);
const SAFE_PROXY_FACTORY_INTERFACE = new ethers.Interface(
  SAFE_PROXY_FACTORY_ABI,
);
const SAFE_PROXY_CREATION_TOPIC = ethers.id("ProxyCreation(address,address)");
const BPS_DENOMINATOR = 10_000n;
const GAS_LIMIT_BUFFER_BPS = 12_000n;
const GAS_PRICE_BUFFER_BPS = 12_000n;
const SAFE_OPERATION_CALL = 0;
const SAFE_CREATION_LOG_BATCH_SIZE = 250_000;
const SECP256K1_ORDER =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const safeDeploymentCache = new Map();

function timeout(promise, milliseconds, label) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`${label}: tiempo de espera agotado`)),
      milliseconds,
    );
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

function cleanAddressInput(address) {
  return String(address ?? "")
    .trim()
    .replace(/[\s\u200B-\u200D\uFEFF]/g, "");
}

function extractAddressCandidate(address) {
  const cleaned = cleanAddressInput(address);
  const match = cleaned.match(/0x[a-fA-F0-9]{40}/i);
  if (match?.[0]) return `0x${match[0].slice(2)}`;
  return cleaned.startsWith("0X") ? `0x${cleaned.slice(2)}` : cleaned;
}

export function normalizeAddress(address) {
  const candidate = extractAddressCandidate(address);
  if (!/^0x[a-fA-F0-9]{40}$/.test(candidate)) {
    throw new Error(
      "Introduce una dirección EVM completa: debe empezar por 0x y tener 42 caracteres",
    );
  }
  return ethers.getAddress(candidate.toLowerCase());
}

export function isValidEvmAddressInput(address) {
  try {
    normalizeAddress(address);
    return true;
  } catch {
    return false;
  }
}

export function normalizePrivateKey(privateKey) {
  const trimmed = String(privateKey ?? "").trim();
  const prefixed = /^0x/i.test(trimmed)
    ? `0x${trimmed.slice(2)}`
    : `0x${trimmed}`;

  if (!/^0x[a-fA-F0-9]{64}$/.test(prefixed)) {
    throw new Error(
      "La llave privada debe tener 64 caracteres hexadecimales",
    );
  }

  const value = BigInt(prefixed);
  if (value <= 0n || value >= SECP256K1_ORDER) {
    throw new Error("La llave privada no esta dentro del rango EVM valido");
  }

  return prefixed;
}

export function privateKeyToAddress(privateKey) {
  const normalizedPrivateKey = normalizePrivateKey(privateKey);
  const wallet = new ethers.Wallet(normalizedPrivateKey);
  return wallet.address;
}

export function safeOwnersInclude(accountState, signerAddress) {
  try {
    if (!accountState?.safe?.detected || !signerAddress) return false;
    const signer = normalizeAddress(signerAddress);
    return (accountState.safe.owners ?? []).some(
      (owner) => normalizeAddress(owner) === signer,
    );
  } catch {
    return false;
  }
}

export function safeMirrorOwnersInclude(accountState, signerAddress) {
  try {
    if (!accountState?.counterfactualSafe?.detected || !signerAddress) {
      return false;
    }
    const signer = normalizeAddress(signerAddress);
    return (accountState.counterfactualSafe.owners ?? []).some(
      (owner) => normalizeAddress(owner) === signer,
    );
  } catch {
    return false;
  }
}

function compactAddress(address) {
  try {
    const normalized = normalizeAddress(address);
    return `${normalized.slice(0, 8)}...${normalized.slice(-6)}`;
  } catch {
    return String(address ?? "");
  }
}

async function refreshSafeAccountState(provider, asset, owner) {
  try {
    const code = await timeout(
      provider.getCode(owner),
      7_000,
      "account code",
    );
    const hasCode = Boolean(code && code !== "0x");
    const [safe, counterfactualSafe] = await Promise.all([
      inspectSafeAccount(provider, owner, hasCode),
      inspectCounterfactualSafeMirror(provider, asset.network, owner, hasCode),
    ]);

    return {
      ...(asset.accountState ?? {}),
      address: owner,
      hasCode,
      kind: safe.detected
        ? "safe-smart-account"
        : hasCode
          ? (asset.accountState?.kind ?? "contract")
          : "no-contract",
      safe,
      counterfactualSafe,
    };
  } catch (error) {
    return {
      ...(asset.accountState ?? {}),
      address: owner,
      safe: {
        ...(asset.accountState?.safe ?? {}),
        detected: Boolean(asset.accountState?.safe?.detected),
        refreshError:
          error instanceof Error
            ? error.message
            : "No se pudo verificar Safe en vivo",
      },
    };
  }
}

function signerMismatchMessage({ asset, owner, signerAddress, accountState }) {
  const signer = compactAddress(signerAddress);
  const fundsAddress = compactAddress(owner);
  const base = `La llave cargada firma ${signer}, pero los fondos detectados estan en ${fundsAddress} en ${asset.networkName}.`;

  if (accountState?.safe?.detected) {
    const owners = (accountState.safe.owners ?? []).map(compactAddress);
    return `${base} Esa direccion si es Safe, pero esta llave no aparece como owner en esta red. Owners detectados: ${owners.join(", ") || "ninguno"}.`;
  }

  if (accountState?.counterfactualSafe?.detected) {
    const mirror = accountState.counterfactualSafe;
    const owners = (mirror.owners ?? []).map(compactAddress);
    if (safeMirrorOwnersInclude(accountState, signerAddress)) {
      return `${base} La misma direccion aparece como Safe en ${mirror.sourceNetworkName}, y esta llave si aparece como owner alli. En ${asset.networkName} todavia no hay contrato Safe desplegado; la ruta correcta es desplegar esa misma Safe con factory, singleton, initializer y salt originales, y despues ejecutar el movimiento desde Safe.`;
    }

    return `${base} La misma direccion aparece como Safe en ${mirror.sourceNetworkName}, pero esta llave no aparece como owner alli. Owners detectados: ${owners.join(", ") || "ninguno"}.`;
  }

  if (accountState?.hasCode) {
    return `${base} La direccion con fondos es un contrato/smart account, pero no expone owners Safe compatibles para ejecutar con esta llave.`;
  }

  return `${base} En esta red esa direccion no fue detectada como Safe; por seguridad solo puede moverla la llave privada exacta de ${fundsAddress}.`;
}

export function formatBalance(rawBalance, decimals, digits = 6) {
  const value = ethers.formatUnits(rawBalance, decimals);
  const [whole, fraction = ""] = value.split(".");
  const trimmed = fraction.slice(0, digits).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

export async function getProvider(network) {
  if (providerCache.has(network.chainId)) {
    return providerCache.get(network.chainId);
  }

  for (const rpcUrl of network.rpcUrls) {
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
        network.name,
      );

      if (Number(providerNetwork.chainId) !== network.chainId) {
        throw new Error("El RPC respondió con una chainId distinta");
      }

      await timeout(provider.getBlockNumber(), 7_000, network.name);
      providerCache.set(network.chainId, provider);
      return provider;
    } catch (error) {
      console.warn(`[RPC] ${network.name}: ${rpcUrl}`, error);
    }
  }

  throw new Error(`No hay un RPC disponible para ${network.name}`);
}

async function inspectSafeAccount(provider, owner, hasCode) {
  if (!hasCode) {
    return {
      detected: false,
      reason: "No hay contrato desplegado en esta red",
    };
  }

  const contract = new ethers.Contract(owner, SAFE_INTROSPECTION_ABI, provider);
  const [ownersResult, thresholdResult, versionResult] = await Promise.allSettled([
    timeout(contract.getOwners(), 7_000, "Safe owners"),
    timeout(contract.getThreshold(), 7_000, "Safe threshold"),
    timeout(contract.VERSION(), 7_000, "Safe version"),
  ]);

  if (
    ownersResult.status !== "fulfilled" ||
    thresholdResult.status !== "fulfilled"
  ) {
    return {
      detected: false,
      reason: "El contrato no expone métodos Safe estándar",
    };
  }

  const owners = Array.isArray(ownersResult.value)
    ? ownersResult.value.filter(ethers.isAddress).map((address) =>
        ethers.getAddress(address),
      )
    : [];
  const threshold = Number(thresholdResult.value);

  if (!owners.length || !Number.isFinite(threshold) || threshold <= 0) {
    return {
      detected: false,
      reason: "Los métodos Safe respondieron con datos no válidos",
    };
  }

  let modules = [];
  let modulesReadable = false;
  try {
    const page = await timeout(
      contract.getModulesPaginated(SAFE_SENTINEL, 10),
      7_000,
      "Safe modules",
    );
    const moduleList = Array.isArray(page?.[0]) ? page[0] : [];
    modules = moduleList.filter(ethers.isAddress).map((address) =>
      ethers.getAddress(address),
    );
    modulesReadable = true;
  } catch (error) {
    console.warn("[SAFE MODULES]", error);
  }

  return {
    detected: true,
    version:
      versionResult.status === "fulfilled" && versionResult.value
        ? String(versionResult.value)
        : "desconocida",
    owners,
    threshold,
    modules,
    modulesReadable,
    recoveryRequirement:
      "Para mover fondos debe firmar el número requerido de owners o existir un módulo autorizado",
  };
}

async function inspectErc1271(provider, owner, hasCode) {
  if (!hasCode) {
    return {
      checked: false,
      supported: false,
      reason: "EIP-1271 solo aplica a cuentas contrato",
    };
  }

  const iface = new ethers.Interface(ERC1271_ABI);
  try {
    const data = iface.encodeFunctionData("isValidSignature", [
      ethers.ZeroHash,
      "0x",
    ]);
    const raw = await timeout(
      provider.call({ to: owner, data }),
      7_000,
      "EIP-1271",
    );
    const [response] = iface.decodeFunctionResult("isValidSignature", raw);
    const normalizedResponse = String(response).toLowerCase();

    return {
      checked: true,
      supported: true,
      validForEmptyTest: normalizedResponse === ERC1271_MAGIC_VALUE,
      response: normalizedResponse,
      note:
        normalizedResponse === ERC1271_MAGIC_VALUE
          ? "El contrato aceptó la firma de prueba vacía; requiere revisión de seguridad"
          : "El método existe, pero la firma de prueba no autoriza movimiento",
    };
  } catch (error) {
    return {
      checked: true,
      supported: false,
      reason:
        error instanceof Error
          ? error.message
          : "El contrato no respondió a isValidSignature",
    };
  }
}

async function inspectEntryPoints(provider) {
  const results = await Promise.allSettled(
    ERC4337_ENTRYPOINTS.map(async (entryPoint) => {
      const address = normalizeAddress(entryPoint.address);
      const code = await timeout(
        provider.getCode(address),
        7_000,
        entryPoint.label,
      );

      return {
        ...entryPoint,
        address,
        deployed: Boolean(code && code !== "0x"),
      };
    }),
  );

  return results.map((result, index) => {
    const entryPoint = ERC4337_ENTRYPOINTS[index];
    if (result.status === "fulfilled") return result.value;

    return {
      ...entryPoint,
      deployed: false,
      error:
        result.reason instanceof Error
          ? result.reason.message
          : "No se pudo consultar EntryPoint",
    };
  });
}

function uint256ToBytes32(value) {
  return ethers.zeroPadValue(ethers.toBeHex(BigInt(value)), 32);
}

function getSafeEffectiveSaltNonce(method, saltNonce, callback) {
  if (method !== "createProxyWithCallback") {
    return BigInt(saltNonce);
  }

  if (!callback) {
    throw new Error("Falta el callback usado para crear la Safe original");
  }

  return BigInt(
    ethers.solidityPackedKeccak256(
      ["uint256", "address"],
      [BigInt(saltNonce), normalizeAddress(callback)],
    ),
  );
}

function createSafeDeploymentSalt({
  method,
  initializer,
  saltNonce,
  callback,
  chainId,
}) {
  const effectiveSaltNonce = getSafeEffectiveSaltNonce(
    method,
    saltNonce,
    callback,
  );
  const parts = [
    ethers.keccak256(initializer),
    uint256ToBytes32(effectiveSaltNonce),
  ];
  if (method === "createChainSpecificProxyWithNonce") {
    parts.push(uint256ToBytes32(chainId));
  }
  return ethers.keccak256(ethers.concat(parts));
}

async function predictSafeProxyAddress({
  provider,
  factory,
  singleton,
  initializer,
  saltNonce,
  callback,
  method,
  chainId,
}) {
  const factoryAddress = normalizeAddress(factory);
  const factoryContract = new ethers.Contract(
    factoryAddress,
    SAFE_PROXY_FACTORY_ABI,
    provider,
  );
  const proxyCreationCode = await timeout(
    factoryContract.proxyCreationCode(),
    7_000,
    "Safe proxyCreationCode",
  );
  const deploymentCode = ethers.concat([
    proxyCreationCode,
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address"],
      [normalizeAddress(singleton)],
    ),
  ]);
  const salt = createSafeDeploymentSalt({
    method,
    initializer,
    saltNonce,
    callback,
    chainId,
  });

  return ethers.getCreate2Address(
    factoryAddress,
    salt,
    ethers.keccak256(deploymentCode),
  );
}

async function getSafeProxyCreationLogs(provider, factory, proxy) {
  const normalizedProxy = normalizeAddress(proxy);
  const filter = {
    address: normalizeAddress(factory),
    topics: [
      SAFE_PROXY_CREATION_TOPIC,
      ethers.zeroPadValue(normalizedProxy, 32),
    ],
    fromBlock: 0,
    toBlock: "latest",
  };

  try {
    const indexedLogs = await timeout(
      provider.getLogs(filter),
      12_000,
      "Safe ProxyCreation logs",
    );
    if (indexedLogs.length) return indexedLogs;
  } catch {
    // Some RPCs reject wide log ranges; fallback below scans in batches.
  }

  const topicOnlyFilter = {
    address: normalizeAddress(factory),
    topics: [SAFE_PROXY_CREATION_TOPIC],
  };

  try {
    const latestBlock = await timeout(
      provider.getBlockNumber(),
      7_000,
      "latest block",
    );
    const logs = [];
    for (
      let toBlock = latestBlock;
      toBlock >= 0 && logs.length === 0;
      toBlock -= SAFE_CREATION_LOG_BATCH_SIZE
    ) {
      const fromBlock = Math.max(0, toBlock - SAFE_CREATION_LOG_BATCH_SIZE + 1);
      const batch = await timeout(
        provider.getLogs({
          ...topicOnlyFilter,
          fromBlock,
          toBlock,
        }),
        12_000,
        "Safe ProxyCreation logs batch",
      );
      logs.push(...batch.filter((log) => safeProxyCreationLogMatches(log, normalizedProxy)));
    }
    return logs;
  } catch {
    return [];
  }
}

function safeProxyCreationLogMatches(log, proxy) {
  try {
    const normalizedProxy = normalizeAddress(proxy);
    if (log.topics?.[1]) {
      const indexedProxy = normalizeAddress(`0x${log.topics[1].slice(-40)}`);
      if (indexedProxy === normalizedProxy) return true;
    }

    if (log.data && log.data !== "0x") {
      const [decodedProxy] = ethers.AbiCoder.defaultAbiCoder().decode(
        ["address", "address"],
        log.data,
      );
      return normalizeAddress(decodedProxy) === normalizedProxy;
    }
  } catch {
    return false;
  }

  return false;
}

function parseSafeFactoryTransaction(transaction) {
  if (!transaction?.data || transaction.data === "0x") return null;

  let parsed;
  try {
    parsed = SAFE_PROXY_FACTORY_INTERFACE.parseTransaction({
      data: transaction.data,
      value: transaction.value ?? 0n,
    });
  } catch {
    return null;
  }

  if (
    ![
      "createProxyWithNonce",
      "createProxyWithCallback",
      "createChainSpecificProxyWithNonce",
    ].includes(parsed.name)
  ) {
    return null;
  }

  return {
    method: parsed.name,
    singleton: normalizeAddress(parsed.args[0]),
    initializer: String(parsed.args[1]),
    saltNonce: BigInt(parsed.args[2]).toString(),
    callback:
      parsed.name === "createProxyWithCallback"
        ? normalizeAddress(parsed.args[3])
        : null,
  };
}

async function fetchJsonWithTimeout(url, milliseconds, label) {
  if (typeof fetch !== "function") {
    throw new Error("fetch no disponible");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), milliseconds);

  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`${label}: ${response.status} ${response.statusText}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

function normalizeSafeCreationPayload(payload, sourceUrl) {
  const data =
    payload?.creation ??
    payload?.data ??
    payload?.results?.[0] ??
    payload;
  if (!data || typeof data !== "object") return null;

  const transactionHash =
    data.transactionHash ??
    data.transaction_hash ??
    data.txHash ??
    data.tx_hash ??
    data.creationTxHash ??
    data.transaction?.txHash ??
    data.transaction?.hash ??
    null;
  const factory =
    data.factoryAddress ??
    data.factory_address ??
    data.factory ??
    data.createdBy ??
    null;
  const singleton =
    data.masterCopy ??
    data.master_copy ??
    data.singleton ??
    data.implementation ??
    null;
  const initializer =
    data.setupData ??
    data.setup_data ??
    data.initializer ??
    data.initData ??
    null;
  const saltNonce =
    data.saltNonce ??
    data.salt_nonce ??
    data.salt ??
    null;

  if (!transactionHash && !factory && !singleton && !initializer) {
    return null;
  }

  return {
    sourceUrl,
    transactionHash,
    factory: factory && ethers.isAddress(factory) ? normalizeAddress(factory) : null,
    singleton:
      singleton && ethers.isAddress(singleton) ? normalizeAddress(singleton) : null,
    initializer:
      typeof initializer === "string" && ethers.isHexString(initializer)
        ? initializer
        : null,
    saltNonce:
      saltNonce !== null && saltNonce !== undefined
        ? BigInt(saltNonce).toString()
        : null,
  };
}

async function readSafeCreationFromService(chainId, safeAddress) {
  const serviceUrls = SAFE_CREATION_SERVICE_URLS[chainId] ?? [];
  const urls = [
    `/api/safe-creation?chainId=${chainId}&safe=${safeAddress}`,
    ...serviceUrls.map(
      (baseUrl) => `${baseUrl}/api/v1/safes/${safeAddress}/creation/`,
    ),
    `${SAFE_CLIENT_GATEWAY_URL}/v1/chains/${chainId}/safes/${safeAddress}/creation`,
    `${SAFE_CLIENT_GATEWAY_URL}/v1/chains/${chainId}/safes/${safeAddress}`,
  ];
  const errors = [];

  for (const url of urls) {
    try {
      const payload = await fetchJsonWithTimeout(
        url,
        8_000,
        "Safe creation service",
      );
      const normalized = normalizeSafeCreationPayload(payload, url);
      if (normalized) return normalized;
      errors.push(`${url}: respuesta sin creacion`);
    } catch (error) {
      errors.push(
        `${url}: ${
          error instanceof Error ? error.message : "consulta fallida"
        }`,
      );
    }
  }

  return { errors };
}

async function buildDeploymentFromCreation({
  provider,
  safeAddress,
  creation,
}) {
  let parsed = null;
  let factory = creation.factory;

  if (creation.transactionHash) {
    const transaction = await timeout(
      provider.getTransaction(creation.transactionHash),
      7_000,
      "Safe creation transaction",
    );
    parsed = parseSafeFactoryTransaction(transaction);
    if (!factory && transaction?.to) {
      factory = normalizeAddress(transaction.to);
    }
  }

  if (!parsed && creation.singleton && creation.initializer && creation.saltNonce) {
    parsed = {
      method: "createProxyWithNonce",
      singleton: creation.singleton,
      initializer: creation.initializer,
      saltNonce: creation.saltNonce,
      callback: null,
    };
  }

  if (!parsed || !factory) return null;

  const predictedSourceAddress = await predictSafeProxyAddress({
    provider,
    factory,
    singleton: parsed.singleton,
    initializer: parsed.initializer,
    saltNonce: parsed.saltNonce,
    callback: parsed.callback,
    method: parsed.method,
    chainId: WORLD_CHAIN_ID,
  });

  if (!safeSameAddressForCore(predictedSourceAddress, safeAddress)) {
    return null;
  }

  return {
    ...parsed,
    factory,
    factoryVersion: "service",
    sourceChainId: WORLD_CHAIN_ID,
    sourceTransactionHash: creation.transactionHash ?? null,
    sourceUrl: creation.sourceUrl,
    predictedSourceAddress,
    canReplayCrossChain:
      parsed.method !== "createChainSpecificProxyWithNonce",
  };
}

async function findSafeDeploymentFromServices(owner, worldProvider) {
  const creation = await readSafeCreationFromService(WORLD_CHAIN_ID, owner);
  if (!creation || !("transactionHash" in creation || "factory" in creation)) {
    return {
      deployment: null,
      errors: creation?.errors ?? [],
    };
  }

  const deployment = await buildDeploymentFromCreation({
    provider: worldProvider,
    safeAddress: owner,
    creation,
  });

  return {
    deployment,
    errors: deployment ? [] : ["La creacion Safe no predice la direccion origen"],
  };
}

async function findSafeDeploymentOnWorldChain(owner) {
  const normalizedOwner = normalizeAddress(owner);
  const cacheKey = normalizedOwner.toLowerCase();
  if (safeDeploymentCache.has(cacheKey)) {
    return safeDeploymentCache.get(cacheKey);
  }

  const promise = (async () => {
    const worldNetwork = NETWORKS.find(
      (item) => item.chainId === WORLD_CHAIN_ID,
    );
    if (!worldNetwork) return null;

    const worldProvider = await getProvider(worldNetwork);
    try {
      const serviceResult = await findSafeDeploymentFromServices(
        normalizedOwner,
        worldProvider,
      );
      if (serviceResult.deployment) {
        return serviceResult.deployment;
      }
    } catch (error) {
      console.warn("[SAFE CREATION SERVICE]", error);
    }

    for (const candidate of SAFE_FACTORY_CANDIDATES) {
      const factory = normalizeAddress(candidate.factory);
      const factoryCode = await timeout(
        worldProvider.getCode(factory),
        7_000,
        "Safe factory code",
      );
      if (!factoryCode || factoryCode === "0x") continue;

      const logs = await getSafeProxyCreationLogs(
        worldProvider,
        factory,
        normalizedOwner,
      );
      for (const log of logs) {
        const transaction = await timeout(
          worldProvider.getTransaction(log.transactionHash),
          7_000,
          "Safe creation transaction",
        );
        const parsed = parseSafeFactoryTransaction(transaction);
        if (!parsed) continue;

        const predictedSourceAddress = await predictSafeProxyAddress({
          provider: worldProvider,
          factory,
          singleton: parsed.singleton,
          initializer: parsed.initializer,
          saltNonce: parsed.saltNonce,
          callback: parsed.callback,
          method: parsed.method,
          chainId: WORLD_CHAIN_ID,
        });
        if (!safeSameAddressForCore(predictedSourceAddress, normalizedOwner)) {
          continue;
        }

        return {
          ...parsed,
          factory,
          factoryVersion: candidate.version,
          sourceChainId: WORLD_CHAIN_ID,
          sourceTransactionHash: log.transactionHash,
          predictedSourceAddress,
          canReplayCrossChain:
            parsed.method !== "createChainSpecificProxyWithNonce",
        };
      }
    }

    return null;
  })();

  safeDeploymentCache.set(cacheKey, promise);
  return promise;
}

function safeSameAddressForCore(left, right) {
  try {
    return normalizeAddress(left) === normalizeAddress(right);
  } catch {
    return false;
  }
}

async function inspectCounterfactualSafeMirror(provider, network, owner, hasCode) {
  if (hasCode || network.chainId === WORLD_CHAIN_ID) {
    return {
      checked: false,
      detected: false,
      reason: hasCode
        ? "La cuenta ya tiene contrato en esta red"
        : "La red origen ya es World Chain",
    };
  }

  const worldNetwork = NETWORKS.find(
    (item) => item.chainId === WORLD_CHAIN_ID,
  );
  if (!worldNetwork) {
    return {
      checked: false,
      detected: false,
      reason: "World Chain no esta configurada",
    };
  }

  try {
    const worldProvider = await getProvider(worldNetwork);
    const worldCode = await timeout(
      worldProvider.getCode(owner),
      7_000,
      "World Chain Safe espejo",
    );
    const worldHasCode = Boolean(worldCode && worldCode !== "0x");
    const worldSafe = await inspectSafeAccount(
      worldProvider,
      owner,
      worldHasCode,
    );

    if (!worldSafe.detected) {
      return {
        checked: true,
        detected: false,
        sourceChainId: WORLD_CHAIN_ID,
        sourceNetworkName: worldNetwork.name,
        reason:
          worldSafe.reason ??
          "La misma direccion no fue detectada como Safe en World Chain",
      };
    }

    let deployment = null;
    let deploymentError = null;
    try {
      deployment = await findSafeDeploymentOnWorldChain(owner);
    } catch (error) {
      deploymentError =
        error instanceof Error
          ? error.message
          : "No se pudo recuperar la creacion original de la Safe";
    }
    let targetPrediction = null;
    let targetPredictionMatches = false;
    let targetFactoryHasCode = false;
    let targetSingletonHasCode = false;

    if (deployment) {
      const [factoryCode, singletonCode] = await Promise.all([
        timeout(
          provider.getCode(deployment.factory),
          7_000,
          "Safe factory target code",
        ),
        timeout(
          provider.getCode(deployment.singleton),
          7_000,
          "Safe singleton target code",
        ),
      ]);
      targetFactoryHasCode = Boolean(factoryCode && factoryCode !== "0x");
      targetSingletonHasCode = Boolean(singletonCode && singletonCode !== "0x");

      if (
        deployment.canReplayCrossChain &&
        targetFactoryHasCode &&
        targetSingletonHasCode
      ) {
        targetPrediction = await predictSafeProxyAddress({
          provider,
          factory: deployment.factory,
          singleton: deployment.singleton,
          initializer: deployment.initializer,
          saltNonce: deployment.saltNonce,
          callback: deployment.callback,
          method: deployment.method,
          chainId: network.chainId,
        });
        targetPredictionMatches = safeSameAddressForCore(
          targetPrediction,
          owner,
        );
      }
    }

    return {
      checked: true,
      detected: true,
      sourceChainId: WORLD_CHAIN_ID,
      sourceNetworkName: worldNetwork.name,
      address: owner,
      version: worldSafe.version,
      owners: worldSafe.owners,
      threshold: worldSafe.threshold,
      modules: worldSafe.modules,
      modulesReadable: worldSafe.modulesReadable,
      deploymentRequired: true,
      deployment: deployment
        ? {
            ...deployment,
            targetChainId: network.chainId,
            targetNetworkName: network.name,
            targetPrediction,
            targetPredictionMatches,
            targetFactoryHasCode,
            targetSingletonHasCode,
            ready:
              deployment.canReplayCrossChain &&
              targetPredictionMatches &&
              targetFactoryHasCode &&
              targetSingletonHasCode,
          }
        : null,
      deploymentError,
      requirement:
        deployment
          ? "Desplegar la misma Safe en esta red y ejecutar desde owner"
          : "Encontrar factory, singleton, initializer y salt originales antes de desplegar la Safe",
    };
  } catch (error) {
    return {
      checked: true,
      detected: false,
      sourceChainId: WORLD_CHAIN_ID,
      sourceNetworkName: worldNetwork.name,
      error:
        error instanceof Error
          ? error.message
          : "No se pudo revisar la Safe espejo en World Chain",
    };
  }
}

async function inspectAccount(provider, network, owner, accountCode, nativeBalance) {
  const hasCode = Boolean(accountCode && accountCode !== "0x");
  const [safe, erc1271, entryPoints, counterfactualSafe] = await Promise.all([
    inspectSafeAccount(provider, owner, hasCode),
    inspectErc1271(provider, owner, hasCode),
    inspectEntryPoints(provider),
    inspectCounterfactualSafeMirror(provider, network, owner, hasCode),
  ]);

  const entryPointAvailable = entryPoints.some((entryPoint) =>
    Boolean(entryPoint.deployed),
  );
  const codeHash = hasCode ? ethers.keccak256(accountCode) : null;
  const kind = safe.detected
    ? "safe-smart-account"
    : hasCode
      ? "contract"
      : "no-contract";

  return {
    address: owner,
    chainId: network.chainId,
    networkName: network.name,
    kind,
    hasCode,
    codeHash,
    nativeGas: {
      symbol: network.symbol,
      hasBalance: nativeBalance > 0n,
      balance: ethers.formatEther(nativeBalance),
      displayBalance: formatBalance(nativeBalance, 18),
      wei: nativeBalance.toString(),
    },
    safe,
    counterfactualSafe,
    erc1271,
    erc4337: {
      entryPointAvailable,
      entryPoints,
      requirement:
        "ERC-4337 además requiere bundler, paymaster opcional y firma válida según la smart account",
    },
    routeHints: {
      miniKit: Boolean(network.writableWithMiniKit),
      externalSignerRequired: !network.writableWithMiniKit,
      safeOrModuleRequired: hasCode,
      deterministicDeploymentUnknown: !hasCode,
      deterministicSafeMirror: Boolean(counterfactualSafe?.detected),
    },
  };
}

async function readToken(provider, network, owner, definition) {
  const rawAddress = definition.addresses?.[network.chainId];
  if (!rawAddress) return null;

  const address = normalizeAddress(rawAddress);
  const code = await timeout(
    provider.getCode(address),
    7_000,
    `${definition.symbol} bytecode`,
  );
  if (!code || code === "0x") return null;

  const contract = new ethers.Contract(address, ERC20_ABI, provider);
  const [rawBalance, decimalsValue, symbolValue] = await Promise.all([
    timeout(
      contract.balanceOf(owner),
      7_000,
      `${definition.symbol} balance`,
    ),
    timeout(
      contract.decimals(),
      7_000,
      `${definition.symbol} decimals`,
    ),
    timeout(contract.symbol(), 7_000, `${definition.symbol} symbol`),
  ]);

  if (rawBalance === 0n) return null;

  const decimals = Number(decimalsValue);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error(`${definition.symbol} devolvió decimales inválidos`);
  }

  return {
    id: `${network.chainId}:${address.toLowerCase()}`,
    network,
    chainId: network.chainId,
    networkName: network.name,
    address,
    isNative: false,
    symbol:
      typeof symbolValue === "string" && symbolValue.trim()
        ? symbolValue.trim()
        : definition.symbol,
    configuredSymbol: definition.symbol,
    decimals,
    rawBalance,
    balance: ethers.formatUnits(rawBalance, decimals),
    displayBalance: formatBalance(rawBalance, decimals),
    projectToken: Boolean(definition.projectToken),
    customToken: Boolean(definition.customToken),
  };
}

async function scanNetwork(network, owner, customTokens) {
  const provider = await getProvider(network);
  const [accountCode, nativeBalance] = await Promise.all([
    timeout(
      provider.getCode(owner),
      7_000,
      `${network.name} account code`,
    ),
    timeout(
      provider.getBalance(owner),
      7_000,
      `${network.name} native balance`,
    ),
  ]);
  const accountState = await inspectAccount(
    provider,
    network,
    owner,
    accountCode,
    nativeBalance,
  );
  const accountKind = accountState.kind;

  const assets = [];

  if (nativeBalance > 0n) {
    assets.push({
      id: `${network.chainId}:native`,
      network,
      chainId: network.chainId,
      networkName: network.name,
      address: null,
      isNative: true,
      symbol: network.symbol,
      configuredSymbol: network.symbol,
      decimals: 18,
      rawBalance: nativeBalance,
      balance: ethers.formatEther(nativeBalance),
      displayBalance: formatBalance(nativeBalance, 18),
      accountKind,
      accountState,
    });
  }

  const definitions = [
    ...TOKENS.filter((token) => token.addresses?.[network.chainId]),
    ...customTokens
      .filter((token) => token.chainId === network.chainId)
      .map((token) => ({
        symbol: token.symbol || "CUSTOM",
        customToken: true,
        addresses: { [network.chainId]: token.address },
      })),
  ];

  const results = await Promise.allSettled(
    definitions.map((definition) =>
      readToken(provider, network, owner, definition),
    ),
  );

  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      assets.push({ ...result.value, accountKind, accountState });
    } else if (result.status === "rejected") {
      console.warn(`[TOKEN] ${network.name}`, result.reason);
    }
  }

  return {
    network,
    accountKind,
    accountState,
    assets,
  };
}

export async function scanAllNetworks(ownerAddress, customTokens = []) {
  const owner = normalizeAddress(ownerAddress);
  const results = await Promise.allSettled(
    NETWORKS.map((network) => scanNetwork(network, owner, customTokens)),
  );

  const assets = [];
  const networks = {};

  results.forEach((result, index) => {
    const network = NETWORKS[index];
    if (result.status === "fulfilled") {
      assets.push(...result.value.assets);
      networks[network.chainId] = {
        status: "online",
        accountKind: result.value.accountKind,
        accountState: result.value.accountState,
      };
    } else {
      networks[network.chainId] = {
        status: "offline",
        error:
          result.reason instanceof Error
            ? result.reason.message
            : "No se pudo consultar la red",
      };
    }
  });

  const uniqueAssets = [...new Map(
    assets.map((asset) => [asset.id, asset]),
  ).values()];

  uniqueAssets.sort((left, right) => {
    if (left.chainId !== 480 && right.chainId === 480) return -1;
    if (right.chainId !== 480 && left.chainId === 480) return 1;
    if (left.chainId !== right.chainId) return left.chainId - right.chainId;
    return left.symbol.localeCompare(right.symbol);
  });

  return { owner, assets: uniqueAssets, networks };
}

export async function switchExternalNetwork(provider, network) {
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: network.chainHex }],
    });
  } catch (error) {
    if (error?.code !== 4902) throw error;

    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: network.chainHex,
          chainName: network.name,
          nativeCurrency: {
            name: network.symbol,
            symbol: network.symbol,
            decimals: 18,
          },
          rpcUrls: network.rpcUrls,
          blockExplorerUrls: [network.explorer],
        },
      ],
    });
  }
}

function applyBuffer(value, bps) {
  return (value * bps + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR;
}

function getGasPriceForMaxCost(feeData) {
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice;
  if (!gasPrice || gasPrice <= 0n) {
    throw new Error("La red no devolvio precio de gas valido");
  }

  return applyBuffer(BigInt(gasPrice), GAS_PRICE_BUFFER_BPS);
}

function prepareTransfer({
  asset,
  targetAddress,
  recipient,
  amount,
  feeRecipient,
  feeAmountUnits = 0n,
}) {
  const owner = normalizeAddress(targetAddress);
  const destination = normalizeAddress(recipient);
  if (owner === destination) {
    throw new Error("La direccion de destino es igual a la direccion origen");
  }

  const amountUnits = ethers.parseUnits(amount, asset.decimals);
  if (amountUnits <= 0n) {
    throw new Error("La cantidad debe ser mayor que cero");
  }
  if (amountUnits > asset.rawBalance) {
    throw new Error("La cantidad supera el balance detectado");
  }

  const feeUnits = BigInt(feeAmountUnits);
  if (feeUnits < 0n || feeUnits >= amountUnits) {
    throw new Error("La comision calculada no es valida");
  }

  if (feeUnits > 0n && !feeRecipient) {
    throw new Error("Falta la direccion que recibe la comision");
  }

  const recipientAmountUnits = amountUnits - feeUnits;
  if (recipientAmountUnits <= 0n) {
    throw new Error("El monto neto para el usuario debe ser mayor que cero");
  }

  const normalizedFeeRecipient =
    feeUnits > 0n && feeRecipient ? normalizeAddress(feeRecipient) : null;
  const txRequests = [];

  if (asset.isNative) {
    txRequests.push({
      to: destination,
      value: recipientAmountUnits,
    });

    if (normalizedFeeRecipient) {
      txRequests.push({
        to: normalizedFeeRecipient,
        value: feeUnits,
      });
    }
  } else {
    const tokenAddress = normalizeAddress(asset.address);
    txRequests.push({
      to: tokenAddress,
      data: ERC20_INTERFACE.encodeFunctionData("transfer", [
        destination,
        recipientAmountUnits,
      ]),
      value: 0n,
    });

    if (normalizedFeeRecipient) {
      txRequests.push({
        to: tokenAddress,
        data: ERC20_INTERFACE.encodeFunctionData("transfer", [
          normalizedFeeRecipient,
          feeUnits,
        ]),
        value: 0n,
      });
    }
  }

  return {
    owner,
    destination,
    amountUnits,
    feeUnits,
    recipientAmountUnits,
    requiredNativeValue: asset.isNative ? amountUnits : 0n,
    txRequests,
  };
}

async function estimateGasCost(provider, signer, txRequests, networkSymbol) {
  const [feeData, gasResults] = await Promise.all([
    provider.getFeeData(),
    Promise.allSettled(
      txRequests.map((transaction) => signer.estimateGas(transaction)),
    ),
  ]);

  let gasLimit = 0n;
  for (const result of gasResults) {
    if (result.status !== "fulfilled") {
      const message =
        result.reason instanceof Error
          ? result.reason.message
          : "La simulacion de gas fallo";
      throw new Error(
        `La red rechazo la simulacion antes de firmar: ${message}`,
      );
    }
    gasLimit += BigInt(result.value);
  }

  const bufferedGasLimit = applyBuffer(gasLimit, GAS_LIMIT_BUFFER_BPS);
  const maxGasPrice = getGasPriceForMaxCost(feeData);
  const estimatedMaxGasCost = bufferedGasLimit * maxGasPrice;

  return {
    gasLimit,
    bufferedGasLimit,
    maxGasPrice,
    estimatedMaxGasCost,
    displayEstimatedMaxGasCost: `${formatBalance(
      estimatedMaxGasCost,
      18,
      8,
    )} ${networkSymbol}`,
  };
}

async function assertCanPayNativeCosts({
  provider,
  signer,
  owner,
  asset,
  txRequests,
  requiredNativeValue,
}) {
  const [nativeBalance, gas] = await Promise.all([
    provider.getBalance(owner),
    estimateGasCost(provider, signer, txRequests, asset.network.symbol),
  ]);
  const requiredTotal = requiredNativeValue + gas.estimatedMaxGasCost;

  if (nativeBalance < requiredTotal) {
    throw new Error(
      `Saldo insuficiente para pagar gas en ${asset.networkName}. Tienes ${formatBalance(
        nativeBalance,
        18,
        8,
      )} ${asset.network.symbol}; necesitas aprox ${formatBalance(
        requiredTotal,
        18,
        8,
      )} ${asset.network.symbol} incluyendo gas.`,
    );
  }

  return {
    nativeBalance: nativeBalance.toString(),
    requiredTotal: requiredTotal.toString(),
    displayNativeBalance: `${formatBalance(nativeBalance, 18, 8)} ${
      asset.network.symbol
    }`,
    displayRequiredTotal: `${formatBalance(requiredTotal, 18, 8)} ${
      asset.network.symbol
    }`,
    gas: {
      gasLimit: gas.gasLimit.toString(),
      bufferedGasLimit: gas.bufferedGasLimit.toString(),
      maxGasPrice: gas.maxGasPrice.toString(),
      estimatedMaxGasCost: gas.estimatedMaxGasCost.toString(),
      displayEstimatedMaxGasCost: gas.displayEstimatedMaxGasCost,
    },
  };
}

function buildSingleSafeTransaction(asset, transfer) {
  if (transfer.txRequests.length !== 1) {
    throw new Error(
      "La ejecucion Safe directa solo admite un movimiento por firma. Usa monto sin comision o ejecuta una transaccion multiple desde Safe UI.",
    );
  }

  const transaction = transfer.txRequests[0];
  return {
    to: normalizeAddress(transaction.to),
    value: BigInt(transaction.value ?? 0n),
    data: transaction.data ?? "0x",
    operation: SAFE_OPERATION_CALL,
  };
}

export function buildSafeUiTransactionDraft({
  asset,
  targetAddress,
  recipient,
  amount,
  feeRecipient,
  feeAmountUnits = 0n,
  connectedExternalAddress,
}) {
  const transfer = prepareTransfer({
    asset,
    targetAddress,
    recipient,
    amount,
    feeRecipient,
    feeAmountUnits,
  });
  const transactions = transfer.txRequests.map((transaction) => ({
    to: normalizeAddress(transaction.to),
    value: BigInt(transaction.value ?? 0n).toString(),
    data: transaction.data ?? "0x",
    operation: SAFE_OPERATION_CALL,
  }));

  return {
    format: "rc-wallet-safe-ui-transaction-draft",
    version: 1,
    createdAt: new Date().toISOString(),
    safeAddress: transfer.owner,
    signerAddress: connectedExternalAddress
      ? normalizeAddress(connectedExternalAddress)
      : null,
    chainId: asset.chainId,
    network: asset.networkName,
    asset: {
      symbol: asset.symbol,
      tokenAddress: asset.address,
      isNative: asset.isNative,
      decimals: asset.decimals,
      amountUnits: transfer.amountUnits.toString(),
      recipientAmountUnits: transfer.recipientAmountUnits.toString(),
      feeUnits: transfer.feeUnits.toString(),
    },
    transactions,
    safeAppsSdk: {
      txs: transactions.map((transaction) => ({
        to: transaction.to,
        value: transaction.value,
        data: transaction.data,
      })),
    },
    transactionBuilder: {
      version: "1.0",
      chainId: String(asset.chainId),
      createdAt: Date.now(),
      meta: {
        name: `RC Wallet rescue ${asset.symbol}`,
        description:
          "Borrador generado por RC Wallet External para revisar, firmar y ejecutar desde Safe UI cuando la Safe requiere owners.",
        createdFromSafeAddress: transfer.owner,
        createdFromOwnerAddress: connectedExternalAddress
          ? normalizeAddress(connectedExternalAddress)
          : "",
      },
      transactions: transactions.map((transaction) => ({
        to: transaction.to,
        value: transaction.value,
        data: transaction.data,
        contractMethod: null,
        contractInputsValues: null,
      })),
    },
    review:
      "Verifica en Safe UI que la red, Safe, destino, token, monto y owners coinciden antes de firmar.",
  };
}

async function assertCanPaySafeExecutionCosts({
  provider,
  signerAddress,
  safeAddress,
  safeContract,
  execArgs,
  networkSymbol,
}) {
  const execData = safeContract.interface.encodeFunctionData(
    "execTransaction",
    execArgs,
  );
  const gasRequest = {
    from: signerAddress,
    to: safeAddress,
    data: execData,
    value: 0n,
  };

  const [nativeBalance, feeData, gasEstimate] = await Promise.all([
    provider.getBalance(signerAddress),
    provider.getFeeData(),
    provider.estimateGas(gasRequest),
  ]);

  const gasLimit = BigInt(gasEstimate);
  const bufferedGasLimit = applyBuffer(gasLimit, GAS_LIMIT_BUFFER_BPS);
  const maxGasPrice = getGasPriceForMaxCost(feeData);
  const estimatedMaxGasCost = bufferedGasLimit * maxGasPrice;

  if (nativeBalance < estimatedMaxGasCost) {
    throw new Error(
      `El owner Safe no tiene gas suficiente. Tiene ${formatBalance(
        nativeBalance,
        18,
        8,
      )} ${networkSymbol}; necesita aprox ${formatBalance(
        estimatedMaxGasCost,
        18,
        8,
      )} ${networkSymbol} para ejecutar la Safe.`,
    );
  }

  return {
    nativeBalance: nativeBalance.toString(),
    requiredTotal: estimatedMaxGasCost.toString(),
    displayNativeBalance: `${formatBalance(nativeBalance, 18, 8)} ${networkSymbol}`,
    displayRequiredTotal: `${formatBalance(estimatedMaxGasCost, 18, 8)} ${networkSymbol}`,
    gas: {
      gasLimit: gasLimit.toString(),
      bufferedGasLimit: bufferedGasLimit.toString(),
      maxGasPrice: maxGasPrice.toString(),
      estimatedMaxGasCost: estimatedMaxGasCost.toString(),
      displayEstimatedMaxGasCost: `${formatBalance(
        estimatedMaxGasCost,
        18,
        8,
      )} ${networkSymbol}`,
    },
  };
}

function createSafeTypedData({
  chainId,
  safeAddress,
  safeTx,
  safeTxGas,
  baseGas,
  gasPrice,
  gasToken,
  refundReceiver,
  nonce,
}) {
  return {
    domain: {
      chainId,
      verifyingContract: safeAddress,
    },
    types: {
      SafeTx: [
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "data", type: "bytes" },
        { name: "operation", type: "uint8" },
        { name: "safeTxGas", type: "uint256" },
        { name: "baseGas", type: "uint256" },
        { name: "gasPrice", type: "uint256" },
        { name: "gasToken", type: "address" },
        { name: "refundReceiver", type: "address" },
        { name: "nonce", type: "uint256" },
      ],
    },
    value: {
      to: safeTx.to,
      value: safeTx.value,
      data: safeTx.data,
      operation: safeTx.operation,
      safeTxGas,
      baseGas,
      gasPrice,
      gasToken,
      refundReceiver,
      nonce,
    },
  };
}

async function signSafeTransaction({
  provider,
  signer,
  signerAddress,
  safeAddress,
  safeTx,
  safeTxGas,
  baseGas,
  gasPrice,
  gasToken,
  refundReceiver,
  nonce,
  safeTxHash,
}) {
  if (signer.signingKey?.sign) {
    return signer.signingKey.sign(safeTxHash).serialized;
  }

  if (typeof signer.signTypedData !== "function") {
    throw new Error(
      "La wallet externa no expone firma tipada compatible con Safe",
    );
  }

  const network = await provider.getNetwork();
  const typedData = createSafeTypedData({
    chainId: Number(network.chainId),
    safeAddress,
    safeTx,
    safeTxGas,
    baseGas,
    gasPrice,
    gasToken,
    refundReceiver,
    nonce,
  });
  const signature = await signer.signTypedData(
    typedData.domain,
    typedData.types,
    typedData.value,
  );
  const recoveredAddress = normalizeAddress(
    ethers.verifyTypedData(
      typedData.domain,
      typedData.types,
      typedData.value,
      signature,
    ),
  );

  if (recoveredAddress !== signerAddress) {
    throw new Error(
      "La firma Safe no recupera la misma direccion owner conectada",
    );
  }

  return signature;
}

function safeTransactionServiceUrl(chainId) {
  const serviceUrl = SAFE_CREATION_SERVICE_URLS[Number(chainId)]?.[0];
  if (!serviceUrl) {
    throw new Error(
      "Esta red no tiene Safe Transaction Service configurado para proponer transacciones",
    );
  }
  return serviceUrl.replace(/\/+$/, "");
}

async function postSafeTransactionProposal({ chainId, safeAddress, payload }) {
  let proxiedProposal = null;

  try {
    proxiedProposal = await postSafeTransactionProposalViaRcApi({
      chainId,
      safeAddress,
      payload,
    });
  } catch (error) {
    if (isRcSafeProposalRejection(error)) throw error;
    console.warn("[RC Wallet] Safe proposal API fallback", error);
  }

  if (proxiedProposal) return proxiedProposal;

  const serviceUrl = safeTransactionServiceUrl(chainId);
  const url = `${serviceUrl}/api/v1/safes/${safeAddress}/multisig-transactions/`;
  const response = await timeout(
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    }),
    20_000,
    "Safe Transaction Service",
  );
  const responseBody = await readSafeProposalResponse(response);

  if (!response.ok) {
    throw new Error(
      `Safe Transaction Service rechazo la propuesta (${response.status}). ${formatSafeProposalDetail(
        responseBody,
      )}`,
    );
  }

  return {
    url,
    status: response.status,
    response: responseBody,
    via: "safe-transaction-service",
  };
}

async function postSafeTransactionProposalViaRcApi({
  chainId,
  safeAddress,
  payload,
}) {
  if (typeof window === "undefined" || typeof fetch !== "function") {
    return null;
  }

  const url = "/api/safe-propose";
  const response = await timeout(
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ chainId, safeAddress, payload }),
    }),
    20_000,
    "API RC Safe",
  );
  const contentType = response.headers?.get?.("content-type") ?? "";
  const responseBody = await readSafeProposalResponse(response);

  if (contentType.includes("text/html")) {
    return null;
  }

  if (!response.ok) {
    throw new Error(
      `API RC Safe rechazo la propuesta (${response.status}). ${formatSafeProposalDetail(
        responseBody,
      )}`,
    );
  }

  return {
    url,
    status: response.status,
    response: responseBody,
    via: "rc-wallet-api",
  };
}

async function readSafeProposalResponse(response) {
  const text = await response.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function formatSafeProposalDetail(detail) {
  if (!detail) return "";
  if (typeof detail === "string") return detail.slice(0, 240);
  return JSON.stringify(detail).slice(0, 240);
}

function isRcSafeProposalRejection(error) {
  return (
    error instanceof Error &&
    error.message.startsWith("API RC Safe rechazo la propuesta")
  );
}

async function buildSignedSafeProposal({
  provider,
  signer,
  signerAddress,
  asset,
  targetAddress,
  recipient,
  amount,
  feeRecipient,
  feeAmountUnits,
}) {
  const transfer = prepareTransfer({
    asset,
    targetAddress,
    recipient,
    amount,
    feeRecipient,
    feeAmountUnits,
  });
  const refreshedAccountState = await refreshSafeAccountState(
    provider,
    asset,
    transfer.owner,
  );

  if (!refreshedAccountState.safe?.detected) {
    throw new Error(
      "La propuesta Safe UI solo aplica cuando la Safe ya esta desplegada en esta red",
    );
  }
  if (!safeOwnersInclude(refreshedAccountState, signerAddress)) {
    throw new Error(
      "La wallet conectada no aparece como owner de la Safe en esta red",
    );
  }

  const safeAddress = transfer.owner;
  const safeContract = new ethers.Contract(
    safeAddress,
    SAFE_INTROSPECTION_ABI,
    signer,
  );
  const safeTx = buildSingleSafeTransaction(asset, transfer);
  const safeTxGas = 0n;
  const baseGas = 0n;
  const gasPrice = 0n;
  const gasToken = ethers.ZeroAddress;
  const refundReceiver = ethers.ZeroAddress;
  const nonce = await timeout(safeContract.nonce(), 7_000, "Safe nonce");
  const safeTxHash = await timeout(
    safeContract.getTransactionHash(
      safeTx.to,
      safeTx.value,
      safeTx.data,
      safeTx.operation,
      safeTxGas,
      baseGas,
      gasPrice,
      gasToken,
      refundReceiver,
      nonce,
    ),
    7_000,
    "Safe transaction hash",
  );
  const signature = await signSafeTransaction({
    provider,
    signer,
    signerAddress,
    safeAddress,
    safeTx,
    safeTxGas,
    baseGas,
    gasPrice,
    gasToken,
    refundReceiver,
    nonce,
    safeTxHash,
  });
  const payload = {
    safe: safeAddress,
    to: safeTx.to,
    value: safeTx.value.toString(),
    data: safeTx.data,
    operation: safeTx.operation,
    safeTxGas: safeTxGas.toString(),
    baseGas: baseGas.toString(),
    gasPrice: gasPrice.toString(),
    gasToken,
    refundReceiver,
    nonce: Number(nonce),
    contractTransactionHash: safeTxHash,
    sender: signerAddress,
    signature,
    origin: "RC Wallet External",
  };

  return {
    safeAddress,
    safeTx: {
      to: safeTx.to,
      value: safeTx.value.toString(),
      data: safeTx.data,
      operation: safeTx.operation,
    },
    safeTxHash,
    payload,
    signature,
    signerAddress,
    accountState: refreshedAccountState,
  };
}

export async function proposeSafeTransactionWithExternalWallet({
  provider,
  asset,
  targetAddress,
  recipient,
  amount,
  feeRecipient,
  feeAmountUnits = 0n,
}) {
  if (!provider?.request) {
    throw new Error("La conexion externa no expone un proveedor EIP-1193");
  }

  await switchExternalNetwork(provider, asset.network);
  const browserProvider = new ethers.BrowserProvider(provider);
  const signer = await browserProvider.getSigner();
  const signerAddress = normalizeAddress(await signer.getAddress());
  const signedProposal = await buildSignedSafeProposal({
    provider: browserProvider,
    signer,
    signerAddress,
    asset,
    targetAddress,
    recipient,
    amount,
    feeRecipient,
    feeAmountUnits,
  });
  const proposal = await postSafeTransactionProposal({
    chainId: asset.chainId,
    safeAddress: signedProposal.safeAddress,
    payload: signedProposal.payload,
  });

  return {
    route: "safe-service-proposal-external",
    ...signedProposal,
    proposal,
  };
}

export async function proposeSafeTransactionWithPrivateKeyWallet({
  privateKey,
  asset,
  targetAddress,
  recipient,
  amount,
  feeRecipient,
  feeAmountUnits = 0n,
}) {
  const provider = await getProvider(asset.network);
  const signer = new ethers.Wallet(normalizePrivateKey(privateKey), provider);
  const signerAddress = normalizeAddress(signer.address);
  const signedProposal = await buildSignedSafeProposal({
    provider,
    signer,
    signerAddress,
    asset,
    targetAddress,
    recipient,
    amount,
    feeRecipient,
    feeAmountUnits,
  });
  const proposal = await postSafeTransactionProposal({
    chainId: asset.chainId,
    safeAddress: signedProposal.safeAddress,
    payload: signedProposal.payload,
  });

  return {
    route: "safe-service-proposal-private-key",
    ...signedProposal,
    proposal,
  };
}

async function sendWithSafeOwnerSigner({
  provider,
  signer,
  signerAddress,
  asset,
  transfer,
  route,
}) {
  const safeState = asset.accountState?.safe;
  if (!safeState?.detected) {
    throw new Error("La direccion con fondos no fue detectada como Safe");
  }

  if (!safeOwnersInclude(asset.accountState, signerAddress)) {
    throw new Error(
      "La direccion firmante no aparece como owner de la Safe donde estan los fondos",
    );
  }

  const safeAddress = transfer.owner;
  const safeContract = new ethers.Contract(
    safeAddress,
    SAFE_INTROSPECTION_ABI,
    signer,
  );
  const [owners, threshold] = await Promise.all([
    timeout(safeContract.getOwners(), 7_000, "Safe owners"),
    timeout(safeContract.getThreshold(), 7_000, "Safe threshold"),
  ]);
  const liveAccountState = {
    safe: {
      detected: true,
      owners,
      threshold: Number(threshold),
    },
  };

  if (!safeOwnersInclude(liveAccountState, signerAddress)) {
    throw new Error(
      "La red ya no reconoce esta llave como owner de la Safe",
    );
  }

  if (Number(threshold) !== 1) {
    throw new Error(
      `Esta Safe requiere ${Number(
        threshold,
      )} firmas. RC Wallet puede ejecutar directo con llave privada solo cuando el umbral es 1; para mas firmas usa Safe UI o reune las firmas requeridas.`,
    );
  }

  const safeTx = buildSingleSafeTransaction(asset, transfer);
  const safeTxGas = 0n;
  const baseGas = 0n;
  const gasPrice = 0n;
  const gasToken = ethers.ZeroAddress;
  const refundReceiver = ethers.ZeroAddress;
  const nonce = await timeout(safeContract.nonce(), 7_000, "Safe nonce");
  const safeTxHash = await timeout(
    safeContract.getTransactionHash(
      safeTx.to,
      safeTx.value,
      safeTx.data,
      safeTx.operation,
      safeTxGas,
      baseGas,
      gasPrice,
      gasToken,
      refundReceiver,
      nonce,
    ),
    7_000,
    "Safe transaction hash",
  );
  const signature = await signSafeTransaction({
    provider,
    signer,
    signerAddress,
    safeAddress,
    safeTx,
    safeTxGas,
    baseGas,
    gasPrice,
    gasToken,
    refundReceiver,
    nonce,
    safeTxHash,
  });
  const execArgs = [
    safeTx.to,
    safeTx.value,
    safeTx.data,
    safeTx.operation,
    safeTxGas,
    baseGas,
    gasPrice,
    gasToken,
    refundReceiver,
    signature,
  ];
  const preflight = await assertCanPaySafeExecutionCosts({
    provider,
    signerAddress,
    safeAddress,
    safeContract,
    execArgs,
    networkSymbol: asset.network.symbol,
  });
  const transaction = await safeContract.execTransaction(...execArgs, {
    gasLimit: BigInt(preflight.gas.bufferedGasLimit),
  });
  const receipt = await transaction.wait(1);

  return {
    route,
    hash: transaction.hash,
    hashes: [transaction.hash],
    receipt,
    receipts: [receipt],
    safeTxHash,
    preflight,
  };
}

async function deployCounterfactualSafeMirror({
  provider,
  signer,
  signerAddress,
  asset,
  owner,
  accountState,
}) {
  const mirror = accountState?.counterfactualSafe;
  const deployment = mirror?.deployment;
  if (!mirror?.detected || !deployment) {
    throw new Error(
      "No se encontro la informacion original para desplegar esta Safe",
    );
  }

  if (!safeMirrorOwnersInclude(accountState, signerAddress)) {
    throw new Error(
      "La llave cargada no aparece como owner de la Safe World App",
    );
  }

  if (Number(mirror.threshold) !== 1) {
    throw new Error(
      `Esta Safe requiere ${Number(
        mirror.threshold,
      )} firmas. RC Wallet puede desplegar y mover directo solo con umbral 1; para mas firmas usa Safe UI o reune los owners requeridos.`,
    );
  }

  if (!deployment.canReplayCrossChain) {
    throw new Error(
      "La Safe original fue creada con despliegue dependiente de chainId; no se puede reproducir la misma direccion en otra red con seguridad.",
    );
  }

  if (!deployment.ready || !deployment.targetPredictionMatches) {
    throw new Error(
      "La prediccion de despliegue Safe no coincide exactamente con la direccion donde estan los fondos. No se desplegara por seguridad.",
    );
  }

  const safeAddress = normalizeAddress(owner);
  const currentCode = await timeout(
    provider.getCode(safeAddress),
    7_000,
    "Safe target code",
  );
  if (currentCode && currentCode !== "0x") {
    const safe = await inspectSafeAccount(provider, safeAddress, true);
    return {
      deployedNow: false,
      accountState: {
        ...accountState,
        hasCode: true,
        kind: safe.detected ? "safe-smart-account" : "contract",
        safe,
      },
      hashes: [],
      receipts: [],
    };
  }

  const factory = new ethers.Contract(
    deployment.factory,
    SAFE_PROXY_FACTORY_ABI,
    signer,
  );
  const deploySaltNonce = getSafeEffectiveSaltNonce(
    deployment.method,
    deployment.saltNonce,
    deployment.callback,
  );
  const gasEstimate = await timeout(
    factory.createProxyWithNonce.estimateGas(
      deployment.singleton,
      deployment.initializer,
      deploySaltNonce,
    ),
    12_000,
    "Safe deployment gas",
  );
  const feeData = await provider.getFeeData();
  const maxGasPrice = getGasPriceForMaxCost(feeData);
  const gasLimit = applyBuffer(BigInt(gasEstimate), GAS_LIMIT_BUFFER_BPS);
  const estimatedMaxGasCost = gasLimit * maxGasPrice;
  const nativeBalance = await timeout(
    provider.getBalance(signerAddress),
    7_000,
    "owner gas balance",
  );

  if (nativeBalance < estimatedMaxGasCost) {
    throw new Error(
      `El owner no tiene gas suficiente para desplegar la Safe en ${asset.networkName}. Tiene ${formatBalance(
        nativeBalance,
        18,
        8,
      )} ${asset.network.symbol}; necesita aprox ${formatBalance(
        estimatedMaxGasCost,
        18,
        8,
      )} ${asset.network.symbol}.`,
    );
  }

  const transaction = await factory.createProxyWithNonce(
    deployment.singleton,
    deployment.initializer,
    deploySaltNonce,
    { gasLimit },
  );
  const receipt = await transaction.wait(1);
  const deployedCode = await timeout(
    provider.getCode(safeAddress),
    7_000,
    "Safe deployed code",
  );
  if (!deployedCode || deployedCode === "0x") {
    throw new Error(
      "La transaccion de despliegue termino, pero la Safe no aparece en la direccion esperada",
    );
  }

  const safe = await inspectSafeAccount(provider, safeAddress, true);
  if (!safe.detected || !safeOwnersInclude({ safe }, signerAddress)) {
    throw new Error(
      "La Safe desplegada no reconoce esta llave como owner; se detiene antes de mover fondos.",
    );
  }

  return {
    deployedNow: true,
    hash: transaction.hash,
    hashes: [transaction.hash],
    receipt,
    receipts: [receipt],
    preflight: {
      nativeBalance: nativeBalance.toString(),
      requiredTotal: estimatedMaxGasCost.toString(),
      displayNativeBalance: `${formatBalance(nativeBalance, 18, 8)} ${
        asset.network.symbol
      }`,
      displayRequiredTotal: `${formatBalance(
        estimatedMaxGasCost,
        18,
        8,
      )} ${asset.network.symbol}`,
      gas: {
        gasLimit: gasEstimate.toString(),
        bufferedGasLimit: gasLimit.toString(),
        maxGasPrice: maxGasPrice.toString(),
        estimatedMaxGasCost: estimatedMaxGasCost.toString(),
        displayEstimatedMaxGasCost: `${formatBalance(
          estimatedMaxGasCost,
          18,
          8,
        )} ${asset.network.symbol}`,
      },
    },
    accountState: {
      ...accountState,
      hasCode: true,
      kind: "safe-smart-account",
      safe,
      counterfactualSafe: {
        ...mirror,
        deployedNow: true,
        deploymentHash: transaction.hash,
      },
    },
  };
}

async function deploySafeMirrorAndSend({
  provider,
  signer,
  signerAddress,
  asset,
  transfer,
  route,
}) {
  const deployment = await deployCounterfactualSafeMirror({
    provider,
    signer,
    signerAddress,
    asset,
    owner: transfer.owner,
    accountState: asset.accountState,
  });
  const deployedAsset = {
    ...asset,
    accountState: deployment.accountState,
  };
  const safeResult = await sendWithSafeOwnerSigner({
    provider,
    signer,
    signerAddress,
    asset: deployedAsset,
    transfer,
    route,
  });

  return {
    ...safeResult,
    deployment,
    hashes: [...(deployment.hashes ?? []), ...(safeResult.hashes ?? [])],
    receipts: [
      ...(deployment.receipts ?? []),
      ...(safeResult.receipts ?? []),
    ],
  };
}

async function sendPreparedTransactions(signer, txRequests) {
  const transactions = [];
  for (const txRequest of txRequests) {
    transactions.push(await signer.sendTransaction(txRequest));
  }

  const receipts = [];
  for (const transaction of transactions) {
    receipts.push(await transaction.wait(1));
  }

  return {
    hash: transactions[0]?.hash ?? null,
    hashes: transactions.map((transaction) => transaction.hash),
    receipt: receipts[0] ?? null,
    receipts,
  };
}

export async function sendWithExternalWallet({
  provider,
  asset,
  targetAddress,
  recipient,
  amount,
  feeRecipient,
  feeAmountUnits = 0n,
}) {
  if (!provider?.request) {
    throw new Error("La conexión externa no expone un proveedor EIP-1193");
  }

  const owner = normalizeAddress(targetAddress);
  const destination = normalizeAddress(recipient);
  if (owner === destination) {
    throw new Error("La dirección de destino es igual a la dirección origen");
  }

  await switchExternalNetwork(provider, asset.network);
  const browserProvider = new ethers.BrowserProvider(provider);
  const signer = await browserProvider.getSigner();
  const signerAddress = normalizeAddress(await signer.getAddress());
  const transfer = prepareTransfer({
    asset,
    targetAddress,
    recipient,
    amount,
    feeRecipient,
    feeAmountUnits,
  });

  if (signerAddress !== transfer.owner) {
    const refreshedAccountState = await refreshSafeAccountState(
      browserProvider,
      asset,
      transfer.owner,
    );
    const safeAsset = {
      ...asset,
      accountState: refreshedAccountState,
    };

    if (safeOwnersInclude(refreshedAccountState, signerAddress)) {
      return sendWithSafeOwnerSigner({
        provider: browserProvider,
        signer,
        signerAddress,
        asset: safeAsset,
        transfer,
        route: "safe-owner-external",
      });
    }

    if (safeMirrorOwnersInclude(refreshedAccountState, signerAddress)) {
      return deploySafeMirrorAndSend({
        provider: browserProvider,
        signer,
        signerAddress,
        asset: safeAsset,
        transfer,
        route: "safe-mirror-deploy-external",
      });
    }

    throw new Error(
      signerMismatchMessage({
        asset,
        owner: transfer.owner,
        signerAddress,
        accountState: refreshedAccountState,
      }),
    );
  }

  const amountUnits = ethers.parseUnits(amount, asset.decimals);
  if (amountUnits <= 0n) {
    throw new Error("La cantidad debe ser mayor que cero");
  }
  if (amountUnits > asset.rawBalance) {
    throw new Error("La cantidad supera el balance detectado");
  }
  const feeUnits = BigInt(feeAmountUnits);
  if (feeUnits < 0n || feeUnits >= amountUnits) {
    throw new Error("La comisión calculada no es válida");
  }
  const recipientAmountUnits = amountUnits - feeUnits;
  if (recipientAmountUnits <= 0n) {
    throw new Error("El monto neto para el usuario debe ser mayor que cero");
  }
  const normalizedFeeRecipient =
    feeUnits > 0n && feeRecipient ? normalizeAddress(feeRecipient) : null;
  const preflight = await assertCanPayNativeCosts({
    provider: browserProvider,
    signer,
    owner: transfer.owner,
    asset,
    txRequests: transfer.txRequests,
    requiredNativeValue: transfer.requiredNativeValue,
  });

  const transactions = [];
  if (asset.isNative) {
    const transaction = await signer.sendTransaction({
      to: destination,
      value: recipientAmountUnits,
    });
    transactions.push(transaction);

    if (normalizedFeeRecipient) {
      const feeTransaction = await signer.sendTransaction({
        to: normalizedFeeRecipient,
        value: feeUnits,
      });
      transactions.push(feeTransaction);
    }
  } else {
    const contract = new ethers.Contract(asset.address, ERC20_ABI, signer);
    const transaction = await contract.transfer(
      destination,
      recipientAmountUnits,
    );
    transactions.push(transaction);

    if (normalizedFeeRecipient) {
      const feeTransaction = await contract.transfer(
        normalizedFeeRecipient,
        feeUnits,
      );
      transactions.push(feeTransaction);
    }
  }

  const receipts = [];
  for (const transaction of transactions) {
    receipts.push(await transaction.wait(1));
  }

  return {
    hash: transactions[0]?.hash ?? null,
    hashes: transactions.map((transaction) => transaction.hash),
    receipt: receipts[0] ?? null,
    receipts,
    preflight,
  };
}

export async function sendWithPrivateKeyWallet({
  privateKey,
  asset,
  targetAddress,
  recipient,
  amount,
  feeRecipient,
  feeAmountUnits = 0n,
}) {
  const owner = normalizeAddress(targetAddress);
  const destination = normalizeAddress(recipient);
  if (owner === destination) {
    throw new Error("La direccion de destino es igual a la direccion origen");
  }

  const provider = await getProvider(asset.network);
  const signer = new ethers.Wallet(normalizePrivateKey(privateKey), provider);
  const signerAddress = normalizeAddress(signer.address);
  const transfer = prepareTransfer({
    asset,
    targetAddress,
    recipient,
    amount,
    feeRecipient,
    feeAmountUnits,
  });

  if (signerAddress !== transfer.owner) {
    const refreshedAccountState = await refreshSafeAccountState(
      provider,
      asset,
      transfer.owner,
    );
    const safeAsset = {
      ...asset,
      accountState: refreshedAccountState,
    };

    if (safeOwnersInclude(refreshedAccountState, signerAddress)) {
      return sendWithSafeOwnerSigner({
        provider,
        signer,
        signerAddress,
        asset: safeAsset,
        transfer,
        route: "safe-owner-private-key",
      });
    }

    if (safeMirrorOwnersInclude(refreshedAccountState, signerAddress)) {
      return deploySafeMirrorAndSend({
        provider,
        signer,
        signerAddress,
        asset: safeAsset,
        transfer,
        route: "safe-mirror-deploy-private-key",
      });
    }

    throw new Error(
      signerMismatchMessage({
        asset,
        owner: transfer.owner,
        signerAddress,
        accountState: refreshedAccountState,
      }),
    );
  }

  const amountUnits = ethers.parseUnits(amount, asset.decimals);
  if (amountUnits <= 0n) {
    throw new Error("La cantidad debe ser mayor que cero");
  }
  if (amountUnits > asset.rawBalance) {
    throw new Error("La cantidad supera el balance detectado");
  }
  const feeUnits = BigInt(feeAmountUnits);
  if (feeUnits < 0n || feeUnits >= amountUnits) {
    throw new Error("La comision calculada no es valida");
  }
  const recipientAmountUnits = amountUnits - feeUnits;
  if (recipientAmountUnits <= 0n) {
    throw new Error("El monto neto para el usuario debe ser mayor que cero");
  }
  const normalizedFeeRecipient =
    feeUnits > 0n && feeRecipient ? normalizeAddress(feeRecipient) : null;
  const preflight = await assertCanPayNativeCosts({
    provider,
    signer,
    owner: transfer.owner,
    asset,
    txRequests: transfer.txRequests,
    requiredNativeValue: transfer.requiredNativeValue,
  });

  const transactions = [];
  if (asset.isNative) {
    const transaction = await signer.sendTransaction({
      to: destination,
      value: recipientAmountUnits,
    });
    transactions.push(transaction);

    if (normalizedFeeRecipient) {
      const feeTransaction = await signer.sendTransaction({
        to: normalizedFeeRecipient,
        value: feeUnits,
      });
      transactions.push(feeTransaction);
    }
  } else {
    const contract = new ethers.Contract(asset.address, ERC20_ABI, signer);
    const transaction = await contract.transfer(
      destination,
      recipientAmountUnits,
    );
    transactions.push(transaction);

    if (normalizedFeeRecipient) {
      const feeTransaction = await contract.transfer(
        normalizedFeeRecipient,
        feeUnits,
      );
      transactions.push(feeTransaction);
    }
  }

  const receipts = [];
  for (const transaction of transactions) {
    receipts.push(await transaction.wait(1));
  }

  return {
    hash: transactions[0]?.hash ?? null,
    hashes: transactions.map((transaction) => transaction.hash),
    receipt: receipts[0] ?? null,
    receipts,
    preflight,
  };
}
