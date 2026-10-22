<#
.SYNOPSIS
    Forex Bot - PowerShell control script (setup, test, GAMBLE, run, dashboard).

.DESCRIPTION
    One entry point for the whole system on Windows (PowerShell 5.1 or 7):

      .\forex-bot.ps1 setup        create forex_bot\.venv, install deps, self-test
      .\forex-bot.ps1 test         run the full pytest suite + risk self-test
      .\forex-bot.ps1 scan         gamble ranking board only - trades NOTHING
      .\forex-bot.ps1 gamble       hunt ONE A+ setup and take it (paper by default)
      .\forex-bot.ps1 status       today's gamble budget / lockout state
      .\forex-bot.ps1 bot          run the trading loop (paper/mock unless -Live)
      .\forex-bot.ps1 api          start the HTTP control plane on port 8787
      .\forex-bot.ps1 dashboard    API in a new window + web dashboard + browser
      .\forex-bot.ps1 backtest     backtester over every configured pair

    Paper-first: nothing touches a real MT5 account unless you pass -Live,
    and -Live still asks you to type LIVE (use a DEMO account). The gamble
    stake is hard-capped at 5% by gamble.py / risk_manager.py regardless
    of what is passed here.

    If Windows refuses to run the script ("cannot be loaded because
    running scripts is disabled"), allow it for your user once:

      Set-ExecutionPolicy -Scope CurrentUser RemoteSigned

    or run it one-off with:

      powershell -ExecutionPolicy Bypass -File .\forex-bot.ps1 setup

.PARAMETER Command
    setup | test | scan | gamble | status | bot | api | dashboard | backtest | help

.PARAMETER Stake
    Gamble stake as a fraction of equity (0.02 = 2%, max 0.05).

.PARAMETER Live
    Use the real MT5 terminal instead of paper. Prompts for confirmation.

.PARAMETER Force
    Skip the -Live confirmation prompt (for scheduled runs you trust).

.PARAMETER Once
    With 'bot': run a single tick and exit.

.PARAMETER Ticks
    With 'bot': run exactly N ticks and exit (0 = run until Ctrl+C).

.PARAMETER Port
    Port for the API control plane (default 8787).

.PARAMETER Pairs
    Optional comma-separated pair override, e.g. "EUR/USD,GBP/USD".

.EXAMPLE
    .\forex-bot.ps1 setup
    .\forex-bot.ps1 test
    .\forex-bot.ps1 scan
    .\forex-bot.ps1 gamble -Stake 0.02
    .\forex-bot.ps1 dashboard
    .\forex-bot.ps1 bot -Once

.NOTES
    Requires: Python 3.10-3.12 (64-bit) from python.org ("Add to PATH"
    ticked), and Node.js LTS for the dashboard only.
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('setup', 'test', 'scan', 'gamble', 'status', 'bot', 'api', 'dashboard', 'backtest', 'help')]
    [string]$Command = 'help',

    [double]$Stake = 0.02,
    [switch]$Live,
    [switch]$Force,
    [switch]$Once,
    [int]$Ticks = 0,
    [int]$Port = 8787,
    [string]$Pairs = '',

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

$ErrorActionPreference = 'Stop'
# Native tools signal failure via $LASTEXITCODE, which this script checks
# explicitly. Stops PS 7.3+ from turning every non-zero exit into a throw.
if (Get-Variable 'PSNativeCommandUseErrorActionPreference' -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}

$RepoRoot = $PSScriptRoot
if (-not $RepoRoot) { $RepoRoot = (Get-Location).Path }
$BotDir = Join-Path $RepoRoot 'forex_bot'
$IsWindowsOS = [Environment]::OSVersion.Platform -eq 'Win32NT'

function Write-Banner {
    Write-Host ''
    Write-Host '====================================================' -ForegroundColor DarkCyan
    Write-Host '  FOREX BOT - PowerShell console' -ForegroundColor Cyan
    Write-Host "  repo : $RepoRoot"
    Write-Host '====================================================' -ForegroundColor DarkCyan
}

