# Configuración final

## 1. Instalar

```bash
npm install
```

## 2. Activar wallets móviles

Crea un proyecto gratuito en:

https://dashboard.reown.com

Copia `.env.example` como `.env.local` y completa:

```text
VITE_REOWN_PROJECT_ID=aa5427a18f0efc9d533439359b0031b3
```

Sin esa variable seguirá disponible una extensión inyectada, pero no el selector
QR para Trust Wallet, MetaMask Mobile, Binance Wallet y otras wallets móviles.

La versión actual usa WalletConnect directamente y no incluye Wagmi ni React
Query. Incluye Viem como dependencia compatible con MiniKit v2 para evitar
errores de resolución durante el despliegue.

La versión 3.3 añade el terminal de mercado: gráficas DexScreener, precio,
volumen, liquidez, market cap y accesos Comprar, Vender y Cambiar mediante el
DEX correspondiente.

## 3. Ejecutar

Para frontend solamente:

```bash
npm run dev
```

Para probar también las funciones SIWE de Vercel:

```bash
npx vercel dev
```

## 4. World Developer Portal

Autoriza los contratos ERC-20 que la Mini App transferirá en World Chain.
MiniKit rechazará contratos no incluidos en la allowlist.

## 5. Regla de recuperación

Para Ethereum, Optimism, Base o BNB Chain:

1. Carga la dirección de World App.
2. Escanea los balances.
3. Selecciona el activo.
4. Conecta MetaMask, Trust Wallet, Binance Wallet u otra wallet, o carga una
   llave privada local solo si ya la tienes y corresponde a la misma dirección.
5. La cuenta firmante debe ser exactamente igual a la dirección escaneada.
6. Selecciona una dirección receptora distinta.
7. Revisa y firma.

Si las direcciones no coinciden, la aplicación bloquea la transferencia. Vincular
dos wallets no concede a una de ellas autoridad sobre la otra. RC Wallet External
no puede extraer, descubrir ni reconstruir una llave privada de World App.

## 6. Publicidad

La interfaz incluye:

- Rincón Colombiano;
- ul. Czapelska 33, Varsovia;
- cupón de empanada con compra mínima de 50 zł;
- enlace directo a Google Maps.

## Advertencia

Prueba primero con cantidades pequeñas. No introduzcas frases semilla. Si usas
el modo de llave privada local, hazlo únicamente en tu propio dominio o equipo
confiable; la llave se usa en memoria y no debe compartirse con terceros.
