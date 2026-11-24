# Runs every kernel test case of the Windows build in its own process (a kernel crash only
# loses that case) and merges the results into one JSON file.
#   run-windows.ps1 [-Runs 5] [-Cases P1a,P3a] [-Out <dir>]
# Default output: ../_build/results/windows (relative to the spike folder).
param(
    [int]$Runs = 5,
    [string[]]$Cases = @(),
    [string]$Out = ''
)
$ErrorActionPreference = 'Stop'
$here = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$kt   = (Resolve-Path (Join-Path $here '..')).Path
$exe  = Join-Path $kt '_build\smlib-win\smlib_kerntest.exe'
if (-not (Test-Path $exe)) { throw "not built yet: run build-windows.ps1 first ($exe)" }
if (-not $Out) { $Out = Join-Path $kt '_build\results\windows' }
$caseDir = Join-Path $Out 'cases'
$artDir  = Join-Path $Out 'artefacts'
New-Item -ItemType Directory -Force -Path $caseDir, $artDir | Out-Null

if ($Cases.Count -eq 0) { $Cases = (& $exe --list) | ForEach-Object { $_.Trim() } | Where-Object { $_ } }
foreach ($c in $Cases) {
    $json = Join-Path $caseDir "$c.json"
    Remove-Item -Force -ErrorAction SilentlyContinue $json
    $p = Start-Process -FilePath $exe -ArgumentList @('--runs', $Runs, '--out', $artDir, '--json', $json, $c) `
        -NoNewWindow -Wait -PassThru `
        -RedirectStandardError (Join-Path $caseDir "$c.stderr.txt") -RedirectStandardOutput (Join-Path $caseDir "$c.stdout.txt")
    Set-Content -Path (Join-Path $caseDir "$c.exit") -Value $p.ExitCode -Encoding ascii
    Write-Host ("{0,-12} exit {1}" -f $c, $p.ExitCode)
}
& node (Join-Path $PSScriptRoot 'merge-results.mjs') (Join-Path $Out 'smlib-windows.json') $caseDir @Cases
if ($LASTEXITCODE -ne 0) { throw "merge failed" }
