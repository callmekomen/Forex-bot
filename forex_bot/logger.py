"""
logger.py — process-wide logging: console + rotating files, never silent.
════════════════════════════════════════════════════════════════════════
Two rotating files are written next to the bot:

* ``bot.log``    — everything at INFO and above
* ``errors.log`` — WARNING and above only, so a crash post-mortem is one
                   ``tail`` away

Console output is colour free on purpose: it is meant to be piped into
``tee``, systemd journals or a Docker log driver.
"""

from __future__ import annotations

import logging
import os
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Optional

LOG_FORMAT = "%(asctime)s [%(levelname)s] %(message)s"
DATE_FORMAT = "%Y-%m-%d %H:%M:%S"
MAX_BYTES = 10 * 1024 * 1024  # rotate at 10 MB
BACKUP_COUNT = 5

_ROOT_NAME = "forex_bot"
_configured: set[str] = set()


def _env_level(default: int = logging.INFO) -> int:
    """Resolve ``FXBOT_LOG_LEVEL`` (DEBUG/INFO/WARNING/ERROR) to a level."""
    raw = os.environ.get("FXBOT_LOG_LEVEL", "").strip().upper()
    if not raw:
        return default
    return getattr(logging, raw, default)


def setup_logger(
    name: str = _ROOT_NAME,
    log_dir: Optional[Path] = None,
    level: Optional[int] = None,
) -> logging.Logger:
    """Create (or fetch) the shared logger with file + console handlers.

    Idempotent: calling it twice with the same *name* will not duplicate
    handlers, which keeps log files readable when several modules ask for
    the logger.

    Args:
        name: Dotted logger name, e.g. ``"forex_bot.strategy"``. Child
            loggers propagate to the root ``forex_bot`` logger.
        log_dir: Directory that receives ``bot.log`` / ``errors.log``.
        level: Explicit logging level; falls back to ``FXBOT_LOG_LEVEL``.

    Returns:
        A configured :class:`logging.Logger`.
    """
    logger = logging.getLogger(_ROOT_NAME if name == _ROOT_NAME else name)
    if name != _ROOT_NAME:
        logger.propagate = True
        return logger

    logger.setLevel(level if level is not None else _env_level())
    if _ROOT_NAME in _configured:
        return logger

    formatter = logging.Formatter(LOG_FORMAT, datefmt=DATE_FORMAT)

    console = logging.StreamHandler()
    console.setFormatter(formatter)
    console.setLevel(level if level is not None else _env_level())
    logger.addHandler(console)

    directory = Path(log_dir) if log_dir else Path(".")
    try:
        directory.mkdir(parents=True, exist_ok=True)

        full = RotatingFileHandler(
            directory / "bot.log", maxBytes=MAX_BYTES, backupCount=BACKUP_COUNT, encoding="utf-8"
        )
        full.setFormatter(formatter)
        logger.addHandler(full)

        errors = RotatingFileHandler(
            directory / "errors.log", maxBytes=MAX_BYTES, backupCount=BACKUP_COUNT, encoding="utf-8"
        )
        errors.setFormatter(formatter)
        errors.setLevel(logging.WARNING)
        logger.addHandler(errors)
    except OSError as exc:
        # A read-only log dir must never stop the trading loop.
        logger.warning("File logging disabled (%s) — continuing with console only.", exc)

    logger.setLevel(level if level is not None else _env_level())
    _configured.add(_ROOT_NAME)
    return logger


def get_logger(name: str) -> logging.Logger:
    """Return a module-scoped child logger, creating the root one if needed.

    Args:
        name: Module name, typically ``__name__``.
    """
    if _ROOT_NAME not in _configured:
        setup_logger()
    return logging.getLogger(name if name.startswith(_ROOT_NAME) else f"{_ROOT_NAME}.{name}")
