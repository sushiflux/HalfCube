# Start script of the local Dev environment (native, no containers): starts the Vite dev server (browser version) and
# the Electron window, which loads the dev server. Builds what is missing first.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts\dev.ps1 [start|stop|restart|status|logs]
#          [-Neubau] [-NurBrowser] [-NurDesktop] [-Ausweichport] [-ImHintergrund] [-Zweitmonitor]
#   start (default)  start everything that is not running yet; own leftovers on the ports are restarted
#   stop             stop dev server and Electron window including their child processes
#   restart          stop, then start
#   status           show what runs, on which port, and the version of the build
#   logs             show the end of the log files in _build\run
#   -Neubau          rebuild the bundles even if they are up to date
#   -NurBrowser      dev server only, no Electron window
#   -NurDesktop      Electron window only; it loads the built bundle (app://), no dev server is started
#   -Ausweichport    take the next free port for this run if the registered one is held by a foreign program
#   -ImHintergrund   the Electron window starts minimized and without taking the focus (after a commit, tests); implies -Zweitmonitor
#   -Zweitmonitor    the Electron window opens on the secondary monitor (HALFCUBE_WINDOW_DISPLAY=secondary): the landscape
#                    one that is not the primary, else the largest; with a single monitor it stays on the primary one
# The ports come from config\dev-ports.json.
param(
    [ValidateSet('start', 'stop', 'restart', 'status', 'logs')][string]$Befehl = 'start',
    [switch]$Neubau, [switch]$NurBrowser, [switch]$NurDesktop, [switch]$Ausweichport, [switch]$ImHintergrund, [switch]$Zweitmonitor
)
$ErrorActionPreference = 'Stop'
if ($NurBrowser -and $NurDesktop) { throw 'NurBrowser und NurDesktop schliessen sich aus.' }

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$build = Join-Path $root '_build'
$run = Join-Path $build 'run'
$viteJs = Join-Path $root 'node_modules\vite\bin\vite.js'
# HALFCUBE_ELECTRON_EXE points the script at another Electron runtime (default: the one npm installed).
$electronExe = if ($env:HALFCUBE_ELECTRON_EXE) { $env:HALFCUBE_ELECTRON_EXE } else { Join-Path $root 'node_modules\electron\dist\electron.exe' }
$mainBundle = Join-Path $build 'desktop\main.cjs'
$webBundle = Join-Path $build 'web\index.html'
$ports = Get-Content -Raw (Join-Path $root 'config\dev-ports.json') | ConvertFrom-Json
$webPort = [int]$ports.'web-dev'
$reservedPorts = @($ports.PSObject.Properties | ForEach-Object { [int]$_.Value })
$url = $null
New-Item -ItemType Directory -Force -Path $run | Out-Null

function Say($t) { Write-Host "[dev] $t" }
function Step($name, [scriptblock]$block) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Say "$name ..."
    & $block
    Say ('{0} fertig in {1:N1} s' -f $name, $sw.Elapsed.TotalSeconds)
}
function Npm { param([Parameter(ValueFromRemainingArguments)]$a) & npm.cmd @a; if ($LASTEXITCODE -ne 0) { throw "npm $($a -join ' ') fehlgeschlagen (Code $LASTEXITCODE)" } }

