# PEARL Paper Trading Dashboard

Dashboard local para observar PEARL/USDT en modo paper. La API vive dentro del mismo proceso del bot V5.x; no inicia otro bot ni reconstruye sus métricas desde `state.json` o `events.jsonl`.

## Uso normal

Desde `C:\Users\Trabajo\pearl-paper-scalper-v5_1_8`:

```powershell
node pearl-scalper-v5.2.0-auto-1cent-10k.cjs
```

Abre <http://127.0.0.1:4174>. Ese mismo proceso sirve la página, expone el objeto runtime por HTTP/SSE y conserva muestras en `runtime_metrics.sqlite`.

El dashboard lee `GET /api/health`, `GET /api/snapshot`, `GET /api/history` y `GET /events`. Los botones de la página llaman únicamente al control local del bot (`POST /open`, `POST /close` y `POST /configure` en el puerto 4175): la configuración solo se cambia con el bot cerrado y sin posiciones; abrir/cerrar habilita o pausa nuevas entradas automáticas; no coloca órdenes manuales ni expone credenciales.

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

La API llama a las métricas que el proceso V5.2.0 mantiene en memoria: versión, target absoluto configurable, bank operativo configurable, sizing base de 100% con cautela de 30% solo cerca del soporte, último precio, ticker 24h, high/low, posición de rango, bid/ask, ventanas de flujo, entry zone, high-range context, falling-market lock, control del bot, salud del WebSocket y registro rolling de toques/rebotes de soporte-resistencia en 120 minutos. El dashboard usa ese objeto como fuente actual; los archivos JSON siguen aportando estado financiero, eventos, señales y fills persistidos.

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
