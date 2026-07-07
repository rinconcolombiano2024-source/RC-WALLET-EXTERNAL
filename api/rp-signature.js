import { ethers } from "ethers";

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
    const { typedData, signature, signerAddress } = req.body ?? {};
    if (!typedData?.domain || !typedData?.types || !typedData?.message || !signature) {
      return res.status(400).json({
        isValid: false,
        error: "Faltan typedData o signature",
      });
    }

    const types = { ...typedData.types };
    delete types.EIP712Domain;

    const digest = ethers.TypedDataEncoder.hash(
      typedData.domain,
      types,
      typedData.message,
    );
    const recoveredAddress = normalizeAddress(
      ethers.verifyTypedData(
        typedData.domain,
        types,
        typedData.message,
        signature,
      ),
    );
    const expectedSigner = signerAddress ? normalizeAddress(signerAddress) : null;

    return res.status(200).json({
      isValid: expectedSigner ? recoveredAddress === expectedSigner : true,
      digest,
      recoveredAddress,
      expectedSigner,
    });
  } catch (error) {
    return res.status(400).json({
      isValid: false,
      error: error instanceof Error ? error.message : "No se pudo verificar la firma",
    });
  }
}
