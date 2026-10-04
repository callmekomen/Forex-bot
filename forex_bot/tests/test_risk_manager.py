"""
Tests for the risk manager — the component that stops you losing money.

Each gate gets an explicit test. These are the assertions that matter most
in the whole repo: a silent regression here is a blown account, not a
cosmetic bug.

Run:  python -m pytest forex_bot/tests -q
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from config import BotConfig  # noqa: E402
from risk_manager import Position, RiskManager  # noqa: E402
from strategy import Signal, TradeSignal  # noqa: E402


@pytest.fixture()
def config(tmp_path: Path) -> BotConfig:
    """Isolated config whose state file lives in a temp dir."""
    cfg = BotConfig()
    cfg.state_file = tmp_path / "state.json"
    cfg.log_dir = tmp_path
    cfg.account_balance = 10_000.0
    return cfg


@pytest.fixture()
def risk(config: BotConfig) -> RiskManager:
    """A fresh risk manager with no history."""
    return RiskManager(config, state_file=config.state_file)


def make_signal(
    pair: str = "EUR/USD",
    direction: Signal = Signal.BUY,
    price: float = 1.1000,
    sl: float = 1.0970,
    tp: float = 1.1060,
    confidence: float = 0.8,
) -> TradeSignal:
    """Build a well-formed, approvable signal to mutate per test."""
    return TradeSignal(
        signal=direction, pair=pair, price=price, stop_loss=sl, take_profit=tp,
        confidence=confidence, reasons=["test"], score=3.0,
    )


def make_position(ticket: int = 1, pair: str = "EUR/USD", lots: float = 0.1) -> Position:
    """A plausible open position."""
    return Position(
        pair=pair, direction="BUY", lots=lots, open_price=1.1000, stop_loss=1.0970,
        take_profit=1.1060, open_time=datetime.now(timezone.utc).isoformat(), ticket=ticket,
    )


#: Noon UTC *today*. It must track the real clock: RiskManager seeds its
#: day counter from datetime.now(), so a hard-coded past date would trip
#: the UTC-rollover reset and silently wipe daily_pnl mid-test.
TRADING_HOUR = datetime.now(timezone.utc).replace(hour=12, minute=0, second=0, microsecond=0)


# ── gate 1: can_trade ─────────────────────────────────────────────────


class TestCanTrade:
    def test_allows_trading_in_normal_conditions(self, risk: RiskManager):
        allowed, reason = risk.can_trade(TRADING_HOUR)
        assert allowed is True
        assert reason == "OK"

    def test_blocks_outside_trading_hours(self, risk: RiskManager):
        allowed, reason = risk.can_trade(TRADING_HOUR.replace(hour=3))
        assert allowed is False
        assert "trading hours" in reason

    def test_blocks_at_max_open_positions(self, risk: RiskManager, config: BotConfig):
        for i in range(config.max_open_positions):
            risk.register_position(make_position(ticket=i + 1, pair=f"P{i}/USD"))
        allowed, reason = risk.can_trade(TRADING_HOUR)
        assert allowed is False
        assert "max open positions" in reason

    def test_daily_loss_latches_halt(self, risk: RiskManager, config: BotConfig):
        risk.daily_pnl = -(config.max_daily_loss_dollars + 1)
        allowed, _ = risk.can_trade(TRADING_HOUR)
        assert allowed is False
        assert risk.halted is True
        # the latch must persist even once the P&L is repaired
        risk.daily_pnl = 0.0
        allowed, reason = risk.can_trade(TRADING_HOUR)
        assert allowed is False
        assert "HALTED" in reason

    def test_drawdown_latches_halt(self, risk: RiskManager, config: BotConfig):
        risk.peak_balance = 10_000.0
        risk.current_balance = 10_000.0 * (1 - config.max_drawdown_limit) - 1
        allowed, _ = risk.can_trade(TRADING_HOUR)
        assert allowed is False
        assert risk.halted is True

    def test_depleted_balance_blocks(self, risk: RiskManager):
        risk.current_balance = 0.0
        allowed, reason = risk.can_trade(TRADING_HOUR)
        assert allowed is False
        assert "depleted" in reason

    def test_daily_halt_clears_on_utc_rollover(self, risk: RiskManager, config: BotConfig):
        risk.daily_pnl = -(config.max_daily_loss_dollars + 1)
        risk.can_trade(TRADING_HOUR)
        assert risk.halted is True
        allowed, _ = risk.can_trade(TRADING_HOUR + timedelta(days=1))
        assert risk.halted is False
        assert allowed is True

    def test_drawdown_halt_does_not_clear_on_rollover(self, risk: RiskManager, config: BotConfig):
        """A drawdown breach is structural — only a human should clear it."""
        risk.peak_balance = 10_000.0
        risk.current_balance = 1_000.0
        risk.can_trade(TRADING_HOUR)
        assert risk.halted is True
        risk.can_trade(TRADING_HOUR + timedelta(days=2))
        assert risk.halted is True


# ── gate 2: sizing ────────────────────────────────────────────────────


class TestPositionSizing:
    def test_risk_never_exceeds_configured_fraction(self, risk: RiskManager, config: BotConfig):
        lots = risk.calculate_position_size("BUY", 1.1000, 1.0970, "EUR/USD")
        risked = risk.risk_dollars(lots, 1.1000, 1.0970, "EUR/USD")
        assert risked <= config.account_balance * config.max_risk_per_trade + 0.01

    def test_rounds_down_not_up(self, risk: RiskManager):
        lots = risk.calculate_position_size("BUY", 1.1000, 1.0970, "EUR/USD")
        assert lots == pytest.approx(round(lots, 2))
        assert lots * 100 == int(lots * 100)

    def test_wider_stop_gives_smaller_size(self, risk: RiskManager):
        tight = risk.calculate_position_size("BUY", 1.1000, 1.0990, "EUR/USD")
        wide = risk.calculate_position_size("BUY", 1.1000, 1.0900, "EUR/USD")
        assert wide < tight

    def test_zero_stop_distance_fails_closed(self, risk: RiskManager):
        assert risk.calculate_position_size("BUY", 1.1000, 1.1000, "EUR/USD") == 0.0

    def test_jpy_pip_size_is_detected(self, risk: RiskManager):
        """0.01 pip size must not be treated as 0.0001, or size is 100x wrong."""
        usd = risk.calculate_position_size("BUY", 1.1000, 1.0970, "EUR/USD")
        jpy = risk.calculate_position_size("BUY", 150.00, 149.70, "USD/JPY")
        assert jpy == pytest.approx(usd, rel=0.2)

    def test_direction_does_not_change_size(self, risk: RiskManager):
        assert risk.calculate_position_size("BUY", 1.1, 1.097) == risk.calculate_position_size(
            "SELL", 1.1, 1.097
        )


# ── gate 3: validate_trade ────────────────────────────────────────────


class TestValidateTrade:
    def test_approves_a_good_signal(self, risk: RiskManager):
        approved, lots, reason = risk.validate_trade(make_signal(), now=TRADING_HOUR)
        assert approved is True
        assert lots > 0
        assert "approved" in reason

    def test_rejects_neutral(self, risk: RiskManager):
        sig = make_signal(direction=Signal.NEUTRAL)
        approved, lots, _ = risk.validate_trade(sig, now=TRADING_HOUR)
        assert approved is False and lots == 0.0

    def test_rejects_low_confidence(self, risk: RiskManager, config: BotConfig):
        sig = make_signal(confidence=config.min_confidence - 0.05)
        approved, _, reason = risk.validate_trade(sig, now=TRADING_HOUR)
        assert approved is False
        assert "confidence" in reason

    def test_rejects_poor_risk_reward(self, risk: RiskManager):
        sig = make_signal(price=1.1000, sl=1.0970, tp=1.1010)  # RR 0.33
        approved, _, reason = risk.validate_trade(sig, now=TRADING_HOUR)
        assert approved is False
        assert "risk:reward" in reason

    def test_rejects_duplicate_pair(self, risk: RiskManager):
        risk.register_position(make_position(pair="EUR/USD"))
        approved, _, reason = risk.validate_trade(make_signal(pair="EUR/USD"), now=TRADING_HOUR)
        assert approved is False
        assert "already holding" in reason

    def test_rejects_degenerate_stops(self, risk: RiskManager):
        sig = make_signal(price=1.1, sl=1.1, tp=1.1)
        approved, _, reason = risk.validate_trade(sig, now=TRADING_HOUR)
        assert approved is False
        assert "degenerate" in reason

    def test_halt_blocks_validation_entirely(self, risk: RiskManager):
        risk.halted = True
        risk.halt_reason = "test"
        approved, lots, _ = risk.validate_trade(make_signal(), now=TRADING_HOUR)
        assert approved is False and lots == 0.0

    def test_approved_lots_respect_the_cap(self, risk: RiskManager, config: BotConfig):
        approved, lots, _ = risk.validate_trade(make_signal(), now=TRADING_HOUR)
        assert approved
        risked = risk.risk_dollars(lots, 1.1000, 1.0970, "EUR/USD")
        assert risked <= config.account_balance * config.max_risk_per_trade + 0.01


# ── bookkeeping and persistence ───────────────────────────────────────


class TestBookkeeping:
    def test_record_close_updates_balance_and_daily(self, risk: RiskManager):
        pos = make_position()
        risk.register_position(pos)
        start = risk.current_balance
        risk.record_close(-150.0, pos, reason="stop")
        assert risk.current_balance == pytest.approx(start - 150.0)
        assert risk.daily_pnl == pytest.approx(-150.0)
        assert len(risk.open_positions) == 0

    def test_peak_tracks_up_only(self, risk: RiskManager):
        pos = make_position()
        risk.register_position(pos)
        risk.record_close(500.0, pos)
        peak = risk.peak_balance
        pos2 = make_position(ticket=2)
        risk.register_position(pos2)
        risk.record_close(-200.0, pos2)
        assert risk.peak_balance == pytest.approx(peak)

    def test_duplicate_ticket_is_not_registered_twice(self, risk: RiskManager):
        risk.register_position(make_position(ticket=7))
        risk.register_position(make_position(ticket=7))
        assert len(risk.open_positions) == 1

    def test_state_survives_restart(self, risk: RiskManager, config: BotConfig):
        risk.register_position(make_position(ticket=42))
        risk.halted = True
        risk.halt_reason = "drawdown"
        risk._save_state()

        revived = RiskManager(config, state_file=config.state_file)
        revived.load_state()
        assert revived.halted is True
        assert revived.halt_reason == "drawdown"
        assert any(p.ticket == 42 for p in revived.open_positions)

    def test_reset_halt_clears_the_latch(self, risk: RiskManager):
        risk.halted = True
        risk.halt_reason = "x"
        risk.reset_halt()
        assert risk.halted is False
        allowed, _ = risk.can_trade(TRADING_HOUR)
        assert allowed is True
