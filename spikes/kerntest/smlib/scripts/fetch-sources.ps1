# Clones NVIDIA usd-brep at the tested tag into ../../_deps/usd-brep and applies the C++20
# patch (patches/0001-*.patch). Safe to re-run: an existing checkout is only verified.
param(
    [string]$Tag = 'v1.0.2',
    [string]$Commit = '9701dd0cf4b8f4fe379290b3032e9407deb220df'
)
$ErrorActionPreference = 'Stop'
$here  = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$deps  = Join-Path (Resolve-Path (Join-Path $here '..')).Path '_deps'
$src   = Join-Path $deps 'usd-brep'
$patch = Join-Path $here 'patches\0001-cxx20-build-fixes.patch'
New-Item -ItemType Directory -Force -Path $deps | Out-Null

if (-not (Test-Path (Join-Path $src '.git'))) {
    git -c advice.detachedHead=false clone --branch $Tag --depth 1 https://github.com/NVIDIA-Omniverse/usd-brep.git $src
    if ($LASTEXITCODE -ne 0) { throw "git clone failed" }
}
$head = (git -C $src rev-parse HEAD).Trim()
if ($head -ne $Commit) { throw "unexpected commit $head (expected $Commit for $Tag)" }

git -C $src apply --check -R $patch 2>$null
if ($LASTEXITCODE -eq 0) { Write-Host "patch already applied"; exit 0 }
git -C $src apply $patch
if ($LASTEXITCODE -ne 0) { throw "patch does not apply" }
Write-Host "patch applied"
