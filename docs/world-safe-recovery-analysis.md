# RC Wallet External - World App Safe Recovery Analysis

## Alcance

Este documento define el flujo seguro para recuperar fondos enviados a una direccion World App/Safe en una red EVM donde la cuenta todavia no esta desplegada. No autoriza despliegues ni movimientos reales en mainnet.

## Caso De Prueba

- Smart Account objetivo: `0x0BbBd8EBa77dB629721CcdFa0C57a9ee107fdB85`
- Owner conocido: `0x2744392572aA5C1DDbE14EE3eA04B063416DE6B7`
- Red fuente: World Chain, `chainId=480`
- Red objetivo: Ethereum, `chainId=1`
- WLD en Ethereum: `0x163f8C2467924be0ae7B5347228CABF260318753`
- Activos observados en Ethereum: `108.42269371 WLD` y `0.010876721815616908 ETH`

## Hechos Confirmados

- En Ethereum, la direccion objetivo no tiene contrato desplegado si `eth_getCode` devuelve `0x`.
- En World Chain, la direccion objetivo se comporta como una Safe Smart Account.
- La Safe observada tiene owner `0x2744392572aA5C1DDbE14EE3eA04B063416DE6B7`.
- La Safe observada tiene threshold `1`.
- La Safe observada tiene un modulo: `0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226`.
- La recuperacion solo puede considerarse viable si la direccion CREATE2 predicha en Ethereum coincide exactamente con `0x0BbBd8EBa77dB629721CcdFa0C57a9ee107fdB85`.

## Inferencias

- Owners y threshold no bastan para reproducir la direccion. El `initializer` exacto puede incluir `fallbackHandler`, llamadas delegadas y habilitacion de modulos.
- Si el despliegue original uso un metodo chain-specific, la igualdad de direccion entre World Chain y Ethereum puede fallar por diseno.
- Si el despliegue original uso una factory estandar de Safe y el mismo initializer/salt no incluye chainId, podria ser posible desplegar la misma direccion en Ethereum, pero solo despues de probar CREATE2.

## Datos Faltantes

- Factory exacta que creo la cuenta individual.
- Singleton exacto usado en el despliegue individual.
- `proxyCreationCode` exacto usado por la factory en el momento del despliegue.
- `initializer` exacto de `Safe.setup`.
- `saltNonce` exacto.
- Metodo exacto:
  - `createProxyWithNonce`
  - `createProxyWithNonceL2`
  - `createProxyWithCallback`
  - `createChainSpecificProxyWithNonce`
  - `createChainSpecificProxyWithNonceL2`
- Calldata completo de la transaccion de creacion.
- Simulacion fork que demuestre despliegue, ownership y movimiento sin mainnet.

## Motor Implementado

Se agrego `CounterfactualSafeRecoveryEngine` en:

`src/recovery/counterfactual-safe-engine.js`

El motor:

- Rechaza campos tipo private key, seed, mnemonic o secretos.
- Calcula direccion CREATE2 con factory, proxyCreationCode, singleton, initializer y salt.
- Soporta metodos Safe estandar y chain-specific.
- Devuelve `predictedAddress`, `expectedAddress`, `matches`, hashes y evidencia.
- Bloquea la transaccion de despliegue si `predictedAddress` no coincide.
- Genera calldata de despliegue solo cuando la recuperacion pasa las verificaciones.
- Genera acciones Safe para transferir ERC20 o nativo despues del despliegue.
- No envia transacciones.
- Exige simulacion fork y aprobacion humana.

## Ruta De Busqueda Y Prediccion

Se agrego la ruta Vercel:

`POST /api/counterfactual-safe-recovery`

La ruta recibe:

- `sourceChainId`: red donde la Safe World App existe, por ejemplo `480`.
- `targetChainId` o `targetChainIds`: redes donde se quiere comprobar despliegue, por ejemplo `1`, `10`, `56`, `8453`.
- `smartAccountAddress`: direccion Worldcoin con fondos.
- `connectedOwnerAddress`: owner que firmara, si ya se conoce.
- `creationTransactionHash` o `relatedTransactionHash`: opcional, pero recomendado si el servicio de Safe/explorer no devuelve la creacion.
- `sourceDeployment`: opcional, para entregar manualmente datos verificados `factory`, `singleton`, `initializer`, `saltNonce`, `method` y `proxyCreationCode`.
- `plannedTransfers`: opcional, acciones ERC20/nativas que se preparan solo si el despliegue pasa CREATE2 y ownership.
- `fromBlock`, `toBlock` o `scanCursor`: opcionales, para continuar busqueda historica por rangos sin agotar el tiempo de Vercel.
- `maxLogBatches`, `logBatchSize` y `relatedBlockRadius`: opcionales, para ajustar la profundidad del escaneo.
- `includeUnindexedLogs`: opcional avanzado; por defecto la ruta usa logs indexados por direccion, que es lo correcto y rapido para Safe.
- `includeGlobalFactorySearch`: opcional; por defecto esta activo para buscar eventos Safe aunque World App haya usado una factory no listada en el catalogo local.

