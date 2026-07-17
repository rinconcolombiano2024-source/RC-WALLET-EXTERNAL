const SAFE_SERVICE_URLS = Object.freeze({
  1: ["https://safe-transaction-mainnet.safe.global"],
  10: ["https://safe-transaction-optimism.safe.global"],
  56: ["https://safe-transaction-bsc.safe.global"],
  480: [
    "https://safe-transaction-worldchain.safe.global",
    "https://safe-transaction-world-chain.safe.global",
  ],
  8453: ["https://safe-transaction-base.safe.global"],
});

const SAFE_CLIENT_GATEWAY_URL = "https://safe-client.safe.global";
const ETHERSCAN_V2_URL = "https://api.etherscan.io/v2/api";

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const SAFE_SUPPORTED_CREATION_METHODS = new Set([
  "createProxyWithNonce",
  "createProxyWithNonceL2",
  "createProxyWithCallback",
  "createChainSpecificProxyWithNonce",
  "createChainSpecificProxyWithNonceL2",
]);

function json(response, status, body) {
  response.status(status).json(body);
}

function explorerApiKey() {
  return (
    process.env.ETHERSCAN_API_KEY ||
    process.env.WORLDSCAN_API_KEY ||
    process.env.WORLD_SCAN_API_KEY ||
    process.env.EXPLORER_API_KEY ||
    ""
  );
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "RC-Wallet-External/1.0",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeCreationPayload(payload, sourceUrl) {
  const data =
    payload?.creation ??
    payload?.data ??
    payload?.results?.[0] ??
    payload?.result?.[0] ??
    payload;
  if (!data || typeof data !== "object") return null;

  const transactionHash =
    data.transactionHash ??
    data.transaction_hash ??
    data.txHash ??
    data.tx_hash ??
    data.hash ??
    data.creationTxHash ??
    data.transaction?.txHash ??
    data.transaction?.hash ??
    null;
  const factoryAddress =
    data.factoryAddress ??
    data.factory_address ??
    data.factory ??
    data.createdBy ??
    data.contractCreator ??
    data.contract_creator ??
    null;
  const singleton =
    data.masterCopy ??
    data.master_copy ??
    data.singleton ??
    data.implementation ??
    null;
  const initializer =
    data.setupData ??
    data.setup_data ??
    data.initializer ??
    data.initData ??
    null;
  const saltNonce =
    data.saltNonce ??
    data.salt_nonce ??
    data.salt ??
    null;
  const method =
    data.method ??
    data.creationMethod ??
    data.creation_method ??
    data.factoryMethod ??
    data.factory_method ??
    null;
  const callback =
    data.callback ??
    data.callbackAddress ??
    data.callback_address ??
    null;

  if (!transactionHash && !factoryAddress && !singleton && !initializer) {
    return null;
  }

  return {
    sourceUrl,
    transactionHash,
    factoryAddress,
    singleton,
    initializer,
    saltNonce,
    method:
      typeof method === "string" && SAFE_SUPPORTED_CREATION_METHODS.has(method)
        ? method
        : null,
    callback,
    raw: data,
  };
}

function etherscanContractCreationUrl(chainId, safeAddress) {
  const apiKey = explorerApiKey();
  if (!apiKey) return null;

  const url = new URL(ETHERSCAN_V2_URL);
  url.searchParams.set("chainid", String(chainId));
  url.searchParams.set("module", "contract");
  url.searchParams.set("action", "getcontractcreation");
  url.searchParams.set("contractaddresses", safeAddress);
  url.searchParams.set("apikey", apiKey);
  return url.toString();
}

async function readSafeCreation(chainId, safeAddress) {
  const serviceUrls = SAFE_SERVICE_URLS[chainId] ?? [];
  const urls = [
    ...serviceUrls.map(
      (baseUrl) => `${baseUrl}/api/v1/safes/${safeAddress}/creation/`,
    ),
    `${SAFE_CLIENT_GATEWAY_URL}/v1/chains/${chainId}/safes/${safeAddress}/creation`,
    `${SAFE_CLIENT_GATEWAY_URL}/v1/chains/${chainId}/safes/${safeAddress}`,
  ].filter(Boolean);
  const explorerCreationUrl = etherscanContractCreationUrl(chainId, safeAddress);
  if (explorerCreationUrl) urls.push(explorerCreationUrl);
  const errors = [];

  for (const url of urls) {
    try {
      const payload = await fetchJson(url);
      const normalized = normalizeCreationPayload(payload, url);
      if (normalized) return normalized;
      errors.push({ url, error: "Respuesta sin datos de creacion" });
    } catch (error) {
      errors.push({
        url,
        error: error instanceof Error ? error.message : "Consulta fallida",
      });
    }
  }

  return { errors };
}

export default async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return json(response, 405, { error: "Metodo no permitido" });
  }

  const chainId = Number(request.query.chainId);
  const safeAddress = String(request.query.safe ?? "").trim();

  if (!Number.isInteger(chainId) || chainId <= 0) {
    return json(response, 400, { error: "chainId invalido" });
  }

  if (!ADDRESS_PATTERN.test(safeAddress)) {
    return json(response, 400, { error: "Direccion Safe invalida" });
  }

  const result = await readSafeCreation(chainId, safeAddress);
  if (result?.transactionHash || result?.factoryAddress) {
    return json(response, 200, { ok: true, creation: result });
  }

  return json(response, 404, {
    ok: false,
    error: "No se encontro la creacion de la Safe",
    details: result?.errors ?? [],
  });
}
