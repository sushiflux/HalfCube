# Configures, builds and installs OCCT (shared, Release, C++20) with MSVC and Ninja.
# Only the modules the kernel test needs are switched on; CMake pulls in the toolkits they depend on.
# Usage: powershell -ExecutionPolicy Bypass -File build-occt-windows.ps1 [-Jobs 12] [-Clean] [-BuildName occt-win] [-NoInstall]
param([int]$Jobs = 12, [switch]$Clean, [string]$BuildName = "occt-win", [switch]$NoInstall)
$ErrorActionPreference = 'Stop'

$kerntest = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$src      = Join-Path $kerntest '_deps\occt-src'
$build    = Join-Path $kerntest "_build\$BuildName"
$install  = Join-Path $kerntest "_build\$BuildName-install"
if (-not (Test-Path (Join-Path $src 'CMakeLists.txt'))) {
    throw "OCCT source missing: $src. Run fetch-occt.ps1 first."
}
. (Join-Path $PSScriptRoot 'vsenv.ps1')

if ($Clean -and (Test-Path $build)) { Remove-Item -Recurse -Force $build }
New-Item -ItemType Directory -Force -Path $build | Out-Null

$sw = [Diagnostics.Stopwatch]::StartNew()
cmake -S $src -B $build -G Ninja `
    -DCMAKE_BUILD_TYPE=Release `
    -DBUILD_LIBRARY_TYPE=Shared `
    -DBUILD_CPP_STANDARD=C++20 `
    -DINSTALL_DIR="$install" `
    -DBUILD_MODULE_FoundationClasses=ON `
    -DBUILD_MODULE_ModelingData=ON `
    -DBUILD_MODULE_ModelingAlgorithms=ON `
    -DBUILD_MODULE_DataExchange=ON `
    -DBUILD_MODULE_Visualization=OFF `
    -DBUILD_MODULE_ApplicationFramework=OFF `
    -DBUILD_MODULE_Draw=OFF `
    -DBUILD_DOC_Overview=OFF `
    -DBUILD_GTEST=OFF `
    -DUSE_FREETYPE=OFF -DUSE_TK=OFF -DUSE_OPENGL=OFF -DUSE_GLES2=OFF -DUSE_D3D=OFF `
    -DUSE_FREEIMAGE=OFF -DUSE_FFMPEG=OFF -DUSE_OPENVR=OFF -DUSE_RAPIDJSON=OFF -DUSE_DRACO=OFF `
    -DUSE_TBB=OFF -DUSE_VTK=OFF -DUSE_EIGEN=OFF
if ($LASTEXITCODE -ne 0) { throw "CMake configure failed ($LASTEXITCODE)" }
$tConfigure = $sw.Elapsed.TotalSeconds

cmake --build $build --parallel $Jobs
if ($LASTEXITCODE -ne 0) { throw "OCCT build failed ($LASTEXITCODE)" }
$tBuild = $sw.Elapsed.TotalSeconds - $tConfigure

if (-not $NoInstall) {
    cmake --install $build
    if ($LASTEXITCODE -ne 0) { throw "OCCT install failed ($LASTEXITCODE)" }
}
"configure_s={0:N1} build_s={1:N1} total_s={2:N1}" -f $tConfigure, $tBuild, $sw.Elapsed.TotalSeconds
