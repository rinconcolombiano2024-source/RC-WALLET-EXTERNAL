import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const blockchainSource = readFileSync(
  new URL("../src/blockchain.js", import.meta.url),
  "utf8",
);
const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const safeProposeSource = readFileSync(
  new URL("../api/safe-propose.js", import.meta.url),
  "utf8",
);
const safeConfirmSource = readFileSync(
  new URL("../api/safe-confirm.js", import.meta.url),
  "utf8",
);
const safeTransactionSource = readFileSync(
  new URL("../api/safe-transaction.js", import.meta.url),
  "utf8",
);
const vercelConfig = JSON.parse(
  readFileSync(new URL("../vercel.json", import.meta.url), "utf8"),
);

for (const forbidden of [
  "createRandom",
  "HDNode",
  "derivePath",
  "mnemonic",
  "toUtf8Bytes",
  "fromUtf8",
]) {
  assert.equal(
    blockchainSource.includes(forbidden),
    false,
    `Forbidden private-key derivation/conversion found: ${forbidden}`,
  );
}

assert.match(
  blockchainSource,
  /export function privateKeyToAddress\(privateKey\)[\s\S]*new ethers\.Wallet\(normalizedPrivateKey\)/,
  "Private-key import must use ethers.Wallet directly with the normalized hex key",
);

assert.match(
  blockchainSource,
  /async function inspectCounterfactualSafeMirror\(provider, network, owner, hasCode\)/,
  "Counterfactual Safe inspection must receive the target-network provider",
);
assert.match(
  blockchainSource,
  /inspectCounterfactualSafeMirror\(provider, asset\.network, owner, hasCode\)/,
  "Refresh path must inspect the Safe mirror with the target provider",
);
assert.match(
  blockchainSource,
  /inspectCounterfactualSafeMirror\(provider, network, owner, hasCode\)/,
  "Network scan path must inspect the Safe mirror with the target provider",
);

for (const required of [
  "safeOwnersInclude(refreshedAccountState, signerAddress)",
  "safeMirrorOwnersInclude(refreshedAccountState, signerAddress)",
  "deploySafeMirrorAndSend",
  "sendWithSafeOwnerSigner",
  "contract.transfer(",
  "signer.sendTransaction(",
  "factory.createProxyWithNonce(",
  "deployment.canReplayCrossChain",
  "deployment.ready",
  "deployment.targetPredictionMatches",
  "targetFactoryHasCode",
  "targetSingletonHasCode",
  "buildSafeUiTransactionDraft",
  "rc-wallet-safe-ui-transaction-draft",
  "transactionBuilder",
  "safeAppsSdk",
  "proposeSafeTransactionWithExternalWallet",
  "proposeSafeTransactionWithPrivateKeyWallet",
  "confirmSafeTransactionWithPrivateKeyWallet",
  "executeSafeTransactionFromServiceWithPrivateKeyWallet",
  "inspectSafeTransactionStatus",
  "buildSafeExecutionSignatures",
  "safe-service-execute-private-key",
  "execTransaction(...execArgs",
  "postSafeTransactionProposal",
  "postSafeTransactionProposalViaRcApi",
  "postSafeTransactionConfirmation",
  "readSafeTransactionDetails",
  "/api/safe-confirm",
  "/api/safe-transaction",
  "/api/safe-propose",
  "rc-wallet-api",
  "contractTransactionHash",
]) {
  assert.ok(
    blockchainSource.includes(required),
    `Recovery route is missing required guard or send path: ${required}`,
  );
}

for (const required of [
  "SAFE_SERVICE_URLS",
  "multisig-transactions",
  "contractTransactionHash",
  "Safe Transaction Service rechazo la propuesta",
  "RC-Wallet-External/1.0",
  "SAFE_API_KEY",
  "authorization",
  "SIGNATURE_PATTERN",
  "UINT_PATTERN",
  "payload.operation",
  "Number.isSafeInteger(payload.nonce)",
]) {
  assert.ok(
    safeProposeSource.includes(required),
    `Safe proposal API is missing: ${required}`,
  );
}

for (const required of [
  "SAFE_SERVICE_URLS",
  "multisig-transactions",
  "confirmations",
  "safeTxHash",
  "SIGNATURE_PATTERN",
  "SAFE_API_KEY",
  "authorization",
  "Safe Transaction Service rechazo la confirmacion",
]) {
  assert.ok(
    safeConfirmSource.includes(required),
    `Safe confirmation API is missing: ${required}`,
  );
}

for (const required of [
  "SAFE_SERVICE_URLS",
  "multisig-transactions",
  "safeTxHash",
  "SAFE_API_KEY",
  "authorization",
  "Safe Transaction Service no encontro la transaccion",
]) {
  assert.ok(
    safeTransactionSource.includes(required),
    `Safe transaction lookup API is missing: ${required}`,
  );
}

assert.equal(
  vercelConfig.rewrites.some((rewrite) => rewrite.source.includes("?!api/")),
  true,
  "Vercel SPA rewrite must not intercept /api routes",
);

assert.equal(appSource.includes("Solo detecci"), false);
assert.equal(appSource.includes("solo detecci"), false);

for (const required of [
  "Tokens disponibles para mover",
  "Mover ahora",
  "Mover con Safe",
  "Desplegar y mover",
  "Validar Safe",
  "selectedAssetCounterfactualSafeReady",
  "deployment?.ready",
  "Validar Safe antes de enviar",
  "Importar llave para mover",
  "Safe Rescue Center",
  "buildSafeRescueSnapshot",
  "buildSafeUiTransactionDraft",
  "counterfactual-safe-deploy-and-execute",
  "safeAppUrl",
  "safe-rescue",
  "Copiar dossier Safe",
  "Copiar tx Safe UI",
  "Proponer en Safe",
  "Confirmar Safe Tx",
  "Consultar Safe Tx",
  "Ejecutar Safe Tx",
  "safeTxHashInput",
  "confirmSelectedSafeTransaction",
  "executeSelectedSafeTransaction",
  "inspectSelectedSafeTransaction",
  "Safe Tx ejecutada",
  "Safe Tx lista para ejecutar",
  "Confirmacion Safe enviada",
  "proposeSelectedSafeTransaction",
  "activeSafeSignerAddress",
  "privateKeyRef.current = privateKey",
  "setConnectedExternalAddress(address)",
  "Llave owner Safe",
  "Transaccion propuesta en Safe",
  "Borrador de transaccion Safe UI copiado",
  "Dossier Safe de movimiento copiado",
  "Prediccion destino",
  "Abrir Safe UI",
  "openSendFormForAsset",
  "asset__move",
]) {
  assert.ok(appSource.includes(required), `Token movement UI is missing: ${required}`);
}

console.log("recovery-routes ok");
