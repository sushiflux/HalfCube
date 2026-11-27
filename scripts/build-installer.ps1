# Local installer build: builds the Windows installer of HalfCube on this PC, in the dev channel, into _build\installer\.
# No push, no tag, no CI run. Official Nightly, Beta and Release packages are built by CI.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts\build-installer.ps1 [-Channel dev] [-Neubau] [-OhneEngine]
#          [-AlleSprachen] [-LayoutPruefung] [-PackId HalfCube] [-Title HalfCube] [-OutDir <folder>]
#          [-VersionId v2026.11.20.1.1] [-FeedDir <folder>]
#          CI (release job of .github/workflows/ci.yml): -Ci -Channel nightly -ReleaseNotes <file> [-PreviousFrom https://github.com/<owner>/<repo>]
#   -Neubau         rebuild every step even if its inputs did not change
#   -OhneEngine     build without the engine (only for tests of the installer itself; the program then has no geometry)
#   -AlleSprachen   keep all Chromium locale files (by default only en-US and de stay: the program speaks German and English)
#   -LayoutPruefung renders every page of the setup (light/dark, DE/EN, 100/150/200 %) offscreen into <OutDir>/layout-check and fails on a layout problem
#   -PackId/-Title  Velopack app id and display name (default HalfCube); tests use another id so a real installation is never touched
#   -OutDir         where the result goes (default _build\installer)
#   -VersionId      TEST ONLY: bakes this five-part id into the bundles, the package and the setup instead of version.txt line 2 (through
#                   HALFCUBE_VERSION_ID, read by config/build-info.ts). Rejected together with -Ci and in a CI tag build. A build with it
#                   overwrites the bundles in _build that the local dev environment uses (run scripts\dev.ps1 -Neubau afterwards).
#   -FeedDir        TEST ONLY: one local folder that collects the successive packages of one channel (not wiped between builds), so vpk
#                   writes deltas between them and the folder works as a local update feed (releases.<channel>.json). Older setups in
#                   -OutDir are kept. Test across skipped versions: build with -FeedDir and three different -VersionId values in a row,
#                   install the first setup, point the program's update source to the folder.
#   -Ci             release job: non-interactive, no layout check, no local-only steps; needs -ReleaseNotes; builds nightly, beta or
#                   release only; writes the files for the GitHub release (setup, packages, releases.<channel>.json) to <OutDir>\release
#                   and build-result.json next to them
#   -ReleaseNotes   markdown file for vpk pack --releaseNotes (the channel changelog excerpt, scripts/ci/release.ts excerpt)
#   -PreviousFrom   repository URL (https://github.com/<owner>/<repo>): fetches the newest full package of the channel from its GitHub
#                   releases first (vpk download github, token from GITHUB_TOKEN if set), so vpk pack writes a delta to it
#
# What it does, in this order (each step is skipped when nothing it depends on changed):
#   1. bundles      npm run build:web and build:desktop (HALFCUBE_CHANNEL is baked into both). _build\web and _build\desktop are shared with
#                   scripts\dev.ps1, so the build id and channel baked into the bundles are read back before and after the build: a foreign
#                   bundle is rebuilt, a wrong one after the build stops the script. -Ci always rebuilds.
#   2. engine      halfcube-engine.exe and its DLLs from engine\_build\windows-release\bin plus the app-local VC++ runtime
#   3. app folder   installer\app\entry.cjs (Velopack hooks first, then the built main process) + velopack from npm, packaged with
#                   @electron/packager (pinned devDependency, run from node_modules) into an Electron application folder with the engine in
#                   resources\engine
#   4. vpk pack     Velopack 1.2.161 from the local tool manifest (.config\dotnet-tools.json, never a global install) creates the
#                   Velopack Setup.exe and the package
#   5. setup        installer\setup (.NET 11 WinForms, the designed window) is published as one self-contained exe
#   6. payload      Velopack's Setup.exe + payload.json + LICENSE + NOTICE become a ZIP appended to that exe: one file, HalfCube-Setup-<id>-<channel>.exe
#                   (LGPL-2.1 section 6 wants the notice and the licence text with every copy; the setup shows both on its licence page)
# The path of the result is printed at the end.
#
# Version mapping (Velopack accepts only three-part SemVer2, "vpk pack" rejects the five-part id; the program itself always shows the
# five-part id). version.txt line 2 is vYear.Month.CommitOfYear.Prompts.ChangedLines:
#   release  <Year>.<Month>.<Commit>                                   2026.11.5
#   beta     <Year>.<Month>.<Commit>-beta.<Prompts>.<Lines>            2026.11.5-beta.13.12369
#   nightly  <Year>.<Month>.<Commit>-alpha.<Prompts>.<Lines>           2026.11.5-alpha.13.12369  (never "nightly": it sorts above beta)
#   dev      <Year>.<Month>.<Commit>-dev.<Prompts>.<Lines>             2026.11.5-dev.13.12369    (local only, never offered as an update)
# The dev channel is the only one tested here. A local build of another channel overwrites the bundles in _build\ that the local
# dev environment uses; run scripts\dev.ps1 -Neubau afterwards.
param(
    [ValidateSet('dev', 'nightly', 'beta', 'release')][string]$Channel = 'dev',
    [string]$PackId = 'HalfCube',
    [string]$Title = 'HalfCube',
    [string]$OutDir,
    [string]$VersionId,
    [string]$FeedDir,
    [string]$ReleaseNotes,
    [string]$PreviousFrom,
    [switch]$Ci,
    [switch]$Neubau, [switch]$OhneEngine, [switch]$AlleSprachen, [switch]$LayoutPruefung
)
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- parameter checks (before anything is created or built)
if ($Ci) {
    if ($Channel -eq 'dev') { throw '-Ci baut nur die Kanaele nightly, beta und release.' }
    if (-not $ReleaseNotes) { throw '-Ci braucht -ReleaseNotes (die Release-Notes-Datei fuer vpk pack).' }
    foreach ($bad in @('OhneEngine', 'LayoutPruefung', 'FeedDir')) {
        if ($PSBoundParameters.ContainsKey($bad)) { throw "-$bad ist nur fuer lokale Tests und mit -Ci nicht erlaubt." }
    }
}
if ($VersionId) {
    if ($Ci -or "$env:GITHUB_REF" -like 'refs/tags/*') {
        throw '-VersionId ist nur fuer lokale Tests (Update ueber uebersprungene Versionen) und wird bei einem CI-Tag-Bau abgelehnt: ein Tag traegt immer die Version seines Commits.'
    }
    if ($VersionId -notmatch '^v(0|[1-9]\d*)(\.(0|[1-9]\d*)){4}$') { throw "-VersionId '$VersionId' ist keine fuenfteilige Kennung wie v2026.11.4.58.26093." }
}
if ($FeedDir -and $PreviousFrom) { throw '-FeedDir und -PreviousFrom schliessen sich aus: der Feed-Ordner ist selbst die Vorgaengerquelle.' }
if ($PreviousFrom -and $PreviousFrom -notmatch '^https://[^/]+/[^/]+/[^/]+$') { throw "-PreviousFrom '$PreviousFrom' muss die Form https://github.com/<owner>/<repo> haben." }
if ($ReleaseNotes -and -not (Test-Path -LiteralPath $ReleaseNotes -PathType Leaf)) { throw "-ReleaseNotes: Datei nicht gefunden: $ReleaseNotes" }
if ($ReleaseNotes) { $ReleaseNotes = (Resolve-Path -LiteralPath $ReleaseNotes).Path }

