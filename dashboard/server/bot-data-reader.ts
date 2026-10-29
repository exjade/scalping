import { readFileSync, watch, type FSWatcher } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import type { BotSnapshot, FileState, JsonRecord } from "../shared/types.js";
import { JsonlTail } from "./jsonl-tail.js";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const LOG_FILES = {
  events: "events.jsonl",
  trades: "paper_trades.jsonl",
  signals: "signals.jsonl",
};

const EMPTY_FILE = (): FileState => ({
  exists: false,
  bytes: 0,
  records: 0,
  parseErrors: 0,
  partialLine: false,
  lastModifiedAt: null,
});

export class BotDataReader {
  private readonly tails: Record<keyof typeof LOG_FILES, JsonlTail>;
  private readonly listenerSet = new Set<(snapshot: BotSnapshot) => void>();
  private readonly mode: "live" | "demo";
  private readonly dataDir: string;
  private watcher: FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private refreshAgain = false;
  private snapshot: BotSnapshot;
  private stateParseErrors = 0;
  private summaryParseErrors = 0;

  constructor() {
    const configured = this.resolveDataDirectory();
    this.mode = configured ? "live" : "demo";
    this.dataDir = configured ?? path.resolve(process.cwd(), "fixtures");
    this.tails = {
      events: new JsonlTail(path.join(this.dataDir, LOG_FILES.events)),
      trades: new JsonlTail(path.join(this.dataDir, LOG_FILES.trades)),
      signals: new JsonlTail(path.join(this.dataDir, LOG_FILES.signals)),
    };
    this.snapshot = {
      mode: this.mode,
      generatedAt: new Date().toISOString(),
      state: null,
      summary24h: null,
      events: [],
      trades: [],
      signals: [],
      dataDirectoryConfigured: Boolean(configured),
      dataDirectory: configured ?? this.dataDir,
      files: {
        state: EMPTY_FILE(),
        summary24h: EMPTY_FILE(),
        events: EMPTY_FILE(),
        trades: EMPTY_FILE(),
        signals: EMPTY_FILE(),
      },
    };
  }

  async start(): Promise<void> {
    await this.refresh();
    if (this.mode === "live") {
      try {
        this.watcher = watch(this.dataDir, { persistent: true }, () => this.scheduleRefresh());
        this.watcher.on("error", () => this.scheduleRefresh());
      } catch {
        // The API remains available with the last valid snapshot if file watching is unsupported.
      }
    }
  }

  stop(): void {
    this.watcher?.close();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
  }

  current(): BotSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: BotSnapshot) => void): () => void {
    this.listenerSet.add(listener);
    return () => this.listenerSet.delete(listener);
  }

  private scheduleRefresh(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.refresh(), 90);
  }

  private refresh(): Promise<void> {
    if (this.refreshInFlight) {
      this.refreshAgain = true;
      return this.refreshInFlight;
    }
    this.refreshInFlight = this.readSnapshot().finally(() => {
      this.refreshInFlight = null;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        void this.refresh();
      }
    });
    return this.refreshInFlight;
  }

  private async readSnapshot(): Promise<void> {
    const [stateRead, summaryRead, eventsRead, tradesRead, signalsRead] = await Promise.all([
      this.readJson(path.join(this.dataDir, "state.json"), "state"),
      this.readJson(path.join(this.dataDir, "summary_24h.json"), "summary24h"),
      this.tails.events.refresh(),
      this.tails.trades.refresh(),
      this.tails.signals.refresh(),
    ]);

    this.snapshot = {
      mode: this.mode,
      generatedAt: new Date().toISOString(),
      state: stateRead.value,
      summary24h: summaryRead.value,
      events: eventsRead.records,
      trades: tradesRead.records,
      signals: signalsRead.records,
      dataDirectoryConfigured: this.mode === "live",
      dataDirectory: this.dataDir,
      files: {
        state: stateRead.file,
        summary24h: summaryRead.file,
        events: eventsRead.file,
        trades: tradesRead.file,
        signals: signalsRead.file,
      },
    };
    for (const listener of this.listenerSet) listener(this.snapshot);
  }

  private async readJson(filePath: string, field: "state" | "summary24h"): Promise<{ value: JsonRecord | null; file: FileState }> {
    try {
      const [content, info] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]);
      let value: JsonRecord | null = null;
      try {
        const parsed: unknown = JSON.parse(content);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed as JsonRecord;
      } catch {
        if (field === "state") this.stateParseErrors += 1;
        else this.summaryParseErrors += 1;
        value = this.snapshot[field];
      }
      const parseErrors = field === "state" ? this.stateParseErrors : this.summaryParseErrors;
      return {
        value,
        file: {
          exists: true,
          bytes: info.size,
          records: value ? 1 : 0,
          parseErrors,
          partialLine: false,
          lastModifiedAt: info.mtime.toISOString(),
        },
      };
    } catch {
      return { value: null, file: EMPTY_FILE() };
    }
  }

  private resolveDataDirectory(): string | null {
    const envDir = process.env.BOT_DATA_DIR?.trim();
    if (envDir) return path.resolve(process.cwd(), envDir);

    try {
      const configPath = path.resolve(process.cwd(), "dashboard.config.json");
      const config = JSON.parse(requireFileSync(configPath)) as { botDataDir?: unknown };
      if (typeof config.botDataDir === "string" && config.botDataDir.trim()) {
        return path.resolve(process.cwd(), config.botDataDir.trim());
      }
    } catch {
      // No config means the dashboard opens its clearly labeled demo dataset.
    }
    return null;
  }
}

function requireFileSync(filePath: string): string {
  // Kept as a tiny wrapper so config access remains explicit and read-only.
  return readFileSync(filePath, "utf8");
}
