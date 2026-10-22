/**
 * A wallet address that can VIEW funds is not necessarily a signer that
 * can MOVE funds. In particular, World App's smart-account address may be
 * counterfactually empty on other EVM chains. Do not turn a Safe owner match,
 * ERC-1271 probe, or World App login into an EOA bridge authorization.
 *
 * "ready" is only a local EOA authority classification, NOT a provider quote,
 * gas sufficiency guarantee, recipient approval, or permission to broadcast.
 */
const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

function sameAddress(left, right) {
  return typeof left === "string" && typeof right === "string" &&
    ADDRESS_PATTERN.test(left) && ADDRESS_PATTERN.test(right) &&
    left.toLowerCase() === right.toLowerCase();
}

export function assessBridgeAuthorization({
  holder,
  connectedSigner,
  accountState,
  worldSessionReady = false,
}) {
  if (typeof holder !== "string" || !ADDRESS_PATTERN.test(holder)) {
    return {
      status: "needs-action",
      requirement: "Seleccionar una direccion EVM valida",
      detail: "No hay cuenta origen verificable.",
    };
  }

  // Any smart-account evidence blocks plain EOA bridge execution even when
  // the signer equals the public address or is one of the Safe owners.
  // Safe bridges require a distinct audited Safe execution route.
  if (
    accountState?.safe?.detected === true ||
    accountState?.counterfactualSafe?.detected === true ||
    accountState?.hasCode === true ||
    accountState?.kind === "contract" ||
    accountState?.kind === "safe-smart-account"
  ) {
    return {
      status: "needs-action",
      requirement: "Safe o contrato: ejecucion y firmas verificadas por separado",
      detail: "Una firma EOA o el login de World App no bastan para autorizar un bridge desde esta smart account.",
    };
  }

  // When RPC account inspection failed, never assume "no code".
  if (!accountState || accountState.hasCode !== false) {
    return {
      status: "needs-action",
      requirement: "Verificar que la direccion origen sea una EOA por RPC",
      detail: "No se ha demostrado ausencia de contrato en la red origen.",
    };
  }

  if (sameAddress(holder, connectedSigner)) {
    return {
      status: "ready",
      requirement: "EOA origen: wallet firmante coincide con la direccion verificada",
      detail: "La identidad del firmante coincide. El proveedor aun debe obtener aprobacion, gas y confirmacion del usuario.",
    };
  }

  return {
    status: "needs-action",
    requirement: worldSessionReady
      ? "World App conectada, pero no autoriza automaticamente otros bridges"
      : "Conectar la EOA exacta de la red origen",
    detail: worldSessionReady
      ? "World App autentica la sesion; para el bridge se necesita un metodo de firma admitido por el proveedor."
      : "Ninguna wallet conectada ha demostrado ser la EOA que controla estos fondos.",
  };
}
