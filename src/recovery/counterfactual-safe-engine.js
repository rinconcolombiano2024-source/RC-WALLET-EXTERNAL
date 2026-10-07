import { ethers } from "ethers";
import {
  ERC20_ABI,
  SAFE_MODULE_SETUP_ABI,
  SAFE_PROXY_FACTORY_ABI,
  SAFE_PROXY_FACTORY_V141_METHODS,
} from "../config.js";
import {
  SAFE_DEPLOYMENT_CATALOG_VERSION,
  SAFE_DEPLOYMENT_CATALOG_SOURCES,
  catalogEntriesForChain,
} from "./safe-deployment-catalog.js";

export const RECOVERY_ENGINE_VERSION = 3;

export const RECOVERY_STATES = Object.freeze({
  UNSUPPORTED_ACCOUNT: "unsupported-account",
  SOURCE_ACCOUNT_NOT_SAFE: "source-account-not-safe",
  OWNER_MISMATCH: "owner-mismatch",
  SOURCE_THRESHOLD_UNVERIFIED: "source-threshold-unverified",
  THRESHOLD_REQUIRES_MULTISIG: "threshold-requires-multisig",
  SOURCE_DEPLOYMENT_NOT_FOUND: "source-deployment-not-found",
  MISSING_CALLDATA: "missing-calldata",
  MISSING_FACTORY: "missing-factory",
  MISSING_SINGLETON: "missing-singleton",
  MISSING_SALT: "missing-salt",
  PREDICTION_FAILED: "prediction-failed",
  SOURCE_PREDICTED_ADDRESS_MISMATCH:
    "source-predicted-address-mismatch",
  CHAIN_SPECIFIC_ADDRESS: "chain-specific-address",
  PREDICTED_ADDRESS_MISMATCH: "predicted-address-mismatch",
  TARGET_ALREADY_DEPLOYED: "target-already-deployed",
  SIMULATION_FAILED: "simulation-failed",
  RECOVERABLE_IN_SIMULATION: "recoverable-in-simulation",
  READY_FOR_MANUAL_REVIEW: "ready-for-manual-review",
});

/*
 * Single source of truth:
 *
 * SafeProxyFactory v1.4.1 does NOT expose:
 *
 * createProxyWithNonceL2()
 * createChainSpecificProxyWithNonceL2()
 *
 * SafeL2 refers to the singleton implementation,
 * not to a different factory deployment function.
 */
export const SAFE_DEPLOYMENT_METHODS = Object.freeze([
  ...SAFE_PROXY_FACTORY_V141_METHODS,
]);

const SUPPORTED_METHODS = new Set(
  SAFE_DEPLOYMENT_METHODS,
);

const CHAIN_SPECIFIC_METHODS = new Set([
  "createChainSpecificProxyWithNonce",
]);

const SECRET_FIELD_PATTERN =
  /private.?key|seed|mnemonic|recovery.?phrase|secret|passphrase/i;

const ADDRESS_PATTERN =
  /^0x[a-fA-F0-9]{40}$/;

const BYTES_PATTERN =
  /^0x(?:[a-fA-F0-9]{2})*$/;

const MAX_UINT256 =
  (1n << 256n) - 1n;

const factoryInterface =
  new ethers.Interface(
    SAFE_PROXY_FACTORY_ABI,
  );

const erc20Interface =
  new ethers.Interface(
    ERC20_ABI,
  );

const safeModuleSetupInterface =
  new ethers.Interface(
    SAFE_MODULE_SETUP_ABI,
  );

const safeSetupInterface =
  new ethers.Interface([
    "function setup(address[] _owners,uint256 _threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)",
  ]);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function pushUnique(
  array,
  value,
) {
  if (!array.includes(value)) {
    array.push(value);
  }
}

function normalizeChainId(
  value,
  label = "chainId",
) {
  let chainId;

  try {
    chainId = BigInt(value);
  } catch {
    throw new Error(
      `${label} invalido`,
    );
  }

  if (
    chainId <= 0n ||
    chainId > MAX_UINT256
  ) {
    throw new Error(
      `${label} fuera de rango`,
    );
  }

  return chainId;
}

function normalizeUint256(
  value,
  label = "uint256",
) {
  let normalized;

  try {
    normalized = BigInt(value);
  } catch {
    throw new Error(
      `${label} invalido`,
    );
  }

  if (
    normalized < 0n ||
    normalized > MAX_UINT256
  ) {
    throw new Error(
      `${label} fuera de rango uint256`,
    );
  }

  return normalized;
}

function assertSupportedDeploymentMethod(
  deploymentMethod,
) {
  if (
    !SUPPORTED_METHODS.has(
      deploymentMethod,
    )
  ) {
    throw new Error(
      `Metodo Safe no soportado por SafeProxyFactory v1.4.1: ${deploymentMethod}`,
    );
  }

  /*
   * Defensive ABI verification.
   *
   * Configuration and ABI must never drift apart.
   */
  try {
    const fragment =
      factoryInterface.getFunction(
        deploymentMethod,
      );

    if (!fragment) {
      throw new Error(
        "fragment not found",
      );
    }
  } catch {
    throw new Error(
      `Metodo Safe configurado pero ausente del ABI: ${deploymentMethod}`,
    );
  }

  return deploymentMethod;
}

function addressEquals(
  left,
  right,
) {
  if (!left || !right) {
    return false;
  }

  try {
    return (
      normalizeRecoveryAddress(
        left,
      ).toLowerCase() ===
      normalizeRecoveryAddress(
        right,
      ).toLowerCase()
    );
  } catch {
    return false;
  }
}

function normalizedAddressSet(
  values,
) {
  if (!Array.isArray(values)) {
    return [];
  }

  const set =
    new Set();

  for (const value of values) {
    try {
      set.add(
        normalizeRecoveryAddress(
          value,
        ).toLowerCase(),
      );
    } catch {}
  }

  return [
    ...set,
  ].sort();
}

