const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const WebSocket = require("ws");
const { createRuntimeApi } = require("./dashboard/runtime-api.cjs");

// ============================================================
// PEARL / USDT PAPER SCALPER V5.1.8.3
// ============================================================
// 100% PAPER — NO API KEY — NO REAL ORDERS
//
// Objetivo del test:
// - correr 24 horas completas sin reglas horarias de trading
// - target normal: +0.45% BRUTO
// - fills causales
// - EARLY ARM: BUY LIMIT se coloca antes de que madure la señal completa
// - BUY LIMIT estática por intento (sin reprice alcista)
// - soporte automático de 60 min SOLO como referencia bajista
// - ticker rolling 24 h de BigONE (open/high/low/close/volume)
// - V5.1.8.3: usar high24h como ENTRY LADDER dinámico para no comprar en el mismo escalón del máximo
// - V5.1.8.3: NORMAL_SCALP -> SOFT_FALLING_CAUTION(30%) -> HARD_FALLING_LOCK(0%)
// - cancelar BUY pendiente solo ante ruptura bajista material confirmada
// - stop defensivo normal SOLO si respeta el capital protegido
// - ruptura estructural NO liquida: mueve la posición a RECOVERY_HOLD
// - RECOVERY_HOLD sale en break-even neto + buffer mínimo
// - RECOVERY_HOLD: -10% arma RECOVERY_DANGER; hard stop solo tras fallo del low24hAnchor
// - BREAKDOWN_LOCK evita recomprar inmediatamente el soporte roto
// - capital nuevo puede inyectarse al SCALP_BUCKET sin mezclarse con la posición atrapada
// - registrar exactamente el punto de 24h y seguir corriendo
// ============================================================

// ============================================================
// MARKET / CAPITAL / FEES
// ============================================================

const MARKET = "PEARL-USDT";
const WS_URL = "wss://api.big.one/ws/v2";
const TICKER_REST_URL = "https://api.big.one/api/v3/asset_pairs/PEARL-USDT/ticker";
const TRADES_REST_URL = "https://api.big.one/api/v3/asset_pairs/PEARL-USDT/trades";
const TIMEZONE = "America/Ciudad_Juarez";

const START_CAPITAL = 100;
const BUY_FEE = 0.002;   // 0.20%
const SELL_FEE = 0.002;  // 0.20%

// IMPORTANTE: ESTE ES EL TARGET DEL BOT.
const TARGET_GROSS = 0.0045; // +0.4500% movimiento de precio

// ============================================================
// V5.1.8.3 — RECOVERY / CAPITAL BUCKETS / ANCHORED 24H SUPPORT
// ============================================================
// Una ruptura estructural ya NO realiza una pérdida de 1–3% automáticamente.
// La posición se separa del SCALP_BUCKET y pasa a RECOVERY_HOLD.
//
// V5.1.8.3 cambia el significado del -10%:
// -10% = RECOVERY_DANGER (alarma), NO venta.
// El HARD STOP real requiere además invalidar el LOW 24H ANCLADO al momento
// de entrar en recovery: romperlo 1.5%, permanecer debajo ~2 min, mantener
// presión vendedora fuerte y NO reclaim del nivel de ruptura.
//
// low24hAnchor es INMUTABLE para ese recovery. El low24h global sigue siendo
// dinámico y puede utilizarse normalmente para operaciones futuras.
const RECOVERY_DANGER_PCT = 0.10;                 // -10% neto = armar danger; NO vender
const RECOVERY_ANCHOR_BREAK_PCT = 0.0150;         // romper low24hAnchor >=1.50%
const RECOVERY_ANCHOR_BREAK_CONFIRM_MS = 2 * 60 * 1000;
const RECOVERY_ANCHOR_ASK_SHARE_5M = 0.62;        // presión vendedora persistente
const RECOVERY_ANCHOR_ASK_SHARE_30S = 0.70;       // presión vendedora rápida
const RECOVERY_EXIT_BUFFER_PCT = 0.0002;          // +0.02% sobre break-even exacto
const MIN_SCALP_CASH_USDT = 1.00;

// V5.1.8.3 — MULTI-POSITION CON LAS MISMAS REGLAS DE ENTRADA.
// Solo una BUY LIMIT pendiente a la vez; pueden coexistir varias SELL LIMIT.
// Cada posición individual usa como máximo 30% del capital operativo y debe
// estar separada >=0.25% de toda posición/recovery abierta.
const MULTI_POSITION_MAX_CAPITAL_FRACTION = 0.30;
const MIN_POSITION_SPACING_PCT = 0.0025; // 0.25%

// ============================================================
// V5.1.8.3 — STARTUP CONTEXT + EXHAUSTION CAUTION
// ============================================================
// El bot NO compra a ciegas al arrancar. Durante 4 minutos observa trades LIVE
// del proceso actual. El snapshot histórico sigue sirviendo para soportes/rangos,
// pero NO cuenta como contexto suficiente para habilitar la primera BUY.
const STARTUP_CONTEXT_LOCK_MS = 2 * 60 * 1000;
const STARTUP_CONTEXT_MIN_LIVE_TRADES = 20;

// HIGH 24h sigue siendo CONTEXTO, nunca resistencia rígida.
// La cautela ahora depende de subida fuerte + agotamiento observable, incluso si
// el precio está en 60–80% del rango 24h. Estar >85% solo suma contexto.
const HIGH_RANGE_CAUTION_MIN_24H_POSITION = 0.75;
const HIGH_RANGE_CAUTION_STRONG_RUN_10M = 0.0100;    // +1.00% desde low 10m
const HIGH_RANGE_CAUTION_STRONG_RUN_60M = 0.0250;    // o +2.50% desde low 60m
const HIGH_RANGE_CAUTION_PULLBACK_5M = 0.0020;       // -0.20% desde high 5m
const HIGH_RANGE_CAUTION_LOWER_HIGH_PCT = 0.0010;    // high 5m >=0.10% menor que 5m previos
const HIGH_RANGE_CAUTION_ASK_SHARE = 0.55;
const HIGH_RANGE_CAUTION_MICRO_DROP = 0.0005;
const HIGH_RANGE_CAUTION_MIN_EXHAUSTION_VOTES = 2;
const HIGH_RANGE_CAUTION_CAPITAL_FRACTION = 0.30;

// V5.1.8.3 — RANGE POSITION SIZING + PRICE LADDER GATE
// <=75% del rango 24h: puede usar 100% del SCALP_BUCKET.
// >75% y <=82%: máximo 30%.
// >82%: NO RANGE BUY.
//
// Nunca compramos dentro de la MISMA banda decimal de 0.10 USDT donde vive
// el high24h. Ejemplo: high24h=1.8722 => solo BUY <1.8000.
// Para habilitar BUY 1.8x el high24h debe romper 1.9000 por al menos 1 tick.
const RANGE_FULL_CAPITAL_MAX_24H_POSITION = 0.75;
const RANGE_CAUTION_MAX_24H_POSITION = 0.82;
const RANGE_CAUTION_CAPITAL_FRACTION = 0.30;
const PRICE_LADDER_STEP = 0.10;
const PRICE_LADDER_BREAK_CONFIRM_TICKS = 1;

// V5.1.8.3 — PRE-ENTRY FALLING REGIME.
// La volatilidad normal NO debe apagar el scalper. Separamos:
// NORMAL_SCALP -> SOFT_FALLING_CAUTION (30%) -> HARD_FALLING_LOCK (0%).
//
// SOFT: deterioro moderado. Sigue operando con máximo 30%.
// HARD: desplome/shock o slow-bleed persistente. Crea el lock real.
const SOFT_FALLING_MOVE_4M = 0.0040;                 // <= -0.40%
const SOFT_FALLING_MOVE_5M = 0.0050;                 // <= -0.50%
const SOFT_FALLING_MOVE_10M = 0.0075;                // <= -0.75%
const SOFT_FALLING_CAPITAL_FRACTION = 0.30;

const HARD_FALLING_MOVE_5M = 0.0125;                 // <= -1.25%
const HARD_FALLING_MOVE_10M = 0.0175;                // <= -1.75%
const HARD_FALLING_DROP_FROM_HIGH_15M = 0.0200;      // >=2.00% bajo high15m
const HARD_FALLING_MOMENTUM_30S = 0.0075;            // <= -0.75%, exige continuidad
const HARD_FALLING_MOMENTUM_CONFIRM_MOVE_5M = 0.0040;// continuación 5m <= -0.40%

// Ruta HARD adicional para slow-bleed persistente.
const HARD_SLOW_BLEED_MOVE_5M = 0.0080;              // <= -0.80%
const HARD_SLOW_BLEED_MOVE_10M = 0.0100;             // <= -1.00%
const HARD_SLOW_BLEED_RECENT_LOW_MS = 2 * 60 * 1000;
const HARD_SLOW_BLEED_NEAR_LOW_PCT = 0.0025;         // dentro de 0.25% del low10m

// Contexto auxiliar; ya NO crea un HARD lock por sí solo.
const PREENTRY_FALLING_PULLBACK_FROM_HIGH_5M = 0.0050;
const PREENTRY_FALLING_ASK_SHARE = 0.62;
const PREENTRY_FALLING_MICRO_DROP = 0.0010;
const PREENTRY_FALLING_NEAR_LOW_PCT = 0.0020;

// ============================================================
// V5.1.8.3 — ENTRY STABILITY GATE / SLOW-BLEED PROTECTION
// ============================================================
// La zona de precio permitida NO basta para comprar. Si el mercado viene
// descendiendo materialmente, esperamos que deje de hacer mínimos y que 10m/5m/30s
// se estabilicen antes de armar una BUY. Esto evita comprar 1.79 simplemente porque
// el ladder lo permite mientras PEARL todavía cae hacia 1.73.
const ENTRY_STABILITY_WINDOW_MS = 15 * 60 * 1000;
const ENTRY_STABILITY_DROP_FROM_HIGH_15M = 0.0100;   // >=1.00% bajo high15m => requiere estabilidad
const ENTRY_STABILITY_DROP_10M = 0.0040;             // move10m <= -0.40% => requiere estabilidad
const ENTRY_STABILITY_DROP_5M = 0.0025;              // move5m <= -0.25% => requiere estabilidad
const ENTRY_STABILITY_MIN_LOW_AGE_MS = 3 * 60 * 1000; // 3 min sin nuevo low del bloque
const ENTRY_STABILITY_MAX_DROP_10M = 0.0020;         // para liberar: move10m >= -0.20%
const ENTRY_STABILITY_MAX_DROP_5M = 0.0010;          // para liberar: move5m >= -0.10%
const ENTRY_STABILITY_MAX_DROP_30S = 0.0005;         // para liberar: move30s >= -0.05%
const ENTRY_STABILITY_MAX_ASK_SHARE_5M = 0.60;
const ENTRY_STABILITY_MIN_BOUNCE_FROM_LOW_5M = 0.0015; // +0.15% desde low5m
const ENTRY_STABILITY_TIGHT_RANGE_5M = 0.0030;       // o rango5m <=0.30%

// ============================================================
// V5.1.8.3 — FALLING MARKET LOCK / STABILITY GATE
// ============================================================
// Si una posición pasa a RECOVERY_HOLD por ruptura estructural, el cash
// restante NO se reutiliza durante la caída. El lock solo se libera cuando
// el mercado deja de hacer nuevos lows materiales y 10m/5m/30s muestran
// estabilidad suficiente. No intenta predecir el fondo; evita comprar cada escalón.
// PRE-ENTRY HARD lock: liberación más rápida una vez desaparece el desplome.
// Los locks nacidos desde RECOVERY mantienen la confirmación conservadora de 5m.
const PREENTRY_HARD_LOCK_MIN_MS = 2 * 60 * 1000;
const PREENTRY_HARD_LOCK_NO_NEW_LOW_MS = 2 * 60 * 1000;
const PREENTRY_HARD_RELEASE_MAX_DROP_5M = 0.0025;     // move5m >= -0.25%
const PREENTRY_HARD_RELEASE_MAX_DROP_30S = 0.0015;   // move30s >= -0.15% o N/A
const PREENTRY_HARD_RELEASE_MIN_BOUNCE_5M = 0.0025;  // +0.25% desde low5m

const FALLING_LOCK_MIN_MS = 5 * 60 * 1000;
const FALLING_LOCK_NO_NEW_LOW_MS = 5 * 60 * 1000;
const FALLING_LOCK_MEANINGFUL_NEW_LOW_PCT = 0.0010;  // nuevo low >=0.10% más abajo
const STABILITY_MAX_DROP_10M = 0.0030;               // move10m >= -0.30%
const STABILITY_MAX_DROP_5M = 0.0015;                // move5m >= -0.15%
const STABILITY_MAX_DROP_30S = 0.0010;               // move30s >= -0.10%
const STABILITY_MAX_ASK_SHARE_5M = 0.62;
const STABILITY_BOUNCE_FROM_LOW_5M = 0.0015;         // +0.15% sobre low5m
const STABILITY_TIGHT_RANGE_5M = 0.0035;             // o rango5m <=0.35%

// Anti-whipsaw tras romper soporte.
const BREAKDOWN_RECLAIM_PCT = 0.0030;        // reclaim >= +0.30% sobre soporte roto
const BREAKDOWN_RECLAIM_CONFIRM_MS = 2 * 60 * 1000;
const BREAKDOWN_NEW_SUPPORT_PCT = 0.0050;    // nuevo soporte >=0.50% más abajo

// Inyección PAPER opcional. Ejemplo Git Bash:
// PAPER_INJECT_USDT=100 PAPER_INJECT_ID=extra-100-1 node pearl-scalper-v5.1.8.3.cjs
// El ID evita aplicar dos veces la misma aportación al reiniciar.
const PAPER_INJECT_USDT = Number(process.env.PAPER_INJECT_USDT || 0);
const PAPER_INJECT_ID = String(process.env.PAPER_INJECT_ID || "").trim();

const TICK = 0.0001;

// V5.1.8.3 — comparación robusta de precios al tick.
// Un trade un tick o más allá de la LIMIT cuenta como cross-through.
const PRICE_EPSILON = TICK / 2;

// Runtime-only: cada reinicio exige 4 minutos de contexto LIVE nuevo.
const PROCESS_STARTED_AT_MS = Date.now();
const liveTradesSinceProcessStart = [];

// ============================================================
// V5.1.8.3 — STRICT CAUSAL FILL AUDIT
// ============================================================
// Un trade puede alimentar métricas aunque venga de REST/WS en lote,
// pero solo puede llenar una orden si fue OBSERVADO después de que
// esa orden ya existía. Una orden creada mientras se procesa un batch
// nunca puede ser llenada por otro trade del MISMO batch.
let tradeObservationSequence = 0;

function makeObservationBatchId(prefix, observedAtMs = Date.now()) {
  tradeObservationSequence += 1;
  return `${prefix}-${observedAtMs}-${tradeObservationSequence}`;
}

function placementCausalityFields(context = null) {
  const tradeTimeMs = Number(context?.tradeTimeMs);
  return {
    placedInObservationBatchId: context?.batchId ?? null,
    placedAfterTradeTimeMs: Number.isFinite(tradeTimeMs) ? tradeTimeMs : null,
    placedAfterTradeExchangeTime: Number.isFinite(tradeTimeMs) ? iso(tradeTimeMs) : null,
    placementObservationSource: context?.source ?? null
  };
}

function causalFillAudit(order, trade, source, observationMeta = {}) {
  const orderPlacedAtMs = Number(
    order?.firstPlacedAtMs ??
    order?.placedAtMs ??
    order?.recoveryOrderPlacedAtMs ??
    order?.recoveryStartedAtMs
  );
  const observedAtMs = Number(observationMeta?.observedAtMs ?? Date.now());
  const batchId = observationMeta?.batchId ?? null;
  const placementBatchId = order?.placedInObservationBatchId ?? null;
  const anchorTradeTimeMs = Number(order?.placedAfterTradeTimeMs);

  const observedAfterPlacement =
    !Number.isFinite(orderPlacedAtMs) || observedAtMs > orderPlacedAtMs;
  const sameObservationBatch = Boolean(
    batchId && placementBatchId && batchId === placementBatchId
  );
  const exchangeAfterAnchor =
    !Number.isFinite(anchorTradeTimeMs) || trade.time >= anchorTradeTimeMs;

  let reason = "OK";
  if (!observedAfterPlacement) reason = "TRADE_OBSERVED_BEFORE_OR_AT_ORDER";
  else if (sameObservationBatch) reason = "SAME_OBSERVATION_BATCH_AS_ORDER";
  else if (!exchangeAfterAnchor) reason = "EXCHANGE_TIME_BEFORE_ORDER_ANCHOR";

  return {
    ok: reason === "OK",
    reason,
    source,
    batchId,
    placementBatchId,
    orderPlacedAt: Number.isFinite(orderPlacedAtMs) ? iso(orderPlacedAtMs) : null,
    orderPlacedAtMs: Number.isFinite(orderPlacedAtMs) ? orderPlacedAtMs : null,
    tradeExchangeTime: Number.isFinite(trade.time) ? iso(trade.time) : null,
    tradeExchangeTimeMs: Number.isFinite(trade.time) ? trade.time : null,
    tradeObservedAt: Number.isFinite(observedAtMs) ? iso(observedAtMs) : null,
    tradeObservedAtMs: Number.isFinite(observedAtMs) ? observedAtMs : null,
    causalAgeMs:
      Number.isFinite(observedAtMs) && Number.isFinite(orderPlacedAtMs)
        ? observedAtMs - orderPlacedAtMs
        : null,
    exchangeAgeVsOrderMs:
      Number.isFinite(trade.time) && Number.isFinite(orderPlacedAtMs)
        ? trade.time - orderPlacedAtMs
        : null,
    placedAfterTradeExchangeTime:
      Number.isFinite(anchorTradeTimeMs) ? iso(anchorTradeTimeMs) : null
  };
}

function priceRelation(price, limit) {
  if (price < limit - PRICE_EPSILON) return -1;
  if (price > limit + PRICE_EPSILON) return 1;
  return 0;
}

// ============================================================
// 24H TEST
// ============================================================

const TEST_DURATION_MS = 24 * 60 * 60 * 1000;

// ============================================================
// ENTRY SIGNAL
// ============================================================

const LOOKBACK_MS = 5 * 60 * 1000;
const MIN_DRAWDOWN = 0.0035;       // 0.35%
const MAX_RANGE_POSITION = 0.45;   // estar en 45% inferior del rango reciente
const MIN_RECENT_RANGE = 0.0045;   // rango >= 0.45%
const MAX_LOW_AGE_MS = 3 * 60 * 1000;
const COOLDOWN_MS = 15 * 1000;

// ============================================================
// V5.1.8.3 — EARLY ARM / MAKER PRIORITY
// ============================================================
// La orden LIMIT se arma ANTES de exigir la señal completa.
// Objetivo: que la orden ya esté descansando en el libro cuando
// el precio llegue a la zona candidata. La señal dura sigue
// calculándose y se registra cuando aparece, pero no esperamos
// a ella para colocar la LIMIT.
// V5.1.8.3: el EARLY ARM NO espera confirmación de FLOW 5m, drawdown ni rango duro.
// Si ya existe una zona maker válida, cercana y debajo del mercado, la LIMIT
// se arma inmediatamente para ganar prioridad temporal en el libro.
const EARLY_ARM_MIN_DISTANCE = 0.0002;       // BUY al menos 0.02% debajo del último trade
const EARLY_ARM_MAX_DISTANCE = 0.0060;       // no armar >0.60% por debajo del mercado

// ============================================================
// V4.8 — ESTRUCTURA 60 MIN / SOPORTE AUTOMÁTICO (DOWNSIDE)
// ============================================================

// No hay niveles PEARL escritos a mano.
// Reconstruimos velas de 1 minuto con trades de los últimos 60 min.
// El motor todavía detecta pivotes de ambos lados internamente, pero V4.8
// SOLO usa el soporte inferior para gestión de riesgo; los máximos/resistencias
// NO bloquean entradas ni repricing.
const STRUCTURE_WINDOW_MS = 60 * 60 * 1000;
const STRUCTURE_BUCKET_MS = 60 * 1000;
const STRUCTURE_PIVOT_RADIUS = 2;
const STRUCTURE_MIN_BUCKETS = 12;
const STRUCTURE_MIN_TOUCHES = 2;

// Clustering adaptativo: depende del rango real observado.
const STRUCTURE_CLUSTER_MIN_PCT = 0.0005; // 0.05%
const STRUCTURE_CLUSTER_MAX_PCT = 0.0015; // 0.15%
const STRUCTURE_CLUSTER_RANGE_FACTOR = 0.04;

// Estos parámetros se conservan únicamente para el análisis interno heredado
// de zonas. NO participan como hard gate de entrada en V4.8.
const STRUCTURE_MAX_RANGE_POSITION = 0.70;

// Parámetro heredado del analizador de zonas. En V4.8 una resistencia
// alcista nunca bloquea el scalping.
const STRUCTURE_BREAKOUT_CONFIRM_PCT = 0.0010;

// Parámetros heredados del analizador de zonas; no se usan para vetar BUYs
// ni reprices en V4.8.
const RESISTANCE_BUFFER_MIN_PCT = 0.0005;
const RESISTANCE_BUFFER_MAX_PCT = 0.0015;
const RESISTANCE_BUFFER_SPREAD_FACTOR = 0.50;

// ============================================================
// V5.1.8.3 — 24H RANGE + DOWNSIDE STRUCTURAL STOP
// ============================================================

// HIGH 24h = contexto, nunca una resistencia que bloquee una subida.
// LOW 24h + soporte local 60m = referencias bajistas.
const STRUCTURAL_STOP_BREAK_PCT = 0.0030;       // rompe soporte >=0.30%
const STRUCTURAL_STOP_FAST_ASK_SHARE = 0.70;   // ASK30 >=70%
const STRUCTURAL_STOP_MIN_DROP_30S = 0.0010;   // momentum30 <= -0.10%

// ============================================================
// BUY LIMIT / TTL
// ============================================================

// Solo aplica a una COMPRA PENDIENTE que aún NO se llenó.
// Nunca cierra una posición ya comprada.
const BUY_TTL_MS = 90 * 1000;

// ============================================================
// V5.1.8.3 — STATIC EARLY-ARM BUY ATTEMPT
// ============================================================

// La BUY permanece FIJA durante todo el intento.
// NO se persigue el precio hacia arriba.
// Si no llena dentro de 90 s, se cancela la idea y el bot
// vuelve a WAITING para recalcular una señal nueva desde cero.
//
// Una ruptura bajista estructural puede cancelar antes del TTL.

// ============================================================
// FILL MODEL
// ============================================================

// V5.1.8.3: en toque exacto exigimos cola + tamaño propio, sin 10% extra.
// Si el mercado ATRAVIESA la LIMIT, el fill es inmediato y este factor no aplica.
const FILL_SAFETY = 1.00;

// ============================================================
// ORDER FLOW / PROTECCIÓN
// ============================================================

const FLOW_WINDOW_MS = 5 * 60 * 1000;
const FAST_FLOW_WINDOW_MS = 30 * 1000;

// Para ABRIR una señal nueva seguimos usando contexto de 5 min.
const MAX_ASK_SHARE_FOR_ENTRY = 0.62;

// V5.1.8.3 — INVALIDACIÓN DE BUY PENDIENTE
//
// Tocar o cruzar ligeramente nuestra BUY NO invalida la idea.
// Eso es justamente la zona donde queremos ser llenados.
//
// Solo cancelamos por presión vendedora si, DESPUÉS de un periodo
// mínimo de observación, el mercado rompe materialmente por debajo
// de nuestra BUY y el flujo de 30 s confirma continuación bajista.
const PENDING_CANCEL_GRACE_MS = 30 * 1000;
const PENDING_BREAK_BELOW_BUY = 0.0030;       // -0.30% bajo nuestra BUY
const PENDING_CANCEL_FAST_ASK_SHARE = 0.70;   // ASK30 >=70%
const PENDING_CANCEL_MIN_DROP_30S = 0.0010;   // precio30s <= -0.10%

// Una vez comprados:
// si han pasado >=2 min,
// el precio cae >=0.20%,
// y ASK agresor >=62%,
// CONSIDERAMOS una salida defensiva.
// V4.8 solo la ejecuta si el neto de esa venta respeta el piso protegido.
const STOP_ASK_SHARE = 0.62;
const STOP_PRICE_DROP = 0.002;
const STOP_MIN_HOLD_MS = 2 * 60 * 1000;

// ============================================================
// PROFIT FLOOR
// ============================================================

// V5.1.8.3: el stop defensivo normal protege el principal COMPLETO del
// SCALP_BUCKET activo. Una ruptura estructural tampoco vende: migra a recovery.
// -10% en recovery SOLO arma RECOVERY_DANGER. El escape con pérdida requiere
// ruptura confirmada del low24hAnchor (1.5% + 2 min + presión vendedora + no reclaim).
// Se conservan estas constantes solo para compatibilidad/telemetría histórica.
const PROFIT_FLOOR_ACTIVATION = 2.00;
const PROFIT_LOCK_FRACTION = 0.75;

// ============================================================
// FILES
// ============================================================

const DIR = path.join(os.homedir(), "pearl-paper-scalper-v5_1_8");
fs.mkdirSync(DIR, { recursive: true });

const STATE_FILE = path.join(DIR, "state.json");
const TRADES_FILE = path.join(DIR, "paper_trades.jsonl");
const EVENTS_FILE = path.join(DIR, "events.jsonl");
const SIGNALS_FILE = path.join(DIR, "signals.jsonl");
const SUMMARY_24H_FILE = path.join(DIR, "summary_24h.json");

// ============================================================
// HELPERS
// ============================================================

function iso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

function num(value, decimals = 8) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return null;
  }
  return Number(Number(value).toFixed(decimals));
}

function pct(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return null;
  }
  return `${(Number(value) * 100).toFixed(4)}%`;
}

function append(file, object) {
  fs.appendFileSync(file, JSON.stringify(object) + "\n", "utf8");
}

function roundUp(price) {
  return Number((Math.ceil(price / TICK) * TICK).toFixed(4));
}

function roundDown(price) {
  return Number((Math.floor(price / TICK) * TICK).toFixed(4));
}

function localClock(ms = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(ms));

  const values = Object.fromEntries(
    parts
      .filter((x) => x.type !== "literal")
      .map((x) => [x.type, x.value])
  );

  return {
    text: `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`,
    dayKey: `${values.year}-${values.month}-${values.day}`
  };
}

