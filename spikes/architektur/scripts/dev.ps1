# Start script of the architecture spike: builds what is missing, then starts the browser page (vite preview) and
# the Electron window. Subcommands: start (default), stop, restart, status, logs.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\dev.ps1 [start|stop|restart|status|logs]
#          [-Neubau] [-NurBrowser] [-NurDesktop] [-Ausweichport]
#   -Neubau        rebuild the UI bundles even if they exist (engines are rebuilt only when missing)
#   -NurBrowser    page only, no Electron window     -NurDesktop   Electron window only (needs no web server)
#   -Ausweichport  take the next free port for this run if the registered one is held by a foreign program
# The ports are the ones of vite.config.ts (single source, registered in the developer's port registry).
param(
    [ValidateSet('start', 'stop', 'restart', 'status', 'logs')][string]$Befehl = 'start',
    [switch]$Neubau, [switch]$NurBrowser, [switch]$NurDesktop, [switch]$Ausweichport
)
$ErrorActionPreference = 'Stop'

$spike = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$build = Join-Path $spike '_build'
$run = Join-Path $build 'run'
$exe = Join-Path $build 'engine-win\halfcube-engine.exe'
$wasm = Join-Path $build 'engine-wasm\halfcube-engine.wasm'
$cfg = Get-Content -Raw (Join-Path $spike 'vite.config.ts')
$port = [int][regex]::Match($cfg, 'PREVIEW_PORT\s*=\s*(\d+)').Groups[1].Value
if (-not $port) { throw 'PREVIEW_PORT nicht in vite.config.ts gefunden.' }
$url = $null
New-Item -ItemType Directory -Force -Path $run | Out-Null
$env:electron_config_cache = Join-Path $build 'electron-cache'

function Say($t) { Write-Host "[spike] $t" }
function Step($name, [scriptblock]$block) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Say "$name ..."
    & $block
    Say ("{0} fertig in {1:N1} s" -f $name, $sw.Elapsed.TotalSeconds)
}
function Npm { param([Parameter(ValueFromRemainingArguments)]$a) & npm.cmd @a; if ($LASTEXITCODE -ne 0) { throw "npm $($a -join ' ') fehlgeschlagen ($LASTEXITCODE)" } }

function Get-Own($name) {
    $f = Join-Path $run "$name.pid"
    if (-not (Test-Path $f)) { return $null }
    $p = Get-Process -Id ([int](Get-Content $f)) -ErrorAction SilentlyContinue
    if ($p) { $p } else { Remove-Item $f; $null }
}
function Stop-Tree($name) {
    $p = Get-Own $name
    if ($p) { & taskkill.exe /PID $p.Id /T /F | Out-Null; Say "$name gestoppt (PID $($p.Id))" }
    Remove-Item (Join-Path $run "$name.pid") -ErrorAction SilentlyContinue
}
function Get-PortHolder($p) {
    $c = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue }
}
function Test-PortFree($p) {
    try { $l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $p); $l.Start(); $l.Stop(); $true } catch { $false }
}

function Stop-All { Stop-Tree 'electron'; Stop-Tree 'web' }

function Ensure-Built {
    Push-Location $spike
    try {
        if (-not (Test-Path (Join-Path $spike 'node_modules\.bin\vite.cmd')) -or -not (Test-Path (Join-Path $spike 'node_modules\electron\path.txt'))) {
            Step 'npm install' { Npm install --no-audit --no-fund }
        }
        if (-not (Test-Path (Join-Path $spike 'node_modules\electron\dist'))) {
            Step 'Electron-Laufzeit laden' { & npx.cmd install-electron; if ($LASTEXITCODE -ne 0) { throw 'install-electron fehlgeschlagen' } }
        }
        if (-not $NurBrowser -and -not (Test-Path $exe)) {
            Step 'native Engine bauen' { & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $spike 'engine\scripts\build-windows.ps1'); if ($LASTEXITCODE -ne 0) { throw 'build-windows.ps1 fehlgeschlagen' } }
        }
        if (-not $NurDesktop -and -not (Test-Path $wasm)) {
            & docker.exe info *> $null
            if ($LASTEXITCODE -ne 0) { throw 'WebAssembly-Engine fehlt und Docker laeuft nicht. Docker Desktop starten und erneut ausfuehren (Docker dient nur als Wegwerf-Build-Umgebung).' }
            Step 'WebAssembly-Engine bauen' { & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $spike 'engine\scripts\build-wasm.ps1'); if ($LASTEXITCODE -ne 0) { throw 'build-wasm.ps1 fehlgeschlagen' } }
        }
        $needUi = $Neubau -or -not (Test-Path (Join-Path $build 'app-web\index.html')) -or -not (Test-Path (Join-Path $build 'app-desktop\main.cjs'))
        if ($needUi) { Step 'Oberflaeche bauen' { Npm run build:ui } }
    } finally { Pop-Location }
}

