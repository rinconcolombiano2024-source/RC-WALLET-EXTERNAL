import { ethers } from "ethers";
import {
  ERC1271_ABI,
  ERC20_ABI,
  NETWORKS,
  SAFE_INTROSPECTION_ABI,
  SAFE_SENTINEL,
  STORAGE_KEYS,
  TOKENS,
  WORLD_CHAIN_ID,
} from "./config.js";

const providerCache = new Map();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function cleanAddressInput(address) {
  return String(address ?? "")
    .trim()
    .replace(/[\s\u200B-\u200D\uFEFF]/g, "");
}

export function normalizeAddress(address) {
  const cleaned = cleanAddressInput(address);
  const match = cleaned.match(/0x[a-fA-F0-9]{40}/i);
  const candidate = match?.[0]
    ? `0x${match[0].slice(2)}`
    : cleaned.startsWith("0X")
      ? `0x${cleaned.slice(2)}`
      : cleaned;

  if (!/^0x[a-fA-F0-9]{40}$/.test(candidate)) {
    throw new Error("Introduce una dirección EVM válida.");
  }

  return ethers.getAddress(candidate.toLowerCase());
}

export function tryNormalizeAddress(address) {
  try {
    return normalizeAddress(address);
  } catch {
    return "";
  }
}

export function normalizePrivateKey(input) {
  const cleaned = String(input ?? "")
    .trim()
    .replace(/[\s\u200B-\u200D\uFEFF]/g, "");
  const withPrefix = cleaned.startsWith("0x") || cleaned.startsWith("0X")
    ? `0x${cleaned.slice(2)}`
    : `0x${cleaned}`;

  if (!/^0x[a-fA-F0-9]{64}$/.test(withPrefix)) {
    throw new Error("La llave privada debe tener 64 caracteres hexadecimales.");
  }

  return withPrefix.toLowerCase();
}

export function deriveWallet(privateKey) {
  const normalizedPrivateKey = normalizePrivateKey(privateKey);
  const wallet = new ethers.Wallet(normalizedPrivateKey);
  return {
    privateKey: normalizedPrivateKey,
    address: ethers.getAddress(wallet.address),
  };
}

export function compareAddresses(left, right) {
  const normalizedLeft = tryNormalizeAddress(left);
  const normalizedRight = tryNormalizeAddress(right);
  return Boolean(
    normalizedLeft &&
      normalizedRight &&
      normalizedLeft.toLowerCase() === normalizedRight.toLowerCase(),
  );
}

export function formatBalance(rawBalance, decimals, digits = 6) {
  const value = ethers.formatUnits(rawBalance, decimals);
  const [whole, fraction = ""] = value.split(".");
  const trimmed = fraction.slice(0, digits).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

export function compactAddress(address) {
  return address ? `${address.slice(0, 8)}…${address.slice(-6)}` : "";
}

async function deriveCryptoKey(password, salt) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 250_000,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptVault({ privateKey, address, expectedAddress }, password) {
  if (!password || password.length < 8) {
    throw new Error("La contraseña local debe tener mínimo 8 caracteres.");
  }

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveCryptoKey(password, salt);
  const payload = JSON.stringify({
    privateKey: normalizePrivateKey(privateKey),
    address: normalizeAddress(address),
    expectedAddress: expectedAddress ? normalizeAddress(expectedAddress) : "",
    createdAt: new Date().toISOString(),
  });
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(payload),
  );

  return {
    format: "rc-wallet-external-vault",
    version: 1,
    kdf: "PBKDF2-SHA256",
    iterations: 250_000,
    cipher: "AES-256-GCM",
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    data: bytesToBase64(cipher),
  };
}

export async function decryptVault(vault, password) {
  if (vault?.format !== "rc-wallet-external-vault" || vault?.version !== 1) {
    throw new Error("El archivo local de wallet no es compatible.");
  }

  const salt = base64ToBytes(vault.salt);
  const iv = base64ToBytes(vault.iv);
  const key = await deriveCryptoKey(password, salt);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    base64ToBytes(vault.data),
  );
  const parsed = JSON.parse(decoder.decode(plain));
  return {
    privateKey: normalizePrivateKey(parsed.privateKey),
    address: normalizeAddress(parsed.address),
    expectedAddress: parsed.expectedAddress ? normalizeAddress(parsed.expectedAddress) : "",
  };
}

export function readStoredVault() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.vault);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function writeStoredVault(vault) {
  localStorage.setItem(STORAGE_KEYS.vault, JSON.stringify(vault));
}

export function deleteStoredVault() {
  localStorage.removeItem(STORAGE_KEYS.vault);
}

