# PEARL Paper Trading Dashboard

Dashboard local para observar PEARL/USDT en modo paper. La API vive dentro del mismo proceso `node pearl-scalper-v5.1.8.cjs`; no inicia otro bot ni reconstruye sus métricas desde `state.json` o `events.jsonl`.

## Uso normal

Desde `C:\Users\Trabajo\pearl-paper-scalper-v5_1_8`:

```powershell
node pearl-scalper-v5.1.8.cjs
```

Abre <http://127.0.0.1:4174>. Ese mismo proceso sirve la página, expone el objeto runtime por HTTP/SSE y conserva muestras en `runtime_metrics.sqlite`.

El API sólo acepta lecturas: `GET /api/health`, `GET /api/snapshot`, `GET /api/history` y `GET /events`. Escucha en `127.0.0.1`; no ofrece rutas de órdenes ni credenciales.

## Vista de desarrollo

Para trabajar en la interfaz mientras el bot ya está ejecutándose:

```powershell
cd C:\Users\Trabajo\pearl-paper-scalper-v5_1_8\dashboard
npm run dashboard
```

Abre la URL que indique Vite, normalmente `http://127.0.0.1:5173`. Vite sólo sirve el frontend y reenvía `/api` y `/events` al API del bot en `127.0.0.1:4174`; no inicia un lector ni un segundo servidor de datos.

Después de cambiar la interfaz, genera los archivos servidos por el proceso del bot:

```powershell
npm run build
```

## Fuente runtime y persistencia

La API llama a las métricas que el proceso V5.1.8 mantiene en memoria: último precio, ticker 24h, high/low, posición de rango, bid/ask, ventanas de flujo, entry zone, high-range caution, falling-market lock y salud del WebSocket. El dashboard usa ese objeto como fuente actual; los archivos JSON siguen aportando estado financiero, eventos, señales y fills persistidos.

`runtime_metrics.sqlite` se crea junto a `state.json`. Guarda una muestra cada 10 segundos y conserva siete días; el gráfico carga hasta 24 horas. Al reiniciar, el bot reanuda el estado persistido en `state.json` y la base conserva la historia del dashboard. Las ventanas de trades en memoria se vuelven a formar con el flujo de mercado tras la reconexión.

## Archivos observados

- `state.json`: efectivo, PEARL, órdenes, posición, recoveries, contadores y bloqueos persistidos.
- `events.jsonl`: eventos de cambios de estado, bloqueos y fills.
- `paper_trades.jsonl`: actividad paper y resultados de ciclos.
- `signals.jsonl`: decisiones de entrada registradas.
- `summary_24h.json`: resumen al completar la prueba de 24 horas.
- `runtime_metrics.sqlite`: muestras de métricas runtime capturadas por el mismo proceso del bot.

Los valores de `runtime_metrics.sqlite` son lecturas históricas del objeto runtime; no participan en las decisiones de trading ni se usan para enviar órdenes.

## Desarrollo y verificación

```powershell
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

El aviso de terceros correspondiente está en [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
