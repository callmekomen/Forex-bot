"""
backtester.py — bar-by-bar historical replay of the live strategy.
════════════════════════════════════════════════════════════════════════
Same :class:`strategy.AdvancedStrategy`, same ATR stops, same confidence
threshold, plus a configurable spread cost. Intra-bar logic is honest about
order of events:

* a bar that touches BOTH stop and target is charged to the **stop**
  (worst case — brokers are not obligated to honour your favoured exit)
* entries happen at the *next* bar's open, never at the signal bar's close,
  which removes the classic "look-ahead" inflation
* exits are checked before new entries, so one position at a time per run

Run it directly for a quick report against the mock feed::

    python backtester.py --pair EUR/USD --bars 4000 --seed 11
"""

from __future__ import annotations

import argparse
import math
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

from config import BotConfig
from costs import CostModel
from data_feed import MockDataFeed
from indicators import Indicators
from logger import get_logger
from strategy import AdvancedStrategy, TradeSignal

#: rough number of bars per year, used to annualise the Sharpe ratio
BARS_PER_YEAR: Dict[str, int] = {
    "1m": 372_960, "5m": 74_592, "15m": 24_864,
    "1h": 6_216, "4h": 1_554, "1d": 252,
}


@dataclass
class BacktestTrade:
    """A single round-trip simulated by the backtester."""

    pair: str
    direction: str
    entry_time: str
    exit_time: str
    entry_price: float
    exit_price: float
    lots: float
    pnl: float
    bars_held: int
    exit_reason: str
    risk: float
    reward: float
    confidence: float
    gross_pnl: float = 0.0
    cost_spread: float = 0.0
    cost_commission: float = 0.0
    cost_swap: float = 0.0
    nights_held: int = 0

    def to_dict(self) -> Dict[str, Any]:
        """JSON-safe representation."""
        return asdict(self)


