"""
data_feed.py — OHLCV + tick access on top of the MetaTrader 5 terminal.
════════════════════════════════════════════════════════════════════════
The rest of the bot only ever talks to :class:`ForexDataFeed`, so the
MT5 package is imported lazily and can be swapped for
:class:`MockDataFeed` in unit tests, CI and dry runs.

Every public method returns a ``pandas.DataFrame`` indexed by an
ascending UTC ``DatetimeIndex`` with the columns
``[open, high, low, close, volume]``.
"""

from __future__ import annotations

import math
import random
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Protocol

import numpy as np
import pandas as pd

from config import BotConfig
from logger import get_logger

try:  # MetaTrader5 is Windows-only; the bot degrades to paper mode without it
    import MetaTrader5 as mt5  # type: ignore
except ImportError:  # pragma: no cover - exercised on non-Windows boxes
    mt5 = None

#: Human timeframe string → MT5 constant (resolved lazily, mt5 may be None).
TIMEFRAME_MAP: Dict[str, str] = {
    "1m": "TIMEFRAME_M1",
    "5m": "TIMEFRAME_M5",
    "15m": "TIMEFRAME_M15",
    "1h": "TIMEFRAME_H1",
    "4h": "TIMEFRAME_H4",
    "1d": "TIMEFRAME_D1",
}

COLUMNS: List[str] = ["open", "high", "low", "close", "volume"]


class DataFeedError(RuntimeError):
    """Raised when the terminal is unreachable or returns no usable bars."""


class CandleSource(Protocol):
    """Structural type satisfied by both the live and the mock feed."""

    def get_candles(self, pair: str, num_bars: int = 500) -> pd.DataFrame: ...

    def get_latest_tick(self, pair: str) -> Dict[str, Any]: ...