# The GitHub token of the release-build job (contents: read) is needed by "vpk download" only. It leaves the environment here, before
# any program starts, so the npm builds, npx and the packager (and whatever their dependencies run) never see it.
$githubToken = $env:GITHUB_TOKEN
Remove-Item Env:\GITHUB_TOKEN -ErrorAction SilentlyContinue

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$out = if ($OutDir) { $OutDir } else { Join-Path $root '_build\installer' }
New-Item -ItemType Directory -Force -Path $out | Out-Null
$out = (Resolve-Path $out).Path
$work = Join-Path $out 'work'
$stageApp = Join-Path $work 'stage-app'
$extra = Join-Path $work 'extra'
$pkgOut = Join-Path $work 'pkg'
# vpk's output folder. With -FeedDir it is the caller's folder that keeps the packages of earlier builds; otherwise it is recreated.
$keepFeed = [bool]$FeedDir
if ($FeedDir) {
    New-Item -ItemType Directory -Force -Path $FeedDir | Out-Null
    $feed = (Resolve-Path $FeedDir).Path
} else { $feed = Join-Path $work 'velopack' }
$setupOut = Join-Path $work 'setup-publish'
$stampFile = Join-Path $work 'pack.stamp'
New-Item -ItemType Directory -Force -Path $work | Out-Null

