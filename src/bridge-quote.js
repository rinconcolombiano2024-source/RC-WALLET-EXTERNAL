/**
 * Read-only LI.FI quote contract. A quote is not authorization or an executable
 * transaction. All fields are validated here and never contain key material.
 */
export const BRIDGE_CHAINS = Object.freeze([1, 10, 56, 137, 480, 8453, 42161]);
export const BRIDGE_OUTPUT_TOKENS = Object.freeze(["USDC", "USDT", "ETH", "WLD", "BNB", "POL"]);
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const HEX_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const INTEGER_PATTERN = /^[1-9][0-9]*$/;
const MAX_ATOMIC_AMOUNT_DIGITS = 78;
const MAX_JSON_BODY_LENGTH = 2_048;

function validateChain(value) {
  const chain = Number(value);
  if (!Number.isSafeInteger(chain) || !BRIDGE_CHAINS.includes(chain)) {
    throw new Error("Red no admitida para cotizaciones");
  }
  return chain;
}

function address(value) {
  if (typeof value !== "string" || !ADDRESS_PATTERN.test(value)) {
    throw new Error("Direccion de origen o destino invalida");
  }
  if (/^0x0{40}$/i.test(value)) throw new Error("No se permite direccion cero");
  return value;
}

function inputToken(value) {
  if (typeof value !== "string") throw new Error("Token origen invalido");
  const token = value.trim();
  if (HEX_PATTERN.test(token) && !/^0x0{40}$/i.test(token)) return token;
  if (BRIDGE_OUTPUT_TOKENS.includes(token)) return token;
  throw new Error("Token origen no admitido");
}

export function validateBridgeQuotePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Solicitud de cotizacion invalida");
  }
  if (JSON.stringify(payload).length > MAX_JSON_BODY_LENGTH) {
    throw new Error("Solicitud de cotizacion demasiado grande");
  }
  const fromChain = validateChain(payload.fromChain);
  const toChain = validateChain(payload.toChain);
  if (fromChain === toChain) throw new Error("El bridge necesita dos redes diferentes");
  const fromAddress = address(payload.fromAddress);
  const toAddress = address(payload.toAddress);
  const fromToken = inputToken(payload.fromToken);
  const toToken = String(payload.toToken ?? "").trim();
  if (!BRIDGE_OUTPUT_TOKENS.includes(toToken)) {
    throw new Error("Selecciona un token de salida admitido");
  }
  const fromAmount = String(payload.fromAmount ?? "").trim();
  if (!INTEGER_PATTERN.test(fromAmount) || fromAmount.length > MAX_ATOMIC_AMOUNT_DIGITS) {
    throw new Error("Cantidad atomica invalida");
  }
  return { fromChain, toChain, fromAddress, toAddress, fromToken, toToken, fromAmount };
}

export function createBridgeQuoteUrl(payload) {
  const params = new URLSearchParams(validateBridgeQuotePayload(payload));
  params.set("integrator", "rc-wallet-external");
  return `https://li.quest/v1/quote?${params.toString()}`;
}

function safeDecimalAmount(value) {
  const v = String(value ?? "");
  return /^(?:0|[1-9][0-9]*)$/.test(v) && v.length <= 78 ? v : null;
}

function safeUsd(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n < 1e12 ? Math.round(n * 100) / 100 : null;
}

/** Reject mismatched responses from a third party; never return transactionRequest. */
export function sanitizeBridgeQuote(quote, requested) {
  const request = validateBridgeQuotePayload(requested);
  if (!quote || typeof quote !== "object" || !quote.action || !quote.estimate) {
    throw new Error("Cotizacion incompleta");
  }
  const action = quote.action;
  if (
    Number(action.fromChainId) !== request.fromChain ||
    Number(action.toChainId) !== request.toChain ||
    String(action.fromAmount) !== request.fromAmount ||
    String(action.fromAddress).toLowerCase() !== request.fromAddress.toLowerCase() ||
    String(action.toAddress).toLowerCase() !== request.toAddress.toLowerCase()
  ) {
    throw new Error("El proveedor devolvio una ruta diferente de la solicitada");
  }
  // Do not silently swap into a different output ticker than the user's choice.
  const returnedOutputSymbol = String(action.toToken?.symbol ?? "").toUpperCase();
  if (returnedOutputSymbol !== request.toToken.toUpperCase()) {
    throw new Error("El token recibido no coincide con la seleccion del usuario");
  }
  const fromTokenAddress = String(action.fromToken?.address ?? "");
  const requestedInputIsAddress = ADDRESS_PATTERN.test(request.fromToken);
  if (requestedInputIsAddress && fromTokenAddress.toLowerCase() !== request.fromToken.toLowerCase()) {
    throw new Error("El token de origen no coincide con la solicitud");
  }
  if (!safeDecimalAmount(quote.estimate.toAmount) || !safeDecimalAmount(quote.estimate.toAmountMin)) {
    throw new Error("Importes de la cotizacion invalidos");
  }
  if (BigInt(quote.estimate.toAmountMin) > BigInt(quote.estimate.toAmount)) {
    throw new Error("Importe minimo inconsistente");
  }
  const receivingDecimals = Number(action.toToken?.decimals);
  if (!Number.isSafeInteger(receivingDecimals) || receivingDecimals < 0 || receivingDecimals > 36) {
    throw new Error("Decimales del token de destino invalidos");
  }
  return {
    provider: String(quote.toolDetails?.name || quote.tool || "LI.FI").slice(0, 60),
    fromChain: request.fromChain,
    toChain: request.toChain,
    sourceAddress: request.fromAddress,
    destinationAddress: request.toAddress,
    sourceSymbol: String(action.fromToken?.symbol ?? "").slice(0, 20),
    outputSymbol: String(action.toToken?.symbol ?? "").slice(0, 20),
    outputDecimals: receivingDecimals,
    estimatedOutputAtomic: String(quote.estimate.toAmount),
    minimumOutputAtomic: String(quote.estimate.toAmountMin),
    gasCostUSD: Array.isArray(quote.estimate.gasCosts)
      ? quote.estimate.gasCosts.map((v) => safeUsd(v?.amountUSD)).filter((v) => v !== null).reduce((a, b) => a + b, 0)
      : null,
    feeCostUSD: Array.isArray(quote.estimate.feeCosts)
      ? quote.estimate.feeCosts.map((v) => safeUsd(v?.amountUSD)).filter((v) => v !== null).reduce((a, b) => a + b, 0)
      : null,
    executionAvailableInRcWallet: false,
    status: "informative-quote-only",
    notice: "Cotizacion informativa, no es una transaccion ni confirma control de fondos. Validar ruta y aprobar exclusivamente desde una wallet autorizada.",
  };
}
