# Forex Bot — MetaTrader 5 algorithmic trading system

A modular, risk-first FX trading bot for Python 3.10+. It pulls OHLCV data
from a running MetaTrader 5 terminal, scores five indicators into a single
confluence signal, and only then hands the idea to a hard risk gate before a
single order is sent.

```
data_feed  →  indicators  →  strategy  →  RISK MANAGER  →  broker  →  MT5
   (OHLCV)     (pure math)   (TradeSignal)   (gate + sizing)  (orders)
```

---

## 1. Prerequisites

| Requirement | Notes |
|---|---|
| **Windows 10/11 x64** | The `MetaTrader5` Python package is Windows-only. On Linux/macOS the bot still runs against the mock feed in **paper mode**. |
| **MetaTrader 5 terminal** | Installed, launched, and **logged in** to a demo account. `File → Auto Trading` must be enabled. |
| **Python 3.10 – 3.12 (64-bit)** | 32-bit interpreters cannot load the MT5 bridge. |
| **A broker symbol set** | The symbols in `config.pairs` must exist in that terminal's Market Watch (e.g. `EURUSD`, not `EUR/USD` — the slash is stripped automatically). |

> **Use a DEMO account.** Do not attach this code to a live account until you
> have watched it trade a full week on demo.

## 2. Installation

```bash
git clone <your-repo> && cd forex_bot
python -m venv .venv
.venv\Scripts\activate            # Windows  (source .venv/bin/activate on *nix)
pip install -r requirements.txt   # MetaTrader5, pandas, numpy
```

Verify the terminal bridge:

```bash
python -c "import MetaTrader5 as mt5; print(mt5.initialize()); print(mt5.terminal_info())"
```

## 3. Running the bot

```bash
python main.py                  # live loop against the logged-in MT5 terminal
python main.py --mock           # synthetic feed + simulated fills (no MT5 needed)
python main.py --once           # one analysis pass, then exit (smoke test)
python main.py --ticks 5        # five passes, then exit
python main.py --self-test      # risk-engine + indicator sanity checks
python main.py --pairs EUR/USD,GBP/USD --timeframe 15m
```

The loop does two things every `tick_interval` seconds (60 by default):

1. **Manage open positions** — detect broker-side stop/target fills, book the
   realised P&L into the risk manager, resync SL/TP if the terminal drifted.
2. **Analyse each pair** — fetch 200 candles, score them, log the signal
   block, ask the risk manager, and only execute on an approval.

Every signal is logged like this (also in `bot.log`):

```
════════════════════════════════════
Signal for EUR/USD: STRONG_BUY
Price: 1.08523
SL: 1.08245  TP: 1.09079
Confidence: 0.78  (score +4.00, RR 2.00)
Reasons:
  EMA12 > EMA26 (uptrend);
  MACD histogram positive (0.00012);
  MACD bullish crossover (histogram flipped +);
  RSI oversold (28.3);
  Strong trend (ADX=31.2)
════════════════════════════════════
```

The loop is deliberately stubborn: if the terminal is closed, the market is
shut, or a data call throws, the tick is logged, the feed is flagged
disconnected, and the bot retries every `connect_retry_seconds` (30) until it
recovers. It never quits on its own and never trades while a halt is latched.

Stop it with `Ctrl+C` — the feed is shut down cleanly and the final state is
saved. To stop after a bounded run instead, use `--once` or `--ticks N`.

## 4. Backtesting

```bash
python backtester.py --pair EUR/USD --bars 4000 --spread 1.5
python backtester.py --pair GBP/USD --timeframe 15m --exact --csv trades.csv
python main.py --backtest            # every configured pair + portfolio summary
```

The backtester replays history bar-by-bar with the *production* strategy:

* first 50 bars are skipped (indicator warm-up),
* a bar that touches both stop and target is charged to the **stop**,
* entries fill on the **next bar's open** (no look-ahead),
* a fixed `spread_pips` cost (default 1.5) is deducted per round trip.

