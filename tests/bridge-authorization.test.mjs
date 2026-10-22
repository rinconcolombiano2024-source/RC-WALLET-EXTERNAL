import assert from "node:assert/strict";
import { assessBridgeAuthorization } from "../src/bridge-authorization.js";

const holder = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";
const signer = holder.toLowerCase();
const otherSigner = "0x0000000000000000000000000000000000000002";

const eoa = assessBridgeAuthorization({
  holder, connectedSigner: signer,
  accountState: { hasCode: false, kind: "no-contract" },
});
assert.equal(eoa.status, "ready");

const unknown = assessBridgeAuthorization({
  holder, connectedSigner: signer,
});
assert.equal(unknown.status, "needs-action");

const different = assessBridgeAuthorization({
  holder, connectedSigner: otherSigner,
  accountState: { hasCode: false, kind: "no-contract" },
});
assert.equal(different.status, "needs-action");

const worldOnly = assessBridgeAuthorization({
  holder, connectedSigner: "",
  accountState: { hasCode: false, kind: "no-contract" },
  worldSessionReady: true,
});
assert.equal(worldOnly.status, "needs-action");
assert.match(worldOnly.requirement, /World App/);

const safe = assessBridgeAuthorization({
  holder, connectedSigner: otherSigner,
  accountState: {
    hasCode: true, kind: "safe-smart-account",
    safe: { detected: true, owners: [otherSigner], threshold: 1 },
  },
});
assert.equal(safe.status, "needs-action");
assert.match(safe.requirement, /Safe/);

const counterfactual = assessBridgeAuthorization({
  holder, connectedSigner: signer,
  accountState: {
    hasCode: false, kind: "no-contract",
    counterfactualSafe: { detected: true, owners: [otherSigner], deployment: { ready: true } },
  },
});
assert.equal(counterfactual.status, "needs-action");

const unverifiedContract = assessBridgeAuthorization({
  holder, connectedSigner: signer,
  accountState: { hasCode: true, kind: "contract" },
});
assert.equal(unverifiedContract.status, "needs-action");
assert.equal(assessBridgeAuthorization({ holder: "invalid", connectedSigner: signer }).status, "needs-action");

console.log("bridge-authorization ok");
