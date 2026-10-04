@echo off
REM ─────────────────────────────────────────────────────────────────
REM  run_bot.cmd — start the forex bot on Windows, straight from boot
REM  or from Task Scheduler / NSSM. Edit the FXBOT_* lines (or delete them
REM  and use "setx /M" / a secret store), then:  run_bot.cmd
REM ─────────────────────────────────────────────────────────────────
setlocal
cd /d "%~dp0.."

REM ── account binding: the bot refuses to trade if the terminal disagrees
set FXBOT_MT5_LOGIN=12345678
set FXBOT_MT5_SERVER=Broker-Demo
REM set FXBOT_MT5_PASSWORD=            <- prefer leaving unset; use the logged-in terminal

REM ── remote control
set FXBOT_TELEGRAM_TOKEN=123456789:AAChangeMe
set FXBOT_TELEGRAM_CHAT_IDS=734112288

REM ── risk knobs (env overrides config.py)
set FXBOT_MAX_RISK_PER_TRADE=0.01
set FXBOT_LOG_LEVEL=INFO

if exist ".venv\Scripts\python.exe" (
  set PY=.venv\Scripts\python.exe
) else (
  set PY=python
)

echo [run_bot] pre-flight self-test...
%PY% main.py --self-test || (echo [run_bot] self-test FAILED - not starting & exit /b 1)

echo [run_bot] starting supervised loop
%PY% deploy\watchdog.py --stale 0 -- main.py %*
endlocal
