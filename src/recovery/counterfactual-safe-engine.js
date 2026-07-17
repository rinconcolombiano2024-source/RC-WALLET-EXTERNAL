import { ethers } from "ethers";
import { ERC20_ABI, SAFE_PROXY_FACTORY_ABI } from "../config.js";
import {
  SAFE_DEPLOYMENT_CATALOG_VERSION,
  SAFE_DEPLOYMENT_CATALOG_SOURCES,
  catalogEntriesForChain,
} from "./safe-deployment-catalog.js";

export const RECOVERY_ENGINE_VERSION = 1;

export const RECOVERY_STATES = Object.freeze({
  UNSUPPORTED_ACCOUNT: "unsupported-account",
  OWNER_MISMATCH: "owner-mismatch",
  SOURCE_DEPLOYMENT_NOT_FOUND: "source-deployment-not-found",
  MISSING_CALLDATA: "missing-calldata",
  MISSING_FACTORY: "missing-factory",
  MISSING_SINGLETON: "missing-singleton",
  MISSING_SALT: "missing-salt",
  CHAIN_SPECIFIC_ADDRESS: "chain-specific-address",
  PREDICTED_ADDRESS_MISMATCH: "predicted-address-mismatch",
  SIMULATION_FAILED: "simulation-failed",
  RECOVERABLE_IN_SIMULATION: "recoverable-in-simulation",
  READY_FOR_MANUAL_REVIEW: "ready-for-manual-review",
});

export const SAFE_DEPLOYMENT_METHODS = Object.freeze([
  "createProxyWithNonce",
  "createProxyWithNonceL2",
  "createProxyWithCallback",
  "createChainSpecificProxyWithNonce",
  "createChainSpecificProxyWithNonceL2",
]);

const CHAIN_SPECIFIC_METHODS = new Set([
  "createChainSpecificProxyWithNonce",
  "createChainSpecificProxyWithNonceL2",
]);

const SECRET_FIELD_PATTERN =
  /private.?key|seed|mnemonic|recovery.?phrase|secret|passphrase/i;

const factoryInterface = new ethers.Interface(SAFE_PROXY_FACTORY_ABI);
const erc20Interface = new ethers.Interface(ERC20_ABI);

export function assertNoSecrets(value, path = []) {
  if (!value || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...path, key];
    if (SECRET_FIELD_PATTERN.test(key)) {
      throw new Error(
        `Campo secreto prohibido en CounterfactualSafeRecoveryEngine: ${nextPath.join(".")}`,
      );
    }
    assertNoSecrets(child, nextPath);
  }
}

export function normalizeRecoveryAddress(address, label = "address") {
  try {
    return ethers.getAddress(String(address ?? "").trim().toLowerCase());
  } catch {
    throw new Error(`${label} invalida`);
  }
}

export function normalizeRecoveryHex(value, label) {
  const normalized = String(value ?? "").trim();
  if (!ethers.isHexString(normalized)) {
    throw new Error(`${label} debe ser bytes hex 0x...`);
  }
  return normalized;
}

export function uint256ToBytes32(value) {
  return ethers.zeroPadValue(ethers.toBeHex(BigInt(value)), 32);
}

export function isChainSpecificSafeMethod(deploymentMethod) {
  return CHAIN_SPECIFIC_METHODS.has(deploymentMethod);
}

export function getSafeEffectiveSaltNonce({
  deploymentMethod,
  saltNonce,
  callback,
}) {
  if (deploymentMethod !== "createProxyWithCallback") {
    return BigInt(saltNonce);
  }
  if (!callback) {
    throw new Error("Falta callback para createProxyWithCallback");
  }

  return BigInt(
    ethers.solidityPackedKeccak256(
      ["uint256", "address"],
      [BigInt(saltNonce), normalizeRecoveryAddress(callback, "callback")],
    ),
  );
}

