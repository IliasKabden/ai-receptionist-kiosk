param(
    [switch]$Setup
)

$ErrorActionPreference = "Stop"

$rootPath   = $PSScriptRoot
$backendPath = Join-Path $rootPath "backend"
$venvPath    = Join-Path $backendPath ".venv"

function Ensure-Venv {
    param([string]$VenvPath)
    if (!(Test-Path $VenvPath)) {
        Write-Host "===> Creating virtual environment at $VenvPath" -ForegroundColor Cyan
        python -m venv $VenvPath
    }
}

if ($Setup) {
    Write-Host "===> Setup (venv + deps)..." -ForegroundColor Cyan
    Ensure-Venv -VenvPath $venvPath
    & "$venvPath\Scripts\python.exe" -m pip install --upgrade pip setuptools wheel
    & "$venvPath\Scripts\pip.exe" install -r (Join-Path $backendPath "requirements.txt")
    Write-Host "===> Setup finished." -ForegroundColor Green
}

Write-Host "===> Starting backend and static server..." -ForegroundColor Cyan

# Inline the startup logic so this one script starts everything.
# 1) Ensure venv exists
Ensure-Venv -VenvPath $venvPath

# 2) Free port 8000 if needed
$portToCheck = 8000
try {
    $listeners = @(Get-NetTCPConnection -LocalPort $portToCheck -ErrorAction Stop | Where-Object { $_.State -eq 'Listen' })
    $pids = $listeners.OwningProcess | Select-Object -Unique
} catch {
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
            Write-Host ("Failed to stop process {0}: {1}" -f $ownPid, $_) -ForegroundColor Red
        }
    }
    Start-Sleep -Seconds 1
}

# 3) Start the backend (uvicorn) using venv python on port 8001 to match frontend
Start-Process -NoNewWindow `
    -FilePath "$venvPath\Scripts\python.exe" `
    -ArgumentList "-m uvicorn app:app --host 0.0.0.0 --port 8001" `
    -WorkingDirectory $backendPath

# 4) Start static server for frontend
Write-Host "===> Starting static server for frontend (http://localhost:5500)..." -ForegroundColor Cyan
$frontendPath = Join-Path $PSScriptRoot "frontend\static"
Start-Process -NoNewWindow `
    -FilePath "python" `
    -ArgumentList "-m http.server 5500" `
    -WorkingDirectory $frontendPath

Write-Host "===> All services started." -ForegroundColor Green
Write-Host "Admin UI:   http://localhost:5500/admin.html"
Write-Host "Kiosk UI:   http://localhost:5500/kiosk.html"
Write-Host "Backend:    http://localhost:8001"

Start-Sleep -Seconds 3

Write-Host "===> Starting desktop kiosk window..." -ForegroundColor Cyan
# Prefer launching Chrome/Chromium in kiosk mode (better media permissions handling)
$chromePaths = @(
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "C:\Program Files\Chromium\Application\chrome.exe"
)
$chromeExe = $null
foreach ($p in $chromePaths) { if (Test-Path $p) { $chromeExe = $p; break } }

if ($chromeExe) {
    Write-Host "===> Launching Chrome kiosk ($chromeExe)" -ForegroundColor Cyan
    # create a dedicated profile dir to avoid permission prompts being suppressed
    $profileDir = Join-Path $env:TEMP 'ai_receptionist_chrome_profile'
    if (!(Test-Path $profileDir)) { New-Item -ItemType Directory -Path $profileDir | Out-Null }

    $args = @(
        "--user-data-dir=$profileDir",
        "--kiosk",
        "--app=http://localhost:5500/kiosk.html",
        "--no-first-run",
        "--disable-infobars",
        "--enable-features=WebRTCPipeWireCapturer",
        "--autoplay-policy=no-user-gesture-required"
    )

    # For debugging or to auto-allow media during tests, uncomment these flags:
    # $args += "--use-fake-ui-for-media-stream"  # auto-accept media permissions (testing only)
    # $args += "--use-fake-device-for-media-stream" # use fake media input

    Start-Process -FilePath $chromeExe -ArgumentList $args -WorkingDirectory $rootPath
} else {
    # fallback to the pywebview window (may not prompt for media on some systems)
    Start-Process -FilePath "$venvPath\Scripts\python.exe" -ArgumentList "`"$rootPath\desktop_kiosk.py`"" -WorkingDirectory $rootPath
}
