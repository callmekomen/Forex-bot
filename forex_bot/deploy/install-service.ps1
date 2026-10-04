# ─────────────────────────────────────────────────────────────────
#  install-service.ps1 — autostart the bot on a Windows VPS
#  Uses Task Scheduler (always present). Run once from an elevated prompt:
#      powershell -ExecutionPolicy Bypass -File deploy\install-service.ps1
#  Remove again with:
#      powershell -File deploy\install-service.ps1 -Uninstall
# ─────────────────────────────────────────────────────────────────
[CmdletBinding()]
param(
    [switch]$Uninstall,
    [string]$TaskName = "ForexBot",
    [string]$PythonDir = "$PSScriptRoot\..",
    [string]$User = "$env:USERNAME"
)

$ErrorActionPreference = "Stop"

if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "[install] removed scheduled task '$TaskName'" -ForegroundColor Yellow
    return
}

if (-not (Test-Path "$PythonDir\main.py")) {
    throw "main.py not found under $PythonDir — run this script from forex_bot/deploy/"
}

# Pre-flight: refuse to register a bot whose risk engine self-test fails
Push-Location $PythonDir
$venvPy = Join-Path $PythonDir ".venv\Scripts\python.exe"
$py = if (Test-Path $venvPy) { $venvPy } else { "python" }
& $py main.py --self-test
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "self-test failed — fix it before enabling autostart" }
Pop-Location

$action    = New-ScheduledTaskAction -Execute "cmd.exe" `
              -Argument "/c `"$PythonDir\deploy\run_bot.cmd`" >> `"$PythonDir\logs\service.log`" 2>&1" `
              -WorkingDirectory $PythonDir
$trigger   = New-ScheduledTaskTrigger -AtStartup
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -StartWhenAvailable -RestartInterval (New-TimeSpan -Minutes 1) `
              -RestartCount 999 -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Highest

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Description "forex_bot supervised tick loop" | Out-Null

Write-Host "[install] task '$TaskName' registered" -ForegroundColor Green
Write-Host "[install] start now : Start-ScheduledTask -TaskName $TaskName"
Write-Host "[install] status    : Get-ScheduledTaskInfo -TaskName $TaskName"
Write-Host "[install] live logs : Get-Content $PythonDir\bot.log -Wait -Tail 40"
Write-Host "[install] remember: the MT5 terminal must also be logged in at boot (put a shortcut in shell:startup)."
