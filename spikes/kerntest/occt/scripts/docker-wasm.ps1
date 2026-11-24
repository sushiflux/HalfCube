# Builds OCCT and the kernel test for WebAssembly in a throwaway emscripten/emsdk container.
# Sources are copied into a named volume; only the .js/.wasm files and logs are copied out to -OutDir.
# -KeepOcct also copies the static OCCT installation to <OutDir>\occt-install; -PrebuiltOcct <dir> reuses such a
# copy and only relinks the test program.
param([Parameter(Mandatory = $true)][string]$OutDir, [string]$Image = 'emscripten/emsdk:7.0.1', [int]$Jobs = 12,
      [int]$MinFreeGB = 15, [switch]$KeepOcct, [string]$PrebuiltOcct, [switch]$WasmExceptions)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'docker-common.ps1')

$kerntest = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$name = 'kt-occt-wasm'
Assert-FreeSpace $MinFreeGB
Remove-KtContainer $name
docker volume create $name | Out-Null
try {
    docker run -d --name $name -v "${name}:/work" -e "JOBS=$Jobs" -e "WASM_EH=$(if ($WasmExceptions) { 1 } else { 0 })" $Image sleep infinity | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'docker run failed' }
    if ($PrebuiltOcct) {
        Copy-IntoContainer $name $PrebuiltOcct '/work/occt-install'
        docker exec $name touch /work/occt-install/.prebuilt
    } else {
        Copy-IntoContainer $name (Join-Path $kerntest '_deps\occt-src') '/work/occt-src'
    }
    Copy-KtSources $name (Join-Path $kerntest 'occt') '/work/kt'
    $sw = [Diagnostics.Stopwatch]::StartNew()
    docker exec $name bash /work/kt/docker/wasm-build.sh
    $code = $LASTEXITCODE
    "container_total_s={0:N1}" -f $sw.Elapsed.TotalSeconds
    Assert-FreeSpace $MinFreeGB
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    docker cp "${name}:/work/out/." $OutDir
    if ($KeepOcct -and -not $PrebuiltOcct) { docker cp "${name}:/work/occt-install" (Join-Path $OutDir 'occt-install') }
    if ($code -ne 0) { throw "wasm-build.sh failed ($code)" }
}
finally {
    Remove-KtContainer $name
    docker volume rm $name 2>$null | Out-Null
}
