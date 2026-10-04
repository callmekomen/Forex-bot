import { useEffect, useRef, useState } from "react";
import {
  Bot,
  KeyRound,
  RefreshCcw,
  Send,
  ShieldCheck,
  Smartphone,
  TerminalSquare,
  UserX,
} from "lucide-react";
import { Chip, Reveal, SectionHeading, cx, usd } from "./ui";
import { deskRun, deskStatus, useDeskVersion } from "../lib/deskBus";

interface Msg {
  id: number;
  from: "me" | "bot";
  text: string;
  kind?: "ok" | "warn" | "err";
}

const MY_CHAT = 734112288;
const STRANGER = 5590114;
const PAIR_VERBS = new Set(["/id", "/pair", "/help", "/start"]);
const DESK_VERBS = new Set([
  "/start",
  "/stop",
  "/status",
  "/positions",
  "/close",
  "/halt",
  "/resume",
  "/risk",
  "/pairs",
  "/tick",
]);

export function TelegramRemote() {
  useDeskVersion();
  const status = deskStatus();
  const [code, setCode] = useState(() => String(Math.floor(100000 + Math.random() * 899999)));
  const [asStranger, setAsStranger] = useState(false);
  const [paired, setPaired] = useState(false);
  const [accountMatch, setAccountMatch] = useState(true);
  const [requireMatch, setRequireMatch] = useState(true);
  const [typing, setTyping] = useState(false);
  const [input, setInput] = useState("/status");
  const [securityLog, setSecurityLog] = useState<string[]>([]);
  const idRef = useRef(100);
  const timers = useRef<number[]>([]);
  const [msgs, setMsgs] = useState<Msg[]>([
    { id: 1, from: "bot", text: "✅ forex_bot gateway online. Allowed chats: 1. /status for a report, /stop to halt the loop." },
    { id: 2, from: "me", text: "/status" },
    { id: 3, from: "bot", text: "🟢 running · tick 41\n💰 equity 10,284.00 USD   peak 10,412.00\n📅 day P&L +284.00   drawdown 1.23%\n📊 closed 9 trades   win rate 55.6%\n🔓 open 2/3\n🆔 account 12345678 @ Broker-Demo · USD · verified=True · symbols 3" },
  ]);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [msgs, typing]);

  useEffect(() => {
    const snapshot = timers.current;
    return () => snapshot.forEach((t) => window.clearTimeout(t));
  }, []);

  // mirror desk activity into the chat, like the gateway's watch loop
  const closedRef = useRef(status?.closedCount ?? 0);
  useEffect(() => {
    const closed = status?.closedCount ?? 0;
    if (closed > closedRef.current) {
      push({
        id: ++idRef.current,
        from: "bot",
        text: `🔔 desk update — ${closed} closed trades, equity ${status!.balance.toFixed(2)}, day ${status!.dailyPnl >= 0 ? "+" : ""}${status!.dailyPnl.toFixed(2)}. Reply /positions for the book.`,
      });
    }
    closedRef.current = closed;
  }, [status?.closedCount]); // eslint-disable-line react-hooks/exhaustive-deps

  const push = (m: Msg) => setMsgs((cur) => [...cur.slice(-60), m]);
  const stamp = () => new Date().toISOString().slice(11, 19);

  function reply(text: string): { msg: string; kind?: Msg["kind"] } {
    const verb = text.trim().split(/\s+/)[0]?.toLowerCase().split("@")[0] || "";
    const chat = asStranger ? STRANGER : MY_CHAT;

    if (asStranger && !paired && !PAIR_VERBS.has(verb)) {
      setSecurityLog((l) => [`[ERROR] forex_bot.telegram: SECURITY WARNING — unauthorised chat_id ${chat} sent ${JSON.stringify(text.slice(0, 44))}`, ...l].slice(0, 6));
      return {
        msg: `⛔ chat \`${chat}\` is not on the allowlist, so this command was ignored.\nOperator can authorise it from the terminal with /pair <code>.`,
        kind: "err",
      };
    }
    if (verb === "/id") return { msg: `Your chat id is \`${chat}\` — put it in telegram_chat_ids to stay authorised.` };
    if (verb === "/pair") {
      const given = text.trim().split(/\s+/)[1] || "";
      if (!given) return { msg: "Usage: /pair <6-digit code shown in the bot terminal>." };
      if (given !== code) {
        setSecurityLog((l) => [`[ERROR] forex_bot.telegram: Pairing rejected for chat ${chat} (bad code).`, ...l].slice(0, 6));
        return { msg: "❌ Wrong or expired code.", kind: "err" };
      }
      setPaired(true);
      return { msg: `✅ chat \`${chat}\` authorised for this session.\nPersist it in config.py → telegram_chat_ids, then /status.`, kind: "ok" };
    }
    if (verb === "/help") {
      return {
        msg:
          "forex_bot commands\n/start · /stop · /status · /positions\n/close <ticket|all> · /halt · /resume\n/risk · /pairs · /id · /pair <code>\nNo command here can size a trade or bypass the risk manager.",
      };
    }
    if (DESK_VERBS.has(verb)) {
      if (verb === "/start" && requireMatch && !accountMatch) {
        return {
          msg: "🚫 Refusing to trade: terminal reports login 87654321 @ Broker-Demo but config demands 12345678.\nFix config.mt5_login or set require_account_match=False (not recommended).",
          kind: "err",
        };
      }
      const out = deskRun(text);
      if (verb === "/start" && /paused|refus|🚫/i.test(out)) return { msg: out, kind: "warn" };
      return { msg: out, kind: verb === "/stop" || verb === "/halt" ? "warn" : undefined };
    }
    if (!text.trim().startsWith("/")) return { msg: "I only take commands — try /status or /help." };
    return { msg: `Unknown command \`${verb}\`. Try /help.` };
  }

  const send = (text: string) => {
    const clean = text.trim();
    if (!clean) return;
    push({ id: ++idRef.current, from: "me", text: clean });
    setTyping(true);
    const t = window.setTimeout(() => {
      const r = reply(clean);
      setTyping(false);
      push({ id: ++idRef.current, from: "bot", text: r.msg, kind: r.kind });
    }, 460);
    timers.current.push(t);
  };

  return (
    <section id="telegram" className="mx-auto max-w-[1400px] px-4 py-20 md:px-7">
      <Reveal>
        <SectionHeading
          index="01"
          kicker="telegram_control.py · start here, stop here"
          tone="sky"
          title={
            <>
              Arm it from your phone.
              <br />
              <span className="text-muted">Only if your phone is on the list.</span>
            </>
          }
          blurb={
            <>
              The gateway long-polls the Bot API with stdlib <code className="rounded bg-panel px-1.5 py-0.5 font-mono text-[12.5px] text-amber">urllib</code> — no new
              dependency. Commands can start, stop, flatten, halt and inspect the loop. They can never size a trade,
              move a stop, or step around <span className="font-mono text-rose">risk_manager.py</span>. Commands from a chat id
              that is not allowlisted are refused <em>and</em> written to <code className="rounded bg-panel px-1.5 py-0.5 font-mono text-[12.5px] text-amber">errors.log</code>.
            </>
          }
          right={<Chip tone="sky"><Smartphone size={12} /> {status?.running ? "desk live" : "desk idle"}</Chip>}
        />
      </Reveal>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,400px)_minmax(0,1fr)]">
        {/* ── the chat ───────────────────────────────────────────────── */}
        <Reveal>
          <div className="panel overflow-hidden rounded-xl">
            <div className="flex items-center gap-2.5 border-b border-line bg-panel-2/80 px-3.5 py-2.5">
              <span className="grid size-7 place-items-center rounded-full border border-sky/45 bg-sky/10 text-sky">
                <Bot size={13} />
              </span>
              <span className="leading-tight">
                <span className="block font-mono text-[12px] text-sand">forex_bot_control</span>
                <span className="block font-mono text-[9.5px] text-muted">bot 7341 · polling mode · timeout 25s</span>
              </span>
              <span className={cx("ml-auto font-mono text-[9.5px] uppercase", paired || !asStranger ? "text-jade" : "text-amber")}>
                {asStranger && !paired ? "unverified chat" : "authorised"}
              </span>
            </div>

            <div ref={listRef} className="h-[352px] space-y-2.5 overflow-y-auto bg-ink-2/70 p-3">
              {msgs.map((m) => (
                <div key={m.id} className={cx("flex", m.from === "me" ? "justify-end" : "justify-start")}>
                  <div
                    className={cx(
                      "max-w-[86%] rounded-2xl px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words",
                      m.from === "me"
                        ? "rounded-br-md border border-sky/30 bg-sky/10 text-sand"
                        : cx(
                            "rounded-bl-md border",
                            m.kind === "err" ? "border-rose/40 bg-rose/[0.08] text-rose" : m.kind === "warn" ? "border-amber/35 bg-amber/[0.07] text-amber" : "border-line bg-panel text-sand-2",
                          ),
                    )}
                  >
                    {m.text.split("`").join("")}
                    <span className={cx("mt-1 block text-[9px]", m.from === "me" ? "text-sky/60" : "text-line")}>{stamp()}</span>
                  </div>
                </div>
              ))}
              {typing && (
                <div className="flex gap-1 rounded-2xl border border-line bg-panel px-3 py-2.5 w-fit">
                  {[0, 1, 2].map((i) => (
                    <span key={i} className="size-1.5 animate-pulse-soft rounded-full bg-muted" style={{ animationDelay: `${i * 160}ms` }} />
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-1 border-t border-line px-3 py-2">
              {["/status", "/start", "/stop", "/positions", "/halt", "/close all", "/help"].map((q) => (
                <button
                  key={q}
                  onClick={() => send(q)}
                  className="rounded-md border border-line px-2 py-1 font-mono text-[10px] text-muted transition-colors hover:border-sky/45 hover:text-sky"
                >
                  {q}
                </button>
              ))}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                send(input);
                setInput("");
              }}
              className="flex items-center gap-2 border-t border-line bg-panel/60 px-3 py-2.5"
            >
              <input
                value={input}
                onChange={(ev) => setInput(ev.target.value)}
                placeholder="/close 900012"
                className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-sand outline-none placeholder:text-line"
              />
              <button
                type="submit"
                className="grid size-8 shrink-0 place-items-center rounded-md border border-sky/40 bg-sky/10 text-sky transition-colors hover:bg-sky/20"
                aria-label="send command"
              >
                <Send size={13} />
              </button>
            </form>

            <div className="flex items-center gap-2 border-t border-line px-3 py-2">
              <UserX size={12} className={asStranger ? "text-rose" : "text-muted"} />
              <button
                onClick={() => {
                  setAsStranger((s) => !s);
                  setPaired(false);
                }}
                className="font-mono text-[10px] text-muted transition-colors hover:text-rose"
              >
                simulate: {asStranger ? `stranger (${STRANGER})` : `owner (${MY_CHAT})`}
              </button>
              {asStranger && !paired && (
                <button onClick={() => { setPaired(true); push({ id: ++idRef.current, from: "bot", text: `✅ chat \`${STRANGER}\` authorised for this session. (operator ran the pairing code)` }); }} className="ml-auto font-mono text-[10px] text-jade hover:underline">
                  operator: run /pair {code}
                </button>
              )}
            </div>
          </div>
        </Reveal>

        {/* ── identity + safety ──────────────────────────────────────── */}
        <Reveal delay={70}>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="panel rounded-xl p-4 md:col-span-2">
              <div className="flex items-center gap-2">
                <ShieldCheck size={14} className="text-jade" />
                <h3 className="font-display text-[17px] font-semibold text-sand">Three ids have to agree before a lot is traded</h3>
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-3">
                <div className="rounded-lg border border-line-soft bg-ink-2/60 p-3">
                  <div className="font-mono text-[9.5px] tracking-[0.16em] text-muted uppercase">1 · which account</div>
                  <div className="tabnum mt-2 font-display text-[19px] font-bold text-sand">12345678</div>
                  <p className="mt-1 font-mono text-[10px] leading-relaxed text-muted">
                    config.mt5_login + mt5_server. At startup <span className="text-sky">ForexDataFeed.initialize()</span> compares them with{" "}
                    <span className="text-sky">mt5.account_info()</span> and refuses to continue on mismatch.
                  </p>
                </div>
                <div className="rounded-lg border border-line-soft bg-ink-2/60 p-3">
                  <div className="font-mono text-[9.5px] tracking-[0.16em] text-muted uppercase">2 · which orders</div>
                  <div className="tabnum mt-2 font-display text-[19px] font-bold text-sand">magic 123456</div>
                  <p className="mt-1 font-mono text-[10px] leading-relaxed text-muted">
                    stamped on every request; <span className="text-sky">positions_get</span> is filtered by it, so manual trades on the same account are
                    never touched, managed, or closed.
                  </p>
                </div>
                <div className="rounded-lg border border-line-soft bg-ink-2/60 p-3">
                  <div className="font-mono text-[9.5px] tracking-[0.16em] text-muted uppercase">3 · who commands</div>
                  <div className="tabnum mt-2 font-display text-[19px] font-bold text-sand">{MY_CHAT}</div>
                  <p className="mt-1 font-mono text-[10px] leading-relaxed text-muted">
                    telegram_chat_ids allowlist, plus a one-time <span className="text-amber">/pair</span> code. Empty list = nobody gets in.
                  </p>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line-soft pt-3">
                <button
                  onClick={() => setRequireMatch((r) => !r)}
                  className={cx(
                    "rounded-md border px-2.5 py-1.5 font-mono text-[10px] transition-colors",
                    requireMatch ? "border-jade/45 bg-jade/10 text-jade" : "border-line text-muted hover:text-sand-2",
                  )}
                >
                  require_account_match = {String(requireMatch)}
                </button>
                <button
                  onClick={() => setAccountMatch((a) => !a)}
                  className={cx(
                    "rounded-md border px-2.5 py-1.5 font-mono text-[10px] transition-colors",
                    accountMatch ? "border-line text-muted hover:text-sand-2" : "border-rose/45 bg-rose/10 text-rose",
                  )}
                >
                  terminal reports {accountMatch ? "12345678 ✓" : "87654321 ✗"}
                </button>
                <span className="font-mono text-[10px] text-muted">then try /start in the chat →</span>
                {requireMatch && !accountMatch && (
                  <span className="rounded-md border border-rose/40 bg-rose/[0.08] px-2.5 py-1.5 font-mono text-[10px] text-rose">
                    DataFeedError: account mismatch — bot will not trade on an unverified account
                  </span>
                )}
                {(!requireMatch || accountMatch) && (
                  <span className="rounded-md border border-jade/35 bg-jade/[0.07] px-2.5 py-1.5 font-mono text-[10px] text-jade">
                    fingerprint verified — /start accepted
                  </span>
                )}
              </div>
            </div>

            <div className="panel rounded-xl p-4">
              <div className="flex items-center gap-2">
                <KeyRound size={13} className="text-amber" />
                <h4 className="font-mono text-[10.5px] tracking-[0.18em] text-muted uppercase">pairing · printed once at boot</h4>
                <button
                  onClick={() => { setCode(String(Math.floor(100000 + Math.random() * 899999))); setPaired(false); }}
                  className="ml-auto grid size-7 place-items-center rounded-md border border-line text-muted transition-colors hover:text-amber"
                  title="print a new code"
                >
                  <RefreshCcw size={12} />
                </button>
              </div>
              <pre className="mt-3 overflow-x-auto rounded-lg border border-line-soft bg-ink-2/80 p-3 font-mono text-[10.5px] leading-relaxed text-sand-2">
{`$ python main.py --remote
[INFO] forex_bot.telegram: No telegram_chat_ids configured.
[WARNING] Pair from any device with:   /pair ${code}
[INFO] forex_bot.telegram: Telegram gateway online — allowed chats: none yet`}
              </pre>
              <p className="mt-2.5 text-[12.5px] leading-relaxed text-sand-2/80">
                The code is random per boot and single-use: redeem it once from the chat you want to trust, then it is
                rotated and the refusal message changes to "already authorised". Restarting with an empty allowlist means
                nobody — including you — can command the bot until you pair again. That is the point.
              </p>
            </div>

            <div className="panel rounded-xl p-4">
              <div className="flex items-center gap-2">
                <TerminalSquare size={13} className="text-rose" />
                <h4 className="font-mono text-[10.5px] tracking-[0.18em] text-muted uppercase">errors.log · security tail</h4>
              </div>
              <div className="mt-3 min-h-[120px] space-y-1.5 font-mono text-[10px] leading-relaxed">
                {securityLog.length ? (
                  securityLog.map((l, i) => (
                    <div key={`${l}-${i}`} className="rounded border border-rose/25 bg-rose/[0.05] px-2 py-1.5 text-rose/90">
                      {l}
                    </div>
                  ))
                ) : (
                  <div className="text-muted">
                    Nothing yet. Switch the chat to <span className="text-rose">stranger</span> and send{" "}
                    <span className="text-sand-2">/stop</span> to see a refusal get logged.
                  </div>
                )}
              </div>
              <p className="mt-2 border-t border-line-soft pt-2 text-[12px] text-sand-2/75">
                Rate limiting is per chat (30 commands/min, 350 ms floor) so a stuck button or a brute-force attempt
                cannot spam the loop.
              </p>
            </div>

            <div className="panel rounded-xl p-4 md:col-span-2">
              <h4 className="font-mono text-[10.5px] tracking-[0.18em] text-muted uppercase">wire it up — four moves</h4>
              <ol className="mt-3 grid gap-2.5 md:grid-cols-2">
                {[
                  ["1 · make the bot", "@BotFather → /newbot → copy the token. Give it privacy-off in /setprivacy if you want it to see group commands (or just use a private chat)."],
                  ["2 · export the secrets", "set FXBOT_TELEGRAM_TOKEN=123:ABC…  ·  set FXBOT_TELEGRAM_CHAT_IDS=734112288  ·  set FXBOT_MT5_LOGIN=12345678"],
                  ["3 · start armed but paused", "python main.py --remote — it connects to MT5, verifies the account fingerprint, then waits at “armed, paused”. No analysis, no orders, nothing to regret."],
                  ["4 · drive it from the chat", "/start to begin, /status whenever you like, /positions + /close all in an emergency, /halt to freeze new entries, /stop when done."],
                ].map(([title, body]) => (
                  <li key={title} className="rounded-lg border border-line-soft bg-ink-2/50 p-3">
                    <div className="font-mono text-[11px] text-sky">{title}</div>
                    <div className="mt-1 text-[12.5px] leading-relaxed text-sand-2/80">{body}</div>
                  </li>
                ))}
              </ol>
              <p className="mt-3 border-t border-line-soft pt-2.5 font-mono text-[10.5px] leading-relaxed text-muted">
                Polling, not webhooks: no public HTTPS host, no exposed port, works behind NAT. Swap{" "}
                <span className="text-sky">HttpApi</span> for a webhook handler if you already run TLS — the dispatcher is the
                same code. Current equity in the desk right now: {usd(status?.balance ?? 10000)}, {status?.open.length ?? 0} open,{" "}
                {status?.halted ? "HALTED" : "no halt"}.
              </p>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
