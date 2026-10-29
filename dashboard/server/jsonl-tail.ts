import { open, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import type { FileState, JsonRecord } from "../shared/types.js";

const CHUNK_SIZE = 64 * 1024;

export class JsonlTail {
  private offset = 0;
  private carry = "";
  private identity = "";
  private decoder = new StringDecoder("utf8");
  private records: JsonRecord[] = [];
  private parseErrors = 0;
  private lastModifiedAt: string | null = null;
  private lastModifiedMs = 0;

  constructor(private readonly filePath: string) {}

  async refresh(): Promise<{ records: JsonRecord[]; file: FileState }> {
    let info;
    try {
      info = await stat(this.filePath);
    } catch {
      this.reset();
      return { records: [], file: this.fileState(false, 0) };
    }

    const identity = `${info.dev}:${info.ino}`;
    if (identity !== this.identity || info.size < this.offset || info.size === this.offset && this.offset > 0 && info.mtimeMs !== this.lastModifiedMs) {
      this.reset();
      this.identity = identity;
    }

    this.lastModifiedAt = info.mtime.toISOString();
    if (info.size > this.offset) {
      const handle = await open(this.filePath, "r");
      try {
        const bytes = Buffer.alloc(CHUNK_SIZE);
        while (this.offset < info.size) {
          const { bytesRead } = await handle.read(bytes, 0, Math.min(bytes.length, info.size - this.offset), this.offset);
          if (!bytesRead) break;
          this.offset += bytesRead;
          this.consume(this.decoder.write(bytes.subarray(0, bytesRead)));
        }
      } finally {
        await handle.close();
      }
    }
    this.lastModifiedMs = info.mtimeMs;

    return { records: [...this.records], file: this.fileState(true, info.size) };
  }

  private consume(text: string): void {
    const lines = `${this.carry}${text}`.split(/\r?\n/);
    this.carry = lines.pop() ?? "";
    for (const line of lines) this.parseLine(line);
  }

  private parseLine(line: string): void {
    const content = line.trim();
    if (!content) return;
    try {
      const value: unknown = JSON.parse(content);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        this.records.push(value as JsonRecord);
      }
    } catch {
      this.parseErrors += 1;
    }
  }

  private fileState(exists: boolean, bytes: number): FileState {
    return {
      exists,
      bytes,
      records: this.records.length,
      parseErrors: this.parseErrors,
      partialLine: Boolean(this.carry),
      lastModifiedAt: this.lastModifiedAt,
    };
  }

  private reset(): void {
    this.offset = 0;
    this.carry = "";
    this.identity = "";
    this.decoder = new StringDecoder("utf8");
    this.records = [];
    this.parseErrors = 0;
    this.lastModifiedAt = null;
    this.lastModifiedMs = 0;
  }
}
