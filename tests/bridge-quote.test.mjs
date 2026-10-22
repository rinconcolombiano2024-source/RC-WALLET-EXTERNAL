import assert from "node:assert/strict";
import {
  validateBridgeQuotePayload,
  createBridgeQuoteUrl,
  sanitizeBridgeQuote,
} from "../src/bridge-quote.js";
import handler from "../api/bridge-quote.js";

const source = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";
const destination = "0x0000000000000000000000000000000000000001";
const payload = {
  fromChain: 1, toChain: 8453,
  fromToken: "ETH", toToken: "USDC",
  fromAmount: "100000000000000000",
  fromAddress: source, toAddress: destination,
};
const quote = {
  tool: "relay",
  toolDetails: { name: "Relay" },
  action: {
    fromChainId: 1, toChainId: 8453,
    fromAddress: source, toAddress: destination,
    fromAmount: payload.fromAmount,
    fromToken: { symbol: "ETH", decimals: 18 },
    toToken: { symbol: "USDC", decimals: 6 },
  },
  estimate: {
    toAmount: "205000000", toAmountMin: "200000000",
    gasCosts: [{ amountUSD: "1.52" }],
    feeCosts: [{ amountUSD: "0.38" }],
  },
  transactionRequest: { to: "0x0000000000000000000000000000000000000002", data: "0x1234" },
};

assert.deepEqual(validateBridgeQuotePayload(payload), payload);
const query = new URL(createBridgeQuoteUrl(payload));
assert.equal(query.origin, "https://li.quest");
assert.equal(query.pathname, "/v1/quote");
assert.equal(query.searchParams.get("fromAmount"), payload.fromAmount);
assert.throws(() => validateBridgeQuotePayload({ ...payload, fromChain: 999 }), /Red no admitida/);
assert.throws(() => validateBridgeQuotePayload({ ...payload, toChain: 1 }), /dos redes/);
assert.throws(() => validateBridgeQuotePayload({ ...payload, fromAmount: "-1" }), /Cantidad/);
assert.throws(() => validateBridgeQuotePayload({ ...payload, fromToken: "javascript:evil()" }), /Token origen/);
assert.throws(() => validateBridgeQuotePayload({ ...payload, privateKey: "0x".padEnd(67, "a"), seed: "x".repeat(2500) }), /demasiado grande/);
assert.throws(() => validateBridgeQuotePayload({ ...payload, fromAddress: "invalid" }), /Direccion/);

const safeQuote = sanitizeBridgeQuote(quote, payload);
assert.equal(safeQuote.minimumOutputAtomic, "200000000");
assert.equal(safeQuote.gasCostUSD, 1.52);
assert.equal(safeQuote.feeCostUSD, 0.38);
assert.equal(safeQuote.executionAvailableInRcWallet, false);
assert.equal(safeQuote.transactionRequest, undefined);
assert.throws(() => sanitizeBridgeQuote({ ...quote, action: { ...quote.action, fromAddress: destination } }, payload), /ruta diferente/);
assert.throws(() => sanitizeBridgeQuote({ ...quote, action: { ...quote.action, toToken: { ...quote.action.toToken, symbol: "USDT" } } }, payload), /token recibido/);
assert.throws(() => sanitizeBridgeQuote({ ...quote, estimate: { ...quote.estimate, toAmountMin: "999999999" } }, payload), /inconsistente/);

function res() {
  return {
    headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
    end() { this.ended = true; return this; },
  };
}

let networkCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  networkCalls++;
  assert.match(url, /^https:\/\/li\.quest\/v1\/quote\?/);
  return { ok: true, text: async () => JSON.stringify(quote) };
};
try {
  const invalid = res();
  await handler({ method: "POST", headers: {}, body: { ...payload, fromAddress: "invalid" } }, invalid);
  assert.equal(invalid.statusCode, 400);
  assert.equal(networkCalls, 0);

  const blocked = res();
  await handler({ method: "POST", headers: { origin: "https://attacker.example" }, body: payload }, blocked);
  assert.equal(blocked.statusCode, 403);
  assert.equal(networkCalls, 0);

  const success = res();
  await handler({ method: "POST", headers: {}, body: payload }, success);
  assert.equal(success.statusCode, 200);
  assert.equal(success.body.quote.status, "informative-quote-only");
  assert.equal(success.body.quote.transactionRequest, undefined);
  assert.equal(networkCalls, 1);

  globalThis.fetch = async () => ({ ok: false, text: async () => '{"code":1001}' });
  const noRoute = res();
  await handler({ method: "POST", headers: {}, body: payload }, noRoute);
  assert.equal(noRoute.statusCode, 422);
  assert.ok(!JSON.stringify(noRoute.body).includes("1001"));
} finally {
  globalThis.fetch = originalFetch;
}
console.log("bridge-quote ok");
