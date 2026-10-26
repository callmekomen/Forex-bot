"""
gamble.py — ONE high-conviction speculation, hunted and gated.
════════════════════════════════════════════════════════════════════════
Pressing "GAMBLE" does **not** flip a coin. A random trade loses to the
spread on average, so a literal casino button would be a machine for
donating money to the broker. This module is the honest version:

1. **Hunt.** Every configured pair is scored with the production
   strategy and ranked by a transparent 0-100 *edge score*
   (confidence, signal strength, trend strength, reward:risk).
2. **A+ gate.** A setup only qualifies when it is *stricter* than a
   normal trade on every axis: confidence, RR, ADX and edge score all
   have gamble-specific floors in ``BotConfig``. No A+ setup → no bet.
   "No trade" is a successful gamble outcome.
3. **Stake, capped.** The operator picks a stake fraction, but sizing
   still goes through ``RiskManager.validate_trade`` which clamps it
   to 5% of equity *and* to the remaining daily-loss budget. The
   gamble can never bypass a halt, a duplicate-pair rule, the session
   filter or the drawdown breaker.
4. **One and done.** Exactly one position is opened, with ATR stop and
   target attached. There is no martingale, no doubling down, no
   automatic revenge trade after a loss.
5. **Lockout.** A durable ledger (``gamble_state.json``) caps gambles
   per UTC day, caps losing gambles per day, and forces a cooldown
   after a loss — surviving restarts, exactly like ``bot_state.json``.
6. **Protect.** Once price reaches +1R the stop can be moved to the
   entry (breakeven), so a winning gamble cannot turn into a loser.

Nothing here guarantees profit. With a 1:2 risk-reward the breakeven
win rate is 33.4%; the A+ gate exists to only bet when the strategy's
confluence suggests the true win rate is plausibly above that. Whether
it actually is can only be answered by the walk-forward tester on real
history — run it before you risk real money.

CLI
---
    python gamble.py --mock                  # rank + (maybe) take ONE paper gamble
    python gamble.py --mock --scan-only      # just show the ranking, trade nothing
    python gamble.py --mock --risk 0.03 --min-confidence 0.75
    python gamble.py --status                # ledger: today's gambles, lockout state
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from logger import get_logger
from strategy import TradeSignal

#: Composite edge-score weights (sums to 100). Transparent on purpose:
#: the dashboard shows the same breakdown the Python computes.
W_CONFIDENCE = 45.0
W_SCORE = 20.0
W_ADX = 20.0
W_RR = 15.0

#: Absolute ceiling for any gamble stake, whatever the config says.
HARD_MAX_RISK_FRACTION = 0.05


def _clamp(value: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, value))


def breakeven_win_rate(risk_reward: float) -> float:
    """Win rate needed to break even at *risk_reward* (before costs).

    ``1 / (1 + RR)`` — at 1:2 you only need to be right a third of the
    time. Spread/commission push the true number a little higher.
    """
    if risk_reward <= 0 or not math.isfinite(risk_reward):
        return 1.0
    return round(1.0 / (1.0 + risk_reward), 4)


def edge_breakdown(signal: TradeSignal) -> Dict[str, float]:
    """The four weighted components of the edge score, for display."""
    adx = signal.indicators.get("adx") if signal.indicators else None
    adx_part = _clamp(((float(adx) - 15.0) / 25.0) if adx is not None else 0.4)
    return {
        "confidence": round(W_CONFIDENCE * _clamp(float(signal.confidence)), 2),
        "score": round(W_SCORE * _clamp(abs(float(signal.score)) / 5.0), 2),
        "adx": round(W_ADX * adx_part, 2),
        "risk_reward": round(W_RR * _clamp((float(signal.risk_reward) - 1.5) / 1.0), 2),
    }


def edge_score(signal: TradeSignal) -> float:
    """Composite 0-100 quality score for *signal* (higher = better bet)."""
    if not signal.signal.actionable:
        # Still return a small directional hint score for ranking boards,
        # but a NEUTRAL can never clear the A+ gate.
        return round(W_SCORE * _clamp(abs(float(signal.score)) / 5.0), 2)
    return round(sum(edge_breakdown(signal).values()), 2)


@dataclass
class GambleCandidate:
    """One pair's gamble verdict: ranking data + pass/fail per gate."""

    pair: str
    signal_name: str
    direction: str
    price: float
    stop_loss: float
    take_profit: float
    confidence: float
    score: float
    risk_reward: float
    adx: Optional[float]
    edge_score: float
    edge_breakdown: Dict[str, float]
    breakeven_win_rate: float
    is_a_plus: bool
    passed: List[str] = field(default_factory=list)
    failed: List[str] = field(default_factory=list)
    reasons: List[str] = field(default_factory=list)

    @property
    def grade(self) -> str:
        """Display grade: A+ qualifies, A/B are watchlist, skip otherwise."""
        if self.is_a_plus:
            return "A+"
        if self.edge_score >= 55:
            return "A"
        if self.edge_score >= 40:
            return "B"
        return "skip"

    def to_dict(self) -> Dict[str, Any]:
        data = asdict(self)
        data["grade"] = self.grade
        return data


