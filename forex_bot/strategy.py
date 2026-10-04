"""
strategy.py — multi-indicator confluence engine that emits TradeSignals.
════════════════════════════════════════════════════════════════════════
Each indicator votes with a score in ``[-1.5, +1.5]``. Votes are summed,
the sum is thresholded into a :class:`Signal`, and confidence is the share
of the maximum attainable score that the sum represents. The ADX does not
vote — it inflates the denominator, so a choppy market must produce *more*
agreement to reach the same confidence.

Stop-loss / take-profit are ATR based and always keep a 1:2 reward:risk.
The strategy NEVER sizes a trade and NEVER checks whether the account can
afford one: that is ``risk_manager.RiskManager``'s job.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import IntEnum
from typing import Any, Dict, List, Optional

import pandas as pd

from config import BotConfig
from indicators import Indicators
from logger import get_logger


class Signal(IntEnum):
    """Directional verdict, ordered so ``>`` / ``<`` comparisons stay sane."""

    STRONG_SELL = -2
    SELL = -1
    NEUTRAL = 0
    BUY = 1
    STRONG_BUY = 2

    @property
    def is_long(self) -> bool:
        """True for BUY / STRONG_BUY."""
        return self > Signal.NEUTRAL

    @property
    def is_short(self) -> bool:
        """True for SELL / STRONG_SELL."""
        return self < Signal.NEUTRAL

    @property
    def actionable(self) -> bool:
        """True when the signal is anything but NEUTRAL."""
        return self != Signal.NEUTRAL

    def label(self) -> str:
        """Upper-case name used in logs and banners."""
        return self.name


@dataclass
class TradeSignal:
    """Immutable verdict for one instrument at one point in time."""

    signal: Signal
    pair: str
    price: float
    stop_loss: float
    take_profit: float
    confidence: float
    reasons: List[str] = field(default_factory=list)
    score: float = 0.0
    indicators: Dict[str, Any] = field(default_factory=dict)

    @property
    def direction(self) -> str:
        """``"BUY"`` / ``"SELL"`` for the broker layer (NEUTRAL → "BUY")."""
        return "BUY" if self.signal.is_long or self.signal == Signal.NEUTRAL else "SELL"

    @property
    def risk(self) -> float:
        """Absolute stop distance in price units."""
        return abs(self.price - self.stop_loss)

    @property
    def reward(self) -> float:
        """Absolute target distance in price units."""
        return abs(self.take_profit - self.price)

    @property
    def risk_reward(self) -> float:
        """Reward-to-risk ratio; 0 when no stop is set."""
        r = self.risk
        return round(self.reward / r, 3) if r > 0 else 0.0

    def format_block(self) -> str:
        """Pretty multi-line block used by ``main.py`` logs."""
        bar = "═" * 28
        reasons = ";\n  ".join(self.reasons) if self.reasons else "n/a"
        return (
            f"{bar}\n"
            f"Signal for {self.pair}: {self.signal.label()}\n"
            f"Price: {self.price:.5f}\n"
            f"SL: {self.stop_loss:.5f}  TP: {self.take_profit:.5f}\n"
            f"Confidence: {self.confidence:.2f}  (score {self.score:+.2f}, RR {self.risk_reward:.2f})\n"
            f"Reasons:\n  {reasons}\n"
            f"{bar}"
        )


class AdvancedStrategy:
    """Scores EMA, MACD, RSI, Bollinger and ADX confluence into a signal."""

    #: maximum absolute sum of the five voting weights
    BASE_MAX_SCORE: float = 1.0 + 1.0 + 1.5 + 1.0 + 0.5

    def __init__(self, config: BotConfig) -> None:
        """Bind the strategy to a config (indicator lengths + ATR stops)."""
        self.config = config
        self.log = get_logger("strategy")

    # ── public API ────────────────────────────────────────────────────

    def analyze(
        self, df: pd.DataFrame, pair: str, price: Optional[float] = None
    ) -> TradeSignal:
        """Analyse *df* (ascending OHLCV) and return a TradeSignal.

        Args:
            df: OHLCV history with a datetime index; needs >= ``min_bars``.
            pair: Instrument label, echoed into the signal.
            price: Optional live price override (tick) used for stops.

        Returns:
            A :class:`TradeSignal`; ``Signal.NEUTRAL`` when confluence is
            missing or history is too short.
        """
        cfg = self.config
        if df is None or len(df) < max(cfg.min_bars, cfg.slow_ema + cfg.signal_ema):
            self.log.debug("%s: only %d bars — not enough history, returning NEUTRAL",
                           pair, 0 if df is None else len(df))
            return self._neutral(pair, 0.0)

        enriched = Indicators.attach(df, cfg).dropna(
            subset=["ema_slow", "rsi", "atr", "macd_hist", "bb_lower", "adx"]
        )
        return self.from_enriched(enriched, pair, price)

    def from_enriched(
        self, enriched: pd.DataFrame, pair: str, price: Optional[float] = None
    ) -> TradeSignal:
        """Score the **last two rows** of an already-enriched frame.

        ``Indicators.attach()`` only ever looks backwards (EMA/RSI/ATR are
        causal), so the backtester can pre-compute the whole history once and
        replay this method bar-by-bar with identical results and no lookahead.

        Args:
            enriched: Frame produced by :meth:`Indicators.attach` with the
                indicator columns already present.
            pair: Instrument label.
            price: Optional live price override for stop placement.

        Returns:
            A :class:`TradeSignal` for the final row of *enriched*.
        """
        cfg = self.config
        if len(enriched) < 3:
            return self._neutral(pair, float(enriched["close"].iloc[-1]) if len(enriched) else 0.0)

        last = enriched.iloc[-1]
        prev = enriched.iloc[-2]
        close = float(price if price is not None else last["close"])

        score = 0.0
        reasons: List[str] = []

        # 1 ── EMA trend -------------------------------------------------
        if last["ema_fast"] > last["ema_slow"]:
            score += 1.0
            reasons.append(f"EMA{cfg.fast_ema} > EMA{cfg.slow_ema} (uptrend)")
        elif last["ema_fast"] < last["ema_slow"]:
            score -= 1.0
            reasons.append(f"EMA{cfg.fast_ema} < EMA{cfg.slow_ema} (downtrend)")

        # 2 ── MACD histogram sign --------------------------------------
        if last["macd_hist"] > 0:
            score += 1.0
            reasons.append(f"MACD histogram positive ({last['macd_hist']:.6f})")
        elif last["macd_hist"] < 0:
            score -= 1.0
            reasons.append(f"MACD histogram negative ({last['macd_hist']:.6f})")

        # 3 ── MACD histogram flip (the heaviest vote) -------------------
        if prev["macd_hist"] <= 0 < last["macd_hist"]:
            score += 1.5
            reasons.append("MACD bullish crossover (histogram flipped +)")
        elif prev["macd_hist"] >= 0 > last["macd_hist"]:
            score -= 1.5
            reasons.append("MACD bearish crossover (histogram flipped -)")

        # 4 ── RSI --------------------------------------------------------
        rsi = float(last["rsi"])
        if rsi < cfg.rsi_oversold:
            score += 1.0
            reasons.append(f"RSI oversold ({rsi:.1f})")
        elif rsi > cfg.rsi_overbought:
            score -= 1.0
            reasons.append(f"RSI overbought ({rsi:.1f})")
        elif rsi > 50:
            score += 0.5
            reasons.append(f"RSI bullish bias ({rsi:.1f})")
        elif rsi < 50:
            score -= 0.5
            reasons.append(f"RSI bearish bias ({rsi:.1f})")

        # 5 ── Bollinger band position -----------------------------------
        band_width = float(last["bb_upper"] - last["bb_lower"])
        if band_width > 0:
            position = (close - float(last["bb_lower"])) / band_width
            if position < 0.20:
                score += 0.5
                reasons.append(f"Price at lower Bollinger zone ({position:.0%} of band)")
            elif position > 0.80:
                score -= 0.5
                reasons.append(f"Price at upper Bollinger zone ({position:.0%} of band)")

        # 6 ── ADX: confidence dampener, not a vote ----------------------
        adx = float(last["adx"])
        max_score = self.BASE_MAX_SCORE
        if adx < 25:
            max_score += (25.0 - adx) / 25.0 * self.BASE_MAX_SCORE  # weak trend → harder to be confident
            reasons.append(f"Weak trend (ADX={adx:.1f}) — confidence penalised")
        else:
            reasons.append(f"Strong trend (ADX={adx:.1f})")

        signal = self._classify(score)
        confidence = min(1.0, abs(score) / max_score) if max_score > 0 else 0.0
        if signal == Signal.NEUTRAL:
            return self._neutral(pair, close, reasons, score)

        atr = float(last["atr"])
        if not atr > 0:  # NaN or zero ATR → refuse to place stops
            self.log.warning("%s: ATR invalid (%s) — forcing NEUTRAL", pair, atr)
            return self._neutral(pair, close, reasons, score)

        stop_loss, take_profit = self._build_stops(close, atr, signal)
        return TradeSignal(
            signal=signal,
            pair=pair,
            price=round(close, 5),
            stop_loss=round(stop_loss, 5),
            take_profit=round(take_profit, 5),
            confidence=round(confidence, 3),
            reasons=reasons,
            score=round(score, 3),
            indicators={
                "ema_fast": round(float(last["ema_fast"]), 5),
                "ema_slow": round(float(last["ema_slow"]), 5),
                "rsi": round(rsi, 2),
                "macd_hist": round(float(last["macd_hist"]), 8),
                "atr": round(atr, 6),
                "adx": round(adx, 2),
                "bb_position": round(position, 3) if band_width > 0 else None,
            },
        )

    # ── internals ─────────────────────────────────────────────────────

    @staticmethod
    def _classify(score: float) -> Signal:
        """Map a raw confluence score onto the Signal enum."""
        if score >= 3.0:
            return Signal.STRONG_BUY
        if score >= 1.5:
            return Signal.BUY
        if score <= -3.0:
            return Signal.STRONG_SELL
        if score <= -1.5:
            return Signal.SELL
        return Signal.NEUTRAL

    def _build_stops(self, price: float, atr: float, signal: Signal) -> tuple[float, float]:
        """ATR stop/target pair keeping a fixed 1:2 risk-reward."""
        cfg = self.config
        if signal.is_long:
            return price - atr * cfg.atr_multiplier, price + atr * cfg.take_profit_multiplier
        return price + atr * cfg.atr_multiplier, price - atr * cfg.take_profit_multiplier

    def _neutral(
        self,
        pair: str,
        price: float,
        reasons: Optional[List[str]] = None,
        score: float = 0.0,
    ) -> TradeSignal:
        """Construct a flat, non-actionable signal (SL/TP = 0)."""
        return TradeSignal(
            signal=Signal.NEUTRAL,
            pair=pair,
            price=round(float(price), 5),
            stop_loss=0.0,
            take_profit=0.0,
            confidence=0.0,
            reasons=reasons or ["Insufficient confluence"],
            score=round(float(score), 3),
            indicators={},
        )
