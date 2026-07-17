import assert from "node:assert/strict";
import handler, {
  normalizeManualSourceDeploymentInput,
  summarizeMovementPlan,
} from "../api/counterfactual-safe-recovery.js";

function createResponse() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    ended: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

const optionsResponse = createResponse();
await handler({ method: "OPTIONS" }, optionsResponse);
assert.equal(optionsResponse.statusCode, 204);
assert.equal(optionsResponse.ended, true);
assert.equal(optionsResponse.headers["access-control-allow-methods"], "POST, OPTIONS");

const secretResponse = createResponse();
await handler(
  {
    method: "POST",
    body: {
      sourceChainId: 480,
      targetChainId: 1,
      smartAccountAddress: "0x0BbBd8EBa77dB629721CcdFa0C57a9ee107fdB85",
      privateKey: "0x1111111111111111111111111111111111111111111111111111111111111111",
    },
  },
  secretResponse,
);
assert.equal(secretResponse.statusCode, 400);
assert.equal(secretResponse.body.ok, false);
assert.match(secretResponse.body.error, /Campo secreto prohibido/);

const missingTargetResponse = createResponse();
await handler(
  {
    method: "POST",
    body: {
      sourceChainId: 480,
      smartAccountAddress: "0x0BbBd8EBa77dB629721CcdFa0C57a9ee107fdB85",
    },
  },
  missingTargetResponse,
);
assert.equal(missingTargetResponse.statusCode, 400);
assert.match(missingTargetResponse.body.error, /targetChainId/);

const methodResponse = createResponse();
await handler({ method: "GET" }, methodResponse);
assert.equal(methodResponse.statusCode, 405);
assert.equal(methodResponse.body.error, "Metodo no permitido");

const manualDeployment = normalizeManualSourceDeploymentInput({
  factoryAddress: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
  masterCopy: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
  setupData: "0x1234",
  salt: 7,
  creationMethod: "createProxyWithNonceL2",
  proxyCreationCode: "0x6080",
});
assert.equal(
  manualDeployment.factory,
  "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
);
assert.equal(
  manualDeployment.singleton,
  "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
);
assert.equal(manualDeployment.initializer, "0x1234");
assert.equal(manualDeployment.saltNonce, "7");
assert.equal(manualDeployment.method, "createProxyWithNonceL2");
assert.equal(manualDeployment.proxyCreationCode, "0x6080");

assert.throws(
  () =>
    normalizeManualSourceDeploymentInput({
      factory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
      singleton: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
      initializer: "0x1234",
      saltNonce: "7",
      method: "createWalletLikeMagic",
    }),
  /Metodo Safe no soportado/,
);

const movementPlan = summarizeMovementPlan({
  recoveryPossible: true,
  blockers: [],
  warnings: ["Run fork simulation and human review before signing any transaction."],
  deployment: {
    deployTransaction: {
      to: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
      value: "0",
      data: "0x1234",
      operation: 0,
    },
    safeActions: [
      {
        to: "0x163f8C2467924be0ae7B5347228CABF260318753",
        value: "0",
        data: "0xa9059cbb0000000000000000000000000000000000000000000000000000000000000001",
        operation: 0,
      },
      {
        to: "0x0000000000000000000000000000000000000001",
        value: "1",
        data: "0x",
        operation: 0,
      },
    ],
    mainnetBroadcastPrepared: false,
    forkSimulationRequired: true,
    manualApprovalRequired: true,
  },
});
assert.equal(movementPlan.canDeploy, true);
assert.equal(movementPlan.canMoveTokens, true);
assert.equal(movementPlan.actionCount, 2);
assert.equal(movementPlan.tokenActionCount, 1);
assert.equal(movementPlan.nativeActionCount, 1);
assert.equal(movementPlan.mainnetBroadcastPrepared, false);
assert.equal(movementPlan.forkSimulationRequired, true);
assert.equal(movementPlan.manualApprovalRequired, true);

console.log("counterfactual-safe-recovery-api ok");
