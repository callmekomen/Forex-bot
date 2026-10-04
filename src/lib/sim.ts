/**
 * sim.ts — a faithful TypeScript mirror of the Python engine.
 * Used only for the interactive console/backtest preview on this page.
 * The real thing is forex_bot/*.py (strategy.from_enriched + Backtester.run).
 */

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type Dir = "BUY" | "SELL";
export type SignalName = "STRONG_BUY" | "BUY" | "NEUTRAL" | "SELL" | "STRONG_SELL";

export const PAIRS = ["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD", "EUR/GBP"] as const;
export type Pair = (typeof PAIRS)[number];

export const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const BARS_PER_YEAR: Record<Timeframe, number> = {
  "1m": 372960,
  "5m": 74592,
  "15m": 24864,
  "1h": 6216,
  "4h": 1554,
  "1d": 252,
};

export const pipSizeOf = (pair: string) => (pair.includes("JPY") ? 0.01 : 0.0001);
export const basePriceOf = (pair: string) =>
  pair.includes("JPY") ? 151.4 : pair.includes("CAD") ? 1.352 : pair.includes("GBP") ? 1.268 : pair.includes("AUD") ? 0.654 : pair.includes("EUR/GBP") ? 0.862 : 1.085;

/* ── deterministic RNG ─────────────────────────────────────────────── */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

/* ── synthetic market ──────────────────────────────────────────────── */
export function generateCandles(opts: {
  seed: number;
  bars: number;
  pair: string;
  timeframe: Timeframe;
}): Candle[] {
  const { seed, bars, pair, timeframe } = opts;
  const rand = mulberry32(seed + hash(pair));
  const seconds = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 }[timeframe];
  const volScale = Math.sqrt(seconds / 3600);
  let price = basePriceOf(pair);
  let drift = 0;
  let regime = 0;
  const out: Candle[] = [];
  const now = Date.UTC(2024, 0, 15, 7, 0, 0);
  for (let i = 0; i < bars; i++) {
    if (regime <= 0) {
      regime = 40 + Math.floor(rand() * 130);
      drift = (rand() - 0.44) * 0.00075 * volScale;
    }
    regime--;
    const vol = (0.0016 + rand() * 0.0022) * volScale;
    const shock = drift + (rand() + rand() + rand() + rand() - 2) * vol;
    const o = price;
    const c = Math.max(1e-4, price * (1 + shock));
    const wick = Math.abs(rand() - 0.5) * vol * 1.35;
    const h = Math.max(o, c) + wick * price;
    const l = Math.min(o, c) - wick * price;
    out.push({ t: now + i * seconds * 1000, o, h, l, c, v: Math.round(900 + rand() * 1400) });
    price = c;
  }
  return out;
}

