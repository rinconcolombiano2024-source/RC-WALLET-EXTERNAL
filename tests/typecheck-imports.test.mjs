import assert from "node:assert/strict";

const engine = await import("../src/recovery/counterfactual-safe-engine.js");
const catalog = await import("../src/recovery/safe-deployment-catalog.js");
const blockchain = await import("../src/blockchain.js");
const counterfactualSafeRecoveryApi = await import(
  "../api/counterfactual-safe-recovery.js"
);

assert.equal(typeof engine.analyzeCounterfactualSafeRecovery, "function");
assert.equal(typeof engine.predictCounterfactualSafeAddress, "function");
assert.equal(typeof engine.createCounterfactualSafeRecoveryEngine, "function");
assert.ok(Array.isArray(catalog.SAFE_DEPLOYMENT_CATALOG));
assert.equal(typeof catalog.catalogEntriesForChain, "function");
assert.equal(typeof blockchain.privateKeyToAddress, "function");
assert.equal(typeof counterfactualSafeRecoveryApi.default, "function");
assert.equal(
  typeof counterfactualSafeRecoveryApi.normalizeManualSourceDeploymentInput,
  "function",
);
assert.equal(typeof counterfactualSafeRecoveryApi.summarizeMovementPlan, "function");

console.log("typecheck-imports ok");
