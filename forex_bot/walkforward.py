"""
walkforward.py — the test that tells you whether the edge is real.
════════════════════════════════════════════════════════════════════════
A single backtest over all history answers the wrong question. If you
tune parameters until the curve looks good, the result is a description
of the past, not a prediction. Walk-forward analysis asks the right one:

    "Would parameters chosen using only data available AT THE TIME have
     made money on the data that came NEXT?"

Mechanics
---------
History is cut into consecutive blocks::

    |<-- train 12mo -->|<- test 3mo ->|
                       |<-- train 12mo -->|<- test 3mo ->|
                                          |<-- train ... -->|

For each fold the grid is optimised **in-sample**, the single best
parameter set is frozen, and it is evaluated **once** on the untouched
out-of-sample block. Stitching the OOS blocks together produces an equity
curve no in-sample fitting ever touched.

Reading the result
------------------
* **OOS profit factor < 1.0** → no edge. Stop. Do not trade it.
* **Efficiency (OOS/IS) < 0.5** → heavy curve-fitting; the parameters do
  not generalise.
* **Unstable best parameters across folds** → you are fitting noise, even
  if the aggregate looks acceptable.
* A strategy that only profits with ``CostModel.zero()`` is not a
  strategy, it is a spread-collection scheme in reverse.

Usage
-----
    python walkforward.py --pair EUR/USD --train 12 --test 3
    python walkforward.py --pair EUR/USD --quick        # smaller grid
    python walkforward.py --pair EUR/USD --mock         # plumbing check only
"""

from __future__ import annotations

import argparse
import itertools
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import numpy as np
import pandas as pd

from backtester import Backtester
from config import BotConfig
from costs import CostModel
from logger import get_logger
from strategy import AdvancedStrategy

#: Parameters the optimiser is allowed to vary, and their candidate values.
DEFAULT_GRID: Dict[str, List[Any]] = {
    "min_confidence": [0.55, 0.60, 0.70],
    "atr_multiplier": [1.0, 1.5, 2.0],
    "fast_ema": [8, 12, 21],
    "slow_ema": [26, 50],
}

QUICK_GRID: Dict[str, List[Any]] = {
    "min_confidence": [0.60, 0.70],
    "atr_multiplier": [1.5, 2.0],
}

#: Minimum trades in an in-sample window for its metrics to mean anything.
MIN_IS_TRADES = 8


@dataclass
class Fold:
    """One train/test split and its results."""

    index: int
    train_start: str
    train_end: str
    test_start: str
    test_end: str
    best_params: Dict[str, Any] = field(default_factory=dict)
    is_metrics: Dict[str, Any] = field(default_factory=dict)
    oos_metrics: Dict[str, Any] = field(default_factory=dict)
    skipped: str = ""

    #: window lengths, needed to compare returns on equal footing
    train_months: int = 12
    test_months: int = 3

    def efficiency(self) -> float:
        """OOS vs IS return, **normalised per month**.

        Comparing a 12-month in-sample return with a 3-month out-of-sample
        return understates transfer by ~4x. Both are reduced to a monthly
        rate first, so 1.0 genuinely means "held up perfectly".
        """
        is_ret = float(self.is_metrics.get("total_return", 0.0) or 0.0) / max(self.train_months, 1)
        oos_ret = float(self.oos_metrics.get("total_return", 0.0) or 0.0) / max(self.test_months, 1)
        if is_ret <= 0:
            return 0.0
        return round(oos_ret / is_ret, 3)


