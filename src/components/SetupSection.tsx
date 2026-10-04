import { useMemo, useState } from "react";
import { marked } from "marked";
import { AlertTriangle, BookOpenCheck, Copy, KeyRound, TerminalSquare, Check } from "lucide-react";
import { Chip, Reveal, SectionHeading, cx } from "./ui";
import { README_MARKDOWN } from "../lib/sources";

const SNIPPETS: { title: string; caption: string; code: string }[] = [
  {
    title: "install & verify",
    caption: "run from inside the project folder so the flat imports resolve",
    code: `cd forex_bot
python -m venv .venv && .venv\\Scripts\\activate
pip install -r requirements.txt

python -c "import MetaTrader5 as m; print(m.initialize(), m.terminal_info())"`,
  },
  {
    title: "prove it works without a terminal",
    caption: "no MT5, no account, no risk — deterministic mock feed",
    code: `python main.py --self-test      # risk engine + indicator assertions
python main.py --mock --once    # one full tick, paper fills
python main.py --mock --ticks 5 --pairs EUR/USD --timeframe 15m`,
  },
  {
    title: "backtest before anything else",
    caption: "bar-by-bar replay, trade list exported for inspection",
    code: `python backtester.py --pair EUR/USD --bars 4000 --spread 1.5 --csv eur.csv
python main.py --backtest       # every configured pair + portfolio`,
  },
  {
    title: "go live (demo first)",
    caption: "credentials come from the environment, never from the repo",
    code: `set FXBOT_MT5_LOGIN=12345678
set FXBOT_MT5_SERVER=Broker-Demo
set FXBOT_MAX_RISK_PER_TRADE=0.01
python main.py`,
  },
];

function Snippet({ s }: { s: (typeof SNIPPETS)[number] }) {
  const [done, setDone] = useState(false);
  return (
    <div className="panel hover-lift rounded-xl p-4 hover:border-sky/35">
      <div className="flex items-center gap-2">
        <TerminalSquare size={13} className="text-sky" />
        <h4 className="font-display text-[14.5px] font-semibold text-sand">{s.title}</h4>
        <button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(s.code);
              setDone(true);
              window.setTimeout(() => setDone(false), 1500);
            } catch {
              setDone(false);
            }
          }}
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 font-mono text-[10px] text-muted transition-colors hover:text-jade"
        >
          {done ? <Check size={11} className="text-jade" /> : <Copy size={11} />}
          {done ? "copied" : "copy"}
        </button>
      </div>
      <p className="mt-1 text-[12.5px] text-muted">{s.caption}</p>
      <pre className="mt-3 overflow-x-auto rounded-lg border border-line-soft bg-ink-2/80 p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre text-jade/90">
        {s.code}
      </pre>
    </div>
  );
}

