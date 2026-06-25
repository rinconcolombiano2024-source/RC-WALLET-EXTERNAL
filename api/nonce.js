import crypto from "node:crypto";

export default function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const nonce = crypto.randomBytes(16).toString("hex");
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";

  res.setHeader(
    "Set-Cookie",
    `rc_external_siwe_nonce=${nonce}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600${secure}`,
  );
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ nonce });
}
