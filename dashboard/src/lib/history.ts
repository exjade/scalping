import type { BotSnapshot, JsonRecord } from "../../shared/types.js";
import { eventTime } from "./derive.js";

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function textValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function recordKey(item: JsonRecord): string {
  const signal = asRecord(item.signal);
  const order = asRecord(item.order ?? signal.order);
  const type = textValue(item.type, item.event, item.signalType, signal.type) ?? "";
  const id = textValue(item.id, item.eventId, item.signalId, item.tradeId, item.fillId, item.lockId, item.recoveryId);
  if (id) return `id:${type}:${id}`;

  const orderId = textValue(item.orderId, item.clientOrderId, item.exchangeOrderId, order.orderId, order.clientOrderId, order.id);
  if (orderId) return `order:${type}:${orderId}`;

  const time = eventTime(item);
  if (time !== null) {
    const metric = asRecord(signal.metric);
    const value = textValue(item.currentPrice, item.marketPrice, item.lastPrice, item.price, item.entryPrice, item.sellPrice, item.orderPrice, signal.price, metric.current);
    const cycle = textValue(item.cycle);
    return `time:${time}:${type}:${cycle ?? ""}:${value ?? ""}`;
  }

  return `json:${JSON.stringify(item)}`;
}

export function mergeRecords(previous: JsonRecord[] = [], incoming: JsonRecord[] = []): JsonRecord[] {
  const byIdentity = new Map<string, JsonRecord>();
  for (const item of [...previous, ...incoming]) {
    if (item && typeof item === "object") byIdentity.set(recordKey(item), item);
  }
  return [...byIdentity.values()].sort((a, b) => (eventTime(a) ?? 0) - (eventTime(b) ?? 0));
}

function mergeRuntimeHistory(previous: JsonRecord[] = [], incoming: JsonRecord[] = []): JsonRecord[] {
  const byTime = new Map<string, JsonRecord>();
  for (const item of [...previous, ...incoming]) {
    const time = eventTime(item);
    byTime.set(time === null ? recordKey(item) : `time:${time}`, item);
  }
  return [...byTime.values()].sort((a, b) => (eventTime(a) ?? 0) - (eventTime(b) ?? 0));
}

export function mergeBotSnapshots(previous: BotSnapshot | null, incoming: BotSnapshot): BotSnapshot {
  return {
    ...(previous ?? {}),
    ...incoming,
    runtimeHistory: mergeRuntimeHistory(previous?.runtimeHistory, incoming.runtimeHistory),
    events: mergeRecords(previous?.events, incoming.events),
    trades: mergeRecords(previous?.trades, incoming.trades),
    signals: mergeRecords(previous?.signals, incoming.signals),
  };
}
