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
  Crosshair,
  Dices,
  Gauge,
  Pause,
  Play,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
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
import {
  DEFAULT_GAMBLE_GATE,
  GAMBLE_COOLDOWN_TICKS,
  GAMBLE_MAX_LOSSES_PER_DAY,
  GAMBLE_MAX_PER_DAY,
  evaluateCandidate,
  previewStake,
  rMultiple,
  rankCandidates,
  type GambleCandidate,
} from "../lib/gamble";

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
  /** Opened by the GAMBLE button (one A+ bet, capped stake). */
  gamble?: boolean;
  /** Stop distance at entry — R-multiples must survive a breakeven move. */
  initialSl?: number;
  /** Stop already moved to entry at +1R. */
  protected?: boolean;
}

type GamblePhase =
  | "idle" | "hunting" | "found" | "in_trade"
  | "won" | "lost" | "closed" | "expired" | "refused" | "cancelled";

interface GambleState {
  phase: GamblePhase;
  scans: number;
  maxScans: number;
  ticket: number | null;
  candidate: GambleCandidate | null;
  ranking: GambleCandidate[];
  bestEdge: number;
  reason: string;
  stakePct: number;
  riskUsd: number;
  targetUsd: number;
  foundTick: number;
  lastPnl: number | null;
  // ── durable daily ledger (mirrors gamble.py GambleLedger) ──
  date: string;
  taken: number;
  wins: number;
  losses: number;
  netPnl: number;
  cooldownUntilTick: number;
}

const todayKey = () => new Date().toISOString().slice(0, 10);