class WalkForward:
    """Rolling-window optimiser + out-of-sample evaluator."""

    def __init__(
        self,
        config: BotConfig,
        costs: Optional[CostModel] = None,
        grid: Optional[Dict[str, List[Any]]] = None,
        objective: str = "profit_factor",
    ) -> None:
        """Configure the analysis.

        Args:
            config: Base configuration; the grid overrides fields on copies.
            costs: Cost model applied to **both** IS and OOS runs. Defaults
                to the pessimistic per-pair model.
            grid: Parameter search space. Defaults to :data:`DEFAULT_GRID`.
            objective: Metric maximised in-sample — ``profit_factor``,
                ``sharpe_ratio``, ``total_return`` or ``expectancy``.
        """
        self.base = config
        self.costs = costs
        self.grid = grid or DEFAULT_GRID
        self.objective = objective
        self.log = get_logger("walkforward")
        self.folds: List[Fold] = []

    # ── grid ──────────────────────────────────────────────────────────

    def combinations(self) -> List[Dict[str, Any]]:
        """Expand the grid into concrete parameter dicts, dropping invalid ones."""
        keys = list(self.grid)
        combos: List[Dict[str, Any]] = []
        for values in itertools.product(*(self.grid[k] for k in keys)):
            params = dict(zip(keys, values))
            # EMA ordering is a hard constraint in strategy.macd()
            fast = params.get("fast_ema", self.base.fast_ema)
            slow = params.get("slow_ema", self.base.slow_ema)
            if fast >= slow:
                continue
            combos.append(params)
        return combos

    def _config_with(self, params: Dict[str, Any]) -> BotConfig:
        """Clone the base config with *params* applied."""
        cfg = BotConfig(**{**self.base.__dict__})
        for key, value in params.items():
            setattr(cfg, key, value)
        return cfg

    # ── evaluation ────────────────────────────────────────────────────

    def _evaluate(self, df: pd.DataFrame, pair: str, params: Dict[str, Any]) -> Dict[str, Any]:
        """Backtest *params* over *df*; returns ``{}` when the window is unusable."""
        cfg = self._config_with(params)
        try:
            tester = Backtester(config=cfg, strategy=AdvancedStrategy(cfg), costs=self.costs)
            return tester.run(df, pair)
        except Exception as exc:
            self.log.debug("params %s failed on this window: %s", params, exc)
            return {}

    def _score(self, metrics: Dict[str, Any]) -> float:
        """Objective value, penalising windows with too few trades.

        A 2-trade window showing a profit factor of 9 is noise, not skill;
        such windows score -inf so the optimiser ignores them.
        """
        if not metrics:
            return float("-inf")
        if int(metrics.get("total_trades", 0)) < MIN_IS_TRADES:
            return float("-inf")
        value = metrics.get(self.objective, 0.0)
        try:
            value = float(value)
        except (TypeError, ValueError):
            return float("-inf")
        if not np.isfinite(value):
            return float("-inf")
        # a window that blew through the drawdown limit is not a winner
        if float(metrics.get("max_drawdown", 0.0)) > 40.0:
            return float("-inf")
        return value

    # ── main loop ─────────────────────────────────────────────────────

    def run(
        self, df: pd.DataFrame, pair: str, train_months: int = 12, test_months: int = 3
    ) -> Dict[str, Any]:
        """Execute the full rolling analysis.

        Args:
            df: Real OHLCV history, UTC-indexed and ascending.
            pair: Instrument label.
            train_months: In-sample window length.
            test_months: Out-of-sample window length and step size.

        Returns:
            Summary dict with ``folds``, ``oos``, ``is``, ``verdict``.

        Raises:
            ValueError: History is too short for even one fold.
        """
        if df is None or df.empty:
            raise ValueError("walk-forward needs a non-empty history")
        if not isinstance(df.index, pd.DatetimeIndex):
            raise ValueError("history must be indexed by datetime")

        span_months = (df.index[-1] - df.index[0]).days / 30.44
        if span_months < train_months + test_months:
            raise ValueError(
                f"history spans {span_months:.1f} months; need at least "
                f"{train_months + test_months} for one fold. Fetch more data."
            )

        combos = self.combinations()
        self.log.info(
            "Walk-forward on %s — %d bars, %.1f months, %d parameter sets, train %dm / test %dm",
            pair, len(df), span_months, len(combos), train_months, test_months,
        )
        if self.costs:
            self.log.info("%s", self.costs.describe())

        self.folds = []
        oos_trades: List[Dict[str, Any]] = []
        cursor = df.index[0]
        train_delta = pd.DateOffset(months=train_months)
        test_delta = pd.DateOffset(months=test_months)
        index = 0

        while True:
            train_end = cursor + train_delta
            test_end = train_end + test_delta
            if test_end > df.index[-1]:
                break
            index += 1
            train_df = df.loc[cursor:train_end]
            test_df = df.loc[train_end:test_end]
            fold = Fold(
                index=index,
                train_months=train_months,
                test_months=test_months,
                train_start=str(cursor)[:10],
                train_end=str(train_end)[:10],
                test_start=str(train_end)[:10],
                test_end=str(test_end)[:10],
            )

            if len(train_df) < 200 or len(test_df) < 60:
                fold.skipped = f"thin window (train {len(train_df)}, test {len(test_df)} bars)"
                self.folds.append(fold)
                cursor = cursor + test_delta
                continue

            # ── in-sample search
            best_score, best_params, best_metrics = float("-inf"), {}, {}
            for params in combos:
                metrics = self._evaluate(train_df, pair, params)
                score = self._score(metrics)
                if score > best_score:
                    best_score, best_params, best_metrics = score, params, metrics

            if not best_params:
                fold.skipped = f"no parameter set produced >= {MIN_IS_TRADES} in-sample trades"
                self.folds.append(fold)
                cursor = cursor + test_delta
                continue

            # ── out-of-sample: evaluated exactly once, never tuned
            oos = self._evaluate(test_df, pair, best_params)
            fold.best_params = best_params
            fold.is_metrics = _slim(best_metrics)
            fold.oos_metrics = _slim(oos)
            self.folds.append(fold)
            for trade in oos.get("trades", []) or []:
                oos_trades.append(trade)

            self.log.info(
                "Fold %d  %s→%s  best=%s  IS pf %.2f (%d trades)  →  OOS pf %.2f (%d trades, %+.2f%%)",
                index, fold.test_start, fold.test_end, best_params,
                float(best_metrics.get("profit_factor", 0) or 0), int(best_metrics.get("total_trades", 0)),
                float(oos.get("profit_factor", 0) or 0), int(oos.get("total_trades", 0)),
                float(oos.get("total_return", 0) or 0),
            )
            cursor = cursor + test_delta

        return self._summarise(pair, oos_trades, train_months, test_months)

    # ── reporting ─────────────────────────────────────────────────────

    def _summarise(
        self, pair: str, oos_trades: List[Dict[str, Any]], train_months: int, test_months: int
    ) -> Dict[str, Any]:
        """Aggregate every out-of-sample block into one honest verdict."""
        used = [f for f in self.folds if not f.skipped and f.oos_metrics]
        pnls = np.array([float(t.get("pnl", 0.0)) for t in oos_trades], dtype=float)
        wins = pnls[pnls > 0]
        losses = pnls[pnls <= 0]
        gross_win = float(wins.sum()) if wins.size else 0.0
        gross_loss = abs(float(losses.sum())) if losses.size else 0.0
        profit_factor = (gross_win / gross_loss) if gross_loss > 0 else (float("inf") if gross_win > 0 else 0.0)

        start_balance = float(self.base.account_balance)
        equity = start_balance + np.cumsum(pnls) if pnls.size else np.array([start_balance])
        peak = np.maximum.accumulate(equity)
        max_dd = float(((peak - equity) / np.where(peak == 0, np.nan, peak) * 100).max()) if pnls.size else 0.0

        # per-month rates, so a 12m window and a 3m window are comparable
        is_returns = [float(f.is_metrics.get("total_return", 0) or 0) / max(train_months, 1) for f in used]
        oos_returns = [float(f.oos_metrics.get("total_return", 0) or 0) / max(test_months, 1) for f in used]
        efficiency = (
            round(float(np.mean(oos_returns)) / float(np.mean(is_returns)), 3)
            if used and float(np.mean(is_returns)) > 0
            else 0.0
        )

        swap_total = sum(float(t.get("cost_swap", 0.0)) for t in oos_trades)
        comm_total = sum(float(t.get("cost_commission", 0.0)) for t in oos_trades)

        summary = {
            "pair": pair,
            "timeframe": self.base.timeframe,
            "train_months": train_months,
            "test_months": test_months,
            "folds_total": len(self.folds),
            "folds_used": len(used),
            "folds_skipped": len(self.folds) - len(used),
            "objective": self.objective,
            "costs": self.costs.describe() if self.costs else "legacy flat spread",
            "oos": {
                "trades": int(pnls.size),
                "win_rate": round(100.0 * wins.size / pnls.size, 2) if pnls.size else 0.0,
                "total_pnl": round(float(pnls.sum()), 2) if pnls.size else 0.0,
                "total_return_pct": round(100.0 * float(pnls.sum()) / start_balance, 2) if pnls.size else 0.0,
                "profit_factor": round(profit_factor, 3) if np.isfinite(profit_factor) else None,
                "max_drawdown_pct": round(max_dd, 2),
                "expectancy": round(float(pnls.mean()), 2) if pnls.size else 0.0,
                "avg_win": round(float(wins.mean()), 2) if wins.size else 0.0,
                "avg_loss": round(float(losses.mean()), 2) if losses.size else 0.0,
                "total_swap_paid": round(swap_total, 2),
                "total_commission": round(comm_total, 2),
            },
            "in_sample": {
                "avg_return_pct_per_month": round(float(np.mean(is_returns)), 2) if used else 0.0,
                "avg_profit_factor": round(
                    float(np.mean([float(f.is_metrics.get("profit_factor", 0) or 0) for f in used])), 3
                ) if used else 0.0,
            },
            "efficiency": efficiency,
            "parameter_stability": self._stability(used),
            "folds": [f.__dict__ for f in self.folds],
        }
        summary["verdict"] = _verdict(summary)
        return summary

    @staticmethod
    def _stability(folds: List[Fold]) -> Dict[str, Any]:
        """How often the optimiser changed its mind between folds.

        Parameters that jump around every fold are being fitted to noise.
        """
        if not folds:
            return {}
        out: Dict[str, Any] = {}
        keys = set().union(*[set(f.best_params) for f in folds])
        for key in sorted(keys):
            values = [f.best_params.get(key) for f in folds]
            uniq = sorted({v for v in values if v is not None}, key=str)
            most = max(uniq, key=lambda v: values.count(v)) if uniq else None
            out[key] = {
                "chosen": [str(v) for v in values],
                "distinct": len(uniq),
                "modal": most,
                "modal_share": round(values.count(most) / len(values), 2) if most is not None else 0.0,
            }
        return out


