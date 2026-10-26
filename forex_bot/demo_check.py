"""
demo_check.py — read-only preflight for testing on an MT5 DEMO account.
════════════════════════════════════════════════════════════════════════
Run this *before* the first live/demo gamble or bot loop. It connects
to the terminal exactly like the bot does, then verifies — placing
absolutely no orders (it never even constructs a Broker):

1. **Terminal** — MetaTrader5 package loads, ``initialize()`` succeeds.
2. **Account** — login/server/currency/balance, and crucially whether
   the account is **DEMO**. A REAL account is refused here by the same
   ``allow_real_account`` lock that guards ``data_feed.initialize()``.
3. **Permissions** — AutoTrading / expert trading flags (data works
   without them; orders do not, so they are warnings, not failures).
4. **Balance sanity** — risk sizing uses ``config.account_balance``,
   *not* terminal equity, so a $50k demo against a $10k config (or
   vice-versa) sizes every trade wrong. Warns loudly on mismatch.
5. **Data** — every configured pair returns live ticks (with spread)
   and enough candles, and the production strategy scores them.
6. **Gamble board** — the same A+ ranking the GAMBLE button would see
   right now, plus whether the bot is inside its UTC trading hours.

Usage
-----
    python demo_check.py            # against the logged-in MT5 terminal
    python demo_check.py --mock     # synthetic plumbing check (no terminal)
    python demo_check.py --json     # machine-readable verdict

Exit code is 0 only when every hard check passes.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from logger import get_logger

PASS, WARN, FAIL = "pass", "warn", "fail"
_ICON = {PASS: "✔", WARN: "!", FAIL: "✗"}


def _check(name: str, status: str, detail: str) -> Dict[str, str]:
    return {"name": name, "status": status, "detail": detail}


def run_checks(feed: Any, config: Any, strategy: Any = None, now: Optional[datetime] = None) -> Dict[str, Any]:
    """Run every preflight check against *feed* (read-only).

    Works against a real ``ForexDataFeed``, a ``MockDataFeed``, or any
    test double exposing ``initialize``/``get_candles``/``get_latest_tick``.
    """
    log = get_logger("demo_check")
    moment = now or datetime.now(timezone.utc)
    checks: List[Dict[str, str]] = []
    pairs_out: List[Dict[str, Any]] = []
    ranking: List[Dict[str, Any]] = []

    # 1 ── connect (this is where the demo-only lock fires) ───────────
    try:
        if hasattr(feed, "initialize"):
            feed.initialize()
        checks.append(_check("terminal", PASS, "feed.initialize() OK"))
    except Exception as exc:
        checks.append(_check("terminal", FAIL, str(exc)))
        return {"ok": False, "checks": checks, "account": {}, "pairs": pairs_out, "ranking": ranking}

    # 2 ── account identity + kind ─────────────────────────────────────
    fp: Dict[str, Any] = dict(getattr(feed, "account_fingerprint", {}) or {})
    if fp:
        kind = str(fp.get("account_kind", "unknown"))
        detail = (
            f"login {fp.get('login')} @ {fp.get('server') or '?'} ({fp.get('company') or 'broker'}), "
            f"balance {fp.get('balance', 0):,.2f} {fp.get('currency', 'USD')}, "
            f"kind={kind.upper()}, login-verified={fp.get('verified')}"
        )
        if kind == "demo":
            checks.append(_check("account", PASS, detail))
        elif kind == "contest":
            checks.append(_check("account", WARN, detail + " — virtual money, safe to test"))
        elif kind == "real":
            checks.append(_check("account", FAIL, detail + " — REAL money. Switch the terminal to a DEMO account."))
        else:
            checks.append(_check("account", FAIL, detail + " — demo status unproven, treated as unsafe"))

        balance = float(fp.get("balance") or 0.0)
        configured = float(getattr(config, "account_balance", 0.0) or 0.0)
        if balance > 0 and configured > 0:
            ratio = balance / configured
            if 0.8 <= ratio <= 1.25:
                checks.append(_check(
                    "balance sanity", PASS,
                    f"terminal balance {balance:,.2f} ≈ configured account_balance {configured:,.2f}",
                ))
            else:
                checks.append(_check(
                    "balance sanity", WARN,
                    f"terminal balance {balance:,.2f} vs configured account_balance {configured:,.2f} — "
                    "risk sizing uses the CONFIGURED number, so lots will be sized for the wrong account. "
                    "Open the demo with a 10,000 deposit, or set account_balance in config.py to match.",
                ))
    else:
        checks.append(_check("account", PASS, "paper/mock feed — no terminal account involved"))

    # 3 ── trading permissions (warnings: data works without them) ────
    mt5 = getattr(feed, "mt5", None)
    if mt5 is not None:
        off: List[str] = []
        try:
            term = mt5.terminal_info()
            if term is not None and getattr(term, "trade_allowed", True) is False:
                off.append("terminal AutoTrading is OFF (enable Algo Trading in MT5)")
            acct = mt5.account_info()
            if acct is not None:
                if getattr(acct, "trade_allowed", True) is False:
                    off.append("account trade_allowed=False (investor password? log in with the master password)")
                if getattr(acct, "trade_expert", True) is False:
                    off.append("expert advisors disabled on this account (trade_expert=False)")
        except Exception as exc:  # never let a probe kill the checklist
            log.debug("permission probe failed: %s", exc)
        if off:
            checks.append(_check("permissions", WARN, "; ".join(off) + " — orders will be rejected until fixed; scanning still works"))
        else:
            checks.append(_check("permissions", PASS, "terminal/account expert-trading flags all allow orders"))

    # 4 ── trading hours ───────────────────────────────────────────────
    try:
        in_hours = config.is_trading_hours(moment.hour)
    except Exception:
        in_hours = True
    checks.append(_check(
        "session",
        PASS if in_hours else WARN,
        f"now {moment:%H:%M UTC}; bot trades {config.start_hour:02d}:00-{config.end_hour:02d}:00 UTC"
        + ("" if in_hours else " — outside the window, bot/gamble will refuse new trades until it opens"),
    ))

    # 5 ── per-pair data + strategy ────────────────────────────────────
    signals: List[Any] = []
    any_data = False
    for pair in list(getattr(config, "pairs", [])):
        row: Dict[str, Any] = {"pair": pair, "ok": False, "detail": ""}
        try:
            df = feed.get_candles(pair, config.candles_per_call)
            bars = len(df)
            last_close = float(df["close"].iloc[-1]) if bars else 0.0
            last_time = str(df.index[-1]) if bars else "?"
            row["bars"] = bars
            row["last_close"] = round(last_close, 5)
            row["last_bar"] = last_time
            if bars >= int(getattr(config, "min_bars", 50)):
                any_data = True
                row["ok"] = True
                row["detail"] = f"{bars} bars, last {last_time} @ {last_close:.5f}"
            else:
                row["detail"] = f"only {bars} bars (need {config.min_bars}) — leave MT5 open to backfill history"
        except Exception as exc:
            row["detail"] = f"candles failed: {exc}"
            df = None

        tick = None
        try:
            tick = feed.get_latest_tick(pair)
            pip = config.pip_size_for(pair)
            spread_pips = round((float(tick["ask"]) - float(tick["bid"])) / pip, 1) if pip else 0.0
            row["bid"] = round(float(tick["bid"]), 5)
            row["ask"] = round(float(tick["ask"]), 5)
            row["spread_pips"] = spread_pips
            row["detail"] += f" | spread {spread_pips}p"
        except Exception as exc:
            row["detail"] += f" | no live tick ({exc}) — market closed?"

        if strategy is not None and df is not None and row["ok"]:
            try:
                sig = strategy.analyze(df, pair)
                signals.append(sig)
                row["signal"] = sig.signal.label()
                row["confidence"] = sig.confidence
                row["detail"] += f" | signal {sig.signal.label()} conf {sig.confidence:.2f}"
            except Exception as exc:
                row["detail"] += f" | strategy error: {exc}"
        pairs_out.append(row)

    if pairs_out:
        good = sum(1 for r in pairs_out if r["ok"])
        status = PASS if any_data and good == len(pairs_out) else (WARN if any_data else FAIL)
        checks.append(_check("market data", status, f"{good}/{len(pairs_out)} pairs returned enough candles"))
        for r in pairs_out:
            checks.append(_check(f"  {r['pair']}", PASS if r["ok"] else FAIL, r["detail"]))

    # 6 ── what would GAMBLE see right now? ────────────────────────────
    if signals:
        try:
            from gamble import rank_candidates

            ranked = rank_candidates(
                signals,
                min_confidence=config.gamble_min_confidence,
                min_risk_reward=config.gamble_min_risk_reward,
                min_adx=config.gamble_min_adx,
                min_edge_score=config.gamble_min_edge_score,
            )
            ranking = [c.to_dict() for c in ranked]
            best = ranked[0]
            verdict = (
                f"A+ AVAILABLE: {best.pair} {best.signal_name} edge {best.edge_score:.1f}"
                if best.is_a_plus else
                f"no A+ right now — best {best.pair} {best.signal_name} edge {best.edge_score:.1f} "
                f"(needs: {'; '.join(best.failed)}). A gamble would correctly refuse."
            )
            checks.append(_check("gamble board", PASS, verdict))
        except Exception as exc:
            checks.append(_check("gamble board", WARN, f"ranking unavailable: {exc}"))

    ok = not any(c["status"] == FAIL for c in checks)
    return {"ok": ok, "checks": checks, "account": fp, "pairs": pairs_out, "ranking": ranking}


def print_report(result: Dict[str, Any]) -> None:
    """Human-readable checklist + exact next commands."""
    print("\n" + "═" * 66)
    print("  DEMO ACCOUNT PREFLIGHT — read-only, no orders are placed")
    print("═" * 66)
    for c in result["checks"]:
        print(f"  [{_ICON.get(c['status'], '?')}] {c['name']:<16} {c['detail']}")
    print("═" * 66)
    if result["ok"]:
        kind = str(result.get("account", {}).get("account_kind", "")).upper()
        label = f"{kind} account" if kind else "paper feed"
        print(f"  READY ({label}). Suggested first real-data steps, in order:")
        print("    1. python gamble.py --live --scan-only     # ranking on real prices, no trade")
        print("    2. python gamble.py --live --risk 0.005    # first demo gamble at a TINY 0.5% stake")
        print("    3. python main.py --ticks 5                # bot loop smoke test on demo")
        print("  Watch the fills in MT5 (Toolbox > Trade, magic 123456) and bot.log.")
        print("  Stay on demo for a full week. Nothing here guarantees profit.")
    else:
        print("  NOT READY — fix the [✗] items above and run this again.")
        print("  Usual causes: MT5 not open/logged in, a REAL account (switch to demo),")
        print("  symbols missing from Market Watch, or running outside market hours.")
    print("═" * 66 + "\n")


def main(argv: Optional[List[str]] = None) -> int:
    """CLI entry point. 0 = ready, 1 = not ready."""
    parser = argparse.ArgumentParser(description="Read-only MT5 demo-account preflight (places no orders)")
    parser.add_argument("--mock", action="store_true", help="synthetic feed plumbing check (no terminal needed)")
    parser.add_argument("--json", action="store_true", help="print the verdict as JSON")
    parser.add_argument("--pairs", default="", help="comma-separated override of config.pairs")
    args = parser.parse_args(argv)

    from config import BotConfig
    from strategy import AdvancedStrategy

    overrides: Dict[str, Any] = {}
    if args.pairs:
        overrides["pairs"] = [p.strip() for p in args.pairs.split(",") if p.strip()]
    config = BotConfig(**overrides) if overrides else BotConfig()

    if args.mock:
        from data_feed import MockDataFeed

        config.paper_mode = True
        feed: Any = MockDataFeed(config)
    else:
        from data_feed import ForexDataFeed

        feed = ForexDataFeed(config)

    try:
        result = run_checks(feed, config, strategy=AdvancedStrategy(config))
    finally:
        if hasattr(feed, "shutdown"):
            try:
                feed.shutdown()
            except Exception:
                pass

    if args.json:
        def _safe(value: Any) -> Any:
            if isinstance(value, dict):
                return {str(k): _safe(v) for k, v in value.items()}
            if isinstance(value, (list, tuple)):
                return [_safe(v) for v in value]
            if hasattr(value, "item"):
                try:
                    return value.item()
                except Exception:
                    return str(value)
            return value if isinstance(value, (str, int, float, bool)) or value is None else str(value)

        print(json.dumps(_safe(result), indent=2))
    else:
        print_report(result)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