// ============================================================
// STATE
// ============================================================

function initialState() {
  const now = Date.now();

  return {
    version: "5.1.8.3",

    startedAt: iso(now),
    startedAtMs: now,

    testStartedAt: iso(now),
    testStartedAtMs: now,
    test24hCompleteLogged: false,
    test24hCompletedAt: null,

    capitalStart: START_CAPITAL,
    capitalContributed: START_CAPITAL,
    cash: START_CAPITAL,
    pearl: 0,
    mode: "WAITING",

    // Posiciones atrapadas separadas del capital operativo.
    recoveryPositions: [],
    breakdownLocks: [],
    capitalInjections: [],

    cycles: 0,
    realizedProfit: 0,

    buyOrder: null,
    scalpPositions: [],
    scalpPositionsOpened: 0,
    positionSpacingBlocks: 0,
    // Vista legacy para dashboard existente; apunta al primer scalp abierto.
    position: null,
    sellOrder: null,

    lastExitTimeMs: 0,

    highestEquity: START_CAPITAL,
    maxDrawdown: 0,

    buyOrdersPlaced: 0,
    buyOrdersCancelled: 0,
    buyOrdersFilled: 0,
    buyOrdersExpired: 0,

    // V5.1.8.3: LIMIT colocadas mediante armado anticipado.
    earlyBuyOrdersArmed: 0,
    hardSignalsConfirmedWhileArmed: 0,

    sellOrdersPlaced: 0,
    sellOrdersFilled: 0,
    targetExits: 0,
    stopExits: 0,

    causalBuyFillsBlocked: 0,
    causalSellFillsBlocked: 0,
    causalRecoveryFillsBlocked: 0,

    // Pico histórico de ganancia REALIZADA. Nunca disminuye.
    peakRealizedProfit: 0,

    // Stops defensivos ejecutados respetando el piso.
    capitalProtectedStops: 0,

    // Veces que una señal de stop fue bloqueada porque vender
    // habría dejado el capital por debajo del piso protegido.
    capitalFloorBlockedStops: 0,

    // V5.1.8.3: ruptura estructural inicia recovery; ya no vende inmediatamente.
    structuralStopExits: 0,
    recoveryHoldsStarted: 0,
    recoveryBreakEvenExits: 0,
    recoveryHardStops: 0,
    recoveryDangerArmed: 0,
    recoveryAnchorBreaksStarted: 0,
    recoveryAnchorBreakReclaims: 0,
    breakdownLocksCreated: 0,
    breakdownLocksReleased: 0,

    // V5.1.8.3 — régimen de agotamiento / lock de caída.
    fallingMarketLock: null,
    fallingMarketLocksCreated: 0,
    fallingMarketLocksReleased: 0,
    fallingMarketEntriesBlocked: 0,
    highRangeCautionOrders: 0,
    softFallingCautionOrders: 0,
    entryStabilityBlocks: 0,
    entryStabilityCancels: 0
  };
}

let state = initialState();

if (fs.existsSync(STATE_FILE)) {
  try {
    const previous = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));

    if (["5.1.8.3", "5.1.8.2", "5.1.8.1", "5.1.8"].includes(previous.version)) {
      state = previous;
      const resumedFromVersion = previous.version;
      state.version = "5.1.8.3";
      console.log(`♻️ Reanudando estado ${resumedFromVersion} en V5.1.8.3 (misma carpeta/runtime)`);
    }
  } catch (error) {
    console.log("No pude cargar state.json:", error.message);
  }
}

function normalizeV515State() {
  state.capitalContributed = Number(state.capitalContributed ?? START_CAPITAL);
  state.recoveryPositions = Array.isArray(state.recoveryPositions) ? state.recoveryPositions : [];
  state.breakdownLocks = Array.isArray(state.breakdownLocks) ? state.breakdownLocks : [];
  state.capitalInjections = Array.isArray(state.capitalInjections) ? state.capitalInjections : [];
  state.recoveryHoldsStarted = Number(state.recoveryHoldsStarted || 0);
  state.recoveryBreakEvenExits = Number(state.recoveryBreakEvenExits || 0);
  state.recoveryHardStops = Number(state.recoveryHardStops || 0);
  state.recoveryDangerArmed = Number(state.recoveryDangerArmed || 0);
  state.recoveryAnchorBreaksStarted = Number(state.recoveryAnchorBreaksStarted || 0);
  state.recoveryAnchorBreakReclaims = Number(state.recoveryAnchorBreakReclaims || 0);
  state.breakdownLocksCreated = Number(state.breakdownLocksCreated || 0);
  state.breakdownLocksReleased = Number(state.breakdownLocksReleased || 0);
  state.sellOrdersPlaced = Number(state.sellOrdersPlaced || 0);
  state.causalBuyFillsBlocked = Number(state.causalBuyFillsBlocked || 0);
  state.causalSellFillsBlocked = Number(state.causalSellFillsBlocked || 0);
  state.causalRecoveryFillsBlocked = Number(state.causalRecoveryFillsBlocked || 0);
  state.fallingMarketLock = state.fallingMarketLock && typeof state.fallingMarketLock === "object"
    ? state.fallingMarketLock
    : null;
  state.fallingMarketLocksCreated = Number(state.fallingMarketLocksCreated || 0);
  state.fallingMarketLocksReleased = Number(state.fallingMarketLocksReleased || 0);
  state.fallingMarketEntriesBlocked = Number(state.fallingMarketEntriesBlocked || 0);
  state.highRangeCautionOrders = Number(state.highRangeCautionOrders || 0);
  state.softFallingCautionOrders = Number(state.softFallingCautionOrders || 0);
  state.entryStabilityBlocks = Number(state.entryStabilityBlocks || 0);
  state.entryStabilityCancels = Number(state.entryStabilityCancels || 0);
  state.scalpPositions = Array.isArray(state.scalpPositions) ? state.scalpPositions : [];
  state.scalpPositionsOpened = Number(state.scalpPositionsOpened || 0);
  state.positionSpacingBlocks = Number(state.positionSpacingBlocks || 0);

  // Migración transparente desde 5.1.8.2/5.1.8.1.
  if (!state.scalpPositions.length && state.position) {
    state.scalpPositionsOpened += 1;
    state.scalpPositions.push({
      ...state.position,
      id: state.position.id || `scalp-migrated-${Date.now()}-${state.scalpPositionsOpened}`,
      sellOrder: state.sellOrder || state.position.sellOrder || null
    });
  }

  for (const position of state.scalpPositions) {
    if (!position.id) {
      state.scalpPositionsOpened += 1;
      position.id = `scalp-${Date.now()}-${state.scalpPositionsOpened}`;
    }
    if (!position.sellOrder && state.scalpPositions.length === 1 && state.sellOrder) {
      position.sellOrder = state.sellOrder;
    }
  }

  syncLegacyScalpView();
}

normalizeV515State();

function openScalpPositions() {
  return Array.isArray(state.scalpPositions) ? state.scalpPositions : [];
}

function scalpCostBasis() {
  return (Number(state.cash) || 0) + openScalpPositions().reduce(
    (sum, p) => sum + (Number(p.investedUSDT) || 0),
    0
  );
}

function syncLegacyScalpView() {
  const positions = Array.isArray(state.scalpPositions) ? state.scalpPositions : [];
  state.pearl = positions.reduce((sum, p) => sum + (Number(p.pearlReceived) || 0), 0);
  state.position = positions[0] || null;
  state.sellOrder = positions[0]?.sellOrder || null;
  state.mode = state.buyOrder ? "BUY_LIMIT" : positions.length ? "SELL_LIMIT" : "WAITING";
}

function positionSpacingContext(candidatePrice) {
  const price = Number(candidatePrice);
  if (!Number.isFinite(price) || price <= 0) {
    return { ok: false, nearestEntry: null, nearestDistancePct: null, reason: "INVALID_CANDIDATE_PRICE" };
  }

  const refs = [
    ...openScalpPositions().map((p) => ({ id: p.id, type: "SCALP", entryPrice: Number(p.entryPrice) })),
    ...state.recoveryPositions.map((p) => ({ id: p.id, type: "RECOVERY", entryPrice: Number(p.entryPrice) }))
  ].filter((x) => Number.isFinite(x.entryPrice) && x.entryPrice > 0);

  if (!refs.length) {
    return { ok: true, nearestEntry: null, nearestDistancePct: null, nearestPositionId: null, nearestType: null, reason: null };
  }

  let nearest = null;
  for (const ref of refs) {
    const distancePct = Math.abs(price / ref.entryPrice - 1);
    if (!nearest || distancePct < nearest.distancePct) nearest = { ...ref, distancePct };
  }

  const ok = nearest.distancePct + 1e-12 >= MIN_POSITION_SPACING_PCT;
  return {
    ok,
    nearestEntry: nearest.entryPrice,
    nearestDistancePct: nearest.distancePct,
    nearestPositionId: nearest.id,
    nearestType: nearest.type,
    reason: ok ? null : "TOO_CLOSE_TO_OPEN_POSITION"
  };
}

function saveState() {
  syncLegacyScalpView();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function logEvent(type, extra = {}) {
  const row = {
    time: iso(),
    localTime: localClock().text,
    type,
    ...extra
  };

  append(EVENTS_FILE, row);
  console.log(`\n${type}`, extra);
}

function maybeApplyPaperCapitalInjection() {
  if (!Number.isFinite(PAPER_INJECT_USDT) || PAPER_INJECT_USDT <= 0) return false;

  if (!PAPER_INJECT_ID) {
    console.log("⚠️ PAPER_INJECT_USDT ignorado: falta PAPER_INJECT_ID único");
    return false;
  }

  if (state.capitalInjections.some((x) => x.id === PAPER_INJECT_ID)) {
    console.log(`ℹ️ Inyección ${PAPER_INJECT_ID} ya aplicada; no se duplica.`);
    return false;
  }

  state.cash += PAPER_INJECT_USDT;
  state.capitalContributed += PAPER_INJECT_USDT;
  state.capitalInjections.push({
    id: PAPER_INJECT_ID,
    amount: PAPER_INJECT_USDT,
    time: iso(),
    localTime: localClock().text
  });

  // Una aportación no es ganancia; ajustamos el high-water mark al nuevo capital.
  state.highestEquity = Math.max(
    Number(state.highestEquity) || 0,
    currentEquity()
  );

  logEvent("💵 PAPER CAPITAL INJECTED", {
    injectionId: PAPER_INJECT_ID,
    amount: num(PAPER_INJECT_USDT),
    scalpCashAfter: num(state.cash),
    totalContributed: num(state.capitalContributed),
    recoveryBuckets: state.recoveryPositions.length
  });

  saveState();
  return true;
}

// ============================================================
// ORDER BOOK
// ============================================================

const bids = new Map();
const asks = new Map();

// ============================================================
// BIGONE ROLLING 24H TICKER
// ============================================================

let ticker24h = null;
let gotTickerSnapshot = false;
let tickerRestTimer = null;
let lastTickerRestErrorLogMs = 0;

function normalizeTicker24h(raw) {
  if (!raw) return null;

  const market = raw.market ?? raw.assetPairName ?? raw.asset_pair_name ?? null;
  if (market && market !== MARKET) return null;

  const open = Number(raw.open);
  const high = Number(raw.high);
  const low = Number(raw.low);
  const close = Number(raw.close);
  const volume = Number(raw.volume);

  if (!Number.isFinite(high) || !Number.isFinite(low) || high <= 0 || low <= 0 || high < low) {
    return null;
  }

  return {
    market: market ?? MARKET,
    open: Number.isFinite(open) ? open : null,
    high,
    low,
    close: Number.isFinite(close) ? close : null,
    volume: Number.isFinite(volume) ? volume : null,
    bid: raw.bid ? { price: Number(raw.bid.price), amount: Number(raw.bid.amount) } : null,
    ask: raw.ask ? { price: Number(raw.ask.price), amount: Number(raw.ask.amount) } : null,
    updatedAt: iso()
  };
}

function updateTicker24h(raw, source = "UPDATE") {
  const normalized = normalizeTicker24h(raw);
  if (!normalized) return false;

  ticker24h = {
    ...normalized,
    source
  };

  if (source === "SNAPSHOT") gotTickerSnapshot = true;
  return true;
}

function handleTickerWsMessage(msg) {
  if (!msg || typeof msg !== "object") return false;

  const arrays = [
    msg.tickersSnapshot?.tickers,
    msg.marketsTickerSnapshot?.tickers,
    msg.marketTickersSnapshot?.tickers,
    msg.marketsTickerUpdate?.tickers
  ].filter(Array.isArray);

  for (const arr of arrays) {
    for (const ticker of arr) {
      if (updateTicker24h(ticker, "WS")) return true;
    }
  }

  const singles = [
    msg.tickerSnapshot?.ticker,
    msg.marketTickerSnapshot?.ticker,
    msg.tickerUpdate?.ticker,
    msg.marketTickerUpdate?.ticker,
    msg.marketsTickerUpdate?.ticker,
    msg.ticker
  ];

  for (const ticker of singles) {
    if (updateTicker24h(ticker, "WS")) return true;
  }

  return false;
}

async function refreshTicker24hRest(reason = "POLL") {
  try {
    const response = await fetch(TICKER_REST_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    const raw = payload?.data ?? payload;

    if (!updateTicker24h(raw, `REST_${reason}`)) {
      throw new Error("ticker payload missing valid high/low");
    }

    return true;
  } catch (error) {
    const now = Date.now();

    // No inundar la terminal si REST falla pero el WebSocket sigue bien.
    if (now - lastTickerRestErrorLogMs >= 5 * 60 * 1000) {
      lastTickerRestErrorLogMs = now;
      console.log("⚠️ 24H ticker REST fallback failed:", error.message);
    }

    return false;
  }
}

function tickerRangePosition24h(price = null) {
  if (!ticker24h) return null;

  const current = Number.isFinite(price) ? price : ticker24h.close;
  if (!Number.isFinite(current) || ticker24h.high <= ticker24h.low) return null;

  return (current - ticker24h.low) / (ticker24h.high - ticker24h.low);
}

function applyLevels(map, levels) {
  for (const level of levels || []) {
    const price = Number(level.price);
    const amount = Number(level.amount);

    if (!Number.isFinite(price)) continue;

    if (!Number.isFinite(amount) || amount <= 0) {
      map.delete(price);
    } else {
      map.set(price, amount);
    }
  }
}

function bestBid() {
  if (!bids.size) return null;
  return Math.max(...bids.keys());
}

function bestAsk() {
  if (!asks.size) return null;
  return Math.min(...asks.keys());
}

function bookAmountAt(map, price) {
  return map.get(price) ?? 0;
}

function marketSpreadObserved() {
  const bid = bestBid();
  const ask = bestAsk();

  if (!bid || !ask) return null;

  return (ask - bid) / ((ask + bid) / 2);
}

// ============================================================
// MARKET SELL SIMULATION
// ============================================================

function simulateMarketSell(pearlAmount) {
  let remaining = pearlAmount;
  let grossUSDT = 0;
  let filledPearl = 0;

  const levels = [...bids.entries()].sort((a, b) => b[0] - a[0]);

  for (const [price, amount] of levels) {
    if (remaining <= 0) break;

    const take = Math.min(remaining, amount);

    grossUSDT += take * price;
    filledPearl += take;
    remaining -= take;
  }

  if (remaining > 0.00000001 || filledPearl <= 0) {
    return null;
  }

  const avgPrice = grossUSDT / filledPearl;

  return {
    avgPrice,
    grossUSDT,
    netUSDT: grossUSDT * (1 - SELL_FEE)
  };
}

// ============================================================
// TRADE HISTORY
// ============================================================

const recentTrades = [];
const seenTrades = new Set();

function tradeKey(trade) {
  const id = trade?.id ?? trade?.tradeId ?? trade?.trade_id ?? null;
  if (id !== null && id !== undefined) return `id:${id}`;

  const createdAt = trade?.createdAt ?? trade?.inserted_at ?? trade?.insertedAt;
  const side = trade?.takerSide ?? trade?.taker_side ?? trade?.side;

  return [createdAt, trade?.price, trade?.amount, side].join("|");
}

function normalizeTrade(trade) {
  const createdAt = trade?.createdAt ?? trade?.inserted_at ?? trade?.insertedAt;
  const side = trade?.takerSide ?? trade?.taker_side ?? trade?.side;

  return {
    id: trade?.id ?? trade?.tradeId ?? trade?.trade_id ?? null,
    time: new Date(createdAt).getTime(),
    price: Number(trade?.price),
    amount: Number(trade?.amount),
    side
  };
}

function trimHistory(newestTime) {
  const keepWindow = Math.max(
    LOOKBACK_MS,
    FLOW_WINDOW_MS,
    STRUCTURE_WINDOW_MS
  );
  const cutoff = newestTime - keepWindow;

  while (recentTrades.length && recentTrades[0].time < cutoff) {
    recentTrades.shift();
  }
}

function addHistoricalTrade(rawTrade) {
  const key = tradeKey(rawTrade);
  if (seenTrades.has(key)) return;

  seenTrades.add(key);

  const trade = normalizeTrade(rawTrade);

  if (
    !Number.isFinite(trade.time) ||
    !Number.isFinite(trade.price) ||
    !Number.isFinite(trade.amount)
  ) {
    return;
  }

  recentTrades.push(trade);
  recentTrades.sort((a, b) => a.time - b.time);
  trimHistory(trade.time);

}

// ============================================================
// FLOW METRICS
// ============================================================

function flowMetrics(now = Date.now(), windowMs = FLOW_WINDOW_MS) {
  const cutoff = now - windowMs;

  let askNotional = 0;
  let bidNotional = 0;

  for (const trade of recentTrades) {
    if (trade.time < cutoff) continue;

    const notional = trade.price * trade.amount;

    if (trade.side === "ASK") {
      askNotional += notional;
    } else if (trade.side === "BID") {
      bidNotional += notional;
    }
  }

  const total = askNotional + bidNotional;

  return {
    askNotional,
    bidNotional,
    askShare: total > 0 ? askNotional / total : null,
    bidShare: total > 0 ? bidNotional / total : null
  };
}

function priceMomentum(now = Date.now(), windowMs = FAST_FLOW_WINDOW_MS) {
  const cutoff = now - windowMs;
  const trades = recentTrades.filter((trade) => trade.time >= cutoff);

  if (trades.length < 2) {
    return {
      first: null,
      last: null,
      move: null
    };
  }

  const first = trades[0].price;
  const last = trades[trades.length - 1].price;

  return {
    first,
    last,
    move: first > 0 ? last / first - 1 : null
  };
}

// ============================================================
// V5.1.8.3 — MARKET REFERENCE / SPARSE-TRADE FALLBACK
// ============================================================
// El EARLY_ARM no debe quedarse paralizado solo porque en los últimos 5 min
// haya menos de 10 ejecuciones. Para decidir dónde DEJAR una LIMIT podemos usar
// una referencia de mercado segura. IMPORTANTE: esto NUNCA genera fills; los
// fills siguen viniendo exclusivamente de trades nuevos observados después de
// colocar la orden.

function marketReferencePrice(now = Date.now()) {
  const latest = recentTrades.length ? recentTrades[recentTrades.length - 1] : null;

  // Preferimos un trade reciente real.
  if (
    latest &&
    Number.isFinite(latest.price) &&
    Number.isFinite(latest.time) &&
    now - latest.time <= 2 * 60 * 1000
  ) {
    return {
      price: latest.price,
      source: "RECENT_TRADE",
      ageMs: Math.max(0, now - latest.time)
    };
  }

  // El ticker close es el último precio reportado por BigONE y sirve como
  // referencia de armado si el stream de trades está temporalmente silencioso.
  if (ticker24h && Number.isFinite(ticker24h.close) && ticker24h.close > 0) {
    return {
      price: ticker24h.close,
      source: ticker24h.source ? `TICKER_${ticker24h.source}` : "TICKER",
      ageMs: null
    };
  }

  // Si existe un trade histórico más viejo, úsalo antes que inventar un precio.
  if (latest && Number.isFinite(latest.price) && latest.price > 0) {
    return {
      price: latest.price,
      source: "LAST_KNOWN_TRADE",
      ageMs: Number.isFinite(latest.time) ? Math.max(0, now - latest.time) : null
    };
  }

  // Último fallback: midpoint del libro. Solo contexto de armado, nunca fill.
  const bid = bestBid();
  const ask = bestAsk();
  if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
    return {
      price: (bid + ask) / 2,
      source: "ORDER_BOOK_MID",
      ageMs: null
    };
  }

  return null;
}

function earlyArmMetric(now = Date.now()) {
  const strict = metrics();
  if (strict) {
    return {
      ...strict,
      sampleCount: recentTrades.filter((t) => t.time >= now - LOOKBACK_MS).length,
      synthetic: false,
      currentSource: "TRADE_WINDOW"
    };
  }

  const ref = marketReferencePrice(now);
  if (!ref || !Number.isFinite(ref.price) || ref.price <= 0) return null;

  const trades = recentTrades.filter((trade) => trade.time >= now - LOOKBACK_MS);
  const prices = trades.map((trade) => trade.price).filter(Number.isFinite);
  prices.push(ref.price);

  const current = ref.price;
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  const range = high - low;
  const rangePct = low > 0 ? range / low : 0;
  const drawdown = high > 0 ? (high - current) / high : 0;
  const rangePosition = range > 0 ? (current - low) / range : 0.5;

  let lowAgeMs = null;
  if (trades.length) {
    let lowTrade = trades[0];
    for (const trade of trades) {
      if (trade.price <= lowTrade.price) lowTrade = trade;
    }
    lowAgeMs = Math.max(0, now - lowTrade.time);
  }

  return {
    current,
    high,
    low,
    rangePct,
    drawdown,
    rangePosition,
    lowAgeMs,
    sampleCount: trades.length,
    synthetic: true,
    currentSource: ref.source
  };
}

// ============================================================
// PRICE METRICS
// ============================================================

function metrics() {
  const now = Date.now();

  const trades = recentTrades.filter(
    (trade) => trade.time >= now - LOOKBACK_MS
  );

  if (trades.length < 10) return null;

  const prices = trades.map((trade) => trade.price);
  const current = prices[prices.length - 1];
  const high = Math.max(...prices);
  const low = Math.min(...prices);

  const range = high - low;
  const rangePct = low > 0 ? range / low : 0;
  const drawdown = high > 0 ? (high - current) / high : 0;
  const rangePosition = range > 0 ? (current - low) / range : 1;

  let lowTrade = trades[0];

  for (const trade of trades) {
    if (trade.price <= lowTrade.price) {
      lowTrade = trade;
    }
  }

  return {
    current,
    high,
    low,
    rangePct,
    drawdown,
    rangePosition,
    lowAgeMs: now - lowTrade.time
  };
}

// ============================================================
// V5.1.8.3 — MULTI-WINDOW MARKET STATE (10m / 5m / 30s)
// ============================================================

function tradeWindowStats(windowMs, endOffsetMs = 0, now = Date.now()) {
  const end = now - endOffsetMs;
  const start = end - windowMs;
  const trades = recentTrades.filter((t) => t.time >= start && t.time <= end);

  if (trades.length < 2) {
    return {
      ready: false,
      samples: trades.length,
      first: null,
      last: null,
      low: null,
      high: null,
      move: null,
      rangePct: null,
      position: null
    };
  }

  const prices = trades.map((t) => t.price).filter(Number.isFinite);
  if (prices.length < 2) return { ready: false, samples: prices.length };

  const first = prices[0];
  const last = prices[prices.length - 1];
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const range = high - low;

  return {
    ready: true,
    samples: prices.length,
    first,
    last,
    low,
    high,
    move: first > 0 ? last / first - 1 : null,
    rangePct: low > 0 ? range / low : null,
    position: range > 0 ? (last - low) / range : 0.5
  };
}

function highRangeCautionContext(metric = null) {
  const m = metric ?? earlyArmMetric();
  const current = m?.current ?? marketReferencePrice()?.price ?? null;
  const range24 = tickerRangePosition24h(current);
  const w10 = tradeWindowStats(10 * 60 * 1000);
  const w5 = tradeWindowStats(5 * 60 * 1000);
  const prev5 = tradeWindowStats(5 * 60 * 1000, 5 * 60 * 1000);
  const structure60 = supportContext60m(current);
  const flow5 = flowMetrics(Date.now(), 5 * 60 * 1000);
  const mom30 = priceMomentum(Date.now(), 30 * 1000);

  const highRange = Number.isFinite(range24) && range24 >= HIGH_RANGE_CAUTION_MIN_24H_POSITION;
  const runFromLow10m = w10.ready && Number.isFinite(w10.low) && Number.isFinite(current)
    ? current / w10.low - 1
    : null;
  const runFromLow60m = Number.isFinite(structure60?.low60m) && Number.isFinite(current)
    ? current / structure60.low60m - 1
    : null;
  const strongRun =
    (runFromLow10m !== null && runFromLow10m >= HIGH_RANGE_CAUTION_STRONG_RUN_10M) ||
    (runFromLow60m !== null && runFromLow60m >= HIGH_RANGE_CAUTION_STRONG_RUN_60M);

  const pullback = w5.ready && Number.isFinite(w5.high) && Number.isFinite(current)
    ? w5.high / current - 1 >= HIGH_RANGE_CAUTION_PULLBACK_5M
    : false;

  const lowerHigh = w5.ready && prev5.ready && Number.isFinite(w5.high) && Number.isFinite(prev5.high)
    ? w5.high <= prev5.high * (1 - HIGH_RANGE_CAUTION_LOWER_HIGH_PCT)
    : false;

  const sellPressure = flow5.askShare !== null && flow5.askShare >= HIGH_RANGE_CAUTION_ASK_SHARE;
  const microDrop = mom30.move !== null && mom30.move <= -HIGH_RANGE_CAUTION_MICRO_DROP;
  const exhaustionVotes = [pullback, lowerHigh, sellPressure, microDrop].filter(Boolean).length;
  // V5.1.8.3: 24h high-range ya NO es requisito. Una subida fuerte con 2 señales
  // de agotamiento activa cautela aunque esté, por ejemplo, en 70–80% del rango.
  // Si además está >=85%, una sola señal de agotamiento basta como precaución.
  const active = strongRun && (
    exhaustionVotes >= HIGH_RANGE_CAUTION_MIN_EXHAUSTION_VOTES ||
    (highRange && exhaustionVotes >= 1)
  );

  return {
    active,
    rangePosition24h: range24,
    highRange,
    strongRun,
    exhaustionVotes,
    pullback,
    lowerHigh,
    sellPressure,
    microDrop,
    runFromLow10m,
    runFromLow60m,
    pullbackFromHigh5m: w5.ready && Number.isFinite(w5.high) && Number.isFinite(current)
      ? current / w5.high - 1
      : null,
    askShare5m: flow5.askShare,
    momentum30s: mom30.move,
    currentHigh5m: w5.high ?? null,
    previousHigh5m: prev5.high ?? null
  };
}

function liveTradeWindowStats(windowMs, now = Date.now()) {
  const start = now - windowMs;
  const trades = liveTradesSinceProcessStart.filter((t) => t.observedAtMs >= start && t.observedAtMs <= now);
  if (trades.length < 2) {
    return { ready: false, samples: trades.length, first: null, last: null, low: null, high: null, move: null, rangePct: null };
  }
  const prices = trades.map((t) => t.price).filter(Number.isFinite);
  if (prices.length < 2) return { ready: false, samples: prices.length };
  const first = prices[0];
  const last = prices[prices.length - 1];
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  let lowTrade = null;
  for (const trade of trades) {
    if (!Number.isFinite(trade.price)) continue;
    if (!lowTrade || trade.price <= lowTrade.price) lowTrade = trade;
  }
  return {
    ready: true,
    samples: prices.length,
    first,
    last,
    low,
    high,
    move: first > 0 ? last / first - 1 : null,
    rangePct: low > 0 ? (high - low) / low : null,
    lowObservedAtMs: Number.isFinite(lowTrade?.observedAtMs) ? lowTrade.observedAtMs : null,
    lowAgeMs: Number.isFinite(lowTrade?.observedAtMs) ? Math.max(0, now - lowTrade.observedAtMs) : null
  };
}

function entryStabilityContext(referencePrice = null) {
  const now = Date.now();
  const current = Number.isFinite(referencePrice)
    ? referencePrice
    : (marketReferencePrice()?.price ?? null);
  const w15 = liveTradeWindowStats(ENTRY_STABILITY_WINDOW_MS, now);
  const w10 = liveTradeWindowStats(10 * 60 * 1000, now);
  const w5 = liveTradeWindowStats(5 * 60 * 1000, now);
  const mom30 = priceMomentum(now, 30 * 1000);
  const flow5 = flowMetrics(now, 5 * 60 * 1000);

  const dropFromHigh15m = w15.ready && Number.isFinite(current) && Number.isFinite(w15.high) && current > 0
    ? w15.high / current - 1
    : null;

  const required = Boolean(
    (dropFromHigh15m !== null && dropFromHigh15m >= ENTRY_STABILITY_DROP_FROM_HIGH_15M) ||
    (w10.ready && w10.move !== null && w10.move <= -ENTRY_STABILITY_DROP_10M) ||
    (w5.ready && w5.move !== null && w5.move <= -ENTRY_STABILITY_DROP_5M)
  );

  // Preferimos el low de 10m para no declarar estabilidad por un rebote muy corto.
  const lowAgeMs = Number.isFinite(w10.lowAgeMs)
    ? w10.lowAgeMs
    : (Number.isFinite(w5.lowAgeMs) ? w5.lowAgeMs : null);

  const noNewLowLongEnough = !required ||
    (Number.isFinite(lowAgeMs) && lowAgeMs >= ENTRY_STABILITY_MIN_LOW_AGE_MS);
  const tenMinuteNotFalling = !required ||
    (w10.ready && w10.move !== null && w10.move >= -ENTRY_STABILITY_MAX_DROP_10M);
  const fiveMinuteNotFalling = !required ||
    (w5.ready && w5.move !== null && w5.move >= -ENTRY_STABILITY_MAX_DROP_5M);
  const microNotFalling = !required ||
    mom30.move === null || mom30.move >= -ENTRY_STABILITY_MAX_DROP_30S;
  const sellPressureContained = !required ||
    flow5.askShare === null || flow5.askShare <= ENTRY_STABILITY_MAX_ASK_SHARE_5M;
  const bounceFromLow5m = w5.ready && Number.isFinite(current) && Number.isFinite(w5.low) && w5.low > 0
    ? current / w5.low - 1
    : null;
  const bounceOrTight = !required || Boolean(
    (bounceFromLow5m !== null && bounceFromLow5m >= ENTRY_STABILITY_MIN_BOUNCE_FROM_LOW_5M) ||
    (w5.ready && w5.rangePct !== null && w5.rangePct <= ENTRY_STABILITY_TIGHT_RANGE_5M)
  );

  const conditions = {
    noNewLowLongEnough,
    tenMinuteNotFalling,
    fiveMinuteNotFalling,
    microNotFalling,
    sellPressureContained,
    bounceOrTight
  };

  const stableEnough = !required || Object.values(conditions).every(Boolean);
  return {
    ok: stableEnough,
    required,
    stableEnough,
    conditions,
    failedConditions: required ? failedConditionNames(conditions) : [],
    current,
    dropFromHigh15m,
    move10m: w10.move ?? null,
    move5m: w5.move ?? null,
    momentum30s: mom30.move ?? null,
    askShare5m: flow5.askShare,
    bounceFromLow5m,
    lowAgeMs,
    minutesSinceLow: Number.isFinite(lowAgeMs) ? lowAgeMs / 60000 : null,
    low5m: w5.low ?? null,
    low10m: w10.low ?? null,
    high15m: w15.high ?? null
  };
}

function preEntryFallingContext(referencePrice = null) {
  const now = Date.now();
  const current = Number.isFinite(referencePrice)
    ? referencePrice
    : (marketReferencePrice()?.price ?? null);
  const w4 = liveTradeWindowStats(4 * 60 * 1000, now);
  const w5 = liveTradeWindowStats(5 * 60 * 1000, now);
  const w10 = liveTradeWindowStats(10 * 60 * 1000, now);
  const w15 = liveTradeWindowStats(15 * 60 * 1000, now);
  const flow5 = flowMetrics(now, 5 * 60 * 1000);
  const mom30 = priceMomentum(now, 30 * 1000);

  const dropFromHigh15m = Boolean(
    w15.ready && Number.isFinite(current) && Number.isFinite(w15.high) && current > 0
  )
    ? w15.high / current - 1
    : null;

  const softDirectionalDrop = Boolean(
    (w4.ready && w4.move !== null && w4.move <= -SOFT_FALLING_MOVE_4M) ||
    (w5.ready && w5.move !== null && w5.move <= -SOFT_FALLING_MOVE_5M) ||
    (w10.ready && w10.move !== null && w10.move <= -SOFT_FALLING_MOVE_10M)
  );

  const nearLow10m = Boolean(
    w10.ready && Number.isFinite(current) && Number.isFinite(w10.low) &&
    current / w10.low - 1 <= HARD_SLOW_BLEED_NEAR_LOW_PCT
  );
  const recentMeaningfulLow = Boolean(
    Number.isFinite(w10.lowAgeMs) &&
    w10.lowAgeMs <= HARD_SLOW_BLEED_RECENT_LOW_MS &&
    nearLow10m
  );

  const hardShock = Boolean(
    (w5.ready && w5.move !== null && w5.move <= -HARD_FALLING_MOVE_5M) ||
    (w10.ready && w10.move !== null && w10.move <= -HARD_FALLING_MOVE_10M) ||
    (dropFromHigh15m !== null && dropFromHigh15m >= HARD_FALLING_DROP_FROM_HIGH_15M) ||
    (
      mom30.move !== null &&
      mom30.move <= -HARD_FALLING_MOMENTUM_30S &&
      w5.ready &&
      w5.move !== null &&
      w5.move <= -HARD_FALLING_MOMENTUM_CONFIRM_MOVE_5M
    )
  );

  const hardSlowBleed = Boolean(
    w5.ready && w5.move !== null && w5.move <= -HARD_SLOW_BLEED_MOVE_5M &&
    w10.ready && w10.move !== null && w10.move <= -HARD_SLOW_BLEED_MOVE_10M &&
    recentMeaningfulLow
  );

  const hardLock = hardShock || hardSlowBleed;
  const softCaution = !hardLock && softDirectionalDrop;

  const pulledFromHigh = Boolean(
    w5.ready && Number.isFinite(current) && Number.isFinite(w5.high) &&
    w5.high / current - 1 >= PREENTRY_FALLING_PULLBACK_FROM_HIGH_5M
  );
  const sellPressure = flow5.askShare !== null && flow5.askShare >= PREENTRY_FALLING_ASK_SHARE;
  const microDrop = mom30.move !== null && mom30.move <= -PREENTRY_FALLING_MICRO_DROP;
  const nearLow = Boolean(
    w5.ready && Number.isFinite(current) && Number.isFinite(w5.low) &&
    current / w5.low - 1 <= PREENTRY_FALLING_NEAR_LOW_PCT
  );
  const confirmingVotes = [pulledFromHigh, sellPressure, microDrop, nearLow].filter(Boolean).length;

  const regime = hardLock
    ? "HARD_FALLING_LOCK"
    : softCaution
      ? "SOFT_FALLING_CAUTION"
      : "NORMAL_SCALP";

  return {
    // Compatibilidad: active ahora significa que existe un HARD lock pre-entry.
    active: hardLock,
    regime,
    hardLock,
    hardShock,
    hardSlowBleed,
    softCaution,
    softDirectionalDrop,
    current,
    directionalDrop: softDirectionalDrop || hardLock,
    confirmingVotes,
    pulledFromHigh,
    sellPressure,
    microDrop,
    nearLow,
    recentMeaningfulLow,
    nearLow10m,
    dropFromHigh15m,
    move4m: w4.move ?? null,
    move5m: w5.move ?? null,
    move10m: w10.move ?? null,
    momentum30s: mom30.move ?? null,
    lowAge10mMs: w10.lowAgeMs ?? null,
    minutesSinceLow10m: Number.isFinite(w10.lowAgeMs) ? w10.lowAgeMs / 60000 : null,
    liveSamples4m: w4.samples ?? 0,
    liveSamples5m: w5.samples ?? 0,
    liveSamples10m: w10.samples ?? 0,
    askShare5m: flow5.askShare
  };
}

function startupContextStatus(referencePrice = null) {
  const now = Date.now();
  const elapsedMs = now - PROCESS_STARTED_AT_MS;
  const liveTrades = liveTradesSinceProcessStart.length;
  const timeReady = elapsedMs >= STARTUP_CONTEXT_LOCK_MS;
  const samplesReady = liveTrades >= STARTUP_CONTEXT_MIN_LIVE_TRADES;
  const falling = preEntryFallingContext(referencePrice);
  const entryStability = entryStabilityContext(referencePrice);

  return {
    locked: !(timeReady && samplesReady),
    ready: timeReady && samplesReady,
    elapsedSeconds: elapsedMs / 1000,
    remainingSeconds: Math.max(0, STARTUP_CONTEXT_LOCK_MS - elapsedMs) / 1000,
    liveTrades,
    minimumLiveTrades: STARTUP_CONTEXT_MIN_LIVE_TRADES,
    timeReady,
    samplesReady,
    falling,
    entryStability
  };
}

function maybeActivatePreEntryFallingLock(referencePrice = null) {
  if (activeFallingMarketLock()) return false;
  const startup = startupContextStatus(referencePrice);
  if (!startup.ready) return false;
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) return false;

  // V5.1.8.3: SOLO el régimen HARD crea un lock real.
  // SOFT_FALLING_CAUTION continúa operando con sizing reducido.
  if (!startup.falling?.hardLock) return false;

  activateFallingMarketLock({
    recoveryId: null,
    triggerPrice: referencePrice,
    brokenSupport: null,
    triggerReason: startup.falling?.hardSlowBleed
      ? "PREENTRY_HARD_SLOW_BLEED"
      : "PREENTRY_HARD_FALLING_MARKET"
  });
  return true;
}