# ---------------------------------------------------------------- processes
function Get-Own($name) {
    $f = Join-Path $run "$name.pid"
    if (-not (Test-Path $f)) { return $null }
    $p = Get-Process -Id ([int](Get-Content $f)) -ErrorAction SilentlyContinue
    # The PID must still belong to this project's process (a recycled PID of a foreign program is never touched).
    $mine = $false
    if ($p) { $c = Get-CommandLine $p.Id; $mine = [bool]($c -and $c -like "*$root*") }
    if ($mine) { $p } else { Remove-Item $f -ErrorAction SilentlyContinue; $null }
}
function Stop-Tree($name) {
    $p = Get-Own $name
    if ($p) {
        if ($name -eq 'electron') {
            # Close the window first so the app can shut down cleanly, then end what is left.
            $child = Get-Process -Name electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$root*" -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
            if ($child) { [void]$child.CloseMainWindow(); [void]$child.WaitForExit(3000) }
        }
        Kill-Tree $p.Id
        Say "$name gestoppt (PID $($p.Id))"
    }
    Remove-Item (Join-Path $run "$name.pid") -ErrorAction SilentlyContinue
}
# taskkill reports an already gone process on stderr; that is no error here.
function Kill-Tree($id) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & taskkill.exe /PID $id /T /F 2>&1 | Out-Null
    $ErrorActionPreference = $old
}
function Get-CommandLine($id) { (Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue).CommandLine }
# Leftovers of this project (command line inside this folder) that lost their PID file, e.g. after a crashed run.
function Stop-Orphans {
    $marks = @('node_modules\vite\bin\vite.js', 'node_modules\electron\dist\electron.exe')
    $found = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $c = $_.CommandLine
        $c -and $c -like "*$root*" -and ($marks | Where-Object { $c -like "*$_*" })
    }
    foreach ($p in $found) {
        if (Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue) {
            Kill-Tree $p.ProcessId
            Say "Uebriggebliebener eigener Prozess beendet: $($p.Name) (PID $($p.ProcessId))"
        }
    }
}
function Stop-All { Stop-Tree 'electron'; Stop-Tree 'web'; Stop-Orphans }

# ---------------------------------------------------------------- ports
function Get-PortHolder($p) {
    $c = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue }
}
# A real bind on the address the server will use, never a lookup alone.
function Test-PortFree($p) {
    try { $l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $p); $l.Start(); $l.Stop(); $true } catch { $false }
}
function Get-NextFreePort($from) {
    $n = $from + 1
    while (-not (Test-PortFree $n) -or $reservedPorts -contains $n) { $n++ }
    $n
}

# ---------------------------------------------------------------- build
function Test-Stale($output, [string[]]$inputs) {
    if (-not (Test-Path $output)) { return $true }
    $t = (Get-Item $output).LastWriteTime
    foreach ($i in $inputs) {
        $p = Join-Path $root $i
        if (-not (Test-Path $p)) { continue }
        # A file path must not go through -Recurse: PowerShell would then search the whole folder tree for that name.
        $items = if (Test-Path $p -PathType Leaf) { Get-Item $p } else { Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue }
        if ($items | Where-Object { $_.LastWriteTime -gt $t } | Select-Object -First 1) { return $true }
    }
    $false
}

function Set-GitHooks {
    if (-not (Test-Path (Join-Path $root '.git'))) { return }
    $current = (& git.exe -C $root config --get core.hooksPath 2>$null)
    if ($current -ne 'scripts/git-hooks') {
        & git.exe -C $root config core.hooksPath scripts/git-hooks
        Say 'Git-Hooks verdrahtet (core.hooksPath = scripts/git-hooks)'
    }
}

function Ensure-Built {
    Push-Location $root
    try {
        $lock = Join-Path $root 'node_modules\.package-lock.json'
        if (-not (Test-Path $lock) -or (Get-Item (Join-Path $root 'package-lock.json')).LastWriteTime -gt (Get-Item $lock).LastWriteTime) {
            Step 'npm install' { Npm install --no-audit --no-fund }
        }
        if (-not $NurBrowser -and -not (Test-Path $electronExe)) {
            Step 'Electron-Laufzeit laden' { & npx.cmd install-electron; if ($LASTEXITCODE -ne 0) { throw 'install-electron fehlgeschlagen' } }
        }

        # ENGINE BUILD (next stage): build the native engine here when its executable is missing or out of date.

        $appInputs = @('app', 'branding\branding.json', 'branding\icons', 'config', 'version.txt', 'vite.config.ts', 'package.json')
        $desktopInputs = @('desktop\src', 'app\src\version.ts', 'app\src\branding.ts', 'app\src\platform.ts', 'branding\branding.json',
            'branding\icons\icon-512.png', 'config', 'version.txt', 'vite.desktop.config.ts', 'package.json')
        # The dev server serves the sources itself; the web bundle is only needed when the window loads it (app://).
        if ($NurDesktop -and ($Neubau -or (Test-Stale $webBundle $appInputs))) { Step 'Browser-Version bauen' { Npm run build:web } }
        if (-not $NurBrowser -and ($Neubau -or (Test-Stale $mainBundle $desktopInputs))) { Step 'Desktop-Programm bauen' { Npm run build:desktop } }
    } finally { Pop-Location }
}

