/**
 * LiveControl.tsx — the dashboard section that actually drives the bot.
 *
 * Everything else on this page is a simulation. This one talks to the real
 * Python process over /api, so what you see here is the bot's true state:
 * its risk book, its open tickets, its log stream.
 *
 * When the control plane is not running the section degrades gracefully to
 * an "offline" card with the command needed to start it — the rest of the
 * page is unaffected.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  botApi,
  subscribeToBot,
  type AnalyzeResult,
  type BotStatus,
  type LogLine,
  type PositionRow,
} from "../lib/botApi";
import { Chip, Metric, Reveal, SectionHeading, SignalBadge, cx, price, usd } from "./ui";

/* ── small atoms ───────────────────────────────────────────────────── */

function Button({
  children,
  onClick,
  tone = "line",
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  tone?: "line" | "jade" | "amber" | "rose" | "sky";
  disabled?: boolean;
  title?: string;
}) {
  const tones = {
    line: "border-line bg-panel/70 text-sand-2 hover:border-sand-2/50 hover:text-sand",
    jade: "border-jade/45 bg-jade/12 text-jade hover:bg-jade/20",
    amber: "border-amber/45 bg-amber/12 text-amber hover:bg-amber/20",
    rose: "border-rose/45 bg-rose/12 text-rose hover:bg-rose/20",
    sky: "border-sky/45 bg-sky/12 text-sky hover:bg-sky/20",
  }[tone];
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "rounded-md border px-3.5 py-2 font-mono text-[11px] tracking-[0.14em] uppercase transition-all duration-150",
        tones,
        disabled && "cursor-not-allowed opacity-35 hover:border-line hover:text-sand-2",
      )}
    >
      {children}
    </button>
  );
}

const levelTone: Record<string, string> = {
  CRITICAL: "text-rose",
  ERROR: "text-rose",
  WARNING: "text-amber",
  INFO: "text-sand-2",
  DEBUG: "text-muted",
};

/* ── main section ──────────────────────────────────────────────────── */