def _slim(metrics: Dict[str, Any]) -> Dict[str, Any]:
    """Keep the headline numbers, drop trade lists and equity curves."""
    if not metrics:
        return {}
    keep = (
        "total_trades", "win_rate", "total_pnl", "total_return", "profit_factor",
        "max_drawdown", "sharpe_ratio", "expectancy", "avg_risk_reward",
    )
    return {k: metrics.get(k) for k in keep if k in metrics}


def _verdict(summary: Dict[str, Any]) -> Dict[str, Any]:
    """Turn the numbers into a blunt go/no-go with reasons."""
    oos = summary["oos"]
    reasons: List[str] = []
    pf = oos["profit_factor"]
    trades = oos["trades"]

    if summary["folds_used"] == 0:
        return {
            "tradeable": False,
            "headline": "INCONCLUSIVE",
            "reasons": ["no usable folds — need more history, or the grid produced too few trades"],
            "caveat": "Nothing was measured. Fetch a longer history before drawing any conclusion.",
        }
    if trades < 30:
        reasons.append(f"only {trades} out-of-sample trades — too few to conclude anything")
    if pf is None or pf < 1.0:
        reasons.append(f"out-of-sample profit factor {pf} < 1.0 — the edge does not survive costs")
    elif pf < 1.2:
        reasons.append(f"profit factor {pf} is marginal; slippage or a spread widening erases it")
    if summary["efficiency"] < 0.5:
        reasons.append(f"efficiency {summary['efficiency']} — in-sample results do not transfer (curve-fitting)")
    if oos["max_drawdown_pct"] > 25:
        reasons.append(f"out-of-sample drawdown {oos['max_drawdown_pct']}% exceeds most risk appetites")
    unstable = [k for k, v in (summary.get("parameter_stability") or {}).items() if v.get("modal_share", 1) < 0.5]
    if unstable:
        reasons.append(f"unstable parameters {unstable} — the optimiser is chasing noise")

    tradeable = not reasons
    return {
        "tradeable": tradeable,
        "headline": "PLAUSIBLE EDGE" if tradeable else "DO NOT TRADE",
        "reasons": reasons or ["survived out-of-sample testing with realistic costs"],
        "caveat": "Walk-forward survival is necessary, not sufficient. Forward-test on demo next.",
    }


