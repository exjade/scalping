import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity, BarChart3, Check, CircleAlert,
  Database, Gauge, History, Info, LockKeyhole, Radio, Search, ShieldCheck,
  Signal, Target, WalletCards, Wifi, WifiOff, X,
} from "lucide-react";
import { PriceChart } from "./components/PriceChart.js";
import { useBotState } from "./hooks/useBotState.js";
import {
  cycleProfit, cycleRoi, deriveBuyDiagnostics, deriveEngine, deriveMarket, derivePortfolio, entryExplanation,
  botConfiguration, eventTime, exitTrades, feeRate, getPath, list, numberValue, pickNumber, record, targetGrossPercent,
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

function currentScalpRecords(snapshot: BotSnapshot): JsonRecord[] {
  const state = record(snapshot.state);
  const persisted = list(state.scalpPositions);
  const legacy = record(state.position);
  const source = persisted.length ? persisted : Object.keys(legacy).length ? [legacy] : [];
  const live = list(getPath(snapshot.runtime, "openScalpPositions"));
  const liveById = new Map(live.map((item) => [String(item.id ?? ""), item]));
  const seen = new Set(source.map((item) => String(item.id ?? "")));
  const normalize = (item: JsonRecord, current?: JsonRecord): JsonRecord => ({
    ...current,
    ...item,
    entryPrice: pickNumber(item.entryPrice, item.entry, current?.entryPrice, current?.entry),
    sellTarget: pickNumber(item.sellTarget, item.targetPlusOneCent, item.target045, current?.sellTarget, current?.targetPlusOneCent, current?.target045),
    investedUSDT: pickNumber(item.investedUSDT, current?.investedUSDT),
    pearlReceived: pickNumber(item.pearlReceived, item.pearl, current?.pearlReceived, current?.pearl),
    heldMinutes: pickNumber(current?.heldMinutes, item.heldMinutes),
    sellOrder: item.sellOrder ?? null,
  });
  return [
    ...source.map((item) => normalize(item, liveById.get(String(item.id ?? "")))),
    ...live.filter((item) => !seen.has(String(item.id ?? ""))).map((item) => normalize(item)),
  ];
}

function ageLabel(value: unknown): string {
  const timestamp = typeof value === "number" ? value > 10_000_000_000 ? value : value * 1000 : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp)) return "N/A";
  const seconds = Math.max(0, (Date.now() - timestamp) / 1000);
  return seconds < 1 ? "<1 s" : `${Math.floor(seconds)} s`;
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
  { id: "trades", label: "Trades", title: "Posiciones y operaciones", description: "Cada compra abierta con su propia venta límite, BUY pendiente, spacing y ciclos completados." },
  { id: "recovery", label: "Recovery", title: "Recovery & protection", description: "Open recovery positions, startup context and market locks." },
  { id: "signals", label: "Signals", title: "Signal history", description: "Persisted entry decisions with their conditions and market context." },
  { id: "execution", label: "Execution", title: "Execution audit", description: "Order placement, fill provenance and observed local data sources." },
  { id: "analytics", label: "Analytics", title: "Performance analytics", description: "Cycle results, fee model and realized equity over time." },
  { id: "guide", label: "Guía", title: "Cómo funciona PEARL", description: "Flujo de mercado, filtros, órdenes, posiciones, recovery y diccionario de términos." },
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
  const runtimeConnected = runtimeProcessId !== null && runtimeVersion.length > 0;
  const market = deriveMarket(snapshot);
  const portfolio = derivePortfolio(snapshot, market);
  const engine = deriveEngine(state, runtime);
  const marketAge = market.priceTime ? Math.max(0, Date.now() - Date.parse(market.priceTime)) : null;
  const marketStale = marketAge !== null && marketAge > 120_000;
  const version = label(runtime.version ?? state.version, snapshot.mode === "demo" ? "5.1.8 demo" : "Unknown");
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
          <span className={`stream-indicator ${runtimeConnected ? streamStatus : streamStatus === "connected" ? "file-only" : "reconnecting"}`} title={runtimeConnected ? `V${runtimeVersion} runtime process ${runtimeProcessId}` : streamStatus === "connected" ? "Connected only to the file reader; the bot runtime API is not attached" : "Waiting for the bot runtime API"}>
            {runtimeConnected && streamStatus === "connected" ? <Wifi size={14} /> : <WifiOff size={14} />}
            <span>{runtimeConnected ? streamStatus === "connected" ? "LIVE API" : "RECONNECTING" : streamStatus === "connected" ? "FILES ONLY" : "NO BOT API"}</span>
          </span>
          {runtimeConnected && streamStatus === "connected" && <span className="runtime-freshness" title={`Snapshot ${String(getPath(snapshot, "generatedAt") ?? "unknown")} · last trade ${String(getPath(runtime, "marketDataHealth.lastLiveTradeAt") ?? "unknown")}`}><span>API {ageLabel(getPath(snapshot, "generatedAt"))}</span><span>TRADE {ageLabel(getPath(runtime, "marketDataHealth.lastLiveTradeAt"))}</span></span>}
        </div>
      </header>

      {loadError && <div className="inline-notice"><CircleAlert size={15} />{loadError}</div>}

      <main id="top" className={`page-content page-${activePage}`}>
        <BotControlBar runtime={runtime} state={state} connected={runtimeConnected} />
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

          {snapshot.mode === "live" && !runtimeConnected && <div className="market-data-note"><Info size={14} /><span>El snapshot actual viene de <b>{snapshot.dataDirectory ?? "la carpeta local"}</b>, pero no incluye el objeto del proceso del bot. Los campos de runtime aparecerán cuando la API integrada del bot esté conectada.</span></div>}
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
              <RangePanel market={market} runtime={runtime} version={version} />
              <EntryZone snapshot={snapshot} market={market} engineMode={engine.mode} version={version} />
              <Structure120Panel market={market} />
            </div>
            <aside className="side-column">
              <TradingEngine snapshot={snapshot} market={market} engine={engine} />
              <MarketProtection snapshot={snapshot} market={market} />
              <BuyDiagnosticsPanel snapshot={snapshot} />
              <ActivityPanel snapshot={snapshot} limit={6} />
            </aside>
          </div>
        </>}

        {activePage === "chart" && <div className="page-stack">
          <Panel title="Price action" eyebrow="MARKET STRUCTURE" icon={Activity} id="chart" action={<div className="panel-live-label"><i />PERSISTED + LIVE</div>}><PriceChart snapshot={snapshot} market={market} /></Panel>
          <div className="page-grid page-grid-two"><RangePanel market={market} runtime={runtime} version={version} /><OrderFlow snapshot={snapshot} market={market} /></div>
          <HighRangePanel snapshot={snapshot} />
        </div>}

        {activePage === "trades" && <div className="page-stack">
          <PositionBookPanel snapshot={snapshot} market={market} />
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

        {activePage === "guide" && <div className="page-stack"><BotGuide snapshot={snapshot} /></div>}

        <footer className="footer"><span>PEARL local observer · paper control</span><span>{runtimeConnected ? `Reads process ${runtimeProcessId} and persisted local records.` : "Reads the configured local data files."} No exchange credentials or manual order placement.</span></footer>
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

function BotControlBar({ runtime, state, connected }: { runtime: JsonRecord; state: JsonRecord; connected: boolean }) {
  const config = botConfiguration(runtime, state);
  const { controlPort, targetPriceDelta: targetDelta, capital, tradingEnabled: initialEnabled } = config;
  const [enabled, setEnabled] = useState<boolean | null>(initialEnabled);
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(!connected);
  const [targetInput, setTargetInput] = useState(targetDelta === null ? "" : targetDelta.toFixed(4));
  const [bankInput, setBankInput] = useState(capital === null ? "" : String(capital));
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (initialEnabled !== null) setEnabled(initialEnabled);
  }, [initialEnabled]);

  useEffect(() => {
    if (dirty) return;
    if (targetDelta !== null) setTargetInput(targetDelta.toFixed(4));
    if (capital !== null) setBankInput(String(capital));
  }, [capital, dirty, targetDelta]);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      if (!connected) {
        if (active) setOffline(true);
        return;
      }
      try {
        const response = await fetch(`http://127.0.0.1:${controlPort}/status`, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as JsonRecord;
        if (active) {
          setEnabled(data.tradingEnabled === true);
          if (!dirty && numberValue(data.targetPriceDelta) !== null) setTargetInput(numberValue(data.targetPriceDelta)!.toFixed(4));
          if (!dirty && numberValue(data.operatingBank) !== null) setBankInput(String(numberValue(data.operatingBank)));
          setOffline(false);
        }
      } catch {
        if (active) setOffline(true);
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 1500);
    return () => { active = false; window.clearInterval(timer); };
  }, [connected, controlPort, dirty]);

  const applyConfiguration = async (): Promise<boolean> => {
    const targetPriceDelta = Number(targetInput);
    const operatingBank = Number(bankInput);
    if (!Number.isFinite(targetPriceDelta) || targetPriceDelta < 0.0001 || !Number.isFinite(operatingBank) || operatingBank <= 0) {
      setNotice("Error: objetivo >= 0.0001 y banco > 0");
      return false;
    }
    const response = await fetch(`http://127.0.0.1:${controlPort}/configure`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetPriceDelta, operatingBank }),
      cache: "no-store",
    });
    const data = await response.json() as JsonRecord;
    if (!response.ok || data.ok === false) throw new Error(String(data.error ?? `HTTP ${response.status}`));
    setTargetInput(numberValue(data.targetPriceDelta)?.toFixed(4) ?? targetInput);
    setBankInput(String(numberValue(data.operatingBank) ?? operatingBank));
    setDirty(false);
    setNotice("Configuración aplicada");
    setOffline(false);
    return true;
  };

  const applyOnly = async () => {
    if (!connected || busy || enabled !== false) return;
    setBusy(true);
    try { await applyConfiguration(); }
    catch (error) { setNotice(`Error: ${error instanceof Error ? error.message : "no se pudo aplicar"}`); }
    finally { setBusy(false); }
  };

  const setTrading = async (next: boolean) => {
    if (!connected || busy) return;
    setBusy(true);
    try {
      if (next && !(await applyConfiguration())) return;
      const response = await fetch(`http://127.0.0.1:${controlPort}/${next ? "open" : "close"}`, { method: "POST", cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as JsonRecord;
      setEnabled(data.tradingEnabled === true);
      setOffline(false);
    } catch (error) {
      setNotice(`Error: ${error instanceof Error ? error.message : "no se pudo cambiar el estado"}`);
    } finally {
      setBusy(false);
    }
  };

  const statusTone = offline ? "amber" : enabled === true ? "green" : enabled === false ? "red" : "neutral";
  const statusLabel = offline ? "CONTROL OFFLINE" : enabled === true ? "BOT ABIERTO" : enabled === false ? "BOT CERRADO" : "BOT …";

  return <section className="bot-control-bar" aria-label="Bot configuration and control">
    <div className="bot-control-heading"><div><div className="eyebrow">V{label(config.version, "N/A")} · AUTO PAPER</div><strong>Configuración del bot en tiempo real</strong></div><StatusPill tone={statusTone} dot>{statusLabel}</StatusPill></div>
    <div className="bot-control-specs"><div><span>TARGET POR OPERACIÓN</span><strong>{targetDelta === null ? "N/A" : `+$${targetDelta.toFixed(4)} PEARL`}</strong></div><div><span>BANK OPERATIVO</span><strong>{currency(capital)} USDT</strong></div><div><span>CONTROL LOCAL</span><strong>API :{controlPort}</strong></div></div>
    <div className="bot-control-edit"><label><span>TARGET POR OPERACIÓN</span><input aria-label="Target por operación" type="number" min="0.0001" step="0.0001" value={targetInput} disabled={!connected || busy || enabled !== false} onChange={(event) => { setTargetInput(event.target.value); setDirty(true); setNotice(""); }} /></label><label><span>BANK OPERATIVO</span><input aria-label="Bank operativo" type="number" min="0.01" step="0.01" value={bankInput} disabled={!connected || busy || enabled !== false} onChange={(event) => { setBankInput(event.target.value); setDirty(true); setNotice(""); }} /></label><button className="bot-control-button apply" type="button" disabled={!connected || busy || enabled !== false} onClick={() => void applyOnly()}>APLICAR CONFIG</button>{notice && <span className={`bot-control-feedback ${notice.startsWith("Error") ? "error" : ""}`}>{notice}</span>}</div>
    <div className="bot-control-actions"><button className="bot-control-button open" type="button" disabled={!connected || busy || enabled === true} onClick={() => void setTrading(true)}>ABRIR BOT</button><button className="bot-control-button close" type="button" disabled={!connected || busy || enabled === false} onClick={() => void setTrading(false)}>CERRAR BOT</button></div>
    <div className="bot-control-note">Para cambiar estrategia: CERRAR BOT → editar → APLICAR CONFIG → ABRIR BOT. Cerrar pausa nuevas BUY; las posiciones abiertas y sus salidas siguen siendo gestionadas por el motor.</div>
  </section>;
}

function RangePanel({ market, runtime, version }: { market: ReturnType<typeof deriveMarket>; runtime: JsonRecord; version: string }) {
  const supportsRangeRules = version.startsWith("5.1.8") || version.startsWith("5.2.");
  const entryZone = record(runtimeRegime(runtime).entryZone);
  const supportEntryOK = entryZone.supportEntryOK === true;
  const supportEntrySource = String(entryZone.supportEntrySource ?? "").replace(/^SUPPORT_/, "").replace(/_/g, " ");
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
        <div className="range-track">{supportsRangeRules ? <><div className="range-segment normal" /><div className="range-segment caution" /><div className="range-segment blocked" /></> : <div className="range-segment unavailable" />}{marker !== null && <div className="range-marker" style={{ left: `${marker}%` }}><span>{price(market.price)}</span><i /></div>}</div>
        <div className="range-band-labels">{supportsRangeRules ? <><span>Normal <b>0–75%</b></span><span>Context <b>75–82%</b></span><span>{supportEntryOK ? "Top range = context" : "Top range blocked"} <b>82–100%</b></span></> : <span className="range-rules-unavailable">Range rules are not confirmed for V{version}</span>}</div>
        <div className="range-stat-row">
          <RangeStat label="Range position" value={ratioPercent(position)} />
          <RangeStat label="Distance from low" value={distanceFromLow === null ? "N/A" : `+${distanceFromLow.toFixed(2)}%`} tone="positive" />
          <RangeStat label="Distance to high" value={distanceToHigh === null ? "N/A" : `${distanceToHigh >= 0 ? "−" : "+"}${Math.abs(distanceToHigh).toFixed(2)}%`} />
        </div>
        {supportsRangeRules ? <div className="ladder-strip"><div className="ladder-info"><span className="ladder-glyph">⌁</span><div><span>Current allowed BUY ladder</span><strong>{allowedBand === null ? "N/A" : `${allowedBand.toFixed(1)}x band`}</strong></div></div><div className={`ladder-info ${supportEntryOK ? "" : "blocked-band"}`}><span className="ladder-lock">{supportEntryOK ? "↘" : <LockKeyhole size={14} />}</span><div><span>{supportEntryOK ? `Support entry override · ${supportEntrySource || "validated support"}` : "High 24h ladder · blocked"}</span><strong>{supportEntryOK ? price(numberValue(entryZone.supportEntryPrice)) : highBand === null ? "N/A" : `${highBand.toFixed(1)}x band`}</strong></div></div><div className="ladder-unlock"><span>{supportEntryOK ? "BUY support distance" : "Next ladder unlock"}</span><strong>{supportEntryOK ? `${ratioPercent(numberValue(entryZone.supportEntryDistancePct))}` : nextUnlock === null ? "N/A" : `HIGH24H > ${nextUnlock.toFixed(4)}`}</strong></div></div> : <div className="rule-note">La referencia de ladder no está confirmada para esta versión.</div>}
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
  const pendingBuyOrder = record(state.buyOrder);
  const order = Object.keys(pendingBuyOrder).length ? pendingBuyOrder : signalOrder;
  const currentEntry = record(getPath(runtime, "entryEngine.earlyArm"));
  const mode = String(order.allocationMode ?? runtimeEntryZone.allocationModeIfBuy ?? getPath(latestSignal, "signal.allocationMode") ?? engineMode ?? "N/A").toUpperCase();
  const supportsRangeRules = version.startsWith("5.1.8") || version.startsWith("5.2.");
  let allocation = numberValue(order.allocationFraction ?? getPath(latestSignal, "signal.allocationFraction"));
  if (allocation === null && supportsRangeRules && market.rangePosition !== null) allocation = runtimeEntryZone.supportEntryOK === true ? 1 : market.rangePosition >= 0.82 ? 0 : 1;
  const target = pickNumber(pendingBuyOrder.target, pendingBuyOrder.sellTarget, currentEntry.target, signalOrder.target, downside.previewTarget);
  const previewBuy = pickNumber(pendingBuyOrder.price, pendingBuyOrder.buyPrice, currentEntry.buy, currentEntry.buyPrice, signalOrder.price, downside.previewBuy);
  return (
      <Panel title="Entry zone" eyebrow={version === "Unknown" ? "VERSION UNKNOWN · ENTRY CONTEXT" : `V${version} ENTRY CONTEXT`} icon={Target}>
      <div className="entry-summary"><div className="entry-mode"><span>ENTRY MODE</span><strong className={mode.includes("BLOCK") ? "negative" : mode.includes("CAUTION") ? "warning-text" : ""}>{label(mode)}</strong></div><StatusPill tone={allocation === 0 ? "red" : allocation !== null && allocation < 1 ? "amber" : "green"}>{allocation === null ? "N/A" : `${Math.round(allocation * 100)}% allocation`}</StatusPill></div>
      <div className="entry-values"><EntryValue label="Current price" value={price(market.price)} /><EntryValue label="Preview BUY" value={price(previewBuy)} /><EntryValue label="Preview target" value={price(target)} /><EntryValue label="24h range position" value={ratioPercent(market.rangePosition)} /></div>
      <div className="allocation-bar"><span style={{ width: `${allocation === null ? 0 : Math.max(0, Math.min(100, allocation * 100))}%` }} /></div>
      <div className="allocation-legend"><span><i className="alloc-full" />Base 100%</span><span><i className="alloc-caution" />Near support 30%</span><span><i className="alloc-blocked" />Blocked 0%</span></div>
      <div className="explanation-box"><Info size={14} /><span>{supportsRangeRules ? entryExplanation(market.rangePosition, allocation, mode, runtimeEntryZone.supportEntryOK === true) : "Entry allocation thresholds are not available for this bot version; the dashboard uses explicit logged order data only."}</span></div>
    </Panel>
  );
}

function EntryValue({ label: title, value }: { label: string; value: string }) {
  return <div className="entry-value"><span>{title}</span><strong>{value}</strong></div>;
}

function PositionBookPanel({ snapshot, market }: { snapshot: BotSnapshot; market: ReturnType<typeof deriveMarket> }) {
  const state = record(snapshot.state);
  const runtime = record(snapshot.runtime);
  const positions = currentScalpRecords(snapshot);
  const recoveries = currentRecoveryRecords(snapshot);
  const stateBuy = record(state.buyOrder);
  const runtimeBuy = record(runtime.pendingBuy);
  const buyOrder = Object.keys(stateBuy).length ? stateBuy : runtimeBuy;
  const hasBuyOrder = Object.keys(buyOrder).length > 0;
  const earlyArm = record(getPath(runtime, "entryEngine.earlyArm"));
  const candidatePrice = pickNumber(buyOrder.price, earlyArm.buy, earlyArm.buyPrice);
  const candidateTarget = pickNumber(buyOrder.target, buyOrder.sellTarget, earlyArm.target);
  const minimumSpacing = numberValue(runtime.minimumPositionSpacing) ?? (numberValue(runtime.minimumPositionSpacingPct) === null ? null : numberValue(runtime.minimumPositionSpacingPct)! * 100);
  const spacingReferences = [
    ...positions.map((item) => ({ id: String(item.id ?? "SCALP"), type: "SCALP", entry: numberValue(item.entryPrice) })),
    ...recoveries.map((item) => ({ id: String(item.id ?? "RECOVERY"), type: "RECOVERY", entry: pickNumber(item.entryPrice, getPath(item, "sourcePosition.entryPrice")) })),
  ].filter((item): item is { id: string; type: string; entry: number } => item.entry !== null && item.entry > 0);
  const nearest = candidatePrice === null ? null : spacingReferences
    .map((item) => ({ ...item, distance: Math.abs(candidatePrice / item.entry - 1) * 100 }))
    .sort((a, b) => a.distance - b.distance)[0] ?? null;
  const spacingPass = nearest && minimumSpacing !== null ? nearest.distance + 1e-10 >= minimumSpacing : nearest ? null : candidatePrice !== null && minimumSpacing !== null ? true : null;
  const cash = pickNumber(state.cash, runtime.cash);
  const deployed = positions.reduce((sum, item) => sum + (numberValue(item.investedUSDT) ?? 0), 0);
  const slotFraction = numberValue(runtime.multiPositionSlotFraction);
  const slotCap = pickNumber(getPath(runtime, "regimeV519.entryZone.multiPositionSlotCapIfBuy"), getPath(runtime, "regimeV518.entryZone.multiPositionSlotCapIfBuy"), buyOrder.multiPositionSlotCap);
  const failedConditions = typeof earlyArm.failedConditions === "string" ? earlyArm.failedConditions.split(",").map((item) => item.trim()).filter(Boolean) : [];

  return <Panel title="Posiciones abiertas y plan de órdenes" eyebrow="SCALPS INDEPENDIENTES" icon={WalletCards} id="position-book" action={<StatusPill tone={positions.length ? "green" : "neutral"}>{positions.length} ABIERTAS</StatusPill>}>
    <div className="position-book-stats">
      <div><span>Scalps abiertos</span><strong>{positions.length}</strong></div>
      <div><span>SELL LIMIT independientes</span><strong>{positions.filter((item) => Object.keys(record(item.sellOrder)).length > 0).length}</strong></div>
      <div><span>BUY LIMIT pendiente</span><strong>{hasBuyOrder ? "1" : "0"}</strong></div>
      <div><span>Recoveries abiertos</span><strong>{recoveries.length}</strong></div>
    </div>

    <div className="position-capital-strip">
      <div><span>Efectivo disponible</span><strong>{currency(cash)}</strong></div>
      <div><span>Capital en scalps</span><strong>{currency(deployed)}</strong></div>
      <div><span>Máximo base por posición</span><strong>{slotFraction === null ? "N/A" : `${slotFraction.toFixed(0)}%`}</strong></div>
      <div><span>Capital asignable al siguiente BUY</span><strong>{slotCap === null ? "N/A" : currency(slotCap)}</strong></div>
    </div>

    <div className="position-entry-plan">
      <div className="position-plan-heading">
        <div><span className="eyebrow">{hasBuyOrder ? "BUY PENDIENTE" : "REFERENCIA DE ENTRADA"}</span><strong>{hasBuyOrder ? "El BUY LIMIT espera ejecución" : "Candidato del bot · no es una orden"}</strong></div>
        <StatusPill tone={hasBuyOrder ? "amber" : "neutral"}>{hasBuyOrder ? "ESPERANDO FILL" : "SOLO REFERENCIA"}</StatusPill>
      </div>
      <div className="position-price-grid">
        <EntryValue label={hasBuyOrder ? "Precio del BUY LIMIT" : "Precio BUY candidato"} value={price(candidatePrice)} />
        <EntryValue label="Objetivo si se ejecuta" value={price(candidateTarget)} />
        <EntryValue label="Capital para este BUY" value={currency(pickNumber(buyOrder.cash, buyOrder.capitalToUse, slotCap))} />
        <EntryValue label="Tiempo restante de orden" value={hasBuyOrder ? duration(numberValue(getPath(runtime, "pendingBuy.ttlRemainingSeconds"))) : "Sin orden colocada"} />
      </div>
      {!hasBuyOrder && failedConditions.length > 0 && <div className="position-plan-note">El candidato actual no es una orden BUY. El runtime aún reporta estos filtros pendientes: <b>{failedConditions.map((condition) => label(condition)).join(", ")}</b>.</div>}
    </div>

    <div className="position-spacing-row">
      <div><span className="eyebrow">SPACING MÍNIMO ENTRE POSICIONES</span><strong>{minimumSpacing === null ? "N/A" : `${minimumSpacing.toFixed(2)}%`}</strong></div>
      <StatusPill tone={spacingPass === true ? "green" : spacingPass === false ? "amber" : "neutral"}>{spacingPass === true ? "DISTANCIA SUFICIENTE" : spacingPass === false ? "DEMASIADO CERCA" : "NO CALCULABLE"}</StatusPill>
      <span>{candidatePrice === null ? "Esperando un precio candidato." : nearest ? `${nearest.type === "SCALP" ? "Scalp" : "Recovery"} ${nearest.id} · ${price(nearest.entry)} · a ${nearest.distance.toFixed(3)}%` : "No hay una posición abierta contra la cual comparar."}</span>
    </div>
    <div className="position-plan-note">Superar el spacing solo aprueba este filtro. El bot todavía debe aprobar contexto inicial, escalera de precios, rango, protecciones de mercado, estabilidad, soporte y fill causal.</div>

    {positions.length > 0 ? <div className="position-card-list">{positions.map((item, index) => <ScalpPositionCard key={String(item.id ?? index)} position={item} market={market} index={index} trades={[...snapshot.trades, ...snapshot.events]} />)}</div> : <div className="position-empty"><strong>No hay un BUY scalp abierto en este momento.</strong><span>Las compras abiertas y sus SELL LIMIT independientes aparecerán aquí desde el proceso actual. Las posiciones de recovery tienen su detalle en la sección Recovery.</span></div>}
  </Panel>;
}

function ScalpPositionCard({ position, market, index, trades }: { position: JsonRecord; market: ReturnType<typeof deriveMarket>; index: number; trades: JsonRecord[] }) {
  const id = String(position.id ?? `SCALP ${index + 1}`);
  const sellOrder = record(position.sellOrder);
  const hasSellOrder = Object.keys(sellOrder).length > 0;
  const matchingBuy = trades.find((item) => String(item.positionId ?? "") === id && String(item.type ?? "").toUpperCase().includes("BUY_FILLED"));
  const buyLimit = pickNumber(position.entryPrice, position.entry, matchingBuy?.entryPrice, matchingBuy?.price);
  const buyFill = pickNumber(matchingBuy?.entryPrice, matchingBuy?.price, position.entryPrice, position.entry);
  const sellTarget = pickNumber(sellOrder.price, position.sellTarget, position.targetPlusOneCent, position.target045);
  const entryAt = position.entryTimeMs ?? position.entryTime;
  const entryMs = typeof entryAt === "number" ? entryAt : typeof entryAt === "string" ? Date.parse(entryAt) : NaN;
  const heldSeconds = numberValue(position.heldMinutes) !== null ? numberValue(position.heldMinutes)! * 60 : Number.isFinite(entryMs) ? Math.max(0, (Date.now() - entryMs) / 1000) : null;
  const progress = buyFill !== null && sellTarget !== null && market.price !== null && sellTarget > buyFill ? Math.min(100, Math.max(0, (market.price - buyFill) / (sellTarget - buyFill) * 100)) : null;
  return <article className="scalp-position-card">
    <div className="scalp-position-head"><div><span className="eyebrow">SCALP {index + 1}</span><strong>{id}</strong></div><StatusPill tone={hasSellOrder ? "green" : "amber"}>{hasSellOrder ? "COMPRA EJECUTADA · SELL LIMIT ACTIVA" : "COMPRA EJECUTADA · SIN SELL LIMIT REGISTRADA"}</StatusPill></div>
    <div className="position-price-grid position-card-prices">
      <EntryValue label="BUY LIMIT colocado" value={price(buyLimit)} />
      <EntryValue label="BUY ejecutado" value={price(buyFill)} />
      <EntryValue label={hasSellOrder ? "SELL LIMIT propia" : "Objetivo SELL planeado"} value={price(sellTarget)} />
      <EntryValue label="SELL ejecutado" value="Aún no vendida" />
    </div>
    <div className="position-card-footer"><span>Capital <b>{currency(numberValue(position.investedUSDT))}</b></span><span>PEARL <b>{numberValue(position.pearlReceived) === null ? "N/A" : numberValue(position.pearlReceived)!.toFixed(6)}</b></span><span>Tiempo abierta <b>{duration(heldSeconds)}</b></span><span>Progreso al target <b>{progress === null ? "N/A" : `${progress.toFixed(0)}%`}</b></span><span>SELL colocada <b>{dateTime(sellOrder.placedAt)}</b></span></div>
    <div className="position-progress"><span style={{ width: `${progress ?? 0}%` }} /></div>
  </article>;
}

function BotGuide({ snapshot }: { snapshot: BotSnapshot }) {
  const runtime = record(snapshot.runtime);
  const state = record(snapshot.state);
  const health = record(runtime.marketDataHealth);
  const regime = runtimeRegime(runtime);
  const startup = record(regime.startupContext);
  const positions = currentScalpRecords(snapshot);
  const recoveries = currentRecoveryRecords(snapshot);
  const stateBuy = record(state.buyOrder);
  const pendingBuy = Object.keys(stateBuy).length ? stateBuy : record(runtime.pendingBuy);
  const hasPendingBuy = Object.keys(pendingBuy).length > 0;
  const earlyArm = record(runtime.earlyArm ?? getPath(runtime, "entryEngine.earlyArm"));
  const hardSignal = record(runtime.hardSignal ?? getPath(runtime, "entryEngine.hardSignal"));
  const earlyFailed = typeof earlyArm.failedConditions === "string" ? earlyArm.failedConditions.split(",").map((item) => item.trim()).filter(Boolean) : [];
  const hardFailed = typeof hardSignal.failedConditions === "string" ? hardSignal.failedConditions.split(",").map((item) => item.trim()).filter(Boolean) : [];
  const candidate = pickNumber(pendingBuy.price, earlyArm.buy, earlyArm.buyPrice);
  const target = pickNumber(pendingBuy.target, earlyArm.target);
  const steps = [
    { title: "1 · Lee el mercado", body: "Se suscribe a PEARL-USDT en el WebSocket público de BigONE para trades, libro y ticker. Si no recibe trades WS durante 10 s, consulta trades REST como respaldo; el ticker REST se actualiza cada 60 s." },
    { title: "2 · Calcula una candidata", body: "Combina precio reciente, bid/ask, rango 24 h, ladder de precios, estructura y soporte. Esta candidata es solo un cálculo; todavía no representa una orden ni una compra." },
    { title: "3 · Evalúa gates de entrada", body: "EARLY ARM permite armar una BUY LIMIT cuando pasan los gates de capital, startup, locks o ventana de rebote, soporte/ruptura, ladder, rango, spacing, cooldown y distancia bajo el mercado. HARD SIGNAL agrega confirmaciones de drawdown, zona baja, antigüedad del low y presión de venta." },
    { title: "4 · Coloca una BUY LIMIT", body: "Solo puede haber una BUY LIMIT pendiente a la vez. La orden dura hasta 90 s; si no se llena, expira, se cancela y el bot vuelve a calcular desde el mercado actual." },
    { title: "5 · Confirma el fill", body: "Una referencia del ticker o del libro no cuenta como ejecución. El fill debe venir de trades observados después de colocar la orden y respetar precio, lado, cola y volumen requeridos." },
    { title: "6 · Administra cada scalp por separado", body: "Después del BUY fill, cada posición conserva su propio entry, target, SELL LIMIT, soporte y provenance. Puede haber N scalps abiertos y N SELL LIMIT, aunque solo una nueva BUY esté pendiente." },
    { title: "7 · Mueve a Recovery si se rompe soporte", body: "Una ruptura estructural saca esa posición del bucket de scalp y la mantiene en RECOVERY_HOLD; no registra una venta realizada. El recovery conserva el target original de entry +$0.0100 y su fill también requiere trades causales posteriores a la orden." },
    { title: "8 · Protege la recuperación", body: "Una pérdida neta de 10% arma una alerta DANGER, pero no vende. El hard stop necesita además romper 1.5% el low24h anclado al iniciar el recovery, permanecer debajo 2 min y confirmar presión vendedora en 5m y 30s sin reclaim." },
  ];
  const terms: Array<[string, string]> = [
    ["Candidata BUY", "Precio que el bot está evaluando ahora. No es una orden y no reserva capital."],
    ["BUY LIMIT", "Orden limitada pendiente para entrar. El precio de la orden no prueba que se haya ejecutado."],
    ["BUY fill", "Compra confirmada por el modelo causal de trades. En una posición filled, el dashboard muestra el precio límite y el precio registrado."],
    ["SELL LIMIT", "Orden de salida que pertenece a una sola posición. Cada scalp y cada recovery tienen su propia salida."],
    ["SELL fill", "Venta confirmada; solo entonces el capital vuelve a efectivo y se contabiliza el cierre."],
    ["Target +$0.0100", "Diferencia absoluta objetivo del precio de PEARL por operación. Las fees modeladas de 0.20% al comprar y 0.20% al vender se descuentan del resultado neto."],
    ["Bank operativo", "Capital paper configurado para esta versión: $10,000 USDT. Una entrada usa 100% del efectivo disponible por defecto; solo baja a 30% cuando está a <=0.30% del soporte."],
    ["Caution de soporte", "Reducción temporal a 30% cuando la entrada queda a <=0.30% sobre el soporte detectado. El rango alto y el falling context ya no reducen sizing por sí solos."],
    ["Spacing 0.25%", "La entrada candidata debe quedar al menos 0.25% separada de la posición scalp o recovery abierta más cercana."],
    ["Range position 24h", "Lugar del precio actual entre el low y high de las últimas 24 horas. Hasta 82% mantiene sizing base; sobre 82% bloquea el RANGE BUY. La reducción a 30% depende solo de cercanía al soporte."],
    ["Price ladder", "Filtro por bandas de precio de 0.10 USDT respecto al high de 24 h. Una banda nueva solo se habilita después de superar el siguiente escalón por al menos un tick."],
    ["EARLY ARM", "Primera evaluación para colocar la BUY LIMIT; no equivale a fill. Puede aparecer aunque el HARD SIGNAL aún no se haya confirmado."],
    ["HARD SIGNAL", "Conjunto de confirmaciones adicionales que se monitorean mientras la BUY está armada. Sus fallos explican por qué no se confirma la señal completa."],
    ["TTL", "Tiempo máximo de vigencia de la orden BUY pendiente: 90 segundos."],
    ["Fill causal", "Solo trades observados después de colocar la orden pueden llenar esa orden; trades históricos previos no la llenan."],
    ["RECOVERY_HOLD", "Posición separada del scalp bucket tras una ruptura estructural; conserva SELL en entry +$0.0100 hasta llenar o llegar al hard stop confirmado."],
    ["Low24h anchor", "Low de 24 h guardado para un recovery al momento de crearlo. No cambia aunque el low global cambie después."],
    ["DANGER −10%", "Alerta de riesgo sobre el valor neto del recovery. No es una orden de venta."],
    ["WS / REST_FALLBACK", "Fuente del último trade observado: WebSocket principal o consulta REST cuando WS lleva 10 s sin trade."],
    ["Runtime API / SSE", "Snapshot del objeto en memoria del mismo proceso Node y actualizaciones continuas al dashboard. La página muestra edad del snapshot y del último trade."],
    ["N/A vs 0", "N/A significa que el dato no está disponible o no hay muestra. 0 significa que el runtime reportó un valor numérico igual a cero."],
  ];

  return <>
    <div className="page-grid page-grid-two">
      <Panel title="Estado operativo actual" eyebrow="LECTURA DEL RUNTIME" icon={Activity}>
        <div className="guide-current-grid"><GuideValue label="Versión / proceso" value={`V${label(runtime.version)} · PID ${String(runtime.processId ?? "N/A")}`} /><GuideValue label="Precio candidato BUY" value={hasPendingBuy ? `${price(candidate)} · BUY LIMIT pendiente` : `${price(candidate)} · solo referencia`} /><GuideValue label="Target candidato" value={price(target)} /><GuideValue label="Scalps / recoveries" value={`${positions.length} / ${recoveries.length}`} /><GuideValue label="Efectivo scalp" value={currency(pickNumber(state.cash, runtime.scalpCash))} /><GuideValue label="Contexto de inicio" value={`${startup.ready === true ? "LISTO" : "EN OBSERVACIÓN"} · ${duration(numberValue(startup.elapsedSeconds))} · ${numberValue(startup.liveTrades) ?? 0}/${numberValue(startup.minimumLiveTrades) ?? 20} trades`} /><GuideValue label="Fuente último trade" value={`${label(health.lastLiveTradeSource)} · ${ageLabel(health.lastLiveTradeAt)}`} /></div>
        {!hasPendingBuy && earlyFailed.length > 0 && <div className="guide-warning"><strong>Por qué no hay una BUY pendiente</strong><span>La candidata no pasó EARLY ARM: {earlyFailed.map((item) => label(item)).join(", ")}.</span></div>}
      </Panel>
      <Panel title="Mercado y actualización" eyebrow="BIGONE · OBSERVACIÓN + CONTROL LOCAL" icon={Radio}>
        <ul className="guide-bullets"><li>El proceso Node del bot lee el mercado PEARL-USDT desde BigONE y mantiene el estado actual en memoria.</li><li>El WebSocket es la fuente principal de trades y libro. Si WS no entrega trades por 10 s, el bot consulta trades REST; el ticker REST sirve como respaldo para el rango 24 h.</li><li>La API integrada publica snapshot y SSE cada 1 s. Los botones del dashboard solo habilitan o pausan entradas automáticas; no envían órdenes manuales a BigONE.</li><li>El precio de Overview viene del runtime actual. El histórico se restaura desde SQLite; el Chart agrega el último precio del runtime para que no espere al siguiente registro histórico, guardado cada 10 s.</li><li>El indicador superior separa edad del snapshot API y edad del último trade. Un API fresco no garantiza que BigONE haya enviado un trade nuevo en ese segundo.</li></ul>
      </Panel>
    </div>

    <Panel title="Ciclo completo de una operación" eyebrow="DESDE BIGONE HASTA EL CIERRE" icon={Target}>
      <div className="guide-steps">{steps.map((step) => <article key={step.title}><strong>{step.title}</strong><p>{step.body}</p></article>)}</div>
    </Panel>

    <div className="page-grid page-grid-two">
      <Panel title="Filtros de entrada" eyebrow="CUÁNDO PUEDE ARMARSE UN BUY" icon={ShieldCheck}>
        <div className="guide-subsection"><strong>EARLY ARM · gates para colocar la LIMIT</strong><p>Capital disponible, contexto de inicio, falling-market lock, estabilidad, breakdown locks, ladder, rango 24 h, spacing mínimo, cooldown, BUY debajo del mercado y distancia máxima de la candidata.</p></div>
        <div className="guide-subsection"><strong>HARD SIGNAL · confirmación adicional</strong><p>Además evalúa drawdown, zona baja del rango reciente, antigüedad del low y presión ASK. La ausencia de HARD SIGNAL no convierte una candidata en fill.</p></div>
        <div className="guide-subsection"><strong>Rango y protecciones</strong><p>El rango &gt;82% bloquea la entrada, pero no reduce sizing entre 0% y 82%. La base usa 100%; solo una entrada a ≤0.30% sobre soporte activa 30%. HARD falling mantiene el lock de entrada.</p></div>
        {hardFailed.length > 0 && <div className="guide-warning"><strong>HARD SIGNAL actual</strong><span>{hardFailed.map((item) => label(item)).join(", ")}</span></div>}
      </Panel>
      <Panel title="Capital, objetivos y salidas" eyebrow="PAPER TRADING" icon={WalletCards}>
        <ul className="guide-bullets"><li>El bank paper configurado es de $10,000 USDT; una operación usa 100% del efectivo disponible por defecto y 30% únicamente cerca del soporte (≤0.30%).</li><li>El spacing se compara contra todas las entradas scalp y recovery abiertas; mide distancia porcentual absoluta al nivel más cercano.</li><li>Cada BUY ejecutada crea una posición separada y su propia SELL LIMIT. Una posición esperando venta no ocupa el único slot de BUY pendiente, pero sí mantiene su capital comprometido.</li><li>Target de precio: +$0.0100 por PEARL. Fee de compra: 0.20%; fee de venta: 0.20%. El resultado neto final depende de esas fees y del fill registrado.</li><li>Una BUY LIMIT no ejecutada vence a los 90 s. Solo se cuenta operación cuando llega un fill causal posterior a la colocación.</li></ul>
      </Panel>
    </div>

    <Panel title="Recovery y protección del capital" eyebrow="HOLD NO ES VENTA" icon={LockKeyhole}>
      <div className="guide-recovery-grid"><GuideValue label="Entrada a recovery" value="Ruptura estructural confirmada; la posición sale del bucket scalp sin venderse." /><GuideValue label="Danger −10% neto" value="Arma advertencia de riesgo. No cierra la posición." /><GuideValue label="Hard stop anclado" value="Exige romper 1.5% bajo el low24h congelado, permanecer bajo el nivel 2 min y ver ASK ≥62% en 5m y ≥70% en 30s, sin reclaim." /><GuideValue label="Salida normal" value="SELL recovery conserva entry +$0.0100, con fill causal." /></div>
      <div className="guide-audit-note"><strong>Nota de configuración de inicio:</strong> la constante que ejecuta V5.1.8.3 requiere 2 minutos y al menos 20 trades LIVE del proceso actual. El comentario de cabecera del mismo archivo todavía dice 4 minutos; este dashboard refleja la constante ejecutable.</div>
    </Panel>

    <Panel title="Diccionario" eyebrow="TÉRMINOS DEL DASHBOARD Y DEL BOT" icon={Info}>
      <dl className="guide-glossary">{terms.map(([term, meaning]) => <div key={term}><dt>{term}</dt><dd>{meaning}</dd></div>)}</dl>
    </Panel>
  </>;
}

function GuideValue({ label: title, value }: { label: string; value: string }) {
  return <div className="guide-value"><span>{title}</span><strong>{value}</strong></div>;
}

function TradingEngine({ snapshot, market, engine }: { snapshot: BotSnapshot; market: ReturnType<typeof deriveMarket>; engine: ReturnType<typeof deriveEngine> }) {
  const state = record(snapshot.state);
  const runtime = record(snapshot.runtime);
  const scalpPositions = currentScalpRecords(snapshot);
  const independentSells = scalpPositions.filter((item) => Object.keys(record(item.sellOrder)).length > 0).length;
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
  const hasActiveOrderOrPosition = hasBuyOrder || scalpPositions.length > 0 || Object.keys(position).length > 0 || hasRecovery;
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
      {scalpPositions.length > 0 ? <>
        <div className="engine-operation-status"><i />{scalpPositions.length} {scalpPositions.length === 1 ? "scalp abierto" : "scalps abiertos"} · {independentSells} SELL LIMIT independientes</div>
        <div className="engine-order-grid engine-trade-prices"><EngineValue label="BUY LIMIT pendiente" value={hasBuyOrder ? price(pickNumber(buyOrder.price, getPath(runtime, "pendingBuy.price"))) : "Ninguna"} /><EngineValue label="Scalps abiertos" value={String(scalpPositions.length)} /><EngineValue label="SELL LIMIT independientes" value={String(independentSells)} /><EngineValue label="Máximo base por posición" value={numberValue(runtime.multiPositionSlotFraction) === null ? "N/A" : `${numberValue(runtime.multiPositionSlotFraction)!.toFixed(0)}%`} /><EngineValue label="Spacing mínimo" value={label(runtime.minimumPositionSpacing, "N/A")} /><EngineValue label="Efectivo disponible" value={currency(pickNumber(state.cash, runtime.cash))} /></div>
        <div className="engine-note">Cada compra abierta tiene su propio SELL LIMIT. En Trades están los precios de entrada, fill y venta de cada una.</div>
      </> : hasActiveOrderOrPosition ? <>
        <div className="engine-operation-status"><i />{stateDescription}</div>
        <div className="engine-order-grid engine-trade-prices"><EngineValue label={buyLabel} value={price(buyReference)} /><EngineValue label={buyFillLabel} value={actualBuy === null ? hasBuyOrder ? "Pendiente" : "Aún no comprada" : price(actualBuy)} /><EngineValue label={sellLabel} value={price(sellReference)} /><EngineValue label="Venta ejecutada" value={sellFillText} /><EngineValue label="Tiempo en posición" value={duration(holdSeconds)} /><EngineValue label="Capital comprometido" value={currency(capital)} /></div>
        {hasRecovery && pickNumber(getPath(recovery, "sourcePosition.sellTarget")) !== null && <div className="engine-previous-target">Target de venta scalp original: <b>{price(pickNumber(getPath(recovery, "sourcePosition.sellTarget")))}</b> · conservado por recovery.</div>}
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
  const reboundReady = runtimeLock.reboundEntryOK === true;
  const ready = typeof runtimeStartup.ready === "boolean" ? runtimeStartup.ready : snapshot.events.some((event) => String(event.type ?? "").toUpperCase().includes("READY")) || Boolean(state.startupContextReady);
  const stable = typeof runtimeLock.stableEnough === "boolean" ? runtimeLock.stableEnough : active ? false : snapshot.events.some((event) => String(event.type ?? "").toUpperCase().includes("STABLE ENOUGH")) || String(lock.status ?? "").toUpperCase() === "INACTIVE";
  const preEntry = typeof runtimePreEntry.active === "boolean" ? runtimePreEntry.active : active && String(lock.triggerReason ?? "").includes("PREENTRY") || state.preEntryFallingDetection === true;
  const checks = [
    { label: "Startup context collected", ok: ready },
    { label: reboundReady ? "Rebound entry window" : "Falling market lock clear", ok: reboundReady || !active },
    { label: "Recent stability confirmation", ok: stable },
    { label: "No new meaningful low", ok: active && numberValue(runtimeLock.minutesSinceMeaningfulNewLow) !== null ? numberValue(runtimeLock.minutesSinceMeaningfulNewLow)! >= 5 : active && lock.lastMeaningfulNewLowAtMs ? Date.now() - Number(lock.lastMeaningfulNewLowAtMs) > 5 * 60_000 : !active },
  ];
  return (
    <Panel title="Market protection" eyebrow="MARKET REGIME" icon={ShieldCheck} action={<div className="panel-actions"><span className="trade-count">CTX {shortTime(market.contextTime)}</span><StatusPill tone={active ? reboundReady ? "green" : "amber" : "green"} dot>{active ? reboundReady ? "LOCK + REBOUND" : "LOCK ACTIVE" : "CLEAR"}</StatusPill></div>}>
      <div className="protection-status"><div className={`protection-emblem ${active ? "emblem-active" : ""}`}>{active ? <LockKeyhole size={17} /> : <ShieldCheck size={17} />}</div><div><strong>{active ? reboundReady ? "Falling lock · rebound window" : "Falling market lock" : stable ? "Market stable" : "Protection ready"}</strong><span>{active ? reboundReady ? "Rebound validado: puede armar BUY bajo el rango superior." : "New BUYs paused until stability returns." : "Entry protections are monitoring the market."}</span></div></div>
      <div className="protection-grid"><ProtectionMetric label="Startup context" value={ready ? "READY" : "COLLECTING"} good={ready} /><ProtectionMetric label="Stable enough" value={active ? stable ? "YES" : reboundReady ? "REBOUND" : "NO" : "NOT REQUIRED"} good={active ? stable || reboundReady : undefined} /><ProtectionMetric label="Pre-entry detection" value={preEntry ? "ACTIVE" : lock.status ? "INACTIVE" : label(state.preEntryFallingDetection, "N/A")} good={preEntry} /><ProtectionMetric label="Recent low age" value={market.minutesSinceLow === null ? "N/A" : `${market.minutesSinceLow.toFixed(1)} min`} /></div>
      <div className="protection-metrics">{[
        ["Move 30s", percent(market.move30s === null ? null : market.move30s * 100)], ["Move 4m", percent(market.move4m === null ? null : market.move4m * 100)], ["Move 5m", percent(market.move5m === null ? null : market.move5m * 100)], ["Move 10m", percent(market.move10m === null ? null : market.move10m * 100)], ["ASK 30s", market.askShare30s === null ? "Sin muestra" : ratioPercent(market.askShare30s)], ["ASK 5m", ratioPercent(market.askShare5m)], ["BID 5m", ratioPercent(market.bidShare5m)], ["Bounce", percent(market.bounceFromLow === null ? null : market.bounceFromLow * 100)],
      ].map(([name, value]) => <div className="protection-metric" key={name}><span>{name}</span><strong>{value}</strong></div>)}</div>
      {active && <div className="lock-checks">{checks.map((check) => <div className={check.ok ? "check-pass" : "check-wait"} key={check.label}>{check.ok ? <Check size={13} /> : <X size={13} />}<span>{check.label}</span><b>{check.ok ? "MET" : "PENDING"}</b></div>)}</div>}
    </Panel>
  );
}

function Structure120Panel({ market }: { market: ReturnType<typeof deriveMarket> }) {
  const structure = record(market.structure120m);
  const support = record(structure.support);
  const resistance = record(structure.resistance);
  const zones = [
    ...list(structure.supports).map((zone) => ({ type: "SUPPORT", zone })),
    ...list(structure.resistances).map((zone) => ({ type: "RESISTANCE", zone })),
  ].sort((a, b) => (numberValue(a.zone.price) ?? 0) - (numberValue(b.zone.price) ?? 0));
  return <Panel title="Support / resistance 120m" eyebrow="TOQUES Y REBOTES · ROLLING REGISTER" icon={Activity} action={<span className="trade-count">{structure.ready === true ? "LIVE" : "COLLECTING"}</span>}>
    <div className="protection-grid"><ProtectionMetric label="Nearest support" value={price(numberValue(support.price))} /><ProtectionMetric label="Support rebounds" value={String(numberValue(support.rebounds) ?? 0)} /><ProtectionMetric label="Nearest resistance" value={price(numberValue(resistance.price))} /><ProtectionMetric label="Resistance rebounds" value={String(numberValue(resistance.rebounds) ?? 0)} /></div>
    {zones.length ? <div className="structure-zone-list">{zones.slice(0, 6).map(({ type, zone }) => <div className="structure-zone-row" key={`${type}-${String(zone.price)}`}><span className={type === "SUPPORT" ? "positive" : "negative"}>{type}</span><strong>{price(numberValue(zone.price))}</strong><small>{numberValue(zone.observedTouches) ?? 0} toques · {numberValue(zone.rebounds) ?? 0} rebotes · {numberValue(zone.pivotTouches) ?? 0} pivotes</small><em>último toque {shortTime(zone.lastTouchAt)}</em></div>)}</div> : <div className="empty-state compact"><strong>Esperando estructura de 120 minutos</strong><span>Se requieren trades y pivotes suficientes para contar zonas.</span></div>}
    <div className="rule-note">Toque = el trade entra o cruza la zona. Rebote = sale 0.20% en la dirección opuesta sin romperla. La ventana se recalcula en tiempo real.</div>
  </Panel>;
}

function BuyDiagnosticsPanel({ snapshot }: { snapshot: BotSnapshot }) {
  const diagnostics = deriveBuyDiagnostics(snapshot);
  const runtime = record(snapshot.runtime);
  const hard = record(getPath(runtime, "entryEngine.hardSignal"));
  const lock = record(getPath(runtime, "regimeV519.fallingMarketLock"));
  const failed = String(hard.failedConditions ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const liveBlockers = lock.active === true && lock.reboundEntryOK !== true ? ["FALLING_MARKET_LOCK"] : failed;
  return <Panel title="BUY_LIMIT audit" eyebrow="WHY FILLS DID / DID NOT HAPPEN" icon={Gauge} action={<span className="trade-count">{diagnostics.fillRate === null ? "N/A" : `${(diagnostics.fillRate * 100).toFixed(1)}% fill rate`}</span>}>
    <div className="protection-grid"><ProtectionMetric label="Placed" value={String(diagnostics.placed ?? 0)} /><ProtectionMetric label="Cancelled" value={String(diagnostics.cancelled ?? 0)} /><ProtectionMetric label="Filled" value={String(diagnostics.filled ?? 0)} good={diagnostics.filled > 0} /><ProtectionMetric label="WS errors" value={String(diagnostics.websocketErrors)} good={diagnostics.websocketErrors === 0} /></div>
    <div className="diagnostic-reasons"><div><span>TTL expired</span><strong>{diagnostics.ttlExpired}</strong></div><div><span>Falling lock</span><strong>{diagnostics.fallingLock}</strong></div><div><span>Support resize</span><strong>{diagnostics.supportResize}</strong></div><div><span>Soft falling</span><strong>{diagnostics.softFallingResize}</strong></div><div><span>User pause</span><strong>{diagnostics.userPaused}</strong></div><div><span>Causality blocks</span><strong>{diagnostics.causalBlocks}</strong></div><div><span>Other cancellations</span><strong>{diagnostics.otherCancelled}</strong></div></div>
    <div className="explanation-box"><Info size={14} /><span>{lock.active === true && lock.reboundEntryOK === true ? "Falling lock activo, pero el rebote actual permite una BUY de scalp mientras no esté en TOP_RANGE_BLOCKED. " : liveBlockers.length ? `Bloqueos actuales: ${liveBlockers.join(", ")}. ` : "Sin bloqueo duro actual. "}Una BUY_LIMIT solo llena si un trade posterior toca o cruza el precio colocado; una subida visible en el gráfico no garantiza que haya tocado la orden.</span></div>
  </Panel>;
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
  return <Panel title="High-range context" eyebrow={`V${label(runtime.version, "bot")} LIVE METRICS`} icon={Signal} action={<StatusPill tone={active ? "amber" : "neutral"} dot>{active ? "CAUTION ACTIVE" : "CLEAR"}</StatusPill>}>
    <div className="protection-grid">{rows.map(([name, value]) => <div className="protection-metric-large" key={name}><span>{name}</span><strong>{value}</strong></div>)}</div>
  </Panel>;
}

function ProtectionMetric({ label: title, value, good }: { label: string; value: string; good?: boolean }) {
  return <div className="protection-metric-large"><span>{title}</span><strong className={good === undefined ? "" : good ? "positive" : "warning-text"}>{value}</strong></div>;
}

function PaginationControls({ page, pageCount, total, pageSize, itemLabel, onPageChange }: {
  page: number; pageCount: number; total: number; pageSize: number; itemLabel: string; onPageChange: (page: number) => void;
}) {
  if (total === 0) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  return <div className="pagination-controls"><span>Mostrando {first}–{last} de {total} {itemLabel}</span><div><button type="button" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>Anterior</button><strong>Página {page} de {pageCount}</strong><button type="button" disabled={page >= pageCount} onClick={() => onPageChange(page + 1)}>Siguiente</button></div></div>;
}

function RecoveryPanel({ snapshot, market, version }: { snapshot: BotSnapshot; market: ReturnType<typeof deriveMarket>; version: string }) {
  const recoveries = currentRecoveryRecords(snapshot);
  const [page, setPage] = useState(1);
  const pageSize = 3;
  const pageCount = Math.max(1, Math.ceil(recoveries.length / pageSize));
  const visibleRecoveries = recoveries.slice((page - 1) * pageSize, page * pageSize);
  useEffect(() => { setPage((current) => Math.min(current, pageCount)); }, [pageCount]);
  const supportsDanger = /^5\.1\.(7|8)(?:$|\D)/.test(version);
  return (
    <Panel title="Recovery center" eyebrow="CAPITAL PROTECTION" icon={ShieldCheck} id="recovery" action={<StatusPill tone={recoveries.length ? "amber" : "neutral"}>{recoveries.length} ACTIVE</StatusPill>}>
      {recoveries.length === 0 ? <div className="empty-state compact"><div className="empty-icon"><ShieldCheck size={17} /></div><strong>No active recovery positions</strong><span>Recovery data will appear here when the bot records a position.</span></div> : <><div className="recovery-list">{visibleRecoveries.map((item, index) => <RecoveryCard key={String(item.id ?? (page - 1) * pageSize + index)} recovery={item} market={market} supportsDanger={supportsDanger} />)}</div><PaginationControls page={page} pageCount={pageCount} total={recoveries.length} pageSize={pageSize} itemLabel="recuperaciones" onPageChange={setPage} /></>}
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
        {previousSellTarget !== null && <div className="recovery-prior-target">Target scalp original {price(previousSellTarget)} · conservado en recovery.</div>}
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
  const [page, setPage] = useState(1);
  const allEvents = snapshot.events.slice().sort((a, b) => (eventTime(b) ?? 0) - (eventTime(a) ?? 0));
  const matchingEvents = allEvents.filter((event) => !filter || /LOCK|RECOVERY|DANGER|BREAKDOWN|STABILITY/i.test(String(event.type ?? "")));
  const pageSize = filter === "protection" ? 10 : limit;
  const pageCount = Math.max(1, Math.ceil((filter ? matchingEvents.length : Math.min(matchingEvents.length, limit)) / pageSize));
  const visibleEvents = filter ? matchingEvents.slice((page - 1) * pageSize, page * pageSize) : matchingEvents.slice(0, limit);
  useEffect(() => { setPage((current) => Math.min(current, pageCount)); }, [pageCount]);
  const title = filter === "protection" ? "Protection history" : "Live activity";
  return (
    <Panel title={title} eyebrow="PERSISTED BOT EVENTS" icon={Radio} action={<span className="trade-count">{filter ? matchingEvents.length : visibleEvents.length} events</span>}>
      {visibleEvents.length ? <><div className="activity-list">{visibleEvents.map((event, index) => <ActivityRow key={`${eventTime(event) ?? index}-${String(event.type)}`} event={event} />)}</div>{filter === "protection" && <PaginationControls page={page} pageCount={pageCount} total={matchingEvents.length} pageSize={pageSize} itemLabel="eventos" onPageChange={setPage} />}</> : <div className="empty-state compact"><strong>No matching events recorded</strong><span>Events will appear here when the bot records them.</span></div>}
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
  const [page, setPage] = useState(1);
  const pageSize = 10;
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
  const pageCount = Math.max(1, Math.ceil(trades.length / pageSize));
  const visibleTrades = trades.slice((page - 1) * pageSize, page * pageSize);
  useEffect(() => { setPage((current) => Math.min(current, pageCount)); }, [pageCount]);
  return (
    <Panel title="Trade history" eyebrow="PAPER FILLS" icon={History} id="trades" action={<span className="trade-count">{trades.length} cycles</span>}>
      <div className="table-tools"><div className="filter-pills">{filters.map((item) => <button key={item} className={filter === item ? "filter-active" : ""} onClick={() => { setFilter(item); setPage(1); }}>{item}</button>)}</div><label className="search-box"><Search size={13} /><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Search trades" /></label></div>
      <div className="table-scroll"><table><thead><tr><th>Cycle</th><th>BUY / SELL time</th><th>BUY filled</th><th>SELL filled</th><th>Capital</th><th>Gross move</th><th>Net ROI</th><th>Profit</th><th>Hold</th><th>Exit reason</th><th>Fill method</th></tr></thead><tbody>
        {visibleTrades.map((trade, index) => { const absoluteIndex = (page - 1) * pageSize + index; const profit = cycleProfit(trade); const type = String(trade.type ?? "").toUpperCase(); const entryAt = trade.entryTime ?? trade.buyTime; const exitAt = trade.time ?? trade.exitTime; return <tr key={`${eventTime(trade) ?? absoluteIndex}-${String(trade.cycle ?? absoluteIndex)}`}><td><span className="cycle-number">{String(trade.cycle ?? trades.length - absoluteIndex)}</span></td><td><span className="table-datetime">{dateTime(entryAt)}</span><span className="table-datetime muted">{dateTime(exitAt)}</span></td><td>{price(pickNumber(trade.entryPrice, trade.buyPrice))}</td><td>{price(pickNumber(trade.sellPrice, trade.exitPrice))}</td><td>{currency(pickNumber(trade.capitalBefore, trade.investedUSDT, trade.originalCapital))}</td><td>{typeof trade.grossMove === "string" ? trade.grossMove : percent(numberValue(trade.grossMove))}</td><td>{percent(cycleRoi(trade))}</td><td className={moneyClass(profit)}>{currency(profit)}</td><td>{duration(pickNumber(trade.holdSeconds, trade.holdTimeSeconds))}</td><td><span className="reason-tag">{label(trade.reason, type.replaceAll("PAPER_", ""))}</span></td><td><span className="fill-method">{label(trade.fillMethod)}</span></td></tr>; })}
        {trades.length === 0 && <tr><td colSpan={11}><div className="table-empty">No matching completed trades in the selected data.</div></td></tr>}
      </tbody></table></div>
      <PaginationControls page={page} pageCount={pageCount} total={trades.length} pageSize={pageSize} itemLabel="operaciones" onPageChange={setPage} />
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
