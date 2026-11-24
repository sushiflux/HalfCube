# P5b (STEP files from another CAD program) for the SMLib track.
#   p5b.ps1 -InputDir <folder with .step/.stp files> -OutDir <result folder>
# USD BRep 1.0.2 has no STEP reader or writer (no STEP code in the source tree; the only
# exchange formats are USD BrepArrays, the native .smb format and OCCT's text .brep format
# through the OCCT_BREP_IMPORT/EXPORT converters). So a STEP file cannot be read by this
# kernel on its own. This script lists the files found and records that outcome per file,
# so the result is explicit and repeatable once files are present.
param(
    [Parameter(Mandatory = $true)][string]$InputDir,
    [Parameter(Mandatory = $true)][string]$OutDir
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$files = @()
if (Test-Path $InputDir) {
    # Case-insensitive on Windows; the regex makes it explicit for other file systems.
    $files = Get-ChildItem -Path $InputDir -File -Recurse | Where-Object { $_.Extension -match '^\.(step|stp)$' }
}
$cases = @()
if ($files.Count -eq 0) {
    $cases += [ordered]@{ id = 'P5b'; outcome = 'pending'; detail = 'pending: no files yet (no *.step / *.stp in the input folder)' }
} else {
    foreach ($f in $files) {
        $cases += [ordered]@{
            id = 'P5b'; file = $f.Name; bytes = $f.Length; outcome = 'not-supported'
            detail = 'USD BRep 1.0.2 has no STEP reader; reading needs a STEP translator (for example OCCT TKDESTEP -> .brep -> occt_to_usd), which this track does not build'
        }
    }
}
$doc = [ordered]@{ kernel = 'NVIDIA USD BRep / SMLib'; usdBrepVersion = '1.0.2'; filesFound = $files.Count; cases = $cases }
$out = Join-Path $OutDir 'p5b.json'
[IO.File]::WriteAllText((Join-Path (Resolve-Path $OutDir).Path 'p5b.json'), ($doc | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
Write-Host "P5b: $($files.Count) STEP file(s) found; wrote $out"
