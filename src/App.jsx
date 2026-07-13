import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ethers } from "ethers";
import { MiniKit } from "@worldcoin/minikit-js";
import {
  buildSafeUiTransactionDraft,
  executeSafeTransactionFromServiceWithExternalWallet,
  confirmSafeTransactionWithPrivateKeyWallet,
  executeSafeTransactionFromServiceWithPrivateKeyWallet,
  formatBalance,
  inspectSafeTransactionStatus,
  isValidEvmAddressInput,
  normalizePrivateKey,
  normalizeAddress,
  privateKeyToAddress,
  proposeSafeTransactionWithExternalWallet,
  proposeSafeTransactionWithPrivateKeyWallet,
  safeMirrorOwnersInclude,
  safeOwnersInclude,
  scanAllNetworks,
  sendWithExternalWallet,
  sendWithPrivateKeyWallet,
  sendWithPrivateKeyOwnerAndGasPayer,
  forgeSafeMirrorDeployment,
  validateManualSafeMirrorDeployment,
} from "./blockchain.js";
import {
  ADMIN_FEE_WALLET,
  BPS_DENOMINATOR,
  ERC20_ABI,
  NETWORKS,
  PERMIT2_ADDRESS,
  RCPL_POOL_MANAGER_CONTRACT,
  RCPL_STAKING_CONTRACT,
  RCPL_TARGET_PRICE_KEY,
  RECOVERY_FEE_BPS,
  RECOVERY_ROUTE_CATALOG,
  WORLD_CHAIN_ID,
  WORLD_CHAIN_BRIDGES,
} from "./config.js";
import {
  analyzeRecoveryProof,
  createRecoveryProofPackage,
  createRecoveryTypedData,
} from "./recovery-proof.js";
import {
  connectInjectedProvider,
  connectWalletConnectProvider,
  disconnectExternalProvider,
  walletConnectConfigured,
} from "./external-wallet.js";
import {
  formatCompactUsd,
  formatUsd,
  getTradeUrl,
  loadMarket,
} from "./market.js";

const ERC20_INTERFACE = new ethers.Interface(ERC20_ABI);
const PERMIT2_INTERFACE = new ethers.Interface([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function transferFrom(address from, address to, uint160 amount, address token)",
]);
const CUSTOM_TOKENS_KEY = "rc_wallet_custom_tokens_v1";
const TRANSFER_HISTORY_KEY = "rc_wallet_transfer_history_v1";
const DEFAULT_RCPL_TARGET_PRICE = "0.10";
const DEFAULT_RCPL_LIQUIDITY_USD = "1000";
const LOCAL_PRIVATE_KEY_CONNECTION_NAME = "Llave privada local";
const WORLD_MINI_APP_URL =
  import.meta.env.VITE_WORLD_MINI_APP_URL?.trim() ||
  "https://worldcoin.org/mini-app?app_id=app_f4a98191ddc786151b045abc9fcef81b&app_mode=mini-app";
const WORLD_ID_STATEMENT = "Iniciar sesión en RC Wallet Recovery";

const APP_TABS = Object.freeze([
  { id: "home", label: "Inicio", icon: "01" },
  { id: "tools", label: "Direccion", icon: "02" },
  { id: "tokens", label: "Escanear", icon: "03" },
  { id: "recovery", label: "Mover", icon: "04" },
]);

const TOKEN_REFERENCE_LINKS = Object.freeze({
  "RC.PL": [
    {
      label: "Contrato RC.PL",
      url: "https://worldscan.org/token/0xb9DEe79d682f9dA8B95761036f2763cdE25bD3e8",
    },
    {
      label: "Rincón Colombiano",
      url: "https://maps.app.goo.gl/MKzY4KzWp8NrTBjw5?g_st=ac",
    },
  ],
  WLD: [{ label: "World", url: "https://world.org" }],
  USDC: [{ label: "Circle USDC", url: "https://www.circle.com/usdc" }],
  USDT: [{ label: "Tether USDT", url: "https://tether.to" }],
  WBTC: [
    { label: "Bitcoin", url: "https://bitcoin.org" },
    { label: "Wrapped BTC", url: "https://wbtc.network" },
  ],
  WETH: [{ label: "Ethereum", url: "https://ethereum.org" }],
  ETH: [{ label: "Ethereum", url: "https://ethereum.org" }],
  BNB: [{ label: "BNB Chain", url: "https://www.bnbchain.org" }],
  GOLD: [{ label: "Precio oro XAU", url: "https://www.gold.org" }],
});

function readCustomTokens() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CUSTOM_TOKENS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readTransferHistory() {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(TRANSFER_HISTORY_KEY) ?? "[]",
    );
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function compactAddress(address) {
  return address ? `${address.slice(0, 8)}…${address.slice(-6)}` : "";
}

function explorerAddressUrl(network, address) {
  return `${network.explorer}/address/${address}`;
}

function explorerTransactionUrl(network, hash) {
  return `${network.explorer}/tx/${hash}`;
}

function normalizeAmount(value) {
  return String(value ?? "").trim().replace(",", ".");
}

function isValidAmount(value) {
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);
}

function readStoredValue(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function calculateRecoveryFee(amountUnits) {
  return (amountUnits * RECOVERY_FEE_BPS) / BPS_DENOMINATOR;
}

function percentFromBps(bps) {
  return Number(bps) / 100;
}

function miniKitHexQuantity(valueUnits) {
  const value = BigInt(valueUnits);
  if (value < 0n) {
    throw new Error("El valor de la transacción no puede ser negativo");
  }
  return `0x${value.toString(16)}`;
}

function permit2Amount(valueUnits) {
  const value = BigInt(valueUnits);
  const maxUint160 = (1n << 160n) - 1n;
  if (value < 0n || value > maxUint160) {
    throw new Error("El monto excede el límite compatible con Permit2");
  }
  return value;
}

function permit2Expiration() {
  return 0;
}

function miniKitErrorText(errorOrResult) {
  return `${errorOrResult?.code || ""} ${
    errorOrResult?.message || ""
  } ${JSON.stringify(errorOrResult?.data ?? errorOrResult ?? {})}`.toLowerCase();
}

function isWorldContractAuthorizationError(errorOrResult) {
  const text = miniKitErrorText(errorOrResult);
  return (
    text.includes("invalid_contract") ||
    text.includes("disallowed_operation") ||
    text.includes("invalid_operation") ||
    text.includes("disallowed operation")
  );
}

function isMiniKitTimeoutError(errorOrResult) {
  const text = miniKitErrorText(errorOrResult);
  return text.includes("minikit_timeout");
}

function withMiniKitTimeout(command, label, timeoutMs = 45_000) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(
        `${label} no respondió a tiempo. Intenta nuevamente o usa la ruta de respaldo compatible.`,
      );
      error.code = "minikit_timeout";
      reject(error);
    }, timeoutMs);
  });

  return Promise.race([Promise.resolve().then(command), timeoutPromise]).finally(
    () => clearTimeout(timeoutId),
  );
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForMiniKitReady(timeoutMs = 2_500) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (Boolean(MiniKit.isInstalled?.())) {
      return true;
    }
    await wait(100);
  }

  return Boolean(MiniKit.isInstalled?.());
}

function buildFeeBreakdown(asset, amountValue) {
  if (!asset) return null;
  const cleanAmount = normalizeAmount(amountValue);
  if (!isValidAmount(cleanAmount)) return null;

  try {
    const grossUnits = ethers.parseUnits(cleanAmount, asset.decimals);
    if (grossUnits <= 0n) return null;
    const feeUnits = calculateRecoveryFee(grossUnits);
    const recipientUnits = grossUnits - feeUnits;

    return {
      grossUnits,
      feeUnits,
      recipientUnits,
      gross: formatBalance(grossUnits, asset.decimals, 8),
      fee: formatBalance(feeUnits, asset.decimals, 8),
      recipient: formatBalance(recipientUnits, asset.decimals, 8),
    };
  } catch {
    return null;
  }
}

function parsePositiveNumber(value) {
  const number = Number(String(value).replace(",", "."));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function tokenReferenceLinks(asset) {
  if (!asset) return [];
  return (
    TOKEN_REFERENCE_LINKS[asset.symbol] ??
    TOKEN_REFERENCE_LINKS[asset.configuredSymbol] ??
    []
  );
}

function routeStatusLabel(status) {
  if (status === "ready") return "Listo";
  if (status === "needs-action") return "Falta acción";
  if (status === "future") return "Futuro";
  return "Bloqueado";
}

function describeMiniKitSendError(result, asset) {
  const rawCode =
    result?.data?.error_code ||
    result?.data?.errorCode ||
    result?.data?.code ||
    result?.error_code ||
    result?.code ||
    "";
  const message =
    result?.data?.errorMessage ||
    result?.data?.message ||
    result?.message ||
    "";
  const code = String(rawCode).toLowerCase();
  const rawErrorText = `${code} ${message} ${JSON.stringify(
    result?.data ?? {},
  )}`.toLowerCase();

  if (code === "minikit_timeout" || rawErrorText.includes("minikit_timeout")) {
    return message || "World App no respondió a tiempo. Vuelve a intentar dentro de World App o usa la ruta de respaldo compatible si está disponible.";
  }

  if (
    code === "invalid_token" ||
    rawErrorText.includes("invalid_token") ||
    rawErrorText.includes("invalid token")
  ) {
    const tokenAddress = asset?.address || "contrato del token";
    const tokenSymbol = asset?.symbol || "token";
    return `World App bloqueó ${tokenSymbol}: token no permitido para Permit2. Para mover este ERC20, agrega el token en World Developer Portal > Mini App > Permissions > Transactions > Permit2 Tokens. Token: ${tokenAddress}. También confirma que Permit2 esté agregado como Contract Entrypoint: ${PERMIT2_ADDRESS}. Usa el mismo entorno donde estás probando la app: Production o Preview.`;
  }

  if (
    code === "disallowed_operation" ||
    code === "invalid_operation" ||
    code === "disalloved_operation" ||
    rawErrorText.includes("disallowed_operation") ||
    rawErrorText.includes("invalid_operation") ||
    rawErrorText.includes("disalloved_operation") ||
    rawErrorText.includes("disallowed operation")
  ) {
    if (asset?.isNative) {
      return "World App bloqueó esta operación nativa. Revisa en World Developer Portal > Mini App > Permissions que las transacciones estén habilitadas y que la lista blanca de direcciones de pago esté deshabilitada o incluya la wallet destino.";
    }

    const tokenAddress = asset?.address || "contrato del token";
    const tokenSymbol = asset?.symbol || "token";
    return `World App bloqueó la operación de ${tokenSymbol}. Para envíos wallet a wallet, autoriza el contrato del token como Contract Entrypoint en World Developer Portal > Mini App > Permissions > Transactions. Contrato: ${tokenAddress}. Función exacta requerida: transfer(address,uint256). Si usas Permit2 para swaps futuros, Permit2 debe quedar aparte como Contract Entrypoint: ${PERMIT2_ADDRESS}.`;
  }

  if (
    code === "invalid_contract" ||
    rawErrorText.includes("invalid_contract")
  ) {
    if (asset?.isNative) {
      return "World App bloqueó la operación nativa como contrato/operación no permitida. En World Developer Portal > Mini App > Permissions revisa que las transacciones estén habilitadas para World Chain y que la lista blanca de direcciones de pago esté deshabilitada o incluya la wallet destino.";
    }

    const tokenAddress = asset?.address || "contrato del token";
    const tokenSymbol = asset?.symbol || "token";
    return `World App bloqueó ${tokenSymbol}: contrato no permitido. Para enviar este token con RC Wallet debes autorizar el contrato del token como Contract Entrypoint en World Developer Portal > Mini App > Permissions > Transactions. Contrato: ${tokenAddress}. Función exacta requerida: transfer(address,uint256). Guarda cambios, vuelve a abrir RC Wallet dentro de World App y prueba de nuevo.`;
  }

  if (code === "invalid_contract" || code === "disallowed_operation") {
    return "World App bloqueó la operación: revisa en Developer Portal que el token/contrato esté permitido para Mini App > Transactions.";
  }
  if (code === "user_rejected") {
    return "Firma rechazada por el usuario en World App.";
  }
  if (code === "simulation_failed") {
    return "La simulación de World App falló antes de enviar. Revisa balance, contrato permitido y datos de transferencia.";
  }
  if (code === "daily_tx_limit_reached") {
    return "World App indica que se alcanzó el límite diario de transacciones.";
  }
  if (code === "input_error" || code === "validation_error") {
    return message || "World App rechazó los datos de la transacción.";
  }

  return message || "World App no aceptó la operación";
}

function buildWorldTransferTransactions({
  asset,
  destination,
  recipientAmountUnits,
  feeAmountUnits,
  includeFeeTransfer = true,
}) {
  const hasFeeTransfer = includeFeeTransfer && feeAmountUnits > 0n;
  const feeRecipient = hasFeeTransfer ? normalizeAddress(ADMIN_FEE_WALLET) : null;
  const transactions = [];

  if (asset.isNative) {
    transactions.push({
      to: destination,
      value: miniKitHexQuantity(recipientAmountUnits),
      data: "0x",
    });
    if (hasFeeTransfer) {
      transactions.push({
        to: feeRecipient,
        value: miniKitHexQuantity(feeAmountUnits),
        data: "0x",
      });
    }
    return transactions;
  }

  const tokenAddress = normalizeAddress(asset.address);
  transactions.push({
    to: tokenAddress,
    data: ERC20_INTERFACE.encodeFunctionData("transfer", [
      destination,
      recipientAmountUnits,
    ]),
  });
  if (hasFeeTransfer) {
    transactions.push({
      to: tokenAddress,
      data: ERC20_INTERFACE.encodeFunctionData("transfer", [
        feeRecipient,
        feeAmountUnits,
      ]),
    });
  }

  return transactions;
}

function bridgeDestinationOptionsFor(asset) {
  if (!asset) return NETWORKS.filter((network) => !network.testnet);
  return NETWORKS.filter(
    (network) => !network.testnet && network.chainId !== asset.chainId,
  );
}

function defaultBridgeDestinationChainId(asset) {
  if (!asset) return WORLD_CHAIN_ID;
  return asset.chainId === WORLD_CHAIN_ID ? 1 : WORLD_CHAIN_ID;
}

function createBridgePlan({
  asset,
  destinationNetwork,
  targetAddress,
  authenticated,
  authenticatedWorldAddress,
  externalMatches,
  connectedExternalAddress,
  nativeGasAsset,
}) {
  if (!asset || !destinationNetwork) return null;

  const sourceIsWorldChain = asset.chainId === WORLD_CHAIN_ID;
  const hasGas = asset.isNative || Boolean(nativeGasAsset?.rawBalance > 0n);
  const worldSessionReady = Boolean(
    authenticated && safeSameAddress(authenticatedWorldAddress, targetAddress),
  );
  const signerReady =
    externalMatches || (sourceIsWorldChain ? worldSessionReady : false);
  const signerRequirement = externalMatches
    ? "Wallet externa o llave local que controle exactamente la direccion origen"
    : sourceIsWorldChain
      ? "Firma World App / MiniKit en World Chain"
      : "Wallet externa que controle exactamente la misma direccion origen";
  const signerStatus = externalMatches
    ? "Wallet externa o llave local coincidente conectada"
    : sourceIsWorldChain
      ? worldSessionReady
        ? "Sesion World App coincide con la direccion origen"
        : "Falta sesion World App o una firma externa con la direccion origen"
      : connectedExternalAddress
        ? "Wallet externa conectada, pero no coincide con la direccion origen"
        : "Falta conectar wallet externa firmante";

  return {
    format: "rc-wallet-assisted-bridge-plan",
    version: 1,
    generatedAt: new Date().toISOString(),
    status: signerReady && hasGas ? "ready" : "needs-action",
    source: {
      network: asset.networkName,
      chainId: asset.chainId,
      symbol: asset.symbol,
      balance: asset.balance,
      tokenAddress: asset.isNative ? "native" : asset.address,
      holder: targetAddress || null,
    },
    destination: {
      network: destinationNetwork.name,
      chainId: destinationNetwork.chainId,
      receiver: targetAddress || null,
    },
    signer: {
      requirement: signerRequirement,
      status: signerStatus,
      connectedExternalAddress: connectedExternalAddress || null,
      externalSignerMatches: externalMatches,
    },
    gas: {
      requiredOn: asset.networkName,
      nativeSymbol: asset.network.symbol,
      detectedNativeBalance: asset.isNative
        ? asset.balance
        : (nativeGasAsset?.balance ?? "0"),
      enoughGasDetected: hasGas,
    },
    providerRule:
      "RC Wallet abre proveedores de bridge reales. El proveedor valida soporte de red/token y la firma ocurre fuera de RC Wallet.",
    safety:
      "No se puede hacer bridge sin firma válida en la red origen. RC Wallet no crea llaves privadas ni semillas retroactivas.",
    providers: WORLD_CHAIN_BRIDGES,
  };
}

function qrImageUrl(value, size = 260) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(value)}`;
}

function extractEvmAddressFromQr(value) {
  try {
    return normalizeAddress(value);
  } catch {
    throw new Error("El QR no contiene una dirección EVM válida");
  }
}

async function pollWorldUserOperation(userOpHash, asset, attempts = 30) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(
        `https://developer.world.org/api/v2/minikit/userop/${userOpHash}`,
        { cache: "no-store" },
      );
      if (response.ok) {
        const result = await response.json();
        if (result.status === "success" && result.transaction_hash) {
          return result;
        }
        if (result.status === "failed") {
          const failure = new Error(
            describeMiniKitSendError({ data: result }, asset),
          );
          failure.name = "WorldUserOperationFailed";
          throw failure;
        }
      }
    } catch (error) {
      if (error?.name === "WorldUserOperationFailed") {
        throw error;
      }
      if (attempt === attempts - 1) {
        console.warn("[WORLD USEROP POLL]", error);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }

  return {
    status: "pending",
    userOpHash,
    transaction_hash: null,
  };
}

function Status({ status }) {
  if (!status.message) return null;

  return (
    <div className={`status status--${status.type}`} role="status">
      {status.message}
    </div>
  );
}

function getAssetMovementState({
  asset,
  targetAddress,
  connectedExternalAddress,
}) {
  if (!asset) {
    return {
      level: "pending",
      label: "Selecciona activo",
      detail: "Pendiente",
    };
  }

  const sameSigner = Boolean(
    connectedExternalAddress &&
      targetAddress &&
      safeSameAddress(connectedExternalAddress, targetAddress),
  );
  const safeOwner = Boolean(
    connectedExternalAddress &&
      !sameSigner &&
      safeOwnersInclude(asset.accountState, connectedExternalAddress),
  );
  const safeMirrorOwner = Boolean(
    connectedExternalAddress &&
      !sameSigner &&
      safeMirrorOwnersInclude(asset.accountState, connectedExternalAddress),
  );
  const safeMirrorReady = Boolean(
    asset.accountState?.counterfactualSafe?.deployment?.ready,
  );

  if (sameSigner) {
    return {
      level: "ready",
      label: "Mover ahora",
      detail: "Firma exacta",
    };
  }

  if (safeOwner) {
    return {
      level: "ready",
      label: "Mover con Safe",
      detail: "Owner Safe",
    };
  }

  if (safeMirrorOwner && safeMirrorReady) {
    return {
      level: "ready",
      label: "Desplegar y mover",
      detail: "Safe lista",
    };
  }

  if (safeMirrorOwner) {
    return {
      level: "pending",
      label: "Validar Safe",
      detail: "Falta creacion",
    };
  }

  if (asset.chainId === WORLD_CHAIN_ID) {
    return {
      level: "ready",
      label: "Mover con World App",
      detail: "World Chain",
    };
  }

  if (connectedExternalAddress) {
    return {
      level: "blocked",
      label: "Firma no coincide",
      detail: "Importa owner correcto",
    };
  }

  return {
    level: "pending",
    label: "Importar llave para mover",
    detail: "Falta firmante",
  };
}

function RecoveryBadge({ asset, externalMatches, movementState }) {
  if (movementState) {
    const className =
      movementState.level === "ready"
        ? "badge badge--green"
        : movementState.level === "blocked"
          ? "badge badge--red"
          : "badge badge--amber";
    return <span className={className}>{movementState.label}</span>;
  }

  if (externalMatches) {
    return <span className="badge badge--green">Firma externa disponible</span>;
  }
  if (asset.chainId === WORLD_CHAIN_ID) {
    return <span className="badge badge--green">Firma World App</span>;
  }
  if (externalMatches) {
    return <span className="badge badge--green">Firma externa disponible</span>;
  }
  return <span className="badge badge--amber">Importar llave para mover</span>;
}

function getNativeGasAsset(assets, chainId) {
  return (
    assets.find((asset) => asset.chainId === chainId && asset.isNative) ??
    null
  );
}

function assetRecoveryPriority(asset) {
  if (!asset) return 99;
  if (asset.chainId === 1) return 0;
  if (asset.chainId !== WORLD_CHAIN_ID) return 1;
  return 2;
}

function sortAssetsForRecovery(left, right) {
  const priority = assetRecoveryPriority(left) - assetRecoveryPriority(right);
  if (priority !== 0) return priority;
  return `${left.networkName}-${left.symbol}`.localeCompare(
    `${right.networkName}-${right.symbol}`,
  );
}

function selectPrimaryExternalAssetId(assets, currentId) {
  const currentAsset = assets.find((asset) => asset.id === currentId);
  if (currentAsset && currentAsset.chainId !== WORLD_CHAIN_ID) {
    return currentAsset.id;
  }

  return (
    assets.find((asset) => asset.chainId === 1)?.id ??
    assets.find((asset) => asset.chainId !== WORLD_CHAIN_ID)?.id ??
    currentAsset?.id ??
    assets[0]?.id ??
    ""
  );
}

function safeSameAddress(left, right) {
  try {
    return Boolean(left && right && normalizeAddress(left) === normalizeAddress(right));
  } catch {
    return false;
  }
}

function getExternalExecutionRoute({
  asset,
  targetAddress,
  connectedExternalAddress,
  externalConnection,
  authenticated,
  miniKitReady,
  authenticatedWorldAddress,
  nativeGasAsset,
}) {
  if (!asset) {
    return {
      id: "none",
      level: "pending",
      canExecute: false,
      label: "Selecciona un token",
      actionLabel: "Selecciona token",
      signerLabel: "Pendiente",
      gasLabel: "Pendiente",
      reason: "Selecciona un activo con balance para calcular la ruta real.",
    };
  }

  const isWorldChain = asset.chainId === WORLD_CHAIN_ID;
  const exactSigner = safeSameAddress(targetAddress, connectedExternalAddress);
  const hasExternalSigner = Boolean(externalConnection || connectedExternalAddress);
  const hasNativeGas = asset.isNative || Boolean(nativeGasAsset?.rawBalance > 0n);
  const worldSessionReady = Boolean(
    isWorldChain &&
      authenticated &&
      miniKitReady &&
      safeSameAddress(authenticatedWorldAddress, targetAddress),
  );
  const safe = asset.accountState?.safe;
  const safeDetected = Boolean(safe?.detected);
  const safeThreshold = Number(safe?.threshold ?? 0);
  const safeOwner = Boolean(
    connectedExternalAddress &&
      !exactSigner &&
      safeOwnersInclude(asset.accountState, connectedExternalAddress),
  );
  const mirror = asset.accountState?.counterfactualSafe;
  const mirrorDetected = Boolean(mirror?.detected);
  const mirrorThreshold = Number(mirror?.threshold ?? 0);
  const mirrorOwner = Boolean(
    connectedExternalAddress &&
      !exactSigner &&
      safeMirrorOwnersInclude(asset.accountState, connectedExternalAddress),
  );
  const mirrorReady = Boolean(
    mirrorOwner &&
      mirror?.deployment?.ready &&
      mirror?.deployment?.targetPredictionMatches,
  );
  const networkName = asset.networkName || asset.network?.name || "esta red";
  const gasSymbol = asset.network?.symbol || "gas";

  if (exactSigner) {
    if (!hasExternalSigner) {
      return {
        id: "direct-eoa-missing-signer",
        level: "pending",
        canExecute: false,
        label: "Llave exacta pendiente",
        actionLabel: "Importar llave exacta",
        signerLabel: "Falta firmante local o wallet externa",
        gasLabel: hasNativeGas ? "Gas detectado" : `Falta ${gasSymbol}`,
        reason:
          "La direccion coincide, pero RC Wallet necesita una conexion activa para firmar.",
      };
    }

    if (!hasNativeGas) {
      return {
        id: "direct-eoa-missing-gas",
        level: "warning",
        canExecute: false,
        label: `Falta gas en ${networkName}`,
        actionLabel: `Agrega ${gasSymbol} para gas`,
        signerLabel: "Llave exacta conectada",
        gasLabel: `Falta ${gasSymbol}`,
        reason: `La llave abre la direccion con fondos, pero para mover ${asset.symbol} necesitas ${gasSymbol} en esa misma direccion.`,
      };
    }

    return {
      id: "direct-eoa",
      level: "ready",
      canExecute: true,
      label: `Envio directo en ${networkName}`,
      actionLabel: `Enviar directo en ${networkName}`,
      signerLabel: "Llave exacta / wallet externa",
      gasLabel: asset.isNative ? "Reserva gas del balance" : "Gas detectado",
      reason:
        "La firma conectada coincide exactamente con la direccion donde estan los fondos.",
    };
  }

  if (isWorldChain && worldSessionReady) {
    return {
      id: "world-minikit",
      level: "ready",
      canExecute: true,
      label: "Firma World App disponible",
      actionLabel: "Firmar con World App",
      signerLabel: "MiniKit / World App",
      gasLabel: "World App calcula la operacion",
      reason:
        "La sesion de World App coincide con la direccion origen en World Chain.",
    };
  }

  if (safeDetected && safeOwner && safeThreshold === 1) {
    return {
      id: "deployed-safe",
      level: "ready",
      canExecute: true,
      label: `Safe lista en ${networkName}`,
      actionLabel: `Ejecutar Safe en ${networkName}`,
      signerLabel: "Owner Safe conectado",
      gasLabel: "Gas lo paga el owner",
      reason:
        "La direccion con fondos es una Safe desplegada y el firmante conectado es owner con umbral 1/1.",
    };
  }

  if (safeDetected && safeOwner) {
    return {
      id: "deployed-safe-needs-signatures",
      level: "warning",
      canExecute: false,
      label: "Safe requiere mas firmas",
      actionLabel: "Reunir firmas Safe",
      signerLabel: "Owner Safe conectado",
      gasLabel: "Gas al ejecutar",
      reason: `Esta Safe requiere ${safeThreshold || "varias"} firmas. Crea la transaccion Safe y reune las confirmaciones antes de ejecutar.`,
    };
  }

  if (mirrorDetected && mirrorOwner && mirrorThreshold === 1 && mirrorReady) {
    return {
      id: "counterfactual-safe",
      level: "ready",
      canExecute: true,
      label: `Safe desplegable en ${networkName}`,
      actionLabel: `Desplegar Safe y mover en ${networkName}`,
      signerLabel: "Owner Safe World App",
      gasLabel: "Gas lo paga el owner",
      reason:
        "La Safe original fue detectada, la llave es owner y la prediccion coincide exactamente con la direccion que tiene los fondos.",
    };
  }

  if (mirrorDetected && mirrorOwner) {
    return {
      id: "counterfactual-safe-not-ready",
      level: "warning",
      canExecute: false,
      label: "Safe espejo no validada",
      actionLabel: "Validar Safe antes de enviar",
      signerLabel: "Owner Safe World App",
      gasLabel: "Pendiente",
      reason:
        "La llave aparece como owner, pero falta factory, singleton, salt o prediccion exacta para desplegar sin riesgo.",
    };
  }

  if (safeDetected || mirrorDetected) {
    return {
      id: "safe-owner-missing",
      level: "blocked",
      canExecute: false,
      label: "Sin owner Safe valido",
      actionLabel: "Sin autoridad para mover",
      signerLabel: connectedExternalAddress
        ? "Firmante no es owner"
        : "Falta owner Safe",
      gasLabel: "No aplica",
      reason:
        "La direccion parece Safe o smart account. Solo un owner valido o las firmas requeridas pueden mover estos fondos.",
    };
  }

  if (connectedExternalAddress) {
    return {
      id: "wrong-signer",
      level: "blocked",
      canExecute: false,
      label: "La llave no corresponde",
      actionLabel: "Sin autoridad para mover",
      signerLabel: "Firmante diferente",
      gasLabel: "No aplica",
      reason:
        "La llave conectada no abre la direccion con fondos y tampoco fue detectada como owner Safe.",
    };
  }

  return {
    id: "missing-signer",
    level: "pending",
    canExecute: false,
    label: "Falta firmante",
    actionLabel: "Importar llave World App",
    signerLabel: "Falta llave o wallet owner",
    gasLabel: "Pendiente",
    reason:
      "Importa la llave exportada por World App o conecta una wallet owner para verificar autoridad real.",
  };
}

