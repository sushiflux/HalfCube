# Builds the native engine (Release) against the OCCT 8.0.2 Windows installation of the kernel test.
# Usage: powershell -ExecutionPolicy Bypass -File build-windows.ps1 [-OcctDir <OCCT install>] [-Clean]
# Output: spikes\architektur\_build\engine-win\partcraft-engine.exe plus the OCCT DLLs it needs.
param([string]$OcctDir, [switch]$Clean)
$ErrorActionPreference = 'Stop'

$spike = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$spikes = Split-Path $spike -Parent
if (-not $OcctDir) { $OcctDir = Join-Path $spikes 'kerntest\_build\occt-win-install' }
$occtCmake = Join-Path $OcctDir 'cmake'
if (-not (Test-Path (Join-Path $occtCmake 'OpenCASCADEConfig.cmake'))) {
    throw "OCCT installation missing: $occtCmake. Build it with spikes\kerntest\occt\scripts\build-occt-windows.ps1 first."
}
. (Join-Path $spikes 'kerntest\occt\scripts\vsenv.ps1')

$build = Join-Path $spike '_build\engine-win'
if ($Clean -and (Test-Path $build)) { Remove-Item -Recurse -Force $build }
cmake -S (Join-Path $spike 'engine') -B $build -G Ninja -DCMAKE_BUILD_TYPE=Release "-DOpenCASCADE_DIR=$occtCmake"
if ($LASTEXITCODE -ne 0) { throw "CMake configure failed ($LASTEXITCODE)" }
cmake --build $build --parallel 8
if ($LASTEXITCODE -ne 0) { throw "Build failed ($LASTEXITCODE)" }
Write-Host "built $build\partcraft-engine.exe"
