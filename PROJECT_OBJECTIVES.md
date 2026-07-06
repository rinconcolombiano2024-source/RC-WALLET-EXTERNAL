# RC Wallet — Objetivos oficiales y alcance técnico

## Misión

RC Wallet detecta activos asociados a una dirección de World App en varias
redes EVM, informa si existe una firma válida para recuperarlos y permite una
transferencia manual cuando esa autoridad está disponible.

## Estados de recuperabilidad

### Recuperable

- Activo en World Chain y sesión World App autenticada.
- Activo en una red externa y la wallet conectada expone exactamente la misma
  dirección que contiene los fondos.
- Smart account desplegada cuya firma EIP-1271 sea válida y cuya función de
  ejecución haya sido identificada y simulada.

### Parcialmente recuperable

- El activo existe, pero todavía no hay un firmante compatible.
- La cuenta es contrafactual y falta reconstruir su despliegue exacto.
- El token admite autorización por firma, pero todavía no se integró su método.

### No recuperable desde RC Wallet

- La wallet conectada tiene una dirección diferente.
- La firma de World App no es válida en la red objetivo.
- No existen propietarios, módulos o datos de despliegue verificables.
- El contrato impide transferencias o el activo no es realmente ERC-20.

## MVP implementado

- Autenticación SIWE mediante World App.
- Dirección automática de World App y modo de análisis manual.
- Escaneo de World Chain, Ethereum, Optimism, Base y BNB Chain.
- Monedas nativas y tokens ERC-20 configurados.
- Contratos ERC-20 personalizados.
- RPC fallback.
- Balances, red, contrato y exploradores.
- Firma MiniKit en World Chain.
- Firma externa con extensión o WalletConnect.
- Bloqueo cuando la cuenta firmante no coincide con la dirección escaneada.
- RC Link para analizar firmas EOA, EIP-1271 y cuentas contrafactuales.
- Caché local de contratos personalizados.
- Publicidad de Rincón Colombiano en Czapelska 33.

## Añadido en la versión 3.3

- Precio, volumen, liquidez y market cap del par más líquido.
- Gráficas de velas en tiempo real mediante DexScreener.
- Botones Comprar, Vender y Cambiar que abren una ruta DEX verificable.

## Pendiente para siguientes fases

- Historial persistente de escaneos y recuperaciones.
- QR local de depósitos.
- Valor total del portafolio.
- Indexador para descubrir automáticamente ERC-20 desconocidos.
- Ejecución de smart accounts externas después de identificar su implementación.
- Swap, compra y venta únicamente mediante integraciones oficiales y auditadas.

## Restricciones

Un RPC estándar no puede enumerar automáticamente todos los tokens de una
dirección. Para detectar ERC-20 desconocidos se necesita un indexador de
transferencias/logs o un proveedor especializado.

World ID demuestra humanidad; SIWE demuestra control de la cuenta. No deben
tratarse como la misma verificación.

MiniKit ejecuta transacciones en World Chain. Las redes externas requieren una
firma válida para la misma cuenta en esa red.
