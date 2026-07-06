import { normalizeAddress } from "./blockchain.js";
import { NETWORKS } from "./config.js";

const DEFAULT_REOWN_PROJECT_ID = "aa5427a18f0efc9d533439359b0031b3";

export const reownProjectId =
  import.meta.env.VITE_REOWN_PROJECT_ID?.trim() || DEFAULT_REOWN_PROJECT_ID;

export const walletConnectConfigured = Boolean(
  reownProjectId && reownProjectId !== "your_reown_walletconnect_project_id",
);

function normalizeChainId(chainId) {
  if (typeof chainId === "number") return chainId;
  if (typeof chainId === "string" && chainId.startsWith("0x")) {
    return Number.parseInt(chainId, 16);
  }
  return Number(chainId);
}

function firstAccount(provider) {
  const accounts = provider?.accounts ?? [];
  if (!accounts[0]) {
    throw new Error("La wallet externa no entregó ninguna cuenta para firmar");
  }
  return normalizeAddress(accounts[0]);
}

function attachProviderListeners(provider, handlers = {}) {
  const onAccountsChanged = (accounts) => {
    try {
      const account = accounts?.[0];
      handlers.onAccount?.(account ? normalizeAddress(account) : "");
    } catch (error) {
      console.warn("[WALLET ACCOUNT]", error);
      handlers.onAccount?.("");
    }
  };
  const onChainChanged = (chainId) => {
    handlers.onChain?.(normalizeChainId(chainId));
  };
  const onDisconnect = () => {
    handlers.onDisconnect?.();
  };

  provider.on?.("accountsChanged", onAccountsChanged);
  provider.on?.("chainChanged", onChainChanged);
  provider.on?.("disconnect", onDisconnect);

  return () => {
    provider.removeListener?.("accountsChanged", onAccountsChanged);
    provider.removeListener?.("chainChanged", onChainChanged);
    provider.removeListener?.("disconnect", onDisconnect);
  };
}

export async function connectInjectedProvider(handlers) {
  const provider = window.ethereum;
  if (!provider?.request) {
    throw new Error(
      "No se detectó wallet inyectada en este navegador. En World App usa WalletConnect/Reown para abrir Trust Wallet, MetaMask, Binance Wallet o Coinbase Wallet.",
    );
  }

  const accounts = await provider.request({
    method: "eth_requestAccounts",
  });
  if (!accounts?.[0]) {
    throw new Error("La wallet externa no entregó ninguna cuenta para firmar");
  }
  const chainId = await provider.request({
    method: "eth_chainId",
  });

  return {
    type: "injected",
    name: "Wallet del navegador",
    provider,
    account: normalizeAddress(accounts?.[0] ?? ""),
    chainId: normalizeChainId(chainId),
    cleanup: attachProviderListeners(provider, handlers),
  };
}

export async function connectWalletConnectProvider(handlers) {
  if (!walletConnectConfigured) {
    throw new Error(
      "Configura VITE_REOWN_PROJECT_ID para usar WalletConnect",
    );
  }

  const origin = window.location.origin;
  const { default: EthereumProvider } = await import(
    "@walletconnect/ethereum-provider"
  );
  const provider = await EthereumProvider.init({
    projectId: reownProjectId,
    chains: [1],
    optionalChains: NETWORKS.map((network) => network.chainId),
    methods: [
      "eth_sendTransaction",
      "personal_sign",
      "eth_signTypedData",
      "eth_signTypedData_v4",
      "wallet_switchEthereumChain",
      "wallet_addEthereumChain",
    ],
    optionalMethods: [
      "eth_sendTransaction",
      "personal_sign",
      "eth_signTypedData",
      "eth_signTypedData_v4",
      "wallet_switchEthereumChain",
      "wallet_addEthereumChain",
    ],
    events: ["accountsChanged", "chainChanged", "disconnect"],
    optionalEvents: ["accountsChanged", "chainChanged", "disconnect"],
    showQrModal: true,
    metadata: {
      name: "RC Wallet External",
      description:
        "Firma movimientos EVM con la misma direccion de World App.",
      url: origin,
      icons: [`${origin}/rc-icon.svg`],
    },
    rpcMap: Object.fromEntries(
      NETWORKS.map((network) => [
        network.chainId,
        network.rpcUrls[0],
      ]),
    ),
  });

  await provider.connect();

  return {
    type: "walletconnect",
    name: "WalletConnect",
    provider,
    account: firstAccount(provider),
    chainId: normalizeChainId(provider.chainId),
    cleanup: attachProviderListeners(provider, handlers),
  };
}

export async function disconnectExternalProvider(connection) {
  connection?.cleanup?.();
  if (
    connection?.type === "walletconnect" &&
    typeof connection.provider?.disconnect === "function"
  ) {
    await connection.provider.disconnect();
  }
}
