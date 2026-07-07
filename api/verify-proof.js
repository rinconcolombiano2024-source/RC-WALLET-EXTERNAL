import { ethers } from "ethers";

const RECOVERY_TYPES = Object.freeze({
  RecoveryAuthorization: [
    { name: "wallet", type: "address" },
    { name: "targetChainId", type: "uint256" },
    { name: "nonce", type: "bytes32" },
    { name: "expiresAt", type: "uint256" },
    { name: "purpose", type: "string" },
  ],
});

function normalizeAddress(address) {
  if (!ethers.isAddress(address)) {
    throw new Error("Direccion EVM invalida");
  }

  return ethers.getAddress(address);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const proof = req.body?.proof ?? req.body;
    if (
      proof?.format !== "rc-wallet-recovery-proof" ||
      proof?.version !== 1 ||
      !proof?.typedData ||
      !proof?.signature
    ) {
      return res.status(400).json({
        isValid: false,
        error: "Formato de prueba invalido",
      });
    }

    const { domain, message, primaryType } = proof.typedData;
    if (primaryType !== "RecoveryAuthorization") {
      throw new Error("Tipo de prueba no soportado");
    }

    const wallet = normalizeAddress(message.wallet);
    const signerAddress = normalizeAddress(proof.signerAddress);
    const types = { ...RECOVERY_TYPES };
    const digest = ethers.TypedDataEncoder.hash(domain, types, message);
    const recoveredAddress = normalizeAddress(
      ethers.verifyTypedData(domain, types, message, proof.signature),
    );
    const expired = Number(message.expiresAt) < Math.floor(Date.now() / 1000);
    const signerMatches = recoveredAddress === signerAddress;
    const walletMatches = recoveredAddress === wallet;

    return res.status(200).json({
      isValid: signerMatches && !expired,
      classification: walletMatches
        ? "portable-eoa-signature"
        : signerMatches
          ? "owner-signature"
          : "signature-not-matching",
      digest,
      wallet,
      signerAddress,
      recoveredAddress,
      signerMatches,
      walletMatches,
      expired,
      targetChainId: Number(message.targetChainId),
    });
  } catch (error) {
    return res.status(400).json({
      isValid: false,
      error: error instanceof Error ? error.message : "No se pudo verificar la prueba",
    });
  }
}
