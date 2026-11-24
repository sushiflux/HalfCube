# Runs the WebAssembly driver (built by docker-wasm.ps1) under the local Node over the whole catalogue, writes the
# result file and the checker output. Headless: only a console process.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File spikes/solvertest/native/scripts/run-wasm.ps1 [-Reps 5] [-Out <file>]
#
# Default output: spikes/solvertest/_results/own-emscripten.json (+ .check.txt, .run.txt with the peak memory line).
param(
    [int]$Reps = 5,
    [string]$Out = '',
    [string]$RunDate = '2026-11-24',
    [string]$Image = 'emscripten/emsdk:7.0.1'
)
$ErrorActionPreference = 'Stop'

$native = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$solver = (Resolve-Path (Join-Path $native '..')).Path
$js     = Join-Path $solver '_build\own-emscripten\solvertest_driver.js'
if (-not (Test-Path $js)) { throw "driver not built: $js (run docker-wasm.ps1)" }
if (-not $Out) { $Out = Join-Path $solver '_results\own-emscripten.json' }
New-Item -ItemType Directory -Force -Path (Split-Path $Out) | Out-Null
$cases = Join-Path $solver 'cases\cases.json'
$node = Get-Command node -ErrorAction Stop

$os  = Get-CimInstance Win32_OperatingSystem
$cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1).Name.Trim()
$nodeVersion = (& $node.Source --version).Trim()
$runtime = "Node $nodeVersion on $($os.Caption) $($os.Version) ($($os.OSArchitecture)), WebAssembly module built with $Image, CPU $cpu"

$hook = Join-Path $PSScriptRoot 'node-exit-report.cjs'
$runTxt = [IO.Path]::ChangeExtension($Out, '.run.txt')
$ErrorActionPreference = 'Continue'   # the driver writes progress to stderr
$log = & $node.Source --require $hook $js $cases $Out --track own-emscripten --runtime $runtime --run-date $RunDate --reps $Reps 2>&1
$driverExit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
[IO.File]::WriteAllLines($runTxt, [string[]]$log, (New-Object Text.UTF8Encoding($false)))
$log | Select-Object -Last 2 | ForEach-Object { Write-Host $_ }
if ($driverExit -ne 0) { throw "driver failed ($driverExit), see $runTxt" }
Write-Host "wrote $Out"

$checkTxt = [IO.Path]::ChangeExtension($Out, '.check.txt')
$lines = & $node.Source (Join-Path $solver 'check\check.mjs') $cases $Out
$checkExit = $LASTEXITCODE
[IO.File]::WriteAllLines($checkTxt, [string[]]$lines, (New-Object Text.UTF8Encoding($false)))
$lines | Select-Object -Last 3 | ForEach-Object { Write-Host $_ }
Write-Host "checker exit code $checkExit, output in $checkTxt"