/* ── indicators (same maths as indicators.py) ──────────────────────── */
export function sma(arr: number[], p: number): number[] {
  const out = new Array(arr.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= p) sum -= arr[i - p];
    if (i >= p - 1) out[i] = sum / p;
  }
  return out;
}
export function ema(arr: number[], p: number): number[] {
  const out = new Array(arr.length).fill(NaN);
  const k = 2 / (p + 1);
  let prev = arr[0];
  for (let i = 0; i < arr.length; i++) {
    prev = i === 0 ? arr[0] : arr[i] * k + prev * (1 - k);
    out[i] = i >= p - 1 ? prev : NaN;
  }
  return out;
}
export function rsi(close: number[], p = 14): number[] {
  const out = new Array(close.length).fill(NaN);
  let ag = 0;
  let al = 0;
  const a = 1 / p;
  for (let i = 1; i < close.length; i++) {
    const d = close[i] - close[i - 1];
    const g = Math.max(d, 0);
    const l = Math.max(-d, 0);
    if (i <= p) {
      ag += g / p;
      al += l / p;
      if (i === p) out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    } else {
      ag = ag * (1 - a) + g * a;
      al = al * (1 - a) + l * a;
      out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
  }
  return out;
}
export function atr(c: Candle[], p = 14): number[] {
  const out = new Array(c.length).fill(NaN);
  const a = 1 / p;
  let prev = NaN;
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
    prev = Number.isNaN(prev) ? tr : prev * (1 - a) + tr * a;
    if (i >= p - 1) out[i] = prev;
  }
  return out;
}
export function macd(close: number[], fast = 12, slow = 26, signal = 9) {
  const fastLine = ema(close, fast);
  const slowLine = ema(close, slow);
  const line = fastLine.map((v, i) => v - slowLine[i]);
  const sig = ema(line.map((v) => (Number.isNaN(v) ? 0 : v)), signal);
  const hist = line.map((v, i) => v - sig[i]);
  return { line, signal: sig, hist };
}
export function bollinger(close: number[], p = 20, mult = 2) {
  const mid = sma(close, p);
  const out = close.map((_, i) => {
    if (i < p - 1) return { upper: NaN, middle: NaN, lower: NaN };
    const slice = close.slice(i - p + 1, i + 1);
    const m = mid[i];
    const sd = Math.sqrt(slice.reduce((s, v) => s + (v - m) ** 2, 0) / p);
    return { upper: m + mult * sd, middle: m, lower: m - mult * sd };
  });
  return out;
}
export function adx(c: Candle[], p = 14): number[] {
  const out = new Array(c.length).fill(NaN);
  const a = 1 / p;
  let sPlus = 0;
  let sMinus = 0;
  let sTr = 0;
  let pdi = 0;
  let mdi = 0;
  let adxPrev = NaN;
  for (let i = 1; i < c.length; i++) {
    const up = c[i].h - c[i - 1].h;
    const dn = c[i - 1].l - c[i].l;
    const plus = up > dn && up > 0 ? up : 0;
    const minus = dn > up && dn > 0 ? dn : 0;
    const tr = Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
    if (i <= p) {
      sTr += tr;
      sPlus += plus;
      sMinus += minus;
      if (i === p) {
        pdi = sTr ? (100 * sPlus) / sTr : 0;
        mdi = sTr ? (100 * sMinus) / sTr : 0;
        adxPrev = sPlus + sMinus === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / (pdi + mdi);
        out[i] = adxPrev;
      }
      continue;
    }
    sTr = sTr - sTr * a + tr;
    sPlus = sPlus - sPlus * a + plus;
    sMinus = sMinus - sMinus * a + minus;
    pdi = sTr ? (100 * sPlus) / sTr : 0;
    mdi = sTr ? (100 * sMinus) / sTr : 0;
    const dx = pdi + mdi === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / (pdi + mdi);
    adxPrev = Number.isNaN(adxPrev) ? dx : adxPrev * (1 - a) + dx * a;
    out[i] = adxPrev;
  }
  return out;
}

/* ── strategy scoring (mirrors strategy.AdvancedStrategy) ──────────── */
export const BASE_MAX = 5.0;
export interface Vote {
  key: string;
  label: string;
  weight: string;
  value: number;
  detail: string;
}
export interface ScoreRow {
  i: number;
  votes: Vote[];
  score: number;
  maxScore: number;
  confidence: number;
  signal: SignalName;
  dir: Dir;
  price: number;
  atr: number;
  rsi: number;
  adx: number;
  sl: number;
  tp: number;
  reasons: string[];
}

export interface StrategyParams {
  fast: number;
  slow: number;
  signal: number;
  rsiPeriod: number;
  rsiOver: number;
  rsiUnder: number;
  atrMult: number;
  tpMult: number;
  minConfidence: number;
}

export const DEFAULT_PARAMS: StrategyParams = {
  fast: 12,
  slow: 26,
  signal: 9,
  rsiPeriod: 14,
  rsiOver: 70,
  rsiUnder: 30,
  atrMult: 1.5,
  tpMult: 3,
  minConfidence: 0.6,
};