class ForexDataFeed:
    """Blocking OHLCV/tick accessor for one logged-in MetaTrader 5 terminal."""

    def __init__(self, config: BotConfig, api: Any = mt5) -> None:
        """Store *config* and the (optional) MT5 binding.

        Args:
            config: Bot configuration; ``timeframe`` selects the bar size.
            api: Injectable MT5 module. Pass a stub in tests.
        """
        self.config = config
        self.mt5 = api
        self.log = get_logger("data_feed")
        self.connected: bool = False
        self._symbols: set[str] = set()
        #: which account we are actually trading — populated by initialize()
        self.account_fingerprint: Dict[str, Any] = {}

    # ── lifecycle ─────────────────────────────────────────────────────

    def initialize(self) -> None:
        """Connect to the terminal, log in and select every configured pair.

        Raises:
            DataFeedError: MT5 is unavailable, the login fails, or not a
                single configured symbol could be selected.
        """
        if self.mt5 is None:
            raise DataFeedError(
                "MetaTrader5 package is not installed. Run `pip install MetaTrader5` "
                "on a Windows machine with the MT5 terminal, or use MockDataFeed."
            )
        kwargs: Dict[str, Any] = {}
        if self.config.mt5_terminal_path:
            kwargs["path"] = self.config.mt5_terminal_path
        if self.config.mt5_login:
            kwargs.update(
                login=self.config.mt5_login,
                password=self.config.mt5_password or "",
                server=self.config.mt5_server or "",
            )

        if not self.mt5.initialize(**kwargs):
            err = self._last_error()
            raise DataFeedError(f"MT5 initialize() failed: {err}")

        info = self.mt5.terminal_info()
        account = self.mt5.account_info()
        self.connected = True
        if account is None:
            self.connected = False
            raise DataFeedError(
                "MT5 is initialized but reports no account — open the terminal, log in to a "
                "trade account, then start the bot again."
            )

        # ── identity check: prove we are about to trade the account we think we are
        self.account_fingerprint = {
            "login": int(getattr(account, "login", 0) or 0),
            "server": str(getattr(account, "server", "") or ""),
            "currency": str(getattr(account, "currency", "USD") or "USD"),
            "balance": float(getattr(account, "balance", 0.0) or 0.0),
            "leverage": int(getattr(account, "leverage", 0) or 0),
            "company": str(getattr(account, "company", "") or ""),
            "verified": False,
            "symbols": [],
        }
        mismatches: List[str] = []
        if self.config.mt5_login and self.account_fingerprint["login"] != int(self.config.mt5_login):
            mismatches.append(
                f"config expects login {self.config.mt5_login}, the terminal is logged into {self.account_fingerprint['login']}"
            )
        if self.config.mt5_server and self.account_fingerprint["server"] != self.config.mt5_server:
            mismatches.append(
                f"config expects server {self.config.mt5_server!r}, terminal says {self.account_fingerprint['server']!r}"
            )
        if mismatches and self.config.require_account_match:
            self.connected = False
            self.mt5.shutdown()
            raise DataFeedError(
                "ACCOUNT MISMATCH — refusing to trade: " + "; ".join(mismatches)
                + ". Correct mt5_login/mt5_server (FXBOT_MT5_LOGIN / FXBOT_MT5_SERVER), or set "
                  "require_account_match=False if you really mean the logged-in account."
            )
        self.account_fingerprint["verified"] = bool(self.config.mt5_login) and not mismatches

        self.log.info(
            "Connected to MT5 terminal '%s' (build %s) — account %s @ %s, balance %.2f %s, fingerprint verified=%s",
            getattr(info, "name", "unknown"),
            getattr(info, "build", "?"),
            self.account_fingerprint["login"],
            self.account_fingerprint["server"] or "?",
            self.account_fingerprint["balance"],
            self.account_fingerprint["currency"],
            self.account_fingerprint["verified"],
        )
        if mismatches:
            self.log.warning("Trading an UNVERIFIED account (require_account_match=False): %s", "; ".join(mismatches))

        ok: List[str] = []
        for pair in self.config.pairs:
            symbol = self._to_symbol(pair)
            if not self.mt5.symbol_select(symbol, True):
                self.log.warning("Symbol %s could not be selected — skipping.", symbol)
                continue
            self._symbols.add(symbol)
            ok.append(pair)
        if not ok:
            raise DataFeedError(
                f"No configured symbol is available on this broker: {self.config.pairs}"
            )
        self.account_fingerprint["symbols"] = ok
        self.log.info("Subscribed to %d/%d symbols: %s", len(ok), len(self.config.pairs), ", ".join(ok))

    def shutdown(self) -> None:
        """Disconnect from the terminal. Safe to call more than once."""
        if self.mt5 is not None and self.connected:
            try:
                self.mt5.shutdown()
            except Exception as exc:  # pragma: no cover - terminal may be gone
                self.log.warning("MT5 shutdown raised %s", exc)
        self.connected = False
        self.log.info("MT5 connection closed.")

    # ── data ──────────────────────────────────────────────────────────

    def get_candles(self, pair: str, num_bars: int = 500) -> pd.DataFrame:
        """Fetch the most recent *num_bars* candles for *pair*.

        Args:
            pair: Instrument, with or without the slash (``EUR/USD`` / ``EURUSD``).
            num_bars: Number of bars to request (>= 1).

        Returns:
            DataFrame indexed by ascending UTC datetime with columns
            ``open, high, low, close, volume``.

        Raises:
            DataFeedError: not connected, bad argument, or empty history.
        """
        if num_bars < 1:
            raise DataFeedError("num_bars must be >= 1")
        if not self.connected:
            raise DataFeedError("Data feed is not initialized — call initialize() first")

        symbol = self._to_symbol(pair)
        tf_const = self._timeframe_constant(self.config.timeframe)
        try:
            rate = self.mt5.copy_rates_from_pos(symbol, tf_const, 0, int(num_bars))
        except Exception as exc:
            raise DataFeedError(f"copy_rates_from_pos({symbol}) blew up: {exc}") from exc
        if rate is None or len(rate) == 0:
            err = self._last_error()
            raise DataFeedError(f"No candle data for {symbol} on {self.config.timeframe} ({err})")

        df = pd.DataFrame(rate)
        for col in ("open", "high", "low", "close", "tick_volume", "volume"):
            if col not in df.columns:
                df[col] = 0.0
        df["time"] = pd.to_datetime(df["time"], unit="s", utc=True)
        if "volume" in df.columns and df["volume"].abs().sum() == 0:
            df["volume"] = df["tick_volume"]
        out = df[["time"] + COLUMNS].copy()
        out = out.replace([np.inf, -np.inf], np.nan).dropna(subset=["open", "high", "low", "close"])
        out = out.set_index("time").sort_index()
        out.index.name = "time"
        if len(out) == 0:
            raise DataFeedError(f"All candles for {symbol} were NaN after cleaning")
        return out

    def get_latest_tick(self, pair: str) -> Dict[str, Any]:
        """Return ``{bid, ask, time}`` for *pair*.

        Raises:
            DataFeedError: no tick available (closed market / bad symbol).
        """
        if not self.connected:
            raise DataFeedError("Data feed is not initialized — call initialize() first")
        symbol = self._to_symbol(pair)
        tick = self.mt5.symbol_info_tick(symbol)
        if tick is None or not all(
            isinstance(getattr(tick, a, None), float) and not math.isnan(getattr(tick, a))
            for a in ("bid", "ask")
        ):
            raise DataFeedError(f"No live tick for {symbol} — market may be closed")
        return {
            "bid": float(tick.bid),
            "ask": float(tick.ask),
            "time": datetime.fromtimestamp(tick.time, tz=timezone.utc),
        }

    # ── internals ─────────────────────────────────────────────────────

    @staticmethod
    def _to_symbol(pair: str) -> str:
        """`"EUR/USD"` → ``"EURUSD"``: brokers rarely accept the slash."""
        return pair.upper().replace("/", "").replace("-", "").strip()

    @staticmethod
    def _timeframe_constant(tf: str) -> Any:
        """Translate a timeframe string into the MT5 enum value."""
        key = TIMEFRAME_MAP.get(tf)
        if key is None:
            raise DataFeedError(f"Unsupported timeframe {tf!r}; known: {sorted(TIMEFRAME_MAP)}")
        value = getattr(mt5, key, None) if mt5 is not None else None
        if value is None:
            raise DataFeedError(f"MT5 constant {key} is unavailable in this build")
        return value

    def _last_error(self) -> str:
        """Best-effort MT5 error string, never raising."""
        try:
            code, text = self.mt5.last_error()
            return f"{code}: {text}"
        except Exception:
            return "no error information"


