import assert from "node:assert/strict";
import test from "node:test";
import type { BotSnapshot } from "../shared/types.js";
import { deriveEngine, deriveMarket, derivePortfolio, exitTrades, feeRate } from "../src/lib/derive.js";

const emptyFiles = {
  state: { exists: true, bytes: 0, records: 1, parseErrors: 0, partialLine: false, lastModifiedAt: null },
  summary24h: { exists: false, bytes: 0, records: 0, parseErrors: 0, partialLine: false, lastModifiedAt: null },
  events: { exists: true, bytes: 0, records: 0, parseErrors: 0, partialLine: false, lastModifiedAt: null },
  trades: { exists: false, bytes: 0, records: 0, parseErrors: 0, partialLine: false, lastModifiedAt: null },
  signals: { exists: false, bytes: 0, records: 0, parseErrors: 0, partialLine: false, lastModifiedAt: null },
};

test("normalizes market observations and computes portfolio values without optional fields", () => {
  const snapshot: BotSnapshot = {
    mode: "live",
    generatedAt: new Date().toISOString(),
    state: { version: "5.1.8", cash: 100, pearl: 0, capitalContributed: 100, realizedProfit: 0.05, mode: "WAITING", fallingMarketLock: { status: "ACTIVE" } },
    summary24h: null,
    events: [
      { type: "READY", time: "2026-10-28T20:00:00Z", bestBid: 1.8, bestAsk: 1.82, ticker24h: { low: 1.5, high: 2, close: 1.81 } },
      { type: "FALLING MARKET LOCK ACTIVATED", time: "2026-10-28T20:01:00Z", triggerPrice: 1.81 },
    ],
    trades: [],
    signals: [],
    files: emptyFiles,
    dataDirectoryConfigured: true,
  };
  const market = deriveMarket(snapshot);
  const portfolio = derivePortfolio(snapshot, market);
  assert.equal(market.price, 1.81);
  assert.equal(market.high24h, 2);
  assert.equal(market.low24h, 1.5);
  assert.ok(Math.abs((market.rangePosition ?? 0) - 0.62) < 1e-9);
  assert.equal(portfolio.equity, 100);
  assert.equal(portfolio.realized, 0.05);
  assert.equal(portfolio.total, 0);
  assert.equal(portfolio.unrealized, -0.05);
  assert.equal(deriveEngine(snapshot.state).mode, "FALLING_MARKET_LOCK");
});

test("keeps unknown portfolio and trade values unavailable when the source omits them", () => {
  const snapshot: BotSnapshot = {
    mode: "live", generatedAt: new Date().toISOString(), state: { version: "5.1.4" }, summary24h: null,
    events: [], trades: [], signals: [], files: emptyFiles, dataDirectoryConfigured: true,
  };
  const market = deriveMarket(snapshot);
  const portfolio = derivePortfolio(snapshot, market);
  assert.equal(portfolio.equity, null);
  assert.equal(portfolio.total, null);
  assert.equal(exitTrades(snapshot).length, 0);
});

test("joins a recorded BUY fill to its completed paper cycle entry timestamp", () => {
  const snapshot: BotSnapshot = {
    mode: "live", generatedAt: new Date().toISOString(), state: { cycles: 1 }, summary24h: null,
    events: [],
    trades: [
      { type: "PAPER_BUY_FILLED", time: "2026-10-28T20:00:00Z", entryPrice: 1.8 },
      { type: "PAPER_SELL_FILLED", time: "2026-10-28T20:03:00Z", cycle: 1, entryPrice: 1.8, sellPrice: 1.81, cycleProfit: 0.05 },
    ],
    signals: [], files: emptyFiles, dataDirectoryConfigured: true,
  };
  const cycle = exitTrades(snapshot)[0];
  assert.equal(cycle.entryTime, "2026-10-28T20:00:00Z");
  assert.equal(cycle.cycle, 1);
});

test("derives fee rates from logged BUY and SELL fills when explicit fee settings are absent", () => {
  const snapshot: BotSnapshot = {
    mode: "live", generatedAt: new Date().toISOString(), state: {}, summary24h: null, events: [],
    trades: [
      { type: "PAPER_BUY_FILLED", time: "2026-10-28T20:00:00Z", entryPrice: 1.8, investedUSDT: 100, grossPearl: 55.55555556, buyFeePearl: 0.11111111112, pearlReceived: 55.44444444888 },
      { type: "PAPER_SELL_FILLED", time: "2026-10-28T20:03:00Z", entryPrice: 1.8, sellPrice: 1.81, cycleProfit: 0.153735, capitalAfter: 100.153735 },
    ], signals: [], files: emptyFiles, dataDirectoryConfigured: true,
  };
  assert.ok(Math.abs((feeRate(snapshot, "buy") ?? 0) - 0.002) < 1e-9);
  assert.ok(Math.abs((feeRate(snapshot, "sell") ?? 0) - 0.002) < 1e-6);
});
