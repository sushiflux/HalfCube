# End-to-end Velopack test with the Electron test app: pack 1.0.0, silent install, update to 1.0.1 from a local feed
# (folder or http://127.0.0.1), user data check, silent uninstall, clean up. No admin rights, nothing is published.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-test.ps1 [-VelopackVersion 1.2.161] [-Feed file|http]
#                                                                           [-WindowCheck] [-GithubCheck] [-KeepUserData]
# Evidence (transcript, setup log, result table) goes to _build\run-<version>-<feed>\.
param(
  [string]$VelopackVersion = '1.2.161',
  [ValidateSet('file', 'http')][string]$Feed = 'file',
  [switch]$WindowCheck,   # show the logo window inactive once and compare the foreground window before and after
  [switch]$GithubCheck,   # one anonymous read-only update check against the public GitHub repository (HTTPS)
  [switch]$KeepUserData   # leave the user-data folder in place at the end
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot\..").Path
. "$PSScriptRoot\lib.ps1"
$packId = 'HalfCubeVelopackTest'
$work = Join-Path $root "_build\run-$VelopackVersion-$Feed"
$feedDir = Join-Path $work 'feed'
$evidence = Join-Path $work 'evidence'
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $feedDir, $evidence | Out-Null
Start-Transcript -Path (Join-Path $evidence 'transcript.txt') | Out-Null

$installDir = Join-Path $env:LOCALAPPDATA $packId
$userDataDir = Join-Path $env:APPDATA $packId
$userFile = Join-Path $userDataDir 'userdata\user-file.txt'
$logFile = Join-Path $userDataDir 'logs\test.log'
$regKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$packId"
$results = New-Object System.Collections.Generic.List[object]

function Add-Result($step, $ok, $detail) {
  $word = if ($ok) { 'PASS' } else { 'FAIL' }
  $results.Add([pscustomobject]@{ Step = $step; Result = $word; Detail = $detail })
  Write-Host ("[{0}] {1}: {2}" -f $word, $step, $detail)
}
function Wait-LogLine($pattern, $timeoutSec = 120) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $timeoutSec) {
    if ((Test-Path $logFile) -and (Select-String -Path $logFile -Pattern $pattern -Quiet)) { return $true }
    Start-Sleep -Milliseconds 300
  }
  return $false
}
function Node-Build($ver) {
  $ErrorActionPreference = 'Continue' # stderr output of native commands is not an error here, the exit code decides
  & node "$root\scripts\build.mjs" $ver --feed $feedDir --vpk $vpk --velopack $VelopackVersion --stage "$ver-v$VelopackVersion" 2>&1 |
    Where-Object { $_ -notmatch 'EBADENGINE|DEP0190|trace-deprecation|^\s*$' } |
    Tee-Object -FilePath (Join-Path $evidence "build-$ver.txt") | Select-Object -Last 22
  if ($LASTEXITCODE -ne 0) { throw "build $ver failed ($LASTEXITCODE)" }
}

