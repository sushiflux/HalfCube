# Runs every WebAssembly measurement of the kernel test for one build folder (with step\ and nostep\) under Node.js:
# the full run, P1a and P3a each in its own process (start-up and peak memory per case), 20 runs of P1a and P3a,
# the four error probes and, for the STEP build, the STEP-only program on two STEP files of the full run.
# Usage: powershell -ExecutionPolicy Bypass -File run-wasm-all.ps1 -BuildDir <wasm folder> -OutDir <results folder>
param([Parameter(Mandatory = $true)][string]$BuildDir, [Parameter(Mandatory = $true)][string]$OutDir)
$ErrorActionPreference = 'Stop'
$runner = Join-Path $PSScriptRoot '..\wasm\run-node.mjs'

function Invoke-Node([string]$Log, [string[]]$NodeArgs) {
    # Node writes progress to stderr; keep it in the log instead of failing on it.
    $ErrorActionPreference = 'Continue'
    & node $runner @NodeArgs *> $Log
    Write-Host "  exit $LASTEXITCODE -> $Log"
}

foreach ($variant in 'step', 'nostep') {
    $dir = Join-Path $BuildDir $variant
    $out = Join-Path $OutDir $variant
    if (-not (Test-Path (Join-Path $dir 'kerntest_occt.wasm'))) { Write-Host "skipped $variant (no build)"; continue }
    New-Item -ItemType Directory -Force -Path $out | Out-Null
    Write-Host "== $variant"
    Invoke-Node (Join-Path $out 'full.log') @($dir, (Join-Path $out 'node-full.json'), '--', 'run', '--runs', '5',
        '--out', (Join-Path $out 'out'), '--json', (Join-Path $out 'results.json'))
    foreach ($case in 'P1a', 'P3a') {
        Invoke-Node (Join-Path $out "$case.log") @($dir, (Join-Path $out "node-$case.json"), '--', 'run', '--runs', '5',
            '--cases', $case, '--skip-extras', '--out', (Join-Path $out "out-$case"), '--json', (Join-Path $out "results-$case.json"))
    }
    Invoke-Node (Join-Path $out 'steady.log') @($dir, (Join-Path $out 'node-steady.json'), '--', 'run', '--runs', '20',
        '--cases', 'P1a,P3a', '--skip-extras', '--out', (Join-Path $out 'out-steady'), '--json', (Join-Path $out 'results-steady.json'))
    foreach ($probe in 'notdone', 'nullread', 'intdiv', 'nullcall') {
        # intdiv and nullcall end in a WebAssembly trap: exit code 1, the error is in node-probe-*.json.
        Invoke-Node (Join-Path $out "probe-$probe.log") @($dir, (Join-Path $out "node-probe-$probe.json"), '--', 'probe', $probe,
            '--json', (Join-Path $out "probe-$probe.json"))
    }
    if (Test-Path (Join-Path $dir 'kerntest_occt_steponly.wasm')) {
        foreach ($part in 'P1a', 'P4b') {
            $step = Join-Path $out "out\${part}_ap214.step"
            if (-not (Test-Path $step)) { continue }
            Invoke-Node (Join-Path $out "steponly-$part.log") @($dir, (Join-Path $out "node-steponly-$part.json"), '--name',
                'kerntest_occt_steponly', '--', $step, (Join-Path $out "steponly-$part.step"))
        }
    }
}