function Get-BasePython {
    # Returns @{ Exe = 'py'; Pre = @('-3.12') } style invocation, or $null.
    # Probing interpreters means running commands that are EXPECTED to fail
    # sometimes, so error handling is relaxed inside here.
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        foreach ($cand in @(
            @{ Exe = 'py'; Pre = @('-3.12') },
            @{ Exe = 'py'; Pre = @('-3.11') },
            @{ Exe = 'py'; Pre = @('-3') },
            @{ Exe = 'python'; Pre = @() },
            @{ Exe = 'python3'; Pre = @() }
        )) {
            $found = Get-Command $cand.Exe -ErrorAction SilentlyContinue
            if ($found) {
                & $cand.Exe @($cand.Pre) '-c' 'import sys; assert sys.version_info >= (3, 10)' 2>$null
                if ($LASTEXITCODE -eq 0) { return $cand }
            }
        }
        return $null
    } finally {
        $ErrorActionPreference = $saved
    }
}

function Get-VenvPython {
    $candidates = @()
    if ($IsWindowsOS) {
        $candidates += Join-Path $BotDir '.venv\Scripts\python.exe'
        $candidates += Join-Path $RepoRoot '.venv\Scripts\python.exe'
    } else {
        $candidates += Join-Path $BotDir '.venv/bin/python'
        $candidates += Join-Path $RepoRoot '.venv/bin/python'
    }
    foreach ($c in $candidates) {
        if (Test-Path $c) { return @{ Exe = $c; Pre = @() } }
    }
    return $null
}

function Get-Python {
    $venv = Get-VenvPython
    if ($venv) { return $venv }
    $base = Get-BasePython
    if ($base) { return $base }
    throw 'No Python 3.10+ found. Install 64-bit Python 3.12 from https://www.python.org/downloads/ and tick "Add python.exe to PATH", then run: .\forex-bot.ps1 setup'
}

function Invoke-Python {
    # Runs python with output STREAMING to your console (never captured:
    # in PowerShell, "$x = Some-Function" swallows native stdout into $x).
    # Callers read the result from $LASTEXITCODE right after this returns.
    param([Parameter(Mandatory = $true)][string[]]$PyArgs, [string]$WorkingDir = $BotDir)
    $py = Get-Python
    Push-Location $WorkingDir
    try {
        & $py.Exe @($py.Pre) @PyArgs
    } finally {
        Pop-Location
    }
}

function Confirm-Live {
    param([string]$What)
    if (-not $Live) { return }
    if ($Force) { return }
    Write-Host ''
    Write-Host "WARNING: -Live makes $What use the REAL MT5 terminal account." -ForegroundColor Red
    Write-Host 'Make sure the terminal is logged into a DEMO account first.' -ForegroundColor Yellow
    $answer = Read-Host 'Type LIVE to continue (anything else cancels)'
    if ($answer -ne 'LIVE') { throw 'Cancelled by operator. Nothing was started.' }
}

function Test-Stake {
    if ($Stake -le 0 -or $Stake -gt 0.05) {
        throw "Stake must be in (0, 0.05] - a gamble may never risk more than 5% of equity. Got: $Stake"
    }
}

function Format-Stake {
    return $Stake.ToString([Globalization.CultureInfo]::InvariantCulture)
}

# ---------------------------------------------------------------- commands