La ruta busca datos en este orden:

- Estado on-chain de la Safe fuente: owners, threshold, version, nonce, modulos, singleton y fallback handler.
- Safe Transaction Service y Safe Client Gateway.
- Etherscan API V2 `getcontractcreation`, si `ETHERSCAN_API_KEY` o `WORLDSCAN_API_KEY` esta configurada.
- Etherscan/Worldscan Logs API para buscar eventos `ProxyCreation` por factory y direccion indexada.
- Etherscan/Worldscan Logs API global, sin fijar factory, usando `topic0 + topic1` para detectar deployers custom.
- Etherscan/Worldscan internal transactions para encontrar el hash de creacion cuando el contrato fue creado por factory.
- Etherscan/Worldscan normal transactions para rescatar hash de creacion o interaccion de factory cuando el explorer lo expone alli.
- Recibo del `creationTransactionHash` o `relatedTransactionHash`, para detectar eventos de creacion dentro de una transaccion externa.
- Ventana de bloques alrededor del `relatedTransactionHash`, para encontrar eventos de creacion cercanos aunque el hash no sea la creacion directa.
- Logs `ProxyCreation`, `ProxyCreationL2` y `ChainSpecificProxyCreationL2` de factories Safe conocidas, con busqueda acotada por lotes e incluyendo eventos indexados y no indexados.
- Busqueda global por eventos `ProxyCreation*` indexados por la direccion proxy, para detectar factories custom o deployers no catalogados.
- Si no termina la busqueda, devuelve `nextScan` para continuar desde el siguiente rango historico.

Por cada red destino devuelve:

- Si la direccion destino ya tiene contrato o esta vacia.
- Factory, singleton, initializer, salt y metodo cuando se pueden reconstruir.
- Direccion CREATE2 predicha.
- Si la prediccion coincide exactamente con la direccion con fondos.
- Calldata de despliegue real solo cuando existe owner valido, factory/singleton con codigo, direccion vacia y coincidencia exacta.
- Acciones Safe de movimiento solo cuando el despliegue tambien es valido.
- `movementPlan.canMoveTokens=true` solo cuando existe `deployTransaction`, existen `safeActions` y no hay broadcast mainnet preparado.

La ruta esta en modo `read-predict-prepare-only`: no firma, no recibe llaves privadas y no transmite transacciones a mainnet.

## Estados Permitidos

- `unsupported-account`
- `owner-mismatch`
- `source-deployment-not-found`
- `missing-calldata`
- `missing-factory`
- `missing-singleton`
- `missing-salt`
- `chain-specific-address`
- `predicted-address-mismatch`
- `simulation-failed`
- `recoverable-in-simulation`
- `ready-for-manual-review`

## Reglas De Seguridad

- No pedir, almacenar ni imprimir llaves privadas o frases semilla.
- Firmar solo mediante wallet externa.
- No transmitir a mainnet sin autorizacion humana explicita.
- No desplegar si la direccion predicha no coincide exactamente.
- No usar delegatecall hacia contratos no aprobados.
- No hacer bridges automaticos.
- No cobrar comision desde fondos sin consentimiento explicito.
- Registrar hechos, inferencias y datos faltantes.

## Fuentes

- Safe Deployment: https://docs.safe.global/sdk/protocol-kit/guides/safe-deployment
- Safe Multichain Deployment: https://docs.safe.global/sdk/protocol-kit/guides/multichain-safe-deployment
- Safe Deployments Repository: https://github.com/safe-global/safe-deployments
- World Chain Docs: https://docs.world.org/world-chain
- Etherscan API V2: https://docs.etherscan.io/etherscan-v2

## Resultado Actual

Resultado: informacion insuficiente para declarar recuperacion viable.

Motivo: falta el `initializer` y `saltNonce` exactos de la Safe individual. El motor ya puede preparar recuperacion activa cuando esos datos existan y la prediccion CREATE2 coincida exactamente.
