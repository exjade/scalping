export type JsonRecord = Record<string, unknown>;

export type FileState = {
  exists: boolean;
  bytes: number;
  records: number;
  parseErrors: number;
  partialLine: boolean;
  lastModifiedAt: string | null;
};

export type BotSnapshot = {
  mode: "live" | "demo";
  generatedAt: string;
  state: JsonRecord | null;
  summary24h: JsonRecord | null;
  events: JsonRecord[];
  trades: JsonRecord[];
  signals: JsonRecord[];
  runtime?: JsonRecord | null;
  runtimeHistory?: JsonRecord[];
  files: Record<string, FileState>;
  dataDirectoryConfigured: boolean;
  dataDirectory?: string | null;
};
