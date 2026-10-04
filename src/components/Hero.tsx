import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Play, Terminal } from "lucide-react";
import { Chip, Reveal, cx } from "./ui";
import { FILES, TOTAL_LINES } from "../lib/sources";
import { generateCandles, prepare, scoreAt, sizeLots, DEFAULT_PARAMS, pipSizeOf } from "../lib/sim";

interface Line {
  text: string;
  tone: "muted" | "info" | "long" | "short" | "warn" | "rule";
}

/** Build an authentic log tape straight from the mirrored engine. */
function buildTape(): Line[] {
  const candles = generateCandles({ seed: 99, bars: 900, pair: "EUR/USD", timeframe: "1h" });
  const d = prepare(candles, DEFAULT_PARAMS);
  const lines: Line[] = [];
  let ticket = 900_001;
  let stamp = Date.UTC(2024, 0, 15, 7, 0, 0);
  const ts = () => {
    stamp += 3_600_000;
    const dt = new Date(stamp);
    return `${dt.toISOString().slice(0, 10)} ${dt.toISOString().slice(11, 19)}`;
  };

  lines.push({ text: `${ts()} [INFO] forex_bot.bot: Bot starting — 3 pairs, 1h timeframe, balance 10000.00, magic 123456, comment forex_bot_v1`, tone: "muted" });
  lines.push({ text: `${ts()} [INFO] forex_bot.risk: State restored: balance 10000.00, day P&L +0.00, 0 open, halted=false`, tone: "muted" });
  lines.push({ text: `${ts()} [WARNING] forex_bot.broker: PAPER MODE — orders are simulated locally, no request reaches a real account.`, tone: "warn" });

  let emitted = 0;
  for (let i = 60; i < candles.length && emitted < 7; i++) {
    const row = scoreAt(d, i, DEFAULT_PARAMS);
    if (row.signal === "NEUTRAL" || row.confidence < DEFAULT_PARAMS.minConfidence) continue;
    const tone: Line["tone"] = row.dir === "BUY" ? "long" : "short";
    lines.push({ text: `${ts()} [INFO] forex_bot.bot:`, tone: "info" });
    lines.push({ text: "═".repeat(44), tone: "rule" });
    lines.push({ text: `Signal for EUR/USD: ${row.signal}`, tone });
    lines.push({ text: `Price: ${row.price.toFixed(5)}`, tone: "info" });
    lines.push({ text: `SL: ${row.sl.toFixed(5)}  TP: ${row.tp.toFixed(5)}`, tone: "info" });
    lines.push({
      text: `Confidence: ${row.confidence.toFixed(2)}  (score ${row.score >= 0 ? "+" : ""}${row.score.toFixed(2)}, RR ${(row.tp - row.sl) !== 0 ? (Math.abs(row.tp - row.price) / Math.abs(row.price - row.sl)).toFixed(2) : "0.00"})`,
      tone: "info",
    });
    lines.push({ text: "Reasons:", tone: "info" });
    row.reasons.forEach((r) => lines.push({ text: `  ${r}`, tone: "info" }));
    lines.push({ text: "═".repeat(44), tone: "rule" });

    const pip = pipSizeOf("EUR/USD");
    const s = sizeLots(10000, 0.02, row.price, row.sl, pip, 10);
    lines.push({
      text: `${ts()} [INFO] forex_bot.risk: approved ${row.dir} ${s.lots.toFixed(2)} lots @ ${row.price.toFixed(5)} | risk ${s.riskUsd.toFixed(2)} USD (1.98% of equity) | conf ${row.confidence.toFixed(2)}`,
      tone: "info",
    });
    lines.push({
      text: `${ts()} [INFO] forex_bot.broker: FILLED ${row.dir} EUR/USD ${s.lots.toFixed(2)} lots @ ${(row.price + pip).toFixed(5)} (ticket ${ticket++}, retcode 10009)`,
      tone,
    });
    lines.push({
      text: `${ts()} [INFO] forex_bot.risk: TRACKING ${row.dir} EUR/USD ${s.lots.toFixed(2)} lots @ ${row.price.toFixed(5)} | SL ${row.sl.toFixed(5)} | TP ${row.tp.toFixed(5)} | ticket ${ticket - 1}`,
      tone: "info",
    });
    emitted++;
  }

  lines.push({ text: `${ts()} [INFO] forex_bot.bot: Tick 41 done — 41 ticks | balance 10,284.00 | 3 open | day +284.00`, tone: "muted" });
  lines.push({ text: `${ts()} [INFO] forex_bot.bot: No analysis this tick — outside trading hours (21:00 UTC, allowed 07:00-20:00)`, tone: "warn" });
  return lines;
}

const toneClass: Record<Line["tone"], string> = {
  muted: "text-muted",
  info: "text-sand-2",
  long: "text-jade",
  short: "text-rose",
  warn: "text-amber",
  rule: "text-sky/50",
};

