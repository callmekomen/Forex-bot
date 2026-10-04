"""
deploy/watchdog.py — supervisor: keep main.py alive, alert when it is not.
════════════════════════════════════════════════════════════════════════
Stdlib only, runs on Windows and Linux. Responsibilities:

* spawn ``python main.py`` (any flags you pass after ``--``)
* restart it on death with exponential backoff, and stop flapping if it dies
  too often (``--max-per-hour``, default 6) — a crash-loop must be loud, not endless
* optional **staleness** watchdog: if ``bot.log`` has not grown for ``--stale N``
  seconds, kill the wedged process and start a fresh one (leave 0 when you use
  ``--remote``, because an armed-but-paused bot is intentionally quiet)
* push a Telegram alert on death / restart / stale-kill when
  ``FXBOT_TELEGRAM_TOKEN`` + ``FXBOT_TELEGRAM_CHAT_IDS`` are in the environment
* propagate Ctrl+C / SIGTERM so the bot can shut the MT5 feed down cleanly

    python deploy/watchdog.py --stale 300 -- --mock --ticks 3
    python deploy/watchdog.py -- --remote
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import List, Optional

ROOT = Path(__file__).resolve().parent.parent
LOG_CANDIDATES = [ROOT / "bot.log", Path("bot.log")]


def newest_log() -> Optional[Path]:
    """Return the freshest ``bot.log`` we can find, or ``None``."""
    best: Optional[Path] = None
    for cand in LOG_CANDIDATES:
        if cand.exists() and (best is None or cand.stat().st_mtime > best.stat().st_mtime):
            best = cand
    return best


def notify(text: str) -> None:
    """Best-effort Telegram alert; never raises, never blocks for long."""
    token = os.environ.get("FXBOT_TELEGRAM_TOKEN", "").strip()
    chats = [c for c in re_split(os.environ.get("FXBOT_TELEGRAM_CHAT_IDS", "")) if c]
    if not token or not chats:
        return
    for chat in chats:
        try:
            req = urllib.request.Request(
                f"https://api.telegram.org/bot{token}/sendMessage",
                data=urllib.parse.urlencode({"chat_id": chat, "text": f"[watchdog] {text}"}).encode(),
            )
            with urllib.request.urlopen(req, timeout=10):
                pass
        except (urllib.error.URLError, TimeoutError, OSError):
            return  # alerting must never take the supervisor down


def re_split(raw: str) -> List[str]:
    """Split a comma/space separated env value."""
    return [part for part in raw.replace(",", " ").split() if part]


class Watchdog:
    """Restart loop with backoff, flapping guard and stale-process kill."""

    def __init__(self, argv: List[str], stale: int, max_per_hour: int, backoff: int) -> None:
        """
        Args:
            argv: command appended after ``python`` (e.g. ``["main.py", "--mock"]``).
            stale: seconds of log silence that count as a hang (0 disables).
            max_per_hour: restarts tolerated before we give up and alert.
            backoff: base sleep between restart attempts.
        """
        self.argv = argv
        self.stale = max(0, int(stale))
        self.max_per_hour = max(1, int(max_per_hour))
        self.backoff = max(1, int(backoff))
        self.stops = 0
        self.started_at = 0.0
        self.proc: Optional[subprocess.Popen] = None
        self._sig = False
        self.history: List[float] = []
        self.state_file = ROOT / "watchdog_state.json"

    # ── signal handling ───────────────────────────────────────────────

    def _install_handlers(self) -> None:
        """Ask the child to exit instead of killing the whole tree."""

        def handler(signum, _frame):  # noqa: ANN001 - signal signature
            self._sig = True
            print(f"[watchdog] signal {signum} received — stopping child", flush=True)
            self.terminate()

        for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
            sig = getattr(signal, name, None)
            if sig is not None:
                try:
                    signal.signal(sig, handler)
                except (ValueError, OSError):  # pragma: no cover - non-main thread
                    pass

    def terminate(self) -> None:
        """Polite terminate, then kill after 15 s."""
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            deadline = time.time() + 15
            while time.time() < deadline and self.proc.poll() is None:
                time.sleep(0.5)
            if self.proc.poll() is None:
                self.proc.kill()

    # ── the loop ──────────────────────────────────────────────────────

    def spawn(self) -> subprocess.Popen:
        """Start the bot with the current working directory set to the package."""
        print(f"[watchdog] launching: {' '.join(self.argv)}  (cwd={ROOT})", flush=True)
        self.started_at = time.time()
        return subprocess.Popen(self.argv, cwd=str(ROOT))

    def is_stale(self) -> bool:
        """True when the log has been silent for too long while running."""
        if self.stale <= 0:
            return False
        log = newest_log()
        if log is None:
            return time.time() - self.started_at > self.stale * 3
        return (time.time() - log.stat().st_mtime) > self.stale

    def record(self, code: int, why: str) -> None:
        """Persist a small audit trail so a night of flapping is reviewable."""
        self.history.append([time.time(), code, why])
        self.history = self.history[-50:]
        try:
            self.state_file.write_text(
                json.dumps({"restarts": self.stops, "last": self.history[-1], "history": self.history}, indent=2),
                encoding="utf-8",
            )
        except OSError:
            pass

    def run(self) -> int:
        """Supervise forever. Returns a non-zero exit code when giving up."""
        self._install_handlers()
        window_start = time.time()
        restarts_in_window = 0
        while not self._sig:
            self.proc = self.spawn()
            while True:
                time.sleep(1.0)
                if self._sig:
                    self.terminate()
                    return 0
                if self.proc.poll() is not None:
                    break
                if self.is_stale():
                    print("[watchdog] no log output — treating the process as wedged", flush=True)
                    notify(f"stale for >{self.stale}s, restarting the bot")
                    self.terminate()
                    break
            code = self.proc.returncode
            if self._sig:
                return 0
            if time.time() - window_start > 3600:
                window_start, restarts_in_window = time.time(), 0
            restarts_in_window += 1
            self.stops += 1
            self.record(int(code if code is not None else -1), "exit" if self.proc.poll() is not None else "stale")
            print(f"[watchdog] child exited rc={code} (restart {restarts_in_window}/{self.max_per_hour} this hour)", flush=True)
            if code == 0:
                print("[watchdog] clean exit (rc=0) — not restarting.", flush=True)
                return 0
            if restarts_in_window > self.max_per_hour:
                msg = f"GIVING UP: {restarts_in_window} restarts in an hour. Check bot.log / errors.log."
                print(f"[watchdog] {msg}", flush=True)
                notify(msg)
                return 1
            delay = min(60, self.backoff * (2 ** min(5, restarts_in_window - 1)))
            notify(f"bot exited rc={code}; restarting in {delay}s")
            time.sleep(delay)


def main() -> int:
    """CLI entry point."""
    parser = argparse.ArgumentParser(description="Supervise the forex bot")
    parser.add_argument("--stale", type=int, default=0, help="kill the child if bot.log is silent N seconds (0 = never)")
    parser.add_argument("--max-per-hour", type=int, default=6, help="restarts tolerated per hour")
    parser.add_argument("--backoff", type=int, default=3, help="base seconds between restarts")
    parser.add_argument("rest", nargs=argparse.REMAINDER, help="command after --, e.g. -- main.py --mock")
    args = parser.parse_args()

    rest = [a for a in args.rest if a != "--"] or [str(ROOT / "main.py")]
    if rest and rest[0].endswith(".py"):
        cmd = [sys.executable, *rest]
    else:
        cmd = [sys.executable, str(ROOT / "main.py"), *rest]
    return Watchdog(cmd, stale=args.stale, max_per_hour=args.max_per_hour, backoff=args.backoff).run()


if __name__ == "__main__":
    raise SystemExit(main())
