import {
  createBridgeQuoteUrl,
  sanitizeBridgeQuote,
  validateBridgeQuotePayload,
} from "../src/bridge-quote.js";

const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_QUOTES_PER_MINUTE = 12;
const MAX_RESPONSE_BYTES = 512_000;
const quoteRequests = new Map();

function configuredOrigins() {
  return String(process.env.RC_ALLOWED_ORIGINS ?? "")
    .split(",").map((v) => v.trim()).filter(Boolean);
}

function allowedOrigin(request) {
  const origin = String(request.headers?.origin ?? "").trim();
  if (!origin) return true;
  if (configuredOrigins().includes(origin)) return true;
  const host = String(request.headers?.["x-forwarded-host"] || request.headers?.host || "").trim();
  const proto = String(request.headers?.["x-forwarded-proto"] || "https").trim();
  if (host && origin === `${proto}://${host}`) return true;
  if (process.env.NODE_ENV !== "production" && /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin)) return true;
  return false;
}

function reply(response, status, body) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  return response.status(status).json(body);
}

function rateLimit(request) {
  const rawIp = String(request.headers?.["x-forwarded-for"] || request.headers?.["x-real-ip"] || "unknown");
  const ip = rawIp.split(",")[0].trim().slice(0, 64);
  const now = Date.now();
  const active = (quoteRequests.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (active.length >= MAX_QUOTES_PER_MINUTE) return false;
  active.push(now);
  quoteRequests.set(ip, active);
  if (quoteRequests.size > 2000) {
    for (const [key, stamps] of quoteRequests) {
      if (!stamps.some((stamp) => now - stamp < RATE_LIMIT_WINDOW_MS)) quoteRequests.delete(key);
    }
  }
  return true;
}

export default async function handler(request, response) {
  if (!allowedOrigin(request)) {
    return reply(response, 403, { error: "Origin no autorizado" });
  }
  if (request.method === "OPTIONS") {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "content-type");
    return response.status(204).end();
  }
  if (request.method !== "POST") {
    return reply(response, 405, { error: "Metodo no permitido" });
  }
  let payload;
  try {
    payload = validateBridgeQuotePayload(request.body);
  } catch (error) {
    return reply(response, 400, { error: error.message });
  }
  if (!rateLimit(request)) {
    response.setHeader("Retry-After", "60");
    return reply(response, 429, { error: "Limite de consultas. Intenta mas tarde." });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const upstream = await fetch(createBridgeQuoteUrl(payload), {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const text = await upstream.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      return reply(response, 502, { error: "Cotizacion demasiado grande" });
    }
    if (!upstream.ok) {
      return reply(response, 422, {
        error: "No existe una cotizacion compatible para ese token, monto y redes. Verifica el token de salida o el proveedor.",
      });
    }
    const quote = sanitizeBridgeQuote(JSON.parse(text), payload);
    return reply(response, 200, { ok: true, quote });
  } catch (error) {
    return reply(response, 502, {
      error: error?.name === "AbortError"
        ? "Tiempo de espera del proveedor agotado"
        : "No se pudo validar la cotizacion externa",
    });
  } finally {
    clearTimeout(timer);
  }
}