export function classify(score: number): SignalName {
  if (score >= 3) return "STRONG_BUY";
  if (score >= 1.5) return "BUY";
  if (score <= -3) return "STRONG_SELL";
  if (score <= -1.5) return "SELL";
  return "NEUTRAL";
}

export interface Prepared {
  candles: Candle[];
  emaFast: number[];
  emaSlow: number[];
  rsi: number[];
  atr: number[];
  hist: number[];
  bb: { upper: number; middle: number; lower: number }[];
  adx: number[];
}

export function prepare(candles: Candle[], p: StrategyParams): Prepared {
  const close = candles.map((c) => c.c);
  return {
    candles,
    emaFast: ema(close, p.fast),
    emaSlow: ema(close, p.slow),
    rsi: rsi(close, p.rsiPeriod),
    atr: atr(candles, 14),
    hist: macd(close, p.fast, p.slow, p.signal).hist,
    bb: bollinger(close, 20, 2),
    adx: adx(candles, 14),
  };
}

export function scoreAt(d: Prepared, i: number, p: StrategyParams): ScoreRow {
  const c = d.candles;
  const price = c[i].c;
  const votes: Vote[] = [];
  const reasons: string[] = [];
  let score = 0;

  const ef = d.emaFast[i];
  const es = d.emaSlow[i];
  if (ef > es) {
    score += 1;
    votes.push({ key: "ema", label: "EMA crossover", weight: "±1.0", value: 1, detail: `EMA${p.fast} > EMA${p.slow}` });
    reasons.push(`EMA${p.fast} > EMA${p.slow} (uptrend)`);
  } else if (ef < es) {
    score -= 1;
    votes.push({ key: "ema", label: "EMA crossover", weight: "±1.0", value: -1, detail: `EMA${p.fast} < EMA${p.slow}` });
    reasons.push(`EMA${p.fast} < EMA${p.slow} (downtrend)`);
  } else {
    votes.push({ key: "ema", label: "EMA crossover", weight: "±1.0", value: 0, detail: "flat" });
  }

  const h = d.hist[i];
  const hp = d.hist[i - 1];
  if (h > 0) {
    score += 1;
    votes.push({ key: "macd", label: "MACD histogram", weight: "±1.0", value: 1, detail: `hist ${h.toExponential(2)}` });
    reasons.push("MACD histogram positive");
  } else {
    score -= 1;
    votes.push({ key: "macd", label: "MACD histogram", weight: "±1.0", value: -1, detail: `hist ${h.toExponential(2)}` });
    reasons.push("MACD histogram negative");
  }

  if (hp <= 0 && h > 0) {
    score += 1.5;
    votes.push({ key: "cross", label: "MACD crossover", weight: "±1.5", value: 1.5, detail: "flip − → +" });
    reasons.push("MACD bullish crossover");
  } else if (hp >= 0 && h < 0) {
    score -= 1.5;
    votes.push({ key: "cross", label: "MACD crossover", weight: "±1.5", value: -1.5, detail: "flip + → −" });
    reasons.push("MACD bearish crossover");
  } else {
    votes.push({ key: "cross", label: "MACD crossover", weight: "±1.5", value: 0, detail: "no flip" });
  }

  const r = d.rsi[i];
  let rsiVote = 0;
  if (r < p.rsiUnder) {
    rsiVote = 1;
    reasons.push(`RSI oversold (${r.toFixed(1)})`);
  } else if (r > p.rsiOver) {
    rsiVote = -1;
    reasons.push(`RSI overbought (${r.toFixed(1)})`);
  } else if (r > 50) {
    rsiVote = 0.5;
    reasons.push(`RSI bullish bias (${r.toFixed(1)})`);
  } else if (r < 50) {
    rsiVote = -0.5;
    reasons.push(`RSI bearish bias (${r.toFixed(1)})`);
  }
  score += rsiVote;
  votes.push({ key: "rsi", label: "RSI", weight: "±1.0", value: rsiVote, detail: `RSI ${r.toFixed(1)}` });

  const band = d.bb[i];
  let bbVote = 0;
  const width = band.upper - band.lower;
  const pos = width > 0 ? (price - band.lower) / width : 0.5;
  if (pos < 0.2) {
    bbVote = 0.5;
    reasons.push(`Price at lower Bollinger zone (${(pos * 100).toFixed(0)}%)`);
  } else if (pos > 0.8) {
    bbVote = -0.5;
    reasons.push(`Price at upper Bollinger zone (${(pos * 100).toFixed(0)}%)`);
  }
  score += bbVote;
  votes.push({ key: "bb", label: "Bollinger position", weight: "±0.5", value: bbVote, detail: `${(pos * 100).toFixed(0)}% of band` });

  const a = d.adx[i];
  let maxScore = BASE_MAX;
  if (a < 25) {
    maxScore += ((25 - a) / 25) * BASE_MAX;
    reasons.push(`Weak trend (ADX=${a.toFixed(1)}) — confidence penalised`);
  } else {
    reasons.push(`Strong trend (ADX=${a.toFixed(1)})`);
  }
  votes.push({ key: "adx", label: "ADX filter", weight: "confidence", value: 0, detail: `ADX ${a.toFixed(1)} · max ${maxScore.toFixed(2)}` });

  const signal = classify(score);
  const confidence = Math.min(1, Math.abs(score) / maxScore);
  const atrV = d.atr[i];
  const dir: Dir = signal === "BUY" || signal === "STRONG_BUY" ? "BUY" : "SELL";
  const actionable = signal !== "NEUTRAL";
  const sl = actionable ? price - atrV * p.atrMult * (dir === "BUY" ? 1 : -1) : 0;
  const tp = actionable ? price + atrV * p.tpMult * (dir === "BUY" ? 1 : -1) : 0;

  return { i, votes, score, maxScore, confidence, signal, dir, price, atr: atrV, rsi: r, adx: a, sl, tp, reasons };
}