function priceLadderEntryContext(buyPrice = null) {
  const high24h = Number(ticker24h?.high);
  const price = Number(buyPrice);
  const stepTicks = Math.round(PRICE_LADDER_STEP / TICK);

  if (!Number.isFinite(high24h) || high24h <= 0 || !Number.isFinite(price) || price <= 0) {
    return {
      ready: false,
      ok: false,
      high24h: Number.isFinite(high24h) ? high24h : null,
      currentHighBandStart: null,
      maxBuyExclusive: null,
      nextUnlockResistance: null,
      buyBandStart: null,
      reason: "TICKER_24H_OR_BUY_UNAVAILABLE"
    };
  }

  // Un simple toque al escalón no desbloquea la banda siguiente.
  // 1.9000 => sigue bloqueada 1.8x; 1.9001 => 1.8x queda habilitada.
  const highTicks = Math.floor(high24h / TICK + 1e-6);
  const confirmedTicks = Math.max(0, highTicks - PRICE_LADDER_BREAK_CONFIRM_TICKS);
  const unlockedBandIndex = Math.floor(confirmedTicks / stepTicks);
  const maxBuyExclusive = Number((unlockedBandIndex * PRICE_LADDER_STEP).toFixed(4));
  const currentHighBandStart = Number((Math.floor(high24h / PRICE_LADDER_STEP + 1e-9) * PRICE_LADDER_STEP).toFixed(4));
  const nextUnlockResistance = Number((maxBuyExclusive + PRICE_LADDER_STEP).toFixed(4));
  const buyBandStart = Number((Math.floor(price / PRICE_LADDER_STEP + 1e-9) * PRICE_LADDER_STEP).toFixed(4));
  const ok = price < maxBuyExclusive - PRICE_EPSILON;

  return {
    ready: true,
    ok,
    high24h,
    currentHighBandStart,
    maxBuyExclusive,
    nextUnlockResistance,
    buyBandStart,
    reason: ok ? null : "BUY_IN_SAME_OR_HIGHER_0_10_BAND_AS_24H_HIGH"
  };
}

function rangePositionEntryContext(referencePrice = null) {
  const price = Number(referencePrice);
  const rangePosition24h = Number.isFinite(price) ? tickerRangePosition24h(price) : null;

  if (!Number.isFinite(rangePosition24h)) {
    return { ready: false, ok: false, rangePosition24h: null, mode: "RANGE_CONTEXT_UNAVAILABLE", fraction: 0, reason: "TICKER_24H_RANGE_UNAVAILABLE" };
  }

  if (rangePosition24h > RANGE_CAUTION_MAX_24H_POSITION) {
    return { ready: true, ok: false, rangePosition24h, mode: "TOP_RANGE_BLOCKED", fraction: 0, reason: "RANGE_POSITION_ABOVE_82PCT" };
  }

  if (rangePosition24h > RANGE_FULL_CAPITAL_MAX_24H_POSITION) {
    return { ready: true, ok: true, rangePosition24h, mode: "UPPER_RANGE_CAUTION", fraction: RANGE_CAUTION_CAPITAL_FRACTION, reason: null };
  }

  return { ready: true, ok: true, rangePosition24h, mode: "NORMAL_SCALP", fraction: 1.0, reason: null };
}

function entryZoneContext(buyPrice = null, metric = null) {
  const ladder = priceLadderEntryContext(buyPrice);
  const range = rangePositionEntryContext(buyPrice);
  const exhaustion = highRangeCautionContext(metric);
  return { ok: Boolean(ladder.ok && range.ok), ladder, range, exhaustion };
}

function scalpAllocation(signal = null) {
  const available = Math.max(0, Number(state.cash) || 0);
  const zone = entryZoneContext(signal?.buyPrice ?? null, signal?.metric ?? null);
  const falling = preEntryFallingContext(signal?.metric?.current ?? null);

  // El tier de rango manda. Exhaustion y SOFT falling solo pueden REDUCIR.
  let fraction = zone.range.ok ? zone.range.fraction : 0;
  if (zone.exhaustion.active && fraction > 0) {
    fraction = Math.min(fraction, HIGH_RANGE_CAUTION_CAPITAL_FRACTION);
  }
  if (falling.softCaution && fraction > 0) {
    fraction = Math.min(fraction, SOFT_FALLING_CAPITAL_FRACTION);
  }

  let mode = zone.range.mode;
  if (zone.exhaustion.active && mode === "NORMAL_SCALP") mode = "EXHAUSTION_CAUTION";
  if (falling.softCaution && fraction > 0) mode = "SOFT_FALLING_CAUTION";
  if (!zone.ladder.ok) mode = "PRICE_LADDER_BLOCKED";
  if (!zone.range.ok) mode = zone.range.mode;

  // V5.1.8.3: misma lógica de régimen, con un cap por posición para que
  // el cash restante pueda seguir operando en oportunidades separadas.
  const regimeCapital = available * fraction;
  const slotCap = Math.max(0, scalpCostBasis() * MULTI_POSITION_MAX_CAPITAL_FRACTION);
  const capital = Math.min(available, regimeCapital, slotCap);

  return {
    mode,
    fraction,
    capital,
    slotCap,
    reserveAfterFill: Math.max(0, available - capital),
    caution: zone.exhaustion,
    falling,
    zone
  };
}

function activeFallingMarketLock() {
  return state.fallingMarketLock?.status === "ACTIVE" ? state.fallingMarketLock : null;
}

function activateFallingMarketLock({ recoveryId, triggerPrice, brokenSupport, triggerReason = "RECOVERY_SUPPORT_BREAK" }) {
  const now = Date.now();
  const existing = activeFallingMarketLock();

  if (existing) {
    existing.recoveryIds = Array.from(new Set([...(existing.recoveryIds || []), recoveryId].filter(Boolean)));
    if (Number.isFinite(triggerPrice) && (!Number.isFinite(existing.lowSinceLock) || triggerPrice < existing.lowSinceLock)) {
      existing.lowSinceLock = triggerPrice;
      existing.lastMeaningfulNewLowAtMs = now;
    }
    saveState();
    return existing;
  }

  const lock = {
    id: `fall-lock-${now}-${state.fallingMarketLocksCreated + 1}`,
    status: "ACTIVE",
    createdAt: iso(now),
    createdAtMs: now,
    recoveryIds: recoveryId ? [recoveryId] : [],
    triggerPrice: Number.isFinite(triggerPrice) ? triggerPrice : null,
    brokenSupport: Number.isFinite(brokenSupport) ? brokenSupport : null,
    triggerReason,
    lowSinceLock: Number.isFinite(triggerPrice) ? triggerPrice : null,
    lastMeaningfulLowPrice: Number.isFinite(triggerPrice) ? triggerPrice : null,
    low24AtLock: Number.isFinite(ticker24h?.low) ? ticker24h.low : null,
    lowest24hObserved: Number.isFinite(ticker24h?.low) ? ticker24h.low : null,
    lastMeaningful24hLow: Number.isFinite(ticker24h?.low) ? ticker24h.low : null,
    lastMeaningfulNewLowAtMs: now,
    releasedAt: null,
    releaseReason: null,
    releaseContext: null
  };

  state.fallingMarketLock = lock;
  state.fallingMarketLocksCreated++;

  logEvent("🏙️ FALLING MARKET LOCK ACTIVATED", {
    lockId: lock.id,
    recoveryId,
    triggerPrice: num(triggerPrice, 4),
    brokenSupport: num(brokenSupport, 4),
    triggerReason,
    scalpCashReserved: num(state.cash),
    action: "NO_NEW_BUYS_UNTIL_STABLE_ENOUGH"
  });

  saveState();
  return lock;
}

function fallingMarketStabilityContext(referencePrice = null) {
  const lock = activeFallingMarketLock();
  if (!lock) return { active: false, stableEnough: true, failedConditions: [] };

  const now = Date.now();
  const current = Number.isFinite(referencePrice)
    ? referencePrice
    : (marketReferencePrice()?.price ?? null);

  const w10 = tradeWindowStats(10 * 60 * 1000);
  const w5 = tradeWindowStats(5 * 60 * 1000);
  const mom30 = priceMomentum(now, 30 * 1000);
  const flow5 = flowMetrics(now, 5 * 60 * 1000);
  const isPreEntryHardLock = String(lock.triggerReason || "").startsWith("PREENTRY_");

  const minAgeMs = isPreEntryHardLock ? PREENTRY_HARD_LOCK_MIN_MS : FALLING_LOCK_MIN_MS;
  const noNewLowMs = isPreEntryHardLock ? PREENTRY_HARD_LOCK_NO_NEW_LOW_MS : FALLING_LOCK_NO_NEW_LOW_MS;

  const minLockAgeOK = now - lock.createdAtMs >= minAgeMs;
  const noNewLowLongEnough =
    now - Number(lock.lastMeaningfulNewLowAtMs || lock.createdAtMs) >= noNewLowMs;

  const bounceFromLow5m = w5.ready && Number.isFinite(current) && Number.isFinite(w5.low)
    ? current / w5.low - 1
    : null;

  let conditions;
  let entryStability = entryStabilityContext(current);

  if (isPreEntryHardLock) {
    // V5.1.8.3: no retenemos el capital 5 minutos extra cuando el shock ya murió.
    const fiveMinuteNotFalling =
      w5.ready && w5.move !== null && w5.move >= -PREENTRY_HARD_RELEASE_MAX_DROP_5M;
    const microNotFalling =
      mom30.move === null || mom30.move >= -PREENTRY_HARD_RELEASE_MAX_DROP_30S;
    const bounceOrRising = Boolean(
      (bounceFromLow5m !== null && bounceFromLow5m >= PREENTRY_HARD_RELEASE_MIN_BOUNCE_5M) ||
      (w5.ready && w5.move !== null && w5.move >= 0)
    );

    conditions = {
      minLockAgeOK,
      noNewLowLongEnough,
      fiveMinuteNotFalling,
      microNotFalling,
      bounceOrRising
    };
  } else {
    // RECOVERY conserva la salida conservadora previa.
    const tenMinuteNotFalling = w10.ready && w10.move !== null && w10.move >= -STABILITY_MAX_DROP_10M;
    const fiveMinuteNotFalling = w5.ready && w5.move !== null && w5.move >= -STABILITY_MAX_DROP_5M;
    const microNotFalling = mom30.move === null || mom30.move >= -STABILITY_MAX_DROP_30S;
    const sellPressureContained = flow5.askShare === null || flow5.askShare <= STABILITY_MAX_ASK_SHARE_5M;
    const bounceOrTight = w5.ready && Number.isFinite(current) && Number.isFinite(w5.low)
      ? (current / w5.low - 1 >= STABILITY_BOUNCE_FROM_LOW_5M) ||
        (w5.rangePct !== null && w5.rangePct <= STABILITY_TIGHT_RANGE_5M)
      : false;
    const entryStabilityOK = entryStability.ok;

    conditions = {
      minLockAgeOK,
      noNewLowLongEnough,
      tenMinuteNotFalling,
      fiveMinuteNotFalling,
      microNotFalling,
      sellPressureContained,
      bounceOrTight,
      entryStabilityOK
    };
  }

  return {
    active: true,
    lockType: isPreEntryHardLock ? "PREENTRY_HARD" : "RECOVERY",
    stableEnough: Object.values(conditions).every(Boolean),
    conditions,
    failedConditions: failedConditionNames(conditions),
    lockAgeMinutes: (now - lock.createdAtMs) / 60000,
    minutesSinceMeaningfulNewLow:
      (now - Number(lock.lastMeaningfulNewLowAtMs || lock.createdAtMs)) / 60000,
    lowSinceLock: lock.lowSinceLock ?? null,
    low24AtLock: lock.low24AtLock ?? null,
    lowest24hObserved: lock.lowest24hObserved ?? null,
    current,
    low24h: ticker24h?.low ?? null,
    high24h: ticker24h?.high ?? null,
    move10m: w10.move ?? null,
    move5m: w5.move ?? null,
    momentum30s: mom30.move ?? null,
    askShare5m: flow5.askShare,
    low5m: w5.low ?? null,
    range5m: w5.rangePct ?? null,
    bounceFromLow5m,
    entryStability
  };
}

function updateFallingMarketLock(referencePrice) {
  const lock = activeFallingMarketLock();
  if (!lock || !Number.isFinite(referencePrice) || referencePrice <= 0) return false;

  const now = Date.now();
  let changed = false;

  const liveLow24 = Number(ticker24h?.low);
  if (Number.isFinite(liveLow24)) {
    if (!Number.isFinite(lock.lowest24hObserved)) {
      lock.lowest24hObserved = liveLow24;
      lock.lastMeaningful24hLow = liveLow24;
      changed = true;
    } else if (liveLow24 < lock.lowest24hObserved) {
      lock.lowest24hObserved = liveLow24;
      changed = true;

      const meaningful24hAnchor = Number(lock.lastMeaningful24hLow);
      if (
        !Number.isFinite(meaningful24hAnchor) ||
        meaningful24hAnchor / liveLow24 - 1 >= FALLING_LOCK_MEANINGFUL_NEW_LOW_PCT
      ) {
        lock.lastMeaningful24hLow = liveLow24;
        lock.lastMeaningfulNewLowAtMs = now;
      }
    }
  }

  if (!Number.isFinite(lock.lowSinceLock)) {
    lock.lowSinceLock = referencePrice;
    lock.lastMeaningfulLowPrice = referencePrice;
    lock.lastMeaningfulNewLowAtMs = now;
    changed = true;
  } else if (referencePrice < lock.lowSinceLock) {
    lock.lowSinceLock = referencePrice;
    changed = true;

    const meaningfulAnchor = Number(lock.lastMeaningfulLowPrice);
    if (
      !Number.isFinite(meaningfulAnchor) ||
      meaningfulAnchor / referencePrice - 1 >= FALLING_LOCK_MEANINGFUL_NEW_LOW_PCT
    ) {
      lock.lastMeaningfulLowPrice = referencePrice;
      lock.lastMeaningfulNewLowAtMs = now;
    }
  }

  const stability = fallingMarketStabilityContext(referencePrice);
  if (stability.stableEnough) {
    lock.status = "RELEASED";
    lock.releasedAt = iso(now);
    lock.releaseReason = "STABLE_ENOUGH_10M_5M_30S";
    lock.releaseContext = stability;
    state.fallingMarketLocksReleased++;
    changed = true;

    logEvent("🌱 FALLING MARKET LOCK RELEASED — STABLE ENOUGH", {
      lockId: lock.id,
      lowSinceLock: num(lock.lowSinceLock, 4),
      currentPrice: num(referencePrice, 4),
      low24h: num(ticker24h?.low, 4),
      move10m: pct(stability.move10m),
      move5m: pct(stability.move5m),
      momentum30s: pct(stability.momentum30s),
      askShare5m: pct(stability.askShare5m),
      bounceFromLow5m: pct(stability.bounceFromLow5m),
      action: "SCALPING_REENABLED"
    });
  }

  if (changed) saveState();
  return changed;
}

