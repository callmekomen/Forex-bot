"""
risk_manager.py — the only gate between a signal and the market.
════════════════════════════════════════════════════════════════════════
NO trade may bypass this module. It owns:

* fixed-fractional position sizing (risk is *cash*, never lots)
* per-day realised loss circuit-breaker (resets at 00:00 UTC)
* peak-to-trough drawdown circuit-breaker (sticky until manual reset)
* max concurrent positions / one position per pair
* session-hours filter (UTC)
* durable state in ``bot_state.json`` so a restart cannot forget the halt

Sizing is deliberately one-directional: a lower balance produces smaller
lots. There is no martingale, no grid recovery, no averaging down.
"""

from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from config import BotConfig
from logger import get_logger
from strategy import TradeSignal


@dataclass
class Position:
    """One open exposure owned by the bot (identified by MT5 ticket)."""

    pair: str
    direction: str            # "BUY" | "SELL"
    lots: float
    open_price: float
    stop_loss: float
    take_profit: float
    open_time: str            # ISO-8601 UTC
    ticket: int
    comment: str = ""

    @property
    def is_long(self) -> bool:
        """True when the position profits from rising prices."""
        return self.direction.upper() == "BUY"

    def stop_distance(self, pip_size: float = 0.0001) -> float:
        """Distance from entry to stop, in *pips*."""
        if pip_size <= 0:
            return 0.0
        return abs(self.open_price - self.stop_loss) / pip_size

    def unrealised_pnl(self, current_price: float, pip_size: float, pip_value: float) -> float:
        """Mark-to-market P&L in account currency for *current_price*."""
        if pip_size <= 0:
            return 0.0
        pips = (current_price - self.open_price) / pip_size
        if not self.is_long:
            pips = -pips
        return round(pips * pip_value * self.lots, 2)

    def to_dict(self) -> Dict[str, Any]:
        """JSON-safe representation."""
        return asdict(self)

    @staticmethod
    def from_dict(raw: Dict[str, Any]) -> "Position":
        """Rebuild a position from persisted state, ignoring unknown keys."""
        allowed = {f for f in Position.__dataclass_fields__}
        return Position(**{k: v for k, v in raw.items() if k in allowed})


@dataclass
class RiskVerdict:
    """Result of :meth:`RiskManager.validate_trade`."""

    approved: bool
    lots: float
    reason: str
    risk_dollars: float = 0.0

    def __bool__(self) -> bool:  # `if verdict:` reads naturally
        """Allow ``if verdict:`` while keeping the tuple API from the spec."""
        return self.approved

    def as_tuple(self) -> Tuple[bool, float, str]:
        """``(approved, lots, reason)`` — the documented signature."""
        return self.approved, self.lots, self.reason


