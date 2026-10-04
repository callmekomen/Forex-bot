import { useEffect, useState } from "react";
import {
  BatteryLow,
  CirclePlay,
  Cpu,
  Eye,
  Phone,
  ShieldAlert,
  Signal,
  WifiOff,
  X,
} from "lucide-react";
import { Chip, Reveal, SectionHeading, cx, usd } from "./ui";
import { deskRun, deskStatus, useDeskVersion } from "../lib/deskBus";

const CMD = [
  { label: "start", cmd: "/start", tone: "jade" },
  { label: "stop", cmd: "/stop", tone: "amber" },
  { label: "halt", cmd: "/halt", tone: "rose" },
  { label: "flatten", cmd: "/close all", tone: "rose" },
] as const;

export function PhoneOps() {
  useDeskVersion();
  const status = deskStatus();
  const [screen, setScreen] = useState<"status" | "book">("status");
  const [reply, setReply] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);
  const [clock, setClock] = useState(() => new Date().toTimeString().slice(0, 5));
  const [pressed, setPressed] = useState<string | null>(null);

  useEffect(() => {
    const t = window.setInterval(() => setClock(new Date().toTimeString().slice(0, 5)), 15_000);
    return () => window.clearInterval(t);
  }, []);

  const fire = (cmd: string) => {
    setPressed(cmd);
    const out = deskRun(cmd);
    setReply({ text: out, tone: /stop|halt|refus|🚫|⛔/i.test(out) ? "warn" : "ok" });
    window.setTimeout(() => setPressed(null), 220);
  };

  const dd = status?.drawdown ?? 0;
  const open = status?.open ?? [];

  return (
    <section id="phone" className="mx-auto max-w-[1400px] px-4 py-20 md:px-7">
      <Reveal>
        <SectionHeading
          index="09"
          kicker="pocket ops · eyes and hand, not the engine"
          tone="jade"
          title={
            <>
              Yes — the <span className="text-jade">control</span> works on a phone.
              <br />
              <span className="text-muted">The loop has no business running on one.</span>
            </>
          }
          blurb={
            <>
              Everything below is wired to the live desk in section 00, so these are real commands, not a picture of
              commands. In production the exact same verbs arrive from the Telegram app on your phone — no build step,
              no app-store binary, no always-on foreground process that a phone is determined to kill.
            </>
          }
          right={<Chip tone="jade"><Phone size={12} /> {status?.running ? "device linked · loop live" : "device linked · loop idle"}</Chip>}
        />
      </Reveal>

      <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)] lg:gap-8">
        {/* ── the phone ─────────────────────────────────────────────── */}
        <Reveal>
          <div className="mx-auto w-[300px] max-w-full">
            <div className="relative rounded-[2.4rem] border border-line bg-gradient-to-b from-panel-2 to-ink-2 p-2.5 shadow-[0_40px_90px_-40px_rgba(0,0,0,0.95)]">
              <div className="absolute left-1/2 top-2.5 z-20 h-5 w-24 -translate-x-1/2 rounded-b-[14px] bg-ink" />
              <div className="absolute -left-[3px] top-24 h-12 w-[3px] rounded-l bg-line" />
              <div className="absolute -right-[3px] top-32 h-8 w-[3px] rounded-r bg-line" />

              <div className="relative overflow-hidden rounded-[1.9rem] border border-line-soft bg-ink">
                {/* status bar */}
                <div className="flex items-center gap-2 bg-ink-2/80 px-4 pb-1.5 pt-2.5 font-mono text-[9.5px] text-sand-2">
                  <span className="tabnum">{clock}</span>
                  <span className="ml-auto flex items-center gap-1.5 text-muted">
                    <Signal size={9} />
                    <BatteryLow size={11} className={status?.running ? "text-jade" : "text-amber"} />
                  </span>
                </div>

                {/* app header */}
                <div className="flex items-center gap-2 border-b border-line px-3 py-2">
                  <span className="grid size-6 place-items-center rounded-md border border-jade/40 bg-jade/10 text-[10px] font-bold text-jade">
                    fx
                  </span>
                  <span className="leading-none">
                    <span className="block font-mono text-[10.5px] text-sand">forex_bot · operator</span>
                    <span className="block font-mono text-[8.5px] text-muted">
                      {status?.pairs.length ?? 0} pairs · tick {status?.tick ?? 0}
                    </span>
                  </span>
                  <span
                    className={cx(
                      "ml-auto size-2 rounded-full",
                      status?.halted ? "bg-rose" : status?.running ? "animate-pulse-soft bg-jade" : "bg-muted",
                    )}
                  />
                </div>

                {/* tabs */}
                <div className="flex gap-1 border-b border-line px-3 py-1.5">
                  {(["status", "book"] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setScreen(t)}
                      className={cx(
                        "flex-1 rounded-md py-1 font-mono text-[9.5px] uppercase transition-colors",
                        screen === t ? "bg-panel-2 text-sand" : "text-muted",
                      )}
                    >
                      {t === "status" ? "status" : `book ${open.length}`}
                    </button>
                  ))}
                </div>

                <div className="min-h-[248px] p-3">
                  {screen === "status" ? (
                    <div className="space-y-2.5">
                      <div className="rounded-lg border border-line-soft bg-panel/70 p-3">
                        <div className="font-mono text-[8.5px] tracking-[0.16em] text-muted uppercase">equity</div>
                        <div className="tabnum font-display text-[28px] leading-none font-bold text-sand">
                          {usd(status?.balance ?? 10000)}
                        </div>
                        <div className="tabnum mt-1.5 flex items-center gap-2 font-mono text-[9.5px]">
                          <span className={cx((status?.dailyPnl ?? 0) >= 0 ? "text-jade" : "text-rose")}>
                            day {(status?.dailyPnl ?? 0) >= 0 ? "+" : ""}
                            {usd(status?.dailyPnl ?? 0)}
                          </span>
                          <span className="text-muted">peak {usd(status?.peak ?? 10000, 0)}</span>
                        </div>
                      </div>

                      <div className="rounded-lg border border-line-soft bg-panel/70 p-3">
                        <div className="flex justify-between font-mono text-[9px] text-muted">
                          <span>drawdown</span>
                          <span className="tabnum text-sand-2">{dd.toFixed(2)} / 15 %</span>
                        </div>
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-2">
                          <div
                            className={cx("h-full rounded-full transition-[width] duration-500", dd > 10 ? "bg-rose" : dd > 5 ? "bg-amber" : "bg-jade")}
                            style={{ width: `${Math.min(100, (dd / 15) * 100)}%` }}
                          />
                        </div>
                        <div className="tabnum mt-2 flex justify-between font-mono text-[9px] text-muted">
                          <span>closed {(status?.closedCount ?? 0)} · {(status?.wins ?? 0)}W</span>
                          <span className={status?.halted ? "text-rose" : "text-jade"}>{status?.halted ? "HALTED" : "no halt"}</span>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        {CMD.map((c) => (
                          <button
                            key={c.cmd}
                            onClick={() => fire(c.cmd)}
                            className={cx(
                              "rounded-lg border py-2.5 font-mono text-[10px] uppercase transition-all active:scale-[0.97]",
                              pressed === c.cmd && "scale-[0.97]",
                              c.tone === "jade"
                                ? "border-jade/45 bg-jade/12 text-jade hover:bg-jade/20"
                                : c.tone === "amber"
                                  ? "border-amber/45 bg-amber/12 text-amber hover:bg-amber/20"
                                  : "border-rose/45 bg-rose/12 text-rose hover:bg-rose/20",
                            )}
                          >
                            {c.tone === "jade" ? <CirclePlay size={11} className="mx-auto mb-1" /> : c.tone === "amber" ? <WifiOff size={11} className="mx-auto mb-1" /> : <ShieldAlert size={11} className="mx-auto mb-1" />}
                            {c.label}
                          </button>
                        ))}
                      </div>

                      {reply && (
                        <div className={cx("rounded-lg border p-2.5 font-mono text-[9px] leading-relaxed whitespace-pre-wrap", reply.tone === "warn" ? "border-amber/40 bg-amber/[0.07] text-amber" : "border-jade/35 bg-jade/[0.06] text-jade")}>
                          <div className="mb-1 flex items-center gap-1.5 text-[8px] tracking-[0.14em] text-muted uppercase">
                            <X size={8} className="hidden" /> bot replied
                          </div>
                          {reply.text}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {!open.length && <div className="py-10 text-center font-mono text-[10px] text-muted">No open exposure.</div>}
                      {open.map((p) => (
                        <div key={p.ticket} className="rounded-lg border border-line-soft bg-panel/70 p-2.5">
                          <div className="flex items-center gap-2 font-mono text-[9.5px]">
                            <span className={p.dir === "BUY" ? "text-jade" : "text-rose"}>{p.dir === "BUY" ? "▲" : "▼"} {p.pair}</span>
                            <span className="tabnum ml-auto text-muted">{p.lots.toFixed(2)} lots</span>
                          </div>
                          <div className="tabnum mt-1.5 flex justify-between font-mono text-[9px] text-muted">
                            <span>@ {p.entry.toFixed(5)}</span>
                            <span className="text-rose/80">SL {p.sl.toFixed(5)}</span>
                            <span className="text-jade/80">TP {p.tp.toFixed(5)}</span>
                          </div>
                          <button
                            onClick={() => fire(`/close ${p.ticket}`)}
                            className="mt-2 w-full rounded-md border border-rose/40 py-1.5 font-mono text-[9px] uppercase text-rose transition-colors active:scale-[0.98] hover:bg-rose/15"
                          >
                            close #{p.ticket}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="border-t border-line bg-ink-2/70 px-3 py-2 text-center font-mono text-[8.5px] text-muted">
                  polling · no inbound port · nothing signed in on this device
                </div>
              </div>
            </div>
            <p className="mt-3 text-center font-mono text-[10px] leading-relaxed text-muted">
              those four buttons are <span className="text-sand-2">/start /stop /halt /close all</span> — the same verbs Telegram sends
            </p>
          </div>
        </Reveal>

        {/* ── the honest split ──────────────────────────────────────── */}
        <Reveal delay={70}>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="panel rounded-xl p-4">
              <div className="flex items-center gap-2">
                <Eye size={14} className="text-jade" />
                <h3 className="font-display text-[16px] font-semibold text-jade">On the phone: yes, all of it</h3>
              </div>
              <ul className="mt-2.5 space-y-2 font-mono text-[11px] leading-relaxed text-sand-2/85">
                <li><span className="text-jade">✓</span> start / stop the loop — <span className="text-sand">/start</span> is literally the deployment trigger</li>
                <li><span className="text-jade">✓</span> <span className="text-sand">/status</span>: equity, day P&amp;L, drawdown, halt flag, account fingerprint</li>
                <li><span className="text-jade">✓</span> the open book, and <span className="text-sand">/close &lt;ticket&gt;</span> to flatten one or all</li>
                <li><span className="text-jade">✓</span> <span className="text-sand">/halt</span> — freeze new entries in one tap, still managed, still persisted</li>
                <li><span className="text-jade">✓</span> push back: every fill and close arrives unprompted in the chat</li>
                <li><span className="text-jade">✓</span> this page too, in a browser or Add-to-Home-Screen — it is static and holds no key</li>
              </ul>
            </div>

            <div className="panel rounded-xl p-4">
              <div className="flex items-center gap-2">
                <Cpu size={14} className="text-rose" />
                <h3 className="font-display text-[16px] font-semibold text-rose">On the phone: never the loop</h3>
              </div>
              <ul className="mt-2.5 space-y-2 font-mono text-[11px] leading-relaxed text-sand-2/85">
                <li><span className="text-rose">✗</span> <span className="text-sand">MetaTrader5</span> is a Windows library — there is no iOS/Android binding to trade through</li>
                <li><span className="text-rose">✗</span> a backgrounded phone process is frozen by iOS, and Doze throttles it on Android: your tick loop just stops mid-sentence</li>
                <li><span className="text-rose">✗</span> sockets drop on network switch/lock; a reconnect is fine, a reconnect <em>while sizing an order</em> is not</li>
                <li><span className="text-rose">✗</span> battery optimisation kills the watchdog too — so nobody restarts it</li>
                <li><span className="text-rose">✗</span> Termux will run pandas, but never MT5 — paper toys only, which is exactly what section 00 is for</li>
              </ul>
            </div>

            <div className="panel rounded-xl p-4 md:col-span-2">
              <div className="flex flex-wrap items-center gap-2">
                <WifiOff size={14} className="text-amber" />
                <h3 className="font-display text-[16px] font-semibold text-sand">And if the phone dies mid-trade?</h3>
                <Chip tone="amber">nothing depends on it</Chip>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                {[
                  ["0 % battery", "Your phone is just a remote. The VPS keeps ticking, the watchdog keeps supervising, the trade stays open with its stop."],
                  ["No signal", "Same. Commands queue as unread messages; nothing is lost, nothing is auto-executed on reconnect — no stale /start surprise."],
                  ["Phone stolen", "Worst case a stranger can /halt or /stop — annoying, and safe by design. /start needs the pairing code printed on the server."],
                ].map(([title, body]) => (
                  <div key={title} className="rounded-lg border border-line-soft bg-ink-2/60 p-3">
                    <div className="font-mono text-[11px] text-amber">{title}</div>
                    <p className="mt-1 text-[12.5px] leading-relaxed text-sand-2/80">{body}</p>
                  </div>
                ))}
              </div>
              <p className="mt-3 border-t border-line-soft pt-2.5 font-mono text-[10.5px] leading-relaxed text-muted">
                The protection that does not need a phone is the one that matters: <span className="text-sand-2">broker-side SL/TP on every fill</span>, plus
                the halted flag inside bot_state.json. Add a heartbeat rule (stale data &gt; N minutes while exposed → flatten) and the phone becomes optional,
                which is how it should stay.
              </p>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
