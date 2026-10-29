"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const HISTORY_INTERVAL_MS = 10_000;
const HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function finite(value) {
  const result = Number(value);
  return value !== null && value !== undefined && Number.isFinite(result) ? result : null;
}

function fraction(value) {
  if (typeof value === "string" && value.includes("%")) {
    const parsed = finite(value.replace("%", ""));
    return parsed === null ? null : parsed / 100;
  }
  const parsed = finite(value);
  return parsed === null ? null : Math.abs(parsed) > 1 ? parsed / 100 : parsed;
}

function percentFlag(value) {
  return value === null || value === undefined ? null : value ? 1 : 0;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function createJsonlReader(filePath) {
  let cachedMtime = -1;
  let cachedSize = -1;
  let cachedRecords = [];
  let cachedParseErrors = 0;
  let cachedPartialLine = false;

  return function readRecords() {
    try {
      const info = fs.statSync(filePath);
      if (info.mtimeMs !== cachedMtime || info.size !== cachedSize) {
        const content = fs.readFileSync(filePath, "utf8");
        const lines = content.split(/\r?\n/);
        cachedPartialLine = content.length > 0 && !content.endsWith("\n");
        if (cachedPartialLine) lines.pop();
        const records = [];
        cachedParseErrors = 0;
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const value = JSON.parse(line);
            if (value && typeof value === "object" && !Array.isArray(value)) records.push(value);
          } catch {
            cachedParseErrors += 1;
          }
        }
        cachedRecords = records;
        cachedMtime = info.mtimeMs;
        cachedSize = info.size;
      }
      return {
        records: cachedRecords,
        file: {
          exists: true,
          bytes: cachedSize,
          records: cachedRecords.length,
          parseErrors: cachedParseErrors,
          partialLine: cachedPartialLine,
          lastModifiedAt: new Date(cachedMtime).toISOString(),
        },
      };
    } catch {
      return {
        records: [],
        file: { exists: false, bytes: 0, records: 0, parseErrors: 0, partialLine: false, lastModifiedAt: null },
      };
    }
  };
}

function jsonFileState(filePath) {
  try {
    const info = fs.statSync(filePath);
    return {
      exists: true,
      bytes: info.size,
      records: 1,
      parseErrors: 0,
      partialLine: false,
      lastModifiedAt: info.mtime.toISOString(),
    };
  } catch {
    return { exists: false, bytes: 0, records: 0, parseErrors: 0, partialLine: false, lastModifiedAt: null };
  }
}

function databaseFileState(filePath, recordCount) {
  try {
    const info = fs.statSync(filePath);
    return {
      exists: true,
      bytes: info.size,
      records: recordCount,
      parseErrors: 0,
      partialLine: false,
      lastModifiedAt: info.mtime.toISOString(),
    };
  } catch {
    return { exists: false, bytes: 0, records: 0, parseErrors: 0, partialLine: false, lastModifiedAt: null };
  }
}

