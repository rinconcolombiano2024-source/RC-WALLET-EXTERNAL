import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { EXTERNAL_PROVIDERS, NETWORKS } from "./config.js";
import {
  compactAddress,
  createImportDiagnosis,
  decryptVault,
  deleteStoredVault,
  deriveWallet,
  encryptVault,
  estimateTransferGas,
  explorerAddressUrl,
  explorerTxUrl,
  formatBalance,
  inspectWorldAppAccount,
  normalizeAddress,
  readCustomTokens,
  readStoredVault,
  scanAllNetworks,
  sendAsset,
  tokenExplorerUrl,
  tryNormalizeAddress,
  writeCustomTokens,
  writeStoredVault,
} from "./wallet-core.js";

const TABS = Object.freeze([
  { id: "home", label: "Inicio", icon: "⌂" },
  { id: "tokens", label: "Tokens", icon: "◆" },
  { id: "send", label: "Enviar", icon: "↗" },
  { id: "swap", label: "Swap", icon: "⇄" },
  { id: "tools", label: "Ajustes", icon: "⚙" },
]);

const WORLD_ID_STATEMENT = "Iniciar sesión en RC Wallet Externa";
const RC_WALLET_MINI_APP_URL =
  import.meta.env.VITE_RC_WALLET_MINIAPP_URL ||
  import.meta.env.VITE_MINI_APP_URL ||
  "https://rc-wallet-vazd.vercel.app/";

function Status({ status }) {
  if (!status.message) return null;
  return <div className={`status status--${status.type}`}>{status.message}</div>;
}

function isPositiveAmount(value) {
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(String(value).trim().replace(",", "."));
}

