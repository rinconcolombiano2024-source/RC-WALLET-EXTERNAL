import assert from "node:assert/strict";
import {
  BLOCKSCOUT_INDEXERS,
  parseIndexedErc20Definitions,
  discoverIndexedErc20Tokens,
} from "../src/token-discovery.js";
import { NETWORKS, SAFE_CREATION_SERVICE_URLS } from "../src/config.js";

const owner = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";
const validToken = "0x163f8C2467924be0ae7B5347228CABF260318753";
const anotherToken = "0x0000000000000000000000000000000000000002";

assert.equal(NETWORKS.find((n) => n.chainId === 137)?.symbol, "POL");
assert.match(SAFE_CREATION_SERVICE_URLS[137][0], /safe-transaction-polygon/);
assert.match(SAFE_CREATION_SERVICE_URLS[42161][0], /safe-transaction-arbitrum/);
assert.equal(NETWORKS.find((n) => n.chainId === 42161)?.chainHex, "0xa4b1");
for (const network of NETWORKS) {
  assert.equal(Number.parseInt(network.chainHex, 16), network.chainId);
  assert.ok(Array.isArray(network.rpcUrls) && network.rpcUrls.length);
}

const input = [
  { token: { type: "ERC-20", address_hash: validToken, symbol: "WLD" }, value: "2" },
  { token: { type: "ERC-20", address_hash: validToken.toLowerCase(), symbol: "WLD" } },
  { token: { type: "ERC-721", address_hash: anotherToken, symbol: "NFT" } },
  { token: { type: "ERC-20", address_hash: "not-an-address", symbol: "BAD" } },
  { token: { type: "ERC-20", address_hash: anotherToken, symbol: "<script>alert(1)</script>" } },
  { token: { type: "ERC-20", address_hash: "0x0000000000000000000000000000000000000000" } },
];

const indexed = parseIndexedErc20Definitions(input, 1, 1);
assert.equal(indexed.definitions.length, 1);
assert.equal(indexed.truncated, true);
assert.equal(indexed.definitions[0].addresses[1], validToken);

const total = parseIndexedErc20Definitions(input, 1);
assert.equal(total.truncated, false);
assert.equal(total.definitions.length, 2);
assert.equal(total.definitions[1].symbol, "<script>alert(1)</script>".slice(0, 30));
assert.throws(() => parseIndexedErc20Definitions({}, 1), /inesperada/);

let calledUrl = "";
const successful = await discoverIndexedErc20Tokens(
  { chainId: 137 },
  owner,
  {
    fetchImpl: async (url, options) => {
      calledUrl = url;
      assert.equal(options.method, "GET");
      return { ok: true, json: async () => input };
    },
  },
);
assert.equal(successful.status, "indexed");
assert.equal(successful.definitions.length, 2);
assert.equal(
  calledUrl,
  `${BLOCKSCOUT_INDEXERS[137]}/api/v2/addresses/${owner}/token-balances`,
);
assert.equal(
  (await discoverIndexedErc20Tokens({ chainId: 480 }, owner)).status,
  "unsupported",
);
assert.equal(
  (await discoverIndexedErc20Tokens({ chainId: 137 }, "invalid")).status,
  "unavailable",
);
assert.equal(
  (
    await discoverIndexedErc20Tokens({ chainId: 137 }, owner, {
      fetchImpl: async () => ({ ok: false, status: 429 }),
    })
  ).status,
  "unavailable",
);
assert.equal(
  (
    await discoverIndexedErc20Tokens({ chainId: 137 }, owner, {
      maxTokens: 1,
      fetchImpl: async () => ({ ok: true, json: async () => input }),
    })
  ).status,
  "partial",
);

console.log("token-discovery ok");
