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

const HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;

function setCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "content-type");
}

function json(response, status, body) {
  setCors(response);
  response.status(status).json(body);
}

function serviceUrl(chainId) {
  return SAFE_SERVICE_URLS[Number(chainId)]?.[0]?.replace(/\/+$/, "") ?? null;
}

function safeApiHeaders() {
  const apiKey =
    process.env.SAFE_API_KEY ||
    process.env.SAFE_GLOBAL_API_KEY ||
    process.env.SAFE_TRANSACTION_SERVICE_API_KEY ||
    "";
  const headers = {
    accept: "application/json",
    "user-agent": "RC-Wallet-External/1.0",
  };

  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

function validateSafeTransactionLookup({ chainId, safeTxHash }) {
  if (!Number.isInteger(Number(chainId))) {
    return "chainId invalido";
  }
  if (!serviceUrl(chainId)) {
    return "Red sin Safe Transaction Service configurado";
  }
  if (!HASH_PATTERN.test(safeTxHash ?? "")) {
    return "safeTxHash invalido";
  }
  return null;
}

export default async function handler(request, response) {
  setCors(response);

  if (request.method === "OPTIONS") {
    return response.status(204).end();
  }
  if (request.method !== "POST") {
    return json(response, 405, { error: "Metodo no permitido" });
  }

  const body = request.body ?? {};
  const chainId = body.chainId;
  const safeTxHash = body.safeTxHash;
  const validationError = validateSafeTransactionLookup({ chainId, safeTxHash });

  if (validationError) {
    return json(response, 400, { error: validationError });
  }

  const baseUrl = serviceUrl(chainId);
  const url = `${baseUrl}/api/v1/multisig-transactions/${safeTxHash}/`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20_000);

  try {
    const upstream = await fetch(url, {
      headers: safeApiHeaders(),
      signal: controller.signal,
    });
    const text = await upstream.text();
    let data = null;

    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text.slice(0, 500);
      }
    }

    if (!upstream.ok) {
      return json(response, upstream.status, {
        error: "Safe Transaction Service no encontro la transaccion",
        status: upstream.status,
        detail: data,
        url,
      });
    }

    return json(response, upstream.status, {
      ok: true,
      status: upstream.status,
      response: data,
      url,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Safe Transaction Service no respondio";
    return json(response, 502, {
      error: "No se pudo contactar Safe Transaction Service",
      detail: message,
      url,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