function qrImageUrl(value) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(value)}`;
}

function getMiniAppUrl() {
  return RC_WALLET_MINI_APP_URL;
}

function tradeUrl(action, asset) {
  if (!asset) return null;
  if (asset.network.dex === "pancake") {
    const url = new URL("https://pancakeswap.finance/swap");
    url.searchParams.set("chain", "bsc");
    if (!asset.isNative) {
      if (action === "buy") url.searchParams.set("outputCurrency", asset.address);
      else url.searchParams.set("inputCurrency", asset.address);
    }
    return url.toString();
  }

  if ([1, 10, 137, 480, 8453].includes(asset.chainId)) {
    const chainMap = {
      1: "mainnet",
      10: "optimism",
      137: "polygon",
      480: "worldchain",
      8453: "base",
    };
    const url = new URL("https://app.uniswap.org/swap");
    url.searchParams.set("chain", chainMap[asset.chainId]);
    if (!asset.isNative) {
      if (action === "buy") url.searchParams.set("outputCurrency", asset.address);
      else url.searchParams.set("inputCurrency", asset.address);
    }
    return url.toString();
  }

  return null;
}

export default function App() {
  const [activeTab, setActiveTab] = useState("home");
  const [storedVault, setStoredVault] = useState(() => readStoredVault());
  const [session, setSession] = useState(null);
  const [unlockPassword, setUnlockPassword] = useState("");
  const [privateKeyInput, setPrivateKeyInput] = useState("");
  const [expectedAddressInput, setExpectedAddressInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [authenticatingWorld, setAuthenticatingWorld] = useState(false);
  const [miniAppUrl] = useState(() => getMiniAppUrl());
  const [authenticatedWorldAddress, setAuthenticatedWorldAddress] = useState("");
  const [worldAccount, setWorldAccount] = useState(null);
  const [assets, setAssets] = useState([]);
  const [networkStates, setNetworkStates] = useState({});
  const [selectedAssetId, setSelectedAssetId] = useState("");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [gasEstimate, setGasEstimate] = useState(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [sending, setSending] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [lastTx, setLastTx] = useState(null);
  const [customTokens, setCustomTokens] = useState(readCustomTokens);
  const [customChainId, setCustomChainId] = useState(480);
  const [customTokenAddress, setCustomTokenAddress] = useState("");
  const [status, setStatus] = useState({
    type: "info",
    message: "RC Wallet Externa firma localmente. Ninguna llave se envía al servidor.",
  });

  const selectedAsset = useMemo(
    () => assets.find((asset) => asset.id === selectedAssetId) ?? assets[0] ?? null,
    [assets, selectedAssetId],
  );

  const importDiagnosis = useMemo(
    () =>
      createImportDiagnosis({
        derivedAddress: session?.address,
        expectedAddress: session?.expectedAddress || authenticatedWorldAddress,
        worldAccount,
      }),
    [authenticatedWorldAddress, session?.address, session?.expectedAddress, worldAccount],
  );

  const verifiedMatch = importDiagnosis.status === "match";
  const operationsBlocked = Boolean(session?.address && importDiagnosis.blocksOperation);

  const totalAssets = assets.length;
  const nativeAssets = assets.filter((asset) => asset.isNative);
  const tokenAssets = assets.filter((asset) => !asset.isNative);

  const showStatus = useCallback((message, type = "info") => {
    setStatus({ message, type });
  }, []);

  const inspectExpectedWorldAccount = useCallback(async (address) => {
    const normalizedAddress = tryNormalizeAddress(address);
    if (!normalizedAddress) {
      setWorldAccount(null);
      return null;
    }

    try {
      const inspection = await inspectWorldAppAccount(normalizedAddress);
      setWorldAccount(inspection);
      return inspection;
    } catch (error) {
      const fallback = {
        address: normalizedAddress,
        error: error instanceof Error ? error.message : "No se pudo inspeccionar World App.",
      };
      setWorldAccount(fallback);
      return fallback;
    }
  }, []);

  const loginWithWorldId = useCallback(async () => {
    setAuthenticatingWorld(true);
    try {
      const module = await import("@worldcoin/minikit-js");
      const miniKit = module.MiniKit;
      const installed = miniKit?.install?.();
      if (!installed?.success || !miniKit?.walletAuth) {
        throw new Error("World ID solo puede autenticarse cuando la app se abre dentro de World App.");
      }

      const nonceResponse = await fetch("/api/nonce", {
        credentials: "include",
        cache: "no-store",
      });
      if (!nonceResponse.ok) throw new Error("No se pudo crear nonce de autenticación.");
      const { nonce } = await nonceResponse.json();

      const authResult = await miniKit.walletAuth({
        nonce,
        statement: WORLD_ID_STATEMENT,
        expirationTime: new Date(Date.now() + 7 * 60 * 1000),
      });

      if (authResult?.executedWith === "fallback") {
        throw new Error("La verificación debe ejecutarse dentro de World App.");
      }

      const payload = authResult?.data ?? authResult;
      const completeResponse = await fetch("/api/complete-siwe", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload, nonce }),
      });
      const complete = await completeResponse.json();
      if (!completeResponse.ok || !complete?.isValid) {
        throw new Error(complete?.error || "No se pudo verificar la sesión World ID.");
      }

      const walletAddress = tryNormalizeAddress(
        complete.address || payload?.address || miniKit.user?.walletAddress,
      );
      if (!walletAddress) {
        throw new Error("World ID no devolvió una dirección EVM válida.");
      }

      setAuthenticatedWorldAddress(walletAddress);
      setExpectedAddressInput(walletAddress);
      await inspectExpectedWorldAccount(walletAddress);
      showStatus(`World ID autenticado: ${walletAddress}`, "success");
    } catch (error) {
      showStatus(error instanceof Error ? error.message : "No se pudo autenticar con World ID.", "error");
    } finally {
      setAuthenticatingWorld(false);
    }
  }, [inspectExpectedWorldAccount, showStatus]);

  const scan = useCallback(async () => {
    if (!session?.address) return;
    setScanning(true);
    showStatus("Escaneando redes EVM…");
    try {
      const result = await scanAllNetworks(session.address, customTokens);
      setAssets(result.assets);
      setNetworkStates(result.networks);
      setSelectedAssetId((current) =>
        result.assets.some((asset) => asset.id === current)
          ? current
          : (result.assets[0]?.id ?? ""),
      );
      showStatus(
        result.assets.length
          ? `Escaneo completado: ${result.assets.length} activo(s) con balance.`
          : "No se encontraron balances en los tokens configurados.",
        "success",
      );
    } catch (error) {
      showStatus(error instanceof Error ? error.message : "No se pudo escanear.", "error");
    } finally {
      setScanning(false);
    }
  }, [customTokens, session?.address, showStatus]);

  useEffect(() => {
    if (session?.address) void scan();
  }, [session?.address]);

  useEffect(() => {
    writeCustomTokens(customTokens);
  }, [customTokens]);

  const importWallet = useCallback(async () => {
    try {
      const derived = deriveWallet(privateKeyInput);
      const expectedAddress = tryNormalizeAddress(expectedAddressInput || authenticatedWorldAddress);
      const inspection = await inspectExpectedWorldAccount(expectedAddress);
      const diagnosis = createImportDiagnosis({
        derivedAddress: derived.address,
        expectedAddress,
        worldAccount: inspection,
      });

      const vault = await encryptVault(
        {
          privateKey: derived.privateKey,
          address: derived.address,
          expectedAddress,
        },
        passwordInput,
      );
      writeStoredVault(vault);
      setStoredVault(vault);
      setSession({
        privateKey: derived.privateKey,
        address: derived.address,
        expectedAddress,
      });
      setPrivateKeyInput("");
      setPasswordInput("");
      setActiveTab("home");
      showStatus(
        diagnosis.blocksOperation
          ? `${diagnosis.title}. Revisa las direcciones mostradas antes de operar.`
          : "Wallet importada, diagnosticada y cifrada localmente.",
        diagnosis.blocksOperation ? "warning" : "success",
      );
    } catch (error) {
      showStatus(error instanceof Error ? error.message : "No se pudo importar la wallet.", "error");
    }
  }, [
    authenticatedWorldAddress,
    expectedAddressInput,
    inspectExpectedWorldAccount,
    passwordInput,
    privateKeyInput,
    showStatus,
  ]);

  const unlockWallet = useCallback(async () => {
    try {
      const unlocked = await decryptVault(storedVault, unlockPassword);
      if (unlocked.expectedAddress) {
        await inspectExpectedWorldAccount(unlocked.expectedAddress);
      }
      setSession(unlocked);
      setUnlockPassword("");
      setActiveTab("home");
      showStatus("Wallet desbloqueada localmente.", "success");
    } catch {
      showStatus("Contraseña incorrecta o wallet local dañada.", "error");
    }
  }, [inspectExpectedWorldAccount, storedVault, unlockPassword, showStatus]);

  const lockWallet = useCallback(() => {
    setSession(null);
    setAssets([]);
    setNetworkStates({});
    setSelectedAssetId("");
    showStatus("Wallet bloqueada. La llave privada salió de la sesión.", "info");
  }, [showStatus]);

  const deleteWallet = useCallback(() => {
    if (!window.confirm("¿Borrar la wallet cifrada de este dispositivo?")) return;
    deleteStoredVault();
    setStoredVault(null);
    setSession(null);
    setAssets([]);
    showStatus("Wallet local borrada del dispositivo.", "success");
  }, [showStatus]);

  const addCustomToken = useCallback(() => {
    try {
      const address = normalizeAddress(customTokenAddress);
      const chainId = Number(customChainId);
      if (customTokens.some((token) => token.chainId === chainId && token.address === address)) {
        throw new Error("Ese token ya existe en la lista personalizada.");
      }
      setCustomTokens((current) => [
        ...current,
        { chainId, address, symbol: "CUSTOM" },
      ]);
      setCustomTokenAddress("");
      showStatus("Token agregado. Escanea de nuevo para consultar balance.", "success");
    } catch (error) {
      showStatus(error instanceof Error ? error.message : "No se pudo agregar token.", "error");
    }
  }, [customChainId, customTokenAddress, customTokens, showStatus]);

  const prepareSend = useCallback(async () => {
    try {
      if (!session?.privateKey || !selectedAsset) throw new Error("Selecciona un activo.");
      if (operationsBlocked) {
        throw new Error(`${importDiagnosis.title}: ${importDiagnosis.detail}`);
      }
      normalizeAddress(recipient);
      if (!isPositiveAmount(amount)) throw new Error("Introduce una cantidad válida.");

      const cleanAmount = String(amount).trim().replace(",", ".");
      const amountUnits = ethers.parseUnits(cleanAmount, selectedAsset.decimals);
      if (amountUnits <= 0n) throw new Error("La cantidad debe ser mayor que cero.");
      if (amountUnits > selectedAsset.rawBalance) throw new Error("La cantidad supera el balance.");
      if (selectedAsset.isNative && amountUnits >= selectedAsset.rawBalance) {
        throw new Error("En moneda nativa debes dejar saldo para pagar gas.");
      }

      const gas = await estimateTransferGas({
        privateKey: session.privateKey,
        asset: selectedAsset,
        recipient,
        amount: cleanAmount,
      });
      setGasEstimate(gas);
      setShowConfirm(true);
      showStatus("Gas estimado. Revisa y confirma manualmente.", "info");
    } catch (error) {
      showStatus(error instanceof Error ? error.message : "No se pudo preparar el envío.", "error");
    }
  }, [
    amount,
    importDiagnosis,
    operationsBlocked,
    recipient,
    selectedAsset,
    session?.privateKey,
    showStatus,
  ]);

  const confirmSend = useCallback(async () => {
    try {
      if (!session?.privateKey || !selectedAsset) return;
      if (operationsBlocked) throw new Error(`${importDiagnosis.title}: ${importDiagnosis.detail}`);
      setSending(true);
      const cleanAmount = String(amount).trim().replace(",", ".");
      const result = await sendAsset({
        privateKey: session.privateKey,
        asset: selectedAsset,
        recipient,
        amount: cleanAmount,
      });
      setLastTx({ ...result, network: selectedAsset.network });
      setShowConfirm(false);
      setRecipient("");
      setAmount("");
      setGasEstimate(null);
      showStatus("Transacción confirmada en blockchain.", "success");
      window.setTimeout(() => void scan(), 4_000);
    } catch (error) {
      showStatus(error instanceof Error ? error.message : "La transacción falló.", "error");
    } finally {
      setSending(false);
    }
  }, [
    amount,
    importDiagnosis,
    operationsBlocked,
    recipient,
    scan,
    selectedAsset,
    session?.privateKey,
    showStatus,
  ]);

  const openTrade = useCallback(
    (action) => {
      const url = tradeUrl(action, selectedAsset);
      if (!url) {
        showStatus("Proveedor real no disponible para este activo/red.", "warning");
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
    },
    [selectedAsset, showStatus],
  );

  const viewClass = (tab) => `view ${activeTab === tab ? "view--active" : ""}`;

  return (
    <main className="page">
      <section className="shell">
        <header className="hero">
          <div className="hero__mark">RC</div>
          <div>
            <span>RC Wallet Externa</span>
            <h1>Wallet EVM local y no custodial</h1>
            <p>Importa una llave privada voluntariamente, cifra localmente y firma desde tu dispositivo.</p>
          </div>
        </header>

        <Status status={status} />

        {!session && (
          <section className="view view--active">
            <article className="card">
              <span className="eyebrow">World App opcional</span>
              <h2>Dirección autenticada de World App</h2>
              <p className="muted">
                Si abres esta versión desde World App, puedes traer la dirección oficial para compararla con la llave privada importada.
              </p>
              <div className="diagnostic-box">
                <span>Conexión World App</span>
                <p>
                  El login web antiguo de World ID fue retirado. Para evitar errores, RC Wallet Externa mantiene la validación profesional por Wallet Auth únicamente cuando se abre dentro de World App.
                </p>
                <div className="button-row">
                  {miniAppUrl && (
                    <button
                      className="button button--primary"
                      type="button"
                      onClick={() => window.open(miniAppUrl, "_blank", "noopener,noreferrer")}
                    >
                      Abrir RC Wallet dentro de World App
                    </button>
                  )}
                  <button
                    className="button button--secondary"
                    type="button"
                    onClick={loginWithWorldId}
                    disabled={authenticatingWorld}
                  >
                    {authenticatingWorld ? "Verificando..." : "Leer dirección con Wallet Auth"}
                  </button>
                </div>
              </div>
              <div className="diagnostic-box">
                <span>Dirección EVM por Wallet Auth</span>
                <p>
                  Usa esta opción dentro de World App para obtener la dirección SIWE que World App firma. Esa es la dirección útil para comparar con la llave privada derivada.
                </p>
                <button
                  className="button button--primary"
                  type="button"
                  onClick={loginWithWorldId}
                  disabled={authenticatingWorld}
                >
                  {authenticatingWorld
                    ? "Verificando World ID..."
                    : "Obtener dirección con World App"}
                </button>
              </div>
              {authenticatedWorldAddress ? (
                <div className="diagnostic-box">
                  <span>Dirección World App autenticada</span>
                  <code>{authenticatedWorldAddress}</code>
                </div>
              ) : (
                <p className="muted">También puedes pegar manualmente la dirección World App esperada abajo.</p>
              )}
            </article>
            {storedVault ? (
              <article className="card">
                <span className="eyebrow">Wallet cifrada detectada</span>
                <h2>Desbloquear RC Wallet Externa</h2>
                <p className="muted">
                  La llave privada está cifrada en este dispositivo. La contraseña no sale del navegador.
                </p>
                <label className="label">
                  Contraseña local
                  <input
                    className="input"
                    type="password"
                    value={unlockPassword}
                    onChange={(event) => setUnlockPassword(event.target.value)}
                    placeholder="Contraseña"
                  />
                </label>
                <button className="button button--primary" type="button" onClick={unlockWallet}>
                  Desbloquear wallet
                </button>
                <button className="button button--danger" type="button" onClick={deleteWallet}>
                  Borrar wallet local
                </button>
              </article>
            ) : (
              <article className="card card--danger">
                <span className="eyebrow">Importar wallet</span>
                <h2>Llave privada exportada</h2>
                <p className="warning">
                  Quien tenga esta llave privada puede acceder a tus fondos. RC Wallet Externa no pide frase semilla y no envía claves por red.
                </p>
                <label className="label">
                  Llave privada
                  <div className="input-row">
                    <input
                      className="input"
                      type={showPrivateKey ? "text" : "password"}
                      value={privateKeyInput}
                      onChange={(event) => setPrivateKeyInput(event.target.value)}
                      placeholder="0x..."
                      spellCheck="false"
                    />
                    <button
                      className="button button--secondary"
                      type="button"
                      onClick={() => setShowPrivateKey((value) => !value)}
                    >
                      {showPrivateKey ? "Ocultar" : "Ver"}
                    </button>
                  </div>
                </label>
                <label className="label">
                  Dirección World App esperada
                  <input
                    className="input"
                    value={expectedAddressInput}
                    onChange={(event) => setExpectedAddressInput(event.target.value)}
                    placeholder="0x..."
                    spellCheck="false"
                  />
                </label>
                {(expectedAddressInput || authenticatedWorldAddress) && (
                  <div className="diagnostic-box">
                    <span>Dirección esperada para comparar</span>
                    <code>
                      {tryNormalizeAddress(expectedAddressInput || authenticatedWorldAddress) ||
                        "Formato EVM no válido todavía"}
                    </code>
                  </div>
                )}
                <label className="label">
                  Contraseña para cifrar en este teléfono
                  <input
                    className="input"
                    type="password"
                    value={passwordInput}
                    onChange={(event) => setPasswordInput(event.target.value)}
                    placeholder="Mínimo 8 caracteres"
                  />
                </label>
                <button className="button button--primary" type="button" onClick={importWallet}>
                  Derivar, verificar y cifrar wallet
                </button>
              </article>
            )}
          </section>
        )}

        {session && (
          <>
            <section className={viewClass("home")}>
              <article className="wallet-card">
                <span className="eyebrow">Wallet local</span>
                <h2>{compactAddress(session.address)}</h2>
                <p className={operationsBlocked ? "mismatch" : "match"}>
                  {verifiedMatch
                    ? "Dirección verificada contra World App."
                    : operationsBlocked
                      ? importDiagnosis.title
                      : "Wallet derivada sin discrepancia comprobada."}
                </p>
                <div className={`diagnostic-box ${operationsBlocked ? "diagnostic-box--blocked" : ""}`}>
                  <span>Diagnóstico de dirección</span>
                  <strong>{importDiagnosis.title}</strong>
                  <p>{importDiagnosis.detail}</p>
                  <div className="diagnostic-grid">
                    <div>
                      <small>Derivada desde la llave</small>
                      <code>{importDiagnosis.derivedAddress || session.address}</code>
                    </div>
                    <div>
                      <small>World App esperada</small>
                      <code>{importDiagnosis.expectedAddress || "No verificada"}</code>
                    </div>
                  </div>
                  {worldAccount?.accountKind && (
                    <p className="muted">
                      Cuenta World App: {worldAccount.accountKind}
                      {worldAccount.safe?.detected
                        ? ` · Safe threshold ${worldAccount.safe.threshold}/${worldAccount.safe.owners.length}`
                        : ""}
                    </p>
                  )}
                  {worldAccount?.safe?.owners?.length ? (
                    <details className="details">
                      <summary>Owners Safe detectados</summary>
                      {worldAccount.safe.owners.map((owner) => (
                        <code className="address" key={owner}>{owner}</code>
                      ))}
                    </details>
                  ) : null}
                </div>
                <div className="quick-grid">
                  <button className="quick" type="button" onClick={() => setActiveTab("send")}>Enviar</button>
                  <button className="quick" type="button" onClick={() => setActiveTab("home")}>Recibir</button>
                  <button className="quick" type="button" onClick={() => setActiveTab("swap")}>Swap</button>
                  <button className="quick" type="button" onClick={scan} disabled={scanning}>
                    {scanning ? "Escaneando" : "Escanear"}
                  </button>
                </div>
              </article>

              <article className="card">
                <div className="section-heading">
                  <div>
                    <span className="eyebrow">Recibir</span>
                    <h2>Tu dirección EVM</h2>
                  </div>
                  <a href={explorerAddressUrl(NETWORKS[0], session.address)} target="_blank" rel="noreferrer">
                    Explorer
                  </a>
                </div>
                <img className="qr" src={qrImageUrl(session.address)} alt="QR de depósito" />
                <code className="address">{session.address}</code>
              </article>

              <article className="card">
                <span className="eyebrow">Resumen</span>
                <div className="stats">
                  <div><strong>{totalAssets}</strong><span>Activos</span></div>
                  <div><strong>{nativeAssets.length}</strong><span>Nativos</span></div>
                  <div><strong>{tokenAssets.length}</strong><span>ERC20</span></div>
                </div>
              </article>
            </section>

            <section className={viewClass("tokens")}>
              <article className="card">
                <div className="section-heading">
                  <div>
                    <span className="eyebrow">Portfolio</span>
                    <h2>Tokens detectados</h2>
                  </div>
                  <button className="button button--secondary" type="button" onClick={scan} disabled={scanning}>
                    Escanear
                  </button>
                </div>
                {assets.length === 0 ? (
                  <p className="muted">Sin balances detectados todavía.</p>
                ) : (
                  <div className="asset-list">
                    {assets.map((asset) => (
                      <button
                        className={`asset ${selectedAsset?.id === asset.id ? "asset--selected" : ""}`}
                        type="button"
                        key={asset.id}
                        onClick={() => {
                          setSelectedAssetId(asset.id);
                          setActiveTab("send");
                        }}
                      >
                        <span className="token-logo">{asset.symbol.slice(0, 3)}</span>
                        <div>
                          <strong>{asset.displayBalance} {asset.symbol}</strong>
                          <small>{asset.networkName}</small>
                          <small>{asset.isNative ? "Moneda nativa" : asset.address}</small>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </article>
            </section>

            <section className={viewClass("send")}>
              <article className="card">
                <span className="eyebrow">Enviar fondos</span>
                <h2>{selectedAsset ? `${selectedAsset.symbol} en ${selectedAsset.networkName}` : "Selecciona un activo"}</h2>
                {operationsBlocked && (
                  <p className="warning">Operaciones bloqueadas: {importDiagnosis.title}. {importDiagnosis.detail}</p>
                )}
                <label className="label">
                  Activo
                  <select
                    className="input"
                    value={selectedAsset?.id ?? ""}
                    onChange={(event) => setSelectedAssetId(event.target.value)}
                  >
                    {assets.map((asset) => (
                      <option key={asset.id} value={asset.id}>
                        {asset.displayBalance} {asset.symbol} · {asset.networkName}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="label">
                  Dirección destino
                  <input className="input" value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="0x..." />
                </label>
                <label className="label">
                  Cantidad
                  <div className="input-row">
                    <input className="input" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.0" />
                    <button className="button button--secondary" type="button" onClick={() => selectedAsset && setAmount(selectedAsset.balance)}>
                      MAX
                    </button>
                  </div>
                </label>
                {selectedAsset && (
                  <p className="muted">Disponible: {selectedAsset.displayBalance} {selectedAsset.symbol}</p>
                )}
                <button className="button button--primary" type="button" disabled={!selectedAsset || operationsBlocked} onClick={prepareSend}>
                  Estimar gas y revisar
                </button>
                {lastTx && (
                  <div className="tx-box">
                    <strong>Última transacción</strong>
                    <a href={explorerTxUrl(lastTx.network, lastTx.hash)} target="_blank" rel="noreferrer">
                      Ver en explorer
                    </a>
                  </div>
                )}
              </article>
            </section>

            <section className={viewClass("swap")}>
              <article className="card market-card">
                <span className="eyebrow">Swap / comprar / vender</span>
                <h2>Proveedor externo real</h2>
                <p className="muted">RC Wallet Externa no simula swaps. Abre DEX/onramp/offramp reales y tú firmas fuera si decides operar.</p>
                <div className="trade-grid">
                  <button className="trade trade--buy" type="button" onClick={() => openTrade("buy")}>Comprar</button>
                  <button className="trade trade--sell" type="button" onClick={() => openTrade("sell")}>Vender</button>
                  <button className="trade trade--swap" type="button" onClick={() => openTrade("swap")}>Swap DEX</button>
                  <button className="trade" type="button" onClick={() => window.open(EXTERNAL_PROVIDERS.universal, "_blank", "noopener,noreferrer")}>
                    Universal bridge
                  </button>
                </div>
                {selectedAsset && !selectedAsset.isNative && (
                  <a className="explorer-link" href={tokenExplorerUrl(selectedAsset)} target="_blank" rel="noreferrer">
                    Ver contrato {selectedAsset.symbol}
                  </a>
                )}
              </article>
            </section>

            <section className={viewClass("tools")}>
              <article className="card">
                <span className="eyebrow">Seguridad</span>
                <h2>Control local</h2>
                <p className="warning">No compartas la llave privada. Quien la tenga puede acceder a tus fondos.</p>
                <div className="button-row">
                  <button className="button button--secondary" type="button" onClick={lockWallet}>Bloquear sesión</button>
                  <button className="button button--danger" type="button" onClick={deleteWallet}>Borrar wallet local</button>
                </div>
              </article>

              <article className="card">
                <span className="eyebrow">Token personalizado</span>
                <h2>Agregar ERC20 desconocido</h2>
                <p className="muted">Sin indexer externo no se pueden enumerar todos los ERC20 desconocidos. Agrega el contrato y RC Wallet leerá su balance real.</p>
                <label className="label">
                  Red
                  <select className="input" value={customChainId} onChange={(event) => setCustomChainId(Number(event.target.value))}>
                    {NETWORKS.map((network) => (
                      <option key={network.chainId} value={network.chainId}>{network.name}</option>
                    ))}
                  </select>
                </label>
                <label className="label">
                  Contrato ERC20
                  <input className="input" value={customTokenAddress} onChange={(event) => setCustomTokenAddress(event.target.value)} placeholder="0x..." />
                </label>
                <button className="button button--primary" type="button" onClick={addCustomToken}>Agregar token</button>
              </article>

              <article className="card">
                <span className="eyebrow">Redes</span>
                <h2>Estado RPC</h2>
                <div className="network-grid">
                  {NETWORKS.map((network) => (
                    <div className="network-pill" key={network.chainId}>
                      <strong>{network.shortName}</strong>
                      <span>{networkStates[network.chainId]?.status ?? "pendiente"}</span>
                    </div>
                  ))}
                </div>
              </article>
            </section>
          </>
        )}

        {showConfirm && selectedAsset && (
          <div className="modal-backdrop">
            <section className="confirm-modal">
              <span className="eyebrow">Confirmación manual</span>
              <h2>Revisar envío</h2>
              <dl>
                <div><dt>Red</dt><dd>{selectedAsset.networkName}</dd></div>
                <div><dt>Token</dt><dd>{selectedAsset.symbol}</dd></div>
                <div><dt>Cantidad</dt><dd>{amount} {selectedAsset.symbol}</dd></div>
                <div><dt>Destino</dt><dd>{compactAddress(normalizeAddress(recipient))}</dd></div>
                <div><dt>Gas estimado</dt><dd>{gasEstimate?.toString() ?? "pendiente"} unidades</dd></div>
                <div>
                  <dt>Saldo restante</dt>
                  <dd>
                    {formatBalance(
                      selectedAsset.rawBalance - ethers.parseUnits(String(amount).trim().replace(",", "."), selectedAsset.decimals),
                      selectedAsset.decimals,
                    )} {selectedAsset.symbol}
                  </dd>
                </div>
              </dl>
              <p className="warning">Firma local. Revisa red, destino, cantidad y gas. No hay reversa si envías a una dirección equivocada.</p>
              <div className="button-row">
                <button className="button button--secondary" type="button" onClick={() => setShowConfirm(false)}>Cancelar</button>
                <button className="button button--primary" type="button" onClick={confirmSend} disabled={sending}>
                  {sending ? "Firmando…" : "Confirmar y firmar localmente"}
                </button>
              </div>
            </section>
          </div>
        )}

        {session && (
          <nav className="bottom-nav">
            {TABS.map((tab) => (
              <button
                className={`bottom-nav__item ${activeTab === tab.id ? "bottom-nav__item--active" : ""}`}
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
              >
                <span>{tab.icon}</span>
                <small>{tab.label}</small>
              </button>
            ))}
          </nav>
        )}
      </section>
    </main>
  );
}
