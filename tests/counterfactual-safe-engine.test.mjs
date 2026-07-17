import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  RECOVERY_STATES,
  analyzeCounterfactualSafeRecovery,
  buildSafeActionForAssetTransfer,
  buildSafeDeploymentTransaction,
  createCounterfactualSafeRecoveryEngine,
  predictCounterfactualSafeAddress,
} from "../src/recovery/counterfactual-safe-engine.js";

const fixture = {
  sourceChainId: 480,
  targetChainId: 1,
  smartAccountAddress: "0x0BbBd8EBa77dB629721CcdFa0C57a9ee107fdB85",
  connectedOwnerAddress: "0x2744392572aA5C1DDbE14EE3eA04B063416DE6B7",
  sourceSafeState: {
    detected: true,
    owners: ["0x2744392572aA5C1DDbE14EE3eA04B063416DE6B7"],
    threshold: 1,
    modules: ["0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226"],
  },
};

const sourceDeployment = {
  factory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
  singleton: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
  proxyCreationCode: "0x6080604052348015600f57600080fd5b506001600081905550",
  initializer: "0x12345678",
  saltNonce: "7",
  deploymentMethod: "createProxyWithNonce",
};

const firstPrediction = predictCounterfactualSafeAddress({
  expectedAddress: ethers.ZeroAddress,
  ...sourceDeployment,
  chainId: fixture.targetChainId,
});
const matchingExpectedAddress = firstPrediction.predictedAddress;

const matchingAnalysis = analyzeCounterfactualSafeRecovery({
  ...fixture,
  smartAccountAddress: matchingExpectedAddress,
  sourceDeployment,
  targetDeploymentStatus: { hasCode: false },
  plannedTransfers: [
    {
      tokenAddress: "0x163f8C2467924be0ae7B5347228CABF260318753",
      recipient: "0x0000000000000000000000000000000000000001",
      amountUnits: "108422693710000000000",
    },
    {
      native: true,
      recipient: "0x0000000000000000000000000000000000000001",
      amountUnits: "1000000000000000",
    },
  ],
});

assert.equal(matchingAnalysis.reconstructionStatus, RECOVERY_STATES.READY_FOR_MANUAL_REVIEW);
assert.equal(matchingAnalysis.addressMatches, true);
assert.equal(matchingAnalysis.recoveryPossible, true);
assert.equal(matchingAnalysis.deployment.deployTransaction.to, sourceDeployment.factory);
assert.equal(matchingAnalysis.deployment.safeActions.length, 2);
assert.equal(matchingAnalysis.deployment.mainnetBroadcastPrepared, false);
assert.equal(matchingAnalysis.deployment.forkSimulationRequired, true);

const mismatchAnalysis = analyzeCounterfactualSafeRecovery({
  ...fixture,
  sourceDeployment,
  targetDeploymentStatus: { hasCode: false },
});

assert.equal(
  mismatchAnalysis.reconstructionStatus,
  RECOVERY_STATES.PREDICTED_ADDRESS_MISMATCH,
);
assert.equal(mismatchAnalysis.addressMatches, false);
assert.equal(mismatchAnalysis.recoveryPossible, false);
assert.equal(mismatchAnalysis.deployment.deployTransaction, null);

const missingSalt = analyzeCounterfactualSafeRecovery({
  ...fixture,
  sourceDeployment: {
    ...sourceDeployment,
    saltNonce: "",
  },
});

assert.equal(missingSalt.reconstructionStatus, RECOVERY_STATES.MISSING_SALT);
assert.ok(missingSalt.blockers.some((item) => item.includes("saltNonce")));

const ownerMismatch = analyzeCounterfactualSafeRecovery({
  ...fixture,
  connectedOwnerAddress: "0x0000000000000000000000000000000000000002",
  sourceDeployment,
});

assert.equal(ownerMismatch.reconstructionStatus, RECOVERY_STATES.OWNER_MISMATCH);
assert.equal(ownerMismatch.ownerMatches, false);

const chainSpecific = analyzeCounterfactualSafeRecovery({
  ...fixture,
  sourceDeployment: {
    ...sourceDeployment,
    deploymentMethod: "createChainSpecificProxyWithNonce",
  },
});

assert.equal(chainSpecific.reconstructionStatus, RECOVERY_STATES.CHAIN_SPECIFIC_ADDRESS);
assert.equal(chainSpecific.evidence.prediction.chainSpecific, true);

const deploymentTransaction = buildSafeDeploymentTransaction(sourceDeployment);
assert.match(deploymentTransaction.data, /^0x[a-fA-F0-9]+$/);
assert.equal(deploymentTransaction.value, "0");

const erc20Action = buildSafeActionForAssetTransfer({
  tokenAddress: "0x163f8C2467924be0ae7B5347228CABF260318753",
  recipient: "0x0000000000000000000000000000000000000001",
  amountUnits: "1",
});
assert.equal(erc20Action.to, "0x163f8C2467924be0ae7B5347228CABF260318753");
assert.match(erc20Action.data, /^0xa9059cbb/);

const nativeAction = buildSafeActionForAssetTransfer({
  native: true,
  recipient: "0x0000000000000000000000000000000000000001",
  amountUnits: "1",
});
assert.equal(nativeAction.data, "0x");
assert.equal(nativeAction.value, "1");

assert.throws(
  () =>
    analyzeCounterfactualSafeRecovery({
      ...fixture,
      privateKey: "0x1111111111111111111111111111111111111111111111111111111111111111",
    }),
  /Campo secreto prohibido/,
);

const engine = createCounterfactualSafeRecoveryEngine({
  sourceChainId: fixture.sourceChainId,
  targetChainId: fixture.targetChainId,
});
assert.equal(
  engine.analyze({
    ...fixture,
    smartAccountAddress: matchingExpectedAddress,
    sourceDeployment,
    targetDeploymentStatus: { hasCode: false },
  }).recoveryPossible,
  true,
);

console.log("counterfactual-safe-engine ok");