@dataclass
class Backtester:
    """Historical simulator driven by the production strategy object."""

    config: BotConfig
    strategy: AdvancedStrategy
    min_confidence: Optional[float] = None
    #: Full cost model. When None, the legacy flat-spread charge is used.
    costs: Optional[CostModel] = None
    trades: List[BacktestTrade] = field(default_factory=list)
    equity_curve: List[float] = field(default_factory=list)
    drawdown_curve: List[float] = field(default_factory=list)

    def __post_init__(self) -> None:
        """Pick up the config's confidence floor and prepare the logger."""
        self.log = get_logger("backtester")
        self._min_conf = (
            self.config.min_confidence if self.min_confidence is None else float(self.min_confidence)
        )

    # ── main loop ─────────────────────────────────────────────────────

    def run(
        self,
        df: pd.DataFrame,
        pair: str,
        spread_pips: float = 1.5,
        warmup: int = 50,
        exact: bool = False,
    ) -> Dict[str, Any]:
        """Replay *df* and return a metrics dictionary.

        Args:
            df: Ascending OHLCV history (``time`` index, >= warmup + 60 rows).
            pair: Instrument label, used for pip-size auto-detection.
            spread_pips: Round-trip cost charged to every trade.
            warmup: Bars skipped before the first signal (indicator warmup).
            exact: Re-run ``strategy.analyze`` per bar (O(n²), bit-exact
                reference) instead of the vectorised causal replay.

        Returns:
            Metrics dict (``total_trades``, ``win_rate``, ``profit_factor``,
            ``max_drawdown``, ``sharpe_ratio``, … ) plus ``trades`` and
            ``equity_curve``.
        """
        if df is None or len(df) <= warmup + 5:
            raise ValueError(f"need more than {warmup + 5} bars, got {0 if df is None else len(df)}")
        pip_size = self.config.pip_size_for(pair)
        spread_cost = float(spread_pips) * pip_size * self.config.pip_value  # cash per lot

        self.trades, self.equity_curve, self.drawdown_curve = [], [], []
        balance = float(self.config.account_balance)
        peak = balance
        enriched = Indicators.attach(df, self.config)
        enriched = enriched.dropna(subset=["ema_slow", "rsi", "atr", "macd_hist", "bb_lower", "adx"])
        if len(enriched) <= warmup + 5:
            raise ValueError("not enough valid bars after indicator warm-up")

        times = enriched.index
        closes = enriched["close"].to_numpy()
        highs = enriched["high"].to_numpy()
        lows = enriched["low"].to_numpy()

        pos: Optional[Dict[str, Any]] = None
        n = len(enriched)
        for i in range(max(warmup, 2), n):
            price = float(closes[i])

            # 1 ── manage an open position first (exits take priority)
            if pos is not None:
                exit_price, reason = self._check_exit(pos, float(highs[i]), float(lows[i]), price)
                if exit_price is None:
                    self._track_curve(balance, peak)
                    continue
                fill = self._apply_exit_fill(pos, exit_price, pip_size, reason, times[i])
                gross, breakdown = self._settle(pos, fill, pip_size, times[i], spread_cost)
                pnl = round(gross - breakdown["cash"], 2)
                balance = round(balance + pnl, 2)
                peak = max(peak, balance)
                self.trades.append(
                    BacktestTrade(
                        pair=pair,
                        direction=pos["direction"],
                        entry_time=str(times[pos["bar"]]),
                        exit_time=str(times[i]),
                        entry_price=round(pos["entry"], 5),
                        exit_price=round(fill, 5),
                        lots=pos["lots"],
                        pnl=pnl,
                        bars_held=i - pos["bar"],
                        exit_reason=reason,
                        risk=round(pos["risk"], 5),
                        reward=round(pos["reward"], 5),
                        confidence=pos["confidence"],
                        gross_pnl=round(gross, 2),
                        cost_spread=breakdown["spread"],
                        cost_commission=breakdown["commission"],
                        cost_swap=breakdown["swap"],
                        nights_held=int(breakdown["nights"]),
                    )
                )
                pos = None

            # 2 ── look for a new entry on data up to and including bar i
            sig = (
                self.strategy.analyze(df.iloc[: i + 1], pair)
                if exact
                else self.strategy.from_enriched(enriched.iloc[max(0, i - 2) : i + 1], pair)
            )
            if not sig.signal.actionable or sig.confidence < self._min_conf:
                self._track_curve(balance, peak)
                continue
            if sig.risk <= 0 or sig.reward / sig.risk < 1.5:
                self._track_curve(balance, peak)
                continue
            if i + 1 >= n:
                self._track_curve(balance, peak)
                continue

            raw_entry = float(closes[i + 1])  # next bar's open — no look-ahead
            entry = (
                self.costs.entry_fill(raw_entry, sig.direction, pip_size, times[i + 1])
                if self.costs is not None
                else raw_entry
            )
            offset = sig.price - entry
            entry_time = str(times[i + 1])
            pos = {
                "direction": sig.direction,
                "signal": sig.signal,
                "bar": i + 1,
                "entry": entry,
                "entry_time": entry_time,
                "stop_loss": round(sig.stop_loss + offset, 5),
                "take_profit": round(sig.take_profit + offset, 5),
                "risk": round(sig.risk, 5),
                "reward": round(sig.reward, 5),
                "lots": self._size(sig, entry),
                "confidence": sig.confidence,
            }
            self._track_curve(balance, peak)

        if pos is not None:
            self.log.info("Backtest ended with an open position — closed at last price (mark-to-market).")
            gross, breakdown = self._settle(pos, float(closes[-1]), pip_size, times[-1], spread_cost)
            pnl = round(gross - breakdown["cash"], 2)
            balance = round(balance + pnl, 2)
            self.trades.append(
                BacktestTrade(
                    pair=pair, direction=pos["direction"], entry_time=str(times[pos["bar"]]),
                    exit_time=str(times[-1]), entry_price=round(pos["entry"], 5),
                    exit_price=round(float(closes[-1]), 5), lots=pos["lots"], pnl=pnl,
                    bars_held=n - 1 - pos["bar"], exit_reason="end_of_data",
                    risk=round(pos["risk"], 5), reward=round(pos["reward"], 5),
                    confidence=pos["confidence"], gross_pnl=round(gross, 2),
                    cost_spread=breakdown["spread"], cost_commission=breakdown["commission"],
                    cost_swap=breakdown["swap"], nights_held=int(breakdown["nights"]),
                )
            )
            self._track_curve(balance, peak)

        return self._metrics(pair, balance, float(closes[0]), float(closes[-1]), spread_pips)

    def run_all(
        self, frames: Dict[str, pd.DataFrame], spread_pips: float = 1.5
    ) -> Dict[str, Any]:
        """Backtest every pair and add a portfolio-level aggregate."""
        per_pair = {pair: self.run(df, pair, spread_pips=spread_pips) for pair, df in frames.items()}
        totals = {
            "pairs": len(per_pair),
            "total_trades": sum(m["total_trades"] for m in per_pair.values()),
            "total_pnl": round(sum(m["total_pnl"] for m in per_pair.values()), 2),
            "avg_win_rate": round(float(np.mean([m["win_rate"] for m in per_pair.values()])), 2),
            "worst_drawdown": round(float(max(m["max_drawdown"] for m in per_pair.values())), 2),
        }
        return {"per_pair": per_pair, "portfolio": totals}

    # ── helpers ───────────────────────────────────────────────────────

    @staticmethod
    def _check_exit(pos: Dict[str, Any], high: float, low: float, close: float) -> tuple[Optional[float], str]:
        """Return ``(exit_price, reason)`` for bar extremes, stop first."""
        long = pos["direction"] == "BUY"
        sl, tp = pos["stop_loss"], pos["take_profit"]
        if long:
            if low <= sl:
                return sl, "stop_loss"
            if high >= tp:
                return tp, "take_profit"
        else:
            if high >= sl:
                return sl, "stop_loss"
            if low <= tp:
                return tp, "take_profit"
        return None, ""

    def _apply_exit_fill(
        self, pos: Dict[str, Any], exit_price: float, pip_size: float, reason: str, moment: Any
    ) -> float:
        """Degrade the theoretical exit price by half-spread + slippage."""
        if self.costs is None:
            return exit_price
        return self.costs.exit_fill(
            exit_price, pos["direction"], pip_size, is_stop=(reason == "stop_loss"), moment=moment
        )

    def _settle(
        self, pos: Dict[str, Any], exit_price: float, pip_size: float, exit_time: Any, legacy_spread: float
    ) -> tuple[float, Dict[str, float]]:
        """Return ``(gross_pnl, cost_breakdown)`` for a closing position.

        With a :class:`costs.CostModel` attached, spread and slippage are
        already baked into the fill prices, so only commission and swap are
        deducted here as cash. Without one, the legacy flat spread charge
        is applied so existing results stay reproducible.
        """
        gross = self._gross_pnl(pos, exit_price, pip_size)
        if self.costs is None:
            cash = legacy_spread * pos["lots"]
            return gross, {"cash": cash, "spread": round(cash, 4), "commission": 0.0, "swap": 0.0, "nights": 0.0}
        items = self.costs.total_cost(
            pos["direction"], pos["lots"], pos.get("entry_time"), exit_time, pip_size
        )
        return gross, {
            "cash": items["total_cash"],
            "spread": items["spread_cost"],
            "commission": items["commission"],
            "swap": items["swap"],
            "nights": items["nights"],
        }

    def _gross_pnl(self, pos: Dict[str, Any], exit_price: float, pip_size: float) -> float:
        """Cash P&L before spread for an open paper position."""
        pips = (exit_price - pos["entry"]) / pip_size
        if pos["direction"] == "SELL":
            pips = -pips
        return pips * self.config.pip_value * pos["lots"]

    def _size(self, sig: TradeSignal, entry: float) -> float:
        """Risk-based lots, mirroring the live risk manager's formula."""
        pips = abs(entry - sig.stop_loss) / self.config.pip_size_for(sig.pair)
        if pips <= 0:
            return self.config.lot_size
        lots = (self.config.account_balance * self.config.max_risk_per_trade) / (
            pips * self.config.pip_value
        )
        return max(0.01, round(math.floor(lots * 100) / 100, 2))

    def _track_curve(self, balance: float, peak: float) -> None:
        """Append the current equity/drawdown point to the curves."""
        self.equity_curve.append(balance)
        dd = 0.0 if peak <= 0 else max(0.0, (peak - balance) / peak * 100.0)
        self.drawdown_curve.append(round(dd, 4))

    def _metrics(self, pair: str, end_balance: float, start_price: float, end_price: float, spread_pips: float) -> Dict[str, Any]:
        """Collapse the trade list into the published performance summary."""
        pnls = np.array([t.pnl for t in self.trades], dtype=float)
        wins = pnls[pnls > 0]
        losses = pnls[pnls <= 0]
        start_balance = self.config.account_balance
        total_pnl = float(pnls.sum()) if pnls.size else 0.0
        gross_win = float(wins.sum()) if wins.size else 0.0
        gross_loss = abs(float(losses.sum())) if losses.size else 0.0
        rrs = [t.reward / t.risk for t in self.trades if t.risk > 0]

        curve = pd.Series(self.equity_curve or [start_balance])
        running_peak = curve.cummax()
        max_dd = float(((running_peak - curve) / running_peak.replace(0, np.nan) * 100.0).max() or 0.0)

        values = curve.to_numpy(dtype=float)
        returns = pd.Series(values[1:] / values[:-1] - 1.0).dropna() if len(values) > 1 else pd.Series(dtype=float)
        per_year = BARS_PER_YEAR.get(self.config.timeframe, 252)
        sharpe = 0.0
        if len(returns) > 2 and float(returns.std()) > 0:
            sharpe = float(returns.mean() / returns.std() * math.sqrt(per_year))

        return {
            "pair": pair,
            "timeframe": self.config.timeframe,
            "bars": int(len(curve)),
            "spread_pips": spread_pips,
            "start_balance": round(start_balance, 2),
            "end_balance": round(end_balance, 2),
            "total_trades": int(pnls.size),
            "winning_trades": int(wins.size),
            "losing_trades": int(losses.size),
            "win_rate": round(100.0 * wins.size / pnls.size, 2) if pnls.size else 0.0,
            "total_pnl": round(total_pnl, 2),
            "total_return": round(100.0 * total_pnl / start_balance, 2) if start_balance else 0.0,
            "avg_win": round(float(wins.mean()), 2) if wins.size else 0.0,
            "avg_loss": round(float(losses.mean()), 2) if losses.size else 0.0,
            "largest_win": round(float(wins.max()), 2) if wins.size else 0.0,
            "largest_loss": round(float(losses.min()), 2) if losses.size else 0.0,
            "gross_profit": round(gross_win, 2),
            "gross_loss": round(gross_loss, 2),
            "profit_factor": round(gross_win / gross_loss, 3) if gross_loss > 0 else (float("inf") if gross_win > 0 else 0.0),
            "expectancy": round(total_pnl / pnls.size, 2) if pnls.size else 0.0,
            "max_drawdown": round(0.0 if math.isnan(max_dd) else max_dd, 2),
            "sharpe_ratio": round(sharpe, 3),
            "avg_risk_reward": round(float(np.mean(rrs)), 3) if rrs else 0.0,
            "avg_bars_held": round(float(np.mean([t.bars_held for t in self.trades])), 1) if self.trades else 0.0,
            "buy_trades": sum(1 for t in self.trades if t.direction == "BUY"),
            "sell_trades": sum(1 for t in self.trades if t.direction == "SELL"),
            "price_change_pct": round(100.0 * (end_price - start_price) / start_price, 2) if start_price else 0.0,
            "trades": [t.to_dict() for t in self.trades],
            "equity_curve": [round(x, 2) for x in self.equity_curve],
            "drawdown_curve": self.drawdown_curve,
        }

    @staticmethod
    def report(metrics: Dict[str, Any]) -> str:
        """Render one metrics dict as a fixed-width console report."""
        pf = metrics["profit_factor"]
        lines = [
            "┌" + "─" * 46 + "┐",
            f"│ BACKTEST — {metrics['pair']:<27}│",
            "├" + "─" * 46 + "┤",
            f"│ bars / timeframe      : {metrics['bars']:<25}│",
            f"│ trades (W / L)        : {metrics['total_trades']:<8}({metrics['winning_trades']}W / {metrics['losing_trades']}L)   │",
            f"│ win rate              : {metrics['win_rate']:>7.2f} %{' ' * 21}│",
            f"│ total P&L             : {metrics['total_pnl']:>12,.2f} USD{' ' * 6}│",
            f"│ total return          : {metrics['total_return']:>7.2f} %{' ' * 21}│",
            f"│ profit factor         : {('inf' if pf == float('inf') else f'{pf:.2f}'):>7}{' ' * 24}│",
            f"│ max drawdown          : {metrics['max_drawdown']:>7.2f} %{' ' * 21}│",
            f"│ Sharpe (annualised)   : {metrics['sharpe_ratio']:>7.2f}{' ' * 24}│",
            f"│ avg win / avg loss    : {metrics['avg_win']:>8,.2f} / {metrics['avg_loss']:>8,.2f}{' ' * 7}│",
            f"│ largest win / loss    : {metrics['largest_win']:>8,.2f} / {metrics['largest_loss']:>8,.2f}{' ' * 7}│",
            f"│ avg risk:reward       : {metrics['avg_risk_reward']:>7.2f}{' ' * 24}│",
            "└" + "─" * 46 + "┘",
        ]
        return "\n".join(lines)


