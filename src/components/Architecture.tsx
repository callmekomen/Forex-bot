import { useState } from "react";
import { ArrowRight, Boxes, CircleDot } from "lucide-react";
import { Reveal, SectionHeading, cx } from "./ui";

interface Node {
  id: string;
  label: string;
  sub: string;
  x: number;
  y: number;
  tone: "jade" | "amber" | "sky" | "lilac" | "rose" | "muted";
  row: 1 | 2 | 3;
}

const W = 214;
const H = 58;

const NODES: Node[] = [
  { id: "config.py", label: "config.py", sub: "BotConfig · validated once", x: 16, y: 24, tone: "amber", row: 1 },
  { id: "data_feed.py", label: "data_feed.py", sub: "MT5 candles + ticks", x: 266, y: 24, tone: "sky", row: 1 },
  { id: "indicators.py", label: "indicators.py", sub: "pure EMA→ADX maths", x: 516, y: 24, tone: "sky", row: 1 },
  { id: "strategy.py", label: "strategy.py", sub: "TradeSignal + score", x: 766, y: 24, tone: "lilac", row: 1 },
  { id: "risk_manager.py", label: "risk_manager.py", sub: "the only gate", x: 766, y: 150, tone: "rose", row: 2 },
  { id: "broker.py", label: "broker.py", sub: "order_send · magic", x: 516, y: 150, tone: "jade", row: 2 },
  { id: "terminal", label: "MetaTrader 5", sub: "demo / live terminal", x: 266, y: 150, tone: "muted", row: 2 },
  { id: "fills", label: "positions / deals", sub: "SL · TP · P&L", x: 16, y: 150, tone: "muted", row: 2 },
  { id: "backtester.py", label: "backtester.py", sub: "offline replay + metrics", x: 16, y: 276, tone: "lilac", row: 3 },
  { id: "bot_state.json", label: "bot_state.json", sub: "atomic state, restart-safe", x: 266, y: 276, tone: "amber", row: 3 },
  { id: "logger.py", label: "logger.py", sub: "bot.log · errors.log", x: 516, y: 276, tone: "muted", row: 3 },
  { id: "main.py", label: "main.py", sub: "tick loop · CLI · banner", x: 766, y: 276, tone: "jade", row: 3 },
];

const EDGES: { from: string; to: string; dashed?: boolean; label?: string }[] = [
  { from: "config.py", to: "data_feed.py" },
  { from: "data_feed.py", to: "indicators.py", label: "OHLCV df" },
  { from: "indicators.py", to: "strategy.py", label: "enriched df" },
  { from: "strategy.py", to: "risk_manager.py", label: "TradeSignal" },
  { from: "risk_manager.py", to: "broker.py", label: "lots · gate" },
  { from: "broker.py", to: "terminal" },
  { from: "terminal", to: "fills" },
  { from: "risk_manager.py", to: "bot_state.json", dashed: true, label: "persist" },
  { from: "strategy.py", to: "backtester.py", dashed: true },
  { from: "main.py", to: "data_feed.py", dashed: true, label: "polls every 60 s" },
  { from: "logger.py", to: "risk_manager.py", dashed: true },
];

const TONES: Record<Node["tone"], { stroke: string; fill: string; text: string; glow: string }> = {
  jade: { stroke: "stroke-jade/70", fill: "fill-jade/10", text: "text-jade", glow: "rgba(47,211,154,0.55)" },
  amber: { stroke: "stroke-amber/70", fill: "fill-amber/10", text: "text-amber", glow: "rgba(247,178,59,0.55)" },
  sky: { stroke: "stroke-sky/70", fill: "fill-sky/10", text: "text-sky", glow: "rgba(111,179,242,0.5)" },
  lilac: { stroke: "stroke-lilac/70", fill: "fill-lilac/10", text: "text-lilac", glow: "rgba(179,156,240,0.5)" },
  rose: { stroke: "stroke-rose/70", fill: "fill-rose/10", text: "text-rose", glow: "rgba(255,107,111,0.55)" },
  muted: { stroke: "stroke-line", fill: "fill-panel", text: "text-sand-2", glow: "rgba(142,163,173,0.35)" },
};