function fallingMarketEntryGate(referencePrice = null) {
  const lock = activeFallingMarketLock();
  const entryStability = entryStabilityContext(referencePrice);
  const preEntry = preEntryFallingContext(referencePrice);

  if (!lock) {
    return {
      ok: true,
      lockId: null,
      stability: null,
      entryStability,
      preEntry,
      softCaution: preEntry.softCaution,
      hardLock: false
    };
  }

  const stability = fallingMarketStabilityContext(referencePrice);
  return {
    ok: false,
    lockId: lock.id,
    stability,
    entryStability,
    preEntry,
    softCaution: false,
    hardLock: true
  };
}

// ============================================================
// V4.8 — ESTRUCTURA 60 MIN / SOPORTE Y RESISTENCIA
// ============================================================

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function structureMinuteCandles(now = Date.now()) {
  const cutoff = now - STRUCTURE_WINDOW_MS;
  const currentBucket =
    Math.floor(now / STRUCTURE_BUCKET_MS) * STRUCTURE_BUCKET_MS;

  const buckets = new Map();

  for (const trade of recentTrades) {
    // Excluimos la vela actual incompleta.
    if (trade.time < cutoff || trade.time >= currentBucket) continue;

    const bucketStart =
      Math.floor(trade.time / STRUCTURE_BUCKET_MS) * STRUCTURE_BUCKET_MS;

    let candle = buckets.get(bucketStart);

    if (!candle) {
      candle = {
        time: bucketStart,
        open: trade.price,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        trades: 0,
        volume: 0
      };
      buckets.set(bucketStart, candle);
    }

    candle.high = Math.max(candle.high, trade.price);
    candle.low = Math.min(candle.low, trade.price);
    candle.close = trade.price;
    candle.trades++;
    candle.volume += trade.amount;
  }

  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

function detectStructurePivots(candles) {
  const highs = [];
  const lows = [];
  const radius = STRUCTURE_PIVOT_RADIUS;

  for (let i = radius; i < candles.length - radius; i++) {
    const candle = candles[i];
    const neighbors = [];

    for (let j = i - radius; j <= i + radius; j++) {
      if (j !== i) neighbors.push(candles[j]);
    }

    const highPivot =
      neighbors.every((x) => candle.high >= x.high) &&
      neighbors.some((x) => candle.high > x.high);

    const lowPivot =
      neighbors.every((x) => candle.low <= x.low) &&
      neighbors.some((x) => candle.low < x.low);

    if (highPivot) {
      highs.push({ price: candle.high, time: candle.time, type: "HIGH" });
    }

    if (lowPivot) {
      lows.push({ price: candle.low, time: candle.time, type: "LOW" });
    }
  }

  return { highs, lows };
}

function clusterStructurePivots(pivots, toleranceAbs) {
  if (!pivots.length) return [];

  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const clusters = [];

  for (const pivot of sorted) {
    let best = null;
    let bestDistance = Infinity;

    for (const cluster of clusters) {
      const distance = Math.abs(pivot.price - cluster.price);

      if (distance <= toleranceAbs && distance < bestDistance) {
        best = cluster;
        bestDistance = distance;
      }
    }

    if (!best) {
      clusters.push({
        price: pivot.price,
        sumPrice: pivot.price,
        touches: 1,
        firstTime: pivot.time,
        lastTime: pivot.time
      });
      continue;
    }

    best.sumPrice += pivot.price;
    best.touches++;
    best.price = best.sumPrice / best.touches;
    best.firstTime = Math.min(best.firstTime, pivot.time);
    best.lastTime = Math.max(best.lastTime, pivot.time);
  }

  return clusters
    .map((cluster) => ({
      ...cluster,
      lower: cluster.price - toleranceAbs,
      upper: cluster.price + toleranceAbs
    }))
    .sort((a, b) => a.price - b.price);
}

function resistanceSafetyBufferPct() {
  const spread = marketSpreadObserved();

  if (!Number.isFinite(spread)) {
    return RESISTANCE_BUFFER_MIN_PCT;
  }

  return clamp(
    spread * RESISTANCE_BUFFER_SPREAD_FACTOR,
    RESISTANCE_BUFFER_MIN_PCT,
    RESISTANCE_BUFFER_MAX_PCT
  );
}

function structure60m(referencePrice = null) {
  const now = Date.now();
  const candles = structureMinuteCandles(now);

  const windowTrades = recentTrades
    .filter((trade) => trade.time >= now - STRUCTURE_WINDOW_MS)
    .filter((trade) => Number.isFinite(trade.price));

  const prices = windowTrades.map((trade) => trade.price);

  // V4.8: la estructura se compara contra el MERCADO REAL ACTUAL,
  // no contra una BUY candidata que podría estar varios ticks debajo.
  // Esto evita que una resistencia vieja siga bloqueando después de un breakout.
  const liveCurrent = prices.length
    ? prices[prices.length - 1]
    : null;

  const current =
    Number.isFinite(liveCurrent) && liveCurrent > 0
      ? liveCurrent
      : Number.isFinite(referencePrice) && referencePrice > 0
        ? referencePrice
        : null;

  if (
    !current ||
    candles.length < STRUCTURE_MIN_BUCKETS ||
    prices.length < 20
  ) {
    return {
      ready: false,
      reason: "INSUFFICIENT_60M_HISTORY",
      mode: "INSUFFICIENT_HISTORY_FALLBACK",
      bucketCount: candles.length,
      current,
      support: null,
      resistance: null,
      brokenResistance: null,
      clusterTolerancePct: null,
      clusterToleranceAbs: null
    };
  }

  const high60m = Math.max(...prices);
  const low60m = Math.min(...prices);
  const rangePct60m = low60m > 0 ? high60m / low60m - 1 : 0;

  const clusterPct = clamp(
    rangePct60m * STRUCTURE_CLUSTER_RANGE_FACTOR,
    STRUCTURE_CLUSTER_MIN_PCT,
    STRUCTURE_CLUSTER_MAX_PCT
  );

  const toleranceAbs = Math.max(TICK * 3, current * clusterPct);
  const pivots = detectStructurePivots(candles);

  const highClusters = clusterStructurePivots(
    pivots.highs,
    toleranceAbs
  ).filter((cluster) => cluster.touches >= STRUCTURE_MIN_TOUCHES);

  const lowClusters = clusterStructurePivots(
    pivots.lows,
    toleranceAbs
  ).filter((cluster) => cluster.touches >= STRUCTURE_MIN_TOUCHES);

  // Resistencia ACTIVA:
  // sigue siendo una pared mientras el mercado no haya confirmado ruptura
  // por encima del borde superior de la zona + pequeño margen.
  const resistanceCandidates = highClusters
    .filter(
      (cluster) =>
        current <= cluster.upper * (1 + STRUCTURE_BREAKOUT_CONFIRM_PCT)
    )
    .sort((a, b) => {
      const da = Math.max(0, a.lower - current);
      const db = Math.max(0, b.lower - current);
      if (da !== db) return da - db;
      if (a.touches !== b.touches) return b.touches - a.touches;
      return b.lastTime - a.lastTime;
    });

  // Resistencia rota más cercana debajo del mercado.
  // Sirve para saber que estamos en BREAKOUT_DISCOVERY y, por tanto,
  // la resistencia antigua ya NO debe bloquear nuevas scalps.
  const brokenResistanceCandidates = highClusters
    .filter(
      (cluster) =>
        current > cluster.upper * (1 + STRUCTURE_BREAKOUT_CONFIRM_PCT)
    )
    .sort((a, b) => {
      const da = current - a.upper;
      const db = current - b.upper;
      if (da !== db) return da - db;
      if (a.touches !== b.touches) return b.touches - a.touches;
      return b.lastTime - a.lastTime;
    });

  const supportCandidates = lowClusters
    .filter((cluster) => cluster.lower <= current)
    .sort((a, b) => {
      const da = Math.max(0, current - a.upper);
      const db = Math.max(0, current - b.upper);
      if (da !== db) return da - db;
      if (a.touches !== b.touches) return b.touches - a.touches;
      return b.lastTime - a.lastTime;
    });

  const resistance = resistanceCandidates[0] ?? null;
  const brokenResistance = brokenResistanceCandidates[0] ?? null;
  const support = supportCandidates[0] ?? null;

  let mode;

  if (resistance && support && support.price < resistance.price) {
    mode = "RANGE_FILTER";
  } else if (resistance) {
    mode = "RESISTANCE_ONLY";
  } else if (brokenResistance) {
    mode = "BREAKOUT_DISCOVERY";
  } else {
    mode = "DISCOVERY_FALLBACK";
  }

  return {
    // ready significa que tenemos historia suficiente para analizar.
    // Ya NO significa que soporte Y resistencia sean obligatorios.
    ready: true,
    reason: "OK",
    mode,
    bucketCount: candles.length,
    current,
    high60m,
    low60m,
    rangePct60m,
    clusterTolerancePct: clusterPct,
    clusterToleranceAbs: toleranceAbs,
    pivotHighCount: pivots.highs.length,
    pivotLowCount: pivots.lows.length,
    highZoneCount: highClusters.length,
    lowZoneCount: lowClusters.length,
    support,
    resistance,
    brokenResistance
  };
}

function supportContext60m(referencePrice = null) {
  const structure = structure60m(referencePrice);
  return {
    ready: structure.ready,
    reason: structure.reason,
    support: structure.support ?? null,
    low60m: structure.low60m ?? null,
    high60m: structure.high60m ?? null,
    bucketCount: structure.bucketCount ?? null
  };
}

function downsideSupportForEntry(entryPrice) {
  const local = supportContext60m(entryPrice);
  const localSupport = local.support?.price;
  const dayLow = ticker24h?.low ?? null;

  if (Number.isFinite(localSupport) && localSupport > 0 && localSupport <= entryPrice) {
    return {
      price: localSupport,
      source: "SUPPORT_60M",
      touches: local.support?.touches ?? null,
      dayLow24h: dayLow
    };
  }

  if (Number.isFinite(dayLow) && dayLow > 0 && dayLow <= entryPrice) {
    return {
      price: dayLow,
      source: "LOW_24H",
      touches: null,
      dayLow24h: dayLow
    };
  }

  return { price: null, source: null, touches: null, dayLow24h: dayLow };
}

function assessStructureForEntry(buyPrice, target) {
  // V4.8: soporte/resistencia es FILTRO INTELIGENTE, no gate obligatorio.
  const structure = structure60m();
  const bufferPct = resistanceSafetyBufferPct();
  const targetWithBuffer = target * (1 + bufferPct);

  // Si aún no hay suficiente historia, seguimos con el scalp normal.
  // Lo registramos como fallback, pero NO bloqueamos la operación.
  if (!structure.ready) {
    return {
      ...structure,
      bufferPct,
      rangePosition: null,
      roomToResistance: null,
      targetClearance: null,
      supportEntryEdge: null,
      resistanceEntryEdge: null,
      targetWithBuffer,
      structurePositionOK: null,
      targetBelowResistance: null,
      hardBlock: false,
      entryAllowed: true,
      blockReason: null,
      warningReason: structure.reason
    };
  }

  const support = structure.support;
  const resistance = structure.resistance;

  // Sin resistencia ACTIVA por encima, no hay pared estructural que bloquear.
  // Esto cubre BREAKOUT_DISCOVERY y DISCOVERY_FALLBACK.
  if (!resistance) {
    return {
      ...structure,
      bufferPct,
      rangePosition: null,
      roomToResistance: null,
      targetClearance: null,
      supportEntryEdge: support?.lower ?? null,
      resistanceEntryEdge: null,
      targetWithBuffer,
      structurePositionOK: null,
      targetBelowResistance: null,
      hardBlock: false,
      entryAllowed: true,
      blockReason: null,
      warningReason:
        structure.mode === "BREAKOUT_DISCOVERY"
          ? "OLD_RESISTANCE_BROKEN_NEW_RESISTANCE_DISCOVERY"
          : "NO_ACTIVE_RESISTANCE_FALLBACK"
    };
  }

  const supportEntryEdge = support?.lower ?? null;
  const resistanceEntryEdge = resistance.lower;

  let rangePosition = null;
  let structurePositionOK = null;

  if (
    Number.isFinite(supportEntryEdge) &&
    resistanceEntryEdge > supportEntryEdge
  ) {
    const structuralSpan = resistanceEntryEdge - supportEntryEdge;
    rangePosition = (buyPrice - supportEntryEdge) / structuralSpan;
    structurePositionOK =
      rangePosition >= 0 &&
      rangePosition <= STRUCTURE_MAX_RANGE_POSITION;
  }

  const roomToResistance = resistanceEntryEdge / buyPrice - 1;
  const targetClearance = resistanceEntryEdge / target - 1;
  const targetBelowResistance = targetWithBuffer <= resistanceEntryEdge;

  // ÚNICO BLOQUEO ESTRUCTURAL DURO en V4.8:
  // existe una resistencia ACTIVA y nuestro target + buffer necesita atravesarla.
  const hardBlock = !targetBelowResistance;

  return {
    ...structure,
    bufferPct,
    rangePosition,
    supportEntryEdge,
    resistanceEntryEdge,
    targetWithBuffer,
    roomToResistance,
    targetClearance,
    structurePositionOK,
    targetBelowResistance,
    hardBlock,
    entryAllowed: !hardBlock,
    blockReason: hardBlock ? "TARGET_BLOCKED_BY_ACTIVE_RESISTANCE" : null,
    warningReason:
      !hardBlock && structurePositionOK === false
        ? "ENTRY_HIGH_IN_RANGE_ADVISORY_ONLY"
        : null
  };
}

// ============================================================
// PROFIT FLOOR
// ============================================================

function activeScalpEquity() {
  let equity = Number(state.cash) || 0;
  const bid = bestBid();

  for (const position of openScalpPositions()) {
    const simulated = simulateMarketSell(position.pearlReceived);
    if (simulated) equity += simulated.netUSDT;
    else equity += bid ? position.pearlReceived * bid * (1 - SELL_FEE) : position.investedUSDT;
  }

  return equity;
}

function protectedCapitalFloor(position = null) {
  if (position && Number.isFinite(position.investedUSDT)) return position.investedUSDT;
  return scalpCostBasis();
}

function riskableProfitBuffer() {
  const equity = activeScalpEquity();
  const floor = protectedCapitalFloor();
  if (!Number.isFinite(equity)) return null;
  return Math.max(0, equity - floor);
}

// ============================================================
// BREAKDOWN LOCK / ANTI-WHIPSAW
// ============================================================

function activeBreakdownLocks() {
  return state.breakdownLocks.filter((x) => x.status === "ACTIVE");
}

function createBreakdownLock({ support, breakPrice, recoveryId }) {
  if (!Number.isFinite(support) || support <= 0) return null;

  const existing = activeBreakdownLocks().find(
    (x) => Math.abs(x.brokenSupport - support) / support <= 0.001
  );
  if (existing) return existing;

  const lock = {
    id: `lock-${Date.now()}-${state.breakdownLocksCreated + 1}`,
    recoveryId,
    brokenSupport: support,
    breakPrice,
    createdAt: iso(),
    createdAtMs: Date.now(),
    reclaimAboveSinceMs: null,
    status: "ACTIVE",
    releasedAt: null,
    releaseReason: null,
    replacementSupport: null
  };

  state.breakdownLocks.push(lock);
  state.breakdownLocksCreated++;
  return lock;
}

function updateBreakdownLocks(referencePrice) {
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) return;

  let changed = false;
  const now = Date.now();

  for (const lock of activeBreakdownLocks()) {
    const reclaimPrice = lock.brokenSupport * (1 + BREAKDOWN_RECLAIM_PCT);

    if (referencePrice >= reclaimPrice) {
      if (!lock.reclaimAboveSinceMs) {
        lock.reclaimAboveSinceMs = now;
        changed = true;
      } else if (now - lock.reclaimAboveSinceMs >= BREAKDOWN_RECLAIM_CONFIRM_MS) {
        lock.status = "RELEASED";
        lock.releasedAt = iso();
        lock.releaseReason = "OLD_SUPPORT_RECLAIMED";
        state.breakdownLocksReleased++;
        changed = true;

        logEvent("🔓 BREAKDOWN LOCK RELEASED", {
          lockId: lock.id,
          brokenSupport: num(lock.brokenSupport, 4),
          reclaimPrice: num(reclaimPrice, 4),
          reason: lock.releaseReason
        });
      }
    } else if (lock.reclaimAboveSinceMs) {
      lock.reclaimAboveSinceMs = null;
      changed = true;
    }
  }

  if (changed) saveState();
}

function breakdownEntryGate(metric, supportContext) {
  const locks = activeBreakdownLocks();
  if (!locks.length) return { ok: true, blockedBy: null };

  const support = supportContext?.support;

  for (const lock of locks) {
    const newSupportOK =
      support &&
      Number.isFinite(support.price) &&
      (support.touches ?? 0) >= STRUCTURE_MIN_TOUCHES &&
      support.price <= lock.brokenSupport * (1 - BREAKDOWN_NEW_SUPPORT_PCT);

    if (newSupportOK) {
      lock.status = "RELEASED";
      lock.releasedAt = iso();
      lock.releaseReason = "NEW_LOWER_SUPPORT_ESTABLISHED";
      lock.replacementSupport = support.price;
      state.breakdownLocksReleased++;

      logEvent("🔓 BREAKDOWN LOCK RELEASED", {
        lockId: lock.id,
        brokenSupport: num(lock.brokenSupport, 4),
        replacementSupport: num(support.price, 4),
        supportTouches: support.touches ?? null,
        reason: lock.releaseReason
      });
      saveState();
      continue;
    }

    return {
      ok: false,
      blockedBy: lock.id,
      brokenSupport: lock.brokenSupport,
      current: metric?.current ?? null
    };
  }

  return { ok: true, blockedBy: null };
}

// ============================================================
// INITIAL BUY PRICE
// ============================================================

function proposedBuyPrice() {
  const bid = bestBid();
  const ask = bestAsk();

  if (!bid || !ask) return null;

  let candidate = roundDown(bid + TICK);

  // No cruzamos el ask con la orden inicial.
  if (candidate >= ask) {
    candidate = roundDown(bid);
  }

  return candidate;
}

// ============================================================
// ENTRY SIGNALS — V5.1
// ============================================================

function failedConditionNames(conditions) {
  return Object.entries(conditions)
    .filter(([, value]) => !value)
    .map(([name]) => name);
}

// Señal DURA heredada: sirve para diagnóstico / confirmación posterior.
// V5.1 ya NO espera a que esta señal sea completa para armar la LIMIT.
function buildHardSignal(ignoreMode = false) {
  if (!ignoreMode && state.buyOrder) return null;

  const cooldownOK = Date.now() - state.lastExitTimeMs >= COOLDOWN_MS;
  const metric = earlyArmMetric();
  if (!metric) return null;

  const flow = flowMetrics();
  const buyPrice = proposedBuyPrice();
  if (!buyPrice) return null;

  const target = roundUp(buyPrice * (1 + TARGET_GROSS));
  const supportContext = supportContext60m(metric.current);
  const breakdownGate = breakdownEntryGate(metric, supportContext);
  const fallingGate = fallingMarketEntryGate(metric.current);
  const startupGate = startupContextStatus(metric.current);
  const entryZone = entryZoneContext(buyPrice, metric);

  const conditions = {
    scalpCapitalOK: state.cash >= MIN_SCALP_CASH_USDT,
    startupContextOK: startupGate.ready,
    fallingMarketLockOK: !fallingGate.lockId,
    entryStabilityOK: fallingGate.entryStability?.ok ?? true,
    breakdownLockOK: breakdownGate.ok,
    priceLadderOK: entryZone.ladder.ok,
    rangePosition24hOK: entryZone.range.ok,
    positionSpacingOK: positionSpacingContext(buyPrice).ok,
    cooldownOK,
    drawdownOK: metric.drawdown >= MIN_DRAWDOWN,
    lowZoneOK: metric.rangePosition <= MAX_RANGE_POSITION,
    rangeOK: metric.rangePct >= MIN_RECENT_RANGE,
    freshLowOK: metric.lowAgeMs <= MAX_LOW_AGE_MS,
    sellPressureOK:
      flow.askShare === null ||
      flow.askShare <= MAX_ASK_SHARE_FOR_ENTRY
  };

  return {
    type: "HARD_SIGNAL",
    ok: Object.values(conditions).every(Boolean),
    conditions,
    failedConditions: failedConditionNames(conditions),
    metric,
    flow,
    supportContext,
    breakdownGate,
    fallingGate,
    startupGate,
    entryZone,
    ticker24h,
    targetSeenRecentlyAdvisory: Number.isFinite(metric.high)
      ? target <= metric.high
      : null,
    marketReferenceSource: metric.currentSource ?? null,
    marketSampleCount: metric.sampleCount ?? null,
    buyPrice,
    target
  };
}

// Señal TEMPRANA V5.1.8.3: si el bot YA tiene una zona maker válida,
// la LIMIT se arma inmediatamente. NO esperamos ASK5m, drawdown 0.35%,
// rango 0.45% ni otras confirmaciones lentas para colocar la orden.
//
// FLOW 5m sigue calculándose y se muestra como CONTEXTO.
// El hardSignal sigue existiendo como confirmación posterior.
// La BUY puede llenarse antes de que llegue ese hardSignal.
function buildEarlyArmSignal(ignoreMode = false) {
  if (!ignoreMode && state.buyOrder) return null;

  const cooldownOK = Date.now() - state.lastExitTimeMs >= COOLDOWN_MS;
  const metric = earlyArmMetric();
  if (!metric) return null;

  const flow = flowMetrics();
  const buyPrice = proposedBuyPrice();
  if (!buyPrice) return null;

  const target = roundUp(buyPrice * (1 + TARGET_GROSS));
  const supportContext = supportContext60m(metric.current);
  const distanceToBuy = buyPrice > 0
    ? metric.current / buyPrice - 1
    : null;
  const breakdownGate = breakdownEntryGate(metric, supportContext);
  const fallingGate = fallingMarketEntryGate(metric.current);
  const startupGate = startupContextStatus(metric.current);
  const entryZone = entryZoneContext(buyPrice, metric);

  const conditions = {
    scalpCapitalOK: state.cash >= MIN_SCALP_CASH_USDT,
    startupContextOK: startupGate.ready,
    fallingMarketLockOK: !fallingGate.lockId,
    entryStabilityOK: !fallingGate.lockId,
    breakdownLockOK: breakdownGate.ok,
    priceLadderOK: entryZone.ladder.ok,
    rangePosition24hOK: entryZone.range.ok,
    positionSpacingOK: positionSpacingContext(buyPrice).ok,
    cooldownOK,
    buyBelowMarketOK:
      distanceToBuy !== null &&
      distanceToBuy >= EARLY_ARM_MIN_DISTANCE,
    buyNotTooFarOK:
      distanceToBuy !== null &&
      distanceToBuy <= EARLY_ARM_MAX_DISTANCE
  };

  return {
    type: "EARLY_ARM",
    ok: Object.values(conditions).every(Boolean),
    conditions,
    failedConditions: failedConditionNames(conditions),
    metric,
    flow, // CONTEXTO: NO bloquea EARLY_ARM en V5.1
    supportContext,
    breakdownGate,
    fallingGate,
    startupGate,
    entryZone,
    ticker24h,
    distanceToBuy,
    targetSeenRecentlyAdvisory: Number.isFinite(metric.high)
      ? target <= metric.high
      : null,
    marketReferenceSource: metric.currentSource ?? null,
    marketSampleCount: metric.sampleCount ?? null,
    buyPrice,
    target
  };
}

// ============================================================
// PLACE BUY LIMIT
// ============================================================

