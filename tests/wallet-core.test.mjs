import assert from "node:assert/strict";
import { Wallet } from "ethers";
import {
  buildSafeUiTransactionDraft,
  normalizePrivateKey,
  privateKeyToAddress,
  safeMirrorOwnersInclude,
  safeOwnersInclude,
} from "../src/blockchain.js";

const knownPrivateKey =
  "0x1111111111111111111111111111111111111111111111111111111111111111";
const knownAddress = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";

assert.equal(privateKeyToAddress(knownPrivateKey), knownAddress);
assert.equal(privateKeyToAddress(knownPrivateKey.slice(2)), knownAddress);
assert.equal(privateKeyToAddress(` ${knownPrivateKey}\n`), new Wallet(knownPrivateKey).address);
assert.equal(normalizePrivateKey(knownPrivateKey), knownPrivateKey);
assert.equal(normalizePrivateKey(knownPrivateKey.replace("0x", "0X")), knownPrivateKey);

const safeSignatureObject = new Wallet(knownPrivateKey).signingKey.sign(
  "0x2222222222222222222222222222222222222222222222222222222222222222",
);
const safeSignature = safeSignatureObject.serialized;
assert.match(safeSignature, /^0x[a-fA-F0-9]{130}$/);
assert.ok(
  safeSignatureObject.v === 27 || safeSignatureObject.v === 28,
  "Safe ECDSA signatures must use v 27/28",
);
assert.equal(
  safeOwnersInclude(
    { safe: { detected: true, owners: [knownAddress.toLowerCase()] } },
    knownAddress,
  ),
  true,
);
assert.equal(
  safeOwnersInclude(
    { safe: { detected: true, owners: [knownAddress] } },
    "0x0000000000000000000000000000000000000001",
  ),
  false,
);
assert.equal(
  safeMirrorOwnersInclude(
    {
      counterfactualSafe: {
        detected: true,
        owners: [knownAddress.toLowerCase()],
      },
    },
    knownAddress,
  ),
  true,
);
assert.equal(
  safeMirrorOwnersInclude(
    {
      counterfactualSafe: {
        detected: true,
        owners: [knownAddress],
      },
    },
    "0x0000000000000000000000000000000000000001",
  ),
  false,
);

const safeDraft = buildSafeUiTransactionDraft({
  asset: {
    chainId: 1,
    networkName: "Ethereum",
    symbol: "ETH",
    address: null,
    isNative: true,
    decimals: 18,
    rawBalance: 2_000_000_000_000_000_000n,
  },
  targetAddress: knownAddress,
  recipient: "0x0000000000000000000000000000000000000001",
  amount: "1",
  feeAmountUnits: 0n,
  connectedExternalAddress: knownAddress,
});
assert.equal(safeDraft.format, "rc-wallet-safe-ui-transaction-draft");
assert.equal(safeDraft.safeAddress, knownAddress);
assert.equal(safeDraft.chainId, 1);
assert.equal(safeDraft.transactions.length, 1);
assert.equal(
  safeDraft.transactionBuilder.transactions[0].to,
  "0x0000000000000000000000000000000000000001",
);
assert.equal(safeDraft.safeAppsSdk.txs[0].value, "1000000000000000000");

assert.throws(
  () => normalizePrivateKey("0x1234"),
  /64 caracteres hexadecimales/,
);
assert.throws(
  () => normalizePrivateKey(`${knownPrivateKey.slice(0, 10)} ${knownPrivateKey.slice(10)}`),
  /64 caracteres hexadecimales/,
);
assert.throws(
  () =>
    normalizePrivateKey(
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    ),
  /rango EVM valido/,
);
assert.throws(
  () =>
    normalizePrivateKey(
      "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
    ),
  /rango EVM valido/,
);

console.log("wallet-core ok");
