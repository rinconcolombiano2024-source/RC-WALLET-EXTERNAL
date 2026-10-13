# RC Wallet External — engineering verification (2026-10-13)

## Scope and safety boundary

This repository is **RC-WALLET-EXTERNAL**, not the separate RC-WALLET Mini App. The current stack is React/Vite/ethers v6/pnpm/Node 24, not CRA/CRACO. This PR intentionally retains the existing wallet, Safe and counterfactual-engine flows. Mainnet signing, contract deployment, and funds movement are **not tested or authorized** by this work.

World Money's documented exported private key derives an owner EOA that is different from the World Wallet (Safe) public address. World documents using an external wallet linked to Safe. Neither matching chain addresses nor a user-supplied private key proves authorization to execute a transaction from a Safe. See https://support.world.org/hc/en-us/articles/38808889982867-How-do-I-export-and-use-my-private-key and https://docs.safe.global/sdk/protocol-kit.

## Findings / fixes

| Finding | Root cause | Patch | Confidence |
|---|---|---|---|
| RPC chain identity could be faked/misreported | ethers `staticNetwork: true` plus `getNetwork()` used as endpoint verification | Both provider implementations now query `eth_chainId` directly, compare it, fall back, and destroy failed providers | Unit-testable |
| Legacy address parser accepted corrupt mixed-case checksums | Lowercasing before `ethers.getAddress()` | Preserve case and EIP-55 checksum | Unit-testable |
| Empty EIP-1271 call implied owner authorization | A successful contract method response is not a valid user signature | The legacy inspector no longer claims signing capability from an empty signature | Code-level |
| Missing ERC-20 balances looked like zero | Token `Promise.allSettled` failures silently discarded | Token errors are recorded and networks marked `partial`; UI warns | Code-level |
| Old address could retain scan results | No invalidation on target change | Increment scan version and clear former-address balances | Code-level |
| Private key had redundant in-memory copies | `externalConnectionRef.current.privateKey` duplicated secret already held for signing | Removed redundant connection descriptor field and cleared key ref on unmount | Code-level, not a full memory/XSS guarantee |
| Safe proposal API lacked body-size enforcement | No parsed-body or content-length cap | 170 KB cap before service relay; confirmation also checks both | API regression-testable |
| Historical recovery tests broke on harmless formatting and stricter source-proof states | String-matching tests expected compact property layout and a generic destination-mismatch outcome | Repaired test assertions without weakening source CREATE2 barrier | Code-level |
| No native CI evidence in initial external repo | No GitHub workflow | Introduced pinned pnpm 11 / Node 24 clean install, tests, static checks, production build, high-severity audit | GitHub Actions evidence |

## Test/CI commands

`pnpm install --frozen-lockfile`, `pnpm test:wallet`, `node --test tests/verified-rpc-and-keys.test.mjs tests/safe-propose-limits.test.mjs`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm audit --audit-level high`.

The GitHub Actions workflow is the authoritative evidence for which of these steps pass on the actual PR head. Individual earlier runs exposed tests that were already out of sync with stronger source-Safe validation. Do not treat a pending, old-SHA, or failing run as a passing build.

## Chain/routing matrix (implementation, not live authorization)

- **World Chain (480):** Safe discovery and World wallet architecture implemented. Actual owner/threshold and live transaction behavior not reverified here.
- **Ethereum (1):** read and Safe counterfactual investigation implemented. Real CREATE2 deployment feasibility unverified.
- **Optimism (10), Base (8453), BNB Chain (56):** multichain reads configured; transfer capability is contingent on genuine signer and Safe authorization, not a common 0x address.
- **Polygon (137), Arbitrum (42161):** not claimed to be production-supported by this PR.

Important: source deployment proof needs the exact factory, singleton, proxy creation bytecode, initializer and salt; matching owner address/threshold by itself cannot reproduce a counterfactual Safe address. The existing recovery API remains in **read/predict/prepare only** mode and cannot establish live recoverability from this audit alone.

## Production blockers

1. Perform a dedicated browser/XSS and secret-lifecycle review: the React input is still holding a sensitive key while entered. Prefer audited dedicated wallet software for exporting/importing the owner's secret.
2. Run controlled read-only RPC diagnosis for the specific public Safe/owner addresses, including source CREATE2 proof and target dependency bytecode. No claims about current actual balances are made from stored examples.
3. Obtain safe real-device authorization proof and Safe signature simulation. Never ask for a private key in chat, logs or GitHub.
4. Verify Vercel deployment, Android/in-app browser, connection/disconnection, RPC quotas, transaction receipt, UI language quality and rollback.
5. Clear high/critical dependency advisories and review remaining moderate ones before marking production-ready.
6. Ensure exact transaction intent and explicit user confirmation before any mainnet broadcast. Never use backdoor signers, hidden destinations, or automatic bridge/deployment.

**Release status: DRAFT / NOT YET PRODUCTION-VERIFIED.**
