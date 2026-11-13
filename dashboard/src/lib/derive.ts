import type { BotSnapshot, JsonRecord } from "../../shared/types.js";

export type MarketData = {
  price: number | null;
  priceSource: string;
  priceTime: string | null;
  quoteTime: string | null;
  contextTime: string | null;
  open24h: number | null;
  high24h: number | null;
  low24h: number | null;
  bid: number | null;
  ask: number | null;
  rangePosition: number | null;
  support60m: number | null;
  structure120m: JsonRecord | null;
  askShare30s: number | null;
  askShare5m: number | null;
  bidShare5m: number | null;
  move30s: number | null;
  move4m: number | null;
  move5m: number | null;
  move10m: number | null;
  bounceFromLow: number | null;
  minutesSinceLow: number | null;
  samples: Array<{ time: number; value: number; type: string; source: JsonRecord }>;
};

export type PortfolioData = {
  equity: number | null;
  realized: number | null;
  unrealized: number | null;
  total: number | null;
  roi: number | null;
  contributed: number | null;
  scalpCash: number | null;
  recoveryEquity: number | null;
  pearl: number | null;
};

export const record = (value: unknown): JsonRecord =>
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};

export const list = (value: unknown): JsonRecord[] =>
  Array.isArray(value) ? value.filter((item): item is JsonRecord => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [];

export function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/[$,%\s,]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function pickNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = numberValue(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

export function botConfiguration(runtimeValue: unknown, stateValue: unknown): {
  version: string;
  targetPriceDelta: number | null;
  capital: number | null;
  controlPort: number;
  tradingEnabled: boolean | null;
} {
  const runtime = record(runtimeValue);
  const state = record(stateValue);
  const control = record(runtime.botControl);
  const rawPort = Math.round(numberValue(control.controlPort) ?? 4175);
  return {
    version: String(runtime.version ?? state.version ?? ""),
    targetPriceDelta: pickNumber(runtime.targetPriceDelta, control.targetPriceDelta, state.targetPriceDelta),
    capital: pickNumber(runtime.operatingBank, control.operatingBank, state.operatingBank, runtime.capitalContributed, state.capitalContributed, state.capitalStart),
    controlPort: Math.max(1, Math.min(65535, rawPort)),
    tradingEnabled: typeof control.tradingEnabled === "boolean"
      ? control.tradingEnabled
      : typeof state.tradingEnabled === "boolean" ? state.tradingEnabled : null,
  };
}

export function getPath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => record(current)[key], source);
}

export function eventTime(item: JsonRecord): number | null {
  const raw = item.time ?? item.timestamp ?? item.createdAt ?? item.at ?? item.tradeObservedAt;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw > 10_000_000_000 ? raw : raw * 1000;
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const ms = numberValue(item.timeMs ?? item.createdAtMs ?? item.timestampMs);
  return ms === null ? null : ms;
}

