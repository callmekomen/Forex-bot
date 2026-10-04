"""
config.py — single source of truth for every tunable bot parameter.
════════════════════════════════════════════════════════════════════════
Everything the strategy, risk engine and scheduler need lives in one
frozen-ish dataclass so settings can never drift between modules.

This file performs NO market I/O — it is pure data plus validation.
Any field can be overridden with an environment variable named
``FXBOT_<FIELD>`` (e.g. ``FXBOT_LOT_SIZE=0.02``), which keeps secrets
such as the MT5 password out of the repository.
"""

from __future__ import annotations

import os
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

#: Timeframes the bot understands. Mapped to MT5 constants in data_feed.py.
VALID_TIMEFRAMES: tuple[str, ...] = ("1m", "5m", "15m", "1h", "4h", "1d")

#: MT5 magic number stamped on every order so the bot only manages itself.
BOT_MAGIC: int = 123456
BOT_COMMENT: str = "forex_bot_v1"


@dataclass
class BotConfig:
    """Complete runtime configuration for :class:`main.ForexBot`."""

    # ── Universe & account ────────────────────────────────────────────
    pairs: List[str] = field(default_factory=lambda: ["EUR/USD", "GBP/USD", "USD/JPY"])
    account_balance: float = 10_000.0
    lot_size: float = 0.01
    leverage: int = 100

    # ── Risk management ───────────────────────────────────────────────
    max_risk_per_trade: float = 0.02     # 2% of equity committed per trade
    max_daily_loss: float = 0.05          # 5% realised daily loss → halt
    max_open_positions: int = 3
    max_drawdown_limit: float = 0.15      # 15% peak-to-trough → halt
    pip_value: float = 10.0               # USD per pip, per standard lot
    pip_size: float = 0.0001              # 4-decimal quote; JPY pairs auto-detect

    # ── Strategy parameters ───────────────────────────────────────────
    fast_ema: int = 12
    slow_ema: int = 26
    signal_ema: int = 9
    rsi_period: int = 14
    rsi_overbought: float = 70.0
    rsi_oversold: float = 30.0
    atr_period: int = 14
    atr_multiplier: float = 1.5           # SL distance = 1.5 × ATR
    take_profit_multiplier: float = 3.0   # TP distance = 3.0 × ATR → 1:2 RR
    min_confidence: float = 0.6
    min_bars: int = 50                    # refuse to analyse thin histories

    # ── Schedule ──────────────────────────────────────────────────────
    timeframe: str = "1h"
    tick_interval: int = 60               # seconds between analysis passes
    candles_per_call: int = 200
    connect_retry_seconds: int = 30       # keep trying the terminal; the loop never quits

    # ── Trading hours (UTC) ───────────────────────────────────────────
    start_hour: int = 7
    end_hour: int = 20

    # ── Remote control (Telegram). Token comes from @BotFather via env. ─
    telegram_enabled: bool = False
    telegram_token: Optional[str] = None
    #: chat ids allowed to command the bot. Empty = nobody (fail closed).
    telegram_chat_ids: List[int] = field(default_factory=list)
    #: one-time code printed at boot; the operator sends /pair <code> once
    telegram_pairing_code: Optional[str] = None
    #: "off" = silent, "trades" = fills/closes only, "all" = + position count
    telegram_notify: str = "trades"
    #: start the loop paused so /start from Telegram is the real trigger
    start_paused: bool = False

    # ── MetaTrader 5 connection (leave login empty to auto-use the
    #    already-logged-in terminal; otherwise it is read from env) ────
    #: if set, the bot REFUSES to trade unless account_info().login matches
    mt5_login: Optional[int] = None
    #: also compare the terminal's account currency/server at startup
    require_account_match: bool = True
    mt5_password: Optional[str] = None
    mt5_server: Optional[str] = None
    mt5_terminal_path: Optional[str] = None

    # ── Infrastructure ────────────────────────────────────────────────
    state_file: Path = Path("bot_state.json")
    log_dir: Path = Path(".")
    #: None = auto (paper when the MT5 package/terminal is unavailable)
    paper_mode: Optional[bool] = None

    # ─────────────────────────────────────────────────────────────────
    # Validation & helpers
    # ─────────────────────────────────────────────────────────────────

    def __post_init__(self) -> None:
        """Validate every field once, at construction time.

        Raises:
            ValueError: if any parameter is nonsensical or out of range.
        """
        if self.timeframe not in VALID_TIMEFRAMES:
            raise ValueError(
                f"timeframe {self.timeframe!r} unsupported; use one of {VALID_TIMEFRAMES}"
            )
        if not self.pairs:
            raise ValueError("pairs must contain at least one instrument")
        if not 0.0 < self.max_risk_per_trade <= 0.25:
            raise ValueError("max_risk_per_trade must be in (0, 0.25] — never risk more than a quarter of the account")
        if not 0.0 < self.max_daily_loss <= 1.0:
            raise ValueError("max_daily_loss must be in (0, 1]")
        if not 0.0 < self.max_drawdown_limit <= 1.0:
            raise ValueError("max_drawdown_limit must be in (0, 1]")
        if self.max_drawdown_limit < self.max_daily_loss:
            raise ValueError("max_drawdown_limit must be >= max_daily_loss")
        if self.fast_ema >= self.slow_ema:
            raise ValueError("fast_ema must be smaller than slow_ema")
        if not 0.0 <= self.min_confidence <= 1.0:
            raise ValueError("min_confidence must be between 0 and 1")
        if self.min_confidence <= 0:
            raise ValueError("min_confidence must be positive or every tick trades")
        if self.rsi_oversold >= self.rsi_overbought:
            raise ValueError("rsi_oversold must be below rsi_overbought")
        if self.atr_multiplier <= 0 or self.take_profit_multiplier <= 0:
            raise ValueError("ATR multipliers must be positive")
        if self.lot_size <= 0 or self.pip_value <= 0 or self.pip_size <= 0:
            raise ValueError("lot_size, pip_value and pip_size must all be positive")
        if self.tick_interval < 1:
            raise ValueError("tick_interval must be at least 1 second")
        if not 0 <= self.start_hour <= 23 or not 0 <= self.end_hour <= 23:
            raise ValueError("start_hour / end_hour must be valid UTC hours (0-23)")
        if self.account_balance <= 0:
            raise ValueError("account_balance must be positive")

        # normalise + auto-detect the MT5 credentials from the environment
        self.mt5_login = self._env_int("mt5_login", self.mt5_login)
        self.mt5_password = os.environ.get("FXBOT_MT5_PASSWORD", self.mt5_password)
        self.mt5_server = os.environ.get("FXBOT_MT5_SERVER", self.mt5_server)
        self.mt5_terminal_path = os.environ.get("FXBOT_MT5_TERMINAL_PATH", self.mt5_terminal_path)

        # ── Telegram wiring: token from env, chat ids from env or config ──
        self.telegram_token = os.environ.get("FXBOT_TELEGRAM_TOKEN", self.telegram_token)
        env_chats = os.environ.get("FXBOT_TELEGRAM_CHAT_IDS", "")
        if env_chats:
            parsed = [int(x) for x in re.split(r"[,\s]+", env_chats.strip()) if x]
            self.telegram_chat_ids = sorted(set(list(self.telegram_chat_ids) + parsed))
        self.telegram_pairing_code = os.environ.get("FXBOT_TELEGRAM_PAIR", self.telegram_pairing_code)
        if self.telegram_enabled and not self.telegram_token:
            raise ValueError("telegram_enabled=True but no token — export FXBOT_TELEGRAM_TOKEN")
        if self.telegram_notify not in ("off", "trades", "all"):
            raise ValueError("telegram_notify must be 'off', 'trades' or 'all'")
        if any(int(c) == 0 for c in self.telegram_chat_ids):
            raise ValueError("telegram_chat_ids contains 0 — chat ids are non-zero")
        self.pairs = [p.strip().upper() for p in self.pairs if p and p.strip()]
        self.state_file = Path(self.state_file)
        self.log_dir = Path(self.log_dir)

    @staticmethod
    def _env_int(name: str, default: Optional[int]) -> Optional[int]:
        """Read an optional integer override from ``FXBOT_<NAME>``."""
        raw = os.environ.get(f"FXBOT_{name.upper()}")
        if raw is None or raw == "":
            return default
        try:
            return int(raw)
        except ValueError as exc:  # pragma: no cover - defensive
            raise ValueError(f"FXBOT_{name.upper()} must be an integer, got {raw!r}") from exc

    # ── derived values ────────────────────────────────────────────────

    @property
    def max_risk_dollars(self) -> float:
        """Absolute cash the bot is allowed to lose on a single trade."""
        return round(self.account_balance * self.max_risk_per_trade, 2)

    @property
    def max_daily_loss_dollars(self) -> float:
        """Cash drawdown allowed within one UTC day before halting."""
        return round(self.account_balance * self.max_daily_loss, 2)

    @property
    def risk_reward_ratio(self) -> float:
        """Take-profit distance divided by stop-loss distance."""
        return round(self.take_profit_multiplier / self.atr_multiplier, 3)

    def pip_size_for(self, pair: str) -> float:
        """Return the pip size of *pair* (JPY quotes move in 0.01 steps).

        Args:
            pair: Instrument symbol, e.g. ``"USD/JPY"``.

        Returns:
            The price increment that counts as one pip.
        """
        if "JPY" in pair.upper():
            return 0.01
        return self.pip_size

    def is_trading_hours(self, hour_utc: int) -> bool:
        """True when *hour_utc* falls inside the configured UTC session window.

        Supports windows that wrap midnight (e.g. ``22 → 6``).
        """
        if self.start_hour == self.end_hour:
            return True  # 24h trading
        if self.start_hour < self.end_hour:
            return self.start_hour <= hour_utc < self.end_hour
        return hour_utc >= self.start_hour or hour_utc < self.end_hour

    def to_dict(self) -> Dict[str, Any]:
        """JSON-safe dict of the config (secrets redacted)."""
        data = asdict(self)
        data.pop("mt5_password", None)
        data["state_file"] = str(self.state_file)
        data["log_dir"] = str(self.log_dir)
        return data

    def summary(self) -> str:
        """Human readable block printed in the startup banner."""
        lines = [
            f"  pairs              : {', '.join(self.pairs)}",
            f"  timeframe          : {self.timeframe}",
            f"  account balance    : {self.account_balance:,.2f} USD (leverage {self.leverage}x)",
            f"  base lot size      : {self.lot_size}",
            f"  risk per trade     : {self.max_risk_per_trade:.2%} → {self.max_risk_dollars:,.2f} USD",
            f"  daily loss halt    : {self.max_daily_loss:.2%} → {self.max_daily_loss_dollars:,.2f} USD",
            f"  max drawdown halt  : {self.max_drawdown_limit:.2%}",
            f"  max open positions : {self.max_open_positions}",
            f"  signal engine      : EMA({self.fast_ema}/{self.slow_ema}/{self.signal_ema}) + "
            f"MACD + RSI({self.rsi_period}) + ADX + Bollinger",
            f"  stops              : SL = {self.atr_multiplier}x ATR / TP = {self.take_profit_multiplier}x ATR "
            f"(RR {self.risk_reward_ratio})",
            f"  min confidence     : {self.min_confidence:.0%}",
            f"  trading hours      : {self.start_hour:02d}:00-{self.end_hour:02d}:00 UTC",
            f"  tick interval      : {self.tick_interval}s",
            f"  magic / comment    : {BOT_MAGIC} / {BOT_COMMENT}",
        ]
        return "\n".join(lines)


#: A ready-to-run default instance — import this instead of re-building it.
DEFAULT_CONFIG = BotConfig()