function signerControlsSafeTarget({
  assets,
  networkStates,
  targetAddress,
  signerAddress,
}) {
  if (!targetAddress || !signerAddress) return false;

  try {
    const target = normalizeAddress(targetAddress);
    const accountStates = [
      ...Object.values(networkStates ?? {}).map((state) => state.accountState),
      ...assets.map((asset) => asset.accountState),
    ].filter(Boolean);

    return accountStates.some(
      (accountState) =>
        safeSameAddress(accountState.address, target) &&
        safeOwnersInclude(accountState, signerAddress),
    );
  } catch {
    return false;
  }
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    const copied = document.execCommand("copy");
    if (!copied) throw new Error("No se pudo copiar al portapapeles");
  } finally {
    document.body.removeChild(textarea);
  }
}

function accountKindLabel(kind) {
  switch (kind) {
    case "safe-smart-account":
      return "Safe / smart account";
    case "contract":
      return "Contrato / smart account";
    case "no-contract":
      return "Sin contrato en esta red";
    default:
      return "No analizado";
  }
}

function describeAccountRoute(accountState) {
  if (!accountState) {
    return "Pendiente de escaneo";
  }

  if (accountState.safe?.detected) {
    return `Safe ${accountState.safe.version || ""} · ${accountState.safe.threshold}/${accountState.safe.owners.length} firmas`;
  }

  if (accountState.counterfactualSafe?.detected) {
    return `Safe en ${accountState.counterfactualSafe.sourceNetworkName} · falta despliegue en esta red`;
  }

  if (accountState.hasCode) {
    if (accountState.erc1271?.supported) {
      return "Contrato con respuesta EIP-1271";
    }
    if (accountState.erc4337?.entryPointAvailable) {
      return "Contrato con red compatible ERC-4337";
    }
    return "Contrato sin interfaz de firma confirmada";
  }

  return "Firma externa exacta requerida";
}

function serializeNetworkDiagnostics(diagnostics) {
  return diagnostics.map((diagnostic) => ({
    network: diagnostic.network.name,
    chainId: diagnostic.network.chainId,
    status: diagnostic.state?.status ?? "pending",
    account: diagnostic.accountLabel,
    route: diagnostic.routeSummary,
    hasFunds: diagnostic.hasFunds,
    assetCount: diagnostic.assetCount,
    hasGas: diagnostic.hasGas,
    safeDetected: diagnostic.safeDetected,
    counterfactualSafeDetected: diagnostic.counterfactualSafeDetected,
    erc1271Supported: diagnostic.erc1271Supported,
    entryPointAvailable: diagnostic.entryPointAvailable,
    nativeGas: diagnostic.accountState?.nativeGas ?? null,
    safe: diagnostic.accountState?.safe ?? null,
    counterfactualSafe: diagnostic.accountState?.counterfactualSafe ?? null,
    erc1271: diagnostic.accountState?.erc1271 ?? null,
    erc4337: diagnostic.accountState?.erc4337 ?? null,
    assets: diagnostic.assets.map((asset) => ({
      symbol: asset.symbol,
      balance: asset.balance,
      contract: asset.address,
      native: asset.isNative,
    })),
  }));
}

function createRecoveryDiagnosis({
  asset,
  authenticated,
  miniKitReady,
  authenticatedWorldAddress,
  targetAddress,
  externalMatches,
  connectedExternalAddress,
  nativeGasAsset,
}) {
  if (!asset) return null;

  const accountState = asset.accountState;
  const worldSessionMatches = safeSameAddress(
    authenticatedWorldAddress,
    targetAddress,
  );
  const hasNativeGas =
    asset.isNative || Boolean(nativeGasAsset?.rawBalance > 0n);
  const accountIsContract = Boolean(accountState?.hasCode);
  const safeDetected = Boolean(accountState?.safe?.detected);
  const safeOwnerConnected = Boolean(
    safeDetected &&
      connectedExternalAddress &&
      !safeSameAddress(connectedExternalAddress, targetAddress) &&
      safeOwnersInclude(accountState, connectedExternalAddress),
  );
  const counterfactualSafeDetected = Boolean(
    accountState?.counterfactualSafe?.detected,
  );
  const counterfactualSafeOwnerConnected = Boolean(
    counterfactualSafeDetected &&
      connectedExternalAddress &&
      !safeSameAddress(connectedExternalAddress, targetAddress) &&
      safeMirrorOwnersInclude(accountState, connectedExternalAddress),
  );
  const safeThreshold = Number(accountState?.safe?.threshold ?? 0);
  const erc1271Supported = Boolean(accountState?.erc1271?.supported);
  const entryPointAvailable = Boolean(
    accountState?.erc4337?.entryPointAvailable,
  );

  if (asset.chainId === WORLD_CHAIN_ID) {
    if (externalMatches) {
      if (safeOwnerConnected) {
        if (safeThreshold !== 1) {
          return {
            level: "partial",
            title: "Safe detectada: faltan firmas",
            route: describeAccountRoute(accountState),
            action:
              "La llave conectada es owner, pero esta Safe exige mas de una firma. Reune las firmas requeridas o usa Safe UI.",
            requirements: [
              `${safeThreshold} firma(s) de owner`,
              "Gas en la cuenta owner que ejecuta",
              "Ejecucion Safe compatible",
            ],
          };
        }

        return {
          level: "recoverable",
          title: "Movible con owner Safe",
          route: "Safe execTransaction",
          action:
            "La direccion activa es una Safe y la wallet conectada aparece como owner. RC Wallet firmara la transaccion Safe y el owner pagara el gas.",
          requirements: [
            "Owner Safe conectado",
            "Gas en la cuenta owner",
            "Umbral Safe 1/1",
          ],
        };
      }

      if (!hasNativeGas) {
        return {
          level: "partial",
          title: "Movible, falta gas",
          route: "Firma externa en World Chain",
          action: `La wallet externa coincide, pero necesitas ${asset.network.symbol} en la misma direccion para pagar gas en World Chain.`,
          requirements: [
            `Enviar ${asset.network.symbol} a la misma direccion`,
            "Mantener MetaMask, WalletConnect o llave local conectada",
          ],
        };
      }

      if (safeDetected) {
        return {
          level: "partial",
          title: "Smart wallet detectada: requiere ejecucion compatible",
          route: describeAccountRoute(accountState),
          action:
            "La direccion en World Chain tiene bytecode. Solo funcionara si el firmante externo puede ejecutar desde esa smart account exacta.",
          requirements: [
            "Proveedor capaz de ejecutar la smart account",
            "Gas disponible en World Chain",
          ],
        };
      }

      return {
        level: accountIsContract ? "partial" : "recoverable",
        title: accountIsContract
          ? "Posible con smart wallet compatible"
          : "Movible con firma externa",
        route: "Llave privada local / MetaMask en World Chain",
        action:
          "Completa destino y monto. RC Wallet External firmara en World Chain con la llave local, MetaMask o WalletConnect desde la misma direccion.",
        requirements: [
          "Misma direccion origen",
          "Gas ETH en World Chain",
          "Confirmacion manual",
        ],
      };
    }

    if (authenticated && miniKitReady && worldSessionMatches) {
      return {
        level: "recoverable",
        title: "✅ Movible con World App",
        route: "MiniKit / World Chain",
        action:
          "Completa la wallet receptora, el monto y firma dentro de World App. Si es ERC20, el token/contrato debe estar permitido en el Developer Portal de World.",
        requirements: [
          "Sesión World App coincidente",
          "MiniKit disponible",
          "Token/contrato permitido en Developer Portal",
        ],
      };
    }

    return {
      level: "partial",
      title: "Movible, falta firma exacta",
      route: "World App o wallet externa exacta",
      action:
        "Conecta MetaMask, WalletConnect o una llave privada local que abra la misma direccion. Tambien puedes abrir la Mini App en World App y autenticar esa misma cuenta.",
      requirements: [
        "Misma direccion origen",
        "Gas ETH en World Chain",
        "Firma externa o sesion World App coincidente",
      ],
    };
  }

  if (externalMatches) {
    if (safeOwnerConnected) {
      if (safeThreshold !== 1) {
        return {
          level: "partial",
          title: "Safe detectada: faltan firmas",
          route: describeAccountRoute(accountState),
          action:
            "La wallet conectada es owner, pero esta Safe exige mas de una firma. Reune las firmas requeridas o usa Safe UI.",
          requirements: [
            `${safeThreshold} firma(s) de owner`,
            "Gas en la cuenta owner que ejecuta",
            "Ejecucion Safe compatible",
          ],
        };
      }

      return {
        level: "recoverable",
        title: "Movible con owner Safe",
        route: "Safe execTransaction",
        action:
          "La direccion activa es una Safe y la wallet conectada aparece como owner. RC Wallet firmara la transaccion Safe y el owner pagara el gas.",
        requirements: [
          "Owner Safe conectado",
          "Gas en la cuenta owner",
          "Umbral Safe 1/1",
        ],
      };
    }

    if (!hasNativeGas) {
      return {
        level: "partial",
        title: "⚠️ Movible, falta gas",
        route: "Wallet externa + gas de red",
        action: `La wallet conectada coincide, pero para mover ${asset.symbol} en ${asset.networkName} necesitas un poco de ${asset.network.symbol} en esa misma dirección para pagar gas.`,
        requirements: [
          `Enviar ${asset.network.symbol} a la misma dirección`,
          "Mantener la wallet externa conectada",
        ],
      };
    }

    if (safeDetected) {
      return {
        level: "partial",
        title: "⚠️ Safe detectada: requiere owners",
        route: describeAccountRoute(accountState),
        action:
          "La dirección parece una Safe. La recuperación es posible solo si la wallet conectada puede ejecutar desde esa Safe o si se reúnen las firmas requeridas de owners/módulos.",
        requirements: [
          `${accountState.safe.threshold} firma(s) de owner`,
          "Safe desplegada o desplegable en esta red",
          "Gas disponible para ejecutar",
        ],
      };
    }

    return {
      level: accountIsContract ? "partial" : "recoverable",
      title: accountIsContract
        ? "⚠️ Posible con smart wallet compatible"
        : "✅ Movible con wallet externa",
      route: accountIsContract
        ? describeAccountRoute(accountState)
        : "Llave privada local / wallet externa",
      action: accountIsContract
        ? "La dirección tiene bytecode. Solo funcionará si la wallet externa puede ejecutar transacciones desde esa smart account exacta."
        : "Completa destinatario y monto. RC Wallet External firmara con la llave local o abrira la wallet externa conectada.",
      requirements: accountIsContract
        ? [
            "Proveedor capaz de ejecutar la smart account",
            erc1271Supported ? "EIP-1271 responde" : "Firma de contrato no confirmada",
            entryPointAvailable ? "EntryPoint detectado" : "Bundler/EntryPoint no confirmado",
          ]
        : ["Llave local o wallet misma direccion", "Gas de red", "Confirmacion manual"],
    };
  }

  if (counterfactualSafeOwnerConnected) {
    return {
      level: "partial",
      title: "Safe World App detectada: falta despliegue",
      route: "Safe contrafactual / despliegue deterministico",
      action:
        `La llave conectada aparece como owner de la Safe en ${accountState.counterfactualSafe.sourceNetworkName}, pero en ${asset.networkName} la direccion aun no tiene contrato desplegado. Primero hay que desplegar la misma Safe con factory, singleton, initializer y salt originales; despues se podra ejecutar el movimiento desde Safe.`,
      requirements: [
        "Factory, singleton, initializer y salt originales",
        `Gas en ${asset.networkName} para desplegar y ejecutar`,
        "Owner Safe con firma valida",
      ],
    };
  }

  if (connectedExternalAddress) {
    return {
      level: "blocked",
      title: "❌ La wallet conectada no controla esos fondos",
      route: "Firma externa no coincidente",
      action:
        "Conecta una wallet u owner Safe que firme exactamente la dirección donde están los fondos.",
      requirements: [
        "La dirección firmante debe ser idéntica",
        "Owner Safe confirmado cuando la cuenta sea smart wallet",
      ],
    };
  }

  return {
    level: accountIsContract ? "partial" : "blocked",
    title: safeDetected
      ? "⚠️ Safe detectada, faltan firmas"
      : accountIsContract
      ? "⚠️ Requiere propietarios o módulos de smart account"
      : "❌ Falta firmante externo exacto",
    route: accountIsContract
      ? describeAccountRoute(accountState)
      : "Wallet externa con la misma dirección",
    action: safeDetected
      ? "RC Wallet detectó estructura Safe. Para mover fondos se necesitan owners, threshold y ejecución Safe real. Si no están disponibles, la app documenta la ruta pero no puede firmar por ti."
      : accountIsContract
      ? "Genera la prueba RC Link y revisa EIP-1271 / ERC-4337 / Safe. Si no existe un módulo, owner o bundler autorizado en esa red, la app solo puede documentar el caso."
      : "Importa la llave privada local o conecta un firmante externo con la direccion exacta y con capacidad de firmar.",
    requirements: accountIsContract
      ? [
          safeDetected ? "Firmas de owners Safe" : "Autoridad de smart account",
          erc1271Supported ? "EIP-1271 disponible" : "EIP-1271 no confirmado",
          entryPointAvailable ? "EntryPoint detectado" : "ERC-4337 no confirmado",
        ]
      : ["Llave privada local o signer real", "Misma direccion origen"],
  };
}

function safeAppChainPrefix(chainId) {
  const prefixes = {
    1: "eth",
    10: "oeth",
    56: "bnb",
    480: "wc",
    8453: "base",
  };
  return prefixes[chainId] ?? null;
}

function safeAppUrl(network, address) {
  const prefix = safeAppChainPrefix(network?.chainId);
  return prefix && address
    ? `https://app.safe.global/home?safe=${prefix}:${address}`
    : "https://app.safe.global/";
}

function displaySafeValue(value) {
  if (value === null || value === undefined || value === "") return "No disponible";
  const text = String(value);
  if (/^0x[a-fA-F0-9]{40}$/.test(text)) return compactAddress(text);
  if (text.length > 28) return `${text.slice(0, 14)}...${text.slice(-10)}`;
  return text;
}

function getSafeRescueState({ asset, targetAddress, connectedExternalAddress }) {
  const accountState = asset?.accountState ?? null;
  const safe = accountState?.safe ?? null;
  const mirror = accountState?.counterfactualSafe ?? null;
  const deployment = mirror?.deployment ?? null;
  const signerIsOrigin = safeSameAddress(connectedExternalAddress, targetAddress);
  const signerIsSafeOwner = safeOwnersInclude(accountState, connectedExternalAddress);
  const signerIsMirrorOwner = safeMirrorOwnersInclude(
    accountState,
    connectedExternalAddress,
  );
  const safeReady = Boolean(
    deployment?.ready && deployment?.targetPredictionMatches,
  );

  if (signerIsOrigin) {
    return {
      level: "ready",
      label: "Llave exacta",
      title: "Mover como wallet EVM directa",
      action:
        "La firma conectada coincide con la direccion que contiene los fondos. RC Wallet puede enviar ETH o ERC20 desde esta red.",
    };
  }

  if (safe?.detected && signerIsSafeOwner && Number(safe.threshold) === 1) {
    return {
      level: "ready",
      label: "Safe lista",
      title: "Mover con Safe desplegada",
      action:
        "La direccion con fondos ya es Safe en esta red y la llave conectada es owner. RC Wallet ejecutara execTransaction.",
    };
  }

  if (safe?.detected && signerIsSafeOwner) {
    return {
      level: "pending",
      label: "Faltan firmas",
      title: "Safe desplegada con umbral mayor",
      action:
        "La llave conectada es owner, pero esta Safe exige mas firmas. Reune los owners requeridos o usa Safe UI.",
    };
  }

  if (mirror?.detected && signerIsMirrorOwner && safeReady) {
    return {
      level: "ready",
      label: "Safe espejo lista",
      title: "Desplegar Safe y mover",
      action:
        "La Safe existe en World Chain, la llave conectada es owner y la prediccion en esta red coincide con la direccion con fondos.",
    };
  }

  if (mirror?.detected && signerIsMirrorOwner) {
    return {
      level: "pending",
      label: "Validar Safe",
      title: "Safe espejo detectada",
      action:
        "La llave aparece como owner de la Safe de World Chain, pero aun falta validar la creacion original, factory, singleton, salt o prediccion exacta.",
    };
  }

  if (safe?.detected || mirror?.detected) {
    return {
      level: "blocked",
      label: "Owner no coincide",
      title: "Safe detectada sin owner conectado",
      action:
        "La direccion parece Safe, pero la llave conectada no aparece como owner para ejecutar movimientos.",
    };
  }

  return {
    level: "pending",
    label: "Firma requerida",
    title: "Sin Safe compatible detectada",
    action:
      "Importa la llave exacta o conecta una wallet que pueda firmar desde la direccion con fondos.",
  };
}

function rescueStepClass(status) {
  if (status === "ready") return "rescue-step rescue-step--ready";
  if (status === "blocked") return "rescue-step rescue-step--blocked";
  return "rescue-step";
}

