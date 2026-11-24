# Builds the kernel test program against the OCCT installation made by build-occt-windows.ps1.
# Usage: powershell -ExecutionPolicy Bypass -File build-tests-windows.ps1 [-NoStep]
param([switch]$NoStep)
$ErrorActionPreference = 'Stop'

$kerntest = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$srcDir   = Join-Path $kerntest 'occt'
$occtCmake = Join-Path $kerntest '_build\occt-win-install\cmake'
$name     = if ($NoStep) { 'occt-tests-win-nostep' } else { 'occt-tests-win' }
$build    = Join-Path $kerntest "_build\$name"
if (-not (Test-Path (Join-Path $occtCmake 'OpenCASCADEConfig.cmake'))) { throw "OCCT installation missing: $occtCmake. Run build-occt-windows.ps1 first." }
. (Join-Path $PSScriptRoot 'vsenv.ps1')

$step = if ($NoStep) { 'OFF' } else { 'ON' }
cmake -S $srcDir -B $build -G Ninja -DCMAKE_BUILD_TYPE=Release -DOpenCASCADE_DIR="$occtCmake" "-DKT_WITH_STEP=$step"
if ($LASTEXITCODE -ne 0) { throw "CMake configure failed ($LASTEXITCODE)" }
cmake --build $build --parallel 4
if ($LASTEXITCODE -ne 0) { throw "Build failed ($LASTEXITCODE)" }
Write-Host "built $build\kerntest_occt.exe"
