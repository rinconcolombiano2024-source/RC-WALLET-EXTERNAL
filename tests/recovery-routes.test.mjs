import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const blockchainSource = readFileSync(
  new URL("../src/blockchain.js", import.meta.url),
  "utf8",
);
const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const stylesSource = readFileSync(
  new URL("../src/styles.css", import.meta.url),
  "utf8",
);
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
const safeRelaySource = readFileSync(
  new URL("../api/safe-relay.js", import.meta.url),
  "utf8",
);
const envExampleSource = readFileSync(
  new URL("../.env.example", import.meta.url),
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
  "sendWithSafeOwnerSignatureAndExecutor",
  "sendWithPrivateKeyOwnerAndGasPayer",
  "safe-owner-private-key-gas-payer",
  "safe-mirror-deploy-private-key-gas-payer",
  "contract.transfer(",
  "signer.sendTransaction(",
  "getSafeFactoryDeploymentCall",
  "validateManualSafeMirrorDeployment",
  "forgeSafeMirrorDeployment",
  "computeSafeProxyAddress",
  "SAFE_FALLBACK_HANDLER_STORAGE_SLOT",
  "safe-forge-auto-reconstruction",
  "manual-safe-rescue-lab",
  "factory.createProxyWithNonce(",
  "factory.createProxyWithNonceL2",
  "factory.createProxyWithCallback",
  "createChainSpecificProxyWithNonceL2",
  "deployment.canReplayCrossChain",
  "deployment.ready",
  "deployment.targetPredictionMatches",
  "isChainSpecificSafeCreationMethod",
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
  "executeSafeTransactionFromServiceWithExternalWallet",
  "relaySafeTransactionFromService",
  "inspectSafeTransactionStatus",
  "buildSafeExecutionSignatures",
  "safe-service-execute-private-key",
  "safe-service-execute-external-gas-payer",
  "safe-service-gelato-relay",
  "payerLabel: \"pagador de gas\"",
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

for (const required of [
  "GELATO_RELAY_API_KEY",
  "GELATO_SPONSORED_CALL_URL",
  "safe-service-gelato-relay",
  "execTransaction",
  "buildSafeExecutionSignatures",
  "confirmationsRequired",
  "Safe Tx sin firmas suficientes",
  "Gelato Relay rechazo la ejecucion patrocinada",
  "relay.gelato.digital/relays/v2/sponsored-call",
]) {
  assert.ok(
    safeRelaySource.includes(required),
    `Safe relay API is missing: ${required}`,
  );
}

assert.ok(
  envExampleSource.includes("GELATO_RELAY_API_KEY="),
  "env.example must document GELATO_RELAY_API_KEY",
);

assert.equal(
  vercelConfig.rewrites.some((rewrite) => rewrite.source.includes("?!api/")),
  true,
  "Vercel SPA rewrite must not intercept /api routes",
);

assert.equal(appSource.includes("Solo detecci"), false);
assert.equal(appSource.includes("solo detecci"), false);
assert.equal(appSource.includes("Publicidad local"), false);
assert.equal(appSource.includes("Comprar"), false);
assert.equal(appSource.includes("Vender"), false);
assert.equal(appSource.includes("solo lectura"), false);

for (const required of [
  "app-view--${tabId}",
  "RescueMissionPanel",
  "Mueve fondos de tu direccion Worldcoin en Ethereum y otras redes",
  "Mover fondos Worldcoin en Ethereum y redes externas",
  "getExternalExecutionRoute",
  "Ruta de ejecucion externa",
  "Enviar directo en",
  "Ejecutar Safe en",
  "Desplegar Safe y mover en",
  "Sin autoridad para mover",
  "externalExecutionRoute.canExecute",
  "Safe manual deploy",
  "Validar ruta Safe manual",
  "Safe Forge auto",
  "Buscar despliegue Safe",
  "runSafeForgeSearch",
  "Pagador de gas externo",
  "connectGasPayerWallet",
  "disconnectGasPayerWallet",
  "gasPayerConnectionRef",
  "applyManualSafeMirrorDeployment",
  "assetRecoveryPriority",
  "sortAssetsForRecovery",
  "asset.chainId === 1",
  "Direccion Worldcoin con fondos",
  "Firmante World App / Safe",
  "RC Wallet detecta fondos en Ethereum, Base, Optimism, BNB",
  "Descargar app",
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
  "Metodo",
  "buildSafeRescueSnapshot",
  "buildSafeUiTransactionDraft",
  "counterfactual-safe-deploy-and-execute",
  "safeAppUrl",
  "safe-rescue",
  "Copiar dossier Safe",
  "Desplegar Safe y mover",
  "Desplegar Safe pendiente",
  "openCounterfactualSafeDeployFlow",
  "onDeploySafeMirror",
  "Copiar tx Safe UI",
  "Proponer en Safe",
  "Confirmar Safe Tx",
  "Consultar Safe Tx",
  "Ejecutar Safe Tx",
  "safeTxHashInput",
  "confirmSelectedSafeTransaction",
  "executeSelectedSafeTransaction",
  "relaySelectedSafeTransaction",
  "inspectSelectedSafeTransaction",
  "gasPayerConnectionRef.current?.provider",
  "Para ejecutar una Safe Tx conecta un pagador de gas",
  "Ejecutar con Relay",
  "Safe Tx enviada al Relay",
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

for (const required of [
  ".app-view--active::before",
  ".app-view--home.app-view--active",
  ".app-view--tokens.app-view--active",
  ".app-view--recovery.app-view--active",
  ".app-view--tools.app-view--active",
  ".execution-route",
  ".execution-route--ready",
  ".execution-route--blocked",
  ".manual-safe-lab",
  ".safe-forge-lab",
  ".manual-safe-grid",
  ".gas-payer-box",
  "max-height: calc(100dvh",
  "overflow: auto",
  ".button--deploy-safe",
  ".button--deploy-safe-ready",
  "@media (max-width: 899px)",
  "touch-action: pan-y",
  "-webkit-overflow-scrolling: touch",
  "overflow-y: auto",
  "max-height: none",
  "100svh",
]) {
  assert.ok(stylesSource.includes(required), `Professional app-window layout is missing: ${required}`);
}

console.log("recovery-routes ok");