Reported metrics: `total_trades`, `win_rate`, `total_pnl`, `total_return`,
`avg_win`, `avg_loss`, `profit_factor`, `max_drawdown`, `sharpe_ratio`
(annualised), `largest_win/loss`, `avg_risk_reward`, `expectancy`.

## 5. Configuration (`config.py`)

Everything lives in the `BotConfig` dataclass — edit the defaults, or override
a field with the environment variable `FXBOT_<FIELD>` (uppercase), e.g.
`FXBOT_MAX_RISK_PER_TRADE=0.01`. MT5 credentials are read from
`FXBOT_MT5_LOGIN`, `FXBOT_MT5_PASSWORD`, `FXBOT_MT5_SERVER`
(leave them unset to reuse the terminal that is already logged in).

| Group | Field | Default | Meaning |
|---|---|---|---|
| Universe | `pairs` | `EUR/USD, GBP/USD, USD/JPY` | Instruments scanned each tick |
| Account | `account_balance` / `lot_size` / `leverage` | `10000.0 / 0.01 / 100` | Starting equity & broker base lot |
| Risk | `max_risk_per_trade` | `0.02` | Max **2 %** of equity at risk per trade |
| Risk | `max_daily_loss` | `0.05` | **5 %** realised loss → halt until next UTC day |
| Risk | `max_open_positions` | `3` | Concurrent exposure cap |
| Risk | `max_drawdown_limit` | `0.15` | **15 %** peak-to-trough → sticky halt |
| Risk | `pip_value` / `pip_size` | `10.0 / 0.0001` | Cash per pip per standard lot (JPY pairs auto-detect `0.01`) |
| Strategy | `fast_ema / slow_ema / signal_ema` | `12 / 26 / 9` | EMA + MACD lengths |
| Strategy | `rsi_period / rsi_overbought / rsi_oversold` | `14 / 70 / 30` | RSI settings |
| Strategy | `atr_period / atr_multiplier / take_profit_multiplier` | `14 / 1.5 / 3.0` | SL = 1.5 × ATR, TP = 3 × ATR → **1 : 2 RR** |
| Strategy | `min_confidence` | `0.6` | Signals below this are rejected |
| Schedule | `timeframe` | `1h` | `1m 5m 15m 1h 4h 1d` |
| Schedule | `tick_interval` | `60` | Seconds between passes |
| Hours | `start_hour / end_hour` | `7 / 20` | Trade only inside this **UTC** window |

## 6. The risk gate (why no trade skips it)

`RiskManager.can_trade()` is evaluated **before** sizing and again inside
`validate_trade()`, which checks in order: global gate → confidence ≥ 0.6 →
reward:risk ≥ 1.5 → duplicate pair → fixed-fractional sizing → realised-risk
cap. Lots are only ever **reduced**:

```
pips          = |entry − stop| / pip_size
max_risk_usd  = balance × max_risk_per_trade
lots          = floor_to_0.01( max_risk_usd / (pips × pip_value) )
```

No martingale, no grid recovery, no averaging down. If the stop is too wide to
fit the risk budget at 0.01 lots, the trade is skipped, not enlarged.

State (daily P&L, balance, peak, open positions, halt flag, trade log) is
written atomically to `bot_state.json` after every change, so a crash or a
restart cannot forget that the circuit-breaker tripped. Delete the file (or
call `RiskManager.reset_halt()`) to clear a sticky drawdown halt — do that only
after a human has reviewed the trading.

## 7. Files

| File | Responsibility |
|---|---|
| `main.py` | `ForexBot` tick loop, CLI, banner, graceful shutdown |
| `config.py` | `BotConfig` dataclass + validation |
| `data_feed.py` | MT5 candles/ticks, timeframe map, `MockDataFeed` for tests |
| `indicators.py` | EMA, SMA, RSI, ATR, MACD, Bollinger, Stochastic, ADX (pure static methods) |
| `strategy.py` | Weighted confluence scoring → `TradeSignal` |
| `risk_manager.py` | Sizing, loss/drawdown halts, hours filter, JSON state |
| `broker.py` | `order_send` with `magic=123456`, SL/TP, closes, position sync |
| `backtester.py` | Bar-by-bar replay + performance metrics |
| `logger.py` | Console + rotating `bot.log` / `errors.log` |
| `bot_state.json` | Auto-created persisted state |

