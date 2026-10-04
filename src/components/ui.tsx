import { useEffect, useRef, useState, type ReactNode } from "react";

/* ── tiny helpers ──────────────────────────────────────────────────── */
export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

export const usd = (v: number, digits = 2) =>
  `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

export const pct = (v: number, digits = 2) => `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;

export const price = (v: number, pair: string) => v.toFixed(pair.includes("JPY") ? 3 : 5);

/* ── scroll reveal ─────────────────────────────────────────────────── */
export function Reveal({
  children,
  delay = 0,
  as: Tag = "div",
  className,
}: {
  children: ReactNode;
  delay?: number;
  as?: "div" | "section" | "li" | "article";
  className?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            setSeen(true);
            io.unobserve(e.target);
          }
        });
      },
      { rootMargin: "-60px 0px -40px 0px", threshold: 0.05 },
    );
    io.observe(node);
    return () => io.disconnect();
  }, []);
  const Comp = Tag as "div";
  return (
    <Comp
      ref={ref as never}
      className={cx("reveal", seen && "is-in", className)}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </Comp>
  );
}

/* ── section heading ───────────────────────────────────────────────── */
export function SectionHeading({
  index,
  kicker,
  title,
  blurb,
  right,
  tone = "jade",
}: {
  index: string;
  kicker: string;
  title: ReactNode;
  blurb?: ReactNode;
  right?: ReactNode;
  tone?: "jade" | "amber" | "rose" | "sky" | "lilac";
}) {
  const toneCls = {
    jade: "text-jade",
    amber: "text-amber",
    rose: "text-rose",
    sky: "text-sky",
    lilac: "text-lilac",
  }[tone];
  return (
    <div className="mb-10 flex flex-col gap-6 border-b border-line pb-7 md:flex-row md:items-end md:justify-between">
      <div className="max-w-3xl">
        <div className="flex items-center gap-3">
          <span className={cx("font-mono text-[11px] tracking-[0.3em] uppercase", toneCls)}>{index}</span>
          <span className="h-px w-10 bg-line" />
          <span className="font-mono text-[11px] tracking-[0.22em] text-muted uppercase">{kicker}</span>
        </div>
        <h2 className="mt-4 text-3xl leading-[1.08] font-bold text-sand md:text-[42px]">{title}</h2>
        {blurb && <p className="mt-4 text-[15px] leading-relaxed text-sand-2/85">{blurb}</p>}
      </div>
      {right && <div className="shrink-0">{right}</div>}
    </div>
  );
}

/* ── atoms ─────────────────────────────────────────────────────────── */
export function Chip({ children, tone = "line" }: { children: ReactNode; tone?: "line" | "jade" | "amber" | "rose" | "sky" }) {
  const tones = {
    line: "border-line text-sand-2 bg-panel/60",
    jade: "border-jade/40 text-jade bg-jade/10",
    amber: "border-amber/40 text-amber bg-amber/10",
    rose: "border-rose/40 text-rose bg-rose/10",
    sky: "border-sky/40 text-sky bg-sky/10",
  }[tone];
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10.5px] tracking-wider uppercase", tones)}>
      {children}
    </span>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[10px] tracking-[0.2em] text-muted uppercase">{children}</span>;
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  suffix = "",
  display,
  tone = "amber",
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  suffix?: string;
  display?: string;
  tone?: "amber" | "jade" | "sky" | "rose";
}) {
  const pctFill = ((value - min) / (max - min)) * 100;
  const tint = { amber: "#f7b23b", jade: "#2fd39a", sky: "#6fb3f2", rose: "#ff6b6f" }[tone];
  return (
    <label className="group block select-none">
      <span className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-[10.5px] tracking-[0.16em] text-muted uppercase">{label}</span>
        <span className="tabnum font-mono text-[13px] font-medium text-sand">
          {display ?? value}
          {suffix}
        </span>
      </span>
      <span className="mt-2.5 block">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="w-full cursor-pointer"
          style={{
            background: `linear-gradient(90deg, ${tint} ${pctFill}%, #24363f ${pctFill}%)`,
          }}
        />
      </span>
    </label>
  );
}

export function Metric({
  label,
  value,
  sub,
  tone = "sand",
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "sand" | "jade" | "rose" | "amber" | "sky";
}) {
  const toneCls = {
    sand: "text-sand",
    jade: "text-jade",
    rose: "text-rose",
    amber: "text-amber",
    sky: "text-sky",
  }[tone];
  return (
    <div className="rounded-lg border border-line-soft bg-ink-2/70 p-3 transition-colors duration-200 hover:border-line hover:bg-panel-2/70">
      <div className="font-mono text-[9.5px] tracking-[0.18em] text-muted uppercase">{label}</div>
      <div className={cx("tabnum mt-1.5 font-display text-[19px] leading-none font-semibold", toneCls)}>{value}</div>
      {sub && <div className="tabnum mt-1.5 font-mono text-[10.5px] text-muted">{sub}</div>}
    </div>
  );
}

export function SignalBadge({ signal, size = "md" }: { signal: string; size?: "sm" | "md" | "lg" }) {
  const long = signal.includes("BUY");
  const short = signal.includes("SELL");
  const tone = long
    ? "border-jade/45 bg-jade/12 text-jade"
    : short
      ? "border-rose/45 bg-rose/12 text-rose"
      : "border-line bg-panel text-muted";
  const sz = size === "lg" ? "px-4 py-2 text-[15px]" : size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-3 py-1 text-[12px]";
  return (
    <span className={cx("inline-flex items-center rounded-md border font-mono font-bold tracking-[0.16em] uppercase", tone, sz)}>
      {long && <span className="mr-1.5">▲</span>}
      {short && <span className="mr-1.5">▼</span>}
      {signal.replace("_", " ")}
    </span>
  );
}
