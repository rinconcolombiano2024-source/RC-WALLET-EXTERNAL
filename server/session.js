import crypto from "node:crypto";

const SESSION_COOKIE = "rc_wallet_session";
const SESSION_VERSION = 1;
const DEFAULT_SESSION_TTL_SECONDS = 15 * 60;

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

function requireSessionSecret() {
  const secret = String(process.env.RC_SESSION_SECRET ?? "").trim();

  if (secret.length < 32) {
    throw new Error(
      "RC_SESSION_SECRET no está configurado o tiene menos de 32 caracteres",
    );
  }

  return secret;
}

function sign(encodedPayload) {
  return crypto
    .createHmac("sha256", requireSessionSecret())
    .update(encodedPayload)
    .digest("base64url");
}

function safeEqual(left, right) {
  try {
    const leftBuffer = Buffer.from(String(left));
    const rightBuffer = Buffer.from(String(right));

    if (leftBuffer.length !== rightBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
  } catch {
    return false;
  }
}

export function readCookie(cookieHeader, name) {
  if (!cookieHeader) return "";

  for (const part of String(cookieHeader).split(";")) {
    const [key, ...valueParts] = part.trim().split("=");

    if (key === name) {
      return decodeURIComponent(valueParts.join("="));
    }
  }

  return "";
}

export function createSessionToken(address) {
  const normalizedAddress = String(address ?? "").trim();

  if (!ADDRESS_PATTERN.test(normalizedAddress)) {
    throw new Error("Dirección de sesión inválida");
  }

  const now = Math.floor(Date.now() / 1000);

  const payload = {
    v: SESSION_VERSION,
    address: normalizedAddress.toLowerCase(),
    iat: now,
    exp: now + DEFAULT_SESSION_TTL_SECONDS,
  };

  const encodedPayload = Buffer.from(
    JSON.stringify(payload),
    "utf8",
  ).toString("base64url");

  return `${encodedPayload}.${sign(encodedPayload)}`;
}

export function verifySessionToken(token) {
  if (!token || typeof token !== "string") {
    return null;
  }

  const parts = token.split(".");

  if (parts.length !== 2) {
    return null;
  }

  const [encodedPayload, receivedSignature] = parts;
  const expectedSignature = sign(encodedPayload);

  if (!safeEqual(receivedSignature, expectedSignature)) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    );

    if (
      payload?.v !== SESSION_VERSION ||
      !ADDRESS_PATTERN.test(payload?.address ?? "") ||
      !Number.isInteger(payload?.iat) ||
      !Number.isInteger(payload?.exp)
    ) {
      return null;
    }

    const now = Math.floor(Date.now() / 1000);

    if (payload.exp <= now || payload.iat > now + 30) {
      return null;
    }

    return {
      address: payload.address.toLowerCase(),
      issuedAt: payload.iat,
      expiresAt: payload.exp,
    };
  } catch {
    return null;
  }
}

export function readSession(request) {
  const token = readCookie(
    request?.headers?.cookie,
    SESSION_COOKIE,
  );

  return verifySessionToken(token);
}

export function createSessionCookie(address) {
  const token = createSessionToken(address);

  const secure =
    process.env.NODE_ENV === "production"
      ? "; Secure"
      : "";

  return (
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; ` +
    `HttpOnly; Path=/; SameSite=Strict; Max-Age=${DEFAULT_SESSION_TTL_SECONDS}${secure}`
  );
}

export function clearSessionCookie() {
  const secure =
    process.env.NODE_ENV === "production"
      ? "; Secure"
      : "";

  return (
    `${SESSION_COOKIE}=; ` +
    `HttpOnly; Path=/; SameSite=Strict; Max-Age=0${secure}`
  );
}
