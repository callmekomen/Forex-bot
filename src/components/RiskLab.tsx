import { useMemo, useState } from "react";
import { Check, Lock, ShieldAlert, X } from "lucide-react";
import { Chip, Metric, Reveal, SectionHeading, Slider, cx, usd } from "./ui";
import { basePriceOf, pipSizeOf, sizeLots } from "../lib/sim";

type Tone = "pass" | "fail" | "skip";

interface Gate {
  id: string;
  order: string;
  tone: Tone;
  detail: string;
}

export function RiskLab() {
  const [pair, setPair] = useState("EUR/USD");
  const [balance, setBalance] = useState(10000);
  const [riskPct, setRiskPct] = useState(0.02);
  const [pipValue, setPipValue] = useState(10);
  const [atrPips, setAtrPips] = useState(28);
  const [atrMult, setAtrMult] = useState(1.5);
  const [tpMult, setTpMult] = useState(3);
  const [dailyPnl, setDailyPnl] = useState(0);
  const [peak, setPeak] = useState(10400);
  const [openCount, setOpenCount] = useState(1);
  const [maxOpen, setMaxOpen] = useState(3);
  const [hour, setHour] = useState(13);
  const [startHour] = useState(7);
  const [endHour] = useState(20);
  const [confidence, setConfidence] = useState(0.72);
  const [dupPair, setDupPair] = useState(false);
  const [haltOverride, setHaltOverride] = useState(false);
  const [maxDailyLoss, setMaxDailyLoss] = useState(0.05);
  const [maxDrawdown, setMaxDrawdown] = useState(0.15);
  const [minConfidence, setMinConfidence] = useState(0.6);

  const state = useMemo(() => {
    const dailyLossLimit = balance * maxDailyLoss;
    const drawdown = peak > 0 ? Math.max(0, (peak - balance) / peak) : 0;
    const haltedFromLoss = dailyPnl <= -Math.abs(dailyLossLimit);
    const haltedFromDrawdown = drawdown >= maxDrawdown;
    const halted = haltOverride || haltedFromLoss || haltedFromDrawdown;
    const haltReason = haltedFromDrawdown
      ? `max drawdown ${(drawdown * 100).toFixed(2)}% >= ${(maxDrawdown * 100).toFixed(2)}%`
      : haltedFromLoss
        ? `daily loss ${dailyPnl.toFixed(2)} exceeded ${dailyLossLimit.toFixed(2)}`
        : haltOverride
          ? "manual / persisted halt"
          : "";

    const inHours = startHour === endHour || (startHour < endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour);

    const gates: Gate[] = [];
    const push = (id: string, order: string, ok: boolean, detail: string, failDetail: string) =>
      gates.push({ id, order, tone: ok ? "pass" : "fail", detail: ok ? detail : failDetail });

    push("halted", "a", !halted, "bot is active", halted ? `BOT HALTED (${haltReason})` : "");
    if (!halted) {
      push("positions", "b", openCount < maxOpen, `${openCount}/${maxOpen} slots used`, `max open positions reached (${openCount}/${maxOpen})`);
      push("balance", "c", balance > 0, `equity ${usd(balance)}`, `account balance depleted (${usd(balance)})`);
      push("daily-loss", "d", !haltedFromLoss, `day ${usd(dailyPnl)} vs limit ${usd(-dailyLossLimit)}`, `halted: ${haltReason}`);
      push("drawdown", "e", !haltedFromDrawdown, `dd ${(drawdown * 100).toFixed(2)}% vs ${(maxDrawdown * 100).toFixed(2)}% limit`, `halted: ${haltReason}`);
      push("hours", "f", inHours, `${String(hour).padStart(2, "0")}:00 UTC is inside ${String(startHour).padStart(2, "0")}–${String(endHour).padStart(2, "0")} UTC`, `outside trading hours (${String(hour).padStart(2, "0")}:00 UTC)`);
    } else {
      gates.push({ id: "positions", order: "b", tone: "skip", detail: "not evaluated — already halted" });
      gates.push({ id: "balance", order: "c", tone: "skip", detail: "not evaluated — already halted" });
      gates.push({ id: "daily-loss", order: "d", tone: "skip", detail: "not evaluated — already halted" });
      gates.push({ id: "drawdown", order: "e", tone: "skip", detail: "not evaluated — already halted" });
      gates.push({ id: "hours", order: "f", tone: "skip", detail: "not evaluated — already halted" });
    }

    const canTrade = !gates.some((g) => g.tone === "fail");
    const firstFail = gates.find((g) => g.tone === "fail");

    // sizing from the plan
    const pip = pipSizeOf(pair);
    const entry = basePriceOf(pair);
    const stopDistance = atrPips * atrMult * pip;
    const sl = entry - stopDistance;
    const tp = entry + stopDistance * (tpMult / atrMult);
    const s = sizeLots(balance, riskPct, entry, sl, pip, pipValue);
    const rr = tpMult / atrMult;

    const steps: Gate[] = [];
    steps.push({ id: "can_trade gate", order: "1", tone: canTrade ? "pass" : "fail", detail: canTrade ? "can_trade() → (True, 'OK')" : `rejected: ${firstFail?.detail}` });
    steps.push({ id: "confidence", order: "2", tone: confidence >= minConfidence ? "pass" : "fail", detail: `signal.confidence ${confidence.toFixed(2)} vs floor ${minConfidence.toFixed(2)}` });
    steps.push({ id: "risk : reward", order: "3", tone: rr >= 1.5 ? "pass" : "fail", detail: `reward/risk = ${rr.toFixed(2)} (minimum 1.50)` });
    steps.push({ id: "duplicate pair", order: "4", tone: dupPair ? "fail" : "pass", detail: dupPair ? `already holding BUY 0.20 lots on ${pair}` : "no open position on this pair" });
    steps.push({ id: "sizing", order: "5", tone: s.lots > 0 ? "pass" : "fail", detail: `${s.pips.toFixed(1)} pips × ${pipValue} = cap ${usd(s.cap)} → ${s.lots.toFixed(2)} lots` });
    steps.push({
      id: "realised-risk cap",
      order: "6",
      tone: s.riskUsd <= s.cap + 0.01 ? "pass" : "fail",
      detail: s.reduced ? `lots shaved to ${s.lots.toFixed(2)} → ${usd(s.riskUsd)} at stop (${s.lots <= 0.01 ? "at minimum lot" : "reduced, never raised"})` : `${usd(s.riskUsd)} at stop ≤ ${usd(s.cap)} cap`,
    });

    const approved = canTrade && steps.every((st) => st.tone === "pass");
    return {
      gates, steps, canTrade, firstFail, approved, pip, entry, sl, tp, s, rr, drawdown, dailyLossLimit, halted, haltReason, stopDistance,
    };
  }, [pair, balance, riskPct, pipValue, atrPips, atrMult, tpMult, dailyPnl, peak, openCount, maxOpen, hour, startHour, endHour, confidence, dupPair, haltOverride, maxDailyLoss, maxDrawdown, minConfidence]);

  const stateJson = JSON.stringify(
    {
      saved_at: "…tick…",
      daily_date: "2024-01-15",
      daily_pnl: Number(dailyPnl.toFixed(2)),
      current_balance: Number(balance.toFixed(2)),
      peak_balance: Number(peak.toFixed(2)),
      halted: state.halted,
      halt_reason: state.haltReason,
      open_positions: openCount,
    },
    null,
    2,
  );

  return (
    <section id="risk" className="mx-auto max-w-[1400px] px-4 py-20 md:px-7">
      <Reveal>
        <SectionHeading
          index="04"
          kicker="risk_manager.py · the gate"
          tone="rose"
          title={
            <>
              The most important file
              <br />
              <span className="text-muted">is the one that says no.</span>
            </>
          }
          blurb={
            <>
              Six ordered gates decide whether the bot may trade at all; six more decide
              whether <em>this</em> signal may trade. Position size is derived from cash at
              risk, so a smaller balance can only ever produce smaller lots — the file has no
              martingale and no grid recovery to fall back on.
            </>
          }
          right={
            <div
              className={cx(
                "flex items-center gap-2 rounded-lg border px-3.5 py-2.5 font-mono text-[12px] transition-colors",
                state.approved ? "border-jade/45 bg-jade/10 text-jade" : "border-rose/45 bg-rose/10 text-rose",
              )}
            >
              {state.approved ? <Check size={14} /> : <ShieldAlert size={14} />}
              {state.approved ? "APPROVED" : "BLOCKED"}
            </div>
          }
        />
      </Reveal>

      <div className="grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)_320px]">
        {/* inputs */}
        <Reveal>
          <div className="panel space-y-4 rounded-xl p-4">
            <div className="flex items-center gap-2">
              <Lock size={13} className="text-rose" />
              <span className="font-mono text-[10.5px] tracking-[0.18em] text-muted uppercase">account & limits</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {["EUR/USD", "GBP/USD", "USD/JPY"].map((p) => (
                <button
                  key={p}
                  onClick={() => setPair(p)}
                  className={cx(
                    "rounded-md border px-2 py-1 font-mono text-[10.5px] transition-colors",
                    pair === p ? "border-rose/45 bg-rose/12 text-rose" : "border-line text-muted hover:text-sand-2",
                  )}
                >
                  {p}
                </button>
              ))}
            </div>
            <Slider label="current_balance" value={balance} min={500} max={40000} step={100} onChange={setBalance} display={balance.toLocaleString()} tone="jade" />
            <Slider label="max_risk_per_trade" value={riskPct} min={0.0025} max={0.05} step={0.0025} onChange={setRiskPct} display={`${(riskPct * 100).toFixed(2)}%`} tone="amber" />
            <Slider label="pip_value (per lot)" value={pipValue} min={5} max={20} step={0.5} onChange={setPipValue} suffix="$" tone="sky" />
            <Slider label="ATR in pips" value={atrPips} min={4} max={140} step={1} onChange={setAtrPips} tone="rose" />
            <Slider label="atr_multiplier → SL" value={atrMult} min={0.5} max={4} step={0.1} onChange={setAtrMult} suffix="×" tone="rose" />
            <Slider label="tp_multiplier → TP" value={tpMult} min={1} max={6} step={0.1} onChange={setTpMult} suffix="×" tone="jade" />
            <div className="border-t border-line-soft pt-3">
              <div className="flex items-center gap-2 font-mono text-[10.5px] tracking-[0.18em] text-muted uppercase">
                live state
              </div>
              <div className="mt-3 space-y-4">
                <Slider label="daily_pnl" value={dailyPnl} min={-1500} max={900} step={10} onChange={setDailyPnl} display={usd(dailyPnl, 0)} tone={dailyPnl < 0 ? "rose" : "jade"} />
                <Slider label="peak_balance" value={peak} min={500} max={40000} step={100} onChange={setPeak} display={peak.toLocaleString()} tone="sky" />
                <Slider label="open_positions" value={openCount} min={0} max={6} step={1} onChange={setOpenCount} tone="amber" />
                <Slider label="max_open_positions" value={maxOpen} min={1} max={6} step={1} onChange={setMaxOpen} tone="amber" />
                <Slider label="hour (UTC)" value={hour} min={0} max={23} step={1} onChange={setHour} display={`${String(hour).padStart(2, "0")}:00`} tone="sky" />
                <Slider label="max_daily_loss" value={maxDailyLoss} min={0.01} max={0.2} step={0.005} onChange={setMaxDailyLoss} display={`${(maxDailyLoss * 100).toFixed(1)}%`} tone="rose" />
                <Slider label="max_drawdown_limit" value={maxDrawdown} min={0.02} max={0.4} step={0.01} onChange={setMaxDrawdown} display={`${(maxDrawdown * 100).toFixed(0)}%`} tone="rose" />
                <Slider label="signal confidence" value={confidence} min={0} max={1} step={0.01} onChange={setConfidence} tone="sky" />
                <Slider label="min_confidence" value={minConfidence} min={0.1} max={0.95} step={0.01} onChange={setMinConfidence} tone="amber" />
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {[
                  { k: "duplicate pair on same symbol", v: dupPair, set: setDupPair },
                  { k: "halted flag persisted in state", v: haltOverride, set: setHaltOverride },
                ].map((t) => (
                  <button
                    key={t.k}
                    onClick={() => t.set(!t.v)}
                    className={cx(
                      "rounded-md border px-2.5 py-1.5 font-mono text-[10px] transition-colors",
                      t.v ? "border-rose/45 bg-rose/12 text-rose" : "border-line bg-panel/60 text-muted hover:text-sand-2",
                    )}
                  >
                    {t.v ? "◉" : "○"} {t.k}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </Reveal>

        {/* gates */}
        <Reveal delay={60} className="min-w-0">
          <div className="flex h-full flex-col gap-4">
            <div className="panel rounded-xl p-4">
              <h3 className="font-mono text-[10.5px] tracking-[0.18em] text-muted uppercase">can_trade() — evaluated in order, first failure wins</h3>
              <ol className="mt-3 space-y-1.5">
                {state.gates.map((g) => (
                  <li
                    key={g.order}
                    className={cx(
                      "flex items-start gap-3 rounded-lg border px-3 py-2 transition-colors",
                      g.tone === "pass" && "border-jade/25 bg-jade/[0.06]",
                      g.tone === "fail" && "border-rose/40 bg-rose/[0.09]",
                      g.tone === "skip" && "border-line-soft bg-ink-2/40",
                    )}
                  >
                    <span
                      className={cx(
                        "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full",
                        g.tone === "pass" && "bg-jade/20 text-jade",
                        g.tone === "fail" && "bg-rose/20 text-rose",
                        g.tone === "skip" && "bg-line text-muted",
                      )}
                    >
                      {g.tone === "pass" ? <Check size={10} strokeWidth={3} /> : g.tone === "fail" ? <X size={10} strokeWidth={3} /> : <span className="text-[8px]">–</span>}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="font-mono text-[11.5px] text-sand">
                        {g.order}. {g.id}
                      </span>
                      <span className={cx("block font-mono text-[10.5px]", g.tone === "fail" ? "text-rose/90" : "text-muted")}>{g.detail}</span>
                    </span>
                  </li>
                ))}
              </ol>
              <div className="mt-3 flex flex-wrap gap-1.5">
                <Chip tone={state.canTrade ? "jade" : "rose"}>{state.canTrade ? "→ (True, 'OK')" : `→ (False, "${state.firstFail?.id}")`}</Chip>
                <Chip tone="amber">daily limit {usd(state.dailyLossLimit, 0)}</Chip>
                <Chip tone={state.drawdown >= maxDrawdown ? "rose" : "line"}>drawdown {(state.drawdown * 100).toFixed(2)}%</Chip>
              </div>
            </div>

            <div className="panel rounded-xl p-4">
              <h3 className="font-mono text-[10.5px] tracking-[0.18em] text-muted uppercase">
                validate_trade(signal) → (approved, lots, reason)
              </h3>
              <ol className="mt-3 grid gap-1.5 sm:grid-cols-2">
                {state.steps.map((g) => (
                  <li
                    key={g.order}
                    className={cx(
                      "rounded-lg border px-3 py-2",
                      g.tone === "pass" ? "border-line-soft bg-ink-2/50" : "border-rose/35 bg-rose/[0.07]",
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <span className={cx("font-mono text-[10px]", g.tone === "pass" ? "text-jade" : "text-rose")}>
                        {g.tone === "pass" ? "✓" : "✗"} {g.order}.
                      </span>
                      <span className="font-mono text-[11px] text-sand">{g.id}</span>
                    </span>
                    <span className="mt-0.5 block font-mono text-[10px] leading-relaxed text-muted">{g.detail}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </Reveal>

        {/* sizing + state */}
        <Reveal delay={120}>
          <div className="flex h-full flex-col gap-4">
            <div className="panel rounded-xl p-4">
              <h3 className="font-mono text-[10.5px] tracking-[0.18em] text-muted uppercase">calculate_position_size()</h3>
              <pre className="mt-3 overflow-x-auto rounded-lg border border-line-soft bg-ink-2/80 p-3 font-mono text-[10.5px] leading-relaxed text-sand-2">
{`distance = |${state.entry.toFixed(5)} − ${state.sl.toFixed(5)}|
         = ${(state.stopDistance).toFixed(5)}  (${(state.stopDistance / state.pip).toFixed(1)} pips)
max_usd  = ${balance.toLocaleString()} × ${(riskPct * 100).toFixed(2)}% = ${usd(state.s.cap)}
lots     = ${usd(state.s.cap)} / (${(state.stopDistance / state.pip).toFixed(1)} × ${pipValue})
         = ${state.s.lots.toFixed(2)} lots${state.s.reduced ? "  (shaved to fit cap)" : ""}`}
              </pre>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Metric label="lots" value={state.s.lots.toFixed(2)} sub={state.s.lots > 0 ? `${(state.s.lots * 100000).toFixed(0)} units` : "sizing refused"} tone="amber" />
                <Metric label="risk at stop" value={usd(state.s.riskUsd)} sub={`${((state.s.riskUsd / Math.max(balance, 1)) * 100).toFixed(2)}% of equity`} tone="rose" />
                <Metric label="entry" value={state.entry.toFixed(5)} tone="sky" />
                <Metric label="TP" value={state.tp.toFixed(5)} sub={`RR ${state.rr.toFixed(2)}`} tone="jade" />
              </div>
            </div>

            <div className="panel flex-1 rounded-xl p-4">
              <div className="flex items-center justify-between">
                <h3 className="font-mono text-[10.5px] tracking-[0.18em] text-muted uppercase">bot_state.json</h3>
                <span className="font-mono text-[9.5px] text-jade">written atomically</span>
              </div>
              <pre className="mt-3 max-h-[220px] overflow-auto rounded-lg border border-line-soft bg-ink-2/80 p-3 font-mono text-[10.5px] leading-relaxed text-amber/85">
                {stateJson}
              </pre>
              <p className="mt-3 text-[12.5px] leading-relaxed text-sand-2/75">
                Halts are <span className="text-rose">sticky</span>: they survive a restart because they are
                part of the state file. Clearing one is a deliberate act —{" "}
                <code className="rounded bg-panel px-1 py-0.5 font-mono text-[11px] text-sky">risk.reset_halt()</code>.
              </p>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
