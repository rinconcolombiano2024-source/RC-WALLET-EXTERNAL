import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function requireAll(source, required, label) {
  for (const needle of required) {
    assert.ok(
      source.includes(needle),
      `${label} is missing required recovery/security invariant: ${needle}`,
    );
  }
}

function forbidAll(source, forbidden, label) {
  for (const needle of forbidden) {
    assert.equal(
      source.includes(needle),
      false,
      `${label} contains forbidden/insecure pattern: ${needle}`,
    );
  }
}

function requireRegex(source, pattern, message) {
  assert.match(source, pattern, message);
}

const blockchainSource = read("../src/blockchain.js");
const configSource = read("../src/config.js");
const safeProposeSource = read("../api/safe-propose.js");
const safeConfirmSource = read("../api/safe-confirm.js");
const safeTransactionSource = read("../api/safe-transaction.js");
const safeRelaySource = read("../api/safe-relay.js");
const counterfactualApiSource = read(
  "../api/counterfactual-safe-recovery.js",
);
const counterfactualEngineSource = read(
  "../src/recovery/counterfactual-safe-engine.js",
);
const envExampleSource = read("../.env.example");
const vercelConfig = JSON.parse(read("../vercel.json"));

/* -------------------------------------------------------------------------- */
/* 1. Private-key / address normalization invariants                           */
/* -------------------------------------------------------------------------- */

forbidAll(
  blockchainSource,
  [
    "createRandom",
    "HDNode",
    "derivePath",
    "mnemonic",
    "toUtf8Bytes",
    "fromUtf8",
    "ethers.getAddress(candidate.toLowerCase())",
  ],
  "src/blockchain.js",
);

requireAll(
  blockchainSource,
  [
    "return ethers.getAddress(candidate);",
    "new ethers.Wallet(normalizedPrivateKey)",
    "validateManualSafeMirrorDeployment",
    "forgeSafeMirrorDeployment",
    "deployCounterfactualSafeMirror",
    "sourceProofVerified",
    "targetPredictionMatches",
    "operation !== SAFE_OPERATION_CALL",
    "findSafeDeploymentOnWorldChain",
    "getSafeFactoryDeploymentCall",
  ],
  "src/blockchain.js",
);

/*
 * The production flow may still contain an explicit manual private-key route,
 * but secrets must never be serialized to the recovery API.
 */
assert.equal(
  counterfactualApiSource.includes("privateKey:"),
  false,
  "Counterfactual recovery API must never build/accept a privateKey field",
);

requireAll(
  counterfactualApiSource,
  ["assertNoSecrets(", "noPrivateKeys:"],
  "counterfactual recovery API",
);

/* -------------------------------------------------------------------------- */
/* 2. Safe/4337 configuration                                                  */
/* -------------------------------------------------------------------------- */

requireAll(
  configSource,
  [
    "ERC4337_ENTRYPOINTS",
    'version: "v0.7"',
    "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
    "SAFE_4337_V030",
    "0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47",
    "0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226",
    "SAFE_MODULE_SETUP_ABI",
    "SAFE_INTROSPECTION_ABI",
    "SAFE_PROXY_FACTORY_ABI",
  ],
  "src/config.js",
);

for (const declaration of [
  "SAFE_INTROSPECTION_ABI",
  "SAFE_PROXY_FACTORY_ABI",
  "SAFE_MODULE_SETUP_ABI",
  "ERC1271_ABI",
  "SAFE_4337_V030",
]) {
  const matches = configSource.match(
    new RegExp(`export const ${declaration}\\b`, "g"),
  );
  assert.equal(
    matches?.length ?? 0,
    1,
    `src/config.js must export ${declaration} exactly once`,
  );
}

/* -------------------------------------------------------------------------- */
/* 3. HTTP security shared by all Safe APIs                                    */
/* -------------------------------------------------------------------------- */

const hardenedSafeApis = [
  ["api/safe-propose.js", safeProposeSource],
  ["api/safe-confirm.js", safeConfirmSource],
  ["api/safe-transaction.js", safeTransactionSource],
  ["api/safe-relay.js", safeRelaySource],
  ["api/counterfactual-safe-recovery.js", counterfactualApiSource],
];