const MODULES: { file: string; what: string; api: string[] }[] = [
  { file: "main.py", what: "Owns the components and the loop. No risk policy lives here — it asks, the gate answers.", api: ["ForexBot.__init__(config, feed, broker)", "run(max_ticks)", "_tick() → manage → scan pairs", "_manage_positions(now)", "backtest(bars) · self_test()"] },
  { file: "config.py", what: "One dataclass for every knob, validated at construction so a typo can never reach the market.", api: ["BotConfig (29 fields)", "max_risk_dollars · risk_reward_ratio", "pip_size_for(pair) — JPY aware", "is_trading_hours(hour_utc)", "summary() for the banner"] },
  { file: "data_feed.py", what: "The only module that talks to the terminal. Failures become clear exceptions, never empty frames.", api: ["initialize() / shutdown()", "get_candles(pair, num_bars)", "get_latest_tick(pair)", "TIMEFRAME_MAP 1m…1d", "MockDataFeed for tests"] },
  { file: "indicators.py", what: "Textbook maths, vectorised, side-effect free. attach() builds the whole frame in one pass.", api: ["ema · sma · rsi (EWM)", "atr (Wilder TR)", "macd → {macd, signal, hist}", "bollinger_bands · stochastic", "adx — trend strength"] },
  { file: "strategy.py", what: "Weighted votes sum to a score; ADX raises the denominator instead of voting, so chop must earn its confidence.", api: ["Signal(IntEnum) −2…+2", "TradeSignal dataclass", "analyze(df, pair, price)", "from_enriched(frame, pair)", "format_block() log output"] },
  { file: "risk_manager.py", what: "Bulletproof pre-trade gate. Circuit breakers latch into the state file so a restart cannot forget them.", api: ["can_trade() → (bool, str)", "calculate_position_size()", "validate_trade(signal)", "register_position · record_close", "_save_state · load_state"] },
  { file: "broker.py", what: "Builds MT5 requests, checks retcode 10009, and silently switches to simulated fills when no terminal exists.", api: ["open_trade(pair, dir, lots, sl, tp)", "close_trade(position) → pnl", "get_open_positions() (magic only)", "sync_stops() · estimate_pnl()", "build_request() — deviation 20"] },
  { file: "backtester.py", what: "Replays history with the production strategy: next-bar fills, stop-priority exits, spread charged.", api: ["run(df, pair, spread_pips)", "run_all(frames) → portfolio", "18 metrics + equity curve", "report(metrics) console box", "python backtester.py --csv"] },
  { file: "logger.py", what: "Console plus two rotating files. A read-only log directory degrades to console instead of dying.", api: ["setup_logger(name, log_dir)", "bot.log — INFO ↑", "errors.log — WARNING ↑", "10 MB × 5 backups", "get_logger(__name__)"] },
];