function Start-Web {
    if (Get-Own 'web') { Stop-Tree 'web' }
    $script:port = $port
    $holder = Get-PortHolder $port
    if ($holder) {
        $next = $port + 1; while (-not (Test-PortFree $next)) { $next++ }
        if (-not $Ausweichport) {
            throw "Port $port wird von einem fremden Programm belegt: $($holder.ProcessName) (PID $($holder.Id), $($holder.Path)). Naechster freier Port: $next. Mit Ausweichport erneut starten: powershell -ExecutionPolicy Bypass -File scripts\dev.ps1 start -Ausweichport"
        }
        $script:port = $next
        Say "Ausweichport fuer diesen Lauf: $next (registrierter Port $port bleibt unveraendert)"
    }
    $log = Join-Path $run 'web.log'
    $vite = Join-Path $spike 'node_modules\vite\bin\vite.js'
    $p = Start-Process node -ArgumentList @($vite, 'preview', '--config', 'vite.config.ts', '--port', $script:port) -WorkingDirectory $spike `
        -WindowStyle Hidden -PassThru -RedirectStandardOutput $log -RedirectStandardError (Join-Path $run 'web.err.log')
    $p.Id | Set-Content (Join-Path $run 'web.pid')
    $script:url = "http://127.0.0.1:$($script:port)/"
    for ($i = 0; $i -lt 50; $i++) {
        try { $r = Invoke-WebRequest -UseBasicParsing -Uri $script:url -TimeoutSec 2; if ($r.StatusCode -eq 200) { Say "Browser-Seite laeuft: $($script:url)"; return } } catch { Start-Sleep -Milliseconds 200 }
    }
    throw "Browser-Seite antwortet nicht auf $($script:url). Log: $log"
}

function Start-Desktop {
    if (Get-Own 'electron') { Stop-Tree 'electron' }
    $el = Join-Path $spike 'node_modules\electron\dist\electron.exe'
    $p = Start-Process $el -ArgumentList @('.') -WorkingDirectory $spike -PassThru -RedirectStandardOutput (Join-Path $run 'electron.log') -RedirectStandardError (Join-Path $run 'electron.err.log')
    $p.Id | Set-Content (Join-Path $run 'electron.pid')
    Start-Sleep -Seconds 2
    if ($p.HasExited) { throw "Electron-Fenster hat sich sofort beendet (Code $($p.ExitCode)). Log: $run\electron.err.log" }
    Say "Electron-Fenster gestartet (PID $($p.Id))"
}

switch ($Befehl) {
    'stop' { Stop-All }
    'status' {
        foreach ($n in 'web', 'electron') { $p = Get-Own $n; Say ("{0}: {1}" -f $n, $(if ($p) { "laeuft (PID $($p.Id))" } else { 'gestoppt' })) }
        Say ("native Engine: {0}; WebAssembly-Engine: {1}" -f (Test-Path $exe), (Test-Path $wasm))
    }
    'logs' { Get-ChildItem $run -Filter *.log -ErrorAction SilentlyContinue | ForEach-Object { "=== $($_.Name)"; Get-Content $_ -Tail 40 } }
    default {
        if ($Befehl -eq 'restart') { Stop-All }
        Ensure-Built
        if (-not $NurDesktop) { Start-Web }
        if (-not $NurBrowser) { Start-Desktop }
        if ($url) { Say "Im Browser oeffnen: $url" }
    }
}
