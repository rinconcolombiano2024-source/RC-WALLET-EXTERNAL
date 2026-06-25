const DEFAULT_WORLD_ID_RP_ID = "rp_44f2772c9e0bb5c3";

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

  const expectedRpId =
    process.env.WORLD_ID_RP_ID ||
    process.env.VITE_WORLD_RP_ID ||
    process.env.VITE_WORLD_CLIENT_ID ||
    DEFAULT_WORLD_ID_RP_ID;

  const { rp_id: rpId, idkitResponse } = await readJsonBody(req);

  if (!rpId || rpId !== expectedRpId) {
    return res.status(400).json({
      error: "RP ID no coincide con la configuración del servidor.",
      expected: expectedRpId,
      received: rpId || "",
    });
  }

  if (!idkitResponse) {
    return res.status(400).json({ error: "Falta la prueba IDKit para verificar." });
  }

  try {
    const response = await fetch(`https://developer.world.org/api/v4/verify/${expectedRpId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(idkitResponse),
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(400).json({
        error: result?.error || result?.message || "World ID rechazó la prueba.",
        details: result,
      });
    }

    return res.status(200).json({
      success: true,
      result,
    });
  } catch (error) {
    return res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : "No se pudo verificar World ID.",
    });
  }
}
