export const SAFE_DEPLOYMENT_CATALOG_VERSION = 1;

export const SAFE_DEPLOYMENT_CATALOG_SOURCES = Object.freeze([
  {
    id: "safe-docs-deployment",
    type: "official-docs",
    url: "https://docs.safe.global/sdk/protocol-kit/guides/safe-deployment",
    note: "Safe Protocol Kit deployment flow and prediction requirement.",
  },
  {
    id: "safe-docs-multichain",
    type: "official-docs",
    url: "https://docs.safe.global/sdk/protocol-kit/guides/multichain-safe-deployment",
    note: "Safe multichain deployment requires matching predicted addresses before deployment.",
  },
  {
    id: "safe-deployments-repo",
    type: "official-repository",
    url: "https://github.com/safe-global/safe-deployments",
    note: "Official Safe deployments repository. Bytecode must still be verified on-chain.",
  },
  {
    id: "world-chain-docs",
    type: "official-docs",
    url: "https://docs.world.org/world-chain",
    note: "World Chain official documentation and network context.",
  },
]);

export const SAFE_DEPLOYMENT_CATALOG = Object.freeze([
  {
    chainId: 1,
    network: "Ethereum",
    safeVersion: "1.4.1",
    proxyFactory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
    singleton: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
    safeL2Singleton: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
    fallbackHandler: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99",
    multiSend: null,
    erc4337Module: null,
    proxyCreationCodeHash: null,
    sourceIds: ["safe-deployments-repo", "safe-docs-deployment"],
    verificationRequired:
      "Verify factory code, singleton code and proxyCreationCode hash on the target chain before use.",
  },
  {
    chainId: 480,
    network: "World Chain",
    safeVersion: "1.4.1",
    proxyFactory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
    singleton: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
    safeL2Singleton: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
    fallbackHandler: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99",
    multiSend: null,
    erc4337Module: "0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226",
    proxyCreationCodeHash: null,
    sourceIds: ["safe-deployments-repo", "world-chain-docs"],
    verificationRequired:
      "Observed module must be verified against the source Safe setup calldata before replay.",
  },
]);

export function catalogEntriesForChain(chainId) {
  return SAFE_DEPLOYMENT_CATALOG.filter(
    (entry) => Number(entry.chainId) === Number(chainId),
  );
}
