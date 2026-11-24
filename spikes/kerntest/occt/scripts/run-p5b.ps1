# P5b: reads every STEP file (*.step, *.stp, any case) in -InDir, checks it, cuts a D5 hole along Z through the
# bounding-box centre, writes <name>-occt-cut.step to -OutDir and collects all reports in -ResultsFile.
# Usage: powershell -ExecutionPolicy Bypass -File run-p5b.ps1 -InDir <step folder> -OutDir <output folder> -ResultsFile <p5b.json>
param(
    [Parameter(Mandatory = $true)][string]$InDir,
    [Parameter(Mandatory = $true)][string]$OutDir,
    [Parameter(Mandatory = $true)][string]$ResultsFile
)
$ErrorActionPreference = 'Stop'
$kerntest = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$exe = Join-Path $kerntest '_build\occt-tests-win\kerntest_occt.exe'
$bin = Join-Path $kerntest '_build\occt-win-install\win64\vc14\bin'
if (-not (Test-Path $exe)) { throw "Test program missing: $exe. Run build-tests-windows.ps1 first." }
$env:PATH = "$bin;$env:PATH"

$files = @(Get-ChildItem -Path $InDir -File | Where-Object { $_.Extension -match '^\.(step|stp)$' })
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$reports = @()
if ($files.Count -eq 0) {
    Write-Host "No STEP files in $InDir - P5b stays pending."
    $summary = '{ "status": "pending: no files yet", "files": [] }'
} else {
    foreach ($f in $files) {
        $base = [IO.Path]::GetFileNameWithoutExtension($f.Name)
        $outStep = Join-Path $OutDir "$base-occt-cut.step"
        $json = Join-Path $OutDir "$base-occt-p5b.json"
        & $exe p5b --in $f.FullName --out $outStep --json $json | Out-File -Encoding utf8 (Join-Path $OutDir "$base-occt-p5b.log")
        if (Test-Path $json) { $reports += (Get-Content -Raw $json) }
        else { $reports += ('{ "input": "' + $f.Name + '", "ok": false, "error": "no report written, exit code ' + $LASTEXITCODE + '" }') }
    }
    $summary = '{ "status": "run", "files": [' + ($reports -join ',') + '] }'
}
$dir = Split-Path -Parent $ResultsFile
if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
[IO.File]::WriteAllText($ResultsFile, $summary)
Write-Host "wrote $ResultsFile"