export function LiveControl() {
  const [online, setOnline] = useState<boolean | null>(null);
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [analysis, setAnalysis] = useState<AnalyzeResult | null>(null);
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState("");
  const logRef = useRef<HTMLDivElement | null>(null);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(""), 4200);
  }, []);

  /* health probe + live stream ------------------------------------- */
  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;

    botApi
      .health()
      .then(() => {
        if (cancelled) return;
        setOnline(true);
        stop = subscribeToBot(
          (snap) => {
            setStatus(snap.status);
            setPositions(snap.positions);
            if (snap.logs.length) {
              setLogs((prev) => [...prev, ...snap.logs].slice(-250));
            }
          },
          () => setOnline(false),
        );
      })
      .catch(() => !cancelled && setOnline(false));

    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  /* keep the log pane pinned to the newest line --------------------- */
  useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [logs]);

  const act = useCallback(
    async (name: string, fn: () => Promise<{ ok: boolean; message?: string }>) => {
      setBusy(name);
      try {
        const res = await fn();
        flash(res.message ?? (res.ok ? `${name} ok` : `${name} refused`));
        const fresh = await botApi.status();
        setStatus(fresh);
      } catch (err) {
        flash(err instanceof Error ? err.message : String(err));
        setOnline(false);
      } finally {
        setBusy("");
      }
    },
    [flash],
  );

  const runAnalysis = useCallback(async () => {
    setBusy("analyze");
    try {
      setAnalysis(await botApi.analyze());
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
    }
  }, [flash]);

  /* ── offline state ----------------------------------------------- */
  if (online === false) {
    return (
      <section id="control" className="mx-auto max-w-[1400px] px-6 py-24">
        <Reveal>
          <SectionHeading
            index="02"
            kicker="live control"
            tone="rose"
            title="Control plane offline"
            blurb="This section drives the real Python bot. Start the control plane and it will connect automatically."
          />
          <div className="rounded-xl border border-line bg-panel/60 p-6">
            <div className="font-mono text-[11px] tracking-[0.18em] text-muted uppercase">start it</div>
            <pre className="mt-3 overflow-x-auto rounded-lg border border-line-soft bg-ink-2/80 p-4 font-mono text-[12.5px] leading-relaxed text-jade">
{`cd forex_bot
python api_server.py          # paper mode, 127.0.0.1:8787`}
            </pre>
            <p className="mt-4 text-[14px] leading-relaxed text-sand-2/85">
              The dashboard calls <code className="font-mono text-sky">/api/*</code>, which Vite proxies to
              port 8787. Nothing else on this page depends on it — the labs below stay fully interactive.
            </p>
            <div className="mt-5">
              <Button tone="sky" onClick={() => window.location.reload()}>retry connection</Button>
            </div>
          </div>
        </Reveal>
      </section>
    );
  }

  const risk = status?.risk ?? {};
  const halted = Boolean(risk.halted);
  const running = Boolean(status?.running);
  const paused = Boolean(status?.paused);
  const isPaper = status?.account?.paper !== false;

  return (
    <section id="control" className="mx-auto max-w-[1400px] px-6 py-24">
      <Reveal>
        <SectionHeading
          index="02"
          kicker="live control"
          tone="jade"
          title={<>Drive the actual bot</>}
          blurb="Every button here hits the Python process through the same risk gates Telegram uses. The browser cannot bypass a halt, exceed the per-trade cap, or place an order the risk manager refused."
          right={
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone={running ? "jade" : "line"}>{running ? (paused ? "paused" : "running") : "stopped"}</Chip>
              <Chip tone={isPaper ? "sky" : "rose"}>{isPaper ? "paper" : "live"}</Chip>
              {halted && <Chip tone="rose">halted</Chip>}
            </div>
          }
        />

        {/* ── controls ───────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-2.5">
          <Button tone="jade" disabled={running || !!busy} onClick={() => act("start", () => botApi.start("paper"))}>
            ▶ start paper
          </Button>
          <Button
            tone="rose"
            disabled={!status?.live_allowed || running || !!busy}
            title={status?.live_allowed ? "Start against the live MT5 terminal" : status?.live_lock_reason}
            onClick={() => act("start live", () => botApi.start("live"))}
          >
            ▶ start live
          </Button>
          <Button tone="line" disabled={!running || !!busy} onClick={() => act("stop", () => botApi.stop())}>
            ⏹ stop
          </Button>
          <Button
            tone="amber"
            disabled={!running || !!busy}
            onClick={() => act(paused ? "resume loop" : "pause", () => (paused ? botApi.unpause() : botApi.pause()))}
          >
            {paused ? "▸ unpause" : "⏸ pause"}
          </Button>
          <span className="mx-1 h-6 w-px bg-line" />
          <Button tone="sky" disabled={!!busy} onClick={runAnalysis}>
            ⟳ dry-run analyse
          </Button>
          <Button tone="line" disabled={running || !!busy} title={running ? "the loop ticks on its own" : "run one tick"} onClick={() => act("tick", () => botApi.tick())}>
            ⏭ single tick
          </Button>
          <span className="mx-1 h-6 w-px bg-line" />
          <Button tone="rose" disabled={halted || !!busy} onClick={() => act("halt", () => botApi.halt())}>
            ⛔ halt
          </Button>
          <Button tone="jade" disabled={!halted || !!busy} onClick={() => act("resume", () => botApi.resume())}>
            ✓ clear halt
          </Button>
          <Button tone="rose" disabled={!positions.length || !!busy} onClick={() => act("close all", () => botApi.close("all"))}>
            ✕ flatten all
          </Button>
        </div>

        {toast && (
          <div className="mt-4 rounded-lg border border-sky/35 bg-sky/8 px-4 py-2.5 font-mono text-[12px] text-sky">
            {toast}
          </div>
        )}
        {halted && (
          <div className="mt-4 rounded-lg border border-rose/40 bg-rose/10 px-4 py-2.5 font-mono text-[12px] text-rose">
            HALT LATCHED — {risk.halt_reason || "limit breached"}. No new entries until cleared.
          </div>
        )}
        {!status?.live_allowed && (
          <p className="mt-4 font-mono text-[11px] text-muted">
            live mode locked: {status?.live_lock_reason ?? "unknown"} · restart with{" "}
            <code className="text-amber">--allow-live</code> and{" "}
            <code className="text-amber">FXBOT_API_ALLOW_LIVE=1</code>
          </p>
        )}

        {/* ── metrics ────────────────────────────────────────────── */}
        <div className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <Metric label="balance" value={usd(Number(risk.balance ?? 0))} tone="sand" />
          <Metric
            label="day p&l"
            value={usd(Number(risk.daily_pnl ?? 0))}
            tone={Number(risk.daily_pnl ?? 0) >= 0 ? "jade" : "rose"}
          />
          <Metric
            label="drawdown"
            value={`${Number(risk.drawdown_pct ?? 0).toFixed(2)}%`}
            tone={Number(risk.drawdown_pct ?? 0) > 10 ? "rose" : "sand"}
          />
          <Metric label="open" value={String(risk.open_positions ?? 0)} sub={`${risk.closed_trades ?? 0} closed`} />
          <Metric label="win rate" value={`${Number(risk.win_rate_pct ?? 0).toFixed(1)}%`} tone="sky" />
          <Metric label="ticks" value={String(status?.ticks ?? 0)} sub={`${status?.rejected ?? 0} rejected`} />
        </div>

        <div className="mt-2 font-mono text-[11px] text-muted">
          {status?.status_line || "idle"} · mode {status?.mode ?? "idle"}
        </div>

        {/* ── positions + logs ───────────────────────────────────── */}
        <div className="mt-8 grid gap-5 lg:grid-cols-2">
          <div className="rounded-xl border border-line bg-panel/55 p-5">
            <div className="mb-3 font-mono text-[10.5px] tracking-[0.2em] text-muted uppercase">
              open positions ({positions.length})
            </div>
            {positions.length === 0 ? (
              <div className="py-9 text-center font-mono text-[12px] text-muted">no open exposure</div>
            ) : (
              <div className="space-y-2.5">
                {positions.map((p) => (
                  <div
                    key={p.ticket}
                    className="flex items-center justify-between gap-3 rounded-lg border border-line-soft bg-ink-2/70 px-3.5 py-2.5"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <SignalBadge signal={p.direction} size="sm" />
                        <span className="font-mono text-[13px] text-sand">{p.pair}</span>
                        <span className="tabnum font-mono text-[11px] text-muted">{p.lots.toFixed(2)} lots</span>
                      </div>
                      <div className="tabnum mt-1 font-mono text-[10.5px] text-muted">
                        @ {price(p.open_price, p.pair)} · SL {price(p.stop_loss, p.pair)} · TP{" "}
                        {price(p.take_profit, p.pair)} · #{p.ticket}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span
                        className={cx(
                          "tabnum font-mono text-[13px]",
                          (p.unrealised_pnl ?? 0) >= 0 ? "text-jade" : "text-rose",
                        )}
                      >
                        {p.unrealised_pnl == null ? "—" : usd(p.unrealised_pnl)}
                      </span>
                      <Button tone="rose" disabled={!!busy} onClick={() => act(`close ${p.ticket}`, () => botApi.close(p.ticket))}>
                        close
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-line bg-panel/55 p-5">
            <div className="mb-3 font-mono text-[10.5px] tracking-[0.2em] text-muted uppercase">live log</div>
            <div ref={logRef} className="h-[300px] overflow-y-auto rounded-lg border border-line-soft bg-ink-2/80 p-3.5">
              {logs.length === 0 ? (
                <div className="py-9 text-center font-mono text-[12px] text-muted">waiting for output…</div>
              ) : (
                logs.map((line) => (
                  <div key={line.id} className="font-mono text-[11px] leading-relaxed">
                    <span className="text-muted">{line.time.slice(11, 19)}</span>{" "}
                    <span className={levelTone[line.level] ?? "text-sand-2"}>{line.message}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* ── dry run ────────────────────────────────────────────── */}
        {analysis && (
          <div className="mt-5 rounded-xl border border-line bg-panel/55 p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="font-mono text-[10.5px] tracking-[0.2em] text-muted uppercase">
                dry run — nothing was executed
              </span>
              <Chip tone={analysis.gate_open ? "jade" : "amber"}>
                {analysis.gate_open ? "gate open" : analysis.gate_reason}
              </Chip>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              {analysis.results.map((r) => (
                <div key={r.pair} className="rounded-lg border border-line-soft bg-ink-2/70 p-3.5">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[13px] text-sand">{r.pair}</span>
                    {r.signal && <SignalBadge signal={r.signal} size="sm" />}
                  </div>
                  {r.error ? (
                    <div className="mt-2 font-mono text-[11px] text-rose">{r.error}</div>
                  ) : (
                    <>
                      <div className="tabnum mt-2 font-mono text-[10.5px] text-muted">
                        conf {((r.confidence ?? 0) * 100).toFixed(0)}% · score {(r.score ?? 0).toFixed(2)} · RR{" "}
                        {(r.risk_reward ?? 0).toFixed(2)}
                      </div>
                      <div
                        className={cx(
                          "mt-2 font-mono text-[11px] leading-snug",
                          r.would_trade ? "text-jade" : "text-amber",
                        )}
                      >
                        {r.would_trade ? `WOULD TRADE ${r.lots} lots` : "no trade"} — {r.verdict}
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </Reveal>
    </section>
  );
}
