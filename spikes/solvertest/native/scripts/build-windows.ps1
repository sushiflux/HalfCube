# Builds planegcs (from ../_deps/FreeCAD) and the solver test driver natively with MSVC, Release,
# C++20, using the Visual Studio 2022 Build Tools found by vswhere (via the kernel test's vsenv.ps1).
# CMake and Ninja are the ones that ship with Visual Studio; nothing needs to be on PATH.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File spikes/solvertest/native/scripts/build-windows.ps1 [-Eigen 3.4.0|5.0.1] [-Clean]
param(
    [ValidateSet('3.4.0', '5.0.1')][string]$Eigen = '3.4.0',
    [switch]$Clean
)
$ErrorActionPreference = 'Stop'

$native    = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$solver    = (Resolve-Path (Join-Path $native '..')).Path
$deps      = Join-Path $solver '_deps'
$eigenDir  = Join-Path $deps "eigen-$Eigen"
$suffix    = if ($Eigen -eq '3.4.0') { '' } else { "-eigen$($Eigen.Replace('.', ''))" }
$build     = Join-Path $solver "_build\native-msvc$suffix"
foreach ($p in @((Join-Path $deps 'FreeCAD\src\Mod\Sketcher\App\planegcs\GCS.cpp'), (Join-Path $eigenDir 'Eigen\Core'),
                 (Join-Path $deps 'boost-1.92.0\boost\version.hpp'), (Join-Path $deps 'nlohmann-json\single_include\nlohmann\json.hpp'))) {
    if (-not (Test-Path $p)) { throw "missing dependency: $p (run scripts/fetch-deps.ps1)" }
}

. (Join-Path $PSScriptRoot '..\..\..\kerntest\occt\scripts\vsenv.ps1')

if ($Clean -and (Test-Path $build)) { Remove-Item -Recurse -Force $build }
cmake -S $native -B $build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_COMPILER=cl "-DHCST_EIGEN_DIR=$eigenDir" -DHCST_TRACK=native-msvc
if ($LASTEXITCODE -ne 0) { throw "CMake configure failed ($LASTEXITCODE)" }
cmake --build $build --parallel 4
if ($LASTEXITCODE -ne 0) { throw "build failed ($LASTEXITCODE)" }
Write-Host "built $(Join-Path $build 'solvertest_driver.exe')"