/* ── risk sizing (mirrors risk_manager.py) ─────────────────────────── */
export function sizeLots(balance: number, riskPct: number, entry: number, sl: number, pip: number, pipValue: number) {
  const pips = Math.abs(entry - sl) / pip;
  if (pips <= 0) return { lots: 0, pips: 0, cap: balance * riskPct, riskUsd: 0, reduced: false };
  const cap = balance * riskPct;
  let lots = Math.max(0, Math.floor((cap / (pips * pipValue)) * 100) / 100);
  if (lots < 0.01) lots = cap / (pips * pipValue) >= 0.005 ? 0.01 : 0;
  let riskUsd = pips * pipValue * lots;
  let reduced = false;
  while (riskUsd > cap && lots > 0.01) {
    lots = Math.round((lots - 0.01) * 100) / 100;
    riskUsd = pips * pipValue * lots;
    reduced = true;
  }
  return { lots, pips, cap, riskUsd: Math.round(riskUsd * 100) / 100, reduced };
}

/* ── backtest loop (mirrors backtester.Backtester.run) ─────────────── */
export interface SimTrade {
  n: number;
  pair: string;
  dir: Dir;
  entryTime: string;
  exitTime: string;
  entry: number;
  exit: number;
  lots: number;
  pnl: number;
  bars: number;
  reason: "stop_loss" | "take_profit" | "end_of_data" | "signal_reversal";
  confidence: number;
  rr: number;
}

export interface SimResult {
  trades: SimTrade[];
  equity: number[];
  drawdown: number[];
  labels: string[];
  candles: Candle[];
  rows: ScoreRow[];
  metrics: {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnl: number;
    totalReturn: number;
    avgWin: number;
    avgLoss: number;
    profitFactor: number;
    maxDrawdown: number;
    sharpe: number;
    largestWin: number;
    largestLoss: number;
    avgRR: number;
    expectancy: number;
    endBalance: number;
    buyTrades: number;
    sellTrades: number;
    avgBars: number;
  };
}