export function Hero() {
  const tape = useMemo(buildTape, []);
  const [n, setN] = useState(Math.min(14, tape.length));
  const boxRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    const t = window.setInterval(() => setN((v) => (v >= tape.length + 6 ? 16 : v + 1)), 420);
    return () => window.clearInterval(t);
  }, [tape.length]);

  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [n]);

  const visible = useMemo(() => {
    const out: Line[] = [];
    for (let i = 0; i < Math.min(n, tape.length); i++) out.push(tape[i]);
    return out;
  }, [n, tape]);

  return (
    <section id="top" className="relative mx-auto max-w-[1400px] px-4 pt-14 pb-16 md:px-7 md:pt-20">
      <div className="grid gap-10 lg:grid-cols-[1.02fr_1fr] lg:gap-12">
        {/* ── statement column ─────────────────────────────────────── */}
        <div>
          <Reveal>
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone="jade">python 3.10+</Chip>
              <Chip tone="sky">MetaTrader 5 bridge</Chip>
              <Chip tone="amber">magic 123456</Chip>
              <Chip>12 files · {TOTAL_LINES.toLocaleString()} lines</Chip>
            </div>
          </Reveal>

          <Reveal delay={70}>
            <h1 className="mt-7 font-display text-[42px] leading-[0.98] font-bold tracking-[-0.035em] text-sand md:text-[68px]">
              A forex bot that
              <span className="block text-muted">says </span>
              <span className="relative inline-block">
                <span className="relative z-10 text-rose">no</span>
                <span className="absolute inset-x-0 bottom-1.5 z-0 h-3 bg-rose/20" />
              </span>
              <span className="block">to most of its own ideas.</span>
            </h1>
          </Reveal>

          <Reveal delay={140}>
            <p className="mt-6 max-w-xl text-[16.5px] leading-relaxed text-sand-2/85">
              Five indicators vote for a direction. A hard risk gate then decides
              whether the account can afford the opinion: 2% of equity per trade,
              5% daily loss breaker, 15% drawdown breaker, one position per pair,
              trading only inside the UTC window. Everything is logged, everything
              is persisted to <code className="rounded bg-panel px-1.5 py-0.5 font-mono text-[13px] text-amber">bot_state.json</code>.
            </p>
          </Reveal>

          <Reveal delay={210}>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <a
                href="#desk"
                className="group inline-flex items-center gap-2 rounded-lg border border-jade/45 bg-jade/12 px-5 py-3 font-mono text-[12.5px] font-medium tracking-wide text-jade uppercase transition-all hover:bg-jade/20 hover:shadow-[0_0_28px_-8px_rgba(47,211,154,0.65)]"
              >
                <span className="size-1.5 animate-pulse-soft rounded-full bg-jade" />
                Open the live desk
                <ArrowDown size={14} className="transition-transform group-hover:translate-y-0.5" />
              </a>
              <a
                href="#source"
                className="inline-flex items-center gap-2 rounded-lg border border-line bg-panel px-5 py-3 font-mono text-[12.5px] tracking-wide text-sand-2 uppercase transition-colors hover:border-jade/40 hover:text-jade"
              >
                Read every file
              </a>
              <a
                href="#backtest"
                className="inline-flex items-center gap-2 rounded-lg border border-line bg-panel px-5 py-3 font-mono text-[12.5px] tracking-wide text-sand-2 uppercase transition-colors hover:border-amber/45 hover:text-amber"
              >
                <Play size={13} /> Backtest lab
              </a>
              <span className="font-mono text-[11px] text-muted">
                <span className="text-amber">⚠</span> demo accounts only — see the risk warning
              </span>
            </div>
          </Reveal>

          <Reveal delay={280}>
            <dl className="mt-11 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line/60 sm:grid-cols-4">
              {[
                { k: "risk / trade", v: "2.0%", s: "fixed fractional" },
                { k: "risk : reward", v: "1 : 2", s: "ATR 1.5 / 3.0" },
                { k: "min confidence", v: "0.60", s: "ADX-dampened" },
                { k: "tick interval", v: "60 s", s: "07–20 UTC" },
              ].map((m) => (
                <div key={m.k} className="bg-ink-2/90 p-4">
                  <dt className="font-mono text-[9.5px] tracking-[0.18em] text-muted uppercase">{m.k}</dt>
                  <dd className="tabnum mt-2 font-display text-[26px] leading-none font-bold text-sand">{m.v}</dd>
                  <dd className="mt-1.5 font-mono text-[10px] text-sky/80">{m.s}</dd>
                </div>
              ))}
            </dl>
          </Reveal>
        </div>

        {/* ── live console ─────────────────────────────────────────── */}
        <Reveal delay={120} className="min-w-0">
          <div className="panel hover-lift relative overflow-hidden rounded-xl shadow-[0_30px_80px_-40px_rgba(0,0,0,0.9)] hover:border-jade/30">
            <div className="flex items-center gap-3 border-b border-line bg-panel-2/80 px-4 py-2.5">
              <span className="flex gap-1.5">
                <span className="size-2.5 rounded-full bg-rose/80" />
                <span className="size-2.5 rounded-full bg-amber/80" />
                <span className="size-2.5 rounded-full bg-jade/80" />
              </span>
              <span className="flex items-center gap-1.5 font-mono text-[11px] text-sand-2">
                <Terminal size={12} className="text-muted" />
                forex_bot — python main.py --mock
              </span>
              <span className="ml-auto font-mono text-[10px] tracking-wider text-jade uppercase">
                <span className="animate-pulse-soft">●</span> streaming
              </span>
            </div>
            <pre
              ref={boxRef}
              className="h-[430px] overflow-y-auto bg-ink-2/70 p-4 font-mono text-[11.5px] leading-[1.62] md:h-[520px]"
            >
              {visible.map((l, i) => (
                <div key={i} className={cx("whitespace-pre-wrap break-words", toneClass[l.tone])}>
                  {l.text}
                </div>
              ))}
              <div className="text-jade">
                <span className="animate-blink">▍</span>
              </div>
            </pre>
            <div className="grid grid-cols-3 gap-px border-t border-line bg-line/60 font-mono text-[10px]">
              {[
                ["bot.log", `${FILES.length} files tracked`],
                ["errors.log", "WARNING ↑ only"],
                ["rotate", "10 MB × 5"],
              ].map(([a, b]) => (
                <div key={a} className="bg-panel/90 px-3 py-2">
                  <div className="text-sky/80">{a}</div>
                  <div className="mt-0.5 text-muted">{b}</div>
                </div>
              ))}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
