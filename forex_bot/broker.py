"""
broker.py — order execution against MetaTrader 5 (or a paper simulator).
════════════════════════════════════════════════════════════════════════
Two responsibilities only: turn an approved request into an MT5 order, and
report what the terminal did back. No strategy thinking, no risk policy —
those live in ``strategy.py`` and ``risk_manager.py``.

Every request is stamped with ``magic=123456`` so ``positions_get`` and
``history_deals_get`` only ever return this bot's traffic. When the MT5
binding is missing the broker transparently switches to **paper mode**
(internal ledger fills) so the loop, risk engine and backtester remain
runnable on any OS.
"""

from __future__ import annotations

import itertools
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from config import BOT_COMMENT, BOT_MAGIC, BotConfig
from data_feed import CandleSource, ForexDataFeed
from logger import get_logger
from risk_manager import Position

try:
    import MetaTrader5 as mt5_pkg  # type: ignore
except ImportError:  # pragma: no cover
    mt5_pkg = None


@dataclass
class Fill:
    """Normalised result of an order request (real or simulated)."""

    ok: bool
    ticket: int = 0
    price: float = 0.0
    volume: float = 0.0
    retcode: int = 0
    error: str = ""


class Broker:
    """Send/modify/close orders for the configured symbol set."""

    def __init__(
        self,
        config: BotConfig,
        feed: Optional[CandleSource] = None,
        api: Any = None,
    ) -> None:
        """Wire the broker to *config* and *feed*.

        Args:
            config: Lot/pip/hour settings (``pip_value``, ``paper_mode``…).
            feed: Data feed used for live tick prices.
            api: MT5 module override; ``None`` → import or paper mode.
        """
        self.config = config
        self.feed = feed
        self.mt5 = api if api is not None else mt5_pkg
        self.log = get_logger("broker")
        self.paper = config.paper_mode if config.paper_mode is not None else (self.mt5 is None)
        self._paper_next_ticket = itertools.count(900_001)
        self._paper_positions: Dict[int, Dict[str, float]] = {}
        if self.paper:
            self.log.warning(
                "PAPER MODE — orders are simulated locally, no request reaches a real account."
            )

    # ── order construction ────────────────────────────────────────────

    def _price_for(self, pair: str, direction: str) -> float:
        """Bid for BUY exits/entries, ask for SELL — fail loudly on bad ticks."""
        if self.feed is None:
            raise RuntimeError("Broker needs a data feed to price orders")
        tick = self.feed.get_latest_tick(pair)
        price = float(tick["ask"] if direction.upper() == "BUY" else tick["bid"])
        if not math.isfinite(price) or price <= 0:
            raise RuntimeError(f"Invalid price for {pair}: {price}")
        return price

    def build_request(
        self,
        symbol: str,
        action: str,
        volume: float,
        price: float,
        stop_loss: float,
        take_profit: float,
        ticket: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Assemble an MT5 order dict (used for both entry and close).

        Args:
            symbol: Broker symbol without slashes.
            action: ``"BUY"`` or ``"SELL"``.
            volume: Lots.
            price: 0.0 for market execution.
            stop_loss: Protective stop (0 disables).
            take_profit: Target (0 disables).
            ticket: Position ticket, required for closes.
        """
        if self.mt5 is None:
            type_buy = type_sell = None
        else:
            type_buy = self.mt5.ORDER_TYPE_BUY
            type_sell = self.mt5.ORDER_TYPE_SELL
        return {
            "action": self.mt5.TRADE_ACTION_DEAL if self.mt5 else 1 if action == "BUY" else 2,
            "symbol": symbol,
            "volume": round(float(volume), 2),
            "type": type_sell if action == "SELL" else type_buy,
            "price": round(float(price), 5) if price else 0.0,
            "deviation": 20,
            "magic": BOT_MAGIC,
            "order": ticket or 0,
            "comment": BOT_COMMENT,
            "expiration": self.mt5.ORDER_TIME_GTC if self.mt5 else 0,
            "type_filling": getattr(self.mt5, "ORDER_FILLING_IOC", 0) if self.mt5 else 0,
            "sl": round(float(stop_loss), 5) if stop_loss else 0.0,
            "tp": round(float(take_profit), 5) if take_profit else 0.0,
            "tick_type": 0,
        }

    # ── public API ────────────────────────────────────────────────────

    def open_trade(
        self,
        pair: str,
        direction: str,
        lots: float,
        sl: float,
        tp: float,
    ) -> Optional[Position]:
        """Send a market order with SL/TP attached; ``None`` on rejection.

        Args:
            pair: Instrument (slashes allowed).
            direction: ``"BUY"`` / ``"SELL"``.
            lots: Requested volume (already risk-checked).
            sl: Stop-loss price.
            tp: Take-profit price.
        """
        direction = direction.upper()
        if lots <= 0:
            self.log.error("Refusing %s %s: non-positive lot size %s", direction, pair, lots)
            return None
        if direction == "BUY" and not (sl < tp):
            self.log.error("Refusing BUY %s: stops inverted (SL %.5f >= TP %.5f)", pair, sl, tp)
            return None
        if direction == "SELL" and not (tp < sl):
            self.log.error("Refusing SELL %s: stops inverted (TP %.5f >= SL %.5f)", pair, tp, sl)
            return None

        try:
            price = self._price_for(pair, direction)
        except Exception as exc:
            self.log.error("Cannot price %s: %s", pair, exc)
            return None

        symbol = ForexDataFeed._to_symbol(pair)
        request = self.build_request(symbol, direction, lots, price, sl, tp)

        if self.paper:
            fill = self._paper_fill(direction, symbol, lots, price, sl, tp)
        else:
            try:
                result = self.mt5.order_send(request)
            except Exception as exc:
                self.log.error("order_send(%s) raised %s", symbol, exc)
                return None
            retcode = int(getattr(result, "retcode", -1))
            if result is None or retcode != 10009:  # TRADE_RETCODE_DONE
                desc = getattr(result, "comment", "no response") if result else "empty response"
                self.log.error("REJECTED %s %s — retcode %s (%s)", direction, symbol, retcode, desc)
                return None
            fill = Fill(
                ok=True,
                ticket=int(getattr(result, "order", 0)),
                price=float(getattr(result, "price", price)),
                volume=float(getattr(result, "volume", lots)),
                retcode=retcode,
            )

        position = Position(
            pair=pair,
            direction=direction,
            lots=round(fill.volume, 2),
            open_price=round(fill.price, 5),
            stop_loss=round(sl, 5),
            take_profit=round(tp, 5),
            open_time=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            ticket=fill.ticket,
            comment=BOT_COMMENT,
        )
        self.log.info(
            "FILLED %s %s %.2f lots @ %.5f (ticket %s, retcode %s)",
            direction, pair, position.lots, position.open_price, position.ticket, fill.retcode,
        )
        return position

    def close_trade(self, position: Position, reason: str = "manual") -> float:
        """Close *position* at market and return realised P&L in dollars.

        Never throws: a failed close is logged and returns 0.0 so the loop
        keeps managing the remaining exposure.
        """
        try:
            price = self._price_for(position.pair, "SELL" if position.is_long else "BUY")
        except Exception as exc:
            self.log.error("Cannot price close for %s: %s", position.pair, exc)
            return 0.0

        if not self.paper:
            symbol = ForexDataFeed._to_symbol(position.pair)
            request = self.build_request(
                symbol,
                "SELL" if position.is_long else "BUY",
                position.lots,
                price,
                0.0,
                0.0,
                ticket=position.ticket,
            )
            try:
                result = self.mt5.order_send(request)
                retcode = int(getattr(result, "retcode", -1))
                if result is None or retcode != 10009:
                    self.log.error(
                        "Close of ticket %s rejected (retcode %s: %s)",
                        position.ticket, retcode, getattr(result, "comment", "?"),
                    )
                    return 0.0
                price = float(getattr(result, "price", price))
                self._sync_realised_pnl(position, retcode)
            except Exception as exc:
                self.log.error("Exception while closing ticket %s: %s", position.ticket, exc)
                return 0.0
        else:
            self._paper_positions.pop(position.ticket, None)

        pnl = self.estimate_pnl(position, price)
        self.log.info(
            "CLOSED ticket %s %s %s %.2f lots @ %.5f → %+.2f USD (%s)",
            position.ticket, position.direction, position.pair, position.lots, price, pnl, reason,
        )
        return round(pnl, 2)

    def estimate_pnl(self, position: Position, close_price: float) -> float:
        """Cash P&L from entry→*close_price* using the configured pip value."""
        pip_size = self.config.pip_size_for(position.pair)
        return position.unrealised_pnl(close_price, pip_size, self.config.pip_value)

    def get_open_positions(self) -> List[Dict[str, Any]]:
        """All terminal positions carrying this bot's magic number."""
        if self.paper:
            return [dict(v) for v in self._paper_positions.values()]
        try:
            raw = self.mt5.positions_get(symbol="") or ()
        except Exception as exc:
            self.log.error("positions_get failed: %s", exc)
            return []
        out = []
        for p in raw:
            if int(getattr(p, "magic", 0)) != BOT_MAGIC:
                continue
            out.append(
                {
                    "ticket": int(p.ticket),
                    "symbol": str(p.symbol),
                    "direction": "BUY" if int(p.type) == 0 else "SELL",
                    "volume": float(p.volume),
                    "price_open": float(p.price_open),
                    "sl": float(p.sl),
                    "tp": float(p.tp),
                    "profit": float(p.profit),
                    "time": datetime.fromtimestamp(int(p.time), tz=timezone.utc).isoformat(),
                }
            )
        return out

    def position_ticket_exists(self, ticket: int) -> bool:
        """True when *ticket* is still open on the terminal (used by the loop)."""
        return any(p["ticket"] == ticket for p in self.get_open_positions())

    def sync_stops(self, position: Position, sl: float, tp: float) -> bool:
        """Best-effort ``TRADE_ACTION_SLTP`` so local and terminal agree."""
        if self.paper:
            position.stop_loss, position.take_profit = round(sl, 5), round(tp, 5)
            return True
        request = {
            "action": self.mt5.TRADE_ACTION_SLTP,
            "position": position.ticket,
            "symbol": ForexDataFeed._to_symbol(position.pair),
            "sl": round(sl, 5),
            "tp": round(tp, 5),
            "magic": BOT_MAGIC,
            "comment": BOT_COMMENT,
        }
        try:
            result = self.mt5.order_send(request)
            ok = int(getattr(result, "retcode", -1)) == 10009
            if not ok:
                self.log.warning("SL/TP modify rejected for %s: %s", position.ticket, result)
            return ok
        except Exception as exc:
            self.log.error("SL/TP modify raised %s", exc)
            return False

    # ── paper plumbing ────────────────────────────────────────────────

    def _paper_fill(self, direction: str, symbol: str, lots: float, price: float, sl: float, tp: float) -> Fill:
        """Simulate a synchronous IOC fill at the requested price."""
        ticket = next(self._paper_next_ticket)
        self._paper_positions[ticket] = {
            "ticket": ticket,
            "symbol": symbol,
            "direction": direction,
            "volume": float(lots),
            "price_open": float(price),
            "sl": float(sl),
            "tp": float(tp),
            "profit": 0.0,
        }
        return Fill(ok=True, ticket=ticket, price=price, volume=lots, retcode=10009, error="")

    def _sync_realised_pnl(self, position: Position, retcode: int) -> None:
        """Read the deal P&L from the terminal, if the API is available."""
        try:
            deals = self.mt5.history_deals_get(ticket=position.ticket, position=position.ticket) or ()
            total = sum(float(d.profit) + float(d.swap) + float(d.commission) for d in deals)
            self.log.debug("Terminal reports %+.2f for ticket %s (retcode %s)", total, position.ticket, retcode)
        except Exception as exc:  # older builds lack `position=` kwarg
            self.log.debug("Deal P&L lookup unavailable (%s) — using pip estimate", exc)
