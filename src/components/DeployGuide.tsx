import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ClipboardCopy,
  CloudUpload,
  HeartPulse,
  MonitorSmartphone,
  Server,
  Stethoscope,
  TriangleAlert,
  X,
} from "lucide-react";
import { Chip, Reveal, SectionHeading, cx, usd } from "./ui";
import { deskStatus, useDeskVersion } from "../lib/deskBus";

const KEY = "forex_bot.deploy.checklist.v2";

interface Step {
  key: string;
  title: string;
  body: string;
  cmd?: string;
  warn?: string;
}

const TARGETS: { id: string; label: string; sub: string; icon: typeof Server; steps: Step[] }[] = [
  {
    id: "win",
    label: "Windows VPS · live loop",
    sub: "the only place MT5 is happy",
    icon: Server,
    steps: [
      { key: "w1", title: "Provision the box", body: "2 vCPU / 4 GB Windows Server near your broker — a 1–5 ms ping beats a fast CPU. Open no inbound ports; the bot only dials out." },
      { key: "w2", title: "Install Python + the terminal", body: "Python 3.10–3.12 x64, then the broker's own MT5 build. Log into the DEMO account, enable File → Auto Trading, and put a terminal shortcut in shell:startup so it is signed in before the bot wakes up." },
      {
        key: "w3",
        title: "Clone and install",
        body: "Virtualenv per box, pinned deps, nothing global.",
        cmd: "git clone <repo> && cd forex_bot\npython -m venv .venv && .venv\\Scripts\\activate\npip install -r requirements.txt",
      },
      {
        key: "w4",
        title: "Pin the identity",
        body: "Edit deploy/run_bot.cmd: MT5 login, server, token, chat id. require_account_match makes a mismatch fatal at startup rather than a surprise at fill time.",
        cmd: "set FXBOT_MT5_LOGIN=12345678\nset FXBOT_MT5_SERVER=Broker-Demo\nset FXBOT_TELEGRAM_CHAT_IDS=734112288",
      },
      {
        key: "w5",
        title: "Prove it in front of you",
        body: "Never deploy something you have not watched for ten minutes.",
        cmd: "python main.py --self-test\npython main.py --mock --once\npython main.py --remote     # then send /start",
      },
      {
        key: "w6",
        title: "Register autostart",
        body: "Task Scheduler at boot, supervised by watchdog.py — it self-tests first and refuses to register a failing bot.",
        cmd: "powershell -ExecutionPolicy Bypass -File deploy\\install-service.ps1\nStart-ScheduledTask -TaskName ForexBot",
      },
      {
        key: "w7",
        title: "Verify the reboot",
        body: "Reboot the VPS and confirm the loop came back, restored bot_state.json, and did not forget a halt.",
        cmd: "Get-Content .\\bot.log -Wait -Tail 40\nGet-ScheduledTaskInfo -TaskName ForexBot",
        warn: "A deploy you have not rebooted through is not a deploy.",
      },
    ],
  },
  {
    id: "linux",
    label: "Linux box · research + alerts",
    sub: "backtests, the watcher, no fills",
    icon: CloudUpload,
    steps: [
      { key: "l1", title: "Know the limit", body: "MetaTrader5 is Windows-only: this host runs backtests, the alert watcher and paper/mock loops, not live fills. Keep the loop itself on the Windows box." },
      {
        key: "l2",
        title: "User, venv, source",
        body: "Dedicated non-login user with the repo under /opt.",
        cmd: "sudo useradd -r -s /usr/sbin/nologin fxbot\nsudo mkdir -p /opt/forex_bot && sudo chown fxbot /opt/forex_bot\ngit clone <repo> /opt/forex_bot && python3 -m venv /opt/forex_bot/.venv",
      },
      {
        key: "l3",
        title: "Secrets in an env file",
        body: "Copy deploy/.env.example to /etc/forex-bot.env, chmod 600, owned by root. Never in the unit file, never in git.",
        cmd: "sudo install -m 600 -o root /opt/forex_bot/deploy/.env.example /etc/forex-bot.env",
      },
      {
        key: "l4",
        title: "Install the unit",
        body: "systemd restarts it, watchdog.py restarts the child, journal keeps the console.",
        cmd: "sudo cp deploy/forex-bot.service /etc/systemd/system/\nsudo systemctl daemon-reload\nsudo systemctl enable --now forex-bot\njournalctl -u forex-bot -f",
      },
      { key: "l5", title: "Nightly cron for research", body: "Re-fit nothing, just re-measure: run the backtester over fresh history each Sunday and mail yourself the report.", cmd: "0 6 * * 0 cd /opt/forex_bot && .venv/bin/python backtester.py --pair EUR/USD --bars 4000 >> /var/log/fx-backtest.log 2>&1" },
    ],
  },
  {
    id: "local",
    label: "Laptop · paper only",
    sub: "the honest first week",
    icon: MonitorSmartphone,
    steps: [
      { key: "p1", title: "Do this first", body: "A full week of demo/paper ticks before any VPS money: you are measuring whether the signals look sane, not whether they profit." },
      { key: "p2", title: "Run it in a terminal you watch", body: "Mock feed, simulated fills, real logic.", cmd: "python main.py --mock --ticks 200" },
      { key: "p3", title: "Read the tape", body: "Every signal block, every rejection reason. If rejections outnumber fills, the thresholds are working; if never, your confidence floor is too low." },
      { key: "p4", title: "Then move it", body: "Copy the same config to the Windows VPS and follow the first tab. Nothing should change except the machine." },
    ],
  },
];