export function Architecture({ onOpenFile }: { onOpenFile: (name: string) => void }) {
  const [hover, setHover] = useState<string>("risk_manager.py");

  const nodeById = (id: string) => NODES.find((n) => n.id === id)!;

  return (
    <section id="architecture" className="mx-auto max-w-[1400px] px-4 py-20 md:px-7">
      <Reveal>
        <SectionHeading
          index="02"
          kicker="system map"
          tone="sky"
          title={<>Eight modules, one direction of trust</>}
          blurb={
            <>
              Data flows right, permission flows left. A signal is a request, not an
              instruction: <span className="font-mono text-rose">risk_manager.py</span> sits
              between every idea and the broker, and nothing — not the backtester, not a
              manual call — has a shorter path.
            </>
          }
          right={
            <div className="flex items-center gap-2 rounded-lg border border-line bg-panel/70 px-3 py-2 font-mono text-[11px] text-muted">
              <Boxes size={13} className="text-sky" /> hover a node or a card
            </div>
          }
        />
      </Reveal>

      <Reveal>
        <div className="panel overflow-hidden rounded-xl p-2 md:p-5">
          <svg viewBox="0 0 996 350" className="h-auto w-full" role="img" aria-label="forex_bot module architecture diagram">
            <defs>
              <marker id="arr" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
                <path d="M0,0 L8,4.5 L0,9 z" className="fill-sky/70" />
              </marker>
              <marker id="arrD" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
                <path d="M0,0 L8,4.5 L0,9 z" className="fill-muted/60" />
              </marker>
            </defs>

            {EDGES.map((e) => {
              const a = nodeById(e.from);
              const b = nodeById(e.to);
              const ac = { x: a.x + W / 2, y: a.y + H / 2 };
              const bc = { x: b.x + W / 2, y: b.y + H / 2 };
              let d: string;
              if (Math.abs(ac.y - bc.y) < 2) {
                const dir = bc.x > ac.x ? 1 : -1;
                d = `M ${ac.x + dir * (W / 2)} ${ac.y} L ${bc.x - dir * (W / 2 + 6)} ${bc.y}`;
              } else {
                const midY = (ac.y + bc.y) / 2;
                d = `M ${ac.x} ${ac.y + (bc.y > ac.y ? H / 2 : -H / 2)} C ${ac.x} ${midY}, ${bc.x} ${midY}, ${bc.x} ${bc.y + (bc.y > ac.y ? -H / 2 - 6 : H / 2 + 6)}`;
              }
              const active = hover === e.from || hover === e.to;
              return (
                <g key={`${e.from}-${e.to}`} opacity={active ? 1 : 0.55}>
                  <path
                    d={d}
                    fill="none"
                    strokeWidth={active ? 1.9 : 1.2}
                    markerEnd={e.dashed ? "url(#arrD)" : "url(#arr)"}
                    className={cx(e.dashed ? "stroke-muted/60" : "stroke-sky/70", active && !e.dashed && "stroke-jade")}
                    strokeDasharray={e.dashed ? "4 6" : undefined}
                    opacity={0.9}
                  />
                  {active && <path d={d} fill="none" strokeWidth="3" className="flow-dash stroke-jade/30" />}
                  {e.label && (
                    <text
                      x={(ac.x + bc.x) / 2}
                      y={(ac.y + bc.y) / 2 - 6}
                      textAnchor="middle"
                      className="font-mono fill-muted text-[9px]"
                    >
                      {e.label}
                    </text>
                  )}
                </g>
              );
            })}

            {NODES.map((n) => {
              const t = TONES[n.tone];
              const active = hover === n.id;
              const isFile = n.id.endsWith(".py") || n.id.endsWith(".json");
              return (
                <g
                  key={n.id}
                  transform={`translate(${n.x} ${n.y})`}
                  onMouseEnter={() => setHover(n.id)}
                  onClick={() => isFile && onOpenFile(n.id)}
                  className={cx(isFile && "cursor-pointer")}
                >
                  <rect width={W} height={H} rx={9} className="fill-ink-2" />
                  <rect
                    width={W}
                    height={H}
                    rx={9}
                    strokeWidth={active ? 1.6 : 1}
                    className={cx(t.stroke, t.fill, "transition-all duration-200")}
                    style={active ? { filter: `drop-shadow(0 0 16px ${t.glow})` } : undefined}
                  />
                  <circle cx={16} cy={H / 2 - 7} r={3} className={cx(active ? "fill-current" : "fill-muted", t.text)} />
                  <text x={28} y={H / 2 - 3} className={cx("font-mono text-[12.5px] font-medium", t.text)}>
                    {n.label}
                  </text>
                  <text x={16} y={H / 2 + 15} className="font-mono fill-muted text-[9.5px]">
                    {n.sub}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      </Reveal>

      <div className="mt-8 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {MODULES.map((m, i) => {
          const active = hover === m.file;
          return (
            <Reveal key={m.file} delay={i * 45}>
              <button
                type="button"
                onMouseEnter={() => setHover(m.file)}
                onMouseLeave={() => setHover("")}
                onFocus={() => setHover(m.file)}
                onClick={() => onOpenFile(m.file)}
                className={cx(
                  "hover-lift h-full w-full rounded-xl border p-4 text-left transition-colors",
                  active ? "border-jade/45 bg-panel-2" : "border-line bg-panel/55 hover:border-line",
                )}
              >
                <span className="flex items-center gap-2">
                  <CircleDot size={12} className={active ? "text-jade" : "text-line"} />
                  <span className="font-mono text-[13px] font-semibold text-sand">{m.file}</span>
                  <ArrowRight
                    size={13}
                    className={cx("ml-auto text-muted transition-transform", active && "translate-x-1 text-jade")}
                  />
                </span>
                <p className="mt-2.5 text-[13.5px] leading-snug text-sand-2/80">{m.what}</p>
                <ul className="mt-3 space-y-1 border-t border-line-soft pt-3">
                  {m.api.map((a) => (
                    <li key={a} className="font-mono text-[10.5px] leading-relaxed text-muted">
                      <span className="text-sky/70">›</span> {a}
                    </li>
                  ))}
                </ul>
              </button>
            </Reveal>
          );
        })}
      </div>
    </section>
  );
}