export function createSafeDeploymentSalt({
  deploymentMethod,
  initializer,
  saltNonce,
  callback = null,
  chainId,
}) {
  if (!SAFE_DEPLOYMENT_METHODS.includes(deploymentMethod)) {
    throw new Error(`Metodo Safe no soportado: ${deploymentMethod}`);
  }

  const effectiveSaltNonce = getSafeEffectiveSaltNonce({
    deploymentMethod,
    saltNonce,
    callback,
  });
  const parts = [
    ethers.keccak256(normalizeRecoveryHex(initializer, "initializer")),
    uint256ToBytes32(effectiveSaltNonce),
  ];

  if (isChainSpecificSafeMethod(deploymentMethod)) {
    parts.push(uint256ToBytes32(chainId));
  }

  return ethers.keccak256(ethers.concat(parts));
}

export function predictCounterfactualSafeAddress({
  expectedAddress,
  factory,
  proxyCreationCode,
  singleton,
  initializer,
  saltNonce,
  deploymentMethod = "createProxyWithNonce",
  callback = null,
  chainId,
}) {
  assertNoSecrets(arguments[0]);

  const normalizedFactory = normalizeRecoveryAddress(factory, "factory");
  const normalizedSingleton = normalizeRecoveryAddress(singleton, "singleton");
  const normalizedInitializer = normalizeRecoveryHex(initializer, "initializer");
  const normalizedProxyCreationCode = normalizeRecoveryHex(
    proxyCreationCode,
    "proxyCreationCode",
  );
  const normalizedExpectedAddress = expectedAddress
    ? normalizeRecoveryAddress(expectedAddress, "expectedAddress")
    : null;
  const deploymentCode = ethers.concat([
    normalizedProxyCreationCode,
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address"],
      [normalizedSingleton],
    ),
  ]);
  const bytecodeHash = ethers.keccak256(deploymentCode);
  const salt = createSafeDeploymentSalt({
    deploymentMethod,
    initializer: normalizedInitializer,
    saltNonce,
    callback,
    chainId,
  });
  const predictedAddress = ethers.getCreate2Address(
    normalizedFactory,
    salt,
    bytecodeHash,
  );

  return {
    predictedAddress,
    expectedAddress: normalizedExpectedAddress,
    matches:
      Boolean(normalizedExpectedAddress) &&
      predictedAddress.toLowerCase() === normalizedExpectedAddress.toLowerCase(),
    factory: normalizedFactory,
    singleton: normalizedSingleton,
    initializer: normalizedInitializer,
    initializerHash: ethers.keccak256(normalizedInitializer),
    saltNonce: BigInt(saltNonce).toString(),
    create2Salt: salt,
    proxyCreationCodeHash: ethers.keccak256(normalizedProxyCreationCode),
    deploymentBytecodeHash: bytecodeHash,
    deploymentMethod,
    chainSpecific: isChainSpecificSafeMethod(deploymentMethod),
    callback: callback ? normalizeRecoveryAddress(callback, "callback") : null,
    chainId: Number(chainId),
    evidence: [
      "CREATE2 prediction uses Safe factory proxyCreationCode, singleton, initializer hash and salt nonce.",
      "Deployment is blocked unless predictedAddress equals expectedAddress byte for byte.",
    ],
  };
}

export function buildSafeDeploymentTransaction({
  factory,
  singleton,
  initializer,
  saltNonce,
  deploymentMethod = "createProxyWithNonce",
  callback = null,
}) {
  const normalizedFactory = normalizeRecoveryAddress(factory, "factory");
  const normalizedSingleton = normalizeRecoveryAddress(singleton, "singleton");
  const normalizedInitializer = normalizeRecoveryHex(initializer, "initializer");
  const normalizedSaltNonce = BigInt(saltNonce);
  let data;

  switch (deploymentMethod) {
    case "createProxyWithNonce":
    case "createProxyWithNonceL2":
    case "createChainSpecificProxyWithNonce":
    case "createChainSpecificProxyWithNonceL2":
      data = factoryInterface.encodeFunctionData(deploymentMethod, [
        normalizedSingleton,
        normalizedInitializer,
        normalizedSaltNonce,
      ]);
      break;
    case "createProxyWithCallback":
      data = factoryInterface.encodeFunctionData(deploymentMethod, [
        normalizedSingleton,
        normalizedInitializer,
        normalizedSaltNonce,
        normalizeRecoveryAddress(callback, "callback"),
      ]);
      break;
    default:
      throw new Error(`Metodo Safe no soportado: ${deploymentMethod}`);
  }

  return {
    to: normalizedFactory,
    value: "0",
    data,
    operation: 0,
    description: "Safe deployment transaction. Review and simulate before signing.",
  };
}

