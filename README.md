# Forex-bot

MetaTrader 5 algorithmic trading system (Python) with a web dashboard —
 multi-indicator confluence strategy, hard risk gates, backtester +
walk-forward validation, Telegram remote control, and a **🎲 GAMBLE
mode** that hunts exactly one A+ setup at a stake you cap in advance.

Full documentation: [`forex_bot/README.md`](forex_bot/README.md)

## Windows / PowerShell quickstart

Needs: Python 3.12 (64-bit, "Add to PATH"), Node.js LTS (dashboard only),
and MetaTrader 5 logged into a **demo** account for live/paper-terminal work.

```powershell
git clone https://github.com/callmekomen/Forex-bot.git
cd Forex-bot

powershell -ExecutionPolicy Bypass -File .\forex-bot.ps1 setup
.\forex-bot.ps1 test          # 97 tests, all green means the risk engine is sane
.\forex-bot.ps1 scan          # gamble ranking board — trades nothing
.\forex-bot.ps1 gamble -Stake 0.02    # hunt ONE A+ setup (paper, 2% max loss)
.\forex-bot.ps1 dashboard     # web UI with the big GAMBLE button
```

Paper-first by design: nothing reaches a terminal account unless you
pass `-Live` *and* type `LIVE` at the prompt — and the bot is
**demo-only**: it reads the MT5 account type at connect and refuses a
real-money account unless deliberately unlocked
(`FXBOT_ALLOW_REAL_ACCOUNT=1`, see `forex_bot/README.md` §3c).

## Test on your MT5 demo account

MT5 open and logged into a **$10,000 demo** (risk sizing uses
`config.account_balance`, so make the demo match), then:

```powershell
$env:FXBOT_MT5_LOGIN = '12345678'          # your demo login
$env:FXBOT_MT5_SERVER = 'YourBroker-Demo'  # exact name from MT5's Navigator

.\forex-bot.ps1 check                      # read-only preflight — places NO orders
.\forex-bot.ps1 scan -Live                 # ranking on real prices, still no trade
.\forex-bot.ps1 gamble -Live -Stake 0.005  # first demo gamble at a tiny 0.5% stake
```

`.\forex-bot.ps1 help` lists every command; `Get-Help .\forex-bot.ps1 -Full`
shows full help.

## Layout

| Path | What it is |
|---|---|
| `forex-bot.ps1` | PowerShell console: setup / test / scan / gamble / bot / api / dashboard |
| `forex_bot/` | The bot itself (strategy, risk manager, broker, gamble engine, tests) |
| `src/` | Vite + React dashboard (Trading Desk, Live Control, backtest/risk labs) |

> ⚠️ Leveraged FX trading can lose your deposit. This is software, not
> financial advice — no mode (including GAMBLE) guarantees profit.
> Demo-trade first; validate with the walk-forward tester before
> risking real money.
