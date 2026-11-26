# Builds the WebAssembly engine in a throwaway emscripten/emsdk container, linking the static OCCT 8.0.2 that the
# kernel test built with native wasm exceptions (-KeepOcct of spikes\kerntest\occt\scripts\docker-wasm.ps1).
# Usage: powershell -ExecutionPolicy Bypass -File build-wasm.ps1 [-OcctInstall <dir>] [-OutDir <dir>]
# Output: halfcube-engine.mjs + halfcube-engine.wasm in -OutDir (default spikes\architektur\_build\engine-wasm).
# Only the container and volume named below are created and removed.
param([string]$OcctInstall, [string]$OutDir, [string]$Image = 'emscripten/emsdk:7.0.1', [int]$Jobs = 8, [int]$MinFreeGB = 10)
$ErrorActionPreference = 'Stop'

$spike = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$spikes = Split-Path $spike -Parent
. (Join-Path $spikes 'kerntest\occt\scripts\docker-common.ps1')
if (-not $OcctInstall) { $OcctInstall = Join-Path $spikes 'kerntest\_build\wasm-final\wasmeh\occt-install' }
if (-not $OutDir) { $OutDir = Join-Path $spike '_build\engine-wasm' }
if (-not (Test-Path $OcctInstall)) {
    throw "Static WebAssembly OCCT missing: $OcctInstall. Build it with spikes\kerntest\occt\scripts\docker-wasm.ps1 -OutDir <dir> -KeepOcct -WasmExceptions -Extra '-UOCC_CONVERT_SIGNALS'."
}

$name = 'halfcube-arch-engine-wasm'
Assert-FreeSpace $MinFreeGB
Remove-KtContainer $name
docker volume create $name | Out-Null
try {
    docker run -d --name $name -v "${name}:/work" -e "JOBS=$Jobs" $Image sleep infinity | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'docker run failed' }
    Copy-IntoContainer $name $OcctInstall '/work/occt-install'
    Copy-KtSources $name (Join-Path $spike 'engine') '/work/src/engine'
    Copy-IntoContainer $name (Join-Path $spike 'protocol') '/work/src/protocol'
    docker exec $name bash /work/src/engine/docker/wasm-build.sh
    $code = $LASTEXITCODE
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    docker cp "${name}:/work/out/." $OutDir
    if ($code -ne 0) { throw "wasm-build.sh failed ($code)" }
    Write-Host "built $OutDir\halfcube-engine.mjs"
}
finally {
    Remove-KtContainer $name
    docker volume rm $name 2>$null | Out-Null
}
