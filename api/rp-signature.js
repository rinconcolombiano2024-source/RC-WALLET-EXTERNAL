import { signRequest } from "@worldcoin/idkit-core/signing";

const DEFAULT_WORLD_ID_ACTION = "rc-wallet-login";

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Cache-Control", "no-store");

  const signingKeyHex =
    process.env.WORLD_ID_RP_SIGNING_KEY ||
    process.env.RP_SIGNING_KEY;

  if (!signingKeyHex) {
    return res.status(500).json({
      error:
        "Falta WORLD_ID_RP_SIGNING_KEY en Vercel. Copia el signing_key del Developer Portal de World ID 4.0.",
    });
  }

  const body = await readJsonBody(req);
  const action = String(body.action || DEFAULT_WORLD_ID_ACTION).trim();

  if (!action) {
    return res.status(400).json({ error: "Action de World ID inválida." });
  }

  try {
    const { sig, nonce, createdAt, expiresAt } = signRequest({
      signingKeyHex,
      action,
    });

    return res.status(200).json({
      sig,
      nonce,
      created_at: createdAt,
      expires_at: expiresAt,
    });
  } catch (error) {
    return res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : "No se pudo firmar la solicitud de World ID.",
    });
  }
}