function placeBuyLimit(signal, placementContext = null) {
  if (state.buyOrder) return false; // una sola BUY pendiente a la vez

  const now = Date.now();
  const price = signal.buyPrice;
  const allocation = scalpAllocation(signal);
  const capitalToUse = allocation.capital;
  const spacing = positionSpacingContext(price);

  if (!spacing.ok) {
    state.positionSpacingBlocks = (state.positionSpacingBlocks || 0) + 1;
    logEvent("↔️ BUY BLOCKED BY POSITION SPACING", {
      requestedPrice: price,
      target: signal.target,
      minimumSpacing: pct(MIN_POSITION_SPACING_PCT),
      nearestEntry: spacing.nearestEntry,
      nearestDistance: pct(spacing.nearestDistancePct),
      nearestPositionId: spacing.nearestPositionId,
      nearestType: spacing.nearestType,
      action: "WAIT_FOR_DISTINCT_SCALP_LEVEL"
    });
    saveState();
    return false;
  }

  if (!allocation.zone.ok) {
    logEvent("🚫 BUY BLOCKED BY V5.1.8.3 ENTRY ZONE", {
      requestedPrice: price,
      target: signal.target,
      rangeMode: allocation.zone.range.mode,
      rangePosition24h: allocation.zone.range.rangePosition24h,
      high24h: allocation.zone.ladder.high24h,
      maxBuyExclusive: allocation.zone.ladder.maxBuyExclusive,
      nextUnlockResistance: allocation.zone.ladder.nextUnlockResistance,
      ladderReason: allocation.zone.ladder.reason,
      rangeReason: allocation.zone.range.reason
    });
    return false;
  }

  if (!Number.isFinite(capitalToUse) || capitalToUse < MIN_SCALP_CASH_USDT) return false;

  const requestedPearl = capitalToUse / price;
  const queueAhead = bookAmountAt(bids, price);

  state.buyOrder = {
    firstPlacedAt: iso(now),
    firstPlacedAtMs: now,
    ...placementCausalityFields(placementContext),
    entrySignalType: signal.type || "UNKNOWN",
    hardSignalConfirmedAt: signal.type === "HARD_SIGNAL" ? iso(now) : null,
    hardSignalConfirmedAtMs: signal.type === "HARD_SIGNAL" ? now : null,
    price,
    target: signal.target,
    cash: capitalToUse,
    allocationMode: allocation.mode,
    allocationFraction: allocation.fraction,
    multiPositionSlotCap: allocation.slotCap,
    reserveAfterFill: allocation.reserveAfterFill,
    highRangeCaution: allocation.caution,
    entryZone: allocation.zone,
    spacingAtPlacement: spacing,
    requestedPearl,
    queueAhead,
    qualifyingVolume: 0,
    requiredFlow: (queueAhead + requestedPearl) * FILL_SAFETY
  };

  syncLegacyScalpView();
  state.buyOrdersPlaced++;
  if (signal.type === "EARLY_ARM") state.earlyBuyOrdersArmed = (state.earlyBuyOrdersArmed || 0) + 1;
  if (["HIGH_RANGE_CAUTION", "EXHAUSTION_CAUTION", "UPPER_RANGE_CAUTION"].includes(allocation.mode)) {
    state.highRangeCautionOrders = (state.highRangeCautionOrders || 0) + 1;
  }
  if (allocation.mode === "SOFT_FALLING_CAUTION") {
    state.softFallingCautionOrders = (state.softFallingCautionOrders || 0) + 1;
  }

  append(SIGNALS_FILE, {
    type: "BUY_LIMIT_PLACED",
    time: iso(),
    localTime: localClock().text,
    signal,
    order: state.buyOrder
  });

  console.log(signal.type === "EARLY_ARM" ? "\n🟡 EARLY BUY ARMED" : "\n🟡 BUY LIMIT", {
    entrySignalType: signal.type, price, target: signal.target,
    allocationMode: allocation.mode, capitalToUse: num(capitalToUse),
    multiPositionSlotCap: num(allocation.slotCap),
    openScalpPositions: openScalpPositions().length,
    minimumPositionSpacing: pct(MIN_POSITION_SPACING_PCT),
    capitalFraction: pct(allocation.fraction),
    cashReserveIfFilled: num(allocation.reserveAfterFill),
    highRangeExhaustionVotes: allocation.caution.exhaustionVotes,
    highRangeCautionActive: allocation.caution.active,
    fallingRegime: allocation.falling?.regime ?? "NORMAL_SCALP",
    softFallingCautionActive: allocation.falling?.softCaution ?? false,
    rangeAllocationMode: allocation.zone.range.mode,
    rangePosition24hAtBuy: pct(allocation.zone.range.rangePosition24h),
    priceLadderOK: allocation.zone.ladder.ok,
    high24hEntryGate: num(allocation.zone.ladder.high24h, 4),
    maxBuyExclusive: num(allocation.zone.ladder.maxBuyExclusive, 4),
    nextUnlockResistance: num(allocation.zone.ladder.nextUnlockResistance, 4),
    startupContextReady: signal.startupGate?.ready ?? null,
    startupElapsedSeconds: num(signal.startupGate?.elapsedSeconds, 1),
    startupLiveTrades: signal.startupGate?.liveTrades ?? null,
    lastPrice: signal.metric.current, recentLow: signal.metric.low,
    support60m: num(signal.supportContext.support?.price, 4),
    supportTouches60m: signal.supportContext.support?.touches ?? null,
    low24h: num(signal.ticker24h?.low, 4), high24h: num(signal.ticker24h?.high, 4),
    rangePosition24h: pct(tickerRangePosition24h(signal.metric.current)),
    targetSeenRecentlyAdvisory: signal.targetSeenRecentlyAdvisory,
    distanceToBuy: pct(signal.distanceToBuy),
    marketReferenceSource: signal.marketReferenceSource ?? null,
    marketSampleCount: signal.marketSampleCount ?? null,
    failedHardConditionsAtArm: signal.type === "EARLY_ARM" ? (buildHardSignal(true)?.failedConditions ?? null) : [],
    askShare5m: pct(signal.flow.askShare), bidShare5m: pct(signal.flow.bidShare)
  });

  saveState();
  return true;
}

// ============================================================
// CANCEL BUY
// ============================================================

function cancelBuy(reason) {
  if (state.mode !== "BUY_LIMIT" || !state.buyOrder) return;

  logEvent("⚪ BUY CANCELLED", {
    reason,
    order: state.buyOrder
  });

  state.buyOrdersCancelled++;

  if (reason === "TTL_EXPIRED") {
    state.buyOrdersExpired = (state.buyOrdersExpired || 0) + 1;
  }

  state.buyOrder = null;
  syncLegacyScalpView();

  saveState();
}

// ============================================================
// V5.1.8.3 — STATIC EARLY-ARM BUY / NO REPRICE UP
// ============================================================

// La entrada anticipada se mantiene estática durante 90 s.
// Si no llena, TTL_EXPIRED cancela el intento y la siguiente
// señal se calcula desde cero con el mercado actual.

// ============================================================
// BUY FILLED
// ============================================================

function fillBuy(fillMeta = {}) {
  const order = state.buyOrder;
  if (!order) return;

  const spacing = positionSpacingContext(order.price);
  if (!spacing.ok) {
    state.positionSpacingBlocks = (state.positionSpacingBlocks || 0) + 1;
    logEvent("↔️ BUY FILL ABORTED BY POSITION SPACING", {
      orderPrice: order.price,
      nearestEntry: spacing.nearestEntry,
      nearestDistance: pct(spacing.nearestDistancePct),
      nearestPositionId: spacing.nearestPositionId
    });
    cancelBuy("POSITION_SPACING_RELOCKED");
    return;
  }

  const capital = order.cash;
  if (!Number.isFinite(capital) || capital <= 0 || state.cash + 1e-9 < capital) {
    logEvent("⚠️ BUY FILL ABORTED", {
      reason: "SCALP_CASH_CHANGED_OR_INSUFFICIENT",
      orderCash: order.cash,
      availableCash: state.cash
    });
    cancelBuy("INSUFFICIENT_SCALP_CASH");
    return;
  }

  const grossPearl = capital / order.price;
  const buyFeePearl = grossPearl * BUY_FEE;
  const pearlReceived = grossPearl - buyFeePearl;
  const sellTarget = roundUp(order.price * (1 + TARGET_GROSS));
  const downsideSupport = downsideSupportForEntry(order.price);
  const entryNow = Date.now();

  state.scalpPositionsOpened = (state.scalpPositionsOpened || 0) + 1;
  const positionId = `scalp-${entryNow}-${state.scalpPositionsOpened}`;

  const queueAhead = bookAmountAt(asks, sellTarget);
  const sellPlacedAtMs = Date.now();
  const sellPlacementContext = {
    batchId: fillMeta.tradeObservationBatchId ?? null,
    tradeTimeMs: fillMeta.tradeExchangeTimeMs ?? null,
    source: fillMeta.tradeSource ?? null
  };

  const sellOrder = {
    positionId,
    placedAt: iso(sellPlacedAtMs),
    placedAtMs: sellPlacedAtMs,
    ...placementCausalityFields(sellPlacementContext),
    price: sellTarget,
    pearl: pearlReceived,
    queueAhead,
    qualifyingVolume: 0,
    requiredFlow: (queueAhead + pearlReceived) * FILL_SAFETY
  };

  const position = {
    id: positionId,
    entryTime: iso(entryNow),
    entryTimeMs: entryNow,
    entryPrice: order.price,
    entrySignalType: order.entrySignalType || null,
    hardSignalConfirmedAt: order.hardSignalConfirmedAt || null,
    allocationMode: order.allocationMode || "NORMAL_SCALP",
    allocationFraction: order.allocationFraction ?? 1,
    reserveAtEntry: Number.isFinite(order.reserveAfterFill) ? order.reserveAfterFill : 0,
    highRangeCautionAtEntry: order.highRangeCaution ?? null,
    investedUSDT: capital,
    grossPearl,
    buyFeePearl,
    pearlReceived,
    sellTarget,
    sellOrder,
    structuralSupportAtEntry: downsideSupport.price,
    structuralSupportSource: downsideSupport.source,
    structuralSupportTouches: downsideSupport.touches,
    low24hAtEntry: ticker24h?.low ?? null,
    high24hAtEntry: ticker24h?.high ?? null,
    fillMethod: fillMeta.method || null,
    fillTriggerTradePrice: fillMeta.tradePrice ?? null,
    fillTriggerTradeSide: fillMeta.tradeSide ?? null,
    fillTriggerTradeSource: fillMeta.tradeSource ?? null,
    fillTriggerTradeExchangeTime: fillMeta.tradeExchangeTime ?? null,
    fillTriggerTradeObservedAt: fillMeta.tradeObservedAt ?? null,
    fillCausalAgeMs: fillMeta.causalAgeMs ?? null
  };

  state.cash = Math.max(0, state.cash - capital);
  state.scalpPositions.push(position);
  state.buyOrdersFilled++;
  state.buyOrder = null;
  state.sellOrdersPlaced = (state.sellOrdersPlaced || 0) + 1;
  syncLegacyScalpView();

  append(TRADES_FILE, {
    type: "PAPER_BUY_FILLED", time: iso(), localTime: localClock().text, positionId,
    entryPrice: order.price, investedUSDT: capital, allocationMode: order.allocationMode || "NORMAL_SCALP",
    allocationFraction: order.allocationFraction ?? 1, cashReserveAfterFill: num(state.cash),
    grossPearl: num(grossPearl), buyFeePearl: num(buyFeePearl), pearlReceived: num(pearlReceived),
    sellTarget, structuralSupportAtEntry: downsideSupport.price, structuralSupportSource: downsideSupport.source,
    low24hAtEntry: ticker24h?.low ?? null, high24hAtEntry: ticker24h?.high ?? null,
    fillMethod: fillMeta.method || null, fillTriggerTradePrice: fillMeta.tradePrice ?? null,
    fillTriggerTradeSide: fillMeta.tradeSide ?? null, fillTriggerTradeSource: fillMeta.tradeSource ?? null,
    fillTriggerTradeExchangeTime: fillMeta.tradeExchangeTime ?? null, fillTriggerTradeObservedAt: fillMeta.tradeObservedAt ?? null,
    fillCausalAgeMs: fillMeta.causalAgeMs ?? null, sellOrderPlacedAt: sellOrder.placedAt
  });

  console.log("\n🟢 BUY FILLED", {
    positionId, entry: order.price, entrySignalType: order.entrySignalType || null,
    hardSignalConfirmedBeforeFill: Boolean(order.hardSignalConfirmedAt), target045: sellTarget,
    pearlReceived: num(pearlReceived), supportAtEntry: num(downsideSupport.price, 4),
    supportSource: downsideSupport.source, low24hAtEntry: num(ticker24h?.low, 4),
    high24hAtEntry: num(ticker24h?.high, 4), capital, cashRemaining: num(state.cash),
    openScalpPositions: openScalpPositions().length, fillMethod: fillMeta.method || null,
    fillTriggerTradePrice: fillMeta.tradePrice ?? null, fillTriggerTradeSide: fillMeta.tradeSide ?? null,
    fillTriggerTradeSource: fillMeta.tradeSource ?? null, fillTriggerTradeExchangeTime: fillMeta.tradeExchangeTime ?? null,
    fillTriggerTradeObservedAt: fillMeta.tradeObservedAt ?? null, fillCausalAgeMs: fillMeta.causalAgeMs ?? null
  });

  logEvent("🟠 SELL LIMIT PLACED", {
    positionId, orderPrice: sellOrder.price, pearl: num(sellOrder.pearl),
    queueAhead: num(sellOrder.queueAhead), requiredFlow: num(sellOrder.requiredFlow),
    placedAt: sellOrder.placedAt, placedInObservationBatchId: sellOrder.placedInObservationBatchId,
    placedAfterTradeExchangeTime: sellOrder.placedAfterTradeExchangeTime,
    placementObservationSource: sellOrder.placementObservationSource,
    rule: "ONLY_TRADES_OBSERVED_AFTER_THIS_ORDER_MAY_FILL"
  });

  saveState();
}

// ============================================================
// EQUITY
// ============================================================

function recoveryPositionNetValue(recovery) {
  const simulated = simulateMarketSell(recovery.pearlReceived);
  if (simulated) return simulated.netUSDT;

  const bid = bestBid();
  if (bid) return recovery.pearlReceived * bid * (1 - SELL_FEE);

  return recovery.investedUSDT;
}

function recoveryEquity() {
  return state.recoveryPositions.reduce(
    (sum, recovery) => sum + recoveryPositionNetValue(recovery),
    0
  );
}

function currentEquity() {
  return activeScalpEquity() + recoveryEquity();
}

// ============================================================
// CLOSE POSITION
// ============================================================

function finalizeSell(positionId, { reason, sellPrice, finalUSDT, market, fillMeta = {} }) {
  const index = openScalpPositions().findIndex((p) => p.id === positionId);
  if (index < 0) return false;

  const position = state.scalpPositions[index];
  const sellOrder = position.sellOrder || null;
  const capitalBefore = position.investedUSDT;
  const profit = finalUSDT - capitalBefore;
  const roi = profit / capitalBefore;
  const holdSeconds = (Date.now() - position.entryTimeMs) / 1000;

  state.cash += finalUSDT;
  state.scalpPositions.splice(index, 1);
  state.cycles++;
  state.sellOrdersFilled++;
  state.realizedProfit = (Number(state.realizedProfit) || 0) + profit;
  state.peakRealizedProfit = Math.max(Number(state.peakRealizedProfit) || 0, state.realizedProfit);
  state.lastExitTimeMs = Date.now();

  if (reason === "TARGET_0.45") state.targetExits++;
  if (reason === "CAPITAL_PROTECTED_STOP") {
    state.stopExits++;
    state.capitalProtectedStops++;
  }

  const row = {
    type: "PAPER_SELL_FILLED", reason, market, time: iso(), localTime: localClock().text,
    cycle: state.cycles, positionId, entryPrice: position.entryPrice, sellPrice: num(sellPrice, 6),
    grossMove: pct(sellPrice / position.entryPrice - 1), cycleROI: pct(roi), holdSeconds: num(holdSeconds, 2),
    capitalBefore: num(capitalBefore), capitalAfter: num(finalUSDT), cycleProfit: num(profit),
    totalProfit: num(state.realizedProfit), fillMethod: fillMeta.method || null,
    fillTriggerTradePrice: fillMeta.tradePrice ?? null, fillTriggerTradeSide: fillMeta.tradeSide ?? null,
    fillTriggerTradeSource: fillMeta.tradeSource ?? null, fillTriggerTradeExchangeTime: fillMeta.tradeExchangeTime ?? null,
    fillTriggerTradeObservedAt: fillMeta.tradeObservedAt ?? null, causalAgeMs: fillMeta.causalAgeMs ?? null,
    exchangeAgeVsOrderMs: fillMeta.exchangeAgeVsOrderMs ?? null, sellOrderPlacedAt: sellOrder?.placedAt ?? null
  };

  append(TRADES_FILE, row);
  console.log("\n💰 POSITION CLOSED", row);
  syncLegacyScalpView();
  saveState();
  return true;
}

function normalTargetSell(positionId, fillMeta = {}) {
  const position = openScalpPositions().find((p) => p.id === positionId);
  const sell = position?.sellOrder;
  if (!position || !sell) return false;

  const grossUSDT = position.pearlReceived * sell.price;
  const finalUSDT = grossUSDT * (1 - SELL_FEE);
  return finalizeSell(positionId, {
    reason: "TARGET_0.45",
    sellPrice: sell.price,
    finalUSDT,
    market: false,
    fillMeta
  });
}

// ============================================================
// PROTECTED MARKET EXIT — V4.8 (POR POSICIÓN)
// ============================================================

let lastCapitalFloorBlockLogMs = 0;

function protectedMarketExit(positionId, reason) {
  const position = openScalpPositions().find((p) => p.id === positionId);
  if (!position) return false;

  const simulated = simulateMarketSell(position.pearlReceived);
  if (!simulated) {
    logEvent("⚠️ PROTECTED EXIT FAILED", { positionId, reason, detail: "INSUFFICIENT_VISIBLE_BID_DEPTH" });
    return false;
  }

  const floor = protectedCapitalFloor(position);
  const wouldReceive = simulated.netUSDT;
  if (wouldReceive + 1e-9 < floor) {
    const now = Date.now();
    if (now - lastCapitalFloorBlockLogMs >= 30000) {
      lastCapitalFloorBlockLogMs = now;
      state.capitalFloorBlockedStops++;
      logEvent("🛡️ STOP BLOCKED BY CAPITAL FLOOR", {
        positionId, reason, entryPrice: position.entryPrice,
        estimatedSellPrice: num(simulated.avgPrice, 6), estimatedNetUSDT: num(wouldReceive),
        protectedCapitalFloor: num(floor), amountBelowFloor: num(floor - wouldReceive),
        action: "HOLD_POSITION"
      });
      saveState();
    }
    return false;
  }

  return finalizeSell(positionId, {
    reason: "CAPITAL_PROTECTED_STOP",
    sellPrice: simulated.avgPrice,
    finalUSDT: simulated.netUSDT,
    market: true
  });
}

function recoveryTargetPrice(position) {
  const exactBreakEven =
    position.investedUSDT /
    (position.pearlReceived * (1 - SELL_FEE));

  return roundUp(exactBreakEven * (1 + RECOVERY_EXIT_BUFFER_PCT));
}

function moveActivePositionToRecovery(positionId, reason, placementContext = null) {
  const positionIndex = openScalpPositions().findIndex((p) => p.id === positionId);
  if (positionIndex < 0) return false;

  const position = state.scalpPositions[positionIndex];
  const support = position.structuralSupportAtEntry;
  const breakPrice = Number.isFinite(support)
    ? support * (1 - STRUCTURAL_STOP_BREAK_PCT)
    : null;
  const target = recoveryTargetPrice(position);
  const recoveryId = `recovery-${Date.now()}-${state.recoveryHoldsStarted + 1}`;

  // V5.1.8.3 — ANCLA INMUTABLE DEL SOPORTE 24H.
  // Preferimos el low24h vigente EXACTAMENTE cuando nace el recovery.
  // Si el ticker no está disponible, usamos el low24h capturado en la entrada.
  const currentLow24h = Number(ticker24h?.low);
  const entryLow24h = Number(position.low24hAtEntry);
  const low24hAnchor =
    Number.isFinite(currentLow24h) && currentLow24h > 0
      ? currentLow24h
      : Number.isFinite(entryLow24h) && entryLow24h > 0
        ? entryLow24h
        : null;
  const low24hAnchorSource =
    Number.isFinite(currentLow24h) && currentLow24h > 0
      ? "TICKER_24H_AT_RECOVERY_ENTRY"
      : Number.isFinite(entryLow24h) && entryLow24h > 0
        ? "POSITION_LOW24H_AT_ENTRY_FALLBACK"
        : null;
  const hardStopBreakPrice = Number.isFinite(low24hAnchor)
    ? low24hAnchor * (1 - RECOVERY_ANCHOR_BREAK_PCT)
    : null;

  const recovery = {
    id: recoveryId,
    status: "RECOVERY_HOLD",
    reason,
    recoveryStartedAt: iso(),
    recoveryStartedAtMs: Date.now(),
    recoveryOrderPlacedAtMs: Date.now(),
    ...placementCausalityFields(placementContext),
    entryTime: position.entryTime,
    entryTimeMs: position.entryTimeMs,
    entryPrice: position.entryPrice,
    investedUSDT: position.investedUSDT,
    pearlReceived: position.pearlReceived,
    recoveryTarget: target,

    // -10% ya NO es un stop. Solo arma RECOVERY_DANGER.
    recoveryDangerNetUSDT: position.investedUSDT * (1 - RECOVERY_DANGER_PCT),
    dangerPct: RECOVERY_DANGER_PCT,
    dangerArmedAt: null,
    dangerArmedAtMs: null,

    // Soporte 24h congelado para ESTA posición recovery.
    low24hAnchor,
    low24hAnchorAt: iso(),
    low24hAnchorSource,
    hardStopBreakPrice,
    anchorBreakPct: RECOVERY_ANCHOR_BREAK_PCT,
    anchorBreakBelowSince: null,
    anchorBreakBelowSinceMs: null,
    anchorBreakConfirmMs: RECOVERY_ANCHOR_BREAK_CONFIRM_MS,
    lastAnchorReclaimAt: null,
    lastAnchorReclaimAtMs: null,

    structuralSupportAtEntry: support,
    structuralSupportSource: position.structuralSupportSource,
    breakPrice,
    queueAhead: bookAmountAt(asks, target),
    qualifyingVolume: 0,
    requiredFlow: (bookAmountAt(asks, target) + position.pearlReceived) * FILL_SAFETY,
    sourcePosition: position
  };

  state.recoveryPositions.push(recovery);
  state.recoveryHoldsStarted++;
  state.structuralStopExits = state.structuralStopExits || 0; // histórico; no aumenta: no hubo venta.

  const lock = createBreakdownLock({
    support,
    breakPrice,
    recoveryId
  });

  // Sacamos SOLO esta posición del motor de scalp SIN venderla.
  state.scalpPositions.splice(positionIndex, 1);
  syncLegacyScalpView();
  state.lastExitTimeMs = Date.now();

  const fallingLock = activateFallingMarketLock({
    recoveryId,
    triggerPrice: bestBid() ?? marketReferencePrice()?.price ?? position.entryPrice,
    brokenSupport: support
  });

  logEvent("🧊 POSITION MOVED TO RECOVERY_HOLD", {
    recoveryId,
    sourcePositionId: positionId,
    reason,
    entryPrice: position.entryPrice,
    investedUSDT: num(position.investedUSDT),
    pearlHeld: num(position.pearlReceived),
    recoveryTarget: target,
    recoveryDangerNetUSDT: num(recovery.recoveryDangerNetUSDT),
    recoveryDangerPct: pct(RECOVERY_DANGER_PCT),
    low24hAnchor: num(low24hAnchor, 6),
    low24hAnchorAt: recovery.low24hAnchorAt,
    low24hAnchorSource,
    hardStopBreakPrice: num(hardStopBreakPrice, 6),
    anchorBreakPct: pct(RECOVERY_ANCHOR_BREAK_PCT),
    anchorBreakConfirmSeconds: RECOVERY_ANCHOR_BREAK_CONFIRM_MS / 1000,
    brokenSupport: num(support, 4),
    breakdownLockId: lock?.id ?? null,
    fallingMarketLockId: fallingLock?.id ?? null,
    scalpCashReserved: num(state.cash),
    action: "HOLD_RECOVERY_-10PCT_IS_DANGER_NOT_EXIT"
  });

  logEvent("🟣 RECOVERY SELL LIMIT PLACED", {
    recoveryId,
    orderPrice: recovery.recoveryTarget,
    pearl: num(recovery.pearlReceived),
    queueAhead: num(recovery.queueAhead),
    requiredFlow: num(recovery.requiredFlow),
    placedAt: iso(recovery.recoveryOrderPlacedAtMs),
    placedInObservationBatchId: recovery.placedInObservationBatchId,
    placedAfterTradeExchangeTime: recovery.placedAfterTradeExchangeTime,
    placementObservationSource: recovery.placementObservationSource,
    rule: "ONLY_TRADES_OBSERVED_AFTER_THIS_ORDER_MAY_FILL"
  });

  append(TRADES_FILE, {
    type: "PAPER_RECOVERY_HOLD_STARTED",
    time: iso(),
    localTime: localClock().text,
    recoveryId,
    sourcePositionId: positionId,
    reason,
    entryPrice: position.entryPrice,
    investedUSDT: num(position.investedUSDT),
    pearlHeld: num(position.pearlReceived),
    recoveryTarget: target,
    recoveryDangerNetUSDT: num(recovery.recoveryDangerNetUSDT),
    recoveryDangerPct: pct(RECOVERY_DANGER_PCT),
    low24hAnchor: num(low24hAnchor, 6),
    low24hAnchorAt: recovery.low24hAnchorAt,
    low24hAnchorSource,
    hardStopBreakPrice: num(hardStopBreakPrice, 6),
    anchorBreakPct: pct(RECOVERY_ANCHOR_BREAK_PCT),
    anchorBreakConfirmSeconds: RECOVERY_ANCHOR_BREAK_CONFIRM_MS / 1000,
    structuralSupportAtEntry: num(support, 6),
    breakPrice: num(breakPrice, 6)
  });

  saveState();
  return true;
}

function finalizeRecoveryPosition(recovery, {
  reason,
  sellPrice,
  finalUSDT,
  market,
  fillMeta = {}
}) {
  const profit = finalUSDT - recovery.investedUSDT;
  const roi = profit / recovery.investedUSDT;
  const holdSeconds = (Date.now() - recovery.entryTimeMs) / 1000;

  state.cash += finalUSDT;
  state.realizedProfit = (Number(state.realizedProfit) || 0) + profit;
  state.peakRealizedProfit = Math.max(
    Number(state.peakRealizedProfit) || 0,
    state.realizedProfit
  );

  if (reason === "RECOVERY_BREAK_EVEN_EXIT") {
    state.recoveryBreakEvenExits++;
  } else if (
    reason === "RECOVERY_HARD_STOP_ANCHORED_SUPPORT_BREAK" ||
    reason === "RECOVERY_HARD_STOP_10PCT"
  ) {
    state.recoveryHardStops++;
    state.stopExits++;
  }

  state.recoveryPositions = state.recoveryPositions.filter(
    (x) => x.id !== recovery.id
  );

  const row = {
    type: "PAPER_RECOVERY_SELL_FILLED",
    reason,
    market,
    time: iso(),
    localTime: localClock().text,
    recoveryId: recovery.id,
    entryPrice: recovery.entryPrice,
    sellPrice: num(sellPrice, 6),
    grossMove: pct(sellPrice / recovery.entryPrice - 1),
    recoveryROI: pct(roi),
    holdSeconds: num(holdSeconds, 2),
    capitalBefore: num(recovery.investedUSDT),
    capitalAfter: num(finalUSDT),
    recoveryProfit: num(profit),
    totalRealizedProfit: num(state.realizedProfit),
    scalpCashAfter: num(state.cash),
    fillMethod: fillMeta.method || null,
    fillTriggerTradePrice: fillMeta.tradePrice ?? null,
    fillTriggerTradeSide: fillMeta.tradeSide ?? null,
    fillTriggerTradeSource: fillMeta.tradeSource ?? null,
    fillTriggerTradeExchangeTime: fillMeta.tradeExchangeTime ?? null,
    fillTriggerTradeObservedAt: fillMeta.tradeObservedAt ?? null,
    causalAgeMs: fillMeta.causalAgeMs ?? null,
    exchangeAgeVsOrderMs: fillMeta.exchangeAgeVsOrderMs ?? null
  };

  append(TRADES_FILE, row);
  console.log("\n💚 RECOVERY POSITION CLOSED", row);
  saveState();
}

