# Fetches (or verifies) the third-party sources the native build needs into ../../_deps (git-ignored):
# FreeCAD (planegcs), Eigen, Boost headers, nlohmann/json. Only official upstream sources, pinned to
# exact commits (Boost: SHA-256 of the release archive). Nothing is installed system-wide; existing,
# verified checkouts are kept. Same pins as spikes/solvertest/fetch-deps.ps1, without the npm part.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File spikes/solvertest/native/scripts/fetch-deps.ps1
$ErrorActionPreference = 'Stop'
$deps = (Join-Path $PSScriptRoot '..\..\_deps')
New-Item -ItemType Directory -Force -Path $deps | Out-Null
$deps = (Resolve-Path $deps).Path

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
        if ($LASTEXITCODE -ne 0) { throw "sparse-checkout failed for $Name" }
    } else {
        git clone --depth 1 --branch $Tag $Url $dir
        if ($LASTEXITCODE -ne 0) { throw "git clone failed for $Name" }
    }
    $have = (git -C $dir rev-parse HEAD).Trim()
    if ($have -ne $Commit) { throw "$Name checked out $have, expected $Commit (tag moved?)" }
    Write-Host "fetched: $Name ($Tag, $Commit)"
}

# planegcs lives in src/Mod/Sketcher/App/planegcs; the build also reads src/FCGlobal.h,
# src/boost_graph_adjacency_list.hpp and src/Mod/Sketcher/SketcherGlobal.h (cone mode includes the
# files directly in every parent folder of the listed folders).
Get-Checkout 'FreeCAD' 'https://github.com/FreeCAD/FreeCAD' '1.1.4' '4fd3bf320d9566a27e60069fc8387448aaa3a094' @('src/Mod/Sketcher/App', 'tests/src/Mod/Sketcher/App/planegcs')
Get-Checkout 'eigen-3.4.0' 'https://gitlab.com/libeigen/eigen.git' '3.4.0' '3147391d946bb4b6c68edd901f2add6ac1f31f8c' $null
Get-Checkout 'eigen-5.0.1' 'https://gitlab.com/libeigen/eigen.git' '5.0.1' 'bc3b39870ecb690a623a3f49149a358b95c5781d' $null
Get-Checkout 'nlohmann-json' 'https://github.com/nlohmann/json.git' 'v3.12.0' '55f93686c01528224f448c19128836e7df245f72' $null

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
Write-Host 'done'
