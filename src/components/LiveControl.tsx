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
  type GambleCandidateRow,
  type GambleStatus,
  type LogLine,
  type PositionRow,
} from "../lib/botApi";
import { Chip, Metric, Reveal, SectionHeading, SignalBadge, Slider, cx, price, usd } from "./ui";

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
  const [gamble, setGamble] = useState<GambleStatus | null>(null);
  const [gambleRanking, setGambleRanking] = useState<GambleCandidateRow[]>([]);
  const [gambleRiskPct, setGambleRiskPct] = useState(0.02);
  const [gambleMinConf, setGambleMinConf] = useState(0.6);
  const [gambleMaxScans, setGambleMaxScans] = useState(60);
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

  /* gamble: poll the hunt state while the control plane is online */
  const refreshGamble = useCallback(async () => {
    try {
      const g = await botApi.gambleStatus();
      setGamble(g);
      if (g.ranking?.length) setGambleRanking(g.ranking);
    } catch {
      /* control plane went away — the health path handles the banner */
    }
  }, []);

  useEffect(() => {
    if (!online) return;
    refreshGamble();
    const t = window.setInterval(refreshGamble, 2500);
    return () => window.clearInterval(t);
  }, [online, refreshGamble]);

  const gambleBody = useCallback(
    () => ({
      risk_pct: gambleRiskPct,
      min_confidence: gambleMinConf,
      max_scans: gambleMaxScans,
      scan_interval: 5,
      protect_breakeven: true,
    }),
    [gambleRiskPct, gambleMinConf, gambleMaxScans],
  );

  const scanGamble = useCallback(async () => {
    setBusy("gamble-scan");
    try {
      const res = await botApi.gambleScan(gambleBody());
      if (res.ranking) setGambleRanking(res.ranking);
      flash(
        res.ok
          ? res.a_plus_available
            ? `A+ available: ${res.best?.pair} ${res.best?.signal_name} (edge ${res.best?.edge_score.toFixed(1)}) — press GAMBLE to take it`
            : "No A+ setup right now — the button would (correctly) refuse this market"
          : res.message ?? "gamble scan refused",
      );
      refreshGamble();
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
    }
  }, [flash, gambleBody, refreshGamble]);

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

        {/* ── 🎲 gamble mode on the real bot ──────────────────────── */}
        {(() => {
          const gPhase = gamble?.phase ?? "idle";
          const hunting = gPhase === "hunting";
          const inTrade = gPhase === "in_trade";
          const ledger = gamble?.ledger ?? status?.gamble?.ledger ?? {};
          const balance = Number(risk.balance ?? 10000);
          const lockReason = String(ledger.lock_reason ?? "");
          const best = gambleRanking[0];
          const cand = gamble?.candidate;
          const monitor = gamble?.monitor;
          return (
            <div className="mt-8 overflow-hidden rounded-xl border border-amber/35 bg-panel/55">
              <div className="flex flex-wrap items-center gap-2.5 border-b border-line px-5 py-3">
                <span className="font-mono text-[11px] font-bold tracking-[0.22em] text-amber uppercase">🎲 gamble — real bot</span>
                <span className="font-mono text-[10.5px] text-muted">hunts ONE A+ setup · paper unless a live bot is already running</span>
                <span className="ml-auto flex flex-wrap gap-1.5">
                  <Chip tone={hunting ? "amber" : inTrade || gPhase === "won" ? "jade" : gPhase === "lost" || gPhase === "refused" ? "rose" : "line"}>
                    {hunting ? `hunting ${gamble?.scans ?? 0}/${gamble?.max_scans ?? 0}` : gPhase}
                  </Chip>
                  <Chip tone="line">today {ledger.taken ?? 0}/{ledger.max_per_day ?? 3}</Chip>
                  <Chip tone={Number(ledger.net_pnl ?? 0) >= 0 ? "jade" : "rose"}>net {usd(Number(ledger.net_pnl ?? 0))}</Chip>
                </span>
              </div>
              <div className="grid gap-5 p-5 lg:grid-cols-[290px_minmax(0,1fr)]">
                <div className="space-y-4">
                  {hunting ? (
                    <button
                      onClick={() => act("stop hunt", () => botApi.gambleStop())}
                      className="w-full rounded-xl border border-amber/60 bg-amber/15 px-5 py-4 font-mono text-[14px] font-black tracking-[0.16em] text-amber uppercase transition-all hover:bg-amber/25"
                    >
                      ◉ hunting… stop
                    </button>
                  ) : (
                    <button
                      onClick={() => act("gamble", () => botApi.gamble(gambleBody()))}
                      disabled={!!busy || inTrade}
                      title={inTrade ? "a gamble trade is already open" : lockReason || "Hunt one A+ setup on the Python bot (paper unless live is already running)"}
                      className={cx(
                        "w-full rounded-xl border px-5 py-4 font-mono text-[16px] font-black tracking-[0.2em] uppercase transition-all",
                        inTrade
                          ? "cursor-not-allowed border-jade/40 bg-jade/10 text-jade"
                          : "border-amber bg-amber text-ink hover:shadow-[0_0_42px_-8px_rgba(247,178,59,0.9)]",
                        !!busy && "opacity-40",
                      )}
                    >
                      {inTrade ? `🎯 live · #${cand?.ticket ?? ledger.open_ticket ?? "?"}` : "🎲 gamble"}
                    </button>
                  )}
                  <div className="tabnum text-center font-mono text-[11px] text-muted">
                    max loss <span className="text-rose">{usd(balance * gambleRiskPct)}</span> → target{" "}
                    <span className="text-jade">+{usd(balance * gambleRiskPct * 2)}</span> @ RR 2.00
                  </div>
                  <Button tone="sky" disabled={!!busy} onClick={scanGamble}>
                    ◎ preview ranking (no trade)
                  </Button>
                  <div className="space-y-3.5 border-t border-line-soft pt-3">
                    <Slider label="stake" value={gambleRiskPct} min={0.005} max={0.05} step={0.0025} onChange={setGambleRiskPct} display={`${(gambleRiskPct * 100).toFixed(2)}%`} tone="amber" />
                    <Slider label="A+ min confidence" value={gambleMinConf} min={0.6} max={0.85} step={0.01} onChange={setGambleMinConf} tone="sky" />
                    <Slider label="hunt budget (scans)" value={gambleMaxScans} min={1} max={240} step={1} onChange={setGambleMaxScans} tone="rose" />
                  </div>
                  {(gamble?.reason || lockReason) && (
                    <p className="font-mono text-[10.5px] leading-relaxed text-sand-2/85">
                      {lockReason ? `🔒 ${lockReason}` : gamble?.reason}
                    </p>
                  )}
                  {inTrade && monitor && (
                    <p className="tabnum font-mono text-[11px] leading-relaxed">
                      <span className={monitor.r_multiple >= 0 ? "text-jade" : "text-rose"}>
                        {monitor.r_multiple >= 0 ? "+" : ""}{monitor.r_multiple.toFixed(2)}R · {usd(monitor.unrealised_pnl)}
                      </span>
                      <span className="text-muted"> @ {monitor.price.toFixed(5)}{monitor.protected ? " · 🛡 breakeven" : ""}</span>
                    </p>
                  )}
                  {inTrade && cand && (
                    <p className="tabnum font-mono text-[10.5px] leading-relaxed text-muted">
                      {cand.direction} {cand.pair} {cand.lots} lots · risk {usd(Number(cand.risk_usd ?? 0))} → +{usd(Number(cand.target_usd ?? 0))}
                    </p>
                  )}
                </div>
                <div className="min-w-0">
                  <div className="mb-2 font-mono text-[10px] tracking-[0.18em] text-muted uppercase">edge ranking — python strategy, live</div>
                  {gambleRanking.length === 0 ? (
                    <div className="py-8 text-center font-mono text-[11.5px] text-muted">
                      no ranking yet — hit <span className="text-sky">preview ranking</span> or press 🎲 GAMBLE
                      {best ? "" : <span className="mt-1 block text-[10px]">on the mock/paper feed most markets grade B or skip — the button refusing is it working</span>}
                    </div>
                  ) : (
                    <div className="divide-y divide-line-soft rounded-lg border border-line-soft bg-ink-2/60">
                      {gambleRanking.map((c) => (
                        <div key={c.pair} className={cx("px-3.5 py-2.5", c.is_a_plus && "bg-jade/[0.06]")} title={c.failed.length ? `refused: ${c.failed.join("; ")}` : c.passed.join("; ")}>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="w-16 font-mono text-[12px] text-sand">{c.pair}</span>
                            <SignalBadge signal={c.signal_name} size="sm" />
                            <span className={cx("rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold", c.grade === "A+" ? "border-jade/50 bg-jade/15 text-jade" : "border-line text-sand-2")}>{c.grade}</span>
                            <span className="tabnum ml-auto font-mono text-[10.5px] text-muted">
                              conf {c.confidence.toFixed(2)} · ADX {c.adx == null ? "–" : c.adx.toFixed(0)} · RR {c.risk_reward.toFixed(2)}
                            </span>
                            <span className={cx("tabnum w-12 text-right font-mono text-[12px] font-bold", c.is_a_plus ? "text-jade" : "text-sand-2")}>{c.edge_score.toFixed(1)}</span>
                          </div>
                          <div className="mt-1 truncate font-mono text-[9.5px] text-muted">
                            {c.is_a_plus ? <span className="text-jade">★ A+ — bettable at your stake</span> : <span className="text-rose/75">✗ {c.failed.join(" · ")}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="mt-3 font-mono text-[10px] leading-relaxed text-muted">
                    Server-enforced: stake ≤5% and ≤ today's remaining loss budget · {ledger.max_per_day ?? 3} gambles/day ·
                    locks after {ledger.max_losses_per_day ?? 2} losses + 30 min cooldown · breakeven at +1R ·{" "}
                    <span className="text-rose">no profit guarantee — A+ confluence only</span>. Same engine:{" "}
                    <code className="text-sky">python gamble.py --mock</code>
                  </p>
                </div>
              </div>
            </div>
          );
        })()}

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