# ---------------------------------------------------------------- start
# Starts a hidden background process whose output goes to a log file. It runs through cmd and ShellExecute on purpose:
# a child started with redirected streams inherits the caller's pipe handles, so a caller that waits for its output
# (a terminal pipe, a hook, a test run) would never see the script end. Returns the cmd process; stopping it with
# taskkill /T ends the whole tree.
function Start-Detached([string]$commandLine, [string]$logFile) {
    $env:NO_COLOR = '1' # plain log files
    try {
        Start-Process cmd.exe -ArgumentList @('/d', '/c', "`"$commandLine > `"$logFile`" 2>&1`"") -WorkingDirectory $root -WindowStyle Hidden -PassThru
    } finally { Remove-Item Env:NO_COLOR -ErrorAction SilentlyContinue }
}

function Start-Web {
    Stop-Tree 'web'
    $port = $webPort
    $holder = Get-PortHolder $port
    if ($holder) {
        $cmd = Get-CommandLine $holder.Id
        if ($cmd -and $cmd -like "*$root*") {
            Say "Port $port wird von einem eigenen Prozess belegt (PID $($holder.Id)); er wird neu gestartet."
            Kill-Tree $holder.Id
            for ($i = 0; $i -lt 25 -and -not (Test-PortFree $port); $i++) { Start-Sleep -Milliseconds 200 }
        } else {
            $next = Get-NextFreePort $port
            if (-not $Ausweichport) {
                throw "Port $port wird von einem fremden Programm belegt: $($holder.ProcessName) (PID $($holder.Id), $($holder.Path)). Naechster freier Port: $next. Mit Ausweichport erneut starten: powershell -ExecutionPolicy Bypass -File scripts\dev.ps1 $Befehl -Ausweichport"
            }
            $port = $next
            Say "Ausweichport fuer diesen Lauf: $port (der registrierte Port $webPort bleibt unveraendert)"
        }
    }
    if (-not (Test-PortFree $port)) { throw "Port $port ist weiterhin belegt. Mit dev.ps1 stop beenden oder -Ausweichport verwenden." }
    $log = Join-Path $run 'web.log'
    $p = Start-Detached "node `"$viteJs`" --config vite.config.ts --port $port --strictPort" $log
    $p.Id | Set-Content (Join-Path $run 'web.pid')
    $script:url = "http://127.0.0.1:$port/"
    for ($i = 0; $i -lt 75; $i++) {
        if ($p.HasExited) { throw "Der Dev-Server hat sich sofort beendet (Code $($p.ExitCode)). Log: $run\web.log" }
        try {
            $r = Invoke-WebRequest -UseBasicParsing -Uri $script:url -TimeoutSec 2
            if ($r.StatusCode -eq 200) { Say "Browser-Version laeuft: $($script:url) (PID $($p.Id))"; return }
        } catch { Start-Sleep -Milliseconds 200 }
    }
    throw "Der Dev-Server antwortet nicht auf $($script:url). Log: $log"
}

function Start-Desktop {
    Stop-Tree 'electron'
    $log = Join-Path $run 'electron.log'
    $saved = @{}
    foreach ($n in 'HALFCUBE_WINDOW', 'HALFCUBE_WINDOW_DISPLAY', 'HALFCUBE_DEV_URL', 'HALFCUBE_USER_DATA') { $saved[$n] = [Environment]::GetEnvironmentVariable($n) }
    try {
        $env:HALFCUBE_USER_DATA = Join-Path $build 'dev-data'
        if ($ImHintergrund) { $env:HALFCUBE_WINDOW = 'minimized' } else { Remove-Item Env:\HALFCUBE_WINDOW -ErrorAction SilentlyContinue }
        if ($Zweitmonitor -or $ImHintergrund) { $env:HALFCUBE_WINDOW_DISPLAY = 'secondary' } else { Remove-Item Env:HALFCUBE_WINDOW_DISPLAY -ErrorAction SilentlyContinue }
        if ($script:url) { $env:HALFCUBE_DEV_URL = $script:url } else { Remove-Item Env:\HALFCUBE_DEV_URL -ErrorAction SilentlyContinue }
        $p = Start-Detached "`"$electronExe`" ." $log
    } finally {
        foreach ($n in $saved.Keys) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) }
    }
    $p.Id | Set-Content (Join-Path $run 'electron.pid')
    Start-Sleep -Seconds 3
    if ($p.HasExited) { throw "Das Electron-Fenster hat sich sofort beendet (Code $($p.ExitCode)). Log: $run\electron.log" }
    $mode = if ($ImHintergrund) { 'minimiert, ohne Fokus' } else { 'normal' }
    if ($Zweitmonitor -or $ImHintergrund) { $mode += ', Zweitmonitor' }
    $source = if ($script:url) { 'laedt den Dev-Server' } else { 'laedt die gebaute Browser-Version (app://)' }
    Say "Electron-Fenster gestartet (PID $($p.Id), $mode, $source)"
}