def _cli() -> None:  # pragma: no cover - interactive utility
    """``python backtester.py`` entry point using the deterministic mock feed."""
    parser = argparse.ArgumentParser(description="Forex bot backtester")
    parser.add_argument("--pair", default="EUR/USD")
    parser.add_argument("--bars", type=int, default=4000)
    parser.add_argument("--seed", type=int, default=11)
    parser.add_argument("--timeframe", default="1h")
    parser.add_argument("--spread", type=float, default=1.5)
    parser.add_argument("--exact", action="store_true", help="recompute indicators per bar (slow)")
    parser.add_argument("--csv", default="", help="write the trade list to this CSV")
    args = parser.parse_args()

    config = BotConfig(pairs=[args.pair], timeframe=args.timeframe)
    feed = MockDataFeed(config, bars=args.bars, seed=args.seed)
    bt = Backtester(config=config, strategy=AdvancedStrategy(config))
    metrics = bt.run(feed.get_candles(args.pair, args.bars), args.pair, spread_pips=args.spread, exact=args.exact)
    print(bt.report(metrics))
    if args.csv:
        pd.DataFrame(metrics["trades"]).to_csv(args.csv, index=False)
        print(f"trade list written to {args.csv}")


if __name__ == "__main__":  # pragma: no cover
    _cli()
