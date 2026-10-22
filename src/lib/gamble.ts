/**
 * gamble.ts — the GAMBLE button's brain (TypeScript mirror of gamble.py).
 *
 * A literal casino button would flip a coin and lose to the spread.
 * This hunts instead: every pair is ranked by a transparent 0-100 edge
 * score, and only an "A+" setup — stricter than a normal trade on
 * confidence, trend strength, reward:risk and edge combined — may be
 * taken, at a stake the risk gate re-caps anyway. No A+ → no bet.
 */

import { pipSizeOf, sizeLots, type ScoreRow } from "./sim";

export interface GambleGate {
  minConfidence: number;
  minRiskReward: number;
  minAdx: number;
  minEdgeScore: number;
}

export const DEFAULT_GAMBLE_GATE: GambleGate = {
  minConfidence: 0.6,
  minRiskReward: 1.8,
  minAdx: 20,
  minEdgeScore: 60,
};

/** Absolute ceiling for a gamble stake — the slider cannot pass this. */
export const GAMBLE_HARD_MAX_RISK = 0.05;
export const GAMBLE_MAX_PER_DAY = 3;
export const GAMBLE_MAX_LOSSES_PER_DAY = 2;
/** Desk ticks of forced pause after a losing gamble (≈30 min live). */
export const GAMBLE_COOLDOWN_TICKS = 20;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Win rate needed to break even at this reward:risk, before costs. */
export const breakevenWinRate = (rr: number) => (rr > 0 ? 1 / (1 + rr) : 1);

/** Reward:risk implied by a scored row's stop/target geometry. */
export function rowRiskReward(row: ScoreRow): number {
  const risk = Math.abs(row.price - row.sl);
  const reward = Math.abs(row.tp - row.price);
  if (row.signal === "NEUTRAL" || risk <= 0) return 0;
  return Math.round((reward / risk) * 1000) / 1000;
}

export interface EdgeBreakdown {
  confidence: number;
  score: number;
  adx: number;
  riskReward: number;
}

/** The four weighted components (sum = edge score, max 100). */
export function edgeBreakdown(row: ScoreRow): EdgeBreakdown {
  const rr = rowRiskReward(row);
  return {
    confidence: Math.round(45 * clamp01(row.confidence) * 100) / 100,
    score: Math.round(20 * clamp01(Math.abs(row.score) / 5) * 100) / 100,
    adx: Math.round(20 * clamp01((row.adx - 15) / 25) * 100) / 100,
    riskReward: Math.round(15 * clamp01((rr - 1.5) / 1.0) * 100) / 100,
  };
}

/** Composite 0-100 quality score. NEUTRAL rows only earn the score part. */
export function edgeScore(row: ScoreRow): number {
  if (row.signal === "NEUTRAL") return edgeBreakdown(row).score;
  const b = edgeBreakdown(row);
  return Math.round((b.confidence + b.score + b.adx + b.riskReward) * 100) / 100;
}

export interface GambleCandidate {
  pair: string;
  signal: ScoreRow["signal"];
  dir: ScoreRow["dir"];
  price: number;
  sl: number;
  tp: number;
  confidence: number;
  score: number;
  adx: number;
  rsi: number;
  atr: number;
  riskReward: number;
  breakevenWinRate: number;
  edgeScore: number;
  breakdown: EdgeBreakdown;
  isAPlus: boolean;
  grade: "A+" | "A" | "B" | "skip";
  passed: string[];
  failed: string[];
  reasons: string[];
}

