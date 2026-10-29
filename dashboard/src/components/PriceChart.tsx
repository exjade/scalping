import { useEffect, useMemo, useRef } from "react";
import {
  AreaSeries,
  ColorType,
  CrosshairMode,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { BotSnapshot, JsonRecord } from "../../shared/types.js";
import type { MarketData } from "../lib/derive.js";
import { eventTime, getPath, numberValue, pickNumber } from "../lib/derive.js";
import { price } from "../lib/format.js";

type Props = { snapshot: BotSnapshot; market: MarketData };

type ChartPoint = { time: UTCTimestamp; value: number };
type ChartMarker = { time: UTCTimestamp; position: "aboveBar" | "belowBar"; color: string; shape: "arrowUp" | "arrowDown" | "circle" | "square"; text: string };

const EVENT_MARKER_MAX_DISTANCE_SECONDS = 20;

function nearestPointTime(points: Map<number, number>, target: number): number | null {
  let nearest: number | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const time of points.keys()) {
    const nextDistance = Math.abs(time - target);
    if (nextDistance < distance) {
      nearest = time;
      distance = nextDistance;
    }
  }
  return distance <= EVENT_MARKER_MAX_DISTANCE_SECONDS ? nearest : null;
}

function makePoints(snapshot: BotSnapshot, market: MarketData): { points: ChartPoint[]; markers: ChartMarker[] } {
  const values = new Map<number, number>();
  const observedValues = new Map<number, number>();
  for (const sample of market.samples) {
    const time = Math.floor(sample.time / 1000);
    values.set(time, sample.value);
    observedValues.set(time, sample.value);
  }
  const markers: ChartMarker[] = [];

  for (const trade of snapshot.trades) {
    const time = eventTime(trade);
    const type = String(trade.type ?? "").toUpperCase();
    if (time === null) continue;
    const isBuy = type.includes("BUY") || type.includes("RECOVERY") && (type.includes("OPEN") || type.includes("START"));
    const isRecovery = type.includes("RECOVERY");
    const value = numberValue(isBuy ? trade.entryPrice ?? trade.price : trade.sellPrice ?? trade.exitPrice ?? trade.price);
    if (value === null || value <= 0) continue;
    const seconds = Math.floor(time / 1000);
    values.set(seconds, value);
    markers.push({
      time: seconds as UTCTimestamp,
      position: isBuy ? "belowBar" : "aboveBar",
      color: isBuy ? "#63c99b" : "#e18b83",
      shape: isBuy ? "arrowUp" : "arrowDown",
      text: isRecovery ? "R" : type.includes("HARD_STOP") ? "X" : isBuy ? "B" : "S",
    });
  }

  for (const item of snapshot.signals) {
    const time = eventTime(item);
    if (time === null) continue;
    const signal = item.signal && typeof item.signal === "object" ? item.signal as JsonRecord : item;
    const signalPrice = pickNumber(
      getPath(signal, "metric.current"),
      signal.currentPrice,
      signal.marketPrice,
      signal.lastPrice,
      signal.price,
    );
    const exactTime = Math.floor(time / 1000);
    let markerTime = exactTime;
    if (signalPrice !== null && signalPrice > 0) values.set(exactTime, signalPrice);
    else {
      const nearest = nearestPointTime(observedValues, exactTime);
      if (nearest === null) continue;
      markerTime = nearest;
    }
    const failedConditions = getPath(signal, "failedConditions");
    const blocked = signal.ok === false || Array.isArray(failedConditions) && failedConditions.length > 0;
    const hardSignal = signal.hardSignal === true;
    markers.push({
      time: markerTime as UTCTimestamp,
      position: "aboveBar",
      color: blocked ? "#d8ab68" : hardSignal ? "#63c99b" : "#83a9e9",
      shape: "circle",
      text: hardSignal ? "+" : "!",
    });
  }

  for (const event of snapshot.events) {
    const time = eventTime(event);
    const type = String(event.type ?? "").toUpperCase();
    if (time === null || !/LOCK|RECOVERY|BREAKDOWN|TARGET|CAUTION/i.test(type)) continue;
    const value = pickNumber(event.currentPrice, event.marketPrice, event.lastPrice, event.price);
    const exactTime = Math.floor(time / 1000);
    let markerTime = exactTime;
    if (value !== null && value > 0) {
      values.set(exactTime, value);
      observedValues.set(exactTime, value);
    } else {
      // Activation events often persist a trigger threshold but no market quote.
      // Anchor the marker to a nearby persisted quote instead of plotting that threshold.
      const nearest = nearestPointTime(observedValues, exactTime);
      if (nearest === null) continue;
      markerTime = nearest;
    }
    const isLock = type.includes("LOCK") || type.includes("BREAKDOWN");
    markers.push({
      time: markerTime as UTCTimestamp,
      position: isLock && /RELEASE|RELEASED/.test(type) ? "belowBar" : isLock ? "aboveBar" : "belowBar",
      color: isLock ? "#d8ab68" : "#83a9e9",
      shape: isLock ? "square" : "circle",
      text: type.includes("LOCK") ? /RELEASE|RELEASED/.test(type) ? "U" : "L" : type.includes("CAUTION") ? "C" : type.includes("RECOVERY") ? "R" : type.includes("BREAKDOWN") ? "D" : "T",
    });
  }

  const uniqueMarkers = new Map<string, ChartMarker>();
  for (const marker of markers) {
    const key = `${marker.time}:${marker.position}:${marker.color}:${marker.shape}:${marker.text}`;
    uniqueMarkers.set(key, marker);
  }
  return {
    points: [...values.entries()].sort(([a], [b]) => a - b).map(([time, value]) => ({ time: time as UTCTimestamp, value })),
    markers: [...uniqueMarkers.values()].sort((a, b) => Number(a.time) - Number(b.time)),
  };
}