function Invoke-Setup {
    Write-Host '[setup] locating Python 3.10+ (64-bit)...' -ForegroundColor Cyan
    $base = Get-BasePython
    if (-not $base) {
        throw 'No Python 3.10+ found. Install 64-bit Python 3.12 from https://www.python.org/downloads/ and tick "Add python.exe to PATH", then re-run setup.'
    }
    $versionLine = & $base.Exe @($base.Pre) '-c' 'import sys, struct; print(sys.version.split()[0] + " " + str(struct.calcsize("P") * 8) + "-bit")'
    Write-Host "[setup] python $versionLine"
    if ($versionLine -notlike '*64-bit*') {
        Write-Host '[setup] WARNING: this Python is not 64-bit - the MetaTrader5 package will not load. Paper mode will still work.' -ForegroundColor Yellow
    }

    $venvDir = Join-Path $BotDir '.venv'
    if (-not (Get-VenvPython)) {
        Write-Host "[setup] creating virtual environment at $venvDir ..." -ForegroundColor Cyan
        & $base.Exe @($base.Pre) '-m' 'venv' $venvDir
        if ($LASTEXITCODE -ne 0) { throw 'venv creation failed' }
    } else {
        Write-Host '[setup] virtual environment already exists - reusing it' -ForegroundColor DarkGray
    }
    $py = Get-Python

    Write-Host '[setup] installing dependencies (MetaTrader5, pandas, numpy)...' -ForegroundColor Cyan
    & $py.Exe '-m' 'pip' 'install' '--upgrade' 'pip' '--quiet'
    & $py.Exe '-m' 'pip' 'install' '-r' (Join-Path $BotDir 'requirements.txt')
    if ($LASTEXITCODE -ne 0) {
        Write-Host '[setup] full install failed (often the MetaTrader5 wheel) - falling back to paper-mode deps' -ForegroundColor Yellow
        & $py.Exe '-m' 'pip' 'install' 'pandas' 'numpy'
        if ($LASTEXITCODE -ne 0) { throw 'pip install failed' }
    }
    Write-Host '[setup] installing pytest (test suite)...' -ForegroundColor Cyan
    & $py.Exe '-m' 'pip' 'install' 'pytest' '--quiet'

    Write-Host '[setup] running the risk-engine self-test...' -ForegroundColor Cyan
    Invoke-Python -PyArgs @('main.py', '--self-test')
    if ($LASTEXITCODE -ne 0) { throw 'self-test FAILED - do not trade until this passes' }

    if ($IsWindowsOS) {
        Write-Host '[setup] checking the MetaTrader5 bridge (needs a logged-in MT5 terminal)...' -ForegroundColor Cyan
        $saved = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        & $py.Exe '-c' 'import MetaTrader5 as mt5; ok = mt5.initialize(); print("[setup] MT5 initialize:", ok); print("[setup] terminal:", mt5.terminal_info()); mt5.shutdown()'
        $mt5Code = $LASTEXITCODE
        $ErrorActionPreference = $saved
        if ($mt5Code -ne 0) {
            Write-Host '[setup] MetaTrader5 package/terminal not reachable yet - fine for paper mode. For live: install MT5, log into a DEMO account, enable AutoTrading.' -ForegroundColor Yellow
        }
    }

    Write-Host ''
    Write-Host '[setup] DONE. Next steps:' -ForegroundColor Green
    Write-Host '  .\forex-bot.ps1 test        run all tests'
    Write-Host '  .\forex-bot.ps1 scan        see the gamble ranking (trades nothing)'
    Write-Host '  .\forex-bot.ps1 gamble      hunt ONE A+ setup in paper mode'
    Write-Host '  .\forex-bot.ps1 dashboard   web UI with the big GAMBLE button'
}

function Invoke-Test {
    $py = Get-Python
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $py.Exe '-m' 'pytest' '--version' 2>$null | Out-Null
    $hasPytest = $LASTEXITCODE -eq 0
    $ErrorActionPreference = $saved
    if (-not $hasPytest) {
        Write-Host '[test] pytest not installed - installing...' -ForegroundColor Cyan
        & $py.Exe '-m' 'pip' 'install' 'pytest' '--quiet'
        if ($LASTEXITCODE -ne 0) { throw 'pytest install failed' }
    }
    Write-Host '[test] full test suite...' -ForegroundColor Cyan
    Invoke-Python -PyArgs @('-m', 'pytest', 'forex_bot/tests', '-q') -WorkingDir $RepoRoot
    if ($LASTEXITCODE -ne 0) { throw '[test] FAILURES - see output above' }
    Write-Host '[test] risk-engine self-test...' -ForegroundColor Cyan
    Invoke-Python -PyArgs @('main.py', '--self-test')
    if ($LASTEXITCODE -ne 0) { throw '[test] self-test FAILED' }
    Write-Host '[test] ALL GREEN' -ForegroundColor Green
}

function Get-GambleArgs {
    param([switch]$ScanOnly)
    $a = @('gamble.py')
    if ($ScanOnly) { $a += '--scan-only' }
    if ($Live) { $a += '--live' }
    $a += @('--risk', (Format-Stake))
    if ($Pairs) { $a += @('--pairs', $Pairs) }
    if ($Rest) { $a += $Rest }
    return $a
}

