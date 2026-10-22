import assert from "node:assert/strict";
import { BLOCKSCOUT_INDEXERS } from "../src/token-discovery.js";
import { fetchIndexedHistory } from "../src/onchain-history.js";

const owner = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";
const another = "0x0000000000000000000000000000000000000002";
const tokenContract = "0x163f8C2467924be0ae7B5347228CABF260318753";
const nativeHash = `0x${"a".repeat(64)}`;
const tokenHash = `0x${"b".repeat(64)}`;

const chainTx = {
  hash: nativeHash,
  from: { hash: owner }, to: { hash: another },
  value: "1500000000000000000",
  timestamp: "2026-10-22T02:30:00Z",
  status: "ok",
};
const erc20Transfer = {
  tx_hash: tokenHash,
  from: { hash: another }, to: { hash: owner },
  total: { value: "12500000" },
  token: { type: "ERC-20", address_hash: tokenContract, decimals: "6", symbol: "USDC" },
  timestamp: "2026-10-22T02:31:00Z",
};
const unrelated = {
  ...chainTx,
  from: { hash: another }, to: { hash: another },
};
let requests = 0;
const source = BLOCKSCOUT_INDEXERS[8453];
const fetchImpl = async (url, options) => {
  requests++;
  assert.equal(options.method, "GET");
  assert.ok(url.startsWith(`${source}/api/v2/addresses/${owner}`));
  if (url.endsWith("transactions")) {
    return { ok: true, json: async () => ({ items: [chainTx, unrelated, { ...chainTx, hash: "invalid" }] }) };
  }
  assert.ok(url.endsWith("token-transfers?type=ERC-20"));
  return { ok: true, json: async () => ({ items: [erc20Transfer] }) };
};
const result = await fetchIndexedHistory(
  { chainId: 8453, address: owner, nativeSymbol: "ETH" },
  { fetchImpl },
);
assert.equal(requests, 2);
assert.equal(result.status, "indexed");
assert.equal(result.records.length, 2);
assert.equal(result.records[0].direction, "in");
assert.equal(result.records[0].symbol, "USDC");
assert.equal(result.records[0].amount, "12.5");
assert.equal(result.records[1].direction, "out");
assert.equal(result.records[1].amount, "1.5");
assert.ok(!JSON.stringify(result).includes("privateKey"));

const partial = await fetchIndexedHistory(
  { chainId: 8453, address: owner },
  {
    fetchImpl: async (url) => {
      if (url.includes("token-transfers")) throw new Error("offline");
      return { ok: true, json: async () => ({ items: [chainTx] }) };
    },
  },
);
assert.equal(partial.status, "partial");
assert.equal(partial.records.length, 1);

const unavailable = await fetchIndexedHistory(
  { chainId: 8453, address: owner },
  { fetchImpl: async () => ({ ok: false, status: 429 }) },
);
assert.equal(unavailable.status, "unavailable");
assert.equal(unavailable.records.length, 0);

const notConfigured = await fetchIndexedHistory({ chainId: 56, address: owner }, { fetchImpl });
assert.equal(notConfigured.status, "unsupported");
assert.equal(requests, 2);
const invalid = await fetchIndexedHistory({ chainId: 8453, address: "invalid" }, { fetchImpl });
assert.equal(invalid.status, "unavailable");
assert.equal(requests, 2);

const malformed = await fetchIndexedHistory(
  { chainId: 8453, address: owner },
  { fetchImpl: async () => ({ ok: true, json: async () => ({ garbage: "unexpected" }) }) },
);
assert.equal(malformed.status, "unavailable");
console.log("onchain-history ok");
