# Clones OCCT at the tested tag into ../../_deps/occt-src (shallow clone, git-ignored folder).
# Licence of OCCT: LGPL-2.1-only WITH OCCT-exception-1.0 (see LICENSE_LGPL_21.txt and OCCT_LGPL_EXCEPTION.txt there).
param([string]$Tag = 'V8_0_2')
$ErrorActionPreference = 'Stop'
$kerntest = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$dest = Join-Path $kerntest '_deps\occt-src'
if (Test-Path (Join-Path $dest 'CMakeLists.txt')) { Write-Host "already present: $dest"; return }
git clone --depth 1 --branch $Tag https://github.com/Open-Cascade-SAS/OCCT.git $dest
if ($LASTEXITCODE -ne 0) { throw "git clone failed ($LASTEXITCODE)" }
git -C $dest log -1 --format='%H %ci'