def format_report(summary: Dict[str, Any]) -> str:
    """Human-readable console report."""
    oos, verdict = summary["oos"], summary["verdict"]
    width = 74
    lines = [
        "═" * width,
        f"  WALK-FORWARD — {summary['pair']} {summary['timeframe']}"
        f"  (train {summary['train_months']}m / test {summary['test_months']}m)",
        "═" * width,
        f"  {summary['costs']}",
        f"  folds: {summary['folds_used']} used, {summary['folds_skipped']} skipped"
        f"   objective: {summary['objective']}",
        "─" * width,
        "  OUT-OF-SAMPLE (the only numbers that matter)",
        f"    trades            : {oos['trades']}",
        f"    win rate          : {oos['win_rate']:.2f} %",
        f"    total P&L         : {oos['total_pnl']:>12,.2f}  ({oos['total_return_pct']:+.2f} %)",
        f"    profit factor     : {oos['profit_factor']}",
        f"    expectancy/trade  : {oos['expectancy']:>12,.2f}",
        f"    max drawdown      : {oos['max_drawdown_pct']:.2f} %",
        f"    swap paid         : {oos['total_swap_paid']:>12,.2f}",
        f"    commission paid   : {oos['total_commission']:>12,.2f}",
        "─" * width,
        f"  in-sample avg return : {summary['in_sample']['avg_return_pct_per_month']:+.2f} %/month"
        f"   ·  efficiency (OOS/IS, per month): {summary['efficiency']}",
        "─" * width,
        "  PARAMETER STABILITY",
    ]
    for key, info in (summary.get("parameter_stability") or {}).items():
        lines.append(f"    {key:<16}: modal {info['modal']} in {info['modal_share']:.0%} of folds "
                     f"({info['distinct']} distinct)")
    lines += [
        "─" * width,
        f"  VERDICT: {verdict['headline']}",
    ]
    for reason in verdict["reasons"]:
        lines.append(f"    • {reason}")
    lines += [f"  {verdict['caveat']}", "═" * width]
    return "\n".join(lines)


