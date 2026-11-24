# Builds the upstream usd-brep tree (kernel, USD layer, OCCT .brep converters, Python bindings)
# with its own premake/Packman/repo_build system, using the installed VS 2022 Build Tools.
# Upstream pins vs2019 (MSVC v142); the override lives in user.repo.toml, a per-checkout
# override file that repo_man reads on top of repo.toml.
param(
    [int]$CorePercentage = 37   # about 12 of 32 hardware threads
)
$ErrorActionPreference = 'Continue'   # native tools write progress to stderr
$kt   = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$src  = Join-Path $kt '_deps\usd-brep'
$logs = Join-Path $kt '_build\logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null

# Keep the Packman cache inside _deps. Without PM_PACKAGES_ROOT, Packman's bootstrap
# would pick a default folder and persist it as a user environment variable (setx).
$env:PM_PACKAGES_ROOT = Join-Path $kt '_deps\packman-cache'

$override = Join-Path $src 'user.repo.toml'
if (-not (Test-Path $override)) {
    @'
# Local override (kernel test): use the installed VS 2022 Build Tools (v143) instead of the pinned vs2019.
[repo_build]
msbuild.vs_version = "vs2022"
msbuild.vs_path = "C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools"
'@ | Set-Content -Encoding utf8 $override
}

$preLog   = Join-Path $logs 'upstream-win-prebuild.log'
$buildLog = Join-Path $logs 'upstream-win-build.log'
Push-Location $src
try {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    # Absolute paths: with NoDefaultCurrentDirectoryInExePath set, cmd does not run
    # batch files from the current directory by bare name.
    $prebuild = Join-Path $src 'prebuild.bat'
    $repo     = Join-Path $src 'repo.bat'
    cmd /c "call `"$prebuild`" > `"$preLog`" 2>&1"
    if ($LASTEXITCODE -ne 0) { throw "prebuild failed ($LASTEXITCODE), see $preLog" }
    $t1 = $sw.Elapsed.TotalSeconds
    cmd /c "call `"$repo`" build -r --core-percentage $CorePercentage > `"$buildLog`" 2>&1"
    $rc = $LASTEXITCODE
    $t2 = $sw.Elapsed.TotalSeconds
    "prebuild_s=$t1 build_total_s=$t2 rc=$rc" | Tee-Object -FilePath (Join-Path $logs 'upstream-win-times.txt')
    if ($rc -ne 0) { throw "build failed ($rc), see $buildLog" }
} finally { Pop-Location }
