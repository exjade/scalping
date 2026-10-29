import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity, BarChart3, Check, CircleAlert,
  Database, Gauge, History, Info, LockKeyhole, Radio, Search, ShieldCheck,
  Signal, Target, WalletCards, Wifi, WifiOff, X,
} from "lucide-react";
import { PriceChart } from "./components/PriceChart.js";
import { useBotState } from "./hooks/useBotState.js";
import {
  cycleProfit, cycleRoi, deriveEngine, deriveMarket, derivePortfolio, entryExplanation,
  eventTime, exitTrades, feeRate, getPath, list, numberValue, pickNumber, record, targetGrossPercent,
} from "./lib/derive.js";
import { currency, dateTime, duration, label, percent, price, ratioPercent, shortTime } from "./lib/format.js";
import type { BotSnapshot, JsonRecord } from "../shared/types.js";

const moneyClass = (value: number | null) => value === null ? "" : value >= 0 ? "positive" : "negative";
const textValue = (source: unknown, ...keys: string[]) => {
  for (const key of keys) {
    const value = getPath(source, key);
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
};

function currentRecoveryRecords(snapshot: BotSnapshot): JsonRecord[] {
  const persisted = list(getPath(snapshot.state, "recoveryPositions"));
  const runtime = list(getPath(snapshot.runtime, "recovery.positions"));
  const runtimeById = new Map(runtime.map((item) => [String(item.id ?? ""), item]));
  const persistedIds = new Set(persisted.map((item) => String(item.id ?? "")));
  const merged = persisted.map((item) => {
    const live = runtimeById.get(String(item.id ?? ""));
    if (!live) return item;
    return {
      ...item,
      ...live,
      sourcePosition: { ...record(item.sourcePosition), ...record(live.sourcePosition) },
    };
  });
  return [...merged, ...runtime.filter((item) => !persistedIds.has(String(item.id ?? "")))];
}

function Panel({ title, eyebrow, icon: Icon, action, children, id, className = "" }: {
  title: string; eyebrow?: string; icon?: typeof Activity; action?: ReactNode; children: ReactNode; id?: string; className?: string;
}) {
  return (
    <section className={`panel ${className}`} id={id}>
      <div className="panel-heading">
        <div className="panel-heading-title">
          {Icon && <span className="panel-icon"><Icon size={15} strokeWidth={1.8} /></span>}
          <div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h2>{title}</h2></div>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function StatusPill({ children, tone = "neutral", dot = false }: { children: ReactNode; tone?: "neutral" | "green" | "amber" | "red" | "blue"; dot?: boolean }) {
  return <span className={`status-pill tone-${tone}`}>{dot && <i className="status-dot" />}{children}</span>;
}

const PAGE_LINKS = [
  { id: "overview", label: "Overview", title: "Market overview", description: "Current price, portfolio and the bot's live protection state." },
  { id: "chart", label: "Chart", title: "Market chart", description: "Price history, entry range, order flow and persisted markers." },
  { id: "trades", label: "Trades", title: "Paper trades", description: "Completed cycles and their recorded fills." },
  { id: "recovery", label: "Recovery", title: "Recovery & protection", description: "Open recovery positions, startup context and market locks." },
  { id: "signals", label: "Signals", title: "Signal history", description: "Persisted entry decisions with their conditions and market context." },
  { id: "execution", label: "Execution", title: "Execution audit", description: "Order placement, fill provenance and observed local data sources." },
  { id: "analytics", label: "Analytics", title: "Performance analytics", description: "Cycle results, fee model and realized equity over time." },
] as const;

type PageId = (typeof PAGE_LINKS)[number]["id"];

function pageFromHash(): PageId {
  const candidate = window.location.hash.slice(1);
  return PAGE_LINKS.some((page) => page.id === candidate) ? candidate as PageId : "overview";
}

function runtimeRegime(runtime: JsonRecord): JsonRecord {
  return record(runtime.regimeV519 ?? runtime.regimeV518);
}

function App() {
  const { snapshot, streamStatus, loadError } = useBotState();
  const [activePage, setActivePage] = useState<PageId>(pageFromHash);

  useEffect(() => {
    const syncFromAddress = () => setActivePage(pageFromHash());
    window.addEventListener("hashchange", syncFromAddress);
    window.addEventListener("popstate", syncFromAddress);
    return () => {
      window.removeEventListener("hashchange", syncFromAddress);
      window.removeEventListener("popstate", syncFromAddress);
    };
  }, []);

  if (!snapshot) return <div className="loading-screen"><div className="brand-mark">P</div><div className="loading-copy">Connecting to local observer<span className="loading-dots">···</span></div><div className="loading-line" /></div>;
  const state = record(snapshot.state);
  const runtime = record(snapshot.runtime);
  const runtimeProcessId = numberValue(runtime.processId);
  const runtimeVersion = String(runtime.version ?? "").replace(/^v/i, "");
  const runtimeConnected = runtimeProcessId !== null && /^5\.1\.8(?:\.|$)/.test(runtimeVersion);
  const market = deriveMarket(snapshot);
  const portfolio = derivePortfolio(snapshot, market);
  const engine = deriveEngine(state, runtime);
  const marketAge = market.priceTime ? Math.max(0, Date.now() - Date.parse(market.priceTime)) : null;
  const marketStale = marketAge !== null && marketAge > 120_000;
  const version = label(state.version, snapshot.mode === "demo" ? "5.1.8 demo" : "Unknown");
  const page = PAGE_LINKS.find((item) => item.id === activePage) ?? PAGE_LINKS[0];
  const navigateTo = (nextPage: PageId) => {
    if (window.location.hash !== `#${nextPage}`) window.history.pushState(null, "", `#${nextPage}`);
    setActivePage(nextPage);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#overview" onClick={(event) => { event.preventDefault(); navigateTo("overview"); }} aria-label="PEARL dashboard home"><span className="brand-mark">P</span><span className="brand-word">PEARL<span>OBSERVER</span></span></a>
        <nav className="top-nav" aria-label="Dashboard sections">
          {PAGE_LINKS.map((item) => <a key={item.id} className={activePage === item.id ? "nav-active" : ""} href={`#${item.id}`} aria-current={activePage === item.id ? "page" : undefined} onClick={(event) => { event.preventDefault(); navigateTo(item.id); }}>{item.label}</a>)}
        </nav>
        <div className="topbar-status">
          {snapshot.mode === "demo" ? <StatusPill tone="amber" dot>DEMO DATA</StatusPill> : <StatusPill tone={runtimeConnected ? "blue" : "amber"} dot>{runtimeConnected ? "BOT RUNTIME" : "FILE SNAPSHOT"}</StatusPill>}
          <StatusPill tone="green"><span className="paper-icon"><ShieldCheck size={12} /></span>PAPER TRADING</StatusPill>
          <span className={`stream-indicator ${runtimeConnected ? streamStatus : streamStatus === "connected" ? "file-only" : "reconnecting"}`} title={runtimeConnected ? `V${runtimeVersion} runtime process ${runtimeProcessId}` : streamStatus === "connected" ? "Connected only to the file reader; the bot runtime API is not attached" : "Waiting for the V5.1.8 runtime API"}>
            {runtimeConnected && streamStatus === "connected" ? <Wifi size={14} /> : <WifiOff size={14} />}
            <span>{runtimeConnected ? streamStatus === "connected" ? "LIVE API" : "RECONNECTING" : streamStatus === "connected" ? "FILES ONLY" : "NO BOT API"}</span>
          </span>
        </div>
      </header>

      {loadError && <div className="inline-notice"><CircleAlert size={15} />{loadError}</div>}

      <main id="top" className={`page-content page-${activePage}`}>
        {activePage !== "overview" && <>
          <section className="section-heading">
            <div><div className="eyebrow">PEARL / USDT · {page.label.toUpperCase()}</div><h1>{page.title}</h1><p>{page.description}</p></div>
            <div className="page-contextbar"><span>PRICE<strong>{price(market.price, 4)}</strong></span><span>24H RANGE<strong>{price(market.low24h)} — {price(market.high24h)}</strong></span><span>POSITION<strong>{ratioPercent(market.rangePosition)}</strong></span></div>
          </section>
        </>}

        {activePage === "overview" && <>
          <section className="market-header" id="overview">
            <div className="market-identity">
              <div className="token-orb">P</div>
              <div><div className="market-kicker">PAPER MARKET</div><h1>PEARL <span>/ USDT</span></h1><div className="market-subline"><span>Bot {version}</span><i />{marketStale ? <span className="warning-text">Last market observation {duration((marketAge ?? 0) / 1000)} ago</span> : <span>{runtimeConnected ? `Live process ${runtimeProcessId}` : "Local data observer"}</span>}</div></div>
            </div>
            <div className="market-price-block">
              <div className="market-price">{price(market.price, 4)}</div>
              <div className="market-price-meta">
                {market.price !== null && market.open24h !== null && market.open24h !== 0 ? <span className={moneyClass(((market.price / market.open24h) - 1) * 100)}>{percent(((market.price / market.open24h) - 1) * 100)}</span> : <span className="muted">24h change N/A</span>}
                <span className="price-source">{market.priceSource}</span>
              </div>
            </div>
            <div className="market-stats">
              <MiniMarketStat title="24H HIGH" value={price(market.high24h)} tone="red" />
              <MiniMarketStat title="24H LOW" value={price(market.low24h)} tone="green" />
              <MiniMarketStat title="RANGE POSITION" value={ratioPercent(market.rangePosition)} tone="blue" />
              <MiniMarketStat title="MARKET LINK" value={!runtimeConnected ? "FILES ONLY" : market.bid !== null && market.ask !== null ? marketStale ? "STALE" : "LIVE QUOTE" : "NO QUOTE"} tone={!runtimeConnected || marketStale ? "amber" : "neutral"} />
            </div>
          </section>

          {snapshot.mode === "live" && !runtimeConnected && <div className="market-data-note"><Info size={14} /><span>El snapshot actual viene de <b>{snapshot.dataDirectory ?? "la carpeta local"}</b>, pero no incluye el objeto del proceso del bot. Los campos de runtime aparecerán cuando la API integrada de V5.1.8 esté conectada.</span></div>}
          {snapshot.mode === "live" && runtimeConnected && market.high24h === null && <div className="market-data-note"><Info size={14} /><span>La API del proceso V{runtimeVersion} está conectada (PID {runtimeProcessId}); el ticker actual aún no reporta high de 24 h.</span></div>}

          <section className="portfolio-hero" aria-label="Portfolio overview">
            <div className="portfolio-primary">
              <div className="eyebrow">PORTFOLIO EQUITY <span className="info-mark" title="Equity is calculated from observed cash, PEARL and active recovery values."><Info size={12} /></span></div>
              <div className="equity-number">{currency(portfolio.equity)}</div>
              <div className="equity-caption"><span className={`equity-delta ${moneyClass(portfolio.total)}`}>{percent(portfolio.total === null || portfolio.contributed === null || portfolio.contributed === 0 ? null : (portfolio.total / portfolio.contributed) * 100)} ROI</span><span>Contributed {currency(portfolio.contributed)}</span></div>
            </div>
            <div className="portfolio-metrics">
              <Metric title="Realized PnL" value={currency(portfolio.realized)} raw={portfolio.realized} icon={BarChart3} note="closed cycles" />
              <Metric title="Unrealized PnL" value={currency(portfolio.unrealized)} raw={portfolio.unrealized} icon={Activity} note="mark to market" />
              <Metric title="Total PnL" value={currency(portfolio.total)} raw={portfolio.total} icon={Gauge} note="since contribution" />
              <Metric title="Scalp cash" value={currency(portfolio.scalpCash)} icon={WalletCards} note="available balance" />
              <Metric title="Recovery equity" value={currency(portfolio.recoveryEquity)} icon={ShieldCheck} note="active recovery" />
              <Metric title="PEARL held" value={portfolio.pearl === null ? "N/A" : `${portfolio.pearl.toFixed(4)} PEARL`} icon={Database} note="spot inventory" />
            </div>
            <div className="hero-orbit orbit-one" /><div className="hero-orbit orbit-two" />
          </section>

          <div className="dashboard-layout">
            <div className="main-column">
              <Panel title="Price action" eyebrow="MARKET STRUCTURE" icon={Activity} action={<div className="panel-live-label"><i />OBSERVED DATA</div>}>
                <PriceChart snapshot={snapshot} market={market} />
              </Panel>
              <RangePanel market={market} version={version} />
              <EntryZone snapshot={snapshot} market={market} engineMode={engine.mode} version={version} />
            </div>
            <aside className="side-column">
              <TradingEngine snapshot={snapshot} market={market} engine={engine} />
              <MarketProtection snapshot={snapshot} market={market} />
              <ActivityPanel snapshot={snapshot} limit={6} />
            </aside>
          </div>
        </>}

        {activePage === "chart" && <div className="page-stack">
          <Panel title="Price action" eyebrow="MARKET STRUCTURE" icon={Activity} id="chart" action={<div className="panel-live-label"><i />PERSISTED + LIVE</div>}><PriceChart snapshot={snapshot} market={market} /></Panel>
          <div className="page-grid page-grid-two"><RangePanel market={market} version={version} /><OrderFlow snapshot={snapshot} market={market} /></div>
          <HighRangePanel snapshot={snapshot} />
        </div>}

        {activePage === "trades" && <div className="page-stack">
          <PerformancePanel snapshot={snapshot} />
          <TradeHistory snapshot={snapshot} />
        </div>}

        {activePage === "recovery" && <div className="page-stack">
          <div className="page-grid page-grid-two"><MarketProtection snapshot={snapshot} market={market} /><RecoveryPanel snapshot={snapshot} market={market} version={version} /></div>
          <ActivityPanel snapshot={snapshot} filter="protection" limit={60} />
        </div>}

        {activePage === "signals" && <div className="page-stack">
          <SignalsPanel snapshot={snapshot} full />
          <div className="page-grid page-grid-two"><EntryZone snapshot={snapshot} market={market} engineMode={engine.mode} version={version} /><HighRangePanel snapshot={snapshot} /></div>
        </div>}

        {activePage === "execution" && <div className="page-stack">
          <ExecutionPanel snapshot={snapshot} full />
          <SourcesPanel snapshot={snapshot} />
        </div>}

        {activePage === "analytics" && <div className="page-stack">
          <div className="page-grid page-grid-two"><PerformancePanel snapshot={snapshot} /><ScalpEconomics snapshot={snapshot} /></div>
          <EquityCurve snapshot={snapshot} portfolio={portfolio} />
        </div>}

        <footer className="footer"><span>PEARL local observer · read-only</span><span>{runtimeConnected ? `Reads process ${runtimeProcessId} and persisted local records.` : "Reads the configured local data files."} No exchange credentials or order controls.</span></footer>
      </main>
    </div>
  );
}

function MiniMarketStat({ title, value, tone }: { title: string; value: string; tone: string }) {
  return <div className="mini-market-stat"><span>{title}</span><strong className={`mini-${tone}`}>{value}</strong></div>;
}

function Metric({ title, value, raw, icon: Icon, note }: { title: string; value: string; raw?: number | null; icon: typeof Activity; note: string }) {
  return <div className="metric-item"><div className="metric-top"><span>{title}</span><Icon size={14} strokeWidth={1.7} /></div><div className={`metric-value ${raw === undefined ? "" : moneyClass(raw)}`}>{value}</div><div className="metric-note">{note}</div></div>;
}

function RangePanel({ market, version }: { market: ReturnType<typeof deriveMarket>; version: string }) {
  const rules518 = version.startsWith("5.1.8");
  const position = market.rangePosition;
  const marker = position === null ? null : Math.min(100, Math.max(0, position * 100));
  const distanceFromLow = market.price !== null && market.low24h !== null && market.low24h !== 0 ? (market.price / market.low24h - 1) * 100 : null;
  const distanceToHigh = market.price !== null && market.high24h !== null && market.high24h !== 0 ? (market.price / market.high24h - 1) * 100 : null;
  const highBand = market.high24h === null ? null : Math.floor(market.high24h * 10) / 10;
  const allowedBand = highBand === null ? null : Math.round((highBand - 0.1) * 10) / 10;
  const nextUnlock = highBand === null ? null : Math.floor(highBand * 10 + 1) / 10;
  return (
    <Panel title="24h range & entry ladder" eyebrow="PRICE POSITIONING" icon={BarChart3}>
      <div className="range-card">
        <div className="range-labels"><div><span>LOW 24H</span><strong>{price(market.low24h)}</strong></div><div className="range-now-label">CURRENT {price(market.price)}</div><div className="range-label-right"><span>HIGH 24H</span><strong>{price(market.high24h)}</strong></div></div>
        <div className="range-track">{rules518 ? <><div className="range-segment normal" /><div className="range-segment caution" /><div className="range-segment blocked" /></> : <div className="range-segment unavailable" />}{marker !== null && <div className="range-marker" style={{ left: `${marker}%` }}><span>{price(market.price)}</span><i /></div>}</div>
        <div className="range-band-labels">{rules518 ? <><span>Normal <b>0–75%</b></span><span>Caution <b>75–82%</b></span><span>Top range blocked <b>82–100%</b></span></> : <span className="range-rules-unavailable">Range rules are not confirmed for V{version}</span>}</div>
        <div className="range-stat-row">
          <RangeStat label="Range position" value={ratioPercent(position)} />
          <RangeStat label="Distance from low" value={distanceFromLow === null ? "N/A" : `+${distanceFromLow.toFixed(2)}%`} tone="positive" />
          <RangeStat label="Distance to high" value={distanceToHigh === null ? "N/A" : `${distanceToHigh >= 0 ? "−" : "+"}${Math.abs(distanceToHigh).toFixed(2)}%`} />
        </div>
        {rules518 ? <div className="ladder-strip"><div className="ladder-info"><span className="ladder-glyph">⌁</span><div><span>Current allowed BUY ladder</span><strong>{allowedBand === null ? "N/A" : `${allowedBand.toFixed(1)}x band`}</strong></div></div><div className="ladder-info blocked-band"><span className="ladder-lock"><LockKeyhole size={14} /></span><div><span>High 24h ladder · blocked</span><strong>{highBand === null ? "N/A" : `${highBand.toFixed(1)}x band`}</strong></div></div><div className="ladder-unlock"><span>Next ladder unlock</span><strong>{nextUnlock === null ? "N/A" : `HIGH24H > ${nextUnlock.toFixed(4)}`}</strong></div></div> : <div className="rule-note">V5.1.8 ladder reference is hidden for this bot version.</div>}
      </div>
    </Panel>
  );
}

function RangeStat({ label: title, value, tone = "" }: { label: string; value: string; tone?: string }) {
  return <div className="range-stat"><span>{title}</span><strong className={tone}>{value}</strong></div>;
}

function EntryZone({ snapshot, market, engineMode, version }: { snapshot: BotSnapshot; market: ReturnType<typeof deriveMarket>; engineMode: string; version: string }) {
  const state = record(snapshot.state);
  const runtime = record(snapshot.runtime);
  const downside = record(runtime.downsideContext);
  const runtimeEntryZone = record(runtimeRegime(runtime).entryZone);
  const latestSignal = snapshot.signals.at(-1) ?? snapshot.events.slice().reverse().find((event) => event.signal);
  const signalOrder = record(getPath(latestSignal, "order"));
  const order = Object.keys(record(state.buyOrder)).length ? record(state.buyOrder) : signalOrder;
  const mode = String(order.allocationMode ?? runtimeEntryZone.allocationModeIfBuy ?? getPath(latestSignal, "signal.allocationMode") ?? engineMode ?? "N/A").toUpperCase();
  let allocation = numberValue(order.allocationFraction ?? getPath(latestSignal, "signal.allocationFraction"));
  if (allocation === null && version.startsWith("5.1.8") && market.rangePosition !== null) allocation = market.rangePosition >= 0.82 ? 0 : market.rangePosition >= 0.75 ? 0.3 : 1;
  const target = pickNumber(order.target, order.sellTarget, downside.previewTarget, state.position && getPath(state.position, "sellTarget"));
  const previewBuy = pickNumber(order.price, order.buyPrice, downside.previewBuy, state.position && getPath(state.position, "entryPrice"));
  return (
      <Panel title="Entry zone" eyebrow={version === "Unknown" ? "VERSION UNKNOWN · ENTRY CONTEXT" : `V${version} ENTRY CONTEXT`} icon={Target}>
      <div className="entry-summary"><div className="entry-mode"><span>ENTRY MODE</span><strong className={mode.includes("BLOCK") ? "negative" : mode.includes("CAUTION") ? "warning-text" : ""}>{label(mode)}</strong></div><StatusPill tone={allocation === 0 ? "red" : allocation !== null && allocation < 1 ? "amber" : "green"}>{allocation === null ? "N/A" : `${Math.round(allocation * 100)}% allocation`}</StatusPill></div>
      <div className="entry-values"><EntryValue label="Current price" value={price(market.price)} /><EntryValue label="Preview BUY" value={price(previewBuy)} /><EntryValue label="Preview target" value={price(target)} /><EntryValue label="24h range position" value={ratioPercent(market.rangePosition)} /></div>
      <div className="allocation-bar"><span style={{ width: `${allocation === null ? 0 : Math.max(0, Math.min(100, allocation * 100))}%` }} /></div>
      <div className="allocation-legend"><span><i className="alloc-full" />Normal 100%</span><span><i className="alloc-caution" />Caution 30%</span><span><i className="alloc-blocked" />Blocked 0%</span></div>
      <div className="explanation-box"><Info size={14} /><span>{version.startsWith("5.1.8") ? entryExplanation(market.rangePosition, allocation, mode) : "Entry allocation thresholds are not available for this bot version; the dashboard uses explicit logged order data only."}</span></div>
    </Panel>
  );
}

function EntryValue({ label: title, value }: { label: string; value: string }) {
  return <div className="entry-value"><span>{title}</span><strong>{value}</strong></div>;
}

function TradingEngine({ snapshot, market, engine }: { snapshot: BotSnapshot; market: ReturnType<typeof deriveMarket>; engine: ReturnType<typeof deriveEngine> }) {
  const state = record(snapshot.state);
  const runtime = record(snapshot.runtime);
  const order = engine.order;
  const position = engine.position;
  const buyOrder = record(state.buyOrder);
  const sellOrder = record(state.sellOrder);
  const recovery = currentRecoveryRecords(snapshot)[0] ?? {};
  const preview = record(getPath(runtime, "entryEngine.earlyArm"));
  const latestClosed = exitTrades(snapshot)[0];
  const hasBuyOrder = Object.keys(buyOrder).length > 0;
  const hasSellOrder = Object.keys(sellOrder).length > 0;
  const hasRecovery = Object.keys(recovery).length > 0;
  const entry = pickNumber(buyOrder.price, position.entryPrice, recovery.entryPrice, order.entryPrice);
  const target = pickNumber(sellOrder.price, position.sellTarget, position.target, recovery.recoveryTarget, buyOrder.target, preview.target);
  const capital = pickNumber(recovery.investedUSDT, order.cash, order.investedUSDT, position.investedUSDT, state.cash);
  const start = recovery.entryTimeMs ?? recovery.entryTime ?? position.openedAt ?? position.openedAtMs ?? order.placedAt ?? order.firstPlacedAt ?? order.time;
  const runtimeHoldSeconds = pickNumber(recovery.heldMinutes) === null ? null : pickNumber(recovery.heldMinutes)! * 60;
  const startMs = typeof start === "number" ? start : typeof start === "string" ? Date.parse(start) : NaN;
  const holdSeconds = runtimeHoldSeconds ?? (Number.isFinite(startMs) ? Math.max(0, (Date.now() - startMs) / 1000) : null);
  const progress = entry !== null && target !== null && market.price !== null && target > entry ? Math.min(100, Math.max(0, ((market.price - entry) / (target - entry)) * 100)) : null;
  const locked = engine.mode.includes("LOCK") || engine.mode.includes("BLOCK") || engine.mode.includes("DANGER");
  const hasActiveOrderOrPosition = hasBuyOrder || hasSellOrder || Object.keys(position).length > 0 || hasRecovery;
  const actualBuy = pickNumber(position.entryPrice, recovery.entryPrice, hasActiveOrderOrPosition ? null : latestClosed?.entryPrice);
  const actualSell = hasActiveOrderOrPosition ? null : pickNumber(latestClosed?.sellPrice, latestClosed?.exitPrice);
  const buyReference = hasActiveOrderOrPosition
    ? pickNumber(buyOrder.price, entry)
    : pickNumber(buyOrder.price, preview.buy, getPath(runtime, "downsideContext.previewBuy"));
  const sellReference = pickNumber(sellOrder.price, recovery.recoveryTarget, position.sellTarget, buyOrder.target, preview.target, getPath(runtime, "downsideContext.previewTarget"));
  const sellLabel = hasRecovery ? "Venta límite recovery activa" : hasSellOrder ? "Venta límite activa" : Object.keys(position).length ? "Objetivo de venta" : hasBuyOrder ? "Objetivo tras compra" : "Próximo objetivo de venta";
  const buyLabel = hasBuyOrder ? "Compra límite pendiente" : hasActiveOrderOrPosition ? "Precio BUY límite" : "Referencia próxima compra";
  const buyFillLabel = actualBuy !== null && hasActiveOrderOrPosition ? "Compra ejecutada" : actualBuy !== null ? "Última compra ejecutada" : "Compra ejecutada";
  const sellFillText = hasActiveOrderOrPosition ? "En espera" : actualSell !== null ? price(actualSell) : "Aún sin venta";
  const stateDescription = hasRecovery
    ? "BUY completada · RECOVERY SELL LIMIT en espera"
    : hasSellOrder
      ? "BUY completada · SELL LIMIT activa"
      : hasBuyOrder
        ? "BUY LIMIT abierta · esperando ejecución"
        : Object.keys(position).length
          ? "BUY completada · esperando salida"
          : "Sin operación abierta";
  return (
    <Panel title="Trading engine" eyebrow="BOT STATE" icon={Gauge} action={<span className="engine-pulse"><i />{locked ? "PROTECTION" : "OBSERVING"}</span>}>
      <div className={`engine-state ${locked ? "engine-locked" : engine.mode.includes("LIMIT") ? "engine-order" : ""}`}><div className="engine-state-icon">{locked ? <LockKeyhole size={19} /> : engine.mode.includes("LIMIT") ? <Target size={19} /> : <Activity size={19} />}</div><div><span>Current mode</span><strong>{label(engine.mode)}</strong></div><span className="engine-state-glow" /></div>
      {hasActiveOrderOrPosition ? <>
        <div className="engine-operation-status"><i />{stateDescription}</div>
        <div className="engine-order-grid engine-trade-prices"><EngineValue label={buyLabel} value={price(buyReference)} /><EngineValue label={buyFillLabel} value={actualBuy === null ? hasBuyOrder ? "Pendiente" : "Aún no comprada" : price(actualBuy)} /><EngineValue label={sellLabel} value={price(sellReference)} /><EngineValue label="Venta ejecutada" value={sellFillText} /><EngineValue label="Tiempo en posición" value={duration(holdSeconds)} /><EngineValue label="Capital comprometido" value={currency(capital)} /></div>
        {hasRecovery && pickNumber(getPath(recovery, "sourcePosition.sellTarget")) !== null && <div className="engine-previous-target">Target de venta scalp anterior: <b>{price(pickNumber(getPath(recovery, "sourcePosition.sellTarget")))}</b> · reemplazado por el target recovery actual.</div>}
        <div className="target-progress-heading"><span>Target progress</span><strong>{progress === null ? "N/A" : `${progress.toFixed(0)}%`}</strong></div>
        <div className="target-progress"><span style={{ width: `${progress ?? 0}%` }} /></div>
      </> : <div className="engine-empty"><strong>No active order or position</strong><span>Next BUY reference: <b>{price(buyReference)}</b> · sell target preview: <b>{price(sellReference)}</b>.</span>{capital !== null && <span>Available cash: <b>{currency(capital)}</b></span>}{latestClosed && <span>Last completed cycle: BUY <b>{price(pickNumber(latestClosed.entryPrice, latestClosed.buyPrice))}</b> · SELL <b>{price(pickNumber(latestClosed.sellPrice, latestClosed.exitPrice))}</b>.</span>}</div>}
      <div className="engine-note">{locked && engine.reason ? label(engine.reason) : locked ? "New buys are paused while the market protection lock is active." : hasActiveOrderOrPosition ? "State reported by the local paper trading process." : "No order is open; the bot is waiting for its next eligible entry."}</div>
    </Panel>
  );
}

function EngineValue({ label: title, value }: { label: string; value: string }) {
  return <div className="engine-value"><span>{title}</span><strong>{value}</strong></div>;
}

function MarketProtection({ snapshot, market }: { snapshot: BotSnapshot; market: ReturnType<typeof deriveMarket> }) {
  const state = record(snapshot.state);
  const runtime = record(snapshot.runtime);
  const regime = runtimeRegime(runtime);
  const runtimeLock = record(regime.fallingMarketLock);
  const runtimeStartup = record(regime.startupContext);
  const runtimePreEntry = record(regime.preEntryFalling);
  const lock = Object.keys(runtimeLock).length ? { ...record(state.fallingMarketLock), ...runtimeLock } : record(state.fallingMarketLock);
  const active = typeof runtimeLock.active === "boolean" ? runtimeLock.active : String(lock.status ?? "").toUpperCase() === "ACTIVE";
  const ready = typeof runtimeStartup.ready === "boolean" ? runtimeStartup.ready : snapshot.events.some((event) => String(event.type ?? "").toUpperCase().includes("READY")) || Boolean(state.startupContextReady);
  const stable = typeof runtimeLock.stableEnough === "boolean" ? runtimeLock.stableEnough : active ? false : snapshot.events.some((event) => String(event.type ?? "").toUpperCase().includes("STABLE ENOUGH")) || String(lock.status ?? "").toUpperCase() === "INACTIVE";
  const preEntry = typeof runtimePreEntry.active === "boolean" ? runtimePreEntry.active : active && String(lock.triggerReason ?? "").includes("PREENTRY") || state.preEntryFallingDetection === true;
  const checks = [
    { label: "Startup context collected", ok: ready },
    { label: "Falling market lock clear", ok: !active },
    { label: "Recent stability confirmation", ok: stable },
    { label: "No new meaningful low", ok: active && numberValue(runtimeLock.minutesSinceMeaningfulNewLow) !== null ? numberValue(runtimeLock.minutesSinceMeaningfulNewLow)! >= 5 : active && lock.lastMeaningfulNewLowAtMs ? Date.now() - Number(lock.lastMeaningfulNewLowAtMs) > 5 * 60_000 : !active },
  ];
  return (
    <Panel title="Market protection" eyebrow="MARKET REGIME" icon={ShieldCheck} action={<div className="panel-actions"><span className="trade-count">CTX {shortTime(market.contextTime)}</span><StatusPill tone={active ? "amber" : "green"} dot>{active ? "LOCK ACTIVE" : "CLEAR"}</StatusPill></div>}>
      <div className="protection-status"><div className={`protection-emblem ${active ? "emblem-active" : ""}`}>{active ? <LockKeyhole size={17} /> : <ShieldCheck size={17} />}</div><div><strong>{active ? "Falling market lock" : stable ? "Market stable" : "Protection ready"}</strong><span>{active ? "New BUYs paused until stability returns." : "Entry protections are monitoring the market."}</span></div></div>
      <div className="protection-grid"><ProtectionMetric label="Startup context" value={ready ? "READY" : "COLLECTING"} good={ready} /><ProtectionMetric label="Stable enough" value={active ? stable ? "YES" : "NO" : "NOT REQUIRED"} good={active ? stable : undefined} /><ProtectionMetric label="Pre-entry detection" value={preEntry ? "ACTIVE" : lock.status ? "INACTIVE" : label(state.preEntryFallingDetection, "N/A")} good={preEntry} /><ProtectionMetric label="Recent low age" value={market.minutesSinceLow === null ? "N/A" : `${market.minutesSinceLow.toFixed(1)} min`} /></div>
      <div className="protection-metrics">{[
        ["Move 30s", percent(market.move30s === null ? null : market.move30s * 100)], ["Move 4m", percent(market.move4m === null ? null : market.move4m * 100)], ["Move 5m", percent(market.move5m === null ? null : market.move5m * 100)], ["Move 10m", percent(market.move10m === null ? null : market.move10m * 100)], ["ASK 30s", market.askShare30s === null ? "Sin muestra" : ratioPercent(market.askShare30s)], ["ASK 5m", ratioPercent(market.askShare5m)], ["BID 5m", ratioPercent(market.bidShare5m)], ["Bounce", percent(market.bounceFromLow === null ? null : market.bounceFromLow * 100)],
      ].map(([name, value]) => <div className="protection-metric" key={name}><span>{name}</span><strong>{value}</strong></div>)}</div>
      {active && <div className="lock-checks">{checks.map((check) => <div className={check.ok ? "check-pass" : "check-wait"} key={check.label}>{check.ok ? <Check size={13} /> : <X size={13} />}<span>{check.label}</span><b>{check.ok ? "MET" : "PENDING"}</b></div>)}</div>}
    </Panel>
  );
}

function HighRangePanel({ snapshot }: { snapshot: BotSnapshot }) {
  const runtime = record(snapshot.runtime);
  const caution = record(runtimeRegime(runtime).highRangeCaution);
  const active = caution.active === true;
  const yesNo = (value: unknown) => typeof value === "boolean" ? value ? "YES" : "NO" : "N/A";
  const rows: Array<[string, string]> = [
    ["Run from low · 10m", String(caution.runFromLow10m ?? "N/A")],
    ["Run from low · 60m", String(caution.runFromLow60m ?? "N/A")],
    ["Exhaustion votes", caution.exhaustionVotes === undefined ? "N/A" : `${caution.exhaustionVotes} / 2`],
    ["Strong run", yesNo(caution.strongRun)],
    ["Pullback", yesNo(caution.pullback)],
    ["Lower high", yesNo(caution.lowerHigh)],
    ["Sell pressure", yesNo(caution.sellPressure)],
    ["Micro drop", yesNo(caution.microDrop)],
  ];
  return <Panel title="High-range context" eyebrow={`V${label(runtime.version, "5.1.8")} LIVE METRICS`} icon={Signal} action={<StatusPill tone={active ? "amber" : "neutral"} dot>{active ? "CAUTION ACTIVE" : "CLEAR"}</StatusPill>}>
    <div className="protection-grid">{rows.map(([name, value]) => <div className="protection-metric-large" key={name}><span>{name}</span><strong>{value}</strong></div>)}</div>
  </Panel>;
}

function ProtectionMetric({ label: title, value, good }: { label: string; value: string; good?: boolean }) {
  return <div className="protection-metric-large"><span>{title}</span><strong className={good === undefined ? "" : good ? "positive" : "warning-text"}>{value}</strong></div>;
}

function RecoveryPanel({ snapshot, market, version }: { snapshot: BotSnapshot; market: ReturnType<typeof deriveMarket>; version: string }) {
  const recoveries = currentRecoveryRecords(snapshot);
  const supportsDanger = /^5\.1\.(7|8)(?:$|\D)/.test(version);
  return (
    <Panel title="Recovery center" eyebrow="CAPITAL PROTECTION" icon={ShieldCheck} id="recovery" action={<StatusPill tone={recoveries.length ? "amber" : "neutral"}>{recoveries.length} ACTIVE</StatusPill>}>
      {recoveries.length === 0 ? <div className="empty-state compact"><div className="empty-icon"><ShieldCheck size={17} /></div><strong>No active recovery positions</strong><span>Recovery data will appear here when the bot records a position.</span></div> : <div className="recovery-list">{recoveries.map((item, index) => <RecoveryCard key={String(item.id ?? index)} recovery={item} market={market} supportsDanger={supportsDanger} />)}</div>}
      {supportsDanger && <div className="danger-note"><CircleAlert size={14} /><span><strong>−10% danger</strong> is a warning state. The anchored support break is a separate hard stop condition.</span></div>}
    </Panel>
  );
}

function RecoveryCard({ recovery, market, supportsDanger }: { recovery: JsonRecord; market: ReturnType<typeof deriveMarket>; supportsDanger: boolean }) {
  const sourcePosition = record(recovery.sourcePosition);
  const entry = pickNumber(recovery.entryPrice, recovery.entry, sourcePosition.entryPrice);
  const original = pickNumber(recovery.originalCapital, recovery.capital, recovery.investedUSDT);
  const quantity = pickNumber(recovery.pearl, recovery.pearlHeld, recovery.quantity, recovery.pearlReceived, sourcePosition.pearlReceived);
  const equity = pickNumber(recovery.netValueNow, recovery.currentEquity, recovery.equity, recovery.markedEquity, recovery.currentValue);
  const current = market.price;
  const markedRoi = numberValue(recovery.unrealizedROI);
  const lossPct = markedRoi ?? (equity !== null && original !== null && original > 0 ? (equity / original - 1) * 100 : entry !== null && current !== null && entry > 0 ? (current / entry - 1) * 100 : null);
  const anchor = pickNumber(recovery.low24hAnchor, recovery.anchorPrice);
  const hardStop = pickNumber(recovery.hardStopBreakPrice, recovery.anchorBreakPrice);
  const anchorDistance = anchor !== null && current !== null && anchor > 0 ? (current / anchor - 1) * 100 : null;
  const target = pickNumber(recovery.recoveryTarget, recovery.target);
  const previousSellTarget = pickNumber(sourcePosition.sellTarget, sourcePosition.target);
  const heldMinutes = pickNumber(recovery.heldMinutes);
  const entryTime = recovery.entryTimeMs ?? recovery.entryTime ?? sourcePosition.entryTimeMs ?? sourcePosition.entryTime ?? recovery.recoveryStartedAtMs ?? recovery.recoveryStartedAt;
  const parsedEntryTime = typeof entryTime === "number" ? entryTime : typeof entryTime === "string" ? Date.parse(entryTime) : NaN;
  const held = heldMinutes !== null ? heldMinutes * 60 : Number.isFinite(parsedEntryTime) ? Math.max(0, (Date.now() - parsedEntryTime) / 1000) : null;
  const danger = Boolean(recovery.dangerActive ?? recovery.dangerArmed ?? recovery.recoveryDanger);
  const dangerPct = pickNumber(recovery.dangerPct);
  const dangerLabel = dangerPct === null ? supportsDanger ? "−10% warning" : "Not available" : `−${(dangerPct * 100).toFixed(0)}% warning`;
  const buyLimit = pickNumber(sourcePosition.entryPrice, recovery.entryPrice, entry);
  const buyFill = pickNumber(recovery.entryPrice, sourcePosition.entryPrice, entry);
  const placedAt = recovery.recoveryOrderPlacedAtMs ?? recovery.recoveryStartedAtMs ?? recovery.recoveryStartedAt;
  const triggerPrice = pickNumber(sourcePosition.fillTriggerTradePrice);
  const confirmRemaining = pickNumber(recovery.anchorBreakConfirmRemainingSeconds, recovery.breakConfirmationSeconds);
  return <div className="recovery-card">
    <div className="recovery-head"><span className="recovery-id">{label(recovery.id, "RECOVERY POSITION")}</span><StatusPill tone={danger ? "red" : "green"}>{danger ? "DANGER ARMED" : "MONITORING"}</StatusPill></div>
    <div className="recovery-main"><div><span>Entry</span><strong>{price(entry)}</strong></div><div><span>Current</span><strong>{price(current)}</strong></div><div><span>Unrealized</span><strong className={lossPct !== null && lossPct < 0 ? "negative" : "positive"}>{percent(lossPct)}</strong></div></div>
    <div className="recovery-execution-path">
      <div className="recovery-execution-card recovery-buy-card">
        <div className="recovery-execution-head"><span>COMPRA · BUY LIMIT</span><StatusPill tone="green">EJECUTADA</StatusPill></div>
        <div className="recovery-execution-values"><div><span>Precio esperado</span><strong>{price(buyLimit)}</strong></div><div><span>Precio comprado</span><strong>{price(buyFill)}</strong></div></div>
        {triggerPrice !== null && <small>Trade que confirmó el fill: {price(triggerPrice)} · fill registrado al precio límite.</small>}
      </div>
      <div className="recovery-execution-card recovery-sell-card">
        <div className="recovery-execution-head"><span>VENTA · RECOVERY SELL LIMIT</span><StatusPill tone="blue">ACTIVA</StatusPill></div>
        <div className="recovery-execution-values"><div><span>Precio límite de salida</span><strong>{price(target)}</strong></div><div><span>Venta ejecutada</span><strong>Aún no vendida</strong></div></div>
        <small>Orden en espera desde {dateTime(placedAt)}.</small>
        {previousSellTarget !== null && <div className="recovery-prior-target">Target scalp anterior {price(previousSellTarget)} · sustituido por este target de recuperación.</div>}
      </div>
    </div>
    <div className="recovery-detail-grid"><RecoveryDetail label="Original capital" value={currency(original)} /><RecoveryDetail label="Current equity" value={currency(equity)} /><RecoveryDetail label="PEARL held" value={quantity === null ? "N/A" : quantity.toFixed(4)} /><RecoveryDetail label="Target" value={price(target)} /><RecoveryDetail label="Hold duration" value={duration(held)} /><RecoveryDetail label="Danger threshold" value={dangerLabel} /></div>
    <div className="anchor-structure"><span>LOW 24H ANCHOR</span><strong>{price(anchor)}</strong><span className="anchor-source">{label(recovery.low24hAnchorSource, "Source N/A")} · {dateTime(recovery.low24hAnchorAt)}</span><div className="anchor-progress"><span style={{ width: `${anchorDistance === null ? 0 : Math.max(0, Math.min(100, (anchorDistance / 1.5) * 100))}%` }} /></div><div className="anchor-bottom"><span>Distance {percent(anchorDistance)}</span><strong>Hard stop structure {price(hardStop)}</strong></div><span className="anchor-footnote">Break confirmation timer: {confirmRemaining === null ? "No confirmation pending" : duration(confirmRemaining)}</span></div>
  </div>;
}

function RecoveryDetail({ label: title, value }: { label: string; value: string }) {
  return <div className="recovery-detail"><span>{title}</span><strong>{value}</strong></div>;
}

function ActivityPanel({ snapshot, filter, limit = 7 }: { snapshot: BotSnapshot; filter?: "protection"; limit?: number }) {
  const allEvents = snapshot.events.slice().sort((a, b) => (eventTime(b) ?? 0) - (eventTime(a) ?? 0));
  const events = allEvents.filter((event) => !filter || /LOCK|RECOVERY|DANGER|BREAKDOWN|STABILITY/i.test(String(event.type ?? ""))).slice(0, limit);
  const title = filter === "protection" ? "Protection history" : "Live activity";
  return (
    <Panel title={title} eyebrow="PERSISTED BOT EVENTS" icon={Radio} action={<span className="trade-count">{events.length} shown</span>}>
      {events.length ? <div className="activity-list">{events.map((event, index) => <ActivityRow key={`${eventTime(event) ?? index}-${String(event.type)}`} event={event} />)}</div> : <div className="empty-state compact"><strong>No matching events recorded</strong><span>Events will appear here when the bot records them.</span></div>}
    </Panel>
  );
}

function ActivityRow({ event }: { event: JsonRecord }) {
  const type = String(event.type ?? "Bot update");
  const upper = type.toUpperCase();
  const tone = upper.includes("LOCK") || upper.includes("BLOCK") || upper.includes("STOP") ? "amber" : upper.includes("SELL") || upper.includes("FILL") ? "green" : "blue";
  const detail = textValue(event, "action", "reason", "triggerReason", "releaseReason");
  return <div className="activity-row"><span className={`activity-mark activity-${tone}`}><i /></span><span className="activity-time">{shortTime(event.time ?? event.timestamp)}</span><div className="activity-copy"><strong>{label(type)}</strong><span>{detail ? label(detail) : event.price !== undefined || event.triggerPrice !== undefined ? `Price ${price(numberValue(event.price ?? event.triggerPrice))}` : label(event.mode, "Bot state update")}</span></div></div>;
}

function PerformancePanel({ snapshot }: { snapshot: BotSnapshot }) {
  const trades = exitTrades(snapshot);
  const profits = trades.map(cycleProfit).filter((value): value is number => value !== null);
  const wins = profits.filter((value) => value > 0);
  const losses = profits.filter((value) => value < 0);
  const holds = trades.map((trade) => pickNumber(trade.holdSeconds, trade.holdTimeSeconds)).filter((value): value is number => value !== null);
  const firstTime = trades.length ? eventTime(trades[trades.length - 1]) : null;
  const lastTime = trades.length ? eventTime(trades[0]) : null;
  const hours = trades.length >= 2 && firstTime !== null && lastTime !== null && lastTime > firstTime ? (lastTime - firstTime) / 3_600_000 : null;
  const pnl = profits.reduce((sum, value) => sum + value, 0);
  const positiveAverage = wins.length ? wins.reduce((sum, value) => sum + value, 0) / wins.length : null;
  const averageCycle = profits.length ? pnl / profits.length : null;
  const sortedHolds = [...holds].sort((a, b) => a - b);
  const median = sortedHolds.length
    ? sortedHolds.length % 2 ? sortedHolds[Math.floor(sortedHolds.length / 2)] : (sortedHolds[sortedHolds.length / 2 - 1] + sortedHolds[sortedHolds.length / 2]) / 2
    : null;
  const avgHold = holds.length ? holds.reduce((sum, value) => sum + value, 0) / holds.length : null;
  const best = profits.length ? Math.max(...profits) : null;
  const worst = profits.length ? Math.min(...profits) : null;
  const roiValues = trades.map(cycleRoi).filter((value): value is number => value !== null);
  const buyRate = feeRate(snapshot, "buy");
  const sellRate = feeRate(snapshot, "sell");
  const estimatedFeeValues = trades.map((trade) => {
    const capital = pickNumber(trade.capitalBefore, trade.investedUSDT, trade.originalCapital);
    const grossRaw = trade.grossMove;
    const grossValue = numberValue(grossRaw);
    const grossRatio = grossValue === null ? 0 : typeof grossRaw === "string" && grossRaw.includes("%") ? grossValue / 100 : Math.abs(grossValue) > 1 ? grossValue / 100 : grossValue;
    return capital !== null && buyRate !== null && sellRate !== null ? capital * buyRate + capital * (1 + grossRatio) * sellRate : null;
  });
  const estimatedFees = estimatedFeeValues.length && estimatedFeeValues.every((value) => value !== null)
    ? estimatedFeeValues.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : null;
  const targetProfit = trades.filter((trade) => String(trade.reason ?? "").toUpperCase().includes("TARGET")).map(cycleProfit).reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const stopLoss = trades.filter((trade) => /STOP/i.test(String(trade.reason ?? trade.type ?? ""))).map(cycleProfit).reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const recoveryProfit = trades.filter((trade) => /RECOVERY/i.test(String(trade.reason ?? trade.type ?? ""))).map(cycleProfit).reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const projected = hours && hours > 0 ? (pnl / hours) * 24 : null;
  return (
    <Panel title="Performance" eyebrow="CYCLE ANALYTICS" icon={BarChart3} id="analytics">
      <div className="performance-grid">
        <PerfValue label="Total cycles" value={String(trades.length || numberValue(snapshot.state?.cycles) || 0)} />
        <PerfValue label="Winning cycles" value={trades.length ? String(wins.length) : "N/A"} tone="positive" />
        <PerfValue label="Losing cycles" value={trades.length ? String(losses.length) : "N/A"} tone="negative" />
        <PerfValue label="Win rate" value={trades.length ? `${((wins.length / trades.length) * 100).toFixed(1)}%` : "N/A"} />
        <PerfValue label="Average cycle PnL" value={currency(averageCycle)} tone={moneyClass(averageCycle)} />
        <PerfValue label="Average winning scalp" value={currency(positiveAverage)} tone="positive" />
        <PerfValue label="Average hold" value={duration(avgHold)} />
        <PerfValue label="Median hold" value={duration(median)} />
        <PerfValue label="Longest hold" value={duration(holds.length ? Math.max(...holds) : null)} />
        <PerfValue label="Best cycle" value={currency(best)} tone="positive" />
        <PerfValue label="Worst cycle" value={currency(worst)} tone="negative" />
        <PerfValue label="Average net ROI" value={roiValues.length ? percent(roiValues.reduce((sum, value) => sum + value, 0) / roiValues.length) : "N/A"} />
        <PerfValue label="Cycles / hour" value={hours ? (trades.length / hours).toFixed(2) : "N/A"} />
      </div>
      <div className="performance-footer"><span>PnL / hour <b>{currency(hours ? pnl / hours : null)}</b></span><span>24h projected <b className={moneyClass(projected)}>{currency(projected)}</b></span><span>Estimated fees <b>{currency(estimatedFees)}</b></span></div>
      <div className="category-pnl"><span>Target profit <b className={moneyClass(targetProfit)}>{currency(targetProfit)}</b></span><span>Recovery net <b className={moneyClass(recoveryProfit)}>{currency(recoveryProfit)}</b></span><span>Stop losses <b className={moneyClass(stopLoss)}>{currency(stopLoss)}</b></span></div>
    </Panel>
  );
}

function PerfValue({ label: title, value, tone = "" }: { label: string; value: string; tone?: string }) {
  return <div className="perf-value"><span>{title}</span><strong className={tone}>{value}</strong></div>;
}

function ScalpEconomics({ snapshot }: { snapshot: BotSnapshot }) {
  const grossPct = targetGrossPercent(snapshot);
  const buyFee = feeRate(snapshot, "buy");
  const sellFee = feeRate(snapshot, "sell");
  const gross = grossPct === null ? null : grossPct / 100;
  const netRatio = gross !== null && buyFee !== null && sellFee !== null ? (1 + gross) * (1 - buyFee) * (1 - sellFee) - 1 : null;
  const realized = pickNumber(snapshot.state?.realizedProfit, snapshot.summary24h?.realizedProfit);
  const wins = exitTrades(snapshot).map(cycleProfit).filter((value): value is number => value !== null && value > 0);
  const averageWin = wins.length ? wins.reduce((sum, value) => sum + value, 0) / wins.length : null;
  const required = realized !== null && realized < 0 && averageWin !== null && averageWin > 0 ? Math.ceil(Math.abs(realized) / averageWin) : null;
  return (
    <Panel title="Scalp economics" eyebrow="FEE-AWARE TARGET MODEL" icon={Target}>
      <div className="economics-cards"><EconomicsValue label="Target gross" value={grossPct === null ? "N/A" : `+${grossPct.toFixed(3)}%`} tone="positive" /><EconomicsValue label="BUY fee" value={buyFee === null ? "N/A" : `${(buyFee * 100).toFixed(3)}%`} /><EconomicsValue label="SELL fee" value={sellFee === null ? "N/A" : `${(sellFee * 100).toFixed(3)}%`} /><EconomicsValue label="Expected net" value={netRatio === null ? "N/A" : percent(netRatio * 100, 4)} tone={netRatio === null ? "" : netRatio >= 0 ? "positive" : "negative"} /></div>
      <div className="economics-bottom"><div><span>Expected profit · $100 reference</span><strong className={moneyClass(netRatio === null ? null : netRatio * 100)}>{currency(netRatio === null ? null : netRatio * 100, 4)}</strong></div><div><span>Realized loss recovery</span><strong>{required !== null ? `~${required} winning scalps` : realized !== null && realized >= 0 ? "No loss to recover" : "N/A"}</strong></div></div>
      <div className="economics-note">Calculated only from target and fee fields found in the observed logs. Missing assumptions remain N/A.</div>
    </Panel>
  );
}

function EconomicsValue({ label: title, value, tone = "" }: { label: string; value: string; tone?: string }) {
  return <div className="economics-value"><span>{title}</span><strong className={tone}>{value}</strong></div>;
}

function EquityCurve({ snapshot, portfolio }: { snapshot: BotSnapshot; portfolio: ReturnType<typeof derivePortfolio> }) {
  const trades = exitTrades(snapshot).slice().reverse();
  const equity = trades.map((trade) => pickNumber(trade.capitalAfter, trade.equityAfter, trade.totalEquity)).filter((value): value is number => value !== null);
  const contributed = portfolio.contributed;
  const values = equity.length
    ? [...(contributed === null ? [] : [contributed]), ...equity, ...(portfolio.equity === null ? [] : [portfolio.equity])]
    : [contributed ?? portfolio.equity].filter((value): value is number => value !== null);
  const max = values.length ? Math.max(...values) : 0;
  const min = values.length ? Math.min(...values) : 0;
  const padding = (max - min) * 0.15 || Math.max(max * 0.002, 0.01);
  const lo = min - padding;
  const hi = max + padding;
  const points = values.map((value, index) => ({ x: values.length <= 1 ? 16 : 16 + (index / (values.length - 1)) * 588, y: 154 - ((value - lo) / (hi - lo || 1)) * 126, value }));
  const path = points.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const area = `${path} L604,170 L16,170 Z`;
  const highest = numberValue(snapshot.state?.highestEquity);
  const drawdown = numberValue(snapshot.state?.maxDrawdown);
  const drawdownPct = highest && drawdown !== null ? drawdown / highest * 100 : null;
  const markY = portfolio.equity === null ? null : 154 - ((portfolio.equity - lo) / (hi - lo || 1)) * 126;
  return (
    <Panel title="Equity curve" eyebrow="CAPITAL TRACKING" icon={WalletCards}>
      <div className="equity-chart-heading"><div><span>Realized equity path</span><strong>{currency(portfolio.equity)}</strong></div><div className="drawdown-label"><span>Max drawdown</span><strong className={drawdownPct !== null && drawdownPct > 0 ? "negative" : ""}>{drawdownPct === null ? "N/A" : drawdownPct === 0 ? "0.00%" : `−${drawdownPct.toFixed(2)}%`}</strong></div></div>
      {points.length > 1 ? <div className="equity-svg-wrap"><div className="equity-legend"><span><i className="realized-legend" />Realized equity</span><span><i className="contributed-legend" />Capital contributed</span><span><i className="mark-legend" />Mark to market</span></div><svg viewBox="0 0 620 182" preserveAspectRatio="none" role="img" aria-label="Realized and mark-to-market equity over completed cycles"><defs><linearGradient id="equityFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#78c9a2" stopOpacity=".22" /><stop offset="1" stopColor="#78c9a2" stopOpacity="0" /></linearGradient></defs><line x1="16" y1="28" x2="604" y2="28" className="chart-grid-line" /><line x1="16" y1="91" x2="604" y2="91" className="chart-grid-line" /><line x1="16" y1="154" x2="604" y2="154" className="chart-grid-line" />{contributed !== null && <line x1="16" x2="604" y1={154 - ((contributed - lo) / (hi - lo || 1)) * 126} y2={154 - ((contributed - lo) / (hi - lo || 1)) * 126} className="contributed-line" />}<path d={area} fill="url(#equityFill)" /><path d={path} className="equity-line" />{points.map((point, index) => index === points.length - 1 && <circle key={point.x} cx={point.x} cy={point.y} r="4" className="equity-point" />)}{markY !== null && points.length > 0 && <><line x1={points[points.length - 1].x} y1={points[points.length - 1].y} x2="604" y2={markY} className="mark-connector" /><circle cx="604" cy={markY} r="4.5" className="mark-point" /></>}</svg><div className="equity-axis"><span>{currency(lo, 2)}</span><span>Contributed {currency(contributed)}</span><span>{currency(hi, 2)}</span></div></div> : <div className="empty-state compact"><div className="empty-icon"><Activity size={17} /></div><strong>Equity curve is collecting data</strong><span>Completed cycle equity points will appear here.</span></div>}
    </Panel>
  );
}

type TradeFilter = "All" | "Targets" | "Recovery" | "Stops" | "Today";

function TradeHistory({ snapshot }: { snapshot: BotSnapshot }) {
  const [filter, setFilter] = useState<TradeFilter>("All");
  const [query, setQuery] = useState("");
  const filters: TradeFilter[] = ["All", "Targets", "Recovery", "Stops", "Today"];
  const trades = useMemo(() => {
    const all = exitTrades(snapshot);
    return all.filter((trade) => {
      const reason = String(trade.reason ?? trade.type ?? "").toUpperCase();
      const date = eventTime(trade);
      const matchesFilter = filter === "All" || filter === "Targets" && reason.includes("TARGET") || filter === "Recovery" && reason.includes("RECOVERY") || filter === "Stops" && reason.includes("STOP") || filter === "Today" && date !== null && new Date(date).toDateString() === new Date().toDateString();
      const haystack = [trade.cycle, trade.entryPrice, trade.sellPrice, trade.reason, trade.type, trade.fillMethod].join(" ").toLowerCase();
      return matchesFilter && haystack.includes(query.toLowerCase());
    });
  }, [filter, query, snapshot]);
  return (
    <Panel title="Trade history" eyebrow="PAPER FILLS" icon={History} id="trades" action={<span className="trade-count">{trades.length} cycles</span>}>
      <div className="table-tools"><div className="filter-pills">{filters.map((item) => <button key={item} className={filter === item ? "filter-active" : ""} onClick={() => setFilter(item)}>{item}</button>)}</div><label className="search-box"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search trades" /></label></div>
      <div className="table-scroll"><table><thead><tr><th>Cycle</th><th>BUY / SELL time</th><th>BUY filled</th><th>SELL filled</th><th>Capital</th><th>Gross move</th><th>Net ROI</th><th>Profit</th><th>Hold</th><th>Exit reason</th><th>Fill method</th></tr></thead><tbody>
        {trades.map((trade, index) => { const profit = cycleProfit(trade); const type = String(trade.type ?? "").toUpperCase(); const entryAt = trade.entryTime ?? trade.buyTime; const exitAt = trade.time ?? trade.exitTime; return <tr key={`${eventTime(trade) ?? index}-${String(trade.cycle ?? index)}`}><td><span className="cycle-number">{String(trade.cycle ?? trades.length - index)}</span></td><td><span className="table-datetime">{dateTime(entryAt)}</span><span className="table-datetime muted">{dateTime(exitAt)}</span></td><td>{price(pickNumber(trade.entryPrice, trade.buyPrice))}</td><td>{price(pickNumber(trade.sellPrice, trade.exitPrice))}</td><td>{currency(pickNumber(trade.capitalBefore, trade.investedUSDT, trade.originalCapital))}</td><td>{typeof trade.grossMove === "string" ? trade.grossMove : percent(numberValue(trade.grossMove))}</td><td>{percent(cycleRoi(trade))}</td><td className={moneyClass(profit)}>{currency(profit)}</td><td>{duration(pickNumber(trade.holdSeconds, trade.holdTimeSeconds))}</td><td><span className="reason-tag">{label(trade.reason, type.replaceAll("PAPER_", ""))}</span></td><td><span className="fill-method">{label(trade.fillMethod)}</span></td></tr>; })}
        {trades.length === 0 && <tr><td colSpan={11}><div className="table-empty">No matching completed trades in the selected data.</div></td></tr>}
      </tbody></table></div>
    </Panel>
  );
}

function ExecutionPanel({ snapshot, full = false }: { snapshot: BotSnapshot; full?: boolean }) {
  const state = record(snapshot.state);
  const causalBuys = numberValue(state.causalBuyFillsBlocked) ?? 0;
  const causalSells = numberValue(state.causalSellFillsBlocked) ?? 0;
  const causalRecovery = numberValue(state.causalRecoveryFillsBlocked) ?? 0;
  const isExecutionRecord = (event: JsonRecord) => /LIMIT PLACED|FILLED|CROSS-THROUGH FILL|FILL BLOCKED|CANCELLED|EXPIRED/i.test(String(event.type ?? ""));
  const executionEvents = snapshot.events.filter(isExecutionRecord);
  const fallbackTrades = snapshot.trades.filter((trade) => isExecutionRecord(trade) && !executionEvents.some((event) => {
    const sameRecovery = trade.recoveryId !== undefined && event.recoveryId === trade.recoveryId;
    const eventAt = eventTime(event);
    const tradeAt = eventTime(trade);
    const closeInTime = eventAt !== null && tradeAt !== null && Math.abs(eventAt - tradeAt) <= 5_000;
    const tradeSide = String(trade.type ?? "").toUpperCase().includes("BUY") ? "BUY" : String(trade.type ?? "").toUpperCase().includes("SELL") ? "SELL" : "";
    const eventType = String(event.type ?? "").toUpperCase();
    const eventSide = eventType.includes("BUY") ? "BUY" : eventType.includes("SELL") ? "SELL" : "";
    return /FILL/i.test(eventType) && (sameRecovery || closeInTime && tradeSide !== "" && tradeSide === eventSide);
  }));
  const source = [...executionEvents, ...fallbackTrades].sort((a, b) => (eventTime(b) ?? 0) - (eventTime(a) ?? 0)).slice(0, full ? 60 : 8);
  return (
    <Panel title="Execution audit" eyebrow="ORDER & FILL PROVENANCE" icon={Database} id="execution">
      <div className="causal-counters"><Counter label="Causal BUY blocked" count={causalBuys} /><Counter label="Causal SELL blocked" count={causalSells} /><Counter label="Causal recovery blocked" count={causalRecovery} /></div>
      {source.length ? <div className="audit-list">{source.map((event, index) => <AuditRow key={`${eventTime(event) ?? index}-${String(event.type)}`} item={event} />)}</div> : <div className="empty-state compact"><div className="empty-icon"><Database size={17} /></div><strong>Execution trace not available yet</strong><span>Order placement, fills, and causal checks will be shown as the bot records them.</span></div>}
    </Panel>
  );
}

function Counter({ label: title, count }: { label: string; count: number }) {
  return <div className="causal-counter"><strong>{count}</strong><span>{title}</span></div>;
}

function AuditRow({ item }: { item: JsonRecord }) {
  const type = String(item.type ?? "Execution event");
  const order = record(item.order);
  const rawSource = item.fillTriggerTradeSource ?? item.tradeSource ?? item.placementObservationSource ?? order.placementObservationSource ?? order.tradeSource ?? item.source;
  const fillMethod = item.fillMethod;
  const rawCausalAge = pickNumber(item.causalAgeMs, item.fillCausalAgeMs, item.placementCausalAgeMs);
  const rawExchangeAge = pickNumber(item.exchangeAgeVsOrderMs);
  const rawMeta: Array<[string, string | null]> = [
    ["Placed", item.orderPlacedAt ?? item.sellOrderPlacedAt ?? item.buyOrderPlacedAt ?? item.placedAt ?? item.firstPlacedAt ?? order.firstPlacedAt ? dateTime(item.orderPlacedAt ?? item.sellOrderPlacedAt ?? item.buyOrderPlacedAt ?? item.placedAt ?? item.firstPlacedAt ?? order.firstPlacedAt) : null],
    ["Exchange", item.tradeExchangeTime ?? item.fillTriggerTradeExchangeTime ?? item.placedAfterTradeExchangeTime ?? order.placedAfterTradeExchangeTime ? dateTime(item.tradeExchangeTime ?? item.fillTriggerTradeExchangeTime ?? item.placedAfterTradeExchangeTime ?? order.placedAfterTradeExchangeTime) : null],
    ["Observed", item.tradeObservedAt ?? item.fillTriggerTradeObservedAt ?? item.placementObservedAt ?? order.placementObservedAt ? dateTime(item.tradeObservedAt ?? item.fillTriggerTradeObservedAt ?? item.placementObservedAt ?? order.placementObservedAt) : null],
    ["Causal age", rawCausalAge === null ? null : duration(rawCausalAge / 1000)],
    ["Exchange vs order", rawExchangeAge === null ? null : duration(rawExchangeAge / 1000)],
    ["Source", rawSource === undefined || rawSource === null ? null : label(rawSource)],
    ["Order price", price(pickNumber(item.orderPrice, item.price, item.buyPrice, item.sellPrice, order.price))],
    ["Trade price", price(pickNumber(item.tradePrice, item.fillTriggerTradePrice))],
    ["Trade side", item.tradeSide ?? item.fillTriggerTradeSide ? label(item.tradeSide ?? item.fillTriggerTradeSide) : null],
    ["PEARL", pickNumber(item.pearl, item.quantity, item.filledPearl, order.pearl) === null ? null : `${pickNumber(item.pearl, item.quantity, item.filledPearl, order.pearl)!.toFixed(6)} PEARL`],
    ["Queue ahead", numberValue(item.queueAhead ?? order.queueAhead) === null ? null : String(item.queueAhead ?? order.queueAhead)],
    ["Required flow", pickNumber(item.requiredFlow, item.requiredVolume, order.requiredFlow) === null ? null : Number(pickNumber(item.requiredFlow, item.requiredVolume, order.requiredFlow)).toLocaleString("en-US", { maximumFractionDigits: 6 })],
    ["Reference", item.recoveryId ?? item.orderId ?? item.buyOrderId ?? item.sellOrderId ?? item.id ? String(item.recoveryId ?? item.orderId ?? item.buyOrderId ?? item.sellOrderId ?? item.id) : null],
  ];
  const meta = rawMeta.filter(([, value]) => value !== null && value !== "N/A");
  const timestamp = item.time ?? item.timestamp;
  return <div className="audit-row"><div className="audit-event"><span className={`audit-icon ${type.includes("BLOCKED") ? "audit-blocked" : type.includes("FILLED") ? "audit-filled" : ""}`}><Activity size={13} /></span><div><strong>{label(type)}</strong><span>{timestamp ? shortTime(timestamp) : ""}{fillMethod ? ` · ${label(fillMethod)}` : ""}</span></div></div>{meta.length > 0 && <div className="audit-meta">{meta.map(([name, value]) => <span key={name}>{name}<b>{value}</b></span>)}</div>}</div>;
}

function SignalsPanel({ snapshot, full = false }: { snapshot: BotSnapshot; full?: boolean }) {
  const items = snapshot.signals.slice().reverse().slice(0, full ? undefined : 4);
  return (
    <Panel title="Signals" eyebrow="ENTRY DECISIONS" icon={Signal} id="signals">
      {items.length ? <div className="signals-list">{items.map((item, index) => <SignalCard key={`${eventTime(item) ?? index}-${String(item.type)}`} item={item} />)}</div> : <div className="empty-state compact"><div className="empty-icon"><Signal size={17} /></div><strong>No signal records found</strong><span>Waiting for signals.jsonl in the selected bot folder.</span></div>}
    </Panel>
  );
}

function SignalCard({ item }: { item: JsonRecord }) {
  const signal = record(item.signal ?? item);
  const conditions = record(signal.conditions);
  const failed = list(signal.failedConditions).map((value) => String(value));
  return <div className="signal-card"><div className="signal-head"><div><span>{label(signal.type ?? item.type)}</span><small>{shortTime(item.time)}</small></div><StatusPill tone={signal.ok === false || failed.length ? "amber" : "green"}>{signal.hardSignal ? "HARD SIGNAL" : signal.ok === false ? "BLOCKED" : "EARLY ARM"}</StatusPill></div><div className="signal-detail-row"><span>Price <b>{price(pickNumber(signal.price, getPath(signal, "metric.current"), getPath(signal, "order.price")))}</b></span><span>Target <b>{price(pickNumber(signal.target, getPath(signal, "order.target")))}</b></span><span>Support <b>{price(pickNumber(getPath(signal, "supportContext.support.price"), getPath(signal, "supportContext.low60m")))}</b></span></div><div className="condition-chips">{Object.entries(conditions).map(([key, value]) => <span className={value ? "condition-pass" : "condition-fail"} key={key}>{value ? <Check size={11} /> : <X size={11} />}{label(key)}</span>)}{failed.filter((condition) => !(condition in conditions)).map((condition) => <span className="condition-fail" key={condition}><X size={11} />{label(condition)}</span>)}</div><div className="signal-flow"><span>ASK share <b>{ratioPercent(numberValue(getPath(signal, "flow.askShare")))}</b></span><span>Range <b>{ratioPercent(numberValue(getPath(signal, "metric.rangePosition")))}</b></span><span>Samples <b>{numberValue(getPath(signal, "metric.sampleCount")) ?? "N/A"}</b></span></div></div>;
}

function OrderFlow({ snapshot, market }: { snapshot: BotSnapshot; market: ReturnType<typeof deriveMarket> }) {
  const flow = [...snapshot.signals, ...snapshot.events].slice().reverse().map((item) => record(item.flow ?? getPath(item, "signal.flow"))).find((item) => Object.keys(item).length);
  const askShare = market.askShare5m ?? numberValue(flow?.askShare);
  const bidShare = market.bidShare5m ?? numberValue(flow?.bidShare);
  const spread = market.bid !== null && market.ask !== null && market.bid > 0 ? ((market.ask - market.bid) / market.bid) * 100 : null;
  return <Panel title="Order flow" eyebrow="MICROSTRUCTURE" icon={Activity} action={<span className="trade-count">QUOTE {shortTime(market.quoteTime)}</span>}>
    <div className="flow-level"><div><span>ASK · 5M</span><strong>{ratioPercent(askShare)}</strong></div><div className="flow-bar ask-flow"><span style={{ width: `${askShare === null ? 0 : Math.max(0, Math.min(100, askShare * 100))}%` }} /></div></div>
    <div className="flow-level"><div><span>BID · 5M</span><strong>{ratioPercent(bidShare)}</strong></div><div className="flow-bar bid-flow"><span style={{ width: `${bidShare === null ? 0 : Math.max(0, Math.min(100, bidShare * 100))}%` }} /></div></div>
    <div className="micro-grid"><RecoveryDetail label="Best bid" value={price(market.bid)} /><RecoveryDetail label="Best ask" value={price(market.ask)} /><RecoveryDetail label="Spread" value={spread === null ? "N/A" : `${spread.toFixed(3)}%`} /><RecoveryDetail label="Support 60m" value={price(market.support60m)} /><RecoveryDetail label="Recent low" value={price(market.low24h)} /><RecoveryDetail label="Support touches" value={String(pickNumber(getPath(flow, "support.touches"), getPath(snapshot.signals.at(-1), "signal.supportContext.support.touches")) ?? "N/A")} /></div>
  </Panel>;
}

function SourcesPanel({ snapshot }: { snapshot: BotSnapshot }) {
  const sourceNames = ["runtimeDb", "state", "events", "trades", "signals", "summary24h"] as const;
  const sourceFiles = { runtimeDb: "runtime_metrics.sqlite", state: "state.json", events: "events.jsonl", trades: "paper_trades.jsonl", signals: "signals.jsonl", summary24h: "summary_24h.json" };
  return <Panel title="Observed files" eyebrow="READ-ONLY SOURCES" icon={Database}>
    <div className="source-list">{sourceNames.map((key) => { const file = snapshot.files[key]; return <div className="source-row" key={key}><span className={`source-state ${file?.exists ? "source-present" : ""}`}><i /></span><span className="source-name">{sourceFiles[key]}</span><span className="source-count">{file?.exists ? key === "state" || key === "summary24h" ? "read" : `${file.records} rows` : "missing"}</span>{file?.partialLine && <span className="partial-tag">partial</span>}</div>; })}</div>
    <div className="source-foot">{snapshot.mode === "demo" ? "Demo files · " : "Leyendo archivos locales · "}{snapshot.dataDirectory ?? "sin directorio configurado"}</div>
  </Panel>;
}

export default App;
