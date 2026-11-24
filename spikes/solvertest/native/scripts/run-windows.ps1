# Runs the native solver test driver over the whole catalogue, writes the result file and the
# checker output. Nothing has to be on PATH except node for the checker (skipped with a message
# if node is missing).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File spikes/solvertest/native/scripts/run-windows.ps1 [-Eigen 3.4.0|5.0.1] [-Reps 5] [-Out <file>]
#
# Default output: spikes/solvertest/_results/native-msvc.json (+ native-msvc.check.txt) of the
# repository; with -Eigen 5.0.1 the default name gets the suffix "-eigen501".
param(
    [ValidateSet('3.4.0', '5.0.1')][string]$Eigen = '3.4.0',
    [int]$Reps = 5,
    [string]$Out = '',
    [string]$RunDate = '2026-11-24'
)
$ErrorActionPreference = 'Stop'

$native = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$solver = (Resolve-Path (Join-Path $native '..')).Path
$suffix = if ($Eigen -eq '3.4.0') { '' } else { "-eigen$($Eigen.Replace('.', ''))" }
$exe    = Join-Path $solver "_build\native-msvc$suffix\solvertest_driver.exe"
if (-not (Test-Path $exe)) { throw "driver not built: $exe (run build-windows.ps1 -Eigen $Eigen)" }
if (-not $Out) { $Out = Join-Path $solver "_results\native-msvc$suffix.json" }
New-Item -ItemType Directory -Force -Path (Split-Path $Out) | Out-Null
$cases = Join-Path $solver 'cases\cases.json'

$os  = Get-CimInstance Win32_OperatingSystem
$cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1).Name.Trim()
$runtime = "$($os.Caption) $($os.Version) ($($os.OSArchitecture)), native x64 process, CPU $cpu"

& $exe $cases $Out --track native-msvc --runtime $runtime --run-date $RunDate --reps $Reps
if ($LASTEXITCODE -ne 0) { throw "driver failed ($LASTEXITCODE)" }
Write-Host "wrote $Out"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Warning 'node not found: checker skipped'; return }
$checkTxt = [IO.Path]::ChangeExtension($Out, '.check.txt')
$lines = & $node.Source (Join-Path $solver 'check\check.mjs') $cases $Out
$checkExit = $LASTEXITCODE
[IO.File]::WriteAllLines($checkTxt, [string[]]$lines, (New-Object Text.UTF8Encoding($false)))
$lines | Select-Object -Last 3 | ForEach-Object { Write-Host $_ }
Write-Host "checker exit code $checkExit, output in $checkTxt"
