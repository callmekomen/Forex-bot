"""
telegram_control.py — start / stop / supervise the bot from Telegram.
════════════════════════════════════════════════════════════════════════
Design rules
------------
1. **Fail closed on identity.** An inbound command is honoured only when its
   ``chat_id`` is present in ``config.telegram_chat_ids``. An unknown chat gets
   a refusal, a ``SECURITY WARNING`` in ``errors.log``, and — at most — a
   pairing prompt. There is no "admin override" text command.
2. **No trade path.** Telegram can start, stop, flatten, inspect and clear a
   halt. It can *not* place a custom order, change lot size, or skip the risk
   manager; every entry still goes through ``RiskManager.validate_trade()``.
3. **Zero extra dependencies.** Plain ``urllib`` against the Bot API, so the
   only requirements stay ``MetaTrader5``, ``pandas``, ``numpy``.
4. **Testable.** Pass ``api=`` any object exposing ``call(method, payload)``
   and the whole gateway runs offline.

Commands
--------
/start · /stop · /status · /positions · /close <ticket|all> · /risk · /pairs
/halt · /resume · /tick · /id · /pair <code> · /help
"""

from __future__ import annotations

import json
import random
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from config import BOT_MAGIC, BotConfig
from logger import get_logger

API_BASE = "https://api.telegram.org/bot{token}/{method}"

#: verbs that a *stranger* is allowed to use (everything else is refused)
PUBLIC_COMMANDS = {"/id", "/pair", "/help", "/start"}


class TelegramError(RuntimeError):
    """Raised when the Bot API answers with an error or is unreachable."""


