# RC Wallet Externa

RC Wallet Externa es una wallet EVM local, no custodial y separada de la Mini App de World App.

## Objetivo

Permitir que un usuario que posee una llave privada real pueda:

- importarla voluntariamente;
- derivar la dirección EVM;
- confirmar que coincide con su dirección World App esperada;
- cifrar la llave localmente con contraseña;
- escanear fondos multi-chain;
- enviar monedas nativas y ERC20 firmando localmente desde el navegador.

## Reglas de seguridad

- La llave privada no se envía a ningún servidor.
- No se pide frase semilla.
- La llave se guarda cifrada en `localStorage` usando AES-GCM y PBKDF2.
- La firma ocurre localmente con `ethers.Wallet`.
- El usuario puede borrar la wallet cifrada del dispositivo.
- Si la dirección derivada no coincide con la dirección World App esperada, los envíos quedan bloqueados.

## Redes incluidas

- Ethereum
- World Chain
- Base
- Optimism
- BNB Chain
- Polygon

## Tokens incluidos

Escanea nativos y ERC20 configurados:

- WLD
- USDC
- USDT
- WETH
- WBTC
- RC.PL
- GOLD / ORO
- SUSHI
- MADS
- RCOL
- Tokens personalizados agregados por contrato.

Nota: enumerar automáticamente todos los ERC20 desconocidos requiere un indexer o API de explorador. Esta versión no simula balances: permite agregar contratos personalizados y lee el balance real on-chain.

## PWA

Incluye:

- `manifest.webmanifest`
- `sw.js`
- icono instalable

Puede instalarse en Android/iOS desde el navegador si el hosting usa HTTPS.

## Deploy

```bash
npm install
npm run build
```

Vercel:

- Framework: Vite
- Build command: `npm run build`
- Output directory: `dist`
- Node: `24.x`

## Relación con RC Wallet Mini App

La Mini App se mantiene intacta para:

- World ID;
- MiniKit;
- diagnóstico;
- escaneo;
- World Chain.

RC Wallet Externa es para:

- importar llave privada real;
- firmar localmente;
- mover fondos en redes EVM externas.

Si World App no permite exportar una llave privada, RC Wallet Externa no puede inventarla ni recuperar fondos sin autoridad criptográfica.
