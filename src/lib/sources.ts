// Single source of truth: the Python files themselves, imported raw by Vite.
import mainPy from "../../forex_bot/main.py?raw";
import configPy from "../../forex_bot/config.py?raw";
import dataFeedPy from "../../forex_bot/data_feed.py?raw";
import indicatorsPy from "../../forex_bot/indicators.py?raw";
import strategyPy from "../../forex_bot/strategy.py?raw";
import riskManagerPy from "../../forex_bot/risk_manager.py?raw";
import brokerPy from "../../forex_bot/broker.py?raw";
import backtesterPy from "../../forex_bot/backtester.py?raw";
import telegramPy from "../../forex_bot/telegram_control.py?raw";
import loggerPy from "../../forex_bot/logger.py?raw";
import requirementsTxt from "../../forex_bot/requirements.txt?raw";
import botStateJson from "../../forex_bot/bot_state.json?raw";
import readmeMd from "../../forex_bot/README.md?raw";
import watchdogPy from "../../forex_bot/deploy/watchdog.py?raw";
import runBotCmd from "../../forex_bot/deploy/run_bot.cmd?raw";
import installPs1 from "../../forex_bot/deploy/install-service.ps1?raw";
import serviceUnit from "../../forex_bot/deploy/forex-bot.service?raw";

export type Lang = "python" | "json" | "text" | "markdown";

export interface SourceFile {
  /** Display name, matching the repo layout. */
  name: string;
  /** Path shown in the file tree. */
  path: string;
  /** One-line responsibility shown above the listing. */
  role: string;
  /** Longer note about what to look at in this file. */
  note: string;
  /** highlight.js language id. */
  lang: Lang;
  /** Emoji-free lucide icon key. */
  icon: string;
  /** Group label used in the tree. */
  group: "runtime" | "engine" | "execution" | "research" | "project" | "deploy";
  /** Raw file contents. */
  code: string;
}

const loc = (s: string) => s.split("\n").length;

