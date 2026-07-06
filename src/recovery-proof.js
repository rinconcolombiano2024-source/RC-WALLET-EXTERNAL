import { ethers } from "ethers";
import { getProvider, normalizeAddress } from "./blockchain.js";
import { NETWORKS, WORLD_CHAIN_ID } from "./config.js";

export const RECOVERY_PRIMARY_TYPE = "RecoveryAuthorization";

export const RECOVERY_TYPES = Object.freeze({
  RecoveryAuthorization: [
    { name: "wallet", type: "address" },
    { name: "targetChainId", type: "uint256" },
    { name: "nonce", type: "bytes32" },
    { name: "expiresAt", type: "uint256" },
    { name: "purpose", type: "string" },
  ],
});

export const RECOVERY_EIP712_DOMAIN = Object.freeze([
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
]);

const EIP1271_ABI = [
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
];
const EIP1271_MAGIC_VALUE = "0x1626ba7e";

function randomBytes32() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return ethers.hexlify(bytes);
}

export function createRecoveryTypedData(walletAddress, targetChainId) {
  const wallet = normalizeAddress(walletAddress);
  const chainId = Number(targetChainId);
  const network = NETWORKS.find((item) => item.chainId === chainId);
  if (!network || chainId === WORLD_CHAIN_ID) {
    throw new Error("Selecciona una red externa soportada");
  }

  const expiresAt = Math.floor(Date.now() / 1000) + 15 * 60;
  return {
    primaryType: RECOVERY_PRIMARY_TYPE,
    domain: {
      name: "RC Wallet Recovery",
      version: "1",
      chainId: WORLD_CHAIN_ID,
    },
    types: {
      EIP712Domain: RECOVERY_EIP712_DOMAIN,
      ...RECOVERY_TYPES,
    },
    message: {
      wallet,
      targetChainId: chainId,
      nonce: randomBytes32(),
      expiresAt,
      purpose: "RC Wallet cross-chain recovery compatibility test",
    },
  };
}

export function createRecoveryProofPackage({
  typedData,
  signature,
  signerAddress,
}) {
  return {
    format: "rc-wallet-recovery-proof",
    version: 1,
    createdAt: new Date().toISOString(),
    signerAddress: normalizeAddress(signerAddress),
    signature,
    typedData,
  };
}

export async function analyzeRecoveryProof(packageInput) {
  const proof =
    typeof packageInput === "string"
      ? JSON.parse(packageInput)
      : packageInput;

  if (
    proof?.format !== "rc-wallet-recovery-proof" ||
    proof?.version !== 1 ||
    !proof?.typedData ||
    !proof?.signature
  ) {
    throw new Error("El paquete de prueba no tiene un formato válido");
  }

  const { domain, message, primaryType } = proof.typedData;
  const wallet = normalizeAddress(message.wallet);
  const signerAddress = normalizeAddress(proof.signerAddress);
  const chainId = Number(message.targetChainId);
  const domainChainId = Number(domain.chainId);

  if (
    primaryType !== RECOVERY_PRIMARY_TYPE ||
    domainChainId !== WORLD_CHAIN_ID ||
    (domain.verifyingContract &&
      normalizeAddress(domain.verifyingContract) !== wallet) ||
    signerAddress !== wallet
  ) {
    throw new Error("La firma, la cuenta y la red no son coherentes");
  }

  const network = NETWORKS.find((item) => item.chainId === chainId);
  const worldNetwork = NETWORKS.find(
    (item) => item.chainId === WORLD_CHAIN_ID,
  );
  if (!network || !worldNetwork || chainId === WORLD_CHAIN_ID) {
    throw new Error("La red objetivo no está soportada");
  }

  const now = Math.floor(Date.now() / 1000);
  const expired = Number(message.expiresAt) < now;
  const digest = ethers.TypedDataEncoder.hash(
    domain,
    RECOVERY_TYPES,
    message,
  );

  let recoveredEoa = null;
  let eoaSignatureMatches = false;
  try {
    recoveredEoa = normalizeAddress(
      ethers.verifyTypedData(
        domain,
        RECOVERY_TYPES,
        message,
        proof.signature,
      ),
    );
    eoaSignatureMatches = recoveredEoa === wallet;
  } catch {
    // Smart-account signatures generally cannot be recovered as an EOA.
  }

  const [worldProvider, targetProvider] = await Promise.all([
    getProvider(worldNetwork),
    getProvider(network),
  ]);
  const [worldCode, targetCode] = await Promise.all([
    worldProvider.getCode(wallet),
    targetProvider.getCode(wallet),
  ]);
  const worldAccountKind =
    worldCode && worldCode !== "0x" ? "contract" : "eoa-or-undeployed";
  const targetAccountKind =
    targetCode && targetCode !== "0x" ? "contract" : "undeployed";

  let eip1271Valid = false;
  let eip1271Error = null;
  if (targetAccountKind === "contract") {
    try {
      const contract = new ethers.Contract(
        wallet,
        EIP1271_ABI,
        targetProvider,
      );
      const magic = await contract.isValidSignature(digest, proof.signature);
      eip1271Valid = String(magic).toLowerCase() === EIP1271_MAGIC_VALUE;
    } catch (error) {
      eip1271Error =
        error instanceof Error ? error.message : "EIP-1271 falló";
    }
  }

  let classification;
  let nextStep;
  if (expired) {
    classification = "expired";
    nextStep = "Genera una prueba nueva dentro de World App.";
  } else if (eoaSignatureMatches) {
    classification = "portable-eoa-signature";
    nextStep =
      "La firma recupera la misma EOA. Se pueden estudiar rutas por firma específicas de cada token, pero no firma una transacción EVM genérica.";
  } else if (eip1271Valid) {
    classification = "deployed-smart-account-signature";
    nextStep =
      "La cuenta objetivo reconoce la firma EIP-1271. Ya se puede diseñar una ejecución de smart account con relayer y simulación.";
  } else if (
    worldAccountKind === "contract" &&
    targetAccountKind === "undeployed"
  ) {
    classification = "counterfactual-smart-account";
    nextStep =
      "La cuenta existe en World Chain pero no en la red objetivo. Hay que recuperar de forma verificable su fábrica, singleton, owners, módulos, initializer y salt antes de desplegarla.";
  } else {
    classification = "signature-not-portable";
    nextStep =
      "Esta firma no demuestra autoridad ejecutable en la red objetivo. No se debe construir un relayer todavía.";
  }

  return {
    classification,
    nextStep,
    wallet,
    targetNetwork: network.name,
    targetChainId: chainId,
    digest,
    expired,
    recoveredEoa,
    eoaSignatureMatches,
    worldAccountKind,
    targetAccountKind,
    eip1271Valid,
    eip1271Error,
  };
}
