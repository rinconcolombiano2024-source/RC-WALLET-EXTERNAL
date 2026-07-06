import { ethers } from "ethers";
import {
  ERC1271_ABI,
  ERC20_ABI,
  ERC4337_ENTRYPOINTS,
  NETWORKS,
  SAFE_INTROSPECTION_ABI,
  TOKENS,
} from "./config.js";

const providerCache = new Map();
const ERC1271_MAGIC_VALUE = "0x1626ba7e";
const SAFE_SENTINEL = "0x0000000000000000000000000000000000000001";
const ERC20_INTERFACE = new ethers.Interface(ERC20_ABI);
const BPS_DENOMINATOR = 10_000n;
const GAS_LIMIT_BUFFER_BPS = 12_000n;
const GAS_PRICE_BUFFER_BPS = 12_000n;
const SECP256K1_ORDER =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function timeout(promise, milliseconds, label) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`${label}: tiempo de espera agotado`)),
      milliseconds,
    );
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

function cleanAddressInput(address) {
  return String(address ?? "")
    .trim()
    .replace(/[\s\u200B-\u200D\uFEFF]/g, "");
}

function extractAddressCandidate(address) {
  const cleaned = cleanAddressInput(address);
  const match = cleaned.match(/0x[a-fA-F0-9]{40}/i);
  if (match?.[0]) return `0x${match[0].slice(2)}`;
  return cleaned.startsWith("0X") ? `0x${cleaned.slice(2)}` : cleaned;
}

export function normalizeAddress(address) {
  const candidate = extractAddressCandidate(address);
  if (!/^0x[a-fA-F0-9]{40}$/.test(candidate)) {
    throw new Error(
      "Introduce una dirección EVM completa: debe empezar por 0x y tener 42 caracteres",
    );
  }
  return ethers.getAddress(candidate.toLowerCase());
}

export function isValidEvmAddressInput(address) {
  try {
    normalizeAddress(address);
    return true;
  } catch {
    return false;
  }
}

export function normalizePrivateKey(privateKey) {
  const trimmed = String(privateKey ?? "").trim();
  const prefixed = /^0x/i.test(trimmed)
    ? `0x${trimmed.slice(2)}`
    : `0x${trimmed}`;

  if (!/^0x[a-fA-F0-9]{64}$/.test(prefixed)) {
    throw new Error(
      "La llave privada debe tener 64 caracteres hexadecimales",
    );
  }

  const value = BigInt(prefixed);
  if (value <= 0n || value >= SECP256K1_ORDER) {
    throw new Error("La llave privada no esta dentro del rango EVM valido");
  }

  return prefixed;
}

export function privateKeyToAddress(privateKey) {
  const normalizedPrivateKey = normalizePrivateKey(privateKey);
  const wallet = new ethers.Wallet(normalizedPrivateKey);
  return wallet.address;
}

