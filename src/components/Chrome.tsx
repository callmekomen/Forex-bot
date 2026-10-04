import { useEffect, useMemo, useState } from "react";
import { Activity, Radio, ShieldCheck } from "lucide-react";
import { cx, price as fmtPrice } from "./ui";
import { generateCandles, PAIRS, pipSizeOf, type Pair } from "../lib/sim";

export const NAV = [
  { id: "desk", label: "Live desk" },
  { id: "telegram", label: "Telegram" },
  { id: "architecture", label: "Architecture" },
  { id: "strategy", label: "Strategy engine" },
  { id: "risk", label: "Risk gate" },
  { id: "backtest", label: "Backtest" },
  { id: "source", label: "Source files" },
  { id: "setup", label: "Setup" },
  { id: "deploy", label: "Deploy" },
  { id: "phone", label: "Phone" },
];

function utcNow() {
  return new Date().toISOString().slice(11, 19);
}

/** Sticky command bar: identity, section nav, UTC clock, mode pill. */
export function TopBar() {
  const [clock, setClock] = useState(utcNow);
  const [active, setActive] = useState<string>("");
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const t = window.setInterval(() => setClock(utcNow()), 1000);
    const onScroll = () => {
      const h = document.documentElement;
      setProgress((h.scrollTop / Math.max(1, h.scrollHeight - h.clientHeight)) * 100);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.clearInterval(t);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible) setActive(visible.target.id);
      },
      { rootMargin: "-45% 0px -45% 0px", threshold: [0, 0.2, 0.6] },
    );
    NAV.forEach((n) => {
      const el = document.getElementById(n.id);
      if (el) io.observe(el);
    });
    return () => io.disconnect();
  }, []);

  return (
    <header className="sticky top-0 z-50 border-b border-line/80 bg-ink/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-5 px-4 md:px-7">
        <a href="#top" className="group flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-md border border-jade/40 bg-jade/10 text-jade transition-colors group-hover:bg-jade/20">
            <Activity size={15} strokeWidth={2.4} />
          </span>
          <span className="leading-none">
            <span className="block font-display text-[15px] font-bold tracking-tight text-sand">
              forex_bot
            </span>
            <span className="block font-mono text-[9px] tracking-[0.22em] text-muted uppercase">
              MT5 · quant desk
            </span>
          </span>
        </a>

        <nav className="ml-2 hidden flex-1 items-center gap-1 lg:flex">
          {NAV.map((n) => (
            <a
              key={n.id}
              href={`#${n.id}`}
              className={cx(
                "rounded-md px-2.5 py-1.5 font-mono text-[11px] tracking-wide uppercase transition-colors",
                active === n.id ? "bg-panel text-sand" : "text-muted hover:bg-panel/60 hover:text-sand-2",
              )}
            >
              {n.label}
            </a>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2.5">
          <span className="hidden items-center gap-1.5 rounded-full border border-amber/35 bg-amber/10 px-2.5 py-1 font-mono text-[10px] tracking-[0.14em] text-amber uppercase sm:inline-flex">
            <ShieldCheck size={12} /> risk gate armed
          </span>
          <span className="tabnum inline-flex items-center gap-1.5 rounded-full border border-line bg-panel px-2.5 py-1 font-mono text-[11px] text-sand-2">
            <Radio size={11} className="animate-pulse-soft text-jade" />
            {clock} UTC
          </span>
        </div>
      </div>
      <div className="flex gap-1.5 overflow-x-auto border-t border-line/70 bg-ink/60 px-3 py-2 lg:hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {NAV.map((n) => (
          <a
            key={n.id}
            href={`#${n.id}`}
            className={cx(
              "shrink-0 rounded-full border px-3 py-1.5 font-mono text-[11px] whitespace-nowrap transition-colors",
              active === n.id ? "border-jade/45 bg-jade/12 text-jade" : "border-line bg-panel/60 text-muted",
            )}
          >
            {n.label}
          </a>
        ))}
      </div>
      <div className="h-[2px] w-full bg-line-soft">
        <div
          className="h-full bg-gradient-to-r from-jade via-sky to-amber transition-[width] duration-150"
          style={{ width: `${progress}%` }}
        />
      </div>
    </header>
  );
}

interface Quote {
  pair: Pair;
  bid: number;
  ask: number;
  change: number;
  dir: 1 | -1;
}

/** Marquee of simulated quotes; each cell flashes on the side it moved. */
export function Ticker() {
  const [quotes, setQuotes] = useState<Quote[]>(() => buildQuotes());
  const [key, setKey] = useState(0);

  useEffect(() => {
    const t = window.setInterval(() => {
      setQuotes((prev) =>
        prev.map((q) => {
          const pip = pipSizeOf(q.pair);
          const step = (Math.random() - 0.5) * 6 * pip;
          const next = q.bid + step;
          return {
            ...q,
            bid: next,
            ask: next + (q.ask - q.bid),
            change: q.change + step / q.bid,
            dir: step >= 0 ? 1 : -1,
          };
        }),
      );
      setKey((k) => k + 1);
    }, 2600);
    return () => window.clearInterval(t);
  }, []);

  const cells = useMemo(
    () =>
      quotes.map((q) => (
        <span
          key={`${q.pair}-${key}`}
          className={cx(
            "mx-5 inline-flex items-center gap-2.5 border-r border-line/70 pr-6 font-mono text-[11.5px] whitespace-nowrap",
            q.dir > 0 ? "flash-up" : "flash-down",
          )}
        >
          <span className="text-sand-2">{q.pair}</span>
          <span className={cx("tabnum", q.dir > 0 ? "text-jade" : "text-rose")}>{fmtPrice(q.bid, q.pair)}</span>
          <span className="tabnum text-[10px] text-muted">{q.ask.toFixed(q.pair.includes("JPY") ? 3 : 5)}</span>
          <span className={cx("tabnum text-[10px]", q.change >= 0 ? "text-jade/80" : "text-rose/80")}>
            {q.change >= 0 ? "▲" : "▼"} {Math.abs(q.change * 100).toFixed(2)}%
          </span>
        </span>
      )),
    [quotes, key],
  );

  return (
    <div className="relative overflow-hidden border-y border-line/70 bg-ink-2/80 py-2">
      <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-16 bg-gradient-to-r from-ink to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-16 bg-gradient-to-l from-ink to-transparent" />
      <div className="flex w-max animate-marquee">
        <div className="flex">{cells}</div>
        <div className="flex" aria-hidden>
          {cells}
        </div>
      </div>
    </div>
  );
}

function buildQuotes(): Quote[] {
  return PAIRS.map((pair) => {
    const series = generateCandles({ seed: 99, bars: 40, pair, timeframe: "1h" });
    const last = series[series.length - 1];
    const first = series[0];
    const half = last.c * 0.00007;
    return { pair, bid: last.c, ask: last.c + half, change: (last.c - first.c) / first.c, dir: 1 as const };
  });
}