function Say($t) { Write-Host "[installer] $t" }
function Step($name, [scriptblock]$block) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Say "$name ..."
    & $block
    Say ('{0} fertig in {1:N1} s' -f $name, $sw.Elapsed.TotalSeconds)
}
function Run {
    # Runs a program and fails on a non-zero exit code. Output goes to the console.
    param([string]$Exe, [Parameter(ValueFromRemainingArguments)]$Arguments)
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) {
        $shown = "$Exe $($Arguments -join ' ')"
        if ($githubToken) { $shown = $shown.Replace($githubToken, '***') }
        throw "$shown fehlgeschlagen (Code $LASTEXITCODE)"
    }
}
function Npm { param([Parameter(ValueFromRemainingArguments)]$a) Run 'npm.cmd' @a }
# Newest write time below a path (a file or a folder); $null when nothing is there.
function Get-Newest($path) {
    if (-not (Test-Path $path)) { return $null }
    if (Test-Path $path -PathType Leaf) { return (Get-Item $path).LastWriteTimeUtc }
    $f = Get-ChildItem $path -Recurse -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if ($f) { $f.LastWriteTimeUtc } else { $null }
}
function Test-Stale($output, [string[]]$inputs) {
    if (-not (Test-Path $output)) { return $true }
    $t = (Get-Item $output).LastWriteTimeUtc
    foreach ($i in $inputs) {
        $n = Get-Newest (Join-Path $root $i)
        if ($n -and $n -gt $t) { return $true }
    }
    $false
}

# ---------------------------------------------------------------- version
if ($VersionId) { $id = $VersionId } else {
    $versionLines = Get-Content (Join-Path $root 'version.txt')
    if ($versionLines.Count -lt 2) { throw 'version.txt hat keine zweite Zeile mit der fuenfteiligen Kennung.' }
    $id = $versionLines[1].Trim()
}
if ($id -notmatch '^v(\d+)\.(\d+)\.(\d+)\.(\d+)\.(\d+)$') { throw "Ungueltige Versionskennung in version.txt: '$id'" }
$vYear = $Matches[1]; $vMonth = $Matches[2]; $vCommit = $Matches[3]; $vPrompts = $Matches[4]; $vLines = $Matches[5]
function Get-PackVersion([string]$channel) {
    $core = "$vYear.$vMonth.$vCommit"
    switch ($channel) {
        'release' { $core }
        'beta' { "$core-beta.$vPrompts.$vLines" }
        'nightly' { "$core-alpha.$vPrompts.$vLines" }
        default { "$core-dev.$vPrompts.$vLines" }
    }
}
$symbols = @{ dev = '</>'; nightly = [string][char]0x03B1; beta = [string][char]0x03B2; release = '' }
$display = if ($symbols[$Channel] -eq '') { $id } else { "$id ($($symbols[$Channel]))" }
$packVersion = Get-PackVersion $Channel
$fileSuffix = if ($Channel -eq 'release') { '' } else { "-$Channel" }
$fileId = if ($Channel -eq 'release') { "v$vYear.$vMonth.$vCommit" } else { $id }
$finalName = "HalfCube-Setup-$fileId$fileSuffix.exe"
# The names vpk gives its files: <packId>-<channel>-Setup.exe and <packId>-<packVersion>-<channel>-full.nupkg
$vpkSetupName = "$PackId-$Channel-Setup.exe"
$vpkFullName = "$PackId-$packVersion-$Channel-full.nupkg"
Say "Version $display, Velopack-Version $packVersion, Kanal $Channel"
if (-not $Ci) {
    if ($Channel -ne 'dev') { Say 'Hinweis: ein lokaler Bau eines anderen Kanals ueberschreibt die Bundles in _build, die die lokale Dev-Umgebung nutzt (danach dev.ps1 -Neubau).' }
    if ($VersionId) { Say "Hinweis: -VersionId $VersionId ist nur ein Test; die Bundles in _build tragen diese Kennung, bis scripts\dev.ps1 -Neubau sie ersetzt." }
}