function timestampFor(item: JsonRecord, nested: JsonRecord[]): number | null {
  const candidates = [item, ...nested];
  for (const candidate of candidates) {
    const updated = candidate.updatedAt ?? candidate.time ?? candidate.timestamp;
    if (typeof updated === "string") {
      const parsed = Date.parse(updated);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return eventTime(item);
}

function nestedObjects(item: JsonRecord): JsonRecord[] {
  const result: JsonRecord[] = [item];
  const keys = [
    "signal", "order", "metric", "ticker24h", "ticker", "market", "marketData", "marketSnapshot",
    "snapshot", "status", "context", "supportContext", "downsideContext", "highRangeCaution", "entryZone",
    "marketDataHealth", "flow", "summary",
  ];
  let cursor = 0;
  while (cursor < result.length && cursor < 40) {
    const parent = result[cursor++];
    for (const key of keys) {
      const value = parent[key];
      if (value && typeof value === "object" && !Array.isArray(value)) result.push(value as JsonRecord);
    }
  }
  return result;
}

const field = (objects: JsonRecord[], keys: string[]): unknown => {
  for (const object of objects) {
    for (const key of keys) if (object[key] !== undefined && object[key] !== null) return object[key];
  }
  return undefined;
};

function ratio(value: unknown): number | null {
  const parsed = numberValue(value);
  if (parsed === null) return null;
  if (typeof value === "string" && value.includes("%")) return parsed / 100;
  return Math.abs(parsed) > 1 ? parsed / 100 : parsed;
}

export function deriveMarket(snapshot: BotSnapshot): MarketData {
  const state = record(snapshot.state);
  const runtime = record(snapshot.runtime);
  const runtimeHealth = record(runtime.marketDataHealth);
  const runtimeDownside = record(runtime.downsideContext);
  const runtimeRegime = record(runtime.regimeV519 ?? runtime.regimeV518);
  const runtimeFalling = record(runtimeRegime.fallingMarketLock);
  const runtimePreEntry = record(runtimeRegime.preEntryFalling);
  const runtimeEntryStability = record(runtimeRegime.entryStability);
  const runtimeStructure120 = record(runtime.structure120m ?? state.structure120m);
  const runtimeLivePrice = pickNumber(runtime.lastPrice);
  const all = [...snapshot.events, ...snapshot.signals, ...snapshot.trades]
    .map((item) => ({ item, objects: nestedObjects(item) }))
    .sort((a, b) => (eventTime(a.item) ?? 0) - (eventTime(b.item) ?? 0));

  let price: number | null = pickNumber(runtime.lastPrice, state.currentPrice, state.marketPrice, state.lastPrice, getPath(state, "market.price"));
  const runtimePriceSource = typeof runtimeHealth.marketReferenceSource === "string" ? runtimeHealth.marketReferenceSource : "API del bot";
  let priceSource = price === null ? "Sin precio observado" : runtimeLivePrice !== null ? `Bot runtime · ${runtimePriceSource}` : "state.json";
  let priceTime: string | null = typeof runtimeHealth.lastLiveTradeAt === "string"
    ? runtimeHealth.lastLiveTradeAt
    : typeof runtime.generatedAt === "string" ? runtime.generatedAt : null;
  let quoteTime: string | null = null;
  let contextTime: string | null = typeof runtimeDownside.ticker24hUpdatedAt === "string" ? runtimeDownside.ticker24hUpdatedAt : null;
  let high24h = pickNumber(runtimeDownside.high24h, state.high24h, getPath(state, "ticker24h.high"), getPath(state, "fallingMarketLock.high24h"));
  let low24h = pickNumber(runtimeDownside.low24h, state.low24h, getPath(state, "ticker24h.low"), getPath(state, "fallingMarketLock.low24AtLock"), getPath(state, "fallingMarketLock.lowest24hObserved"), getPath(state, "fallingMarketLock.lastMeaningful24hLow"));
  let open24h = pickNumber(runtimeDownside.open24h, state.open24h, getPath(state, "ticker24h.open"));
  let bid = pickNumber(runtime.bestBid, state.bestBid, getPath(state, "orderBook.bestBid"));
  let ask = pickNumber(runtime.bestAsk, state.bestAsk, getPath(state, "orderBook.bestAsk"));
  let rangePosition: number | null = ratio(runtimeDownside.rangePosition24h ?? state.rangePosition24h);
  let support60m = pickNumber(runtimeDownside.support60m, state.support60m);
  let askShare30s: number | null = ratio(runtime.askShare30s ?? state.askShare30s);
  let askShare5m: number | null = ratio(runtime.askShare5m ?? state.askShare5m);
  let bidShare5m: number | null = ratio(runtime.bidShare5m ?? state.bidShare5m);
  let move30s: number | null = ratio(runtime.priceMove30s ?? state.move30s ?? state.momentum30s);
  let move4m: number | null = ratio(runtimePreEntry.move4m ?? state.move4m);
  let move5m: number | null = ratio(runtimePreEntry.move5m ?? runtimeFalling.move5m ?? state.move5m);
  let move10m: number | null = ratio(runtimePreEntry.move10m ?? runtimeFalling.move10m ?? state.move10m);
  let bounceFromLow: number | null = ratio(runtimeFalling.bounceFromLow5m ?? runtimeEntryStability.bounceFromLow5m ?? runtimePreEntry.bounceFromLow5m ?? state.bounceFromLow5m ?? state.bounceFromLow);
  let minutesSinceLow = pickNumber(runtimeFalling.minutesSinceMeaningfulNewLow, runtimeEntryStability.minutesSinceLow, runtimePreEntry.minutesSinceLow10m, state.minutesSinceMeaningfulLow, state.minutesSinceLow);
  const samples: MarketData["samples"] = [];

  for (const item of snapshot.runtimeHistory ?? []) {
    const time = eventTime(item);
    const value = pickNumber(item.lastPrice);
    if (time !== null && value !== null && value > 0) samples.push({ time, value, type: "RUNTIME", source: item });
  }

  for (const { item, objects } of all) {
    const time = timestampFor(item, objects);
    const itemType = String(item.type ?? item.event ?? "market").toUpperCase();
    const ticker = objects.find((object) => object.high !== undefined && object.low !== undefined);
    const foundHigh = pickNumber(field(objects, ["high24h", "high24H"]), ticker?.high, getPath(item, "ticker24h.high"));
    const foundLow = pickNumber(field(objects, ["low24h", "low24H", "low24AtLock", "lowest24hObserved", "lastMeaningful24hLow"]), ticker?.low, getPath(item, "ticker24h.low"));
    const foundOpen = pickNumber(field(objects, ["open24h"]), ticker?.open);
    if (foundHigh !== null) high24h = foundHigh;
    if (foundLow !== null) low24h = foundLow;
    if (foundOpen !== null) open24h = foundOpen;

    const currentCandidate = pickNumber(field(objects, ["currentPrice", "marketPrice", "lastPrice"]))
      ?? pickNumber(
        getPath(item, "ticker24h.close"),
        getPath(item, "ticker.close"),
        getPath(item, "market.price"),
        getPath(item, "marketData.price"),
        getPath(item, "marketSnapshot.price"),
        getPath(item, "metric.current"),
        getPath(item, "signal.metric.current"),
      )
      ?? (/MARKET|TICKER|PRICE OBSERVED|TRADE OBSERVED/i.test(itemType) ? numberValue(item.price) : null);
    if (currentCandidate !== null && currentCandidate > 0) {
      price = currentCandidate;
      priceSource = objects.some((object) => object.currentPrice !== undefined || object.marketPrice !== undefined || object.lastPrice !== undefined)
        ? "Snapshot de mercado"
        : "Evento del bot";
      priceTime = time ? new Date(time).toISOString() : null;
      if (time) samples.push({ time, value: currentCandidate, type: itemType, source: item });
    }

    const foundBid = pickNumber(field(objects, ["bestBid"]), ...objects.map((object) => getPath(object, "bid.price")), getPath(item, "ticker24h.bid.price"));
    const foundAsk = pickNumber(field(objects, ["bestAsk"]), ...objects.map((object) => getPath(object, "ask.price")), getPath(item, "ticker24h.ask.price"));
    if (foundBid !== null) bid = foundBid;
    if (foundAsk !== null) ask = foundAsk;
    if ((foundBid !== null || foundAsk !== null) && time !== null) quoteTime = new Date(time).toISOString();
    const foundPosition = ratio(field(objects, ["rangePosition24h", "rangePosition"]));
    if (foundPosition !== null) rangePosition = foundPosition;
    const foundSupport = pickNumber(field(objects, ["support60m"]), ...objects.map((object) => getPath(object, "support.price")), getPath(item, "supportContext.support.price"));
    if (foundSupport !== null) support60m = foundSupport;
    const foundAsk30 = ratio(field(objects, ["askShare30s"]));
    const foundAsk5 = ratio(field(objects, ["askShare5m", "askShare"]));
    const foundBid5 = ratio(field(objects, ["bidShare5m", "bidShare"]));
    if (foundAsk30 !== null) askShare30s = foundAsk30;
    if (foundAsk5 !== null) askShare5m = foundAsk5;
    if (foundBid5 !== null) bidShare5m = foundBid5;
    for (const [keys, assign] of [
      [["move30s", "momentum30s"], (value: number) => { move30s = value; }],
      [["move4m"], (value: number) => { move4m = value; }],
      [["move5m"], (value: number) => { move5m = value; }],
      [["move10m"], (value: number) => { move10m = value; }],
      [["bounceFromLow5m", "bounceFromLow"], (value: number) => { bounceFromLow = value; }],
    ] as Array<[string[], (value: number) => void]>) {
      const found = ratio(field(objects, keys));
      if (found !== null) assign(found);
    }
    const foundMinutes = pickNumber(field(objects, ["minutesSinceMeaningfulLow", "minutesSinceLow"]));
    if (foundMinutes !== null) minutesSinceLow = foundMinutes;
    if ([foundPosition, foundAsk30, foundAsk5, foundBid5, foundSupport, foundMinutes].some((value) => value !== null) && time !== null) {
      contextTime = new Date(time).toISOString();
    }
  }

  // In-process bot metrics are the current source of truth; older saved events remain history only.
  const livePrice = pickNumber(runtime.lastPrice);
  if (livePrice !== null && livePrice > 0) {
    price = livePrice;
    priceSource = `Bot runtime · ${runtimePriceSource}`;
    priceTime = typeof runtimeHealth.lastLiveTradeAt === "string"
      ? runtimeHealth.lastLiveTradeAt
      : typeof runtime.generatedAt === "string" ? runtime.generatedAt : priceTime;
  }
  high24h = pickNumber(runtimeDownside.high24h) ?? high24h;
  low24h = pickNumber(runtimeDownside.low24h) ?? low24h;
  open24h = pickNumber(runtimeDownside.open24h) ?? open24h;
  bid = pickNumber(runtime.bestBid) ?? bid;
  ask = pickNumber(runtime.bestAsk) ?? ask;
  rangePosition = ratio(runtimeDownside.rangePosition24h) ?? rangePosition;
  support60m = pickNumber(runtimeDownside.support60m) ?? support60m;
  askShare30s = ratio(runtime.askShare30s) ?? askShare30s;
  askShare5m = ratio(runtime.askShare5m) ?? askShare5m;
  bidShare5m = ratio(runtime.bidShare5m) ?? bidShare5m;
  move30s = ratio(runtime.priceMove30s) ?? move30s;
  move4m = ratio(runtimePreEntry.move4m) ?? move4m;
  move5m = ratio(runtimePreEntry.move5m ?? runtimeFalling.move5m) ?? move5m;
  move10m = ratio(runtimePreEntry.move10m ?? runtimeFalling.move10m) ?? move10m;
  bounceFromLow = ratio(runtimeFalling.bounceFromLow5m ?? runtimeEntryStability.bounceFromLow5m ?? runtimePreEntry.bounceFromLow5m) ?? bounceFromLow;
  minutesSinceLow = pickNumber(runtimeFalling.minutesSinceMeaningfulNewLow, runtimeEntryStability.minutesSinceLow, runtimePreEntry.minutesSinceLow10m) ?? minutesSinceLow;
  if (typeof runtimeDownside.ticker24hUpdatedAt === "string") contextTime = runtimeDownside.ticker24hUpdatedAt;

  const lowTimestamp = pickNumber(getPath(state, "fallingMarketLock.lastMeaningfulNewLowAtMs"));
  if (lowTimestamp !== null) minutesSinceLow = Math.max(0, (Date.now() - lowTimestamp) / 60_000);

  if (bid !== null && ask !== null && (price === null || priceSource === "state.json")) {
    price = (bid + ask) / 2;
    priceSource = "Promedio bid/ask";
  }
  if (rangePosition === null && price !== null && low24h !== null && high24h !== null && high24h > low24h) {
    rangePosition = (price - low24h) / (high24h - low24h);
  }

  return {
    price, priceSource, priceTime, quoteTime, contextTime, open24h, high24h, low24h, bid, ask, rangePosition,
    support60m, structure120m: Object.keys(runtimeStructure120).length ? runtimeStructure120 : null,
    askShare30s, askShare5m, bidShare5m, move30s, move4m, move5m, move10m,
    bounceFromLow, minutesSinceLow, samples: uniqueSamples(samples),
  };
}

function uniqueSamples(samples: MarketData["samples"]): MarketData["samples"] {
  const bySecond = new Map<number, MarketData["samples"][number]>();
  for (const sample of samples) bySecond.set(Math.floor(sample.time / 1000), sample);
  return [...bySecond.values()].sort((a, b) => a.time - b.time);
}

export function derivePortfolio(snapshot: BotSnapshot, market: MarketData): PortfolioData {
  const state = record(snapshot.state);
  const runtime = record(snapshot.runtime);
  const cash = pickNumber(runtime.scalpCash, state.cash, state.scalpCash);
  const pearl = pickNumber(runtime.pearl, state.pearl, state.pearlHeld);
  const contributed = pickNumber(runtime.capitalContributed, state.capitalContributed, state.capitalStart);
  const realized = pickNumber(runtime.realizedProfit, state.realizedProfit, snapshot.summary24h?.realizedProfit);
  const runtimeRecoveries = list(getPath(runtime, "recovery.positions"));
  const recoveries = runtimeRecoveries.length ? runtimeRecoveries : list(state.recoveryPositions);
  const recoveryValues = recoveries.map((position) => {
    const explicit = pickNumber(position.netValueNow, position.currentEquity, position.equity, position.markedEquity, position.currentValue);
    if (explicit !== null) return explicit;
    const recoveryCash = pickNumber(position.cash, position.capital, position.originalCapital);
    const quantity = pickNumber(position.pearl, position.pearlHeld, position.quantity, position.pearlReceived);
    return recoveryCash !== null && quantity !== null && market.price !== null ? recoveryCash + quantity * market.price : null;
  });
  const calculatedRecoveryEquity = recoveryValues.every((value) => value !== null)
    ? recoveryValues.reduce<number>((total, value) => total + (value ?? 0), 0)
    : recoveries.length ? null : 0;
  const spotValue = pearl === 0 ? 0 : pearl !== null && market.price !== null ? pearl * market.price : null;
  const recoveryEquity = pickNumber(runtime.recoveryEquity, state.recoveryEquity, calculatedRecoveryEquity);
  const calculatedEquity = cash !== null && recoveryEquity !== null && spotValue !== null ? cash + recoveryEquity + spotValue : null;
  const equity = pickNumber(runtime.equity, calculatedEquity);
  const total = equity !== null && contributed !== null ? equity - contributed : null;
  const unrealized = total !== null && realized !== null ? total - realized : null;
  const roi = pickNumber(runtime.ROI, runtime.roi, total !== null && contributed !== null && contributed !== 0 ? (total / contributed) * 100 : null);
  return { equity, realized, unrealized, total, roi, contributed, scalpCash: cash, recoveryEquity, pearl };
}

export function tradeRecords(snapshot: BotSnapshot): JsonRecord[] {
  const source = snapshot.trades.length ? snapshot.trades : snapshot.events;
  return source.filter((item) => {
    const type = String(item.type ?? "").toUpperCase();
    return type.includes("FILL") || type.includes("EXIT") || item.cycleProfit !== undefined || item.cycleROI !== undefined;
  }).sort((a, b) => (eventTime(b) ?? 0) - (eventTime(a) ?? 0));
}

export function exitTrades(snapshot: BotSnapshot): JsonRecord[] {
  const chronological = tradeRecords(snapshot).slice().sort((a, b) => (eventTime(a) ?? 0) - (eventTime(b) ?? 0));
  const buys = chronological.filter((trade) => String(trade.type ?? "").toUpperCase().includes("BUY_FILLED"));
  const usedBuys = new Set<JsonRecord>();
  return chronological.filter((trade) => {
    const type = String(trade.type ?? "").toUpperCase();
    return type.includes("SELL_FILLED") || type.includes("EXIT") || trade.cycleProfit !== undefined || trade.cycleROI !== undefined;
  }).map((trade) => {
    if (trade.entryTime !== undefined || trade.buyTime !== undefined) return trade;
    const exitAt = eventTime(trade);
    const entry = pickNumber(trade.entryPrice, trade.buyPrice);
    const earlierBuys = buys.filter((buy) => {
      const buyAt = eventTime(buy);
      return !usedBuys.has(buy) && buyAt !== null && exitAt !== null && buyAt <= exitAt;
    });
    const positionId = String(trade.positionId ?? "");
    const idMatches = positionId ? earlierBuys.filter((buy) => String(buy.positionId ?? "") === positionId) : [];
    const priceMatches = earlierBuys.filter((buy) => {
      const buyPrice = pickNumber(buy.entryPrice, buy.price);
      return entry === null || buyPrice === null || Math.abs(entry - buyPrice) < 0.0000001;
    });
    const candidates = idMatches.length ? idMatches : priceMatches;
    const matched = candidates.at(-1);
    if (!matched) return trade;
    usedBuys.add(matched);
    return { ...trade, entryTime: matched.time ?? matched.timestamp ?? matched.createdAt };
  }).sort((a, b) => (eventTime(b) ?? 0) - (eventTime(a) ?? 0));
}

export function deriveEngine(stateValue: unknown, runtimeValue?: unknown): { mode: string; reason: string; order: JsonRecord; position: JsonRecord } {
  const state = record(stateValue);
  const runtime = record(runtimeValue);
  const regime = record(runtime.regimeV519 ?? runtime.regimeV518);
  const buyOrder = record(state.buyOrder);
  const sellOrder = record(state.sellOrder);
  const legacyPosition = record(state.position);
  const scalpPositions = list(state.scalpPositions);
  const positions = scalpPositions.length ? scalpPositions : Object.keys(legacyPosition).length ? [legacyPosition] : [];
  const position = positions[0] ?? legacyPosition;
  const sellOrders = positions.filter((item) => Object.keys(record(item.sellOrder)).length > 0);
  const recoveries = list(state.recoveryPositions);
  const runtimeLock = record(regime.fallingMarketLock);
  const lock = Object.keys(runtimeLock).length ? runtimeLock : record(state.fallingMarketLock);
  let mode = String(state.mode ?? "N/A").toUpperCase();
  let order: JsonRecord = {};
  if (Object.keys(buyOrder).length) { mode = positions.length ? "BUY_LIMIT + OPEN SCALPS" : "BUY_LIMIT"; order = buyOrder; }
  else if (sellOrders.length > 1) { mode = "MULTIPLE SELL LIMITS"; order = record(sellOrders[0].sellOrder); }
  else if (Object.keys(sellOrder).length || sellOrders.length === 1) { mode = "SELL_LIMIT"; order = Object.keys(sellOrder).length ? sellOrder : record(sellOrders[0].sellOrder); }
  else if (positions.length) mode = "SCALP POSITION OPEN";
  else if (recoveries.length) mode = "RECOVERY_HOLD";
  else if (lock.active === true || String(lock.status ?? "").toUpperCase() === "ACTIVE") mode = "FALLING_MARKET_LOCK";
  const reason = String(lock.triggerReason ?? lock.releaseReason ?? lock.failedConditions ?? "");
  return { mode, reason, order, position };
}

export function targetGrossPercent(snapshot: BotSnapshot): number | null {
  for (const event of [...snapshot.events].reverse()) {
    const value = event.targetGross ?? event.targetGrossPct;
    if (value !== undefined) return numberValue(value);
  }
  return pickNumber(snapshot.state?.targetGrossPct, snapshot.summary24h?.targetGrossPct);
}

export function cycleProfit(trade: JsonRecord): number | null {
  return pickNumber(trade.cycleProfit, trade.profit, trade.realizedProfit, trade.netProfit, trade.recoveryProfit);
}

export function cycleRoi(trade: JsonRecord): number | null {
  const raw = trade.cycleROI ?? trade.netROI ?? trade.roi ?? trade.recoveryROI;
  const value = numberValue(raw);
  if (value === null) return null;
  if (typeof raw === "string" && raw.includes("%")) return value;
  return Math.abs(value) > 1 ? value : value * 100;
}

export function feeRate(snapshot: BotSnapshot, side: "buy" | "sell"): number | null {
  const keys = side === "buy"
    ? ["buyFeeRate", "buyFeePct", "buyFeePercent", "feeRateBuy"]
    : ["sellFeeRate", "sellFeePct", "sellFeePercent", "feeRateSell"];
  const all = [...snapshot.events, ...snapshot.trades, ...snapshot.signals].reverse();
  for (const item of all) {
    const objects = nestedObjects(item);
    const raw = field(objects, keys);
    if (raw !== undefined) {
      const parsed = numberValue(raw);
      if (parsed !== null) return Math.abs(parsed) > 1 ? parsed / 100 : parsed;
    }
  }
  if (side === "buy") {
    const inferred = snapshot.trades.map((trade) => {
      const feeUSDT = pickNumber(trade.buyFeeUSDT, trade.buyFeeAmount);
      const invested = pickNumber(trade.investedUSDT, trade.capitalBefore);
      if (feeUSDT !== null && invested !== null && invested > 0) return feeUSDT / invested;
      const fee = pickNumber(trade.buyFeePearl, trade.buyFeeAmount);
      const gross = pickNumber(trade.grossPearl, trade.pearlGross);
      return fee !== null && gross !== null && gross > 0 ? fee / gross : null;
    }).find((value): value is number => value !== null && value >= 0 && value < 1);
    return inferred ?? null;
  }

  const buys = snapshot.trades.filter((trade) => String(trade.type ?? "").toUpperCase().includes("BUY_FILLED"));
  for (const cycle of exitTrades(snapshot)) {
    const entryAt = cycle.entryTime ?? cycle.buyTime;
    const buy = buys.find((item) => item.time === entryAt || item.timestamp === entryAt);
    if (!buy) continue;
    const pearlReceived = pickNumber(buy.pearlReceived);
    const sellPrice = pickNumber(cycle.sellPrice, cycle.exitPrice);
    const invested = pickNumber(buy.investedUSDT, cycle.investedUSDT);
    const profit = cycleProfit(cycle);
    if (pearlReceived === null || sellPrice === null || invested === null || profit === null) continue;
    const grossProceeds = pearlReceived * sellPrice;
    const rate = grossProceeds > 0 ? 1 - (invested + profit) / grossProceeds : null;
    if (rate !== null && rate >= 0 && rate < 1) return rate;
  }
  return null;
}

export function deriveBuyDiagnostics(snapshot: BotSnapshot) {
  const state = record(snapshot.state);
  const events = snapshot.events;
  const cancellationEvents = events.filter((item) => /BUY CANCELLED/i.test(String(item.type ?? "")));
  const reason = (item: JsonRecord) => String(item.reason ?? item.cancelReason ?? "").toUpperCase();
  const placedFromSignals = snapshot.signals.filter((item) => String(item.type ?? "").toUpperCase() === "BUY_LIMIT_PLACED").length;
  const fills = (snapshot.trades.length ? snapshot.trades : events).filter((item) => /BUY_FILLED|BUY CROSS-THROUGH FILL/i.test(String(item.type ?? ""))).length;
  const placed = pickNumber(state.buyOrdersPlaced) ?? placedFromSignals;
  const cancelled = pickNumber(state.buyOrdersCancelled) ?? cancellationEvents.length;
  const filled = pickNumber(state.buyOrdersFilled) ?? fills;
  const countReason = (pattern: RegExp) => cancellationEvents.filter((item) => pattern.test(reason(item))).length;
  return {
    placed,
    cancelled,
    filled,
    fillRate: placed && placed > 0 ? filled / placed : null,
    ttlExpired: countReason(/TTL_EXPIRED/),
    fallingLock: countReason(/FALLING_MARKET|FALLING/),
    supportResize: countReason(/SUPPORT_CAUTION/),
    softFallingResize: countReason(/SOFT_FALLING/),
    userPaused: countReason(/BOT_PAUSED/),
    otherCancelled: cancellationEvents.filter((item) => !/TTL_EXPIRED|FALLING|SUPPORT_CAUTION|SOFT_FALLING|BOT_PAUSED/i.test(reason(item))).length,
    websocketErrors: events.filter((item) => /WS ERROR/i.test(String(item.type ?? ""))).length,
    causalBlocks: events.filter((item) => /BUY FILL BLOCKED BY CAUSALITY/i.test(String(item.type ?? ""))).length,
    lastCancellation: cancellationEvents.at(-1) ?? null,
  };
}

export function entryExplanation(rangePosition: number | null, allocation: number | null, mode: string, supportEntryOK = false): string {
  if (!supportEntryOK && (mode === "TOP_RANGE_BLOCKED" || (rangePosition !== null && rangePosition >= 0.82))) {
    return "Compra bloqueada: el precio está dentro de la banda superior del rango de 24 horas.";
  }
  if (supportEntryOK) {
    return "BUY orientada al soporte validado; 60M/120M funcionan como contexto y no como bloqueo simultáneo.";
  }
  if (mode === "SUPPORT_CAUTION") {
    return "Asignación reducida al 30% porque la entrada está demasiado cerca del soporte detectado.";
  }
  if (allocation !== null && allocation > 0 && allocation < 1) {
    return "Asignación reducida por la protección de soporte reportada por el runtime.";
  }
  if (mode === "FALLING_MARKET_LOCK") return "Sin nuevas compras mientras la protección de mercado espera estabilidad.";
  if (rangePosition !== null && rangePosition >= 0.75) return "Contexto de rango alto; el sizing base sigue en 100% salvo que la entrada esté cerca del soporte.";
  if (rangePosition !== null) return "El precio está en el rango normal; las demás condiciones de entrada siguen siendo determinantes.";
  return "La posición en el rango no está disponible en los archivos observados.";
}
