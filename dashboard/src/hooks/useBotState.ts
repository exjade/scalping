import { useEffect, useState } from "react";
import type { BotSnapshot, JsonRecord } from "../../shared/types.js";
import { mergeBotSnapshots } from "../lib/history.js";

type StreamStatus = "connecting" | "connected" | "reconnecting";

export function useBotState(): { snapshot: BotSnapshot | null; streamStatus: StreamStatus; loadError: string | null } {
  const [snapshot, setSnapshot] = useState<BotSnapshot | null>(null);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("connecting");
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let source: EventSource | null = null;

    const connectStream = () => {
      if (!active || source) return;
      source = new EventSource("/events");
      source.addEventListener("open", () => { if (active) setStreamStatus("connected"); });
      source.addEventListener("snapshot", (event) => {
        try {
          const next = JSON.parse((event as MessageEvent<string>).data) as BotSnapshot;
          if (active) {
            setSnapshot((previous) => mergeBotSnapshots(previous, next));
            setStreamStatus("connected");
          }
        } catch {
          if (active) setLoadError("Se recibió una actualización incompleta; esperando la siguiente lectura.");
        }
      });
      source.addEventListener("error", () => { if (active) setStreamStatus("reconnecting"); });
    };

    const load = async () => {
      let runtimeHistory: JsonRecord[] = [];
      let historyDirectory: string | null = null;
      let historyLoaded = false;
      let warning: string | null = null;

      try {
        try {
          const historyResponse = await fetch("/api/history?hours=24&limit=10000");
          if (historyResponse.ok) {
            const history = await historyResponse.json() as { records?: unknown; dataDirectory?: unknown };
            runtimeHistory = Array.isArray(history.records)
              ? history.records.filter((item): item is JsonRecord => Boolean(item && typeof item === "object"))
              : [];
            historyDirectory = typeof history.dataDirectory === "string" ? history.dataDirectory : null;
            historyLoaded = true;
          }
        } catch {
          // Continue to restore JSONL and current state; report the missing DB below.
        }

        const response = await fetch("/api/snapshot");
        if (!response.ok) throw new Error(`API ${response.status}`);
        const data = await response.json() as BotSnapshot;
        const snapshotDirectory = typeof data.dataDirectory === "string" ? data.dataDirectory : null;
        const normalizeDirectory = (value: string) => value.replace(/[\\/]+/g, "\\").replace(/\\$/, "").toLowerCase();
        if (historyDirectory && snapshotDirectory && normalizeDirectory(historyDirectory) !== normalizeDirectory(snapshotDirectory)) {
          runtimeHistory = [];
          warning = "La base de datos histórica pertenece a otra carpeta; no se mezcló con los archivos del bot actual.";
        } else if (!historyLoaded && data.runtime) {
          warning = "No se pudo cargar runtime_metrics.sqlite. Se restauraron los eventos, señales y operaciones persistidos.";
        }

        const restored = mergeBotSnapshots(null, { ...data, runtimeHistory });
        if (active) {
          setSnapshot((previous) => mergeBotSnapshots(previous, restored));
          setLoadError(warning);
          // The persisted snapshot is the required base; SSE only follows it.
          connectStream();
        }
      } catch {
        if (active) {
          setLoadError("No se pudo restaurar el snapshot persistido del bot.");
          setStreamStatus("reconnecting");
        }
      }
    };
    void load();
    return () => {
      active = false;
      source?.close();
    };
  }, []);

  return { snapshot, streamStatus, loadError };
}