export function SetupSection() {
  const html = useMemo(() => marked.parse(README_MARKDOWN, { async: false, gfm: true, breaks: false }) as string, []);

  return (
    <section id="setup" className="mx-auto max-w-[1400px] px-4 py-20 md:px-7">
      <Reveal>
        <SectionHeading
          index="07"
          kicker="README.md · the printed spec sheet"
          tone="amber"
          title={
            <>
              Everything the operator needs,
              <br />
              <span className="text-muted">on paper, next to the machine.</span>
            </>
          }
          blurb={
            <>
              The repository ships with a README that covers prerequisites, the verification one-liner,
              every configuration field, and an explicit risk disclaimer. It is rendered here directly from{" "}
              <code className="rounded bg-panel px-1.5 py-0.5 font-mono text-[12.5px] text-amber">forex_bot/README.md</code>.
            </>
          }
          right={<Chip tone="amber"><BookOpenCheck size={12} /> {README_MARKDOWN.split("\n").length} lines of docs</Chip>}
        />
      </Reveal>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Reveal className="min-w-0">
          <article className="max-h-[76vh] overflow-auto rounded-xl border border-line bg-paper p-6 shadow-[0_24px_60px_-40px_rgba(0,0,0,0.9)] md:p-9">
            <div className="readme" dangerouslySetInnerHTML={{ __html: html }} />
          </article>
        </Reveal>

        <Reveal delay={80}>
          <div className="flex flex-col gap-3 lg:sticky lg:top-20">
            {SNIPPETS.map((s) => (
              <Snippet key={s.title} s={s} />
            ))}

            <div className="rounded-xl border border-amber/35 bg-amber/[0.07] p-4">
              <div className="flex items-center gap-2">
                <KeyRound size={13} className="text-amber" />
                <h4 className="font-display text-[14px] font-semibold text-amber">config surface</h4>
              </div>
              <ul className="mt-2.5 space-y-1.5 font-mono text-[11px] leading-relaxed text-sand-2/85">
                <li>edit <span className="text-sand">config.py</span> for permanent changes</li>
                <li>
                  <span className="text-amber">FXBOT_&lt;FIELD&gt;</span> env override for anything secret or per-run
                </li>
                <li>MT5 password / login / server are env-only — never committed</li>
                <li>invalid values raise <span className="text-rose">ValueError</span> at construction, not at the first order</li>
              </ul>
            </div>

            <div className={cx("rounded-xl border border-rose/40 bg-rose/[0.08] p-4")}>
              <div className="flex items-center gap-2">
                <AlertTriangle size={13} className="text-rose" />
                <h4 className="font-display text-[14px] font-semibold text-rose">risk warning</h4>
              </div>
              <p className="mt-2 text-[12.5px] leading-relaxed text-sand-2/85">
                Leveraged FX trading can lose more than your deposit. Backtests omit slippage, requotes,
                swap, weekend gaps and outages. Run on demo until you have watched a full week of ticks, keep{" "}
                <code className="rounded bg-panel px-1 py-0.5 font-mono text-[11px]">max_risk_per_trade</code> at
                1–2%, and treat this as engineering education — not advice.
              </p>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

export function Footer({ onOpenFile }: { onOpenFile: (n: string) => void }) {
  return (
    <footer className="border-t border-line bg-ink-2/70">
      <div className="mx-auto grid max-w-[1400px] gap-8 px-4 py-14 md:grid-cols-[1.3fr_1fr] md:px-7">
        <div>
          <h3 className="font-display text-[22px] leading-tight font-bold text-sand">
            Ship the bot, not the hope.
          </h3>
          <p className="mt-3 max-w-lg text-[13.5px] leading-relaxed text-muted">
            Nine Python modules, three dependencies, one risk gate. Read{" "}
            <button onClick={() => onOpenFile("risk_manager.py")} className="font-mono text-jade underline decoration-dotted underline-offset-4">
              risk_manager.py
            </button>{" "}
            first if you only have five minutes — it is the file that decides whether anything else gets to
            happen.
          </p>
          <div className="mt-5 flex flex-wrap gap-1.5">
            <Chip tone="jade">Python 3.10+</Chip>
            <Chip tone="sky">pandas · numpy</Chip>
            <Chip tone="amber">MetaTrader5</Chip>
            <Chip>UTC everywhere</Chip>
          </div>
        </div>
        <div className="rounded-xl border border-line bg-panel/50 p-4 font-mono text-[10.5px] leading-relaxed text-muted">
          <div className="text-sand-2">forex_bot/</div>
          {[
            "main.py",
            "config.py",
            "data_feed.py",
            "indicators.py",
            "strategy.py",
            "risk_manager.py",
            "broker.py",
            "backtester.py",
            "logger.py",
            "telegram_control.py",
            "requirements.txt",
            "README.md",
            "bot_state.json",
            "deploy/watchdog.py",
            "deploy/run_bot.cmd",
            "deploy/install-service.ps1",
            "deploy/forex-bot.service",
          ].map((f) => (
            <button
              key={f}
              onClick={() => onOpenFile(f.split("/").pop() as string)}
              className="block w-full text-left text-muted transition-colors hover:text-sky"
            >
              ├─ {f}
            </button>
          ))}
        </div>
      </div>
      <div className="border-t border-line/70 px-4 py-5 text-center font-mono text-[10px] tracking-wider text-line uppercase md:px-7">
        educational software · no warranty · not financial advice · trade a demo account
      </div>
    </footer>
  );
}