function freshGamble(): GambleState {
  return {
    phase: "idle", scans: 0, maxScans: 90, ticket: null, candidate: null,
    ranking: [], bestEdge: 0, reason: "", stakePct: 0.02, riskUsd: 0,
    targetUsd: 0, foundTick: 0, lastPnl: null,
    date: todayKey(), taken: 0, wins: 0, losses: 0, netPnl: 0, cooldownUntilTick: 0,
  };
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
  gamble: GambleState;
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
    gamble: freshGamble(),
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
  // ── gamble button settings ──
  const [gambleRiskPct, setGambleRiskPct] = useState(0.02);
  const [gambleMinConf, setGambleMinConf] = useState(DEFAULT_GAMBLE_GATE.minConfidence);
  const [gambleMinEdge, setGambleMinEdge] = useState(DEFAULT_GAMBLE_GATE.minEdgeScore);
  const [gambleMaxScans, setGambleMaxScans] = useState(90);
  const [gambleAutoTake, setGambleAutoTake] = useState(true);
  const [gambleProtect, setGambleProtect] = useState(true);
  const [tab, setTab] = useState<"open" | "closed">("open");
  const [, force] = useState(0);

  const eng = useRef<Engine | null>(null);
  if (!eng.current) eng.current = makeEngine(10000);
  const e = eng.current;

  const cfgRef = useRef({
    riskPct, minConf, atrMult, tpMult, maxOpen, dailyLimit, ddLimit, sessionFilter, active,
    gambleRiskPct, gambleMinConf, gambleMinEdge, gambleMaxScans, gambleAutoTake, gambleProtect,
  });
  useEffect(() => {
    cfgRef.current = {
      riskPct, minConf, atrMult, tpMult, maxOpen, dailyLimit, ddLimit, sessionFilter, active,
      gambleRiskPct, gambleMinConf, gambleMinEdge, gambleMaxScans, gambleAutoTake, gambleProtect,
    };
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
      // gamble ledger: today's budget/lockout survives a refresh, like the halt
      const gl = s.gamble ?? {};
      if (gl.date === todayKey()) {
        eng2.gamble.date = String(gl.date);
        eng2.gamble.taken = Number(gl.taken ?? 0);
        eng2.gamble.wins = Number(gl.wins ?? 0);
        eng2.gamble.losses = Number(gl.losses ?? 0);
        eng2.gamble.netPnl = Number(gl.netPnl ?? 0);
        eng2.gamble.cooldownUntilTick = Number(gl.cooldownUntilTick ?? 0);
        eng2.gamble.lastPnl = gl.lastPnl == null ? null : Number(gl.lastPnl);
      }
      const openGamble = eng2.open.find((p) => p.gamble);
      if (openGamble) {
        eng2.gamble.phase = "in_trade";
        eng2.gamble.ticket = openGamble.ticket;
      }
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
          gamble: {
            date: e.gamble.date, taken: e.gamble.taken, wins: e.gamble.wins,
            losses: e.gamble.losses, netPnl: e.gamble.netPnl,
            cooldownUntilTick: e.gamble.cooldownUntilTick, lastPnl: e.gamble.lastPnl,
          },
        }),
      );
    } catch {
      /* ignore quota errors */
    }
  }, [e]);

  /* ── gamble helpers ────────────────────────────────────────────── */

  /** Reset the daily gamble ledger at 00:00 UTC (lockouts are per-day). */
  const rollGambleDay = (eng2: Engine) => {
    const g = eng2.gamble;
    if (g.date !== todayKey()) {
      g.date = todayKey();
      g.taken = 0; g.wins = 0; g.losses = 0; g.netPnl = 0; g.cooldownUntilTick = 0;
    }
  };

  /** Why the button is locked right now — "" when a press may proceed. */
  const gambleLock = (eng2: Engine): string => {
    rollGambleDay(eng2);
    const g = eng2.gamble;
    if (g.phase === "hunting" || g.phase === "found") return "a hunt is already running";
    if (g.phase === "in_trade") return `gamble ticket ${g.ticket} is still open — one at a time`;
    if (eng2.halted) return `BOT HALTED (${eng2.haltReason})`;
    if (g.taken >= GAMBLE_MAX_PER_DAY) return `daily gamble budget spent (${g.taken}/${GAMBLE_MAX_PER_DAY}) — locked until 00:00 UTC`;
    if (g.losses >= GAMBLE_MAX_LOSSES_PER_DAY) return `${g.losses} losing gambles today — locked until 00:00 UTC (no revenge trades)`;
    if (eng2.tick < g.cooldownUntilTick) return `cooldown after a losing gamble — ${g.cooldownUntilTick - eng2.tick} tick(s) remaining`;
    return "";
  };

  /** Book a finished gamble into the ledger and settle the phase. */
  const settleGamble = (eng2: Engine, pos: Pos, pnl: number) => {
    const g = eng2.gamble;
    if (!pos.gamble) return;
    g.netPnl = Math.round((g.netPnl + pnl) * 100) / 100;
    g.lastPnl = pnl;
    g.ticket = null;
    // A breakeven-protected exit that scratches around zero is not a
    // "loss" for lockout purposes — protection did its job.
    const scratch = Boolean(pos.protected) && g.riskUsd > 0 && pnl >= -0.2 * g.riskUsd;
    if (pnl > 0) {
      g.wins++;
      g.phase = "won";
      g.reason = `gamble WON ${usd(pnl)} on ${pos.pair} — target was +${g.targetUsd.toFixed(2)}`;
    } else if (scratch) {
      g.phase = "closed";
      g.reason = `gamble protected at breakeven — scratched ${usd(pnl)} on ${pos.pair}, capital intact`;
    } else {
      g.losses++;
      g.phase = "lost";
      g.cooldownUntilTick = eng2.tick + GAMBLE_COOLDOWN_TICKS;
      g.reason = `gamble lost ${usd(pnl)} on ${pos.pair} — stake was capped, cooldown ${GAMBLE_COOLDOWN_TICKS} ticks, no revenge trade`;
    }
    log(eng2, pnl > 0 ? "long" : scratch ? "warn" : "short", "gamble",
      `🎲 ${g.reason} | today ${g.taken} gambles, ${g.wins}W/${g.losses}L, net ${usd(g.netPnl)}`);
  };

  /** Open THE one gamble trade for an A+ candidate. Returns success. */
  const executeGamble = (eng2: Engine, cand: GambleCandidate): boolean => {
    const c = cfgRef.current;
    const g = eng2.gamble;
    if (eng2.open.some((x) => x.pair === cand.pair)) {
      g.reason = `already holding a position on ${cand.pair} — gamble skipped`;
      return false;
    }
    if (eng2.open.length >= c.maxOpen) {
      g.reason = `no free slot (${eng2.open.length}/${c.maxOpen} open) — gamble skipped`;
      return false;
    }
    const stake = previewStake({
      balance: eng2.balance,
      stakeFraction: g.stakePct,
      dailyPnl: eng2.dailyPnl,
      dayStartBalance: eng2.dayStart,
      dailyLimitFraction: c.dailyLimit,
      candidate: cand,
    });
    if (stake.lots <= 0) {
      g.reason = stake.cappedByDailyBudget
        ? `daily loss budget nearly spent (${usd(stake.dailyBudgetLeftUsd)} left) — stake rounds to zero, no bet`
        : "stake rounds to zero lots — stop too wide for the stake, no bet";
      log(eng2, "warn", "gamble", `🎲 REFUSED — ${g.reason}`);
      return false;
    }
    // Fill 1 pip through the quoted price, shifting SL/TP by the same
    // amount so the cash risk is exactly what the ticket promised.
    const pip = pipSizeOf(cand.pair);
    const fill = cand.dir === "BUY" ? cand.price + pip : cand.price - pip;
    const shift = fill - cand.price;
    const pos: Pos = {
      ticket: eng2.ticket++,
      pair: cand.pair,
      dir: cand.dir,
      lots: stake.lots,
      entry: Number(fill.toFixed(5)),
      sl: Number((cand.sl + shift).toFixed(5)),
      tp: Number((cand.tp + shift).toFixed(5)),
      openedAt: now(),
      openedTick: eng2.tick,
      gamble: true,
      initialSl: Number((cand.sl + shift).toFixed(5)),
      protected: false,
    };
    eng2.open.push(pos);
    const p = eng2.pairs.find((x) => x.pair === cand.pair);
    if (p) p.skip = Math.max(p.skip, 10);
    g.taken++;
    g.phase = "in_trade";
    g.ticket = pos.ticket;
    g.candidate = cand;
    g.riskUsd = stake.riskUsd;
    g.targetUsd = stake.targetUsd;
    g.reason = `A+ ${cand.pair} ${cand.signal} taken — risk ${usd(stake.riskUsd)} to make +${usd(stake.targetUsd)} (RR ${cand.riskReward.toFixed(2)}, only needs a ${(cand.breakevenWinRate * 100).toFixed(0)}% win rate to break even)`;
    log(eng2, cand.dir === "BUY" ? "long" : "short", "gamble",
      `🎲 GAMBLE TAKEN ${pos.dir} ${pos.pair} ${pos.lots.toFixed(2)} lots @ ${pos.entry.toFixed(5)} | SL ${pos.sl.toFixed(5)} TP ${pos.tp.toFixed(5)} | edge ${cand.edgeScore.toFixed(1)} conf ${cand.confidence.toFixed(2)} | risk ${usd(stake.riskUsd)} (${(g.stakePct * 100).toFixed(2)}% stake${stake.cappedByDailyBudget ? ", clamped by daily budget" : ""}) → target +${usd(stake.targetUsd)} | ticket ${pos.ticket} | ${cand.reasons.slice(0, 2).join("; ")}`);
    return true;
  };

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
      // 2a ── gamble protection: at +1R move the stop to entry, so a
      // winning gamble can no longer become a losing one.
      if (pos.gamble && c.gambleProtect && !pos.protected) {
        const rNow = rMultiple(pos.entry, pos.initialSl ?? pos.sl, p.price, pos.dir);
        if (rNow >= 1) {
          pos.sl = pos.entry;
          pos.protected = true;
          log(eng2, "warn", "gamble", `🎲 +${rNow.toFixed(2)}R on ticket ${pos.ticket} — stop moved to breakeven ${pos.entry.toFixed(5)}. Worst case now ≈ scratch.`);
        }
      }
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
        settleGamble(eng2, pos, pnl);
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

    // 3b ── GAMBLE hunt: rank everything, take at most ONE A+ bet.
    // Runs before the normal scan and pauses new normal entries while
    // active — the gamble gets first (and only) claim on the setup.
    const g = eng2.gamble;
    rollGambleDay(eng2);
    if (g.phase === "found" && eng2.tick - g.foundTick > 20) {
      g.phase = "hunting";
      g.reason = "the A+ setup you were shown went stale (20 ticks) — hunting again";
      log(eng2, "warn", "gamble", "🎲 A+ setup expired unconfirmed — resuming the hunt.");
    }
    if (g.phase === "hunting") {
      if (eng2.halted) {
        g.phase = "refused";
        g.reason = `BOT HALTED (${eng2.haltReason}) — hunt aborted, no bet`;
        log(eng2, "error", "gamble", `🎲 HUNT ABORTED — ${g.reason}`);
      } else if (!inHours) {
        g.phase = "refused";
        g.reason = `outside trading hours (${String(utcHour).padStart(2, "0")}:00 UTC) — no bet`;
        log(eng2, "warn", "gamble", `🎲 HUNT ABORTED — ${g.reason}`);
      } else {
        g.scans++;
        const gate = {
          minConfidence: c.gambleMinConf,
          minRiskReward: Math.max(1.8, 1.5),
          minAdx: DEFAULT_GAMBLE_GATE.minAdx,
          minEdgeScore: c.gambleMinEdge,
        };
        const rows: Array<{ pair: string; row: ScoreRow }> = [];
        for (const p of eng2.pairs) {
          if (!c.active.includes(p.pair)) continue;
          const d = prepare(p.candles, params);
          const row = scoreAt(d, p.candles.length - 1, params);
          p.row = row;
          rows.push({ pair: p.pair, row });
        }
        const ranking = rankCandidates(rows, gate);
        g.ranking = ranking;
        g.bestEdge = Math.max(g.bestEdge, ranking[0]?.edgeScore ?? 0);
        const takeable = ranking.find((cand) => cand.isAPlus && !eng2.open.some((x) => x.pair === cand.pair));
        if (takeable) {
          if (!c.gambleAutoTake) {
            g.phase = "found";
            g.candidate = takeable;
            g.foundTick = eng2.tick;
            g.reason = `A+ FOUND: ${takeable.pair} ${takeable.signal} (edge ${takeable.edgeScore.toFixed(1)}) — confirm within 20 ticks to take it`;
            log(eng2, "warn", "gamble", `🎲 ${g.reason}`);
          } else if (!executeGamble(eng2, takeable)) {
            g.phase = "refused";
            log(eng2, "warn", "gamble", `🎲 REFUSED at execution — ${g.reason}`);
          }
        } else if (g.scans >= g.maxScans) {
          g.phase = "expired";
          const top = ranking[0];
          g.reason = top
            ? `hunted ${g.maxScans} scans, no A+ setup — best was ${top.pair} edge ${top.edgeScore.toFixed(1)} (${top.failed.join("; ")}). No bet placed. That refusal IS the edge.`
            : `hunted ${g.maxScans} scans with nothing to rank — no bet placed`;
          log(eng2, "warn", "gamble", `🎲 HUNT EXPIRED — ${g.reason}`);
        } else if (g.scans % 10 === 1) {
          const top = ranking[0];
          if (top) {
            log(eng2, "info", "gamble",
              `🎲 hunting ${g.scans}/${g.maxScans} — best so far ${top.pair} ${top.signal} edge ${top.edgeScore.toFixed(1)} (best-ever ${g.bestEdge.toFixed(1)}), needs ≥ ${gate.minEdgeScore} + conf ≥ ${gate.minConfidence.toFixed(2)}`);
          }
        }
      }
    }
    const gambleActive = g.phase === "hunting" || g.phase === "found" || g.phase === "in_trade";

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
    } else if (gambleActive) {
      if (eng2.tick % 10 === 1) {
        log(eng2, "info", "gamble", "🎲 gamble focus — new normal entries paused until the gamble settles (open positions still managed)");
      }
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
    settleGamble(e, pos, pnl);
    persist();
    force((v) => v + 1);
  };
  /* ── THE GAMBLE BUTTON ─────────────────────────────────────────── */
  const startGamble = useCallback((): string => {
    const eng2 = eng.current!;
    const c = cfgRef.current;
    const g = eng2.gamble;
    if (!c.active.length) {
      log(eng2, "error", "gamble", "🎲 No pairs selected — nothing to hunt.");
      force((v) => v + 1);
      return "no pairs selected";
    }
    const locked = gambleLock(eng2);
    if (locked) {
      g.phase = g.phase === "in_trade" ? g.phase : "refused";
      g.reason = locked;
      log(eng2, "warn", "gamble", `🎲 GAMBLE LOCKED — ${locked}`);
      force((v) => v + 1);
      return locked;
    }
    if (eng2.open.length >= c.maxOpen) {
      g.phase = "refused";
      g.reason = `all ${c.maxOpen} position slots are full — close something first`;
      log(eng2, "warn", "gamble", `🎲 REFUSED — ${g.reason}`);
      force((v) => v + 1);
      return g.reason;
    }
    g.phase = "hunting";
    g.scans = 0;
    g.maxScans = c.gambleMaxScans;
    g.stakePct = c.gambleRiskPct;
    g.bestEdge = 0;
    g.candidate = null;
    g.ticket = null;
    g.riskUsd = 0;
    g.targetUsd = 0;
    g.reason = `hunting one A+ setup across ${c.active.length} pair(s) — stake ${(c.gambleRiskPct * 100).toFixed(2)}% ≈ ${usd(eng2.balance * c.gambleRiskPct)} max loss, up to ${c.gambleMaxScans} scans`;
    log(eng2, "warn", "gamble",
      `🎲 GAMBLE PRESSED — hunting ONE A+ setup (edge ≥ ${c.gambleMinEdge}, conf ≥ ${c.gambleMinConf.toFixed(2)}, RR ≥ 1.80, ADX ≥ 20). Stake ${(c.gambleRiskPct * 100).toFixed(2)}% ≈ ${usd(eng2.balance * c.gambleRiskPct)} max loss. ${c.gambleAutoTake ? "Will auto-take the first A+." : "Will ask you to confirm."} No A+ in ${c.gambleMaxScans} scans = no bet.`);
    if (!running) {
      log(eng2, "info", "gamble", "🎲 loop was idle — starting it so the hunt can scan live ticks.");
      setRunning(true);
    }
    persist();
    force((v) => v + 1);
    return "hunting";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, persist]);

  const stopGamble = useCallback((): string => {
    const eng2 = eng.current!;
    const g = eng2.gamble;
    if (g.phase === "hunting" || g.phase === "found") {
      g.phase = "cancelled";
      g.reason = `hunt cancelled after ${g.scans} scan(s) — no bet was placed`;
      log(eng2, "warn", "gamble", `🎲 ${g.reason}`);
      persist();
      force((v) => v + 1);
      return "hunt cancelled — no bet was placed";
    }
    if (g.phase === "in_trade") {
      return "the gamble is already in a trade — it keeps its SL/TP. Use close on the ticket to exit now.";
    }
    return "no gamble hunt is running";
  }, [persist]);

  const confirmGamble = useCallback((): string => {
    const eng2 = eng.current!;
    const c = cfgRef.current;
    const g = eng2.gamble;
    if (g.phase !== "found" || !g.candidate) return "nothing is waiting for confirmation";
    // Re-score the pair right now: only take it if it is *still* A+.
    const p = eng2.pairs.find((x) => x.pair === g.candidate!.pair)!;
    const params = { ...DEFAULT_PARAMS, atrMult: c.atrMult, tpMult: c.tpMult, minConfidence: c.minConf };
    const row = scoreAt(prepare(p.candles, params), p.candles.length - 1, params);
    p.row = row;
    const fresh = evaluateCandidate(p.pair, row, {
      minConfidence: c.gambleMinConf, minRiskReward: 1.8,
      minAdx: DEFAULT_GAMBLE_GATE.minAdx, minEdgeScore: c.gambleMinEdge,
    });
    if (!fresh.isAPlus) {
      g.phase = "hunting";
      g.reason = `setup faded before you confirmed (${fresh.failed.join("; ")}) — hunting again`;
      log(eng2, "warn", "gamble", `🎲 ${g.reason}`);
      force((v) => v + 1);
      return g.reason;
    }
    const ok = executeGamble(eng2, fresh);
    if (!ok) g.phase = "refused";
    persist();
    force((v) => v + 1);
    return ok ? `gamble taken on ${fresh.pair}` : g.reason;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persist]);

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
        case "/gamble": {
          const g2 = eng2.gamble;
          const sub = (parts[1] || "").toLowerCase();
          if (sub === "stop") return `🎲 ${stopGamble()}`;
          if (sub === "status" || sub === "") {
            const locked = gambleLock(eng2);
            return [
              `🎲 gamble: ${g2.phase}${g2.phase === "hunting" ? ` (scan ${g2.scans}/${g2.maxScans}, best edge ${g2.bestEdge.toFixed(1)})` : ""}`,
              g2.phase === "in_trade"
                ? `🎯 ticket ${g2.ticket} ${g2.candidate?.pair ?? ""} risk ${usd(g2.riskUsd)} → target +${usd(g2.targetUsd)}`
                : g2.reason || "idle — /gamble go to hunt one A+ setup",
              `📅 today ${g2.taken}/${GAMBLE_MAX_PER_DAY} gambles · ${g2.wins}W/${g2.losses}L · net ${usd(g2.netPnl)}`,
              locked ? `🔒 locked: ${locked}` : "🔓 button available",
            ].join("\n");
          }
          if (sub === "go" || sub === "start") {
            const res = startGamble();
            return res === "hunting"
              ? `🎲 HUNTING — one A+ setup, stake ${(gambleRiskPct * 100).toFixed(2)}% (≈${usd(eng2.balance * gambleRiskPct)} max loss). No A+ = no bet.`
              : `🎲 refused: ${res}`;
          }
          return "🎲 usage: /gamble · /gamble go · /gamble stop";
        }
        default:
          return "Unknown command. /start /stop /status /positions /close <ticket|all> /halt /resume /risk /tick /gamble /help";
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
      gamble: {
        phase: e.gamble.phase, taken: e.gamble.taken, wins: e.gamble.wins,
        losses: e.gamble.losses, netPnl: e.gamble.netPnl, ticket: e.gamble.ticket,
      },
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

  /* ── gamble view-model ─────────────────────────────────────────── */
  const g = e.gamble;
  const gambleGate = {
    minConfidence: gambleMinConf,
    minRiskReward: 1.8,
    minAdx: DEFAULT_GAMBLE_GATE.minAdx,
    minEdgeScore: gambleMinEdge,
  };
  const liveRanking: GambleCandidate[] =
    g.ranking.length > 0
      ? g.ranking
      : rankCandidates(
          scanRows.filter((p) => p.row).map((p) => ({ pair: p.pair, row: p.row! })),
          gambleGate,
        );
  const bestCand = liveRanking[0] ?? null;
  const displayCand = g.candidate ?? (bestCand?.isAPlus ? bestCand : null);
  const stakePreview = displayCand
    ? previewStake({
        balance: e.balance, stakeFraction: gambleRiskPct, dailyPnl: e.dailyPnl,
        dayStartBalance: e.dayStart, dailyLimitFraction: dailyLimit, candidate: displayCand,
      })
    : null;
  const gamblePos = e.open.find((p) => p.gamble) ?? null;
  const gamblePairState = gamblePos ? e.pairs.find((p) => p.pair === gamblePos.pair) : null;
  const gambleR =
    gamblePos && gamblePairState
      ? rMultiple(gamblePos.entry, gamblePos.initialSl ?? gamblePos.sl, gamblePairState.price, gamblePos.dir)
      : 0;
  const gambleProgress =
    gamblePos && gamblePairState
      ? Math.max(0, Math.min(1,
          gamblePos.dir === "BUY"
            ? (gamblePairState.price - (gamblePos.initialSl ?? gamblePos.sl)) / (gamblePos.tp - (gamblePos.initialSl ?? gamblePos.sl) || 1)
            : ((gamblePos.initialSl ?? gamblePos.sl) - gamblePairState.price) / ((gamblePos.initialSl ?? gamblePos.sl) - gamblePos.tp || 1),
        ))
      : 0;
  const gambleLockReason = gambleLock(e);
  const phaseChip: { label: string; tone: "line" | "jade" | "amber" | "rose" | "sky" } = {
    idle: { label: "ready", tone: "line" as const },
    hunting: { label: `hunting ${g.scans}/${g.maxScans}`, tone: "amber" as const },
    found: { label: "A+ found — confirm", tone: "jade" as const },
    in_trade: { label: "gamble live", tone: "jade" as const },
    won: { label: "won", tone: "jade" as const },
    lost: { label: "lost — cooldown", tone: "rose" as const },
    closed: { label: "protected scratch", tone: "sky" as const },
    expired: { label: "expired — no bet", tone: "amber" as const },
    refused: { label: "refused", tone: "rose" as const },
    cancelled: { label: "cancelled", tone: "line" as const },
  }[g.phase];

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

      {/* ── 🎲 GAMBLE MODE ─────────────────────────────────────────── */}
      <Reveal>
        <div className="panel relative mb-4 overflow-hidden rounded-xl !border-amber/35">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-amber/70 to-transparent" />
          <div className="flex flex-wrap items-center gap-2.5 border-b border-line px-4 py-3">
            <Dices size={16} className="text-amber" />
            <span className="font-mono text-[11px] font-bold tracking-[0.22em] text-amber uppercase">gamble mode</span>
            <span className="font-mono text-[10.5px] text-muted">one A+ bet · capped stake · no A+ = no bet</span>
            <span className="ml-auto flex flex-wrap items-center gap-1.5">
              <Chip tone={phaseChip.tone}>{phaseChip.label}</Chip>
              <Chip tone="line">today {g.taken}/{GAMBLE_MAX_PER_DAY}</Chip>
              <Chip tone={g.netPnl >= 0 ? "jade" : "rose"}>net {usd(g.netPnl)}</Chip>
            </span>
          </div>

          <div className="grid gap-0 lg:grid-cols-[300px_minmax(0,1fr)_300px]">
            {/* stake + THE button */}
            <div className="space-y-4 border-b border-line p-4 lg:border-r lg:border-b-0">
              {g.phase === "found" ? (
                <button
                  onClick={() => confirmGamble()}
                  className="w-full rounded-xl border border-jade bg-jade px-5 py-4 font-mono text-[15px] font-black tracking-[0.18em] text-ink uppercase transition-all hover:shadow-[0_0_38px_-8px_rgba(47,211,154,0.85)]"
                >
                  ★ take the A+ bet
                </button>
              ) : g.phase === "hunting" ? (
                <button
                  onClick={() => stopGamble()}
                  className="relative w-full overflow-hidden rounded-xl border border-amber/60 bg-amber/15 px-5 py-4 font-mono text-[15px] font-black tracking-[0.18em] text-amber uppercase transition-all hover:bg-amber/25"
                >
                  <span className="absolute inset-0 -z-0 animate-pulse-soft bg-amber/10" />
                  <span className="relative">◉ hunting… {g.scans}/{g.maxScans} — stop</span>
                </button>
              ) : (
                <button
                  onClick={() => startGamble()}
                  disabled={g.phase === "in_trade"}
                  title={gambleLockReason || "Hunt one A+ setup and take it at your stake"}
                  className={cx(
                    "group w-full rounded-xl border px-5 py-4 font-mono text-[17px] font-black tracking-[0.22em] uppercase transition-all",
                    g.phase === "in_trade"
                      ? "cursor-not-allowed border-jade/40 bg-jade/10 text-jade"
                      : gambleLockReason
                        ? "border-rose/45 bg-rose/10 text-rose hover:bg-rose/15"
                        : "border-amber bg-amber text-ink hover:shadow-[0_0_42px_-8px_rgba(247,178,59,0.9)]",
                  )}
                >
                  {g.phase === "in_trade" ? `🎯 live · ticket ${g.ticket}` : gambleLockReason ? "🔒 gamble" : "🎲 gamble"}
                </button>
              )}
              {g.phase === "found" && (
                <button onClick={() => stopGamble()} className="w-full rounded-md border border-line px-3 py-2 font-mono text-[11px] text-muted uppercase hover:text-sand-2">
                  pass — keep hunting rules, cancel
                </button>
              )}
              <div className="tabnum text-center font-mono text-[11px] leading-relaxed text-muted">
                max loss <span className="text-rose">{usd(e.balance * gambleRiskPct)}</span>
                {"  →  "}target <span className="text-jade">+{usd(e.balance * gambleRiskPct * (tpMult / atrMult))}</span>
                <br />at RR {(tpMult / atrMult).toFixed(2)} you break even winning just{" "}
                {(100 / (1 + tpMult / atrMult)).toFixed(0)}% of bets
              </div>
              {g.phase === "hunting" && (
                <div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-line">
                    <div className="h-full rounded-full bg-amber transition-all duration-300" style={{ width: `${Math.min(100, (g.scans / Math.max(g.maxScans, 1)) * 100)}%` }} />
                  </div>
                  <div className="mt-1.5 flex justify-between font-mono text-[9.5px] text-muted">
                    <span>scan {g.scans}/{g.maxScans}</span>
                    <span>best edge {g.bestEdge.toFixed(1)} / needs {gambleMinEdge}+</span>
                  </div>
                </div>
              )}
              <div className="space-y-3.5 border-t border-line-soft pt-3">
                <Slider label="stake (max loss)" value={gambleRiskPct} min={0.005} max={0.05} step={0.0025} onChange={setGambleRiskPct} display={`${(gambleRiskPct * 100).toFixed(2)}%`} tone="amber" />
                <Slider label="A+ min confidence" value={gambleMinConf} min={0.55} max={0.85} step={0.01} onChange={setGambleMinConf} tone="sky" />
                <Slider label="A+ min edge score" value={gambleMinEdge} min={50} max={85} step={1} onChange={setGambleMinEdge} tone="amber" />
                <Slider label="hunt budget (scans)" value={gambleMaxScans} min={10} max={240} step={10} onChange={setGambleMaxScans} tone="rose" />
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  onClick={() => setGambleAutoTake((v) => !v)}
                  title="Auto: take the first A+ instantly. Off: pause and ask you to confirm."
                  className={cx("rounded-md border px-2 py-2 font-mono text-[10px] transition-colors", gambleAutoTake ? "border-amber/45 bg-amber/10 text-amber" : "border-line text-muted hover:text-sand-2")}
                >
                  {gambleAutoTake ? "⚡ auto-take ON" : "✋ confirm first"}
                </button>
                <button
                  onClick={() => setGambleProtect((v) => !v)}
                  title="At +1R profit, move the stop to entry so the bet cannot turn into a loss."
                  className={cx("rounded-md border px-2 py-2 font-mono text-[10px] transition-colors", gambleProtect ? "border-jade/45 bg-jade/10 text-jade" : "border-line text-muted hover:text-sand-2")}
                >
                  {gambleProtect ? "🛡 breakeven @+1R" : "breakeven OFF"}
                </button>
              </div>
            </div>

            {/* live edge ranking */}
            <div className="border-b border-line lg:border-b-0">
              <div className="flex items-center gap-2 px-4 pt-3 pb-2">
                <Crosshair size={12} className="text-amber" />
                <span className="font-mono text-[10px] tracking-[0.18em] text-muted uppercase">edge ranking — what the button sees</span>
              </div>
              <div className="divide-y divide-line-soft">
                {liveRanking.length === 0 && (
                  <div className="px-4 py-8 text-center font-mono text-[11px] text-muted">press 🎲 GAMBLE (or start the loop) — pairs get ranked here every tick</div>
                )}
                {liveRanking.map((cand) => (
                  <div key={cand.pair} className={cx("px-4 py-2.5", cand.isAPlus && "bg-jade/[0.06]")} title={cand.failed.length ? `refused: ${cand.failed.join("; ")}` : cand.passed.join("; ")}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="w-16 font-mono text-[12px] text-sand">{cand.pair}</span>
                      <SignalBadge signal={cand.signal} size="sm" />
                      <span className={cx("rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold", cand.grade === "A+" ? "border-jade/50 bg-jade/15 text-jade" : cand.grade === "A" ? "border-sky/40 text-sky" : cand.grade === "B" ? "border-line text-sand-2" : "border-line text-muted")}>
                        {cand.grade}
                      </span>
                      <span className="tabnum ml-auto font-mono text-[10.5px] text-muted">
                        conf {cand.confidence.toFixed(2)} · ADX {cand.adx.toFixed(0)} · RR {cand.riskReward.toFixed(2)} · BE {(cand.breakevenWinRate * 100).toFixed(0)}%
                      </span>
                      <span className={cx("tabnum w-14 text-right font-mono text-[12px] font-bold", cand.isAPlus ? "text-jade" : "text-sand-2")}>{cand.edgeScore.toFixed(1)}</span>
                    </div>
                    <div className="mt-1.5 flex h-1.5 gap-0.5 overflow-hidden rounded-full">
                      <div className="bg-sky/70" style={{ width: `${cand.breakdown.confidence}%` }} title={`confidence ${cand.breakdown.confidence}`} />
                      <div className="bg-lilac/70" style={{ width: `${cand.breakdown.score}%` }} title={`signal strength ${cand.breakdown.score}`} />
                      <div className="bg-amber/70" style={{ width: `${cand.breakdown.adx}%` }} title={`trend ADX ${cand.breakdown.adx}`} />
                      <div className="bg-jade/70" style={{ width: `${cand.breakdown.riskReward}%` }} title={`risk:reward ${cand.breakdown.riskReward}`} />
                      <div className="flex-1 bg-line/60" />
                    </div>
                    {cand.failed.length > 0 ? (
                      <div className="mt-1 truncate font-mono text-[9.5px] text-rose/75">✗ {cand.failed.join(" · ")}</div>
                    ) : (
                      <div className="mt-1 font-mono text-[9.5px] text-jade">★ A+ — this is bettable at your stake</div>
                    )}
                  </div>
                ))}
              </div>
              <div className="px-4 py-2 font-mono text-[9.5px] text-muted">edge = confidence ⟨sky⟩ + signal ⟨lilac⟩ + trend ⟨amber⟩ + risk:reward ⟨jade⟩ · max 100 · A+ needs every gate green</div>
            </div>

            {/* ticket / live trade / ledger */}
            <div className="space-y-3 p-4 lg:border-l lg:border-line">
              {gamblePos ? (
                <>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] tracking-[0.18em] text-muted uppercase">🎯 gamble live</span>
                    {gamblePos.protected && <span className="inline-flex items-center gap-1 rounded border border-jade/45 bg-jade/10 px-1.5 py-0.5 font-mono text-[9.5px] text-jade"><ShieldCheck size={10} /> breakeven</span>}
                    <span className="ml-auto font-mono text-[10px] text-muted">#{gamblePos.ticket}</span>
                  </div>
                  <div className="font-mono text-[13px] text-sand">
                    <span className={gamblePos.dir === "BUY" ? "text-jade" : "text-rose"}>{gamblePos.dir === "BUY" ? "▲" : "▼"} {gamblePos.dir}</span>{" "}
                    {gamblePos.pair} · {gamblePos.lots.toFixed(2)} lots
                  </div>
                  <div className="tabnum grid grid-cols-3 gap-1.5 font-mono text-[10.5px]">
                    <div className="rounded bg-ink-2/70 px-2 py-1.5"><span className="text-muted">entry</span><br />{gamblePos.entry.toFixed(5)}</div>
                    <div className="rounded bg-ink-2/70 px-2 py-1.5"><span className="text-rose/80">stop</span><br />{gamblePos.sl.toFixed(5)}</div>
                    <div className="rounded bg-ink-2/70 px-2 py-1.5"><span className="text-jade/80">target</span><br />{gamblePos.tp.toFixed(5)}</div>
                  </div>
                  <div>
                    <div className="relative h-2 rounded-full bg-gradient-to-r from-rose/50 via-panel-2 to-jade/50">
                      <div className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-ink bg-sand" style={{ left: `${gambleProgress * 100}%` }} />
                    </div>
                    <div className="mt-1 flex justify-between font-mono text-[9.5px] text-muted"><span>-1R stop</span><span>entry</span><span>+{(tpMult / atrMult).toFixed(1)}R target</span></div>
                  </div>
                  <div className="tabnum flex items-baseline justify-between font-mono">
                    <span className={cx("text-[15px] font-bold", gambleR >= 0 ? "text-jade" : "text-rose")}>{gambleR >= 0 ? "+" : ""}{gambleR.toFixed(2)}R</span>
                    <span className="text-[11px] text-muted">risk {usd(g.riskUsd)} → +{usd(g.targetUsd)}</span>
                  </div>
                  <button onClick={() => closeManually(gamblePos.ticket)} className="w-full rounded-md border border-rose/45 px-3 py-2 font-mono text-[11px] text-rose uppercase transition-colors hover:bg-rose/10">
                    cash out now (manual close)
                  </button>
                </>
              ) : displayCand && stakePreview ? (
                <>
                  <div className="font-mono text-[10px] tracking-[0.18em] text-muted uppercase">🎫 {g.phase === "found" ? "your ticket — confirm to take it" : "next A+ ticket preview"}</div>
                  <div className="font-mono text-[13px] text-sand">
                    <span className={displayCand.dir === "BUY" ? "text-jade" : "text-rose"}>{displayCand.dir === "BUY" ? "▲" : "▼"} {displayCand.dir}</span>{" "}
                    {displayCand.pair} · {stakePreview.lots.toFixed(2)} lots · edge {displayCand.edgeScore.toFixed(1)}
                  </div>
                  <div className="tabnum grid grid-cols-2 gap-1.5 font-mono text-[10.5px]">
                    <div className="rounded bg-ink-2/70 px-2 py-1.5"><span className="text-rose/80">you risk</span><br />{usd(stakePreview.riskUsd)} ({stakePreview.stopPips} pips)</div>
                    <div className="rounded bg-ink-2/70 px-2 py-1.5"><span className="text-jade/80">to make</span><br />+{usd(stakePreview.targetUsd)}</div>
                    <div className="rounded bg-ink-2/70 px-2 py-1.5"><span className="text-muted">entry / stop</span><br />{displayCand.price.toFixed(5)} / {displayCand.sl.toFixed(5)}</div>
                    <div className="rounded bg-ink-2/70 px-2 py-1.5"><span className="text-muted">target · BE win rate</span><br />{displayCand.tp.toFixed(5)} · {(displayCand.breakevenWinRate * 100).toFixed(0)}%</div>
                  </div>
                  {stakePreview.cappedByDailyBudget && (
                    <div className="rounded border border-amber/40 bg-amber/10 px-2 py-1.5 font-mono text-[10px] text-amber">stake clamped by today's remaining loss budget ({usd(stakePreview.dailyBudgetLeftUsd)} left)</div>
                  )}
                  <div className="font-mono text-[10px] leading-relaxed text-muted">{displayCand.reasons.slice(0, 3).join(" · ")}</div>
                </>
              ) : (
                <>
                  <div className="font-mono text-[10px] tracking-[0.18em] text-muted uppercase">🎫 no ticket yet</div>
                  <p className="font-mono text-[11px] leading-relaxed text-sand-2/80">
                    {g.reason || "Press GAMBLE and it scans every pair each tick. The first setup that clears every A+ gate gets taken — exactly one trade, stop and target attached."}
                  </p>
                  {bestCand && !bestCand.isAPlus && (
                    <p className="font-mono text-[10.5px] leading-relaxed text-rose/80">closest right now: {bestCand.pair} edge {bestCand.edgeScore.toFixed(1)} — {bestCand.failed[0]}</p>
                  )}
                </>
              )}
              <div className="space-y-1.5 border-t border-line-soft pt-3">
                <div className="flex justify-between font-mono text-[10px] text-muted">
                  <span>today's gamble budget</span>
                  <span>{g.taken}/{GAMBLE_MAX_PER_DAY} used · {g.wins}W/{g.losses}L · net {usd(g.netPnl)}</span>
                </div>
                <div className="flex gap-1">
                  {Array.from({ length: GAMBLE_MAX_PER_DAY }).map((_, i) => (
                    <div key={i} className={cx("h-1.5 flex-1 rounded-full", i < g.taken ? "bg-amber" : "bg-line")} />
                  ))}
                </div>
                {gambleLockReason && g.phase !== "hunting" && g.phase !== "in_trade" && (
                  <div className="font-mono text-[10px] leading-relaxed text-rose/85">🔒 {gambleLockReason}</div>
                )}
                <div className="font-mono text-[9.5px] leading-relaxed text-muted">
                  guardrails: stake ≤5% · ≤ remaining daily budget · {GAMBLE_MAX_PER_DAY}/day · locks after {GAMBLE_MAX_LOSSES_PER_DAY} losses · {GAMBLE_COOLDOWN_TICKS}-tick cooldown · zero martingale
                </div>
              </div>
            </div>
          </div>

          <div className="border-t border-line px-4 py-2.5 font-mono text-[10.5px] leading-relaxed text-muted">
            <span className="text-amber">Honest print:</span> this is not a coin flip and <span className="text-rose">never a profit guarantee</span> — it only
            bets when five indicators, trend strength and 1:2 geometry line up together, at a loss you chose in advance. Most presses on a dead
            market will correctly end with <span className="text-sand-2">"no A+ — no bet"</span>. Python twin:{" "}
            <code className="text-sky">python gamble.py --mock</code> · real bot: <code className="text-sky">POST /api/gamble</code> · Telegram: <code className="text-sky">/gamble go</code>
          </div>
        </div>
      </Reveal>

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
                          <tr key={pos.ticket} className={cx("border-b border-line-soft/60 hover:bg-panel-2/50", pos.gamble && "bg-amber/[0.05]")}>
                            <td className="px-3 py-1.5 text-muted">{pos.ticket}</td>
                            <td className="px-3 py-1.5 text-sand-2">{pos.pair}{pos.gamble && <span title={pos.protected ? "gamble — stop at breakeven" : "gamble trade"}> 🎲{pos.protected ? "🛡" : ""}</span>}</td>
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
                        <tr key={`${t.ticket}-${t.closedAt}`} className={cx("border-b border-line-soft/60 hover:bg-panel-2/50", t.gamble && "bg-amber/[0.05]")}>
                          <td className="px-3 py-1.5 text-muted">{t.ticket}</td>
                          <td className="px-3 py-1.5 text-sand-2">{t.pair}{t.gamble && <span title="gamble trade"> 🎲</span>}</td>
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