## 8. Testing / extending

```python
from config import BotConfig
from data_feed import MockDataFeed
from strategy import AdvancedStrategy

cfg  = BotConfig(pairs=["EUR/USD"])
feed = MockDataFeed(cfg, bars=600, seed=42)      # deterministic
sig  = AdvancedStrategy(cfg).analyze(feed.get_candles("EUR/USD", 300), "EUR/USD")
```

`ForexBot(config=..., feed=..., broker=...)` accepts any object implementing
`get_candles` / `get_latest_tick`, so the loop can be unit-tested without MT5
entirely. `python main.py --self-test` runs the built-in checks.

---

## 9. Remote control from Telegram (optional)

Adds one file — `telegram_control.py` — and no new dependencies (it talks to the
Bot API with `urllib`).

```bash
# 1. @BotFather → /newbot → token.  2. /setprivacy → Disable (optional, for groups)
set FXBOT_TELEGRAM_TOKEN=123456789:AA...
set FXBOT_TELEGRAM_CHAT_IDS=734112288        # comma separated
set FXBOT_MT5_LOGIN=12345678                  # the account you intend to trade
python main.py --remote                       # connects, verifies, then WAITS
```

`--remote` starts the loop **armed but paused**: nothing is analysed and no order is sent
until you message `/start`.

| Command | Effect | Bypasses risk? |
|---|---|---|
| `/start` `/stop` | arm or stop the tick loop (stop is graceful — current tick finishes) | no |
| `/status` | equity, peak, day P&L, drawdown, win rate, open count, halt flag, account fingerprint | no |
| `/positions` | the bot's own tickets with SL/TP (magic-filtered) | no |
| `/close <ticket\|all>` | flatten through the broker, P&L booked by the risk manager | no |
| `/halt` `/resume` | latch / clear the halt flag (persisted to `bot_state.json`) | no |
| `/risk` `/pairs` `/id` | read-only introspection | — |

**Security model — fail closed.**

* A command is honoured only if its `chat_id` is in `telegram_chat_ids`. Everyone else gets a
  refusal and a `SECURITY WARNING` line in `errors.log`.
* With an empty allowlist the bot prints a one-time 6-digit code at boot; you send
  `/pair 483920` from the chat you want to trust. The code is then rotated.
* Per-chat rate limit: 30 commands/minute, 350 ms floor.
* There is deliberately **no** `/buy`, `/sell`, `/lots` or `/disable_risk`. Telegram can
  stop things, never start a trade that the risk manager has not approved.
* Long-polling (no public webhook, no open port). Swap `HttpApi` for a webhook handler if
  you already serve TLS — the dispatcher is unchanged.

## 10. Deploying it

The bot is a **console process that must stay alive and stay signed in to MT5**,
which means a Windows box, not a Heroku dyno. Split it in your head:

| Piece | Where it runs | Why |
|---|---|---|
| tick loop (`main.py`) | **Windows VPS** near your broker (1–5 ms ping), logged into the MT5 terminal | `MetaTrader5` is Windows-only and needs a running terminal process |
| research / backtests | anywhere — your laptop, a Linux box | pandas + numpy only |
| this dashboard | any static host (Netlify, Pages, S3, nginx) | `npm run build` emits one self-contained `dist/index.html` |

### 10.1 The loop, on a Windows VPS

1. Buy a small Windows VPS (2 vCPU / 4 GB is plenty), open the firewall for nothing —
   the bot makes no inbound connections.
2. Install **Python 3.10–3.12 x64** and the **broker's MT5 terminal**. Log into the demo
   account, enable `File → Auto Trading`, and tick *"launch on startup"* in the terminal.
3. `git clone` → `cd forex_bot` → `python -m venv .venv` → `.venv\Scripts\activate` →
   `pip install -r requirements.txt`.