function processRecoveryTrade(trade, source, observationMeta = {}) {
  if (!state.recoveryPositions.length) return;

  // Copia para poder remover elementos durante el loop.
  for (const recovery of [...state.recoveryPositions]) {
    const relation = priceRelation(trade.price, recovery.recoveryTarget);
    const causal = causalFillAudit(recovery, trade, source, observationMeta);

    if (!causal.ok) {
      if (relation > 0 || (relation === 0 && trade.side === "BID")) {
        state.causalRecoveryFillsBlocked =
          (state.causalRecoveryFillsBlocked || 0) + 1;

        logEvent("⏱️ RECOVERY FILL BLOCKED BY CAUSALITY", {
          recoveryId: recovery.id,
          orderPrice: recovery.recoveryTarget,
          tradePrice: trade.price,
          tradeSide: trade.side,
          ...causal
        });
      }
      continue;
    }

    if (relation > 0) {
      const finalUSDT =
        recovery.pearlReceived * recovery.recoveryTarget * (1 - SELL_FEE);

      logEvent("⚡ RECOVERY CROSS-THROUGH FILL", {
        recoveryId: recovery.id,
        orderPrice: recovery.recoveryTarget,
        tradePrice: trade.price,
        tradeSide: trade.side,
        tradeSource: source,
        orderPlacedAt: causal.orderPlacedAt,
        tradeExchangeTime: causal.tradeExchangeTime,
        tradeObservedAt: causal.tradeObservedAt,
        causalAgeMs: causal.causalAgeMs,
        exchangeAgeVsOrderMs: causal.exchangeAgeVsOrderMs
      });

      finalizeRecoveryPosition(recovery, {
        reason: "RECOVERY_BREAK_EVEN_EXIT",
        sellPrice: recovery.recoveryTarget,
        finalUSDT,
        market: false,
        fillMeta: {
          method: "CROSS_THROUGH",
          tradePrice: trade.price,
          tradeSide: trade.side,
          tradeSource: source,
          tradeExchangeTime: causal.tradeExchangeTime,
          tradeExchangeTimeMs: causal.tradeExchangeTimeMs,
          tradeObservedAt: causal.tradeObservedAt,
          tradeObservationBatchId: causal.batchId,
          causalAgeMs: causal.causalAgeMs,
          exchangeAgeVsOrderMs: causal.exchangeAgeVsOrderMs
        }
      });
      continue;
    }

    if (relation === 0 && trade.side === "BID") {
      recovery.qualifyingVolume += trade.amount;

      if (recovery.qualifyingVolume >= recovery.requiredFlow) {
        const finalUSDT =
          recovery.pearlReceived * recovery.recoveryTarget * (1 - SELL_FEE);

        finalizeRecoveryPosition(recovery, {
          reason: "RECOVERY_BREAK_EVEN_EXIT",
          sellPrice: recovery.recoveryTarget,
          finalUSDT,
          market: false,
          fillMeta: {
            method: "AT_LIMIT_QUEUE_CONSUMED",
            tradePrice: trade.price,
            tradeSide: trade.side,
            tradeSource: source,
            tradeExchangeTime: causal.tradeExchangeTime,
            tradeExchangeTimeMs: causal.tradeExchangeTimeMs,
            tradeObservedAt: causal.tradeObservedAt,
            tradeObservationBatchId: causal.batchId,
            causalAgeMs: causal.causalAgeMs,
            exchangeAgeVsOrderMs: causal.exchangeAgeVsOrderMs
          }
        });
      }
    }
  }
}

function checkRecoveryHardStops() {
  if (!state.recoveryPositions.length) return false;
  let exited = false;
  const now = Date.now();

  for (const recovery of [...state.recoveryPositions]) {
    const simulated = simulateMarketSell(recovery.pearlReceived);
    if (!simulated) continue;

    const dangerThreshold =
      recovery.investedUSDT * (1 - RECOVERY_DANGER_PCT);
    const netValue = simulated.netUSDT;
    const lossPct = netValue / recovery.investedUSDT - 1;

    // --------------------------------------------------------
    // 1) -10% SOLO ARMA RECOVERY_DANGER. NO VENDE.
    // --------------------------------------------------------
    if (netValue <= dangerThreshold + 1e-9 && !recovery.dangerArmedAtMs) {
      recovery.status = "RECOVERY_DANGER";
      recovery.dangerArmedAtMs = now;
      recovery.dangerArmedAt = iso(now);
      state.recoveryDangerArmed = (state.recoveryDangerArmed || 0) + 1;

      logEvent("⚠️ RECOVERY DANGER ARMED -10% — HOLD", {
        recoveryId: recovery.id,
        entryPrice: recovery.entryPrice,
        investedUSDT: num(recovery.investedUSDT),
        estimatedSellPrice: num(simulated.avgPrice, 6),
        estimatedNetUSDT: num(netValue),
        dangerThresholdNetUSDT: num(dangerThreshold),
        lossPct: pct(lossPct),
        low24hAnchor: num(recovery.low24hAnchor, 6),
        hardStopBreakPrice: num(recovery.hardStopBreakPrice, 6),
        action: "HOLD_AND_WATCH_ANCHORED_24H_SUPPORT"
      });
      saveState();
    }

    // Hasta llegar al -10% no existe posibilidad de hard stop.
    if (!recovery.dangerArmedAtMs) continue;

    const anchor = Number(recovery.low24hAnchor);
    const hardStopBreakPrice = Number(
      recovery.hardStopBreakPrice ??
      (Number.isFinite(anchor) ? anchor * (1 - RECOVERY_ANCHOR_BREAK_PCT) : NaN)
    );

    // Si no pudimos capturar un low24h válido, fail-closed: HOLD.
    if (!Number.isFinite(anchor) || anchor <= 0 || !Number.isFinite(hardStopBreakPrice)) {
      continue;
    }

    const referencePrice = Number(bestBid() ?? simulated.avgPrice);
    if (!Number.isFinite(referencePrice) || referencePrice <= 0) continue;

    // --------------------------------------------------------
    // 2) TOCAR low24hAnchor NO ES STOP.
    // El stop solo empieza a confirmarse 1.5% DEBAJO del anchor.
    // Cualquier reclaim del nivel de ruptura reinicia el reloj.
    // --------------------------------------------------------
    if (referencePrice > hardStopBreakPrice + PRICE_EPSILON) {
      if (recovery.anchorBreakBelowSinceMs) {
        recovery.lastAnchorReclaimAtMs = now;
        recovery.lastAnchorReclaimAt = iso(now);
        recovery.anchorBreakBelowSinceMs = null;
        recovery.anchorBreakBelowSince = null;
        state.recoveryAnchorBreakReclaims =
          (state.recoveryAnchorBreakReclaims || 0) + 1;

        logEvent("↩️ RECOVERY ANCHOR BREAK RECLAIMED — HOLD", {
          recoveryId: recovery.id,
          referencePrice: num(referencePrice, 6),
          low24hAnchor: num(anchor, 6),
          hardStopBreakPrice: num(hardStopBreakPrice, 6),
          action: "RESET_2MIN_BREAK_CONFIRMATION"
        });
        saveState();
      }
      continue;
    }

    if (!recovery.anchorBreakBelowSinceMs) {
      recovery.anchorBreakBelowSinceMs = now;
      recovery.anchorBreakBelowSince = iso(now);
      state.recoveryAnchorBreaksStarted =
        (state.recoveryAnchorBreaksStarted || 0) + 1;

      logEvent("🔻 RECOVERY ANCHORED SUPPORT BREAK — CONFIRMING", {
        recoveryId: recovery.id,
        referencePrice: num(referencePrice, 6),
        low24hAnchor: num(anchor, 6),
        hardStopBreakPrice: num(hardStopBreakPrice, 6),
        requiredBelowSeconds: RECOVERY_ANCHOR_BREAK_CONFIRM_MS / 1000,
        action: "HOLD_DURING_CONFIRMATION"
      });
      saveState();
      continue;
    }

    const belowMs = now - recovery.anchorBreakBelowSinceMs;
    if (belowMs < RECOVERY_ANCHOR_BREAK_CONFIRM_MS) continue;

    // --------------------------------------------------------
    // 3) Después de ~2 min debajo, todavía exigimos presión vendedora.
    // Sin presión fuerte, seguimos esperando: no vendemos por un wick lento.
    // --------------------------------------------------------
    const flow5m = flowMetrics(now, FLOW_WINDOW_MS);
    const flow30s = flowMetrics(now, FAST_FLOW_WINDOW_MS);
    const strongSellPressure =
      flow5m.askShare !== null &&
      flow5m.askShare >= RECOVERY_ANCHOR_ASK_SHARE_5M &&
      flow30s.askShare !== null &&
      flow30s.askShare >= RECOVERY_ANCHOR_ASK_SHARE_30S;

    if (!strongSellPressure) continue;

    // referencePrice sigue debajo del break porque cualquier reclaim habría
    // reiniciado el reloj arriba. Aquí sí invalidamos el soporte anclado.
    logEvent("🛑 RECOVERY HARD STOP — ANCHORED 24H SUPPORT FAILED", {
      recoveryId: recovery.id,
      entryPrice: recovery.entryPrice,
      investedUSDT: num(recovery.investedUSDT),
      estimatedSellPrice: num(simulated.avgPrice, 6),
      estimatedNetUSDT: num(simulated.netUSDT),
      lossPct: pct(lossPct),
      low24hAnchor: num(anchor, 6),
      hardStopBreakPrice: num(hardStopBreakPrice, 6),
      belowAnchorBreakSeconds: num(belowMs / 1000, 1),
      askShare5m: pct(flow5m.askShare),
      askShare30s: pct(flow30s.askShare),
      dangerArmedAt: recovery.dangerArmedAt,
      anchorBreakBelowSince: recovery.anchorBreakBelowSince,
      reason: "DANGER_PLUS_CONFIRMED_ANCHORED_SUPPORT_FAILURE"
    });

    finalizeRecoveryPosition(recovery, {
      reason: "RECOVERY_HARD_STOP_ANCHORED_SUPPORT_BREAK",
      sellPrice: simulated.avgPrice,
      finalUSDT: simulated.netUSDT,
      market: true
    });
    exited = true;
  }

  return exited;
}

// ============================================================
// RISK EXIT — SIN HORARIOS
// ============================================================

function maybeRiskExit(positionId, placementContext = null) {
  const position = openScalpPositions().find((p) => p.id === positionId);
  if (!position) return false;

  const bid = bestBid();
  if (!bid) return false;

  const now = Date.now();
  const flow5m = flowMetrics(now, FLOW_WINDOW_MS);
  const flow30s = flowMetrics(now, FAST_FLOW_WINDOW_MS);
  const momentum30s = priceMomentum(now, FAST_FLOW_WINDOW_MS);
  const holdMs = now - position.entryTimeMs;
  const priceMove = bid / position.entryPrice - 1;
  const support = position.structuralSupportAtEntry;

  if (holdMs >= STOP_MIN_HOLD_MS && Number.isFinite(support) && support > 0) {
    const structuralBreakPrice = support * (1 - STRUCTURAL_STOP_BREAK_PCT);
    const confirmed =
      bid <= structuralBreakPrice &&
      flow5m.askShare !== null && flow5m.askShare >= STOP_ASK_SHARE &&
      flow30s.askShare !== null && flow30s.askShare >= STRUCTURAL_STOP_FAST_ASK_SHARE &&
      momentum30s.move !== null && momentum30s.move <= -STRUCTURAL_STOP_MIN_DROP_30S;

    if (confirmed) {
      return moveActivePositionToRecovery(positionId, "CONFIRMED_SUPPORT_BREAK", placementContext);
    }
  }

  if (
    holdMs >= STOP_MIN_HOLD_MS &&
    flow5m.askShare !== null &&
    flow5m.askShare >= STOP_ASK_SHARE &&
    priceMove <= -STOP_PRICE_DROP
  ) {
    return protectedMarketExit(positionId, "SELL_PRESSURE");
  }

  return false;
}

// ============================================================
// DRAWDOWN
// ============================================================

function updateDrawdown() {
  const equity = currentEquity();

  if (!Number.isFinite(equity)) return;

  if (equity > state.highestEquity) {
    state.highestEquity = equity;
  }

  const dd =
    state.highestEquity > 0
      ? (state.highestEquity - equity) / state.highestEquity
      : 0;

  state.maxDrawdown = Math.max(state.maxDrawdown, dd);
}

// ============================================================
// 24H SUMMARY
// ============================================================

function testTiming() {
  const elapsedMs = Date.now() - state.testStartedAtMs;

  return {
    elapsedMs,
    elapsedHours: elapsedMs / 3600000,
    remainingHours: Math.max(0, (TEST_DURATION_MS - elapsedMs) / 3600000),
    complete: elapsedMs >= TEST_DURATION_MS
  };
}

function maybeMark24hComplete() {
  const timing = testTiming();

  if (!timing.complete || state.test24hCompleteLogged) {
    return;
  }

  state.test24hCompleteLogged = true;
  state.test24hCompletedAt = iso();

  const summary = {
    version: "5.1.8.3",
    testStartedAt: state.testStartedAt,
    testCompletedAt: state.test24hCompletedAt,
    elapsedHours: timing.elapsedHours,

    startCapital: START_CAPITAL,
    totalContributed: state.capitalContributed,
    scalpCash: state.cash,
    pearl: state.pearl,
    mode: state.mode,
    equity: currentEquity(),
    totalROI: state.capitalContributed > 0
      ? currentEquity() / state.capitalContributed - 1
      : null,
    realizedProfit: state.realizedProfit,
    recoveryEquity: recoveryEquity(),
    recoveryPositions: state.recoveryPositions,
    breakdownLocks: state.breakdownLocks,

    cycles: state.cycles,

    buyOrdersPlaced: state.buyOrdersPlaced,
    buyOrdersCancelled: state.buyOrdersCancelled,
    buyOrdersFilled: state.buyOrdersFilled,
    buyOrdersExpired: state.buyOrdersExpired || 0,

    sellOrdersPlaced: state.sellOrdersPlaced || 0,
    sellOrdersFilled: state.sellOrdersFilled,
    targetExits: state.targetExits,
    stopExits: state.stopExits,
    capitalProtectedStops: state.capitalProtectedStops,
    capitalFloorBlockedStops: state.capitalFloorBlockedStops,
    structuralStopExits: state.structuralStopExits || 0,
    recoveryHoldsStarted: state.recoveryHoldsStarted || 0,
    recoveryBreakEvenExits: state.recoveryBreakEvenExits || 0,
    recoveryHardStops: state.recoveryHardStops || 0,
    recoveryDangerArmed: state.recoveryDangerArmed || 0,
    recoveryAnchorBreaksStarted: state.recoveryAnchorBreaksStarted || 0,
    recoveryAnchorBreakReclaims: state.recoveryAnchorBreakReclaims || 0,
    breakdownLocksCreated: state.breakdownLocksCreated || 0,
    breakdownLocksReleased: state.breakdownLocksReleased || 0,
    highRangeCautionOrders: state.highRangeCautionOrders || 0,
    fallingMarketLock: state.fallingMarketLock,
    fallingMarketLocksCreated: state.fallingMarketLocksCreated || 0,
    fallingMarketLocksReleased: state.fallingMarketLocksReleased || 0,
    fallingMarketEntriesBlocked: state.fallingMarketEntriesBlocked || 0,
    ticker24h,
    peakRealizedProfit: state.peakRealizedProfit,
    protectedCapitalFloor: protectedCapitalFloor(),

    highestEquity: state.highestEquity,
    maxDrawdown: state.maxDrawdown,

    openPosition: state.position,
    openPositions: openScalpPositions(),
    openScalpPositionCount: openScalpPositions().length,
    positionSpacingBlocks: state.positionSpacingBlocks || 0,
    minimumPositionSpacingPct: MIN_POSITION_SPACING_PCT,
    pendingBuy: state.buyOrder,
    openRecoveries: state.recoveryPositions
  };

  fs.writeFileSync(
    SUMMARY_24H_FILE,
    JSON.stringify(summary, null, 2),
    "utf8"
  );

  logEvent("🏁 24H TEST COMPLETE", {
    summaryFile: SUMMARY_24H_FILE,
    equity: num(summary.equity),
    totalROI: pct(summary.totalROI),
    cycles: summary.cycles,
    realizedProfit: num(summary.realizedProfit),
    maxDrawdown: pct(summary.maxDrawdown)
  });

  saveState();
}

// ============================================================
// LIVE READY
// ============================================================

let gotDepthSnapshot = false;
let gotTradesSnapshot = false;
let gotLiveTrade = false;
let liveReady = false;
let lastWsLiveTradeAtMs = null;
let lastAnyLiveTradeAtMs = null;
let lastLiveTradeSource = null;
let wsLiveTradesReceived = 0;
let restLiveTradesReceived = 0;
let tradesRestTimer = null;
let tradesRestBootstrapped = false;
let lastTradesRestErrorLogMs = 0;

function maybeReady() {
  if (!liveReady && gotDepthSnapshot && (gotTradesSnapshot || gotLiveTrade || tradesRestBootstrapped)) {
    liveReady = true;

    logEvent("✅ V5.1.8.3 READY", {
      historyTrades: recentTrades.length,
      bestBid: bestBid(),
      bestAsk: bestAsk(),
      ticker24hReady: Boolean(ticker24h),
      tradeBootstrap: gotTradesSnapshot ? "WS_SNAPSHOT" : (gotLiveTrade ? "WS_LIVE" : "REST_TRADES"),
      targetGross: pct(TARGET_GROSS),
      testMode: "24H_CONTINUOUS"
    });
  }
}

// ============================================================
// LIVE TRADE
// ============================================================

function processLiveTrade(rawTrade, source = "WS", observationMeta = {}) {
  const trade = normalizeTrade(rawTrade);

  if (
    !Number.isFinite(trade.time) ||
    !Number.isFinite(trade.price) ||
    !Number.isFinite(trade.amount)
  ) {
    return;
  }

  const now = Date.now();
  gotLiveTrade = true;
  lastAnyLiveTradeAtMs = now;
  lastLiveTradeSource = source;

  if (source === "WS") {
    lastWsLiveTradeAtMs = now;
    wsLiveTradesReceived++;
  } else if (source === "REST_FALLBACK") {
    restLiveTradesReceived++;
  }

  maybeReady();

  const key = tradeKey(rawTrade);
  if (seenTrades.has(key)) return;
  seenTrades.add(key);

  liveTradesSinceProcessStart.push({
    time: trade.time,
    price: trade.price,
    amount: trade.amount,
    side: trade.side,
    observedAtMs: now,
    source
  });
  while (
    liveTradesSinceProcessStart.length &&
    liveTradesSinceProcessStart[0].observedAtMs < now - 30 * 60 * 1000
  ) {
    liveTradesSinceProcessStart.shift();
  }

  recentTrades.push(trade);
  recentTrades.sort((a, b) => a.time - b.time);
  trimHistory(trade.time);

  const preEntryLockCreated = maybeActivatePreEntryFallingLock(trade.price);
  if (preEntryLockCreated && state.buyOrder) {
    cancelBuy("PREENTRY_HARD_FALLING_MARKET_LOCK");
  }

  updateFallingMarketLock(trade.price);
  updateBreakdownLocks(trade.price);
  processRecoveryTrade(trade, source, observationMeta);
  checkRecoveryHardStops();

  // ==========================================================
  // ÚNICA BUY LIMIT PENDIENTE — puede coexistir con varias SELL.
  // ==========================================================
  if (state.buyOrder) {
    const order = state.buyOrder;
    const causal = causalFillAudit(order, trade, source, observationMeta);

    if (!causal.ok) {
      const relation = priceRelation(trade.price, order.price);
      if (relation < 0 || (relation === 0 && trade.side === "ASK")) {
        state.causalBuyFillsBlocked = (state.causalBuyFillsBlocked || 0) + 1;
        logEvent("⏱️ BUY FILL BLOCKED BY CAUSALITY", {
          orderPrice: order.price,
          tradePrice: trade.price,
          tradeSide: trade.side,
          ...causal
        });
      }
    } else {
      const pendingFalling = preEntryFallingContext(trade.price);

      if (
        pendingFalling.softCaution &&
        Number(order.allocationFraction || 1) > SOFT_FALLING_CAPITAL_FRACTION + 1e-9
      ) {
        logEvent("🟠 PENDING BUY RESIZED — SOFT FALLING CAUTION", {
          orderPrice: order.price,
          target: order.target,
          tradePrice: trade.price,
          previousAllocationFraction: pct(order.allocationFraction || 1),
          nextAllocationFraction: pct(SOFT_FALLING_CAPITAL_FRACTION),
          move4m: pct(pendingFalling.move4m),
          move5m: pct(pendingFalling.move5m),
          move10m: pct(pendingFalling.move10m),
          action: "CANCEL_AND_REARM_AT_30PCT"
        });
        cancelBuy("SOFT_FALLING_CAUTION_RESIZE");
      }

      if (state.buyOrder) {
        const pendingZone = entryZoneContext(order.price, earlyArmMetric());
        const pendingSpacing = positionSpacingContext(order.price);

        if (!pendingZone.ok || !pendingSpacing.ok) {
          logEvent(
            !pendingSpacing.ok
              ? "↔️ PENDING BUY CANCELLED BY POSITION SPACING"
              : "🚫 PENDING BUY CANCELLED BY V5.1.8.3 ENTRY ZONE",
            {
              orderPrice: order.price,
              target: order.target,
              nearestEntry: pendingSpacing.nearestEntry,
              nearestDistance: pct(pendingSpacing.nearestDistancePct),
              high24h: pendingZone.ladder.high24h,
              maxBuyExclusive: pendingZone.ladder.maxBuyExclusive,
              nextUnlockResistance: pendingZone.ladder.nextUnlockResistance,
              rangePosition24h: pendingZone.range.rangePosition24h,
              rangeMode: pendingZone.range.mode,
              ladderReason: pendingZone.ladder.reason,
              rangeReason: pendingZone.range.reason
            }
          );
          cancelBuy(!pendingSpacing.ok ? "POSITION_SPACING_RELOCKED" : "ENTRY_ZONE_RELOCKED");
        }
      }

      if (state.buyOrder) {
        if (!order.hardSignalConfirmedAt) {
          const hardSignalNow = buildHardSignal(true);
          if (hardSignalNow?.ok) {
            order.hardSignalConfirmedAt = iso();
            order.hardSignalConfirmedAtMs = Date.now();
            state.hardSignalsConfirmedWhileArmed =
              (state.hardSignalsConfirmedWhileArmed || 0) + 1;

            logEvent("✅ HARD SIGNAL CONFIRMED WHILE ARMED", {
              orderPrice: order.price,
              target: order.target,
              orderAgeSeconds: num((Date.now() - order.firstPlacedAtMs) / 1000, 2),
              marketPrice: trade.price,
              tradeExchangeTime: causal.tradeExchangeTime,
              tradeObservedAt: causal.tradeObservedAt,
              causalAgeMs: causal.causalAgeMs,
              hardConditions: hardSignalNow.conditions
            });
          }
        }

        if (Date.now() - order.firstPlacedAtMs >= BUY_TTL_MS) {
          cancelBuy("TTL_EXPIRED");
        }
      }

      if (state.buyOrder) {
        const buyRelation = priceRelation(trade.price, order.price);

        if (buyRelation < 0) {
          logEvent("⚡ BUY CROSS-THROUGH FILL", {
            orderPrice: order.price,
            tradePrice: trade.price,
            tradeSide: trade.side,
            tradeSource: source,
            queueAhead: order.queueAhead,
            qualifyingVolumeBeforeFill: order.qualifyingVolume,
            orderPlacedAt: causal.orderPlacedAt,
            tradeExchangeTime: causal.tradeExchangeTime,
            tradeObservedAt: causal.tradeObservedAt,
            causalAgeMs: causal.causalAgeMs,
            exchangeAgeVsOrderMs: causal.exchangeAgeVsOrderMs
          });

          fillBuy({
            method: "CROSS_THROUGH",
            tradePrice: trade.price,
            tradeSide: trade.side,
            tradeSource: source,
            tradeExchangeTime: causal.tradeExchangeTime,
            tradeExchangeTimeMs: causal.tradeExchangeTimeMs,
            tradeObservedAt: causal.tradeObservedAt,
            tradeObservationBatchId: causal.batchId,
            causalAgeMs: causal.causalAgeMs,
            exchangeAgeVsOrderMs: causal.exchangeAgeVsOrderMs
          });
        } else if (buyRelation === 0 && trade.side === "ASK") {
          order.qualifyingVolume += trade.amount;

          if (order.qualifyingVolume >= order.requiredFlow) {
            fillBuy({
              method: "AT_LIMIT_QUEUE_CONSUMED",
              tradePrice: trade.price,
              tradeSide: trade.side,
              tradeSource: source,
              tradeExchangeTime: causal.tradeExchangeTime,
              tradeExchangeTimeMs: causal.tradeExchangeTimeMs,
              tradeObservedAt: causal.tradeObservedAt,
              tradeObservationBatchId: causal.batchId,
              causalAgeMs: causal.causalAgeMs,
              exchangeAgeVsOrderMs: causal.exchangeAgeVsOrderMs
            });
          }
        }
      }

      if (state.buyOrder) {
        const flow5m = flowMetrics();
        const flow30s = flowMetrics(Date.now(), FAST_FLOW_WINDOW_MS);
        const momentum30s = priceMomentum(Date.now(), FAST_FLOW_WINDOW_MS);
        const orderAgeMs = Date.now() - order.firstPlacedAtMs;
        const breakPrice = order.price * (1 - PENDING_BREAK_BELOW_BUY);
        const distanceFromBuy = trade.price / order.price - 1;
        const graceElapsed = orderAgeMs >= PENDING_CANCEL_GRACE_MS;
        const materiallyBelowBuy = trade.price <= breakPrice;
        const fastSellPressure =
          flow30s.askShare !== null &&
          flow30s.askShare >= PENDING_CANCEL_FAST_ASK_SHARE;
        const fastPriceStillFalling =
          momentum30s.move !== null &&
          momentum30s.move <= -PENDING_CANCEL_MIN_DROP_30S;

        if (
          graceElapsed &&
          materiallyBelowBuy &&
          fastSellPressure &&
          fastPriceStillFalling
        ) {
          logEvent("⚠️ BUY STRUCTURAL BREAK CONFIRMED", {
            orderPrice: order.price,
            breakPrice,
            marketPrice: trade.price,
            distanceFromBuy,
            orderAgeSeconds: orderAgeMs / 1000,
            askShare5m: flow5m.askShare,
            bidShare5m: flow5m.bidShare,
            askShare30s: flow30s.askShare,
            bidShare30s: flow30s.bidShare,
            priceMove30s: momentum30s.move
          });

          cancelBuy("STRUCTURAL_BREAK_BELOW_BUY");
        }
      }
    }
  }

  // ==========================================================
  // TODAS LAS SELL LIMIT ABIERTAS — independientes por posición.
  // ==========================================================
  for (const position of [...openScalpPositions()]) {
    const sell = position.sellOrder;
    if (!sell) continue;

    const causal = causalFillAudit(sell, trade, source, observationMeta);
    const sellRelation = priceRelation(trade.price, sell.price);

    if (!causal.ok) {
      if (sellRelation > 0 || (sellRelation === 0 && trade.side === "BID")) {
        state.causalSellFillsBlocked = (state.causalSellFillsBlocked || 0) + 1;
        logEvent("⏱️ SELL FILL BLOCKED BY CAUSALITY", {
          positionId: position.id,
          orderPrice: sell.price,
          tradePrice: trade.price,
          tradeSide: trade.side,
          ...causal
        });
      }
      continue;
    }

    if (sellRelation > 0) {
      logEvent("⚡ SELL CROSS-THROUGH FILL", {
        positionId: position.id,
        orderPrice: sell.price,
        tradePrice: trade.price,
        tradeSide: trade.side,
        tradeSource: source,
        queueAhead: sell.queueAhead,
        qualifyingVolumeBeforeFill: sell.qualifyingVolume,
        orderPlacedAt: causal.orderPlacedAt,
        tradeExchangeTime: causal.tradeExchangeTime,
        tradeObservedAt: causal.tradeObservedAt,
        causalAgeMs: causal.causalAgeMs,
        exchangeAgeVsOrderMs: causal.exchangeAgeVsOrderMs
      });

      normalTargetSell(position.id, {
        method: "CROSS_THROUGH",
        tradePrice: trade.price,
        tradeSide: trade.side,
        tradeSource: source,
        tradeExchangeTime: causal.tradeExchangeTime,
        tradeExchangeTimeMs: causal.tradeExchangeTimeMs,
        tradeObservedAt: causal.tradeObservedAt,
        tradeObservationBatchId: causal.batchId,
        causalAgeMs: causal.causalAgeMs,
        exchangeAgeVsOrderMs: causal.exchangeAgeVsOrderMs
      });
      continue;
    }

    if (sellRelation === 0 && trade.side === "BID") {
      sell.qualifyingVolume += trade.amount;

      if (sell.qualifyingVolume >= sell.requiredFlow) {
        normalTargetSell(position.id, {
          method: "AT_LIMIT_QUEUE_CONSUMED",
          tradePrice: trade.price,
          tradeSide: trade.side,
          tradeSource: source,
          tradeExchangeTime: causal.tradeExchangeTime,
          tradeExchangeTimeMs: causal.tradeExchangeTimeMs,
          tradeObservedAt: causal.tradeObservedAt,
          tradeObservationBatchId: causal.batchId,
          causalAgeMs: causal.causalAgeMs,
          exchangeAgeVsOrderMs: causal.exchangeAgeVsOrderMs
        });
        continue;
      }
    }

    maybeRiskExit(position.id, {
      batchId: observationMeta?.batchId ?? null,
      tradeTimeMs: trade.time,
      source
    });
  }

  // ==========================================================
  // NUEVA BUY — mismas protecciones aunque existan SELL abiertas.
  // ==========================================================
  if (!state.buyOrder && state.cash >= MIN_SCALP_CASH_USDT) {
    const startup = startupContextStatus(trade.price);
    if (!startup.ready) return;

    maybeActivatePreEntryFallingLock(trade.price);
    if (activeFallingMarketLock()) return;

    const earlySignal = buildEarlyArmSignal();
    if (earlySignal?.ok) {
      placeBuyLimit(earlySignal, {
        batchId: observationMeta?.batchId ?? null,
        tradeTimeMs: trade.time,
        source
      });
    }
  }
}