class HttpApi:
    """Minimal ``urllib`` wrapper around the Telegram Bot API."""

    def __init__(self, token: str, timeout: float = 35.0) -> None:
        """Bind to a bot token obtained from @BotFather."""
        if not token:
            raise TelegramError("empty bot token — set FXBOT_TELEGRAM_TOKEN")
        self.token = token
        self.timeout = timeout

    def call(self, method: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """POST one API method and return the parsed ``result``.

        Raises:
            TelegramError: transport failure or ``ok: false`` response.
        """
        url = API_BASE.format(token=self.token, method=method)
        data = urllib.parse.urlencode(payload or {}).encode("utf-8")
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data=data), timeout=self.timeout) as res:
                body = json.loads(res.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
            raise TelegramError(f"{method} failed: {exc}") from exc
        if not body.get("ok"):
            raise TelegramError(f"{method} rejected: {body.get('description', 'unknown error')}")
        return body.get("result", {})


@dataclass
class Command:
    """A parsed inbound message."""

    verb: str
    args: List[str]
    chat_id: int
    user: str
    text: str

    @property
    def is_command(self) -> bool:
        """True when the message began with a slash."""
        return self.text.startswith("/")


@dataclass
class RateLimiter:
    """Token bucket per chat so a compromised/typo-happy client can't flood."""

    per_minute: int = 30
    min_interval: float = 0.35
    _stamps: Dict[int, List[float]] = field(default_factory=dict)
    _last: Dict[int, float] = field(default_factory=dict)

    def allow(self, chat_id: int) -> bool:
        """True when this chat may send another command right now."""
        now = time.time()
        if now - self._last.get(chat_id, 0.0) < self.min_interval:
            return False
        bucket = [t for t in self._stamps.get(chat_id, []) if now - t < 60.0]
        if len(bucket) >= self.per_minute:
            return False
        bucket.append(now)
        self._stamps[chat_id] = bucket
        self._last[chat_id] = now
        return True


class TelegramGateway:
    """Long-polling loop bridging Telegram ⇄ a running :class:`ForexBot`."""

    def __init__(
        self,
        config: BotConfig,
        bot: Any,
        api: Optional[Any] = None,
        on_command: Optional[Callable[[str, int], str]] = None,
    ) -> None:
        """
        Args:
            config: Bot config; supplies token, allowlist, pairing code.
            bot: The live ``ForexBot`` (duck-typed so there is no import cycle).
            api: Injectable transport (``HttpApi`` by default, stub in tests).
            on_command: Optional extra handler for app-specific verbs.
        """
        self.config = config
        self.bot = bot
        self.api = api if api is not None else HttpApi(config.telegram_token or "")
        self.on_command_extra = on_command
        self.log = get_logger("telegram")
        self.allowed: List[int] = list(config.telegram_chat_ids or [])
        self.pairing_code = config.telegram_pairing_code or f"{random.SystemRandom().randint(0, 999999):06d}"
        self.limiter = RateLimiter()
        self._offset = 0
        self._thread: Optional[threading.Thread] = None
        self._watcher: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self.running = False
        self._last_trade_count = len(getattr(bot.risk, "trade_log", []))
        self._last_open_count = len(getattr(bot.risk, "open_positions", []))

    # ── lifecycle ─────────────────────────────────────────────────────

    def start(self) -> bool:
        """Spin up the poll + notify threads. ``False`` if disabled/misconfigured."""
        if not self.config.telegram_enabled:
            self.log.info("Telegram control disabled (set telegram_enabled + FXBOT_TELEGRAM_TOKEN).")
            return False
        if not self.allowed:
            self.log.warning(
                "No telegram_chat_ids configured. Pair from the terminal with:  /pair %s", self.pairing_code
            )
        self._stop.clear()
        self.running = True
        self._thread = threading.Thread(target=self._poll_loop, name="tg-poll", daemon=True)
        self._watcher = threading.Thread(target=self._watch_loop, name="tg-watch", daemon=True)
        self._thread.start()
        self._watcher.start()
        self.log.info("Telegram gateway online — allowed chats: %s", self.allowed or "none yet")
        try:
            self.send("✅ forex_bot gateway online. /status for a report, /stop to halt the loop.")
        except TelegramError as exc:
            self.log.error("Could not send hello: %s", exc)
        return True

    def stop(self) -> None:
        """Ask both threads to exit and push a farewell line."""
        self._stop.set()
        self.running = False
        for t in (self._thread, self._watcher):
            if t and t.is_alive():
                t.join(timeout=3)
        try:
            self.send("⏹ gateway stopped. The bot keeps whatever the risk manager already allowed.")
        except TelegramError:
            pass

    # ── inbound ───────────────────────────────────────────────────────

    def _poll_loop(self) -> None:
        """Long-poll ``getUpdates``; never dies on a transient API error."""
        while not self._stop.is_set():
            try:
                result = self.api.call(
                    "getUpdates",
                    {"offset": self._offset + 1, "timeout": min(25, self.config.tick_interval or 25), "allowed_updates": '["message"]'},
                )
                updates = result if isinstance(result, list) else result.get("result", [])
                for update in updates:
                    self._offset = max(self._offset, int(update.get("update_id", 0)))
                    self.handle_update(update)
            except TelegramError as exc:
                self.log.warning("getUpdates failed (%s) — backing off 10s", exc)
                self._stop.wait(10)
            except Exception as exc:  # pragma: no cover - defensive
                self.log.exception("Poll loop error: %s", exc)
                self._stop.wait(5)

    def handle_update(self, update: Dict[str, Any]) -> Optional[str]:
        """Parse one update, authorise it, dispatch, and reply. Returns the reply."""
        message = update.get("message") or {}
        text = (message.get("text") or "").strip()
        chat = int(message.get("chat", {}).get("id") or 0)
        if not text or not chat:
            return None
        user = message.get("from", {}).get("username") or message.get("from", {}).get("first_name") or "unknown"
        cmd = self.parse(text)
        cmd.chat_id = chat
        cmd.user = user

        if not self.limiter.allow(chat):
            self.log.warning("Rate limit hit by chat %s (%s)", chat, user)
            return None

        authorized = chat in self.allowed
        if not authorized and cmd.verb not in PUBLIC_COMMANDS:
            self.log.error("SECURITY WARNING — unauthorised chat_id %s (%s) sent %r", chat, user, text[:80])
            return self.send(
                "⛔ Not authorised. Your chat id is "
                f"`{chat}`.\nAdd it to telegram_chat_ids in config.py, or use /pair <code> if the "
                "operator is at the terminal.",
                chat,
            )

        reply = self.dispatch(cmd, authorized)
        if reply:
            self.send(reply, chat)
        return reply

    @staticmethod
    def parse(text: str) -> Command:
        """Split ``"/close 900012 now"`` into verb + args."""
        parts = text.split()
        verb = parts[0].lower().split("@")[0]
        return Command(verb=verb, args=parts[1:], chat_id=0, user="", text=text)

    def dispatch(self, cmd: Command, authorized: bool) -> str:
        """Map a verb onto behaviour. Everything here is read-mostly and safe."""
        verb, args = cmd.verb, cmd.args

        if verb == "/start":
            if not authorized:
                return self._pair_prompt(cmd)
            already = not getattr(self.bot, "paused", False) and getattr(self.bot, "running", False)
            if hasattr(self.bot, "start_now"):
                self.bot.start_now()
            return "▶️ already running." if already else "▶️ trading loop armed — signals will pass the risk gate from the next tick."

        if verb == "/stop":
            if not authorized:
                return self._pair_prompt(cmd)
            if hasattr(self.bot, "stop_now"):
                self.bot.stop_now(reason="telegram /stop")
            return "⏹ stopping after the current tick. Open positions keep their SL/TP."

        if verb == "/halt":
            if not authorized:
                return self._pair_prompt(cmd)
            risk = getattr(self.bot, "risk", None)
            if risk is not None:
                risk.halted = True
                risk.halt_reason = "operator halt via Telegram /halt"
                risk._save_state()  # noqa: SLF001 - deliberate, halt must survive a restart
            return "🛑 HALTED. No new entries until /resume (state file updated)."

        if verb == "/resume":
            if not authorized:
                return self._pair_prompt(cmd)
            risk = getattr(self.bot, "risk", None)
            if risk is not None:
                risk.reset_halt(reason="telegram /resume")
            if hasattr(self.bot, "start_now"):
                self.bot.start_now()
            return "↩️ halt cleared and loop resumed. Verify the numbers below look sane."

        if verb == "/tick":
            if not authorized:
                return self._pair_prompt(cmd)
            if hasattr(self.bot, "_tick"):
                self.bot._tick()  # noqa: SLF001 - operator requested a single manual pass
            return "🔎 one analysis pass completed."

        if verb == "/status":
            return self.status_text() if authorized else self._pair_prompt(cmd)
        if verb == "/positions":
            return self.positions_text() if authorized else self._pair_prompt(cmd)
        if verb == "/close":
            return self.close_text(args) if authorized else self._pair_prompt(cmd)
        if verb == "/risk":
            return self.risk_text() if authorized else self._pair_prompt(cmd)
        if verb == "/pairs":
            return "📌 watching: " + ", ".join(self.config.pairs) + f"  [{self.config.timeframe}]"
        if verb == "/id":
            return f"Your chat id is `{cmd.chat_id}` — put it in telegram_chat_ids to stay authorised."
        if verb == "/pair":
            return self.pair(cmd)
        if verb in ("/help", "/start_bot"):
            return self.help_text()
        if cmd.is_command:
            return f"Unknown command `{verb}`. Try /help."
        return "I only take commands — try /status or /help."

    # ── renderers ─────────────────────────────────────────────────────

    def status_text(self) -> str:
        """Multi-line account/loop report, same numbers the console prints."""
        risk = getattr(self.bot, "risk", None)
        stats = risk.stats() if risk is not None else {}
        running = getattr(self.bot, "running", False)
        paused = getattr(self.bot, "paused", False)
        state = "🟢 running" if running and not paused else "🟡 armed, paused" if paused else "🔴 stopped"
        lines = [
            f"{state}  ·  tick {getattr(self.bot, 'ticks', 0)}",
            f"💰 equity {stats.get('balance', 0):,.2f} USD   peak {stats.get('peak_balance', 0):,.2f}",
            f"📅 day P&L {stats.get('daily_pnl', 0):+,.2f}   drawdown {stats.get('drawdown_pct', 0):.2f}%",
            f"📊 closed {stats.get('closed_trades', 0)} trades   win rate {stats.get('win_rate_pct', 0):.1f}%",
            f"🔓 open {stats.get('open_positions', 0)}/{self.config.max_open_positions}",
            f"🚨 halted: {stats.get('halted', False)} {stats.get('halt_reason', '')}".rstrip(),
            self._identity_line(),
        ]
        return "\n".join(lines)

    def positions_text(self) -> str:
        """Table of the bot's own open exposure (magic-filtered)."""
        risk = getattr(self.bot, "risk", None)
        positions = list(getattr(risk, "open_positions", [])) if risk is not None else []
        if not positions:
            return "No open positions."
        rows = [f"{len(positions)} open (magic {BOT_MAGIC}):"]
        for p in positions:
            rows.append(
                f"• {p.ticket} {p.pair} {p.direction} {p.lots:.2f} @ {p.open_price:.5f}\n"
                f"  SL {p.stop_loss:.5f}  TP {p.take_profit:.5f}  since {p.open_time}"
            )
        return "\n".join(rows)

    def close_text(self, args: List[str]) -> str:
        """/close <ticket> or /close all — routes through the broker + risk book."""
        broker = getattr(self.bot, "broker", None)
        risk = getattr(self.bot, "risk", None)
        if broker is None or risk is None:
            return "Broker not available."
        targets = list(risk.open_positions)
        if args and args[0].lower() not in ("all", "*"):
            try:
                ticket = int(args[0])
            except ValueError:
                return "Usage: /close <ticket|all>"
            targets = [p for p in targets if p.ticket == ticket]
            if not targets:
                return f"No open position with ticket {ticket}."
        if not targets:
            return "Nothing to close."
        out = []
        for pos in targets:
            try:
                pnl = broker.close_trade(pos, reason="telegram /close")
                risk.record_close(pnl, pos, reason="telegram")
                out.append(f"closed {pos.ticket} {pos.pair} → {pnl:+,.2f} USD")
            except Exception as exc:
                out.append(f"failed to close {pos.ticket}: {exc}")
                self.log.error("Telegram close of %s failed: %s", pos.ticket, exc)
        return "🔻 " + "; ".join(out)

    def risk_text(self) -> str:
        """Effective risk limits, so you can sanity-check before /resume."""
        cfg = self.config
        return (
            "Risk limits (read-only here — edit config.py and restart):\n"
            f"• risk/trade {cfg.max_risk_per_trade:.2%} ≈ {cfg.max_risk_dollars:,.2f} USD\n"
            f"• daily loss halt {cfg.max_daily_loss:.2%} ≈ {cfg.max_daily_loss_dollars:,.2f} USD\n"
            f"• max drawdown halt {cfg.max_drawdown_limit:.2%}\n"
            f"• max open {cfg.max_open_positions} · min confidence {cfg.min_confidence:.2f}\n"
            f"• SL {cfg.atr_multiplier}×ATR / TP {cfg.take_profit_multiplier}×ATR (RR {cfg.risk_reward_ratio})\n"
            f"• session {cfg.start_hour:02d}–{cfg.end_hour:02d} UTC · tick {cfg.tick_interval}s"
        )

    def _identity_line(self) -> str:
        """Which MT5 account we believe we are trading, and how we checked."""
        feed = getattr(self.bot, "feed", None)
        fp = getattr(feed, "account_fingerprint", None)
        if not fp:
            return "🆔 account: not verified (mock/paper feed)"
        return (
            f"🆔 account {fp.get('login')} @ {fp.get('server')} · {fp.get('currency')}"
            f" · verified={fp.get('verified')} · symbols {len(fp.get('symbols', []))}"
        )

    def help_text(self) -> str:
        """Command sheet."""
        return (
            "forex_bot commands\n"
            "/start — begin trading loop\n/start_paused alias of /status\n"
            "/stop — stop after current tick\n/status — equity, day P&L, drawdown, halt\n"
            "/positions — open tickets with SL/TP\n/close <ticket|all> — flatten via broker\n"
            "/halt — refuse new entries now\n/resume — clear halt and continue\n"
            "/risk — effective limits\n/pairs — watchlist\n/id — show your chat id\n"
            "/pair <code> — authorise this chat (code printed in the terminal)\n"
            "No command here can size a trade or bypass the risk manager."
        )

    def _pair_prompt(self, cmd: Command) -> str:
        """Refusal + instructions for a chat we do not know yet."""
        return (
            f"⛔ chat `{cmd.chat_id}` is not on the allowlist, so this command was ignored.\n"
            "Operator can authorise it from the terminal with:\n  /pair <code>\n"
            "or add the id to telegram_chat_ids in config.py and restart."
        )

    def pair(self, cmd: Command) -> str:
        """Redeem the terminal-printed code once, from the chat being added."""
        code = (cmd.args[0] if cmd.args else "").strip()
        if not code:
            return "Usage: /pair <6-digit code shown in the bot terminal>."
        if code != self.pairing_code:
            self.log.error("Pairing rejected for chat %s (bad code).", cmd.chat_id)
            return "❌ Wrong or expired code."
        if cmd.chat_id in self.allowed:
            return "This chat is already authorised."
        self.allowed.append(cmd.chat_id)
        self.pairing_code = f"{random.SystemRandom().randint(0, 999999):06d}"
        self.log.warning("Chat %s paired. Add it to telegram_chat_ids to persist across restarts.", cmd.chat_id)
        return (
            f"✅ chat `{cmd.chat_id}` authorised for this session.\n"
            "Persist it in config.py → telegram_chat_ids, then /status."
        )

    # ── outbound ──────────────────────────────────────────────────────

    def send(self, text: str, chat_id: Optional[int] = None) -> None:
        """Send a message to one chat or broadcast to the allowlist."""
        mode = self.config.telegram_notify
        if mode == "off" and not text.startswith("✅"):
            return
        targets = [chat_id] if chat_id else list(self.allowed)
        for target in targets:
            if not target:
                continue
            try:
                self.api.call(
                    "sendMessage",
                    {"chat_id": target, "text": text[:4000], "parse_mode": "Markdown", "disable_web_page_preview": True},
                )
            except TelegramError as exc:
                self.log.error("sendMessage to %s failed: %s", target, exc)

    def _watch_loop(self) -> None:
        """Push fills/closes so the phone is a truthful mirror of the desk."""
        while not self._stop.wait(max(3.0, self.config.tick_interval / 2)):
            try:
                risk = getattr(self.bot, "risk", None)
                if risk is None:
                    continue
                trades = list(getattr(risk, "trade_log", []))
                if len(trades) > self._last_trade_count and self.config.telegram_notify != "off":
                    for item in trades[self._last_trade_count :]:
                        emoji = "🟢" if item.get("pnl", 0) > 0 else "🔴"
                        self.send(
                            f"{emoji} closed {item.get('direction')} {item.get('pair')} "
                            f"{item.get('lots')} lots → {item.get('pnl', 0):+,.2f} USD "
                            f"({item.get('exit')}) · balance {item.get('balance_after', 0):,.2f}"
                        )
                    self._last_trade_count = len(trades)
                open_count = len(getattr(risk, "open_positions", []))
                if open_count != self._last_open_count and self.config.telegram_notify == "all":
                    self.send(f"📈 open positions: {open_count}/{self.config.max_open_positions}")
                    self._last_open_count = open_count
                if getattr(risk, "halted", False) and self.config.telegram_notify != "off":
                    self._stop.wait(300)
                    self.send(f"🚨 HALT — {getattr(risk, 'halt_reason', 'limit breached')}")
            except Exception as exc:  # pragma: no cover - watcher must never die
                self.log.warning("Watch loop hiccup: %s", exc)
