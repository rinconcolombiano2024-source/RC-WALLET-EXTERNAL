import assert from "node:assert/strict";
import handler, { parseBinplorerTokenHints } from "../api/token-discovery.js";
import { discoverIndexedErc20Tokens } from "../src/token-discovery.js";

const owner = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";
const tokenA = "0x163f8C2467924be0ae7B5347228CABF260318753";
const tokenB = "0x0000000000000000000000000000000000000002";
const indexerResponse = {
  address: owner,
  ETH: { balance: 10_000_000 },
  tokens: [
    { tokenInfo: { address: tokenA, symbol: "USDT", decimals: "18" }, balance: "99999" },
    { tokenInfo: { address: tokenA.toLowerCase(), symbol: "fake" }, balance: "123" },
    { tokenInfo: { address: tokenB, symbol: "<script>hey</script>" }, balance: "200" },
    { tokenInfo: { address: "bad-address", symbol: "FAKE" }, balance: "12" },
  ],
};

const parsed = parseBinplorerTokenHints(indexerResponse);
assert.equal(parsed.items.length, 2);
assert.equal(parsed.items[0].token.address_hash, tokenA);
assert.equal(parsed.items[0].token.balance, undefined);
assert.equal(parsed.items[1].token.symbol, "scriptheyscript");
assert.throws(() => parseBinplorerTokenHints({}), /lista de tokens/);

function mockResponse() {
  return {
    headers: {},
    setHeader(key, val) { this.headers[key] = val; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}
function getRequest(address = owner, chainId = "56", headers = {}) {
  return { method: "GET", headers, query: { address, chainId } };
}

let called = 0;
const originalFetch = globalThis.fetch;
const oldKey = process.env.BINPLORER_API_KEY;
process.env.BINPLORER_API_KEY = "unit-test-secret-token";
globalThis.fetch = async (url) => {
  called++;
  const remote = new URL(String(url));
  assert.equal(remote.origin, "https://api.binplorer.com");
  assert.equal(remote.pathname, `/getAddressInfo/${owner}`);
  assert.equal(remote.searchParams.get("apiKey"), "unit-test-secret-token");
  return {
    ok: true,
    headers: { get: () => null },
    text: async () => JSON.stringify(indexerResponse),
  };
};

try {
  const invalid = mockResponse();
  await handler(getRequest("invalid"), invalid);
  assert.equal(invalid.statusCode, 400);
  assert.equal(called, 0);

  const invalidNetwork = mockResponse();
  await handler(getRequest(owner, "1"), invalidNetwork);
  assert.equal(invalidNetwork.statusCode, 400);
  assert.equal(called, 0);

  const blocked = mockResponse();
  await handler(getRequest(owner, "56", { origin: "https://attacker.example" }), blocked);
  assert.equal(blocked.statusCode, 403);
  assert.equal(called, 0);

  const ok = mockResponse();
  await handler(getRequest(), ok);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.status, "indexed");
  assert.equal(ok.body.items.length, 2);
  assert.equal(ok.body.items[0].token.balance, undefined);
  assert.ok(!JSON.stringify(ok.body).includes("unit-test-secret-token"));
  assert.ok(!JSON.stringify(ok.body).includes("99999"));

  const front = await discoverIndexedErc20Tokens({ chainId: 56 }, owner, {
    fetchImpl: async (url, opts) => {
      assert.match(url, /^\/api\/token-discovery\?chainId=56/);
      assert.equal(opts.method, "GET");
      return { ok: true, json: async () => ok.body };
    },
  });
  assert.equal(front.status, "indexed");
  assert.equal(front.definitions.length, 2);
  assert.equal(front.definitions[0].addresses[56], tokenA);

  const partial = await discoverIndexedErc20Tokens({ chainId: 56 }, owner, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ ...ok.body, status: "partial" }),
    }),
  });
  assert.equal(partial.status, "partial");

  const unreachable = await discoverIndexedErc20Tokens({ chainId: 56 }, owner, {
    fetchImpl: async () => { throw new Error("upstream unavailable"); },
  });
  assert.equal(unreachable.status, "unavailable");
} finally {
  globalThis.fetch = originalFetch;
  if (oldKey === undefined) delete process.env.BINPLORER_API_KEY;
  else process.env.BINPLORER_API_KEY = oldKey;
}
console.log("bnb-token-discovery ok");