function sameAddressSet(
  left,
  right,
) {
  const leftSet =
    normalizedAddressSet(
      left,
    );

  const rightSet =
    normalizedAddressSet(
      right,
    );

  if (
    leftSet.length !==
    rightSet.length
  ) {
    return false;
  }

  return leftSet.every(
    (
      value,
      index,
    ) =>
      value ===
      rightSet[index],
  );
}

function safeThresholdFromState(
  sourceSafeState,
) {
  const value =
    sourceSafeState?.threshold;

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  try {
    const threshold =
      BigInt(value);

    if (
      threshold <= 0n ||
      threshold > MAX_UINT256
    ) {
      return null;
    }

    return threshold;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Secret protection                                                          */
/* -------------------------------------------------------------------------- */

export function assertNoSecrets(
  value,
  path = [],
  seen = new WeakSet(),
) {
  if (
    !value ||
    typeof value !== "object"
  ) {
    return;
  }

  if (
    seen.has(value)
  ) {
    return;
  }

  seen.add(value);

  for (
    const [key, child]
    of Object.entries(value)
  ) {
    const nextPath = [
      ...path,
      key,
    ];

    if (
      SECRET_FIELD_PATTERN.test(
        key,
      )
    ) {
      throw new Error(
        `Campo secreto prohibido en CounterfactualSafeRecoveryEngine: ${nextPath.join(
          ".",
        )}`,
      );
    }

    assertNoSecrets(
      child,
      nextPath,
      seen,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Normalization                                                              */
/* -------------------------------------------------------------------------- */

export function normalizeRecoveryAddress(
  address,
  label = "address",
) {
  const candidate =
    String(
      address ?? "",
    ).trim();

  if (
    !ADDRESS_PATTERN.test(
      candidate,
    )
  ) {
    throw new Error(
      `${label} invalida: debe ser una direccion EVM completa`,
    );
  }

  try {
    /*
     * DO NOT lowercase before ethers.getAddress().
     *
     * Mixed-case addresses must pass EIP-55.
     */
    return ethers.getAddress(
      candidate,
    );
  } catch {
    throw new Error(
      `${label} invalida o checksum EIP-55 incorrecto`,
    );
  }
}

export function normalizeRecoveryHex(
  value,
  label = "hex",
) {
  const normalized =
    String(
      value ?? "",
    ).trim();

  if (
    !BYTES_PATTERN.test(
      normalized,
    )
  ) {
    throw new Error(
      `${label} debe ser bytes hex completos 0x...`,
    );
  }

  return normalized;
}

export function uint256ToBytes32(
  value,
) {
  return ethers.zeroPadValue(
    ethers.toBeHex(
      normalizeUint256(
        value,
        "uint256",
      ),
    ),
    32,
  );
}

/* -------------------------------------------------------------------------- */
/* Safe deployment method                                                     */
/* -------------------------------------------------------------------------- */

export function isChainSpecificSafeMethod(
  deploymentMethod,
) {
  return CHAIN_SPECIFIC_METHODS.has(
    deploymentMethod,
  );
}

/*
 * SafeProxyFactory.createProxyWithCallback()
 *
 * uint256 saltNonceWithCallback =
 *   uint256(
 *     keccak256(
 *       abi.encodePacked(
 *         saltNonce,
 *         callback
 *       )
 *     )
 *   );
 *
 * Then:
 *
 * createProxyWithNonce(
 *   singleton,
 *   initializer,
 *   saltNonceWithCallback
 * )
 */
export function getSafeEffectiveSaltNonce({
  deploymentMethod,
  saltNonce,
  callback,
}) {
  assertSupportedDeploymentMethod(
    deploymentMethod,
  );

  const normalizedSaltNonce =
    normalizeUint256(
      saltNonce,
      "saltNonce",
    );

  if (
    deploymentMethod !==
    "createProxyWithCallback"
  ) {
    return normalizedSaltNonce;
  }

  if (
    callback === null ||
    callback === undefined ||
    callback === ""
  ) {
    throw new Error(
      "Falta callback para createProxyWithCallback",
    );
  }

  const normalizedCallback =
    normalizeRecoveryAddress(
      callback,
      "callback",
    );

  return BigInt(
    ethers.solidityPackedKeccak256(
      [
        "uint256",
        "address",
      ],
      [
        normalizedSaltNonce,
        normalizedCallback,
      ],
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* CREATE2 salt                                                               */
/* -------------------------------------------------------------------------- */

/*
 * SafeProxyFactory v1.4.1:
 *
 * createProxyWithNonce:
 *
 * keccak256(
 *   abi.encodePacked(
 *     keccak256(initializer),
 *     saltNonce
 *   )
 * )
 *
 *
 * createChainSpecificProxyWithNonce:
 *
 * keccak256(
 *   abi.encodePacked(
 *     keccak256(initializer),
 *     saltNonce,
 *     chainId
 *   )
 * )
 */
export function createSafeDeploymentSalt({
  deploymentMethod,
  initializer,
  saltNonce,
  callback = null,
  chainId,
}) {
  assertSupportedDeploymentMethod(
    deploymentMethod,
  );

  const normalizedInitializer =
    normalizeRecoveryHex(
      initializer,
      "initializer",
    );

  const effectiveSaltNonce =
    getSafeEffectiveSaltNonce({
      deploymentMethod,
      saltNonce,
      callback,
    });

  const parts = [
    ethers.keccak256(
      normalizedInitializer,
    ),

    uint256ToBytes32(
      effectiveSaltNonce,
    ),
  ];

  if (
    isChainSpecificSafeMethod(
      deploymentMethod,
    )
  ) {
    const normalizedChainId =
      normalizeChainId(
        chainId,
        "chainId",
      );

    parts.push(
      uint256ToBytes32(
        normalizedChainId,
      ),
    );
  }

  return ethers.keccak256(
    ethers.concat(parts),
  );
}

/* -------------------------------------------------------------------------- */
/* CREATE2 prediction                                                         */
/* -------------------------------------------------------------------------- */

export function predictCounterfactualSafeAddress({
  expectedAddress,
  factory,
  proxyCreationCode,
  singleton,
  initializer,
  saltNonce,
  deploymentMethod =
    "createProxyWithNonce",
  callback = null,
  chainId,
}) {
  const input = {
    expectedAddress,
    factory,
    proxyCreationCode,
    singleton,
    initializer,
    saltNonce,
    deploymentMethod,
    callback,
    chainId,
  };

  assertNoSecrets(
    input,
  );

  assertSupportedDeploymentMethod(
    deploymentMethod,
  );

  const normalizedFactory =
    normalizeRecoveryAddress(
      factory,
      "factory",
    );

  const normalizedSingleton =
    normalizeRecoveryAddress(
      singleton,
      "singleton",
    );

  const normalizedInitializer =
    normalizeRecoveryHex(
      initializer,
      "initializer",
    );

  const normalizedProxyCreationCode =
    normalizeRecoveryHex(
      proxyCreationCode,
      "proxyCreationCode",
    );

  if (
    normalizedProxyCreationCode ===
    "0x"
  ) {
    throw new Error(
      "proxyCreationCode no puede estar vacio",
    );
  }

  const normalizedExpectedAddress =
    expectedAddress
      ? normalizeRecoveryAddress(
          expectedAddress,
          "expectedAddress",
        )
      : null;

  const normalizedChainId =
    normalizeChainId(
      chainId,
      "chainId",
    );

  /*
   * SafeProxy CREATE2 deployment bytecode:
   *
   * proxyCreationCode
   * ++
   * abi.encode(singleton)
   */
  const deploymentCode =
    ethers.concat([
      normalizedProxyCreationCode,

      ethers.AbiCoder
        .defaultAbiCoder()
        .encode(
          [
            "address",
          ],
          [
            normalizedSingleton,
          ],
        ),
    ]);

  const deploymentBytecodeHash =
    ethers.keccak256(
      deploymentCode,
    );

  const create2Salt =
    createSafeDeploymentSalt({
      deploymentMethod,

      initializer:
        normalizedInitializer,

      saltNonce,

      callback,

      chainId:
        normalizedChainId,
    });

  const predictedAddress =
    ethers.getCreate2Address(
      normalizedFactory,
      create2Salt,
      deploymentBytecodeHash,
    );

  const matches =
    Boolean(
      normalizedExpectedAddress,
    ) &&
    predictedAddress.toLowerCase() ===
      normalizedExpectedAddress
        .toLowerCase();

  return {
    predictedAddress,

    expectedAddress:
      normalizedExpectedAddress,

    matches,

    factory:
      normalizedFactory,

    singleton:
      normalizedSingleton,

    initializer:
      normalizedInitializer,

    initializerHash:
      ethers.keccak256(
        normalizedInitializer,
      ),

    saltNonce:
      normalizeUint256(
        saltNonce,
        "saltNonce",
      ).toString(),

    effectiveSaltNonce:
      getSafeEffectiveSaltNonce({
        deploymentMethod,
        saltNonce,
        callback,
      }).toString(),

    create2Salt,

    proxyCreationCodeHash:
      ethers.keccak256(
        normalizedProxyCreationCode,
      ),

    deploymentBytecodeHash,

    deploymentMethod,

    chainSpecific:
      isChainSpecificSafeMethod(
        deploymentMethod,
      ),

    callback:
      deploymentMethod ===
      "createProxyWithCallback"
        ? normalizeRecoveryAddress(
            callback,
            "callback",
          )
        : null,

    chainId:
      Number(
        normalizedChainId,
      ),

    evidence: [
      "CREATE2 prediction uses the exact factory address.",

      "CREATE2 prediction uses the exact Safe proxyCreationCode.",

      "CREATE2 prediction uses the exact singleton.",

      "CREATE2 prediction uses the exact initializer bytes.",

      "CREATE2 prediction uses the exact salt nonce.",

      deploymentMethod ===
      "createProxyWithCallback"
        ? "Callback deployment uses the SafeProxyFactory callback-derived effective salt nonce."
        : "No callback-derived salt nonce is used.",

      isChainSpecificSafeMethod(
        deploymentMethod,
      )
        ? "This deployment method includes chainId in the CREATE2 salt."
        : "This deployment method does not include chainId in the CREATE2 salt.",

      matches
        ? "Predicted address matches the expected Safe address."
        : "Predicted address DOES NOT match the expected Safe address.",
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* Initializer                                                                */
/* -------------------------------------------------------------------------- */

export function decodeSafeInitializer(
  initializer,
) {
  const normalizedInitializer =
    normalizeRecoveryHex(
      initializer,
      "initializer",
    );

  let parsed;

  try {
    parsed =
      safeSetupInterface
        .parseTransaction({
          data:
            normalizedInitializer,
        });
  } catch {
    return {
      decoded:
        false,

      initializer:
        normalizedInitializer,

      reason:
        "Initializer no reconocido como Safe.setup().",
    };
  }

  if (
    !parsed ||
    parsed.name !== "setup"
  ) {
    return {
      decoded:
        false,

      initializer:
        normalizedInitializer,

      reason:
        "Initializer no corresponde a Safe.setup().",
    };
  }

  const owners =
    Array.from(
      parsed.args[0] ?? [],
    ).map(
      (owner) =>
        normalizeRecoveryAddress(
          owner,
          "initializer.owner",
        ),
    );

  const thresholdValue =
    normalizeUint256(
      parsed.args[1],
      "initializer.threshold",
    );

  const setupTo =
    normalizeRecoveryAddress(
      parsed.args[2],
      "initializer.setupTo",
    );

  const setupData =
    normalizeRecoveryHex(
      parsed.args[3],
      "initializer.setupData",
    );

  const fallbackHandler =
    normalizeRecoveryAddress(
      parsed.args[4],
      "initializer.fallbackHandler",
    );

  const paymentToken =
    normalizeRecoveryAddress(
      parsed.args[5],
      "initializer.paymentToken",
    );

  const paymentValue =
    normalizeUint256(
      parsed.args[6],
      "initializer.payment",
    );

  const paymentReceiver =
    normalizeRecoveryAddress(
      parsed.args[7],
      "initializer.paymentReceiver",
    );

  let moduleSetup =
    null;

  if (
    setupTo !==
      ethers.ZeroAddress &&
    setupData !==
      "0x"
  ) {
    try {
      const parsedModuleSetup =
        safeModuleSetupInterface
          .parseTransaction({
            data:
              setupData,
          });

      if (
        parsedModuleSetup?.name ===
        "enableModules"
      ) {
        moduleSetup = {
          recognized:
            true,

          method:
            "enableModules",

          target:
            setupTo,

          modules:
            Array.from(
              parsedModuleSetup
                .args[0] ?? [],
            ).map(
              (module) =>
                normalizeRecoveryAddress(
                  module,
                  "initializer.module",
                ),
            ),
        };
      } else {
        moduleSetup = {
          recognized:
            false,

          target:
            setupTo,

          data:
            setupData,
        };
      }
    } catch {
      moduleSetup = {
        recognized:
          false,

        target:
          setupTo,

        data:
          setupData,
      };
    }
  }

  return {
    decoded:
      true,

    initializer:
      normalizedInitializer,

    function:
      "setup",

    owners,

    threshold:
      thresholdValue.toString(),

    setupTo,

    setupData,

    fallbackHandler,

    paymentToken,

    payment:
      paymentValue.toString(),

    paymentReceiver,

    moduleSetup,
  };
}

/* -------------------------------------------------------------------------- */
/* Deployment transaction                                                     */
/* -------------------------------------------------------------------------- */

export function buildSafeDeploymentTransaction({
  factory,
  singleton,
  initializer,
  saltNonce,
  deploymentMethod =
    "createProxyWithNonce",
  callback = null,
}) {
  assertSupportedDeploymentMethod(
    deploymentMethod,
  );

  const normalizedFactory =
    normalizeRecoveryAddress(
      factory,
      "factory",
    );

  const normalizedSingleton =
    normalizeRecoveryAddress(
      singleton,
      "singleton",
    );

  const normalizedInitializer =
    normalizeRecoveryHex(
      initializer,
      "initializer",
    );

  const normalizedSaltNonce =
    normalizeUint256(
      saltNonce,
      "saltNonce",
    );

  let args;

  switch (
    deploymentMethod
  ) {
    case "createProxyWithNonce":

    case "createChainSpecificProxyWithNonce": {
      args = [
        normalizedSingleton,

        normalizedInitializer,

        normalizedSaltNonce,
      ];

      break;
    }

    case "createProxyWithCallback": {
      if (
        callback === null ||
        callback === undefined ||
        callback === ""
      ) {
        throw new Error(
          "Falta callback para createProxyWithCallback",
        );
      }

      args = [
        normalizedSingleton,

        normalizedInitializer,

        normalizedSaltNonce,

        normalizeRecoveryAddress(
          callback,
          "callback",
        ),
      ];

      break;
    }

    default:
      throw new Error(
        `Metodo Safe no soportado por SafeProxyFactory v1.4.1: ${deploymentMethod}`,
      );
  }

  const data =
    factoryInterface
      .encodeFunctionData(
        deploymentMethod,
        args,
      );

  /*
   * Defensive self-verification.
   *
   * Encode the transaction and decode it again
   * using the authoritative ABI.
   */
  const parsed =
    factoryInterface
      .parseTransaction({
        data,
        value:
          0n,
      });

  if (
    !parsed ||
    parsed.name !==
      deploymentMethod
  ) {
    throw new Error(
      "No se pudo verificar el calldata de despliegue Safe",
    );
  }

  return {
    to:
      normalizedFactory,

    value:
      "0",

    data,

    operation:
      0,

    deploymentMethod,

    description:
      "Safe deployment transaction. Requires exact source and target CREATE2 proof, fork simulation and explicit human approval before mainnet.",

    mainnetBroadcastPrepared:
      false,
  };
}

/* -------------------------------------------------------------------------- */
/* Asset recovery action                                                      */
/* -------------------------------------------------------------------------- */

export function buildSafeActionForAssetTransfer({
  tokenAddress,
  recipient,
  amountUnits,
  native = false,
}) {
  const normalizedRecipient =
    normalizeRecoveryAddress(
      recipient,
      "recipient",
    );

  if (
    normalizedRecipient ===
    ethers.ZeroAddress
  ) {
    throw new Error(
      "recipient no puede ser la direccion cero",
    );
  }

  const amount =
    normalizeUint256(
      amountUnits,
      "amountUnits",
    );

  if (
    amount <= 0n
  ) {
    throw new Error(
      "amountUnits debe ser mayor que cero",
    );
  }

  if (native) {
    return {
      to:
        normalizedRecipient,

      value:
        amount.toString(),

      data:
        "0x",

      operation:
        0,

      description:
        "Native asset transfer to execute only from the verified Safe.",
    };
  }

  const normalizedToken =
    normalizeRecoveryAddress(
      tokenAddress,
      "tokenAddress",
    );

  if (
    normalizedToken ===
    ethers.ZeroAddress
  ) {
    throw new Error(
      "tokenAddress no puede ser la direccion cero",
    );
  }

  return {
    to:
      normalizedToken,

    value:
      "0",

    data:
      erc20Interface
        .encodeFunctionData(
          "transfer",
          [
            normalizedRecipient,
            amount,
          ],
        ),

    operation:
      0,

    description:
      "ERC20 transfer to execute only from the verified Safe.",
  };
}

/* -------------------------------------------------------------------------- */
/* Deployment requirements                                                    */
/* -------------------------------------------------------------------------- */

function missingSourceDeploymentFields(
  sourceDeployment,
) {
  const missing = [];

  if (
    !sourceDeployment
  ) {
    return [
      "sourceDeployment",
    ];
  }

  if (
    !sourceDeployment.factory
  ) {
    missing.push(
      "factory",
    );
  }

  if (
    !sourceDeployment.singleton
  ) {
    missing.push(
      "singleton",
    );
  }

  if (
    !sourceDeployment.initializer
  ) {
    missing.push(
      "initializer",
    );
  }

  if (
    sourceDeployment.saltNonce ===
      null ||
    sourceDeployment.saltNonce ===
      undefined ||
    sourceDeployment.saltNonce ===
      ""
  ) {
    missing.push(
      "saltNonce",
    );
  }

  if (
    !sourceDeployment
      .proxyCreationCode
  ) {
    missing.push(
      "proxyCreationCode",
    );
  }

  const deploymentMethod =
    sourceDeployment
      .deploymentMethod ??
    sourceDeployment
      .method;

  if (
    !deploymentMethod
  ) {
    missing.push(
      "deploymentMethod",
    );
  } else if (
    !SUPPORTED_METHODS.has(
      deploymentMethod,
    )
  ) {
    missing.push(
      "deploymentMethod",
    );
  }

  if (
    deploymentMethod ===
      "createProxyWithCallback" &&
    (
      sourceDeployment.callback ===
        null ||
      sourceDeployment.callback ===
        undefined ||
      sourceDeployment.callback ===
        ""
    )
  ) {
    missing.push(
      "callback",
    );
  }

  return missing;
}

function stateForMissingField(
  field,
) {
  if (
    field ===
    "sourceDeployment"
  ) {
    return RECOVERY_STATES
      .SOURCE_DEPLOYMENT_NOT_FOUND;
  }

  if (
    field ===
    "factory"
  ) {
    return RECOVERY_STATES
      .MISSING_FACTORY;
  }

  if (
    field ===
    "singleton"
  ) {
    return RECOVERY_STATES
      .MISSING_SINGLETON;
  }

  if (
    field ===
    "saltNonce"
  ) {
    return RECOVERY_STATES
      .MISSING_SALT;
  }

  return RECOVERY_STATES
    .MISSING_CALLDATA;
}

/* -------------------------------------------------------------------------- */
/* Initializer vs live Safe                                                   */
/* -------------------------------------------------------------------------- */

function validateDecodedInitializerAgainstLiveState({
  initializerAnalysis,
  sourceSafeState,
  blockers,
  warnings,
  facts,
}) {
  if (
    !initializerAnalysis
  ) {
    return;
  }

  if (
    !initializerAnalysis
      .decoded
  ) {
    warnings.push(
      initializerAnalysis
        .reason,
    );

    return;
  }

  facts.push(
    `initializerOwners=${initializerAnalysis.owners.length}`,
  );

  facts.push(
    `initializerThreshold=${initializerAnalysis.threshold}`,
  );

  facts.push(
    `initializerSetupTo=${initializerAnalysis.setupTo}`,
  );

  facts.push(
    `initializerFallbackHandler=${initializerAnalysis.fallbackHandler}`,
  );

  if (
    initializerAnalysis
      .moduleSetup
      ?.recognized
  ) {
    facts.push(
      `initializerEnabledModules=${initializerAnalysis.moduleSetup.modules.join(
        ",",
      )}`,
    );
  }

  const liveOwners =
    Array.isArray(
      sourceSafeState?.owners,
    )
      ? sourceSafeState
          .owners
      : [];

  if (
    liveOwners.length >
      0 &&
    !sameAddressSet(
      initializerAnalysis
        .owners,
      liveOwners,
    )
  ) {
    pushUnique(
      blockers,
      "initializer owners do not match the current source Safe owners",
    );
  }

  const sourceThreshold =
    safeThresholdFromState(
      sourceSafeState,
    );

  if (
    sourceThreshold !==
      null &&
    BigInt(
      initializerAnalysis
        .threshold,
    ) !==
      sourceThreshold
  ) {
    pushUnique(
      blockers,
      "initializer threshold does not match the current source Safe threshold",
    );
  }

  if (
    sourceSafeState
      ?.fallbackHandler &&
    sourceSafeState
      .fallbackHandler !==
      ethers.ZeroAddress &&
    !addressEquals(
      initializerAnalysis
        .fallbackHandler,
      sourceSafeState
        .fallbackHandler,
    )
  ) {
    pushUnique(
      blockers,
      "initializer fallbackHandler does not match source Safe fallbackHandler",
    );
  }

  if (
    BigInt(
      initializerAnalysis
        .payment,
    ) !== 0n
  ) {
    pushUnique(
      blockers,
      "initializer payment is non-zero; automatic prefunded deployment is blocked",
    );
  }

  if (
    initializerAnalysis
      .setupTo ===
      ethers.ZeroAddress &&
    initializerAnalysis
      .setupData !==
      "0x"
  ) {
    pushUnique(
      blockers,
      "initializer setupTo is zero but setupData is non-empty",
    );
  }

  if (
    initializerAnalysis
      .setupTo !==
      ethers.ZeroAddress &&
    initializerAnalysis
      .setupData !==
      "0x" &&
    !initializerAnalysis
      .moduleSetup
      ?.recognized
  ) {
    pushUnique(
      blockers,
      "initializer delegatecall is not recognized as SafeModuleSetup.enableModules",
    );
  }

  if (
    initializerAnalysis
      .moduleSetup
      ?.recognized &&
    sourceSafeState
      ?.modulesReadable ===
      true
  ) {
    const liveModules =
      normalizedAddressSet(
        sourceSafeState
          .modules,
      );

    for (
      const module
      of initializerAnalysis
        .moduleSetup
        .modules
    ) {
      if (
        !liveModules.includes(
          normalizeRecoveryAddress(
            module,
          ).toLowerCase(),
        )
      ) {
        pushUnique(
          blockers,
          `initializer module ${module} is not enabled in the source Safe`,
        );
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Upstream evidence                                                          */
/* -------------------------------------------------------------------------- */

function mergeUpstreamValidation({
  sourceDeployment,
  blockers,
  warnings,
}) {
  const upstream =
    sourceDeployment
      ?.initializerValidation;

  if (!upstream) {
    return;
  }

  for (
    const blocker
    of upstream.blockers ??
      []
  ) {
    pushUnique(
      blockers,
      blocker,
    );
  }

  for (
    const warning
    of upstream.warnings ??
      []
  ) {
    pushUnique(
      warnings,
      warning,
    );
  }

  if (
    upstream.valid ===
      false &&
    !(
      upstream.blockers ??
      []
    ).length
  ) {
    pushUnique(
      blockers,
      "Safe initializer validation failed",
    );
  }
}

function validatePrecomputedPredictionConsistency({
  sourceDeployment,
  sourcePrediction,
  targetPrediction,
  blockers,
}) {
  const precomputedSource =
    sourceDeployment
      ?.sourcePrediction;

  const precomputedTarget =
    sourceDeployment
      ?.targetPrediction;

  if (
    precomputedSource
      ?.predictedAddress &&
    !addressEquals(
      precomputedSource
        .predictedAddress,
      sourcePrediction
        ?.predictedAddress,
    )
  ) {
    pushUnique(
      blockers,
      "source CREATE2 prediction conflicts with independently recomputed prediction",
    );
  }

  if (
    precomputedTarget
      ?.predictedAddress &&
    !addressEquals(
      precomputedTarget
        .predictedAddress,
      targetPrediction
        ?.predictedAddress,
    )
  ) {
    pushUnique(
      blockers,
      "target CREATE2 prediction conflicts with independently recomputed prediction",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Recovery analysis                                                          */
/* -------------------------------------------------------------------------- */

export function analyzeCounterfactualSafeRecovery(
  input,
) {
  assertNoSecrets(
    input,
  );

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

  const normalizedSourceChainId =
    normalizeChainId(
      sourceChainId,
      "sourceChainId",
    );

  const normalizedTargetChainId =
    normalizeChainId(
      targetChainId,
      "targetChainId",
    );

  const expectedAddress =
    normalizeRecoveryAddress(
      smartAccountAddress,
      "smartAccountAddress",
    );

  const ownerAddress =
    connectedOwnerAddress
      ? normalizeRecoveryAddress(
          connectedOwnerAddress,
          "connectedOwnerAddress",
        )
      : null;

  const sourceSafeDetected =
    sourceSafeState
      ?.detected === true;

  const normalizedOwners =
    Array.isArray(
      sourceSafeState
        ?.owners,
    )
      ? sourceSafeState
          .owners
          .map(
            (owner) =>
              normalizeRecoveryAddress(
                owner,
                "sourceSafeState.owner",
              ),
          )
      : [];

  const ownerMatches =
    Boolean(
      ownerAddress,
    ) &&
    normalizedOwners.some(
      (owner) =>
        addressEquals(
          owner,
          ownerAddress,
        ),
    );

  const sourceThreshold =
    safeThresholdFromState(
      sourceSafeState,
    );

  const blockers = [];

  const warnings = [
    "No mainnet broadcast is performed by this engine.",

    "A fork simulation and explicit human review are mandatory before signing any deployment.",
  ];

  const facts = [
    `sourceChainId=${normalizedSourceChainId.toString()}`,

    `targetChainId=${normalizedTargetChainId.toString()}`,

    `expectedAddress=${expectedAddress}`,

    `sourceSafeDetected=${sourceSafeDetected}`,

    `ownerMatches=${ownerMatches}`,
  ];

  const inferences = [];

  if (
    normalizedSourceChainId ===
    normalizedTargetChainId
  ) {
    pushUnique(
      blockers,
      "source and target chains must be different for cross-chain recovery",
    );
  }

  const missing =
    missingSourceDeploymentFields(
      sourceDeployment,
    );

  /*
   * Barrier 1:
   * source must be an actual Safe.
   */
  if (
    !sourceSafeDetected
  ) {
    pushUnique(
      blockers,
      "source account was not verified as a Safe smart account",
    );
  }

  /*
   * Barrier 2:
   * connected signer must be a source Safe owner.
   */
  if (
    !ownerMatches
  ) {
    pushUnique(
      blockers,
      "connected owner is not an owner of the source Safe",
    );
  }

  /*
   * Barrier 3:
   * this automated path currently supports threshold=1.
   */
  if (
    sourceThreshold ===
    null
  ) {
    pushUnique(
      blockers,
      "source Safe threshold could not be verified",
    );
  } else {
    facts.push(
      `sourceThreshold=${sourceThreshold.toString()}`,
    );

    if (
      sourceThreshold !==
      1n
    ) {
      pushUnique(
        blockers,
        `source Safe requires ${sourceThreshold.toString()} signatures; single-owner recovery cannot be declared`,
      );
    }
  }

  /*
   * Barrier 4:
   * counterfactual deployment requires no code
   * at the target Safe address.
   */
  if (
    targetDeploymentStatus
      .hasCode === true
  ) {
    pushUnique(
      blockers,
      "target address already has code; use the deployed-Safe recovery route instead",
    );
  } else if (
    targetDeploymentStatus
      .hasCode !== false
  ) {
    pushUnique(
      blockers,
      "target address code status has not been verified",
    );
  }

  if (
    targetDeploymentStatus
      .factoryHasCode ===
      false
  ) {
    pushUnique(
      blockers,
      "target Safe factory has no code",
    );
  }

  if (
    targetDeploymentStatus
      .factoryHasCode ===
      null ||
    targetDeploymentStatus
      .factoryHasCode ===
      undefined
  ) {
    warnings.push(
      "Target factory code status was not supplied to the engine; the API provenance gate must verify it before mainnet.",
    );
  }

  if (
    targetDeploymentStatus
      .singletonHasCode ===
      false
  ) {
    pushUnique(
      blockers,
      "target Safe singleton has no code",
    );
  }

  if (
    targetDeploymentStatus
      .singletonHasCode ===
      null ||
    targetDeploymentStatus
      .singletonHasCode ===
      undefined
  ) {
    warnings.push(
      "Target singleton code status was not supplied to the engine; the API provenance gate must verify it before mainnet.",
    );
  }

  if (
    missing.length
  ) {
    pushUnique(
      blockers,
      `missing deployment data: ${missing.join(
        ", ",
      )}`,
    );
  }

  /*
   * Merge the stronger API-level initializer validation
   * when present.
   */
  mergeUpstreamValidation({
    sourceDeployment,
    blockers,
    warnings,
  });

  let initializerAnalysis =
    null;

  if (
    sourceDeployment
      ?.initializer
  ) {
    try {
      initializerAnalysis =
        decodeSafeInitializer(
          sourceDeployment
            .initializer,
        );

      validateDecodedInitializerAgainstLiveState({
        initializerAnalysis,

        sourceSafeState,

        blockers,

        warnings,

        facts,
      });
    } catch (
      error
    ) {
      warnings.push(
        `Initializer inspection failed: ${
          error instanceof
          Error
            ? error.message
            : "unknown error"
        }`,
      );
    }
  }

  let sourcePrediction =
    null;

  let targetPrediction =
    null;

  let predictionError =
    null;

  /*
   * Barrier 5:
   *
   * First reproduce the already-existing Safe
   * on the source chain.
   *
   * Then reproduce the SAME address on target.
   */
  if (
    !missing.length
  ) {
    try {
      const deploymentMethod =
        assertSupportedDeploymentMethod(
          sourceDeployment
            .deploymentMethod ??
            sourceDeployment
              .method,
        );

      /*
       * Use independently verified source and target
       * proxyCreationCode when supplied by the API.
       *
       * Falling back to proxyCreationCode preserves
       * backwards compatibility for pure callers/tests.
       */
      const sourceProxyCreationCode =
        sourceDeployment
          .sourceProxyCreationCode ??
        sourceDeployment
          .proxyCreationCode;

      const targetProxyCreationCode =
        sourceDeployment
          .targetProxyCreationCode ??
        sourceDeployment
          .proxyCreationCode;

      const commonPredictionInput = {
        expectedAddress,

        factory:
          sourceDeployment
            .factory,

        singleton:
          sourceDeployment
            .singleton,

        initializer:
          sourceDeployment
            .initializer,

        saltNonce:
          sourceDeployment
            .saltNonce,

        deploymentMethod,

        callback:
          sourceDeployment
            .callback ??
          null,
      };

      sourcePrediction =
        predictCounterfactualSafeAddress({
          ...commonPredictionInput,

          proxyCreationCode:
            sourceProxyCreationCode,

          chainId:
            normalizedSourceChainId,
        });

      targetPrediction =
        predictCounterfactualSafeAddress({
          ...commonPredictionInput,

          proxyCreationCode:
            targetProxyCreationCode,

          chainId:
            normalizedTargetChainId,
        });

      validatePrecomputedPredictionConsistency({
        sourceDeployment,

        sourcePrediction,

        targetPrediction,

        blockers,
      });

      facts.push(
        `sourcePredictedAddress=${sourcePrediction.predictedAddress}`,
      );

      facts.push(
        `targetPredictedAddress=${targetPrediction.predictedAddress}`,
      );

      facts.push(
        `sourceAddressMatches=${sourcePrediction.matches}`,
      );

      facts.push(
        `targetAddressMatches=${targetPrediction.matches}`,
      );

      if (
        sourcePrediction
          .matches
      ) {
        inferences.push(
          "Source CREATE2 proof reproduces the existing Safe address.",
        );
      } else {
        inferences.push(
          "Source CREATE2 proof DOES NOT reproduce the existing Safe address.",
        );

        pushUnique(
          blockers,
          "source CREATE2 prediction does not reproduce the existing World Safe",
        );
      }

      if (
        targetPrediction
          .matches
      ) {
        inferences.push(
          "Target CREATE2 proof reproduces the address that contains the funds.",
        );
      } else {
        inferences.push(
          "Target CREATE2 proof DOES NOT reproduce the address that contains the funds.",
        );

        pushUnique(
          blockers,
          "target CREATE2 predicted address mismatch",
        );
      }

      if (
        targetPrediction
          .chainSpecific &&
        normalizedSourceChainId !==
          normalizedTargetChainId
      ) {
        warnings.push(
          "The original Safe deployment method is chain-specific. chainId changes the CREATE2 salt, so cross-chain address equality must be explicitly proven.",
        );
      }
    } catch (
      error
    ) {
      predictionError =
        error instanceof
        Error
          ? error.message
          : "CREATE2 prediction failed";

      pushUnique(
        blockers,
        `CREATE2 prediction failed: ${predictionError}`,
      );
    }
  }

  const sourceProofValid =
    Boolean(
      sourcePrediction
        ?.matches,
    );

  const targetProofValid =
    Boolean(
      targetPrediction
        ?.matches,
    );

  const targetIsEmpty =
    targetDeploymentStatus
      .hasCode ===
    false;

  /*
   * Compatibility rule:
   *
   * Pure engine consumers may omit
   * factoryHasCode/singletonHasCode.
   *
   * Production API adds a stronger provenance gate
   * and must verify these explicitly.
   */
  const recoveryPossible =
    sourceSafeDetected &&
    ownerMatches &&
    sourceThreshold ===
      1n &&
    sourceProofValid &&
    targetProofValid &&
    targetIsEmpty &&
    targetDeploymentStatus
      .factoryHasCode !==
      false &&
    targetDeploymentStatus
      .singletonHasCode !==
      false &&
    blockers.length ===
      0;

  let state =
    RECOVERY_STATES
      .READY_FOR_MANUAL_REVIEW;

  if (
    !sourceSafeDetected
  ) {
    state =
      RECOVERY_STATES
        .SOURCE_ACCOUNT_NOT_SAFE;
  } else if (
    !sourceDeployment
  ) {
    state =
      RECOVERY_STATES
        .SOURCE_DEPLOYMENT_NOT_FOUND;
  } else if (
    !ownerMatches
  ) {
    state =
      RECOVERY_STATES
        .OWNER_MISMATCH;
  } else if (
    sourceThreshold ===
      null
  ) {
    state =
      RECOVERY_STATES
        .SOURCE_THRESHOLD_UNVERIFIED;
  } else if (
    sourceThreshold !==
      1n
  ) {
    state =
      RECOVERY_STATES
        .THRESHOLD_REQUIRES_MULTISIG;
  } else if (
    missing.length
  ) {
    state =
      stateForMissingField(
        missing[0],
      );
  } else if (
    predictionError
  ) {
    state =
      RECOVERY_STATES
        .PREDICTION_FAILED;
  } else if (
    targetPrediction
      ?.chainSpecific &&
    normalizedSourceChainId !==
      normalizedTargetChainId &&
    !targetPrediction
      .matches
  ) {
    state =
      RECOVERY_STATES
        .CHAIN_SPECIFIC_ADDRESS;
  } else if (
    !sourcePrediction
      ?.matches
  ) {
    state =
      RECOVERY_STATES
        .SOURCE_PREDICTED_ADDRESS_MISMATCH;
  } else if (
    !targetPrediction
      ?.matches
  ) {
    state =
      RECOVERY_STATES
        .PREDICTED_ADDRESS_MISMATCH;
  } else if (
    targetDeploymentStatus
      .hasCode === true
  ) {
    state =
      RECOVERY_STATES
        .TARGET_ALREADY_DEPLOYED;
  }

  /*
   * Absolute rule:
   *
   * No deployment transaction exists unless
   * every recovery condition passed.
   */
  const deployTransaction =
    recoveryPossible
      ? buildSafeDeploymentTransaction({
          factory:
            sourceDeployment
              .factory,

          singleton:
            sourceDeployment
              .singleton,

          initializer:
            sourceDeployment
              .initializer,

          saltNonce:
            sourceDeployment
              .saltNonce,

          deploymentMethod:
            sourceDeployment
              .deploymentMethod ??
            sourceDeployment
              .method,

          callback:
            sourceDeployment
              .callback ??
            null,
        })
      : null;

  const safeActions =
    recoveryPossible
      ? plannedTransfers.map(
          buildSafeActionForAssetTransfer,
        )
      : [];

  return {
    engine:
      "CounterfactualSafeRecoveryEngine",

    version:
      RECOVERY_ENGINE_VERSION,

    catalogVersion:
      SAFE_DEPLOYMENT_CATALOG_VERSION,

    supportedDeploymentMethods:
      SAFE_DEPLOYMENT_METHODS,

    accountType:
      sourceSafeDetected
        ? "safe-smart-account"
        : "unknown",

    sourceChainId:
      Number(
        normalizedSourceChainId,
      ),

    targetChainId:
      Number(
        normalizedTargetChainId,
      ),

    smartAccountAddress:
      expectedAddress,

    connectedOwnerAddress:
      ownerAddress,

    sourceSafeDetected,

    sourceThreshold:
      sourceThreshold !==
        null
        ? sourceThreshold
            .toString()
        : null,

    ownerMatches,

    sourcePredictedAddress:
      sourcePrediction
        ?.predictedAddress ??
      null,

    predictedAddress:
      targetPrediction
        ?.predictedAddress ??
      null,

    sourceAddressMatches:
      sourceProofValid,

    addressMatches:
      targetProofValid,

    deploymentProofComplete:
      sourceProofValid &&
      targetProofValid,

    recoveryPossible,

    reconstructionStatus:
      state,

    blockers,

    evidence: {
      facts,

      inferences,

      missing,

      /*
       * Compatibility alias.
       */
      prediction:
        targetPrediction,

      sourcePrediction,

      targetPrediction,

      initializer:
        initializerAnalysis,

      sourceSafeSnapshot: {
        detected:
          sourceSafeDetected,

        owners:
          normalizedOwners,

        threshold:
          sourceThreshold !==
            null
            ? sourceThreshold
                .toString()
            : null,

        singleton:
          sourceSafeState
            ?.singleton ??
          null,

        fallbackHandler:
          sourceSafeState
            ?.fallbackHandler ??
          null,

        modules:
          Array.isArray(
            sourceSafeState
              ?.modules,
          )
            ? sourceSafeState
                .modules
            : [],
      },

      catalogEntries:
        catalogEntriesForChain(
          Number(
            normalizedTargetChainId,
          ),
        ),

      sources:
        SAFE_DEPLOYMENT_CATALOG_SOURCES,
    },

    warnings,

    deployment: {
      deployTransaction,

      safeActions,

      manualApprovalRequired:
        true,

      forkSimulationRequired:
        true,

      mainnetBroadcastPrepared:
        false,

      sourceCreate2ProofRequired:
        true,

      targetCreate2ProofRequired:
        true,

      canonicalFactoryMethodsOnly:
        true,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

export function createCounterfactualSafeRecoveryEngine(
  defaults = {},
) {
  assertNoSecrets(
    defaults,
  );

  return {
    analyze(
      input,
    ) {
      return analyzeCounterfactualSafeRecovery({
        ...defaults,
        ...input,
      });
    },

    predict:
      predictCounterfactualSafeAddress,

    decodeInitializer:
      decodeSafeInitializer,

    buildSafeDeploymentTransaction,

    buildSafeActionForAssetTransfer,
  };
}
