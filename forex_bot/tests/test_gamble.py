"""
Tests for gamble mode — the button must refuse bad bets, cap every
stake, lock itself out after losses, and never bypass the risk gate.

Run:  python -m pytest forex_bot/tests/test_gamble.py -q
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from config import BotConfig  # noqa: E402
from gamble import (  # noqa: E402
    GambleEngine,
    GambleLedger,
    GambleRequest,
    breakeven_win_rate,
    edge_score,
    evaluate_candidate,
    rank_candidates,
)
from risk_manager import Position, RiskManager  # noqa: E402
from strategy import Signal, TradeSignal  # noqa: E402

NOON = datetime.now(timezone.utc).replace(hour=12, minute=0, second=0, microsecond=0)

GATE = dict(min_confidence=0.70, min_risk_reward=1.8, min_adx=20.0, min_edge_score=68.0)


def make_signal(**overrides) -> TradeSignal:
    """An A+ quality signal; mutate one field per test to break one gate."""
    base = dict(
        signal=Signal.STRONG_BUY, pair="EUR/USD", price=1.1000,
        stop_loss=1.0970, take_profit=1.1060, confidence=0.90,
        reasons=["test"], score=4.5,
        indicators={"adx": 35.0, "rsi": 62.0, "atr": 0.002},
    )
    base.update(overrides)
    return TradeSignal(**base)


@pytest.fixture()
def config(tmp_path: Path) -> BotConfig:
    cfg = BotConfig()
    cfg.state_file = tmp_path / "state.json"
    cfg.log_dir = tmp_path
    return cfg


@pytest.fixture()
def risk(config: BotConfig) -> RiskManager:
    return RiskManager(config, state_file=config.state_file)


# ── edge scoring & the A+ gate ────────────────────────────────────────


class TestEdgeGate:
    def test_breakeven_win_rate_at_1_to_2(self):
        assert breakeven_win_rate(2.0) == pytest.approx(1 / 3, abs=1e-3)
        assert breakeven_win_rate(1.0) == 0.5
        assert breakeven_win_rate(0) == 1.0

    def test_strong_signal_is_a_plus(self):
        cand = evaluate_candidate(make_signal(), **GATE)
        assert cand.is_a_plus is True
        assert cand.grade == "A+"
        assert cand.failed == []
        assert cand.edge_score >= GATE["min_edge_score"]

    def test_low_confidence_is_refused(self):
        cand = evaluate_candidate(make_signal(confidence=0.61, score=2.0), **GATE)
        assert cand.is_a_plus is False
        assert any("confidence" in f for f in cand.failed)

    def test_weak_trend_is_refused(self):
        sig = make_signal(indicators={"adx": 12.0})
        cand = evaluate_candidate(sig, **GATE)
        assert cand.is_a_plus is False
        assert any("ADX" in f for f in cand.failed)

    def test_poor_risk_reward_is_refused(self):
        cand = evaluate_candidate(make_signal(take_profit=1.1020), **GATE)  # RR 0.67
        assert cand.is_a_plus is False
        assert any("risk:reward" in f for f in cand.failed)

    def test_neutral_is_never_a_plus(self):
        sig = make_signal(signal=Signal.NEUTRAL, stop_loss=0.0, take_profit=0.0, confidence=0.0, score=0.4)
        cand = evaluate_candidate(sig, **GATE)
        assert cand.is_a_plus is False
        assert edge_score(sig) < GATE["min_edge_score"]

    def test_missing_adx_fails_closed(self):
        cand = evaluate_candidate(make_signal(indicators={}), **GATE)
        assert cand.is_a_plus is False
        assert any("ADX unavailable" in f for f in cand.failed)

    def test_ranking_puts_best_edge_first(self):
        strong = make_signal(pair="EUR/USD")
        weak = make_signal(pair="GBP/USD", confidence=0.72, score=2.0, indicators={"adx": 21.0})
        ranked = rank_candidates([weak, strong], **GATE)
        assert ranked[0].pair == "EUR/USD"
        assert ranked[0].edge_score > ranked[1].edge_score


# ── stake caps inside the risk manager ────────────────────────────────


class TestStakeCaps:
    def test_gamble_stake_can_exceed_normal_risk_but_not_5pct(self, risk: RiskManager, config: BotConfig):
        approved, lots, _ = risk.validate_trade(make_signal(), now=NOON, risk_fraction=0.50)
        assert approved is True
        risked = risk.risk_dollars(lots, 1.1000, 1.0970, "EUR/USD")
        assert risked <= config.account_balance * 0.05 + 0.01
        assert risked > config.account_balance * config.max_risk_per_trade  # bigger than normal loop

    def test_normal_path_unchanged(self, risk: RiskManager, config: BotConfig):
        approved, lots, _ = risk.validate_trade(make_signal(), now=NOON)
        assert approved is True
        risked = risk.risk_dollars(lots, 1.1000, 1.0970, "EUR/USD")
        assert risked <= config.account_balance * config.max_risk_per_trade + 0.01

    def test_stake_clamped_to_remaining_daily_budget(self, risk: RiskManager, config: BotConfig):
        # $450 already lost today of a $500 budget → at most $50 further risk.
        risk.daily_pnl = -(config.max_daily_loss_dollars - 50)
        approved, lots, _ = risk.validate_trade(make_signal(), now=NOON, risk_fraction=0.05)
        risked = risk.risk_dollars(lots, 1.1000, 1.0970, "EUR/USD")
        assert risked <= 50 + 0.01

    def test_halt_still_blocks_gamble_stake(self, risk: RiskManager):
        risk.halted = True
        risk.halt_reason = "test halt"
        approved, lots, reason = risk.validate_trade(make_signal(), now=NOON, risk_fraction=0.02)
        assert approved is False and lots == 0.0
        assert "HALTED" in reason

    def test_invalid_stake_fails_closed(self, risk: RiskManager):
        approved, lots, _ = risk.validate_trade(make_signal(), now=NOON, risk_fraction=float("nan"))
        assert approved is False and lots == 0.0


# ── ledger lockouts ───────────────────────────────────────────────────


class TestLedger:
    def test_daily_budget_locks(self, tmp_path: Path):
        ledger = GambleLedger(tmp_path / "g.json", max_per_day=2, max_losses_per_day=2, cooldown_minutes=0)
        for ticket in (1, 2):
            ledger.record_open(ticket, now=NOON)
            ledger.record_result(100.0, ticket, now=NOON)
        allowed, reason = ledger.can_gamble(NOON)
        assert allowed is False and "budget" in reason

    def test_one_open_gamble_at_a_time(self, tmp_path: Path):
        ledger = GambleLedger(tmp_path / "g.json", cooldown_minutes=0)
        ledger.record_open(42, now=NOON)
        allowed, reason = ledger.can_gamble(NOON)
        assert allowed is False and "already open" in reason

    def test_loss_limit_locks_no_revenge(self, tmp_path: Path):
        ledger = GambleLedger(tmp_path / "g.json", max_per_day=5, max_losses_per_day=2, cooldown_minutes=0)
        for ticket in (1, 2):
            ledger.record_open(ticket, now=NOON)
            ledger.record_result(-200.0, ticket, now=NOON)
        allowed, reason = ledger.can_gamble(NOON)
        assert allowed is False and "losing gambles" in reason

    def test_cooldown_after_loss(self, tmp_path: Path):
        ledger = GambleLedger(tmp_path / "g.json", max_per_day=5, max_losses_per_day=5, cooldown_minutes=30)
        ledger.record_open(1, now=NOON)
        ledger.record_result(-100.0, 1, now=NOON)
        assert ledger.can_gamble(NOON + timedelta(minutes=10))[0] is False
        assert ledger.can_gamble(NOON + timedelta(minutes=31))[0] is True

    def test_lockout_survives_restart(self, tmp_path: Path):
        path = tmp_path / "g.json"
        first = GambleLedger(path, max_per_day=1, cooldown_minutes=0)
        first.record_open(7, now=NOON)
        first.record_result(-50.0, 7, now=NOON)
        second = GambleLedger(path, max_per_day=1, cooldown_minutes=0)
        assert second.taken == 1 and second.losses == 1
        assert second.can_gamble(NOON)[0] is False

    def test_new_day_resets_budget(self, tmp_path: Path):
        ledger = GambleLedger(tmp_path / "g.json", max_per_day=1, cooldown_minutes=0)
        ledger.record_open(1, now=NOON)
        ledger.record_result(-50.0, 1, now=NOON)
        assert ledger.can_gamble(NOON + timedelta(days=1))[0] is True


# ── engine: one trade, through the real gates ─────────────────────────


class FakeFeed:
    def get_candles(self, pair, num_bars=200):
        return object()  # strategy is faked; candles are never inspected


class FakeStrategy:
    def __init__(self, signals):
        self.signals = signals

    def analyze(self, df, pair, price=None):
        return self.signals[pair]


class FakeBroker:
    paper = True

    def __init__(self):
        self.opened = []

    def open_trade(self, pair, direction, lots, sl, tp):
        pos = Position(
            pair=pair, direction=direction, lots=lots, open_price=1.1000,
            stop_loss=sl, take_profit=tp,
            open_time=datetime.now(timezone.utc).isoformat(), ticket=900_001 + len(self.opened),
        )
        self.opened.append(pos)
        return pos

    def sync_stops(self, position, sl, tp):
        position.stop_loss, position.take_profit = sl, tp
        return True


class FakeBot:
    def __init__(self, config, risk, signals):
        self.config = config
        self.risk = risk
        self.feed = FakeFeed()
        self.strategy = FakeStrategy(signals)
        self.broker = FakeBroker()


def make_engine(config, risk, tmp_path, signals) -> GambleEngine:
    bot = FakeBot(config, risk, signals)
    ledger = GambleLedger(tmp_path / "g.json", cooldown_minutes=0)
    return GambleEngine(bot, ledger=ledger)


class TestEngine:
    def test_takes_exactly_one_a_plus_trade(self, config, risk, tmp_path):
        signals = {
            "EUR/USD": make_signal(pair="EUR/USD"),
            "GBP/USD": make_signal(pair="GBP/USD", confidence=0.99, score=5.0),
            "USD/JPY": make_signal(pair="USD/JPY", signal=Signal.NEUTRAL, confidence=0.0, score=0.1, stop_loss=0.0, take_profit=0.0),
        }
        engine = make_engine(config, risk, tmp_path, signals)
        result = engine.hunt_once(GambleRequest(risk_fraction=0.02), now=NOON)
        assert result["taken"] is True
        assert result["candidate"]["pair"] == "GBP/USD"  # highest edge wins
        assert len(engine.bot.broker.opened) == 1
        assert len(risk.open_positions) == 1
        assert engine.ledger.taken == 1 and engine.ledger.open_ticket is not None

    def test_no_a_plus_no_bet(self, config, risk, tmp_path):
        signals = {p: make_signal(pair=p, confidence=0.65, score=2.0, indicators={"adx": 18.0}) for p in config.pairs}
        engine = make_engine(config, risk, tmp_path, signals)
        result = engine.hunt_once(GambleRequest(), now=NOON)
        assert result["taken"] is False
        assert "no A+ setup" in result["reason"]
        assert engine.bot.broker.opened == []

    def test_scan_only_never_trades(self, config, risk, tmp_path):
        signals = {p: make_signal(pair=p) for p in config.pairs}
        engine = make_engine(config, risk, tmp_path, signals)
        result = engine.hunt_once(GambleRequest(), now=NOON, execute=False)
        assert result["taken"] is False
        assert engine.bot.broker.opened == []

    def test_halted_bot_refuses(self, config, risk, tmp_path):
        risk.halted = True
        risk.halt_reason = "drawdown"
        signals = {p: make_signal(pair=p) for p in config.pairs}
        engine = make_engine(config, risk, tmp_path, signals)
        result = engine.hunt_once(GambleRequest(), now=NOON)
        assert result["taken"] is False
        assert engine.bot.broker.opened == []

    def test_second_press_while_open_is_refused(self, config, risk, tmp_path):
        signals = {p: make_signal(pair=p) for p in config.pairs}
        engine = make_engine(config, risk, tmp_path, signals)
        assert engine.hunt_once(GambleRequest(), now=NOON)["taken"] is True
        again = engine.hunt_once(GambleRequest(), now=NOON)
        assert again["taken"] is False
        assert len(engine.bot.broker.opened) == 1

    def test_breakeven_protection_at_1r(self, config, risk, tmp_path):
        signals = {p: make_signal(pair=p) for p in config.pairs}
        engine = make_engine(config, risk, tmp_path, signals)
        pos = Position(
            pair="EUR/USD", direction="BUY", lots=0.5, open_price=1.1000,
            stop_loss=1.0970, take_profit=1.1060,
            open_time=datetime.now(timezone.utc).isoformat(), ticket=1,
        )
        assert engine.maybe_protect_breakeven(pos, 1.1010) is False  # +0.33R
        assert pos.stop_loss == 1.0970
        assert engine.maybe_protect_breakeven(pos, 1.1030) is True   # +1R
        assert pos.stop_loss == pytest.approx(1.1000)
        assert engine.r_multiple(pos, 1.1060) == pytest.approx(2.0, abs=0.01)
