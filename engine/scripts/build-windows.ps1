# Builds the native engine on Windows (MSVC, Ninja, Release) and runs the C++ unit tests.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File engine/scripts/build-windows.ps1 [options]
#
#   -OcctDir <dir>   use an existing OCCT 8.0.2 installation (shared, Release, C++20, built with the flags below);
#                    also read from the environment variable HALFCUBE_OCCT_DIR. Without it, OCCT is built from
#                    engine/_deps/occt-src into engine/_build/occt-windows-install once and reused afterwards.
#   -TestCommands    build with the test commands diagnostics.crash and diagnostics.hang (separate build folder)
#   -Clean           delete the engine build folder first
#   -NoTests         do not run the unit tests
#   -Jobs <n>        parallel compile jobs (default: number of logical processors)
#
# Output: engine/_build/windows-release[-testing]/bin/halfcube-engine.exe with the OCCT DLLs next to it.
# Needs Visual Studio 2022 or its Build Tools with the C++ workload; vswhere finds them, nothing has to be on PATH.
param([string]$OcctDir = $env:HALFCUBE_OCCT_DIR, [switch]$TestCommands, [switch]$Clean, [switch]$NoTests, [int]$Jobs = 0)
$ErrorActionPreference = 'Stop'

$engine = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$buildRoot = Join-Path $engine '_build'
if ($Jobs -le 0) { $Jobs = [Environment]::ProcessorCount }
. (Join-Path $PSScriptRoot 'vsenv.ps1')

function Find-OcctConfig([string]$Dir) {
    $cfg = Get-ChildItem -Path $Dir -Recurse -Filter 'OpenCASCADEConfig.cmake' -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $cfg) { throw "No OpenCASCADEConfig.cmake below $Dir; that folder is no OCCT installation." }
    return $cfg.DirectoryName
}