for (const [label, source] of hardenedSafeApis) {
  forbidAll(
    source,
    [
      'setHeader("Access-Control-Allow-Origin", "*")',
      'setHeader("Access-Control-Allow-Origin","*")',
      "Access-Control-Allow-Origin: *",
    ],
    label,
  );

  requireAll(
    source,
    [
      "Origin no autorizado",
      "RC_ALLOWED_ORIGINS",
      "Cache-Control",
      "no-store",
    ],
    label,
  );
}

/* -------------------------------------------------------------------------- */
/* 4. Safe proposal                                                           */
/* -------------------------------------------------------------------------- */

requireAll(
  safeProposeSource,
  [
    "SAFE_SERVICE_URLS",
    "multisig-transactions",
    "SAFE_API_KEY",
    "authorization",
    "SIGNATURE_PATTERN",
    "UINT_PATTERN",
    "contractTransactionHash",
    "payload.operation !== 0",
    "CALL (operation=0)",
    "rateLimit",
    "requestBodyTooLarge",
  ],
  "api/safe-propose.js",
);

assert.equal(
  safeProposeSource.includes("payload.operation !== 0 &&"),
  false,
  "Safe proposal API must never permit operation=1/DELEGATECALL",
);

/* -------------------------------------------------------------------------- */
/* 5. Safe confirmation                                                       */
/* -------------------------------------------------------------------------- */

requireAll(
  safeConfirmSource,
  [
    "SAFE_SERVICE_URLS",
    "confirmations",
    "safeTxHash",
    "recoverAddress",
    "confirmationAlreadyExists",
    "transaction.isExecuted",
    "operation !== 0",
    "DELEGATECALL esta bloqueado",
    "rateLimit",
    "requestBodyTooLarge",
  ],
  "api/safe-confirm.js",
);

/* -------------------------------------------------------------------------- */
/* 6. Safe transaction lookup                                                 */
/* -------------------------------------------------------------------------- */

requireAll(
  safeTransactionSource,
  [
    "SAFE_SERVICE_URLS",
    "multisig-transactions",
    "normalizeUpstreamTransaction",
    "operation !== 0",
    "DELEGATECALL esta bloqueado",
    "hashVerified",
    "applyRateLimit",
    "requestBodyTooLarge",
    "AbortController",
  ],
  "api/safe-transaction.js",
);

/* -------------------------------------------------------------------------- */
/* 7. Sponsored Relay                                                         */
/* -------------------------------------------------------------------------- */

requireAll(
  safeRelaySource,
  [
    "readSession",
    "buildVerifiedExecutionSignatures",
    "recoverConfirmationSigner",
    "getTransactionHash",
    "liveNonceVerified",
    "safeTxHashVerifiedOnChain",
    "ownersVerifiedOnChain",
    "thresholdVerifiedOnChain",
    "signaturesVerified",
    "provider.call",
    "simulationPassed",
    "ERC20_TRANSFER_SELECTOR",
    "erc20-transfer",
    "native-transfer",
    "operation !== 0",
    "DELEGATECALL esta bloqueado",
    "GELATO_RELAY_API_KEY",
    "relay.gelato.digital/relays/v2/sponsored-call",
  ],
  "api/safe-relay.js",
);

forbidAll(
  safeRelaySource,
  [
    "buildSafeExecutionSignatures(",
    "operation !== 0 &&",
  ],
  "api/safe-relay.js",
);

requireRegex(
  safeRelaySource,
  /safeTx\.safe[\s\S]{0,300}session\.address/,
  "Relay must bind sponsored execution to the authenticated World/Safe session",
);

/* -------------------------------------------------------------------------- */
/* 8. Counterfactual Safe API: independent source/target proof                 */
/* -------------------------------------------------------------------------- */

requireAll(
  counterfactualApiSource,
  [
    "sourceProxyCreationCode",
    "targetProxyCreationCode",
    "sourceProxyCreationCodeHash",
    "targetProxyCreationCodeHash",
    "proxyCreationCodeMatches",
    "factoryRuntimeCodeMatches",
    "singletonRuntimeCodeMatches",
    "sourceSingletonMatchesSafe",
    "decodeSafeInitializer",
    "targetDependenciesHaveCode",
    "sourcePrediction",
    "targetPrediction",
    "receiptVerified",
    "includeGlobalFactorySearch === true",
    "DEFAULT_LOG_BATCH_SIZE = 25_000",
    "MAX_LOG_BATCHES = 64",
    "MAX_GLOBAL_LOG_BATCHES = 8",
    "RC_RECOVERY_MAX_PER_MINUTE",
    "requestBodyTooLarge",
    "read-predict-prepare-only",
    "noMainnetBroadcast:",
    "forkSimulationRequired:",
    "humanApprovalRequired:",
  ],
  "api/counterfactual-safe-recovery.js",
);