const HOSTS = [
  { id: "netlify", label: "Netlify / Vercel", cmd: "npm run build\nnpx netlify-cli deploy --prod --dir=dist" },
  { id: "pages", label: "GitHub Pages", cmd: "npm run build && npx gh-pages -d dist" },
  { id: "static", label: "nginx / S3 / disk", cmd: "npm run build\nsudo cp -r dist/* /var/www/forex_bot/\n# or just open dist/index.html locally — it is one file" },
];

function CopyBlock({ code }: { code: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="group relative mt-2.5">
      <pre className="overflow-x-auto rounded-lg border border-line-soft bg-ink-2/85 p-3 pr-10 font-mono text-[11px] leading-relaxed text-jade/90">
        {code}
      </pre>
      <button
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(code);
            setDone(true);
            window.setTimeout(() => setDone(false), 1400);
          } catch {
            setDone(false);
          }
        }}
        className="absolute right-2 top-2 rounded border border-line bg-panel px-2 py-1.5 text-muted opacity-100 transition-all hover:text-jade focus:opacity-100 md:opacity-0 md:group-hover:opacity-100"
        aria-label="copy commands"
      >
        {done ? <Check size={12} className="text-jade" /> : <ClipboardCopy size={12} />}
      </button>
    </div>
  );
}

