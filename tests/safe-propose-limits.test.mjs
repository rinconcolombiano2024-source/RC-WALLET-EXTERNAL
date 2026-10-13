import assert from "node:assert/strict";
import { test } from "node:test";
import handler from "../api/safe-propose.js";

const safe = "0x1111111111111111111111111111111111111111";
const destination = "0x2222222222222222222222222222222222222222";
function payload(overrides = {}) {
  return {
    safe,
    to: destination,
    sender: safe,
    gasToken: "0x0000000000000000000000000000000000000000",
    refundReceiver: "0x0000000000000000000000000000000000000000",
    operation: 0,
    value: "0",
    safeTxGas: "0",
    baseGas: "0",
    gasPrice: "0",
    nonce: 0,
    data: "0x",
    signature: "0x" + "11".repeat(65),
    contractTransactionHash: "0x" + "22".repeat(32),
    ...overrides,
  };
}
function response() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(key, value) { this.headers[key] = value; return this; },
    status(n) { this.statusCode = n; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}
function request(overrides = {}) {
  return {
    method: "POST",
    headers: { origin: "http://localhost:3000", host: "localhost:3000" },
    body: { chainId: 1, safeAddress: safe, payload: payload() },
    ...overrides,
  };
}

test("oversized Safe proposals are rejected before upstream broadcast", async () => {
  const res = response();
  await handler(request({ body: { huge: "X".repeat(180_000) } }), res);
  assert.equal(res.statusCode, 413);
  assert.match(res.body.error, /grande/);
});
test("content-length header cannot bypass Safe proposal limits", async () => {
  const res = response();
  await handler(request({ headers: { host: "localhost:3000", "content-length": "180000" } }), res);
  assert.equal(res.statusCode, 413);
});
test("Safe proposal endpoint rejects cross-origin calls", async () => {
  const res = response();
  await handler(request({ headers: { origin: "https://evil.invalid", host: "localhost:3000" } }), res);
  assert.equal(res.statusCode, 403);
});
test("Safe proposal endpoint prohibits DELEGATECALL", async () => {
  const res = response();
  await handler(request({ body: { chainId: 1, safeAddress: safe, payload: payload({ operation: 1 }) } }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /CALL/);
});