export function formatBalance(rawBalance, decimals, digits = 6) {
  const value = ethers.formatUnits(rawBalance, decimals);
  const [whole, fraction = ""] = value.split(".");
  const trimmed = fraction.slice(0, digits).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

export async function getProvider(network) {
  if (providerCache.has(network.chainId)) {
    return providerCache.get(network.chainId);
  }

  for (const rpcUrl of network.rpcUrls) {
    try {
      const provider = new ethers.JsonRpcProvider(
        rpcUrl,
        network.chainId,
        {
          staticNetwork: true,
          batchMaxCount: 1,
        },
      );
      const providerNetwork = await timeout(
        provider.getNetwork(),
        7_000,
        network.name,
      );

      if (Number(providerNetwork.chainId) !== network.chainId) {
        throw new Error("El RPC respondió con una chainId distinta");
      }

      await timeout(provider.getBlockNumber(), 7_000, network.name);
      providerCache.set(network.chainId, provider);
      return provider;
    } catch (error) {
      console.warn(`[RPC] ${network.name}: ${rpcUrl}`, error);
    }
  }

  throw new Error(`No hay un RPC disponible para ${network.name}`);
}

async function inspectSafeAccount(provider, owner, hasCode) {
  if (!hasCode) {
    return {
      detected: false,
      reason: "No hay contrato desplegado en esta red",
    };
  }

  const contract = new ethers.Contract(owner, SAFE_INTROSPECTION_ABI, provider);
  const [ownersResult, thresholdResult, versionResult] = await Promise.allSettled([
    timeout(contract.getOwners(), 7_000, "Safe owners"),
    timeout(contract.getThreshold(), 7_000, "Safe threshold"),
    timeout(contract.VERSION(), 7_000, "Safe version"),
  ]);

  if (
    ownersResult.status !== "fulfilled" ||
    thresholdResult.status !== "fulfilled"
  ) {
    return {
      detected: false,
      reason: "El contrato no expone métodos Safe estándar",
    };
  }

  const owners = Array.isArray(ownersResult.value)
    ? ownersResult.value.filter(ethers.isAddress).map((address) =>
        ethers.getAddress(address),
      )
    : [];
  const threshold = Number(thresholdResult.value);

  if (!owners.length || !Number.isFinite(threshold) || threshold <= 0) {
    return {
      detected: false,
      reason: "Los métodos Safe respondieron con datos no válidos",
    };
  }

  let modules = [];
  let modulesReadable = false;
  try {
    const page = await timeout(
      contract.getModulesPaginated(SAFE_SENTINEL, 10),
      7_000,
      "Safe modules",
    );
    const moduleList = Array.isArray(page?.[0]) ? page[0] : [];
    modules = moduleList.filter(ethers.isAddress).map((address) =>
      ethers.getAddress(address),
    );
    modulesReadable = true;
  } catch (error) {
    console.warn("[SAFE MODULES]", error);
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
    recoveryRequirement:
      "Para mover fondos debe firmar el número requerido de owners o existir un módulo autorizado",
  };
}

async function inspectErc1271(provider, owner, hasCode) {
  if (!hasCode) {
    return {
      checked: false,
      supported: false,
      reason: "EIP-1271 solo aplica a cuentas contrato",
    };
  }

  const iface = new ethers.Interface(ERC1271_ABI);
  try {
    const data = iface.encodeFunctionData("isValidSignature", [
      ethers.ZeroHash,
      "0x",
    ]);
    const raw = await timeout(
      provider.call({ to: owner, data }),
      7_000,
      "EIP-1271",
    );
    const [response] = iface.decodeFunctionResult("isValidSignature", raw);
    const normalizedResponse = String(response).toLowerCase();

    return {
      checked: true,
      supported: true,
      validForEmptyTest: normalizedResponse === ERC1271_MAGIC_VALUE,
      response: normalizedResponse,
      note:
        normalizedResponse === ERC1271_MAGIC_VALUE
          ? "El contrato aceptó la firma de prueba vacía; requiere revisión de seguridad"
          : "El método existe, pero la firma de prueba no autoriza movimiento",
    };
  } catch (error) {
    return {
      checked: true,
      supported: false,
      reason:
        error instanceof Error
          ? error.message
          : "El contrato no respondió a isValidSignature",
    };
  }
}

async function inspectEntryPoints(provider) {
  const results = await Promise.allSettled(
    ERC4337_ENTRYPOINTS.map(async (entryPoint) => {
      const address = normalizeAddress(entryPoint.address);
      const code = await timeout(
        provider.getCode(address),
        7_000,
        entryPoint.label,
      );

      return {
        ...entryPoint,
        address,
        deployed: Boolean(code && code !== "0x"),
      };
    }),
  );

  return results.map((result, index) => {
    const entryPoint = ERC4337_ENTRYPOINTS[index];
    if (result.status === "fulfilled") return result.value;

    return {
      ...entryPoint,
      deployed: false,
      error:
        result.reason instanceof Error
          ? result.reason.message
          : "No se pudo consultar EntryPoint",
    };
  });
}

async function inspectAccount(provider, network, owner, accountCode, nativeBalance) {
  const hasCode = Boolean(accountCode && accountCode !== "0x");
  const [safe, erc1271, entryPoints] = await Promise.all([
    inspectSafeAccount(provider, owner, hasCode),
    inspectErc1271(provider, owner, hasCode),
    inspectEntryPoints(provider),
  ]);

  const entryPointAvailable = entryPoints.some((entryPoint) =>
    Boolean(entryPoint.deployed),
  );
  const codeHash = hasCode ? ethers.keccak256(accountCode) : null;
  const kind = safe.detected
    ? "safe-smart-account"
    : hasCode
      ? "contract"
      : "no-contract";

  return {
    address: owner,
    chainId: network.chainId,
    networkName: network.name,
    kind,
    hasCode,
    codeHash,
    nativeGas: {
      symbol: network.symbol,
      hasBalance: nativeBalance > 0n,
      balance: ethers.formatEther(nativeBalance),
      displayBalance: formatBalance(nativeBalance, 18),
      wei: nativeBalance.toString(),
    },
    safe,
    erc1271,
    erc4337: {
      entryPointAvailable,
      entryPoints,
      requirement:
        "ERC-4337 además requiere bundler, paymaster opcional y firma válida según la smart account",
    },
    routeHints: {
      miniKit: Boolean(network.writableWithMiniKit),
      externalSignerRequired: !network.writableWithMiniKit,
      safeOrModuleRequired: hasCode,
      deterministicDeploymentUnknown: !hasCode,
    },
  };
}

async function readToken(provider, network, owner, definition) {
  const rawAddress = definition.addresses?.[network.chainId];
  if (!rawAddress) return null;

  const address = normalizeAddress(rawAddress);
  const code = await timeout(
    provider.getCode(address),
    7_000,
    `${definition.symbol} bytecode`,
  );
  if (!code || code === "0x") return null;

  const contract = new ethers.Contract(address, ERC20_ABI, provider);
  const [rawBalance, decimalsValue, symbolValue] = await Promise.all([
    timeout(
      contract.balanceOf(owner),
      7_000,
      `${definition.symbol} balance`,
    ),
    timeout(
      contract.decimals(),
      7_000,
      `${definition.symbol} decimals`,
    ),
    timeout(contract.symbol(), 7_000, `${definition.symbol} symbol`),
  ]);

  if (rawBalance === 0n) return null;

  const decimals = Number(decimalsValue);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error(`${definition.symbol} devolvió decimales inválidos`);
  }

  return {
    id: `${network.chainId}:${address.toLowerCase()}`,
    network,
    chainId: network.chainId,
    networkName: network.name,
    address,
    isNative: false,
    symbol:
      typeof symbolValue === "string" && symbolValue.trim()
        ? symbolValue.trim()
        : definition.symbol,
    configuredSymbol: definition.symbol,
    decimals,
    rawBalance,
    balance: ethers.formatUnits(rawBalance, decimals),
    displayBalance: formatBalance(rawBalance, decimals),
    projectToken: Boolean(definition.projectToken),
    customToken: Boolean(definition.customToken),
  };
}