function Get-VersionLine {
    $f = Join-Path $root 'version.txt'
    if (Test-Path $f) { (Get-Content $f)[1] } else { 'unbekannt' }
}

try {
switch ($Befehl) {
    'stop' { Stop-All }
    'status' {
        $w = Get-Own 'web'
        $e = Get-Own 'electron'
        Say ('Dev-Server:       {0}' -f $(if ($w) { "laeuft (PID $($w.Id)), Port $webPort registriert" } else { 'gestoppt' }))
        Say ('Electron-Fenster: {0}' -f $(if ($e) { "laeuft (PID $($e.Id))" } else { 'gestoppt' }))
        if ($w) {
            try {
                $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$webPort/" -TimeoutSec 3
                Say ('Antwort auf Port {0}: {1}, COOP {2}, COEP {3}' -f $webPort, $r.StatusCode, $r.Headers['Cross-Origin-Opener-Policy'], $r.Headers['Cross-Origin-Embedder-Policy'])
            } catch { Say "Der Dev-Server antwortet nicht auf Port $webPort." }
        }
        Say ('Desktop-Bau:      {0}' -f $(if (Test-Path $mainBundle) { 'vorhanden' } else { 'fehlt' }))
        Say ('Version (version.txt): {0}' -f (Get-VersionLine))
    }
    'logs' {
        $files = Get-ChildItem $run -Filter *.log -ErrorAction SilentlyContinue
        if (-not $files) { Say 'Keine Log-Dateien vorhanden.' }
        foreach ($f in $files) { "=== $($f.Name)"; Get-Content $f.FullName -Tail 40 }
    }
    default {
        if ($Befehl -eq 'restart') { Stop-All }
        Set-GitHooks
        Ensure-Built
        if (-not $NurDesktop) { Start-Web }
        if (-not $NurBrowser) { Start-Desktop }
        if ($script:url) { Say "Im Browser oeffnen: $($script:url)" }
        Say "Version: $(Get-VersionLine)"
    }
}
} catch {
    Write-Host "[dev] FEHLER: $($_.Exception.Message)"
    exit 1
}