/** Grade one scored row against the A+ gate, explaining every verdict. */
export function evaluateCandidate(pair: string, row: ScoreRow, gate: GambleGate): GambleCandidate {
  const rr = rowRiskReward(row);
  const edge = edgeScore(row);
  const passed: string[] = [];
  const failed: string[] = [];
  const check = (ok: boolean, yes: string, no: string) => (ok ? passed.push(yes) : failed.push(no));

  check(row.signal !== "NEUTRAL", `directional signal (${row.signal})`, "signal is NEUTRAL — no direction to bet on");
  check(row.confidence >= gate.minConfidence, `confidence ${row.confidence.toFixed(2)} ≥ ${gate.minConfidence.toFixed(2)}`, `confidence ${row.confidence.toFixed(2)} < ${gate.minConfidence.toFixed(2)}`);
  check(rr >= gate.minRiskReward, `risk:reward ${rr.toFixed(2)} ≥ ${gate.minRiskReward.toFixed(2)}`, `risk:reward ${rr.toFixed(2)} < ${gate.minRiskReward.toFixed(2)}`);
  check(row.adx >= gate.minAdx, `trend strength ADX ${row.adx.toFixed(1)} ≥ ${gate.minAdx}`, `ADX ${row.adx.toFixed(1)} < ${gate.minAdx} — choppy, no trend to ride`);
  check(edge >= gate.minEdgeScore, `edge score ${edge.toFixed(1)} ≥ ${gate.minEdgeScore}`, `edge score ${edge.toFixed(1)} < ${gate.minEdgeScore}`);

  const isAPlus = failed.length === 0;
  return {
    pair,
    signal: row.signal,
    dir: row.dir,
    price: row.price,
    sl: row.sl,
    tp: row.tp,
    confidence: row.confidence,
    score: row.score,
    adx: row.adx,
    rsi: row.rsi,
    atr: row.atr,
    riskReward: rr,
    breakevenWinRate: Math.round(breakevenWinRate(rr) * 10000) / 10000,
    edgeScore: edge,
    breakdown: edgeBreakdown(row),
    isAPlus,
    grade: isAPlus ? "A+" : edge >= 55 ? "A" : edge >= 40 ? "B" : "skip",
    passed,
    failed,
    reasons: row.reasons,
  };
}

/** Evaluate every pair and sort best-edge first. */
export function rankCandidates(rows: Array<{ pair: string; row: ScoreRow }>, gate: GambleGate): GambleCandidate[] {
  return rows
    .map(({ pair, row }) => evaluateCandidate(pair, row, gate))
    .sort((a, b) => b.edgeScore - a.edgeScore || b.confidence - a.confidence || Math.abs(b.score) - Math.abs(a.score));
}

export interface StakePreview {
  /** Stake the operator asked for, after the hard 5% ceiling. */
  effectiveFraction: number;
  /** Cash risk after also clamping to today's remaining loss budget. */
  cappedRiskUsd: number;
  /** What is left of today's daily-loss allowance. */
  dailyBudgetLeftUsd: number;
  cappedByDailyBudget: boolean;
  lots: number;
  riskUsd: number;
  targetUsd: number;
  stopPips: number;
}

/**
 * Size a gamble stake the way RiskManager.validate_trade does in Python:
 * fraction → hard 5% ceiling → remaining daily-loss budget → lots.
 */
export function previewStake(opts: {
  balance: number;
  stakeFraction: number;
  dailyPnl: number;
  dayStartBalance: number;
  dailyLimitFraction: number;
  candidate: GambleCandidate;
}): StakePreview {
  const fraction = Math.min(Math.max(opts.stakeFraction, 0), GAMBLE_HARD_MAX_RISK);
  const dailyBudgetLeft = Math.max(0, opts.dayStartBalance * opts.dailyLimitFraction + Math.min(0, opts.dailyPnl));
  const wanted = opts.balance * fraction;
  const capped = Math.min(wanted, dailyBudgetLeft);
  const pip = pipSizeOf(opts.candidate.pair);
  const sizing =
    opts.balance > 0 && capped > 0
      ? sizeLots(opts.balance, capped / opts.balance, opts.candidate.price, opts.candidate.sl, pip, 10)
      : { lots: 0, riskUsd: 0, pips: 0 };
  return {
    effectiveFraction: fraction,
    cappedRiskUsd: Math.round(capped * 100) / 100,
    dailyBudgetLeftUsd: Math.round(dailyBudgetLeft * 100) / 100,
    cappedByDailyBudget: capped < wanted - 0.005,
    lots: sizing.lots,
    riskUsd: sizing.riskUsd,
    targetUsd: Math.round(sizing.riskUsd * opts.candidate.riskReward * 100) / 100,
    stopPips: Math.round(sizing.pips * 10) / 10,
  };
}

/** Open profit in units of the *initial* risk distance (+1R, +2R, …). */
export function rMultiple(entry: number, initialSl: number, price: number, dir: "BUY" | "SELL"): number {
  const risk = Math.abs(entry - initialSl);
  if (risk <= 0) return 0;
  const move = dir === "BUY" ? price - entry : entry - price;
  return Math.round((move / risk) * 1000) / 1000;
}