$server = $null
try {
  if (Test-Path $regKey) { throw "$packId is already installed, refusing to run" }
  Remove-Item $userDataDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $env:LOCALAPPDATA 'velopack\velopack_HalfCubeVelopackTest.log') -Force -ErrorAction SilentlyContinue
  $elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  Add-Result 'precondition' (-not $elevated) "test app not installed, user-data folder empty, elevated shell: $elevated"

  # vpk without a global install (same version as the npm package, as the documentation asks)
  $tools = Join-Path $root "_build\tools-$VelopackVersion"
  $vpk = Join-Path $tools 'vpk.exe'
  if (-not (Test-Path $vpk)) { & dotnet tool install vpk --tool-path $tools --version $VelopackVersion | Select-Object -Last 2 }
  & $vpk --skip-updates -h | Select-Object -Skip 1 -First 1

  # 1. pack 1.0.0
  Node-Build '1.0.0'
  $setup = Join-Path $feedDir "$packId-win-Setup.exe"
  $setupCopy = Join-Path $work 'Setup-1.0.0.exe'
  Copy-Item $setup $setupCopy
  $f100 = Get-Item "$feedDir\$packId-1.0.0-full.nupkg"
  Add-Result '1 pack 1.0.0' ((Test-Path $setup) -and $f100) ("full nupkg {0:N0} bytes, Setup.exe {1:N0} bytes" -f $f100.Length, (Get-Item $setup).Length)

  # 2. silent install
  $r = Invoke-Watched -File $setupCopy -ArgList @('--silent', '--log', (Join-Path $evidence 'setup-1.0.0.log')) -Label 'Setup --silent'
  $r | Format-List | Out-String | Write-Host
  $ok = ($r.ExitCode -eq 0) -and (Test-Path "$installDir\current\$packId.exe") -and (Test-Path $regKey) -and ($r.VisibleWindows -eq 'none')
  Add-Result '2 silent install' $ok ("exit {0}, {1} s, windows: {2}, dir {3}" -f $r.ExitCode, $r.Seconds, $r.VisibleWindows, $installDir)
  $reg = Get-ItemProperty $regKey
  Add-Result '2 uninstall entry (HKCU)' ($reg.DisplayVersion -eq '1.0.0') ("DisplayVersion {0}, Publisher {1}, QuietUninstallString {2}" -f $reg.DisplayVersion, $reg.Publisher, $reg.QuietUninstallString)
  $hklm = Test-Path "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$packId"
  Add-Result '2 no machine-wide entry' (-not $hklm) 'no HKLM uninstall key'
  $lnkStart = Test-Path "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\HalfCube Velopack Test.lnk"
  $lnkDesk = Test-Path ([Environment]::GetFolderPath('Desktop') + '\HalfCube Velopack Test.lnk')
  Add-Result '2 shortcuts' $lnkStart "Start menu: $lnkStart, Desktop: $lnkDesk (vpk default Desktop,StartMenuRoot)"
  $running = (Get-RelatedProcesses | Measure-Object).Count -gt 0
  $hookOnly = (Select-String -Path $logFile -Pattern 'hook after-install' -Quiet) -and -not (Select-String -Path $logFile -Pattern ' start args=' -Quiet)
  Add-Result '2 no auto start after silent install' ((-not $running) -and $hookOnly) 'only the after-install hook ran, the app itself was not started'

  # 3. first run of the installed app, info only
  $exe = "$installDir\current\$packId.exe"
  $r = Invoke-Watched -File $exe -ArgList @('--action=info') -Label 'installed 1.0.0 info'
  $seen = Select-String -Path $logFile -Pattern 'appId=HalfCubeVelopackTest version=1.0.0 portable=false' -Quiet
  Add-Result '3 installed app reports its version' (($r.ExitCode -eq 0) -and $seen) 'appId, version 1.0.0, portable=false (see test.log)'
  Copy-Item $userFile (Join-Path $evidence 'user-file-before-update.txt')

  if ($WindowCheck) {
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class Fg { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); }'
    function Get-Fg { $h = [Fg]::GetForegroundWindow(); $p = [uint32]0; [void][Fg]::GetWindowThreadProcessId($h, [ref]$p); "$h/$p" }
    $fgBefore = Get-Fg
    $r = Invoke-Watched -File $exe -ArgList @('--action=info', '--window=inactive') -Label 'installed 1.0.0 window=inactive'
    $fgAfter = Get-Fg
    $r | Format-List | Out-String | Write-Host
    $shown = Select-String -Path $logFile -Pattern 'window shown inactive, focused=false' -Quiet
    Add-Result '3 inactive window does not take the focus' ($shown -and ($fgBefore -eq $fgAfter)) "logo window shown inactive, foreground window before $fgBefore, after $fgAfter, visible windows seen: $($r.VisibleWindows)"
  }

  # 4. pack 1.0.1 into the same feed (delta)
  Node-Build '1.0.1'
  $full = (Get-Item "$feedDir\$packId-1.0.1-full.nupkg").Length
  $deltaFile = Get-Item "$feedDir\$packId-1.0.1-delta.nupkg" -ErrorAction SilentlyContinue
  Add-Result '4 pack 1.0.1 with delta' ($null -ne $deltaFile) ("full {0:N0} bytes, delta {1:N0} bytes ({2:P2} of full)" -f $full, $deltaFile.Length, ($deltaFile.Length / $full))

  # 5. update from the local feed
  $feedArg = $feedDir
  if ($Feed -eq 'http') {
    $l = New-Object System.Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0); $l.Start(); $port = $l.LocalEndpoint.Port; $l.Stop()
    $serverLog = Join-Path $evidence 'feed-server.log'
    $server = Start-Process node -ArgumentList @("`"$root\scripts\serve.mjs`"", "`"$feedDir`"", $port) -WindowStyle Hidden -PassThru -RedirectStandardOutput $serverLog
    Start-Sleep -Seconds 1
    $feedArg = "http://127.0.0.1:$port"
  }
  $r = Invoke-Watched -File $exe -ArgList @('--action=update', "--feed=$feedArg") -Label "update from $feedArg"
  $r | Format-List | Out-String | Write-Host
  $done = Wait-LogLine 'app=1.0.1 .*update check: no update available'
  [void](Wait-Idle -TimeoutSec 60)
  $regNow = (Get-ItemProperty $regKey).DisplayVersion
  $sq = Get-Content "$installDir\current\sq.version" -Raw
  Add-Result '5 update 1.0.0 to 1.0.1' ($done -and $regNow -eq '1.0.1' -and $sq -match '<version>1.0.1</version>') ("windows: {0}; registry {1}; restarted into 1.0.1 and found no further update; feed {2}" -f $r.VisibleWindows, $regNow, $feedArg)
  $usedDelta = Select-String -Path (Join-Path $env:LOCALAPPDATA 'velopack\velopack_HalfCubeVelopackTest.log') -Pattern 'Successfully applied 1 delta patches' -Quiet
  Add-Result '5 update used the delta package' $usedDelta 'velopack log: delta patches applied'
  $hooks = (Select-String -Path $logFile -Pattern 'hook before-update 1.0.0' -Quiet) -and (Select-String -Path $logFile -Pattern 'hook after-update 1.0.1' -Quiet) -and (Select-String -Path $logFile -Pattern 'hook restarted 1.0.1' -Quiet)
  Add-Result '5 hooks ran' $hooks 'before-update (old version), after-update and restarted (new version)'
  if ($server) { Stop-Process -Id $server.Id -Force; $server = $null; Get-Content $serverLog | Select-Object -First 12 }

  # 6. user data
  $content = Get-Content $userFile -Raw
  $first = Get-Content (Join-Path $evidence 'user-file-before-update.txt') -Raw
  Add-Result '6 user-data file survived the update' ($content.StartsWith($first.TrimEnd()) -and $content -match 'seen by 1.0.1') 'first line unchanged, new line written by 1.0.1'

  # 7. optional read-only checks against GitHub (HTTPS): a public repository without releases, and a name that does not exist
  if ($GithubCheck) {
    foreach ($url in @('https://github.com/sushiflux/HalfCube', 'https://github.com/sushiflux/no-such-repository-for-the-velopack-test')) {
      $r = Invoke-Watched -File $exe -ArgList @('--action=check', "--feed=$url") -Label "github check $url"
      $line = (Select-String -Path $logFile -Pattern 'update check|error' | Select-Object -Last 1).Line
      Add-Result "7 HTTPS check $url" $true "exit $($r.ExitCode): $line"
    }
  }

  # 8. silent uninstall with the registered command
  $q = (Get-ItemProperty $regKey).QuietUninstallString
  $r = Invoke-Watched -File "$installDir\Update.exe" -ArgList @('--uninstall', '--silent') -Label 'uninstall'
  $r | Format-List | Out-String | Write-Host
  [void](Wait-Idle -TimeoutSec 60); Start-Sleep -Seconds 4
  $gone = -not (Test-Path $installDir)
  Add-Result '8 silent uninstall removes program files' ($gone -and $r.ExitCode -eq 0) "exit $($r.ExitCode), $($r.Seconds) s, windows: $($r.VisibleWindows), install dir exists: $(-not $gone), command: $q"
  $lnk = (Test-Path "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\HalfCube Velopack Test.lnk") -or (Test-Path ([Environment]::GetFolderPath('Desktop') + '\HalfCube Velopack Test.lnk'))
  Add-Result '8 shortcuts removed' (-not $lnk) 'no Start menu or Desktop shortcut left'
  Add-Result '8 uninstall entry removed' (-not (Test-Path $regKey)) 'HKCU key gone'
  $kept = (Test-Path $userFile) -and ((Get-Content $userFile -Raw) -match 'seen by 1.0.1') -and (Select-String -Path $logFile -Pattern 'hook before-uninstall 1.0.1' -Quiet)
  Add-Result '8 user-data file survived the uninstall' $kept 'user-file.txt still there, before-uninstall hook ran'
  Copy-Item $logFile (Join-Path $evidence 'test.log')
  Copy-Item (Join-Path $env:LOCALAPPDATA 'velopack\velopack_HalfCubeVelopackTest.log') (Join-Path $evidence 'velopack-app.log')
  Copy-Item $userFile (Join-Path $evidence 'user-file-after-uninstall.txt')
}
catch {
  Add-Result 'run' $false ($_ | Out-String)
}
finally {
  if ($server) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
  # Never leave the app behind, also after a failed run
  if (Test-Path "$installDir\Update.exe") {
    Start-Process "$installDir\Update.exe" -ArgumentList '--uninstall', '--silent' -WindowStyle Hidden -Wait
    [void](Wait-Idle -TimeoutSec 60); Start-Sleep 4
  }
  if (-not $KeepUserData) {
    Remove-Item $userDataDir -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $env:LOCALAPPDATA 'velopack\velopack_HalfCubeVelopackTest.log') -Force -ErrorAction SilentlyContinue
  }
  $results | Format-Table -AutoSize -Wrap | Out-String -Width 250 | Write-Host
  $results | ConvertTo-Json | Set-Content (Join-Path $evidence 'results.json')
  Write-Host ("left on the machine: install dir {0}, user data {1}, registry {2}" -f (Test-Path $installDir), (Test-Path $userDataDir), (Test-Path $regKey))
  Stop-Transcript | Out-Null
}