forbidAll(
  counterfactualApiSource,
  [
    "DEFAULT_LOG_BATCH_SIZE = 250_000",
    "DEFAULT_MAX_LOG_BATCHES = 220",
    "includeGlobalFactorySearch: body.includeGlobalFactorySearch !== false",
    "setCors(response)",
  ],
  "api/counterfactual-safe-recovery.js",
);

requireRegex(
  counterfactualApiSource,
  /const sourceProxyCreationCode\s*=\s*sourceFactory[\s\S]{0,300}const targetProxyCreationCode\s*=\s*targetFactory/,
  "Source and target proxyCreationCode must be read independently",
);

requireRegex(
  counterfactualApiSource,
  /proxyCreationCode:\s*sourceProxyCreationCode/,
  "Engine compatibility proxyCreationCode must remain source-derived",
);

requireRegex(
  counterfactualApiSource,
  /targetProxyCreationCode[\s\S]{0,700}predictCounterfactualSafeAddress/,
  "Target CREATE2 prediction must use target proxy creation code",
);

requireRegex(
  counterfactualApiSource,
  /BigInt\(decoded\.payment\)\s*!==\s*0n/,
  "Automatic counterfactual deployment must block non-zero Safe.setup payment",
);

requireRegex(
  counterfactualApiSource,
  /deployTransaction:\s*recoveryPossible[\s\S]{0,180}\?\s*analysis\.deployment/,
  "Deployment transaction must fail closed when recovery proof has blockers",
);

/* -------------------------------------------------------------------------- */
/* 9. Counterfactual engine invariants                                         */
/* -------------------------------------------------------------------------- */

requireAll(
  counterfactualEngineSource,
  [
    "SOURCE_ACCOUNT_NOT_SAFE",
    "SOURCE_THRESHOLD_UNVERIFIED",
    "THRESHOLD_REQUIRES_MULTISIG",
    "SOURCE_PREDICTED_ADDRESS_MISMATCH",
    "PREDICTED_ADDRESS_MISMATCH",
    "TARGET_ALREADY_DEPLOYED",
    "sourcePrediction",
    "targetPrediction",
    "source CREATE2 prediction does not reproduce the existing World Safe",
    "target CREATE2 predicted address mismatch",
    "mainnetBroadcastPrepared: false",
    "sourceCreate2ProofRequired: true",
    "targetCreate2ProofRequired: true",
  ],
  "src/recovery/counterfactual-safe-engine.js",
);

requireRegex(
  counterfactualEngineSource,
  /forkSimulationRequired:\s*true/,
  "Counterfactual engine must require fork simulation",
);

requireRegex(
  counterfactualEngineSource,
  /sourceSafeState\?\.detected\s*===\s*true/,
  "Counterfactual engine must require a positively verified source Safe",
);

requireRegex(
  counterfactualEngineSource,
  /sourceThreshold\s*!==\s*1n/,
  "Direct recovery must fail closed when source Safe threshold is not 1",
);

/* -------------------------------------------------------------------------- */
/* 10. Deployment/platform configuration                                       */
/* -------------------------------------------------------------------------- */

requireAll(
  envExampleSource,
  [
    "SAFE_API_KEY=",
    "GELATO_RELAY_API_KEY=",
    "ETHERSCAN_API_KEY=",
    "WORLDSCAN_API_KEY=",
    "RC_SESSION_SECRET=",
    "RC_ALLOWED_ORIGINS=",
    "RC_RELAY_MAX_PER_MINUTE=5",
  ],
  ".env.example",
);

assert.equal(
  vercelConfig.rewrites.some((rewrite) =>
    String(rewrite.source).includes("(?!api/)"),
  ),
  true,
  "Vercel SPA rewrite must never intercept /api routes",
);

/* -------------------------------------------------------------------------- */
/* 11. Obsolete unsafe test expectations must not return                       */
/* -------------------------------------------------------------------------- */

assert.equal(
  blockchainSource.includes("safe-forge-auto-reconstruction"),
  false,
  "Obsolete safe-forge-auto-reconstruction marker must stay removed",
);

console.log("recovery-routes security invariants ok");