// ============================================================
// V5.1.8.3 — LIVE TRADE EXTRACTION + REST FALLBACK
// ============================================================

function extractLiveTradeUpdates(msg) {
  const out = [];
  const push = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) if (item) out.push(item);
    } else {
      out.push(value);
    }
  };

  // Formato usado históricamente por BigONE v2.
  push(msg?.tradeUpdate?.trade);
  push(msg?.tradeUpdate?.trades);

  // Variantes defensivas para cambios de envelope sin romper el bot.
  push(msg?.tradesUpdate?.trade);
  push(msg?.tradesUpdate?.trades);
  push(msg?.marketTradeUpdate?.trade);
  push(msg?.marketTradeUpdate?.trades);
  push(msg?.marketTradesUpdate?.trade);
  push(msg?.marketTradesUpdate?.trades);

  return out;
}

function restTradeToWsShape(raw) {
  return {
    id: raw?.id,
    market: MARKET,
    price: raw?.price,
    amount: raw?.amount,
    takerSide: raw?.takerSide ?? raw?.taker_side,
    createdAt: raw?.createdAt ?? raw?.inserted_at ?? raw?.insertedAt
  };
}

async function refreshTradesRest(reason = "POLL") {
  try {
    const response = await fetch(TRADES_REST_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const payload = await response.json();
    const rows = Array.isArray(payload) ? payload : (payload?.data ?? []);
    if (!Array.isArray(rows)) throw new Error("trades payload is not an array");

    const normalizedRows = rows
      .map(restTradeToWsShape)
      .filter((t) => Number.isFinite(new Date(t.createdAt).getTime()))
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    // Primer poll: solo bootstrap histórico. Nunca llena órdenes.
    if (!tradesRestBootstrapped) {
      for (const trade of normalizedRows) addHistoricalTrade(trade);
      tradesRestBootstrapped = true;
      maybeReady();
      return true;
    }

    // V5.1.8.3: todos los trades de esta respuesta REST comparten el MISMO
    // momento de observación. Si una orden nace mientras procesamos este lote,
    // ningún otro trade del mismo lote puede llenarla: ya estaba recibido.
    const observedAtMs = Date.now();
    const batchId = makeObservationBatchId(`REST_${reason}`, observedAtMs);

    for (const trade of normalizedRows) {
      const key = tradeKey(trade);
      if (seenTrades.has(key)) continue;
      processLiveTrade(trade, "REST_FALLBACK", { observedAtMs, batchId });
    }

    return true;
  } catch (error) {
    const now = Date.now();
    if (now - lastTradesRestErrorLogMs >= 5 * 60 * 1000) {
      lastTradesRestErrorLogMs = now;
      console.log("⚠️ trades REST fallback failed:", error.message);
    }
    return false;
  }
}

// ============================================================
// WEBSOCKET
// ============================================================

let ws = null;
let pingTimer = null;
let reconnectTimer = null;

function connect() {
  gotDepthSnapshot = false;
  gotTradesSnapshot = false;
  gotLiveTrade = false;
  liveReady = false;

  console.log("\n🔌 Conectando V5.1.8.3...");

  ws = new WebSocket(WS_URL, "json", {
    handshakeTimeout: 15000,
    perMessageDeflate: false
  });

  ws.on("open", () => {
    console.log("✅ BIGONE CONNECTED V5.1.8.3");

    ws.send(
      JSON.stringify({
        requestId: "v514-depth",
        subscribeMarketDepthRequest: {
          market: MARKET
        }
      })
    );

    ws.send(
      JSON.stringify({
        requestId: "v514-trades",
        subscribeMarketTradesRequest: {
          market: MARKET,
          limit: 200
        }
      })
    );

    ws.send(
      JSON.stringify({
        requestId: "v514-ticker",
        subscribeMarketsTickerRequest: {
          markets: [MARKET]
        }
      })
    );

    // WebSocket es la fuente principal. REST sirve como bootstrap/fallback
    // para garantizar high/low 24h incluso si el formato push cambia.
    refreshTicker24hRest("BOOTSTRAP");

    clearInterval(tickerRestTimer);
    tickerRestTimer = setInterval(() => {
      refreshTicker24hRest("POLL");
    }, 60 * 1000);

    // Bootstrap/fallback de trades públicos. El primer fetch solo llena
    // contexto histórico; desde el segundo poll solo procesa trades nuevos.
    refreshTradesRest("BOOTSTRAP");
    clearInterval(tradesRestTimer);
    tradesRestTimer = setInterval(() => {
      const wsStale =
        lastWsLiveTradeAtMs === null ||
        Date.now() - lastWsLiveTradeAtMs >= 10 * 1000;

      if (wsStale) refreshTradesRest("POLL");
    }, 5 * 1000);

    clearInterval(pingTimer);

    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 20000);
  });

  ws.on("message", (raw) => {
    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // --------------------------------------------------------
    // DEPTH SNAPSHOT
    // --------------------------------------------------------

    if (msg.depthSnapshot?.depth) {
      bids.clear();
      asks.clear();

      applyLevels(bids, msg.depthSnapshot.depth.bids);
      applyLevels(asks, msg.depthSnapshot.depth.asks);

      gotDepthSnapshot = true;
      maybeReady();
    }

    // --------------------------------------------------------
    // DEPTH UPDATE
    // --------------------------------------------------------

    if (msg.depthUpdate?.depth) {
      applyLevels(bids, msg.depthUpdate.depth.bids);
      applyLevels(asks, msg.depthUpdate.depth.asks);

      updateDrawdown();
      checkRecoveryHardStops();

      for (const position of [...openScalpPositions()]) {
        maybeRiskExit(position.id);
      }
    }

    // --------------------------------------------------------
    // ROLLING 24H TICKER
    // --------------------------------------------------------

    handleTickerWsMessage(msg);

    // --------------------------------------------------------
    // HISTORICAL TRADES SNAPSHOT
    // Nunca llena órdenes.
    // --------------------------------------------------------

    if (msg.tradesSnapshot?.trades) {
      const history = [...msg.tradesSnapshot.trades].sort(
        (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
      );

      for (const trade of history) {
        addHistoricalTrade(trade);
      }

      gotTradesSnapshot = true;
      maybeReady();
    }

    // --------------------------------------------------------
    // LIVE TRADE
    // Solo estos pueden llenar órdenes.
    // --------------------------------------------------------

    const liveTrades = extractLiveTradeUpdates(msg);
    if (liveTrades.length) {
      const observedAtMs = Date.now();
      const batchId = makeObservationBatchId("WS", observedAtMs);

      for (const trade of liveTrades) {
        // Todos los trades contenidos en el mismo mensaje comparten batch.
        // Una orden creada por uno de ellos no puede ser llenada retroactivamente
        // por otro trade que ya venía dentro del mismo mensaje recibido.
        processLiveTrade(trade, "WS", { observedAtMs, batchId });
      }
    }
  });

  ws.on("error", (error) => {
    logEvent("❌ WS ERROR", {
      message: error.message
    });
  });

  ws.on("close", (code, reason) => {
    clearInterval(pingTimer);
    clearInterval(tickerRestTimer);
    clearInterval(tradesRestTimer);

    console.log("🔌 DISCONNECTED", code, reason.toString());

    if (reconnectTimer) return;

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 5000);
  });
}

// ============================================================
// V5.1.8.3 — ENTRY DIAGNOSTICS / MARKET HEALTH
// ============================================================

function entryDiagnostics() {
  const early = buildEarlyArmSignal(true);
  const hard = buildHardSignal(true);

  return {
    earlyArm: early
      ? {
          ok: early.ok,
          buy: early.buyPrice,
          target: early.target,
          distanceToBuy: pct(early.distanceToBuy),
          marketReferenceSource: early.marketReferenceSource ?? null,
          marketSampleCount: early.marketSampleCount ?? null,
          failedConditions: early.failedConditions.join(", ") || null
        }
      : null,
    hardSignal: hard
      ? {
          ok: hard.ok,
          buy: hard.buyPrice,
          target: hard.target,
          failedConditions: hard.failedConditions.join(", ") || null
        }
      : null
  };
}

let latestStatusObject = null;

function activeFallingLockSnapshot(currentPrice, stability) {
  const lock = activeFallingMarketLock();
  return lock
    ? {
        active: true,
        id: lock.id,
        lowSinceLock: num(lock.lowSinceLock, 4),
        low24h: num(ticker24h?.low, 4),
        lockAgeMinutes: num(stability.lockAgeMinutes, 2),
        minutesSinceMeaningfulNewLow: num(stability.minutesSinceMeaningfulNewLow, 2),
        stableEnough: stability.stableEnough,
        failedConditions: stability.failedConditions?.join(", ") || null,
        move10m: pct(stability.move10m),
        move5m: pct(stability.move5m),
        momentum30s: pct(stability.momentum30s),
        askShare5m: pct(stability.askShare5m),
        bounceFromLow5m: pct(stability.bounceFromLow5m),
        reservedCash: num(state.cash),
        currentPrice,
      }
    : { active: false, stableEnough: false };
}

function liveJsonStatus() {
  const base = latestStatusObject || {};
  const metric = metrics();
  const displayMetric = metric ?? earlyArmMetric();
  const marketRef = marketReferencePrice();
  const currentPrice = displayMetric?.current ?? marketRef?.price ?? null;
  const flow5m = flowMetrics();
  const flow30s = flowMetrics(Date.now(), FAST_FLOW_WINDOW_MS);
  const momentum30s = priceMomentum(Date.now(), FAST_FLOW_WINDOW_MS);
  const diag = entryDiagnostics();
  const timing = testTiming();
  const supportPreview = supportContext60m(currentPrice);
  const rangePosition24h = tickerRangePosition24h(currentPrice);
  const previewBuyPrice = proposedBuyPrice();
  const previewTarget = previewBuyPrice ? roundUp(previewBuyPrice * (1 + TARGET_GROSS)) : null;
  const startup = startupContextStatus(currentPrice);
  const preEntry = preEntryFallingContext(currentPrice);
  const highRange = highRangeCautionContext(displayMetric);
  const stability = fallingMarketStabilityContext(currentPrice);
  const zone = entryZoneContext(previewBuyPrice, displayMetric);
  const allocation = previewBuyPrice ? scalpAllocation({ buyPrice: previewBuyPrice, metric: displayMetric }) : null;

  const pendingFillProgress =
    state.buyOrder && state.buyOrder.requiredFlow > 0
      ? state.buyOrder.qualifyingVolume / state.buyOrder.requiredFlow
      : null;

  return {
    ...base,
    generatedAt: iso(),
    processId: process.pid,
    version: "5.1.8.3",
    localTime: localClock().text,
    testMode: "24H_CONTINUOUS",
    testElapsedHours: num(timing.elapsedHours, 2),
    testRemainingHours: num(timing.remainingHours, 2),
    test24hComplete: state.test24hCompleteLogged,
    mode: state.mode,
    scalpCash: num(state.cash),
    capitalContributed: num(state.capitalContributed),
    pearl: num(state.pearl),
    recoveryEquity: num(recoveryEquity()),
    equity: num(currentEquity()),
    ROI: state.capitalContributed > 0 ? pct(currentEquity() / state.capitalContributed - 1) : null,
    realizedProfit: num(state.realizedProfit),
    cycles: state.cycles,
    targetGross: pct(TARGET_GROSS),
    lastPrice: currentPrice,
    recentLow: displayMetric?.low ?? null,
    recentHigh: displayMetric?.high ?? null,
    marketDataHealth: {
      ...(base.marketDataHealth || {}),
      marketReferenceSource: displayMetric?.currentSource ?? marketRef?.source ?? null,
      strict5mMetricsReady: Boolean(metric),
      recentTradeSampleCount: displayMetric?.sampleCount ?? null,
      liveReady,
      lastLiveTradeSource,
      lastLiveTradeAt: lastAnyLiveTradeAtMs ? iso(lastAnyLiveTradeAtMs) : null,
      secondsSinceLiveTrade: lastAnyLiveTradeAtMs ? num((Date.now() - lastAnyLiveTradeAtMs) / 1000, 1) : null,
      wsLiveTradesReceived,
      restLiveTradesReceived,
      restFallbackBootstrapped: tradesRestBootstrapped,
      causalBuyFillsBlocked: state.causalBuyFillsBlocked || 0,
      causalSellFillsBlocked: state.causalSellFillsBlocked || 0,
      causalRecoveryFillsBlocked: state.causalRecoveryFillsBlocked || 0,
    },
    bestBid: bestBid(),
    bestAsk: bestAsk(),
    marketSpreadObserved: pct(marketSpreadObserved()),
    downsideContext: {
      ...(base.downsideContext || {}),
      support60m: num(supportPreview.support?.price, 4),
      supportTouches60m: supportPreview.support?.touches ?? null,
      supportLowerEdge60m: num(supportPreview.support?.lower, 4),
      low60m: num(supportPreview.low60m, 4),
      high60m: num(supportPreview.high60m, 4),
      ticker24hReady: Boolean(ticker24h),
      ticker24hSource: ticker24h?.source ?? null,
      ticker24hUpdatedAt: ticker24h?.updatedAt ?? null,
      open24h: num(ticker24h?.open, 4),
      low24h: num(ticker24h?.low, 4),
      high24h: num(ticker24h?.high, 4),
      close24h: num(ticker24h?.close, 4),
      volume24h: num(ticker24h?.volume, 4),
      rangePosition24h: pct(rangePosition24h),
      distanceFrom24hLow: ticker24h && currentPrice ? pct(currentPrice / ticker24h.low - 1) : null,
      distanceTo24hHigh: ticker24h && currentPrice ? pct(ticker24h.high / currentPrice - 1) : null,
      previewBuy: previewBuyPrice,
      previewTarget,
      priceLadderEntryGate: previewBuyPrice ? priceLadderEntryContext(previewBuyPrice) : null,
      rangePositionEntryGate: previewBuyPrice ? rangePositionEntryContext(previewBuyPrice) : null,
    },
    entryEngine: diag,
    regimeV519: {
      ...(base.regimeV519 || {}),
      startupContext: {
        locked: startup.locked,
        ready: startup.ready,
        elapsedSeconds: num(startup.elapsedSeconds, 1),
        remainingSeconds: num(startup.remainingSeconds, 1),
        liveTrades: startup.liveTrades,
        minimumLiveTrades: startup.minimumLiveTrades,
        timeReady: startup.timeReady,
        samplesReady: startup.samplesReady,
      },
      preEntryFalling: {
        active: preEntry.active,
        regime: preEntry.regime,
        hardLock: preEntry.hardLock,
        softCaution: preEntry.softCaution,
        hardShock: preEntry.hardShock,
        hardSlowBleed: preEntry.hardSlowBleed,
        directionalDrop: preEntry.directionalDrop,
        confirmingVotes: preEntry.confirmingVotes,
        move4m: pct(preEntry.move4m),
        move5m: pct(preEntry.move5m),
        move10m: pct(preEntry.move10m),
        pulledFromHigh: preEntry.pulledFromHigh,
        sellPressure: preEntry.sellPressure,
        microDrop: preEntry.microDrop,
        nearLow: preEntry.nearLow,
      },
      entryStability: (() => {
        const e = entryStabilityContext(currentPrice);
        return {
          ok: e.ok,
          required: e.required,
          stableEnough: e.stableEnough,
          failedConditions: e.failedConditions?.join(", ") || null,
          dropFromHigh15m: pct(e.dropFromHigh15m),
          move10m: pct(e.move10m),
          move5m: pct(e.move5m),
          momentum30s: pct(e.momentum30s),
          askShare5m: pct(e.askShare5m),
          minutesSinceLow: num(e.minutesSinceLow, 2),
          bounceFromLow5m: pct(e.bounceFromLow5m)
        };
      })(),
      entryZone: {
        ok: zone.ok,
        high24h: num(zone.ladder.high24h, 4),
        priceLadderOK: zone.ladder.ok,
        maxBuyExclusive: num(zone.ladder.maxBuyExclusive, 4),
        nextUnlockResistance: num(zone.ladder.nextUnlockResistance, 4),
        buyBandStart: num(zone.ladder.buyBandStart, 4),
        ladderReason: zone.ladder.reason,
        rangePosition24h: pct(zone.range.rangePosition24h),
        rangeMode: zone.range.mode,
        rangeOK: zone.range.ok,
        rangeReason: zone.range.reason,
        capitalFractionIfBuy: allocation ? pct(allocation.fraction) : null,
        effectiveCapitalToUseIfBuy: allocation ? num(allocation.capital) : null,
        multiPositionSlotCapIfBuy: allocation ? num(allocation.slotCap) : null,
        effectiveCashFractionIfBuy: allocation && state.cash > 0 ? pct(allocation.capital / state.cash) : null,
        allocationModeIfBuy: allocation?.mode ?? null,
      },
      highRangeCaution: {
        active: highRange.active,
        rangePosition24h: pct(highRange.rangePosition24h),
        strongRun: highRange.strongRun,
        runFromLow10m: pct(highRange.runFromLow10m),
        runFromLow60m: pct(highRange.runFromLow60m),
        exhaustionVotes: highRange.exhaustionVotes,
        pullback: highRange.pullback,
        lowerHigh: highRange.lowerHigh,
        sellPressure: highRange.sellPressure,
        microDrop: highRange.microDrop,
      },
      fallingMarketLock: activeFallingLockSnapshot(currentPrice, stability),
    },
    earlyArm: diag.earlyArm,
    hardSignal: diag.hardSignal,
    askShare5m: pct(flow5m.askShare),
    bidShare5m: pct(flow5m.bidShare),
    askShare30s: pct(flow30s.askShare),
    bidShare30s: pct(flow30s.bidShare),
    priceMove30s: pct(momentum30s.move),
    openScalpPositions: openScalpPositions().map((p) => ({
      id: p.id,
      entry: p.entryPrice,
      target045: p.sellTarget,
      investedUSDT: num(p.investedUSDT),
      pearl: num(p.pearlReceived),
      allocationMode: p.allocationMode ?? "NORMAL_SCALP",
      heldMinutes: num((Date.now() - p.entryTimeMs) / 60000, 2),
      sellOrderPlacedAt: p.sellOrder?.placedAt ?? null
    })),
    openScalpPositionCount: openScalpPositions().length,
    multiPositionSlotFraction: pct(MULTI_POSITION_MAX_CAPITAL_FRACTION),
    minimumPositionSpacing: pct(MIN_POSITION_SPACING_PCT),

    pendingBuy: state.buyOrder
      ? {
          ...(base.pendingBuy || {}),
          price: state.buyOrder.price,
          target: state.buyOrder.target,
          entrySignalType: state.buyOrder.entrySignalType ?? null,
          allocationMode: state.buyOrder.allocationMode ?? "NORMAL_SCALP",
          capitalToUse: num(state.buyOrder.cash),
          capitalFraction: pct(state.buyOrder.allocationFraction ?? 1),
          multiPositionSlotCap: num(state.buyOrder.multiPositionSlotCap),
          openScalpPositions: openScalpPositions().length,
          hardSignalConfirmed: Boolean(state.buyOrder.hardSignalConfirmedAt),
          ageSeconds: num((Date.now() - state.buyOrder.firstPlacedAtMs) / 1000, 1),
          ttlRemainingSeconds: num(Math.max(0, BUY_TTL_MS - (Date.now() - state.buyOrder.firstPlacedAtMs)) / 1000, 1),
          fillProgress: pct(Math.min(1, pendingFillProgress ?? 0)),
          marketDistanceFromBuy: metric?.current ? pct(metric.current / state.buyOrder.price - 1) : null,
        }
      : null,
    position: state.position ? { ...(base.position || {}), entry: state.position.entryPrice, target045: state.position.sellTarget } : null,
    recovery: base.recovery || { positions: state.recoveryPositions || [], activeBreakdownLocks: [] },
    protectedCapitalFloor: num(protectedCapitalFloor()),
    peakRealizedProfit: num(state.peakRealizedProfit),
    riskableProfitBuffer: num(riskableProfitBuffer()),
    marketExitNetNow: state.position ? num(simulateMarketSell(state.position.pearlReceived)?.netUSDT) : null,
    marketExitWouldRespectFloor: state.position
      ? (() => {
          const sim = simulateMarketSell(state.position.pearlReceived);
          return sim ? sim.netUSDT + 1e-9 >= protectedCapitalFloor(state.position) : null;
        })()
      : null,
    buysPlaced: state.buyOrdersPlaced,
    earlyBuysArmed: state.earlyBuyOrdersArmed || 0,
    hardSignalsConfirmedWhileArmed: state.hardSignalsConfirmedWhileArmed || 0,
    buyOrdersExpired: state.buyOrdersExpired || 0,
    buysCancelled: state.buyOrdersCancelled,
    buysFilled: state.buyOrdersFilled,
    sellOrdersPlaced: state.sellOrdersPlaced || 0,
    sellsFilled: state.sellOrdersFilled,
    targetExits: state.targetExits,
    stopExits: state.stopExits,
    capitalProtectedStops: state.capitalProtectedStops,
    capitalFloorBlockedStops: state.capitalFloorBlockedStops,
    structuralStopExits: state.structuralStopExits || 0,
    recoveryHoldsStarted: state.recoveryHoldsStarted || 0,
    recoveryBreakEvenExits: state.recoveryBreakEvenExits || 0,
    recoveryHardStops: state.recoveryHardStops || 0,
    breakdownLocksCreated: state.breakdownLocksCreated || 0,
    breakdownLocksReleased: state.breakdownLocksReleased || 0,
    highRangeCautionOrders: state.highRangeCautionOrders || 0,
    softFallingCautionOrders: state.softFallingCautionOrders || 0,
    entryStabilityBlocks: state.entryStabilityBlocks || 0,
    entryStabilityCancels: state.entryStabilityCancels || 0,
    fallingMarketLocksCreated: state.fallingMarketLocksCreated || 0,
    fallingMarketLocksReleased: state.fallingMarketLocksReleased || 0,
    fallingMarketEntriesBlocked: state.fallingMarketEntriesBlocked || 0,
    positionSpacingBlocks: state.positionSpacingBlocks || 0,
    scalpPositionsOpened: state.scalpPositionsOpened || 0,
    maxDrawdown: pct(state.maxDrawdown),
  };
}

// ============================================================
// STATUS / HOUSEKEEPING
// ============================================================