export function DeployGuide({ onOpenFile }: { onOpenFile: (name: string) => void }) {
  useDeskVersion();
  const status = deskStatus();
  const [target, setTarget] = useState("win");
  const [host, setHost] = useState("netlify");
  const [checked, setChecked] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(KEY) || "{}");
    } catch {
      return {};
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(checked));
    } catch {
      /* storage disabled — the checklist just won't persist */
    }
  }, [checked]);

  const steps = useMemo(() => TARGETS.find((t) => t.id === target) ?? TARGETS[0], [target]);
  const total = TARGETS.reduce((n, t) => n + t.steps.length, 0);
  const done = TARGETS.reduce((n, t) => n + t.steps.filter((s) => checked[s.key]).length, 0);

  const doctor = [
    {
      id: "os",
      label: "Live loop on Windows",
      tone: target === "win" ? "pass" : "warn",
      text: target === "win" ? "MT5 requires it — correct choice" : "live fills cannot run on this target; use the Windows tab",
    },
    {
      id: "risk",
      label: "risk/trade ≤ 2 %",
      tone: (status?.limits.riskPct ?? 0.02) <= 0.02 ? "pass" : "fail",
      text: `${((status?.limits.riskPct ?? 0.02) * 100).toFixed(2)} % currently — on a live box 0.5–1 % is the braver end`,
    },
    {
      id: "halt",
      label: "No latched halt",
      tone: status?.halted ? "fail" : "pass",
      text: status?.halted ? status.haltReason || "halt active — /resume after review" : "clean; halts persist in bot_state.json so a restart cannot hide one",
    },
    {
      id: "dd",
      label: "Drawdown headroom",
      tone: (status?.drawdown ?? 0) < 5 ? "pass" : (status?.drawdown ?? 0) < 12 ? "warn" : "fail",
      text: `${(status?.drawdown ?? 0).toFixed(2)} % used of the 15 % breaker`,
    },
    {
      id: "loop",
      label: "Loop actually running",
      tone: status?.running ? "pass" : "warn",
      text: status?.running ? `tick ${status.tick} · ${status.open.length} open · equity ${usd(status.balance)}` : "start section 00 (or /start) to prove the pipeline end to end first",
    },
    {
      id: "state",
      label: "State durable",
      tone: "pass",
      text: "desk persists to localStorage; the bot writes bot_state.json atomically — back that file up nightly",
    },
    {
      id: "secret",
      label: "Secrets out of git",
      tone: "warn",
      text: "deploy/.env.example is the template; the real .env / run_bot.cmd edits stay on the box",
    },
    {
      id: "reboot",
      label: "Reboot-tested",
      tone: checked.w7 || checked.l4 || checked.p4 ? "pass" : "fail",
      text: "reboot the host and confirm the task returns and restores state",
    },
  ] as const;

  return (
    <section id="deploy" className="mx-auto max-w-[1400px] px-4 py-20 md:px-7">
      <Reveal>
        <SectionHeading
          index="08"
          kicker="deploy · keep it alive without you"
          tone="amber"
          title={
            <>
              A bot you have to babysit
              <br />
              <span className="text-muted">is a bot that loses money at 03:00.</span>
            </>
          }
          blurb={
            <>
              Three pieces, three homes: the tick loop lives on a Windows box beside the
              terminal, research can live anywhere, and this dashboard is a single static file.
              Tick the steps as you do them — the list is saved in this browser, and the doctor
              on the right reads the live desk, so it can tell you your own risk knob is too hot.
            </>
          }
          right={
            <div className="flex items-center gap-3 rounded-lg border border-line bg-panel/70 px-3.5 py-2.5">
              <span className="font-mono text-[10px] tracking-[0.16em] text-muted uppercase">ready</span>
              <span className="tabnum font-display text-[22px] leading-none font-bold text-sand">
                {done}
                <span className="text-muted">/{total}</span>
              </span>
              <span className="h-1.5 w-20 overflow-hidden rounded-full bg-ink-2">
                <span className="block h-full rounded-full bg-amber transition-[width] duration-500" style={{ width: `${(done / total) * 100}%` }} />
              </span>
            </div>
          }
        />
      </Reveal>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Reveal className="min-w-0">
          <div className="panel rounded-xl p-4">
            <div className="flex flex-wrap gap-1.5">
              {TARGETS.map((t) => {
                const Icon = t.icon;
                const on = target === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setTarget(t.id)}
                    className={cx(
                      "flex items-center gap-2 rounded-lg border px-3 py-2 text-left transition-all",
                      on ? "border-amber/45 bg-amber/10 text-amber" : "border-line text-muted hover:border-line hover:text-sand-2",
                    )}
                  >
                    <Icon size={14} />
                    <span className="leading-tight">
                      <span className="block font-mono text-[11.5px]">{t.label}</span>
                      <span className="block font-mono text-[9.5px] text-muted">{t.sub}</span>
                    </span>
                  </button>
                );
              })}
            </div>

            <ol className="relative mt-5 space-y-3 border-l border-line pl-6">
              {steps.steps.map((s, i) => {
                const on = Boolean(checked[s.key]);
                return (
                  <li key={s.key} className="relative">
                    <span
                      className={cx(
                        "absolute -left-[31px] grid size-5 place-items-center rounded-full border font-mono text-[9.5px] transition-colors",
                        on ? "border-jade/60 bg-jade/15 text-jade" : "border-line bg-ink text-muted",
                      )}
                    >
                      {on ? <Check size={10} strokeWidth={3} /> : i + 1}
                    </span>
                    <div
                      className={cx(
                        "rounded-lg border p-3 transition-colors",
                        on ? "border-jade/25 bg-jade/[0.05]" : "border-line-soft bg-ink-2/50 hover:border-line",
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <h4 className="font-display text-[15.5px] font-semibold text-sand">{s.title}</h4>
                          <p className="mt-1 text-[13px] leading-relaxed text-sand-2/80">{s.body}</p>
                          {s.cmd && <CopyBlock code={s.cmd} />}
                          {s.warn && (
                            <p className="mt-2 flex items-start gap-1.5 font-mono text-[10.5px] leading-relaxed text-amber">
                              <TriangleAlert size={12} className="mt-px shrink-0" /> {s.warn}
                            </p>
                          )}
                        </div>
                        <button
                          onClick={() => setChecked((c) => ({ ...c, [s.key]: !c[s.key] }))}
                          className={cx(
                            "mt-0.5 shrink-0 rounded-md border px-2 py-1 font-mono text-[9.5px] tracking-wider uppercase transition-colors",
                            on ? "border-jade/45 text-jade" : "border-line text-muted hover:text-sand-2",
                          )}
                        >
                          {on ? "done" : "mark"}
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>

            <div className="mt-4 grid gap-3 border-t border-line pt-4 md:grid-cols-[minmax(0,1fr)_220px]">
              <div>
                <div className="flex items-center gap-2">
                  <HeartPulse size={13} className="text-jade" />
                  <h4 className="font-display text-[14.5px] font-semibold text-sand">What keeps it alive</h4>
                </div>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-sand-2/80">
                  The scheduled task runs <span className="font-mono text-amber">deploy/watchdog.py</span>, not{" "}
                  <span className="font-mono">main.py</span> directly. It restarts a dead child with exponential backoff,
                  gives up after 6 restarts in an hour and sends you a Telegram message instead of flapping forever, can
                  kill a process whose log went silent, and forwards Ctrl+C so the MT5 feed closes cleanly. Task Scheduler
                  and systemd are then only responsible for restarting the watchdog itself.
                </p>
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {["watchdog.py", "run_bot.cmd", "install-service.ps1", "forex-bot.service"].map((f) => (
                    <button
                      key={f}
                      onClick={() => onOpenFile(f)}
                      className="rounded-md border border-line px-2 py-1 font-mono text-[10px] text-muted transition-colors hover:border-amber/40 hover:text-amber"
                    >
                      open {f}
                    </button>
                  ))}
                </div>
              </div>
              <div className="rounded-lg border border-line-soft bg-ink-2/60 p-3">
                <div className="font-mono text-[9.5px] tracking-[0.16em] text-muted uppercase">morning checks</div>
                <ul className="mt-2 space-y-1.5 font-mono text-[10.5px] leading-relaxed text-sand-2/85">
                  <li><span className="text-jade">›</span> /status — equity, day P&amp;L, halt</li>
                  <li><span className="text-jade">›</span> errors.log has 0 new lines</li>
                  <li><span className="text-jade">›</span> trade count grew by a plausible amount</li>
                  <li><span className="text-jade">›</span> drawdown inside 15 % and shrinking</li>
                  <li><span className="text-jade">›</span> bot.log mtime is within 2 × tick_interval</li>
                </ul>
              </div>
            </div>
          </div>
        </Reveal>

        <Reveal delay={70}>
          <div className="flex flex-col gap-4">
            <div className="panel rounded-xl p-4">
              <div className="flex items-center gap-2">
                <Stethoscope size={14} className="text-sky" />
                <h4 className="font-display text-[15px] font-semibold text-sand">Preflight doctor</h4>
                <span className="ml-auto font-mono text-[9.5px] text-muted">live from section 00</span>
              </div>
              <ul className="mt-3 space-y-1.5">
                {doctor.map((d) => (
                  <li key={d.id} className="flex items-start gap-2.5 rounded-lg border border-line-soft bg-ink-2/50 px-2.5 py-2 transition-colors hover:border-line">
                    <span className={cx("mt-0.5 grid size-4 shrink-0 place-items-center rounded-full", d.tone === "pass" ? "bg-jade/15 text-jade" : d.tone === "warn" ? "bg-amber/15 text-amber" : "bg-rose/15 text-rose")}>
                      {d.tone === "pass" ? <Check size={9} strokeWidth={3} /> : d.tone === "warn" ? <TriangleAlert size={9} /> : <X size={9} strokeWidth={3} />}
                    </span>
                    <span className="min-w-0">
                      <span className="block font-mono text-[11px] text-sand">{d.label}</span>
                      <span className="block font-mono text-[10px] leading-relaxed text-muted">{d.text}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="panel rounded-xl p-4">
              <div className="flex items-center gap-2">
                <CloudUpload size={14} className="text-lilac" />
                <h4 className="font-display text-[15px] font-semibold text-sand">Ship the dashboard</h4>
              </div>
              <div className="mt-2.5 flex gap-1">
                {HOSTS.map((h) => (
                  <button
                    key={h.id}
                    onClick={() => setHost(h.id)}
                    className={cx(
                      "flex-1 rounded-md border px-2 py-1.5 font-mono text-[10px] transition-colors",
                      host === h.id ? "border-lilac/45 bg-lilac/10 text-lilac" : "border-line text-muted hover:text-sand-2",
                    )}
                  >
                    {h.label}
                  </button>
                ))}
              </div>
              <CopyBlock code={HOSTS.find((h) => h.id === host)!.cmd} />
              <p className="mt-2.5 text-[12.5px] leading-relaxed text-sand-2/80">
                The build is one self-contained <span className="font-mono text-[11.5px] text-amber">dist/index.html</span> — CSS, JS and every
                annotated Python file inlined. It holds no token, no API and no ability to trade, so publishing it is a
                documentation act, not a security decision. Keep it off the trading box entirely if you prefer.
              </p>
            </div>

            <div className="rounded-xl border border-rose/35 bg-rose/[0.07] p-4">
              <div className="flex items-center gap-2">
                <TriangleAlert size={14} className="text-rose" />
                <h4 className="font-display text-[14.5px] font-semibold text-rose">Deploy-time don'ts</h4>
              </div>
              <ul className="mt-2 space-y-1.5 font-mono text-[10.5px] leading-relaxed text-sand-2/85">
                <li>✗ no webhook / open port for the bot — polling is enough</li>
                <li>✗ no password in config.py or the .cmd committed to git</li>
                <li>✗ no live account until a full demo week is in bot.log</li>
                <li>✗ no “restart policy” without a give-up threshold; a crash-loop costs money</li>
                <li>✗ no deleting bot_state.json to “fix” a halt</li>
              </ul>
            </div>
          </div>
        </Reveal>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Chip tone="jade"><Server size={12} /> loop → Windows VPS</Chip>
        <Chip tone="sky"><CloudUpload size={12} /> research → anywhere</Chip>
        <Chip tone="sky"><MonitorSmartphone size={12} /> dashboard → static host</Chip>
        <span className="font-mono text-[10.5px] text-muted">
          and one rule: <span className="text-amber">reboot it before you trust it</span>.
        </span>
      </div>
    </section>
  );
}
