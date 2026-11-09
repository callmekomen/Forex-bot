"""
Tests for the demo-only account lock, gamble feed connection, preflight.

The lock is the last line between "testing on demo" and wiring this
thing to real money by accident, so every branch gets pinned: demo
passes, contest (virtual money) passes, REAL is refused, *unknown*
is refused, and only an explicit opt-in unlocks real accounts.

Run:  python -m pytest forex_bot/tests/test_demo_safety.py -q
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from config import BotConfig  # noqa: E402
from data_feed import DataFeedError, ForexDataFeed, MockDataFeed  # noqa: E402
from demo_check import run_checks  # noqa: E402
from gamble import GambleEngine, GambleLedger, GambleRequest  # noqa: E402
from risk_manager import Position, RiskManager  # noqa: E402
from strategy import AdvancedStrategy, Signal, TradeSignal  # noqa: E402

NOON = datetime.now(timezone.utc).replace(hour=12, minute=0, second=0, microsecond=0)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FXBOT_ALLOW_REAL_ACCOUNT", raising=False)
    monkeypatch.delenv("FXBOT_MT5_LOGIN", raising=False)
    monkeypatch.delenv("FXBOT_MT5_SERVER", raising=False)


@pytest.fixture()
def config(tmp_path: Path) -> BotConfig:
    cfg = BotConfig(pairs=["EUR/USD"])
    cfg.state_file = tmp_path / "state.json"
    cfg.log_dir = tmp_path
    return cfg


# ── fake MT5 terminal ─────────────────────────────────────────────────


def make_account(trade_mode=0, with_trade_mode: bool = True, balance: float = 10_000.0):
    acct = SimpleNamespace(
        login=12345678, server="Broker-Demo", currency="USD", balance=balance,
        equity=balance, leverage=100, company="Broker LLC",
        trade_allowed=True, trade_expert=True,
    )
    if with_trade_mode:
        acct.trade_mode = trade_mode
    return acct


class FakeMT5:
    """Just enough of the MetaTrader5 module for ForexDataFeed."""

    def __init__(self, account) -> None:
        self._account = account
        self.shutdown_called = False

    def initialize(self, **kwargs) -> bool:
        return True

    def terminal_info(self):
        return SimpleNamespace(name="MetaTrader 5", build=4150, trade_allowed=True)

    def account_info(self):
        return self._account

    def symbol_select(self, symbol: str, flag: bool) -> bool:
        return True

    def shutdown(self) -> None:
        self.shutdown_called = True

    def last_error(self):
        return (0, "ok")


# ── the demo-only lock ────────────────────────────────────────────────


class TestDemoOnlyLock:
    def test_demo_account_connects(self, config: BotConfig):
        feed = ForexDataFeed(config, api=FakeMT5(make_account(trade_mode=0)))
        feed.initialize()
        assert feed.connected is True
        assert feed.account_fingerprint["account_kind"] == "demo"
        assert feed.account_fingerprint["is_demo"] is True

    def test_contest_account_connects_its_virtual_money(self, config: BotConfig):
        feed = ForexDataFeed(config, api=FakeMT5(make_account(trade_mode=1)))
        feed.initialize()
        assert feed.account_fingerprint["account_kind"] == "contest"

    def test_real_account_is_refused_and_disconnected(self, config: BotConfig):
        fake = FakeMT5(make_account(trade_mode=2))
        feed = ForexDataFeed(config, api=fake)
        with pytest.raises(DataFeedError, match="REAL ACCOUNT"):
            feed.initialize()
        assert feed.connected is False
        assert fake.shutdown_called is True

    def test_unknown_account_kind_fails_closed(self, config: BotConfig):
        feed = ForexDataFeed(config, api=FakeMT5(make_account(with_trade_mode=False)))
        with pytest.raises(DataFeedError, match="ACCOUNT KIND UNKNOWN"):
            feed.initialize()
        assert feed.connected is False

    def test_real_account_only_with_explicit_opt_in(self, config: BotConfig):
        config.allow_real_account = True
        feed = ForexDataFeed(config, api=FakeMT5(make_account(trade_mode=2)))
        feed.initialize()
        assert feed.connected is True
        assert feed.account_fingerprint["account_kind"] == "real"

    def test_env_var_unlocks(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("FXBOT_ALLOW_REAL_ACCOUNT", "1")
        assert BotConfig().allow_real_account is True
        monkeypatch.setenv("FXBOT_ALLOW_REAL_ACCOUNT", "0")
        assert BotConfig().allow_real_account is False
        monkeypatch.delenv("FXBOT_ALLOW_REAL_ACCOUNT")
        assert BotConfig().allow_real_account is False  # default stays locked


# ── gamble feed connection (the dead --live path) ─────────────────────


def make_signal(pair: str = "EUR/USD") -> TradeSignal:
    return TradeSignal(
        signal=Signal.STRONG_BUY, pair=pair, price=1.1000, stop_loss=1.0970,
        take_profit=1.1060, confidence=0.90, reasons=["test"], score=4.5,
        indicators={"adx": 35.0},
    )


class NeedsInitFeed:
    """Mimics a real ForexDataFeed before initialize() has run."""

    def __init__(self, fail_with: Exception | None = None) -> None:
        self.connected = False
        self.fail_with = fail_with
        self.initialised = 0

    def initialize(self) -> None:
        self.initialised += 1
        if self.fail_with is not None:
            raise self.fail_with
        self.connected = True

    def get_candles(self, pair, num_bars=200):
        if not self.connected:
            raise DataFeedError("Data feed is not initialized — call initialize() first")
        return object()

    def get_latest_tick(self, pair):
        return {"bid": 1.0999, "ask": 1.1001, "time": NOON}


class FakeStrategy:
    def analyze(self, df, pair, price=None):
        return make_signal(pair)


class FakeBroker:
    paper = True

    def __init__(self) -> None:
        self.opened = []

    def open_trade(self, pair, direction, lots, sl, tp):
        pos = Position(
            pair=pair, direction=direction, lots=lots, open_price=1.1000,
            stop_loss=sl, take_profit=tp,
            open_time=datetime.now(timezone.utc).isoformat(), ticket=900_001,
        )
        self.opened.append(pos)
        return pos


class FakeBot:
    def __init__(self, config, risk, feed) -> None:
        self.config = config
        self.risk = risk
        self.feed = feed
        self.strategy = FakeStrategy()
        self.broker = FakeBroker()


def make_engine(config, tmp_path, feed) -> GambleEngine:
    risk = RiskManager(config, state_file=config.state_file)
    bot = FakeBot(config, risk, feed)
    return GambleEngine(bot, ledger=GambleLedger(tmp_path / "g.json", cooldown_minutes=0))


class TestGambleFeedConnection:
    def test_scan_initialises_an_unconnected_feed(self, config, tmp_path):
        feed = NeedsInitFeed()
        engine = make_engine(config, tmp_path, feed)
        ranking = engine.scan(GambleRequest())
        assert feed.initialised == 1
        assert ranking and ranking[0].is_a_plus

    def test_blocked_feed_refuses_cleanly_and_trades_nothing(self, config, tmp_path):
        feed = NeedsInitFeed(fail_with=DataFeedError("REAL ACCOUNT — refusing to trade"))
        engine = make_engine(config, tmp_path, feed)
        result = engine.hunt_once(GambleRequest(), now=NOON)
        assert result["ok"] is False and result["taken"] is False
        assert "feed not ready" in result["reason"] and "REAL ACCOUNT" in result["reason"]
        assert engine.bot.broker.opened == []

    def test_scan_propagates_connection_failure_loudly(self, config, tmp_path):
        feed = NeedsInitFeed(fail_with=DataFeedError("terminal gone"))
        engine = make_engine(config, tmp_path, feed)
        with pytest.raises(DataFeedError, match="terminal gone"):
            engine.scan(GambleRequest())


# ── read-only preflight ───────────────────────────────────────────────


class TestPreflight:
    def test_mock_feed_is_ready(self, config):
        feed = MockDataFeed(config)
        result = run_checks(feed, config, strategy=AdvancedStrategy(config), now=NOON)
        assert result["ok"] is True
        statuses = {c["name"]: c["status"] for c in result["checks"]}
        assert statuses["terminal"] == "pass"
        assert statuses["market data"] == "pass"
        assert result["pairs"] and all(p["ok"] for p in result["pairs"])

    def test_blocked_terminal_fails_fast(self, config):
        class BlockedFeed(NeedsInitFeed):
            pass

        feed = BlockedFeed(fail_with=DataFeedError("REAL ACCOUNT — refusing to trade"))
        result = run_checks(feed, config, strategy=None, now=NOON)
        assert result["ok"] is False
        assert result["checks"][0]["status"] == "fail"
        assert "REAL ACCOUNT" in result["checks"][0]["detail"]

    def test_balance_mismatch_warns(self, config):
        mock = MockDataFeed(config)

        class RichDemoFeed:
            account_fingerprint = {
                "login": 12345678, "server": "Broker-Demo", "currency": "USD",
                "balance": 50_000.0, "company": "Broker", "verified": True,
                "account_kind": "demo", "is_demo": True, "trade_mode": 0,
            }

            def initialize(self): mock.initialize()
            def get_candles(self, pair, n=200): return mock.get_candles(pair, n)
            def get_latest_tick(self, pair): return mock.get_latest_tick(pair)

        result = run_checks(RichDemoFeed(), config, strategy=AdvancedStrategy(config), now=NOON)
        balance_checks = [c for c in result["checks"] if c["name"] == "balance sanity"]
        assert balance_checks and balance_checks[0]["status"] == "warn"
        assert "CONFIGURED number" in balance_checks[0]["detail"]
