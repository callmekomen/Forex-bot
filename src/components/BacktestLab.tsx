import { useMemo, useState } from "react";
import {
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
} from "chart.js";
import { Bar, Line } from "react-chartjs-2";
import { ChartLine, RotateCcw } from "lucide-react";
import { Chip, Metric, Reveal, SectionHeading, Slider, cx, usd } from "./ui";
import { PAIRS, TIMEFRAMES, runBacktest, type Pair, type Timeframe } from "../lib/sim";

ChartJS.register(LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip, Legend, BarElement);

const DOWN = 260;

const gridColor = "rgba(36,54,63,0.75)";
const tickColor = "#8ea3ad";

export function BacktestLab() {
  const [pair, setPair] = useState<Pair>("EUR/USD");
  const [timeframe, setTimeframe] = useState<Timeframe>("1h");
  const [bars, setBars] = useState(2200);
  const [seed, setSeed] = useState(11);
  const [spread, setSpread] = useState(1.5);
  const [balance, setBalance] = useState(10000);
  const [riskPct, setRiskPct] = useState(0.02);
  const [minConf, setMinConf] = useState(0.6);
  const [atrMult, setAtrMult] = useState(1.5);
  const [tpMult, setTpMult] = useState(3);

  const result = useMemo(
    () =>
      runBacktest({
        pair,
        timeframe,
        bars,
        seed,
        spreadPips: spread,
        balance,
        riskPct,
        minConfidence: minConf,
        atrMult,
        tpMult,
      }),
    [pair, timeframe, bars, seed, spread, balance, riskPct, minConf, atrMult, tpMult],
  );

  const m = result.metrics;
  const step = Math.max(1, Math.floor(result.equity.length / DOWN));
  const sample = (arr: number[]) => arr.filter((_, i) => i % step === 0 || i === arr.length - 1);
  const labels = sample(result.equity.map((_, i) => i)).map((_, i) => String(i * step));
  const eq = sample(result.equity);
  const dd = sample(result.drawdown);

  const lastTrades = result.trades.slice(-46);

  const equityData = {
    labels,
    datasets: [
      {
        label: "equity (USD)",
        data: eq,
        borderColor: "#2fd39a",
        backgroundColor: (ctx: { chart: { ctx: CanvasRenderingContext2D; chartArea?: { top: number; bottom: number } } }) => {
          const area = ctx.chart.chartArea;
          if (!area) return "rgba(47,211,154,0.12)";
          const g = ctx.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
          g.addColorStop(0, "rgba(47,211,154,0.34)");
          g.addColorStop(1, "rgba(47,211,154,0.01)");
          return g;
        },
        borderWidth: 1.5,
        fill: true,
        pointRadius: 0,
        tension: 0.05,
        yAxisID: "y",
      },
      {
        label: "drawdown %",
        data: dd,
        borderColor: "rgba(255,107,111,0.9)",
        backgroundColor: "rgba(255,107,111,0.16)",
        borderWidth: 1.1,
        fill: true,
        pointRadius: 0,
        tension: 0.1,
        yAxisID: "y1",
      },
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index" as const, intersect: false },
    plugins: {
      legend: { display: true, labels: { color: tickColor, boxWidth: 10, font: { family: "JetBrains Mono", size: 10 } } },
      tooltip: {
        backgroundColor: "#0e161c",
        borderColor: "#24363f",
        borderWidth: 1,
        titleColor: "#ece7dc",
        bodyColor: "#c9c2b4",
        titleFont: { family: "JetBrains Mono", size: 10 },
        bodyFont: { family: "JetBrains Mono", size: 11 },
        callbacks: {
          title: (items: { dataIndex: number }[]) => `bar ${items[0].dataIndex * step + 50}`,
        },
      },
    },
    scales: {
      x: { grid: { color: gridColor }, ticks: { color: tickColor, maxTicksLimit: 8, font: { family: "JetBrains Mono", size: 9 } } },
      y: { grid: { color: gridColor }, ticks: { color: tickColor, font: { family: "JetBrains Mono", size: 9.5 } } },
      y1: {
        position: "right" as const,
        grid: { display: false },
        ticks: { color: "rgba(255,107,111,0.8)", font: { family: "JetBrains Mono", size: 9 }, callback: (v: number | string) => `${v}%` },
        reverse: true,
      },
    },
  };

  const tradeData = {
    labels: lastTrades.map((t) => `${t.dir === "BUY" ? "▲" : "▼"}${t.n}`),
    datasets: [
      {
        label: "P&L per trade (USD)",
        data: lastTrades.map((t) => t.pnl),
        backgroundColor: lastTrades.map((t) => (t.pnl > 0 ? "rgba(47,211,154,0.75)" : "rgba(255,107,111,0.75)")),
        borderRadius: 2,
        barPercentage: 0.78,
      },
    ],
  };

  const barOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: "#0e161c",
        borderColor: "#24363f",
        borderWidth: 1,
        callbacks: {
          title: (items: { dataIndex: number }[]) => {
            const t = lastTrades[items[0].dataIndex];
            return t ? `${t.pair} ${t.dir} · ${t.reason.replace("_", " ")}` : "";
          },
          label: (item: { dataIndex: number }) => {
            const t = lastTrades[item.dataIndex];
            return t ? ` ${usd(t.pnl)} · ${t.lots.toFixed(2)} lots · ${t.bars} bars · conf ${t.confidence.toFixed(2)}` : "";
          },
        },
      },
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: tickColor, font: { family: "JetBrains Mono", size: 9 } } },
      y: { grid: { color: gridColor }, ticks: { color: tickColor, font: { family: "JetBrains Mono", size: 9 } } },
    },
  };

  const reset = () => {
    setPair("EUR/USD");
    setTimeframe("1h");
    setBars(2200);
    setSeed(11);
    setSpread(1.5);
    setBalance(10000);
    setRiskPct(0.02);
    setMinConf(0.6);
    setAtrMult(1.5);
    setTpMult(3);
  };

  return (
    <section id="backtest" className="mx-auto max-w-[1400px] px-4 py-20 md:px-7">
      <Reveal>
        <SectionHeading
          index="05"
          kicker="backtester.py · Backtester.run()"
          tone="sky"
          title={
            <>
              Honest replay: next-bar fills,
              <br />
              <span className="text-muted">stop-first exits, spread charged.</span>
            </>
          }
          blurb={
            <>
              The engine skips 50 warm-up bars, refuses anything below the confidence floor, demands
              reward:risk ≥ 1.5, and when one bar touches both the stop and the target it books the{" "}
              <span className="text-rose">stop</span>. This console is a TypeScript mirror of that loop — the
              authoritative report comes from <code className="rounded bg-panel px-1.5 py-0.5 font-mono text-[12px] text-amber">python backtester.py</code>.
            </>
          }
          right={
            <button
              onClick={reset}
              className="inline-flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 font-mono text-[11px] tracking-wide text-muted uppercase transition-colors hover:border-sky/45 hover:text-sky"
            >
              <RotateCcw size={12} /> reset
            </button>
          }
        />
      </Reveal>

      <div className="grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
        <Reveal>
          <div className="panel space-y-4 rounded-xl p-4">
            <div className="flex items-center gap-2">
              <ChartLine size={13} className="text-sky" />
              <span className="font-mono text-[10.5px] tracking-[0.18em] text-muted uppercase">run parameters</span>
            </div>
            <div>
              <span className="font-mono text-[10px] tracking-[0.18em] text-muted uppercase">pair</span>
              <div className="mt-2 grid grid-cols-2 gap-1.5">
                {PAIRS.map((p) => (
                  <button
                    key={p}
                    onClick={() => setPair(p)}
                    className={cx(
                      "rounded-md border px-2 py-1.5 font-mono text-[10.5px] transition-colors",
                      pair === p ? "border-sky/50 bg-sky/12 text-sky" : "border-line bg-ink-2/60 text-muted hover:text-sand-2",
                    )}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <span className="font-mono text-[10px] tracking-[0.18em] text-muted uppercase">timeframe</span>
              <div className="mt-2 flex gap-1.5">
                {TIMEFRAMES.map((t) => (
                  <button
                    key={t}
                    onClick={() => setTimeframe(t)}
                    className={cx(
                      "flex-1 rounded-md border py-1.5 font-mono text-[10.5px] transition-colors",
                      timeframe === t ? "border-jade/50 bg-jade/12 text-jade" : "border-line bg-ink-2/60 text-muted hover:text-sand-2",
                    )}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <Slider label="bars" value={bars} min={600} max={4000} step={100} onChange={setBars} tone="sky" />
            <Slider label="seed" value={seed} min={1} max={120} step={1} onChange={setSeed} tone="amber" />
            <Slider label="spread" value={spread} min={0} max={5} step={0.1} onChange={setSpread} suffix=" pips" tone="rose" />
            <Slider label="starting balance" value={balance} min={2000} max={50000} step={500} onChange={setBalance} display={balance.toLocaleString()} tone="jade" />
            <Slider label="risk / trade" value={riskPct} min={0.0025} max={0.05} step={0.0025} onChange={setRiskPct} display={`${(riskPct * 100).toFixed(2)}%`} tone="amber" />
            <Slider label="min_confidence" value={minConf} min={0.1} max={0.95} step={0.01} onChange={setMinConf} tone="sky" />
            <Slider label="atr_multiplier (SL)" value={atrMult} min={0.5} max={4} step={0.1} onChange={setAtrMult} suffix="×" tone="rose" />
            <Slider label="tp_multiplier" value={tpMult} min={1} max={6} step={0.1} onChange={setTpMult} suffix="×" tone="jade" />
            <p className="border-t border-line-soft pt-3 font-mono text-[10px] leading-relaxed text-muted">
              deterministic: the same seed + pair + timeframe always replays the same tape. No slippage, no
              swap, no requotes — treat every number here as optimistic.
            </p>
          </div>
        </Reveal>

        <Reveal delay={60} className="min-w-0">
          <div className="flex flex-col gap-4">
            <div className="panel rounded-xl p-4">
              <div className="flex flex-wrap items-center gap-2 border-b border-line-soft pb-3">
                <span className="font-mono text-[11px] text-sand-2">
                  {pair} · {timeframe} · {bars} bars · seed {seed}
                </span>
                <Chip tone={m.totalPnl >= 0 ? "jade" : "rose"}>
                  net {usd(m.totalPnl, 0)} ({m.totalReturn >= 0 ? "+" : ""}
                  {m.totalReturn.toFixed(2)}%)
                </Chip>
                <Chip tone="sky">{m.totalTrades} trades</Chip>
                <Chip tone="amber">PF {Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : "∞"}</Chip>
              </div>
              <div className={cx("mt-3 h-[260px]")}>
                <Line data={equityData} options={options} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-4">
              <Metric label="win rate" value={`${m.winRate.toFixed(1)}%`} sub={`${m.wins}W / ${m.losses}L`} tone={m.winRate >= 50 ? "jade" : "amber"} />
              <Metric label="profit factor" value={Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : "∞"} sub="gross win ÷ gross loss" tone={m.profitFactor >= 1.3 ? "jade" : "rose"} />
              <Metric label="max drawdown" value={`${m.maxDrawdown.toFixed(2)}%`} sub="peak-to-trough equity" tone={m.maxDrawdown > 15 ? "rose" : "sand" as never} />
              <Metric label="sharpe (ann.)" value={m.sharpe.toFixed(2)} sub={`${timeframe} bars × √${"per-year"}`} tone="sky" />
              <Metric label="expectancy" value={usd(m.expectancy)} sub="per closed trade" tone={m.expectancy >= 0 ? "jade" : "rose"} />
              <Metric label="avg win" value={usd(m.avgWin)} sub={`largest ${usd(m.largestWin, 0)}`} tone="jade" />
              <Metric label="avg loss" value={usd(m.avgLoss)} sub={`largest ${usd(m.largestLoss, 0)}`} tone="rose" />
              <Metric label="avg R:R" value={m.avgRR.toFixed(2)} sub={`${m.avgBars} bars held · ${m.buyTrades}▲/${m.sellTrades}▼`} tone="amber" />
            </div>

            <div className="panel rounded-xl p-4">
              <h3 className="font-mono text-[10.5px] tracking-[0.18em] text-muted uppercase">per-trade P&amp;L · last {lastTrades.length} round trips</h3>
              <div className="mt-3 h-[170px]">
                <Bar data={tradeData} options={barOptions} />
              </div>
            </div>

            <div className="panel overflow-hidden rounded-xl">
              <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
                <span className="font-mono text-[10.5px] tracking-[0.18em] text-muted uppercase">trade log (tail)</span>
                <span className="ml-auto font-mono text-[10px] text-muted">
                  exit breakdown: {result.trades.filter((t) => t.reason === "take_profit").length} TP ·{" "}
                  {result.trades.filter((t) => t.reason === "stop_loss").length} SL ·{" "}
                  {result.trades.filter((t) => !t.reason.includes("loss") && !t.reason.includes("profit")).length} other
                </span>
              </div>
              <div className="max-h-[280px] overflow-auto">
                <table className="w-full border-collapse text-left font-mono text-[10.5px]">
                  <thead className="sticky top-0 bg-panel-2/95 text-muted backdrop-blur">
                    <tr>
                      {["#", "dir", "entry", "exit", "lots", "bars", "conf", "exit why", "pnl"].map((h) => (
                        <th key={h} className="border-b border-line px-3 py-2 font-medium tracking-[0.12em] uppercase">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.trades
                      .slice(-14)
                      .reverse()
                      .map((t) => (
                        <tr key={t.n} className="border-b border-line-soft/60 transition-colors hover:bg-panel-2/60">
                          <td className="px-3 py-1.5 text-muted">{t.n}</td>
                          <td className={cx("px-3 py-1.5", t.dir === "BUY" ? "text-jade" : "text-rose")}>
                            {t.dir === "BUY" ? "▲" : "▼"} {t.dir}
                          </td>
                          <td className="tabnum px-3 py-1.5 text-sand-2">{t.entry.toFixed(pair.includes("JPY") ? 3 : 5)}</td>
                          <td className="tabnum px-3 py-1.5 text-sand-2">{t.exit.toFixed(pair.includes("JPY") ? 3 : 5)}</td>
                          <td className="tabnum px-3 py-1.5 text-muted">{t.lots.toFixed(2)}</td>
                          <td className="tabnum px-3 py-1.5 text-muted">{t.bars}</td>
                          <td className="tabnum px-3 py-1.5 text-muted">{t.confidence.toFixed(2)}</td>
                          <td className="px-3 py-1.5 text-sky/80">{t.reason.replace("_", " ")}</td>
                          <td className={cx("tabnum px-3 py-1.5 font-medium", t.pnl > 0 ? "text-jade" : "text-rose")}>{usd(t.pnl)}</td>
                        </tr>
                      ))}
                    {!result.trades.length && (
                      <tr>
                        <td colSpan={9} className="px-3 py-6 text-center text-muted">
                          No trade met the confidence floor in this window — try lowering min_confidence or widening the bars.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
