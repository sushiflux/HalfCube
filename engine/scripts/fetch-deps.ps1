# Fetches the engine's third-party sources into engine/_deps (git-ignored), pinned by the "fetch" blocks of
# third_party/manifest.json: git checkouts must end up at the pinned commit, archives and single files must match
# their SHA-256. Each folder gets a ".halfcube-pin" stamp; a folder whose stamp matches is kept as it is.
# Licence files of every library stay inside its folder. Nothing is installed system-wide.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File engine/scripts/fetch-deps.ps1 [-Skip occt] [-Only eigen,boost]
#
# -Skip occt: leave out the OCCT sources (about 300 MB) when the builds use an existing OCCT installation.
param([string[]]$Skip = @(), [string[]]$Only = @())
$ErrorActionPreference = 'Stop'

$engine = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repo = Split-Path $engine -Parent
$deps = Join-Path $engine '_deps'
$manifestPath = Join-Path $repo 'third_party\manifest.json'
$manifest = Get-Content -Raw -Encoding UTF8 $manifestPath | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $deps | Out-Null
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git is required (not found on PATH).' }

function Get-PinText($f) {
    switch ($f.kind) {
        'git' { return "git $($f.url) $($f.commit)" + $(if ($f.sparse) { " sparse:" + ($f.sparse -join ',') } else { '' }) }
        'archive' { return "archive $($f.url) $($f.sha256)" }
        'files' { return "files " + (($f.files | ForEach-Object { "$($_.path)=$($_.sha256)" }) -join ' ') }
    }
}

function Test-Stamp([string]$Dir, [string]$Pin) {
    $stamp = Join-Path $Dir '.halfcube-pin'
    return (Test-Path $stamp) -and ((Get-Content -Raw $stamp).Trim() -eq $Pin)
}

function Write-Stamp([string]$Dir, [string]$Pin) {
    [IO.File]::WriteAllText((Join-Path $Dir '.halfcube-pin'), "$Pin`n")
}

function Get-Sha256([string]$Path) { (Get-FileHash -Algorithm SHA256 $Path).Hash.ToLowerInvariant() }

function Invoke-Download([string]$Url, [string]$OutFile) {
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $OutFile
}

function Fetch-Git($c, $f, [string]$Dir, [string]$Pin) {
    if (Test-Path (Join-Path $Dir '.git')) {
        $have = (git -C $Dir rev-parse HEAD).Trim()
        if ($have -ne $f.commit) {
            throw "$($c.id): $Dir is at commit $have, but $($f.commit) ($($f.ref)) is pinned. Delete the folder and run the script again."
        }
        Write-Stamp $Dir $Pin
        Write-Host "verified: $($c.id) $($c.version) ($($f.commit))"
        return
    }
    if (Test-Path $Dir) { throw "$($c.id): $Dir exists but is no git checkout. Delete the folder and run the script again." }
    if ($f.sparse) {
        git -c advice.detachedHead=false clone --quiet --depth 1 --branch $f.ref --filter=blob:none --sparse $f.url $Dir
        if ($LASTEXITCODE -ne 0) { throw "$($c.id): git clone of $($f.url) failed ($LASTEXITCODE)." }
        git -C $Dir sparse-checkout set --cone @($f.sparse)
        if ($LASTEXITCODE -ne 0) { throw "$($c.id): git sparse-checkout failed ($LASTEXITCODE)." }
    } else {
        git -c advice.detachedHead=false clone --quiet --depth 1 --branch $f.ref $f.url $Dir
        if ($LASTEXITCODE -ne 0) { throw "$($c.id): git clone of $($f.url) failed ($LASTEXITCODE)." }
    }
    $have = (git -C $Dir rev-parse HEAD).Trim()
    if ($have -ne $f.commit) {
        throw "$($c.id): tag $($f.ref) of $($f.url) points to $have, but $($f.commit) is pinned (the tag was moved). Check the upstream release before changing the pin."
    }
    Write-Stamp $Dir $Pin
    Write-Host "fetched: $($c.id) $($c.version) ($($f.commit))"
}

function Fetch-Archive($c, $f, [string]$Dir, [string]$Pin) {
    if (Test-Path $Dir) { throw "$($c.id): $Dir exists without a matching .halfcube-pin stamp. Delete the folder and run the script again." }
    $tmp = Join-Path $deps ".download-$($c.id)"
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    try {
        $file = Join-Path $tmp ([IO.Path]::GetFileName(([Uri]$f.url).AbsolutePath))
        Invoke-Download $f.url $file
        $sha = Get-Sha256 $file
        if ($sha -ne $f.sha256) { throw "$($c.id): SHA-256 of $($f.url) is $sha, expected $($f.sha256). The download is damaged or the file was changed upstream." }
        $part = "$Dir.partial"
        if (Test-Path $part) { Remove-Item -Recurse -Force $part }
        New-Item -ItemType Directory -Force -Path $part | Out-Null
        $tarArgs = @('-xzf', $file, '-C', $part, "--strip-components=$($f.stripComponents)") + @($f.members)
        # Windows ships bsdtar in System32; a GNU tar found first on PATH would read "G:" as a remote host.
        $tarExe = Join-Path $env:SystemRoot 'System32\tar.exe'
        if (-not (Test-Path $tarExe)) { $tarExe = 'tar' }
        & $tarExe @tarArgs
        if ($LASTEXITCODE -ne 0) { throw "$($c.id): extracting $file with $tarExe failed ($LASTEXITCODE)." }
        Move-Item $part $Dir
    } finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
        if (Test-Path "$Dir.partial") { Remove-Item -Recurse -Force "$Dir.partial" -ErrorAction SilentlyContinue }
    }
    Write-Stamp $Dir $Pin
    Write-Host "fetched: $($c.id) $($c.version) (SHA-256 verified)"
}

function Fetch-Files($c, $f, [string]$Dir, [string]$Pin) {
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    foreach ($e in $f.files) {
        $target = Join-Path $Dir ($e.path -replace '/', '\')
        New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
        if ((Test-Path $target) -and ((Get-Sha256 $target) -eq $e.sha256)) { continue }
        $part = "$target.partial"
        Invoke-Download $e.url $part
        $sha = Get-Sha256 $part
        if ($sha -ne $e.sha256) {
            Remove-Item -Force $part
            throw "$($c.id): SHA-256 of $($e.url) is $sha, expected $($e.sha256)."
        }
        Move-Item -Force $part $target
    }
    Write-Stamp $Dir $Pin
    Write-Host "fetched: $($c.id) $($c.version) ($($f.files.Count) files, SHA-256 verified)"
}

foreach ($c in $manifest.components) {
    $f = $c.fetch
    if (-not $f -or $f.kind -eq 'docker-image') { continue }
    if ($Only.Count -gt 0 -and $Only -notcontains $c.id) { continue }
    if ($Skip -contains $c.id) { Write-Host "skipped: $($c.id)"; continue }
    $dir = Join-Path $deps $f.dir
    $pin = Get-PinText $f
    if (Test-Stamp $dir $pin) { Write-Host "present: $($c.id) $($c.version)"; continue }
    switch ($f.kind) {
        'git' { Fetch-Git $c $f $dir $pin }
        'archive' { Fetch-Archive $c $f $dir $pin }
        'files' { Fetch-Files $c $f $dir $pin }
        default { throw "$($c.id): unknown fetch kind '$($f.kind)' in $manifestPath." }
    }
}
Write-Host "dependencies ready in $deps"