def evaluate_candidate(
    signal: TradeSignal,
    *,
    min_confidence: float,
    min_risk_reward: float,
    min_adx: float,
    min_edge_score: float,
) -> GambleCandidate:
    """Grade *signal* against the gamble (A+) gate.

    Every condition is reported in ``passed``/``failed`` so the operator
    can see *why* the button refused — a gamble you cannot audit is
    just a slot machine.
    """
    adx_raw = signal.indicators.get("adx") if signal.indicators else None
    adx = float(adx_raw) if adx_raw is not None else None
    edge = edge_score(signal)
    # A NEUTRAL signal carries SL=TP=0, which makes the raw RR artefact
    # 1.0 — display it honestly as "no trade geometry" instead.
    rr = float(signal.risk_reward) if signal.signal.actionable else 0.0
    passed: List[str] = []
    failed: List[str] = []

    checks: List[Tuple[bool, str, str]] = [
        (
            signal.signal.actionable,
            f"directional signal ({signal.signal.label()})",
            "signal is NEUTRAL — no direction to bet on",
        ),
        (
            signal.confidence >= min_confidence,
            f"confidence {signal.confidence:.2f} ≥ {min_confidence:.2f}",
            f"confidence {signal.confidence:.2f} < {min_confidence:.2f}",
        ),
        (
            rr >= min_risk_reward,
            f"risk:reward {rr:.2f} ≥ {min_risk_reward:.2f}",
            f"risk:reward {rr:.2f} < {min_risk_reward:.2f}",
        ),
        (
            adx is not None and adx >= min_adx,
            f"trend strength ADX {adx:.1f} ≥ {min_adx:.0f}" if adx is not None else "",
            "ADX unavailable — cannot confirm a trend" if adx is None else f"ADX {adx:.1f} < {min_adx:.0f} — choppy, no trend to ride",
        ),
        (
            edge >= min_edge_score,
            f"edge score {edge:.1f} ≥ {min_edge_score:.0f}",
            f"edge score {edge:.1f} < {min_edge_score:.0f}",
        ),
    ]
    for ok, yes, no in checks:
        (passed if ok else failed).append(yes if ok else no)

    return GambleCandidate(
        pair=signal.pair,
        signal_name=signal.signal.label(),
        direction=signal.direction,
        price=float(signal.price),
        stop_loss=float(signal.stop_loss),
        take_profit=float(signal.take_profit),
        confidence=float(signal.confidence),
        score=float(signal.score),
        risk_reward=rr,
        adx=adx,
        edge_score=edge,
        edge_breakdown=edge_breakdown(signal),
        breakeven_win_rate=breakeven_win_rate(rr),
        is_a_plus=all(ok for ok, _, _ in checks),
        passed=[p for p in passed if p],
        failed=failed,
        reasons=list(signal.reasons),
    )