export function readCustomTokens() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEYS.customTokens) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeCustomTokens(tokens) {
  localStorage.setItem(STORAGE_KEYS.customTokens, JSON.stringify(tokens));
}

async function timeout(promise, milliseconds, label) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`${label}: tiempo de espera agotado`)),
      milliseconds,
    );
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

export async function getProvider(network) {
  if (providerCache.has(network.chainId)) return providerCache.get(network.chainId);

  for (const rpcUrl of network.rpcUrls) {
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl, network.chainId, {
        staticNetwork: true,
        batchMaxCount: 1,
      });
      await timeout(provider.getBlockNumber(), 8_000, network.name);
      providerCache.set(network.chainId, provider);
      return provider;
    } catch (error) {
      console.warn(`[RPC ${network.name}]`, error);
    }
  }

  throw new Error(`No hay RPC disponible para ${network.name}.`);
}

async function inspectSafe(provider, address, hasCode) {
  if (!hasCode) {
    return {
      detected: false,
      reason: "No hay contrato desplegado en esta red.",
    };
  }

  const contract = new ethers.Contract(address, SAFE_INTROSPECTION_ABI, provider);
  const [ownersResult, thresholdResult, versionResult] = await Promise.allSettled([
    timeout(contract.getOwners(), 8_000, "Safe owners"),
    timeout(contract.getThreshold(), 8_000, "Safe threshold"),
    timeout(contract.VERSION(), 8_000, "Safe version"),
  ]);

  if (
    ownersResult.status !== "fulfilled" ||
    thresholdResult.status !== "fulfilled"
  ) {
    return {
      detected: false,
      reason: "La cuenta tiene bytecode, pero no responde como Safe estándar.",
    };
  }

  const owners = Array.isArray(ownersResult.value)
    ? ownersResult.value.filter(ethers.isAddress).map((item) => ethers.getAddress(item))
    : [];
  const threshold = Number(thresholdResult.value);

  if (!owners.length || !Number.isFinite(threshold) || threshold <= 0) {
    return {
      detected: false,
      reason: "Safe respondió datos no válidos.",
    };
  }

  let modules = [];
  let modulesReadable = false;
  try {
    const page = await timeout(
      contract.getModulesPaginated(SAFE_SENTINEL, 10),
      8_000,
      "Safe modules",
    );
    modules = Array.isArray(page?.[0])
      ? page[0].filter(ethers.isAddress).map((item) => ethers.getAddress(item))
      : [];
    modulesReadable = true;
  } catch {
    modulesReadable = false;
  }

  return {
    detected: true,
    version:
      versionResult.status === "fulfilled" && versionResult.value
        ? String(versionResult.value)
        : "desconocida",
    owners,
    threshold,
    modules,
    modulesReadable,
  };
}

async function inspectEip1271(provider, address, hasCode) {
  if (!hasCode) {
    return {
      checked: false,
      supported: false,
      reason: "EIP-1271 solo aplica a smart accounts.",
    };
  }

  const iface = new ethers.Interface(ERC1271_ABI);
  try {
    const data = iface.encodeFunctionData("isValidSignature", [
      ethers.ZeroHash,
      "0x",
    ]);
    await timeout(provider.call({ to: address, data }), 8_000, "EIP-1271");
    return {
      checked: true,
      supported: true,
      reason: "La cuenta expone isValidSignature.",
    };
  } catch (error) {
    return {
      checked: true,
      supported: false,
      reason:
        error instanceof Error
          ? error.message
          : "La cuenta no respondió a EIP-1271.",
    };
  }
}

export async function inspectWorldAppAccount(address) {
  const normalizedAddress = normalizeAddress(address);
  const worldNetwork = NETWORKS.find((network) => network.chainId === WORLD_CHAIN_ID);
  if (!worldNetwork) {
    throw new Error("World Chain no está configurada.");
  }

  const provider = await getProvider(worldNetwork);
  const [code, nativeBalance] = await Promise.all([
    timeout(provider.getCode(normalizedAddress), 8_000, "World account code"),
    timeout(provider.getBalance(normalizedAddress), 8_000, "World account balance"),
  ]);
  const hasCode = Boolean(code && code !== "0x");
  const [safe, erc1271] = await Promise.all([
    inspectSafe(provider, normalizedAddress, hasCode),
    inspectEip1271(provider, normalizedAddress, hasCode),
  ]);

  return {
    address: normalizedAddress,
    chainId: WORLD_CHAIN_ID,
    networkName: worldNetwork.name,
    hasCode,
    accountKind: safe.detected
      ? "safe-smart-account"
      : hasCode
        ? "smart-account-or-contract"
        : "eoa-or-undeployed",
    codeHash: hasCode ? ethers.keccak256(code) : null,
    nativeBalance: {
      wei: nativeBalance.toString(),
      displayBalance: formatBalance(nativeBalance, 18),
      symbol: worldNetwork.symbol,
    },
    safe,
    erc1271,
  };
}

