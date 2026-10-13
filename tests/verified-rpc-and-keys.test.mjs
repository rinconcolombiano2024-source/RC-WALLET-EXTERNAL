import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { Wallet } from "ethers";
import { getProvider as blockchainProvider, normalizeAddress as blockchainAddress } from "../src/blockchain.js";
import { getProvider as walletCoreProvider, normalizeAddress as coreAddress } from "../src/wallet-core.js";

const servers = [];
after(async () => { await Promise.all(servers.map((server) => new Promise((done) => server.close(done)))); });

async function rpc(chainId) {
  let requests = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const query = JSON.parse(body);
    requests++;
    const method = query.method;
    const result = method === "eth_chainId" ? "0x" + chainId.toString(16)
      : method === "eth_blockNumber" ? "0x1" : "0x";
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: query.id, result }));
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  return { url: `http://127.0.0.1:${server.address().port}`, count: () => requests };
}

test("EIP-55 checksums remain enforced by both address parsers", () => {
  const address = new Wallet("0x" + "11".repeat(32)).address;
  assert.equal(coreAddress(address), address);
  assert.equal(blockchainAddress(address), address);
  const index = [...address].findIndex((ch, i) => i > 2 && /[a-fA-F]/.test(ch));
  const corrupt = address.slice(0, index) + (address[index] === address[index].toUpperCase()
    ? address[index].toLowerCase() : address[index].toUpperCase()) + address.slice(index + 1);
  assert.throws(() => coreAddress(corrupt), /checksum/i);
  assert.throws(() => blockchainAddress(corrupt), /checksum/i);
});

test("main blockchain RPC rejects wrong actual chain and falls back", async () => {
  const wrong = await rpc(1);
  const correct = await rpc(300881);
  const provider = await blockchainProvider({
    chainId: 300881,
    name: "Mock Chain A",
    rpcUrls: [wrong.url, correct.url],
  });
  assert.equal(Number(BigInt(await provider.send("eth_chainId", []))), 300881);
  assert.ok(wrong.count() >= 1);
  assert.ok(correct.count() >= 1);
  provider.destroy();
});

test("legacy wallet-core RPC also rejects wrong actual chain and falls back", async () => {
  const wrong = await rpc(1);
  const correct = await rpc(300882);
  const provider = await walletCoreProvider({
    chainId: 300882,
    name: "Mock Chain B",
    rpcUrls: [wrong.url, correct.url],
  });
  assert.equal(Number(BigInt(await provider.send("eth_chainId", []))), 300882);
  assert.ok(wrong.count() >= 1);
  assert.ok(correct.count() >= 1);
  provider.destroy();
});

test("no RPC accepting an invalid chain is treated as trustworthy", async () => {
  const wrong = await rpc(1);
  await assert.rejects(
    () => blockchainProvider({ chainId: 300883, name: "Mock Chain C", rpcUrls: [wrong.url] }),
    /No hay un RPC disponible/,
  );
});