def main(argv: Optional[List[str]] = None) -> int:
    """CLI entry point."""
    parser = argparse.ArgumentParser(description="Walk-forward validation with realistic costs")
    parser.add_argument("--pair", default="EUR/USD")
    parser.add_argument("--timeframe", default="1h")
    parser.add_argument("--train", type=int, default=12, help="in-sample months")
    parser.add_argument("--test", type=int, default=3, help="out-of-sample months")
    parser.add_argument("--objective", default="profit_factor",
                        choices=["profit_factor", "sharpe_ratio", "total_return", "expectancy"])
    parser.add_argument("--quick", action="store_true", help="smaller grid (faster)")
    parser.add_argument("--no-costs", action="store_true", help="frictionless — diagnostic only")
    parser.add_argument("--mock", action="store_true", help="synthetic data: tests plumbing, proves nothing")
    parser.add_argument("--mock-bars", type=int, default=26000)
    parser.add_argument("--json", default="", help="write the full summary to this path")
    args = parser.parse_args(argv)

    cfg = BotConfig()
    cfg.timeframe = args.timeframe
    log = get_logger("walkforward")

    if args.mock:
        from data_feed import MockDataFeed

        cfg.pairs = [args.pair]
        feed = MockDataFeed(cfg, bars=args.mock_bars)
        df = feed.history(args.pair)
        print("\n  ⚠  SYNTHETIC DATA — this validates the harness, not the strategy.\n")
    else:
        from history import HistoryError, load

        try:
            df = load(args.pair, args.timeframe)
        except HistoryError as exc:
            log.error("%s", exc)
            return 2

    costs = CostModel.zero() if args.no_costs else CostModel.for_pair(args.pair)
    grid = QUICK_GRID if args.quick else DEFAULT_GRID
    engine = WalkForward(cfg, costs=costs, grid=grid, objective=args.objective)

    try:
        summary = engine.run(df, args.pair, args.train, args.test)
    except ValueError as exc:
        log.error("%s", exc)
        return 2

    print("\n" + format_report(summary))
    if args.json:
        Path(args.json).write_text(json.dumps(summary, indent=2, default=str), encoding="utf-8")
        print(f"\n  full summary → {args.json}")
    return 0 if summary["verdict"]["tradeable"] else 1


if __name__ == "__main__":
    sys.exit(main())
