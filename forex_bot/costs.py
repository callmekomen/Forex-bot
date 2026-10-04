"""
costs.py — the money a backtest silently forgets.
════════════════════════════════════════════════════════════════════════
A flat "1.5 pip spread" is the single most common way a retail backtest
flatters itself. Real round trips are charged for:

* **Spread** — and it is not constant. It widens at the rollover, during
  news, and on the Sunday open.
* **Commission** — ECN accounts pay per lot per side.
* **Swap / rollover** — interest for holding overnight, charged at 22:00
  UTC, and **tripled on Wednesday** to cover the weekend value date. For
  an hourly strategy holding positions for many hours this is frequently
  larger than the spread.
* **Slippage** — stops in particular fill *worse* than requested, because
  they become market orders in a moving book.

This module models all four. Everything is expressed per *standard lot*
and scaled by position size.

The defaults are deliberately pessimistic. A strategy that only works
with optimistic costs does not work.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Dict, Optional

import pandas as pd

#: Indicative retail swap rates, USD per standard lot per night.
#: NEGATIVE = you pay. Override with your broker's real numbers —
#: these vary by broker, account type and central-bank policy.
DEFAULT_SWAP_TABLE: Dict[str, Dict[str, float]] = {
    "EUR/USD": {"long": -7.20, "short": 2.10},
    "GBP/USD": {"long": -5.80, "short": 1.40},
    "USD/JPY": {"long": 4.60, "short": -11.30},
    "AUD/USD": {"long": -6.10, "short": 1.20},
    "USD/CHF": {"long": 3.90, "short": -9.80},
    "USD/CAD": {"long": 1.80, "short": -7.40},
}

#: Hours (UTC) when spreads reliably widen: rollover + thin Asian close.
WIDE_SPREAD_HOURS = {21, 22, 23}


@dataclass
class CostModel:
    """Full round-trip cost model for one instrument.

    Attributes:
        spread_pips: Typical spread during liquid hours.
        wide_spread_multiplier: Spread multiplier during rollover hours.
        commission_per_lot_per_side: ECN commission, charged twice.
        slippage_pips_entry: Adverse fill on entry (market order).
        slippage_pips_stop: Adverse fill when a stop triggers. Larger than
            entry slippage on purpose — stops fill into momentum.
        swap_long / swap_short: USD per lot per night. Negative = you pay.
        swap_enabled: Set False to isolate the effect of swap.
        triple_swap_weekday: Weekday with 3x swap (2 = Wednesday).
    """

    spread_pips: float = 1.5
    wide_spread_multiplier: float = 2.5
    commission_per_lot_per_side: float = 3.5
    slippage_pips_entry: float = 0.3
    slippage_pips_stop: float = 0.8
    swap_long: float = -7.20
    swap_short: float = 2.10
    swap_enabled: bool = True
    triple_swap_weekday: int = 2

    @classmethod
    def for_pair(cls, pair: str, **overrides: float) -> "CostModel":
        """Build a model using the indicative swap table for *pair*.

        Args:
            pair: Instrument such as ``"EUR/USD"``.
            **overrides: Any dataclass field to override.

        Returns:
            A :class:`CostModel` with that pair's swap rates applied.
        """
        swaps = DEFAULT_SWAP_TABLE.get(pair.upper(), {"long": -5.0, "short": -5.0})
        params: Dict[str, float] = {
            "swap_long": swaps["long"],
            "swap_short": swaps["short"],
        }
        params.update(overrides)
        return cls(**params)  # type: ignore[arg-type]

    @classmethod
    def zero(cls) -> "CostModel":
        """A cost-free model — useful to quantify how much costs matter."""
        return cls(
            spread_pips=0.0,
            wide_spread_multiplier=1.0,
            commission_per_lot_per_side=0.0,
            slippage_pips_entry=0.0,
            slippage_pips_stop=0.0,
            swap_enabled=False,
        )

    # ── individual components ─────────────────────────────────────────

    def spread_at(self, moment: Optional[datetime]) -> float:
        """Spread in pips at *moment*, widened during rollover hours."""
        if moment is None:
            return self.spread_pips
        hour = moment.hour
        if hour in WIDE_SPREAD_HOURS:
            return self.spread_pips * self.wide_spread_multiplier
        return self.spread_pips

    def entry_fill(self, requested: float, direction: str, pip_size: float, moment=None) -> float:
        """Apply half-spread + slippage to an entry, always against you.

        A BUY pays the ask (above mid), a SELL receives the bid (below mid).
        """
        half = self.spread_at(_as_dt(moment)) / 2.0
        adverse = (half + self.slippage_pips_entry) * pip_size
        return requested + adverse if direction.upper() == "BUY" else requested - adverse

    def exit_fill(
        self, requested: float, direction: str, pip_size: float, is_stop: bool, moment=None
    ) -> float:
        """Apply half-spread + slippage to an exit, always against you.

        Stop exits use the larger slippage figure: a stop becomes a market
        order precisely when the book is thin and moving.
        """
        half = self.spread_at(_as_dt(moment)) / 2.0
        slip = self.slippage_pips_stop if is_stop else 0.0
        adverse = (half + slip) * pip_size
        # closing a long means selling → filled lower; closing a short → higher
        return requested - adverse if direction.upper() == "BUY" else requested + adverse

    def commission(self, lots: float) -> float:
        """Round-trip commission (both sides) for *lots*."""
        return round(2.0 * self.commission_per_lot_per_side * float(lots), 4)

    def nights_held(self, entry_time, exit_time) -> int:
        """Number of 22:00 UTC rollovers crossed between the two stamps.

        Swap is charged when a position is open at the rollover, so this
        counts boundaries crossed, not calendar days.
        """
        start, end = _as_dt(entry_time), _as_dt(exit_time)
        if start is None or end is None or end <= start:
            return 0
        nights = 0
        cursor = start.replace(hour=22, minute=0, second=0, microsecond=0)
        if cursor <= start:
            cursor += timedelta(days=1)
        while cursor <= end:
            nights += 1
            cursor += timedelta(days=1)
        return nights

    def swap_charge(self, direction: str, lots: float, entry_time, exit_time) -> float:
        """Total swap for the holding period (negative = a cost).

        Wednesday rollovers count triple, which is how brokers settle the
        weekend value date.
        """
        if not self.swap_enabled:
            return 0.0
        start, end = _as_dt(entry_time), _as_dt(exit_time)
        if start is None or end is None or end <= start:
            return 0.0
        rate = self.swap_long if direction.upper() == "BUY" else self.swap_short
        total = 0.0
        cursor = start.replace(hour=22, minute=0, second=0, microsecond=0)
        if cursor <= start:
            cursor += timedelta(days=1)
        while cursor <= end:
            multiplier = 3.0 if cursor.weekday() == self.triple_swap_weekday else 1.0
            total += rate * multiplier * float(lots)
            cursor += timedelta(days=1)
        return round(total, 4)

    # ── aggregate ─────────────────────────────────────────────────────

    def total_cost(
        self, direction: str, lots: float, entry_time, exit_time, pip_size: float
    ) -> Dict[str, float]:
        """Itemised costs for one round trip, so nothing hides in a lump sum.

        Note:
            Spread and slippage are applied to the *fill prices* by
            :meth:`entry_fill` / :meth:`exit_fill`, so they are reported
            here for transparency but must not be subtracted twice.

        Returns:
            ``{spread_cost, commission, swap, nights, total_cash}`` where
            ``total_cash`` covers only commission + swap.
        """
        comm = self.commission(lots)
        swap = self.swap_charge(direction, lots, entry_time, exit_time)
        spread_cash = self.spread_at(_as_dt(entry_time)) * 10.0 * float(lots)
        return {
            "spread_cost": round(spread_cash, 4),
            "commission": comm,
            "swap": swap,
            "nights": float(self.nights_held(entry_time, exit_time)),
            # net cash deducted from gross P&L: commission always costs,
            # swap is added signed (negative swap = a charge)
            "total_cash": round(comm - swap, 4),
        }

    def describe(self) -> str:
        """One-line human summary for report headers."""
        if self.spread_pips == 0 and not self.swap_enabled:
            return "costs: NONE (frictionless — diagnostic only)"
        return (
            f"costs: spread {self.spread_pips}p (x{self.wide_spread_multiplier} at rollover) · "
            f"commission ${self.commission_per_lot_per_side}/lot/side · "
            f"slippage {self.slippage_pips_entry}p entry / {self.slippage_pips_stop}p stop · "
            f"swap {self.swap_long:+.2f}/{self.swap_short:+.2f} per night"
            + (" (3x Wed)" if self.swap_enabled else " (disabled)")
        )


def _as_dt(value) -> Optional[datetime]:
    """Coerce pandas/str/datetime into a naive **UTC** ``datetime``.

    Everything is normalised to tz-naive UTC so mixed-awareness inputs
    (``pd.Timestamp`` from a tz-aware index vs. a plain ``datetime``)
    never raise on comparison. ``pd.Timestamp`` subclasses ``datetime``,
    so it must be handled before the isinstance shortcut.
    """
    if value is None:
        return None
    if isinstance(value, datetime) and not isinstance(value, pd.Timestamp):
        return value.replace(tzinfo=None) if value.tzinfo is not None else value
    try:
        stamp = pd.Timestamp(value)
        if stamp.tzinfo is not None:
            stamp = stamp.tz_convert("UTC").tz_localize(None)
        return stamp.to_pydatetime()
    except Exception:
        return None
