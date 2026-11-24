# Builds and runs the OCCT kernel test on Linux in a throwaway ubuntu:24.04 container.
# The sources are copied into a named volume (no bind mount); only the results are copied out to -OutDir.
# Container and volume are removed afterwards.
param([Parameter(Mandatory = $true)][string]$OutDir, [int]$Jobs = 12, [int]$Runs = 5, [int]$MinFreeGB = 15)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'docker-common.ps1')

$kerntest = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$name = 'kt-occt-linux'
Assert-FreeSpace $MinFreeGB
Remove-KtContainer $name
docker volume create $name | Out-Null
try {
    docker run -d --name $name -v "${name}:/work" -e "JOBS=$Jobs" -e "RUNS=$Runs" ubuntu:24.04 sleep infinity | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'docker run failed' }
    Copy-IntoContainer $name (Join-Path $kerntest '_deps\occt-src') '/work/occt-src'
    Copy-KtSources $name (Join-Path $kerntest 'occt') '/work/kt'
    $sw = [Diagnostics.Stopwatch]::StartNew()
    docker exec $name bash /work/kt/docker/linux-build.sh
    $code = $LASTEXITCODE
    "container_total_s={0:N1}" -f $sw.Elapsed.TotalSeconds
    Assert-FreeSpace $MinFreeGB
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    docker cp "${name}:/work/out/." $OutDir
    if ($code -ne 0) { throw "linux-build.sh failed ($code)" }
}
finally {
    Remove-KtContainer $name
    docker volume rm $name 2>$null | Out-Null
}