export function createImportDiagnosis({
  derivedAddress,
  expectedAddress,
  worldAccount,
}) {
  const normalizedDerived = tryNormalizeAddress(derivedAddress);
  const normalizedExpected = tryNormalizeAddress(expectedAddress);

  if (!normalizedDerived) {
    return {
      status: "invalid-derived",
      blocksOperation: true,
      title: "Dirección derivada inválida",
      detail: "La llave privada no generó una dirección EVM válida.",
      derivedAddress: "",
      expectedAddress: normalizedExpected,
    };
  }

  if (!normalizedExpected) {
    return {
      status: "unverified",
      blocksOperation: false,
      title: "Wallet derivada sin comparación World App",
      detail:
        "No hay dirección World App esperada. Puedes operar esta llave, pero no queda demostrado que pertenezca a World App.",
      derivedAddress: normalizedDerived,
      expectedAddress: "",
      worldAccount,
    };
  }

  if (compareAddresses(normalizedDerived, normalizedExpected)) {
    return {
      status: "match",
      blocksOperation: false,
      title: "Coincidencia exacta",
      detail: "La llave privada genera exactamente la dirección World App esperada.",
      derivedAddress: normalizedDerived,
      expectedAddress: normalizedExpected,
      worldAccount,
    };
  }

  const safeOwners = worldAccount?.safe?.owners ?? [];
  const derivedIsSafeOwner = safeOwners.some((owner) =>
    compareAddresses(owner, normalizedDerived),
  );

  if (derivedIsSafeOwner) {
    return {
      status: "safe-owner-not-safe-address",
      blocksOperation: true,
      title: "La llave parece owner de una Safe, no la dirección Safe",
      detail:
        "La dirección World App esperada es una Safe/smart account. La llave derivada es owner, pero no es la dirección que contiene los fondos. Para mover fondos se requiere ejecución Safe real con threshold/módulos.",
      derivedAddress: normalizedDerived,
      expectedAddress: normalizedExpected,
      worldAccount,
    };
  }

  if (worldAccount?.hasCode) {
    return {
      status: "smart-account-mismatch",
      blocksOperation: true,
      title: "World App usa smart account o contrato",
      detail:
        "La dirección esperada tiene bytecode en World Chain. Una llave EOA distinta no puede mover directamente fondos de esa smart account.",
      derivedAddress: normalizedDerived,
      expectedAddress: normalizedExpected,
      worldAccount,
    };
  }

  return {
    status: "mismatch",
    blocksOperation: true,
    title: "La llave privada no corresponde a la dirección esperada",
    detail:
      "La dirección derivada y la dirección World App esperada son diferentes. Revisa que la llave exportada sea la correcta.",
    derivedAddress: normalizedDerived,
    expectedAddress: normalizedExpected,
    worldAccount,
  };
}

async function readToken(provider, network, owner, token) {
  const rawAddress = token.addresses?.[network.chainId] ?? token.address;
  if (!rawAddress) return null;

  const address = normalizeAddress(rawAddress);
  const code = await timeout(provider.getCode(address), 8_000, `${token.symbol} code`);
  if (!code || code === "0x") return null;

  const contract = new ethers.Contract(address, ERC20_ABI, provider);
  const [rawBalance, decimalsValue, symbolValue, nameValue] = await Promise.all([
    timeout(contract.balanceOf(owner), 8_000, `${token.symbol} balance`),
    timeout(contract.decimals(), 8_000, `${token.symbol} decimals`),
    timeout(contract.symbol(), 8_000, `${token.symbol} symbol`).catch(() => token.symbol),
    timeout(contract.name(), 8_000, `${token.symbol} name`).catch(() => token.symbol),
  ]);

  if (rawBalance === 0n) return null;
  const decimals = Number(decimalsValue);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) return null;

  const symbol = typeof symbolValue === "string" && symbolValue.trim()
    ? symbolValue.trim()
    : token.symbol;

  return {
    id: `${network.chainId}:${address.toLowerCase()}`,
    chainId: network.chainId,
    network,
    networkName: network.name,
    address,
    isNative: false,
    symbol,
    name: typeof nameValue === "string" ? nameValue : symbol,
    decimals,
    rawBalance,
    balance: ethers.formatUnits(rawBalance, decimals),
    displayBalance: formatBalance(rawBalance, decimals),
    customToken: Boolean(token.customToken),
    projectToken: Boolean(token.projectToken),
  };
}