const fmt = (t: number) => new Date(t).toISOString().slice(5, 16).replace("T", " ");

export function runBacktest(opts: {
  pair: Pair;
  timeframe: Timeframe;
  bars: number;
  seed: number;
  spreadPips: number;
  balance: number;
  riskPct: number;
  minConfidence: number;
  atrMult: number;
  tpMult: number;
}): SimResult {
  const p: StrategyParams = { ...DEFAULT_PARAMS, atrMult: opts.atrMult, tpMult: opts.tpMult, minConfidence: opts.minConfidence };
  const candles = generateCandles({ seed: opts.seed, bars: opts.bars, pair: opts.pair, timeframe: opts.timeframe });
  const d = prepare(candles, p);
  const pip = pipSizeOf(opts.pair);
  const pipValue = 10;
  const spreadCost = opts.spreadPips * pip * pipValue;
  const warmup = 50;

  let balance = opts.balance;
  let peak = balance;
  const trades: SimTrade[] = [];
  const equity: number[] = [];
  const drawdown: number[] = [];
  const labels: string[] = [];
  const rows: ScoreRow[] = [];
  let pos: null | { dir: Dir; entry: number; sl: number; tp: number; lots: number; bar: number; conf: number; risk: number; reward: number } = null;

  for (let i = warmup; i < candles.length; i++) {
    const row = scoreAt(d, i, p);
    rows.push(row);
    const c = candles[i];
    if (pos) {
      let exit: number | null = null;
      let reason: SimTrade["reason"] = "end_of_data";
      if (pos.dir === "BUY") {
        if (c.l <= pos.sl) {
          exit = pos.sl;
          reason = "stop_loss";
        } else if (c.h >= pos.tp) {
          exit = pos.tp;
          reason = "take_profit";
        }
      } else {
        if (c.h >= pos.sl) {
          exit = pos.sl;
          reason = "stop_loss";
        } else if (c.l <= pos.tp) {
          exit = pos.tp;
          reason = "take_profit";
        }
      }
      // signal reversal closes the trade at the bar close
      if (exit === null && row.signal !== "NEUTRAL" && (row.dir === "BUY" ? -1 : 1) !== (pos.dir === "BUY" ? 1 : -1)) {
        exit = c.c;
        reason = "signal_reversal";
      }
      if (exit !== null) {
        const pips = (pos.dir === "BUY" ? exit - pos.entry : pos.entry - exit) / pip;
        const pnl = Math.round((pips * pipValue * pos.lots - spreadCost * pos.lots) * 100) / 100;
        balance = Math.round((balance + pnl) * 100) / 100;
        peak = Math.max(peak, balance);
        trades.push({
          n: trades.length + 1,
          pair: opts.pair,
          dir: pos.dir,
          entryTime: fmt(candles[pos.bar].t),
          exitTime: fmt(c.t),
          entry: pos.entry,
          exit,
          lots: pos.lots,
          pnl,
          bars: i - pos.bar,
          reason,
          confidence: pos.conf,
          rr: pos.risk > 0 ? Math.round((pos.reward / pos.risk) * 100) / 100 : 0,
        });
        pos = null;
      }
    }

    if (!pos && row.signal !== "NEUTRAL" && row.confidence >= p.minConfidence && row.atr > 0) {
      const risk = row.atr * p.atrMult;
      const reward = row.atr * p.tpMult;
      if (reward / risk >= 1.5 && i + 1 < candles.length) {
        const entry = candles[i + 1].c;
        const offset = entry - row.price;
        const sl = row.sl + offset;
        const { lots } = sizeLots(balance, opts.riskPct, entry, sl, pip, pipValue);
        if (lots > 0) {
          pos = {
            dir: row.dir,
            entry,
            sl,
            tp: row.tp + offset,
            lots,
            bar: i + 1,
            conf: row.confidence,
            risk,
            reward,
          };
        }
      }
    }

    equity.push(Math.round(balance * 100) / 100);
    drawdown.push(peak > 0 ? Math.round(Math.max(0, ((peak - balance) / peak) * 10000) / 100) : 0);
    labels.push(fmt(c.t));
  }

  if (pos) {
    const last = candles[candles.length - 1];
    const pips = (pos.dir === "BUY" ? last.c - pos.entry : pos.entry - last.c) / pip;
    const pnl = Math.round((pips * pipValue * pos.lots - spreadCost * pos.lots) * 100) / 100;
    balance = Math.round((balance + pnl) * 100) / 100;
    trades.push({
      n: trades.length + 1,
      pair: opts.pair,
      dir: pos.dir,
      entryTime: fmt(candles[pos.bar].t),
      exitTime: fmt(last.t),
      entry: pos.entry,
      exit: last.c,
      lots: pos.lots,
      pnl,
      bars: candles.length - 1 - pos.bar,
      reason: "end_of_data",
      confidence: pos.conf,
      rr: pos.risk > 0 ? Math.round((pos.reward / pos.risk) * 100) / 100 : 0,
    });
    equity.push(balance);
    drawdown.push(Math.round(Math.max(0, ((peak - balance) / peak) * 10000) / 100));
    labels.push(fmt(last.t));
  }

  const pnls = trades.map((t) => t.pnl);
  const wins = pnls.filter((v) => v > 0);
  const losses = pnls.filter((v) => v <= 0);
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const grossWin = sum(wins);
  const grossLoss = Math.abs(sum(losses));
  const mean = wins.length + losses.length ? sum(pnls) / pnls.length : 0;
  const ret = equity.map((v, i) => (i === 0 ? 0 : (v - equity[i - 1]) / equity[i - 1])).slice(1);
  const mu = sum(ret) / (ret.length || 1);
  const sd = Math.sqrt(sum(ret.map((v) => (v - mu) ** 2)) / (ret.length || 1));
  const sharpe = sd > 0 ? (mu / sd) * Math.sqrt(BARS_PER_YEAR[opts.timeframe]) : 0;

  return {
    trades,
    equity,
    drawdown,
    labels,
    candles,
    rows,
    metrics: {
      totalTrades: pnls.length,
      wins: wins.length,
      losses: losses.length,
      winRate: pnls.length ? Math.round((10000 * wins.length) / pnls.length) / 100 : 0,
      totalPnl: Math.round(grossWin - grossLoss),
      totalReturn: Math.round(((grossWin - grossLoss) / opts.balance) * 10000) / 100,
      avgWin: wins.length ? Math.round((grossWin / wins.length) * 100) / 100 : 0,
      avgLoss: losses.length ? Math.round((-grossLoss / losses.length) * 100) / 100 : 0,
      profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 1000) / 1000 : grossWin > 0 ? Infinity : 0,
      maxDrawdown: Math.round(Math.max(0, ...drawdown) * 100) / 100,
      sharpe: Math.round(sharpe * 1000) / 1000,
      largestWin: wins.length ? Math.round(Math.max(...wins) * 100) / 100 : 0,
      largestLoss: losses.length ? Math.round(Math.min(...losses) * 100) / 100 : 0,
      avgRR: trades.length ? Math.round((sum(trades.map((t) => t.rr)) / trades.length) * 100) / 100 : 0,
      expectancy: Math.round(mean * 100) / 100,
      endBalance: balance,
      buyTrades: trades.filter((t) => t.dir === "BUY").length,
      sellTrades: trades.filter((t) => t.dir === "SELL").length,
      avgBars: trades.length ? Math.round((sum(trades.map((t) => t.bars)) / trades.length) * 10) / 10 : 0,
    },
  };
}
