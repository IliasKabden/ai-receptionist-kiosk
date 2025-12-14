param(
    [switch]$Setup,
    [switch]$Run
)

$ErrorActionPreference = "Stop"

$backendPath = Join-Path $PSScriptRoot "backend"
$venvPath    = Join-Path $backendPath ".venv"

if ($Setup) {
    Write-Host "===> Creating virtual environment and installing dependencies..." -ForegroundColor Cyan

    if (!(Test-Path $venvPath)) {
        python -m venv $venvPath
    }

    & "$venvPath\Scripts\python.exe" -m pip install --upgrade pip
    & "$venvPath\Scripts\pip.exe" install -r (Join-Path $backendPath "requirements.txt")

    Write-Host "===> Setup finished." -ForegroundColor Green
}

if ($Run) {
    Write-Host "===> Starting backend (FastAPI + Uvicorn)..." -ForegroundColor Cyan
    # Ensure port 8000 is free. If a process is already listening, attempt to stop it
    # to avoid the common "only one usage of each socket address" error.
    $portToCheck = 8000
    try {
        $listeners = @(Get-NetTCPConnection -LocalPort $portToCheck -ErrorAction Stop | Where-Object { $_.State -eq 'Listen' })
        $pids = $listeners.OwningProcess | Select-Object -Unique
    } catch {
        # Fallback for environments without Get-NetTCPConnection: use netstat parsing
        $pids = @()
        try {
            $lines = netstat -ano | Select-String ":$portToCheck"
            foreach ($line in $lines) {
                $parts = ($line -split '\s+') -ne ''
                if ($parts.Length -ge 5) {
                    $pid = $parts[-1]
                    if ($pid -as [int]) { $pids += [int]$pid }
                }
            }
            $pids = $pids | Select-Object -Unique
        } catch {
            $pids = @()
        }
    }

    if ($pids.Count -gt 0) {
        foreach ($ownPid in $pids) {
            try {
                Write-Host "===> Stopping process PID $ownPid that is listening on port $portToCheck" -ForegroundColor Yellow
                Stop-Process -Id $ownPid -Force -ErrorAction Stop
                Write-Host "Stopped process $ownPid" -ForegroundColor Green
            } catch {
                # Use formatted output to avoid PowerShell parsing issues with "$ownPid: $_" inside double quotes
                Write-Host ("Failed to stop process {0}: {1}" -f $ownPid, $_) -ForegroundColor Red
            }
        }
        Start-Sleep -Seconds 1
    }

    Start-Process -NoNewWindow `
        -FilePath "$venvPath\Scripts\python.exe" `
        -ArgumentList "-m uvicorn app:app --host 0.0.0.0 --port 8000" `
        -WorkingDirectory $backendPath

    Write-Host "===> Starting static server for frontend (http://localhost:5500)..." -ForegroundColor Cyan
    $frontendPath = Join-Path $PSScriptRoot "frontend\static"
    Start-Process -NoNewWindow `
        -FilePath "python" `
        -ArgumentList "-m http.server 5500" `
        -WorkingDirectory $frontendPath

    Write-Host "===> All services started." -ForegroundColor Green
    Write-Host "Admin UI:   http://localhost:5500/admin.html"
    Write-Host "Kiosk UI:   http://localhost:5500/kiosk.html"
}
