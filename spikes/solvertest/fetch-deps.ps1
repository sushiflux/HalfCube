# Fetches the third-party sources of the solver test into _deps/ (git-ignored) and installs the npm
# package locally. Only official upstream sources; every checkout is verified against the pinned
# commit (or SHA-256 for the Boost archive). Nothing is installed system-wide. Re-running is safe:
# existing, verified checkouts are kept.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File spikes/solvertest/fetch-deps.ps1 [-SkipBoost]
param([switch]$SkipBoost)
$ErrorActionPreference = 'Stop'
$deps = Join-Path $PSScriptRoot '_deps'
New-Item -ItemType Directory -Force -Path $deps | Out-Null

function Get-Checkout([string]$Name, [string]$Url, [string]$Tag, [string]$Commit, [string[]]$Sparse) {
    $dir = Join-Path $deps $Name
    if (Test-Path (Join-Path $dir '.git')) {
        $have = (git -C $dir rev-parse HEAD).Trim()
        if ($have -eq $Commit) { Write-Host "present: $Name ($Tag, $Commit)"; return }
        throw "$Name exists but is at $have, expected $Commit. Remove $dir and run again."
    }
    if ($Sparse) {
        git clone --depth 1 --branch $Tag --filter=blob:none --sparse $Url $dir
        if ($LASTEXITCODE -ne 0) { throw "git clone failed for $Name" }
        git -C $dir sparse-checkout set --cone @Sparse
    } else {
        git clone --depth 1 --branch $Tag $Url $dir
        if ($LASTEXITCODE -ne 0) { throw "git clone failed for $Name" }
    }
    $have = (git -C $dir rev-parse HEAD).Trim()
    if ($have -ne $Commit) { throw "$Name checked out $have, expected $Commit (tag moved?)" }
    Write-Host "fetched: $Name ($Tag, $Commit)"
}

# planegcs from FreeCAD: only the solver, its callers in Sketcher/App (reference for the constraint
# mapping), the planegcs tests and the helper headers that sit directly in src/
Get-Checkout 'FreeCAD' 'https://github.com/FreeCAD/FreeCAD' '1.1.4' '4fd3bf320d9566a27e60069fc8387448aaa3a094' @('src/Mod/Sketcher/App', 'tests/src/Mod/Sketcher/App/planegcs')
# the WebAssembly wrapper repository (README, LICENSE, binding generator, FreeCAD commit it was built from)
Get-Checkout 'Salusoft-planegcs' 'https://github.com/Salusoft89/planegcs' '1.3.0' '9d26baef0b240fe0eef4186d4e5e5e66ec3620b7' $null
Get-Checkout 'eigen-3.4.0' 'https://gitlab.com/libeigen/eigen.git' '3.4.0' '3147391d946bb4b6c68edd901f2add6ac1f31f8c' $null
Get-Checkout 'eigen-5.0.1' 'https://gitlab.com/libeigen/eigen.git' '5.0.1' 'bc3b39870ecb690a623a3f49149a358b95c5781d' $null
Get-Checkout 'nlohmann-json' 'https://github.com/nlohmann/json.git' 'v3.12.0' '55f93686c01528224f448c19128836e7df245f72' $null

# Boost: header-only use (graph, math constants); only boost/ and the licence are extracted
if (-not $SkipBoost) {
    $boost = Join-Path $deps 'boost-1.92.0'
    if (Test-Path (Join-Path $boost 'boost\version.hpp')) { Write-Host 'present: boost-1.92.0' }
    else {
        $dl = Join-Path $deps 'boost-dl'
        New-Item -ItemType Directory -Force -Path $dl | Out-Null
        $archive = Join-Path $dl 'boost_1_92_0.tar.gz'
        Invoke-WebRequest -Uri 'https://archives.boost.io/release/1.92.0/source/boost_1_92_0.tar.gz' -OutFile $archive
        $sha = (Get-FileHash -Algorithm SHA256 $archive).Hash.ToLower()
        if ($sha -ne 'c4a3b310ddd2472416e091067166b0713be97c63f38c212c484ada022fd296ce') { throw "Boost archive SHA-256 mismatch: $sha" }
        New-Item -ItemType Directory -Force -Path $boost | Out-Null
        tar -xzf $archive -C $boost --strip-components=1 boost_1_92_0/boost boost_1_92_0/LICENSE_1_0.txt
        if ($LASTEXITCODE -ne 0) { throw 'tar failed' }
        Remove-Item $archive
        Write-Host 'fetched: boost-1.92.0 (SHA-256 verified)'
    }
}

# the prebuilt WebAssembly package, installed locally with the exact pinned version, no install scripts
Push-Location (Join-Path $PSScriptRoot 'salusoft')
try {
    npm install --ignore-scripts --no-audit --no-fund --save-exact
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
} finally { Pop-Location }
Write-Host 'done'