async function scanNetwork(network, owner, customTokens) {
  const provider = await getProvider(network);
  const [accountCode, nativeBalance] = await Promise.all([
    timeout(
      provider.getCode(owner),
      7_000,
      `${network.name} account code`,
    ),
    timeout(
      provider.getBalance(owner),
      7_000,
      `${network.name} native balance`,
    ),
  ]);
  const accountState = await inspectAccount(
    provider,
    network,
    owner,
    accountCode,
    nativeBalance,
  );
  const accountKind = accountState.kind;

  const assets = [];

  if (nativeBalance > 0n) {
    assets.push({
      id: `${network.chainId}:native`,
      network,
      chainId: network.chainId,
      networkName: network.name,
      address: null,
      isNative: true,
      symbol: network.symbol,
      configuredSymbol: network.symbol,
      decimals: 18,
      rawBalance: nativeBalance,
      balance: ethers.formatEther(nativeBalance),
      displayBalance: formatBalance(nativeBalance, 18),
      accountKind,
      accountState,
    });
  }

  const definitions = [
    ...TOKENS.filter((token) => token.addresses?.[network.chainId]),
    ...customTokens
      .filter((token) => token.chainId === network.chainId)
      .map((token) => ({
        symbol: token.symbol || "CUSTOM",
        customToken: true,
        addresses: { [network.chainId]: token.address },
      })),
  ];

  const results = await Promise.allSettled(
    definitions.map((definition) =>
      readToken(provider, network, owner, definition),
    ),
  );

  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      assets.push({ ...result.value, accountKind, accountState });
    } else if (result.status === "rejected") {
      console.warn(`[TOKEN] ${network.name}`, result.reason);
    }
  }

  return {
    network,
    accountKind,
    accountState,
    assets,
  };
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
      networks[network.chainId] = {
        status: "online",
        accountKind: result.value.accountKind,
        accountState: result.value.accountState,
      };
    } else {
      networks[network.chainId] = {
        status: "offline",
        error:
          result.reason instanceof Error
            ? result.reason.message
            : "No se pudo consultar la red",
      };
    }
  });

  const uniqueAssets = [...new Map(
    assets.map((asset) => [asset.id, asset]),
  ).values()];

  uniqueAssets.sort((left, right) => {
    if (left.chainId === 480 && right.chainId !== 480) return -1;
    if (right.chainId === 480 && left.chainId !== 480) return 1;
    if (left.chainId !== right.chainId) return left.chainId - right.chainId;
    return left.symbol.localeCompare(right.symbol);
  });

  return { owner, assets: uniqueAssets, networks };
}

