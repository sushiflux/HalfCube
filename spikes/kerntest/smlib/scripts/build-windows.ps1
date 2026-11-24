# Builds the SMLib kernel (SMLib + SM_API) and the kernel test program with MSVC (C++20,
# Release, Ninja). Uses the Visual Studio Build Tools found by vswhere and the CMake and
# Ninja that ship with them. Nothing is installed.
param(
    [int]$Jobs = 12,
    [switch]$Clean
)
$ErrorActionPreference = 'Stop'
$here  = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$kt    = (Resolve-Path (Join-Path $here '..')).Path
$build = Join-Path $kt '_build\smlib-win'
$logs  = Join-Path $kt '_build\logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null

. (Join-Path $PSScriptRoot 'vsenv.ps1')
Import-VsDevEnv

if ($Clean -and (Test-Path $build)) { Remove-Item -Recurse -Force $build }
New-Item -ItemType Directory -Force -Path $build | Out-Null

$sw = [Diagnostics.Stopwatch]::StartNew()
& cmake -S $here -B $build -G Ninja -DCMAKE_BUILD_TYPE=Release 2>&1 | Tee-Object -FilePath (Join-Path $logs 'smlib-win-configure.log')
if ($LASTEXITCODE -ne 0) { throw "CMake configure failed" }
$tConf = $sw.Elapsed.TotalSeconds
$ErrorActionPreference = 'Continue'
& cmake --build $build --parallel $Jobs -- -k 0 *>&1 | Out-File -Encoding utf8 (Join-Path $logs 'smlib-win-build.log')
$rc = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
$tBuild = $sw.Elapsed.TotalSeconds - $tConf
"configure_s=$([math]::Round($tConf,1)) build_s=$([math]::Round($tBuild,1)) jobs=$Jobs rc=$rc" |
    Tee-Object -FilePath (Join-Path $logs 'smlib-win-times.txt')
if ($rc -ne 0) { throw "build failed, see $(Join-Path $logs 'smlib-win-build.log')" }
