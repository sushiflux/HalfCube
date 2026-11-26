# Builds planegcs and the solver test driver for WebAssembly in a throwaway emscripten/emsdk container.
# Sources are copied in with docker cp (nothing of the drive is mounted); only the .js/.wasm files and the logs are
# copied out to -OutDir (default: spikes/solvertest/_build/own-emscripten). Container and volume are removed at the end.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File spikes/solvertest/native/scripts/docker-wasm.ps1 [-Extra '<more flags>']
param([string]$OutDir = '', [string]$Image = 'emscripten/emsdk:7.0.1', [int]$Jobs = 12, [int]$MinFreeGB = 5, [string]$Extra = '')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\..\..\kerntest\occt\scripts\docker-common.ps1')

$native  = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$solver  = (Resolve-Path (Join-Path $native '..')).Path
$deps    = Join-Path $solver '_deps'
if (-not $OutDir) { $OutDir = Join-Path $solver '_build\own-emscripten' }
$name = 'halfcube-solvertest-wasm'
foreach ($p in @('FreeCAD', 'eigen-3.4.0', 'boost-1.92.0', 'nlohmann-json')) {
    if (-not (Test-Path (Join-Path $deps $p))) { throw "missing dependency: $deps\$p (run scripts/fetch-deps.ps1)" }
}
Assert-FreeSpace $MinFreeGB
Remove-KtContainer $name
docker volume create $name | Out-Null
try {
    docker run -d --name $name -v "${name}:/work" -e "JOBS=$Jobs" -e "WASM_EXTRA=$Extra" $Image sleep infinity | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'docker run failed' }
    Copy-KtSources $name $native '/work/solvertest/native'
    foreach ($p in @('FreeCAD', 'eigen-3.4.0', 'boost-1.92.0', 'nlohmann-json')) {
        Copy-IntoContainer $name (Join-Path $deps $p) "/work/solvertest/_deps/$p"
    }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    docker exec $name bash /work/solvertest/native/docker/wasm-build.sh
    $code = $LASTEXITCODE
    "container_total_s={0:N1}" -f $sw.Elapsed.TotalSeconds
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    docker cp "${name}:/work/out/." $OutDir
    if ($code -ne 0) { throw "wasm-build.sh failed ($code)" }
    Write-Host "built into $OutDir"
}
finally {
    Remove-KtContainer $name
    docker volume rm $name 2>$null | Out-Null
}
