export const SAFE_DEPLOYMENT_CATALOG_VERSION = 2;

export const SAFE_DEPLOYMENT_CATALOG_SOURCES = Object.freeze([
  {
    id: "safe-docs-deployment",
    type: "official-docs",
    url: "https://docs.safe.global/sdk/protocol-kit/guides/safe-deployment",
    note:
      "Safe Protocol Kit deployment flow and prediction requirement.",
  },
  {
    id: "safe-docs-multichain",
    type: "official-docs",
    url: "https://docs.safe.global/sdk/protocol-kit/guides/multichain-safe-deployment",
    note:
      "Safe multichain deployment requires matching predicted addresses before deployment.",
  },
  {
    id: "safe-deployments-repo",
    type: "official-repository",
    url: "https://github.com/safe-global/safe-deployments",
    note:
      "Official Safe deployments repository. Bytecode must still be verified on-chain.",
  },
  {
    id: "safe-4337-module-v0.3.0",
    type: "official-repository",
    url: "https://github.com/safe-fndn/safe-modules",
    note:
      "Safe4337Module v0.3.0 supports EntryPoint v0.7.0 and publishes the canonical SafeModuleSetup and Safe4337Module addresses.",
  },
  {
    id: "world-chain-docs",
    type: "official-docs",
    url: "https://docs.world.org/world-chain",
    note:
      "World Chain official documentation and network context.",
  },
]);

export const SAFE_DEPLOYMENT_CATALOG = Object.freeze([
  {
    chainId: 1,
    network: "Ethereum",

    safeVersion: "1.4.1",

    proxyFactory:
      "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",

    singleton:
      "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",

    safeL2Singleton:
      "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",

    fallbackHandler:
      "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99",

    multiSend: null,

    erc4337Version: "0.3.0",

    erc4337EntryPoint:
      "0x0000000071727De22E5E9d8BAf0edAc6f37da032",

    safeModuleSetup:
      "0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47",

    erc4337Module:
      "0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226",

    proxyCreationCodeHash: null,

    sourceIds: [
      "safe-deployments-repo",
      "safe-docs-deployment",
      "safe-docs-multichain",
      "safe-4337-module-v0.3.0",
    ],

    verificationRequired:
      "Before recovery, verify factory code, singleton code, SafeModuleSetup code, Safe4337Module code, EntryPoint code and proxyCreationCode directly on Ethereum. Do not infer the source Safe initializer from this catalog.",
  },

  {
    chainId: 480,
    network: "World Chain",

    safeVersion: "1.4.1",

    proxyFactory:
      "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",

    singleton:
      "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",

    safeL2Singleton:
      "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",

    fallbackHandler:
      "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99",

    multiSend: null,

    erc4337Version: "0.3.0",

    erc4337EntryPoint:
      "0x0000000071727De22E5E9d8BAf0edAc6f37da032",

    safeModuleSetup:
      "0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47",

    erc4337Module:
      "0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226",

    proxyCreationCodeHash: null,

    sourceIds: [
      "safe-deployments-repo",
      "safe-docs-deployment",
      "safe-docs-multichain",
      "safe-4337-module-v0.3.0",
      "world-chain-docs",
    ],

    verificationRequired:
      "The actual World Safe deployment must be reconstructed from on-chain evidence. Verify owners, threshold, singleton, fallback handler, enabled modules, setup target, setup calldata, factory, proxyCreationCode, deployment method and saltNonce before any cross-chain replay.",
  },
]);

export function catalogEntriesForChain(chainId) {
  return SAFE_DEPLOYMENT_CATALOG.filter(
    (entry) => Number(entry.chainId) === Number(chainId),
  );
}
