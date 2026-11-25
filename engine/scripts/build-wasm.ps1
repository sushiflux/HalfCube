# Builds the WebAssembly engine (partcraft-engine.mjs + .wasm) in a throwaway emscripten/emsdk container.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File engine/scripts/build-wasm.ps1 [options]
#
#   -TestCommands     build with the test commands diagnostics.crash and diagnostics.hang
#   -OcctInstall <d>  reuse a static WebAssembly OCCT installation (default: engine/_build/occt-wasm-install when it
#                     exists); without one OCCT is built from engine/_deps/occt-src (about 5 minutes) and kept there
#   -FreshOcct        ignore an existing OCCT installation and build OCCT from source
#   -Jobs <n>         parallel compile jobs (default: number of logical processors)
#
# Output: engine/_build/wasm[-testing]/ with the module, the Emscripten runtime licence texts in licenses/ and the
# build logs in logs/. Needs Docker. The container and the volume are both named partcraft-engine-wasm and are removed
# at the end, also on failure; nothing else in Docker is touched.
param([switch]$TestCommands, [string]$OcctInstall = '', [switch]$FreshOcct, [int]$Jobs = 0,
      [string]$Image = 'emscripten/emsdk:7.0.1@sha256:73aece2e0ab748487945ad117b79fc4d277e9f656e54fc800a9b1a0a6562715b')
$ErrorActionPreference = 'Stop'

$engine = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repo = (Resolve-Path (Join-Path $engine '..')).Path
$buildRoot = Join-Path $engine '_build'
$outDir = Join-Path $buildRoot ($(if ($TestCommands) { 'wasm-testing' } else { 'wasm' }))
$defaultOcct = Join-Path $buildRoot 'occt-wasm-install'
if (-not $OcctInstall -and -not $FreshOcct -and (Test-Path (Join-Path $defaultOcct '.partcraft-occt'))) { $OcctInstall = $defaultOcct }
if ($Jobs -le 0) { $Jobs = [Environment]::ProcessorCount }
$name = 'partcraft-engine-wasm'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker is not installed or not on PATH; the WebAssembly build runs in a Docker container.' }
foreach ($dep in 'freecad', 'eigen', 'boost', 'nlohmann-json') {
    if (-not (Test-Path (Join-Path $engine "_deps\$dep\.partcraft-pin"))) { throw "engine/_deps/$dep is missing; run engine/scripts/fetch-deps.ps1 first." }
}
if (-not $OcctInstall -and -not (Test-Path (Join-Path $engine '_deps\occt-src\.partcraft-pin'))) {
    throw 'engine/_deps/occt-src is missing and no prebuilt WebAssembly OCCT was given; run engine/scripts/fetch-deps.ps1 first.'
}

function Invoke-Docker {
    & docker @args
    if ($LASTEXITCODE -ne 0) { throw "docker $($args -join ' ') failed with exit code $LASTEXITCODE." }
}
function Remove-Own {
    if (docker ps -aq --filter "name=^${name}$") { docker rm -f $name | Out-Null }
    if (docker volume ls -q --filter "name=^${name}$") { docker volume rm $name | Out-Null }
}

$sw = [Diagnostics.Stopwatch]::StartNew()
Remove-Own
try {
    Invoke-Docker volume create $name | Out-Null
    Invoke-Docker run -d --name $name -v "${name}:/work" -e "JOBS=$Jobs" -e "TEST_COMMANDS=$(if ($TestCommands) { 1 } else { 0 })" $Image sleep infinity | Out-Null

    # Sources: only what the build reads, without build trees and without the native OCCT sources.
    Invoke-Docker exec $name mkdir -p /work/src/engine/_deps /work/src/third_party
    foreach ($item in 'CMakeLists.txt', 'cmake', 'src', 'third_party_shims', 'docker') {
        Invoke-Docker cp (Join-Path $engine $item) "${name}:/work/src/engine/$item"
    }
    foreach ($dep in 'freecad', 'eigen', 'boost', 'nlohmann-json') {
        Invoke-Docker cp (Join-Path $engine "_deps\$dep") "${name}:/work/src/engine/_deps/$dep"
    }
    Invoke-Docker cp (Join-Path $repo 'version.txt') "${name}:/work/src/version.txt"
    Invoke-Docker cp (Join-Path $repo 'third_party\manifest.json') "${name}:/work/src/third_party/manifest.json"
    if ($OcctInstall) {
        Write-Host "using the prebuilt WebAssembly OCCT in $OcctInstall"
        Invoke-Docker cp $OcctInstall "${name}:/work/occt-install"
    } else {
        Write-Host 'copying the OCCT sources into the container'
        Invoke-Docker cp (Join-Path $engine '_deps\occt-src') "${name}:/work/occt-src"
    }
    Invoke-Docker exec $name sh -c "find /work/src/engine/docker -name '*.sh' -exec sed -i 's/\r$//' {} +"

    docker exec $name bash /work/src/engine/docker/wasm-build.sh
    $code = $LASTEXITCODE

    if (Test-Path $outDir) { Remove-Item -Recurse -Force $outDir }
    New-Item -ItemType Directory -Force -Path (Join-Path $outDir 'logs') | Out-Null
    Invoke-Docker cp "${name}:/work/out/." (Join-Path $outDir 'logs')
    if ($code -ne 0) { throw "The WebAssembly build failed (exit code $code); logs in $outDir\logs." }
    foreach ($f in 'partcraft-engine.mjs', 'partcraft-engine.wasm') { Move-Item (Join-Path $outDir "logs\$f") (Join-Path $outDir $f) }
    Move-Item (Join-Path $outDir 'logs\licenses') (Join-Path $outDir 'licenses')
    if (-not $OcctInstall) {
        if (Test-Path $defaultOcct) { Remove-Item -Recurse -Force $defaultOcct }
        Invoke-Docker cp "${name}:/work/occt-install" $defaultOcct
    }
}
finally {
    Remove-Own
}
$wasm = (Get-Item (Join-Path $outDir 'partcraft-engine.wasm')).Length
$mjs = (Get-Item (Join-Path $outDir 'partcraft-engine.mjs')).Length
Write-Host ("built {0}: partcraft-engine.wasm {1} bytes, partcraft-engine.mjs {2} bytes" -f $outDir, $wasm, $mjs)
Get-Content (Join-Path $outDir 'logs\occt-times.txt'), (Join-Path $outDir 'logs\engine-times.txt')
Write-Host ("total_s={0:N1}" -f $sw.Elapsed.TotalSeconds)
