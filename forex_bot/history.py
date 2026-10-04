"""
history.py — real market history, cached to disk.
════════════════════════════════════════════════════════════════════════
``MockDataFeed`` is a seeded random walk. It is perfect for testing the
*plumbing* and worthless for testing an *edge*: it has no trends, no fat
tails, no weekend gaps, no regime changes. Any backtest run against it
measures the backtester, not the strategy.

This module gets genuine bars onto disk so walk-forward validation has
something real to chew on. Three sources, in order of preference:

1. **A running MT5 terminal** (``--source mt5``) — ``copy_rates_range``
   pulls the broker's own history, spreads and gaps included.
2. **A CSV you already have** (``--source csv``) — Dukascopy, HistData,
   TrueFX, your broker's export. Columns are auto-detected.
3. **The cache** — once fetched, data is stored as Parquet (or CSV when
   pyarrow is unavailable) and reused.

Usage
-----
    # on Windows, with the terminal logged in
    python history.py --source mt5 --pair EUR/USD --timeframe 1h \\
        --start 2015-01-01 --end 2024-12-31

    # anywhere, from a file you downloaded
    python history.py --source csv --file ~/EURUSD_H1.csv --pair EUR/USD

    python history.py --list        # what is already cached
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

import pandas as pd

from config import BotConfig
from logger import get_logger

try:
    import MetaTrader5 as mt5  # type: ignore
except ImportError:  # pragma: no cover - non-Windows
    mt5 = None

#: Where cached history lands. Git-ignored — data does not belong in a repo.
CACHE_DIR = Path(__file__).parent / "data"

COLUMNS = ["open", "high", "low", "close", "volume"]

#: Common column spellings across CSV vendors → our canonical names.
ALIASES: Dict[str, str] = {
    "date": "time", "datetime": "time", "timestamp": "time", "time": "time",
    "gmt time": "time", "local time": "time",
    "o": "open", "open": "open", "<open>": "open",
    "h": "high", "high": "high", "<high>": "high",
    "l": "low", "low": "low", "<low>": "low",
    "c": "close", "close": "close", "<close>": "close", "price": "close",
    "v": "volume", "volume": "volume", "vol": "volume",
    "tickvol": "volume", "tick_volume": "volume", "<tickvol>": "volume",
}


class HistoryError(RuntimeError):
    """Raised when history cannot be obtained or is unusable."""


def cache_path(pair: str, timeframe: str) -> Path:
    """Canonical cache file for *pair* / *timeframe* (Parquet preferred)."""
    stem = f"{pair.replace('/', '')}_{timeframe}"
    parquet = CACHE_DIR / f"{stem}.parquet"
    return parquet if parquet.exists() else CACHE_DIR / f"{stem}.csv"


def _normalise(df: pd.DataFrame, pair: str) -> pd.DataFrame:
    """Coerce an arbitrary OHLCV frame into the canonical shape.

    Args:
        df: Raw frame with vendor-specific column names.
        pair: Instrument, for error messages.

    Returns:
        UTC-indexed frame with exactly ``[open, high, low, close, volume]``,
        sorted ascending, duplicates and non-finite rows removed.

    Raises:
        HistoryError: A required OHLC column is missing.
    """
    renamed = {}
    for col in df.columns:
        key = str(col).strip().lower()
        if key in ALIASES:
            renamed[col] = ALIASES[key]
    out = df.rename(columns=renamed).copy()

    if "time" not in out.columns:
        if isinstance(out.index, pd.DatetimeIndex):
            out = out.reset_index().rename(columns={out.index.name or "index": "time"})
        else:
            raise HistoryError(f"{pair}: no recognisable time column in {list(df.columns)[:8]}")

    missing = [c for c in ("open", "high", "low", "close") if c not in out.columns]
    if missing:
        raise HistoryError(f"{pair}: missing column(s) {missing}; saw {list(df.columns)[:8]}")
    if "volume" not in out.columns:
        out["volume"] = 0.0

    out["time"] = pd.to_datetime(out["time"], utc=True, errors="coerce", format="mixed")
    out = out.dropna(subset=["time"])
    for col in COLUMNS:
        out[col] = pd.to_numeric(out[col], errors="coerce")
    out = out.dropna(subset=["open", "high", "low", "close"])
    out = out[(out[["open", "high", "low", "close"]] > 0).all(axis=1)]

    out = out.set_index("time").sort_index()
    out = out[~out.index.duplicated(keep="last")]
    if out.empty:
        raise HistoryError(f"{pair}: no usable rows after cleaning")

    # sanity: a bar whose high < low is corrupt data, not a trading signal
    bad = out["high"] < out["low"]
    if bad.any():
        out = out[~bad]
    return out[COLUMNS]


def from_csv(path: Path, pair: str) -> pd.DataFrame:
    """Load and normalise a vendor CSV.

    Args:
        path: CSV file; separator is sniffed automatically.
        pair: Instrument label used in messages.
    """
    if not path.exists():
        raise HistoryError(f"CSV not found: {path}")
    try:
        raw = pd.read_csv(path, sep=None, engine="python")
    except Exception as exc:
        raise HistoryError(f"Could not parse {path}: {exc}") from exc
    return _normalise(raw, pair)


def from_mt5(
    pair: str,
    timeframe: str = "1h",
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
    config: Optional[BotConfig] = None,
) -> pd.DataFrame:
    """Pull real bars from a running MT5 terminal.

    Args:
        pair: ``"EUR/USD"`` — the slash is stripped for the broker symbol.
        timeframe: One of the keys in ``data_feed.TIMEFRAME_MAP``.
        start: First bar (UTC). Defaults to 2015-01-01.
        end: Last bar (UTC). Defaults to now.
        config: Optional config carrying login credentials.

    Raises:
        HistoryError: MT5 missing, login failed, or the range came back empty.
    """
    if mt5 is None:
        raise HistoryError(
            "MetaTrader5 is not installed (it is Windows-only). Use --source csv, "
            "or run this on the machine hosting your terminal."
        )
    from data_feed import TIMEFRAME_MAP

    key = TIMEFRAME_MAP.get(timeframe)
    if key is None:
        raise HistoryError(f"Unsupported timeframe {timeframe!r}")
    tf_const = getattr(mt5, key, None)
    if tf_const is None:
        raise HistoryError(f"MT5 lacks constant {key}")

    cfg = config or BotConfig()
    kwargs = {}
    if cfg.mt5_terminal_path:
        kwargs["path"] = cfg.mt5_terminal_path
    if cfg.mt5_login:
        kwargs.update(login=cfg.mt5_login, password=cfg.mt5_password or "", server=cfg.mt5_server or "")
    if not mt5.initialize(**kwargs):
        raise HistoryError(f"MT5 initialize() failed: {mt5.last_error()}")

    symbol = pair.upper().replace("/", "").replace("-", "")
    try:
        if not mt5.symbol_select(symbol, True):
            raise HistoryError(f"Symbol {symbol} is not available on this broker")
        first = start or datetime(2015, 1, 1, tzinfo=timezone.utc)
        last = end or datetime.now(timezone.utc)
        rates = mt5.copy_rates_range(symbol, tf_const, first, last)
        if rates is None or len(rates) == 0:
            raise HistoryError(
                f"No bars for {symbol} {timeframe} between {first:%Y-%m-%d} and {last:%Y-%m-%d}. "
                "Scroll that far back in the terminal chart once to make it download history."
            )
        frame = pd.DataFrame(rates)
        frame["time"] = pd.to_datetime(frame["time"], unit="s", utc=True)
        if "tick_volume" in frame.columns:
            frame["volume"] = frame["tick_volume"]
        return _normalise(frame, pair)
    finally:
        mt5.shutdown()


def save(df: pd.DataFrame, pair: str, timeframe: str) -> Path:
    """Persist *df* to the cache, preferring Parquet.

    Returns:
        The path actually written.
    """
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    stem = f"{pair.replace('/', '')}_{timeframe}"
    try:
        target = CACHE_DIR / f"{stem}.parquet"
        df.to_parquet(target)
    except Exception:  # pyarrow/fastparquet absent — CSV is fine
        target = CACHE_DIR / f"{stem}.csv"
        df.to_csv(target)
    return target


def load(pair: str, timeframe: str = "1h") -> pd.DataFrame:
    """Read cached history for *pair*.

    Raises:
        HistoryError: nothing cached yet.
    """
    path = cache_path(pair, timeframe)
    if not path.exists():
        raise HistoryError(
            f"No cached history for {pair} {timeframe}. Fetch it first:\n"
            f"  python history.py --source mt5 --pair {pair} --timeframe {timeframe}\n"
            f"  python history.py --source csv --file <your.csv> --pair {pair}"
        )
    frame = pd.read_parquet(path) if path.suffix == ".parquet" else pd.read_csv(path, index_col=0, parse_dates=True)
    if frame.index.tz is None:
        frame.index = frame.index.tz_localize("UTC")
    return frame


def available() -> List[Dict[str, object]]:
    """Inventory of everything in the cache."""
    if not CACHE_DIR.exists():
        return []
    rows: List[Dict[str, object]] = []
    for path in sorted(CACHE_DIR.glob("*")):
        if path.suffix not in (".parquet", ".csv"):
            continue
        try:
            frame = pd.read_parquet(path) if path.suffix == ".parquet" else pd.read_csv(path, index_col=0, parse_dates=True)
            rows.append(
                {
                    "file": path.name,
                    "bars": len(frame),
                    "from": str(frame.index[0])[:16],
                    "to": str(frame.index[-1])[:16],
                    "size_kb": round(path.stat().st_size / 1024, 1),
                }
            )
        except Exception as exc:
            rows.append({"file": path.name, "error": str(exc)})
    return rows


def describe(df: pd.DataFrame) -> Dict[str, object]:
    """Quick quality report — gaps and coverage, before you trust the data."""
    spans = df.index.to_series().diff().dropna()
    typical = spans.median() if len(spans) else pd.Timedelta(0)
    gaps = spans[spans > typical * 3] if len(spans) else spans
    return {
        "bars": len(df),
        "from": str(df.index[0]),
        "to": str(df.index[-1]),
        "median_spacing": str(typical),
        "gaps_over_3x": int(len(gaps)),
        "largest_gap": str(gaps.max()) if len(gaps) else "none",
        "years": round((df.index[-1] - df.index[0]).days / 365.25, 2),
    }


def main(argv: Optional[List[str]] = None) -> int:
    """CLI entry point."""
    parser = argparse.ArgumentParser(description="Fetch and cache real market history")
    parser.add_argument("--source", choices=["mt5", "csv"], default="mt5")
    parser.add_argument("--pair", default="EUR/USD")
    parser.add_argument("--timeframe", default="1h")
    parser.add_argument("--file", default="", help="CSV path when --source csv")
    parser.add_argument("--start", default="2015-01-01")
    parser.add_argument("--end", default="")
    parser.add_argument("--list", action="store_true", help="show the cache and exit")
    args = parser.parse_args(argv)
    log = get_logger("history")

    if args.list:
        rows = available()
        if not rows:
            print(f"Cache is empty ({CACHE_DIR}).")
            return 0
        print(f"Cached history in {CACHE_DIR}:")
        for row in rows:
            print("  " + ", ".join(f"{k}={v}" for k, v in row.items()))
        return 0

    try:
        if args.source == "csv":
            if not args.file:
                parser.error("--source csv requires --file")
            frame = from_csv(Path(args.file).expanduser(), args.pair)
        else:
            start = pd.Timestamp(args.start, tz="UTC").to_pydatetime()
            end = pd.Timestamp(args.end, tz="UTC").to_pydatetime() if args.end else None
            frame = from_mt5(args.pair, args.timeframe, start, end)
    except HistoryError as exc:
        log.error("%s", exc)
        return 2

    path = save(frame, args.pair, args.timeframe)
    report = describe(frame)
    print(f"\nSaved {len(frame):,} bars → {path}")
    for key, value in report.items():
        print(f"  {key:<16}: {value}")
    if int(report["gaps_over_3x"]) > 0:
        print(
            f"\n  note: {report['gaps_over_3x']} gaps longer than 3x the median spacing.\n"
            "  Weekend gaps are normal for FX; large weekday gaps mean missing data."
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
