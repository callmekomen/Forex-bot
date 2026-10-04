import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Filler,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
} from "chart.js";
import { Line } from "react-chartjs-2";
import {
  CircleStop,
  Gauge,
  Pause,
  Play,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { Chip, Metric, Reveal, SectionHeading, SignalBadge, Slider, cx, usd } from "./ui";
import { registerDesk, emit as emitDesk, type DeskStatus } from "../lib/deskBus";
import {
  generateCandles,
  pipSizeOf,
  prepare,
  scoreAt,
  sizeLots,
  DEFAULT_PARAMS,
  type Candle,
  type Dir,
  type Pair,
  type ScoreRow,
} from "../lib/sim";

ChartJS.register(LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip, BarElement);

const STORE_KEY = "forex_bot.desk.v1";
const HISTORY = 260;
const BARS_PER_POS = 4;
const ALL_PAIRS: Pair[] = ["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD", "EUR/GBP"];

interface Pos {
  ticket: number;
  pair: string;
  dir: Dir;
  lots: number;
  entry: number;
  sl: number;
  tp: number;
  openedAt: string;
  openedTick: number;
}
interface Closed extends Omit<Pos, "openedTick"> {
  exit: number;
  pnl: number;
  reason: string;
  closedAt: string;
}
interface LogLine {
  id: number;
  time: string;
  level: "info" | "long" | "short" | "warn" | "error";
  tag: string;
  msg: string;
}
interface PairState {
  pair: Pair;
  candles: Candle[];
  price: number;
  prevPrice: number;
  row: ScoreRow | null;
  skip: number;
}
interface Engine {
  tick: number;
  ticket: number;
  logId: number;
  balance: number;
  peak: number;
  dayStart: number;
  dailyPnl: number;
  halted: boolean;
  haltReason: string;
  open: Pos[];
  closed: Closed[];
  logs: LogLine[];
  equity: number[];
  pairs: PairState[];
  phase: number;
}

const now = () => new Date().toISOString().slice(11, 19);

function makeEngine(balance: number): Engine {
  const pairs: PairState[] = ALL_PAIRS.map((pair, i) => {
    const candles = generateCandles({ seed: 99 + i * 13, bars: HISTORY, pair, timeframe: "1h" });
    const price = candles[candles.length - 1].c;
    return { pair, candles, price, prevPrice: price, row: null, skip: 0 };
  });
  return {
    tick: 0,
    ticket: 900_001,
    logId: 1,
    balance,
    peak: balance,
    dayStart: balance,
    dailyPnl: 0,
    halted: false,
    haltReason: "",
    open: [],
    closed: [],
    logs: [],
    equity: [balance],
    pairs,
    phase: 0,
  };
}

function log(e: Engine, level: LogLine["level"], tag: string, msg: string) {
  e.logs.push({ id: e.logId++, time: now(), level, tag, msg });
  if (e.logs.length > 220) e.logs.splice(0, e.logs.length - 220);
}

export function TradingDesk() {
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(1200);
  const [riskPct, setRiskPct] = useState(0.02);
  const [minConf, setMinConf] = useState(0.55);
  const [atrMult, setAtrMult] = useState(1.5);
  const [tpMult, setTpMult] = useState(3);
  const [maxOpen, setMaxOpen] = useState(3);
  const [dailyLimit, setDailyLimit] = useState(0.05);
  const [ddLimit, setDdLimit] = useState(0.15);
  const [sessionFilter, setSessionFilter] = useState(false);
  const [active, setActive] = useState<Pair[]>(["EUR/USD", "GBP/USD", "USD/JPY"]);
  const [tab, setTab] = useState<"open" | "closed">("open");
  const [, force] = useState(0);

  const eng = useRef<Engine | null>(null);
  if (!eng.current) eng.current = makeEngine(10000);
  const e = eng.current;

  const cfgRef = useRef({ riskPct, minConf, atrMult, tpMult, maxOpen, dailyLimit, ddLimit, sessionFilter, active });
  useEffect(() => {
    cfgRef.current = { riskPct, minConf, atrMult, tpMult, maxOpen, dailyLimit, ddLimit, sessionFilter, active };
  });

  /* ── restore persisted desk state (mirrors load_state) ─────────── */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      const eng2 = eng.current!;
      eng2.balance = Number(s.current_balance ?? eng2.balance);
      eng2.peak = Math.max(Number(s.peak_balance ?? 0), eng2.balance);
      eng2.dailyPnl = Number(s.daily_pnl ?? 0);
      eng2.halted = Boolean(s.halted);
      eng2.haltReason = String(s.halt_reason ?? "");
      eng2.open = Array.isArray(s.open_positions) ? s.open_positions : [];
      eng2.closed = Array.isArray(s.trade_log) ? s.trade_log : [];
      eng2.ticket = Number(s.next_ticket ?? 900_001);
      eng2.tick = Number(s.tick ?? 0);
      eng2.equity = Array.isArray(s.equity) ? s.equity.slice(-160) : [eng2.balance];
      log(
        eng2,
        "info",
        "risk",
        `State restored: balance ${eng2.balance.toFixed(2)}, day ${eng2.dailyPnl >= 0 ? "+" : ""}${eng2.dailyPnl.toFixed(2)}, ${eng2.open.length} open, halted=${eng2.halted}`,
      );
      force((v) => v + 1);
    } catch {
      /* corrupt or unavailable storage — start clean, never crash the desk */
    }
  }, []);

  const persist = useCallback(() => {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          saved_at: new Date().toISOString(),
          tick: e.tick,
          current_balance: Number(e.balance.toFixed(2)),
          peak_balance: Number(e.peak.toFixed(2)),
          daily_pnl: Number(e.dailyPnl.toFixed(2)),
          halted: e.halted,
          halt_reason: e.haltReason,
          open_positions: e.open,
          trade_log: e.closed.slice(-50),
          equity: e.equity.slice(-160),
          next_ticket: e.ticket,
        }),
      );
    } catch {
      /* ignore quota errors */
    }
  }, [e]);

  /* ── the tick: manage → gate → scan → size → fill ──────────────── */
  const doTick = useCallback(() => {
    const c = cfgRef.current;
    const eng2 = eng.current!;
    eng2.tick++;
    eng2.phase += 1;
    const params = { ...DEFAULT_PARAMS, atrMult: c.atrMult, tpMult: c.tpMult, minConfidence: c.minConf };
    const utcHour = new Date().getUTCHours();
    const inHours = !c.sessionFilter || (utcHour >= 7 && utcHour < 20);

    // 1 ── advance prices, form candles
    for (const p of eng2.pairs) {
      p.prevPrice = p.price;
      const trend = 0.00055 * Math.sin(eng2.phase / 34 + p.pair.length) + 0.00022 * Math.sin(eng2.phase / 11);
      const shock = trend + (Math.random() - 0.5) * 0.0017;
      const next = Math.max(1e-4, p.price * (1 + shock));
      p.price = next;
      const last = p.candles[p.candles.length - 1];
      last.c = next;
      last.h = Math.max(last.h, next);
      last.l = Math.min(last.l, next);
      last.v += Math.round(Math.random() * 40);
      if (eng2.tick % BARS_PER_POS === 0) {
        p.candles.push({ t: last.t + 3600_000, o: next, h: next, l: next, c: next, v: 800 + Math.round(Math.random() * 400) });
        if (p.candles.length > HISTORY) p.candles.shift();
      }
    }

    // 2 ── manage open positions (SL/TP against the live quote)
    for (const pos of [...eng2.open]) {
      const p = eng2.pairs.find((x) => x.pair === pos.pair)!;
      const pip = pipSizeOf(pos.pair);
      const bid = p.price - p.price * 0.00006;
      const ask = p.price + p.price * 0.00006;
      const hitLong = pos.dir === "BUY" && bid <= pos.sl;
      const hitLongTp = pos.dir === "BUY" && bid >= pos.tp;
      const hitShort = pos.dir === "SELL" && ask >= pos.sl;
      const hitShortTp = pos.dir === "SELL" && ask <= pos.tp;
      if (hitLong || hitLongTp || hitShort || hitShortTp) {
        const exit = hitLong || hitShort ? pos.sl : pos.tp;
        const pips = (pos.dir === "BUY" ? exit - pos.entry : pos.entry - exit) / pip;
        const pnl = Math.round((pips * 10 * pos.lots - 1.5 * pip * 10 * pos.lots) * 100) / 100;
        eng2.open = eng2.open.filter((x) => x.ticket !== pos.ticket);
        eng2.closed.unshift({ ...pos, exit, pnl, reason: hitLong || hitShort ? "stop_loss" : "take_profit", closedAt: now() });
        eng2.dailyPnl = Math.round((eng2.dailyPnl + pnl) * 100) / 100;
        eng2.balance = Math.round((eng2.balance + pnl) * 100) / 100;
        eng2.peak = Math.max(eng2.peak, eng2.balance);
        log(
          eng2,
          pnl >= 0 ? "long" : "short",
          "risk",
          `CLOSED ${pos.dir} ${pos.pair} ticket ${pos.ticket} -> ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USD (${hitLong || hitShort ? "stop_loss" : "take_profit"}) | day ${eng2.dailyPnl >= 0 ? "+" : ""}${eng2.dailyPnl.toFixed(2)} | balance ${eng2.balance.toFixed(2)}`,
        );
      }
    }

    // 3 ── circuit breakers
    const drawdown = eng2.peak > 0 ? Math.max(0, (eng2.peak - eng2.balance) / eng2.peak) : 0;
    if (!eng2.halted && eng2.dailyPnl <= -Math.abs(eng2.dayStart * c.dailyLimit)) {
      eng2.halted = true;
      eng2.haltReason = `daily loss ${eng2.dailyPnl.toFixed(2)} exceeded ${(c.dailyLimit * 100).toFixed(1)}% limit`;
      log(eng2, "error", "risk", `HALT — ${eng2.haltReason}. No further trades this UTC day.`);
    }
    if (!eng2.halted && drawdown >= c.ddLimit) {
      eng2.halted = true;
      eng2.haltReason = `max drawdown ${(drawdown * 100).toFixed(2)}% >= ${(c.ddLimit * 100).toFixed(0)}%`;
      log(eng2, "error", "risk", `HALT — ${eng2.haltReason}. Sticky until reset_halt().`);
    }

    eng2.equity.push(Number(eng2.balance.toFixed(2)));
    if (eng2.equity.length > 160) eng2.equity.shift();
    if (eng2.closed.length > 120) eng2.closed.length = 120;

    // 4 ── can_trade()
    const gateFail = eng2.halted
      ? `BOT HALTED (${eng2.haltReason})`
      : eng2.open.length >= c.maxOpen
        ? `max open positions reached (${eng2.open.length}/${c.maxOpen})`
        : !inHours
          ? `outside trading hours (${String(utcHour).padStart(2, "0")}:00 UTC, allowed 07:00-20:00)`
          : "";
    if (gateFail) {
      if (eng2.tick % 5 === 1) log(eng2, "warn", "bot", `No analysis this tick — ${gateFail}`);
    } else {
      // 5 ── scan each enabled pair
      for (const p of eng2.pairs) {
        if (!c.active.includes(p.pair)) continue;
        if (p.skip > 0) {
          p.skip--;
          continue;
        }
        const d = prepare(p.candles, params);
        const row = scoreAt(d, p.candles.length - 1, params);
        p.row = row;
        if (row.signal === "NEUTRAL" || row.confidence < c.minConf) continue;

        const dup = eng2.open.some((x) => x.pair === p.pair);
        const rr = row.atr > 0 ? c.tpMult / c.atrMult : 0;
        const sizing = sizeLots(eng2.balance, c.riskPct, row.price, row.sl, pipSizeOf(p.pair), 10);
        const verdict = dup
          ? { ok: false, why: `already holding a position on ${p.pair}` }
          : rr < 1.5
            ? { ok: false, why: `risk:reward ${rr.toFixed(2)} < 1.50` }
            : sizing.lots <= 0
              ? { ok: false, why: "lot size rounds to zero — stop too wide for the risk budget" }
              : { ok: true, why: "" };

        log(
          eng2,
          row.dir === "BUY" ? "long" : "short",
          "strategy",
          `Signal ${p.pair} ${row.signal} @ ${row.price.toFixed(5)} | SL ${row.sl.toFixed(5)} TP ${row.tp.toFixed(5)} | conf ${row.confidence.toFixed(2)} | score ${row.score >= 0 ? "+" : ""}${row.score.toFixed(2)} | ${row.reasons.slice(0, 2).join("; ")}`,
        );
        if (!verdict.ok) {
          p.skip = 6;
          log(eng2, "warn", "risk", `${p.pair}: REJECTED — ${verdict.why}`);
          continue;
        }
        const fill = row.dir === "BUY" ? row.price + pipSizeOf(p.pair) : row.price - pipSizeOf(p.pair);
        const pos: Pos = {
          ticket: eng2.ticket++,
          pair: p.pair,
          dir: row.dir,
          lots: sizing.lots,
          entry: Number(fill.toFixed(5)),
          sl: row.sl,
          tp: row.tp,
          openedAt: now(),
          openedTick: eng2.tick,
        };
        eng2.open.push(pos);
        p.skip = 10;
        log(eng2, "info", "broker", `FILLED ${pos.dir} ${pos.pair} ${pos.lots.toFixed(2)} lots @ ${pos.entry.toFixed(5)} (ticket ${pos.ticket}, retcode 10009, magic 123456)`);
        log(eng2, row.dir === "BUY" ? "long" : "short", "risk", `approved ${pos.dir} ${sizing.lots.toFixed(2)} lots | risk ${sizing.riskUsd.toFixed(2)} USD (${((sizing.riskUsd / eng2.balance) * 100).toFixed(2)}% of equity) | RR ${rr.toFixed(2)} | conf ${row.confidence.toFixed(2)}`);
      }
    }
    persist();
    force((v) => v + 1);
  }, [e, persist]);

  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(doTick, speed);
    return () => window.clearInterval(t);
  }, [running, speed, doTick]);

  const start = () => {
    if (!active.length) {
      log(e, "error", "bot", "No pairs selected — refusing to start an empty loop.");
      force((v) => v + 1);
      return;
    }
    log(e, "info", "bot", `Bot starting — ${active.length} pairs, live scan every ${(speed / 1000).toFixed(1)}s, magic 123456, comment forex_bot_v1`);
    log(e, "warn", "broker", "DESK MODE — fills are simulated in the browser; nothing reaches a broker.");
    setRunning(true);
  };
  const stop = () => {
    log(e, "warn", "bot", `Stopped by operator after ${e.tick} ticks — ${e.open.length} position(s) left open, state persisted.`);
    setRunning(false);
    persist();
    force((v) => v + 1);
  };
  const reset = () => {
    setRunning(false);
    localStorage.removeItem(STORE_KEY);
    eng.current = makeEngine(10000);
    log(eng.current, "info", "bot", "Desk reset — balance 10000.00, halts cleared, state file removed.");
    force((v) => v + 1);
  };
  const closeManually = (ticket: number) => {
    const pos = e.open.find((x) => x.ticket === ticket);
    if (!pos) return;
    const p = e.pairs.find((x) => x.pair === pos.pair)!;
    const pip = pipSizeOf(pos.pair);
    const pips = (pos.dir === "BUY" ? p.price - pos.entry : pos.entry - p.price) / pip;
    const pnl = Math.round(pips * 10 * pos.lots * 100) / 100;
    e.open = e.open.filter((x) => x.ticket !== ticket);
    e.closed.unshift({ ...pos, exit: p.price, pnl, reason: "manual", closedAt: now() });
    e.dailyPnl = Math.round((e.dailyPnl + pnl) * 100) / 100;
    e.balance = Math.round((e.balance + pnl) * 100) / 100;
    e.peak = Math.max(e.peak, e.balance);
    log(e, pnl >= 0 ? "long" : "short", "bot", `Manual close ticket ${ticket} ${pos.pair} → ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USD`);
    persist();
    force((v) => v + 1);
  };
  const clearHalt = () => {
    e.halted = false;
    e.haltReason = "";
    e.peak = Math.max(e.peak, e.balance);
    log(e, "warn", "risk", "Halt cleared by operator. Balance " + e.balance.toFixed(2) + ", peak " + e.peak.toFixed(2) + ".");
    persist();
    force((v) => v + 1);
  };

  /* ── remote control surface (the Telegram chat talks to this) ─────── */
  const handleRemote = useCallback(
    (raw: string): string => {
      const parts = raw.trim().split(/\s+/);
      const verb = (parts[0] || "").toLowerCase();
      const eng2 = eng.current!;
      const wins = eng2.closed.filter((t) => t.pnl > 0).length;
      const dd = eng2.peak > 0 ? (((eng2.peak - eng2.balance) / eng2.peak) * 100).toFixed(2) : "0.00";
      switch (verb) {
        case "/start":
          if (eng2.halted) return "🚫 Refusing to start: a halt is latched. /resume clears it (after you have reviewed).";
          start();
          return "▶️ trading loop armed — signals will pass the risk gate from the next tick.";
        case "/stop":
          stop();
          return "⏹ stopping after the current tick. Open positions keep their SL/TP.";
        case "/tick":
          doTick();
          return "🔎 one analysis pass completed.";
        case "/status":
          return [
            `${running ? "🟢 running" : "🟡 stopped"} · tick ${eng2.tick}`,
            `💰 equity ${eng2.balance.toFixed(2)} USD   peak ${eng2.peak.toFixed(2)}`,
            `📅 day P&L ${eng2.dailyPnl >= 0 ? "+" : ""}${eng2.dailyPnl.toFixed(2)}   drawdown ${dd}%`,
            `📊 closed ${eng2.closed.length} trades   win rate ${eng2.closed.length ? ((100 * wins) / eng2.closed.length).toFixed(1) : "0.0"}%`,
            `🔓 open ${eng2.open.length}/${maxOpen}`,
            eng2.halted ? `🚨 halted: ${eng2.haltReason}` : "✅ no halt",
            "🆔 account 12345678 @ Broker-Demo · USD · verified=True · magic 123456",
          ].join("\n");
        case "/positions":
          if (!eng2.open.length) return "No open positions.";
          return `${eng2.open.length} open (magic 123456):\n${eng2.open
            .map((p) => `• ${p.ticket} ${p.pair} ${p.dir} ${p.lots.toFixed(2)} @ ${p.entry.toFixed(5)}\n  SL ${p.sl.toFixed(5)}  TP ${p.tp.toFixed(5)}  since ${p.openedAt}`)
            .join("\n")}`;
        case "/close": {
          const arg = (parts[1] || "all").toLowerCase();
          const targets = arg === "all" || arg === "*" ? [...eng2.open] : eng2.open.filter((p) => String(p.ticket) === arg);
          if (!targets.length) return arg === "all" ? "Nothing to close." : `No open position with ticket ${arg}.`;
          targets.forEach((p) => closeManually(p.ticket));
          return `🔻 closed ${targets.length} position(s) via broker; P&L booked through the risk manager.`;
        }
        case "/halt":
          eng2.halted = true;
          eng2.haltReason = "operator halt via remote command";
          setRunning(false);
          persist();
          force((v) => v + 1);
          return "🛑 HALTED. No new entries until /resume (state file updated).";
        case "/resume":
          clearHalt();
          return "↩️ halt cleared. Loop still needs /start — that is deliberate.";
        case "/risk":
          return [
            "Risk limits (read-only here — edit config.py and restart):",
            `• risk/trade ${(riskPct * 100).toFixed(2)}% ≈ ${usd(eng2.balance * riskPct)}`,
            `• daily loss halt ${(dailyLimit * 100).toFixed(1)}% ≈ ${usd(eng2.dayStart * dailyLimit, 0)}`,
            `• max drawdown halt ${(ddLimit * 100).toFixed(0)}%  (currently ${dd}%)`,
            `• max open ${maxOpen} · min confidence ${minConf.toFixed(2)}`,
            `• SL ${atrMult}×ATR / TP ${tpMult}×ATR (RR ${(tpMult / atrMult).toFixed(2)})`,
            "• session 07–20 UTC · tick " + (speed / 1000).toFixed(1) + "s",
          ].join("\n");
        case "/pairs":
          return `📌 watching: ${active.join(", ")}  [1h]`;
        default:
          return "Unknown command. /start /stop /status /positions /close <ticket|all> /halt /resume /risk /tick /help";
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [running, riskPct, minConf, atrMult, tpMult, maxOpen, dailyLimit, ddLimit, active, speed, e],
  );

  const busStatus = useCallback(
    (): DeskStatus | null => ({
      running,
      tick: e.tick,
      balance: e.balance,
      peak: e.peak,
      dailyPnl: e.dailyPnl,
      drawdown: e.peak > 0 ? Math.max(0, ((e.peak - e.balance) / e.peak) * 100) : 0,
      halted: e.halted,
      haltReason: e.haltReason,
      open: e.open.map((p) => ({ ticket: p.ticket, pair: p.pair, dir: p.dir, lots: p.lots, entry: p.entry, sl: p.sl, tp: p.tp })),
      closedCount: e.closed.length,
      wins: e.closed.filter((t) => t.pnl > 0).length,
      pairs: [...active],
      limits: { riskPct, minConf, atrMult, tpMult, maxOpen, dailyLimit, ddLimit },
    }),
    [running, e, active, riskPct, minConf, atrMult, tpMult, maxOpen, dailyLimit, ddLimit],
  );

  useEffect(() => registerDesk({ status: busStatus, run: handleRemote }), [busStatus, handleRemote]);
  useEffect(() => {
    emitDesk();
  });

  const drawdown = e.peak > 0 ? Math.max(0, ((e.peak - e.balance) / e.peak) * 100) : 0;
  const wins = e.closed.filter((t) => t.pnl > 0).length;
  const scanRows = useMemo(() => e.pairs.filter((p) => active.includes(p.pair)), [e, active]);
  const mark = (p: PairState) => {
    const pos = e.open.find((x) => x.pair === p.pair);
    if (!pos) return 0;
    const pip = pipSizeOf(p.pair);
    return Math.round(((p.price - pos.entry) / pip) * 10 * pos.lots * (pos.dir === "BUY" ? 1 : -1) * 100) / 100;
  };

  const chartData = {
    labels: e.equity.map((_, i) => String(i)),
    datasets: [
      {
        label: "equity",
        data: e.equity,
        borderColor: e.halted ? "#ff6b6f" : "#2fd39a",
        borderWidth: 1.6,
        pointRadius: 0,
        tension: 0.25,
        fill: true,
        backgroundColor: (ctx: { chart: { ctx: CanvasRenderingContext2D; chartArea?: { top: number; bottom: number } } }) => {
          const a = ctx.chart.chartArea;
          if (!a) return "rgba(47,211,154,0.1)";
          const g = ctx.chart.ctx.createLinearGradient(0, a.top, 0, a.bottom);
          g.addColorStop(0, e.halted ? "rgba(255,107,111,0.28)" : "rgba(47,211,154,0.26)");
          g.addColorStop(1, "rgba(47,211,154,0.01)");
          return g;
        },
      },
    ],
  };
  const chartOpts = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 240 },
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: {
      x: { display: false },
      y: {
        grid: { color: "rgba(36,54,63,0.7)" },
        ticks: { color: "#8ea3ad", font: { family: "JetBrains Mono", size: 9 }, maxTicksLimit: 5 },
      },
    },
  };

  const toneCls = { info: "text-sand-2", long: "text-jade", short: "text-rose", warn: "text-amber", error: "text-rose font-medium" };

  return (
    <section id="desk" className="mx-auto max-w-[1400px] px-4 py-16 md:px-7">
      <Reveal>
        <SectionHeading
          index="00"
          kicker="main.py — the loop, running"
          tone="jade"
          title={
            <>
              Start it and walk away.
              <br />
              <span className="text-muted">It scans, gates, fills, manages — until you stop it.</span>
            </>
          }
          blurb={
            <>
              This is the live tick loop from <code className="rounded bg-panel px-1.5 py-0.5 font-mono text-[12.5px] text-amber">main.py</code> running in your browser:
              prices advance, indicators re-score every tick, the risk gate approves or rejects, positions open with
              ATR stops and close when a level is touched. Halts and P&amp;L persist in localStorage exactly like{" "}
              <code className="rounded bg-panel px-1.5 py-0.5 font-mono text-[12.5px] text-amber">bot_state.json</code>, so refreshing the page
              does not make the bot forget it was down 16%.
            </>
          }
          right={
            <div className="flex items-center gap-2">
              <button
                onClick={running ? stop : start}
                className={cx(
                  "group relative inline-flex items-center gap-2.5 rounded-xl border px-6 py-3.5 font-mono text-[13px] font-bold tracking-[0.14em] uppercase transition-all",
                  running
                    ? "border-rose/50 bg-rose/12 text-rose hover:bg-rose/20"
                    : "border-jade/50 bg-jade/12 text-jade hover:bg-jade/20 hover:shadow-[0_0_34px_-8px_rgba(47,211,154,0.7)]",
                )}
              >
                {running ? (
                  <>
                    <span className="absolute inset-0 -z-10 animate-pulse-soft rounded-xl bg-jade/5" />
                    <CircleStop size={16} /> stop the loop
                  </>
                ) : (
                  <>
                    <Play size={16} className="transition-transform group-hover:scale-110" /> start trading
                  </>
                )}
              </button>
              <button
                onClick={() => doTick()}
                disabled={running}
                title="Run exactly one tick"
                className="grid size-11 place-items-center rounded-lg border border-line bg-panel text-muted transition-colors enabled:hover:border-sky/45 enabled:hover:text-sky disabled:opacity-40"
              >
                <Sparkles size={14} />
              </button>
              <button
                onClick={reset}
                title="Clear state and halts"
                className="grid size-11 place-items-center rounded-lg border border-line bg-panel text-muted transition-colors hover:border-rose/45 hover:text-rose"
              >
                <Trash2 size={14} />
              </button>
            </div>
          }
        />
      </Reveal>

      {e.halted && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-rose/45 bg-rose/[0.09] px-4 py-3">
          <ShieldAlert size={16} className="text-rose" />
          <span className="font-mono text-[12.5px] text-rose">CIRCUIT BREAKER TRIPPED — {e.haltReason}</span>
          <span className="font-mono text-[11px] text-sand-2/70">new entries blocked; open positions still managed</span>
          <button
            onClick={clearHalt}
            className="ml-auto rounded-md border border-rose/45 px-3 py-1.5 font-mono text-[11px] text-rose transition-colors hover:bg-rose/15"
          >
            reset_halt()
          </button>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[290px_minmax(0,1fr)_330px]">
        {/* ── controls ─────────────────────────────────────────────── */}
        <Reveal>
          <div className="panel space-y-4 rounded-xl p-4">
            <div className="flex items-center gap-2">
              <Gauge size={13} className={running ? "animate-pulse-soft text-jade" : "text-muted"} />
              <span className="font-mono text-[10.5px] tracking-[0.18em] text-muted uppercase">loop controls</span>
            </div>

            <div>
              <span className="font-mono text-[10px] tracking-[0.18em] text-muted uppercase">tick_interval</span>
              <div className="mt-2 grid grid-cols-4 gap-1">
                {[600, 1200, 2400, 4000].map((s) => (
                  <button
                    key={s}
                    onClick={() => setSpeed(s)}
                    className={cx(
                      "rounded-md border py-1.5 font-mono text-[10.5px] transition-colors",
                      speed === s ? "border-jade/50 bg-jade/12 text-jade" : "border-line text-muted hover:text-sand-2",
                    )}
                  >
                    {(s / 1000).toFixed(1)}s
                  </button>
                ))}
              </div>
            </div>

            <div>
              <span className="font-mono text-[10px] tracking-[0.18em] text-muted uppercase">watchlist</span>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {ALL_PAIRS.map((p) => {
                  const on = active.includes(p);
                  return (
                    <button
                      key={p}
                      onClick={() => setActive((cur) => (on ? cur.filter((x) => x !== p) : [...cur, p]))}
                      className={cx(
                        "rounded-md border px-2 py-1 font-mono text-[10.5px] transition-colors",
                        on ? "border-sky/45 bg-sky/10 text-sky" : "border-line text-muted hover:text-sand-2",
                      )}
                    >
                      {on ? "◉" : "○"} {p}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-3.5 border-t border-line-soft pt-3">
              <Slider label="max_risk_per_trade" value={riskPct} min={0.0025} max={0.05} step={0.0025} onChange={setRiskPct} display={`${(riskPct * 100).toFixed(2)}%`} tone="amber" />
              <Slider label="min_confidence" value={minConf} min={0.2} max={0.9} step={0.01} onChange={setMinConf} tone="sky" />
              <Slider label="atr_multiplier (SL)" value={atrMult} min={0.8} max={3} step={0.1} onChange={setAtrMult} suffix="×" tone="rose" />
              <Slider label="tp_multiplier" value={tpMult} min={1.5} max={5} step={0.1} onChange={setTpMult} suffix="×" tone="jade" />
              <Slider label="max_open_positions" value={maxOpen} min={1} max={6} step={1} onChange={setMaxOpen} tone="amber" />
              <Slider label="max_daily_loss" value={dailyLimit} min={0.01} max={0.2} step={0.005} onChange={setDailyLimit} display={`${(dailyLimit * 100).toFixed(1)}%`} tone="rose" />
              <Slider label="max_drawdown_limit" value={ddLimit} min={0.03} max={0.4} step={0.01} onChange={setDdLimit} display={`${(ddLimit * 100).toFixed(0)}%`} tone="rose" />
              <button
                onClick={() => setSessionFilter((s) => !s)}
                className={cx(
                  "flex w-full items-center gap-2 rounded-md border px-2.5 py-2 font-mono text-[10.5px] transition-colors",
                  sessionFilter ? "border-amber/45 bg-amber/10 text-amber" : "border-line text-muted hover:text-sand-2",
                )}
              >
                {sessionFilter ? <Pause size={11} /> : <Play size={11} />}
                session filter 07–20 UTC {sessionFilter ? "ON — it will idle off-hours" : "OFF — always trading"}
              </button>
            </div>
          </div>
        </Reveal>

        {/* ── accounts + scan + chart + book ────────────────────────── */}
        <Reveal delay={60} className="min-w-0">
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
              <Metric label="equity" value={usd(e.balance)} sub={`start ${usd(e.dayStart, 0)}`} tone={e.balance >= e.dayStart ? "jade" : "rose"} />
              <Metric label="daily pnl" value={usd(e.dailyPnl)} sub={`limit ${usd(-e.dayStart * dailyLimit, 0)}`} tone={e.dailyPnl >= 0 ? "jade" : "rose"} />
              <Metric label="drawdown" value={`${drawdown.toFixed(2)}%`} sub={`halt at ${(ddLimit * 100).toFixed(0)}%`} tone={drawdown >= ddLimit ? "rose" : "sand"} />
              <Metric label="open" value={`${e.open.length}/${maxOpen}`} sub={running ? "loop live" : "loop idle"} tone={running ? "jade" : "sand"} />
              <Metric label="closed trades" value={e.closed.length} sub={`${wins}W / ${e.closed.length - wins}L`} tone="sky" />
              <Metric label="tick" value={e.tick.toLocaleString()} sub={`${(speed / 1000).toFixed(1)}s interval`} tone="amber" />
            </div>

            <div className="panel overflow-hidden rounded-xl">
              <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
                <span className={cx("size-2 rounded-full", running ? "animate-pulse-soft bg-jade" : "bg-muted")} />
                <span className="font-mono text-[10.5px] tracking-[0.18em] text-muted uppercase">scan — {scanRows.length} pairs each tick</span>
                <Chip tone={running ? "jade" : "line"}>{running ? "loop running" : "loop idle"}</Chip>
              </div>
              <div className="divide-y divide-line-soft">
                {scanRows.map((p) => {
                  const row = p.row;
                  const up = p.price >= p.prevPrice;
                  const pos = e.open.find((x) => x.pair === p.pair);
                  const spark = p.candles.slice(-60).map((c) => c.c);
                  const lo = Math.min(...spark);
                  const hi = Math.max(...spark);
                  const pts = spark
                    .map((v, i) => `${(i / (spark.length - 1)) * 120},${28 - ((v - lo) / (hi - lo || 1)) * 26}`)
                    .join(" ");
                  return (
                    <div
                      key={p.pair}
                      className="grid grid-cols-[72px_minmax(0,1fr)_66px_minmax(0,96px)] items-center gap-2 px-3 py-2.5 transition-colors hover:bg-panel-2/50 sm:grid-cols-[110px_minmax(0,1fr)_120px_130px] sm:gap-3 sm:px-4"
                    >
                      <div>
                        <div className="font-mono text-[12px] text-sand">{p.pair}</div>
                        <div className="tabnum font-mono text-[10px] text-muted">
                          <span className={up ? "text-jade" : "text-rose"}>{p.price.toFixed(p.pair.includes("JPY") ? 3 : 5)}</span>{" "}
                          {pos ? <span className="text-amber">{pos.dir.toLowerCase()}</span> : null}
                        </div>
                      </div>
                      <svg viewBox="0 0 120 30" className="h-8 w-full">
                        <polyline points={pts} fill="none" className={up ? "stroke-jade/80" : "stroke-rose/80"} strokeWidth={1.2} />
                      </svg>
                      <div className="text-right">
                        {row ? (
                          <>
                            <div className="tabnum font-mono text-[10.5px] text-sand-2">
                              score {row.score >= 0 ? "+" : ""}
                              {row.score.toFixed(1)}
                            </div>
                            <div className="tabnum font-mono text-[10px] text-muted">conf {row.confidence.toFixed(2)}</div>
                          </>
                        ) : (
                          <span className="font-mono text-[10px] text-muted">awaiting first tick</span>
                        )}
                      </div>
                      <div className="flex justify-end">{row ? <SignalBadge signal={row.signal} size="sm" /> : <span className="font-mono text-[10px] text-line">—</span>}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="panel rounded-xl p-4">
              <div className="flex items-center gap-2 border-b border-line-soft pb-2">
                <span className="font-mono text-[10.5px] tracking-[0.18em] text-muted uppercase">equity curve</span>
                <span className="ml-auto tabnum font-mono text-[10px] text-muted">
                  peak {usd(e.peak, 0)} · {e.equity.length} pts
                </span>
              </div>
              <div className="mt-2 h-[150px]">
                <Line data={chartData} options={chartOpts} />
              </div>
            </div>

            <div className="panel overflow-hidden rounded-xl">
              <div className="flex items-center gap-1 border-b border-line px-3 py-2">
                {(["open", "closed"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={cx(
                      "rounded-md px-2.5 py-1 font-mono text-[10.5px] tracking-wide uppercase transition-colors",
                      tab === t ? "bg-panel-2 text-sand" : "text-muted hover:text-sand-2",
                    )}
                  >
                    {t === "open" ? `open positions (${e.open.length})` : `trade log (${e.closed.length})`}
                  </button>
                ))}
              </div>
              <div className="max-h-[240px] overflow-auto">
                <table className="w-full border-collapse text-left font-mono text-[10.5px]">
                  <thead className="sticky top-0 bg-panel-2/95 text-muted backdrop-blur">
                    <tr>
                      {(tab === "open"
                        ? ["ticket", "pair", "dir", "lots", "entry", "sl", "tp", "uP&L", ""]
                        : ["ticket", "pair", "dir", "lots", "entry", "exit", "reason", "pnl"]
                      ).map((h) => (
                        <th key={h} className="border-b border-line px-3 py-1.5 font-medium tracking-[0.1em] uppercase">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {tab === "open" &&
                      e.open.map((pos) => {
                        const u = mark(e.pairs.find((x) => x.pair === pos.pair)!);
                        return (
                          <tr key={pos.ticket} className="border-b border-line-soft/60 hover:bg-panel-2/50">
                            <td className="px-3 py-1.5 text-muted">{pos.ticket}</td>
                            <td className="px-3 py-1.5 text-sand-2">{pos.pair}</td>
                            <td className={cx("px-3 py-1.5", pos.dir === "BUY" ? "text-jade" : "text-rose")}>
                              {pos.dir === "BUY" ? "▲" : "▼"} {pos.dir}
                            </td>
                            <td className="tabnum px-3 py-1.5">{pos.lots.toFixed(2)}</td>
                            <td className="tabnum px-3 py-1.5">{pos.entry.toFixed(5)}</td>
                            <td className="tabnum px-3 py-1.5 text-rose/80">{pos.sl.toFixed(5)}</td>
                            <td className="tabnum px-3 py-1.5 text-jade/80">{pos.tp.toFixed(5)}</td>
                            <td className={cx("tabnum px-3 py-1.5", u >= 0 ? "text-jade" : "text-rose")}>{usd(u)}</td>
                            <td className="px-3 py-1.5">
                              <button
                                onClick={() => closeManually(pos.ticket)}
                                className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-muted transition-colors hover:border-rose/45 hover:text-rose"
                              >
                                <X size={9} /> close
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    {tab === "closed" &&
                      e.closed.map((t) => (
                        <tr key={`${t.ticket}-${t.closedAt}`} className="border-b border-line-soft/60 hover:bg-panel-2/50">
                          <td className="px-3 py-1.5 text-muted">{t.ticket}</td>
                          <td className="px-3 py-1.5 text-sand-2">{t.pair}</td>
                          <td className={cx("px-3 py-1.5", t.dir === "BUY" ? "text-jade" : "text-rose")}>
                            {t.dir === "BUY" ? "▲" : "▼"}
                          </td>
                          <td className="tabnum px-3 py-1.5">{t.lots.toFixed(2)}</td>
                          <td className="tabnum px-3 py-1.5">{t.entry.toFixed(5)}</td>
                          <td className="tabnum px-3 py-1.5">{t.exit.toFixed(5)}</td>
                          <td className={cx("px-3 py-1.5", t.reason === "take_profit" ? "text-jade/80" : t.reason === "stop_loss" ? "text-rose/80" : "text-sky/80")}>{t.reason}</td>
                          <td className={cx("tabnum px-3 py-1.5", t.pnl >= 0 ? "text-jade" : "text-rose")}>{usd(t.pnl)}</td>
                        </tr>
                      ))}
                    {((tab === "open" && !e.open.length) || (tab === "closed" && !e.closed.length)) && (
                      <tr>
                        <td colSpan={8} className="px-3 py-6 text-center text-muted">
                          {tab === "open" ? "No open exposure — press start trading, or step one tick with the scan button." : "No closed trades yet."}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </Reveal>

        {/* ── console + state ──────────────────────────────────────── */}
        <Reveal delay={120}>
          <div className="flex h-full min-h-[520px] flex-col gap-4">
            <div className="panel flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl">
              <div className="flex items-center gap-2 border-b border-line bg-panel-2/70 px-3.5 py-2">
                <span className="font-mono text-[10.5px] tracking-[0.18em] text-muted uppercase">bot.log</span>
                <span className="ml-auto flex items-center gap-1.5 font-mono text-[9.5px] text-jade uppercase">
                  <span className={cx("size-1.5 rounded-full", running ? "animate-pulse-soft bg-jade" : "bg-muted")} />
                  {e.logs.length} lines
                </span>
              </div>
              <div className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto bg-ink-2/60 p-3">
                <div className="space-y-1.5 font-mono text-[10.5px] leading-relaxed">
                  {[...e.logs].reverse().map((l) => (
                    <div key={l.id} className="flex gap-2">
                      <span className="shrink-0 text-line">{l.time}</span>
                      <span className={cx("shrink-0", l.level === "error" ? "text-rose" : l.level === "warn" ? "text-amber" : "text-sky/70")}>
                        {l.level === "error" ? "[ERROR]" : l.level === "warn" ? "[WARN ]" : "[INFO ]"}
                      </span>
                      <span className="shrink-0 text-muted">forex_bot.{l.tag}:</span>
                      <span className={cx("min-w-0 break-words", toneCls[l.level])}>{l.msg}</span>
                    </div>
                  ))}
                  {!e.logs.length && <div className="text-muted">Waiting for the first tick…</div>}
                </div>
              </div>
            </div>

            <div className="panel rounded-xl p-4">
              <div className="flex items-center gap-2">
                <RotateCcw size={12} className="text-amber" />
                <span className="font-mono text-[10.5px] tracking-[0.18em] text-muted uppercase">persisted state</span>
                <span className="ml-auto font-mono text-[9.5px] text-jade">localStorage · written each tick</span>
              </div>
              <pre className="mt-2.5 max-h-[150px] overflow-auto rounded-lg border border-line-soft bg-ink-2/80 p-3 font-mono text-[10px] leading-relaxed text-amber/85">
{`{
  "current_balance": ${e.balance.toFixed(2)},
  "peak_balance": ${e.peak.toFixed(2)},
  "daily_pnl": ${e.dailyPnl.toFixed(2)},
  "halted": ${e.halted},
  "open_positions": ${e.open.length},
  "trade_log": ${e.closed.length} entries
}`}
              </pre>
            </div>
          </div>
        </Reveal>
      </div>

      <p className="mt-4 font-mono text-[10.5px] leading-relaxed text-muted">
        Same sequence the Python runs: advance prices → manage exposure → circuit breakers → can_trade() → per-pair score →
        validate_trade() → open_trade(). <span className="text-rose">Desk fills are simulated</span>;{" "}
        <span className="text-sand-2">python main.py</span> runs the identical loop against a real MT5 demo terminal and keeps
        going until you press Ctrl+C.
      </p>
    </section>
  );
}