# ---------------------------------------------------------------- tools
Push-Location $root
try {
    foreach ($tool in @('node', 'npm.cmd', 'dotnet')) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool nicht gefunden." }
    }
    $sdk = (& dotnet --version).Trim()
    if ($sdk -notmatch '^11\.') { throw ".NET SDK 11 wird gebraucht, gefunden: $sdk" }
    # vpk comes from the tool manifest of this repository: a local tool, nothing is installed globally
    Run 'dotnet' 'tool' 'restore' '--verbosity' 'quiet'
    $electronVersion = (& node -p "require('./node_modules/electron/package.json').version").Trim()
    if (-not $electronVersion) { throw 'Electron ist nicht installiert (npm install).' }
    # The packager is a pinned devDependency (package.json, package-lock.json) and runs from node_modules: no npx, nothing is resolved
    # or downloaded at build time.
    $packagerBin = Join-Path $root 'node_modules\@electron\packager\bin\electron-packager.mjs'
    if (-not (Test-Path -LiteralPath $packagerBin)) { throw '@electron/packager ist nicht installiert (npm ci).' }
    $packagerVersion = (& node -p "require('./node_modules/@electron/packager/package.json').version").Trim()

    # ---------------------------------------------------------------- 1. bundles
    $env:HALFCUBE_CHANNEL = $Channel
    # The id reaches the bundles through config/build-info.ts; without -VersionId a stray variable must not change the build
    if ($VersionId) { $env:HALFCUBE_VERSION_ID = $VersionId } else { Remove-Item Env:\HALFCUBE_VERSION_ID -ErrorAction SilentlyContinue }
    $webBundle = Join-Path $root '_build\web\index.html'
    $mainBundle = Join-Path $root '_build\desktop\main.cjs'
    $releaseCli = Join-Path $root 'scripts\ci\release.ts'
    $appInputs = @('app', 'branding\branding.json', 'branding\icons', 'config', 'protocol', 'version.txt', 'vite.config.ts', 'package.json')
    $desktopInputs = @('desktop\src', 'app\src\version.ts', 'app\src\branding.ts', 'app\src\platform.ts', 'branding\branding.json',
        'branding\icons\icon-512.png', 'config', 'version.txt', 'vite.desktop.config.ts', 'package.json')
    # _build\web and _build\desktop are shared with scripts\dev.ps1 (dev channel, the id of version.txt). What matters is what the bundles
    # themselves carry, not what an earlier run of this script wrote down: the build id and channel baked into them (config/build-info.ts)
    # are read back every time. A bundle from another channel or id is rebuilt; if it is still wrong after the build, the script stops.
    function Get-BundleState([string]$webDir, [string]$mainFile) {
        $answer = & node $releaseCli 'verify-bundles' '--web' $webDir '--main' $mainFile '--id' $id '--channel' $Channel '--on-mismatch' 'report'
        if ($LASTEXITCODE -ne 0) { throw 'scripts\ci\release.ts verify-bundles ist fehlgeschlagen.' }
        ($answer -join ' ').Trim()
    }
    function Assert-BundleInfo([string]$webDir, [string]$mainFile) {
        Run 'node' $releaseCli 'verify-bundles' '--web' $webDir '--main' $mainFile '--id' $id '--channel' $Channel
    }
    $bundleState = if ($Neubau -or $Ci) { 'match' } else { Get-BundleState (Join-Path $root '_build\web') $mainBundle }
    $bundleForeign = $bundleState -ne 'match'
    if ($bundleForeign) { Say "Die Bundles in _build passen nicht zu diesem Bau, sie werden neu gebaut. $bundleState" }
    # A CI build starts from a clean checkout; it rebuilds anyway so no leftover can reach a package
    if ($Neubau -or $Ci -or $bundleForeign -or (Test-Stale $webBundle $appInputs)) { Step 'Browser-Version bauen' { Npm 'run' 'build:web' } }
    if ($Neubau -or $Ci -or $bundleForeign -or (Test-Stale $mainBundle $desktopInputs)) { Step 'Desktop-Programm bauen' { Npm 'run' 'build:desktop' } }
    foreach ($f in @($webBundle, $mainBundle, (Join-Path $root '_build\desktop\preload.cjs'))) {
        if (-not (Test-Path $f)) { throw "Bundle fehlt nach dem Bau: $f" }
    }
    Assert-BundleInfo (Join-Path $root '_build\web') $mainBundle

    # ---------------------------------------------------------------- 2. engine
    $engineBin = Join-Path $root 'engine\_build\windows-release\bin'
    $engineExe = Join-Path $engineBin 'halfcube-engine.exe'
    $engineFiles = @()
    if (Test-Path $engineExe) {
        # Everything the build folder holds except the unit-test program goes flat into resourcesengine (contract in desktopsrcengine-path.ts)
        $engineFiles = @(Get-ChildItem $engineBin -File -Recurse | Where-Object { $_.Name -notlike '*-tests*' -and ($_.Extension -in @('.exe', '.dll', '.txt', '.md', '.html')) })
        $engineRoot = (Get-Item $engineBin).FullName
    } elseif (-not $OhneEngine) {
        throw "Engine nicht gefunden: $engineExe. Erst engine\scripts\build-windows.ps1 ausfuehren (oder -OhneEngine fuer einen Installer-Test ohne Geometrie)."
    } else { Say 'WARNUNG: -OhneEngine, der Installer enthaelt keine Engine.' }
    # The engine and the OCCT libraries link the VC++ runtime dynamically: the three runtime DLLs go next to them (app-local), so no
    # separate Visual C++ redistributable (which needs administrator rights) is required on the target PC.
    $crtFiles = @()
    if ($engineFiles.Count -gt 0) {
        $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
        $crtDir = $null
        if (Test-Path $vswhere) {
            $vsRoot = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
            if ($vsRoot) {
                $crtDir = Get-ChildItem (Join-Path $vsRoot 'VC\Redist\MSVC') -Directory -ErrorAction SilentlyContinue |
                    Where-Object { $_.Name -match '^\d' } | Sort-Object Name -Descending |
                    ForEach-Object { Join-Path $_.FullName 'x64\Microsoft.VC143.CRT' } | Where-Object { Test-Path $_ } | Select-Object -First 1
            }
        }
        if (-not $crtDir) { throw 'Die VC++-Laufzeit (x64\Microsoft.VC143.CRT) wurde in der Visual-Studio-Installation nicht gefunden.' }
        foreach ($n in @('vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll')) {
            $p = Join-Path $crtDir $n
            if (-not (Test-Path $p)) { throw "$n fehlt in $crtDir" }
            $crtFiles += Get-Item $p
        }
    }

    # ---------------------------------------------------------------- 3. app folder + 4. vpk pack (one stamp for both)
    $stampParts = @($id, $Channel, $packVersion, $PackId, $Title, "electron=$electronVersion", "packager=$packagerVersion", "all-locales=$($AlleSprachen.IsPresent)",
        (Get-Newest (Join-Path $root '_build\desktop')), (Get-Newest (Join-Path $root '_build\web')),
        (Get-Newest (Join-Path $root 'installer\app')), (Get-Newest (Join-Path $root 'branding\icons')),
        (Get-FileHash $PSCommandPath -Algorithm SHA256).Hash)
    if ($ReleaseNotes) { $stampParts += (Get-FileHash -LiteralPath $ReleaseNotes -Algorithm SHA256).Hash }
    foreach ($f in ($engineFiles + $crtFiles)) { $stampParts += "$($f.Name)|$($f.Length)|$($f.LastWriteTimeUtc.Ticks)" }
    $stamp = ($stampParts | ForEach-Object { "$_" }) -join "`n"
    $packCurrent = (-not $Neubau) -and (-not $Ci) -and (Test-Path $stampFile) -and ((Get-Content $stampFile -Raw) -eq $stamp) -and (Test-Path $feed)
    if ($packCurrent) {
        if (-not ((Test-Path (Join-Path $feed $vpkSetupName)) -and (Test-Path (Join-Path $feed $vpkFullName)))) { $packCurrent = $false } else { Say 'Programmordner und Velopack-Paket sind aktuell, uebersprungen.' }
    }
    if (-not $packCurrent) {
        Remove-Item $stampFile -ErrorAction SilentlyContinue
        Step 'Programmordner vorbereiten' {
            Remove-Item $stageApp, $extra -Recurse -Force -ErrorAction SilentlyContinue
            New-Item -ItemType Directory -Force -Path $stageApp, (Join-Path $extra 'engine') | Out-Null
            Copy-Item (Join-Path $root 'installer\app\entry.cjs') $stageApp
            Copy-Item (Join-Path $root 'installer\app\package-lock.json') $stageApp
            $pkgJson = Get-Content -Raw (Join-Path $root 'installer\app\package.json') | ConvertFrom-Json
            $pkgJson.version = $packVersion
            # UTF-8 without BOM: Electron's JSON reader does not accept a byte order mark
            [IO.File]::WriteAllText((Join-Path $stageApp 'package.json'), ($pkgJson | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
            Copy-Item (Join-Path $root '_build\desktop') (Join-Path $stageApp '_build\desktop') -Recurse
            Copy-Item (Join-Path $root '_build\web') (Join-Path $stageApp '_build\web') -Recurse
            # What goes into the package is checked again at the place it is copied to (the bundles could change while the script runs)
            Assert-BundleInfo (Join-Path $stageApp '_build\web') (Join-Path $stageApp '_build\desktop\main.cjs')
            foreach ($f in $engineFiles) {
                $rel = $f.FullName.Substring($engineRoot.Length).TrimStart('\')
                $dest = Join-Path (Join-Path $extra 'engine') $rel
                New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
                Copy-Item $f.FullName $dest
            }
            foreach ($f in $crtFiles) { Copy-Item $f.FullName (Join-Path $extra 'engine') }
            Push-Location $stageApp
            try { Npm 'ci' '--omit=dev' '--no-audit' '--no-fund' } finally { Pop-Location }
            # The npm package carries the native module of every platform (20 MB); only the Windows x64 one is loaded
            Get-ChildItem (Join-Path $stageApp 'node_modules\velopack\lib\native') -Filter '*.node' | Where-Object { $_.Name -notlike '*win_x64*' } | Remove-Item -Force
        }
        Step 'Electron verpacken' {
            Remove-Item $pkgOut -Recurse -Force -ErrorAction SilentlyContinue
            $packagerArgs = @($packagerBin, $stageApp, 'HalfCube',
                '--platform=win32', '--arch=x64', "--out=$pkgOut", '--overwrite', "--electron-version=$electronVersion",
                "--icon=$(Join-Path $root 'branding\icons\icon.ico')",
                # The Windows file version has four numeric parts (year, month, commit of the year, prompts)
                '--asar.unpack=**/*.node',
                "--app-version=$vYear.$vMonth.$vCommit.$vPrompts", "--app-copyright=(c) $((Get-Date).Year) SushiFlux",
                '--win32metadata.CompanyName=SushiFlux', '--win32metadata.ProductName=HalfCube',
                '--win32metadata.FileDescription=HalfCube', '--win32metadata.OriginalFilename=HalfCube.exe')
            if ($engineFiles.Count -gt 0) { $packagerArgs += "--extra-resource=$(Join-Path $extra 'engine')" }
            Run 'node' @packagerArgs
        }
        $pkgDir = (Get-ChildItem $pkgOut -Directory | Select-Object -First 1).FullName
        if (-not (Test-Path (Join-Path $pkgDir 'HalfCube.exe'))) { throw "HalfCube.exe fehlt im verpackten Ordner $pkgDir" }
        if ($engineFiles.Count -gt 0 -and -not (Test-Path (Join-Path $pkgDir 'resources\engine\halfcube-engine.exe'))) { throw 'resources\engine\halfcube-engine.exe fehlt im verpackten Ordner.' }
        if (-not $AlleSprachen) {
            # The program speaks German and English; Chromium falls back to en-US for everything else (about 35 MB less)
            Get-ChildItem (Join-Path $pkgDir 'locales') -Filter '*.pak' | Where-Object { $_.Name -notin @('en-US.pak', 'de.pak') } | Remove-Item -Force
        }
        Step 'Velopack-Paket erzeugen (vpk pack)' {
            if (-not $keepFeed) { Remove-Item $feed -Recurse -Force -ErrorAction SilentlyContinue }
            New-Item -ItemType Directory -Force -Path $feed | Out-Null
            if ($FeedDir -and (Test-Path (Join-Path $feed $vpkFullName))) {
                throw "Im Feed-Ordner liegt schon ein Paket dieser Version ($vpkFullName). Eine neue, hoehere -VersionId waehlen oder das Paket loeschen."
            }
            if ($PreviousFrom) {
                # The newest full package of this channel from the GitHub releases (only the 10 newest releases are looked at, see
                # sources/github.rs of Velopack); vpk pack finds it in the output folder and writes the delta. No release yet = nothing to fetch.
                $download = @('download', 'github', '--repoUrl', $PreviousFrom, '--channel', $Channel, '--pre', '--outputDir', $feed)
                if ($githubToken) { $download += @('--token', $githubToken) }
                Run 'dotnet' 'tool' 'run' 'vpk' '--' @download
            }
            # Without a feed (local dev build) no delta packages are made. The portable zip is never made. The Velopack installer
            # (Setup.exe) is carried inside our own setup, which runs it silently. Shortcuts (desktop and start menu) are fixed in the
            # package; the setup removes the ones the user switches off.
            $delta = if ($FeedDir -or $PreviousFrom) { 'BestSpeed' } else { 'None' }
            $packArgs = @('pack', '--packId', $PackId, '--packVersion', $packVersion, '--packDir', $pkgDir,
                '--mainExe', 'HalfCube.exe', '--packTitle', $Title, '--packAuthors', 'SushiFlux',
                '--icon', (Join-Path $root 'branding\icons\icon.ico'), '--channel', $Channel, '--runtime', 'win-x64',
                '--outputDir', $feed, '--delta', $delta, '--noPortable', '--shortcuts', 'Desktop,StartMenuRoot')
            if ($ReleaseNotes) { $packArgs += @('--releaseNotes', (Resolve-Path -LiteralPath $ReleaseNotes).Path) }
            Run 'dotnet' 'tool' 'run' 'vpk' '--' @packArgs
        }
        Set-Content -Path $stampFile -Value $stamp -Encoding utf8 -NoNewline
    }

    $vpkSetup = @(Get-Item (Join-Path $feed $vpkSetupName) -ErrorAction SilentlyContinue)
    $nupkg = @(Get-Item (Join-Path $feed $vpkFullName) -ErrorAction SilentlyContinue)
    if ($vpkSetup.Count -ne 1 -or $nupkg.Count -ne 1) { throw "vpk hat $vpkSetupName und $vpkFullName nicht erzeugt (in $feed)." }

    # ---------------------------------------------------------------- installed size (for the setup's progress bar)
    # The setup measures the fill level of the target folder against this number: the files of the app (uncompressed) plus the copy of the
    # package Velopack keeps in packages\ plus its updater and start stubs.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zipFile = [IO.Compression.ZipFile]::OpenRead($nupkg[0].FullName)
    try { $appBytes = ($zipFile.Entries | Where-Object { $_.FullName -like 'lib/*' } | Measure-Object -Property Length -Sum).Sum } finally { $zipFile.Dispose() }
    $installedBytes = [int64]$appBytes + $nupkg[0].Length + 4MB

    # ---------------------------------------------------------------- 5. the designed setup
    $setupSources = @('installer\setup', 'installer\Directory.Build.props', 'branding\icons\icon-512.png', 'branding\icons\icon.ico')
    $setupPublished = Join-Path $setupOut 'HalfCube-Setup.exe'
    $setupStale = $Neubau -or (Test-Stale $setupPublished $setupSources)
    # NuGet's restore files hold absolute paths; after a move or rename of the project folder they are recreated from scratch.
    $setupObj = Join-Path $out 'obj\HalfCube.Setup'
    $setupAssets = Join-Path $setupObj 'project.assets.json'
    if ((Test-Path $setupAssets) -and -not ((Get-Content -Raw $setupAssets).Replace('\\', '/').ToLowerInvariant().Contains($root.Replace('\', '/').ToLowerInvariant()))) {
        Say 'Die .NET-Wiederherstellungsdateien stammen aus einem anderen Projektordner, obj wird neu angelegt.'
        Remove-Item $setupObj -Recurse -Force
    }
    if ($setupStale) {
        Step 'Setup-Programm bauen (.NET)' {
            Remove-Item $setupOut -Recurse -Force -ErrorAction SilentlyContinue
            Run 'dotnet' 'publish' (Join-Path $root 'installer\setup\HalfCube.Setup.csproj') '-c' 'Release' '-r' 'win-x64' '--self-contained' 'true' '-o' $setupOut '--nologo' '-v' 'quiet'
        }
    } else { Say 'Setup-Programm ist aktuell, uebersprungen.' }
    if (-not (Test-Path $setupPublished)) { throw "Setup-Programm fehlt nach dem Bau: $setupPublished" }

    # ---------------------------------------------------------------- 6. payload
    Step 'Installer zusammensetzen' {
        $payloadZip = Join-Path $work 'payload.zip'
        Remove-Item $payloadZip -ErrorAction SilentlyContinue
        $info = [ordered]@{
            formatVersion  = 1
            packId         = $PackId
            title          = $Title
            version        = $id
            displayVersion = $display
            channel        = $Channel
            mainExe        = 'HalfCube.exe'
            installedBytes = $installedBytes
            setupBytes     = [int64]$vpkSetup[0].Length
        }
        $zip = [IO.Compression.ZipFile]::Open($payloadZip, [IO.Compression.ZipArchiveMode]::Create)
        try {
            # Velopack's Setup.exe is compressed already: stored, so the setup can copy it out without a decompression pass
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $vpkSetup[0].FullName, 'Setup.exe', [IO.Compression.CompressionLevel]::NoCompression)
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $root 'LICENSE'), 'LICENSE', [IO.Compression.CompressionLevel]::Optimal)
            # The NOTICE file (Required Notice, LGPL-2.1 section 6 permission, OCCT notice) travels next to the licence text; a missing file stops the build
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $root 'NOTICE'), 'NOTICE', [IO.Compression.CompressionLevel]::Optimal)
            $entry = $zip.CreateEntry('payload.json')
            $writer = New-Object IO.StreamWriter($entry.Open(), (New-Object Text.UTF8Encoding $false))
            try { $writer.Write(($info | ConvertTo-Json)) } finally { $writer.Dispose() }
        } finally { $zip.Dispose() }
        $final = Join-Path $out $finalName
        # Test builds with -FeedDir or -VersionId keep the older setups (the first one is installed, the later ones are updates)
        if (-not $FeedDir -and -not $VersionId) {
            Get-ChildItem $out -Filter 'HalfCube-Setup-*.exe' -File | Where-Object { $_.Name -ne $finalName } | Remove-Item -Force -ErrorAction SilentlyContinue
        }
        Copy-Item $setupPublished $final -Force
        # The published exe appends the payload to the copy (a running exe cannot be written, and it is a window program: wait for it)
        $append = Start-Process -FilePath $setupPublished -ArgumentList @('--append-payload', "`"$final`"", "`"$payloadZip`"") -Wait -PassThru -WindowStyle Hidden
        if ($append.ExitCode -ne 0) { throw "Anhaengen des Pakets an das Setup fehlgeschlagen (Code $($append.ExitCode))." }
    }
} finally { Pop-Location }

$result = Join-Path $out $finalName
$size = (Get-Item $result).Length
Say ('Fertig: {0} ({1:N0} MB)' -f $result, ($size / 1MB))
Say "Version $display (Velopack $packVersion), Kanal $Channel"
if ($Ci) {
    # What the GitHub release carries: our setup (the download), the packages of this build and the slim feed the updater reads.
    # Velopack's own Setup.exe stays inside our setup and is not published separately.
    $rel = Join-Path $out 'release'
    Remove-Item $rel -Recurse -Force -ErrorAction SilentlyContinue
    Push-Location $root
    try { Run 'node' (Join-Path $root 'scripts\ci\release.ts') 'stage' '--dir' $feed '--channel' $Channel '--out' $rel } finally { Pop-Location }
    Copy-Item $result $rel
    $buildResult = [ordered]@{ id = $id; channel = $Channel; displayVersion = $display; packVersion = $packVersion; setup = $finalName; files = @(Get-ChildItem $rel -File | ForEach-Object { $_.Name }) }
    [IO.File]::WriteAllText((Join-Path $rel 'build-result.json'), ($buildResult | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
    Say "Dateien fuer das GitHub-Release: $rel ($($buildResult.files -join ', '))"
}
if ($LayoutPruefung) {
    # The headless layout check of the setup: nothing is shown, nothing is installed
    $shots = Join-Path $out 'layout-check'
    Remove-Item $shots -Recurse -Force -ErrorAction SilentlyContinue
    Say "Layout-Pruefung nach $shots ..."
    $check = Start-Process -FilePath $result -ArgumentList @('--test-layout', "`"$shots`"") -Wait -PassThru -WindowStyle Hidden
    if ($check.ExitCode -ne 0) { throw "Layout-Pruefung fehlgeschlagen, Bericht: $(Join-Path $shots 'layout-report.txt')" }
    Say "Layout-Pruefung bestanden: $(Join-Path $shots 'layout-report.txt')"
}
Write-Output $result