class RiskManager:
    """Stateful, fail-safe pre-trade risk gatekeeper."""

    def __init__(self, config: BotConfig, state_file: Optional[Path] = None) -> None:
        """Seed balances/limits from *config* and load any saved state.

        Args:
            config: Bot configuration (risk limits, trading hours, lots).
            state_file: Override for the JSON state path (tests use tmp dirs).
        """
        self.config = config
        self.state_file = Path(state_file or config.state_file)
        self.log = get_logger("risk")

        self.current_balance: float = float(config.account_balance)
        self.peak_balance: float = float(config.account_balance)
        self.daily_pnl: float = 0.0
        self.daily_date: str = self._today()
        self.open_positions: List[Position] = []
        self.trade_log: List[Dict[str, Any]] = []
        self.halted: bool = False
        self.halt_reason: str = ""
        self.load_state()

    # ─────────────────────────────────────────────────────────────────
    # Gate #1 — may we trade at all?
    # ─────────────────────────────────────────────────────────────────

    def can_trade(self, now: Optional[datetime] = None) -> Tuple[bool, str]:
        """Check every global constraint, in order of severity.

        Args:
            now: Injectable UTC timestamp (used by tests). Defaults to now.

        Returns:
            ``(True, "OK")`` when trading is allowed, otherwise
            ``(False, "<first failing rule>")``. A breached loss or
            drawdown limit also latches :attr:`halted`.
        """
        moment = now or datetime.now(timezone.utc)
        self._reset_daily(moment)

        if self.halted:
            return False, f"BOT HALTED ({self.halt_reason or 'limit breached'})"

        if len(self.open_positions) >= self.config.max_open_positions:
            return False, (
                f"max open positions reached ({len(self.open_positions)}/"
                f"{self.config.max_open_positions})"
            )

        if not self.open_positions and self.current_balance <= 0:
            return False, f"account balance depleted ({self.current_balance:,.2f})"

        loss_limit = self.config.max_daily_loss_dollars
        if self.daily_pnl <= -abs(loss_limit):
            self.halted = True
            self.halt_reason = (
                f"daily loss {self.daily_pnl:,.2f} exceeded {loss_limit:,.2f} limit"
            )
            self._save_state()
            self.log.critical("HALT — %s", self.halt_reason)
            return False, f"halted: {self.halt_reason}"

        drawdown = self.drawdown_pct()
        if drawdown >= self.config.max_drawdown_limit:
            self.halted = True
            self.halt_reason = (
                f"max drawdown {drawdown:.2%} >= {self.config.max_drawdown_limit:.2%} "
                f"(peak {self.peak_balance:,.2f} → {self.current_balance:,.2f})"
            )
            self._save_state()
            self.log.critical("HALT — %s", self.halt_reason)
            return False, f"halted: {self.halt_reason}"

        if not self.config.is_trading_hours(moment.hour):
            return False, (
                f"outside trading hours ({moment.hour:02d}:00 UTC, allowed "
                f"{self.config.start_hour:02d}:00-{self.config.end_hour:02d}:00)"
            )

        return True, "OK"

    # ─────────────────────────────────────────────────────────────────
    # Gate #2 — sizing
    # ─────────────────────────────────────────────────────────────────

    def calculate_position_size(
        self, direction: str, entry: float, stop_loss: float, pair: str = ""
    ) -> float:
        """Fixed-fractional lot size from the stop distance.

        ``lots = (balance × max_risk_per_trade) / (pips × pip_value)``

        Args:
            direction: ``"BUY"`` / ``"SELL"`` (accepted for symmetry; the
                formula is direction-agnostic because the stop defines risk).
            entry: Planned entry price.
            stop_loss: Protective stop price.
            pair: Instrument, used to auto-detect JPY pip size.

        Returns:
            Lot size rounded down to 0.01 steps, at least the broker minimum,
            or ``0.0`` when the stop is invalid (fail closed).
        """
        pip_size = self.config.pip_size_for(pair) if pair else self.config.pip_size
        distance = abs(float(entry) - float(stop_loss))
        if distance <= 0 or math.isnan(distance):
            self.log.warning("Invalid stop distance (%s) — sizing refused", distance)
            return 0.0
        pips = distance / pip_size
        if pips < 1e-9:
            return 0.0
        max_risk_dollars = self.current_balance * self.config.max_risk_per_trade
        raw_lots = max_risk_dollars / (pips * self.config.pip_value)
        if not math.isfinite(raw_lots) or raw_lots <= 0:
            return 0.0
        # round DOWN so realised risk never exceeds the configured fraction
        lots = math.floor(raw_lots * 100.0) / 100.0
        if lots < 0.01:
            lots = 0.01 if raw_lots >= 0.005 else 0.0
        return round(lots, 2)

    def risk_dollars(self, lots: float, entry: float, stop_loss: float, pair: str = "") -> float:
        """Cash lost if the stop is hit for *lots*."""
        pip_size = self.config.pip_size_for(pair) if pair else self.config.pip_size
        pips = abs(float(entry) - float(stop_loss)) / pip_size if pip_size else 0.0
        return round(pips * self.config.pip_value * float(lots), 2)

    # ─────────────────────────────────────────────────────────────────
    # Gate #3 — full pre-trade validation
    # ─────────────────────────────────────────────────────────────────

    def validate_trade(
        self, signal: TradeSignal, now: Optional[datetime] = None
    ) -> Tuple[bool, float, str]:
        """Approve/reject *signal* and return ``(approved, lots, reason)``.

        Checks, in order: global gate → confidence → reward:risk → duplicate
        pair → sizing → realised-risk cap. Lots are shaved down (never up)
        until the stop-loss scenario fits inside ``max_risk_per_trade``.
        """
        allowed, gate_reason = self.can_trade(now)
        if not allowed:
            return False, 0.0, gate_reason

        if not signal.signal.actionable:
            return False, 0.0, f"{signal.pair}: signal is NEUTRAL"

        if signal.confidence < self.config.min_confidence:
            return False, 0.0, (
                f"confidence {signal.confidence:.2f} < required {self.config.min_confidence:.2f}"
            )

        risk = abs(signal.price - signal.stop_loss)
        reward = abs(signal.take_profit - signal.price)
        if risk <= 0 or reward <= 0 or not math.isfinite(risk) or not math.isfinite(reward):
            return False, 0.0, "degenerate stop/target — refusing to trade"
        rr = reward / risk
        if rr < 1.5:
            return False, 0.0, f"risk:reward {rr:.2f} < required 1.50"

        for open_pos in self.open_positions:
            if open_pos.pair == signal.pair:
                return False, 0.0, (
                    f"already holding {open_pos.direction} {open_pos.lots} lots on {signal.pair} "
                    f"(ticket {open_pos.ticket})"
                )

        lots = self.calculate_position_size(signal.direction, signal.price, signal.stop_loss, signal.pair)
        if lots <= 0:
            return False, 0.0, "calculated lot size is zero — stop too wide for the risk budget"

        # verify (and if necessary reduce) realised risk
        projected = self.risk_dollars(lots, signal.price, signal.stop_loss, signal.pair)
        cap = self.current_balance * self.config.max_risk_per_trade
        while projected > cap and lots > 0.01:
            lots = round(lots - 0.01, 2)
            projected = self.risk_dollars(lots, signal.price, signal.stop_loss, signal.pair)
        if projected > cap:
            return False, 0.0, (
                f"minimum lot (0.01) still risks {projected:,.2f} > cap {cap:,.2f} — skip"
            )

        return True, lots, (
            f"approved {signal.direction} {lots} lots @ {signal.price:.5f} | "
            f"risk {projected:,.2f} USD ({projected / max(self.current_balance, 1e-9):.2%} of equity) "
            f"| RR {rr:.2f} | conf {signal.confidence:.2f}"
        )

    # ─────────────────────────────────────────────────────────────────
    # Bookkeeping
    # ─────────────────────────────────────────────────────────────────

    def register_position(self, position: Position) -> None:
        """Track a newly filled *position* and persist the state."""
        if any(p.ticket == position.ticket for p in self.open_positions):
            return
        self.open_positions.append(position)
        self._save_state()
        self.log.info(
            "TRACKING %s %s %.2f lots @ %.5f | SL %.5f | TP %.5f | ticket %s",
            position.direction, position.pair, position.lots, position.open_price,
            position.stop_loss, position.take_profit, position.ticket,
        )

    def remove_position(self, ticket: int) -> Optional[Position]:
        """Drop an open position (e.g. closed by the broker) without P&L."""
        for pos in list(self.open_positions):
            if pos.ticket == ticket:
                self.open_positions.remove(pos)
                self._save_state()
                return pos
        return None

    def record_close(self, pnl: float, position: Position, reason: str = "manual") -> float:
        """Book a realised *pnl* for a closed *position* and update limits.

        Args:
            pnl: Realised result in account currency (can be negative).
            position: The position that was closed.
            reason: ``"take_profit"`` / ``"stop_loss"`` / ``"manual"`` / …

        Returns:
            The P&L that was booked.
        """
        pnl = round(float(pnl), 2)
        self._reset_daily()
        self.daily_pnl = round(self.daily_pnl + pnl, 2)
        self.current_balance = round(self.current_balance + pnl, 2)
        self.peak_balance = max(self.peak_balance, self.current_balance)
        self.remove_position(position.ticket)
        self.trade_log.append(
            {
                "pair": position.pair,
                "direction": position.direction,
                "lots": position.lots,
                "open_price": position.open_price,
                "close_price": position.open_price,  # refined by caller when known
                "stop_loss": position.stop_loss,
                "take_profit": position.take_profit,
                "open_time": position.open_time,
                "close_time": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "ticket": position.ticket,
                "pnl": pnl,
                "exit": reason,
                "balance_after": self.current_balance,
            }
        )
        self._save_state()
        self.log.info(
            "CLOSED %s %s ticket %s -> %+.2f USD | day %+.2f | balance %.2f | drawdown %.2f%%%s",
            position.direction, position.pair, position.ticket, pnl, self.daily_pnl,
            self.current_balance, self.drawdown_pct() * 100,
            " | HALTED" if self.halted else "",
        )
        return pnl

    def mark_balance(self, balance: float) -> None:
        """Sync equity from the broker; raises the peak, never lowers it."""
        try:
            value = float(balance)
        except (TypeError, ValueError):
            return
        if value > 0 and math.isfinite(value):
            self.current_balance = round(value, 2)
            self.peak_balance = max(self.peak_balance, self.current_balance)
            self._save_state()

    def drawdown_pct(self) -> float:
        """Peak-to-trough equity drawdown as a positive fraction."""
        if self.peak_balance <= 0:
            return 0.0
        return max(0.0, (self.peak_balance - self.current_balance) / self.peak_balance)

    def stats(self) -> Dict[str, Any]:
        """Summary dict used by the banner and the status log line."""
        wins = [t for t in self.trade_log if t["pnl"] > 0]
        losses = [t for t in self.trade_log if t["pnl"] <= 0]
        total = len(self.trade_log)
        return {
            "balance": round(self.current_balance, 2),
            "peak_balance": round(self.peak_balance, 2),
            "daily_pnl": round(self.daily_pnl, 2),
            "drawdown_pct": round(self.drawdown_pct() * 100, 2),
            "open_positions": len(self.open_positions),
            "closed_trades": total,
            "win_rate_pct": round(100.0 * len(wins) / total, 1) if total else 0.0,
            "gross_profit": round(sum(t["pnl"] for t in wins), 2),
            "gross_loss": round(sum(t["pnl"] for t in losses), 2),
            "halted": self.halted,
            "halt_reason": self.halt_reason,
        }

    def reset_halt(self, reason: str = "manual") -> None:
        """Manually clear a latch after a human has reviewed the damage."""
        self.halted = False
        self.halt_reason = ""
        self.peak_balance = max(self.peak_balance, self.current_balance)
        self._save_state()
        self.log.warning("Halt cleared (%s). Balance %.2f, peak %.2f.", reason, self.current_balance, self.peak_balance)

    # ─────────────────────────────────────────────────────────────────
    # Persistence
    # ─────────────────────────────────────────────────────────────────

    def _reset_daily(self, now: Optional[datetime] = None) -> None:
        """Zero ``daily_pnl`` when the UTC date rolls over."""
        today = self._today(now)
        if today != self.daily_date:
            if self.daily_pnl != 0.0:
                self.log.info("New UTC day %s — daily P&L reset from %+.2f", today, self.daily_pnl)
            self.daily_date = today
            self.daily_pnl = 0.0
            if self.halted and self.halt_reason.startswith("daily loss"):
                self.halted = False
                self.halt_reason = ""
                self.log.info("Daily-loss halt cleared by the UTC day rollover.")
            self._save_state()

    @staticmethod
    def _today(now: Optional[datetime] = None) -> str:
        """Current UTC date as ``YYYY-MM-DD``."""
        return (now or datetime.now(timezone.utc)).astimezone(timezone.utc).date().isoformat()

    def _save_state(self) -> None:
        """Atomically write the full state to ``bot_state.json``."""
        payload = {
            "saved_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "daily_date": self.daily_date,
            "daily_pnl": self.daily_pnl,
            "current_balance": self.current_balance,
            "peak_balance": self.peak_balance,
            "halted": self.halted,
            "halt_reason": self.halt_reason,
            "open_positions": [p.to_dict() for p in self.open_positions],
            "trade_log": self.trade_log[-500:],
            "config": {
                "max_risk_per_trade": self.config.max_risk_per_trade,
                "max_daily_loss": self.config.max_daily_loss,
                "max_drawdown_limit": self.config.max_drawdown_limit,
                "max_open_positions": self.config.max_open_positions,
                "min_confidence": self.config.min_confidence,
                "pairs": self.config.pairs,
                "timeframe": self.config.timeframe,
            },
        }
        try:
            self.state_file.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.state_file.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
            tmp.replace(self.state_file)
        except OSError as exc:
            self.log.error("Could not persist state to %s: %s", self.state_file, exc)

    def load_state(self) -> bool:
        """Restore state from ``bot_state.json`` if it exists.

        Returns:
            ``True`` when a file was found and applied (stale files older
            than one UTC day keep balances but reset ``daily_pnl``).
        """
        if not self.state_file.exists():
            self._save_state()
            return False
        try:
            raw = json.loads(self.state_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            self.log.error("State file unreadable (%s) — starting fresh.", exc)
            return False

        self.daily_pnl = float(raw.get("daily_pnl", 0.0))
        self.daily_date = str(raw.get("daily_date", self._today()))
        self.current_balance = float(raw.get("current_balance", self.current_balance))
        self.peak_balance = max(float(raw.get("peak_balance", 0.0)), self.current_balance)
        self.halted = bool(raw.get("halted", False))
        self.halt_reason = str(raw.get("halt_reason", ""))
        self.trade_log = list(raw.get("trade_log", []))
        positions = []
        for item in raw.get("open_positions", []):
            try:
                positions.append(Position.from_dict(item))
            except (TypeError, KeyError) as exc:
                self.log.warning("Skipping malformed persisted position %s: %s", item, exc)
        self.open_positions = positions
        self._reset_daily()
        self.log.info(
            "State restored: balance %.2f, day P&L %+.2f, %d open, halted=%s",
            self.current_balance, self.daily_pnl, len(self.open_positions), self.halted,
        )
        return True