def rank_candidates(
    signals: List[TradeSignal],
    *,
    min_confidence: float,
    min_risk_reward: float,
    min_adx: float,
    min_edge_score: float,
) -> List[GambleCandidate]:
    """Evaluate every signal and return the ranking, best edge first."""
    ranked = [
        evaluate_candidate(
            s,
            min_confidence=min_confidence,
            min_risk_reward=min_risk_reward,
            min_adx=min_adx,
            min_edge_score=min_edge_score,
        )
        for s in signals
    ]
    ranked.sort(key=lambda c: (c.edge_score, c.confidence, abs(c.score)), reverse=True)
    return ranked


# ══════════════════════════════════════════════════════════════════════
# Ledger — the lockout that survives restarts
# ══════════════════════════════════════════════════════════════════════


class GambleLedger:
    """Durable per-day gamble budget: count, losses, cooldown, net P&L.

    Persisted atomically to ``gamble_state.json`` next to the risk
    state. A crash, a restart or a second browser tab must not reset
    "you already lost twice today".
    """

    def __init__(
        self,
        state_file: Optional[Path] = None,
        *,
        max_per_day: int = 3,
        max_losses_per_day: int = 2,
        cooldown_minutes: int = 30,
    ) -> None:
        self.state_file = Path(state_file or "gamble_state.json")
        self.max_per_day = int(max_per_day)
        self.max_losses_per_day = int(max_losses_per_day)
        self.cooldown_minutes = int(cooldown_minutes)
        self.log = get_logger("gamble")
        self.date: str = self._today()
        self.taken: int = 0
        self.wins: int = 0
        self.losses: int = 0
        self.net_pnl: float = 0.0
        self.last_loss_at: Optional[str] = None
        self.open_ticket: Optional[int] = None
        self.history: List[Dict[str, Any]] = []
        self._load()

    @staticmethod
    def _today(now: Optional[datetime] = None) -> str:
        return (now or datetime.now(timezone.utc)).strftime("%Y-%m-%d")

    def _rollover(self, now: Optional[datetime] = None) -> None:
        today = self._today(now)
        if today != self.date:
            self.date, self.taken, self.wins, self.losses = today, 0, 0, 0
            self.net_pnl, self.last_loss_at = 0.0, None
            self._save()

    def can_gamble(self, now: Optional[datetime] = None) -> Tuple[bool, str]:
        """Whether a new gamble may be taken right now, and why not."""
        moment = now or datetime.now(timezone.utc)
        self._rollover(moment)
        if self.open_ticket is not None:
            return False, f"a gamble is already open (ticket {self.open_ticket}) — one at a time"
        if self.taken >= self.max_per_day:
            return False, f"daily gamble budget spent ({self.taken}/{self.max_per_day}) — locked until 00:00 UTC"
        if self.losses >= self.max_losses_per_day:
            return False, f"{self.losses} losing gambles today — locked until 00:00 UTC (no revenge trades)"
        if self.last_loss_at and self.cooldown_minutes > 0:
            try:
                lost_at = datetime.fromisoformat(self.last_loss_at)
            except ValueError:
                lost_at = None
            if lost_at is not None:
                until = lost_at + timedelta(minutes=self.cooldown_minutes)
                if moment < until:
                    left = int((until - moment).total_seconds() // 60) + 1
                    return False, f"cooldown after a losing gamble — {left} min remaining"
        return True, "OK"

    def record_open(self, ticket: int, detail: Optional[Dict[str, Any]] = None, now: Optional[datetime] = None) -> None:
        """Book a newly taken gamble (counts against today's budget)."""
        self._rollover(now)
        self.taken += 1
        self.open_ticket = int(ticket)
        self.history.append({
            "time": (now or datetime.now(timezone.utc)).isoformat(),
            "event": "open", "ticket": int(ticket), **(detail or {}),
        })
        self.history = self.history[-100:]
        self._save()

    def record_result(self, pnl: float, ticket: Optional[int] = None, now: Optional[datetime] = None) -> None:
        """Book a closed gamble's result; a loss starts the cooldown."""
        moment = now or datetime.now(timezone.utc)
        self._rollover(moment)
        self.net_pnl = round(self.net_pnl + float(pnl), 2)
        if pnl > 0:
            self.wins += 1
        elif pnl < 0:
            self.losses += 1
            self.last_loss_at = moment.isoformat()
        if ticket is None or ticket == self.open_ticket:
            self.open_ticket = None
        self.history.append({
            "time": moment.isoformat(), "event": "close",
            "ticket": ticket, "pnl": round(float(pnl), 2),
        })
        self.history = self.history[-100:]
        self._save()

    def status(self, now: Optional[datetime] = None) -> Dict[str, Any]:
        allowed, reason = self.can_gamble(now)
        return {
            "date": self.date,
            "taken": self.taken,
            "remaining": max(0, self.max_per_day - self.taken),
            "max_per_day": self.max_per_day,
            "wins": self.wins,
            "losses": self.losses,
            "max_losses_per_day": self.max_losses_per_day,
            "net_pnl": self.net_pnl,
            "open_ticket": self.open_ticket,
            "can_gamble": allowed,
            "lock_reason": "" if allowed else reason,
        }

    # ── persistence ───────────────────────────────────────────────────

    def _save(self) -> None:
        payload = {
            "date": self.date, "taken": self.taken, "wins": self.wins,
            "losses": self.losses, "net_pnl": self.net_pnl,
            "last_loss_at": self.last_loss_at, "open_ticket": self.open_ticket,
            "history": self.history,
        }
        try:
            tmp = self.state_file.with_suffix(self.state_file.suffix + ".tmp")
            tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
            tmp.replace(self.state_file)
        except OSError as exc:  # read-only dir must not crash the bot
            self.log.warning("Could not persist gamble ledger: %s", exc)

    def _load(self) -> None:
        try:
            if not self.state_file.exists():
                return
            raw = json.loads(self.state_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        if raw.get("date") != self._today():
            return  # stale day — start fresh, keep no lockout from yesterday
        self.date = str(raw.get("date", self.date))
        self.taken = int(raw.get("taken", 0))
        self.wins = int(raw.get("wins", 0))
        self.losses = int(raw.get("losses", 0))
        self.net_pnl = float(raw.get("net_pnl", 0.0))
        self.last_loss_at = raw.get("last_loss_at")
        self.open_ticket = raw.get("open_ticket")
        self.history = list(raw.get("history", []))[-100:]


# ══════════════════════════════════════════════════════════════════════
# Engine — scan → rank → gate → (maybe) ONE fill
# ══════════════════════════════════════════════════════════════════════


@dataclass
class GambleRequest:
    """What one press of the button asks for."""

    risk_fraction: float = 0.02
    min_confidence: float = 0.60
    min_risk_reward: float = 1.8
    min_adx: float = 20.0
    min_edge_score: float = 60.0
    pairs: Optional[List[str]] = None

    def clamped_risk(self, config_cap: float) -> float:
        """Stake after every ceiling: request ∩ config ∩ hard 5%."""
        return round(min(float(self.risk_fraction), float(config_cap), HARD_MAX_RISK_FRACTION), 4)


class GambleEngine:
    """Hunts one A+ setup across the universe and takes at most one trade.

    The engine borrows the running bot's ``feed``/``strategy``/``risk``/
    ``broker`` — it owns no execution path of its own, so there is no
    way for a gamble to reach the market except through the same gates
    as every other order.
    """

    def __init__(self, bot: Any, ledger: Optional[GambleLedger] = None) -> None:
        self.bot = bot
        self.config = bot.config
        self.log = get_logger("gamble")
        if ledger is None:
            state = Path(getattr(bot.risk, "state_file", "bot_state.json"))
            ledger = GambleLedger(
                state.with_name("gamble_state.json"),
                max_per_day=self.config.gamble_max_per_day,
                max_losses_per_day=self.config.gamble_max_losses_per_day,
                cooldown_minutes=self.config.gamble_cooldown_minutes,
            )
        self.ledger = ledger
        #: Initial stop distance per ticket, remembered *before* any
        #: breakeven move — once the stop sits at entry the distance is
        #: zero and R-multiples would be meaningless without this.
        self._initial_risk: Dict[int, float] = {}

    def _pairs(self, request: GambleRequest) -> List[str]:
        wanted = request.pairs or list(self.config.pairs)
        return [p for p in wanted if p in self.config.pairs] or list(self.config.pairs)

    def scan(self, request: GambleRequest) -> List[GambleCandidate]:
        """Score every pair once and return the edge ranking (no trading)."""
        signals: List[TradeSignal] = []
        for pair in self._pairs(request):
            try:
                df = self.bot.feed.get_candles(pair, self.config.candles_per_call)
                signals.append(self.bot.strategy.analyze(df, pair))
            except Exception as exc:  # one bad pair must not kill the hunt
                self.log.warning("gamble scan: %s failed (%s) — skipped", pair, exc)
        return rank_candidates(
            signals,
            min_confidence=request.min_confidence,
            min_risk_reward=request.min_risk_reward,
            min_adx=request.min_adx,
            min_edge_score=request.min_edge_score,
        )

    def hunt_once(
        self,
        request: Optional[GambleRequest] = None,
        *,
        now: Optional[datetime] = None,
        execute: bool = True,
    ) -> Dict[str, Any]:
        """One scan; take the best A+ setup if (and only if) one exists.

        Returns a JSON-safe verdict. ``taken`` is True only when the
        risk manager approved *and* the broker filled exactly one order.
        """
        req = request or GambleRequest(
            min_confidence=self.config.gamble_min_confidence,
            min_risk_reward=self.config.gamble_min_risk_reward,
            min_adx=self.config.gamble_min_adx,
            min_edge_score=self.config.gamble_min_edge_score,
        )
        moment = now or datetime.now(timezone.utc)
        stake = req.clamped_risk(self.config.gamble_max_risk_per_trade)

        allowed, why = self.ledger.can_gamble(moment)
        if execute and not allowed:
            return {"ok": False, "taken": False, "reason": why, "ledger": self.ledger.status(moment)}

        allowed, why = self.bot.risk.can_trade(moment)
        if execute and not allowed:
            return {"ok": False, "taken": False, "reason": f"risk gate closed: {why}", "ledger": self.ledger.status(moment)}

        ranking = self.scan(req)
        board = [c.to_dict() for c in ranking]
        best = next((c for c in ranking if c.is_a_plus), None)
        if best is None:
            top = ranking[0] if ranking else None
            reason = (
                f"no A+ setup — best was {top.pair} (edge {top.edge_score:.1f}: "
                f"{'; '.join(top.failed)}) — no bet placed"
                if top else "no pairs could be scanned"
            )
            self.log.info("GAMBLE refused: %s", reason)
            return {"ok": True, "taken": False, "reason": reason, "ranking": board,
                    "ledger": self.ledger.status(moment)}

        # Rebuild the winning signal object for the risk gate / broker.
        signal = self._resignal(best.pair)
        if signal is None:
            return {"ok": False, "taken": False, "reason": f"{best.pair}: signal vanished on rescan",
                    "ranking": board, "ledger": self.ledger.status(moment)}

        approved, lots, verdict = self.bot.risk.validate_trade(
            signal, now=moment, risk_fraction=stake,
        )
        stake_usd = self.bot.risk.risk_dollars(lots, signal.price, signal.stop_loss, signal.pair) if lots else 0.0
        ticket = {
            "pair": best.pair, "direction": best.direction, "lots": lots,
            "entry": signal.price, "stop_loss": signal.stop_loss,
            "take_profit": signal.take_profit, "risk_usd": stake_usd,
            "target_usd": round(stake_usd * best.risk_reward, 2),
            "risk_reward": best.risk_reward, "edge_score": best.edge_score,
            "confidence": best.confidence,
            "breakeven_win_rate": best.breakeven_win_rate,
            "reasons": best.reasons,
        }
        if not approved:
            self.log.info("GAMBLE %s rejected by risk manager — %s", best.pair, verdict)
            return {"ok": True, "taken": False, "reason": f"risk manager: {verdict}",
                    "candidate": ticket, "ranking": board, "ledger": self.ledger.status(moment)}
        if not execute:
            return {"ok": True, "taken": False, "reason": "scan-only — A+ found but not executed",
                    "candidate": ticket, "ranking": board, "ledger": self.ledger.status(moment)}

        position = self.bot.broker.open_trade(
            signal.pair, signal.direction, lots, signal.stop_loss, signal.take_profit,
        )
        if position is None:
            return {"ok": False, "taken": False, "reason": "broker rejected the order — nothing opened",
                    "candidate": ticket, "ranking": board, "ledger": self.ledger.status(moment)}

        position.comment = "forex_bot_gamble"
        self._initial_risk[int(position.ticket)] = abs(float(position.open_price) - float(position.stop_loss))
        self.bot.risk.register_position(position)
        self.ledger.record_open(position.ticket, detail=ticket, now=moment)
        ticket["ticket"] = position.ticket
        ticket["entry"] = position.open_price
        self.log.info(
            "🎲 GAMBLE TAKEN %s %s %.2f lots @ %.5f | risk %.2f USD | target +%.2f | edge %.1f | ticket %s",
            position.direction, position.pair, position.lots, position.open_price,
            stake_usd, ticket["target_usd"], best.edge_score, position.ticket,
        )
        return {"ok": True, "taken": True, "reason": verdict, "candidate": ticket,
                "ranking": board, "ledger": self.ledger.status(moment)}

    def _resignal(self, pair: str) -> Optional[TradeSignal]:
        """Fresh signal for *pair* (the ranking holds plain data only)."""
        try:
            df = self.bot.feed.get_candles(pair, self.config.candles_per_call)
            return self.bot.strategy.analyze(df, pair)
        except Exception as exc:
            self.log.warning("gamble rescan of %s failed: %s", pair, exc)
            return None

    # ── profit protection ─────────────────────────────────────────────

    def _risk_distance(self, position: Any) -> float:
        """Initial entry→stop distance, stable across breakeven moves."""
        ticket = int(getattr(position, "ticket", 0) or 0)
        cached = self._initial_risk.get(ticket)
        if cached:
            return cached
        current = abs(float(position.open_price) - float(position.stop_loss))
        if current > 0:
            if ticket:
                self._initial_risk[ticket] = current
            return current
        # Stop already at entry (e.g. engine restarted): recover the
        # original distance from the target and the configured RR.
        rr = float(getattr(self.config, "risk_reward_ratio", 0) or 0)
        reward = abs(float(position.take_profit) - float(position.open_price))
        return reward / rr if rr > 0 else 0.0

    def r_multiple(self, position: Any, current_price: float) -> float:
        """Open profit in units of initial risk (``+1R`` = entry→stop once over)."""
        risk = self._risk_distance(position)
        if risk <= 0:
            return 0.0
        move = (float(current_price) - position.open_price) if position.is_long else (position.open_price - float(current_price))
        return round(move / risk, 3)

    def maybe_protect_breakeven(self, position: Any, current_price: float) -> bool:
        """Move the stop to entry once the gamble is up ``gamble_breakeven_r``.

        Returns True when the stop was actually moved. Never moves a
        stop *against* the position and never tightens past the entry.
        """
        if self.r_multiple(position, current_price) < self.config.gamble_breakeven_r:
            return False
        entry = float(position.open_price)
        already = position.stop_loss >= entry if position.is_long else position.stop_loss <= entry
        if already:
            return False
        ok = self.bot.broker.sync_stops(position, entry, position.take_profit)
        if ok:
            position.stop_loss = round(entry, 5)
            self.log.info(
                "🎲 GAMBLE ticket %s protected — stop moved to breakeven %.5f",
                position.ticket, entry,
            )
        return bool(ok)


# ══════════════════════════════════════════════════════════════════════
# CLI
# ══════════════════════════════════════════════════════════════════════


def _print_board(result: Dict[str, Any]) -> None:
    print("\n🎲 GAMBLE — edge ranking (best first)")
    print("─" * 78)
    for c in result.get("ranking", []):
        mark = "★ A+" if c["is_a_plus"] else f"  {c['grade']}"
        adx = f"{c['adx']:.1f}" if c["adx"] is not None else "  –"
        print(
            f"{mark:>5}  {c['pair']:<8} {c['signal_name']:<11} edge {c['edge_score']:>5.1f}  "
            f"conf {c['confidence']:.2f}  RR {c['risk_reward']:.2f}  ADX {adx}  "
            f"breakeven WR {c['breakeven_win_rate']:.0%}"
        )
        for fail in c["failed"]:
            print(f"        ✗ {fail}")
    print("─" * 78)
    if result.get("taken"):
        t = result["candidate"]
        print(
            f"✔ TAKEN {t['direction']} {t['pair']} {t['lots']} lots @ {t['entry']:.5f} "
            f"| SL {t['stop_loss']:.5f} TP {t['take_profit']:.5f} "
            f"| risk ${t['risk_usd']:,.2f} → target +${t['target_usd']:,.2f} | ticket {t.get('ticket')}"
        )
    else:
        print(f"✗ NO BET — {result.get('reason', '')}")
    ledger = result.get("ledger") or {}
    if ledger:
        print(
            f"  ledger today: {ledger.get('taken', 0)}/{ledger.get('max_per_day', 0)} gambles, "
            f"{ledger.get('wins', 0)}W/{ledger.get('losses', 0)}L, net ${ledger.get('net_pnl', 0):+,.2f}"
            + (f" · LOCKED: {ledger['lock_reason']}" if ledger.get("lock_reason") else "")
        )
    print("\nNo button guarantees profit. This one only bets A+ confluence at a capped stake.\n")


def main(argv: Optional[List[str]] = None) -> int:
    """CLI: one hunt, at most one trade. Paper unless told otherwise."""
    parser = argparse.ArgumentParser(description="Hunt ONE A+ setup and (maybe) take it at a capped stake")
    parser.add_argument("--mock", action="store_true", help="synthetic feed + paper fills (the default)")
    parser.add_argument("--live", action="store_true", help="use the real MT5 terminal instead of paper — explicit opt-in")
    parser.add_argument("--scan-only", action="store_true", help="rank the pairs, trade nothing")
    parser.add_argument("--status", action="store_true", help="print today's gamble ledger and exit")
    parser.add_argument("--risk", type=float, default=0.02, help="stake fraction of equity, e.g. 0.02 = 2%% (hard cap 5%%)")
    parser.add_argument("--min-confidence", type=float, default=None, help="override the A+ confidence floor")
    parser.add_argument("--pairs", default="", help="comma-separated subset of config pairs")
    args = parser.parse_args(argv)

    from config import BotConfig

    config = BotConfig()
    ledger = GambleLedger(
        Path(config.state_file).with_name("gamble_state.json"),
        max_per_day=config.gamble_max_per_day,
        max_losses_per_day=config.gamble_max_losses_per_day,
        cooldown_minutes=config.gamble_cooldown_minutes,
    )
    if args.status:
        print(json.dumps(ledger.status(), indent=2))
        return 0

    from data_feed import MockDataFeed
    from main import ForexBot

    feed = None
    if not args.live:
        # Paper-first: a gamble against a real terminal must be asked
        # for explicitly with --live, never arrived at by omission.
        feed = MockDataFeed(config)
        config.paper_mode = True
    bot = ForexBot(config=config, feed=feed)
    engine = GambleEngine(bot, ledger=ledger)
    request = GambleRequest(
        risk_fraction=args.risk,
        min_confidence=args.min_confidence if args.min_confidence is not None else config.gamble_min_confidence,
        min_risk_reward=config.gamble_min_risk_reward,
        min_adx=config.gamble_min_adx,
        min_edge_score=config.gamble_min_edge_score,
        pairs=[p.strip() for p in args.pairs.split(",") if p.strip()] or None,
    )
    result = engine.hunt_once(request, execute=not args.scan_only)
    _print_board(result)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