function Invoke-Scan {
    Test-Stake
    Write-Host '[scan] ranking every pair - this trades NOTHING' -ForegroundColor Cyan
    Invoke-Python -PyArgs (Get-GambleArgs -ScanOnly)
}

function Invoke-Gamble {
    Test-Stake
    Confirm-Live -What 'the gamble'
    if ($Live) {
        Write-Host ("[gamble] LIVE hunt on the MT5 terminal - stake {0:P2} of equity (max loss), ONE A+ trade max" -f $Stake) -ForegroundColor Red
    } else {
        Write-Host ("[gamble] PAPER hunt (mock feed, simulated fills) - stake {0:P2} of equity, ONE A+ trade max. No A+ = no bet." -f $Stake) -ForegroundColor Cyan
    }
    Invoke-Python -PyArgs (Get-GambleArgs)
}

function Invoke-Status {
    Write-Host '[status] gamble ledger (today, UTC):' -ForegroundColor Cyan
    Invoke-Python -PyArgs @('gamble.py', '--status')
    $ledgerCode = $LASTEXITCODE
    try {
        $api = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/status" -TimeoutSec 3
        Write-Host ("[status] API bot: mode={0} running={1} balance={2} dayPnL={3} halted={4}" -f `
            $api.mode, $api.running, $api.risk.balance, $api.risk.daily_pnl, $api.risk.halted) -ForegroundColor Cyan
        $g = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/gamble" -TimeoutSec 3
        Write-Host ("[status] API gamble: phase={0} scans={1}/{2} reason={3}" -f $g.phase, $g.scans, $g.max_scans, $g.reason) -ForegroundColor Cyan
    } catch {
        Write-Host "[status] API not running on port $Port (start it with .\forex-bot.ps1 api) - ledger above is from disk" -ForegroundColor DarkGray
    }
    $global:LASTEXITCODE = $ledgerCode
}

function Invoke-Bot {
    Confirm-Live -What 'the bot loop'
    $botArgs = @('main.py')
    if (-not $Live) { $botArgs += '--mock' }
    if ($Once) { $botArgs += '--once' }
    elseif ($Ticks -gt 0) { $botArgs += @('--ticks', $Ticks.ToString()) }
    if ($Pairs) { $botArgs += @('--pairs', $Pairs) }
    if ($Rest) { $botArgs += $Rest }
    if ($Live) {
        Write-Host '[bot] starting against the real MT5 terminal - Ctrl+C to stop' -ForegroundColor Red
    } else {
        Write-Host '[bot] paper mode (mock feed, simulated fills) - Ctrl+C to stop' -ForegroundColor Cyan
    }
    Invoke-Python -PyArgs $botArgs
}

function Invoke-Api {
    $apiArgs = @('api_server.py', '--port', $Port.ToString())
    if ($Live) {
        Confirm-Live -What 'the API (live unlocked)'
        $env:FXBOT_API_ALLOW_LIVE = '1'
        $apiArgs += '--allow-live'
        Write-Host '[api] LIVE unlocked via --allow-live + FXBOT_API_ALLOW_LIVE=1 (still paper until Start Live is pressed)' -ForegroundColor Red
    }
    if ($Rest) { $apiArgs += $Rest }
    Write-Host "[api] control plane on http://127.0.0.1:$Port/api - Ctrl+C to stop" -ForegroundColor Cyan
    Invoke-Python -PyArgs $apiArgs
}

function Invoke-Dashboard {
    $npm = Get-Command 'npm' -ErrorAction SilentlyContinue
    if (-not $npm) {
        throw 'Node.js not found. Install Node.js LTS from https://nodejs.org/ (needed for the dashboard only - the bot and gamble CLI run without it).'
    }
    if (-not (Test-Path (Join-Path $RepoRoot 'node_modules'))) {
        Write-Host '[dashboard] first run - npm install...' -ForegroundColor Cyan
        Push-Location $RepoRoot
        try {
            & npm 'install'
            if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
        } finally {
            Pop-Location
        }
    }
    $apiUp = $false
    try {
        $null = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
        $apiUp = $true
    } catch { $apiUp = $false }

    if ($apiUp) {
        Write-Host "[dashboard] API already running on port $Port" -ForegroundColor DarkGray
    } elseif ($IsWindowsOS) {
        Write-Host '[dashboard] starting the bot API in a new PowerShell window...' -ForegroundColor Cyan
        $scriptPath = Join-Path $RepoRoot 'forex-bot.ps1'
        Start-Process powershell -ArgumentList @('-NoExit', '-ExecutionPolicy', 'Bypass', '-File', "`"$scriptPath`"", 'api', '-Port', $Port.ToString()) -WorkingDirectory $RepoRoot
    } else {
        Write-Host '[dashboard] start the API in a second terminal:  ./forex-bot.ps1 api' -ForegroundColor Yellow
    }

    if ($IsWindowsOS) {
        Start-Sleep -Seconds 3
        Write-Host '[dashboard] opening http://localhost:5173 in your browser...' -ForegroundColor Cyan
        Start-Process 'http://localhost:5173'
    }
    Write-Host '[dashboard] starting Vite dev server - Ctrl+C stops the dashboard (API window keeps running)' -ForegroundColor Cyan
    Push-Location $RepoRoot
    try {
        & npm 'run' 'dev' '--' '--port' '5173'
    } finally {
        Pop-Location
    }
}

function Invoke-Backtest {
    $btArgs = @('main.py', '--backtest')
    if ($Pairs) { $btArgs += @('--pairs', $Pairs) }
    if ($Rest) { $btArgs += $Rest }
    Invoke-Python -PyArgs $btArgs
}

function Show-Help {
    Write-Host @'

Usage:  .\forex-bot.ps1 <command> [options]

Commands:
  setup       create venv + install everything + self-test   (run this first)
  test        full pytest suite + risk self-test
  scan        gamble ranking board - trades NOTHING
  gamble      hunt ONE A+ setup, take it at -Stake (paper unless -Live)
  status      gamble budget/lockout + API bot status if running
  bot         trading loop (paper/mock unless -Live)  [-Once] [-Ticks N]
  api         HTTP control plane for the dashboard    [-Port 8787]
  dashboard   API (new window) + web dashboard + browser
  backtest    strategy backtest on all pairs
  help        this text        (also: Get-Help .\forex-bot.ps1 -Full)

Options:
  -Stake 0.02   gamble max loss as fraction of equity (0.005 - 0.05)
  -Live         real MT5 terminal instead of paper (asks you to type LIVE)
  -Force        skip the LIVE confirmation prompt
  -Pairs "EUR/USD,GBP/USD"

Quick start:
  powershell -ExecutionPolicy Bypass -File .\forex-bot.ps1 setup
  .\forex-bot.ps1 test
  .\forex-bot.ps1 scan
  .\forex-bot.ps1 gamble -Stake 0.02
  .\forex-bot.ps1 dashboard

Handy PowerShell extras:
  Get-Content .\forex_bot\bot.log -Wait -Tail 40     # live log tail
  $env:FXBOT_TELEGRAM_TOKEN = "123:AA..."            # session env vars
  .\forex_bot\.venv\Scripts\Activate.ps1             # activate the venv
'@
}

# ---------------------------------------------------------------- dispatch

Write-Banner

# NOTE: deliberately no "exit" at the end - running ".\forex-bot.ps1" in an
# interactive console must never close your PowerShell window.
$script:ResultCode = 0
switch ($Command) {
    'setup'     { Invoke-Setup }
    'test'      { Invoke-Test }
    'scan'      { Invoke-Scan;      $script:ResultCode = $LASTEXITCODE }
    'gamble'    { Invoke-Gamble;    $script:ResultCode = $LASTEXITCODE }
    'status'    { Invoke-Status;    $script:ResultCode = $LASTEXITCODE }
    'bot'       { Invoke-Bot;       $script:ResultCode = $LASTEXITCODE }
    'api'       { Invoke-Api;       $script:ResultCode = $LASTEXITCODE }
    'dashboard' { Invoke-Dashboard; $script:ResultCode = $LASTEXITCODE }
    'backtest'  { Invoke-Backtest;  $script:ResultCode = $LASTEXITCODE }
    default     { Show-Help }
}

if ($script:ResultCode -ne 0) {
    Write-Host "[forex-bot] '$Command' finished with code $script:ResultCode" -ForegroundColor Yellow
}
