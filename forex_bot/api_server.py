"""
api_server.py — local HTTP control plane for the dashboard.
════════════════════════════════════════════════════════════════════════
Exposes the *existing* :class:`main.ForexBot` over a small JSON API so the
Vite dashboard can start, stop, inspect and flatten the bot from a browser.

Design rules
------------
* **Standard library only.** No FastAPI/Flask — ``requirements.txt`` stays
  as it was, and the bot's dependency surface does not grow.
* **Wraps, never reimplements.** Every mutation routes through the same
  ``ForexBot`` / ``RiskManager`` / ``Broker`` calls that Telegram uses, so
  the risk gates cannot be bypassed by talking to HTTP instead.
* **Paper by default.** Live MT5 trading requires ``--allow-live`` *and*
  ``FXBOT_API_ALLOW_LIVE=1``. Two independent switches, both off by default.
* **Localhost by default.** Binds 127.0.0.1 unless told otherwise, and any
  non-loopback bind demands a token.

Run it
------
    python api_server.py                 # paper, 127.0.0.1:8787
    python api_server.py --port 9000
    python api_server.py --host 0.0.0.0 --token secret123
    python api_server.py --allow-live    # + FXBOT_API_ALLOW_LIVE=1

Endpoints
---------
``GET  /api/health``     liveness, no auth
``GET  /api/status``     mode, loop state, risk stats, account fingerprint
``GET  /api/config``     effective configuration (secrets redacted)
``GET  /api/positions``  open positions, marked to market
``GET  /api/signals``    recent signals seen by the strategy
``GET  /api/logs``       tail of the in-memory log ring
``GET  /api/events``     server-sent events stream of status snapshots
``POST /api/start``      start the loop   ``{"mode": "paper"|"live"}``
``POST /api/stop``       stop after the current tick
``POST /api/pause``      idle the loop, stay connected
``POST /api/analyze``    dry-run scoring of every pair, executes nothing
``POST /api/tick``       force one tick (only while the loop is stopped)
``POST /api/close``      ``{"ticket": 123}`` or ``{"ticket": "all"}``
``POST /api/halt``       latch the risk halt now
``POST /api/resume``     clear a latched halt
``POST /api/backtest``   ``{"pair": "EUR/USD", "bars": 4000}``
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import threading
import time
from collections import deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Deque, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

from config import BotConfig
from data_feed import MockDataFeed
from logger import get_logger
from main import ForexBot

API_VERSION = "1.0"
MAX_LOG_LINES = 500
MAX_SIGNALS = 100


# ══════════════════════════════════════════════════════════════════════
# Capture helpers
# ══════════════════════════════════════════════════════════════════════


class RingLogHandler(logging.Handler):
    """Keep the last *capacity* log records in memory for ``GET /api/logs``."""

    def __init__(self, capacity: int = MAX_LOG_LINES) -> None:
        super().__init__()
        self.records: Deque[Dict[str, Any]] = deque(maxlen=capacity)
        self._seq = 0
        self._lock = threading.Lock()

    def emit(self, record: logging.LogRecord) -> None:
        """Append one formatted record; never raise into the logging call."""
        try:
            with self._lock:
                self._seq += 1
                self.records.append(
                    {
                        "id": self._seq,
                        "time": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
                        "level": record.levelname,
                        "message": record.getMessage(),
                    }
                )
        except Exception:  # pragma: no cover - logging must never explode
            pass

    def tail(self, limit: int = 200, after: int = 0) -> List[Dict[str, Any]]:
        """Return up to *limit* records with ``id > after``."""
        with self._lock:
            items = [r for r in self.records if r["id"] > after]
        return items[-limit:]


class SignalRecorder:
    """Remembers recent :class:`strategy.TradeSignal` objects for the UI."""

    def __init__(self, capacity: int = MAX_SIGNALS) -> None:
        self.items: Deque[Dict[str, Any]] = deque(maxlen=capacity)
        self._lock = threading.Lock()

    def add(self, signal: Any) -> None:
        """Flatten *signal* into a JSON-safe dict and store it."""
        try:
            row = {
                "time": datetime.now(timezone.utc).isoformat(),
                "pair": signal.pair,
                "signal": signal.signal.label(),
                "actionable": bool(signal.signal.actionable),
                "price": signal.price,
                "stop_loss": signal.stop_loss,
                "take_profit": signal.take_profit,
                "confidence": signal.confidence,
                "score": signal.score,
                "risk_reward": signal.risk_reward,
                "reasons": list(signal.reasons),
                "indicators": dict(signal.indicators),
            }
        except Exception:
            return
        with self._lock:
            self.items.append(row)

    def recent(self, limit: int = 25) -> List[Dict[str, Any]]:
        """Most recent signals, newest last."""
        with self._lock:
            return list(self.items)[-limit:]


# ══════════════════════════════════════════════════════════════════════
# Supervisor
# ══════════════════════════════════════════════════════════════════════


class BotSupervisor:
    """Owns the bot instance and the thread its loop runs in.

    The dashboard is stateless; all state lives here. Every mutating call
    is serialised behind ``self._lock`` so two browser tabs cannot race the
    loop into an inconsistent state.
    """

    def __init__(self, allow_live: bool = False) -> None:
        """Create a supervisor with no bot yet (built lazily on start).

        Args:
            allow_live: Master switch permitting ``mode="live"``. Even when
                True, ``FXBOT_API_ALLOW_LIVE=1`` must also be set.
        """
        self.allow_live = allow_live
        self.log = get_logger("api")
        self.logs = RingLogHandler()
        self.signals = SignalRecorder()
        self.bot: Optional[ForexBot] = None
        self.mode: str = "idle"
        self.thread: Optional[threading.Thread] = None
        self.started_at: Optional[str] = None
        self.last_error: str = ""
        self._lock = threading.RLock()

        root = logging.getLogger("forex_bot")
        self.logs.setLevel(logging.INFO)
        root.addHandler(self.logs)

    # ── construction ──────────────────────────────────────────────────

    def _build(self, mode: str) -> ForexBot:
        """Instantiate a bot wired for *mode* and attach the signal recorder."""
        cfg = BotConfig()
        if mode == "paper":
            feed = MockDataFeed(cfg)
            cfg.paper_mode = True
            bot = ForexBot(config=cfg, feed=feed)
        else:
            bot = ForexBot(config=cfg)

        # Non-invasive capture: wrap analyze() so main.py needs no changes.
        original = bot.strategy.analyze

        def recording_analyze(df: Any, pair: str, price: Optional[float] = None) -> Any:
            signal = original(df, pair, price)
            self.signals.add(signal)
            return signal

        bot.strategy.analyze = recording_analyze  # type: ignore[assignment]
        return bot

    def live_permitted(self) -> Tuple[bool, str]:
        """Whether live trading is unlocked, plus the reason when it is not."""
        if not self.allow_live:
            return False, "server started without --allow-live"
        if os.environ.get("FXBOT_API_ALLOW_LIVE", "") != "1":
            return False, "FXBOT_API_ALLOW_LIVE is not set to 1"
        return True, "live trading unlocked"

    # ── lifecycle ─────────────────────────────────────────────────────

    def start(self, mode: str = "paper") -> Dict[str, Any]:
        """Start the tick loop in a daemon thread.

        Args:
            mode: ``"paper"`` (mock feed, simulated fills) or ``"live"``.

        Returns:
            ``{"ok": bool, "message": str, ...}``.
        """
        with self._lock:
            if self.thread and self.thread.is_alive():
                return {"ok": False, "message": f"already running in {self.mode} mode"}
            if mode not in ("paper", "live"):
                return {"ok": False, "message": f"unknown mode {mode!r}"}
            if mode == "live":
                ok, why = self.live_permitted()
                if not ok:
                    return {
                        "ok": False,
                        "message": f"live trading is locked: {why}",
                        "hint": "restart with --allow-live and FXBOT_API_ALLOW_LIVE=1",
                    }
            try:
                self.bot = self._build(mode)
            except Exception as exc:
                self.last_error = str(exc)
                self.log.exception("Could not build the bot: %s", exc)
                return {"ok": False, "message": f"failed to build bot: {exc}"}

            self.mode = mode
            self.started_at = datetime.now(timezone.utc).isoformat()
            self.last_error = ""

            def runner() -> None:
                try:
                    assert self.bot is not None
                    self.bot.run()
                except Exception as exc:  # pragma: no cover - defensive
                    self.last_error = str(exc)
                    self.log.exception("Bot loop died: %s", exc)

            self.thread = threading.Thread(target=runner, name="bot-loop", daemon=True)
            self.thread.start()
            self.log.info("API started the bot in %s mode.", mode)
            return {"ok": True, "message": f"bot started in {mode} mode", "mode": mode}

    def stop(self) -> Dict[str, Any]:
        """Ask the loop to finish the current tick and exit."""
        with self._lock:
            if not (self.thread and self.thread.is_alive()) or self.bot is None:
                return {"ok": False, "message": "bot is not running"}
            self.bot.stop_now(reason="dashboard")
        self.thread.join(timeout=10)
        alive = bool(self.thread and self.thread.is_alive())
        self.mode = "idle" if not alive else self.mode
        self.log.info("API stopped the bot (clean=%s).", not alive)
        return {
            "ok": True,
            "message": "stop requested" + ("" if not alive else " (loop still winding down)"),
            "stopped": not alive,
        }

    def pause(self) -> Dict[str, Any]:
        """Idle the loop without disconnecting (mirrors Telegram's pause)."""
        with self._lock:
            if self.bot is None:
                return {"ok": False, "message": "bot is not running"}
            self.bot.paused = True
            return {"ok": True, "message": "loop paused — no analysis until resumed"}

    def unpause(self) -> Dict[str, Any]:
        """Un-pause the loop. Refused while a risk halt is latched."""
        with self._lock:
            if self.bot is None:
                return {"ok": False, "message": "bot is not running"}
            if self.bot.risk.halted:
                return {
                    "ok": False,
                    "message": f"halt latched: {self.bot.risk.halt_reason} — clear it first",
                }
            self.bot.start_now()
            return {"ok": True, "message": "loop un-paused"}

    # ── risk controls ─────────────────────────────────────────────────

    def halt(self, reason: str = "dashboard") -> Dict[str, Any]:
        """Latch the risk halt immediately — no new entries."""
        with self._lock:
            if self.bot is None:
                return {"ok": False, "message": "bot is not running"}
            self.bot.risk.halted = True
            self.bot.risk.halt_reason = f"manual halt ({reason})"
            self.bot.risk._save_state()
            self.log.critical("HALT latched from the dashboard.")
            return {"ok": True, "message": "halt latched — existing positions keep their SL/TP"}

    def resume(self) -> Dict[str, Any]:
        """Clear a latched halt after human review."""
        with self._lock:
            if self.bot is None:
                return {"ok": False, "message": "bot is not running"}
            if not self.bot.risk.halted:
                return {"ok": True, "message": "no halt was latched"}
            self.bot.risk.reset_halt(reason="dashboard")
            return {"ok": True, "message": "halt cleared"}

    def close(self, ticket: Any) -> Dict[str, Any]:
        """Flatten one ticket or everything, through the broker + risk book."""
        with self._lock:
            if self.bot is None:
                return {"ok": False, "message": "bot is not running"}
            targets = list(self.bot.risk.open_positions)
            if str(ticket).lower() not in ("all", "*"):
                try:
                    want = int(ticket)
                except (TypeError, ValueError):
                    return {"ok": False, "message": "ticket must be an integer or 'all'"}
                targets = [p for p in targets if p.ticket == want]
                if not targets:
                    return {"ok": False, "message": f"no open position with ticket {ticket}"}
            if not targets:
                return {"ok": False, "message": "nothing to close"}

            results = []
            for pos in targets:
                try:
                    pnl = self.bot.broker.close_trade(pos, reason="dashboard")
                    self.bot.risk.record_close(pnl, pos, reason="dashboard")
                    results.append({"ticket": pos.ticket, "pair": pos.pair, "pnl": pnl, "ok": True})
                except Exception as exc:
                    self.log.error("Dashboard close of %s failed: %s", pos.ticket, exc)
                    results.append({"ticket": pos.ticket, "error": str(exc), "ok": False})
            return {"ok": True, "closed": results}

    # ── read-only analysis ────────────────────────────────────────────

    def analyze(self) -> Dict[str, Any]:
        """Score every pair **without trading** — a safe dry run.

        Builds a throwaway paper bot when nothing is running, so the
        dashboard can show live scoring before you commit to starting.
        """
        bot = self.bot
        temporary = False
        if bot is None:
            bot = self._build("paper")
            temporary = True
        out: List[Dict[str, Any]] = []
        now = datetime.now(timezone.utc)
        allowed, gate = bot.risk.can_trade(now)
        for pair in bot.config.pairs:
            try:
                df = bot.feed.get_candles(pair, bot.config.candles_per_call)
                signal = bot.strategy.analyze(df, pair)
                approved, lots, reason = bot.risk.validate_trade(signal, now=now)
                out.append(
                    {
                        "pair": pair,
                        "signal": signal.signal.label(),
                        "price": signal.price,
                        "stop_loss": signal.stop_loss,
                        "take_profit": signal.take_profit,
                        "confidence": signal.confidence,
                        "score": signal.score,
                        "risk_reward": signal.risk_reward,
                        "reasons": signal.reasons,
                        "indicators": signal.indicators,
                        "would_trade": bool(approved),
                        "lots": lots,
                        "verdict": reason,
                    }
                )
            except Exception as exc:
                out.append({"pair": pair, "error": str(exc)})
        if temporary and hasattr(bot.feed, "shutdown"):
            try:
                bot.feed.shutdown()
            except Exception:
                pass
        return {
            "ok": True,
            "dry_run": True,
            "gate_open": allowed,
            "gate_reason": gate,
            "results": out,
        }

    def tick(self) -> Dict[str, Any]:
        """Force a single tick — refused while the loop owns the bot."""
        with self._lock:
            if self.thread and self.thread.is_alive():
                return {
                    "ok": False,
                    "message": "the loop is running and ticks on its own — stop it first",
                }
            if self.bot is None:
                self.bot = self._build("paper")
                self.mode = "paper"
            try:
                self.bot._tick()
                self.bot.ticks += 1
                return {"ok": True, "message": f"tick {self.bot.ticks} complete", "status": self.bot.last_status}
            except Exception as exc:
                self.log.exception("Manual tick failed: %s", exc)
                return {"ok": False, "message": f"tick failed: {exc}"}

    def backtest(self, pair: str = "", bars: int = 4000, spread: float = 1.5) -> Dict[str, Any]:
        """Run the production backtester on synthetic or live history."""
        try:
            from backtester import Backtester
        except Exception as exc:
            return {"ok": False, "message": f"backtester unavailable: {exc}"}
        from strategy import AdvancedStrategy

        cfg = BotConfig()
        target = pair or cfg.pairs[0]
        try:
            feed = MockDataFeed(cfg, bars=max(bars, 500))
            df = feed.history(target) if hasattr(feed, "history") else feed.get_candles(target, bars)
            tester = Backtester(config=cfg, strategy=AdvancedStrategy(cfg))
            metrics = tester.run(df, target, spread_pips=spread)
            return {"ok": True, "pair": target, "bars": len(df), "metrics": _jsonable(metrics)}
        except Exception as exc:
            self.log.exception("Backtest failed: %s", exc)
            return {"ok": False, "message": f"backtest failed: {exc}"}

    # ── snapshots ─────────────────────────────────────────────────────

    def status(self) -> Dict[str, Any]:
        """Everything the dashboard header needs in one object."""
        running = bool(self.thread and self.thread.is_alive())
        bot = self.bot
        live_ok, live_why = self.live_permitted()
        payload: Dict[str, Any] = {
            "api_version": API_VERSION,
            "server_time": datetime.now(timezone.utc).isoformat(),
            "running": running,
            "mode": self.mode,
            "started_at": self.started_at,
            "last_error": self.last_error,
            "live_allowed": live_ok,
            "live_lock_reason": live_why,
        }
        if bot is None:
            payload.update(
                {
                    "paused": False,
                    "ticks": 0,
                    "status_line": "no bot instance — press Start",
                    "risk": {},
                    "account": {},
                }
            )
            return payload
        stats = bot.risk.stats()
        fingerprint = getattr(bot.feed, "account_fingerprint", {}) or {}
        payload.update(
            {
                "paused": bool(bot.paused),
                "ticks": bot.ticks,
                "signals_seen": bot.signals_seen,
                "rejected": bot.rejected,
                "status_line": bot.last_status,
                "risk": stats,
                "account": {
                    "login": fingerprint.get("login"),
                    "server": fingerprint.get("server"),
                    "currency": fingerprint.get("currency", "USD"),
                    "verified": fingerprint.get("verified", False),
                    "paper": self.mode == "paper",
                },
            }
        )
        return payload

    def positions(self) -> Dict[str, Any]:
        """Open positions, marked to market when a tick price is available."""
        if self.bot is None:
            return {"ok": True, "positions": []}
        rows = []
        for pos in self.bot.risk.open_positions:
            row = pos.to_dict()
            try:
                tick = self.bot.feed.get_latest_tick(pos.pair)
                mid = (tick["bid"] + tick["ask"]) / 2.0
                row["current_price"] = round(mid, 5)
                row["unrealised_pnl"] = pos.unrealised_pnl(
                    mid, self.bot.config.pip_size_for(pos.pair), self.bot.config.pip_value
                )
            except Exception:
                row["current_price"] = None
                row["unrealised_pnl"] = None
            rows.append(row)
        return {"ok": True, "positions": rows}

    def config_view(self) -> Dict[str, Any]:
        """Effective configuration with credentials redacted."""
        cfg = self.bot.config if self.bot else BotConfig()
        return {
            "pairs": cfg.pairs,
            "timeframe": cfg.timeframe,
            "tick_interval": cfg.tick_interval,
            "account_balance": cfg.account_balance,
            "max_risk_per_trade": cfg.max_risk_per_trade,
            "max_daily_loss": cfg.max_daily_loss,
            "max_open_positions": cfg.max_open_positions,
            "max_drawdown_limit": cfg.max_drawdown_limit,
            "min_confidence": cfg.min_confidence,
            "atr_multiplier": cfg.atr_multiplier,
            "take_profit_multiplier": cfg.take_profit_multiplier,
            "fast_ema": cfg.fast_ema,
            "slow_ema": cfg.slow_ema,
            "signal_ema": cfg.signal_ema,
            "rsi_period": cfg.rsi_period,
            "rsi_overbought": cfg.rsi_overbought,
            "rsi_oversold": cfg.rsi_oversold,
            "start_hour": cfg.start_hour,
            "end_hour": cfg.end_hour,
            "mt5_login": "***" if getattr(cfg, "mt5_login", None) else None,
            "mt5_server": getattr(cfg, "mt5_server", None),
        }


def _jsonable(value: Any) -> Any:
    """Best-effort conversion of numpy/pandas scalars into plain JSON types."""
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if hasattr(value, "item") and callable(getattr(value, "item")):
        try:
            return value.item()
        except Exception:
            return str(value)
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


# ══════════════════════════════════════════════════════════════════════
# HTTP layer
# ══════════════════════════════════════════════════════════════════════


class ControlHandler(BaseHTTPRequestHandler):
    """Routes ``/api/*`` onto :class:`BotSupervisor`."""

    server_version = f"ForexBotAPI/{API_VERSION}"
    supervisor: BotSupervisor
    token: str = ""

    # ── plumbing ──────────────────────────────────────────────────────

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        """Silence the default stderr spam; the bot logger is enough."""
        return

    def _cors(self) -> None:
        """Permissive CORS — the API only ever binds locally by default."""
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-API-Token")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _send(self, payload: Any, code: int = 200) -> None:
        """Serialise *payload* as JSON with CORS headers."""
        body = json.dumps(_jsonable(payload)).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:  # pragma: no cover - browser navigated away
            pass

    def _authorized(self) -> bool:
        """True when no token is configured or the request carries it."""
        if not self.token:
            return True
        supplied = self.headers.get("X-API-Token", "")
        if not supplied:
            supplied = parse_qs(urlparse(self.path).query).get("token", [""])[0]
        return supplied == self.token

    def _body(self) -> Dict[str, Any]:
        """Parse the JSON request body, tolerating an empty one."""
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
            if length <= 0:
                return {}
            raw = self.rfile.read(length).decode("utf-8")
            parsed = json.loads(raw) if raw.strip() else {}
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}

    # ── verbs ─────────────────────────────────────────────────────────

    def do_OPTIONS(self) -> None:  # noqa: N802
        """CORS preflight."""
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        """Read-only endpoints."""
        parsed = urlparse(self.path)
        route = parsed.path.rstrip("/") or "/"
        query = parse_qs(parsed.query)
        sup = self.supervisor

        if route in ("/api/health", "/health"):
            self._send({"ok": True, "service": "forex-bot-api", "version": API_VERSION})
            return
        if not self._authorized():
            self._send({"ok": False, "message": "unauthorized — missing or wrong X-API-Token"}, 401)
            return

        if route == "/api/status":
            self._send(sup.status())
        elif route == "/api/config":
            self._send(sup.config_view())
        elif route == "/api/positions":
            self._send(sup.positions())
        elif route == "/api/signals":
            limit = int(query.get("limit", ["25"])[0] or 25)
            self._send({"ok": True, "signals": sup.signals.recent(limit)})
        elif route == "/api/logs":
            limit = int(query.get("limit", ["200"])[0] or 200)
            after = int(query.get("after", ["0"])[0] or 0)
            self._send({"ok": True, "lines": sup.logs.tail(limit, after)})
        elif route == "/api/events":
            self._stream_events()
        else:
            self._send({"ok": False, "message": f"unknown route {route}"}, 404)

    def do_POST(self) -> None:  # noqa: N802
        """Mutating endpoints."""
        route = urlparse(self.path).path.rstrip("/") or "/"
        if not self._authorized():
            self._send({"ok": False, "message": "unauthorized — missing or wrong X-API-Token"}, 401)
            return
        body = self._body()
        sup = self.supervisor

        actions: Dict[str, Callable[[], Dict[str, Any]]] = {
            "/api/start": lambda: sup.start(str(body.get("mode", "paper")).lower()),
            "/api/stop": sup.stop,
            "/api/pause": sup.pause,
            "/api/unpause": sup.unpause,
            "/api/resume": sup.resume,
            "/api/halt": lambda: sup.halt(str(body.get("reason", "dashboard"))),
            "/api/close": lambda: sup.close(body.get("ticket", "all")),
            "/api/analyze": sup.analyze,
            "/api/tick": sup.tick,
            "/api/backtest": lambda: sup.backtest(
                str(body.get("pair", "")),
                int(body.get("bars", 4000) or 4000),
                float(body.get("spread", 1.5) or 1.5),
            ),
        }
        action = actions.get(route)
        if action is None:
            self._send({"ok": False, "message": f"unknown route {route}"}, 404)
            return
        try:
            result = action()
        except Exception as exc:
            self.supervisor.log.exception("%s failed: %s", route, exc)
            self._send({"ok": False, "message": str(exc)}, 500)
            return
        self._send(result, 200 if result.get("ok", True) else 409)

    # ── SSE ───────────────────────────────────────────────────────────

    def _stream_events(self) -> None:
        """Push a status snapshot every second until the client disconnects."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self._cors()
        self.end_headers()
        last_log_id = 0
        try:
            while True:
                snapshot = {
                    "status": self.supervisor.status(),
                    "positions": self.supervisor.positions()["positions"],
                    "logs": self.supervisor.logs.tail(40, last_log_id),
                }
                if snapshot["logs"]:
                    last_log_id = snapshot["logs"][-1]["id"]
                chunk = f"data: {json.dumps(_jsonable(snapshot))}\n\n"
                self.wfile.write(chunk.encode("utf-8"))
                self.wfile.flush()
                time.sleep(1.0)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception:  # pragma: no cover - defensive
            return


def build_server(
    host: str = "127.0.0.1", port: int = 8787, token: str = "", allow_live: bool = False
) -> Tuple[ThreadingHTTPServer, BotSupervisor]:
    """Create the HTTP server and its supervisor.

    Args:
        host: Bind address. Non-loopback binds require a token.
        port: TCP port.
        token: Shared secret checked against ``X-API-Token``.
        allow_live: Permit live MT5 mode (still needs the env var).

    Returns:
        ``(server, supervisor)`` — call ``serve_forever()`` on the server.

    Raises:
        SystemExit: Non-loopback bind without a token.
    """
    if host not in ("127.0.0.1", "localhost", "::1") and not token:
        raise SystemExit(
            f"Refusing to bind {host} without --token: that would expose bot controls "
            "to the network. Pass --token <secret> or bind 127.0.0.1."
        )
    supervisor = BotSupervisor(allow_live=allow_live)
    handler = type("BoundHandler", (ControlHandler,), {"supervisor": supervisor, "token": token})
    server = ThreadingHTTPServer((host, port), handler)
    server.daemon_threads = True
    return server, supervisor


def main(argv: Optional[List[str]] = None) -> int:
    """CLI entry point."""
    parser = argparse.ArgumentParser(description="HTTP control plane for the forex bot")
    parser.add_argument("--host", default=os.environ.get("FXBOT_API_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("FXBOT_API_PORT", "8787")))
    parser.add_argument("--token", default=os.environ.get("FXBOT_API_TOKEN", ""))
    parser.add_argument("--allow-live", action="store_true", help="permit mode=live (needs FXBOT_API_ALLOW_LIVE=1)")
    parser.add_argument("--autostart", action="store_true", help="start the paper loop immediately")
    args = parser.parse_args(argv)

    server, supervisor = build_server(args.host, args.port, args.token, args.allow_live)
    live_ok, live_why = supervisor.live_permitted()

    print("═" * 66)
    print("  FOREX BOT — HTTP CONTROL PLANE")
    print("═" * 66)
    print(f"  listening     : http://{args.host}:{args.port}/api")
    print(f"  auth          : {'token required' if args.token else 'none (loopback only)'}")
    print(f"  live trading  : {'UNLOCKED' if live_ok else 'LOCKED — ' + live_why}")
    print(f"  default mode  : paper (mock feed, simulated fills)")
    print("═" * 66)
    print("  Dashboard: run `npm run dev` in the repo root and open the preview.")
    print("  Stop with Ctrl+C.\n")

    if args.autostart:
        print(supervisor.start("paper")["message"])

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down…")
        supervisor.stop()
        server.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