async function scanNetwork(network, owner, customTokens) {
  const provider = await getProvider(network);
  const nativeBalance = await timeout(
    provider.getBalance(owner),
    8_000,
    `${network.name} balance nativo`,
  );
  const assets = [];

  if (nativeBalance > 0n) {
    assets.push({
      id: `${network.chainId}:native`,
      chainId: network.chainId,
      network,
      networkName: network.name,
      address: null,
      isNative: true,
      symbol: network.symbol,
      name: `${network.symbol} nativo`,
      decimals: 18,
      rawBalance: nativeBalance,
      balance: ethers.formatEther(nativeBalance),
      displayBalance: formatBalance(nativeBalance, 18),
    });
  }

  const configuredTokens = [
    ...TOKENS.filter((token) => token.addresses?.[network.chainId]),
    ...customTokens
      .filter((token) => Number(token.chainId) === network.chainId)
      .map((token) => ({
        ...token,
        customToken: true,
        addresses: { [network.chainId]: token.address },
      })),
  ];

  const tokenResults = await Promise.allSettled(
    configuredTokens.map((token) => readToken(provider, network, owner, token)),
  );
  for (const result of tokenResults) {
    if (result.status === "fulfilled" && result.value) assets.push(result.value);
    if (result.status === "rejected") console.warn(`[TOKEN ${network.name}]`, result.reason);
  }

  return { network, assets };
}

export async function scanAllNetworks(ownerAddress, customTokens = []) {
  const owner = normalizeAddress(ownerAddress);
  const results = await Promise.allSettled(
    NETWORKS.map((network) => scanNetwork(network, owner, customTokens)),
  );

  const assets = [];
  const networks = {};

  results.forEach((result, index) => {
    const network = NETWORKS[index];
    if (result.status === "fulfilled") {
      assets.push(...result.value.assets);
      networks[network.chainId] = { status: "online", assetCount: result.value.assets.length };
    } else {
      networks[network.chainId] = {
        status: "offline",
        error: result.reason instanceof Error ? result.reason.message : "No se pudo escanear.",
      };
    }
  });

  return {
    owner,
    assets: [...new Map(assets.map((asset) => [asset.id, asset])).values()].sort((a, b) => {
      if (a.chainId !== b.chainId) return a.chainId - b.chainId;
      if (a.isNative !== b.isNative) return a.isNative ? -1 : 1;
      return a.symbol.localeCompare(b.symbol);
    }),
    networks,
  };
}

export async function estimateTransferGas({ privateKey, asset, recipient, amount }) {
  const provider = await getProvider(asset.network);
  const signer = new ethers.Wallet(normalizePrivateKey(privateKey), provider);
  const destination = normalizeAddress(recipient);
  const amountUnits = ethers.parseUnits(String(amount).trim().replace(",", "."), asset.decimals);

  if (asset.isNative) {
    return signer.estimateGas({ to: destination, value: amountUnits });
  }

  const contract = new ethers.Contract(asset.address, ERC20_ABI, signer);
  return contract.transfer.estimateGas(destination, amountUnits);
}

export async function sendAsset({ privateKey, asset, recipient, amount }) {
  const provider = await getProvider(asset.network);
  const signer = new ethers.Wallet(normalizePrivateKey(privateKey), provider);
  const destination = normalizeAddress(recipient);
  const amountUnits = ethers.parseUnits(String(amount).trim().replace(",", "."), asset.decimals);

  if (amountUnits <= 0n) throw new Error("La cantidad debe ser mayor que cero.");
  if (amountUnits > asset.rawBalance) throw new Error("La cantidad supera el balance.");

  if (asset.isNative) {
    const transaction = await signer.sendTransaction({ to: destination, value: amountUnits });
    return transaction.wait(1).then((receipt) => ({ hash: transaction.hash, receipt }));
  }

  const contract = new ethers.Contract(asset.address, ERC20_ABI, signer);
  const transaction = await contract.transfer(destination, amountUnits);
  return transaction.wait(1).then((receipt) => ({ hash: transaction.hash, receipt }));
}

export function explorerAddressUrl(network, address) {
  return `${network.explorer}/address/${address}`;
}

export function explorerTxUrl(network, hash) {
  return `${network.explorer}/tx/${hash}`;
}

export function tokenExplorerUrl(asset) {
  return asset.address ? `${asset.network.explorer}/token/${asset.address}` : asset.network.explorer;
}
