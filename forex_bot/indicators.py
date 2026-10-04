"""
indicators.py — pure, side-effect-free technical indicators on DataFrames.
════════════════════════════════════════════════════════════════════════
Every function is a ``@staticmethod``: same input → same output, no global
state, no logging. That makes them trivially unit-testable and lets the
backtester pre-compute an entire history in one vectorised pass.

Conventions
-----------
* ``series`` is a ``pandas.Series`` (usually the close).
* Returned frames/series keep the caller's index.
* Warm-up periods are ``NaN`` — callers must drop or skip them.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import numpy as np
import pandas as pd

if TYPE_CHECKING:  # pragma: no cover - typing only
    from config import BotConfig


class Indicators:
    """Namespace for the indicator maths used by the strategy."""

    # ── moving averages ───────────────────────────────────────────────

    @staticmethod
    def ema(series: pd.Series, period: int) -> pd.Series:
        """Exponential moving average.

        Args:
            series: Price/volume series.
            period: EMA length (must be >= 1).

        Returns:
            EMA series, ``NaN`` for the first ``period - 1`` rows.
        """
        if period < 1:
            raise ValueError("ema period must be >= 1")
        return series.ewm(span=int(period), adjust=False).mean()

    @staticmethod
    def sma(series: pd.Series, period: int) -> pd.Series:
        """Simple moving average."""
        if period < 1:
            raise ValueError("sma period must be >= 1")
        return series.rolling(window=int(period), min_periods=int(period)).mean()

    # ── oscillators ───────────────────────────────────────────────────

    @staticmethod
    def rsi(series: pd.Series, period: int = 14) -> pd.Series:
        """Wilder-style RSI computed with exponential weighting (Cutler's EWM).

        Average gain/loss are ``ewm(alpha=1/period)`` rather than a simple
        rolling mean, so the value reacts like the platform traders use.

        Returns:
            Series bounded 0…100.
        """
        if period < 2:
            raise ValueError("rsi period must be >= 2")
        delta = series.diff()
        gain = delta.clip(lower=0.0)
        loss = -delta.clip(upper=0.0)
        avg_gain = gain.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()
        avg_loss = loss.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()
        rs = avg_gain / avg_loss.replace(0.0, np.nan)
        out = 100.0 - (100.0 / (1.0 + rs))
        # a perfectly rising market has no losses → RSI 100, not NaN
        out = out.where(~((avg_loss == 0) & (avg_gain > 0)), 100.0)
        out = out.where(~((avg_gain == 0) & (avg_loss > 0)), 0.0)
        return out.clip(0.0, 100.0)

    @staticmethod
    def macd(
        series: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9
    ) -> pd.DataFrame:
        """MACD line, signal line and histogram.

        Returns:
            DataFrame with columns ``macd``, ``signal``, ``histogram``.
        """
        if fast >= slow:
            raise ValueError("macd fast period must be < slow period")
        macd_line = Indicators.ema(series, fast) - Indicators.ema(series, slow)
        signal_line = Indicators.ema(macd_line, signal)
        hist = macd_line - signal_line
        return pd.DataFrame({"macd": macd_line, "signal": signal_line, "histogram": hist})

    @staticmethod
    def stochastic(df: pd.DataFrame, k: int = 14, d: int = 3) -> pd.DataFrame:
        """Slow stochastic oscillator.

        Args:
            df: Must contain ``high``, ``low``, ``close``.
            k: Lookback for the %K range.
            d: SMA smoothing of %K.

        Returns:
            DataFrame with columns ``%K`` and ``%D`` (0…100).
        """
        lowest = df["low"].rolling(k, min_periods=k).min()
        highest = df["high"].rolling(k, min_periods=k).max()
        span = (highest - lowest).replace(0.0, np.nan)
        fast_k = 100.0 * (df["close"] - lowest) / span
        slow_k = fast_k.rolling(3, min_periods=1).mean()
        return pd.DataFrame({"%K": slow_k.clip(0, 100), "%D": slow_k.rolling(d, min_periods=d).mean()})

    # ── volatility / trend ────────────────────────────────────────────

    @staticmethod
    def atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
        """Average True Range (Wilder smoothing via EWM).

        ``TR = max(high-low, |high-prev_close|, |low-prev_close|)``
        """
        if period < 1:
            raise ValueError("atr period must be >= 1")
        prev_close = df["close"].shift(1)
        tr = pd.concat(
            [
                df["high"] - df["low"],
                (df["high"] - prev_close).abs(),
                (df["low"] - prev_close).abs(),
            ],
            axis=1,
        ).max(axis=1)
        return tr.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()

    @staticmethod
    def bollinger_bands(series: pd.Series, period: int = 20, mult: float = 2.0) -> pd.DataFrame:
        """Bollinger bands around a simple moving average.

        Returns:
            DataFrame with ``upper``, ``middle``, ``lower``.
        """
        middle = Indicators.sma(series, period)
        sd = series.rolling(period, min_periods=period).std(ddof=0)
        return pd.DataFrame(
            {"upper": middle + mult * sd, "middle": middle, "lower": middle - mult * sd}
        )

    @staticmethod
    def adx(df: pd.DataFrame, period: int = 14) -> pd.Series:
        """Average Directional Index + smoothing of +DI/-DI is left to caller.

        Uses Wilder's normalisation: ``DX = 100 * |+DI - -DI| / (+DI + -DI)``
        with ADX being an EMA-smoothed DX. ``ADX > 25`` = trending market.
        """
        if period < 2:
            raise ValueError("adx period must be >= 2")
        up = df["high"].diff()
        down = -df["low"].diff()
        plus_dm = pd.Series(np.where((up > down) & (up > 0), up, 0.0), index=df.index)
        minus_dm = pd.Series(np.where((down > up) & (down > 0), down, 0.0), index=df.index)
        prev_close = df["close"].shift(1)
        tr = pd.concat(
            [
                df["high"] - df["low"],
                (df["high"] - prev_close).abs(),
                (df["low"] - prev_close).abs(),
            ],
            axis=1,
        ).max(axis=1)
        alpha = 1.0 / period
        atr_ = tr.ewm(alpha=alpha, adjust=False, min_periods=period).mean().replace(0.0, np.nan)
        plus_di = 100.0 * plus_dm.ewm(alpha=alpha, adjust=False, min_periods=period).mean() / atr_
        minus_di = 100.0 * minus_dm.ewm(alpha=alpha, adjust=False, min_periods=period).mean() / atr_
        denom = (plus_di + minus_di).replace(0.0, np.nan)
        dx = 100.0 * (plus_di - minus_di).abs() / denom
        return dx.ewm(alpha=alpha, adjust=False, min_periods=period).mean()

    # ── batch helper ──────────────────────────────────────────────────

    @classmethod
    def attach(cls, df: pd.DataFrame, config: "BotConfig") -> pd.DataFrame:
        """Return a copy of *df* carrying every indicator column at once.

        Computing all indicators in a single vectorised pass is roughly an
        order of magnitude faster than recomputing them bar-by-bar in a
        backtest loop; the strategy can then read pre-computed rows.

        Adds: ``ema_fast, ema_slow, rsi, atr, macd, macd_signal,
        macd_hist, bb_upper, bb_middle, bb_lower, adx``.
        """
        if df.empty:
            raise ValueError("attach() needs a non-empty DataFrame")
        out = df.copy()
        close = out["close"]
        out["ema_fast"] = cls.ema(close, config.fast_ema)
        out["ema_slow"] = cls.ema(close, config.slow_ema)
        out["rsi"] = cls.rsi(close, config.rsi_period)
        out["atr"] = cls.atr(out, config.atr_period)
        macd = cls.macd(close, config.fast_ema, config.slow_ema, config.signal_ema)
        out[["macd", "macd_signal", "macd_hist"]] = macd
        bands = cls.bollinger_bands(close, 20, 2.0)
        out[["bb_upper", "bb_middle", "bb_lower"]] = bands
        out["adx"] = cls.adx(out, config.atr_period)
        return out