# CMake build folders and the OCCT install config store absolute paths. When the project folder has been moved or renamed
# they point to a folder that no longer exists, so they are detected here and recreated instead of failing the build.
# Normalised form of a path for comparisons: forward slashes, no trailing slash, lower case (Windows paths are case-insensitive).
function Normalize-Path([string]$P) { return $P.Replace('\', '/').TrimEnd('/').ToLowerInvariant() }
# True when the CMake cache in $Dir was created for another source folder than $ExpectedHome.
function Test-CacheMoved([string]$Dir, [string]$ExpectedHome) {
    $cache = Join-Path $Dir 'CMakeCache.txt'
    if (-not (Test-Path $cache)) { return $false }
    $m = Select-String -Path $cache -Pattern '^CMAKE_HOME_DIRECTORY:[A-Z]+=(.*)$' | Select-Object -First 1
    if (-not $m) { return $false }
    return (Normalize-Path $m.Matches[0].Groups[1].Value.Trim()) -ne (Normalize-Path $ExpectedHome)
}
# True when the installed OpenCASCADEConfig.cmake names an absolute path outside the engine folder.
function Test-OcctInstallMoved([string]$Install, [string]$EngineDir) {
    $cfg = Get-ChildItem -Path $Install -Recurse -Filter 'OpenCASCADEConfig.cmake' -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $cfg) { return $false }
    $prefix = (Normalize-Path $EngineDir) + '/'
    foreach ($m in [regex]::Matches((Get-Content -Raw $cfg.FullName), '"([A-Za-z]:[/\\][^"]*)"')) {
        if (-not ((Normalize-Path $m.Groups[1].Value) + '/').StartsWith($prefix)) { return $true }
    }
    return $false
}

# OCCT configure options. Same modules and switches as the Linux build; DataExchange is kept for
# the STEP, IGES and STL work of later phases.
$occtOptions = @(
    '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_LIBRARY_TYPE=Shared', '-DBUILD_CPP_STANDARD=C++20',
    '-DBUILD_MODULE_FoundationClasses=ON', '-DBUILD_MODULE_ModelingData=ON', '-DBUILD_MODULE_ModelingAlgorithms=ON',
    '-DBUILD_MODULE_DataExchange=ON', '-DBUILD_MODULE_Visualization=OFF', '-DBUILD_MODULE_ApplicationFramework=OFF',
    '-DBUILD_MODULE_Draw=OFF', '-DBUILD_DOC_Overview=OFF', '-DBUILD_GTEST=OFF',
    '-DUSE_FREETYPE=OFF', '-DUSE_TK=OFF', '-DUSE_OPENGL=OFF', '-DUSE_GLES2=OFF', '-DUSE_D3D=OFF', '-DUSE_FREEIMAGE=OFF',
    '-DUSE_FFMPEG=OFF', '-DUSE_OPENVR=OFF', '-DUSE_RAPIDJSON=OFF', '-DUSE_DRACO=OFF', '-DUSE_TBB=OFF', '-DUSE_VTK=OFF',
    '-DUSE_EIGEN=OFF')
$sw = [Diagnostics.Stopwatch]::StartNew()
$occtSeconds = 0

if ($OcctDir) {
    $occtConfig = Find-OcctConfig $OcctDir
    Write-Host "using the OCCT installation $OcctDir"
} else {
    $src = Join-Path $engine '_deps\occt-src'
    $occtBuild = Join-Path $buildRoot 'occt-windows'
    $occtInstall = Join-Path $buildRoot 'occt-windows-install'
    $stampFile = Join-Path $occtInstall '.halfcube-occt'
    $srcPin = Join-Path $src '.halfcube-pin'
    if (-not (Test-Path $srcPin)) { throw "OCCT sources missing in $src. Run engine/scripts/fetch-deps.ps1 first (or pass -OcctDir)." }
    $stamp = ((Get-Content -Raw $srcPin).Trim()) + ' | msvc | ' + ($occtOptions -join ' ')
    $stampOk = (Test-Path $stampFile) -and ((Get-Content -Raw $stampFile).Trim() -eq $stamp)
    $occtMoved = $stampOk -and (Test-OcctInstallMoved $occtInstall $engine)
    if ($occtMoved) { Write-Host "the OCCT installation $occtInstall refers to a folder outside $engine (project folder moved or renamed); rebuilding it" }
    if ($stampOk -and -not $occtMoved) {
        Write-Host "reusing $occtInstall (same OCCT sources and options)"
    } else {
        Write-Host "building OCCT from $src (about 10 minutes) ..."
        if (Test-Path $occtInstall) { Remove-Item -Recurse -Force $occtInstall }
        if ((Test-Path $occtBuild) -and ($occtMoved -or (Test-CacheMoved $occtBuild $src))) {
            Write-Host "removing the OCCT build folder $occtBuild (it holds paths of the old project folder)"
            Remove-Item -Recurse -Force $occtBuild
        }
        cmake -S $src -B $occtBuild -G Ninja "-DINSTALL_DIR=$occtInstall" @occtOptions
        if ($LASTEXITCODE -ne 0) { throw "OCCT configure failed ($LASTEXITCODE)." }
        cmake --build $occtBuild --parallel $Jobs
        if ($LASTEXITCODE -ne 0) { throw "OCCT build failed ($LASTEXITCODE)." }
        cmake --install $occtBuild
        if ($LASTEXITCODE -ne 0) { throw "OCCT install failed ($LASTEXITCODE)." }
        [IO.File]::WriteAllText($stampFile, "$stamp`n")
        $occtSeconds = $sw.Elapsed.TotalSeconds
    }
    $occtConfig = Find-OcctConfig $occtInstall
}

$name = if ($TestCommands) { 'windows-release-testing' } else { 'windows-release' }
$build = Join-Path $buildRoot $name
if ($Clean -and (Test-Path $build)) { Remove-Item -Recurse -Force $build }
if ((Test-Path $build) -and (Test-CacheMoved $build $engine)) {
    Write-Host "removing the engine build folder $build (its CMake cache was created in another project folder)"
    Remove-Item -Recurse -Force $build
}
$t0 = $sw.Elapsed.TotalSeconds
cmake -S $engine -B $build -G Ninja -DCMAKE_BUILD_TYPE=Release "-DOpenCASCADE_DIR=$occtConfig" `
    "-DHALFCUBE_TEST_COMMANDS=$(if ($TestCommands) { 'ON' } else { 'OFF' })"
if ($LASTEXITCODE -ne 0) { throw "Engine configure failed ($LASTEXITCODE)." }
cmake --build $build --parallel $Jobs
if ($LASTEXITCODE -ne 0) { throw "Engine build failed ($LASTEXITCODE)." }
$engineSeconds = $sw.Elapsed.TotalSeconds - $t0

if (-not $NoTests) {
    & (Join-Path $build 'bin\halfcube-engine-tests.exe')
    if ($LASTEXITCODE -ne 0) { throw "Unit tests failed ($LASTEXITCODE)." }
}

$exe = Join-Path $build 'bin\halfcube-engine.exe'
$dlls = Get-ChildItem (Join-Path $build 'bin') -Filter 'TK*.dll'
"built {0} ({1:N0} bytes) with {2} OCCT DLLs ({3:N0} bytes)" -f $exe, (Get-Item $exe).Length, $dlls.Count, ($dlls | Measure-Object Length -Sum).Sum
"times: occt_build_s={0:N1} engine_build_s={1:N1} total_s={2:N1}" -f $occtSeconds, $engineSeconds, $sw.Elapsed.TotalSeconds