export const FILES: SourceFile[] = [
  {
    name: "config.py",
    path: "forex_bot/config.py",
    role: "BotConfig dataclass — every tunable parameter, validated once",
    note: "Risk limits, indicator lengths, UTC session window and pip geometry all live here so no module can drift. Fields can be overridden with FXBOT_<FIELD> env vars.",
    lang: "python",
    icon: "sliders",
    group: "project",
    code: configPy,
  },
  {
    name: "main.py",
    path: "forex_bot/main.py",
    role: "ForexBot tick loop, CLI, banner, graceful shutdown",
    note: "Two steps per tick: manage open exposure, then scan each pair. Note the risk-warning header and that feed/broker are injectable for tests.",
    lang: "python",
    icon: "play",
    group: "runtime",
    code: mainPy,
  },
  {
    name: "risk_manager.py",
    path: "forex_bot/risk_manager.py",
    role: "The gatekeeper: sizing, circuit breakers, durable state",
    note: "can_trade() → calculate_position_size() → validate_trade(). Lots are only ever reduced. State is written atomically to bot_state.json after every change.",
    lang: "python",
    icon: "shield",
    group: "engine",
    code: riskManagerPy,
  },
  {
    name: "strategy.py",
    path: "forex_bot/strategy.py",
    role: "Weighted confluence scoring → TradeSignal",
    note: "Five voting indicators, ADX as a confidence dampener, ATR stops at a fixed 1:2 risk-reward. analyze() attaches indicators; from_enriched() is the shared path the backtester replays.",
    lang: "python",
    icon: "brain",
    group: "engine",
    code: strategyPy,
  },
  {
    name: "indicators.py",
    path: "forex_bot/indicators.py",
    role: "Pure static indicator maths (EMA, RSI, ATR, MACD, BB, Stoch, ADX)",
    note: "No side effects, no I/O. attach() computes the whole indicator frame in one vectorised pass so a backtest stays fast.",
    lang: "python",
    icon: "activity",
    group: "engine",
    code: indicatorsPy,
  },
  {
    name: "data_feed.py",
    path: "forex_bot/data_feed.py",
    role: "MT5 candles + ticks, timeframe map, injectable MockDataFeed",
    note: "Every failure raises DataFeedError with an actionable message. MockDataFeed satisfies the same protocol, so tests and CI need no terminal.",
    lang: "python",
    icon: "satellite",
    group: "execution",
    code: dataFeedPy,
  },
  {
    name: "broker.py",
    path: "forex_bot/broker.py",
    role: "order_send with magic=123456, SL/TP, closes, position sync",
    note: "Builds the MT5 request dict, checks retcode 10009, and degrades to simulated fills (paper mode) wherever the terminal binding is missing.",
    lang: "python",
    icon: "zap",
    group: "execution",
    code: brokerPy,
  },
  {
    name: "backtester.py",
    path: "forex_bot/backtester.py",
    role: "Bar-by-bar replay + 18 performance metrics",
    note: "Entries fill on the next bar's open, a bar touching both stop and target is charged to the stop, spread is deducted per round trip. `python backtester.py --pair EUR/USD` prints the report.",
    lang: "python",
    icon: "flask",
    group: "research",
    code: backtesterPy,
  },
  {
    name: "telegram_control.py",
    path: "forex_bot/telegram_control.py",
    role: "Remote start/stop/status over the Telegram Bot API — stdlib only",
    note: "Fail-closed on identity: an inbound command is honoured only when its chat_id is allowlisted, and no verb here can size a trade or bypass the risk manager. Includes one-time /pair code, per-chat rate limiting, and a watcher that pushes fills and closes.",
    lang: "python",
    icon: "send",
    group: "execution",
    code: telegramPy,
  },
  {
    name: "logger.py",
    path: "forex_bot/logger.py",
    role: "Console + rotating bot.log / errors.log (10 MB)",
    note: "Idempotent setup so multiple modules can request the same logger without duplicating handlers; a read-only log dir downgrades to console instead of crashing.",
    lang: "python",
    icon: "terminal",
    group: "runtime",
    code: loggerPy,
  },
  {
    name: "watchdog.py",
    path: "forex_bot/deploy/watchdog.py",
    role: "Supervisor: restart with backoff, stale-kill, Telegram alert on death",
    note: "Gives up after 6 restarts in an hour and messages you instead of flapping. Reads bot.log mtime for wedged-process detection; leave --stale 0 when you run --remote, because a paused loop is quiet on purpose.",
    lang: "python",
    icon: "activity",
    group: "deploy",
    code: watchdogPy,
  },
  {
    name: "run_bot.cmd",
    path: "forex_bot/deploy/run_bot.cmd",
    role: "Windows entry point — env vars, self-test, then the supervised loop",
    note: "The FXBOT_MT5_LOGIN line is what pins which account may be traded. Refuses to start if --self-test fails.",
    lang: "text",
    icon: "terminal",
    group: "deploy",
    code: runBotCmd,
  },
  {
    name: "install-service.ps1",
    path: "forex_bot/deploy/install-service.ps1",
    role: "Register / remove the Task Scheduler autostart entry",
    note: "Runs the risk self-test before registering, restarts on failure, and reminds you that the MT5 terminal itself must launch at boot. -Uninstall to remove.",
    lang: "text",
    icon: "terminal",
    group: "deploy",
    code: installPs1,
  },
  {
    name: "forex-bot.service",
    path: "forex_bot/deploy/forex-bot.service",
    role: "systemd unit for the cross-platform half (research, alerts)",
    note: "Hardened: NoNewPrivileges, ProtectSystem=full, MemoryMax, secrets via EnvironmentFile. MT5 still needs Windows — see the comment at the top.",
    lang: "text",
    icon: "database",
    group: "deploy",
    code: serviceUnit,
  },
  {
    name: "bot_state.json",
    path: "forex_bot/bot_state.json",
    role: "Persisted state — survives restarts and crashes",
    note: "Auto-created and rewritten after every fill, close and halt. This is why a restart cannot forget that the daily-loss breaker tripped.",
    lang: "json",
    icon: "database",
    group: "runtime",
    code: botStateJson,
  },
  {
    name: "requirements.txt",
    path: "forex_bot/requirements.txt",
    role: "Three dependencies — that is the whole footprint",
    note: "MetaTrader5 is Windows-only; on other platforms the bot runs against MockDataFeed in paper mode.",
    lang: "text",
    icon: "package",
    group: "project",
    code: requirementsTxt,
  },
  {
    name: "README.md",
    path: "forex_bot/README.md",
    role: "Setup, run, backtest, configuration table, risk warning",
    note: "Written for someone who has never seen the repo: prerequisites, verification command, every config field, and an explicit disclaimer.",
    lang: "markdown",
    icon: "book",
    group: "project",
    code: readmeMd,
  },
];

export const README_MARKDOWN = readmeMd;

export interface FileMeta extends SourceFile {
  lines: number;
  bytes: number;
}

export const FILES_META: FileMeta[] = FILES.map((f) => ({
  ...f,
  lines: loc(f.code),
  bytes: new Blob([f.code]).size,
}));

export const TOTAL_LINES = FILES.filter((f) => f.lang === "python").reduce(
  (sum, f) => sum + loc(f.code),
  0,
);

export const TOTAL_BYTES = FILES.reduce((s, f) => s + new Blob([f.code]).size, 0);