setInterval(() => {
  // Expira una BUY aunque durante unos segundos no llegue ningún trade.
  if (
    state.buyOrder &&
    Date.now() - state.buyOrder.firstPlacedAtMs >= BUY_TTL_MS
  ) {
    cancelBuy("TTL_EXPIRED");
  }

  updateDrawdown();
  checkRecoveryHardStops();
  maybeMark24hComplete();

  const metric = metrics();
  const displayMetric = metric ?? earlyArmMetric();
  const marketRef = marketReferencePrice();
  if (marketRef?.price) updateBreakdownLocks(marketRef.price);
  const flow5m = flowMetrics();
  const flow30s = flowMetrics(Date.now(), FAST_FLOW_WINDOW_MS);
  const momentum30s = priceMomentum(Date.now(), FAST_FLOW_WINDOW_MS);
  const equity = currentEquity();
  const timing = testTiming();

  const previewBuyPrice = proposedBuyPrice();
  const previewTarget = previewBuyPrice
    ? roundUp(previewBuyPrice * (1 + TARGET_GROSS))
    : null;

  const supportPreview = supportContext60m(displayMetric?.current ?? marketRef?.price ?? null);
  const rangePosition24h = tickerRangePosition24h(displayMetric?.current ?? marketRef?.price ?? null);
  const entryDiag = entryDiagnostics();
  if (activeFallingMarketLock() && !state.buyOrder && state.cash >= MIN_SCALP_CASH_USDT) {
    state.fallingMarketEntriesBlocked = (state.fallingMarketEntriesBlocked || 0) + 1;
  }

  const pendingFillProgress =
    state.buyOrder && state.buyOrder.requiredFlow > 0
      ? state.buyOrder.qualifyingVolume / state.buyOrder.requiredFlow
      : null;

  const sellFillProgress =
    state.sellOrder && state.sellOrder.requiredFlow > 0
      ? state.sellOrder.qualifyingVolume / state.sellOrder.requiredFlow
      : null;

  console.log("\n========== V5.1.8.3 STATUS ==========");

  const statusSnapshot = {
    localTime: localClock().text,

    testMode: "24H_CONTINUOUS",
    testElapsedHours: num(timing.elapsedHours, 2),
    testRemainingHours: num(timing.remainingHours, 2),
    test24hComplete: state.test24hCompleteLogged,

    mode: state.mode,

    scalpCash: num(state.cash),
    capitalContributed: num(state.capitalContributed),
    pearl: num(state.pearl),
    recoveryEquity: num(recoveryEquity()),
    equity: num(equity),
    ROI: state.capitalContributed > 0
      ? pct(equity / state.capitalContributed - 1)
      : null,
    realizedProfit: num(state.realizedProfit),
    cycles: state.cycles,

    targetGross: pct(TARGET_GROSS),

    lastPrice: displayMetric?.current ?? marketRef?.price ?? null,
    recentLow: displayMetric?.low ?? null,
    recentHigh: displayMetric?.high ?? null,

    marketDataHealth: {
      marketReferenceSource: displayMetric?.currentSource ?? marketRef?.source ?? null,
      strict5mMetricsReady: Boolean(metric),
      recentTradeSampleCount: displayMetric?.sampleCount ?? null,
      liveReady,
      lastLiveTradeSource,
      lastLiveTradeAt: lastAnyLiveTradeAtMs ? iso(lastAnyLiveTradeAtMs) : null,
      secondsSinceLiveTrade: lastAnyLiveTradeAtMs
        ? num((Date.now() - lastAnyLiveTradeAtMs) / 1000, 1)
        : null,
      wsLiveTradesReceived,
      restLiveTradesReceived,
      restFallbackBootstrapped: tradesRestBootstrapped,
      causalBuyFillsBlocked: state.causalBuyFillsBlocked || 0,
      causalSellFillsBlocked: state.causalSellFillsBlocked || 0,
      causalRecoveryFillsBlocked: state.causalRecoveryFillsBlocked || 0
    },

    bestBid: bestBid(),
    bestAsk: bestAsk(),

    // SOLO INFORMACIÓN DEL LIBRO.
    // NO es nuestro target.
    marketSpreadObserved: pct(marketSpreadObserved()),

    downsideContext: {
      support60m: num(supportPreview.support?.price, 4),
      supportTouches60m: supportPreview.support?.touches ?? null,
      supportLowerEdge60m: num(supportPreview.support?.lower, 4),
      low60m: num(supportPreview.low60m, 4),
      high60m: num(supportPreview.high60m, 4),

      ticker24hReady: Boolean(ticker24h),
      ticker24hSource: ticker24h?.source ?? null,
      ticker24hUpdatedAt: ticker24h?.updatedAt ?? null,
      open24h: num(ticker24h?.open, 4),
      low24h: num(ticker24h?.low, 4),
      high24h: num(ticker24h?.high, 4),
      close24h: num(ticker24h?.close, 4),
      volume24h: num(ticker24h?.volume, 4),
      rangePosition24h: pct(rangePosition24h),
      distanceFrom24hLow: ticker24h && (displayMetric?.current ?? marketRef?.price)
        ? pct((displayMetric?.current ?? marketRef?.price) / ticker24h.low - 1)
        : null,
      distanceTo24hHigh: ticker24h && (displayMetric?.current ?? marketRef?.price)
        ? pct(ticker24h.high / (displayMetric?.current ?? marketRef?.price) - 1)
        : null,

      previewBuy: previewBuyPrice,
      previewTarget,
      targetSeenRecentlyAdvisory: displayMetric && previewTarget && Number.isFinite(displayMetric.high)
        ? previewTarget <= displayMetric.high
        : null,

      bullishResistanceHardGate: true,
      priceLadderEntryGate: previewBuyPrice ? priceLadderEntryContext(previewBuyPrice) : null,
      rangePositionEntryGate: previewBuyPrice ? rangePositionEntryContext(previewBuyPrice) : null
    },

    entryEngine: entryDiag,

    regimeV519: {
      startupContext: (() => {
        const st = startupContextStatus(displayMetric?.current ?? marketRef?.price ?? null);
        return {
          locked: st.locked,
          ready: st.ready,
          elapsedSeconds: num(st.elapsedSeconds, 1),
          remainingSeconds: num(st.remainingSeconds, 1),
          liveTrades: st.liveTrades,
          minimumLiveTrades: st.minimumLiveTrades,
          timeReady: st.timeReady,
          samplesReady: st.samplesReady
        };
      })(),
      preEntryFalling: (() => {
        const f = preEntryFallingContext(displayMetric?.current ?? marketRef?.price ?? null);
        return {
          active: f.active,
          regime: f.regime,
          hardLock: f.hardLock,
          softCaution: f.softCaution,
          hardShock: f.hardShock,
          hardSlowBleed: f.hardSlowBleed,
          directionalDrop: f.directionalDrop,
          confirmingVotes: f.confirmingVotes,
          move4m: pct(f.move4m),
          move5m: pct(f.move5m),
          move10m: pct(f.move10m),
          pulledFromHigh: f.pulledFromHigh,
          sellPressure: f.sellPressure,
          microDrop: f.microDrop,
          nearLow: f.nearLow
        };
      })(),
      entryStability: (() => {
        const e = entryStabilityContext(displayMetric?.current ?? marketRef?.price ?? null);
        return {
          ok: e.ok,
          required: e.required,
          stableEnough: e.stableEnough,
          failedConditions: e.failedConditions?.join(", ") || null,
          dropFromHigh15m: pct(e.dropFromHigh15m),
          move10m: pct(e.move10m),
          move5m: pct(e.move5m),
          momentum30s: pct(e.momentum30s),
          askShare5m: pct(e.askShare5m),
          minutesSinceLow: num(e.minutesSinceLow, 2),
          bounceFromLow5m: pct(e.bounceFromLow5m)
        };
      })(),
      entryZone: (() => {
        const z = entryZoneContext(previewBuyPrice, displayMetric);
        const alloc = previewBuyPrice ? scalpAllocation({ buyPrice: previewBuyPrice, metric: displayMetric }) : null;
        return {
          ok: z.ok,
          high24h: num(z.ladder.high24h, 4),
          priceLadderOK: z.ladder.ok,
          maxBuyExclusive: num(z.ladder.maxBuyExclusive, 4),
          nextUnlockResistance: num(z.ladder.nextUnlockResistance, 4),
          buyBandStart: num(z.ladder.buyBandStart, 4),
          ladderReason: z.ladder.reason,
          rangePosition24h: pct(z.range.rangePosition24h),
          rangeMode: z.range.mode,
          rangeOK: z.range.ok,
          rangeReason: z.range.reason,
          capitalFractionIfBuy: alloc ? pct(alloc.fraction) : null,
          effectiveCapitalToUseIfBuy: alloc ? num(alloc.capital) : null,
          multiPositionSlotCapIfBuy: alloc ? num(alloc.slotCap) : null,
          effectiveCashFractionIfBuy: alloc && state.cash > 0 ? pct(alloc.capital / state.cash) : null,
          allocationModeIfBuy: alloc?.mode ?? null
        };
      })(),
      highRangeCaution: (() => {
        const c = highRangeCautionContext(displayMetric);
        return {
          active: c.active,
          rangePosition24h: pct(c.rangePosition24h),
          strongRun: c.strongRun,
          runFromLow10m: pct(c.runFromLow10m),
          runFromLow60m: pct(c.runFromLow60m),
          exhaustionVotes: c.exhaustionVotes,
          pullback: c.pullback,
          lowerHigh: c.lowerHigh,
          sellPressure: c.sellPressure,
          microDrop: c.microDrop
        };
      })(),
      fallingMarketLock: (() => {
        const lock = activeFallingMarketLock();
        const st = fallingMarketStabilityContext(displayMetric?.current ?? marketRef?.price ?? null);
        return lock
          ? {
              active: true,
              id: lock.id,
              lowSinceLock: num(lock.lowSinceLock, 4),
              low24h: num(ticker24h?.low, 4),
              lockAgeMinutes: num(st.lockAgeMinutes, 2),
              minutesSinceMeaningfulNewLow: num(st.minutesSinceMeaningfulNewLow, 2),
              stableEnough: st.stableEnough,
              failedConditions: st.failedConditions?.join(", ") || null,
              move10m: pct(st.move10m),
              move5m: pct(st.move5m),
              momentum30s: pct(st.momentum30s),
              askShare5m: pct(st.askShare5m),
              bounceFromLow5m: pct(st.bounceFromLow5m),
              reservedCash: num(state.cash)
            }
          : { active: false };
      })()
    },

    askShare5m: pct(flow5m.askShare),
    bidShare5m: pct(flow5m.bidShare),
    askShare30s: pct(flow30s.askShare),
    bidShare30s: pct(flow30s.bidShare),
    priceMove30s: pct(momentum30s.move),

    openScalpPositions: openScalpPositions().map((p) => ({
      id: p.id,
      entry: p.entryPrice,
      target045: p.sellTarget,
      investedUSDT: num(p.investedUSDT),
      pearl: num(p.pearlReceived),
      allocationMode: p.allocationMode ?? "NORMAL_SCALP",
      heldMinutes: num((Date.now() - p.entryTimeMs) / 60000, 2),
      sellOrderPlacedAt: p.sellOrder?.placedAt ?? null
    })),
    openScalpPositionCount: openScalpPositions().length,
    multiPositionSlotFraction: pct(MULTI_POSITION_MAX_CAPITAL_FRACTION),
    minimumPositionSpacing: pct(MIN_POSITION_SPACING_PCT),

    pendingBuy: state.buyOrder
      ? {
          price: state.buyOrder.price,
          target: state.buyOrder.target,
          staticPrice: true,
          entrySignalType: state.buyOrder.entrySignalType ?? null,
          allocationMode: state.buyOrder.allocationMode ?? "NORMAL_SCALP",
          capitalToUse: num(state.buyOrder.cash),
          capitalFraction: pct(state.buyOrder.allocationFraction ?? 1),
          multiPositionSlotCap: num(state.buyOrder.multiPositionSlotCap),
          openScalpPositions: openScalpPositions().length,
          reserveAfterFill: num(state.buyOrder.reserveAfterFill ?? 0),
          hardSignalConfirmed: Boolean(state.buyOrder.hardSignalConfirmedAt),
          hardSignalConfirmedAt: state.buyOrder.hardSignalConfirmedAt ?? null,
          ageSeconds: num(
            (Date.now() - state.buyOrder.firstPlacedAtMs) / 1000,
            1
          ),
          ttlRemainingSeconds: num(
            Math.max(0, BUY_TTL_MS - (Date.now() - state.buyOrder.firstPlacedAtMs)) / 1000,
            1
          ),
          fillProgress: pct(Math.min(1, pendingFillProgress ?? 0)),
          marketDistanceFromBuy: metric?.current
            ? pct(metric.current / state.buyOrder.price - 1)
            : null,
          structuralBreakPrice: num(
            state.buyOrder.price * (1 - PENDING_BREAK_BELOW_BUY),
            4
          ),
          cancelGraceRemainingSeconds: num(
            Math.max(
              0,
              PENDING_CANCEL_GRACE_MS -
                (Date.now() - state.buyOrder.firstPlacedAtMs)
            ) / 1000,
            1
          )
        }
      : null,

    position: state.position
      ? {
          entry: state.position.entryPrice,
          target045: state.position.sellTarget,
          allocationMode: state.position.allocationMode ?? "NORMAL_SCALP",
          investedUSDT: num(state.position.investedUSDT),
          cashReserve: num(state.cash),
          heldMinutes: num(
            (Date.now() - state.position.entryTimeMs) / 60000,
            2
          ),
          bestBidMoveFromEntry: bestBid()
            ? pct(bestBid() / state.position.entryPrice - 1)
            : null,
          sellFillProgress: pct(Math.min(1, sellFillProgress ?? 0)),
          supportAtEntry: num(state.position.structuralSupportAtEntry, 4),
          supportSource: state.position.structuralSupportSource ?? null,
          structuralBreakPrice: state.position.structuralSupportAtEntry
            ? num(
                state.position.structuralSupportAtEntry * (1 - STRUCTURAL_STOP_BREAK_PCT),
                4
              )
            : null,
          low24hAtEntry: num(state.position.low24hAtEntry, 4),
          high24hAtEntry: num(state.position.high24hAtEntry, 4)
        }
      : null,

    recovery: {
      positions: state.recoveryPositions.map((r) => ({
        id: r.id,
        entryPrice: r.entryPrice,
        investedUSDT: num(r.investedUSDT),
        netValueNow: num(recoveryPositionNetValue(r)),
        recoveryTarget: r.recoveryTarget,
        dangerActive: Boolean(r.dangerArmedAtMs),
        dangerThresholdNetUSDT: num(r.recoveryDangerNetUSDT),
        dangerArmedAt: r.dangerArmedAt ?? null,
        low24hAnchor: num(r.low24hAnchor, 6),
        low24hAnchorAt: r.low24hAnchorAt ?? null,
        low24hAnchorSource: r.low24hAnchorSource ?? null,
        hardStopBreakPrice: num(r.hardStopBreakPrice, 6),
        anchorBreakBelowSince: r.anchorBreakBelowSince ?? null,
        anchorBreakConfirmRemainingSeconds: r.anchorBreakBelowSinceMs
          ? num(Math.max(0, RECOVERY_ANCHOR_BREAK_CONFIRM_MS - (Date.now() - r.anchorBreakBelowSinceMs)) / 1000, 1)
          : null,
        unrealizedROI: pct(recoveryPositionNetValue(r) / r.investedUSDT - 1),
        heldMinutes: num((Date.now() - r.entryTimeMs) / 60000, 2)
      })),
      activeBreakdownLocks: activeBreakdownLocks().map((lock) => ({
        id: lock.id,
        brokenSupport: num(lock.brokenSupport, 4),
        breakPrice: num(lock.breakPrice, 4),
        reclaimAboveSince: lock.reclaimAboveSinceMs ? iso(lock.reclaimAboveSinceMs) : null
      }))
    },

    protectedCapitalFloor: num(protectedCapitalFloor()),
    peakRealizedProfit: num(state.peakRealizedProfit),
    riskableProfitBuffer: num(riskableProfitBuffer()),

    marketExitNetNow: state.position
      ? num(simulateMarketSell(state.position.pearlReceived)?.netUSDT)
      : null,

    marketExitWouldRespectFloor: state.position
      ? (() => {
          const sim = simulateMarketSell(state.position.pearlReceived);
          return sim ? sim.netUSDT + 1e-9 >= protectedCapitalFloor(state.position) : null;
        })()
      : null,

    buysPlaced: state.buyOrdersPlaced,
    earlyBuysArmed: state.earlyBuyOrdersArmed || 0,
    hardSignalsConfirmedWhileArmed:
      state.hardSignalsConfirmedWhileArmed || 0,
    buyOrdersExpired: state.buyOrdersExpired || 0,
    buysCancelled: state.buyOrdersCancelled,
    buysFilled: state.buyOrdersFilled,

    sellOrdersPlaced: state.sellOrdersPlaced || 0,
    sellsFilled: state.sellOrdersFilled,
    targetExits: state.targetExits,
    stopExits: state.stopExits,
    capitalProtectedStops: state.capitalProtectedStops,
    capitalFloorBlockedStops: state.capitalFloorBlockedStops,
    structuralStopExits: state.structuralStopExits || 0,
    recoveryHoldsStarted: state.recoveryHoldsStarted || 0,
    recoveryBreakEvenExits: state.recoveryBreakEvenExits || 0,
    recoveryHardStops: state.recoveryHardStops || 0,
    breakdownLocksCreated: state.breakdownLocksCreated || 0,
    breakdownLocksReleased: state.breakdownLocksReleased || 0,
    highRangeCautionOrders: state.highRangeCautionOrders || 0,
    softFallingCautionOrders: state.softFallingCautionOrders || 0,
    entryStabilityBlocks: state.entryStabilityBlocks || 0,
    entryStabilityCancels: state.entryStabilityCancels || 0,
    fallingMarketLocksCreated: state.fallingMarketLocksCreated || 0,
    fallingMarketLocksReleased: state.fallingMarketLocksReleased || 0,
    fallingMarketEntriesBlocked: state.fallingMarketEntriesBlocked || 0,
    positionSpacingBlocks: state.positionSpacingBlocks || 0,
    scalpPositionsOpened: state.scalpPositionsOpened || 0,

    maxDrawdown: pct(state.maxDrawdown)
  };

  latestStatusObject = statusSnapshot;
  console.log(statusSnapshot);

  saveState();
}, 30000);

// ============================================================
// START
// ============================================================

console.log(`
=========================================================
PEARL / USDT PAPER SCALPER V5.1.8.3
=========================================================

CAPITAL FICTICIO:
${START_CAPITAL} USDT

TARGET NORMAL:
+0.4500% BRUTO

FEES MODELADAS:
BUY  ${pct(BUY_FEE)}
SELL ${pct(SELL_FEE)}

MODO:
24H_CONTINUOUS

NO EXISTE:
- RESCUE por hora
- DEFENSIVE por hora
- OFF por hora
- cierre forzado por hora
- bloqueo de compras a mediodía

SÍ EXISTE:
- fill causal ESTRICTO por tiempo de observación
- V5.1.8.3: un trade del mismo batch que creó la orden NUNCA puede llenarla
- V5.1.8.3: BUY/SELL registran orderPlacedAt + tradeExchangeTime + causalAgeMs
- V5.1.8.3: SELL LIMIT se imprime explícitamente al abrirse
- V5.1.8.3: trade que ATRAVIESA una LIMIT = FULL FILL inmediato
- V5.1.8.3: trade EXACTO en la LIMIT = respeta cola + tamaño propio
- V5.1.8.3: target normal +0.45% bruto
- V5.1.8.3: MULTI-POSITION: una BUY pendiente máxima + múltiples SELL LIMIT independientes
- V5.1.8.3: cada posición usa máximo 30% del capital operativo; cash restante sigue evaluando entradas
- V5.1.8.3: nuevas entradas exigen >=0.25% de separación de toda posición/recovery abierta
- V5.1.8.3: STARTUP_CONTEXT_LOCK observa 4 min LIVE antes de permitir la primera BUY
- V5.1.8.3: régimen <=75%=100% permitido, 75–82%=30%, >82%=bloqueado; el slot multi limita cada posición a 30%
- V5.1.8.3: PRICE_LADDER: high24h=1.8722 => BUY <1.8000; romper 1.9000+1 tick habilita 1.8x
- V5.1.8.3: ruptura estructural => RECOVERY_HOLD; NO venta inmediata
- V5.1.8.3: RECOVERY_HOLD activa FALLING_MARKET_LOCK sobre el cash restante
- V5.1.8.3: HARD_FALLING_LOCK puede activarse PRE-ENTRY solo ante desplome/slow-bleed fuerte
- V5.1.8.3: SOFT_FALLING_CAUTION opera al 30%; ENTRY_STABILITY queda como contexto de calidad
- V5.1.8.3: PREENTRY HARD LOCK libera tras >=2 min sin nuevo low + 5m/30s estables + rebote
- V5.1.8.3: durante HARD_FALLING_LOCK NO hay nuevas BUY, aunque haya cash
- V5.1.8.3: lock cae solo con STABLE_ENOUGH usando 10m + 5m + 30s + flow5m
- RECOVERY_HOLD sale en break-even neto (+0.02% buffer)
- RECOVERY_HOLD: -10% SOLO arma RECOVERY_DANGER; NO vende
- V5.1.8.3: hard stop solo si rompe low24hAnchor -1.5% por ~2 min + presión vendedora + no reclaim
- BREAKDOWN_LOCK bloquea recompra del soporte roto
- lock se libera por reclaim confirmado 2 min o nuevo soporte >=0.50% más abajo
- capital PAPER extra se inyecta con PAPER_INJECT_USDT + PAPER_INJECT_ID
- EARLY ARM: BUY LIMIT se coloca antes de la señal completa
- la LIMIT gana tiempo descansando en el libro
- señal dura se valida mientras la orden ya está armada
- TTL BUY = 90 s
- BUY estática durante todo el intento
- NO reprice alcista / NO perseguir el precio
- si no llena en 90 s: TTL_EXPIRED → cancelar → recalcular desde cero
- early arm NO espera ASK5m/drawdown/rango duro; arma la LIMIT apenas existe zona maker válida
- ASK5m queda como CONTEXTO y dentro del hardSignal; NO bloquea EARLY_ARM
- hardSignal sigue registrándose como confirmación posterior; NO es requisito para fill
- V5.1.8.3: tradeUpdate se procesa incluso durante bootstrap/reconexión
- V5.1.8.3: fallback REST de trades cada 5 s si el WS de trades queda silencioso
- V5.1.8.3: ticker.close/libro pueden dar referencia para EARLY_ARM; NUNCA generan fills
- soporte 60m automático SOLO como referencia bajista
- ticker rolling 24h BigONE: open/high/low/close/volume
- HIGH 24h = ENTRY LADDER dinámico; no compramos en su misma banda de 0.10
- V5.1.8.3 existe ENTRY ZONE gate para evitar congelar capital cerca del high24h
- targetSeenRecently es ADVISORY, no requisito
- BUY pendiente NO se cancela por tocar/cruzar ligeramente la entrada
- cancelación solo por ruptura estructural confirmada:
    edad >=30 s
    mercado >=0.30% debajo de BUY
    ASK30 >=70%
    priceMove30 <= -0.10%
- stop defensivo normal:
    hold >=2 min
    caída >=0.20%
    ASK5m >=62%
    SOLO vende si respeta CAPITAL FLOOR
- ruptura estructural confirmada:
    rompe soporte >=0.30%
    ASK5m >=62% + ASK30 >=70%
    priceMove30 <= -0.10%
    NO VENDE: mueve la posición a RECOVERY_HOLD
- stop defensivo normal protege 100% del principal del SCALP_BUCKET activo
- RECOVERY_HOLD: -10% neto = RECOVERY_DANGER, NO hard stop
- hard stop recovery requiere fallo confirmado del low24hAnchor
- capital nuevo/reseva queda líquido; FALLING_MARKET_LOCK impide usarlo hasta STABLE_ENOUGH
- si vender el scalp dejaría menos que su floor:
    NO VENDE; mantiene la posición activa
- target normal SIEMPRE +0.45% bruto
- FLOW 5 min = contexto
- FLOW 30 s = micro momentum + confirmación de ruptura, nunca persecución alcista

ESTRUCTURA V5.1.8.3:
- NORMAL_SCALP = target +0.45%
- STARTUP_CONTEXT_LOCK = 4 min + >=20 trades LIVE antes de primera BUY
- RANGE SIZING = <=75% usa 100%; 75–82% usa 30%; >82% bloquea RANGE BUY
- FALLING_MARKET_LOCK = cash líquido bloqueado durante caída, sin nuevas BUY
- ENTRY_STABILITY_GATE = precio permitido NO implica compra; exige que la caída se estabilice
- STABLE_ENOUGH = no new low + 10m/5m/30s/flow estabilizados
- RECOVERY_HOLD = inventario atrapado; -10% danger; hard stop solo por low24hAnchor confirmado
- BREAKDOWN_LOCK = anti-whipsaw; no recomprar soporte roto inmediatamente
- FLOW 30 s = micro momentum
- 5 min = señal inmediata de scalp
- soporte 60m = referencia bajista automática
- ticker 24h BigONE = rango intradía real
- high 24h = escalón dinámico: una banda de 0.10 por debajo para RANGE BUY
- low 24h = fallback de soporte si no hay soporte local confirmado
- romper el siguiente escalón (ej. 1.9001) habilita la banda inferior recién conquistada (1.8x)

LOG:
- FULL STATUS cada 30 segundos
- eventos de BUY/FILL/CANCEL salen inmediatamente
- sin JSON LIVE cada segundo

IMPORTANTE:
marketSpreadObserved es solo el spread actual del libro.
NO cambia el target de +0.45%.

A LAS 24 HORAS:
- escribe summary_24h.json
- registra evento 24H TEST COMPLETE
- sigue corriendo hasta que tú lo detengas

ARCHIVOS:
${DIR}

100% PAPER
NO API KEY
NO DINERO REAL
=========================================================
`);

maybeApplyPaperCapitalInjection();
const runtimeApi = createRuntimeApi({
  rootDir: DIR,
  getRuntime: liveJsonStatus,
  getState: () => state,
  port: Number(process.env.PEARL_DASHBOARD_PORT || 4174),
});
runtimeApi.start();
connect();