function createRuntimeApi({ rootDir, getRuntime, getState, port = 4174 }) {
  const absoluteRoot = path.resolve(rootDir);
  const dashboardDist = path.join(absoluteRoot, "dashboard", "dist");
  const databasePath = path.join(absoluteRoot, "runtime_metrics.sqlite");
  const eventsReader = createJsonlReader(path.join(absoluteRoot, "events.jsonl"));
  const tradesReader = createJsonlReader(path.join(absoluteRoot, "paper_trades.jsonl"));
  const signalsReader = createJsonlReader(path.join(absoluteRoot, "signals.jsonl"));

  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 1000;
    CREATE TABLE IF NOT EXISTS runtime_metrics (
      captured_at_ms INTEGER PRIMARY KEY,
      mode TEXT,
      price REAL,
      high24h REAL,
      low24h REAL,
      range_position REAL,
      best_bid REAL,
      best_ask REAL,
      ask_share_5m REAL,
      bid_share_5m REAL,
      ask_share_30s REAL,
      move_30s REAL,
      move_4m REAL,
      move_5m REAL,
      move_10m REAL,
      bounce_from_low REAL,
      high_range_active INTEGER,
      run_from_low_10m REAL,
      run_from_low_60m REAL,
      exhaustion_votes INTEGER,
      pullback INTEGER,
      lower_high INTEGER,
      sell_pressure INTEGER,
      micro_drop INTEGER,
      falling_lock_active INTEGER,
      stable_enough INTEGER,
      entry_range_mode TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_metrics_captured ON runtime_metrics(captured_at_ms);
  `);

  const insertMetric = database.prepare(`
    INSERT OR REPLACE INTO runtime_metrics (
      captured_at_ms, mode, price, high24h, low24h, range_position, best_bid, best_ask,
      ask_share_5m, bid_share_5m, ask_share_30s, move_30s, move_4m, move_5m, move_10m,
      bounce_from_low, high_range_active, run_from_low_10m, run_from_low_60m, exhaustion_votes,
      pullback, lower_high, sell_pressure, micro_drop, falling_lock_active, stable_enough, entry_range_mode
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const countMetrics = database.prepare("SELECT COUNT(*) AS count FROM runtime_metrics");
  const deleteExpired = database.prepare("DELETE FROM runtime_metrics WHERE captured_at_ms < ?");
  const readHistory = database.prepare(`
    SELECT * FROM (
      SELECT * FROM runtime_metrics WHERE captured_at_ms >= ? ORDER BY captured_at_ms DESC LIMIT ?
    ) ORDER BY captured_at_ms ASC
  `);

  let databaseRows = Number(countMetrics.get().count) || 0;
  let latestSnapshot = null;
  let lastDatabaseWriteAt = 0;
  let lastPruneAt = 0;
  let timer = null;
  const subscribers = new Set();

  const stateFile = path.join(absoluteRoot, "state.json");
  const summaryFile = path.join(absoluteRoot, "summary_24h.json");

  function buildSnapshot() {
    const runtime = getRuntime() ?? {};
    const state = getState() ?? {};
    const events = eventsReader();
    const trades = tradesReader();
    const signals = signalsReader();
    return {
      mode: "live",
      generatedAt: new Date().toISOString(),
      dataDirectoryConfigured: true,
      dataDirectory: absoluteRoot,
      runtime,
      state,
      summary24h: readJson(summaryFile),
      events: events.records,
      trades: trades.records,
      signals: signals.records,
      files: {
        state: jsonFileState(stateFile),
        summary24h: jsonFileState(summaryFile),
        events: events.file,
        trades: trades.file,
        signals: signals.file,
        runtimeDb: databaseFileState(databasePath, databaseRows),
      },
    };
  }

  function persistRuntime(runtime) {
    const downside = runtime.downsideContext ?? {};
    const regime = runtime.regimeV518 ?? {};
    const caution = regime.highRangeCaution ?? {};
    const falling = regime.fallingMarketLock ?? {};
    const preEntry = regime.preEntryFalling ?? {};
    const rowTime = Date.now();
    const position = fraction(downside.rangePosition24h);
    insertMetric.run(
      rowTime,
      runtime.mode ?? null,
      finite(runtime.lastPrice),
      finite(downside.high24h),
      finite(downside.low24h),
      position,
      finite(runtime.bestBid),
      finite(runtime.bestAsk),
      fraction(runtime.askShare5m),
      fraction(runtime.bidShare5m),
      fraction(runtime.askShare30s),
      fraction(runtime.priceMove30s),
      fraction(preEntry.move4m),
      fraction(preEntry.move5m),
      fraction(preEntry.move10m),
      fraction(falling.bounceFromLow5m),
      percentFlag(caution.active),
      fraction(caution.runFromLow10m),
      fraction(caution.runFromLow60m),
      finite(caution.exhaustionVotes),
      percentFlag(caution.pullback),
      percentFlag(caution.lowerHigh),
      percentFlag(caution.sellPressure),
      percentFlag(caution.microDrop),
      percentFlag(falling.active),
      percentFlag(falling.stableEnough),
      regime.entryZone?.rangeMode ?? null,
    );
    databaseRows = Number(countMetrics.get().count) || 0;

    if (rowTime - lastPruneAt >= 60 * 60 * 1000) {
      deleteExpired.run(rowTime - HISTORY_RETENTION_MS);
      databaseRows = Number(countMetrics.get().count) || 0;
      lastPruneAt = rowTime;
    }
    lastDatabaseWriteAt = rowTime;
  }

  function refresh() {
    try {
      latestSnapshot = buildSnapshot();
      const now = Date.now();
      if (now - lastDatabaseWriteAt >= HISTORY_INTERVAL_MS) persistRuntime(latestSnapshot.runtime);
      latestSnapshot.files.runtimeDb = databaseFileState(databasePath, databaseRows);
      const payload = `event: snapshot\ndata: ${JSON.stringify(latestSnapshot)}\n\n`;
      for (const response of subscribers) response.write(payload);
    } catch (error) {
      console.error("⚠️ Dashboard API refresh failed:", error.message);
    }
  }

  function sendJson(response, statusCode, value) {
    response.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify(value));
  }

  function sendStatic(requestPath, response) {
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(requestPath);
    } catch {
      response.writeHead(400);
      response.end("Bad path");
      return;
    }
    const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
    const candidate = path.resolve(dashboardDist, relativePath);
    if (candidate !== dashboardDist && !candidate.startsWith(`${dashboardDist}${path.sep}`)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }
    const filePath = fs.existsSync(candidate) && fs.statSync(candidate).isFile()
      ? candidate
      : path.join(dashboardDist, "index.html");
    if (!fs.existsSync(filePath)) {
      response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Dashboard assets are missing. Run npm run build in the dashboard folder.");
      return;
    }
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": path.basename(filePath) === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    });
    fs.createReadStream(filePath).pipe(response);
  }

  function historyFromRequest(url) {
    const hoursValue = finite(url.searchParams.get("hours"));
    const hours = Math.max(1, Math.min(168, hoursValue ?? 24));
    const limitValue = Math.floor(finite(url.searchParams.get("limit")) ?? 10_000);
    const limit = Math.max(1, Math.min(10_000, limitValue));
    const since = Date.now() - hours * 60 * 60 * 1000;
    const rows = readHistory.all(since, limit);
    return rows.map((row) => ({
      time: row.captured_at_ms,
      mode: row.mode,
      lastPrice: row.price,
      high24h: row.high24h,
      low24h: row.low24h,
      rangePosition24h: row.range_position,
      bestBid: row.best_bid,
      bestAsk: row.best_ask,
      askShare5m: row.ask_share_5m,
      bidShare5m: row.bid_share_5m,
      askShare30s: row.ask_share_30s,
      priceMove30s: row.move_30s,
      move4m: row.move_4m,
      move5m: row.move_5m,
      move10m: row.move_10m,
      bounceFromLow5m: row.bounce_from_low,
      highRangeCaution: {
        active: row.high_range_active === null ? null : Boolean(row.high_range_active),
        runFromLow10m: row.run_from_low_10m,
        runFromLow60m: row.run_from_low_60m,
        exhaustionVotes: row.exhaustion_votes,
        pullback: row.pullback === null ? null : Boolean(row.pullback),
        lowerHigh: row.lower_high === null ? null : Boolean(row.lower_high),
        sellPressure: row.sell_pressure === null ? null : Boolean(row.sell_pressure),
        microDrop: row.micro_drop === null ? null : Boolean(row.micro_drop),
      },
      fallingMarketLock: {
        active: row.falling_lock_active === null ? null : Boolean(row.falling_lock_active),
        stableEnough: row.stable_enough === null ? null : Boolean(row.stable_enough),
      },
      entryRangeMode: row.entry_range_mode,
    }));
  }

  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname = requestUrl.pathname;

    if (pathname.startsWith("/api/") || pathname === "/events") {
      if (request.method !== "GET") {
        response.writeHead(405, { Allow: "GET" });
        response.end("Method not allowed");
        return;
      }
      if (pathname === "/api/health") {
        sendJson(response, 200, { ok: true, botVersion: "5.1.8", processId: process.pid, dataDirectory: absoluteRoot });
        return;
      }
      if (pathname === "/api/snapshot") {
        sendJson(response, 200, latestSnapshot ?? buildSnapshot());
        return;
      }
      if (pathname === "/api/history") {
        sendJson(response, 200, { dataDirectory: absoluteRoot, retentionDays: 7, records: historyFromRequest(requestUrl) });
        return;
      }
      if (pathname === "/events") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        response.write(`event: snapshot\ndata: ${JSON.stringify(latestSnapshot ?? buildSnapshot())}\n\n`);
        subscribers.add(response);
        const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 15_000);
        request.on("close", () => {
          clearInterval(heartbeat);
          subscribers.delete(response);
        });
        return;
      }
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end("Method not allowed");
      return;
    }
    sendStatic(pathname, response);
  });

  function start() {
    refresh();
    timer = setInterval(refresh, 1000);
    server.on("error", (error) => {
      if (error.code === "EADDRINUSE") {
        console.error(`⚠️ Dashboard API port ${port} is occupied. Free that port and restart V5.1.8 to enable its live API.`);
      } else {
        console.error("⚠️ Dashboard API failed:", error.message);
      }
    });
    server.listen(port, "127.0.0.1", () => {
      console.log(`📊 Dashboard API (same bot process) at http://127.0.0.1:${port}`);
    });
  }

  function close() {
    if (timer) clearInterval(timer);
    for (const response of subscribers) response.end();
    subscribers.clear();
    server.close();
    database.close();
  }

  return { start, close, server, databasePath };
}

module.exports = { createRuntimeApi };