export function buildSafeActionForAssetTransfer({
  tokenAddress,
  recipient,
  amountUnits,
  native = false,
}) {
  const normalizedRecipient = normalizeRecoveryAddress(recipient, "recipient");
  const amount = BigInt(amountUnits);
  if (amount <= 0n) {
    throw new Error("amountUnits debe ser mayor que cero");
  }

  if (native) {
    return {
      to: normalizedRecipient,
      value: amount.toString(),
      data: "0x",
      operation: 0,
      description: "Native asset transfer to execute from the deployed Safe.",
    };
  }

  const normalizedToken = normalizeRecoveryAddress(tokenAddress, "tokenAddress");
  return {
    to: normalizedToken,
    value: "0",
    data: erc20Interface.encodeFunctionData("transfer", [
      normalizedRecipient,
      amount,
    ]),
    operation: 0,
    description: "ERC20 transfer to execute from the deployed Safe.",
  };
}

function missingSourceDeploymentFields(sourceDeployment) {
  const missing = [];
  if (!sourceDeployment) return ["sourceDeployment"];
  if (!sourceDeployment.factory) missing.push("factory");
  if (!sourceDeployment.singleton) missing.push("singleton");
  if (!sourceDeployment.initializer) missing.push("initializer");
  if (
    sourceDeployment.saltNonce === null ||
    sourceDeployment.saltNonce === undefined ||
    sourceDeployment.saltNonce === ""
  ) {
    missing.push("saltNonce");
  }
  if (!sourceDeployment.proxyCreationCode) missing.push("proxyCreationCode");
  if (!sourceDeployment.deploymentMethod && !sourceDeployment.method) {
    missing.push("deploymentMethod");
  }
  return missing;
}

function stateForMissingField(field) {
  if (field === "sourceDeployment") return RECOVERY_STATES.SOURCE_DEPLOYMENT_NOT_FOUND;
  if (field === "factory") return RECOVERY_STATES.MISSING_FACTORY;
  if (field === "singleton") return RECOVERY_STATES.MISSING_SINGLETON;
  if (field === "saltNonce") return RECOVERY_STATES.MISSING_SALT;
  return RECOVERY_STATES.MISSING_CALLDATA;
}