4. Edit `deploy/run_bot.cmd`: set `FXBOT_MT5_LOGIN`, `FXBOT_MT5_SERVER`, the token and your
   chat id. That is the file that pins **which account** this bot may touch.
5. Dry run in front of you: `python main.py --self-test`, then `python main.py --mock --once`,
   then `python main.py --remote` and send `/start`.
6. Register autostart (elevated PowerShell):
   `powershell -ExecutionPolicy Bypass -File deploy\install-service.ps1`
   It runs the self-test first and refuses to register a bot that fails it.
7. Watch it once so you trust it: `Get-Content .\bot.log -Wait -Tail 40`.
8. Reboot the VPS. Confirm the task came back and `bot_state.json` restored your halt flags.

`deploy\watchdog.py` is what the task actually runs: it restarts a dead `main.py` with
backoff, gives up after 6 restarts in an hour and messages you instead of flapping
forever, and can kill a wedged process when `bot.log` goes silent (`--stale 300`;
leave it `0` while you use `--remote`, since a paused loop is intentionally quiet).

### 10.2 Secrets and updates

* Secrets live in the environment (`deploy/.env.example` is the template — never commit the
  real one). Nothing in `config.py` should ever contain a password.
* Update flow: `python main.py --self-test` → stop the task → `git pull` →
  `pip install -r requirements.txt` → start the task → check `/status`.
* Rollback: `git checkout <tag>` and restart. `bot_state.json` is the one file you must not
  lose — copy it off the box nightly (it is your halt memory and trade log).
* Keep `bot.log` / `errors.log` on the box (rotated at 10 MB) and pull them weekly; the
  dashboard is a viewer, not a database.

### 10.3 The dashboard

`npm run build` produces `dist/index.html` — a single file with the CSS, JS and the whole
annotated source inlined. Drop it on Netlify / Vercel / GitHub Pages / `s3 cp --acl
public-read` / `nginx root /var/www/forex_bot`, or just open the file locally. No API keys,
no server, nothing that can trade — it is documentation plus an in-browser simulation, so
it is safe to make it public.

## 11. Using it from a phone

**Control and monitoring: yes. The loop itself: never.**

| On the phone | On the Windows box |
|---|---|
| `/start` `/stop` `/status` `/positions` `/close <ticket\|all>` `/halt` `/resume` `/risk` | the tick loop, the MT5 terminal, `watchdog.py`, `bot.log`, `bot_state.json` |
| unsolicited push of every fill and close (`telegram_notify`) | account-mismatch check, risk gate, position sizing |

Why the loop cannot live on the phone: `MetaTrader5` has no iOS/Android binding, and mobile OSes
freeze or throttle background processes (iOS suspends you the moment you swipe away, Android's Doze
does it gradually) — a tick loop that stops mid-analysis is worse than one that never started. Termux can
run pandas, but never MT5.

Nothing depends on the phone being alive: exposure is protected by the **broker-side SL/TP attached to
every fill**, and a latched halt is remembered in `bot_state.json`. A dead battery, a dropped call or a
lost phone costs you a command, never a position. A stolen phone costs you at most an unauthorised
`/halt` — `/start` is not enough without the pairing code printed on the server.

Optional hardening (recommended before live money): a heartbeat rule in the watchdog — *if the feed has
been stale for N minutes while a position is open, flatten and shout*. Then the phone is genuinely
optional, which is exactly where a remote control belongs.

## 12. ⚠️ Risk warning

Leveraged foreign-exchange trading can result in losses that exceed your
initial deposit and is not suitable for all investors. This repository is
provided for education and research **only** — it is not investment advice, not
a signal service, and not a promise of profit. Live markets include slippage,
requotes, negative swap, weekend gaps, broker downtime and data errors that a
backtest cannot reproduce. You are solely responsible for every order your
machine sends. Trade a demo account first, never risk money you can afford to
lose, and keep `max_risk_per_trade` small (≤ 1 %).
