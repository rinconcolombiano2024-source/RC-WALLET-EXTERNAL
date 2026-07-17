import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const recoveryEngineSource = readFileSync(
  new URL("../src/recovery/counterfactual-safe-engine.js", import.meta.url),
  "utf8",
);
const catalogSource = readFileSync(
  new URL("../src/recovery/safe-deployment-catalog.js", import.meta.url),
  "utf8",
);
const counterfactualSafeRecoveryApiSource = readFileSync(
  new URL("../api/counterfactual-safe-recovery.js", import.meta.url),
  "utf8",
);

for (const forbidden of [
  "new Wallet",
  "createRandom",
  "HDNode",
  "derivePath",
  "mnemonicTo",
  ".sendTransaction(",
  "wallet_sendTransaction",
]) {
  assert.equal(
    recoveryEngineSource.includes(forbidden) ||
      catalogSource.includes(forbidden) ||
      counterfactualSafeRecoveryApiSource.includes(forbidden),
    false,
    `Recovery module must not contain active signing/broadcast primitive: ${forbidden}`,
  );
}

for (const required of [
  "assertNoSecrets",
  "mainnetBroadcastPrepared: false",
  "forkSimulationRequired: true",
  "manualApprovalRequired: true",
  "predictedAddress",
  "expectedAddress",
  "matches",
]) {
  assert.ok(
    recoveryEngineSource.includes(required),
    `Recovery module is missing safety marker: ${required}`,
  );
}

for (const required of [
  "counterfactual-safe-recovery",
  "read-predict-prepare-only",
  "assertNoSecrets",
  "predictCounterfactualSafeAddress",
  "SAFE_PROXY_CREATION_TOPIC",
  "SAFE_PROXY_CREATION_L2_TOPIC",
  "SAFE_CHAIN_SPECIFIC_PROXY_CREATION_L2_TOPIC",
  "getcontractcreation",
  "if (!parsed) return null",
  "creationFromTransactionHash",
  "creationFromReceiptLogs",
  "readCreationFromExplorerLogs",
  "readCreationFromExplorerGlobalLogs",
  "readCreationFromExplorerInternalTransactions",
  "readCreationFromExplorerNormalTransactions",
  "readCreationFromExplorer",
  "creationFromMatchedLog",
  "searchCreationAroundTransaction",
  "searchGlobalProxyCreationLogs",
  "includeUnindexedLogs",
  "includeGlobalFactorySearch",
  "globalLogSearch",
  "Promise.allSettled",
  "scanCursor",
  "nextScan",
  "normalizeManualSourceDeploymentInput",
  "manualSourceDeployment",
  "plannedTransfers",
  "summarizeMovementPlan",
  "canMoveTokens",
  "inspectSafe",
  "searchCreationLogs",
  "noMainnetBroadcast",
  "humanApprovalRequired",
]) {
  assert.ok(
    counterfactualSafeRecoveryApiSource.includes(required),
    `Counterfactual Safe recovery API is missing safety marker: ${required}`,
  );
}

console.log("lint-recovery-security ok");