export async function switchExternalNetwork(provider, network) {
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: network.chainHex }],
    });
  } catch (error) {
    if (error?.code !== 4902) throw error;

    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: network.chainHex,
          chainName: network.name,
          nativeCurrency: {
            name: network.symbol,
            symbol: network.symbol,
            decimals: 18,
          },
          rpcUrls: network.rpcUrls,
          blockExplorerUrls: [network.explorer],
        },
      ],
    });
  }
}

function applyBuffer(value, bps) {
  return (value * bps + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR;
}

function getGasPriceForMaxCost(feeData) {
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice;
  if (!gasPrice || gasPrice <= 0n) {
    throw new Error("La red no devolvio precio de gas valido");
  }

  return applyBuffer(BigInt(gasPrice), GAS_PRICE_BUFFER_BPS);
}

function prepareTransfer({
  asset,
  targetAddress,
  recipient,
  amount,
  feeRecipient,
  feeAmountUnits = 0n,
}) {
  const owner = normalizeAddress(targetAddress);
  const destination = normalizeAddress(recipient);
  if (owner === destination) {
    throw new Error("La direccion de destino es igual a la direccion origen");
  }

  const amountUnits = ethers.parseUnits(amount, asset.decimals);
  if (amountUnits <= 0n) {
    throw new Error("La cantidad debe ser mayor que cero");
  }
  if (amountUnits > asset.rawBalance) {
    throw new Error("La cantidad supera el balance detectado");
  }

  const feeUnits = BigInt(feeAmountUnits);
  if (feeUnits < 0n || feeUnits >= amountUnits) {
    throw new Error("La comision calculada no es valida");
  }

  if (feeUnits > 0n && !feeRecipient) {
    throw new Error("Falta la direccion que recibe la comision");
  }

  const recipientAmountUnits = amountUnits - feeUnits;
  if (recipientAmountUnits <= 0n) {
    throw new Error("El monto neto para el usuario debe ser mayor que cero");
  }

  const normalizedFeeRecipient =
    feeUnits > 0n && feeRecipient ? normalizeAddress(feeRecipient) : null;
  const txRequests = [];

  if (asset.isNative) {
    txRequests.push({
      to: destination,
      value: recipientAmountUnits,
    });

    if (normalizedFeeRecipient) {
      txRequests.push({
        to: normalizedFeeRecipient,
        value: feeUnits,
      });
    }
  } else {
    const tokenAddress = normalizeAddress(asset.address);
    txRequests.push({
      to: tokenAddress,
      data: ERC20_INTERFACE.encodeFunctionData("transfer", [
        destination,
        recipientAmountUnits,
      ]),
      value: 0n,
    });

    if (normalizedFeeRecipient) {
      txRequests.push({
        to: tokenAddress,
        data: ERC20_INTERFACE.encodeFunctionData("transfer", [
          normalizedFeeRecipient,
          feeUnits,
        ]),
        value: 0n,
      });
    }
  }

  return {
    owner,
    destination,
    amountUnits,
    feeUnits,
    recipientAmountUnits,
    requiredNativeValue: asset.isNative ? amountUnits : 0n,
    txRequests,
  };
}

async function estimateGasCost(provider, signer, txRequests, networkSymbol) {
  const [feeData, gasResults] = await Promise.all([
    provider.getFeeData(),
    Promise.allSettled(
      txRequests.map((transaction) => signer.estimateGas(transaction)),
    ),
  ]);

  let gasLimit = 0n;
  for (const result of gasResults) {
    if (result.status !== "fulfilled") {
      const message =
        result.reason instanceof Error
          ? result.reason.message
          : "La simulacion de gas fallo";
      throw new Error(
        `La red rechazo la simulacion antes de firmar: ${message}`,
      );
    }
    gasLimit += BigInt(result.value);
  }

  const bufferedGasLimit = applyBuffer(gasLimit, GAS_LIMIT_BUFFER_BPS);
  const maxGasPrice = getGasPriceForMaxCost(feeData);
  const estimatedMaxGasCost = bufferedGasLimit * maxGasPrice;

  return {
    gasLimit,
    bufferedGasLimit,
    maxGasPrice,
    estimatedMaxGasCost,
    displayEstimatedMaxGasCost: `${formatBalance(
      estimatedMaxGasCost,
      18,
      8,
    )} ${networkSymbol}`,
  };
}

async function assertCanPayNativeCosts({
  provider,
  signer,
  owner,
  asset,
  txRequests,
  requiredNativeValue,
}) {
  const [nativeBalance, gas] = await Promise.all([
    provider.getBalance(owner),
    estimateGasCost(provider, signer, txRequests, asset.network.symbol),
  ]);
  const requiredTotal = requiredNativeValue + gas.estimatedMaxGasCost;

  if (nativeBalance < requiredTotal) {
    throw new Error(
      `Saldo insuficiente para pagar gas en ${asset.networkName}. Tienes ${formatBalance(
        nativeBalance,
        18,
        8,
      )} ${asset.network.symbol}; necesitas aprox ${formatBalance(
        requiredTotal,
        18,
        8,
      )} ${asset.network.symbol} incluyendo gas.`,
    );
  }

  return {
    nativeBalance: nativeBalance.toString(),
    requiredTotal: requiredTotal.toString(),
    displayNativeBalance: `${formatBalance(nativeBalance, 18, 8)} ${
      asset.network.symbol
    }`,
    displayRequiredTotal: `${formatBalance(requiredTotal, 18, 8)} ${
      asset.network.symbol
    }`,
    gas: {
      gasLimit: gas.gasLimit.toString(),
      bufferedGasLimit: gas.bufferedGasLimit.toString(),
      maxGasPrice: gas.maxGasPrice.toString(),
      estimatedMaxGasCost: gas.estimatedMaxGasCost.toString(),
      displayEstimatedMaxGasCost: gas.displayEstimatedMaxGasCost,
    },
  };
}

async function sendPreparedTransactions(signer, txRequests) {
  const transactions = [];
  for (const txRequest of txRequests) {
    transactions.push(await signer.sendTransaction(txRequest));
  }

  const receipts = [];
  for (const transaction of transactions) {
    receipts.push(await transaction.wait(1));
  }

  return {
    hash: transactions[0]?.hash ?? null,
    hashes: transactions.map((transaction) => transaction.hash),
    receipt: receipts[0] ?? null,
    receipts,
  };
}

export async function sendWithExternalWallet({
  provider,
  asset,
  targetAddress,
  recipient,
  amount,
  feeRecipient,
  feeAmountUnits = 0n,
}) {
  if (!provider?.request) {
    throw new Error("La conexión externa no expone un proveedor EIP-1193");
  }

  const owner = normalizeAddress(targetAddress);
  const destination = normalizeAddress(recipient);
  if (owner === destination) {
    throw new Error("La dirección de destino es igual a la dirección origen");
  }

  await switchExternalNetwork(provider, asset.network);
  const browserProvider = new ethers.BrowserProvider(provider);
  const signer = await browserProvider.getSigner();
  const signerAddress = normalizeAddress(await signer.getAddress());
  const transfer = prepareTransfer({
    asset,
    targetAddress,
    recipient,
    amount,
    feeRecipient,
    feeAmountUnits,
  });

  if (signerAddress !== transfer.owner) {
    throw new Error(
      "La wallet conectada no controla la dirección donde están los fondos",
    );
  }

  const amountUnits = ethers.parseUnits(amount, asset.decimals);
  if (amountUnits <= 0n) {
    throw new Error("La cantidad debe ser mayor que cero");
  }
  if (amountUnits > asset.rawBalance) {
    throw new Error("La cantidad supera el balance detectado");
  }
  const feeUnits = BigInt(feeAmountUnits);
  if (feeUnits < 0n || feeUnits >= amountUnits) {
    throw new Error("La comisión calculada no es válida");
  }
  const recipientAmountUnits = amountUnits - feeUnits;
  if (recipientAmountUnits <= 0n) {
    throw new Error("El monto neto para el usuario debe ser mayor que cero");
  }
  const normalizedFeeRecipient =
    feeUnits > 0n && feeRecipient ? normalizeAddress(feeRecipient) : null;
  const preflight = await assertCanPayNativeCosts({
    provider: browserProvider,
    signer,
    owner: transfer.owner,
    asset,
    txRequests: transfer.txRequests,
    requiredNativeValue: transfer.requiredNativeValue,
  });

  const transactions = [];
  if (asset.isNative) {
    const transaction = await signer.sendTransaction({
      to: destination,
      value: recipientAmountUnits,
    });
    transactions.push(transaction);

    if (normalizedFeeRecipient) {
      const feeTransaction = await signer.sendTransaction({
        to: normalizedFeeRecipient,
        value: feeUnits,
      });
      transactions.push(feeTransaction);
    }
  } else {
    const contract = new ethers.Contract(asset.address, ERC20_ABI, signer);
    const transaction = await contract.transfer(
      destination,
      recipientAmountUnits,
    );
    transactions.push(transaction);

    if (normalizedFeeRecipient) {
      const feeTransaction = await contract.transfer(
        normalizedFeeRecipient,
        feeUnits,
      );
      transactions.push(feeTransaction);
    }
  }

  const receipts = [];
  for (const transaction of transactions) {
    receipts.push(await transaction.wait(1));
  }

  return {
    hash: transactions[0]?.hash ?? null,
    hashes: transactions.map((transaction) => transaction.hash),
    receipt: receipts[0] ?? null,
    receipts,
    preflight,
  };
}

export async function sendWithPrivateKeyWallet({
  privateKey,
  asset,
  targetAddress,
  recipient,
  amount,
  feeRecipient,
  feeAmountUnits = 0n,
}) {
  const owner = normalizeAddress(targetAddress);
  const destination = normalizeAddress(recipient);
  if (owner === destination) {
    throw new Error("La direccion de destino es igual a la direccion origen");
  }

  const provider = await getProvider(asset.network);
  const signer = new ethers.Wallet(normalizePrivateKey(privateKey), provider);
  const signerAddress = normalizeAddress(signer.address);
  const transfer = prepareTransfer({
    asset,
    targetAddress,
    recipient,
    amount,
    feeRecipient,
    feeAmountUnits,
  });

  if (signerAddress !== transfer.owner) {
    throw new Error(
      "La llave privada local no corresponde a la direccion donde estan los fondos",
    );
  }

  const amountUnits = ethers.parseUnits(amount, asset.decimals);
  if (amountUnits <= 0n) {
    throw new Error("La cantidad debe ser mayor que cero");
  }
  if (amountUnits > asset.rawBalance) {
    throw new Error("La cantidad supera el balance detectado");
  }
  const feeUnits = BigInt(feeAmountUnits);
  if (feeUnits < 0n || feeUnits >= amountUnits) {
    throw new Error("La comision calculada no es valida");
  }
  const recipientAmountUnits = amountUnits - feeUnits;
  if (recipientAmountUnits <= 0n) {
    throw new Error("El monto neto para el usuario debe ser mayor que cero");
  }
  const normalizedFeeRecipient =
    feeUnits > 0n && feeRecipient ? normalizeAddress(feeRecipient) : null;
  const preflight = await assertCanPayNativeCosts({
    provider,
    signer,
    owner: transfer.owner,
    asset,
    txRequests: transfer.txRequests,
    requiredNativeValue: transfer.requiredNativeValue,
  });

  const transactions = [];
  if (asset.isNative) {
    const transaction = await signer.sendTransaction({
      to: destination,
      value: recipientAmountUnits,
    });
    transactions.push(transaction);

    if (normalizedFeeRecipient) {
      const feeTransaction = await signer.sendTransaction({
        to: normalizedFeeRecipient,
        value: feeUnits,
      });
      transactions.push(feeTransaction);
    }
  } else {
    const contract = new ethers.Contract(asset.address, ERC20_ABI, signer);
    const transaction = await contract.transfer(
      destination,
      recipientAmountUnits,
    );
    transactions.push(transaction);

    if (normalizedFeeRecipient) {
      const feeTransaction = await contract.transfer(
        normalizedFeeRecipient,
        feeUnits,
      );
      transactions.push(feeTransaction);
    }
  }

  const receipts = [];
  for (const transaction of transactions) {
    receipts.push(await transaction.wait(1));
  }

  return {
    hash: transactions[0]?.hash ?? null,
    hashes: transactions.map((transaction) => transaction.hash),
    receipt: receipts[0] ?? null,
    receipts,
    preflight,
  };
}
