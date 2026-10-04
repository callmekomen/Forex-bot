"""
main.py — entry point: the live trading loop of the forex bot.
════════════════════════════════════════════════════════════════════════

╔══════════════════════════════════════════════════════════════════════╗
║  RISK WARNING                                                         ║
║  Trading leveraged FX carries a high risk of loss and is NOT suitable ║
║  for every investor. This software is educational automation, not     ║
║  financial advice. Nothing here guarantees profit; past backtested    ║
║  performance does not predict live results. Spreads, slippage,         ║
║  requotes, swap, broker outages and weekend gaps are NOT fully modelled║
║  by the backtester.                                                   ║
║  ALWAYS run this on a DEMO account first, keep max_risk_per_trade low,║
║  and never trade money you cannot afford to lose in full. The authors ║
║  accept no liability for trading losses incurred by using this code.  ║
╚══════════════════════════════════════════════════════════════════════╝

Usage
─────
    python main.py                     # live/demo MT5 loop
    python main.py --mock              # synthetic feed + paper fills (no MT5)
    python main.py --once              # single tick, then exit (smoke test)
    python main.py --ticks 5           # five ticks, then exit
    python main.py --backtest          # historical report, then exit
    python main.py --self-test         # risk-engine sanity checks
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime, timezone
from typing import Dict, List, Optional

import pandas as pd

from backtester import Backtester
from broker import Broker
from config import BOT_COMMENT, BOT_MAGIC, BotConfig
from data_feed import CandleSource, DataFeedError, ForexDataFeed, MockDataFeed
from logger import get_logger, setup_logger
from risk_manager import RiskManager
from strategy import AdvancedStrategy

BANNER = "FOREX ALGORITHMIC TRADING BOT — multi-indicator confluence + hard risk gates"


class ForexBot:
    """Owns the components and the tick loop; contains no risk policy itself."""

    def __init__(
        self,
        config: Optional[BotConfig] = None,
        feed: Optional[CandleSource] = None,
        broker: Optional[Broker] = None,
    ) -> None:
        """Build config → feed → strategy → risk → broker, in dependency order.

        Args:
            config: Override config (defaults to :data:`config.DEFAULT_CONFIG`).
            feed: Injectable data source. Pass a :class:`MockDataFeed` (or any
                object with ``get_candles``/``get_latest_tick``) in unit tests.
            broker: Injectable execution layer, so tests can assert on orders
                without touching a terminal.
        """
        self.config = config or BotConfig()
        setup_logger(log_dir=self.config.log_dir)
        self.log = get_logger("bot")
        self.feed: CandleSource = feed if feed is not None else ForexDataFeed(self.config)
        self.strategy = AdvancedStrategy(self.config)
        self.risk = RiskManager(self.config)
        self.broker = broker or Broker(self.config, self.feed)
        self.running: bool = False
        self.paused: bool = bool(getattr(config, "start_paused", False))
        self.telegram = None
        self.ticks: int = 0
        self.signals_seen: int = 0
        self.rejected: int = 0
        self.last_status: str = "booting"

    # ── remote control ────────────────────────────────────────────────

    def attach_telegram(self) -> bool:
        """Enable the Telegram gateway (start / stop / status from a phone).

        Returns:
            ``True`` when a token is configured and the gateway was created.
        """
        try:
            from telegram_control import TelegramGateway
        except ImportError as exc:  # pragma: no cover - missing file
            self.log.error("Telegram module unavailable (%s) — running without remote control.", exc)
            return False
        self.telegram = TelegramGateway(self.config, self)
        return self.telegram.start()

    def start_now(self) -> None:
        """Un-pause the loop — this is what ``/start`` calls."""
        if self.risk.halted:
            self.log.warning("/start ignored: a halt is latched. Clear it via /resume after review.")
            return
        self.paused = False
        self.log.info("▶ Loop un-paused by operator — analysing from the next tick.")

    def stop_now(self, reason: str = "operator") -> None:
        """Stop the loop gracefully after the current tick (``/stop``)."""
        self.paused = False
        self.running = False
        self.log.warning("⏹ Loop stopping (reason: %s). Open positions keep their SL/TP.", reason)

    # ── lifecycle ─────────────────────────────────────────────────────

    def run(self, max_ticks: Optional[int] = None) -> None:
        """Start the loop: connect, banner, then tick every ``tick_interval``.

        Runs until :meth:`stop_now` (Telegram ``/stop``) or ``Ctrl+C``. When the
        bot was started with ``start_paused`` the loop idles — connected, ready,
        not trading — until ``/start`` arrives.

        Args:
            max_ticks: Stop after N ticks (``--once`` / ``--ticks N``). ``None``
                means run until interrupted.
        """
        self._print_banner()
        if self.telegram is not None and self.paused:
            print("💤 ARMED, PAUSED — send /start from an authorised Telegram chat to begin trading.\n")
        self.running = True
        try:
            while self.running:
                started = time.time()
                if self.paused:
                    self.last_status = "armed, paused — waiting for /start"
                    time.sleep(max(1.0, min(5.0, self.config.tick_interval)))
                    continue
                try:
                    if self._ensure_connected():
                        self._tick()
                    else:
                        self.last_status = "waiting for the MT5 terminal"
                        self.log.warning(
                            "Terminal unavailable — retrying in %ds. The loop stays alive; open positions "
                            "remain under the broker's own SL/TP.",
                            self.config.connect_retry_seconds,
                        )
                except DataFeedError as exc:
                    self.log.error("Data feed error: %s — will reconnect on the next tick.", exc)
                    if isinstance(self.feed, ForexDataFeed):
                        self.feed.connected = False
                    self.last_status = f"feed error: {exc}"
                except Exception as exc:  # never let one bad tick kill the loop
                    self.log.exception("Tick failed: %s", exc)
                    self.last_status = f"error: {exc}"
                self.ticks += 1
                if max_ticks is not None and self.ticks >= max_ticks:
                    self.log.info("Completed %d tick(s) — stopping as requested.", self.ticks)
                    break
                elapsed = time.time() - started
                time.sleep(max(1.0, self.config.tick_interval - elapsed))
        except KeyboardInterrupt:
            self.log.warning("KeyboardInterrupt — shutting down after %d ticks.", self.ticks)
        finally:
            self.stop()

    def stop(self) -> None:
        """Stop the loop and release the terminal connection."""
        self.running = False
        if hasattr(self.feed, "shutdown"):
            try:
                self.feed.shutdown()  # type: ignore[attr-defined]
            except Exception as exc:
                self.log.warning("feed shutdown error: %s", exc)
        stats = self.risk.stats()
        self.log.info(
            "Final state — balance %.2f | closed %d trades | open %d | %s",
            stats["balance"], stats["closed_trades"], stats["open_positions"],
            "HALTED" if stats["halted"] else "active",
        )

    # ── connectivity ──────────────────────────────────────────────────

    def _connect(self) -> bool:
        """Try to (re)initialize the MT5 feed; never raise, never quit.

        Returns:
            ``True`` when the terminal answered and symbols are selected.
        """
        if not isinstance(self.feed, ForexDataFeed):
            return True
        try:
            self.feed.initialize()
            self.log.info("MT5 feed connected — running.")
            return True
        except DataFeedError as exc:
            self.log.error("Connect failed: %s", exc)
        except Exception as exc:  # pragma: no cover - defensive
            self.log.exception("Unexpected error while connecting: %s", exc)
        self.feed.connected = False  # type: ignore[attr-defined]
        time.sleep(self.config.connect_retry_seconds)
        return False

    def _ensure_connected(self) -> bool:
        """Lazy reconnect hook — mock/paper feeds are always 'connected'."""
        if not isinstance(self.feed, ForexDataFeed):
            return True
        if getattr(self.feed, "connected", False):
            return True
        return self._connect()

    # ── one iteration ─────────────────────────────────────────────────

    def _tick(self) -> None:
        """Manage open exposure, then scan every pair for a new signal."""
        now = datetime.now(timezone.utc)
        self._manage_positions(now)

        allowed, reason = self.risk.can_trade(now)
        if not allowed:
            self.last_status = reason
            self.log.info("No analysis this tick — %s", reason)
            return

        for pair in self.config.pairs:
            self._analyze_pair(pair, now)

        stats = self.risk.stats()
        self.last_status = (
            f"{self.ticks + 1} ticks | balance {stats['balance']:,.2f} | "
            f"{stats['open_positions']} open | day {stats['daily_pnl']:+,.2f}"
        )
        self.log.info("Tick %d done — %s", self.ticks + 1, self.last_status)

    def _analyze_pair(self, pair: str, now: datetime) -> None:
        """Fetch history, score it, gate it, and (maybe) execute it."""
        try:
            df: pd.DataFrame = self.feed.get_candles(pair, self.config.candles_per_call)
        except Exception as exc:
            self.log.error("%s: data fetch failed — %s", pair, exc)
            return
        if df is None or len(df) < self.config.min_bars:
            self.log.warning("%s: only %s bars — need %d, skipping", pair, 0 if df is None else len(df), self.config.min_bars)
            return

        try:
            signal = self.strategy.analyze(df, pair)
        except Exception as exc:
            self.log.exception("%s: strategy error — %s", pair, exc)
            return

        if not signal.signal.actionable:
            self.log.debug("%s: NEUTRAL (score %.2f) — nothing to do", pair, signal.score)
            return

        self.signals_seen += 1
        self.log.info("\n%s", signal.format_block())

        approved, lots, reason = self.risk.validate_trade(signal, now=now)
        if not approved:
            self.rejected += 1
            self.log.info("%s: REJECTED by risk manager — %s", pair, reason)
            return
        self.log.info("%s: %s", pair, reason)

        try:
            position = self.broker.open_trade(pair, signal.direction, lots, signal.stop_loss, signal.take_profit)
        except Exception as exc:
            self.log.error("%s: broker raised %s — no position opened", pair, exc)
            return
        if position is None:
            self.log.error("%s: broker returned no position — skipping", pair)
            return

        self.risk.register_position(position)
        self.log.info(
            "✔ LIVE %s %s %.2f lots @ %.5f | SL %.5f | TP %.5f | ticket %s | magic %s",
            position.direction, position.pair, position.lots, position.open_price,
            position.stop_loss, position.take_profit, position.ticket, BOT_MAGIC,
        )

    def _manage_positions(self, now: datetime) -> None:
        """Close anything the broker already stopped out; keep P&L honest."""
        if not self.risk.open_positions:
            return
        try:
            live = {p["ticket"]: p for p in self.broker.get_open_positions()}
        except Exception as exc:
            self.log.error("Position sync failed: %s", exc)
            return

        for position in list(self.risk.open_positions):
            broker_pos = live.get(position.ticket)
            if broker_pos is None:
                # Closed server-side (SL/TP hit) → book estimated P&L from the stop levels.
                exit_price = position.stop_loss if self._last_price_was_below(position) else position.take_profit
                pnl = self.broker.estimate_pnl(position, exit_price)
                reason = "stop_loss" if exit_price == position.stop_loss else "take_profit"
                self.log.info("%s ticket %s no longer on terminal — booking %s exit.", position.pair, position.ticket, reason)
                self.risk.record_close(pnl, position, reason=reason)
                self.log.info("Account balance after close: %.2f", self.risk.current_balance)
                continue

            # trailing/consistency check: never let the terminal drift from our plan
            if abs(broker_pos["sl"] - position.stop_loss) > 1e-9 or abs(broker_pos["tp"] - position.take_profit) > 1e-9:
                self.log.warning(
                    "%s ticket %s stops differ (terminal SL %.5f/TP %.5f vs bot %.5f/%.5f) — resyncing",
                    position.pair, position.ticket, broker_pos["sl"], broker_pos["tp"],
                    position.stop_loss, position.take_profit,
                )
                self.broker.sync_stops(position, position.stop_loss, position.take_profit)

            try:
                price = self.feed.get_latest_tick(position.pair)
            except Exception as exc:
                self.log.debug("%s: tick unavailable (%s)", position.pair, exc)
                continue
            unrealised = self.broker.estimate_pnl(position, float(price["ask"] if position.is_long else price["bid"]))
            self.log.debug("%s ticket %s unrealised %+.2f", position.pair, position.ticket, unrealised)

    def _last_price_was_below(self, position) -> bool:
        """Heuristic: did the market last trade on the *stop* side of *position*?

        Used only when the terminal reports the ticket gone and no deal
        history is available, to attribute the P&L to the right exit level.
        """
        try:
            tick = self.feed.get_latest_tick(position.pair)  # type: ignore[attr-defined]
            price = float(tick.get("mid", (tick["bid"] + tick["ask"]) / 2.0))
        except Exception:
            return True  # fail conservative: assume the stop was hit
        return price <= position.stop_loss if position.is_long else price >= position.stop_loss

    # ── reporting ─────────────────────────────────────────────────────

    def _print_banner(self) -> None:
        """Print the startup banner with the effective configuration."""
        bar = "═" * 66
        print(bar)
        print(BANNER)
        print(bar)
        print(self.config.summary())
        print(f"  mode               : {'PAPER (simulated fills)' if self.broker.paper else 'LIVE MT5'}")
        print(f"  state file         : {self.risk.state_file}")
        print(f"  log files          : bot.log / errors.log (rotate @10MB)")
        print(f"  UTC now            : {datetime.now(timezone.utc).isoformat(timespec='seconds')}")
        print(bar)
        print("RISK WARNING: leveraged trading can lose more than your deposit.")
        print("This is software, not advice. Demo-test before you risk real money.")
        print(bar, "\n")
        self.log.info(
            "Bot starting — %d pairs, %s timeframe, balance %.2f, magic %s, comment %s",
            len(self.config.pairs), self.config.timeframe, self.config.account_balance,
            BOT_MAGIC, BOT_COMMENT,
        )

    def backtest(self, bars: int = 4000, spread_pips: float = 1.5) -> Dict[str, object]:
        """Run the backtester over the injected feed and print reports."""
        bt = Backtester(config=self.config, strategy=self.strategy)
        frames: Dict[str, pd.DataFrame] = {}
        for pair in self.config.pairs:
            try:
                frames[pair] = self.feed.get_candles(pair, bars)  # type: ignore[attr-defined]
            except Exception as exc:
                self.log.error("%s: history unavailable (%s)", pair, exc)
        if not frames:
            print("No history to backtest — check the data feed.")
            return {}
        results = bt.run_all(frames, spread_pips=spread_pips)
        for pair, metrics in results["per_pair"].items():
            print(bt.report(metrics))
        print("\nPORTFOLIO:", results["portfolio"])
        return results

    def self_test(self) -> int:
        """Exercise the risk engine and indicators; return a process exit code."""
        from indicators import Indicators
        from strategy import Signal

        failures: List[str] = []
        df = MockDataFeed(self.config, bars=400).history(self.config.pairs[0])

        # indicators behave
        rsi = Indicators.rsi(df["close"], 14).dropna()
        if rsi.empty or not (0 <= rsi.min() and rsi.max() <= 100):
            failures.append("RSI out of bounds")
        atr = Indicators.atr(df, 14).dropna()
        if atr.empty or atr.min() <= 0:
            failures.append("ATR not positive")

        # risk manager: sizing shrinks with balance
        risk = RiskManager(BotConfig(account_balance=10_000.0), state_file=_tmp_state())
        big = risk.calculate_position_size("BUY", 1.1000, 1.0950, "EUR/USD")
        risk.current_balance = 2_000.0
        small = risk.calculate_position_size("BUY", 1.1000, 1.0950, "EUR/USD")
        if not (0 < small <= big <= 20.0):
            failures.append(f"position sizing not monotonic ({big} → {small})")
        if big * 50 * self.config.pip_value > 10_000 * self.config.max_risk_per_trade + 1:
            failures.append("position sizing exceeded the risk cap")

        # risk manager: halt on daily loss
        risk2 = RiskManager(BotConfig(account_balance=1_000.0, max_daily_loss=0.05), state_file=_tmp_state())
        from risk_manager import Position

        pos = Position("EUR/USD", "BUY", 0.01, 1.1, 1.09, 1.12, "now", 1)
        risk2.record_close(-100.0, pos)
        allowed, why = risk2.can_trade()
        if allowed or "halt" not in why.lower():
            failures.append("daily loss limit failed to halt the bot")

        # strategy returns a well-formed signal
        sig = AdvancedStrategy(self.config).analyze(df, self.config.pairs[0])
        if sig.signal != Signal.NEUTRAL and sig.risk <= 0:
            failures.append("actionable signal without a stop distance")

        print("SELF-TEST " + ("PASSED ✔" if not failures else "FAILED ✘"))
        for f in failures:
            print("  -", f)
        return 1 if failures else 0


def _tmp_state():
    """A throw-away state file so self-tests never touch ``bot_state.json``."""
    from pathlib import Path

    return Path(f"bot_state_selftest_{int(time.time() * 1000)}.json")


def main(argv: Optional[List[str]] = None) -> int:
    """Parse CLI flags and dispatch to the loop / backtest / self-test."""
    parser = argparse.ArgumentParser(description=BANNER)
    parser.add_argument("--mock", action="store_true", help="synthetic feed + paper fills")
    parser.add_argument("--once", action="store_true", help="run a single tick and exit")
    parser.add_argument("--ticks", type=int, default=None, help="run N ticks then exit")
    parser.add_argument("--backtest", action="store_true", help="run the backtester and exit")
    parser.add_argument("--self-test", action="store_true", help="run internal sanity checks")
    parser.add_argument("--pairs", default="", help="comma-separated override of config.pairs")
    parser.add_argument("--timeframe", default="", help="1m|5m|15m|1h|4h|1d")
    parser.add_argument("--bars", type=int, default=4000, help="history length for --backtest")
    parser.add_argument(
        "--remote",
        action="store_true",
        help="enable the Telegram gateway and wait for /start before trading",
    )
    parser.add_argument("--telegram", action="store_true", help="enable Telegram but trade immediately")
    args = parser.parse_args(argv)

    overrides: Dict[str, object] = {}
    if args.pairs:
        overrides["pairs"] = [p.strip() for p in args.pairs.split(",") if p.strip()]
    if args.timeframe:
        overrides["timeframe"] = args.timeframe
    config = BotConfig(**overrides) if overrides else BotConfig()

    feed: Optional[CandleSource] = None
    if args.mock or args.self_test or args.backtest or sys.platform != "win32":
        feed = MockDataFeed(config, bars=max(args.bars, 800))
        if not (args.mock or args.backtest or args.self_test):
            print("\n[note] MetaTrader5 is unavailable on this OS — using the mock feed in paper mode.\n")

    if args.remote or args.telegram:
        config.telegram_enabled = True
        config.start_paused = bool(args.remote)
        if not config.telegram_token:
            print("\n[FATAL] --remote needs a bot token: set FXBOT_TELEGRAM_TOKEN (@BotFather → /newbot).\n")
            return 2

    bot = ForexBot(config=config, feed=feed)

    if config.telegram_enabled:
        if not bot.attach_telegram():
            print("[note] Telegram gateway could not start — running console-only.")
        elif config.start_paused:
            print(
                "\n💤 ARMED, PAUSED. Pair with:  /pair "
                f"{bot.telegram.pairing_code}\n   then send /start to begin trading. Ctrl+C to quit.\n"
            )

    if args.self_test:
        return bot.self_test()
    if args.backtest:
        bot.backtest(bars=args.bars)
        return 0
    if args.once:
        bot.run(max_ticks=1)
        return 0
    bot.run(max_ticks=args.ticks)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
