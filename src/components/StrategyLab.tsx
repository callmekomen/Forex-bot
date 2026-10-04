import { useMemo, useState } from "react";
import { Brain, Crosshair, Gauge } from "lucide-react";
import { Chip, Metric, Reveal, SectionHeading, SignalBadge, Slider, cx, price as fmtPrice } from "./ui";
import { generateCandles, prepare, scoreAt, sizeLots, pipSizeOf, DEFAULT_PARAMS, type Pair, PAIRS } from "../lib/sim";

const SEED = 99;
const BARS = 900;

function pathify(values: number[], lo: number, hi: number, w: number, h: number) {
  if (!values.length) return "";
  const step = w / (values.length - 1);
  return values
    .map((v, i) => {
      const y = h - ((v - lo) / (hi - lo || 1)) * h;
      return `${i === 0 ? "M" : "L"} ${(i * step).toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

/** First bar (default params) that actually produces a tradeable signal. */
const FIRST_SIGNAL = (() => {
  const candles = generateCandles({ seed: SEED, bars: BARS, pair: "EUR/USD", timeframe: "1h" });
  const prepared = prepare(candles, DEFAULT_PARAMS);
  for (let i = 60; i < BARS - 3; i++) {
    const r = scoreAt(prepared, i, DEFAULT_PARAMS);
    if (r.signal !== "NEUTRAL" && r.confidence >= DEFAULT_PARAMS.minConfidence) return i;
  }
  return 612;
})();

export function StrategyLab() {
  const [pair, setPair] = useState<Pair>("EUR/USD");
  const [bar, setBar] = useState(FIRST_SIGNAL);
  const [fast, setFast] = useState(12);
  const [slow, setSlow] = useState(26);
  const [atrMult, setAtrMult] = useState(1.5);
  const [tpMult, setTpMult] = useState(3);
  const [minConf, setMinConf] = useState(0.6);

  const { row, d, candleView, scale, actionable } = useMemo(() => {
    const candles = generateCandles({ seed: SEED, bars: BARS, pair, timeframe: "1h" });
    const params = { fast, slow, signal: 9, rsiPeriod: 14, rsiOver: 70, rsiUnder: 30, atrMult, tpMult, minConfidence: minConf };
    const prepared = prepare(candles, params);
    const idx = Math.max(60, Math.min(BARS - 3, Math.round(bar)));
    const actionable: number[] = [];
    for (let i = 60; i < BARS - 3; i++) {
      const r = scoreAt(prepared, i, params);
      if (r.signal !== "NEUTRAL") actionable.push(i);
    }
    const slice = candles.slice(idx - 120, idx + 60);
    const closes = slice.map((c) => c.c);
    const lo = Math.min(...closes) * 0.9995;
    const hi = Math.max(...closes) * 1.0005;
    return {
      row: scoreAt(prepared, idx, params),
      d: { prepared, idx, params },
      candleView: { closes, ef: prepared.emaFast.slice(idx - 120, idx + 60), es: prepared.emaSlow.slice(idx - 120, idx + 60) },
      scale: { lo, hi, marker: 120 / 179 },
      actionable,
    };
  }, [pair, bar, fast, slow, atrMult, tpMult, minConf]);

  const step = (dir: 1 | -1) => {
    if (!actionable.length) return;
    const cur = Math.round(bar);
    const next = dir > 0 ? actionable.find((i) => i > cur) : [...actionable].reverse().find((i) => i < cur);
    setBar(next ?? cur);
  };

  const pip = pipSizeOf(pair);
  const sizing = sizeLots(10000, 0.02, row.price, row.sl, pip, 10);
  const risk = Math.abs(row.price - row.sl);
  const reward = Math.abs(row.tp - row.price);
  const rr = risk > 0 ? reward / risk : 0;
  const passed = row.signal !== "NEUTRAL" && row.confidence >= minConf && rr >= 1.5;

  const scorePct = ((row.score + 5) / 10) * 100;
  const w = 300;
  const h = 108;

  return (
    <section id="strategy" className="mx-auto max-w-[1400px] px-4 py-20 md:px-7">
      <Reveal>
        <SectionHeading
          index="03"
          kicker="strategy.py · AdvancedStrategy"
          tone="lilac"
          title={
            <>
              Five indicators vote.
              <br />
              <span className="text-muted">The score decides, not the narrative.</span>
            </>
          }
          blurb={
            <>
              Weights are fixed: EMA ±1.0, MACD histogram ±1.0, MACD crossover ±1.5, RSI ±1.0,
              Bollinger position ±0.5. Score ≥ 3.0 is a strong buy, ≥ 1.5 a buy. ADX never votes — under
              25 it inflates the denominator, so weak trends need more agreement to reach the 0.60 floor.
            </>
          }
          right={
            <div className="flex flex-wrap items-center gap-2">
              {PAIRS.slice(0, 3).map((p) => (
                <button
                  key={p}
                  onClick={() => setPair(p)}
                  className={cx(
                    "rounded-md border px-3 py-1.5 font-mono text-[11px] transition-colors",
                    pair === p ? "border-lilac/50 bg-lilac/15 text-lilac" : "border-line bg-panel/60 text-muted hover:text-sand-2",
                  )}
                >
                  {p}
                </button>
              ))}
            </div>
          }
        />
      </Reveal>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* ── chart + verdict ───────────────────────────────────────── */}
        <Reveal className="min-w-0">
          <div className="panel overflow-hidden rounded-xl">
            <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
              <Crosshair size={13} className="text-lilac" />
              <span className="font-mono text-[11px] text-sand-2">{pair} · H1 · bar #{d.idx}</span>
              <span className="ml-auto flex items-center gap-1.5">
                <button
                  onClick={() => step(-1)}
                  className="rounded border border-line px-2 py-0.5 font-mono text-[10px] text-muted transition-colors hover:border-lilac/45 hover:text-lilac"
                >
                  ← prev signal
                </button>
                <span className="tabnum px-1 font-mono text-[10px] text-muted">{actionable.length} signal bars</span>
                <button
                  onClick={() => step(1)}
                  className="rounded border border-line px-2 py-0.5 font-mono text-[10px] text-muted transition-colors hover:border-lilac/45 hover:text-lilac"
                >
                  next signal →
                </button>
              </span>
              <span className="font-mono text-[11px] text-muted">
                close <span className="tabnum text-sand">{fmtPrice(row.price, pair)}</span>
              </span>
            </div>

            <svg viewBox={`0 0 ${w} ${h}`} className="h-44 w-full">
              {[0.25, 0.5, 0.75].map((g) => (
                <line key={g} x1={0} x2={w} y1={h * g} y2={h * g} className="stroke-line-soft" strokeWidth={0.6} />
              ))}
              <path d={pathify(candleView.ef, scale.lo, scale.hi, w, h)} fill="none" className="stroke-jade" strokeWidth={1.3} />
              <path d={pathify(candleView.es, scale.lo, scale.hi, w, h)} fill="none" className="stroke-rose" strokeWidth={1.3} strokeDasharray="3 3" />
              <path d={pathify(candleView.closes, scale.lo, scale.hi, w, h)} fill="none" className="stroke-sky" strokeWidth={1.7} />
              <line x1={w * scale.marker} x2={w * scale.marker} y1={0} y2={h} className="stroke-amber/70" strokeWidth={1} strokeDasharray="2 3" />
              <text x={6} y={13} className="font-mono fill-jade text-[8px]">EMA{fast}</text>
              <text x={54} y={13} className="font-mono fill-rose text-[8px]">EMA{slow}</text>
              <text x={102} y={13} className="font-mono fill-sky text-[8px]">close</text>
            </svg>

            {/* score ruler */}
            <div className="border-t border-line px-4 py-5">
              <div className="flex items-center justify-between font-mono text-[10px] tracking-wider text-muted uppercase">
                <span>confluence score</span>
                <span className="tabnum text-sand">
                  {row.score >= 0 ? "+" : ""}
                  {row.score.toFixed(2)} / max {row.maxScore.toFixed(2)}
                </span>
              </div>
              <div className="relative mt-3 h-9">
                <div className="absolute inset-x-0 top-3 h-2 rounded-full bg-gradient-to-r from-rose/70 via-line to-jade/70" />
                {[-3, -1.5, 0, 1.5, 3].map((tick) => (
                  <span
                    key={tick}
                    className={cx("absolute top-1.5 h-5 w-px", tick === 0 ? "bg-sand/45" : "bg-ink/70")}
                    style={{ left: `${((tick + 5) / 10) * 100}%` }}
                  />
                ))}
                <span
                  className="absolute top-0 -ml-1.5 size-4 rotate-45 rounded-[3px] border-2 border-ink bg-amber shadow-[0_0_18px_rgba(247,178,59,0.8)] transition-[left] duration-300"
                  style={{ left: `${Math.max(1, Math.min(99, scorePct))}%` }}
                />
                <span className="absolute -bottom-1 left-0 font-mono text-[9px] text-rose/70">−5 STRONG_SELL</span>
                <span className="absolute -bottom-1 right-0 font-mono text-[9px] text-jade/70">STRONG_BUY +5</span>
              </div>
            </div>

            {/* vote rows */}
            <div className="divide-y divide-line-soft border-t border-line">
              {row.votes.map((v) => {
                const mag = Math.min(100, (Math.abs(v.value) / 1.5) * 100);
                const pos = v.value >= 0;
                return (
                  <div key={v.key} className="grid grid-cols-[130px_1fr_92px] items-center gap-3 px-4 py-2.5 transition-colors hover:bg-panel-2/60">
                    <span className="font-mono text-[11px] text-sand-2">{v.label}</span>
                    <span className="relative h-1.5 rounded-full bg-ink-2">
                      <span className="absolute inset-y-0 left-1/2 w-px bg-line" />
                      <span
                        className={cx(
                          "absolute top-0 h-1.5 rounded-full transition-all duration-300",
                          v.key === "adx" ? "bg-sky" : pos ? "bg-jade" : "bg-rose",
                        )}
                        style={
                          v.key === "adx"
                            ? { left: "0%", width: `${Math.min(100, (row.adx / 50) * 100)}%` }
                            : { left: pos ? "50%" : `${50 - mag / 2}%`, width: `${mag / 2}%` }
                        }
                      />
                    </span>
                    <span className={cx("tabnum text-right font-mono text-[11px]", v.value > 0 ? "text-jade" : v.value < 0 ? "text-rose" : "text-muted")}>
                      {v.key === "adx" ? `ADX ${row.adx.toFixed(1)}` : `${v.value > 0 ? "+" : ""}${v.value.toFixed(1)}`}
                      <span className="ml-1 text-muted">{v.weight}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </Reveal>

        {/* ── controls + output ─────────────────────────────────────── */}
        <Reveal delay={80}>
          <div className="flex flex-col gap-4">
            <div className="panel rounded-xl p-4">
              <div className="mb-3 flex items-center gap-2">
                <Brain size={13} className="text-lilac" />
                <span className="font-mono text-[10.5px] tracking-[0.18em] text-muted uppercase">config.py overrides</span>
              </div>
              <div className="space-y-4">
                <Slider label="scrub bar" value={bar} min={60} max={BARS - 3} step={1} onChange={setBar} display={`#${Math.round(bar)}`} tone="sky" />
                <Slider label="fast_ema" value={fast} min={3} max={30} step={1} onChange={(v) => setFast(Math.min(v, slow - 1))} tone="jade" />
                <Slider label="slow_ema" value={slow} min={10} max={80} step={1} onChange={(v) => setSlow(Math.max(v, fast + 1))} tone="rose" />
                <Slider label="atr_multiplier (SL)" value={atrMult} min={0.5} max={4} step={0.1} onChange={setAtrMult} suffix="×" tone="amber" />
                <Slider label="take_profit_multiplier" value={tpMult} min={1} max={6} step={0.1} onChange={setTpMult} suffix="×" tone="jade" />
                <Slider label="min_confidence" value={minConf} min={0.1} max={0.95} step={0.01} onChange={setMinConf} tone="sky" />
              </div>
            </div>

            <div className={cx("panel rounded-xl p-4 transition-colors", passed ? "border-jade/35" : "border-rose/30")}>
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10.5px] tracking-[0.18em] text-muted uppercase">TradeSignal</span>
                <SignalBadge signal={row.signal} />
              </div>
              <div className="mt-3 flex items-center gap-3">
                <Gauge size={15} className={passed ? "text-jade" : "text-rose"} />
                <div className="flex-1">
                  <div className="flex justify-between font-mono text-[10px] text-muted">
                    <span>confidence</span>
                    <span className="tabnum text-sand">
                      {row.confidence.toFixed(2)} / floor {minConf.toFixed(2)}
                    </span>
                  </div>
                  <div className="relative mt-1.5 h-2 rounded-full bg-ink-2">
                    <div
                      className={cx("h-2 rounded-full transition-all duration-300", passed ? "bg-jade" : "bg-rose")}
                      style={{ width: `${row.confidence * 100}%` }}
                    />
                    <div className="absolute -top-1 h-4 w-px bg-amber" style={{ left: `${minConf * 100}%` }} />
                  </div>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2">
                <Metric
                  label="stop loss"
                  value={row.signal === "NEUTRAL" ? "—" : fmtPrice(row.sl, pair)}
                  sub={row.signal === "NEUTRAL" ? "SL/TP = 0 when flat" : `−${(risk / pip).toFixed(1)} pips`}
                  tone="rose"
                />
                <Metric
                  label="take profit"
                  value={row.signal === "NEUTRAL" ? "—" : fmtPrice(row.tp, pair)}
                  sub={row.signal === "NEUTRAL" ? "no target, no trade" : `+${(reward / pip).toFixed(1)} pips`}
                  tone="jade"
                />
                <Metric label="risk : reward" value={rr >= 1.5 ? rr.toFixed(2) : "n/a"} sub="gate needs ≥ 1.50" tone={rr >= 1.5 ? "jade" : "rose"} />
                <Metric
                  label="lot size"
                  value={sizing.lots > 0 ? sizing.lots.toFixed(2) : "—"}
                  sub={sizing.lots > 0 ? `risk ${sizing.riskUsd.toFixed(0)} USD` : "not sized (flat signal)"}
                  tone="amber"
                />
              </div>

              <ul className="mt-4 space-y-1.5 border-t border-line-soft pt-3">
                {row.reasons.map((r) => (
                  <li key={r} className="font-mono text-[10.5px] leading-relaxed text-sand-2/80">
                    <span className="text-lilac">›</span> {r}
                  </li>
                ))}
              </ul>

              <div className="mt-3 flex flex-wrap gap-1.5">
                <Chip tone={passed ? "jade" : "rose"}>{passed ? "gate → would execute" : "gate → rejected"}</Chip>
                <Chip>atr {row.atr > 0 ? (row.atr / pip).toFixed(1) : "0.0"} pips</Chip>
                <Chip>rsi {row.rsi.toFixed(1)}</Chip>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