export function analyzeCounterfactualSafeRecovery(input) {
  assertNoSecrets(input);

  const {
    sourceChainId,
    targetChainId,
    smartAccountAddress,
    connectedOwnerAddress,
    sourceDeployment,
    targetDeploymentStatus = {},
    sourceSafeState = {},
    plannedTransfers = [],
  } = input ?? {};
  const expectedAddress = normalizeRecoveryAddress(
    smartAccountAddress,
    "smartAccountAddress",
  );
  const ownerAddress = connectedOwnerAddress
    ? normalizeRecoveryAddress(connectedOwnerAddress, "connectedOwnerAddress")
    : null;
  const normalizedOwners = (sourceSafeState.owners ?? []).map((owner) =>
    normalizeRecoveryAddress(owner, "sourceSafeState.owner"),
  );
  const ownerMatches = Boolean(
    ownerAddress &&
      normalizedOwners.some(
        (owner) => owner.toLowerCase() === ownerAddress.toLowerCase(),
      ),
  );
  const blockers = [];
  const warnings = [
    "No mainnet broadcast is performed by this engine.",
    "Run fork simulation and human review before signing any transaction.",
  ];
  const facts = [
    `sourceChainId=${Number(sourceChainId)}`,
    `targetChainId=${Number(targetChainId)}`,
    `expectedAddress=${expectedAddress}`,
  ];
  const inferences = [];
  const missing = missingSourceDeploymentFields(sourceDeployment);

  if (!ownerMatches) {
    blockers.push("connected owner is not an owner of the source Safe");
  }
  if (targetDeploymentStatus.hasCode) {
    blockers.push("target address already has code");
  }
  if (targetDeploymentStatus.factoryHasCode === false) {
    blockers.push("target Safe factory has no code");
  }
  if (targetDeploymentStatus.singletonHasCode === false) {
    blockers.push("target Safe singleton has no code");
  }
  if (missing.length) {
    blockers.push(`missing deployment data: ${missing.join(", ")}`);
  }

  let prediction = null;
  if (!missing.length) {
    prediction = predictCounterfactualSafeAddress({
      expectedAddress,
      factory: sourceDeployment.factory,
      proxyCreationCode: sourceDeployment.proxyCreationCode,
      singleton: sourceDeployment.singleton,
      initializer: sourceDeployment.initializer,
      saltNonce: sourceDeployment.saltNonce,
      deploymentMethod:
        sourceDeployment.deploymentMethod ?? sourceDeployment.method,
      callback: sourceDeployment.callback ?? null,
      chainId: targetChainId,
    });

    facts.push(`predictedAddress=${prediction.predictedAddress}`);
    inferences.push(
      prediction.matches
        ? "CREATE2 prediction matches target address"
        : "CREATE2 prediction does not match target address",
    );
    if (!prediction.matches) {
      blockers.push("predicted address mismatch");
    }
    if (prediction.chainSpecific && Number(sourceChainId) !== Number(targetChainId)) {
      warnings.push(
        "chain-specific Safe method includes chainId in the salt; cross-chain address equality is unlikely unless proven.",
      );
    }
  }

  const recoveryPossible =
    Boolean(prediction?.matches) &&
    ownerMatches &&
    !targetDeploymentStatus.hasCode &&
    targetDeploymentStatus.factoryHasCode !== false &&
    targetDeploymentStatus.singletonHasCode !== false &&
    blockers.length === 0;
  let state = RECOVERY_STATES.READY_FOR_MANUAL_REVIEW;

  if (!sourceDeployment) state = RECOVERY_STATES.SOURCE_DEPLOYMENT_NOT_FOUND;
  else if (!ownerMatches) state = RECOVERY_STATES.OWNER_MISMATCH;
  else if (missing.length) state = stateForMissingField(missing[0]);
  else if (prediction?.chainSpecific && !prediction.matches) {
    state = RECOVERY_STATES.CHAIN_SPECIFIC_ADDRESS;
  } else if (!prediction?.matches) {
    state = RECOVERY_STATES.PREDICTED_ADDRESS_MISMATCH;
  }

  const deployTransaction = recoveryPossible
    ? buildSafeDeploymentTransaction({
        factory: sourceDeployment.factory,
        singleton: sourceDeployment.singleton,
        initializer: sourceDeployment.initializer,
        saltNonce: sourceDeployment.saltNonce,
        deploymentMethod:
          sourceDeployment.deploymentMethod ?? sourceDeployment.method,
        callback: sourceDeployment.callback ?? null,
      })
    : null;
  const safeActions = recoveryPossible
    ? plannedTransfers.map(buildSafeActionForAssetTransfer)
    : [];

  return {
    engine: "CounterfactualSafeRecoveryEngine",
    version: RECOVERY_ENGINE_VERSION,
    catalogVersion: SAFE_DEPLOYMENT_CATALOG_VERSION,
    accountType: sourceSafeState.detected ? "safe-smart-account" : "unknown",
    sourceChainId: Number(sourceChainId),
    targetChainId: Number(targetChainId),
    smartAccountAddress: expectedAddress,
    connectedOwnerAddress: ownerAddress,
    ownerMatches,
    reconstructionStatus: state,
    predictedAddress: prediction?.predictedAddress ?? null,
    addressMatches: Boolean(prediction?.matches),
    recoveryPossible,
    blockers,
    evidence: {
      facts,
      inferences,
      missing,
      prediction,
      catalogEntries: catalogEntriesForChain(targetChainId),
      sources: SAFE_DEPLOYMENT_CATALOG_SOURCES,
    },
    warnings,
    deployment: {
      deployTransaction,
      safeActions,
      manualApprovalRequired: true,
      forkSimulationRequired: true,
      mainnetBroadcastPrepared: false,
    },
  };
}

export function createCounterfactualSafeRecoveryEngine(defaults = {}) {
  assertNoSecrets(defaults);

  return {
    analyze(input) {
      return analyzeCounterfactualSafeRecovery({
        ...defaults,
        ...input,
      });
    },
    predict: predictCounterfactualSafeAddress,
    buildSafeDeploymentTransaction,
    buildSafeActionForAssetTransfer,
  };
}