class MockDataFeed:
    """Deterministic synthetic feed — for unit tests, demos and CI.

    It satisfies :class:`CandleSource`, so ``ForexBot``, ``AdvancedStrategy``
    and ``Backtester`` run unchanged against it. Prices follow a seeded
    geometric random walk with intraday drift, which is enough to keep the
    EMA/MACD/RSI machinery producing real signals.
    """

    def __init__(self, config: BotConfig, bars: int = 2000, seed: int = 7, start_price: float = 1.10) -> None:
        """Generate one history per configured pair up front.

        Args:
            config: Bot config (pairs + timeframe are used).
            bars: How many synthetic bars to pre-generate per pair.
            seed: RNG seed — same seed, same tests.
            start_price: First open price.
        """
        self.config = config
        self.log = get_logger("mock_feed")
        self._frames: Dict[str, pd.DataFrame] = {}
        step = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400}[config.timeframe]
        end = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        index = pd.DatetimeIndex(
            [end - timedelta(seconds=step * (bars - i)) for i in range(bars)], name="time"
        )
        for i, pair in enumerate(config.pairs):
            rng = random.Random(seed + i)
            price = start_price * (1 + 0.01 * i)
            drift = 0.00002 * (1 if i % 2 == 0 else -1)
            rows = []
            for ts in index:
                shock = rng.gauss(drift, 0.0011)
                o = price
                c = max(1e-4, price * (1 + shock))
                wick = abs(rng.gauss(0, 0.0007))
                h = max(o, c) * (1 + wick)
                low = min(o, c) * (1 - wick)
                rows.append({"open": o, "high": h, "low": low, "close": c, "volume": 1200 + rng.randint(0, 900)})
                price = c
            frame = pd.DataFrame(rows, index=index)
            frame["time"] = frame.index
            self._frames[pair] = frame[["time"] + COLUMNS].set_index("time").sort_index()
        self.connected = False
        self.log.info("MockDataFeed ready: %d pairs x %d %s bars", len(self._frames), bars, config.timeframe)

    def initialize(self) -> None:
        """Mark the mock feed as connected (mirrors the real API)."""
        self.connected = True

    def shutdown(self) -> None:
        """No-op teardown, mirroring :class:`ForexDataFeed.shutdown`."""
        self.connected = False

    def get_candles(self, pair: str, num_bars: int = 500) -> pd.DataFrame:
        """Return the last *num_bars* synthetic candles for *pair*."""
        if pair not in self._frames:
            raise DataFeedError(f"Mock feed has no series for {pair}")
        return self._frames[pair].tail(int(num_bars)).copy()

    def get_latest_tick(self, pair: str) -> Dict[str, Any]:
        """Mid price with a fixed half-spread, mimicking a live tick."""
        try:
            last = self._frames[pair].iloc[-1]
        except (KeyError, IndexError) as exc:
            raise DataFeedError(f"Mock feed has no tick for {pair}") from exc
        mid = float(last["close"])
        half = mid * 0.00007
        return {"bid": mid - half, "ask": mid + half, "time": datetime.now(timezone.utc)}

    def history(self, pair: str) -> pd.DataFrame:
        """Full synthetic history — handy for backtests."""
        if pair not in self._frames:
            raise DataFeedError(f"Mock feed has no series for {pair}")
        return self._frames[pair].copy()