export function PriceChart({ snapshot, market }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const markerApiRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const fittedRef = useRef(false);
  const chartData = useMemo(() => makePoints(snapshot, market), [snapshot, market]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const chart = createChart(element, {
      width: element.clientWidth,
      height: element.clientHeight || 320,
      layout: {
        background: { type: ColorType.Solid, color: "#101419" },
        textColor: "#7f8a96",
        attributionLogo: true,
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        fontSize: 11,
      },
      grid: { vertLines: { color: "rgba(255,255,255,.035)" }, horzLines: { color: "rgba(255,255,255,.045)" } },
      crosshair: { mode: CrosshairMode.Magnet, vertLine: { color: "rgba(131,169,233,.32)", labelBackgroundColor: "#263346" }, horzLine: { color: "rgba(131,169,233,.32)", labelBackgroundColor: "#263346" } },
      rightPriceScale: { borderColor: "rgba(255,255,255,.07)", scaleMargins: { top: 0.14, bottom: 0.14 } },
      timeScale: { borderColor: "rgba(255,255,255,.07)", timeVisible: true, secondsVisible: false, rightOffset: 3 },
      localization: { priceFormatter: (value: number) => price(value, 4) },
    });
    const series = chart.addSeries(AreaSeries, {
      lineColor: "#81a5e7",
      topColor: "rgba(103,143,211,.25)",
      bottomColor: "rgba(103,143,211,.015)",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerBorderColor: "#b8cefa",
      crosshairMarkerBackgroundColor: "#81a5e7",
    });
    chartRef.current = chart;
    seriesRef.current = series;
    markerApiRef.current = createSeriesMarkers(series, []);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      const height = entries[0]?.contentRect.height;
      if (width && height) chart.applyOptions({ width, height });
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      markerApiRef.current = null;
      priceLinesRef.current = [];
    };
  }, []);

  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;
    series.setData(chartData.points);
    markerApiRef.current?.setMarkers(chartData.markers);
    for (const line of priceLinesRef.current) series.removePriceLine(line);
    priceLinesRef.current = [];
    const addLine = (value: number | null, title: string, color: string) => {
      if (value === null) return;
      priceLinesRef.current.push(series.createPriceLine({ price: value, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title }));
    };
    addLine(market.high24h, "24H HIGH", "rgba(221,151,139,.62)");
    addLine(market.low24h, "24H LOW", "rgba(110,190,155,.62)");
    addLine(market.support60m, "SUPPORT 60M", "rgba(131,169,233,.60)");
    const highAnchor = numberValue(snapshot.state?.low24hAnchor);
    if (highAnchor !== null && highAnchor !== market.low24h) addLine(highAnchor, "RECOVERY ANCHOR", "rgba(221,171,104,.6)");
    const position = snapshot.state?.position && typeof snapshot.state.position === "object" ? snapshot.state.position as JsonRecord : {};
    addLine(numberValue(position.entryPrice), "ENTRY", "rgba(131,169,233,.48)");
    addLine(numberValue(position.sellTarget ?? position.target), "TARGET", "rgba(130,200,164,.55)");
    const recoveries = Array.isArray(snapshot.state?.recoveryPositions) ? snapshot.state.recoveryPositions : [];
    recoveries.forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      const recovery = item as JsonRecord;
      const anchor = numberValue(recovery.low24hAnchor ?? recovery.anchorPrice);
      const hardStop = numberValue(recovery.hardStopBreakPrice ?? recovery.anchorBreakPrice);
      addLine(anchor, `RECOVERY ANCHOR ${index + 1}`, "rgba(221,171,104,.6)");
      addLine(hardStop, `HARD STOP ${index + 1}`, "rgba(222,130,124,.58)");
    });
    if (!fittedRef.current && chartData.points.length > 1) {
      chart.timeScale().fitContent();
      fittedRef.current = true;
    }
  }, [chartData, market, snapshot.state]);

  return (
    <div className="chart-wrap">
      <div className="chart-legend">
        <span><i className="legend-dot legend-price" />Price</span>
        <span><i className="legend-line legend-high" />24h high / low</span>
        <span><i className="legend-dot legend-buy" />B · BUY</span>
        <span><i className="legend-dot legend-sell" />S · SELL</span>
        <span><i className="legend-dot legend-signal" />! · SIGNAL</span>
        <span><i className="legend-square legend-lock" />L LOCK / U RELEASE</span>
        <span><i className="legend-dot legend-recovery" />R · RECOVERY</span>
      </div>
      <div className="chart-canvas" ref={containerRef} />
      {chartData.points.length < 2 && <div className="chart-empty"><span className="pulse-dot" />Waiting for more market observations</div>}
      <div className="chart-credit">Charting by <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">TradingView</a> · Copyright (с) 2025 TradingView, Inc. · local bot records</div>
    </div>
  );
}
