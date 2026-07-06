import assert from "node:assert/strict";
import {
  normalizePrivateKey,
  privateKeyToAddress,
} from "../src/blockchain.js";

const knownPrivateKey =
  "0x1111111111111111111111111111111111111111111111111111111111111111";
const knownAddress = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";

assert.equal(privateKeyToAddress(knownPrivateKey), knownAddress);
assert.equal(privateKeyToAddress(knownPrivateKey.slice(2)), knownAddress);
assert.equal(normalizePrivateKey(knownPrivateKey), knownPrivateKey);

assert.throws(
  () => normalizePrivateKey("0x1234"),
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