function RescueMissionPanel({
  targetAddress,
  connectedExternalAddress,
  externalConnectionName,
  externalMatches,
  assets,
  scanning,
  selectedAsset,
  movementState,
  onOpenAddress,
  onScan,
  onOpenTokens,
  onOpenMove,
  onDisconnect,
}) {
  const hasTarget = Boolean(targetAddress);
  const hasAssets = assets.length > 0;
  const signerReady = Boolean(connectedExternalAddress && externalMatches);
  const signerBlocked = Boolean(connectedExternalAddress && !externalMatches);
  const selectedReady = Boolean(selectedAsset && movementState?.level === "ready");
  const signerLabel = connectedExternalAddress
    ? `${externalConnectionName || "Firmante"}: ${compactAddress(connectedExternalAddress)}`
    : "Falta importar llave World App u owner Safe";

  const steps = [
    {
      id: "address",
      number: "01",
      title: "Direccion Worldcoin con fondos",
      status: hasTarget ? "ready" : "pending",
      detail: hasTarget
        ? compactAddress(targetAddress)
        : "Pega la direccion donde estan los fondos.",
      action: "Abrir",
      onClick: onOpenAddress,
    },
    {
      id: "scan",
      number: "02",
      title: "Escaneo EVM real",
      status: hasAssets ? "ready" : scanning ? "pending" : "pending",
      detail: scanning
        ? "Leyendo Ethereum, Base, Optimism, BNB y World Chain."
        : hasAssets
          ? `${assets.length} activo(s) detectado(s).`
          : "Escanea redes para encontrar tokens y tipo de cuenta.",
      action: scanning ? "Escaneando" : hasTarget ? "Escanear" : "Pendiente",
      onClick: hasTarget ? onScan : onOpenAddress,
      disabled: scanning,
    },
    {
      id: "signer",
      number: "03",
      title: "Firmante World App / Safe",
      status: signerReady ? "ready" : signerBlocked ? "blocked" : "pending",
      detail: signerReady
        ? signerLabel
        : signerBlocked
          ? "El firmante no coincide; solo sirve si es owner Safe valido."
          : signerLabel,
      action: connectedExternalAddress ? "Borrar" : "Importar",
      onClick: connectedExternalAddress ? onDisconnect : onOpenAddress,
    },
    {
      id: "move",
      number: "04",
      title: "Mover fondos",
      status: selectedReady ? "ready" : selectedAsset ? "pending" : "pending",
      detail: selectedReady
        ? `${selectedAsset.symbol} listo por ruta ${movementState.detail}.`
        : selectedAsset
          ? `${selectedAsset.symbol}: ${movementState?.label ?? "validar ruta"}.`
          : "Selecciona un token detectado.",
      action: selectedAsset ? "Mover" : "Tokens",
      onClick: selectedAsset ? onOpenMove : onOpenTokens,
    },
  ];

  return (
    <section className="rescue-mission">
      <div className="rescue-mission__head">
        <div>
          <span className="eyebrow">RC Wallet External Rescue</span>
          <h2>Mover fondos Worldcoin en Ethereum y redes externas</h2>
          <p>
            RC Wallet detecta fondos en Ethereum, Base, Optimism, BNB y otras
            redes EVM. Para moverlos necesita llave exacta, owner Safe valido o
            despliegue Safe compatible en la red donde estan los tokens.
          </p>
        </div>
        <span className={signerReady ? "badge badge--green" : "badge badge--amber"}>
          {signerReady ? "Firma valida" : "Firma pendiente"}
        </span>
      </div>

      <dl className="rescue-authority">
        <div>
          <dt>Direccion con fondos</dt>
          <dd>{hasTarget ? compactAddress(targetAddress) : "Pendiente"}</dd>
        </div>
        <div>
          <dt>Firmante real</dt>
          <dd>{connectedExternalAddress ? compactAddress(connectedExternalAddress) : "Pendiente"}</dd>
        </div>
        <div>
          <dt>Regla</dt>
          <dd>{signerReady ? "Autorizado" : "Validar antes de enviar"}</dd>
        </div>
      </dl>

      <div className="rescue-steps">
        {steps.map((step) => (
          <article className={rescueStepClass(step.status)} key={step.id}>
            <span>{step.number}</span>
            <div>
              <strong>{step.title}</strong>
              <p>{step.detail}</p>
            </div>
            <button
              className="button button--secondary"
              type="button"
              onClick={step.onClick}
              disabled={step.disabled}
            >
              {step.action}
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

function buildSafeRescueSnapshot({
  asset,
  targetAddress,
  connectedExternalAddress,
}) {
  if (!asset) return null;

  const accountState = asset.accountState ?? {};
  const safe = accountState.safe ?? {};
  const mirror = accountState.counterfactualSafe ?? {};
  const deployment = mirror.deployment ?? {};
  const rescueState = getSafeRescueState({
    asset,
    targetAddress,
    connectedExternalAddress,
  });
  const signerIsOrigin = safeSameAddress(connectedExternalAddress, targetAddress);
  const signerIsSafeOwner = safeOwnersInclude(
    accountState,
    connectedExternalAddress,
  );
  const signerIsMirrorOwner = safeMirrorOwnersInclude(
    accountState,
    connectedExternalAddress,
  );
  const deployedSafeReady = Boolean(
    safe.detected && signerIsSafeOwner && Number(safe.threshold) === 1,
  );
  const mirrorReady = Boolean(
    mirror.detected &&
      signerIsMirrorOwner &&
      deployment.ready &&
      deployment.targetPredictionMatches,
  );

  return {
    generatedAt: new Date().toISOString(),
    routeLabel: rescueState.label,
    routeTitle: rescueState.title,
    routeAction: rescueState.action,
    executionRoute: signerIsOrigin
      ? "direct-eoa"
      : deployedSafeReady
        ? "deployed-safe-exec-transaction"
        : mirrorReady
          ? "counterfactual-safe-deploy-and-execute"
          : "not-ready",
    canMoveNow: Boolean(signerIsOrigin || deployedSafeReady || mirrorReady),
    canMoveWithPrivateKey: signerIsOrigin,
    canMoveWithDeployedSafe: deployedSafeReady,
    canDeploySafeMirrorAndMove: mirrorReady,
    targetAddress,
    connectedExternalAddress: connectedExternalAddress || null,
    network: {
      name: asset.networkName,
      chainId: asset.chainId,
      explorer: explorerAddressUrl(asset.network, targetAddress),
      safeUi: safeAppUrl(asset.network, targetAddress),
    },
    asset: {
      symbol: asset.symbol,
      balance: asset.balance,
      displayBalance: asset.displayBalance,
      tokenAddress: asset.address,
      isNative: asset.isNative,
    },
    safe: {
      detected: Boolean(safe.detected),
      version: safe.version ?? null,
      owners: safe.owners ?? [],
      threshold: safe.threshold ?? null,
      modules: safe.modules ?? [],
      signerIsOwner: signerIsSafeOwner,
    },
    counterfactualSafe: {
      detected: Boolean(mirror.detected),
      sourceNetworkName: mirror.sourceNetworkName ?? null,
      owners: mirror.owners ?? [],
      threshold: mirror.threshold ?? null,
      signerIsOwner: signerIsMirrorOwner,
      deployment: {
        ready: Boolean(deployment.ready),
        canReplayCrossChain: Boolean(deployment.canReplayCrossChain),
        targetPredictionMatches: Boolean(deployment.targetPredictionMatches),
        targetFactoryHasCode: Boolean(deployment.targetFactoryHasCode),
        targetSingletonHasCode: Boolean(deployment.targetSingletonHasCode),
        factory: deployment.factory ?? null,
        singleton: deployment.singleton ?? null,
        saltNonce: deployment.saltNonce ?? null,
        targetPrediction: deployment.targetPrediction ?? null,
        sourceUrl: deployment.sourceUrl ?? null,
      },
    },
    requiredNextAction:
      signerIsOrigin || deployedSafeReady || mirrorReady
        ? "Completar destinatario, monto, gas y firmar el movimiento."
        : safe.detected || mirror.detected
          ? "Conectar un owner Safe valido, reunir firmas si el umbral es mayor a 1 o validar despliegue deterministico."
          : "Importar la llave exacta o conectar una wallet que firme desde la direccion con fondos.",
  };
}

function SafeRescuePanel({
  asset,
  targetAddress,
  connectedExternalAddress,
  onDeploySafeMirror,
  onCopyPlan,
  onCopySafeUiDraft,
  onConfirmSafeTx,
  onExecuteSafeTx,
  onInspectSafeTx,
  onProposeSafeTx,
  safeTxHashInput,
  onSafeTxHashChange,
}) {
  if (!asset) return null;

  const accountState = asset.accountState ?? {};
  const safe = accountState.safe ?? {};
  const mirror = accountState.counterfactualSafe ?? {};
  const deployment = mirror.deployment ?? {};
  const rescueState = getSafeRescueState({
    asset,
    targetAddress,
    connectedExternalAddress,
  });
  const owners = safe.detected ? safe.owners : mirror.owners;
  const threshold = safe.detected ? safe.threshold : mirror.threshold;
  const safeDetected = Boolean(safe.detected || mirror.detected);
  const signerIsOrigin = safeSameAddress(connectedExternalAddress, targetAddress);
  const signerIsOwner =
    safeOwnersInclude(accountState, connectedExternalAddress) ||
    safeMirrorOwnersInclude(accountState, connectedExternalAddress);
  const safeMirrorDetected = Boolean(mirror.detected);
  const safeMirrorReady = Boolean(
    safeMirrorDetected &&
      signerIsOwner &&
      deployment.ready &&
      deployment.targetPredictionMatches,
  );

  return (
    <section className={`safe-rescue safe-rescue--${rescueState.level}`}>
      <div className="safe-rescue__head">
        <div>
          <span className="eyebrow">Safe Rescue Center</span>
          <h3>{rescueState.title}</h3>
          <p>{rescueState.action}</p>
        </div>
        <span
          className={`badge ${
            rescueState.level === "ready"
              ? "badge--green"
              : rescueState.level === "blocked"
                ? "badge--red"
                : "badge--amber"
          }`}
        >
          {rescueState.label}
        </span>
      </div>

      <dl className="safe-rescue__grid">
        <div>
          <dt>Direccion con fondos</dt>
          <dd>{compactAddress(targetAddress)}</dd>
        </div>
        <div>
          <dt>Red objetivo</dt>
          <dd>{asset.networkName}</dd>
        </div>
        <div>
          <dt>Firmante conectado</dt>
          <dd>{connectedExternalAddress ? compactAddress(connectedExternalAddress) : "Falta firmante"}</dd>
        </div>
        <div>
          <dt>Control</dt>
          <dd>{signerIsOrigin ? "Llave exacta" : signerIsOwner ? "Owner Safe" : "No confirmado"}</dd>
        </div>
        <div>
          <dt>Safe</dt>
          <dd>{safe.detected ? `Desplegada ${safe.version || ""}` : mirror.detected ? `En ${mirror.sourceNetworkName}` : "No detectada"}</dd>
        </div>
        <div>
          <dt>Umbral</dt>
          <dd>{threshold ? `${threshold}/${owners?.length ?? 0}` : "No aplica"}</dd>
        </div>
        <div>
          <dt>Prediccion</dt>
          <dd>{deployment.targetPredictionMatches ? "Coincide" : deployment.targetPrediction ? "No coincide" : "No disponible"}</dd>
        </div>
        <div>
          <dt>Despliegue</dt>
          <dd>{deployment.ready ? "Listo" : safe.detected ? "Ya existe" : "Pendiente"}</dd>
        </div>
      </dl>

      {safeDetected && (
        <div className="safe-rescue__details">
          <div>
            <strong>Owners</strong>
            <div className="safe-owner-list">
              {(owners ?? []).length ? (
                owners.map((owner) => (
                  <code
                    className={
                      safeSameAddress(owner, connectedExternalAddress)
                        ? "safe-owner safe-owner--active"
                        : "safe-owner"
                    }
                    key={owner}
                  >
                    {compactAddress(owner)}
                  </code>
                ))
              ) : (
                <span>No disponibles</span>
              )}
            </div>
          </div>

          {(mirror.detected || deployment.targetPrediction) && (
            <div className="safe-deploy-matrix">
              <div>
                <span>Metodo</span>
                <code>{displaySafeValue(deployment.method)}</code>
              </div>
              <div>
                <span>Factory</span>
                <code>{displaySafeValue(deployment.factory)}</code>
              </div>
              <div>
                <span>Singleton</span>
                <code>{displaySafeValue(deployment.singleton)}</code>
              </div>
              <div>
                <span>Salt</span>
                <code>{displaySafeValue(deployment.saltNonce)}</code>
              </div>
              <div>
                <span>Prediccion destino</span>
                <code>{displaySafeValue(deployment.targetPrediction)}</code>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="safe-rescue__actions">
        {safeMirrorDetected && (
          <button
            className={`button button--deploy-safe ${
              safeMirrorReady ? "button--deploy-safe-ready" : ""
            }`}
            type="button"
            onClick={onDeploySafeMirror}
          >
            {safeMirrorReady
              ? "Desplegar Safe y mover"
              : "Desplegar Safe pendiente"}
          </button>
        )}
        <a
          className="button button--secondary"
          href={explorerAddressUrl(asset.network, targetAddress)}
          target="_blank"
          rel="noreferrer"
        >
          Abrir explorer
        </a>
        {safeDetected && (
          <a
            className="button button--secondary"
            href={safeAppUrl(asset.network, targetAddress)}
            target="_blank"
            rel="noreferrer"
          >
            Abrir Safe UI
          </a>
        )}
        <button className="button button--secondary" type="button" onClick={onCopyPlan}>
          Copiar dossier Safe
        </button>
        {safeDetected && (
          <button
            className="button button--secondary"
            type="button"
            onClick={onCopySafeUiDraft}
          >
            Copiar tx Safe UI
          </button>
        )}
        {safe.detected && signerIsOwner && (
          <>
            <button
              className="button button--secondary"
              type="button"
              onClick={onProposeSafeTx}
            >
              Proponer en Safe
            </button>
            <input
              className="safe-rescue__hash-input"
              value={safeTxHashInput}
              onChange={(event) => onSafeTxHashChange(event.target.value)}
              placeholder="safeTxHash 0x..."
            />
            <button
              className="button button--secondary"
              type="button"
              onClick={onConfirmSafeTx}
            >
              Confirmar Safe Tx
            </button>
            <button
              className="button button--secondary"
              type="button"
              onClick={onInspectSafeTx}
            >
              Consultar Safe Tx
            </button>
            <button
              className="button button--primary"
              type="button"
              onClick={onExecuteSafeTx}
            >
              Ejecutar Safe Tx
            </button>
          </>
        )}
      </div>
    </section>
  );
}

function stopQrScannerStream(stream) {
  stream?.getTracks?.().forEach((track) => track.stop());
}

function isStandaloneApp() {
  try {
    return Boolean(
      window.matchMedia?.("(display-mode: standalone)")?.matches ||
        window.navigator?.standalone,
    );
  } catch {
    return false;
  }
}

function getInstallDeviceInfo() {
  const userAgent = navigator.userAgent || "";
  const isIOS = /iPad|iPhone|iPod/.test(userAgent);
  const isAndroid = /Android/i.test(userAgent);
  const isDesktop = !isIOS && !isAndroid;

  if (isIOS) {
    return {
      label: "iPhone / iPad",
      title: "Instalar en iPhone o iPad",
      instructions: [
        "Abre esta pagina en Safari.",
        "Toca Compartir.",
        "Elige Agregar a pantalla de inicio.",
      ],
    };
  }

  if (isAndroid) {
    return {
      label: "Android",
      title: "Instalar en Android",
      instructions: [
        "Toca Instalar ahora si aparece disponible.",
        "Si no aparece, abre el menu del navegador.",
        "Elige Instalar app o Agregar a pantalla principal.",
      ],
    };
  }

  if (isDesktop) {
    return {
      label: "Computador",
      title: "Instalar en computador",
      instructions: [
        "Usa Chrome, Edge o Brave.",
        "Toca Instalar ahora si aparece disponible.",
        "Tambien puedes usar el icono de instalar en la barra del navegador.",
      ],
    };
  }

  return {
    label: "Dispositivo",
    title: "Instalar RC Wallet",
    instructions: [
      "Abre esta pagina en tu navegador principal.",
      "Busca Instalar app o Agregar a pantalla principal.",
      "La app quedara disponible como acceso directo instalado.",
    ],
  };
}

export default function App() {
  const mountedRef = useRef(false);
  const scanIdRef = useRef(0);
  const externalConnectionRef = useRef(null);
  const gasPayerConnectionRef = useRef(null);
  const privateKeyRef = useRef("");
  const installPromptRef = useRef(null);
  const autoLoginAttemptedRef = useRef(false);
  const authenticatedRef = useRef(false);
  const authenticatedWorldAddressRef = useRef("");
  const sendSectionRef = useRef(null);
  const qrVideoRef = useRef(null);
  const qrStreamRef = useRef(null);
  const qrScanActiveRef = useRef(false);

  const [activeTab, setActiveTab] = useState("home");
  const [miniKitReady, setMiniKitReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [authenticatedWorldAddress, setAuthenticatedWorldAddress] =
    useState("");
  const [targetAddress, setTargetAddress] = useState("");
  const [manualAddress, setManualAddress] = useState("");
  const [connectedExternalAddress, setConnectedExternalAddress] =
    useState("");
  const [externalConnectionName, setExternalConnectionName] = useState("");
  const [externalConnecting, setExternalConnecting] = useState(false);
  const [gasPayerAddress, setGasPayerAddress] = useState("");
  const [gasPayerName, setGasPayerName] = useState("");
  const [gasPayerConnecting, setGasPayerConnecting] = useState(false);
  const [privateKeyInput, setPrivateKeyInput] = useState("");
  const [privateKeyTargetAddressInput, setPrivateKeyTargetAddressInput] =
    useState("");
  const [manualSafeMethod, setManualSafeMethod] =
    useState("createProxyWithNonce");
  const [manualSafeFactory, setManualSafeFactory] = useState("");
  const [manualSafeSingleton, setManualSafeSingleton] = useState("");
  const [manualSafeInitializer, setManualSafeInitializer] = useState("");
  const [manualSafeSaltNonce, setManualSafeSaltNonce] = useState("");
  const [manualSafeCallback, setManualSafeCallback] = useState("");
  const [manualSafeStatus, setManualSafeStatus] = useState(null);
  const [manualSafeBusy, setManualSafeBusy] = useState(false);
  const [safeForgeStart, setSafeForgeStart] = useState("0");
  const [safeForgeEnd, setSafeForgeEnd] = useState("5000");
  const [safeForgeSetupTo, setSafeForgeSetupTo] = useState("");
  const [safeForgeSetupData, setSafeForgeSetupData] = useState("0x");
  const [safeForgeExtraHandlers, setSafeForgeExtraHandlers] = useState("");
  const [safeForgeStatus, setSafeForgeStatus] = useState(null);
  const [safeForgeBusy, setSafeForgeBusy] = useState(false);
  const [assets, setAssets] = useState([]);
  const [networkStates, setNetworkStates] = useState({});
  const [selectedAssetId, setSelectedAssetId] = useState("");
  const [bridgeDestinationChainId, setBridgeDestinationChainId] =
    useState(WORLD_CHAIN_ID);
  const [tokenScreenOpen, setTokenScreenOpen] = useState(false);
  const [customTokens, setCustomTokens] = useState(readCustomTokens);
  const [customChainId, setCustomChainId] = useState(1);
  const [customTokenAddress, setCustomTokenAddress] = useState("");
  const [search, setSearch] = useState("");
  const [networkFilter, setNetworkFilter] = useState("all");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [safeTxHashInput, setSafeTxHashInput] = useState("");
  const [feeAccepted, setFeeAccepted] = useState(false);
  const [showSendConfirm, setShowSendConfirm] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [sending, setSending] = useState(false);
  const [qrScanning, setQrScanning] = useState(false);
  const [qrScannerError, setQrScannerError] = useState("");
  const [lastTransaction, setLastTransaction] = useState(null);
  const [transferHistory, setTransferHistory] = useState(readTransferHistory);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [showInstallModal, setShowInstallModal] = useState(false);
  const [installPromptAvailable, setInstallPromptAvailable] = useState(false);
  const [appInstalled, setAppInstalled] = useState(isStandaloneApp);
  const [proofChainId, setProofChainId] = useState(10);
  const [proofPackage, setProofPackage] = useState("");
  const [proofInput, setProofInput] = useState("");
  const [proofReport, setProofReport] = useState(null);
  const [proofBusy, setProofBusy] = useState(false);
  const [market, setMarket] = useState(null);
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketError, setMarketError] = useState("");
  const [rcplTargetPrice, setRcplTargetPrice] = useState(() =>
    readStoredValue(RCPL_TARGET_PRICE_KEY, DEFAULT_RCPL_TARGET_PRICE),
  );
  const [rcplLiquidityUsd, setRcplLiquidityUsd] = useState(
    DEFAULT_RCPL_LIQUIDITY_USD,
  );
  const [status, setStatus] = useState({
    type: "info",
    message:
      "Objetivo principal: mover fondos de la direccion Worldcoin en Ethereum y otras redes EVM.",
  });

  const selectedAsset = useMemo(
    () => assets.find((asset) => asset.id === selectedAssetId) ?? null,
    [assets, selectedAssetId],
  );

  const selectedTokenLinks = useMemo(
    () => tokenReferenceLinks(selectedAsset),
    [selectedAsset],
  );

  const filteredAssets = useMemo(() => {
    const query = search.trim().toLowerCase();
    return assets
      .filter((asset) => {
        const matchesNetwork =
          networkFilter === "all" || String(asset.chainId) === networkFilter;
        const matchesQuery =
          !query ||
          asset.symbol.toLowerCase().includes(query) ||
          asset.networkName.toLowerCase().includes(query) ||
          asset.address?.toLowerCase().includes(query);

        return matchesNetwork && matchesQuery;
      })
      .sort(sortAssetsForRecovery);
  }, [assets, networkFilter, search]);

  const externalControlsSafeTarget = useMemo(
    () =>
      signerControlsSafeTarget({
        assets,
        networkStates,
        targetAddress,
        signerAddress: connectedExternalAddress,
      }),
    [assets, connectedExternalAddress, networkStates, targetAddress],
  );

  const selectedAssetUsesSafeOwnerSigner = useMemo(
    () =>
      Boolean(
        selectedAsset &&
          connectedExternalAddress &&
          !safeSameAddress(targetAddress, connectedExternalAddress) &&
          safeOwnersInclude(selectedAsset.accountState, connectedExternalAddress),
      ),
    [connectedExternalAddress, selectedAsset, targetAddress],
  );

  const selectedAssetUsesCounterfactualSafeOwnerSigner = useMemo(
    () =>
      Boolean(
        selectedAsset &&
          connectedExternalAddress &&
          !safeSameAddress(targetAddress, connectedExternalAddress) &&
          safeMirrorOwnersInclude(
            selectedAsset.accountState,
            connectedExternalAddress,
          ),
      ),
    [connectedExternalAddress, selectedAsset, targetAddress],
  );

  const selectedAssetCounterfactualSafeReady = useMemo(
    () =>
      Boolean(
        selectedAssetUsesCounterfactualSafeOwnerSigner &&
          selectedAsset?.accountState?.counterfactualSafe?.deployment?.ready,
      ),
    [selectedAsset, selectedAssetUsesCounterfactualSafeOwnerSigner],
  );

  const externalMatches = useMemo(() => {
    if (!targetAddress || !connectedExternalAddress) return false;
    try {
      return (
        normalizeAddress(targetAddress) ===
          normalizeAddress(connectedExternalAddress) ||
        selectedAssetUsesSafeOwnerSigner ||
        selectedAssetCounterfactualSafeReady
      );
    } catch {
      return false;
    }
  }, [
    connectedExternalAddress,
    selectedAssetCounterfactualSafeReady,
    selectedAssetUsesSafeOwnerSigner,
    targetAddress,
  ]);

  const selectedAssetMovementState = useMemo(
    () =>
      getAssetMovementState({
        asset: selectedAsset,
        targetAddress,
        connectedExternalAddress,
      }),
    [connectedExternalAddress, selectedAsset, targetAddress],
  );

  const selectedAssetSafeUiDraftAvailable = useMemo(
    () =>
      Boolean(
        selectedAsset?.accountState?.safe?.detected ||
          selectedAsset?.accountState?.counterfactualSafe?.detected,
      ),
    [selectedAsset],
  );

  const activeSafeSignerAddress =
    connectedExternalAddress || externalConnectionRef.current?.account || "";

  const selectedAssetSafeProposalAvailable = useMemo(
    () =>
      Boolean(
        selectedAsset?.accountState?.safe?.detected &&
          activeSafeSignerAddress &&
          safeOwnersInclude(selectedAsset.accountState, activeSafeSignerAddress),
      ),
    [activeSafeSignerAddress, selectedAsset],
  );

  const selectedNativeGasAsset = useMemo(
    () =>
      selectedAsset
        ? getNativeGasAsset(assets, selectedAsset.chainId)
        : null,
    [assets, selectedAsset],
  );

  const externalExecutionRoute = useMemo(
    () =>
      getExternalExecutionRoute({
        asset: selectedAsset,
        targetAddress,
        connectedExternalAddress,
        externalConnection: externalConnectionRef.current,
        authenticated,
        miniKitReady,
        authenticatedWorldAddress,
        nativeGasAsset: selectedNativeGasAsset,
      }),
    [
      authenticated,
      authenticatedWorldAddress,
      connectedExternalAddress,
      externalConnectionName,
      miniKitReady,
      selectedAsset,
      selectedNativeGasAsset,
      targetAddress,
    ],
  );

  const bridgeDestinationOptions = useMemo(
    () => bridgeDestinationOptionsFor(selectedAsset),
    [selectedAsset],
  );

  const bridgeDestinationNetwork = useMemo(
    () =>
      bridgeDestinationOptions.find(
        (network) => network.chainId === Number(bridgeDestinationChainId),
      ) ??
      bridgeDestinationOptions[0] ??
      null,
    [bridgeDestinationChainId, bridgeDestinationOptions],
  );

  const selectedBridgePlan = useMemo(
    () =>
      createBridgePlan({
        asset: selectedAsset,
        destinationNetwork: bridgeDestinationNetwork,
        targetAddress,
        authenticated,
        authenticatedWorldAddress,
        externalMatches,
        connectedExternalAddress,
        nativeGasAsset: selectedNativeGasAsset,
      }),
    [
      authenticated,
      authenticatedWorldAddress,
      bridgeDestinationNetwork,
      connectedExternalAddress,
      externalMatches,
      selectedAsset,
      selectedNativeGasAsset,
      targetAddress,
    ],
  );

  const selectedRecoveryDiagnosis = useMemo(
    () =>
      createRecoveryDiagnosis({
        asset: selectedAsset,
        authenticated,
        miniKitReady,
        authenticatedWorldAddress,
        targetAddress,
        externalMatches,
        connectedExternalAddress,
        nativeGasAsset: selectedNativeGasAsset,
      }),
    [
      authenticated,
      authenticatedWorldAddress,
      connectedExternalAddress,
      externalMatches,
      miniKitReady,
      selectedAsset,
      selectedNativeGasAsset,
      targetAddress,
    ],
  );

  const feeBreakdown = useMemo(
    () => buildFeeBreakdown(selectedAsset, amount),
    [amount, selectedAsset],
  );

  const portfolioSummary = useMemo(() => {
    const onlineNetworks = Object.values(networkStates).filter(
      (state) => state.status === "online",
    ).length;
    const worldAssets = assets.filter(
      (asset) => asset.chainId === WORLD_CHAIN_ID,
    ).length;
    const externalAssets = assets.length - worldAssets;

    return {
      onlineNetworks,
      totalAssets: assets.length,
      worldAssets,
      externalAssets,
    };
  }, [assets, networkStates]);

  const homeAssets = useMemo(
    () => [...assets].sort(sortAssetsForRecovery).slice(0, 5),
    [assets],
  );

  const viewClass = useCallback(
    (tabId) =>
      `app-view app-view--${tabId} ${
        activeTab === tabId ? "app-view--active" : ""
      }`,
    [activeTab],
  );

  const estimateAssetValue = useCallback(
    (asset) => {
      if (
        asset.id === selectedAssetId &&
        market?.priceUsd &&
        Number.isFinite(Number(asset.balance))
      ) {
        return formatUsd(Number(asset.balance) * Number(market.priceUsd));
      }

      return "Pendiente de mercado";
    },
    [market, selectedAssetId],
  );

  const rcplAsset = useMemo(
    () => assets.find((asset) => asset.symbol === "RC.PL") ?? null,
    [assets],
  );

  const rcplPlan = useMemo(() => {
    const targetPrice = parsePositiveNumber(rcplTargetPrice);
    const liquidityUsd = parsePositiveNumber(rcplLiquidityUsd);
    const rcplForOneSide =
      targetPrice > 0 && liquidityUsd > 0
        ? liquidityUsd / 2 / targetPrice
        : 0;

    return {
      targetPrice,
      liquidityUsd,
      rcplForOneSide,
      stableSideUsd: liquidityUsd / 2,
    };
  }, [rcplLiquidityUsd, rcplTargetPrice]);

  const recoveryNetworkDiagnostics = useMemo(
    () =>
      NETWORKS.map((network) => {
        const state = networkStates[network.chainId];
        const accountState = state?.accountState ?? null;
        const networkAssets = assets.filter(
          (asset) => asset.chainId === network.chainId,
        );

        return {
          network,
          state,
          accountState,
          assets: networkAssets,
          assetCount: networkAssets.length,
          hasFunds: networkAssets.length > 0,
          accountLabel: accountKindLabel(accountState?.kind ?? state?.accountKind),
          routeSummary: describeAccountRoute(accountState),
          safeDetected: Boolean(accountState?.safe?.detected),
          counterfactualSafeDetected: Boolean(
            accountState?.counterfactualSafe?.detected,
          ),
          erc1271Supported: Boolean(accountState?.erc1271?.supported),
          entryPointAvailable: Boolean(accountState?.erc4337?.entryPointAvailable),
          hasGas: Boolean(accountState?.nativeGas?.hasBalance),
        };
      }),
    [assets, networkStates],
  );

  const maximumRecoveryRoutes = useMemo(() => {
    const externalAssets = assets.filter(
      (asset) => asset.chainId !== WORLD_CHAIN_ID,
    );
    const contractAssets = assets.filter(
      (asset) => Boolean(asset.accountState?.hasCode),
    );
    const safeNetworks = recoveryNetworkDiagnostics.filter(
      (diagnostic) =>
        diagnostic.safeDetected || diagnostic.counterfactualSafeDetected,
    );
    const erc4337Networks = recoveryNetworkDiagnostics.filter(
      (diagnostic) =>
        diagnostic.entryPointAvailable && diagnostic.accountState?.hasCode,
    );
    const hasWorldChainAssets = assets.some(
      (asset) => asset.chainId === WORLD_CHAIN_ID,
    );

    return [
      {
        id: "world-minikit",
        status:
          authenticated && miniKitReady
            ? hasWorldChainAssets
              ? "ready"
              : "needs-action"
            : "needs-action",
        title: "World Chain / MiniKit secundario",
        description:
          "Ruta compatible para mover fondos en World Chain. Requiere sesión World App y allowlist de tokens/contratos en Developer Portal.",
        next:
          authenticated && miniKitReady
            ? "Selecciona un activo de World Chain y firma con World App."
            : "Autentica con World App dentro de la Mini App.",
      },
      {
        id: "external-signer",
        status: externalMatches
          ? "ready"
          : connectedExternalAddress
            ? "blocked"
            : "needs-action",
        title: "Ruta principal: redes externas",
        description:
          "Funcion principal: mover fondos de la direccion Worldcoin en Ethereum, Optimism, Base, BNB y otras redes distintas a World Chain.",
        next: externalMatches
          ? RECOVERY_FEE_BPS > 0n
            ? "Completa destino, monto y acepta comisión para abrir firma externa."
            : "Completa destino y monto para abrir firma externa."
          : connectedExternalAddress
            ? "La wallet conectada no firma desde la dirección de los fondos."
            : "Conecta una wallet externa u owner Safe que pueda firmar.",
      },
      {
        id: "rc-link",
        status: proofReport
          ? proofReport.classification === "deployed-smart-account-signature"
            ? "ready"
            : proofReport.classification === "counterfactual-smart-account"
              ? "needs-action"
              : "blocked"
          : authenticated
            ? "needs-action"
            : "needs-action",
        title: "RC Link / EIP-1271",
        description:
          "Prueba si la firma de World App tiene autoridad verificable en una red externa mediante EIP-712/EIP-1271.",
        next: proofReport
          ? proofReport.nextStep
          : "Firma una prueba dentro de World App y analízala para saber si se puede construir relayer.",
      },
      {
        id: "counterfactual",
        status: safeNetworks.length || contractAssets.length ? "needs-action" : "future",
        title: "Safe / contrato espejo real",
        description:
          "Si la dirección es Safe o smart account, RC Wallet debe verificar owners, threshold, módulos y despliegue determinístico antes de intentar mover.",
        next:
          safeNetworks.length
            ? `Safe detectada en ${safeNetworks.map((item) => item.network.name).join(", ")}. Requiere firmas reales de owners.`
            : "Recolectar datos verificables del despliegue original. No se deben adivinar parámetros.",
      },
      {
        id: "erc-4337",
        status: erc4337Networks.length ? "needs-action" : "future",
        title: "ERC-4337 / UserOperation",
        description:
          "Ruta para smart accounts con EntryPoint, bundler, paymaster opcional y firma válida según el contrato.",
        next: erc4337Networks.length
          ? `EntryPoint detectado en ${erc4337Networks.map((item) => item.network.name).join(", ")}. Falta confirmar bundler, módulo y firma.`
          : "Sin EntryPoint confirmado en las redes escaneadas.",
      },
      {
        id: "recovery-relayer",
        status:
          proofReport?.classification === "deployed-smart-account-signature"
            ? "ready"
            : "needs-action",
        title: "Relayer RC Movement",
        description:
          "Infraestructura que RC Wallet puede crear para ejecutar movimientos de smart accounts cuando la firma EIP-1271 sea válida.",
        next:
          proofReport?.classification === "deployed-smart-account-signature"
            ? "Diseñar simulación, relayer y contrato destino para ejecución segura."
            : "Primero debe existir una prueba RC Link válida en la red objetivo.",
      },
      {
        id: "bridge",
        status: selectedBridgePlan
          ? selectedBridgePlan.status
          : assets.length
            ? "needs-action"
            : "future",
        title: "Bridge asistido",
        description:
          "Ruta para llevar fondos entre World Chain, Ethereum, Optimism, Base y otras redes usando proveedores reales de puente.",
        next: selectedBridgePlan
          ? `Preparar ${selectedBridgePlan.source.symbol} de ${selectedBridgePlan.source.network} a ${bridgeDestinationNetwork?.name ?? "red destino"}. La firma ocurre en el proveedor externo.`
          : "Selecciona un activo detectado para preparar la ruta de puente.",
      },
      {
        id: "support-dossier",
        status: externalAssets.length ? "ready" : "needs-action",
        title: "Expediente para soporte / emisor",
        description:
          "Paquete técnico con red, contrato, balance, dirección, pruebas y estado de firma para World, exchange, emisor o auditoría.",
        next:
          externalAssets.length
            ? "Copiar expediente máximo y adjuntarlo en soporte."
            : "Escanear una dirección con fondos externos.",
      },
      {
        id: "future-vault",
        status: "future",
        title: "RC Rescue Vault futuro",
        description:
          "Contrato preventivo para depósitos futuros con control social/firmas múltiples. Protege nuevos fondos, no mueve fondos ya enviados antes de existir.",
        next:
          "Crear contrato auditado, owners, guardianes, timelock y política de comisiones.",
      },
    ];
  }, [
    assets,
    authenticated,
    bridgeDestinationNetwork,
    connectedExternalAddress,
    externalMatches,
    miniKitReady,
    recoveryNetworkDiagnostics,
    selectedBridgePlan,
    proofReport,
  ]);

  const showStatus = useCallback((message, type = "info") => {
    if (mountedRef.current) setStatus({ message, type });
  }, []);

  const installDeviceInfo = useMemo(getInstallDeviceInfo, []);

  const openInstallDialog = useCallback(() => {
    setShowInstallModal(true);
  }, []);

  const installApp = useCallback(async () => {
    const prompt = installPromptRef.current;
    if (!prompt) {
      showStatus(
        "Si no aparece instalacion directa, usa el menu del navegador y elige Agregar a pantalla principal.",
        "info",
      );
      return;
    }

    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      installPromptRef.current = null;
      setInstallPromptAvailable(false);

      if (choice?.outcome === "accepted") {
        setAppInstalled(true);
        setShowInstallModal(false);
        showStatus("RC Wallet quedo instalada en este dispositivo.", "success");
      } else {
        showStatus("Instalacion cancelada. Puedes intentarlo de nuevo.", "info");
      }
    } catch (error) {
      console.error("[INSTALL APP]", error);
      showStatus(
        "Este navegador no permitio instalacion directa. Usa Agregar a pantalla principal.",
        "warning",
      );
    }
  }, [showStatus]);

  const copyAppLink = useCallback(async () => {
    try {
      await copyTextToClipboard(window.location.href);
      showStatus("Enlace de descarga copiado.", "success");
    } catch (error) {
      showStatus(
        error instanceof Error ? error.message : "No se pudo copiar el enlace",
        "error",
      );
    }
  }, [showStatus]);

  const performWorldLogin = useCallback(
    async (contextLabel = "sesión World ID") => {
      const ready = await waitForMiniKitReady();
      setMiniKitReady(ready);

      if (!ready) {
        throw new Error("Abre RC Wallet dentro de World App para verificar World ID");
      }
      if (typeof MiniKit.walletAuth !== "function") {
        throw new Error("Wallet Auth no está disponible en este entorno de World App");
      }

      showStatus(`Solicitando verificación segura con World ID: ${contextLabel}…`);
      const nonceResponse = await fetch("/api/nonce", {
        credentials: "include",
        cache: "no-store",
      });
      if (!nonceResponse.ok) {
        throw new Error("No se pudo crear el nonce de autenticación");
      }

      const { nonce } = await nonceResponse.json();
      const result = await MiniKit.walletAuth({
        nonce,
        statement: WORLD_ID_STATEMENT,
        expirationTime: new Date(Date.now() + 10 * 60 * 1000),
      });

      if (result?.executedWith === "fallback") {
        throw new Error("La verificación debe ejecutarse dentro de World App");
      }
      if (!result?.data) {
        throw new Error("World App no devolvió una respuesta de Wallet Auth válida");
      }

      const verifyResponse = await fetch("/api/complete-siwe", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload: result.data, nonce }),
      });
      const verification = await verifyResponse.json();

      if (!verifyResponse.ok || !verification.isValid) {
        throw new Error(
          verification.error ?? "La verificación World ID no pudo validarse",
        );
      }

      const address = normalizeAddress(verification.address);
      setTargetAddress(address);
      setManualAddress(address);
      setAuthenticatedWorldAddress(address);
      setAuthenticated(true);
      authenticatedWorldAddressRef.current = address;
      authenticatedRef.current = true;
      return address;
    },
    [showStatus],
  );

  const confirmWorldAction = useCallback(
    async (actionLabel) => {
      try {
        const verifiedAddress = await performWorldLogin(
          `Confirmar ${actionLabel} en RC Wallet`,
        );

        if (
          targetAddress &&
          normalizeAddress(verifiedAddress) !== normalizeAddress(targetAddress)
        ) {
          showStatus(
            "La sesión World ID verificada no coincide con la wallet activa.",
            "error",
          );
          return false;
        }

        showStatus("World ID verificado. Puedes continuar.", "success");
        return true;
      } catch (error) {
        console.error("[WORLD CONFIRMATION]", error);
        showStatus(
          error instanceof Error
            ? error.message
            : "La verificación World ID fue cancelada o falló",
          "error",
        );
        return false;
      }
    },
    [performWorldLogin, showStatus, targetAddress],
  );

  useEffect(() => {
    mountedRef.current = true;
    try {
      const installed = Boolean(MiniKit.isInstalled?.());
      setMiniKitReady(installed);

      if (installed && MiniKit.user?.walletAddress) {
        // Do not auto-load the cached address here. Loading a target address
        // triggers scanning and QR rendering; inside World App that must happen
        // only after an explicit user action to avoid leaving the Mini App.
      }
    } catch (error) {
      console.warn("[MINIKIT INSTALL]", error);
      setMiniKitReady(false);
    }

    return () => {
      mountedRef.current = false;
      scanIdRef.current += 1;
      externalConnectionRef.current?.cleanup?.();
      gasPayerConnectionRef.current?.cleanup?.();
      qrScanActiveRef.current = false;
      stopQrScannerStream(qrStreamRef.current);
    };
  }, []);

  useEffect(() => {
    const handleBeforeInstallPrompt = (event) => {
      event.preventDefault();
      installPromptRef.current = event;
      setInstallPromptAvailable(true);
    };

    const handleAppInstalled = () => {
      installPromptRef.current = null;
      setInstallPromptAvailable(false);
      setAppInstalled(true);
      showStatus("RC Wallet quedo instalada en este dispositivo.", "success");
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, [showStatus]);

  useEffect(() => {
    try {
      localStorage.setItem(CUSTOM_TOKENS_KEY, JSON.stringify(customTokens));
    } catch (error) {
      console.warn("[LOCAL STORAGE] custom tokens", error);
    }
  }, [customTokens]);

  useEffect(() => {
    try {
      localStorage.setItem(
        TRANSFER_HISTORY_KEY,
        JSON.stringify(transferHistory.slice(0, 25)),
      );
    } catch (error) {
      console.warn("[LOCAL STORAGE] transfer history", error);
    }
  }, [transferHistory]);

  useEffect(() => {
    setRecipient("");
    setAmount("");
    setFeeAccepted(false);
    setLastTransaction(null);
    setShowSendConfirm(false);
  }, [selectedAssetId]);

  useEffect(() => {
    if (!selectedAsset) return;
    setBridgeDestinationChainId(defaultBridgeDestinationChainId(selectedAsset));
  }, [selectedAsset]);

  useEffect(() => {
    setFeeAccepted(false);
  }, [amount, recipient]);

  useEffect(() => {
    try {
      localStorage.setItem(RCPL_TARGET_PRICE_KEY, rcplTargetPrice);
    } catch (error) {
      console.warn("[LOCAL STORAGE] RC.PL target price", error);
    }
  }, [rcplTargetPrice]);

  useEffect(() => {
    if (!selectedAsset) {
      setMarket(null);
      setMarketError("");
      setMarketLoading(false);
      return undefined;
    }

    const controller = new AbortController();
    let intervalId;

    const refreshMarket = async () => {
      try {
        if (mountedRef.current) setMarketLoading(true);
        const result = await loadMarket(
          selectedAsset,
          controller.signal,
        );
        if (!controller.signal.aborted && mountedRef.current) {
          setMarket(result);
          setMarketError(
            result ? "" : "No existe un mercado líquido verificable.",
          );
        }
      } catch (error) {
        if (error?.name !== "AbortError" && mountedRef.current) {
          setMarket(null);
          setMarketError(
            error instanceof Error
              ? error.message
              : "No se pudo cargar el mercado",
          );
        }
      } finally {
        if (!controller.signal.aborted && mountedRef.current) {
          setMarketLoading(false);
        }
      }
    };

    void refreshMarket();
    intervalId = window.setInterval(refreshMarket, 30_000);

    return () => {
      controller.abort();
      window.clearInterval(intervalId);
    };
  }, [selectedAsset]);

  const openTrade = useCallback(
    async (action) => {
      const url = getTradeUrl(action, selectedAsset, market);
      if (!url) {
        showStatus(
          "Función preparada: requiere proveedor de liquidez, DEX u onramp compatible para este activo.",
          "warning",
        );
        return;
      }

      showStatus(
        "Abriendo proveedor externo. La compra/venta real se firma fuera de RC Wallet.",
        "info",
      );
      window.open(url, "_blank", "noopener,noreferrer");
    },
    [market, selectedAsset, showStatus],
  );

  const openSendForm = useCallback(() => {
    setTokenScreenOpen(false);
    setActiveTab("recovery");
    window.setTimeout(() => {
      sendSectionRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
      document.getElementById("recipient")?.focus();
    }, 450);
  }, []);

  const openSendFormForAsset = useCallback((assetId) => {
    setSelectedAssetId(assetId);
    setTokenScreenOpen(false);
    setActiveTab("recovery");
    window.setTimeout(() => {
      sendSectionRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
      document.getElementById("recipient")?.focus();
    }, 450);
  }, []);

  const openTokenScreen = useCallback((assetId) => {
    setSelectedAssetId(assetId);
    setTokenScreenOpen(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const loginWithWorldApp = useCallback(async () => {
    try {
      await performWorldLogin("Iniciar sesión con World ID en RC Wallet");
      showStatus("Sesión World ID iniciada correctamente.", "success");
    } catch (error) {
      console.error("[WORLD AUTH]", error);
      showStatus(
        error instanceof Error ? error.message : "Falló la autenticación",
        "error",
      );
    }
  }, [performWorldLogin, showStatus]);

  useEffect(() => {
    if (
      !miniKitReady ||
      authenticated ||
      autoLoginAttemptedRef.current ||
      !MiniKit.user?.walletAddress
    ) {
      return;
    }

    autoLoginAttemptedRef.current = true;
    showStatus(
      "Sesión guardada detectada. Pulsa “Iniciar sesión con World ID” para validarla.",
      "info",
    );
  }, [authenticated, miniKitReady, showStatus]);

  const useManualAddress = useCallback(() => {
    try {
      const address = normalizeAddress(manualAddress);
      setTargetAddress(address);
      setAuthenticatedWorldAddress("");
      setAuthenticated(false);
      authenticatedWorldAddressRef.current = "";
      authenticatedRef.current = false;
      showStatus(
        "Dirección cargada en modo de análisis. Esto no demuestra control sobre sus fondos.",
        "warning",
      );
    } catch (error) {
      showStatus(error.message, "error");
    }
  }, [manualAddress, showStatus]);

  const scan = useCallback(async () => {
    if (!targetAddress || scanning) return;

    const currentScanId = scanIdRef.current + 1;
    scanIdRef.current = currentScanId;
    setScanning(true);
    showStatus("Escaneando redes y contratos configurados…");

    try {
      const result = await scanAllNetworks(targetAddress, customTokens);
      if (!mountedRef.current || scanIdRef.current !== currentScanId) return;

      setAssets(result.assets);
      setNetworkStates(result.networks);
      setSelectedAssetId((current) =>
        selectPrimaryExternalAssetId(result.assets, current),
      );
      const externalAssetCount = result.assets.filter(
        (asset) => asset.chainId !== WORLD_CHAIN_ID,
      ).length;

      showStatus(
        result.assets.length
          ? externalAssetCount
            ? `Escaneo completado: ${externalAssetCount} activo(s) fuera de World Chain listos para revisar.`
            : `Escaneo completado: ${result.assets.length} activo(s) en World Chain. No se detectaron fondos externos configurados.`
          : "No se encontraron balances entre los activos configurados.",
        "success",
      );
    } catch (error) {
      console.error("[SCAN]", error);
      showStatus(
        error instanceof Error ? error.message : "Falló el escaneo",
        "error",
      );
    } finally {
      if (mountedRef.current && scanIdRef.current === currentScanId) {
        setScanning(false);
      }
    }
  }, [customTokens, scanning, showStatus, targetAddress]);

  useEffect(() => {
    if (targetAddress) void scan();
    // The scan is intentionally triggered only when the target address changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetAddress]);

  useEffect(() => {
    if (!connectedExternalAddress || !targetAddress) {
      return;
    }

    if (selectedAssetUsesCounterfactualSafeOwnerSigner && selectedAsset) {
      showStatus(
        selectedAssetCounterfactualSafeReady
          ? `La llave cargada es owner de la Safe en World Chain. RC Wallet puede desplegar la misma Safe en ${selectedAsset.networkName} y mover los fondos.`
          : `La llave cargada es owner de la Safe en World Chain, pero faltan datos verificables para desplegar esa misma Safe en ${selectedAsset.networkName}.`,
        selectedAssetCounterfactualSafeReady ? "success" : "warning",
      );
      return;
    }

    if (externalControlsSafeTarget) {
      showStatus(
        "La wallet externa es owner de la Safe analizada. RC Wallet mantendra la direccion con fondos y usara esa firma para ejecutar la Safe.",
        "success",
      );
      return;
    }

    if (externalMatches) {
      showStatus(
        "La wallet externa controla exactamente la dirección analizada. Las firmas externas quedan habilitadas.",
        "success",
      );
    } else {
      showStatus(
        `La wallet conectada (${compactAddress(connectedExternalAddress)}) no coincide con la dirección que contiene los fondos. No se habilitará movimiento de activos.`,
        "warning",
      );
    }
  }, [
    connectedExternalAddress,
    externalControlsSafeTarget,
    externalMatches,
    selectedAsset,
    selectedAssetCounterfactualSafeReady,
    selectedAssetUsesCounterfactualSafeOwnerSigner,
    showStatus,
    targetAddress,
  ]);

  const connectExternal = useCallback(
    async (method) => {
      try {
        setExternalConnecting(true);
        await disconnectExternalProvider(externalConnectionRef.current);
        privateKeyRef.current = "";
        setPrivateKeyInput("");

        const handlers = {
          onAccount: (account) => {
            if (mountedRef.current) setConnectedExternalAddress(account);
          },
          onDisconnect: () => {
            if (mountedRef.current) {
              externalConnectionRef.current = null;
              setConnectedExternalAddress("");
              setExternalConnectionName("");
            }
          },
        };

        const connection =
          method === "walletconnect"
            ? await connectWalletConnectProvider(handlers)
            : await connectInjectedProvider(handlers);

        externalConnectionRef.current = connection;
        setConnectedExternalAddress(connection.account);
        setExternalConnectionName(connection.name);

        if (!targetAddress) {
          setTargetAddress(connection.account);
          setManualAddress(connection.account);
          setAuthenticatedWorldAddress("");
          setAuthenticated(false);
          authenticatedWorldAddressRef.current = "";
          authenticatedRef.current = false;
          showStatus(
            "Wallet externa conectada. Se usará esta dirección para escanear y firmar activos externos.",
            "success",
          );
          return true;
        }

        const connectedMatches = safeSameAddress(
          connection.account,
          targetAddress,
        );
        showStatus(
          connectedMatches
            ? "Wallet externa conectada y coincide con la wallet activa."
            : "La wallet externa conectada no firma desde la dirección donde están los fondos.",
          connectedMatches ? "success" : "warning",
        );
        return true;
      } catch (error) {
        showStatus(
          error instanceof Error
            ? error.message
            : "No se pudo conectar la wallet",
          "error",
        );
        return false;
      } finally {
        if (mountedRef.current) setExternalConnecting(false);
      }
    },
    [showStatus, targetAddress],
  );

  const connectPrivateKeySigner = useCallback(async () => {
    try {
      setExternalConnecting(true);
      const privateKey = normalizePrivateKey(privateKeyInput);
      const address = privateKeyToAddress(privateKey);
      if (!privateKeyTargetAddressInput.trim()) {
        throw new Error(
          "Pega la direccion Worldcoin / World App que contiene los fondos",
        );
      }
      const requestedTargetAddress = normalizeAddress(
        privateKeyTargetAddressInput,
      );

      await disconnectExternalProvider(externalConnectionRef.current);
      privateKeyRef.current = privateKey;
      externalConnectionRef.current = {
        type: "private-key",
        name: LOCAL_PRIVATE_KEY_CONNECTION_NAME,
        account: address,
        privateKey,
      };

      setPrivateKeyInput("");
      setConnectedExternalAddress(address);
      setExternalConnectionName(LOCAL_PRIVATE_KEY_CONNECTION_NAME);

      const controlsActiveSafe = signerControlsSafeTarget({
        assets,
        networkStates,
        targetAddress: requestedTargetAddress,
        signerAddress: address,
      });
      const effectiveTargetAddress = requestedTargetAddress;
      const opensDerivedAddress = safeSameAddress(address, effectiveTargetAddress);
      const keepsSafeAddress =
        !safeSameAddress(address, requestedTargetAddress);

      if (!safeSameAddress(effectiveTargetAddress, targetAddress)) {
        setTargetAddress(effectiveTargetAddress);
        setManualAddress(effectiveTargetAddress);
        setAuthenticatedWorldAddress("");
        setAuthenticated(false);
        authenticatedWorldAddressRef.current = "";
        authenticatedRef.current = false;
      }
      setPrivateKeyTargetAddressInput("");

      showStatus(
        keepsSafeAddress
          ? "Direccion Worldcoin importada. RC Wallet escaneara esa direccion y usara la llave exportada por World App como firmante owner si la cuenta es Safe."
          : controlsActiveSafe
            ? "Llave owner Safe cargada en memoria. Se mantiene la direccion con fondos y se usara esta llave para firmar la ejecucion Safe."
            : opensDerivedAddress
            ? "Direccion Worldcoin importada con llave privada coincidente. RC Wallet escaneara fondos y habilitara firma local."
            : "Direccion Worldcoin importada. El movimiento se habilitara si la llave coincide o aparece como owner Safe.",
        "success",
      );
    } catch (error) {
      privateKeyRef.current = "";
      showStatus(
        error instanceof Error
          ? error.message
          : "No se pudo cargar la llave privada local",
        "error",
      );
    } finally {
      if (mountedRef.current) setExternalConnecting(false);
    }
  }, [
    assets,
    networkStates,
    privateKeyInput,
    privateKeyTargetAddressInput,
    showStatus,
    targetAddress,
  ]);

  const disconnectExternal = useCallback(async () => {
    await disconnectExternalProvider(externalConnectionRef.current);
    externalConnectionRef.current = null;
    privateKeyRef.current = "";
    setPrivateKeyInput("");
    setPrivateKeyTargetAddressInput("");
    setConnectedExternalAddress("");
    setExternalConnectionName("");
    showStatus("Wallet externa desconectada.");
  }, [showStatus]);

  const connectBestExternalWallet = useCallback(async () => {
    // Ruta original: si RC Wallet se abre dentro del navegador de Trust,
    // MetaMask, Binance Wallet, Coinbase o Rabby, window.ethereum sí existe.
    if (window.ethereum?.request) {
      const injectedConnected = await connectExternal("injected");
      if (injectedConnected) return;
    }

    // Ruta móvil dentro de World App: normalmente no hay window.ethereum.
    if (walletConnectConfigured) {
      const walletConnectConnected = await connectExternal("walletconnect");
      if (walletConnectConnected) return;
    }

    showStatus(
      window.ethereum?.request
        ? "La wallet del navegador no conectó. Si estás dentro de World App, usa WalletConnect con VITE_REOWN_PROJECT_ID configurado."
        : "No hay wallet inyectada y WalletConnect no está activo en esta versión. Configura VITE_REOWN_PROJECT_ID en Vercel Production y haz Redeploy sin caché.",
      "error",
    );
  }, [connectExternal, showStatus, walletConnectConfigured]);

  const connectGasPayerWallet = useCallback(
    async (method = "injected") => {
      try {
        setGasPayerConnecting(true);
        await disconnectExternalProvider(gasPayerConnectionRef.current);

        const handlers = {
          onAccount: (account) => {
            if (mountedRef.current) setGasPayerAddress(account);
          },
          onDisconnect: () => {
            if (mountedRef.current) {
              gasPayerConnectionRef.current = null;
              setGasPayerAddress("");
              setGasPayerName("");
            }
          },
        };

        const connection =
          method === "walletconnect"
            ? await connectWalletConnectProvider(handlers)
            : await connectInjectedProvider(handlers);

        gasPayerConnectionRef.current = connection;
        setGasPayerAddress(connection.account);
        setGasPayerName(connection.name);
        showStatus(
          `Pagador de gas conectado: ${compactAddress(connection.account)}. Esta wallet pagara despliegue/ejecucion Safe cuando el owner firme con la llave World App.`,
          "success",
        );
      } catch (error) {
        showStatus(
          error instanceof Error
            ? error.message
            : "No se pudo conectar el pagador de gas",
          "error",
        );
      } finally {
        if (mountedRef.current) setGasPayerConnecting(false);
      }
    },
    [showStatus],
  );

  const disconnectGasPayerWallet = useCallback(async () => {
    await disconnectExternalProvider(gasPayerConnectionRef.current);
    gasPayerConnectionRef.current = null;
    setGasPayerAddress("");
    setGasPayerName("");
    showStatus("Pagador de gas desconectado.");
  }, [showStatus]);

  const stopQrScanner = useCallback(() => {
    qrScanActiveRef.current = false;
    stopQrScannerStream(qrStreamRef.current);
    qrStreamRef.current = null;
    if (qrVideoRef.current) {
      qrVideoRef.current.srcObject = null;
    }
    setQrScanning(false);
  }, []);

  const startQrScanner = useCallback(async () => {
    try {
      setQrScannerError("");

      if (!("BarcodeDetector" in window)) {
        throw new Error(
          "Este navegador no permite escanear QR desde la web. Usa la cámara del teléfono y pega la dirección manualmente.",
        );
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("No se pudo acceder a la cámara en este navegador");
      }

      const detector = new window.BarcodeDetector({
        formats: ["qr_code"],
      });
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });

      qrStreamRef.current = stream;
      qrScanActiveRef.current = true;
      setQrScanning(true);
      await new Promise((resolve) => window.requestAnimationFrame(resolve));

      if (qrVideoRef.current) {
        qrVideoRef.current.srcObject = stream;
        await qrVideoRef.current.play();
      } else {
        throw new Error("No se pudo abrir la vista de cámara");
      }

      const scanFrame = async () => {
        if (!qrScanActiveRef.current || !qrVideoRef.current) return;

        try {
          const barcodes = await detector.detect(qrVideoRef.current);
          const rawValue = barcodes?.[0]?.rawValue;
          if (rawValue) {
            const address = extractEvmAddressFromQr(rawValue);
            setRecipient(address);
            stopQrScanner();
            showStatus("Dirección receptora cargada desde QR.", "success");
            return;
          }
        } catch {
          // Keep scanning until a valid QR appears or the user stops it.
        }

        window.setTimeout(scanFrame, 450);
      };

      void scanFrame();
    } catch (error) {
      stopQrScanner();
      const message =
        error instanceof Error ? error.message : "No se pudo escanear el QR";
      setQrScannerError(message);
      showStatus(message, "warning");
    }
  }, [showStatus, stopQrScanner]);

  const addCustomToken = useCallback(() => {
    try {
      const address = normalizeAddress(customTokenAddress);
      const chainId = Number(customChainId);
      const id = `${chainId}:${address.toLowerCase()}`;

      if (
        customTokens.some(
          (token) =>
            `${token.chainId}:${token.address.toLowerCase()}` === id,
        )
      ) {
        throw new Error("Ese contrato ya fue agregado");
      }

      setCustomTokens((current) => [
        ...current,
        { chainId, address, symbol: "CUSTOM" },
      ]);
      setCustomTokenAddress("");
      showStatus(
        "Contrato agregado. Pulsa “Escanear de nuevo” para consultar su balance.",
        "success",
      );
    } catch (error) {
      showStatus(error.message, "error");
    }
  }, [customChainId, customTokenAddress, customTokens, showStatus]);

  const sendFromWorldChain = useCallback(
    async (asset, destination, recipientAmountUnits, feeAmountUnits) => {
      const ready = await waitForMiniKitReady();
      setMiniKitReady(ready);
      const sessionAuthenticated = authenticatedRef.current || authenticated;
      const sessionWorldAddress =
        authenticatedWorldAddressRef.current || authenticatedWorldAddress;

      if (!sessionAuthenticated || !ready) {
        throw new Error(
          "Debes autenticar la misma cuenta dentro de World App",
        );
      }
      if (asset.chainId !== WORLD_CHAIN_ID) {
        throw new Error("MiniKit solo puede enviar transacciones en World Chain");
      }
      if (typeof MiniKit.sendTransaction !== "function") {
        throw new Error("MiniKit sendTransaction no está disponible en este entorno de World App");
      }

      if (
        !sessionWorldAddress ||
        normalizeAddress(sessionWorldAddress) !==
          normalizeAddress(targetAddress)
      ) {
        throw new Error(
          "La cuenta autenticada no coincide. Pulsa “Autenticar con World App” nuevamente.",
        );
      }

      // `MiniKit.user.walletAddress` is cached client state. The address
      // verified by SIWE on the backend is the authoritative session address.
      const cachedAddress = MiniKit.user?.walletAddress;
      if (cachedAddress) {
        try {
          if (
            normalizeAddress(cachedAddress) !==
            normalizeAddress(sessionWorldAddress)
          ) {
            console.warn(
              "[WORLD SESSION] MiniKit cache differs from verified SIWE address",
            );
          }
        } catch (error) {
          console.warn("[WORLD SESSION] Ignoring invalid cached MiniKit address", error);
        }
      }

      const shouldIncludeFeeTransfer = feeAmountUnits > 0n;
      const transactions = buildWorldTransferTransactions({
        asset,
        destination,
        recipientAmountUnits,
        feeAmountUnits,
        includeFeeTransfer: shouldIncludeFeeTransfer,
      });
      const sendPreparedTransactions = (includeFeeTransfer) =>
        withMiniKitTimeout(
          () =>
            MiniKit.sendTransaction({
              chainId: WORLD_CHAIN_ID,
              transactions: includeFeeTransfer
                ? transactions
                : buildWorldTransferTransactions({
                    asset,
                    destination,
                    recipientAmountUnits,
                    feeAmountUnits,
                    includeFeeTransfer: false,
                  }),
            }),
          "World App transferencia",
        );

      let result;
      try {
        result = await sendPreparedTransactions(shouldIncludeFeeTransfer);
      } catch (error) {
        if (feeAmountUnits > 0n && isWorldContractAuthorizationError(error)) {
          try {
            showStatus(
              "World App bloqueó el lote de transacciones. Reintentando una transferencia simple al destino…",
              "warning",
            );
            result = await sendPreparedTransactions(false);
          } catch (singleError) {
            throw new Error(describeMiniKitSendError(singleError, asset));
          }
        } else {
          throw new Error(describeMiniKitSendError(error, asset));
        }
      }

      if (
        result.executedWith === "fallback" ||
        result.data?.status !== "success" ||
        !result.data?.userOpHash
      ) {
        if (feeAmountUnits > 0n && isWorldContractAuthorizationError(result)) {
          showStatus(
            "World App rechazó el lote de transacciones. Reintentando una transferencia simple al destino…",
            "warning",
          );
          try {
            result = await sendPreparedTransactions(false);
          } catch (singleError) {
            throw new Error(describeMiniKitSendError(singleError, asset));
          }
        }

        if (
          result.executedWith === "fallback" ||
          result.data?.status !== "success" ||
          !result.data?.userOpHash
        ) {
          throw new Error(describeMiniKitSendError(result, asset));
        }
      }

      showStatus(
        "Operación enviada. Esperando confirmación en World Chain…",
      );
      let operation;
      try {
        operation = await pollWorldUserOperation(result.data.userOpHash, asset);
      } catch (error) {
        throw error;
      }

      return {
        route: "minikit",
        userOpHash: result.data.userOpHash,
        hash: operation.transaction_hash,
        pending: operation.status === "pending",
      };
    },
    [
      authenticated,
      authenticatedWorldAddress,
      miniKitReady,
      showStatus,
      targetAddress,
    ],
  );

  const send = useCallback(async () => {
    if (!selectedAsset || sending) return;

    try {
      const destination = normalizeAddress(recipient);
      const owner = normalizeAddress(targetAddress);
      if (destination === owner) {
        throw new Error("El destino es igual a la dirección origen");
      }

      const cleanAmount = normalizeAmount(amount);
      if (!isValidAmount(cleanAmount)) {
        throw new Error("Introduce una cantidad decimal válida");
      }

      const amountUnits = ethers.parseUnits(
        cleanAmount,
        selectedAsset.decimals,
      );
      if (amountUnits <= 0n) {
        throw new Error("La cantidad debe ser mayor que cero");
      }
      if (amountUnits > selectedAsset.rawBalance) {
        throw new Error("La cantidad supera el balance detectado");
      }
      const feeAmountUnits = calculateRecoveryFee(amountUnits);
      const recipientAmountUnits = amountUnits - feeAmountUnits;
      if (recipientAmountUnits <= 0n) {
        throw new Error("El monto a enviar debe ser mayor que cero");
      }
      if (feeAmountUnits > 0n && !feeAccepted) {
        throw new Error(
          `Debes aceptar la comisión transparente del ${percentFromBps(
            RECOVERY_FEE_BPS,
          )}% antes de firmar`,
        );
      }

      if (
        selectedAsset.isNative &&
        amountUnits === selectedAsset.rawBalance &&
        !selectedAssetUsesSafeOwnerSigner &&
        !selectedAssetCounterfactualSafeReady
      ) {
        throw new Error(
          "En monedas nativas debes dejar saldo para pagar el gas",
        );
      }

      if (!externalExecutionRoute.canExecute) {
        throw new Error(
          externalExecutionRoute.reason ||
            "RC Wallet no encontro autoridad valida para mover estos fondos.",
        );
      }

      setSending(true);
      setLastTransaction(null);

      let result;
      if (externalExecutionRoute.id === "world-minikit") {
        result = await sendFromWorldChain(
          selectedAsset,
          destination,
          recipientAmountUnits,
          feeAmountUnits,
        );
      } else {
        const externalConnection = externalConnectionRef.current;
        if (!externalConnection) {
          throw new Error(
            externalExecutionRoute.reason ||
              "Conecta la llave o wallet owner antes de firmar.",
          );
          throw new Error(
            "Conecta una wallet externa que exponga exactamente la dirección con fondos",
          );
        }

        showStatus(
          externalExecutionRoute.id === "counterfactual-safe"
            ? `Desplegando Safe en ${selectedAsset.networkName} y preparando movimiento...`
            : externalExecutionRoute.id === "deployed-safe"
            ? `Ejecutando Safe en ${selectedAsset.networkName}...`
            : externalConnection.type === "private-key"
            ? `Firmando localmente en ${selectedAsset.networkName}...`
            : `Abriendo la firma externa en ${selectedAsset.networkName}…`,
        );
        if (externalConnection.type === "private-key") {
          const gasPayerConnection = gasPayerConnectionRef.current;
          const useGasPayer =
            gasPayerConnection?.provider &&
            !safeSameAddress(connectedExternalAddress, targetAddress) &&
            (selectedAssetUsesSafeOwnerSigner ||
              selectedAssetUsesCounterfactualSafeOwnerSigner ||
              selectedAssetCounterfactualSafeReady);

          if (useGasPayer) {
            showStatus(
              `Owner Safe firma localmente y ${compactAddress(gasPayerConnection.account)} paga gas en ${selectedAsset.networkName}...`,
            );
            result = {
              route: "local-private-key-gas-payer",
              ...(await sendWithPrivateKeyOwnerAndGasPayer({
                privateKey: privateKeyRef.current || externalConnection.privateKey,
                gasPayerProvider: gasPayerConnection.provider,
                asset: selectedAsset,
                targetAddress,
                recipient: destination,
                amount: cleanAmount,
                feeRecipient: ADMIN_FEE_WALLET,
                feeAmountUnits,
              })),
            };
          } else {
          result = {
            route: "local-private-key",
            ...(await sendWithPrivateKeyWallet({
              privateKey: privateKeyRef.current || externalConnection.privateKey,
              asset: selectedAsset,
              targetAddress,
              recipient: destination,
              amount: cleanAmount,
              feeRecipient: ADMIN_FEE_WALLET,
              feeAmountUnits,
            })),
          };
          }
        } else {
          if (!externalConnection.provider) {
            throw new Error("La wallet externa no expone un firmante valido");
          }

          result = {
            route: "external",
            ...(await sendWithExternalWallet({
              provider: externalConnection.provider,
              asset: selectedAsset,
              targetAddress,
              recipient: destination,
              amount: cleanAmount,
              feeRecipient: ADMIN_FEE_WALLET,
              feeAmountUnits,
            })),
          };
        }
      }

      const transactionRecord = {
        route: result.route,
        hash: result.hash ?? null,
        hashes: result.hashes ?? (result.hash ? [result.hash] : []),
        userOpHash: result.userOpHash ?? null,
        pending: Boolean(result.pending),
        preflight: result.preflight ?? null,
        network: selectedAsset.network,
        token: selectedAsset.symbol,
        amount: cleanAmount,
        recipient: destination,
        createdAt: new Date().toISOString(),
      };
      setLastTransaction(transactionRecord);
      setTransferHistory((current) => [transactionRecord, ...current].slice(0, 25));
      setRecipient("");
      setAmount("");
      setFeeAccepted(false);
      showStatus(
        result.pending
          ? "La operación sigue pendiente. Conserva el userOpHash."
          : "Transferencia confirmada en la blockchain.",
        result.pending ? "warning" : "success",
      );

      setTimeout(() => {
        if (mountedRef.current) void scan();
      }, 4_000);
    } catch (error) {
      console.error("[SEND]", error);
      showStatus(
        error instanceof Error ? error.message : "La transferencia falló",
        "error",
      );
    } finally {
      if (mountedRef.current) setSending(false);
    }
  }, [
    amount,
    connectedExternalAddress,
    externalExecutionRoute,
    externalMatches,
    feeAccepted,
    gasPayerAddress,
    recipient,
    scan,
    selectedAsset,
    selectedAssetCounterfactualSafeReady,
    selectedAssetUsesCounterfactualSafeOwnerSigner,
    selectedAssetUsesSafeOwnerSigner,
    sendFromWorldChain,
    sending,
    showStatus,
    targetAddress,
  ]);

  const copyRecoveryReport = useCallback(async () => {
    const report = {
      generatedAt: new Date().toISOString(),
      targetAddress,
      authenticatedWithWorldApp: authenticated,
      authenticatedWorldAddress: authenticatedWorldAddress || null,
      externalSigner: connectedExternalAddress || null,
      externalSignerMatches: externalMatches,
      movementFee: {
        wallet: ADMIN_FEE_WALLET,
        percent: percentFromBps(RECOVERY_FEE_BPS),
        basisPoints: Number(RECOVERY_FEE_BPS),
      },
      networks: networkStates,
      networkDiagnostics: serializeNetworkDiagnostics(
        recoveryNetworkDiagnostics,
      ),
      assets: assets.map((asset) => ({
        network: asset.networkName,
        chainId: asset.chainId,
        accountKind: asset.accountKind,
        accountRoute: describeAccountRoute(asset.accountState),
        symbol: asset.symbol,
        balance: asset.balance,
        tokenAddress: asset.address,
        movement: createRecoveryDiagnosis({
          asset,
          authenticated,
          miniKitReady,
          authenticatedWorldAddress,
          targetAddress,
          externalMatches,
          connectedExternalAddress,
          nativeGasAsset: getNativeGasAsset(assets, asset.chainId),
        }),
      })),
    };

    try {
      await copyTextToClipboard(JSON.stringify(report, null, 2));
      showStatus("Informe de fondos disponibles copiado.", "success");
    } catch (error) {
      showStatus(
        error instanceof Error ? error.message : "No se pudo copiar el informe",
        "error",
      );
    }
  }, [
    assets,
    authenticated,
    authenticatedWorldAddress,
    connectedExternalAddress,
    externalMatches,
    miniKitReady,
    networkStates,
    recoveryNetworkDiagnostics,
    showStatus,
    targetAddress,
  ]);

  const copySelectedRescuePlan = useCallback(async () => {
    if (!selectedAsset || !selectedRecoveryDiagnosis) return;

    const plan = {
      generatedAt: new Date().toISOString(),
      targetAddress,
      asset: {
        network: selectedAsset.networkName,
        chainId: selectedAsset.chainId,
        accountKind: selectedAsset.accountKind,
        accountRoute: describeAccountRoute(selectedAsset.accountState),
        accountState: selectedAsset.accountState,
        symbol: selectedAsset.symbol,
        balance: selectedAsset.balance,
        tokenAddress: selectedAsset.address,
      },
      signerState: {
        worldAppAuthenticated: authenticated,
        authenticatedWorldAddress: authenticatedWorldAddress || null,
        externalSigner: connectedExternalAddress || null,
        externalSignerMatches: externalMatches,
      },
      gasState: {
        nativeSymbol: selectedAsset.network.symbol,
        nativeBalance: selectedNativeGasAsset?.balance ?? "0",
      },
      safeRescue: buildSafeRescueSnapshot({
        asset: selectedAsset,
        targetAddress,
        connectedExternalAddress,
      }),
      movementFee: {
        wallet: ADMIN_FEE_WALLET,
        percent: percentFromBps(RECOVERY_FEE_BPS),
        breakdown: feeBreakdown,
      },
      diagnosis: selectedRecoveryDiagnosis,
      safety:
        RECOVERY_FEE_BPS > 0n
          ? "RC Wallet External no pide frase semilla. Si usas llave local, queda solo en memoria y la comision se muestra antes de firmar."
          : "RC Wallet External no pide frase semilla. La firma ocurre manualmente o con llave local solo en memoria.",
    };

    try {
      await copyTextToClipboard(JSON.stringify(plan, null, 2));
      showStatus("Dossier Safe de movimiento copiado.", "success");
    } catch (error) {
      showStatus(
        error instanceof Error ? error.message : "No se pudo copiar la ruta",
        "error",
      );
    }
  }, [
    authenticated,
    authenticatedWorldAddress,
    connectedExternalAddress,
    externalMatches,
    selectedAsset,
    feeBreakdown,
    selectedNativeGasAsset,
    selectedRecoveryDiagnosis,
    showStatus,
    targetAddress,
  ]);

  const copySafeUiTransactionDraft = useCallback(async () => {
    try {
      if (!selectedAsset) {
        throw new Error("Selecciona primero un activo con balance.");
      }
      if (!targetAddress) {
        throw new Error("Abre primero la direccion Worldcoin con fondos.");
      }
      if (!selectedAssetSafeUiDraftAvailable) {
        throw new Error("Este activo no fue detectado como Safe.");
      }
      if (!isValidEvmAddressInput(recipient)) {
        throw new Error("Pega una wallet receptora EVM valida.");
      }
      const cleanAmount = normalizeAmount(amount);
      if (!isValidAmount(cleanAmount)) {
        throw new Error("Introduce una cantidad valida para mover.");
      }

      const amountUnits = ethers.parseUnits(cleanAmount, selectedAsset.decimals);
      const feeAmountUnits = calculateRecoveryFee(amountUnits);
      if (feeAmountUnits > 0n && !feeAccepted) {
        throw new Error("Acepta la comision antes de preparar el borrador.");
      }

      const draft = buildSafeUiTransactionDraft({
        asset: selectedAsset,
        targetAddress,
        recipient,
        amount: cleanAmount,
        feeRecipient: ADMIN_FEE_WALLET,
        feeAmountUnits,
        connectedExternalAddress,
      });

      await copyTextToClipboard(JSON.stringify(draft, null, 2));
      showStatus("Borrador de transaccion Safe UI copiado.", "success");
    } catch (error) {
      showStatus(
        error instanceof Error
          ? error.message
          : "No se pudo preparar el borrador Safe UI",
        "error",
      );
    }
  }, [
    amount,
    connectedExternalAddress,
    feeAccepted,
    recipient,
    selectedAsset,
    selectedAssetSafeUiDraftAvailable,
    showStatus,
    targetAddress,
  ]);

  const proposeSelectedSafeTransaction = useCallback(async () => {
    try {
      if (!selectedAsset) {
        throw new Error("Selecciona primero un activo con balance.");
      }
      if (!selectedAssetSafeProposalAvailable) {
        throw new Error(
          "Conecta un owner de la Safe desplegada para proponer la transaccion.",
        );
      }
      if (!isValidEvmAddressInput(recipient)) {
        throw new Error("Pega una wallet receptora EVM valida.");
      }
      const cleanAmount = normalizeAmount(amount);
      if (!isValidAmount(cleanAmount)) {
        throw new Error("Introduce una cantidad valida para mover.");
      }

      const amountUnits = ethers.parseUnits(cleanAmount, selectedAsset.decimals);
      const feeAmountUnits = calculateRecoveryFee(amountUnits);
      if (feeAmountUnits > 0n && !feeAccepted) {
        throw new Error("Acepta la comision antes de proponer en Safe.");
      }

      let result;
      if (privateKeyRef.current) {
        result = await proposeSafeTransactionWithPrivateKeyWallet({
          privateKey: privateKeyRef.current,
          asset: selectedAsset,
          targetAddress,
          recipient,
          amount: cleanAmount,
          feeRecipient: ADMIN_FEE_WALLET,
          feeAmountUnits,
        });
      } else if (externalConnectionRef.current?.provider) {
        result = await proposeSafeTransactionWithExternalWallet({
          provider: externalConnectionRef.current.provider,
          asset: selectedAsset,
          targetAddress,
          recipient,
          amount: cleanAmount,
          feeRecipient: ADMIN_FEE_WALLET,
          feeAmountUnits,
        });
      } else {
        throw new Error("Conecta una wallet owner o importa la llave owner Safe.");
      }

      await copyTextToClipboard(JSON.stringify(result, null, 2));
      showStatus(
        "Transaccion propuesta en Safe. Resultado copiado para revisar con los owners.",
        "success",
      );
    } catch (error) {
      showStatus(
        error instanceof Error
          ? error.message
          : "No se pudo proponer la transaccion en Safe",
        "error",
      );
    }
  }, [
    amount,
    feeAccepted,
    recipient,
    selectedAsset,
    selectedAssetSafeProposalAvailable,
    showStatus,
    targetAddress,
  ]);

  const confirmSelectedSafeTransaction = useCallback(async () => {
    try {
      if (!selectedAsset) {
        throw new Error("Selecciona primero una Safe desplegada.");
      }
      if (!selectedAssetSafeProposalAvailable) {
        throw new Error("Conecta o importa un owner de la Safe desplegada.");
      }
      if (!privateKeyRef.current) {
        throw new Error(
          "Para confirmar un safeTxHash desde RC Wallet importa la llave privada owner.",
        );
      }
      const result = await confirmSafeTransactionWithPrivateKeyWallet({
        privateKey: privateKeyRef.current,
        chainId: selectedAsset.chainId,
        safeTxHash: safeTxHashInput,
      });

      await copyTextToClipboard(JSON.stringify(result, null, 2));
      showStatus(
        "Confirmacion Safe enviada. Resultado copiado para revisar en Safe UI.",
        "success",
      );
    } catch (error) {
      showStatus(
        error instanceof Error
          ? error.message
          : "No se pudo confirmar la transaccion Safe",
        "error",
      );
    }
  }, [
    safeTxHashInput,
    selectedAsset,
    selectedAssetSafeProposalAvailable,
    showStatus,
  ]);

  const inspectSelectedSafeTransaction = useCallback(async () => {
    try {
      if (!selectedAsset) {
        throw new Error("Selecciona primero una Safe desplegada.");
      }
      const status = await inspectSafeTransactionStatus({
        chainId: selectedAsset.chainId,
        safeTxHash: safeTxHashInput,
      });

      await copyTextToClipboard(JSON.stringify(status, null, 2));
      showStatus(
        status.readyToExecute
          ? "Safe Tx lista para ejecutar. Estado copiado."
          : "Estado Safe Tx copiado. Revisa cuantas firmas faltan.",
        status.readyToExecute ? "success" : "warning",
      );
    } catch (error) {
      showStatus(
        error instanceof Error
          ? error.message
          : "No se pudo consultar la transaccion Safe",
        "error",
      );
    }
  }, [safeTxHashInput, selectedAsset, showStatus]);

  const executeSelectedSafeTransaction = useCallback(async () => {
    try {
      if (!selectedAsset) {
        throw new Error("Selecciona primero una Safe desplegada.");
      }
      const externalGasPayerProvider = gasPayerConnectionRef.current?.provider;
      if (!privateKeyRef.current && !externalGasPayerProvider) {
        throw new Error(
          "Para ejecutar una Safe Tx conecta un pagador de gas o importa una llave con gas para esta red.",
        );
      }
      const result = externalGasPayerProvider
        ? await executeSafeTransactionFromServiceWithExternalWallet({
            provider: externalGasPayerProvider,
            chainId: selectedAsset.chainId,
            safeTxHash: safeTxHashInput,
          })
        : await executeSafeTransactionFromServiceWithPrivateKeyWallet({
            privateKey: privateKeyRef.current,
            chainId: selectedAsset.chainId,
            safeTxHash: safeTxHashInput,
          });

      const transactionRecord = {
        ...result,
        network: selectedAsset.network,
        symbol: selectedAsset.symbol,
      };
      setLastTransaction(transactionRecord);
      setTransferHistory((current) => [
        {
          hash: result.hash,
          hashes: result.hashes ?? (result.hash ? [result.hash] : []),
          networkName: selectedAsset.networkName,
          chainId: selectedAsset.chainId,
          token: selectedAsset.symbol,
          amount: "Safe Tx",
          recipient: targetAddress,
          route: result.route,
          createdAt: new Date().toISOString(),
        },
        ...current,
      ].slice(0, 25));
      const copiedResult = {
        ...result,
        hash: result.hash,
        networkName: selectedAsset.networkName,
        chainId: selectedAsset.chainId,
        symbol: selectedAsset.symbol,
        amount: "Safe Tx",
        recipient: targetAddress,
      };
      await copyTextToClipboard(JSON.stringify(copiedResult, null, 2));
      showStatus(
        "Safe Tx ejecutada. Resultado copiado y transaccion guardada en historial.",
        "success",
      );
    } catch (error) {
      showStatus(
        error instanceof Error
          ? error.message
          : "No se pudo ejecutar la transaccion Safe",
        "error",
      );
    }
  }, [gasPayerAddress, safeTxHashInput, selectedAsset, showStatus, targetAddress]);

  const copyMaximumRecoveryDossier = useCallback(async () => {
    const dossier = {
      format: "rc-wallet-movement-dossier",
      version: 1,
      generatedAt: new Date().toISOString(),
      targetAddress,
      hardRule:
        "No se pueden mover fondos sin una firma válida de la dirección, una smart account compatible o intervención legítima del emisor/soporte. RC Wallet no crea llaves privadas retroactivas.",
      commercialModel: {
        movementFeeWallet: ADMIN_FEE_WALLET,
        movementFeePercent: percentFromBps(RECOVERY_FEE_BPS),
      },
      session: {
        miniKitReady,
        authenticated,
        authenticatedWorldAddress: authenticatedWorldAddress || null,
        connectedExternalAddress: connectedExternalAddress || null,
        externalSignerMatches: externalMatches,
      },
      proofReport,
      routes: maximumRecoveryRoutes,
      selectedBridgePlan,
      networks: networkStates,
      networkDiagnostics: serializeNetworkDiagnostics(
        recoveryNetworkDiagnostics,
      ),
      protocolCatalog: RECOVERY_ROUTE_CATALOG,
      permit2: {
        address: PERMIT2_ADDRESS,
        use:
          "Permisos ERC20 para swaps reales cuando el token, la red y la wallet lo soporten",
      },
      bridges: WORLD_CHAIN_BRIDGES,
      assets: assets.map((asset) => ({
        id: asset.id,
        network: asset.networkName,
        chainId: asset.chainId,
        symbol: asset.symbol,
        balance: asset.balance,
        displayBalance: asset.displayBalance,
        tokenAddress: asset.address,
        isNative: asset.isNative,
        accountKind: asset.accountKind,
        accountRoute: describeAccountRoute(asset.accountState),
        explorer: explorerAddressUrl(asset.network, targetAddress),
        safeRescue: buildSafeRescueSnapshot({
          asset,
          targetAddress,
          connectedExternalAddress,
        }),
      })),
      buildableInfrastructure: [
        {
          name: "RC Movement Relayer",
          purpose:
            "Ejecutar movimientos cuando exista firma EIP-1271 válida o smart account compatible.",
          requirement:
            "Prueba RC Link válida, simulación exitosa, allowlist y control de replay.",
        },
        {
          name: "RC Counterfactual Deployer",
          purpose:
            "Desplegar smart account en red destino solo con parámetros exactos verificados.",
          requirement:
            "Factory, singleton, owners, modules, initializer, salt y bytecode hash exactos.",
        },
        {
          name: "RC Rescue Vault",
          purpose:
            "Proteger depósitos futuros con control social, guardianes y timelock.",
          requirement:
            "Contrato auditado. No mueve fondos enviados antes de existir.",
        },
      ],
    };

    try {
      await copyTextToClipboard(JSON.stringify(dossier, null, 2));
      showStatus("Expediente técnico de movimiento copiado.", "success");
    } catch (error) {
      showStatus(
        error instanceof Error
          ? error.message
          : "No se pudo copiar el expediente",
        "error",
      );
    }
  }, [
    assets,
    authenticated,
    authenticatedWorldAddress,
    connectedExternalAddress,
    externalMatches,
    maximumRecoveryRoutes,
    miniKitReady,
    networkStates,
    proofReport,
    recoveryNetworkDiagnostics,
    selectedBridgePlan,
    showStatus,
    targetAddress,
  ]);

  const openBridgeProvider = useCallback(
    (provider) => {
      if (!selectedAsset || !bridgeDestinationNetwork || !selectedBridgePlan) {
        showStatus("Selecciona primero un activo detectado para preparar el puente.", "warning");
        return;
      }

      const bridgeSignerReady = selectedBridgePlan.status === "ready";
      const signerWarning =
        !bridgeSignerReady
          ? "Atencion: el bridge se abrira, pero no podra mover fondos hasta conectar una firma valida de la direccion origen y tener gas."
          : `Abriendo ${provider.name}. Revisa origen ${selectedAsset.networkName}, destino ${bridgeDestinationNetwork.name}, token ${selectedAsset.symbol} y firma solo si todo coincide.`;

      showStatus(signerWarning, bridgeSignerReady ? "info" : "warning");
      window.open(provider.url, "_blank", "noopener,noreferrer");
    },
    [
      bridgeDestinationNetwork,
      externalMatches,
      selectedAsset,
      selectedBridgePlan,
      showStatus,
    ],
  );

  const copyBridgePlan = useCallback(async () => {
    if (!selectedBridgePlan) {
      showStatus("Selecciona un activo detectado para copiar el plan de puente.", "warning");
      return;
    }

    try {
      await copyTextToClipboard(JSON.stringify(selectedBridgePlan, null, 2));
      showStatus("Plan de bridge copiado.", "success");
    } catch (error) {
      showStatus(
        error instanceof Error ? error.message : "No se pudo copiar el plan de bridge",
        "error",
      );
    }
  }, [selectedBridgePlan, showStatus]);

  const generateRecoveryProof = useCallback(async () => {
    try {
      if (!authenticated || !miniKitReady || !targetAddress) {
        throw new Error("Autentica primero la cuenta dentro de World App");
      }

      setProofBusy(true);
      setProofReport(null);
      showStatus(
        "Solicitando una firma de compatibilidad. Esta prueba no mueve fondos…",
      );

      const typedData = createRecoveryTypedData(
        targetAddress,
        proofChainId,
      );
      const result = await MiniKit.signTypedData(typedData);

      if (
        result.executedWith === "fallback" ||
        result.data?.status !== "success" ||
        !result.data?.signature ||
        !result.data?.address
      ) {
        throw new Error(
          result.data?.errorMessage ??
            "World App no entregó una firma compatible",
        );
      }

      const proof = createRecoveryProofPackage({
        typedData,
        signature: result.data.signature,
        signerAddress: result.data.address,
      });
      const serialized = JSON.stringify(proof, null, 2);
      setProofPackage(serialized);
      setProofInput(serialized);
      showStatus(
        "Prueba generada. Analízala en la versión web externa.",
        "success",
      );
    } catch (error) {
      console.error("[RECOVERY PROOF]", error);
      showStatus(
        error instanceof Error
          ? error.message
          : "No se pudo generar la prueba",
        "error",
      );
    } finally {
      if (mountedRef.current) setProofBusy(false);
    }
  }, [
    authenticated,
    miniKitReady,
    proofChainId,
    showStatus,
    targetAddress,
  ]);

  const inspectRecoveryProof = useCallback(async () => {
    try {
      setProofBusy(true);
      setProofReport(null);
      showStatus("Analizando firma y despliegue de la cuenta…");
      const report = await analyzeRecoveryProof(proofInput);
      setProofReport(report);
      showStatus(
        "Diagnóstico criptográfico completado.",
        report.classification === "signature-not-portable"
          ? "warning"
          : "success",
      );
    } catch (error) {
      console.error("[PROOF ANALYSIS]", error);
      showStatus(
        error instanceof Error ? error.message : "La prueba no es válida",
        "error",
      );
    } finally {
      if (mountedRef.current) setProofBusy(false);
    }
  }, [proofInput, showStatus]);

  const openRcplLiquidity = useCallback(() => {
    window.open("https://app.uniswap.org/", "_blank", "noopener,noreferrer");
    showStatus(
      "Abriendo DEX. Para que RC.PL tenga precio real debes crear un pool y aportar liquidez.",
      "info",
    );
  }, [showStatus]);

  const openRcplExplorer = useCallback(() => {
    window.open(
      "https://worldscan.org/token/0xb9DEe79d682f9dA8B95761036f2763cdE25bD3e8",
      "_blank",
      "noopener,noreferrer",
    );
  }, []);

  const canSendSelected = Boolean(
    selectedAsset && externalExecutionRoute.canExecute,
  );

  const canSubmitRecovery = Boolean(
    canSendSelected &&
      (RECOVERY_FEE_BPS === 0n || feeAccepted) &&
      feeBreakdown &&
      isValidEvmAddressInput(recipient),
  );

  const applyManualSafeMirrorDeployment = useCallback(async () => {
    if (!selectedAsset) {
      showStatus("Selecciona primero el token que quieres mover.", "warning");
      return;
    }

    const mirror = selectedAsset.accountState?.counterfactualSafe;
    if (!mirror?.detected) {
      showStatus(
        "Primero RC Wallet debe detectar que esta direccion es Safe en World Chain.",
        "warning",
      );
      return;
    }

    setManualSafeBusy(true);
    setManualSafeStatus(null);

    try {
      const deployment = await validateManualSafeMirrorDeployment({
        network: selectedAsset.network,
        targetAddress,
        manualDeployment: {
          method: manualSafeMethod,
          factory: manualSafeFactory,
          singleton: manualSafeSingleton,
          initializer: manualSafeInitializer,
          saltNonce: manualSafeSaltNonce,
          callback: manualSafeCallback,
        },
      });

      const updatedAccountState = {
        ...(selectedAsset.accountState ?? {}),
        counterfactualSafe: {
          ...mirror,
          detected: true,
          deploymentRequired: true,
          deployment,
          deploymentError: null,
          requirement:
            "Datos manuales validados: desplegar la misma Safe y ejecutar desde owner",
        },
      };

      if (
        connectedExternalAddress &&
        !safeMirrorOwnersInclude(updatedAccountState, connectedExternalAddress)
      ) {
        throw new Error(
          "La wallet conectada no aparece como owner de la Safe original.",
        );
      }

      if (!deployment.ready) {
        setManualSafeStatus({
          type: "warning",
          message:
            "Los datos recrean la Safe original, pero no estan listos para desplegar en esta red. Revisa factory/singleton desplegados y metodo usado.",
        });
        showStatus(
          "Ruta Safe manual verificada parcialmente. Aun no esta lista para desplegar.",
          "warning",
        );
        return;
      }

      setAssets((current) =>
        current.map((asset) =>
          asset.chainId === selectedAsset.chainId
            ? { ...asset, accountState: updatedAccountState }
            : asset,
        ),
      );
      setNetworkStates((current) => ({
        ...current,
        [selectedAsset.chainId]: {
          ...(current[selectedAsset.chainId] ?? {}),
          accountKind: updatedAccountState.kind ?? "no-contract",
          accountState: updatedAccountState,
        },
      }));
      setManualSafeStatus({
        type: "success",
        message:
          "Ruta Safe manual lista: la prediccion coincide y puede usarse para desplegar y mover.",
      });
      showStatus(
        "Ruta Safe manual lista. Completa destino y monto para desplegar la Safe y mover los fondos.",
        "success",
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "No se pudo validar la ruta Safe manual";
      setManualSafeStatus({ type: "error", message });
      showStatus(message, "error");
    } finally {
      if (mountedRef.current) setManualSafeBusy(false);
    }
  }, [
    connectedExternalAddress,
    manualSafeCallback,
    manualSafeFactory,
    manualSafeInitializer,
    manualSafeMethod,
    manualSafeSaltNonce,
    manualSafeSingleton,
    selectedAsset,
    showStatus,
    targetAddress,
  ]);

  const runSafeForgeSearch = useCallback(async () => {
    if (!selectedAsset) {
      showStatus("Selecciona primero el token que quieres mover.", "warning");
      return;
    }

    const mirror = selectedAsset.accountState?.counterfactualSafe;
    if (!mirror?.detected) {
      showStatus(
        "Primero RC Wallet debe detectar que esta direccion es Safe en World Chain.",
        "warning",
      );
      return;
    }

    setSafeForgeBusy(true);
    setSafeForgeStatus(null);

    try {
      const extraFallbackHandlers = safeForgeExtraHandlers
        .split(/[\s,;]+/)
        .map((item) => item.trim())
        .filter(Boolean);
      const result = await forgeSafeMirrorDeployment({
        network: selectedAsset.network,
        targetAddress,
        saltNonceStart: safeForgeStart,
        saltNonceEnd: safeForgeEnd,
        setupTo: safeForgeSetupTo || undefined,
        setupData: safeForgeSetupData || "0x",
        extraFallbackHandlers,
      });
      const deployment =
        result?.targetPrediction || result?.ready ? result : result?.deployment;

      if (!deployment) {
        const message = `Safe Forge no encontro coincidencia en ${result.attempts} intento(s). Amplia el rango o agrega setup/fallback handler si World App uso una plantilla distinta.`;
        setSafeForgeStatus({ type: "warning", message });
        showStatus(message, "warning");
        return;
      }

      const updatedAccountState = {
        ...(selectedAsset.accountState ?? {}),
        counterfactualSafe: {
          ...mirror,
          detected: true,
          deploymentRequired: true,
          deployment,
          deploymentError: null,
          requirement:
            "Safe Forge encontro una creacion que predice exactamente la direccion con fondos",
        },
      };

      setAssets((current) =>
        current.map((asset) =>
          asset.chainId === selectedAsset.chainId
            ? { ...asset, accountState: updatedAccountState }
            : asset,
        ),
      );
      setNetworkStates((current) => ({
        ...current,
        [selectedAsset.chainId]: {
          ...(current[selectedAsset.chainId] ?? {}),
          accountKind: updatedAccountState.kind ?? "no-contract",
          accountState: updatedAccountState,
        },
      }));

      const message = deployment.ready
        ? `Safe Forge encontro ruta lista con salt ${deployment.saltNonce}. Ya puedes desplegar Safe y mover si conectas el owner.`
        : `Safe Forge encontro coincidencia con salt ${deployment.saltNonce}, pero falta factory/singleton en la red destino.`;
      setSafeForgeStatus({
        type: deployment.ready ? "success" : "warning",
        message,
      });
      showStatus(message, deployment.ready ? "success" : "warning");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Safe Forge no pudo completar la busqueda";
      setSafeForgeStatus({ type: "error", message });
      showStatus(message, "error");
    } finally {
      if (mountedRef.current) setSafeForgeBusy(false);
    }
  }, [
    safeForgeEnd,
    safeForgeExtraHandlers,
    safeForgeSetupData,
    safeForgeSetupTo,
    safeForgeStart,
    selectedAsset,
    showStatus,
    targetAddress,
  ]);

  const openCounterfactualSafeDeployFlow = useCallback(() => {
    openSendForm();

    if (!selectedAsset) return;

    if (!selectedAssetUsesCounterfactualSafeOwnerSigner) {
      showStatus(
        "Para desplegar la Safe primero importa o conecta la llave owner de World App.",
        "warning",
      );
      return;
    }

    if (!selectedAssetCounterfactualSafeReady) {
      showStatus(
        "RC Wallet detecto una Safe espejo, pero aun falta prediccion exacta o datos de creacion verificables para desplegarla.",
        "warning",
      );
      return;
    }

    if (!isValidEvmAddressInput(recipient)) {
      showStatus(
        "Completa la wallet destino antes de desplegar la Safe y mover fondos.",
        "warning",
      );
      return;
    }

    if (!feeBreakdown) {
      showStatus(
        "Introduce la cantidad que quieres mover antes de desplegar la Safe.",
        "warning",
      );
      return;
    }

    if (RECOVERY_FEE_BPS > 0n && !feeAccepted) {
      showStatus(
        "Acepta la comision visible antes de preparar el despliegue y movimiento.",
        "warning",
      );
      return;
    }

    if (!canSubmitRecovery || sending) return;
    setShowSendConfirm(true);
  }, [
    canSubmitRecovery,
    feeAccepted,
    feeBreakdown,
    openSendForm,
    recipient,
    selectedAsset,
    selectedAssetCounterfactualSafeReady,
    selectedAssetUsesCounterfactualSafeOwnerSigner,
    sending,
    showStatus,
  ]);

  return (
    <main className="page">
      <div className="shell">
        <header className="hero">
          <div className="hero__mark">RC</div>
          <div className="hero__copy">
            <h1>RC Wallet External</h1>
            <p>
              Mueve fondos de tu direccion Worldcoin en Ethereum y otras redes
              EVM cuando existe llave exacta, owner Safe o despliegue Safe
              compatible.
            </p>
          </div>
          <button
            className="button button--install"
            type="button"
            onClick={openInstallDialog}
          >
            {appInstalled ? "App instalada" : "Descargar app"}
          </button>
        </header>

        <Status status={status} />

        {showInstallModal && (
          <div className="modal-backdrop" role="presentation">
            <section
              className="confirm-modal install-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="install-app-title"
            >
              <span className="eyebrow">Descargar app</span>
              <h2 id="install-app-title">RC Wallet para cualquier dispositivo</h2>
              <p>
                Instala RC Wallet External como app en este dispositivo. La
                instalacion conserva la misma version web de Vercel y funciona
                en movil, tablet y computador.
              </p>

              <div className="install-card">
                <span>Dispositivo detectado</span>
                <strong>{installDeviceInfo.label}</strong>
                <small>
                  {appInstalled
                    ? "La app ya parece instalada."
                    : installPromptAvailable
                      ? "Instalacion directa disponible."
                      : "Usa los pasos de instalacion del navegador."}
                </small>
              </div>

              <div className="install-steps">
                <strong>{installDeviceInfo.title}</strong>
                <ol>
                  {installDeviceInfo.instructions.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ol>
              </div>

              <div className="button-row">
                <button
                  className="button button--primary"
                  type="button"
                  onClick={installApp}
                  disabled={appInstalled || !installPromptAvailable}
                >
                  {appInstalled ? "Ya instalada" : "Instalar ahora"}
                </button>
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={copyAppLink}
                >
                  Copiar enlace
                </button>
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => setShowInstallModal(false)}
                >
                  Cerrar
                </button>
              </div>
            </section>
          </div>
        )}

        {tokenScreenOpen && selectedAsset && (
          <section className="token-screen" role="dialog" aria-modal="true">
            <div className="token-screen__topbar">
              <button
                className="button button--secondary"
                type="button"
                onClick={() => setTokenScreenOpen(false)}
              >
                ← Atrás
              </button>
              <button
                className="button button--danger"
                type="button"
                onClick={() => setTokenScreenOpen(false)}
              >
                Cerrar
              </button>
            </div>

            <div className="token-screen__hero">
              <div>
                <span className="eyebrow">{selectedAsset.networkName}</span>
                <h2>{selectedAsset.symbol}</h2>
                <p>
                  Balance disponible: {selectedAsset.displayBalance}{" "}
                  {selectedAsset.symbol}
                </p>
              </div>
              <RecoveryBadge
                asset={selectedAsset}
                movementState={selectedAssetMovementState}
              />
            </div>

            <div className="token-info-grid">
              <div>
                <span>Contrato</span>
                <strong>
                  {selectedAsset.isNative
                    ? "Moneda nativa"
                    : compactAddress(selectedAsset.address)}
                </strong>
              </div>
              <div>
                <span>Cuenta</span>
                <strong>
                  {selectedAsset.accountState?.hasCode
                    ? accountKindLabel(selectedAsset.accountState.kind)
                    : "EOA / sin contrato"}
                </strong>
              </div>
              <div>
                <span>Red</span>
                <strong>{selectedAsset.networkName}</strong>
              </div>
            </div>

            <div className="token-rescue-route">
              <span className="eyebrow">Ruta de rescate</span>
              <strong>{selectedAssetMovementState.label}</strong>
              <p>
                {selectedAssetMovementState.detail}. RC Wallet solo habilita el
                movimiento si la firma corresponde a la direccion con fondos o
                a un owner Safe valido.
              </p>
            </div>

            <div className="reference-links">
              <strong>Información del activo</strong>
              <div className="button-row">
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() =>
                    window.open(
                      explorerAddressUrl(selectedAsset.network, targetAddress),
                      "_blank",
                      "noopener,noreferrer",
                    )
                  }
                >
                  Ver dirección en explorador
                </button>
                {!selectedAsset.isNative && (
                  <button
                    className="button button--secondary"
                    type="button"
                    onClick={() =>
                      window.open(
                        `${selectedAsset.network.explorer}/token/${selectedAsset.address}`,
                        "_blank",
                        "noopener,noreferrer",
                      )
                    }
                  >
                    Ver contrato
                  </button>
                )}
                {selectedTokenLinks.map((link) => (
                  <button
                    className="button button--secondary"
                    type="button"
                    key={link.url}
                    onClick={() =>
                      window.open(link.url, "_blank", "noopener,noreferrer")
                    }
                  >
                    {link.label}
                  </button>
                ))}
              </div>
            </div>

            <button
              className="trade-button trade-button--send"
              type="button"
              onClick={openSendForm}
            >
              Enviar / mover {selectedAsset.symbol}
            </button>
          </section>
        )}

        {showSendConfirm && selectedAsset && feeBreakdown && (
          <div className="modal-backdrop" role="presentation">
            <section
              className="confirm-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="send-confirm-title"
            >
              <span className="eyebrow">Confirmación manual</span>
              <h2 id="send-confirm-title">Enviar / mover fondos</h2>
              <dl>
                <div>
                  <dt>Token</dt>
                  <dd>{selectedAsset.symbol}</dd>
                </div>
                <div>
                  <dt>Red</dt>
                  <dd>{selectedAsset.networkName}</dd>
                </div>
                <div>
                  <dt>Destino</dt>
                  <dd>{compactAddress(recipient)}</dd>
                </div>
                <div>
                  <dt>Cantidad total</dt>
                  <dd>
                    {feeBreakdown.gross} {selectedAsset.symbol}
                  </dd>
                </div>
                <div>
                  <dt>Recibe destino</dt>
                  <dd>
                    {feeBreakdown.recipient} {selectedAsset.symbol}
                  </dd>
                </div>
                {RECOVERY_FEE_BPS > 0n && (
                <div>
                  <dt>Comisión RC</dt>
                  <dd>
                    {feeBreakdown.fee} {selectedAsset.symbol}
                  </dd>
                </div>
                )}
                <div>
                  <dt>Firma requerida</dt>
                  <dd>{externalExecutionRoute.signerLabel}</dd>
                </div>
                <div>
                  <dt>Ruta</dt>
                  <dd>{externalExecutionRoute.label}</dd>
                </div>
                <div>
                  <dt>Fee de red</dt>
                  <dd>La wallet lo calcula antes de firmar</dd>
                </div>
              </dl>
              <p>
                RC Wallet no mueve fondos sin tu firma. Revisa red, destino y
                monto antes de continuar.
              </p>
              <div className="button-row">
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => setShowSendConfirm(false)}
                >
                  Cancelar
                </button>
                <button
                  className="button button--primary"
                  type="button"
                  disabled={sending}
                  onClick={async () => {
                    if (externalExecutionRoute.id === "world-minikit") {
                      const confirmed = await confirmWorldAction(
                        "envío de activos",
                      );
                      if (!confirmed) return;
                    }
                    setShowSendConfirm(false);
                    void send();
                  }}
                >
                  Confirmar y firmar
                </button>
              </div>
            </section>
          </div>
        )}

        {showHistoryModal && (
          <div className="modal-backdrop" role="presentation">
            <section
              className="confirm-modal history-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="transfer-history-title"
            >
              <span className="eyebrow">Historial local</span>
              <h2 id="transfer-history-title">Transferencias</h2>
              {transferHistory.length ? (
                <div className="history-list">
                  {transferHistory.map((item, index) => (
                    <article
                      className="history-item"
                      key={`${item.userOpHash || item.hash || item.createdAt}-${index}`}
                    >
                      <div>
                        <strong>
                          {item.amount} {item.token || "TOKEN"}
                        </strong>
                        <span>
                          {item.network?.name || "Red"} ·{" "}
                          {item.pending ? "Pendiente" : "Confirmada"}
                        </span>
                      </div>
                      <small>
                        Destino: {item.recipient ? compactAddress(item.recipient) : "N/D"}
                      </small>
                      <small>
                        {item.createdAt
                          ? new Date(item.createdAt).toLocaleString()
                          : "Fecha local no disponible"}
                      </small>
                      {item.hash ? (
                        <a
                          href={explorerTransactionUrl(item.network, item.hash)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Abrir explorer
                        </a>
                      ) : item.userOpHash ? (
                        <code>{item.userOpHash}</code>
                      ) : null}
                    </article>
                  ))}
                </div>
              ) : (
                <p className="empty">
                  Aún no hay transferencias guardadas en este dispositivo.
                </p>
              )}
              <div className="button-row">
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => setShowHistoryModal(false)}
                >
                  Cerrar
                </button>
              </div>
            </section>
          </div>
        )}

        <section className={viewClass("home")}>
          <section className="home-wallet-card">
            <span className="eyebrow">Rescate principal</span>
            <h2>{targetAddress ? compactAddress(targetAddress) : "RC Wallet External"}</h2>
            <p>
              {targetAddress
                ? "Direccion Worldcoin activa. La app valida llave exacta, owner Safe o despliegue Safe compatible antes de mover."
                : "Herramienta dedicada a rescatar fondos de direcciones Worldcoin en Ethereum y otras redes EVM."}
            </p>
            <div className="home-login-actions">
              <button
                className="button button--secondary"
                type="button"
                disabled={externalConnecting}
                onClick={connectBestExternalWallet}
              >
                {externalConnecting
                  ? "Conectando firmante..."
                  : "Conectar owner externo"}
              </button>
              <button
                className="button button--secondary"
                type="button"
                onClick={() =>
                  window.open(WORLD_MINI_APP_URL, "_blank", "noopener,noreferrer")
                }
              >
                Abrir Mini App Worldcoin
              </button>
            </div>
            <div className="local-key-box local-key-box--home">
              <strong>Importar direccion Worldcoin</strong>
              <p>
                Pega la direccion Worldcoin/World App con fondos y la llave
                exportada por World App. RC Wallet deriva el firmante real y
                verifica si puede mover directo o como owner Safe.
              </p>
              <input
                className="input"
                value={privateKeyTargetAddressInput}
                onChange={(event) =>
                  setPrivateKeyTargetAddressInput(event.target.value)
                }
                placeholder="Direccion Worldcoin / World App con fondos"
                spellCheck="false"
              />
              <div className="input-row">
                <input
                  className="input"
                  type="password"
                  value={privateKeyInput}
                  onChange={(event) => setPrivateKeyInput(event.target.value)}
                  placeholder="0x..."
                  autoComplete="off"
                  spellCheck="false"
                />
                <button
                  className="button button--primary"
                  type="button"
                  disabled={
                    externalConnecting ||
                    !privateKeyInput.trim() ||
                    !privateKeyTargetAddressInput.trim()
                  }
                  onClick={connectPrivateKeySigner}
                >
                  Importar Worldcoin
                </button>
              </div>
            </div>
            {connectedExternalAddress && (
              <p className={externalMatches ? "match" : "mismatch"}>
                Externa: {compactAddress(connectedExternalAddress)}
              </p>
            )}
            <RescueMissionPanel
              targetAddress={targetAddress}
              connectedExternalAddress={connectedExternalAddress}
              externalConnectionName={externalConnectionName}
              externalMatches={externalMatches}
              assets={assets}
              scanning={scanning}
              selectedAsset={selectedAsset}
              movementState={selectedAssetMovementState}
              onOpenAddress={() => setActiveTab("tools")}
              onScan={scan}
              onOpenTokens={() => setActiveTab("tokens")}
              onOpenMove={openSendForm}
              onDisconnect={disconnectExternal}
            />
            <div className="quick-actions">
              <button
                className="quick-action"
                type="button"
                onClick={() => setActiveTab("tools")}
              >
                Direccion
              </button>
              <button
                className="quick-action"
                type="button"
                onClick={() => {
                  setActiveTab("tokens");
                  if (targetAddress) void scan();
                }}
                disabled={!targetAddress || scanning}
              >
                Escanear
              </button>
              <button
                className="quick-action"
                type="button"
                onClick={openSendForm}
                disabled={!selectedAsset}
              >
                Mover
              </button>
              <button
                className="quick-action quick-action--primary"
                type="button"
                onClick={() => setShowInstallModal(true)}
              >
                Descargar app
              </button>
            </div>
          </section>

        <section className="exchange-dashboard">
          <div className="metric-card metric-card--hero">
            <span>Fondos externos</span>
            <strong>{portfolioSummary.externalAssets}</strong>
            <small>activos fuera de World Chain</small>
          </div>
          <div className="metric-card">
            <span>Redes online</span>
            <strong>{portfolioSummary.onlineNetworks}</strong>
            <small>RPC fallback activo</small>
          </div>
          <div className="metric-card">
            <span>Total detectado</span>
            <strong>{portfolioSummary.totalAssets}</strong>
            <small>World Chain queda secundario</small>
          </div>
          {RECOVERY_FEE_BPS > 0n && (
          <div className="metric-card metric-card--gold">
            <span>Comisión de movimiento</span>
            <strong>{percentFromBps(RECOVERY_FEE_BPS)}%</strong>
            <small>visible antes de firmar</small>
          </div>
          )}
        </section>

          <section className="card token-summary-card">
            <div className="section-heading">
              <div>
                <span className="eyebrow">Resumen</span>
                <h2>Fondos externos principales</h2>
              </div>
              <button
                className="button button--secondary"
                type="button"
                onClick={() => setActiveTab("tokens")}
              >
                Ver todos
              </button>
            </div>
            {homeAssets.length === 0 ? (
              <p className="empty">
                Aún no hay activos detectados. Conecta o analiza una dirección
                y ejecuta el escáner multicadena.
              </p>
            ) : (
              <div className="mini-asset-list">
                {homeAssets.map((asset) => (
                  <button
                    className="mini-asset"
                    type="button"
                    key={asset.id}
                    onClick={() => openTokenScreen(asset.id)}
                  >
                    <span className="token-logo">{asset.symbol.slice(0, 3)}</span>
                    <span>
                      <strong>{asset.symbol}</strong>
                      <small>{asset.networkName}</small>
                    </span>
                    <b>{asset.displayBalance}</b>
                  </button>
                ))}
              </div>
            )}
          </section>

        </section>

        <section className={viewClass("tools")}>
        <section className="card">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Paso 1</span>
              <h2>Dirección que contiene los fondos</h2>
            </div>
            {authenticated && (
              <span className="badge badge--green">SIWE verificado</span>
            )}
          </div>

          <div className="button-row">
            <button
              className="button button--secondary"
              type="button"
              onClick={() =>
                window.open(WORLD_MINI_APP_URL, "_blank", "noopener,noreferrer")
              }
            >
              Abrir Mini App Worldcoin
            </button>
            <button
              className="button button--secondary"
              type="button"
              onClick={loginWithWorldApp}
            >
              Verificar World ID opcional
            </button>
          </div>

          <div className="separator">
            <span>o analizar manualmente</span>
          </div>

          <div className="input-row">
            <input
              className="input"
              value={manualAddress}
              onChange={(event) => setManualAddress(event.target.value)}
              placeholder="0x…"
              spellCheck="false"
            />
            <button
              className="button button--secondary"
              type="button"
              onClick={useManualAddress}
            >
              Analizar
            </button>
          </div>

          <div className="local-key-box">
            <strong>Importar direccion Worldcoin</strong>
            <p>
              Esta app esta dedicada a rescate Worldcoin: importa la direccion
              con fondos y usa la llave exportada solo como firmante local.
            </p>
            <input
              className="input"
              value={privateKeyTargetAddressInput}
              onChange={(event) =>
                setPrivateKeyTargetAddressInput(event.target.value)
              }
              placeholder="Direccion Worldcoin / World App con fondos"
              spellCheck="false"
            />
            <div className="input-row">
              <input
                className="input"
                type="password"
                value={privateKeyInput}
                onChange={(event) => setPrivateKeyInput(event.target.value)}
                placeholder="0x..."
                autoComplete="off"
                spellCheck="false"
              />
              <button
                className="button button--primary"
                type="button"
                disabled={
                  externalConnecting ||
                  !privateKeyInput.trim() ||
                  !privateKeyTargetAddressInput.trim()
                }
                onClick={connectPrivateKeySigner}
              >
                Importar Worldcoin
              </button>
            </div>
          </div>

          {targetAddress && (
            <div className="address-box">
              <span>Dirección activa</span>
              <strong>{targetAddress}</strong>
              <div className="receive-qr">
                <img
                  src={qrImageUrl(targetAddress)}
                  alt="QR de la dirección RC Wallet"
                  loading="lazy"
                />
                <div>
                  <b>Recibir fondos</b>
                  <p>
                    Comparte este QR para recibir en la misma dirección EVM.
                    Antes de enviar, confirma la red correcta: World Chain,
                    Ethereum, Optimism, Base o BNB Chain.
                  </p>
                  <button
                    className="button button--secondary"
                    type="button"
                    onClick={async () => {
                      try {
                        await copyTextToClipboard(targetAddress);
                        showStatus("Dirección copiada.", "success");
                      } catch (error) {
                        showStatus(
                          error instanceof Error
                            ? error.message
                            : "No se pudo copiar la dirección",
                          "error",
                        );
                      }
                    }}
                  >
                    Copiar dirección
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="seed-warning">
            <strong>RC Wallet External trabaja fuera de World App.</strong>
            <p>
              Importa la direccion Worldcoin con la llave exportada por World
              App y mueve fondos encontrados en redes externas distintas a
              World Chain.
            </p>
          </div>
        </section>
        </section>

        <section className={viewClass("tools")}>
          <section className="card">
            <div className="section-heading">
              <div>
                <span className="eyebrow">Historial</span>
                <h2>Última operación local</h2>
              </div>
              <button
                className="button button--secondary"
                type="button"
                onClick={() => setShowHistoryModal(true)}
              >
                Ver historial
              </button>
            </div>
            {lastTransaction ? (
              <div className="transaction-result">
                <strong>
                  {lastTransaction.pending
                    ? "Operación pendiente"
                    : "Operación confirmada"}
                </strong>
                <span>{lastTransaction.network?.name}</span>
                {lastTransaction.hash ? (
                  <a
                    href={explorerTransactionUrl(
                      lastTransaction.network,
                      lastTransaction.hash,
                    )}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Abrir explorer
                  </a>
                ) : (
                  <code>{lastTransaction.userOpHash}</code>
                )}
              </div>
            ) : (
              <p className="empty">
                Aún no hay operaciones en esta sesión. Cuando envíes o muevas
                activos, el último resultado aparecerá aquí.
              </p>
            )}
          </section>
        </section>

        {!targetAddress && (
          <section className={viewClass("tokens")}>
            <section className="card">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">Tokens</span>
                  <h2>Conecta una dirección para escanear</h2>
                </div>
              </div>
              <p className="empty">
                RC Wallet necesita la dirección EVM de World App o una
                dirección manual para detectar WLD, PUF, GOLD, SUSHI, RCOL,
                MADS, GoldenPUF, USDC, USDT, WETH, WBTC y contratos ERC-20
                personalizados.
              </p>
              <button
                className="button button--primary"
                type="button"
                onClick={() => setActiveTab("tools")}
              >
                Conectar / analizar dirección
              </button>
            </section>
          </section>
        )}

        {targetAddress && (
          <section className={viewClass("tokens")}>
            <section className="card">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">Paso 2</span>
                  <h2>Escáner multicadena</h2>
                </div>
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={scan}
                  disabled={scanning}
                >
                  {scanning ? "Escaneando…" : "Escanear de nuevo"}
                </button>
              </div>

              <div className="network-grid">
                {NETWORKS.map((network) => {
                  const state = networkStates[network.chainId];
                  return (
                    <div className="network-pill" key={network.chainId}>
                      <span
                        className={`dot ${
                          state?.status === "online"
                            ? "dot--green"
                            : state?.status === "offline"
                              ? "dot--red"
                              : ""
                        }`}
                      />
                      <span>{network.name}</span>
                      {state?.accountKind === "contract" && (
                        <small>contrato</small>
                      )}
                    </div>
                  );
                })}
              </div>

              <details className="details">
                <summary>Agregar contrato ERC-20 personalizado</summary>
                <div className="custom-token-form">
                  <select
                    className="input"
                    value={customChainId}
                    onChange={(event) =>
                      setCustomChainId(Number(event.target.value))
                    }
                  >
                    {NETWORKS.map((network) => (
                      <option value={network.chainId} key={network.chainId}>
                        {network.name}
                      </option>
                    ))}
                  </select>
                  <input
                    className="input"
                    value={customTokenAddress}
                    onChange={(event) =>
                      setCustomTokenAddress(event.target.value)
                    }
                    placeholder="Contrato 0x…"
                    spellCheck="false"
                  />
                  <button
                    className="button button--secondary"
                    type="button"
                    onClick={addCustomToken}
                  >
                    Agregar
                  </button>
                </div>
              </details>
              <p className="fine-print">
                PUF y GoldenPUF se pueden escanear como ERC-20 personalizado
                cuando tengas el contrato verificado. RC Wallet no
                inventa direcciones de tokens.
              </p>
            </section>

            <section className="card">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">Paso 3</span>
                  <h2>Tokens disponibles para mover</h2>
                </div>
                <span className="asset-count">{assets.length}</span>
              </div>

              <input
                className="input input--search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Buscar token, red o contrato"
              />

              <select
                className="input input--search"
                value={networkFilter}
                onChange={(event) => setNetworkFilter(event.target.value)}
              >
                <option value="all">Todas las redes</option>
                {NETWORKS.filter((network) => !network.testnet).map((network) => (
                  <option value={String(network.chainId)} key={network.chainId}>
                    {network.name}
                  </option>
                ))}
              </select>

              {filteredAssets.length === 0 ? (
                <p className="empty">
                  No hay balances entre las monedas y contratos configurados.
                </p>
              ) : (
                <div className="asset-list">
                  {filteredAssets.map((asset) => {
                    const selected = asset.id === selectedAssetId;
                    const movementState = getAssetMovementState({
                      asset,
                      targetAddress,
                      connectedExternalAddress,
                    });
                    return (
                      <article
                        className={`asset ${selected ? "asset--selected" : ""}`}
                        key={asset.id}
                      >
                        <button
                          className="asset__main"
                          type="button"
                          onClick={() => openTokenScreen(asset.id)}
                        >
                          <span className="token-logo">
                            {asset.symbol.slice(0, 3)}
                          </span>
                          <div>
                            <span className="asset__network">
                              {asset.networkName}
                            </span>
                            <strong>
                              {asset.displayBalance} {asset.symbol}
                            </strong>
                            <small>
                              {asset.isNative
                                ? "Moneda nativa"
                                : compactAddress(asset.address)}
                            </small>
                            <small>Valor estimado: {estimateAssetValue(asset)}</small>
                          </div>
                        </button>
                        <div className="asset__actions">
                          <RecoveryBadge
                            asset={asset}
                            movementState={movementState}
                          />
                          <button
                            className="asset__move"
                            type="button"
                            onClick={() => openSendFormForAsset(asset.id)}
                          >
                            Mover
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}

              <div className="button-row">
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={copyRecoveryReport}
                >
                  Copiar informe
                </button>
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() =>
                    window.open(
                      explorerAddressUrl(NETWORKS[0], targetAddress),
                      "_blank",
                      "noopener,noreferrer",
                    )
                  }
                >
                  Ver en Worldscan
                </button>
              </div>
            </section>
          </section>
        )}

        {selectedAsset && (
          <>
          <section className={viewClass("markets")}>
          <section className="card market-card">
            <div className="section-heading">
              <div>
                <span className="eyebrow">Mercado en tiempo real</span>
                <h2>
                  {selectedAsset.symbol}
                  {market?.quoteToken?.symbol
                    ? ` / ${market.quoteToken.symbol}`
                    : ""}
                </h2>
              </div>
              {market && (
                <span
                  className={`market-change ${
                    market.change24h >= 0
                      ? "market-change--up"
                      : "market-change--down"
                  }`}
                >
                  {market.change24h >= 0 ? "+" : ""}
                  {market.change24h.toFixed(2)}%
                </span>
              )}
            </div>

            {marketLoading && !market && (
              <p className="empty">Buscando el par con mayor liquidez…</p>
            )}

            {marketError && !market && (
              <div className="market-unavailable">
                <strong>Mercado no disponible</strong>
                <span>{marketError}</span>
              </div>
            )}

            {market && (
              <>
                <div className="market-stats">
                  <div>
                    <span>Precio</span>
                    <strong>
                      {market.priceUsd
                        ? formatUsd(market.priceUsd, 8)
                        : "—"}
                    </strong>
                  </div>
                  <div>
                    <span>Volumen 24h</span>
                    <strong>{formatCompactUsd(market.volume24h)}</strong>
                  </div>
                  <div>
                    <span>Liquidez</span>
                    <strong>{formatCompactUsd(market.liquidityUsd)}</strong>
                  </div>
                  <div>
                    <span>Market cap</span>
                    <strong>
                      {formatCompactUsd(market.marketCap || market.fdv)}
                    </strong>
                  </div>
                </div>

                <div className="chart-frame">
                  <iframe
                    key={market.pairAddress}
                    title={`Gráfica ${selectedAsset.symbol}`}
                    src={market.chartUrl}
                    loading="lazy"
                    sandbox="allow-scripts allow-same-origin allow-popups"
                    allowFullScreen
                  />
                </div>
              </>
            )}

            <p className="market-disclaimer">
              Mercado solo informativo. La funcion principal de RC Wallet
              External es mover fondos desde la direccion Worldcoin en Ethereum
              y redes externas cuando exista firma exacta, owner Safe valido o
              despliegue Safe compatible.
            </p>

            <button
              className="trade-button trade-button--send"
              type="button"
              onClick={openSendForm}
            >
              Mover {selectedAsset.symbol}
            </button>
          </section>
          </section>

          <section className={viewClass("recovery")}>
          <RescueMissionPanel
            targetAddress={targetAddress}
            connectedExternalAddress={connectedExternalAddress}
            externalConnectionName={externalConnectionName}
            externalMatches={externalMatches}
            assets={assets}
            scanning={scanning}
            selectedAsset={selectedAsset}
            movementState={selectedAssetMovementState}
            onOpenAddress={() => setActiveTab("tools")}
            onScan={scan}
            onOpenTokens={() => setActiveTab("tokens")}
            onOpenMove={openSendForm}
            onDisconnect={disconnectExternal}
          />
          <section className="card diagnostic-card">
            <div className="section-heading">
              <div>
                <span className="eyebrow">Diagnóstico real por red</span>
                <h2>Firma, gas, Safe y ERC-4337</h2>
              </div>
              <span className="badge badge--blue">On-chain</span>
            </div>

            <p className="link-copy">
              RC Wallet revisa cada red con lecturas reales. Si existe ruta
              firmable, muestra la condición exacta que falta para mover.
            </p>

            <div className="diagnostic-grid">
              {recoveryNetworkDiagnostics.map((diagnostic) => (
                <article
                  className={`diagnostic-network ${
                    diagnostic.hasFunds ? "diagnostic-network--funds" : ""
                  }`}
                  key={diagnostic.network.chainId}
                >
                  <div className="diagnostic-network__head">
                    <div>
                      <strong>{diagnostic.network.name}</strong>
                      <span>{diagnostic.accountLabel}</span>
                    </div>
                    <span
                      className={`dot ${
                        diagnostic.state?.status === "online"
                          ? "dot--green"
                          : "dot--amber"
                      }`}
                    />
                  </div>

                  <dl>
                    <div>
                      <dt>Fondos</dt>
                      <dd>{diagnostic.assetCount}</dd>
                    </div>
                    <div>
                      <dt>Gas</dt>
                      <dd>
                        {diagnostic.accountState?.nativeGas
                          ? `${diagnostic.accountState.nativeGas.displayBalance} ${diagnostic.network.symbol}`
                          : "No leído"}
                      </dd>
                    </div>
                    <div>
                      <dt>Ruta</dt>
                      <dd>{diagnostic.routeSummary}</dd>
                    </div>
                  </dl>

                  <div className="capability-row">
                    <span
                      className={
                        diagnostic.safeDetected ||
                        diagnostic.counterfactualSafeDetected
                          ? "capability capability--on"
                          : "capability"
                      }
                    >
                      Safe
                    </span>
                    <span
                      className={
                        diagnostic.erc1271Supported
                          ? "capability capability--on"
                          : "capability"
                      }
                    >
                      EIP-1271
                    </span>
                    <span
                      className={
                        diagnostic.entryPointAvailable
                          ? "capability capability--on"
                          : "capability"
                      }
                    >
                      ERC-4337
                    </span>
                  </div>

                  {diagnostic.accountState?.safe?.detected && (
                    <p className="diagnostic-note">
                      Safe {diagnostic.accountState.safe.version}:{" "}
                      {diagnostic.accountState.safe.threshold}/
                      {diagnostic.accountState.safe.owners.length} firmas.
                    </p>
                  )}

                  {diagnostic.accountState?.counterfactualSafe?.detected && (
                    <p className="diagnostic-note">
                      Safe detectada en{" "}
                      {diagnostic.accountState.counterfactualSafe.sourceNetworkName};{" "}
                      {diagnostic.accountState.counterfactualSafe.deployment?.ready
                        ? `lista para desplegar en ${diagnostic.network.name}.`
                        : `falta recuperar o validar la creacion para ${diagnostic.network.name}.`}
                    </p>
                  )}

                  {diagnostic.state?.error && (
                    <p className="warning-copy">{diagnostic.state.error}</p>
                  )}
                </article>
              ))}
            </div>
          </section>

          <section
            className="card card--recovery"
            id="send-funds"
            ref={sendSectionRef}
          >
            <div className="section-heading">
              <div>
                <span className="eyebrow">Paso 4</span>
                <h2>
                  Enviar / mover {selectedAsset.symbol} en{" "}
                  {selectedAsset.networkName}
                </h2>
              </div>
              <RecoveryBadge
                asset={selectedAsset}
                movementState={selectedAssetMovementState}
              />
            </div>

            {selectedAsset && (
              <div
                className={`execution-route execution-route--${externalExecutionRoute.level}`}
              >
                <div>
                  <span className="eyebrow">Ruta de ejecucion externa</span>
                  <strong>{externalExecutionRoute.label}</strong>
                  <p>{externalExecutionRoute.reason}</p>
                </div>
                <dl>
                  <div>
                    <dt>Accion</dt>
                    <dd>{externalExecutionRoute.actionLabel}</dd>
                  </div>
                  <div>
                    <dt>Firma</dt>
                    <dd>{externalExecutionRoute.signerLabel}</dd>
                  </div>
                  <div>
                    <dt>Gas</dt>
                    <dd>{externalExecutionRoute.gasLabel}</dd>
                  </div>
                </dl>
              </div>
            )}

            {selectedRecoveryDiagnosis && (
              <div
                className={`rescue-diagnosis rescue-diagnosis--${selectedRecoveryDiagnosis.level}`}
              >
                <div>
                  <span className="eyebrow">Diagnóstico de firma</span>
                  <strong>{selectedRecoveryDiagnosis.title}</strong>
                  <p>{selectedRecoveryDiagnosis.action}</p>
                  {selectedRecoveryDiagnosis.requirements?.length > 0 && (
                    <ul className="requirement-list">
                      {selectedRecoveryDiagnosis.requirements.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  )}
                </div>
                <dl>
                  <div>
                    <dt>Ruta</dt>
                    <dd>{selectedRecoveryDiagnosis.route}</dd>
                  </div>
                  <div>
                    <dt>Gas</dt>
                    <dd>
                      {selectedAsset.isNative
                        ? "El gas sale del mismo balance"
                        : selectedNativeGasAsset
                          ? `${selectedNativeGasAsset.displayBalance} ${selectedNativeGasAsset.symbol}`
                          : `0 ${selectedAsset.network.symbol}`}
                    </dd>
                  </div>
                  <div>
                    <dt>Cuenta</dt>
                    <dd>
                      {selectedAsset.accountState?.hasCode
                        ? accountKindLabel(selectedAsset.accountState.kind)
                        : "EOA o sin contrato"}
                    </dd>
                  </div>
                </dl>
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={copySelectedRescuePlan}
                >
                  Copiar ruta de movimiento
                </button>
              </div>
            )}

            {selectedAsset && (
              <SafeRescuePanel
                asset={selectedAsset}
                targetAddress={targetAddress}
                connectedExternalAddress={connectedExternalAddress}
                onDeploySafeMirror={openCounterfactualSafeDeployFlow}
                onCopyPlan={copySelectedRescuePlan}
                onCopySafeUiDraft={copySafeUiTransactionDraft}
                onConfirmSafeTx={confirmSelectedSafeTransaction}
                onExecuteSafeTx={executeSelectedSafeTransaction}
                onInspectSafeTx={inspectSelectedSafeTransaction}
                onProposeSafeTx={proposeSelectedSafeTransaction}
                safeTxHashInput={safeTxHashInput}
                onSafeTxHashChange={setSafeTxHashInput}
              />
            )}

            {selectedAsset?.accountState?.counterfactualSafe?.detected && (
              <div className="manual-safe-lab safe-forge-lab">
                <div>
                  <span className="eyebrow">Ruta experimental segura</span>
                  <strong>Safe Forge auto</strong>
                  <p>
                    RC Wallet lee la Safe viva en World Chain, reconstruye
                    initializers comunes con owners reales y busca un salt nonce
                    que produzca exactamente{" "}
                    <code>{compactAddress(targetAddress)}</code>. No envia
                    transacciones durante la busqueda.
                  </p>
                </div>
                <div className="manual-safe-grid">
                  <label className="label">
                    Salt inicio
                    <input
                      className="input"
                      value={safeForgeStart}
                      onChange={(event) => setSafeForgeStart(event.target.value)}
                      placeholder="0"
                      spellCheck="false"
                    />
                  </label>
                  <label className="label">
                    Salt fin
                    <input
                      className="input"
                      value={safeForgeEnd}
                      onChange={(event) => setSafeForgeEnd(event.target.value)}
                      placeholder="5000"
                      spellCheck="false"
                    />
                  </label>
                  <label className="label">
                    Setup to
                    <input
                      className="input"
                      value={safeForgeSetupTo}
                      onChange={(event) =>
                        setSafeForgeSetupTo(event.target.value)
                      }
                      placeholder="Opcional"
                      spellCheck="false"
                    />
                  </label>
                  <label className="label">
                    Setup data
                    <input
                      className="input"
                      value={safeForgeSetupData}
                      onChange={(event) =>
                        setSafeForgeSetupData(event.target.value)
                      }
                      placeholder="0x"
                      spellCheck="false"
                    />
                  </label>
                  <label className="label manual-safe-grid__wide">
                    Fallback handlers extra
                    <input
                      className="input"
                      value={safeForgeExtraHandlers}
                      onChange={(event) =>
                        setSafeForgeExtraHandlers(event.target.value)
                      }
                      placeholder="0x... separados por coma o espacio"
                      spellCheck="false"
                    />
                  </label>
                </div>
                <button
                  className="button button--deploy-safe"
                  type="button"
                  disabled={safeForgeBusy}
                  onClick={runSafeForgeSearch}
                >
                  {safeForgeBusy
                    ? "Buscando despliegue..."
                    : "Buscar despliegue Safe"}
                </button>
                {safeForgeStatus && (
                  <p className={`manual-safe-status manual-safe-status--${safeForgeStatus.type}`}>
                    {safeForgeStatus.message}
                  </p>
                )}
              </div>
            )}

            {selectedAsset?.accountState?.counterfactualSafe?.detected && (
              <div className="manual-safe-lab">
                <div>
                  <span className="eyebrow">Ruta avanzada</span>
                  <strong>Safe manual deploy</strong>
                  <p>
                    Si la busqueda automatica no encontro la creacion Safe,
                    pega los datos originales. RC Wallet solo activa el
                    despliegue si la prediccion coincide exactamente con{" "}
                    <code>{compactAddress(targetAddress)}</code>.
                  </p>
                </div>
                <div className="manual-safe-grid">
                  <label className="label">
                    Metodo
                    <select
                      className="input"
                      value={manualSafeMethod}
                      onChange={(event) =>
                        setManualSafeMethod(event.target.value)
                      }
                    >
                      <option value="createProxyWithNonce">
                        createProxyWithNonce
                      </option>
                      <option value="createProxyWithNonceL2">
                        createProxyWithNonceL2
                      </option>
                      <option value="createProxyWithCallback">
                        createProxyWithCallback
                      </option>
                    </select>
                  </label>
                  <label className="label">
                    Factory
                    <input
                      className="input"
                      value={manualSafeFactory}
                      onChange={(event) =>
                        setManualSafeFactory(event.target.value)
                      }
                      placeholder="0x..."
                      spellCheck="false"
                    />
                  </label>
                  <label className="label">
                    Singleton
                    <input
                      className="input"
                      value={manualSafeSingleton}
                      onChange={(event) =>
                        setManualSafeSingleton(event.target.value)
                      }
                      placeholder="0x..."
                      spellCheck="false"
                    />
                  </label>
                  <label className="label manual-safe-grid__wide">
                    Initializer
                    <textarea
                      className="input manual-safe-textarea"
                      value={manualSafeInitializer}
                      onChange={(event) =>
                        setManualSafeInitializer(event.target.value)
                      }
                      placeholder="0x..."
                      spellCheck="false"
                    />
                  </label>
                  <label className="label">
                    Salt nonce
                    <input
                      className="input"
                      value={manualSafeSaltNonce}
                      onChange={(event) =>
                        setManualSafeSaltNonce(event.target.value)
                      }
                      placeholder="0"
                      spellCheck="false"
                    />
                  </label>
                  <label className="label">
                    Callback
                    <input
                      className="input"
                      value={manualSafeCallback}
                      onChange={(event) =>
                        setManualSafeCallback(event.target.value)
                      }
                      placeholder="Solo si aplica"
                      spellCheck="false"
                    />
                  </label>
                </div>
                <button
                  className="button button--deploy-safe"
                  type="button"
                  disabled={manualSafeBusy}
                  onClick={applyManualSafeMirrorDeployment}
                >
                  {manualSafeBusy
                    ? "Validando Safe..."
                    : "Validar ruta Safe manual"}
                </button>
                {manualSafeStatus && (
                  <p className={`manual-safe-status manual-safe-status--${manualSafeStatus.type}`}>
                    {manualSafeStatus.message}
                  </p>
                )}
              </div>
            )}

            {selectedAsset && (
              <div className="recovery-explanation">
                <strong>
                  RC Wallet valida autoridad real antes de mover.
                </strong>
                <p>
                  Para esta red se necesita llave exacta de{" "}
                  <code>{compactAddress(targetAddress)}</code>, owner Safe
                  valido o una Safe espejo desplegable con prediccion exacta.
                </p>
                <div className="local-key-box">
                  <strong>Importar direccion Worldcoin</strong>
                  <p>
                    Pega la direccion Worldcoin que contiene los fondos y la
                    llave exportada por World App. RC Wallet usa esa direccion
                    como origen y la llave solo como firmante.
                  </p>
                  <input
                    className="input"
                    value={privateKeyTargetAddressInput}
                    onChange={(event) =>
                      setPrivateKeyTargetAddressInput(event.target.value)
                    }
                    placeholder="Direccion Worldcoin / World App con fondos"
                    spellCheck="false"
                  />
                  <div className="input-row">
                    <input
                      className="input"
                      type="password"
                      value={privateKeyInput}
                      onChange={(event) =>
                        setPrivateKeyInput(event.target.value)
                      }
                      placeholder="0x..."
                      autoComplete="off"
                      spellCheck="false"
                    />
                    <button
                      className="button button--secondary"
                      type="button"
                      disabled={
                        externalConnecting ||
                        !privateKeyInput.trim() ||
                        !privateKeyTargetAddressInput.trim()
                      }
                      onClick={connectPrivateKeySigner}
                    >
                      Importar Worldcoin
                    </button>
                  </div>
                </div>
                <div className="wallet-connectors">
                  <button
                    className="button button--secondary"
                    type="button"
                    disabled={externalConnecting}
                    onClick={connectBestExternalWallet}
                  >
                    {walletConnectConfigured
                      ? "Conectar por WalletConnect"
                      : "Conectar wallet del navegador"}
                  </button>
                  {walletConnectConfigured && (
                    <button
                      className="button button--secondary"
                      type="button"
                      disabled={externalConnecting}
                      onClick={() => connectExternal("injected")}
                    >
                      Wallet del navegador / extensión
                    </button>
                  )}
                  {connectedExternalAddress && (
                    <button
                      className="button button--danger"
                      type="button"
                      onClick={disconnectExternal}
                    >
                      Desconectar
                    </button>
                  )}
                </div>
                {!walletConnectConfigured && (
                  <p className="warning-copy">
                    Para conectar wallets moviles por WalletConnect configura
                    <code> VITE_REOWN_PROJECT_ID</code> en Vercel. Sin eso solo
                    funcionara una wallet inyectada dentro del navegador.
                  </p>
                )}
                {connectedExternalAddress && (
                  <p className={externalMatches ? "match" : "mismatch"}>
                    {externalConnectionName}: {connectedExternalAddress}
                  </p>
                )}
                <div className="gas-payer-box">
                  <strong>Pagador de gas externo</strong>
                  <p>
                    Para Safe, la llave World App puede firmar como owner y una
                    wallet distinta puede pagar gas para desplegar o ejecutar en
                    esta red.
                  </p>
                  <div className="wallet-connectors">
                    <button
                      className="button button--secondary"
                      type="button"
                      disabled={gasPayerConnecting}
                      onClick={() => connectGasPayerWallet("injected")}
                    >
                      Conectar pagador del navegador
                    </button>
                    {walletConnectConfigured && (
                      <button
                        className="button button--secondary"
                        type="button"
                        disabled={gasPayerConnecting}
                        onClick={() => connectGasPayerWallet("walletconnect")}
                      >
                        Pagador por WalletConnect
                      </button>
                    )}
                    {gasPayerAddress && (
                      <button
                        className="button button--danger"
                        type="button"
                        onClick={disconnectGasPayerWallet}
                      >
                        Quitar pagador
                      </button>
                    )}
                  </div>
                  {gasPayerAddress && (
                    <p className="match">
                      {gasPayerName || "Pagador"}: {gasPayerAddress}
                    </p>
                  )}
                </div>
                {selectedAsset.accountState?.hasCode && (
                  <p className="warning-copy">
                    La dirección tiene bytecode en esta red. Es una cuenta de
                    contrato y requiere sus propietarios o módulos originales;
                    conectar una EOA distinta no sirve.
                  </p>
                )}
              </div>
            )}

            <label className="label" htmlFor="recipient">
              Wallet receptora
            </label>
            <input
              id="recipient"
              className="input"
              value={recipient}
              onChange={(event) => setRecipient(event.target.value)}
              placeholder="0x…"
              spellCheck="false"
            />
            <div className="qr-actions">
              <button
                className="button button--secondary"
                type="button"
                onClick={qrScanning ? stopQrScanner : startQrScanner}
              >
                {qrScanning ? "Detener escáner QR" : "Escanear QR de destino"}
              </button>
              {recipient && (
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => setRecipient("")}
                >
                  Limpiar destino
                </button>
              )}
            </div>

            {(qrScanning || qrScannerError) && (
              <div className="qr-scanner">
                {qrScanning && (
                  <video
                    ref={qrVideoRef}
                    muted
                    playsInline
                    aria-label="Escáner QR"
                  />
                )}
                {qrScannerError && (
                  <p className="warning-copy">{qrScannerError}</p>
                )}
                <small>
                  El QR debe contener una dirección EVM. RC Wallet no guarda
                  imágenes ni video de la cámara.
                </small>
              </div>
            )}

            <label className="label" htmlFor="amount">
              Cantidad total a mover
            </label>
            <div className="input-row">
              <input
                id="amount"
                className="input"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="0.0"
              />
              <button
                className="button button--secondary"
                type="button"
                onClick={() => {
                  if (selectedAsset.isNative) {
                    showStatus(
                      "Para moneda nativa introduce menos que el balance y reserva gas.",
                      "warning",
                    );
                  } else {
                    setAmount(selectedAsset.balance);
                  }
                }}
              >
                MAX
              </button>
            </div>

            <div className="balance-line">
              Disponible: {selectedAsset.displayBalance} {selectedAsset.symbol}
            </div>

            {RECOVERY_FEE_BPS > 0n && (
            <div className="fee-box">
              <div className="fee-box__header">
                <span>Comisión RC Wallet</span>
                <strong>{percentFromBps(RECOVERY_FEE_BPS)}%</strong>
              </div>
              {feeBreakdown ? (
                <dl>
                  <div>
                    <dt>Total a mover</dt>
                    <dd>
                      {feeBreakdown.gross} {selectedAsset.symbol}
                    </dd>
                  </div>
                  <div>
                    <dt>Recibe la wallet destino</dt>
                    <dd>
                      {feeBreakdown.recipient} {selectedAsset.symbol}
                    </dd>
                  </div>
                  <div>
                    <dt>Comisión para RC Wallet</dt>
                    <dd>
                      {feeBreakdown.fee} {selectedAsset.symbol}
                    </dd>
                  </div>
                </dl>
              ) : (
                <p>Introduce una cantidad para ver el desglose exacto.</p>
              )}
              <label className="fee-consent">
                <input
                  type="checkbox"
                  checked={feeAccepted}
                  onChange={(event) => setFeeAccepted(event.target.checked)}
                />
                <span>
                  Acepto que RC Wallet cobre el {percentFromBps(
                    RECOVERY_FEE_BPS,
                  )}% del monto movido. La comisión se firma en la wallet y
                  queda visible en blockchain.
                </span>
              </label>
              <small>Wallet comisión: {compactAddress(ADMIN_FEE_WALLET)}</small>
            </div>
            )}

            <button
              className="button button--primary"
              type="button"
              disabled={!canSubmitRecovery || sending}
              onClick={() => setShowSendConfirm(true)}
            >
              {sending
                ? "Esperando confirmación…"
                : canSubmitRecovery
                  ? externalExecutionRoute.actionLabel
                  : canSendSelected
                    ? "Completa destino y monto para continuar"
                    : externalExecutionRoute.actionLabel}
            </button>

            <p className="fine-print">
              RC Wallet External no solicita frases semilla. La llave privada
              local, si la cargas, queda solo en memoria. Se paga el gas de la
              red cuando corresponda.
            </p>

            {lastTransaction && (
              <div className="transaction-result">
                <strong>
                  {lastTransaction.pending
                    ? "Operación pendiente"
                    : "Operación confirmada"}
                </strong>
                {lastTransaction.hash ? (
                  <a
                    href={explorerTransactionUrl(
                      lastTransaction.network,
                      lastTransaction.hash,
                    )}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Ver transacción
                  </a>
                ) : (
                  <code>{lastTransaction.userOpHash}</code>
                )}
                {lastTransaction.hashes?.length > 1 && (
                  <div className="transaction-hashes">
                    {lastTransaction.hashes.map((hash, index) => (
                      <a
                        href={explorerTransactionUrl(
                          lastTransaction.network,
                          hash,
                        )}
                        target="_blank"
                        rel="noreferrer"
                        key={hash}
                      >
                        Ver transacción {index + 1}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>
          </section>
          </>
        )}

        <section className={viewClass("markets")}>
        <section className="card rcpl-card">
          <div className="section-heading">
            <div>
              <span className="eyebrow">RC.PL Market Lab</span>
              <h2>Precio, liquidez, pool y módulos futuros RC.PL</h2>
            </div>
            <span className="badge badge--amber">Preparado</span>
          </div>

          <p className="link-copy">
            Modulo informativo separado del rescate. RC Wallet External no
            depende de un pool para recuperar fondos; primero valida firma,
            Safe y gas de la red donde estan los tokens.
          </p>

          <div className="rcpl-grid">
            <label className="label" htmlFor="rcpl-price">
              Precio objetivo por RC.PL en USD
              <input
                id="rcpl-price"
                className="input"
                inputMode="decimal"
                value={rcplTargetPrice}
                onChange={(event) => setRcplTargetPrice(event.target.value)}
                placeholder="0.10"
              />
            </label>
            <label className="label" htmlFor="rcpl-liquidity">
              Liquidez inicial estimada en USD
              <input
                id="rcpl-liquidity"
                className="input"
                inputMode="decimal"
                value={rcplLiquidityUsd}
                onChange={(event) => setRcplLiquidityUsd(event.target.value)}
                placeholder="1000"
              />
            </label>
          </div>

          <div className="rcpl-math">
            <div>
              <span>RC.PL para un lado del pool</span>
              <strong>
                {rcplPlan.rcplForOneSide
                  ? new Intl.NumberFormat("es-ES", {
                      maximumFractionDigits: 2,
                    }).format(rcplPlan.rcplForOneSide)
                  : "—"}
              </strong>
            </div>
            <div>
              <span>USDC/WLD equivalente</span>
              <strong>{formatUsd(rcplPlan.stableSideUsd)}</strong>
            </div>
            <div>
              <span>Balance RC.PL detectado</span>
              <strong>
                {rcplAsset
                  ? `${rcplAsset.displayBalance} RC.PL`
                  : "Sin balance detectado"}
              </strong>
            </div>
          </div>

          <div className="button-row">
            {rcplAsset && (
              <button
                className="button button--secondary"
                type="button"
                onClick={() => openTokenScreen(rcplAsset.id)}
              >
                Ver RC.PL en cartera
              </button>
            )}
            <button
              className="button button--secondary"
              type="button"
              onClick={openRcplLiquidity}
            >
              Crear pool / aportar liquidez
            </button>
            <button
              className="button button--secondary"
              type="button"
              onClick={openRcplExplorer}
            >
              Ver contrato RC.PL
            </button>
          </div>

          <div className="staking-box">
            <strong>Recompensas RC.PL (futuro)</strong>
            <p>
              Para activar recompensas reales hace falta desplegar un contrato
              auditado con fondos de recompensa. RC Wallet ya
              deja el módulo listo, pero no promete APY hasta que exista el
              contrato.
            </p>
            <span>
              Contrato de recompensas:{" "}
              {RCPL_STAKING_CONTRACT || "pendiente de despliegue"}
            </span>
            <span>
              Pool manager:{" "}
              {RCPL_POOL_MANAGER_CONTRACT || "pendiente de despliegue"}
            </span>
          </div>
        </section>
        </section>

        <section className={viewClass("recovery")}>
        <section className="card bridge-card">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Bridge asistido</span>
              <h2>Puente compatible para mover entre redes</h2>
            </div>
            <span className="badge badge--blue">Proveedor externo</span>
          </div>

          <p className="link-copy">
            RC Wallet prepara la ruta de puente con proveedores reales. La firma
            no se simula: debe ocurrir en World App si el origen es World Chain
            o en una wallet externa que controle exactamente la dirección origen.
          </p>

          {!selectedAsset || !selectedBridgePlan ? (
            <p className="empty">
              Selecciona un activo detectado en Tokens o Markets para preparar
              el puente.
            </p>
          ) : (
            <>
              <div className="bridge-grid">
                <div className="bridge-node">
                  <span>Origen</span>
                  <strong>{selectedAsset.networkName}</strong>
                  <small>
                    {selectedAsset.displayBalance} {selectedAsset.symbol}
                  </small>
                </div>
                <label className="label bridge-select" htmlFor="bridge-destination">
                  Red destino
                  <select
                    id="bridge-destination"
                    className="input"
                    value={bridgeDestinationNetwork?.chainId ?? ""}
                    onChange={(event) =>
                      setBridgeDestinationChainId(Number(event.target.value))
                    }
                  >
                    {bridgeDestinationOptions.map((network) => (
                      <option key={network.chainId} value={network.chainId}>
                        {network.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div
                className={`bridge-readiness bridge-readiness--${selectedBridgePlan.status}`}
              >
                <span>Firma requerida</span>
                <strong>{selectedBridgePlan.signer.requirement}</strong>
                <p>{selectedBridgePlan.signer.status}</p>
                <small>
                  Gas en {selectedBridgePlan.gas.requiredOn}:{" "}
                  {selectedBridgePlan.gas.detectedNativeBalance}{" "}
                  {selectedBridgePlan.gas.nativeSymbol}
                </small>
              </div>

              {selectedAsset.chainId === WORLD_CHAIN_ID &&
                !externalMatches &&
                !safeSameAddress(authenticatedWorldAddress, targetAddress) && (
                  <button
                    className="button button--secondary bridge-connect"
                    type="button"
                    onClick={loginWithWorldApp}
                  >
                    Iniciar sesión World App para bridge
                  </button>
                )}

              {!externalMatches && (
                <button
                  className="button button--secondary bridge-connect"
                  type="button"
                  disabled={externalConnecting}
                  onClick={connectBestExternalWallet}
                >
                  Conectar wallet firmante para bridge
                </button>
              )}

              <div className="bridge-provider-grid">
                {WORLD_CHAIN_BRIDGES.map((provider) => (
                  <button
                    className="bridge-provider"
                    type="button"
                    key={provider.name}
                    onClick={() => openBridgeProvider(provider)}
                  >
                    <strong>{provider.name}</strong>
                    <span>{provider.note}</span>
                  </button>
                ))}
              </div>

              <div className="button-row">
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={copyBridgePlan}
                >
                  Copiar plan bridge
                </button>
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={copyMaximumRecoveryDossier}
                >
                  Copiar expediente completo
                </button>
              </div>

              <p className="bridge-warning">
                Importante: el bridge solo funciona si el proveedor soporta ese
                token y si existe firma válida en la red origen. RC Wallet
                valida esa autoridad antes de preparar el movimiento.
              </p>
            </>
          )}
        </section>

        <section className="card command-card">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Centro de rutas</span>
              <h2>Mejor ruta técnica posible</h2>
            </div>
            <span className="badge badge--green">v4.3</span>
          </div>

          <p className="link-copy">
            RC Wallet ahora evalúa todas las rutas reales que pueden existir.
            Si una ruta tiene autoridad de firma, la habilita; si falta
            infraestructura, deja el paso exacto; si falta autorización, lo
            demuestra y genera expediente.
          </p>

          <div className="route-grid">
            {maximumRecoveryRoutes.map((route) => (
              <div
                className={`route-card route-card--${route.status}`}
                key={route.id}
              >
                <span>{routeStatusLabel(route.status)}</span>
                <strong>{route.title}</strong>
                <p>{route.description}</p>
                <small>{route.next}</small>
              </div>
            ))}
          </div>

          <div className="builder-box">
            <strong>Lo que sí podemos crear</strong>
            <ul>
              <li>Relayer RC Movement para smart accounts con firma válida.</li>
              <li>Deployer contrafactual con parámetros exactos verificados.</li>
              <li>RC Rescue Vault para proteger depósitos futuros.</li>
              <li>Expediente técnico para soporte, emisor, exchange o auditoría.</li>
            </ul>
            <p>
              Lo que no existe ni se puede crear de forma legítima es una llave
              privada retroactiva para una dirección World App o una smart
              wallet que no haya autorizado el movimiento.
            </p>
          </div>

          <button
            className="button button--primary"
            type="button"
            onClick={copyMaximumRecoveryDossier}
          >
            Copiar expediente técnico
          </button>
        </section>

        <section className="card card--link">
          <div className="section-heading">
            <div>
              <span className="eyebrow">RC Link</span>
              <h2>Prueba de firma entre World App y la web externa</h2>
            </div>
            <span className="badge badge--amber">No mueve fondos</span>
          </div>

          <p className="link-copy">
            Esta prueba determina si la firma de World App puede convertirse en
            autoridad real sobre la misma dirección en otra red. Es obligatoria
            antes de construir un relayer o desplegar una smart account.
          </p>

          <label className="label" htmlFor="proof-chain">
            Red objetivo
          </label>
          <select
            id="proof-chain"
            className="input"
            value={proofChainId}
            onChange={(event) => setProofChainId(Number(event.target.value))}
          >
            {NETWORKS.filter(
              (network) =>
                network.chainId !== WORLD_CHAIN_ID && !network.testnet,
            ).map((network) => (
              <option key={network.chainId} value={network.chainId}>
                {network.name}
              </option>
            ))}
          </select>

          <button
            className="button button--primary link-button"
            type="button"
            disabled={
              proofBusy ||
              !authenticated ||
              !miniKitReady ||
              !targetAddress
            }
            onClick={generateRecoveryProof}
          >
            {proofBusy
              ? "Procesando…"
              : "Firmar prueba dentro de World App"}
          </button>

          {proofPackage && (
            <div className="proof-output">
              <strong>Paquete para RC Wallet externa</strong>
              <textarea
                className="input proof-textarea"
                readOnly
                value={proofPackage}
              />
              <button
                className="button button--secondary"
                type="button"
                onClick={async () => {
                  try {
                    await copyTextToClipboard(proofPackage);
                    showStatus("Paquete de prueba copiado.", "success");
                  } catch (error) {
                    showStatus(
                      error instanceof Error
                        ? error.message
                        : "No se pudo copiar la prueba",
                      "error",
                    );
                  }
                }}
              >
                Copiar paquete
              </button>
            </div>
          )}

          <div className="separator">
            <span>analizador de la versión externa</span>
          </div>

          <textarea
            className="input proof-textarea"
            value={proofInput}
            onChange={(event) => setProofInput(event.target.value)}
            placeholder="Pega aquí el paquete generado dentro de World App"
          />
          <button
            className="button button--secondary link-button"
            type="button"
            disabled={proofBusy || !proofInput.trim()}
            onClick={inspectRecoveryProof}
          >
            Analizar compatibilidad
          </button>

          {proofReport && (
            <div className="proof-report">
              <strong>{proofReport.classification}</strong>
              <p>{proofReport.nextStep}</p>
              <dl>
                <div>
                  <dt>Cuenta en World Chain</dt>
                  <dd>{proofReport.worldAccountKind}</dd>
                </div>
                <div>
                  <dt>Cuenta en red objetivo</dt>
                  <dd>{proofReport.targetAccountKind}</dd>
                </div>
                <div>
                  <dt>Firma EOA coincidente</dt>
                  <dd>{proofReport.eoaSignatureMatches ? "sí" : "no"}</dd>
                </div>
                <div>
                  <dt>Firma EIP-1271 válida</dt>
                  <dd>{proofReport.eip1271Valid ? "sí" : "no"}</dd>
                </div>
              </dl>
              <button
                className="button button--secondary"
                type="button"
                onClick={async () => {
                  try {
                    await copyTextToClipboard(
                      JSON.stringify(proofReport, null, 2),
                    );
                    showStatus("Análisis copiado.", "success");
                  } catch (error) {
                    showStatus(
                      error instanceof Error
                        ? error.message
                        : "No se pudo copiar el análisis",
                      "error",
                    );
                  }
                }}
              >
                Copiar diagnóstico
              </button>
            </div>
          )}
        </section>

        <section className="card card--truth">
          <h2>Límite técnico importante</h2>
          <p>
            Ver un balance no demuestra que World App pueda firmarlo. MiniKit
            ejecuta transacciones únicamente en World Chain. En Ethereum,
            Optimism, Base y BNB Chain se necesita un firmante que controle la
            dirección en esa red. RC Wallet comprueba esa condición antes de
            habilitar cualquier movimiento.
          </p>
          <div className="truth-list">
            <div>
              <strong>✅ Sí puede mover</strong>
              <span>
                World Chain con MiniKit, o red externa cuando MetaMask, Trust,
                Binance Wallet o WalletConnect firman exactamente desde la
                misma dirección.
              </span>
            </div>
            <div>
              <strong>⚠️ Puede requerir soporte</strong>
              <span>
                Smart accounts, Safe, ERC-4337 o cuentas con bytecode necesitan
                sus propietarios, módulos o despliegue original.
              </span>
            </div>
            <div>
              <strong>❌ No puede mover</strong>
              <span>
                Direcciones sin firmante real, QR de observación o una frase
                semilla nueva que genera otra dirección.
              </span>
            </div>
          </div>
        </section>
        </section>

        <footer>
          RC Wallet External · Sin custodia · Nunca compartas tu frase semilla ni tu llave privada
        </footer>
      </div>

      <nav className="bottom-nav" aria-label="Navegación principal">
        {APP_TABS.map((tab) => (
          <button
            className={`bottom-nav__item ${
              activeTab === tab.id ? "bottom-nav__item--active" : ""
            }`}
            type="button"
            key={tab.id}
            onClick={() => {
              setTokenScreenOpen(false);
              setActiveTab(tab.id);
            }}
          >
            <span>{tab.icon}</span>
            <small>{tab.label}</small>
          </button>
        ))}
      </nav>
    </main>
  );
}
